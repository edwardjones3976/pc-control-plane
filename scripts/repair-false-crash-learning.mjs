import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreContextSession } from "../server/context-sessions.js";
import { sessionIsModeBad } from "../server/learning.js";
import { scorePriorityAppSession } from "../server/sessions.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.join(appRoot, "data");
const learningPath = path.join(dataRoot, "learning.json");
const healthSessionsPath = path.join(dataRoot, "health-sessions.json");
const contextSessionsPath = path.join(dataRoot, "context-sessions.json");
const correctionId = "2026-08-29-executable-crash-correlation-v1";
const verifiedUnrelatedApps = new Set(["nvidia app", "onedrive"]);

function executableName(event = {}) {
  const explicit = event?.analysis?.applicationName;
  const message = String(event?.message || "");
  const parsed = message.match(/faulting application name:\s*([^,\r\n]*?\.exe)\b/i)?.[1] || null;
  return String(explicit || parsed || "")
    .trim()
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function isVerifiedFalseCrash(event = {}) {
  const name = executableName(event);
  if (!verifiedUnrelatedApps.has(name)) return false;
  if (name === "onedrive") {
    return /exception code:\s*0xc0000409/i.test(String(event?.message || ""));
  }
  return /exception code:\s*0xc0000005/i.test(String(event?.message || ""));
}

function correctedSession(session, kind) {
  const crashes = Array.isArray(session?.crashes) ? session.crashes : [];
  if (!crashes.length || !crashes.every(isVerifiedFalseCrash)) return null;
  const copy = { ...session, crashes: [] };
  const score = kind === "health"
    ? scorePriorityAppSession(copy, {}, { health: { state: "Stable" } })
    : scoreContextSession(copy, {}, { health: { state: "Stable" }, offenders: copy.offenders || [] });
  return {
    id: String(session.id),
    profile: String(session.profile || (kind === "health" ? "competitive" : "balanced")),
    endedAt: session.endedAt || null,
    oldScore: Number(session.outcomeScore),
    score: Number(score),
    removedCrashes: crashes.length,
    apps: [...new Set(crashes.map(executableName))]
  };
}

const [learningRaw, healthRaw, contextRaw] = await Promise.all([
  fs.readFile(learningPath, "utf8"),
  fs.readFile(healthSessionsPath, "utf8"),
  fs.readFile(contextSessionsPath, "utf8")
]);
const learning = JSON.parse(learningRaw);
const priorCorrections = Array.isArray(learning.corrections) ? learning.corrections : [];
if (priorCorrections.some((entry) => entry?.id === correctionId)) {
  process.stdout.write(`${JSON.stringify({ ok: true, alreadyApplied: true, correctionId }, null, 2)}\n`);
  process.exit(0);
}

const healthSessions = JSON.parse(healthRaw)?.sessions || [];
const contextSessions = JSON.parse(contextRaw)?.sessions || [];
const corrections = [
  ...healthSessions.map((session) => correctedSession(session, "health")),
  ...contextSessions.map((session) => correctedSession(session, "context"))
].filter(Boolean);
const byId = new Map(corrections.map((entry) => [entry.id, entry]));
const changedProfiles = [];

for (const [profileId, profile] of Object.entries(learning.profiles || {})) {
  let changed = false;
  for (const record of profile.sessions || []) {
    const correction = byId.get(String(record.id));
    if (!correction) continue;
    record.score = correction.score;
    record.crashes = 0;
    record.modeCrashes = 0;
    record.correction = correctionId;
    changed = true;
  }
  if (!changed) continue;

  const recent = (profile.sessions || []).slice(-3);
  const badCount = recent.filter((entry) => sessionIsModeBad(entry, 60)).length;
  if (profile.guardrail && badCount < 2) {
    profile.guardrail = null;
  }
  const newestGood = [...(profile.sessions || [])]
    .reverse()
    .find((entry) => Number(entry.score) >= 80);
  if (newestGood && (!profile.lastKnownGood || String(newestGood.endedAt) >= String(profile.lastKnownGood.endedAt || ""))) {
    profile.lastKnownGood = {
      sessionId: newestGood.id,
      endedAt: newestGood.endedAt,
      score: Number(newestGood.score),
      install: profile.lastKnownGood?.install || null
    };
  }
  changedProfiles.push({ profileId, correctedSessions: corrections.filter((entry) => entry.profile === profileId).length, recentBadCount: badCount, guardrailActive: Boolean(profile.guardrail) });
}

const appliedAt = new Date().toISOString();
learning.updatedAt = appliedAt;
learning.corrections = [...priorCorrections, {
  id: correctionId,
  appliedAt,
  reason: "Removed mode-learning penalties from locally verified unrelated OneDrive/NVIDIA App crash events.",
  sessions: corrections
}].slice(-20);

const stamp = appliedAt.replace(/[:.]/g, "-");
const backupPath = path.join(dataRoot, `learning.pre-${correctionId}.${stamp}.json.bak`);
await fs.copyFile(learningPath, backupPath);
await fs.writeFile(learningPath, `${JSON.stringify(learning, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  ok: true,
  correctionId,
  backupPath,
  correctedSessionCount: corrections.length,
  changedProfiles,
  sessions: corrections
}, null, 2)}\n`);
