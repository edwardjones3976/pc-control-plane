import fs from "node:fs/promises";
import { contextSessionsPath, dataDir } from "./config.js";
import { actionableCrashesDuringSession } from "./sessions.js";
import { finalizeThermalOutcome, updateThermalOutcome } from "./thermal-hierarchy.js";

const TRACKED = {
  "Agentic Work": "agentic",
  "Media / Video": "balanced",
  "Focused Work": "conservative"
};

export function contextProfileFor(label) {
  return TRACKED[label] || null;
}

async function readFile() {
  try {
    const parsed = JSON.parse(await fs.readFile(contextSessionsPath, "utf8"));
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

async function writeFile(sessions) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    contextSessionsPath,
    `${JSON.stringify({ schema: "pc-control-plane-context-sessions/v1", sessions }, null, 2)}\n`,
    "utf8"
  );
}

function compactProcesses(processes = [], limit = 50) {
  return (Array.isArray(processes) ? processes : [])
    .slice(0, limit)
    .map((process) => ({
      name: process.name,
      pid: process.pid,
      path: process.path || null,
      cpuPct: process.cpuPct,
      cpuSeconds: process.cpuSeconds,
      workingSetMB: process.workingSetMB
    }));
}

export async function readContextSessions(limit = 5) {
  return (await readFile())
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

export async function startContextSession({ label, profile, telemetry = null }) {
  const sessions = await readFile();
  const active = sessions.find((session) => !session.endedAt);
  if (active && active.label === label) {
    return active; // already tracking this context
  }
  const session = {
    id: `${profile}-${new Date().toISOString().replace(/[:.]/g, "")}`,
    label,
    profile,
    startedAt: new Date().toISOString(),
    endedAt: null,
    crashes: [],
    offenders: [],
    processes: [],
    thermal: telemetry ? updateThermalOutcome({}, telemetry, {
      modeId: profile,
      foregroundActive: false
    }) : null,
    outcomeScore: null,
    status: "active"
  };
  sessions.push(session);
  await writeFile(sessions.slice(-30));
  return session;
}

export async function sampleContextSessionThermals({ telemetry = null } = {}) {
  if (!telemetry) {
    return null;
  }
  const sessions = await readFile();
  const active = [...sessions].reverse().find((session) => !session.endedAt);
  if (!active) {
    return null;
  }
  active.thermal = updateThermalOutcome(active.thermal || {}, telemetry, {
    modeId: active.profile || "balanced",
    foregroundActive: false
  });
  await writeFile(sessions.slice(-30));
  return active.thermal;
}

export function scoreContextSession(session, telemetry, policy) {
  let score = 100;
  score -= Math.min(60, (session.crashes?.length || 0) * 30);
  score -= Math.min(20, (policy?.offenders?.length || 0) * 4);
  if (policy?.health?.state === "Strained") score -= 25;
  else if (policy?.health?.state === "Warm") score -= 8;
  score -= Math.min(30, Number(session.thermal?.penalty) || 0);
  return Math.max(0, score);
}

export async function endContextSession({ telemetry = null, policy = null } = {}) {
  const sessions = await readFile();
  const active = [...sessions].reverse().find((session) => !session.endedAt);
  if (!active) {
    return null;
  }
  active.endedAt = new Date().toISOString();
  active.durationSeconds = Math.round((Date.parse(active.endedAt) - Date.parse(active.startedAt)) / 1000);
  active.crashes = actionableCrashesDuringSession(active, policy);
  active.offenders = (policy?.offenders || []).map((o) => ({ name: o.name, pid: o.pid, path: o.path || null }));
  active.processes = compactProcesses(telemetry?.processes || []);
  active.thermal = telemetry
    ? finalizeThermalOutcome(active.thermal || {}, telemetry, {
        modeId: active.profile || "balanced",
        foregroundActive: false
      })
    : active.thermal || null;
  active.outcomeScore = scoreContextSession(active, telemetry, policy);
  active.status = active.crashes.length ? "needs-review" : "completed";
  await writeFile(sessions.slice(-30));
  active.tooShortToLearn = active.durationSeconds < 20;
  return active;
}
