import path from "node:path";
import { dataDir, protectedAppRules, learnedSessionWindow } from "./config.js";
import { summarizeThermalReliability } from "./thermal-hierarchy.js";

const learningPath = path.join(dataDir, "learning.json");

const GUARDRAIL_WINDOW = 3;
const GUARDRAIL_BAD_THRESHOLD = 2;
const BAD_SCORE = 60;
const GOOD_SCORE = 80;
const GUARDRAIL_DECAY_MS = 7 * 24 * 60 * 60 * 1000;
const LEARN_MIN_DURATION_MS = 20 * 1000;
const MAX_SESSION_EVIDENCE_ITEMS = 50;

const APP_TEMP_BLOCK_MS = 24 * 60 * 60 * 1000;
const APP_SUSPECT_MS = 72 * 60 * 60 * 1000;
const APP_PROBATION_MS = 7 * 24 * 60 * 60 * 1000;
const APP_TRUSTED_MS = 14 * 24 * 60 * 60 * 1000;

export function isHardwareBugcheck(entry) {
  const sub = entry?.analysis?.subcategory || entry?.subcategory || null;
  const cat = entry?.analysis?.category || entry?.category || null;
  const code = entry?.analysis?.bugcheckCode || entry?.bugcheckCode || null;
  return sub === "bugcheck" || Boolean(code) || (cat === "crash" && sub === "bugcheck");
}
export function summarizeSessionCrashes(crashes = []) {
  const list = Array.isArray(crashes) ? crashes : [];
  let hardwareRaw = 0;
  let nonHardware = 0;
  const seen = new Set();
  let hardwareDeduped = 0;
  for (const entry of list) {
    if (isHardwareBugcheck(entry)) {
      hardwareRaw += 1;
      const code = entry?.analysis?.bugcheckCode || entry?.bugcheckCode || "bugcheck";
      const minute = String(entry?.time || entry?.analysis?.time || "").slice(0, 16);
      const key = `${code}|${minute}`;
      if (!seen.has(key)) { seen.add(key); hardwareDeduped += 1; }
    } else {
      nonHardware += 1;
    }
  }
  return { total: list.length, hardwareRaw, hardwareDeduped, nonHardware };
}
export function sessionIsModeBad(entry, badScore = 60) {
  const hasSplit = entry?.hardwareCrashes !== undefined || entry?.modeCrashes !== undefined;
  if (!hasSplit) {
    return Number(entry.score) < badScore || Number(entry.crashes || 0) > 0;
  }
  if (Number(entry.modeCrashes || 0) > 0) return true;
  const hardwareCrashes = Number(entry.hardwareCrashes || 0);
  const totalCrashes = Number(entry.crashes || 0);
  const scoreExcludingHwCrash = (hardwareCrashes > 0 && totalCrashes > 0)
    ? Math.min(100, Number(entry.score) + Math.min(60, totalCrashes * 30))
    : Number(entry.score);
  return scoreExcludingHwCrash < badScore;
}

function emptyLearning() {
  return {
    schema: "pc-control-plane-learning/v2",
    updatedAt: null,
    profiles: {},
    apps: {},
    history: []
  };
}

function normalizeProcessName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\//g, "\\").toLowerCase();
}

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.max(min, Math.min(max, n));
}

function parseTimeMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

export function validateLearningSession(session = {}) {
  if (!session || typeof session !== "object") {
    return { ok: false, reason: "missing session" };
  }
  if (!String(session.id || "").trim()) {
    return { ok: false, reason: "missing session id" };
  }

  const startedMs = parseTimeMs(session.startedAt);
  const endedMs = parseTimeMs(session.endedAt);
  if (startedMs == null || endedMs == null) {
    return { ok: false, reason: "invalid session timestamps" };
  }
  if (endedMs <= startedMs) {
    return { ok: false, reason: "non-positive session duration" };
  }
  if (endedMs - startedMs < LEARN_MIN_DURATION_MS) {
    return { ok: false, reason: "session too short to learn" };
  }

  const rawScore = Number(session.outcomeScore);
  if (!Number.isFinite(rawScore)) {
    return { ok: false, reason: "invalid outcome score" };
  }
  const score = clamp(rawScore);
  const normalized = {
    ...session,
    id: String(session.id).trim(),
    profile: String(session.profile || "competitive").trim() || "competitive",
    outcomeScore: score,
    crashes: Array.isArray(session.crashes) ? session.crashes.slice(0, MAX_SESSION_EVIDENCE_ITEMS) : [],
    offenders: Array.isArray(session.offenders) ? session.offenders.slice(0, MAX_SESSION_EVIDENCE_ITEMS) : [],
    processes: Array.isArray(session.processes) ? session.processes.slice(0, MAX_SESSION_EVIDENCE_ITEMS) : []
  };

  return {
    ok: true,
    session: normalized,
    clamped: score !== rawScore,
    rawScore,
    durationMs: endedMs - startedMs
  };
}

function addDays(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function isExpired(entry, nowMs = Date.now()) {
  const expiresMs = entry?.expiresAt ? Date.parse(entry.expiresAt) : null;
  return Number.isFinite(expiresMs) && expiresMs < nowMs;
}

function isStaticProtectedName(name) {
  const normalized = normalizeProcessName(name);
  if (!normalized) {
    return false;
  }
  return protectedAppRules.some((rule) => rule.match.some((part) => normalized.includes(part)));
}

export function appIdentityForProcess(process = {}) {
  const name = String(process.name || process.ProcessName || process.label || "").trim();
  const rawPath = process.path || process.Path || process.executablePath || process.ExecutablePath || process.exe || "";
  const normalizedPath = normalizePath(rawPath);
  const normalizedName = normalizeProcessName(name);
  return {
    key: normalizedPath ? `path:${normalizedPath}` : `name:${normalizedName || "unknown"}`,
    name: name || normalizedName || "unknown",
    normalizedName,
    path: rawPath ? String(rawPath) : null,
    identityConfidence: normalizedPath ? "high" : "low"
  };
}

function normalizeLearning(value) {
  if (!value || typeof value !== "object" || !value.profiles) {
    return emptyLearning();
  }
  return {
    schema: "pc-control-plane-learning/v2",
    updatedAt: value.updatedAt || null,
    profiles: value.profiles || {},
    apps: value.apps || {},
    history: Array.isArray(value.history) ? value.history : []
  };
}

async function readLearningFile(readJson) {
  return normalizeLearning(await readJson(learningPath, null));
}

function defaultAppEntry(identity) {
  return {
    key: identity.key,
    name: identity.name,
    normalizedName: identity.normalizedName,
    path: identity.path,
    identityConfidence: identity.identityConfidence,
    state: "observed",
    confidence: 0,
    userDecision: null,
    firstSeenAt: null,
    lastSeenAt: null,
    expiresAt: null,
    cleanSessions: 0,
    badSessions: 0,
    offenderSightings: 0,
    crashCorrelations: 0,
    modes: {},
    evidence: []
  };
}

function getAppEntry(learning, process) {
  const identity = appIdentityForProcess(process);
  const existing = learning.apps[identity.key] || defaultAppEntry(identity);
  existing.key = identity.key;
  existing.name = existing.name || identity.name;
  existing.normalizedName = existing.normalizedName || identity.normalizedName;
  existing.path = existing.path || identity.path;
  existing.identityConfidence = existing.identityConfidence || identity.identityConfidence;
  existing.modes = existing.modes || {};
  existing.evidence = Array.isArray(existing.evidence) ? existing.evidence : [];
  return existing;
}

function addEvidence(entry, evidence) {
  entry.evidence.push({
    at: new Date().toISOString(),
    ...evidence
  });
  entry.evidence = entry.evidence.slice(-12);
}

function modeStats(entry, modeId) {
  const key = modeId || "unknown";
  entry.modes[key] = entry.modes[key] || {
    seen: 0,
    cleanSessions: 0,
    badSessions: 0,
    offenderSightings: 0,
    crashCorrelations: 0
  };
  return entry.modes[key];
}

function compactProcess(process = {}) {
  return {
    name: process.name,
    pid: process.pid,
    path: process.path || null,
    workingSetMB: process.workingSetMB,
    cpuPct: process.cpuPct,
    cpuSeconds: process.cpuSeconds
  };
}

function keySetFor(processes = []) {
  return new Set(processes.map((process) => appIdentityForProcess(process).key));
}

function updateAppState(entry) {
  if (isExpired(entry) && entry.userDecision !== "allow") {
    entry.state = "expired";
    entry.expiresAt = null;
    return entry;
  }
  if (entry.userDecision === "allow") {
    entry.state = "trusted-suggested";
    entry.confidence = 100;
    entry.expiresAt = null;
    return entry;
  }
  if (entry.userDecision === "ignore") {
    entry.state = "observed";
    entry.expiresAt = null;
    return entry;
  }
  if (entry.userDecision === "temporary-block") {
    entry.state = "blocked-this-session";
    entry.confidence = Math.max(entry.confidence || 0, 90);
    entry.expiresAt = entry.expiresAt || addDays(APP_TEMP_BLOCK_MS);
    return entry;
  }
  if (isStaticProtectedName(entry.name)) {
    entry.state = "observed";
    entry.expiresAt = null;
  } else if (entry.badSessions >= 2 && entry.crashCorrelations > 0) {
    entry.state = "blocked-this-session";
    entry.expiresAt = addDays(APP_TEMP_BLOCK_MS);
  } else if (entry.badSessions >= 2 || entry.offenderSightings >= 3) {
    entry.state = "suspect";
    entry.expiresAt = addDays(APP_SUSPECT_MS);
  } else if (entry.cleanSessions >= 3) {
    entry.state = "trusted-suggested";
    entry.expiresAt = addDays(APP_TRUSTED_MS);
  } else if (entry.cleanSessions >= 2) {
    entry.state = "probation-allow";
    entry.expiresAt = addDays(APP_PROBATION_MS);
  } else if (!entry.state || entry.state === "expired") {
    entry.state = "observed";
    entry.expiresAt = null;
  }

  entry.confidence = clamp(
    entry.cleanSessions * 22 -
      entry.badSessions * 28 -
      entry.offenderSightings * 6 -
      entry.crashCorrelations * 20 +
      (entry.identityConfidence === "high" ? 10 : 0)
  );
  return entry;
}

function updateAppsFromSession(learning, session) {
  const score = Number(session.outcomeScore);
  const profileId = session.profile || "unknown";
  const endedAt = session.endedAt || new Date().toISOString();
  const crashes = Array.isArray(session.crashes) ? session.crashes : [];
  const offenders = Array.isArray(session.offenders) ? session.offenders.map(compactProcess) : [];
  const processes = Array.isArray(session.processes) ? session.processes.map(compactProcess) : [];
  const offenderKeys = keySetFor(offenders);
  const combined = [...processes, ...offenders];
  const seen = new Map();
  for (const process of combined) {
    const identity = appIdentityForProcess(process);
    if (!identity.normalizedName || identity.normalizedName === "unknown") {
      continue;
    }
    if (!seen.has(identity.key)) {
      seen.set(identity.key, { ...process, ...identity });
    }
  }

  const cleanSession = score >= GOOD_SCORE && crashes.length === 0;
  const badSession = score < BAD_SCORE || crashes.length > 0;
  for (const process of seen.values()) {
    const entry = getAppEntry(learning, process);
    const stats = modeStats(entry, profileId);
    const offender = offenderKeys.has(entry.key);
    entry.firstSeenAt = entry.firstSeenAt || endedAt;
    entry.lastSeenAt = endedAt;
    stats.seen += 1;

    if (cleanSession && !offender) {
      entry.cleanSessions += 1;
      stats.cleanSessions += 1;
      addEvidence(entry, { type: "clean-session", sessionId: session.id, profileId, score });
    }
    if (offender) {
      entry.offenderSightings += 1;
      stats.offenderSightings += 1;
      addEvidence(entry, { type: "offender", sessionId: session.id, profileId, score });
    }
    if (badSession && offender) {
      entry.badSessions += 1;
      stats.badSessions += 1;
      addEvidence(entry, { type: "bad-session-offender", sessionId: session.id, profileId, score });
    }
    if (crashes.length > 0 && offender) {
      entry.crashCorrelations += 1;
      stats.crashCorrelations += 1;
      addEvidence(entry, { type: "crash-correlated", sessionId: session.id, profileId, crashes: crashes.length });
    }

    learning.apps[entry.key] = updateAppState(entry);
  }
}

function appSummary(entry) {
  return {
    key: entry.key,
    name: entry.name,
    normalizedName: entry.normalizedName,
    path: entry.path || null,
    identityConfidence: entry.identityConfidence,
    state: entry.state || "observed",
    confidence: entry.confidence || 0,
    userDecision: entry.userDecision || null,
    firstSeenAt: entry.firstSeenAt || null,
    lastSeenAt: entry.lastSeenAt || null,
    expiresAt: entry.expiresAt || null,
    cleanSessions: entry.cleanSessions || 0,
    badSessions: entry.badSessions || 0,
    offenderSightings: entry.offenderSightings || 0,
    crashCorrelations: entry.crashCorrelations || 0,
    modes: entry.modes || {},
    evidence: (entry.evidence || []).slice(-5)
  };
}

function summarizeApps(learning) {
  const now = Date.now();
  const entries = Object.values(learning.apps || {})
    .map((entry) => (isExpired(entry, now) && entry.userDecision !== "allow" ? { ...entry, state: "expired" } : entry))
    .filter((entry) => entry.state !== "expired")
    .map(appSummary)
    .sort((a, b) => {
      const stateRank = { "blocked-this-session": 4, suspect: 3, "trusted-suggested": 2, "probation-allow": 1, observed: 0 };
      const rankDelta = (stateRank[b.state] || 0) - (stateRank[a.state] || 0);
      if (rankDelta) return rankDelta;
      return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
    });

  return {
    updatedAt: learning.updatedAt,
    total: entries.length,
    entries,
    suggestedAllow: entries.filter((entry) => ["probation-allow", "trusted-suggested"].includes(entry.state)),
    temporaryBlocks: entries.filter((entry) => entry.state === "blocked-this-session"),
    suspects: entries.filter((entry) => entry.state === "suspect"),
    userAllowed: entries.filter((entry) => entry.userDecision === "allow")
  };
}

export function createLearningStore({ readJson, writeJson, appendAudit, archive = null }) {
  const archiveAppend = async (record) => {
    if (!archive || typeof archive.append !== "function") return;
    try { await archive.append(record); } catch { /* never block learning */ }
  };

  async function readLearning() {
    return readLearningFile(readJson);
  }

  async function readArchivedHistory(options = {}) {
    if (!archive || typeof archive.readRecent !== "function") {
      return { ok: true, source: "none", sessions: [] };
    }
    try {
      return await archive.readRecent(options);
    } catch (error) {
      return { ok: false, source: "error", error: error?.message || String(error), sessions: [] };
    }
  }

  async function updateFromSession(session) {
    const validation = validateLearningSession(session);
    if (!validation.ok) {
      await appendAudit({
        level: "info",
        action: "learning.session-rejected",
        message: `Learning skipped session: ${validation.reason}.`,
        details: {
          reason: validation.reason,
          sessionId: session?.id || null,
          profile: session?.profile || null
        }
      });
      return null;
    }
    session = validation.session;
    if (validation.clamped) {
      await appendAudit({
        level: "warn",
        action: "learning.session-clamped",
        message: `Learning clamped session score from ${validation.rawScore} to ${session.outcomeScore}.`,
        details: {
          sessionId: session.id,
          profile: session.profile,
          rawScore: validation.rawScore,
          score: session.outcomeScore
        }
      });
    }
    const learning = await readLearningFile(readJson);
    const profileId = session.profile || "competitive";
    const profile = learning.profiles[profileId] || { sessions: [], lastKnownGood: null, guardrail: null };

    const crashInfo = summarizeSessionCrashes(session.crashes);
    const sessionRecord = {
      id: session.id,
      endedAt: session.endedAt,
      score: Number(session.outcomeScore),
      crashes: crashInfo.total,
      hardwareCrashes: crashInfo.hardwareDeduped,
      modeCrashes: crashInfo.nonHardware,
      thermal: session.thermal ? {
        worstSeverity: session.thermal.worstSeverity || "ok",
        worstComponent: session.thermal.worstComponent || null,
        penalty: Number(session.thermal.penalty) || 0,
        guardActivations: Number(session.thermal.guardActivations) || 0,
        peaksC: session.thermal.peaksC || {},
        severitySeconds: session.thermal.severitySeconds || {}
      } : null
    };
    profile.sessions.push(sessionRecord);
    profile.sessions = profile.sessions.slice(-learnedSessionWindow);
    profile.thermal = summarizeThermalReliability(profile.sessions);
    await archiveAppend({ at: new Date().toISOString(), profileId, ...sessionRecord });

    const score = Number(session.outcomeScore);
    if (score >= GOOD_SCORE) {
      profile.lastKnownGood = {
        sessionId: session.id,
        endedAt: session.endedAt,
        score,
        install: session.discoveredInstall?.root || null
      };
    }

    const recent = profile.sessions.slice(-GUARDRAIL_WINDOW);
    const badCount = recent.filter((entry) => sessionIsModeBad(entry, BAD_SCORE)).length;
    const previouslyArmed = Boolean(profile.guardrail);

    if (badCount >= GUARDRAIL_BAD_THRESHOLD && recent.length >= GUARDRAIL_WINDOW - 1) {
      profile.guardrail = {
        armedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + GUARDRAIL_DECAY_MS).toISOString(),
        reason: `${badCount} of last ${recent.length} sessions ended badly (score <${BAD_SCORE} or crash signals).`,
        evidence: recent
      };
      if (!previouslyArmed) {
        await appendAudit({
          level: "warn",
          action: "learning.guardrail-armed",
          message: `Learned guardrail: auto-escalation into "${profileId}" paused for 7 days - ${profile.guardrail.reason}`,
          details: { profileId, recent }
        });
      }
    } else if (previouslyArmed && badCount === 0 && recent.length >= GUARDRAIL_WINDOW - 1) {
      profile.guardrail = null;
      await appendAudit({
        level: "info",
        action: "learning.guardrail-cleared",
        message: `Learned guardrail cleared for "${profileId}": recent sessions are healthy again.`,
        details: { profileId, recent }
      });
    }

    learning.profiles[profileId] = profile;
    updateAppsFromSession(learning, session);
    learning.updatedAt = new Date().toISOString();
    learning.history.push({
      at: learning.updatedAt,
      profileId,
      sessionId: session.id,
      score,
      thermal: session.thermal ? {
        worstSeverity: session.thermal.worstSeverity,
        worstComponent: session.thermal.worstComponent,
        penalty: session.thermal.penalty
      } : null,
      guardrail: Boolean(profile.guardrail),
      appCount: Object.keys(learning.apps || {}).length
    });
    learning.history = learning.history.slice(-75);

    await writeJson(learningPath, learning);
    return learning;
  }

  async function activeGuardrails() {
    const learning = await readLearningFile(readJson);
    const now = Date.now();
    const avoid = [];
    for (const [profileId, profile] of Object.entries(learning.profiles)) {
      const guardrail = profile.guardrail;
      if (!guardrail) {
        continue;
      }
      if (guardrail.expiresAt && Date.parse(guardrail.expiresAt) < now) {
        continue;
      }
      avoid.push({ profileId, reason: guardrail.reason, expiresAt: guardrail.expiresAt });
    }
    return avoid;
  }

  async function appReputationSummary() {
    return summarizeApps(await readLearningFile(readJson));
  }

  async function appReputationMap() {
    const summary = await appReputationSummary();
    return Object.fromEntries(summary.entries.map((entry) => [entry.key, entry]));
  }

  async function applyAppDecision({ action, key, process = null, reason = "manual-ui" } = {}) {
    const allowed = new Set(["promote-allow", "demote", "ignore", "clear", "temporary-block"]);
    if (!allowed.has(action)) {
      return { ok: false, message: `Unknown app learning decision: ${action}` };
    }
    const learning = await readLearningFile(readJson);
    const identity = key
      ? { key, name: key.replace(/^name:/, "").replace(/^path:/, ""), normalizedName: key, path: null, identityConfidence: "low" }
      : appIdentityForProcess(process || {});
    const entry = learning.apps[identity.key] || defaultAppEntry(identity);
    entry.lastSeenAt = entry.lastSeenAt || new Date().toISOString();

    if (action === "clear") {
      delete learning.apps[identity.key];
    } else {
      entry.userDecision =
        action === "promote-allow" ? "allow" :
        action === "temporary-block" ? "temporary-block" :
        action;
      if (action === "promote-allow") {
        entry.state = "trusted-suggested";
        entry.confidence = 100;
        entry.expiresAt = null;
      } else if (action === "temporary-block") {
        entry.state = "blocked-this-session";
        entry.confidence = 100;
        entry.expiresAt = addDays(APP_TEMP_BLOCK_MS);
      } else {
        entry.state = "observed";
        entry.expiresAt = null;
      }
      addEvidence(entry, { type: `user-${action}`, reason });
      learning.apps[identity.key] = updateAppState(entry);
    }

    learning.updatedAt = new Date().toISOString();
    learning.history.push({ at: learning.updatedAt, action: `app.${action}`, key: identity.key, reason });
    learning.history = learning.history.slice(-75);
    await writeJson(learningPath, learning);
    await appendAudit({
      level: action === "temporary-block" ? "warn" : "info",
      action: `learning.app.${action}`,
      message: `Learning app decision ${action}: ${entry.name || identity.key}.`,
      details: { key: identity.key, reason }
    });
    return { ok: true, app: action === "clear" ? null : appSummary(learning.apps[identity.key]), appReputation: summarizeApps(learning) };
  }

  async function summary() {
    const learning = await readLearningFile(readJson);
    const guardrails = await activeGuardrails();
    const profiles = Object.fromEntries(
      Object.entries(learning.profiles).map(([id, profile]) => {
        const scores = profile.sessions.map((entry) => entry.score);
        return [
          id,
          {
            sessions: profile.sessions.length,
            avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
            lastScore: scores.at(-1) ?? null,
            thermal: profile.thermal || summarizeThermalReliability(profile.sessions || []),
            lastKnownGood: profile.lastKnownGood,
            guardrail: profile.guardrail ? { reason: profile.guardrail.reason, expiresAt: profile.guardrail.expiresAt } : null
          }
        ];
      })
    );
    return { updatedAt: learning.updatedAt, profiles, guardrails, appReputation: summarizeApps(learning) };
  }

  return { readLearning, updateFromSession, activeGuardrails, appReputationSummary, appReputationMap, applyAppDecision, summary, readArchivedHistory };
}
