import fs from "node:fs/promises";
import { dataDir, priorityAppSessionsPath } from "./config.js";
import { finalizeThermalOutcome, updateThermalOutcome } from "./thermal-hierarchy.js";

async function readSessionsFile() {
  try {
    const parsed = JSON.parse(await fs.readFile(priorityAppSessionsPath, "utf8"));
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

async function writeSessionsFile(sessions) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    priorityAppSessionsPath,
    `${JSON.stringify({ schema: "pc-control-plane-health-sessions/v2", sessions }, null, 2)}\n`,
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

export function eventsDuringSession(session = {}, events = []) {
  const startedAt = Date.parse(String(session?.startedAt || ""));
  const endedAt = Date.parse(String(session?.endedAt || ""));
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return [];
  }
  return (Array.isArray(events) ? events : []).filter((event) => {
    const eventAt = Date.parse(String(event?.time || ""));
    return Number.isFinite(eventAt) && eventAt >= startedAt && eventAt <= endedAt;
  });
}

export function actionableCrashesDuringSession(session = {}, policy = {}) {
  return eventsDuringSession(session, policy?.eventAnalysis?.recentActionableCrashSignals || []);
}

export async function readPriorityAppSessions(limit = 5) {
  return (await readSessionsFile())
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

export async function startPriorityAppSessionRecord({ source = "observer", profile = "competitive", discovery = null, telemetry = null, policy = null } = {}) {
  const sessions = await readSessionsFile();
  const active = sessions.find((session) => !session.endedAt);
  if (active) {
    return active;
  }
  const session = {
    id: `health-${new Date().toISOString().replace(/[:.]/g, "")}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    source,
    profile,
    trackedWorkload: discovery?.candidates?.[0] || null,
    crashes: [],
    correlatedEvents: [],
    offenders: [],
    processes: [],
    thermal: telemetry ? updateThermalOutcome({}, telemetry, {
      modeId: profile,
      foregroundActive: true
    }) : null,
    restoreResult: null,
    outcomeScore: null,
    status: "active"
  };
  sessions.push(session);
  await writeSessionsFile(sessions.slice(-20));
  return session;
}

export async function samplePriorityAppSessionThermals({ telemetry = null, policy = null } = {}) {
  if (!telemetry) {
    return null;
  }
  const sessions = await readSessionsFile();
  const active = [...sessions].reverse().find((session) => !session.endedAt);
  if (!active) {
    return null;
  }
  active.thermal = updateThermalOutcome(active.thermal || {}, telemetry, {
    modeId: active.profile || "competitive",
    foregroundActive: true
  });
  await writeSessionsFile(sessions.slice(-20));
  return active.thermal;
}

export async function endPriorityAppSessionRecord({ telemetry = null, policy = null, restoreResult = null } = {}) {
  const sessions = await readSessionsFile();
  const active = [...sessions].reverse().find((session) => !session.endedAt);
  if (!active) {
    return null;
  }
  active.endedAt = new Date().toISOString();
  active.crashes = actionableCrashesDuringSession(active, policy);
  active.correlatedEvents = [
    ...active.crashes,
    ...eventsDuringSession(active, policy?.eventAnalysis?.hardwareSignals || [])
  ].slice(0, 10);
  active.offenders = policy?.offenders || [];
  active.processes = compactProcesses(telemetry?.processes || []);
  active.thermal = telemetry
    ? finalizeThermalOutcome(active.thermal || {}, telemetry, {
        modeId: active.profile || "competitive",
        foregroundActive: true
      })
    : active.thermal || null;
  active.restoreResult = restoreResult;
  active.outcomeScore = scorePriorityAppSession(active, telemetry, policy);
  active.status = active.crashes.length ? "needs-review" : "completed";
  await writeSessionsFile(sessions.slice(-20));
  return active;
}

export async function attachFrameStats(frameStats) {
  if (!frameStats || frameStats.available === false) {
    return null;
  }
  const sessions = await readSessionsFile();
  const active = [...sessions].reverse().find((session) => !session.endedAt);
  if (!active) {
    return null;
  }
  active.frameStats = frameStats;
  await writeSessionsFile(sessions.slice(-20));
  return active;
}

export function scorePriorityAppSession(session, telemetry, policy) {
  let score = 100;
  score -= Math.min(60, (session.crashes?.length || 0) * 30);
  score -= Math.min(20, (session.offenders?.length || 0) * 4);
  if (policy?.health?.state === "Strained") score -= 20;
  score -= Math.min(30, Number(session.thermal?.penalty) || 0);

  const fs = session.frameStats;
  if (fs && fs.available) {
    if (Number.isFinite(fs.p1LowFps)) {
      if (fs.p1LowFps < 60) score -= 25;
      else if (fs.p1LowFps < 90) score -= 12;
      else if (fs.p1LowFps < 120) score -= 4;
    }
    if (Number.isFinite(fs.stutterRatio)) {
      score -= Math.min(20, Math.round(fs.stutterRatio * 100));
    }
  }
  return Math.max(0, Math.min(100, score));
}
