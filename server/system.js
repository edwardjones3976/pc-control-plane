import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createComfortController } from "./desktop-comfort.js";
export { desktopComfortPreset } from "./desktop-comfort.js";
import {
  adapterManifests,
  validateAdapterManifests
} from "./adapters.js";
import {
  appRoot,
  dataDir,
  defaultState,
  diagnosticTrapsDir,
  archiveRoot,
  plansDir,
  protectedAppRules,
  recoveryPath,
  modes,
  scripts,
  statePath,
  workspaceRoot
} from "./config.js";
import { readLedger, appendLedgerEvent, findIncompleteChains } from "./ledger.js";
import { readSingleInstanceLock } from "./lock.js";
import { planPolicy, executableActions, createCorrelationId } from "./planner.js";
import { currentPowerPlanName } from "./invariants.js";
import { analyzeEvents, evaluatePolicy, getMode, isProtectedProcess, effectiveRamUsedPct, preferBandBeforeModeSwitch, modeBandCeiling } from "./policy.js";
import { buildFailureDiagnostics, listFailureProfiles } from "./failures.js";
import { createSnapshot, listSnapshots } from "./snapshots.js";
import {
  attachFrameStats,
  endPriorityAppSessionRecord,
  readPriorityAppSessions,
  samplePriorityAppSessionThermals,
  startPriorityAppSessionRecord
} from "./sessions.js";
import { explainDecision, simulateAll, simulateScenario, SIMULATION_SCENARIOS } from "./explain.js";
import { classifyGameCandidate, shouldProbe3dEngine, GAME_CONFIRMED_AT } from "./game-identity.js";
import {
  COMPETITIVE_PRIOR,
  GAME_STANCES,
  decideLaunchStance,
  decideBandTrial,
  enrollFlipOptimization,
  gameLibrarySnapshot,
  markGameVerdict,
  readGameLibrary,
  recordBandTrialSample,
  recordGameOutcome,
  recordGameWarmup,
  scanGameLibrary,
  titleThermalBias
} from "./game-library.js";
import {
  applyEcoCage,
  applyIrqShepherd,
  auditIrqShepherd,
  revertIrqShepherd,
  competitiveTuningStatus,
  drainEngagementTemps,
  engageCompetitiveLatches,
  engageGpuClockLatch,
  readFocusSteals,
  releaseCompetitiveLatches,
  releaseGpuClockLatch,
  restoreOrphanedLatches,
  sampleDpcHealth
} from "./competitive-tuning.js";
import { convergeInvariants } from "./convergence.js";
import {
  evaluateCpuReliefEligibility,
  evaluateReliefGate,
  nextSustainedPressureStreak,
  recordReliefSample,
  normalizeReliefStore,
  RELIEF_TUNING
} from "./relief.js";
import { recordSelfError, summarizeSelfHealth, normalizeSelfHealth } from "./self-health.js";
import {
  buildSelfTreatmentPlan,
  normalizeSelfTreatmentStore,
  recordSelfTreatmentAttempt,
  recordSelfTreatmentOutcome,
  summarizeSelfTreatment
} from "./self-treatment.js";
import { attributeResourcePressure } from "./attribution.js";
import { recordEfficacy, summarizeEfficacy, healthScore, normalizeEfficacy } from "./efficacy.js";
import { buildAutonomousMlGovernor } from "./ml-governor.js";
import {
  normalizeGovernorDecisionStore,
  recordGovernorDecision,
  summarizeGovernorDecisionLedger,
  verifyGovernorDecisions
} from "./ml-decision-ledger.js";
import { buildMlExecutionGate } from "./ml-action-registry.js";
import { planMlExecution } from "./ml-executor.js";
import { buildNorthStarOptimizer } from "./ml-optimizer.js";
import {
  normalizeIncidentLearningStore,
  observeIncidentLearning,
  summarizeIncidentLearning
} from "./incident-learning.js";
import { summarizeExternalPerformanceKnowledge } from "./external-performance-knowledge.js";
import { summarizeHardwareProfile } from "./hardware-profile.js";
import { pushThermalSample, evaluatePredictiveCooling, calibrationMarginC } from "./thermal-trend.js";
import { THERMAL_THRESHOLDS } from "./thermal-hierarchy.js";
import { parseWingetUpgrades, summarizeUpdates } from "./updates.js";
import { createLearningStore } from "./learning.js";
import { POWER_LADDER, MODE_BANDS, resolveAdaptivePlanStateless, getLastResolvedPlan, isCompetitiveGamingSession } from "./power-adaptive.js";
import { buildArchitectureSnapshot } from "./precedence.js";
import { handleOffenders, resumeAllSuspended } from "./offenders.js";
import { captureFrameStats, presentMonStatus } from "./presentmon.js";
import {
  contextProfileFor,
  endContextSession,
  readContextSessions,
  sampleContextSessionThermals,
  startContextSession
} from "./context-sessions.js";
import {
  armDiagnosticTraps,
  disarmDiagnosticTraps,
  getDiagnosticTrapStatus,
  recordDiagnosticTrapWarning
} from "./diagnostic-traps.js";
import { classifyThermalState } from "./thermal-hierarchy.js";
import {
  getAuditArchiveStatus,
  appendAuditRecords,
  maybeArchiveOldAuditRecords,
  readAuditWindow
} from "./audit-archive.js";

const MAX_BUFFER = 1024 * 1024 * 8;
const TELEMETRY_TIMEOUT_MS = Number(process.env.PC_CONTROL_TELEMETRY_TIMEOUT_MS || 45000);
const MANUAL_TRANSITION_HOLD_MS = Number(process.env.PC_CONTROL_MANUAL_TRANSITION_HOLD_MS || 60 * 1000);
const AUDIT_COALESCE_WINDOW_MS = Number(process.env.PC_CONTROL_AUDIT_COALESCE_WINDOW_MS || 10 * 60 * 1000);
const MODE_SWITCH_STABILITY_DWELL_MS = Number(process.env.PC_CONTROL_MODE_SWITCH_STABILITY_DWELL_MS || 30 * 1000);
const MODE_SWITCH_STABILITY_CONFIRMATIONS = Math.max(1, Number(process.env.PC_CONTROL_MODE_SWITCH_STABILITY_CONFIRMATIONS || 2));
const REST_MODE_RETURN_DWELL_MS = Number(process.env.PC_CONTROL_REST_MODE_RETURN_DWELL_MS || 2 * 60 * 1000);
const REST_MODE_RETURN_CONFIRMATIONS = Math.max(2, Number(process.env.PC_CONTROL_REST_MODE_RETURN_CONFIRMATIONS || 3));
const PLAN_APPLY_MAX_AGE_MS = Number(process.env.PC_CONTROL_PLAN_APPLY_MAX_AGE_MS || 5 * 60 * 1000);
const EXTENDED_IDLE_MS = Number(process.env.PC_CONTROL_EXTENDED_IDLE_MS || 60 * 60 * 1000);
export const OVERDRIVE_LOCK_MS = Number(process.env.PC_CONTROL_OVERDRIVE_LOCK_MS || 20 * 60 * 1000);
const OVERDRIVE_LOCK_SAFETY_SOURCES = new Set([
  "safety", "crash", "thermal", "failure", "panic", "restore", "recovery", "observer-safety"
]);
const OVERDRIVE_AGENT_SOURCES = new Set([
  "observer", "auto", "autonomous", "governor", "ml", "ml-executor", "ml-governor", "convergence", "self-heal"
]);
const LHM_DISCOVERY_TTL_MS = Number(process.env.PC_CONTROL_LHM_DISCOVERY_TTL_MS || 10 * 60 * 1000);
const LHM_DISCOVERY_MAX_ENTRIES = Number(process.env.PC_CONTROL_LHM_DISCOVERY_MAX_ENTRIES || 2500);
const LHM_DISCOVERY_MAX_DEPTH = Number(process.env.PC_CONTROL_LHM_DISCOVERY_MAX_DEPTH || 7);
const observerState = {
  running: false,
  tickInFlight: false,
  skippedOverlappingTicks: 0,
  lastTickAt: null,
  lastHealth: null,
  lastPriority: null,
  lastSuggestedMode: null,
  lastFailureSignature: null,
  lastHighLoadRunning: null,
  lastAutoApplyAt: null,
  manualTransitionHoldUntil: null,
  manualTransitionTarget: null,
  manualTransitionReason: null,
  lastManualHoldAudit: null,
  pendingAutoTarget: null,
  pendingAutoTargetSince: null,
  pendingAutoTargetConfirmations: 0,
  lastModeStabilityAudit: null,
  gamingCriticalStreak: 0,
  lastGamingHoldAudit: null,
  lastGamingRecoveryAudit: null,
  idleReturnMode: null,
  idleReturnModeStoredAt: null,
  idleReturnOverdriveBlocked: false,
  lastIdleAudit: null,
  lastContextLabel: null,
  lastContextSessionStart: 0,
  frameCaptureInFlight: false,
  frameCapturedForSession: null,
  lastMemoryReleaseAt: null,
  lastMemoryBackoffAudit: null,
  lastCpuReliefAt: null,
  cpuPressureStreak: 0,
  cpuReliefInFlight: false,
  lastNetworkDiagnosisAt: null,
  lastGpuReliefAt: null,
  gpuReliefHoldUntil: null,
  pendingGpuReliefSample: null,
  lastFailureAutonomySignature: null,
  lastFailureProactiveSignature: null,
  lastReliefGateSignature: null,
  lastDriverContainmentAuditSignature: null,
  contextAuditKeys: [],
  lastFailureTrapAttemptAt: null,
  lastMlExecutionAudit: null,
  lastMlOptimizerAudit: null,
  selfTreatmentInFlight: false,
  lastSelfTreatmentAudit: null,
  lastError: null
};

let observerTimer = null;
let observerTickPromise = null;
const observerBackgroundTasks = new Set();

function trackObserverTask(promise) {
  observerBackgroundTasks.add(promise);
  promise.then(() => observerBackgroundTasks.delete(promise), () => observerBackgroundTasks.delete(promise));
  return promise;
}

export async function stopObserverLoop() {
  observerState.running = false;
  clearInterval(observerTimer);
  observerTimer = null;
  await observerTickPromise;
  while (observerBackgroundTasks.size) await Promise.allSettled([...observerBackgroundTasks]);
}

const libreHardwareMonitorLibCache = {
  path: null,
  checkedAt: 0
};

function holdManualTransition(targetModeId, reason, holdMs = MANUAL_TRANSITION_HOLD_MS) {
  if (!targetModeId || holdMs <= 0) {
    return;
  }
  observerState.manualTransitionHoldUntil = new Date(Date.now() + holdMs).toISOString();
  observerState.manualTransitionTarget = targetModeId;
  observerState.manualTransitionReason = reason;
}

function manualTransitionHold() {
  const untilMs = observerState.manualTransitionHoldUntil
    ? Date.parse(observerState.manualTransitionHoldUntil)
    : 0;
  const active = Number.isFinite(untilMs) && untilMs > Date.now();
  if (!active && observerState.manualTransitionHoldUntil) {
    observerState.manualTransitionHoldUntil = null;
    observerState.manualTransitionTarget = null;
    observerState.manualTransitionReason = null;
    observerState.lastManualHoldAudit = null;
  }
  return {
    active,
    until: active ? observerState.manualTransitionHoldUntil : null,
    target: active ? observerState.manualTransitionTarget : null,
    reason: active ? observerState.manualTransitionReason : null
  };
}

async function hydrateObserverContextFromActiveSession(contextLabel, trackedProfile) {
  if (observerState.lastContextLabel !== null) {
    return;
  }
  const active = (await readContextSessions(30)).find((session) => !session.endedAt);
  if (!active) {
    return;
  }
  observerState.lastContextLabel = active.label || null;
  observerState.lastContextSessionStart = Date.parse(active.startedAt || "") || Date.now();
  if (active.label === contextLabel && active.profile === trackedProfile) {
    observerState.frameCapturedForSession = observerState.lastContextSessionStart;
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatDurationSummary(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 60_000) {
    return `${Math.max(1, Math.round(value / 1000))}s`;
  }
  if (value < 60 * 60_000) {
    return `${Math.round(value / 60_000)}m`;
  }
  return `${Math.round(value / (60 * 60_000))}h`;
}

export function normalizeInputTelemetry(input = {}, { nowMs = Date.now(), thresholdMs = EXTENDED_IDLE_MS } = {}) {
  const available = input?.available !== false && (
    Number.isFinite(Number(input?.idleMs)) ||
    Number.isFinite(Number(input?.idleSeconds)) ||
    Number.isFinite(Number(input?.idleMinutes))
  );
  const threshold = Number.isFinite(Number(thresholdMs)) && Number(thresholdMs) > 0
    ? Number(thresholdMs)
    : EXTENDED_IDLE_MS;
  if (!available) {
    return {
      available: false,
      idleMs: null,
      idleSeconds: null,
      idleMinutes: null,
      lastInputAt: null,
      thresholdMs: threshold,
      isExtendedIdle: false,
      error: input?.error || "Input idle telemetry unavailable."
    };
  }
  const idleMs = Number.isFinite(Number(input.idleMs))
    ? Number(input.idleMs)
    : Number.isFinite(Number(input.idleSeconds))
      ? Number(input.idleSeconds) * 1000
      : Number(input.idleMinutes) * 60 * 1000;
  const safeIdleMs = Math.max(0, Math.round(idleMs));
  const suppliedLastInput = input.lastInputAt ? Date.parse(input.lastInputAt) : NaN;
  const lastInputAt = Number.isFinite(suppliedLastInput)
    ? new Date(suppliedLastInput).toISOString()
    : new Date(Math.max(0, Number(nowMs) - safeIdleMs)).toISOString();
  return {
    available: true,
    idleMs: safeIdleMs,
    idleSeconds: Math.round(safeIdleMs / 1000),
    idleMinutes: Math.round((safeIdleMs / 60_000) * 10) / 10,
    lastInputAt,
    thresholdMs: threshold,
    isExtendedIdle: safeIdleMs >= threshold,
    error: null
  };
}

export function buildInactivityStatus({ telemetry = {}, observer = {}, nowMs = Date.now(), thresholdMs = EXTENDED_IDLE_MS } = {}) {
  const input = normalizeInputTelemetry(telemetry.input || {}, { nowMs, thresholdMs });
  const returnMode = observer.idleReturnMode || null;
  const active = Boolean(input.available && input.isExtendedIdle);
  return {
    ...input,
    active,
    returnMode,
    returnModeLabel: returnMode ? getMode(returnMode).label : null,
    storedAt: observer.idleReturnModeStoredAt || null,
    overdriveRestoreBlocked: Boolean(observer.idleReturnOverdriveBlocked),
    summary: input.available
      ? active
        ? `Active for ${Math.round(input.idleMinutes)} min -> Conservative`
        : `Watching (${Math.round(input.idleMinutes)} min idle)`
      : "Input idle telemetry unavailable",
    detail: input.available
      ? active
        ? `No keyboard/mouse input since ${input.lastInputAt}; Conservative idle cooling is eligible.`
        : `Extended inactivity starts after ${Math.round(input.thresholdMs / 60_000)} minutes without keyboard/mouse input.`
      : input.error
  };
}

export function summarizeFanTelemetry(fans = {}, host = {}) {
  const rpmRows = Array.isArray(fans.rpm) ? fans.rpm : [];
  const controlRows = Array.isArray(fans.controls) ? fans.controls : [];
  const fanCount = Number.isFinite(Number(fans.count)) ? Number(fans.count) : rpmRows.length;
  const controlCount = Number.isFinite(Number(fans.controlCount)) ? Number(fans.controlCount) : controlRows.length;
  const maxRpmValue = Number(fans.maxRpm);
  const averageRpmValue = Number(fans.averageRpm);
  const maxRpm = Number.isFinite(maxRpmValue) ? maxRpmValue : null;
  const averageRpm = Number.isFinite(averageRpmValue) ? averageRpmValue : null;
  const source = fans.source || (
    rpmRows[0]?.source ||
    controlRows[0]?.source ||
    null
  );
  if (fanCount > 0 || controlCount > 0) {
    const summaryParts = [];
    if (fanCount > 0) {
      summaryParts.push(`${fanCount} fan${fanCount === 1 ? "" : "s"}`);
    }
    if (maxRpm) {
      summaryParts.push(`max ${Math.round(maxRpm)} RPM`);
    } else if (controlCount > 0) {
      summaryParts.push(`${controlCount} PWM`);
    }
    const detailParts = ["Read-only fan telemetry is available."];
    if (averageRpm) detailParts.push(`Average ${Math.round(averageRpm)} RPM.`);
    if (source) detailParts.push(`Source: ${source}.`);
    detailParts.push("The app observes fans but does not control fan curves or firmware.");
    return {
      state: "ok",
      ok: true,
      summary: summaryParts.join(" / ") || "Available",
      detail: detailParts.join(" ")
    };
  }
  const note = fans.note || (
    host.elevated === false
      ? "Fan RPM/PWM may require the elevated launcher or a sensor agent."
      : "This board/controller did not expose fan RPM/PWM sensors."
  );
  return {
    state: "info",
    ok: true,
    summary: "Not exposed",
    detail: `${note} This is informational; the app still uses CPU/GPU/VRAM/storage temperatures for safety.`
  };
}

export function buildReadinessSummary({ telemetry = {}, observer = {}, adapters = {}, drift = [], frameTooling = null } = {}) {
  const temperatures = telemetry.temperatures || {};
  const system = telemetry.system || {};
  const host = telemetry.host || {};
  const fans = telemetry.fans || {};
  const gpu = telemetry.gpu || null;
  const staleAge = formatDurationSummary(telemetry.seedAgeMs);
  const powerPlans = telemetry.power?.plans || [];
  const planNames = new Set(powerPlans.map((plan) => plan?.name).filter(Boolean));
  const missingPlans = POWER_LADDER.filter((name) => !planNames.has(name));
  const warningDrift = drift.filter((entry) => entry?.state !== "info");
  const hasCpuTemp = finiteNumber(system.cpuTempC) || finiteNumber(system.systemTempC) ||
    finiteNumber(temperatures.cpuC) || finiteNumber(temperatures.systemC);
  const hasMemoryTemp = finiteNumber(system.memoryTempC) || finiteNumber(temperatures.memoryC);
  const hasGpuTemp = finiteNumber(gpu?.temperatureC) || finiteNumber(temperatures.gpuC);
  const hasStorageTemp = finiteNumber(system.storageTempC) || finiteNumber(temperatures.storageC);
  const sensorsNeedElevation = host.elevated === false;
  const cpuSensorKnownUnavailable = !hasCpuTemp && (
    Boolean(temperatures.librarySource) ||
    /not exposed|did not expose|invalid 0 C/i.test(String(temperatures.note || ""))
  );
  const thermalState = classifyThermalState(telemetry);
  const inactivity = buildInactivityStatus({ telemetry, observer });
  const fanTelemetry = summarizeFanTelemetry(fans, host);
  const thermalStateLevel =
    thermalState.severity === "critical" ? "fail" :
      ["hot", "warm"].includes(thermalState.severity) ? "warn" :
        thermalState.available ? "ok" : "info";
  const items = [
    {
      key: "telemetryFreshness",
      label: "Telemetry Freshness",
      state: telemetry.stale ? "warn" : "ok",
      ok: !telemetry.stale,
      summary: telemetry.stale ? `Cached${staleAge ? ` ${staleAge}` : ""}` : "Live",
      detail: telemetry.stale
        ? "Read-only dashboard status is using the last persisted telemetry snapshot while a fresh capture finishes."
        : `Captured ${telemetry.capturedAt || "pending"}${finiteNumber(telemetry.captureDurationMs) ? ` in ${(telemetry.captureDurationMs / 1000).toFixed(1)}s` : ""}.`
    },
    {
      key: "observer",
      label: "Observer",
      state: observer.running ? "ok" : "fail",
      ok: Boolean(observer.running),
      summary: observer.running ? "Connected" : "Disconnected",
      detail: observer.running ? `Last tick ${observer.lastTickAt || "pending"}` : observer.lastError || "Observer loop is not running."
    },
    {
      key: "inactivity",
      label: "Inactivity",
      state: inactivity.available ? "ok" : "info",
      ok: true,
      summary: inactivity.available
        ? inactivity.active
          ? `Idle ${Math.round(inactivity.idleMinutes)}m`
          : "Watching"
        : "Unavailable",
      detail: inactivity.detail
    },
    {
      key: "powerPlans",
      label: "Power Plans",
      state: missingPlans.length ? "fail" : "ok",
      ok: missingPlans.length === 0,
      summary: missingPlans.length ? `${missingPlans.length} missing` : "All five available",
      detail: missingPlans.length ? `Missing: ${missingPlans.join(", ")}` : POWER_LADDER.join(" -> ")
    },
    {
      key: "thermalHierarchy",
      label: "Thermal Hierarchy",
      state: thermalStateLevel,
      ok: !["fail", "warn"].includes(thermalStateLevel),
      summary: thermalState.available ? thermalState.summary : "No sensors",
      detail: thermalState.available
        ? `${thermalState.reason} Fixed thresholds; learning cannot override hot or critical limits.`
        : "No valid thermal readings are available; start through the elevated launcher for CPU/storage sensors."
    },
    {
      key: "fanTelemetry",
      label: "Fan Telemetry",
      state: fanTelemetry.state,
      ok: fanTelemetry.ok,
      summary: fanTelemetry.summary,
      detail: fanTelemetry.detail
    },
    {
      key: "gpuTelemetry",
      label: "GPU Telemetry",
      state: hasGpuTemp ? "ok" : "fail",
      ok: hasGpuTemp,
      summary: hasGpuTemp ? `${Math.round(gpu?.temperatureC ?? temperatures.gpuC)} C` : "Unavailable",
      detail: hasGpuTemp ? `Source: ${temperatures.gpuSource || "nvidia-smi"}` : "GPU telemetry is required for thermal and power-limit guards."
    },
    ...(frameTooling ? [{
      key: "frameTooling",
      label: "Frame Timing",
      state: frameTooling.available ? "ok" : "info",
      ok: true,
      summary: frameTooling.available ? "PresentMon" : "Proxy only",
      detail: frameTooling.available
        ? `PresentMon frame capture available${frameTooling.path ? ` at ${frameTooling.path}` : ""}.`
        : "PresentMon was not found; FPS/session smoothness learning falls back to telemetry proxies until PresentMon is installed or PC_CONTROL_PRESENTMON points to it."
    }] : []),
    {
      key: "storageTelemetry",
      label: "Storage SMART",
      state: hasStorageTemp ? "ok" : "warn",
      ok: hasStorageTemp,
      summary: hasStorageTemp ? `${Math.round(system.storageTempC ?? temperatures.storageC)} C` : "Needs elevation",
      detail: hasStorageTemp
        ? `Source: ${temperatures.storageSource || "SMART"}${temperatures.storageName ? ` / ${temperatures.storageName}` : ""}`
        : "Start PC Control Plane through the elevated launcher and approve UAC to read SMART drive temperatures."
    },
    {
      key: "cpuTemperature",
      label: "CPU Temperature",
      state: hasCpuTemp ? "ok" : sensorsNeedElevation ? "warn" : cpuSensorKnownUnavailable ? "info" : "warn",
      ok: hasCpuTemp || (!sensorsNeedElevation && cpuSensorKnownUnavailable),
      summary: hasCpuTemp ? `${Math.round(system.cpuTempC ?? system.systemTempC ?? temperatures.cpuC ?? temperatures.systemC)} C` : sensorsNeedElevation ? "Needs elevation" : "n/a",
      detail: hasCpuTemp
        ? `Source: ${temperatures.cpuSource || temperatures.systemSource || "sensor"}`
        : sensorsNeedElevation
          ? "The service is not elevated; start with the elevated launcher to restore CPU sensor telemetry."
          : temperatures.librarySource
          ? "LibreHardwareMonitor is installed, but this hardware did not expose a valid CPU temperature reading."
          : temperatures.note || "Install LibreHardwareMonitor/OpenHardwareMonitor if the firmware does not expose CPU temperature."
    },
    {
      key: "memoryTemperature",
      label: "RAM Temperature",
      state: hasMemoryTemp ? "ok" : sensorsNeedElevation ? "warn" : "info",
      ok: hasMemoryTemp || !sensorsNeedElevation,
      summary: hasMemoryTemp ? `${Math.round(system.memoryTempC ?? temperatures.memoryC)} C` : sensorsNeedElevation ? "Needs elevation" : "n/a",
      detail: hasMemoryTemp
        ? `Source: ${temperatures.memorySource || "sensor"}${temperatures.memoryName ? ` / ${temperatures.memoryName}` : ""}`
        : sensorsNeedElevation
          ? "The service is not elevated; start with the elevated launcher to restore RAM sensor telemetry when the modules expose it."
          : "RAM modules may not expose thermal sensors; this is informational when CPU/GPU/storage telemetry are available."
    },
    {
      key: "adapterContracts",
      label: "Adapter Contracts",
      state: adapters.ok === false ? "fail" : "ok",
      ok: adapters.ok !== false,
      summary: adapters.ok === false ? `${adapters.errors?.length || 0} issue(s)` : "Valid",
      detail: adapters.ok === false ? (adapters.errors || []).slice(0, 2).join(" | ") : "Rollback manifests and adapter contracts loaded."
    },
    {
      key: "settingsDrift",
      label: "Settings Drift",
      state: warningDrift.length ? "warn" : drift.length ? "info" : "ok",
      ok: warningDrift.length === 0,
      summary: String(drift.length || 0),
      detail: drift[0]?.label || "No outside changes detected."
    }
  ];
  const failCount = items.filter((item) => item.state === "fail").length;
  const warnCount = items.filter((item) => item.state === "warn").length;
  const infoCount = items.filter((item) => item.state === "info").length;
  return {
    ok: failCount === 0,
    state: failCount ? "blocked" : warnCount ? "degraded" : "ready",
    summary: failCount
      ? `${failCount} blocker(s), ${warnCount} warning(s)`
      : warnCount
        ? `${warnCount} warning(s)${infoCount ? `, ${infoCount} info` : ""}`
        : infoCount
          ? `Ready, ${infoCount} info`
          : "Ready",
    items
  };
}

export async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(plansDir, { recursive: true });
  await fs.mkdir(diagnosticTrapsDir, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await ensureDataDir();
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export const defaultAutomations = Object.freeze({
  thermalProtection: true,
  crashRecovery: true,
  failureProactivePrevention: true,
  failureRemediation: true,
  failurePrevention: true,
  selfHeal: true,
  networkGuard: true,
  networkDiagnosis: true,
  powerGuard: true,
  memoryRelief: true,
  cpuRelief: true,
  gpuRelief: true,
  mlExecution: true,
  offenderHandling: "observe-only",
  cooldownSeconds: 20,
  profileOnLaunch: "competitive"
});

const fullTimeAutomationLocks = Object.freeze({
  thermalProtection: true,
  crashRecovery: true,
  failureProactivePrevention: true,
  failureRemediation: true,
  failurePrevention: true,
  selfHeal: true,
  networkGuard: true,
  networkDiagnosis: true,
  memoryRelief: true,
  cpuRelief: true,
  gpuRelief: true,
  powerGuard: true,
  offenderHandling: "observe-only",
  profileOnLaunch: "competitive"
});

const automationValidators = {
  thermalProtection: (v) => typeof v === "boolean",
  crashRecovery: (v) => typeof v === "boolean",
  failureProactivePrevention: (v) => typeof v === "boolean",
  failureRemediation: (v) => typeof v === "boolean",
  failurePrevention: (v) => typeof v === "boolean",
  selfHeal: (v) => typeof v === "boolean",
  networkGuard: (v) => typeof v === "boolean",
  networkDiagnosis: (v) => typeof v === "boolean",
  powerGuard: (v) => typeof v === "boolean",
  memoryRelief: (v) => typeof v === "boolean",
  cpuRelief: (v) => typeof v === "boolean",
  gpuRelief: (v) => typeof v === "boolean",
  mlExecution: (v) => typeof v === "boolean",
  offenderHandling: (v) => v === "observe-only",
  cooldownSeconds: (v) => Number.isFinite(Number(v)) && Number(v) >= 10 && Number(v) <= 3600,
  profileOnLaunch: (v) => v === "none" || modes.some((mode) => mode.id === v)
};

export function normalizeAutomations(saved = {}) {
  const cooldown = Number(saved.cooldownSeconds);
  return {
    ...defaultAutomations,
    ...(Number.isFinite(cooldown) && cooldown >= 10 && cooldown <= 3600 ? { cooldownSeconds: cooldown } : {}),
    ...fullTimeAutomationLocks,
    ...(typeof saved.mlExecution === "boolean" ? { mlExecution: saved.mlExecution } : {})
  };
}

export function normalizeRuntimeState(saved = {}) {
  return {
    ...defaultState,
    ...saved,
    learningInfluence: saved.learningInfluence !== false,
    pinned: false,
    autonomy: "auto-safe",
    automations: normalizeAutomations(saved.automations || {})
  };
}

export async function readState() {
  const saved = await readJson(statePath, {});
  return normalizeRuntimeState(saved);
}

export async function setAutomationSetting(key, value) {
  const validator = automationValidators[key];
  if (!validator) {
    return { ok: false, message: `Unknown automation setting: ${key}` };
  }
  const normalized = key === "cooldownSeconds" ? Number(value) : value;
  if (!validator(normalized)) {
    return { ok: false, message: `Invalid value for ${key}: ${value}` };
  }
  const state = await readState();
  if (Object.hasOwn(fullTimeAutomationLocks, key) && normalized !== fullTimeAutomationLocks[key]) {
    const next = await writeState({
      ...state,
      lastAction: `Automation ${key} is managed full-time and remains ${fullTimeAutomationLocks[key]}.`
    });
    await appendAudit({
      level: "info",
      action: "automation.setting.locked",
      message: `Automation ${key} is full-time and remains ${fullTimeAutomationLocks[key]}.`,
      details: { key, requested: normalized, enforced: fullTimeAutomationLocks[key] }
    });
    return { ok: true, state: next, message: `Automation ${key} is managed full-time.` };
  }
  const next = await writeState({
    ...state,
    automations: { ...state.automations, [key]: normalized },
    lastAction: `Set automation ${key} to ${normalized}.`
  });
  await appendAudit({
    level: "info",
    action: "automation.setting",
    message: `Automation ${key} set to ${normalized}.`,
    details: { key, value: normalized }
  });
  return { ok: true, state: next, message: `Automation ${key} set to ${normalized}.` };
}

export async function setLearningInfluence(value) {
  const enabled = value !== false;
  const state = await readState();
  const next = await writeState({
    ...state,
    learningInfluence: enabled,
    lastAction: enabled
      ? "Learning influence enabled."
      : "Learning influence disabled; learning is advisory-only."
  });
  await appendAudit({
    level: "info",
    action: "learning.influence",
    message: enabled
      ? "Learning influence enabled."
      : "Learning influence disabled; summaries remain visible but resolver/reputation influence is ignored.",
    details: { enabled }
  });
  return { ok: true, state: next, learningInfluence: enabled };
}

export async function writeState(nextState) {
  const merged = normalizeRuntimeState(nextState);
  await writeJson(statePath, merged);
  return merged;
}

export function getObserverState() {
  return { ...observerState };
}

const LEARNING_ARCHIVE_FILE = "learning-sessions.jsonl";
let archiveFallbackNotified = false;
function archiveDirs() {
  return [archiveRoot, path.join(dataDir, "archive")];
}
async function appendLearningArchive(record) {
  const line = `${JSON.stringify(record)}\n`;
  for (const dir of archiveDirs()) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(path.join(dir, LEARNING_ARCHIVE_FILE), line, "utf8");
      return;
    } catch (err) {
      if (dir === archiveRoot && !archiveFallbackNotified) {
        archiveFallbackNotified = true;
        try {
          await appendAudit({
            level: "warn",
            action: "learning.archive-fallback",
            message: `Learning archive on ${archiveRoot} is unavailable; using the local fallback folder.`,
            details: { error: err?.message || String(err) }
          });
        } catch {}
      }
    }
  }
}
async function readLearningArchive({ profileId = null, limit = 200 } = {}) {
  const lim = Math.max(1, Math.min(5000, Math.round(Number(limit)) || 200));
  for (const dir of archiveDirs()) {
    try {
      const raw = await fs.readFile(path.join(dir, LEARNING_ARCHIVE_FILE), "utf8");
      let rows = raw.split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      if (profileId) rows = rows.filter((r) => r.profileId === profileId);
      return {
        ok: true,
        source: dir === archiveRoot ? "archive" : "local-fallback",
        location: dir,
        total: rows.length,
        sessions: rows.slice(-lim)
      };
    } catch { /* try next candidate */ }
  }
  return { ok: true, source: "none", total: 0, sessions: [] };
}
const learningArchive = { append: appendLearningArchive, readRecent: readLearningArchive };

const learningStore = createLearningStore({ readJson, writeJson, appendAudit, archive: learningArchive });
export const getLearningSummary = () => learningStore.summary();
export const getLearningHistory = (options = {}) => learningStore.readArchivedHistory(options);

function learningInfluenceEnabled(state = {}) {
  return state.learningInfluence !== false;
}

function stateWithLearningInfluence(state, learning) {
  return learningInfluenceEnabled(state)
    ? { ...state, appReputation: learning.appReputation, learning }
    : { ...state, appReputation: null, learning: null };
}

function effectiveLearningForDecisions(state, learning) {
  return learningInfluenceEnabled(state) ? learning : null;
}

const AUDIT_COALESCE_ACTIONS = new Set([
  "observer.tick",
  "failure.proactive-prevention.autonomous",
  "failure.remediation.autonomous",
  "failure.remediation.relief-gate",
  "diagnostics.traps.warning",
  "thermal.predictive-cool",
  "ml.governor.decision",
  "ml.governor.verified",
  "ml.governor.prevention-candidate",
  "ml.optimizer.hypothesis",
  "ml.governor.executed"
]);

function auditCoalesceKey(record = {}) {
  return AUDIT_COALESCE_ACTIONS.has(record.action) ? record.action : null;
}

function auditCoalescingBypass(record = {}) {
  const action = String(record.action || "");
  const message = String(record.message || "");
  if (!AUDIT_COALESCE_ACTIONS.has(action)) {
    return true;
  }
  return /\b(clear|cleared|resolved|restored)\b/i.test(message);
}

function auditCoalesceSignature(record = {}) {
  const action = String(record.action || "");
  const details = record.details || {};
  if (action === "observer.tick") {
    return [
      action,
      details.health?.state || "unknown-health",
      details.priority?.label || "unknown-priority",
      details.suggestedMode || "unknown-mode",
      details.failureWatchlist?.top?.id || "no-failure",
      details.highLoadRunning ? "foreground" : "background"
    ].join("|");
  }
  if (action === "diagnostics.traps.warning") {
    return [
      action,
      details.warning?.id || details.warning?.profileId || details.warning?.label || "warning",
      details.warning?.state || record.level || "warn"
    ].join("|");
  }
  if (action === "failure.remediation.relief-gate") {
    return [
      action,
      details.ramGate?.reason || "ram-unknown",
      details.cpuGate?.reason || "cpu-unknown",
      details.cpuEligibility?.reason || "eligibility-unknown",
      details.thermalSeverity || "thermal-unknown"
    ].join("|");
  }
  if (action === "failure.remediation.autonomous") {
    const routes = details.remediation?.routes || [];
    return [
      action,
      details.remediation?.status || "status-unknown",
      routes.map((route) => `${route.profileId || "profile"}:${route.handler || "handler"}:${route.recent ? "live" : "doc"}`).sort().join(",")
    ].join("|");
  }
  if (action === "failure.proactive-prevention.autonomous") {
    const guards = details.proactive?.activeGuards || [];
    return [
      action,
      guards.map((guard) => `${guard.id || "guard"}:${guard.state || "active"}`).sort().join(",")
    ].join("|");
  }
  if (action === "thermal.predictive-cool") {
    return [
      action,
      details.worstComponent || "temperature",
      details.hotLine || "hot-line"
    ].join("|");
  }
  if (action === "ml.governor.executed") {
    return [
      action,
      details.gate?.actionId || "action",
      details.gate?.handler || "handler"
    ].join("|");
  }
  if (action === "ml.governor.decision") {
    const selected = details.selected || {};
    const before = details.before || {};
    return [
      action,
      selected.id || "action",
      selected.intent || "intent",
      before.modeId || "mode"
    ].join("|");
  }
  if (action === "ml.governor.verified") {
    const selected = details.selected || {};
    return [
      action,
      selected.id || "action"
    ].join("|");
  }
  if (action === "ml.governor.prevention-candidate") {
    const candidate = details.candidate || {};
    return [
      action,
      candidate.actionId || "action",
      candidate.treatment || "treatment"
    ].join("|");
  }
  if (action === "ml.optimizer.hypothesis") {
    const experiment = details.selectedExperiment || {};
    return [
      action,
      experiment.executable ? "executable" : "advisory",
      details.status || "status",
      details.coverage?.executableCount ?? "exec"
    ].join("|");
  }
  return `${action}:${record.level || "info"}:${String(record.message || "").slice(0, 160)}`;
}

function auditCoalescedMessage(record = {}, state = {}) {
  const action = String(record.action || "");
  const count = Math.max(2, Number(state.count || 0));
  const duration = formatDurationSummary((Date.parse(record.ts || "") || Date.now()) - (Date.parse(state.firstAt || "") || Date.now())) || "a short time";
  if (action === "observer.tick") {
    const details = record.details || {};
    return `${details.health?.state || "Health"} / ${details.priority?.label || "current activity"} persisted for ${duration} across ${count} checks.`;
  }
  if (action === "diagnostics.traps.warning") {
    const label = record.details?.warning?.label || "CPU/RAM pressure";
    return `${label} persisted for ${duration} across ${count} samples.`;
  }
  if (action === "failure.remediation.relief-gate") {
    return `CPU/RAM relief stayed gated for ${duration} across ${count} samples.`;
  }
  if (action === "failure.remediation.autonomous") {
    return `The same safe failure-remediation route stayed active for ${duration} across ${count} checks.`;
  }
  if (action === "failure.proactive-prevention.autonomous") {
    return `The same proactive guard set stayed active for ${duration} across ${count} checks.`;
  }
  if (action === "thermal.predictive-cool") {
    const component = record.details?.worstComponent || "temperature";
    return `Predictive cooling kept easing ${component} for ${duration} across ${count} checks.`;
  }
  if (action === "ml.governor.executed") {
    return `ML governor continued delegating the same safe handler for ${duration} across ${count} checks.`;
  }
  if (action === "ml.governor.decision") {
    const selected = record.details?.selected?.label || "same safe action";
    return `ML governor kept selecting ${selected} for ${duration} across ${count} checks.`;
  }
  if (action === "ml.governor.verified") {
    const outcome = record.details?.outcome || "the same outcome";
    const selected = record.details?.selected?.label || "the same safe action";
    return `ML governor kept verifying ${selected} as ${outcome} for ${duration} across ${count} checks.`;
  }
  if (action === "ml.governor.prevention-candidate") {
    const candidate = record.details?.candidate || {};
    return `ML governor kept the same ${candidate.treatment || "prevention"} candidate for ${duration} across ${count} checks.`;
  }
  if (action === "ml.optimizer.hypothesis") {
    const experiment = record.details?.selectedExperiment?.label || "the same bounded experiment";
    return `North-star optimizer kept evaluating ${experiment} for ${duration} across ${count} checks.`;
  }
  return `Repeated ${action || "audit"} entries persisted for ${duration} across ${count} samples.`;
}

function summaryAuditRecord(record = {}, state = {}) {
  return {
    ...record,
    message: auditCoalescedMessage(record, state),
    details: {
      ...(record.details || {}),
      coalesced: true,
      originalAction: record.action || null,
      originalMessage: state.firstMessage || null,
      firstAt: state.firstAt || null,
      lastAt: record.ts || null,
      samples: Math.max(2, Number(state.count || 0))
    }
  };
}

export function createAuditCoalescer({ windowMs = AUDIT_COALESCE_WINDOW_MS } = {}) {
  const cache = new Map();
  return {
    process(record) {
      const key = auditCoalesceKey(record);
      if (!key || auditCoalescingBypass(record)) {
        cache.delete(key);
        return [record];
      }
      const signature = auditCoalesceSignature(record);
      const nowMs = Date.parse(record.ts || "") || Date.now();
      const current = cache.get(key);
      if (!current || current.signature !== signature) {
        const out = [];
        if (current?.count > 1 && current.lastRecord) {
          out.push(summaryAuditRecord(current.lastRecord, current));
        }
        cache.set(key, {
          signature,
          firstAt: record.ts,
          lastAt: record.ts,
          lastSummaryAt: record.ts,
          firstMessage: record.message || null,
          lastRecord: record,
          count: 1
        });
        out.push(record);
        return out;
      }
      const elapsedSinceSummary = nowMs - (Date.parse(current.lastSummaryAt || current.firstAt || "") || nowMs);
      current.count += 1;
      current.lastAt = record.ts;
      current.lastRecord = record;
      if (elapsedSinceSummary >= Math.max(1000, Number(windowMs) || AUDIT_COALESCE_WINDOW_MS)) {
        const summary = summaryAuditRecord(record, current);
        current.firstAt = record.ts;
        current.lastSummaryAt = record.ts;
        current.firstMessage = record.message || current.firstMessage;
        current.count = 1;
        return [summary];
      }
      return [];
    },
    reset() {
      cache.clear();
    }
  };
}

const auditCoalescer = createAuditCoalescer();

export async function appendAudit(entry) {
  await ensureDataDir();
  const record = {
    ts: new Date().toISOString(),
    ...entry
  };
  const records = auditCoalescer.process(record);
  if (!records.length) {
    return null;
  }
  await appendAuditRecords(records);
  maybeArchiveOldAuditRecords().catch(() => {
  });
  return records.at(-1) || null;
}

export async function readAudit(options = {}) {
  try {
    const normalized = typeof options === "number" ? { limit: options } : options;
    return await readAuditWindow(normalized);
  } catch {
    return [];
  }
}

export const STATUS_AUDIT_LIMIT = Number(process.env.PC_CONTROL_STATUS_AUDIT_LIMIT || 400);
const STATUS_AUDIT_DETAIL_CHARS = Number(process.env.PC_CONTROL_STATUS_AUDIT_DETAIL_CHARS || 600);

export function compactAuditForStatus(entries = [], {
  limit = STATUS_AUDIT_LIMIT,
  detailChars = STATUS_AUDIT_DETAIL_CHARS
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const capped = list.slice(0, Math.max(1, limit));
  return capped.map((entry) => {
    if (!entry || typeof entry !== "object" || entry.details == null) {
      return entry;
    }
    let serialized;
    try {
      serialized = JSON.stringify(entry.details);
    } catch {
      return { ...entry, details: null, detailsTruncated: true };
    }
    if (!serialized || serialized.length <= detailChars) {
      return entry;
    }
    return {
      ...entry,
      details: { summary: `${serialized.slice(0, detailChars)}…`, bytes: serialized.length },
      detailsTruncated: true
    };
  });
}

function rememberContextAuditKey(key) {
  if (!key || observerState.contextAuditKeys.includes(key)) {
    return;
  }
  observerState.contextAuditKeys.push(key);
  observerState.contextAuditKeys = observerState.contextAuditKeys.slice(-120);
}

async function appendContextSessionAudit(entry) {
  const id = entry?.details?.id;
  if (!id || !["context.session-start", "context.session-end"].includes(entry?.action)) {
    return appendAudit(entry);
  }
  const key = `${entry.action}:${id}`;
  if (observerState.contextAuditKeys.includes(key)) {
    return null;
  }
  const recent = await readAudit({ days: 1, limit: 500 });
  if (recent.some((audit) => audit?.action === entry.action && audit?.details?.id === id)) {
    rememberContextAuditKey(key);
    return null;
  }
  rememberContextAuditKey(key);
  return appendAudit(entry);
}

export async function releaseMemory({ dryRun = false, minWorkingMB = 100 } = {}) {
  const correlationId = createCorrelationId("memrelease");
  const minMB = Math.max(0, Math.min(4096, Number(minWorkingMB) || 0));
  const args = ["-MinWorkingMB", String(minMB)];
  if (!dryRun) {
    args.push("-Apply");
  }
  let report = null;
  let runError = null;
  try {
    const result = await runPowerShellScript(scripts.releaseMemory, args, { timeoutMs: 30000 });
    const stdout = String(result.stdout || "").trim();
    if (stdout) {
      try { report = JSON.parse(stdout); } catch { runError = "Could not parse RAM-release output."; }
    } else {
      runError = String(result.stderr || "").trim() || "RAM-release script produced no output.";
    }
  } catch (err) {
    runError = err?.message || String(err);
  }

  if (!report) {
    const message = `RAM release ${dryRun ? "preview" : "run"} failed: ${runError || "unknown error"}.`;
    await appendAudit({
      level: "warn",
      action: "memory.release",
      message,
      details: { correlationId, dryRun }
    });
    return { ok: false, dryRun, error: runError || "RAM release failed.", message, correlationId };
  }

  const freedMB = Number(report.freedMB) || 0;
  const summary = dryRun
    ? `RAM release preview: ${report.candidates ?? 0} trimmable process(es) at >= ${minMB} MB working set; ${report.afterFreeMB ?? "?"} MB free of ${report.totalMB ?? "?"} MB.`
    : `RAM release: trimmed ${report.trimmed ?? 0} process working set(s); free memory ${report.beforeFreeMB ?? "?"} -> ${report.afterFreeMB ?? "?"} MB (${freedMB >= 0 ? "+" : ""}${freedMB} MB). No process was suspended or stopped.`;

  if (!dryRun) {
    await appendLedgerEvent({
      status: "completed",
      correlationId,
      action: "memory.release",
      adapterId: "memory-release",
      adapterVersion: "1.0.0",
      message: summary,
      details: {
        minWorkingMB: minMB,
        trimmed: report.trimmed ?? 0,
        beforeFreeMB: report.beforeFreeMB ?? null,
        afterFreeMB: report.afterFreeMB ?? null,
        freedMB
      }
    });
  }
  await appendAudit({
    level: "action",
    action: "memory.release",
    message: summary,
    details: { correlationId, dryRun, ...report }
  });

  return { ok: true, dryRun, correlationId, summary, message: summary, ...report };
}

let cpuPulseRunning = false;

export async function relieveCpu(options = {}) {
  if (cpuPulseRunning) return { ok: false, message: "CPU relief is already running. Check its result before trying again." };
  cpuPulseRunning = true;
  try {
    return await runCpuPulse(options);
  } finally {
    cpuPulseRunning = false;
  }
}

async function runCpuPulse({ dryRun = false, capPct = 80, seconds = 6 } = {}) {
  const correlationId = createCorrelationId("cpurelief");
  const cap = Math.max(40, Math.min(99, Number(capPct) || 80));
  const secs = Math.max(2, Math.min(30, Number(seconds) || 6));
  const args = ["-CapPct", String(cap), "-Seconds", String(secs)];
  if (!dryRun) {
    args.push("-Apply");
  }
  let report = null;
  let runError = null;
  try {
    const result = await runPowerShellScript(scripts.relieveCpu, args, { timeoutMs: (secs + 20) * 1000 });
    const stdout = String(result.stdout || "").trim();
    if (stdout) {
      try { report = JSON.parse(stdout); } catch { runError = "Could not parse CPU-relief output."; }
    } else {
      runError = String(result.stderr || "").trim() || "CPU-relief script produced no output.";
    }
  } catch (err) {
    runError = err?.message || String(err);
  }

  if (report?.ok !== true || (!dryRun && report.applied && report.restoredTo !== report.originalMaxPct)) {
    runError ||= report?.message;
    const message = `CPU relief ${dryRun ? "preview" : "pulse"} failed: ${runError || "outcome unverified"}`;
    await appendAudit({
      level: "warn",
      action: "cpu.relief",
      message,
      details: { correlationId, dryRun }
    });
    return { ok: false, dryRun, error: runError || "CPU relief failed.", message, correlationId };
  }

  const easedPct = Number(report.easedPct) || 0;
  const summary = dryRun
    ? `CPU relief preview: would cap processor max to ${cap}% for ${secs}s on the active scheme (current max ${report.originalMaxPct ?? "?"}%).`
    : !report.applied
    ? `CPU relief not needed: processor max is already at or below ${cap}%.`
    : `CPU relief: capped processor max to ${cap}% for ${secs}s, then restored ${report.restoredTo ?? report.originalMaxPct ?? 100}%. CPU load ${report.beforeLoad ?? "?"}% -> ${report.duringLoad ?? "?"}% during the pulse. No process was suspended or stopped.`;

  if (!dryRun && report.applied) {
    await appendLedgerEvent({
      status: "completed",
      correlationId,
      action: "cpu.relief",
      adapterId: "cpu-relief",
      adapterVersion: "1.0.0",
      message: summary,
      details: { capPct: cap, seconds: secs, restoredTo: report.restoredTo ?? null, easedPct }
    });
  }
  await appendAudit({
    level: "action",
    action: "cpu.relief",
    message: summary,
    details: { correlationId, dryRun, ...report }
  });

  return { ok: true, dryRun, correlationId, summary, message: summary, ...report };
}

export async function runNetworkDiagnosis({ dryRun = false, autonomous = false } = {}) {
  const correlationId = createCorrelationId("netdiag");
  const telemetry = overlayLiveCore(await captureTelemetry({ force: true, skipNetwork: false, maxAgeMs: 0 }));
  const state = await readState();
  const learning = await learningStore.summary();
  const policy = evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning));
  const network = policy.networkHealth || {};
  const pressurePct = networkDiagnosisPressure(network);
  const signalCount = (network.issues || []).length + (network.actions || []).length;
  const metric = pressurePct >= RELIEF_TUNING.network.pressurePct && signalCount > 0 ? 1 : 0;
  const statusText = network.state || "unknown";
  const summary = signalCount
    ? `Network diagnosis: ${statusText}; ${network.issues?.[0] || network.actions?.[0]?.label || "actionable network signal found"}.`
    : `Network diagnosis: ${statusText}; no actionable DNS, reachability, VPN, packet-loss, or bandwidth issue found.`;

  if (!dryRun) {
    observerState.lastNetworkDiagnosisAt = new Date().toISOString();
    await writeReliefStore(recordReliefSample(await readReliefStore(), "network", {
      metric,
      at: observerState.lastNetworkDiagnosisAt
    }));
    await appendLedgerEvent({
      status: "completed",
      correlationId,
      action: autonomous ? "network.diagnose.auto" : "network.diagnose",
      adapterId: "network-diagnosis",
      adapterVersion: "1.0.0",
      message: summary,
      details: { pressurePct, signalCount, networkState: network.state }
    });
  }

  await appendAudit({
    level: pressurePct >= RELIEF_TUNING.network.pressurePct ? "info" : "observe",
    action: autonomous ? "network.diagnose.auto" : "network.diagnose",
    dryRun,
    message: summary,
    details: {
      correlationId,
      pressurePct,
      signalCount,
      networkState: network.state,
      issues: network.issues || [],
      actions: network.actions || [],
      latencyMs: network.latencyMs ?? null,
      packetLossPct: network.packetLossPct ?? null,
      dnsOk: network.dnsOk ?? null,
      webReachable: network.webReachable ?? null,
      serviceReachable: network.serviceReachable ?? null,
      vpnActive: Boolean(network.vpnActive)
    }
  });

  let dpcHealth = null;
  try {
    dpcHealth = await sampleDpcHealth();
    if (dpcHealth.state === "storm" || dpcHealth.state === "elevated") {
      await appendAudit({
        level: dpcHealth.state === "storm" ? "warn" : "info",
        action: "diagnostics.dpc",
        message: dpcHealth.summary,
        details: dpcHealth
      });
    }
  } catch {
    dpcHealth = { state: "unavailable", summary: "DPC sampling failed." };
  }

  return {
    ok: true,
    dryRun,
    correlationId,
    message: dpcHealth && dpcHealth.state !== "healthy" && dpcHealth.state !== "unavailable"
      ? `${summary} ${dpcHealth.summary}`
      : summary,
    network,
    dpcHealth,
    pressurePct,
    signalCount,
    learnedEffective: Boolean(metric)
  };
}

export async function relieveGpu({ dryRun = false, autonomous = false } = {}) {
  const correlationId = createCorrelationId("gpurelief");
  const state = await readState();
  const learning = await learningStore.summary();
  const effectiveLearning = effectiveLearningForDecisions(state, learning);
  const telemetry = overlayLiveCore(await captureTelemetry({ maxAgeMs: 10000 }));
  const policy = evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning));
  const signals = gpuReliefSignals(telemetry, policy);
  const before = resolveAdaptivePlanStateless({ modeId: state.modeId, telemetry, policy, learning: effectiveLearning });
  const reliefTelemetry = {
    ...telemetry,
    gpuReliefActive: true
  };
  const after = resolveAdaptivePlanStateless({ modeId: state.modeId, telemetry: reliefTelemetry, policy, learning: effectiveLearning });
  const holdMs = RELIEF_TUNING.gpu.holdMs;
  const lowered = Number.isFinite(Number(before?.tier)) && Number.isFinite(Number(after?.tier)) && Number(after.tier) < Number(before.tier);
  const summary = dryRun
    ? `GPU relief preview: would request a short in-mode power-band ease (${before?.plan || "current target"} -> ${after?.plan || "adaptive target"}).`
    : `GPU relief: requested a ${Math.round(holdMs / 1000)}s in-mode power-band ease (${before?.plan || "current target"} -> ${after?.plan || "adaptive target"}). No GPU clocks, voltage, fan, driver, or firmware setting was changed.`;

  if (!dryRun) {
    const now = Date.now();
    observerState.lastGpuReliefAt = new Date(now).toISOString();
    observerState.gpuReliefHoldUntil = new Date(now + holdMs).toISOString();
    observerState.pendingGpuReliefSample = {
      at: observerState.lastGpuReliefAt,
      pressurePct: signals.pressurePct,
      gpuTempC: signals.gpuTempC,
      vramTempC: signals.vramTempC,
      planBefore: before?.plan || null,
      planAfter: after?.plan || null
    };
    await convergeInvariants({ state, telemetry: reliefTelemetry, policy, learning: effectiveLearning });
    await appendLedgerEvent({
      status: "completed",
      correlationId,
      action: autonomous ? "gpu.relief.auto" : "gpu.relief",
      adapterId: "gpu-relief",
      adapterVersion: "1.0.0",
      message: summary,
      details: { signals, before, after, holdUntil: observerState.gpuReliefHoldUntil }
    });
  }

  await appendAudit({
    level: signals.pressurePct >= RELIEF_TUNING.gpu.pressurePct || lowered ? "action" : "info",
    action: autonomous ? "gpu.relief.auto" : "gpu.relief",
    dryRun,
    message: summary,
    details: {
      correlationId,
      signals,
      pressurePct: signals.pressurePct,
      targetBefore: before,
      targetAfter: after,
      holdUntil: observerState.gpuReliefHoldUntil,
      lowered
    }
  });

  return {
    ok: true,
    dryRun,
    correlationId,
    message: summary,
    signals,
    targetBefore: before,
    targetAfter: after,
    holdUntil: observerState.gpuReliefHoldUntil,
    lowered
  };
}

const reliefLearningPath = path.join(dataDir, "relief-learning.json");
const incidentLearningPath = path.join(dataDir, "incident-learning.json");

async function readReliefStore() {
  return normalizeReliefStore(await readJson(reliefLearningPath, {}));
}

async function writeReliefStore(store) {
  await ensureDataDir();
  await writeJson(reliefLearningPath, normalizeReliefStore(store));
}

export async function getReliefLearning() {
  return readReliefStore();
}

async function readIncidentLearningStore() {
  return normalizeIncidentLearningStore(await readJson(incidentLearningPath, {}));
}

async function writeIncidentLearningStore(store) {
  await ensureDataDir();
  await writeJson(incidentLearningPath, normalizeIncidentLearningStore(store));
}

const selfHealthPath = path.join(dataDir, "self-health.json");
const selfTreatmentPath = path.join(dataDir, "self-treatment.json");
const SELF_ERROR_AUDIT_WINDOW_MS = 5 * 60 * 1000;
const selfErrorAuditAt = new Map();

async function readSelfHealth() {
  return normalizeSelfHealth(await readJson(selfHealthPath, {}));
}
async function writeSelfHealth(store) {
  await ensureDataDir();
  await writeJson(selfHealthPath, normalizeSelfHealth(store));
}
export async function getSelfHealth() {
  return summarizeSelfHealth(await readSelfHealth());
}
async function readSelfTreatment() {
  return normalizeSelfTreatmentStore(await readJson(selfTreatmentPath, {}));
}
async function writeSelfTreatment(store) {
  await ensureDataDir();
  await writeJson(selfTreatmentPath, normalizeSelfTreatmentStore(store));
}
export async function getSelfTreatment() {
  const selfHealth = summarizeSelfHealth(await readSelfHealth());
  return summarizeSelfTreatment(await readSelfTreatment(), selfHealth);
}

const efficacyPath = path.join(dataDir, "efficacy.json");
const MODE_EFFICACY_WINDOW_MS = 45 * 1000;
async function readEfficacy() {
  return normalizeEfficacy(await readJson(efficacyPath, {}));
}
async function writeEfficacy(store) {
  await ensureDataDir();
  await writeJson(efficacyPath, normalizeEfficacy(store));
}
export async function getEfficacy() {
  return summarizeEfficacy(await readEfficacy());
}

const mlDecisionLedgerPath = path.join(dataDir, "ml-decisions.json");
async function readMlDecisionLedger() {
  return normalizeGovernorDecisionStore(await readJson(mlDecisionLedgerPath, {}));
}
async function writeMlDecisionLedger(store) {
  await ensureDataDir();
  await writeJson(mlDecisionLedgerPath, normalizeGovernorDecisionStore(store));
}

let updatesCache = { at: 0, value: null };
const UPDATES_TTL_MS = 60 * 60 * 1000;
export async function getUpdates({ force = false } = {}) {
  if (!force && updatesCache.value && Date.now() - updatesCache.at < UPDATES_TTL_MS) {
    return { ...updatesCache.value, cached: true };
  }
  let wingetOk = true;
  let list = [];
  try {
    const result = await runPowerShell(
      "$ErrorActionPreference='SilentlyContinue'; winget upgrade --include-unknown --disable-interactivity 2>$null | Out-String",
      { timeoutMs: 45000 }
    );
    if (result.ok && result.stdout) {
      list = parseWingetUpgrades(result.stdout);
    } else {
      wingetOk = false;
    }
  } catch {
    wingetOk = false;
  }
  const value = { ok: true, capturedAt: new Date().toISOString(), ...summarizeUpdates(list, { wingetOk }) };
  updatesCache = { at: Date.now(), value };
  return value;
}
async function recordPendingModeEfficacy(currentHealthState) {
  const pending = observerState.pendingModeEfficacy;
  if (!pending) return;
  if (Date.now() - (Date.parse(pending.at) || 0) < MODE_EFFICACY_WINDOW_MS) return;
  observerState.pendingModeEfficacy = null;
  try {
    const res = recordEfficacy(await readEfficacy(), {
      action: pending.action,
      before: pending.before,
      after: healthScore(currentHealthState)
    });
    await writeEfficacy(res.store);
  } catch { /* never let efficacy bookkeeping break the tick */ }
}

async function recordPendingGpuReliefOutcome(telemetry, policy) {
  const pending = observerState.pendingGpuReliefSample;
  if (!pending) return;
  const startedMs = Date.parse(pending.at || "");
  if (!Number.isFinite(startedMs) || Date.now() - startedMs < RELIEF_TUNING.gpu.holdMs) {
    return;
  }
  observerState.pendingGpuReliefSample = null;
  try {
    const after = gpuReliefSignals(telemetry, policy);
    const beforePressure = Number(pending.pressurePct);
    const afterPressure = Number(after.pressurePct);
    const metric = Number.isFinite(beforePressure) && Number.isFinite(afterPressure)
      ? Math.max(0, beforePressure - afterPressure)
      : 0;
    await writeReliefStore(recordReliefSample(await readReliefStore(), "gpu", {
      metric,
      at: new Date().toISOString()
    }));
    await appendAudit({
      level: "observe",
      action: "gpu.relief.learned",
      message: `GPU relief outcome checked: pressure ${Math.round(beforePressure || 0)} -> ${Math.round(afterPressure || 0)} (${metric >= RELIEF_TUNING.gpu.effectiveEasedPct ? "helped" : "little change"}).`,
      details: { before: pending, after, metric }
    });
  } catch {
  }
}

async function advanceMlGovernorDecisionLoop({ governor, state, telemetry, policy, adaptivePower }) {
  const at = new Date().toISOString();
  const beforeStore = await readMlDecisionLedger();
  const beforeCandidateIds = new Set(beforeStore.preventionCandidates.map((candidate) => candidate.id));
  const verifiedResult = verifyGovernorDecisions(beforeStore, {
    state,
    telemetry,
    policy,
    adaptivePower,
    at
  });
  const recordedResult = recordGovernorDecision(verifiedResult.store, {
    governor,
    state,
    telemetry,
    policy,
    adaptivePower,
    at
  });
  const verified = verifiedResult.verified || [];
  const recorded = recordedResult.record;
  if (!verified.length && !recorded) {
    return { verified: [], recorded: null, preventionCandidates: [] };
  }
  await writeMlDecisionLedger(recordedResult.store);

  if (recorded) {
    await appendAudit({
      level: "observe",
      action: "ml.governor.decision",
      message: `ML governor selected "${recorded.selected.label}" for verification.`,
      details: {
        level: 4,
        status: "verified-shadow-loop",
        decisionId: recorded.id,
        selected: recorded.selected,
        before: recorded.before,
        dueAt: recorded.dueAt
      }
    });
  }

  for (const entry of verified.slice(-3)) {
    await appendAudit({
      level: entry.helped ? "observe" : "info",
      action: "ml.governor.verified",
      message: `ML governor verified "${entry.selected.label}": ${entry.outcome}.`,
      details: {
        level: 4,
        status: "verified-shadow-loop",
        decisionId: entry.id,
        selected: entry.selected,
        outcome: entry.outcome,
        reason: entry.reason,
        before: entry.before,
        after: entry.after,
        confidence: entry.confidence
      }
    });
  }

  const newPreventionCandidates = recordedResult.store.preventionCandidates
    .filter((candidate) => !beforeCandidateIds.has(candidate.id));
  for (const candidate of newPreventionCandidates) {
    await appendAudit({
      level: "info",
      action: "ml.governor.prevention-candidate",
      message: `ML governor prevention candidate: ${candidate.treatment} for "${candidate.label}".`,
      details: {
        level: 4,
        status: "verified-shadow-loop",
        candidate
      }
    });
  }

  return { verified, recorded, preventionCandidates: newPreventionCandidates };
}

async function maybeExecuteMlGovernorSafeHandler({ gate, state, telemetry, policy, learning, handler }) {
  if (state?.automations?.mlExecution === false) {
    return false;
  }
  if (!gate?.eligible || !handler) {
    return false;
  }
  if (gate.handler !== handler) {
    return false;
  }
  const auditKey = `${gate.handler}:${gate.actionId}:${gate.evidence?.reason || "evidence"}`;
  if (observerState.lastMlExecutionAudit !== auditKey) {
    observerState.lastMlExecutionAudit = auditKey;
    await appendAudit({
      level: "action",
      action: "ml.governor.executed",
      message: `ML governor delegated "${gate.label}" to the existing ${gate.handler} handler.`,
      details: {
        level: 5,
        gate,
        currentMode: state.modeId,
        health: policy?.health?.state || null
      }
    });
  }
  if (handler === "convergeInvariants") {
    await convergeInvariants({ state, telemetry, policy, learning });
    return true;
  }
  if (handler === "maybeAutonomousRelief") {
    await maybeAutonomousRelief({ state, telemetry, policy });
    return true;
  }
  return false;
}

export async function getAttribution() {
  const telemetry = await captureTelemetry({ maxAgeMs: 5000 });
  const result = attributeResourcePressure({
    processes: telemetry?.processes || [],
    isProtected: (name) => isProtectedProcess(name)
  });
  return { ok: true, capturedAt: telemetry?.capturedAt || null, ...result };
}

async function noteSelfError(action, message) {
  const msg = String(message || "");
  let recorded = null;
  try {
    const res = recordSelfError(await readSelfHealth(), { action, message: msg });
    await writeSelfHealth(res.store);
    recorded = res;
  } catch {
  }
  const signature = recorded?.signature || `${action}|${msg}`;
  const now = Date.now();
  const last = selfErrorAuditAt.get(signature) || 0;
  if (recorded?.isNew || now - last >= SELF_ERROR_AUDIT_WINDOW_MS) {
    selfErrorAuditAt.set(signature, now);
    const count = recorded?.count || 1;
    await appendAudit({
      level: "warn",
      action,
      message: count > 1 ? `${msg} (x${count} for this internal fault)` : msg,
      details: { selfHealth: true, count, signature }
    });
  }
}

function selfHealthCountForSignature(store = {}, signature = "") {
  return Math.max(0, Math.round(Number(store?.signatures?.[signature]?.count) || 0));
}

function resetObserverVolatileState() {
  observerState.pendingAutoTarget = null;
  observerState.pendingAutoTargetSince = null;
  observerState.pendingAutoTargetConfirmations = 0;
  observerState.lastModeStabilityAudit = null;
  observerState.lastManualHoldAudit = null;
  observerState.lastReliefGateSignature = null;
    observerState.lastFailureAutonomySignature = null;
    observerState.lastFailureProactiveSignature = null;
    observerState.lastFailureTrapAttemptAt = null;
    observerState.lastDriverContainmentAuditSignature = null;
  observerState.cpuReliefInFlight = false;
  observerState.frameCaptureInFlight = false;
  observerState.lastGuardrailBlock = null;
  observerState.lastBandFirstAudit = null;
  observerState.lastGamingHoldAudit = null;
  observerState.lastPredictiveAudit = null;
}

async function executeSelfTreatmentCure(cureId) {
  if (cureId === "telemetry-cache-refresh") {
    telemetryCache.at = 0;
    networkCache.at = 0;
    captureTelemetry({ force: true, skipNetwork: true, maxAgeMs: 0 }).catch(() => {
    });
    return { ok: true, message: "Expired cached telemetry and started a fresh light capture." };
  }
  if (cureId === "observer-volatile-reset") {
    resetObserverVolatileState();
    return { ok: true, message: "Cleared volatile observer holds and in-flight markers." };
  }
  if (cureId === "audit-coalescer-reset") {
    auditCoalescer.reset();
    return { ok: true, message: "Reset audit repeat coalescing state." };
  }
  return { ok: false, message: `Unknown self-treatment cure: ${cureId}` };
}

async function verifyPendingSelfTreatments(store) {
  let next = normalizeSelfTreatmentStore(store);
  const now = Date.now();
  const due = next.pending.filter((attempt) => {
    const verifyMs = Date.parse(attempt.verifyAt || "");
    return Number.isFinite(verifyMs) && verifyMs <= now;
  });
  if (!due.length) {
    return next;
  }
  const selfHealthStore = await readSelfHealth();
  for (const attempt of due) {
    const afterCount = selfHealthCountForSignature(selfHealthStore, attempt.signature);
    const result = recordSelfTreatmentOutcome(next, {
      attemptId: attempt.id,
      afterCount,
      at: new Date().toISOString()
    });
    next = result.store;
    if (result.outcome) {
      await appendAudit({
        level: result.outcome.helped ? "observe" : "warn",
        action: "self-treatment.verified",
        message: result.outcome.helped
          ? `Self-treatment helped: ${attempt.cureId} stopped ${attempt.action} from recurring during verification.`
          : `Self-treatment did not help yet: ${attempt.cureId} saw ${attempt.action} recur and will learn/back off if repeated.`,
        details: {
          cureId: attempt.cureId,
          action: attempt.action,
          signature: attempt.signature,
          beforeCount: attempt.beforeCount,
          afterCount,
          helped: result.outcome.helped,
          backoffUntil: result.outcome.backoffUntil
        }
      });
    }
  }
  return next;
}

async function maybeSelfTreat(source = "observer") {
  if (observerState.selfTreatmentInFlight) {
    return null;
  }
  let store = await readSelfTreatment();
  store = await verifyPendingSelfTreatments(store);
  const selfHealthStore = await readSelfHealth();
  const selfHealth = summarizeSelfHealth(selfHealthStore);
  const plan = buildSelfTreatmentPlan({ selfHealth, store });
  await writeSelfTreatment(store);
  if (!plan.eligible || !plan.cure || !plan.fault) {
    return plan;
  }

  observerState.selfTreatmentInFlight = true;
  try {
    const cureResult = await executeSelfTreatmentCure(plan.cure.id);
    if (!cureResult.ok) {
      await noteSelfError("self-treatment.error", cureResult.message);
      return plan;
    }
    const next = recordSelfTreatmentAttempt(store, {
      cureId: plan.cure.id,
      signature: plan.fault.signature,
      action: plan.fault.action,
      sample: plan.fault.sample,
      beforeCount: plan.fault.count,
      at: new Date().toISOString()
    });
    await writeSelfTreatment(next.store);
    const auditKey = `${plan.cure.id}:${plan.fault.signature}:${plan.fault.count}`;
    if (observerState.lastSelfTreatmentAudit !== auditKey) {
      observerState.lastSelfTreatmentAudit = auditKey;
      await appendAudit({
        level: "action",
        action: "self-treatment.applied",
        message: `Self-treatment applied: ${plan.cure.label} for recurring ${plan.fault.action}. ${cureResult.message}`,
        details: {
          source,
          cureId: plan.cure.id,
          cure: plan.cure.label,
          action: plan.fault.action,
          signature: plan.fault.signature,
          count: plan.fault.count,
          verifyAt: next.attempt?.verifyAt || null,
          result: cureResult
        }
      });
    }
    return { ...plan, attempt: next.attempt };
  } catch (error) {
    await noteSelfError("self-treatment.error", error?.message || String(error));
    return plan;
  } finally {
    observerState.selfTreatmentInFlight = false;
  }
}

function latestReliefSample(entry = {}) {
  const samples = Array.isArray(entry.samples) ? entry.samples : [];
  return samples.length ? samples[samples.length - 1] : null;
}

function reliefCooldownUntil(lastRunAt, cooldownMs) {
  const lastMs = lastRunAt ? Date.parse(lastRunAt) : 0;
  if (!Number.isFinite(lastMs) || lastMs <= 0) {
    return null;
  }
  return new Date(lastMs + cooldownMs).toISOString();
}

function activeFutureIso(value, now = Date.now()) {
  const ms = value ? Date.parse(value) : 0;
  return Number.isFinite(ms) && ms > now ? value : null;
}

function networkDiagnosisPressure(networkHealth = {}) {
  if (networkHealth.state === "critical") return 100;
  if (networkHealth.state === "warning") return 70;
  if ((networkHealth.actions || []).some((action) => String(action.id || "").includes("network."))) return 55;
  return 0;
}

function gpuReliefSignals(telemetry = {}, policy = {}) {
  const gpu = telemetry?.gpu || {};
  const temps = telemetry?.temperatures || {};
  const thermal = policy?.thermalState || classifyThermalState(telemetry);
  const component = thermal?.components || {};
  const gpuTempC = Number.isFinite(Number(gpu.temperatureC))
    ? Number(gpu.temperatureC)
    : (Number.isFinite(Number(temps.gpuC)) ? Number(temps.gpuC) : null);
  const vramTempC = Number.isFinite(Number(temps.gpuMemoryC)) ? Number(temps.gpuMemoryC) : null;
  const powerDraw = Number(gpu.powerDrawW);
  const powerLimit = Number(gpu.powerLimitW);
  const powerRatio = Number.isFinite(powerDraw) && Number.isFinite(powerLimit) && powerLimit > 0
    ? powerDraw / powerLimit
    : null;
  const rank = { ok: 0, warm: 82, hot: 94, critical: 100 };
  const gpuSeverity = component.gpu?.severity || (thermal?.worstComponent === "gpu" ? thermal.severity : "ok");
  const vramSeverity = component.vram?.severity || (thermal?.worstComponent === "vram" ? thermal.severity : "ok");
  const thermalPressure = Math.max(rank[gpuSeverity] || 0, rank[vramSeverity] || 0);
  const powerPressure = powerRatio != null && powerRatio >= 0.95 ? Math.min(100, Math.round(powerRatio * 100)) : 0;
  const pressurePct = Math.max(thermalPressure, powerPressure);
  const reasons = [];
  if (thermalPressure) {
    reasons.push(thermal.summary || `GPU thermal state is ${thermal.severity}`);
  }
  if (powerPressure) {
    reasons.push(`GPU is near its power limit (${Math.round(powerRatio * 100)}%)`);
  }
  return {
    pressurePct,
    gpuTempC,
    vramTempC,
    powerRatio,
    thermalSeverity: thermal.severity || "ok",
    worstComponent: thermal.worstComponent || null,
    reason: reasons.join("; ") || "GPU/VRAM pressure is normal"
  };
}

function competitiveBand2GpuReliefGate(state = {}, telemetry = {}) {
  if (!isCompetitiveGamingSession(state?.modeId, telemetry)) {
    return {
      allowed: false,
      reason: "blocked outside Competitive"
    };
  }
  const activePlan = currentPowerPlanName(telemetry);
  if (!/02\s*-\s*Endurance/i.test(String(activePlan || ""))) {
    return {
      allowed: false,
      reason: "waiting for Competitive band 02"
    };
  }
  return {
    allowed: true,
    reason: "ready on band 02"
  };
}

function summarizeReliefGate(kind, gate, { enabled, pressurePct, thresholdPct, backoffUntil, cooldownUntil, autonomousAllowed, extraReason = null } = {}) {
  const label = kind === "ram" ? "RAM relief" : kind === "cpu" ? "CPU relief" : kind === "network" ? "Network diagnosis" : "GPU relief";
  if (!enabled) {
    return kind === "network" ? "Network diagnosis disabled" : `${label} disabled`;
  }
  if (backoffUntil) {
    return `${label} backed off until ${backoffUntil}`;
  }
  if (cooldownUntil && gate?.reason === "cooldown") {
    return `${label} cooling down until ${cooldownUntil}`;
  }
  if (extraReason) {
    return `${label} gated: ${extraReason}`;
  }
  if (!Number.isFinite(Number(pressurePct)) || Number(pressurePct) < thresholdPct) {
    const unit = kind === "ram" || kind === "cpu" ? "%" : "";
    return `${label} watching (${Math.round(Number(pressurePct) || 0)}${unit} < ${thresholdPct}${unit})`;
  }
  return autonomousAllowed ? `${label} ready` : `${label} gated: ${gate?.reason || "not eligible"}`;
}

export function buildReliefStatus({ state = {}, telemetry = {}, policy = {}, store = {}, now = Date.now() } = {}) {
  const normalized = normalizeReliefStore(store);
  const automations = normalizeAutomations(state.automations || {});
  const influence = learningInfluenceEnabled(state);
  const ramPressure = effectiveRamUsedPct(telemetry?.system);
  const cpuPressure = Number(telemetry?.system?.cpuLoadPct);
  const networkPressure = networkDiagnosisPressure(policy?.networkHealth || {});
  const gpuSignals = gpuReliefSignals(telemetry, policy);
  const thermalSeverity = policy?.thermalState?.severity || "ok";
  const lastResolved = getLastResolvedPlan();
  const powerAtFloor = Boolean(lastResolved &&
    Number.isFinite(lastResolved.tier) &&
    Number.isFinite(lastResolved.floor) &&
    lastResolved.tier <= lastResolved.floor);
  const heatJustifiesCap = thermalSeverity === "hot" || thermalSeverity === "critical";

  const ramGate = evaluateReliefGate(normalized, "ram", {
    now,
    pressure: Number.isFinite(ramPressure) ? ramPressure : 0,
    lastRunAt: observerState.lastMemoryReleaseAt,
    influence
  });
  const cpuGate = evaluateReliefGate(normalized, "cpu", {
    now,
    pressure: Number.isFinite(cpuPressure) ? cpuPressure : 0,
    lastRunAt: observerState.lastCpuReliefAt,
    influence
  });
  const networkGate = evaluateReliefGate(normalized, "network", {
    now,
    pressure: networkPressure,
    lastRunAt: observerState.lastNetworkDiagnosisAt,
    influence
  });
  const gpuGate = evaluateReliefGate(normalized, "gpu", {
    now,
    pressure: gpuSignals.pressurePct,
    lastRunAt: observerState.lastGpuReliefAt,
    influence
  });

  const ramCooldownUntil = reliefCooldownUntil(observerState.lastMemoryReleaseAt, RELIEF_TUNING.ram.cooldownMs);
  const cpuCooldownUntil = reliefCooldownUntil(observerState.lastCpuReliefAt, RELIEF_TUNING.cpu.cooldownMs);
  const networkCooldownUntil = reliefCooldownUntil(observerState.lastNetworkDiagnosisAt, RELIEF_TUNING.network.cooldownMs);
  const gpuCooldownUntil = reliefCooldownUntil(observerState.lastGpuReliefAt, RELIEF_TUNING.gpu.cooldownMs);
  const ramBackoffUntil = activeFutureIso(normalized.ram.backoffUntil, now);
  const cpuBackoffUntil = activeFutureIso(normalized.cpu.backoffUntil, now);
  const networkBackoffUntil = activeFutureIso(normalized.network.backoffUntil, now);
  const gpuBackoffUntil = activeFutureIso(normalized.gpu.backoffUntil, now);
  const ramAutonomousAllowed = automations.memoryRelief !== false && ramGate.allowed;
  const cpuEligibility = evaluateCpuReliefEligibility({
    cpuLoadPct: Number.isFinite(cpuPressure) ? cpuPressure : 0,
    thermalSeverity,
    powerAtFloor,
    pressureStreak: observerState.cpuPressureStreak,
    inFlight: observerState.cpuReliefInFlight
  });
  const cpuExtraReason = cpuEligibility.eligible ? null : cpuEligibility.reason;
  const cpuAutonomousAllowed = automations.cpuRelief !== false && cpuGate.allowed && cpuEligibility.eligible;
  const networkAutonomousAllowed = automations.networkDiagnosis !== false && networkGate.allowed;
  const gpuHoldUntil = activeFutureIso(observerState.gpuReliefHoldUntil, now);
  const gpuBand2Gate = competitiveBand2GpuReliefGate(state, telemetry);
  const gpuAutonomousAllowed = automations.gpuRelief !== false && gpuGate.allowed && !gpuHoldUntil && gpuBand2Gate.allowed;

  return {
    ram: {
      enabled: automations.memoryRelief !== false,
      pressurePct: Number.isFinite(ramPressure) ? ramPressure : null,
      thresholdPct: RELIEF_TUNING.ram.pressurePct,
      cooldownMs: RELIEF_TUNING.ram.cooldownMs,
      cooldownUntil: ramGate.reason === "cooldown" ? ramCooldownUntil : null,
      backoffUntil: ramBackoffUntil,
      lastRunAt: observerState.lastMemoryReleaseAt || normalized.ram.lastAt || null,
      latestSample: latestReliefSample(normalized.ram),
      ineffectiveStreak: normalized.ram.ineffectiveStreak,
      gate: ramGate,
      autonomousAllowed: ramAutonomousAllowed,
      state: automations.memoryRelief === false ? "disabled" : ramGate.allowed ? "ready" : ramGate.reason,
      summary: summarizeReliefGate("ram", ramGate, {
        enabled: automations.memoryRelief !== false,
        pressurePct: ramPressure,
        thresholdPct: RELIEF_TUNING.ram.pressurePct,
        backoffUntil: ramBackoffUntil,
        cooldownUntil: ramCooldownUntil,
        autonomousAllowed: ramAutonomousAllowed
      })
    },
    cpu: {
      enabled: automations.cpuRelief !== false,
      pressurePct: Number.isFinite(cpuPressure) ? cpuPressure : null,
      thresholdPct: RELIEF_TUNING.cpu.pressurePct,
      cooldownMs: RELIEF_TUNING.cpu.cooldownMs,
      cooldownUntil: cpuGate.reason === "cooldown" ? cpuCooldownUntil : null,
      backoffUntil: cpuBackoffUntil,
      lastRunAt: observerState.lastCpuReliefAt || normalized.cpu.lastAt || null,
      latestSample: latestReliefSample(normalized.cpu),
      ineffectiveStreak: normalized.cpu.ineffectiveStreak,
      gate: cpuGate,
      autonomousAllowed: cpuAutonomousAllowed,
      inFlight: Boolean(observerState.cpuReliefInFlight),
      powerAtFloor,
      heatJustifiesCap,
      pressureStreak: observerState.cpuPressureStreak,
      sustainedSamples: RELIEF_TUNING.cpu.sustainedSamples,
      sustainedPressure: cpuEligibility.sustainedPressure,
      thermalFloorRelief: cpuEligibility.thermalFloorRelief,
      thermalSeverity,
      state: automations.cpuRelief === false ? "disabled" : cpuAutonomousAllowed ? "ready" : cpuExtraReason || cpuGate.reason,
      summary: summarizeReliefGate("cpu", cpuGate, {
        enabled: automations.cpuRelief !== false,
        pressurePct: cpuPressure,
        thresholdPct: RELIEF_TUNING.cpu.pressurePct,
        backoffUntil: cpuBackoffUntil,
        cooldownUntil: cpuCooldownUntil,
        autonomousAllowed: cpuAutonomousAllowed,
        extraReason: cpuExtraReason
      })
    },
    network: {
      enabled: automations.networkDiagnosis !== false,
      pressurePct: networkPressure,
      thresholdPct: RELIEF_TUNING.network.pressurePct,
      cooldownMs: RELIEF_TUNING.network.cooldownMs,
      cooldownUntil: networkGate.reason === "cooldown" ? networkCooldownUntil : null,
      backoffUntil: networkBackoffUntil,
      lastRunAt: observerState.lastNetworkDiagnosisAt || normalized.network.lastAt || null,
      latestSample: latestReliefSample(normalized.network),
      ineffectiveStreak: normalized.network.ineffectiveStreak,
      gate: networkGate,
      autonomousAllowed: networkAutonomousAllowed,
      state: automations.networkDiagnosis === false ? "disabled" : networkAutonomousAllowed ? "ready" : networkGate.reason,
      networkState: policy?.networkHealth?.state || "unknown",
      issues: policy?.networkHealth?.issues || [],
      actions: policy?.networkHealth?.actions || [],
      summary: summarizeReliefGate("network", networkGate, {
        enabled: automations.networkDiagnosis !== false,
        pressurePct: networkPressure,
        thresholdPct: RELIEF_TUNING.network.pressurePct,
        backoffUntil: networkBackoffUntil,
        cooldownUntil: networkCooldownUntil,
        autonomousAllowed: networkAutonomousAllowed
      })
    },
    gpu: {
      enabled: automations.gpuRelief !== false,
      pressurePct: gpuSignals.pressurePct,
      thresholdPct: RELIEF_TUNING.gpu.pressurePct,
      cooldownMs: RELIEF_TUNING.gpu.cooldownMs,
      holdMs: RELIEF_TUNING.gpu.holdMs,
      cooldownUntil: gpuGate.reason === "cooldown" ? gpuCooldownUntil : null,
      backoffUntil: gpuBackoffUntil,
      holdUntil: gpuHoldUntil,
      lastRunAt: observerState.lastGpuReliefAt || normalized.gpu.lastAt || null,
      latestSample: latestReliefSample(normalized.gpu),
      ineffectiveStreak: normalized.gpu.ineffectiveStreak,
      gate: gpuGate,
      autonomousAllowed: gpuAutonomousAllowed,
      competitiveBand2Gate: gpuBand2Gate,
      state: automations.gpuRelief === false ? "disabled" : gpuHoldUntil ? "holding" : gpuAutonomousAllowed ? "ready" : gpuGate.reason,
      signals: gpuSignals,
      summary: gpuHoldUntil
        ? `GPU relief active until ${gpuHoldUntil}`
        : summarizeReliefGate("gpu", gpuGate, {
          enabled: automations.gpuRelief !== false,
          pressurePct: gpuSignals.pressurePct,
          thresholdPct: RELIEF_TUNING.gpu.pressurePct,
          backoffUntil: gpuBackoffUntil,
          cooldownUntil: gpuCooldownUntil,
          autonomousAllowed: gpuAutonomousAllowed,
          extraReason: gpuGate.allowed && !gpuBand2Gate.allowed
            ? gpuBand2Gate.reason
            : gpuSignals.pressurePct > 0 && gpuSignals.pressurePct < RELIEF_TUNING.gpu.pressurePct ? gpuSignals.reason : null
        })
    },
    learningInfluence: influence,
    updatedAt: new Date(now).toISOString()
  };
}

async function persistPlan(plan) {
  await ensureDataDir();
  const filePath = path.join(plansDir, `${plan.correlationId}.json`);
  await writeJson(filePath, plan);
  return { ...plan, filePath };
}

async function readPlan(correlationId) {
  if (!correlationId || !/^[a-zA-Z0-9_.-]+$/.test(String(correlationId))) {
    return null;
  }
  return readJson(path.join(plansDir, `${correlationId}.json`), null);
}

function planSummaryForAudit(plan) {
  return {
    correlationId: plan.correlationId,
    targetMode: plan.targetMode,
    risk: plan.risk,
    actions: (plan.plannedActions || []).map((action) => ({
      id: action.id,
      adapterId: action.adapterId,
      status: action.status,
      mutation: action.mutation
    }))
  };
}

function planAgeMs(plan, nowMs = Date.now()) {
  const createdAtMs = plan?.createdAt ? Date.parse(plan.createdAt) : NaN;
  if (!Number.isFinite(createdAtMs)) {
    return Infinity;
  }
  return Math.max(0, nowMs - createdAtMs);
}

async function writeRecoveryState(value) {
  await writeJson(recoveryPath, {
    schema: "pc-control-plane-recovery/v2",
    updatedAt: new Date().toISOString(),
    ...value
  });
}

async function readRecoveryState() {
  return readJson(recoveryPath, {
    schema: "pc-control-plane-recovery/v2",
    updatedAt: null,
    incompleteChains: [],
    safeRestoreOffered: false
  });
}

export async function inspectCrashRecovery() {
  const ledger = await readLedger(300);
  const incompleteChains = findIncompleteChains(ledger);
  const recovery = {
    incompleteChains,
    safeRestoreOffered: incompleteChains.length > 0,
    message:
      incompleteChains.length > 0
        ? "Incomplete action chains were found. Panic restore is available."
        : "No incomplete action chains detected."
  };
  await writeRecoveryState(recovery);
  return recovery;
}

function detectDrift({ state, telemetry, plan = null, desiredPowerPlan = null }) {
  const mode = getMode(state?.modeId);
  const activePowerPlan = currentPowerPlanName(telemetry);
  const drift = [];
  const expectedPower = plan ? plan.currentState?.powerPlan : (desiredPowerPlan || mode.powerPlanName);
  if (expectedPower && activePowerPlan && activePowerPlan !== expectedPower) {
    const expectedTier = POWER_LADDER.indexOf(expectedPower);
    const actualTier = POWER_LADDER.indexOf(activePowerPlan);
    const band = MODE_BANDS[mode.id] || null;
    const inModeBand = band &&
      expectedTier >= band.floor &&
      expectedTier <= band.ceiling &&
      actualTier >= band.floor &&
      actualTier <= band.ceiling;
    const adjacentAdaptiveStep = !plan &&
      inModeBand &&
      expectedTier >= 0 &&
      actualTier >= 0 &&
      Math.abs(expectedTier - actualTier) <= 1;
    drift.push({
      id: "power-plan-drift",
      label: adjacentAdaptiveStep ? "Power plan settling" : "Power plan drift",
      state: adjacentAdaptiveStep ? "info" : "warn",
      expected: expectedPower,
      actual: activePowerPlan,
      evidence: telemetry?.power?.activeLine || null,
      likelySource: adjacentAdaptiveStep
        ? "Adaptive power is moving between adjacent allowed plans."
        : "Windows, Control Panel, vendor utility, or manual powercfg change"
    });
  }
  if (plan?.currentState?.modeId && state?.modeId !== plan.currentState.modeId) {
    drift.push({
      id: "mode-drift",
      label: "Mode drift",
      expected: plan.currentState.modeId,
      actual: state?.modeId,
      evidence: `Plan ${plan.correlationId}`,
      likelySource: "State changed after planning"
    });
  }
  return drift;
}

function runFile(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd || workspaceRoot,
        timeout: options.timeoutMs || 20000,
        maxBuffer: options.maxBuffer || MAX_BUFFER,
        windowsHide: true,
        env: options.env ? { ...process.env, ...options.env } : process.env
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error: error ? String(error.message || error) : null
        });
      }
    );
  });
}

export async function runPowerShell(command, options = {}) {
  const script = String(command || "");
  if (script.length < 6000) {
    return runFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      options
    );
  }
  const scriptPath = path.join(os.tmpdir(), `pc-control-plane-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    return await runPowerShellScript(scriptPath, [], options);
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
}

export function runPowerShellScript(scriptPath, args = [], options = {}) {
  return runFile(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    options
  );
}

export async function captureLiveSensorTelemetry(options = {}) {
  const libreHardwareMonitorLibPath = await findLibreHardwareMonitorLibPath();
  const result = await runPowerShell(
    `
$ErrorActionPreference = 'SilentlyContinue'
$temperatures = [pscustomobject]@{ cpuC = $null; cpuSource = $null; systemC = $null; systemSource = $null; memoryC = $null; memorySource = $null; memoryName = $null; gpuMemoryC = $null; gpuMemorySource = $null; librarySource = $null; libraryError = $null }
$fanSensorRows = @()
$fanControlRows = @()
function Add-FanSensor($name, $hardware, $identifier, $value, $source) {
  $rpm = [double]$value
  if ($rpm -gt 0 -and $rpm -lt 30000) {
    $script:fanSensorRows += [pscustomobject]@{ name = [string]$name; hardware = [string]$hardware; identifier = [string]$identifier; rpm = [math]::Round($rpm, 0); source = [string]$source }
  }
}
function Add-FanControl($name, $hardware, $identifier, $value, $source) {
  $pct = [double]$value
  if ($pct -ge 0 -and $pct -le 100) {
    $script:fanControlRows += [pscustomobject]@{ name = [string]$name; hardware = [string]$hardware; identifier = [string]$identifier; pct = [math]::Round($pct, 1); source = [string]$source }
  }
}
foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {
  $sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue
  if (-not $sensors) { continue }
  $sourceName = ($ns -replace '^root/','')
  foreach ($sensor in $sensors) {
    if ($null -eq $sensor.Value) { continue }
    if ($sensor.SensorType -eq 'Fan') { Add-FanSensor $sensor.Name $sensor.Hardware $sensor.Identifier $sensor.Value $sourceName }
    elseif ($sensor.SensorType -eq 'Control') { Add-FanControl $sensor.Name $sensor.Hardware $sensor.Identifier $sensor.Value $sourceName }
  }
  $tempSensors = $sensors | Where-Object { $_.SensorType -eq 'Temperature' -and $null -ne $_.Value }
  if (-not $temperatures.cpuC) {
    $cpuSensor = $tempSensors | Where-Object { $_.Identifier -match '/cpu/' -and $_.Name -match 'Package|Tctl|Tdie|Total|Average|Core|CCD' } | Sort-Object Value -Descending | Select-Object -First 1
    if ($cpuSensor) { $temperatures.cpuC = [math]::Round([double]$cpuSensor.Value, 1); $temperatures.cpuSource = $sourceName }
  }
}
try {
  $lhmDll = $null
  if ($env:PC_CONTROL_LHM_LIB -and (Test-Path $env:PC_CONTROL_LHM_LIB)) {
    $lhmDll = Get-Item -Path $env:PC_CONTROL_LHM_LIB -ErrorAction SilentlyContinue
  }
  if ($lhmDll) {
    Add-Type -Path $lhmDll.FullName -ErrorAction Stop
    $temperatures.librarySource = 'LibreHardwareMonitorLib'
    $computerSensors = [LibreHardwareMonitor.Hardware.Computer]::new()
    $computerSensors.IsCpuEnabled = $true
    $computerSensors.IsGpuEnabled = $true
    $computerSensors.IsMotherboardEnabled = $true
    try { $computerSensors.IsMemoryEnabled = $true } catch {}
    $computerSensors.IsStorageEnabled = $true
    $computerSensors.Open()
    Start-Sleep -Milliseconds 150
    for ($i = 0; $i -lt 2; $i++) {
      foreach ($hardware in $computerSensors.Hardware) {
        $hardware.Update()
        foreach ($subHardware in $hardware.SubHardware) { $subHardware.Update() }
      }
      Start-Sleep -Milliseconds 100
    }
    $sensorRows = @()
    $allHardware = @()
    foreach ($hardware in $computerSensors.Hardware) {
      $allHardware += $hardware
      foreach ($subHardware in $hardware.SubHardware) { $allHardware += $subHardware }
    }
    foreach ($hardware in $allHardware) {
      foreach ($sensor in $hardware.Sensors) {
        if ($null -eq $sensor.Value) { continue }
        $sensorType = $sensor.SensorType.ToString()
        if ($sensorType -eq 'Temperature') {
          $value = [double]$sensor.Value
          if ($value -gt 5 -and $value -lt 125) {
            $sensorRows += [pscustomobject]@{ hardware = [string]$hardware.Name; hardwareType = [string]$hardware.HardwareType; name = [string]$sensor.Name; identifier = [string]$sensor.Identifier; value = [math]::Round($value, 1) }
          }
        } elseif ($sensorType -eq 'Fan') {
          Add-FanSensor $sensor.Name $hardware.Name $sensor.Identifier $sensor.Value 'LibreHardwareMonitorLib'
        } elseif ($sensorType -eq 'Control') {
          Add-FanControl $sensor.Name $hardware.Name $sensor.Identifier $sensor.Value 'LibreHardwareMonitorLib'
        }
      }
    }
    if (-not $temperatures.cpuC) {
      $cpuSensor = $sensorRows | Where-Object { ($_.identifier -match '/cpu/' -or $_.hardware -match 'Ryzen|Intel|CPU') -and $_.name -match 'Package|Tctl|Tdie|Total|Average|Core|CCD' } | Sort-Object value -Descending | Select-Object -First 1
      if ($cpuSensor) { $temperatures.cpuC = $cpuSensor.value; $temperatures.cpuSource = 'LibreHardwareMonitorLib' }
    }
    $gpuMemorySensor = $sensorRows | Where-Object { $_.identifier -match '/gpu' -and $_.name -match 'Memory Junction|Memory|VRAM|Hot Spot' } | Sort-Object value -Descending | Select-Object -First 1
    if ($gpuMemorySensor) { $temperatures.gpuMemoryC = $gpuMemorySensor.value; $temperatures.gpuMemorySource = 'LibreHardwareMonitorLib' }
    $memorySensor = $sensorRows | Where-Object {
      $_.identifier -notmatch '/gpu|/cpu|/hdd' -and (
        $_.identifier -match '/memory|/ram|/dimm|/dram|/spd' -or
        $_.hardwareType -match 'Memory' -or
        $_.hardware -match 'DIMM|DDR|DRAM|Memory|RAM|SPD|TSOD|Corsair|G\\.Skill|Kingston|Crucial|Vengeance|Trident|HyperX' -or
        $_.name -match 'DIMM|DRAM|Memory|RAM|SPD|TSOD'
      )
    } | Sort-Object value -Descending | Select-Object -First 1
    if ($memorySensor) { $temperatures.memoryC = $memorySensor.value; $temperatures.memorySource = 'LibreHardwareMonitorLib'; $temperatures.memoryName = $memorySensor.hardware }
    $computerSensors.Close()
  }
} catch {
  $temperatures.libraryError = $_.Exception.Message
}
$fanSensorRows = @($fanSensorRows | Sort-Object rpm -Descending | Select-Object -First 12)
$fanControlRows = @($fanControlRows | Sort-Object pct -Descending | Select-Object -First 12)
$fanSources = @(($fanSensorRows + $fanControlRows) | ForEach-Object { $_.source } | Where-Object { $_ } | Select-Object -Unique)
$maxFanRpm = if ($fanSensorRows.Count -gt 0) { ($fanSensorRows | Sort-Object rpm -Descending | Select-Object -First 1).rpm } else { $null }
$avgFanRpm = if ($fanSensorRows.Count -gt 0) { [math]::Round((($fanSensorRows | Measure-Object -Property rpm -Average).Average), 0) } else { $null }
[pscustomobject]@{
  capturedAt = (Get-Date).ToString('o')
  temperatures = $temperatures
  fans = [pscustomobject]@{
    available = (($fanSensorRows.Count + $fanControlRows.Count) -gt 0)
    status = if (($fanSensorRows.Count + $fanControlRows.Count) -gt 0) { 'available' } else { 'unavailable' }
    source = if ($fanSources.Count -gt 0) { ($fanSources -join ', ') } else { $null }
    count = $fanSensorRows.Count
    controlCount = $fanControlRows.Count
    maxRpm = $maxFanRpm
    averageRpm = $avgFanRpm
    rpm = $fanSensorRows
    controls = $fanControlRows
    note = if (($fanSensorRows.Count + $fanControlRows.Count) -gt 0) { 'Fan telemetry is read-only and exposed by the local sensor stack.' } else { 'Fan telemetry is not currently exposed by the local sensor stack.' }
  }
} | ConvertTo-Json -Depth 7 -Compress
`,
    {
      timeoutMs: options.timeoutMs || 3500,
      maxBuffer: 1024 * 1024,
      env: { PC_CONTROL_LHM_LIB: libreHardwareMonitorLibPath || "" }
    }
  );
  if (!result.ok || !result.stdout) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function spawnPowerShellScript(scriptPath, args = []) {
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  return child.pid;
}

async function pathExists(candidatePath) {
  if (!candidatePath) {
    return false;
  }
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function findFileBounded(root, fileName, limits) {
  let visited = 0;
  async function visit(dir, depth) {
    if (visited >= limits.maxEntries || depth > limits.maxDepth) {
      return null;
    }
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const sortedEntries = entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sortedEntries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return entryPath;
      }
      if (entry.isDirectory()) {
        const found = await visit(entryPath, depth + 1);
        if (found) {
          return found;
        }
      }
      if (visited >= limits.maxEntries) {
        break;
      }
    }
    return null;
  }
  return visit(root, 0);
}

async function findLibreHardwareMonitorLibPath({ force = false } = {}) {
  const now = Date.now();
  if (!force && libreHardwareMonitorLibCache.checkedAt && now - libreHardwareMonitorLibCache.checkedAt < LHM_DISCOVERY_TTL_MS) {
    return libreHardwareMonitorLibCache.path;
  }

  const configuredPath = process.env.PC_CONTROL_LHM_LIB;
  if (await pathExists(configuredPath)) {
    libreHardwareMonitorLibCache.path = configuredPath;
    libreHardwareMonitorLibCache.checkedAt = now;
    return configuredPath;
  }

  const localAppData = process.env.LOCALAPPDATA || "";
  const candidatePaths = [
    path.join(localAppData, "Microsoft", "WinGet", "Packages", "LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe", "LibreHardwareMonitorLib.dll"),
    path.join(localAppData, "Temp", "WinGet", "LibreHardwareMonitorLib.dll"),
    path.join(process.env.ProgramFiles || "", "LibreHardwareMonitor", "LibreHardwareMonitorLib.dll"),
    path.join(process.env["ProgramFiles(x86)"] || "", "LibreHardwareMonitor", "LibreHardwareMonitorLib.dll")
  ];
  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      libreHardwareMonitorLibCache.path = candidatePath;
      libreHardwareMonitorLibCache.checkedAt = now;
      return candidatePath;
    }
  }

  const roots = [
    path.join(localAppData, "Microsoft", "WinGet", "Packages"),
    path.join(localAppData, "Temp", "WinGet")
  ].filter(Boolean);
  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue;
    }
    const found = await findFileBounded(root, "LibreHardwareMonitorLib.dll", {
      maxEntries: LHM_DISCOVERY_MAX_ENTRIES,
      maxDepth: LHM_DISCOVERY_MAX_DEPTH
    });
    if (found) {
      libreHardwareMonitorLibCache.path = found;
      libreHardwareMonitorLibCache.checkedAt = now;
      return found;
    }
  }

  libreHardwareMonitorLibCache.path = null;
  libreHardwareMonitorLibCache.checkedAt = now;
  return null;
}

export async function getPowerPlans() {
  const result = await runPowerShell(
    `
$plans = @()
powercfg /list 2>$null | ForEach-Object {
  if ($_ -match 'Power Scheme GUID:\\s+([a-fA-F0-9-]+)\\s+\\((.*)\\)\\s*(\\*)?\\s*$') {
    $plans += [pscustomobject]@{
      guid = $matches[1]
      name = $matches[2]
      active = [bool]$matches[3]
    }
  }
}
$plans | ConvertTo-Json -Depth 4
`,
    { timeoutMs: 15000 }
  );

  if (!result.ok || !result.stdout) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function setPowerPlanByName(planName, dryRun = true) {
  const plans = await getPowerPlans();
  const plan = plans.find((entry) => String(entry.name).toLowerCase() === String(planName).toLowerCase());
  if (!plan) {
    return {
      ok: false,
      dryRun,
      message: `Power plan not found: ${planName}`,
      plans
    };
  }
  if (dryRun) {
    return {
      ok: true,
      dryRun,
      message: `Would switch active power plan to ${plan.name}.`,
      plan
    };
  }
  const result = await runFile("powercfg.exe", ["/setactive", plan.guid], { timeoutMs: 15000 });
  return {
    ok: result.ok,
    dryRun,
    message: result.ok ? `Switched active power plan to ${plan.name}.` : `Failed to switch to ${plan.name}.`,
    plan,
    result
  };
}

function parseJsonOutput(output, fallback) {
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function telemetryArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function recentEventKey(event = {}) {
  return [
    event.time || "",
    event.logName || "",
    event.provider || "",
    event.id ?? "",
    String(event.message || "").slice(0, 120)
  ].join("|");
}

function mergeRecentEvents(primary = [], fallback = [], max = 64) {
  const seen = new Set();
  const merged = [];
  for (const event of [...telemetryArray(primary), ...telemetryArray(fallback)]) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const key = recentEventKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
    if (merged.length >= max) {
      break;
    }
  }
  return merged;
}

function mergeTelemetryCaptureFailure(failed = {}, previous = null) {
  if (!failed?.error || !previous || typeof previous !== "object") {
    return failed;
  }
  const capturedAtMs = previous.capturedAt ? Date.parse(previous.capturedAt) : NaN;
  return sanitizeTelemetryIdentity({
    ...previous,
    capturedAt: failed.capturedAt || new Date().toISOString(),
    captureDurationMs: failed.captureDurationMs,
    error: failed.error,
    stale: true,
    refreshFailed: true,
    refreshPending: false,
    seedAgeMs: Number.isFinite(capturedAtMs) ? Math.max(0, Date.now() - capturedAtMs) : null,
    recentEvents: mergeRecentEvents(failed.recentEvents, previous.recentEvents),
    eventCaptureFallback: failed.eventCaptureFallback || false
  });
}

async function captureRecentEventsFallback() {
  const result = await runPowerShell(
    `
$events = @()
try {
  $start = (Get-Date).AddHours(-8)
  $filters = @(
    @{ LogName='System'; Level=1,2,3; StartTime=$start },
    @{ LogName='Application'; Level=1,2,3; StartTime=$start }
  )
  foreach ($filter in $filters) {
    try {
      $events += Get-WinEvent -FilterHashtable $filter -MaxEvents 120 | Where-Object {
        $provider = [string]$_.ProviderName
        $message = [string]$_.Message
        ($provider -match 'nvlddmkm|Display|Windows Error Reporting|Application Error|WER-SystemErrorReporting') -or
        ($message -match 'LiveKernelEvent|WATCHDOG|Tdr|nvlddmkm|GPU|display driver|stopped responding')
      } | ForEach-Object {
        $message = ([string]$_.Message -replace '\\s+', ' ')
        [pscustomobject]@{
          time = $_.TimeCreated.ToString('s')
          logName = $_.LogName
          provider = $_.ProviderName
          id = $_.Id
          level = $_.LevelDisplayName
          message = $message.Substring(0, [Math]::Min(700, $message.Length))
          fallback = $true
        }
      }
    } catch {}
  }
  @($events | Sort-Object time -Descending | Select-Object -First 24) | ConvertTo-Json -Depth 4
} catch {
  @() | ConvertTo-Json
}
`,
    { timeoutMs: 8000 }
  );
  if (!result.ok || !result.stdout) {
    return [];
  }
  return telemetryArray(parseJsonOutput(result.stdout, []));
}

function isShippingWorkloadName(name) {
  return /win64[-_]?shipping/i.test(String(name || ""));
}

function sanitizeProcessIdentity(process) {
  if (!process || !isShippingWorkloadName(process.name)) {
    return process;
  }
  return {
    ...process,
    name: "Foreground workload",
    path: null,
    commandLine: null
  };
}

function sanitizeTelemetryIdentity(telemetry) {
  if (!telemetry || typeof telemetry !== "object") {
    return telemetry;
  }
  const sanitized = {
    ...telemetry,
    processes: (telemetry.processes || []).map(sanitizeProcessIdentity)
  };
  const activeProcess = sanitizeProcessIdentity(telemetry.priorityApp?.process || null);
  if (telemetry.priorityApp) {
    sanitized.priorityApp = {
      ...telemetry.priorityApp,
      process: activeProcess
    };
  }
  const foregroundMatchesActive =
    telemetry.foreground &&
    activeProcess &&
    Number(telemetry.foreground.pid) === Number(telemetry.priorityApp?.process?.pid);
  if (telemetry.foreground && (foregroundMatchesActive || isShippingWorkloadName(telemetry.foreground.name))) {
    sanitized.foreground = {
      ...telemetry.foreground,
      name: "Foreground workload",
      title: "Foreground workload"
    };
  }
  return sanitized;
}

const telemetryCache = { value: null, at: 0, pending: null, lastPersistAt: 0 };
const TELEMETRY_TTL_MS = Number(process.env.PC_CONTROL_TELEMETRY_TTL_MS || 30000);
const TELEMETRY_PERSIST_MS = 30000;

let rawIdentityCache = { at: 0, foreground: null, priorityProcess: null };
function rawForegroundIdentity() {
  return rawIdentityCache.foreground || rawIdentityCache.priorityProcess || null;
}
const NETWORK_TTL_MS = Number(process.env.PC_CONTROL_NETWORK_TTL_MS || 60000);
const networkCache = { value: null, at: 0 };
const STATUS_AUX_TTL_MS = Number(process.env.PC_CONTROL_STATUS_AUX_TTL_MS || 30000);
const statusAuxCache = { value: null, at: 0, pending: null };

let _prevCpuTimes = null;
function liveCpuLoadPct() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  let pct = null;
  if (_prevCpuTimes) {
    const dIdle = idle - _prevCpuTimes.idle;
    const dTotal = total - _prevCpuTimes.total;
    if (dTotal > 0) {
      pct = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
    }
  }
  _prevCpuTimes = { idle, total };
  return pct;
}
function overlayLiveCore(telemetry) {
  if (!telemetry || telemetry.error) {
    return telemetry;
  }
  const cpu = liveCpuLoadPct();
  const totalB = os.totalmem();
  const freeB = os.freemem();
  const ramUsedPct = totalB > 0 ? Math.round(((totalB - freeB) / totalB) * 1000) / 10 : null;
  const system = { ...(telemetry.system || {}) };
  if (cpu != null) {
    system.cpuLoadPct = cpu;
  }
  if (ramUsedPct != null) {
    system.ramUsedPct = ramUsedPct;
    system.ramFreeGB = Math.round((freeB / 1024 ** 3) * 10) / 10;
    system.ramTotalGB = Math.round((totalB / 1024 ** 3) * 10) / 10;
  }
  return { ...telemetry, system, liveCoreOverlaid: true };
}
const telemetrySeedPath = path.join(dataDir, "telemetry-last.json");

function persistTelemetrySnapshot(value) {
  if (!value || value.error || Date.now() - telemetryCache.lastPersistAt < TELEMETRY_PERSIST_MS) {
    return;
  }
  telemetryCache.lastPersistAt = Date.now();
  writeJson(telemetrySeedPath, value).catch(() => {
  });
}

async function readTelemetrySeed() {
  const seed = await readJson(telemetrySeedPath, null);
  if (!seed || typeof seed !== "object" || seed.error) {
    return null;
  }
  const capturedAtMs = seed.capturedAt ? Date.parse(seed.capturedAt) : NaN;
  const seedAgeMs = Number.isFinite(capturedAtMs) ? Math.max(0, Date.now() - capturedAtMs) : null;
  return {
    ...sanitizeTelemetryIdentity(seed),
    stale: true,
    seedAgeMs
  };
}

function staleTelemetrySnapshot(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  const capturedAtMs = value.capturedAt ? Date.parse(value.capturedAt) : NaN;
  return {
    ...sanitizeTelemetryIdentity(value),
    stale: true,
    refreshPending: true,
    seedAgeMs: Number.isFinite(capturedAtMs) ? Math.max(0, Date.now() - capturedAtMs) : null
  };
}

const FAILURE_EVIDENCE_FALLBACK_MS = Number(process.env.PC_CONTROL_FAILURE_EVIDENCE_FALLBACK_MS || 45 * 60 * 1000);
const failureProfileLabels = new Map(listFailureProfiles().map((profile) => [profile.id, profile.label]));

function knownFailureSignature(signature) {
  const id = String(signature || "").trim();
  return id && id !== "none" && failureProfileLabels.has(id) ? id : null;
}

function recentFailureEvidenceTime(value, nowMs = Date.now()) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) {
    return null;
  }
  const ageMs = nowMs - ts;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > FAILURE_EVIDENCE_FALLBACK_MS) {
    return null;
  }
  return ts;
}

function fallbackEventKey(event = {}) {
  return [
    event.time || "",
    event.logName || "",
    event.provider || "",
    event.id ?? "",
    String(event.message || "").slice(0, 160)
  ].join("|");
}

function addFallbackEvent(events, seen, event, source) {
  if (!event || typeof event !== "object") {
    return false;
  }
  const key = fallbackEventKey(event);
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  events.push({
    ...event,
    retainedAfterCaptureError: true,
    fallbackSource: source
  });
  return true;
}

function syntheticFailureEvidenceEvent(signature, source, message, at = new Date()) {
  const label = failureProfileLabels.get(signature) || "Guarded failure signature";
  return {
    time: at.toISOString(),
    logName: "PC Control Plane",
    provider: source === "audit" ? "PC Control Plane Audit" : "PC Control Plane Observer",
    id: null,
    level: "Warning",
    message: message || `${label} was retained after telemetry capture failed so remediation stays routed.`,
    synthetic: true,
    failureSignature: signature,
    fallbackSource: source
  };
}

function failureSignatureFromAudit(entry = {}) {
  const details = entry.details || {};
  const top = knownFailureSignature(details.failureWatchlist?.top?.id);
  if (top) {
    return top;
  }
  const routes = Array.isArray(details.remediation?.routes) ? details.remediation.routes : [];
  const liveRoute = routes.find((route) => route.recent && knownFailureSignature(route.profileId));
  if (liveRoute) {
    return liveRoute.profileId;
  }
  const route = routes.find((item) => knownFailureSignature(item.profileId));
  return route?.profileId || null;
}

async function auditFailureFallbackEvent(nowMs = Date.now()) {
  try {
    const audit = await readAudit({ days: 1, limit: 120 });
    for (const entry of audit || []) {
      if (!recentFailureEvidenceTime(entry.ts, nowMs)) {
        continue;
      }
      const signature = failureSignatureFromAudit(entry);
      if (!signature) {
        continue;
      }
      return syntheticFailureEvidenceEvent(
        signature,
        "audit",
        `${failureProfileLabels.get(signature)} was recorded in the audit shortly before telemetry capture failed; remediation remains routed.`,
        new Date(entry.ts)
      );
    }
  } catch {
    return null;
  }
  return null;
}

async function buildTelemetryFailureEvidenceFallback(priorTelemetry = {}, directEvents = []) {
  const nowMs = Date.now();
  const events = [];
  const seen = new Set();
  const sources = new Set();
  const priorEvents = Array.isArray(priorTelemetry?.recentEvents) ? priorTelemetry.recentEvents : [];

  for (const event of telemetryArray(directEvents)) {
    if (!recentFailureEvidenceTime(event.time, nowMs)) {
      continue;
    }
    if (addFallbackEvent(events, seen, event, "capture-error")) {
      sources.add("capture-error");
    }
    if (events.length >= 32) {
      break;
    }
  }

  if (events.length < 32) {
    for (const event of await captureRecentEventsFallback()) {
      if (!recentFailureEvidenceTime(event.time, nowMs)) {
        continue;
      }
      if (addFallbackEvent(events, seen, event, "event-log-fallback")) {
        sources.add("event-log-fallback");
      }
      if (events.length >= 32) {
        break;
      }
    }
  }

  for (const event of priorEvents) {
    if (!recentFailureEvidenceTime(event.time, nowMs)) {
      continue;
    }
    if (addFallbackEvent(events, seen, event, "prior-telemetry")) {
      sources.add("prior-telemetry");
    }
    if (events.length >= 32) {
      break;
    }
  }

  const observerSignature = knownFailureSignature(observerState.lastFailureSignature);
  if (observerSignature) {
    const event = syntheticFailureEvidenceEvent(
      observerSignature,
      "observer",
      `${failureProfileLabels.get(observerSignature)} is still the observer's last failure signature; telemetry capture failed, so containment remains active.`
    );
    if (addFallbackEvent(events, seen, event, "observer")) {
      sources.add("observer");
    }
  }

  const auditEvent = await auditFailureFallbackEvent(nowMs);
  if (auditEvent && addFallbackEvent(events, seen, auditEvent, "audit")) {
    sources.add("audit");
  }

  return { events, sources: [...sources] };
}

async function telemetryCaptureErrorFallback(errorTelemetry, priorTelemetry = {}) {
  const { events, sources } = await buildTelemetryFailureEvidenceFallback(priorTelemetry, errorTelemetry?.recentEvents);
  const priorProcesses = Array.isArray(priorTelemetry?.processes) ? priorTelemetry.processes : [];
  return sanitizeTelemetryIdentity({
    ...errorTelemetry,
    processes: priorProcesses,
    recentEvents: events,
    failureEvidenceFallback: {
      active: events.length > 0,
      reason: events.length > 0
        ? "Fresh telemetry capture failed; retained recent failure evidence so detection, remediation, and prevention remain routed."
        : "Fresh telemetry capture failed and no recent retained failure evidence was available.",
      sources,
      priorCapturedAt: priorTelemetry?.capturedAt || null,
      observerLastFailureSignature: observerState.lastFailureSignature || null
    }
  });
}

export async function captureTelemetry(options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : TELEMETRY_TTL_MS;
  if (!options.force && telemetryCache.value && Date.now() - telemetryCache.at < maxAgeMs) {
    return telemetryCache.value;
  }
  if (!options.force && telemetryCache.pending) {
    if (telemetryCache.value && options.allowStaleSeed) {
      return staleTelemetrySnapshot(telemetryCache.value);
    }
    if (!telemetryCache.value && options.allowStaleSeed) {
      const seed = await readTelemetrySeed();
      if (seed) {
        return seed;
      }
    }
    return telemetryCache.pending;
  }
  const pending = captureTelemetryUncached(options).then(async (value) => {
    const finalValue = value?.error && !value?.failureEvidenceFallback
      ? await telemetryCaptureErrorFallback(value, telemetryCache.value || await readTelemetrySeed() || {})
      : value;
    telemetryCache.value = finalValue;
    telemetryCache.at = Date.now();
    telemetryCache.pending = null;
    persistTelemetrySnapshot(finalValue);
    return finalValue;
  });
  if (!options.force) {
    telemetryCache.pending = pending;
  }
  if (!options.force && telemetryCache.value && options.allowStaleSeed) {
    return staleTelemetrySnapshot(telemetryCache.value);
  }
  if (!options.force && !telemetryCache.value && options.allowStaleSeed) {
    const seed = await readTelemetrySeed();
    if (seed) {
      return seed;
    }
  }
  return pending;
}

async function captureTelemetryUncached(opts = {}) {
  const captureStartedAt = Date.now();
  const networkFresh = Boolean(networkCache.value) && Date.now() - networkCache.at < NETWORK_TTL_MS;
  const skipNetwork = opts.skipNetwork ?? networkFresh;
  const libreHardwareMonitorLibPath = await findLibreHardwareMonitorLibPath();
  const result = await runPowerShell(
    `
$ErrorActionPreference = 'SilentlyContinue'
$skipNetwork = ${skipNetwork ? "$true" : "$false"}
$isElevated = $false
try {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$usedKb = [double]($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)
$ramPct = if ($os.TotalVisibleMemorySize -gt 0) { [math]::Round(($usedKb / [double]$os.TotalVisibleMemorySize) * 100, 1) } else { $null }
$inputIdle = [pscustomobject]@{ available = $false; idleMs = $null; idleSeconds = $null; idleMinutes = $null; lastInputAt = $null; error = $null }
try {
  $idleSig = @'
using System;
using System.Runtime.InteropServices;
public class IdleInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")]
  public static extern uint GetTickCount();
}
'@
  Add-Type -TypeDefinition $idleSig -ErrorAction SilentlyContinue
  $lii = New-Object IdleInput+LASTINPUTINFO
  $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'IdleInput+LASTINPUTINFO')
  if ([IdleInput]::GetLastInputInfo([ref]$lii)) {
    [uint32]$nowTick = [IdleInput]::GetTickCount()
    [uint32]$lastTick = $lii.dwTime
    $idleMs = if ($nowTick -ge $lastTick) {
      [uint64]($nowTick - $lastTick)
    } else {
      [uint64]([uint32]::MaxValue - $lastTick) + [uint64]$nowTick + 1
    }
    $inputIdle = [pscustomobject]@{
      available = $true
      idleMs = [int64]$idleMs
      idleSeconds = [math]::Round([double]$idleMs / 1000, 0)
      idleMinutes = [math]::Round([double]$idleMs / 60000, 1)
      lastInputAt = (Get-Date).AddMilliseconds(-1 * [double]$idleMs).ToString('o')
      error = $null
    }
  } else {
    $inputIdle.error = 'GetLastInputInfo returned false.'
  }
} catch {
  $inputIdle.error = $_.Exception.Message
}
$logicalProcessors = [math]::Max(1, [int]$cpu.NumberOfLogicalProcessors)
$processCpuPct = @{}
try {
  Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
    ForEach-Object {
      $processCpuPct[[int]$_.IDProcess] = [math]::Round(([double]$_.PercentProcessorTime / $logicalProcessors), 1)
    }
} catch {}
$processes = Get-Process | ForEach-Object {
  $cpuSeconds = 0
  $cpuPct = $null
  $procPath = $null
  if ($null -ne $_.CPU) { $cpuSeconds = [math]::Round([double]$_.CPU, 1) }
  if ($processCpuPct.ContainsKey([int]$_.Id)) { $cpuPct = $processCpuPct[[int]$_.Id] }
  try { $procPath = $_.Path } catch {}
  [pscustomobject]@{
    name = $_.ProcessName
    pid = $_.Id
    path = $procPath
    cpuPct = $cpuPct
    cpuSeconds = $cpuSeconds
    workingSetMB = [math]::Round([double]$_.WorkingSet64 / 1MB, 1)
    privateMB = [math]::Round([double]$_.PrivateMemorySize64 / 1MB, 1)
  }
} | Sort-Object -Property workingSetMB -Descending | Select-Object -First 80
$foreground = $null
try {
  $fgSig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
'@
  Add-Type -TypeDefinition $fgSig -ErrorAction SilentlyContinue
  $hwnd = [FgWin]::GetForegroundWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    $fgPid = 0
    [void][FgWin]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
    $sb = New-Object System.Text.StringBuilder 512
    [void][FgWin]::GetWindowText($hwnd, $sb, $sb.Capacity)
    $rect = New-Object FgWin+RECT
    [void][FgWin]::GetWindowRect($hwnd, [ref]$rect)
    $fgProc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
    $fgPath = $null
    try { $fgPath = $fgProc.Path } catch {}
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    # [[Claude | Claude Fable 5 | 2026-08-12 03:24 UTC | change]] Fullscreen is now measured
    # against THE MONITOR THE WINDOW IS ACTUALLY ON (MonitorFromWindow + GetMonitorInfo).
    # It previously compared the window against Win32_VideoController's
    # CurrentHorizontalResolution -- the PRIMARY ADAPTER's mode. On a multi-monitor or
    # DPI-scaled desktop that is the wrong rectangle, so a genuinely fullscreen game on a
    # secondary display read as windowed and never triggered the gaming path. Borderless
    # fullscreen (the default for most modern titles) is detected from the window STYLE:
    # covering the monitor with no caption bar is borderless, which the size test alone
    # cannot distinguish from a maximized window.
    $fullscreen = $false
    $borderless = $false
    $monitorW = 0
    $monitorH = 0
    $monitorOk = $false
    try {
      $mon = [FgWin]::MonitorFromWindow($hwnd, 2)
      $mi = New-Object FgWin+MONITORINFO
      $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'FgWin+MONITORINFO')
      if ([FgWin]::GetMonitorInfo($mon, [ref]$mi)) {
        $monitorOk = $true
        $monitorW = $mi.rcMonitor.Right - $mi.rcMonitor.Left
        $monitorH = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
        $fullscreen = ($rect.Left -le ($mi.rcMonitor.Left + 2) -and $rect.Top -le ($mi.rcMonitor.Top + 2) -and $rect.Right -ge ($mi.rcMonitor.Right - 2) -and $rect.Bottom -ge ($mi.rcMonitor.Bottom - 2))
        $style = [FgWin]::GetWindowLong($hwnd, -16)
        $hasCaption = (($style -band 0x00C00000) -ne 0)
        $borderless = ($fullscreen -and -not $hasCaption)
      }
    } catch {}
    if (-not $monitorOk) {
      $screen = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($screen -and $screen.CurrentHorizontalResolution) {
        $fullscreen = ($w -ge ($screen.CurrentHorizontalResolution - 8) -and $h -ge ($screen.CurrentVerticalResolution - 8))
      }
    }
    $visibleWindows = 0
    try {
      $visibleWindows = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0
      }).Count
    } catch { $visibleWindows = 0 }
    $foreground = [pscustomobject]@{
      pid = $fgPid
      name = if ($fgProc) { $fgProc.ProcessName } else { $null }
      path = $fgPath
      title = $sb.ToString()
      widthPx = $w
      heightPx = $h
      fullscreen = $fullscreen
      borderlessFullscreen = $borderless
      monitorWidthPx = $monitorW
      monitorHeightPx = $monitorH
      monitorAware = $monitorOk
      visibleWindows = $visibleWindows
    }
  }
} catch {}
# [[Claude | Claude Fable 5 | 2026-08-12 03:24 UTC | change]] Anti-cheat / online-game
# runtimes. Their presence is a cheap (~30ms), highly specific signal that a protected
# game is live -- nothing else on a desktop runs these. Scanned separately because the
# process table is capped at the top 80 by working set and an anti-cheat driver shim is
# small enough to fall off that list while the game it protects is running.
$gameRuntimes = @()
try {
  $gameRuntimes = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match '(?i)^(vgc|vgk|EasyAntiCheat.*|EAC.*|BEService|BEDaisy|.*BattlEye.*|.*Vanguard.*|FaceitClient|steam|EpicGamesLauncher)$' } |
    ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id } })
} catch {}
$priorityAppProcess = $null
try {
  $protectedPriorityNames = '^(codex|claude|node|node_repl|python|pythonw|docker|com\.docker|vmmem|powershell|pwsh|explorer|dwm|system|registry|memory compression)$'
  if ($foreground -and $foreground.pid) {
    $fgPidNumber = [int]$foreground.pid
    $foregroundProcess = $processes | Where-Object { [int]$_.pid -eq $fgPidNumber } | Select-Object -First 1
    if ($foregroundProcess) {
      $fgName = ([string]$foregroundProcess.name).ToLowerInvariant()
      $fgCpu = if ($null -ne $foregroundProcess.cpuPct) { [double]$foregroundProcess.cpuPct } else { 0 }
      $fgPrivate = if ($null -ne $foregroundProcess.privateMB) { [double]$foregroundProcess.privateMB } else { 0 }
      if ($fgName -notmatch $protectedPriorityNames -and ($foreground.fullscreen -or $fgCpu -ge 12 -or $fgPrivate -ge 1800)) {
        $priorityAppProcess = $foregroundProcess
      }
    }
  }
  if (-not $priorityAppProcess) {
    $priorityAppProcess = $processes |
      Where-Object {
        $name = ([string]$_.name).ToLowerInvariant()
        $cpuPct = if ($null -ne $_.cpuPct) { [double]$_.cpuPct } else { 0 }
        $privateMb = if ($null -ne $_.privateMB) { [double]$_.privateMB } else { 0 }
        $name -notmatch $protectedPriorityNames -and ($cpuPct -ge 35 -or $privateMb -ge 6000)
      } |
      Sort-Object -Property cpuPct, privateMB -Descending |
      Select-Object -First 1
  }
} catch {}
$highLoadTelemetry = [bool]$priorityAppProcess
$powerLine = (powercfg /getactivescheme 2>$null | Select-Object -First 1)
$plans = @()
powercfg /list 2>$null | ForEach-Object {
  if ($_ -match 'Power Scheme GUID:\\s+([a-fA-F0-9-]+)\\s+\\((.*)\\)\\s*(\\*)?\\s*$') {
    $plans += [pscustomobject]@{
      guid = $matches[1]
      name = $matches[2]
      active = [bool]$matches[3]
    }
  }
}
$hags = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -Name HwSchMode -ErrorAction SilentlyContinue).HwSchMode
$gpu = $null
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
  $line = & $nvidiaSmi.Source --query-gpu=name,driver_version,pstate,temperature.gpu,power.draw,power.limit,utilization.gpu,utilization.memory,memory.used,memory.total,clocks.gr,clocks.mem --format=csv,noheader,nounits 2>$null | Select-Object -First 1
  if ($line) {
    $p = $line -split ',\\s*'
    $throttleReasons = (& $nvidiaSmi.Source --query-gpu=clocks_throttle_reasons.active --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    $gpu = [pscustomobject]@{
      name = $p[0]
      driver = $p[1]
      pstate = $p[2]
      temperatureC = [double]$p[3]
      powerDrawW = [double]$p[4]
      powerLimitW = [double]$p[5]
      utilizationPct = [double]$p[6]
      memoryUtilPct = [double]$p[7]
      memoryUsedMB = [double]$p[8]
      memoryTotalMB = [double]$p[9]
      graphicsClockMHz = [double]$p[10]
      memoryClockMHz = [double]$p[11]
      throttleReasonsActive = $throttleReasons
    }
  }
}
$temperatures = [pscustomobject]@{ cpuC = $null; cpuSource = $null; systemC = $null; systemSource = $null; memoryC = $null; memorySource = $null; memoryName = $null; gpuC = $null; gpuSource = $null; gpuMemoryC = $null; gpuMemorySource = $null; storageC = $null; storageSource = $null; storageName = $null; drives = @(); librarySource = $null; libraryError = $null; elevationRequired = $false; note = $null }
$fanSensorRows = @()
$fanControlRows = @()
if ($gpu -and $null -ne $gpu.temperatureC) { $temperatures.gpuC = [math]::Round([double]$gpu.temperatureC, 1); $temperatures.gpuSource = 'nvidia-smi' }
# Preferred CPU source: a sensor agent (LibreHardwareMonitor / OpenHardwareMonitor) when present.
foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {
  if ($temperatures.cpuC) { break }
  $sensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue | Where-Object { $_.SensorType -eq 'Temperature' }
  if ($sensors) {
    $cpuSensor = $sensors | Where-Object { $_.Identifier -match '/cpu/' -and $_.Name -match 'Package|Tctl|Tdie|Total|Average|Core' } | Sort-Object Value -Descending | Select-Object -First 1
    if (-not $cpuSensor) { $cpuSensor = $sensors | Where-Object { $_.Identifier -match '/cpu/' } | Sort-Object Value -Descending | Select-Object -First 1 }
    if ($cpuSensor) { $temperatures.cpuC = [math]::Round([double]$cpuSensor.Value, 1); $temperatures.cpuSource = ($ns -replace '.*/','') }
    if (-not $temperatures.gpuC) {
      $gpuSensor = $sensors | Where-Object { $_.Identifier -match '/gpu' } | Sort-Object Value -Descending | Select-Object -First 1
      if ($gpuSensor) { $temperatures.gpuC = [math]::Round([double]$gpuSensor.Value, 1); $temperatures.gpuSource = ($ns -replace '.*/','') }
    }
  }
}
# Fan RPM/PWM telemetry is read-only. It may inform readiness and cooling context,
# but this control plane does not set fan curves, vendor profiles, firmware, or BIOS.
foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {
  $coolingSensors = Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction SilentlyContinue |
    Where-Object { $_.SensorType -eq 'Fan' -or $_.SensorType -eq 'Control' }
  foreach ($sensor in $coolingSensors) {
    $sourceName = ($ns -replace '^root/','')
    if ($sensor.SensorType -eq 'Fan' -and $null -ne $sensor.Value) {
      $rpm = [double]$sensor.Value
      if ($rpm -gt 0 -and $rpm -lt 30000) {
        $fanSensorRows += [pscustomobject]@{
          name = [string]$sensor.Name
          hardware = [string]$sensor.Hardware
          identifier = [string]$sensor.Identifier
          rpm = [math]::Round($rpm, 0)
          source = $sourceName
        }
      }
    } elseif ($sensor.SensorType -eq 'Control' -and $null -ne $sensor.Value) {
      $pct = [double]$sensor.Value
      if ($pct -ge 0 -and $pct -le 100) {
        $fanControlRows += [pscustomobject]@{
          name = [string]$sensor.Name
          hardware = [string]$sensor.Hardware
          identifier = [string]$sensor.Identifier
          pct = [math]::Round($pct, 1)
          source = $sourceName
        }
      }
    }
  }
}
# Fallback sensor source: read LibreHardwareMonitorLib directly when the app is
# installed but its WMI namespace is not publishing. Invalid 0 C CPU readings are
# deliberately ignored; some boards expose a placeholder until the low-level
# driver can read a real die sensor.
try {
  $lhmDll = $null
  if ($env:PC_CONTROL_LHM_LIB -and (Test-Path $env:PC_CONTROL_LHM_LIB)) {
    $lhmDll = Get-Item -Path $env:PC_CONTROL_LHM_LIB -ErrorAction SilentlyContinue
  }
  if (-not $lhmDll) {
    $lhmRoots = @(
      (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Packages'),
      (Join-Path $env:LOCALAPPDATA 'Temp\\WinGet')
    ) | Where-Object { $_ -and (Test-Path $_) }
    $lhmDll = Get-ChildItem -Path $lhmRoots -Recurse -Filter 'LibreHardwareMonitorLib.dll' -ErrorAction SilentlyContinue |
      Sort-Object FullName |
      Select-Object -First 1
  }
  if ($lhmDll) {
    Add-Type -Path $lhmDll.FullName -ErrorAction Stop
    $temperatures.librarySource = 'LibreHardwareMonitorLib'
    $computerSensors = [LibreHardwareMonitor.Hardware.Computer]::new()
    $computerSensors.IsCpuEnabled = $true
    $computerSensors.IsGpuEnabled = $true
    $computerSensors.IsMotherboardEnabled = $true
    try { $computerSensors.IsMemoryEnabled = $true } catch {}
    $computerSensors.IsStorageEnabled = $true
    $computerSensors.Open()
    Start-Sleep -Milliseconds 150
    for ($i = 0; $i -lt 2; $i++) {
      foreach ($hardware in $computerSensors.Hardware) {
        $hardware.Update()
        foreach ($subHardware in $hardware.SubHardware) { $subHardware.Update() }
      }
      Start-Sleep -Milliseconds 100
    }
    $sensorRows = @()
    $allHardware = @()
    foreach ($hardware in $computerSensors.Hardware) {
      $allHardware += $hardware
      foreach ($subHardware in $hardware.SubHardware) { $allHardware += $subHardware }
    }
    foreach ($hardware in $allHardware) {
      foreach ($sensor in $hardware.Sensors) {
        $sensorType = $sensor.SensorType.ToString()
        if ($sensorType -eq 'Temperature' -and $null -ne $sensor.Value) {
          $value = [double]$sensor.Value
          if ($value -gt 5 -and $value -lt 125) {
            $sensorRows += [pscustomobject]@{
              hardware = [string]$hardware.Name
              hardwareType = [string]$hardware.HardwareType
              name = [string]$sensor.Name
              identifier = [string]$sensor.Identifier
              value = [math]::Round($value, 1)
            }
          }
        } elseif ($sensorType -eq 'Fan' -and $null -ne $sensor.Value) {
          $rpm = [double]$sensor.Value
          if ($rpm -gt 0 -and $rpm -lt 30000) {
            $fanSensorRows += [pscustomobject]@{
              name = [string]$sensor.Name
              hardware = [string]$hardware.Name
              identifier = [string]$sensor.Identifier
              rpm = [math]::Round($rpm, 0)
              source = 'LibreHardwareMonitorLib'
            }
          }
        } elseif ($sensorType -eq 'Control' -and $null -ne $sensor.Value) {
          $pct = [double]$sensor.Value
          if ($pct -ge 0 -and $pct -le 100) {
            $fanControlRows += [pscustomobject]@{
              name = [string]$sensor.Name
              hardware = [string]$hardware.Name
              identifier = [string]$sensor.Identifier
              pct = [math]::Round($pct, 1)
              source = 'LibreHardwareMonitorLib'
            }
          }
        }
      }
    }
    $cpuSensor = $sensorRows |
      Where-Object { $_.identifier -match '/cpu/' -or $_.hardware -match 'Ryzen|Intel|CPU' } |
      Where-Object { $_.name -match 'Package|Tctl|Tdie|Total|Average|Core|CCD' } |
      Sort-Object value -Descending |
      Select-Object -First 1
    if ((-not $temperatures.cpuC) -and $cpuSensor) {
      $temperatures.cpuC = $cpuSensor.value
      $temperatures.cpuSource = 'LibreHardwareMonitorLib'
    }
    $gpuCoreSensor = $sensorRows |
      Where-Object { $_.identifier -match '/gpu' -and $_.name -match 'GPU Core|Core' } |
      Sort-Object value -Descending |
      Select-Object -First 1
    if ((-not $temperatures.gpuC) -and $gpuCoreSensor) {
      $temperatures.gpuC = $gpuCoreSensor.value
      $temperatures.gpuSource = 'LibreHardwareMonitorLib'
    }
    $gpuMemorySensor = $sensorRows |
      Where-Object { $_.identifier -match '/gpu' -and $_.name -match 'Memory Junction|Memory|VRAM|Hot Spot' } |
      Sort-Object value -Descending |
      Select-Object -First 1
    if ($gpuMemorySensor) {
      $temperatures.gpuMemoryC = $gpuMemorySensor.value
      $temperatures.gpuMemorySource = 'LibreHardwareMonitorLib'
    }
    $memorySensor = $sensorRows |
      Where-Object {
        $_.identifier -notmatch '/gpu' -and
        $_.identifier -notmatch '/cpu' -and
        $_.identifier -notmatch '/hdd' -and
        (
          $_.identifier -match '/memory|/ram|/dimm|/dram|/spd' -or
          $_.hardwareType -match 'Memory' -or
          $_.hardware -match 'DIMM|DDR|DRAM|Memory|RAM|SPD|TSOD|Corsair|G\\.Skill|Kingston|Crucial|Vengeance|Trident|HyperX' -or
          $_.name -match 'DIMM|DRAM|Memory|RAM|SPD|TSOD'
        )
      } |
      Sort-Object value -Descending |
      Select-Object -First 1
    if ($memorySensor) {
      $temperatures.memoryC = $memorySensor.value
      $temperatures.memorySource = 'LibreHardwareMonitorLib'
      $temperatures.memoryName = $memorySensor.hardware
    }
    $computerSensors.Close()
  }
} catch {
  $temperatures.libraryError = $_.Exception.Message
}
# Fallback CPU/system source: ACPI thermal zone (available when the service runs elevated).
if (-not $temperatures.cpuC) {
  try {
    $tz = Get-CimInstance -Namespace 'root/WMI' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
    if ($tz) {
      $hot = $tz | ForEach-Object { [math]::Round((([double]$_.CurrentTemperature) / 10.0) - 273.15, 1) } | Where-Object { $_ -gt 5 -and $_ -lt 125 } | Sort-Object -Descending | Select-Object -First 1
      if ($null -ne $hot) { $temperatures.systemC = $hot; $temperatures.systemSource = 'acpi-thermal-zone' }
    }
  } catch {}
}
if ((-not $temperatures.cpuC) -and ($null -eq $temperatures.systemC)) {
  if (-not $isElevated) {
    $temperatures.elevationRequired = $true
    $temperatures.note = 'The service is not elevated, so CPU/RAM hardware sensors and SMART storage temperatures may be unavailable. Start PC Control Plane with the elevated launcher and approve UAC to restore full telemetry.'
  } elseif ($temperatures.librarySource) {
    $temperatures.note = 'LibreHardwareMonitor is installed, but this hardware did not expose a valid CPU die temperature; invalid 0 C readings are ignored. GPU is read via nvidia-smi; VRAM memory-junction is read via LibreHardwareMonitorLib when available; storage via SMART when elevated.'
  } else {
    $temperatures.note = 'CPU die temperature is not exposed by this PC firmware even when elevated; install a sensor agent such as LibreHardwareMonitor to populate it. GPU is read via nvidia-smi; storage via SMART when elevated.'
  }
}
# Storage drive temperatures (SMART; available when the service runs elevated).
try {
  $driveList = @()
  if ($isElevated) {
    Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
      $rc = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
      $dt = if ($rc -and $null -ne $rc.Temperature) { [int]$rc.Temperature } else { 0 }
      if ($dt -gt 0 -and $dt -lt 120) {
        $driveList += [pscustomobject]@{ name = [string]$_.FriendlyName; mediaType = [string]$_.MediaType; tempC = $dt }
      }
    }
  }
  if ($driveList.Count -gt 0) {
    $hotDrive = $driveList | Sort-Object tempC -Descending | Select-Object -First 1
    $temperatures.storageC = $hotDrive.tempC
    $temperatures.storageSource = 'smart'
    $temperatures.storageName = $hotDrive.name
    $temperatures.drives = $driveList
  }
} catch {}
$fanSensorRows = @($fanSensorRows | Sort-Object rpm -Descending | Select-Object -First 12)
$fanControlRows = @($fanControlRows | Sort-Object pct -Descending | Select-Object -First 12)
$fanSources = @(($fanSensorRows + $fanControlRows) | ForEach-Object { $_.source } | Where-Object { $_ } | Select-Object -Unique)
$maxFanRpm = if ($fanSensorRows.Count -gt 0) { ($fanSensorRows | Sort-Object rpm -Descending | Select-Object -First 1).rpm } else { $null }
$avgFanRpm = if ($fanSensorRows.Count -gt 0) { [math]::Round((($fanSensorRows | Measure-Object -Property rpm -Average).Average), 0) } else { $null }
$fanNote = if (($fanSensorRows.Count + $fanControlRows.Count) -gt 0) {
  'Fan telemetry is read-only and exposed by the local sensor stack.'
} elseif (-not $isElevated) {
  'Fan telemetry may require the elevated launcher or a sensor agent that exposes fan RPM/PWM sensors.'
} elseif ($temperatures.librarySource) {
  'LibreHardwareMonitor is available, but this hardware/controller did not expose fan RPM/PWM sensors.'
} else {
  'Fan RPM/PWM sensors require LibreHardwareMonitor/OpenHardwareMonitor or a board/controller that exposes them.'
}
$fans = [pscustomobject]@{
  available = (($fanSensorRows.Count + $fanControlRows.Count) -gt 0)
  status = if (($fanSensorRows.Count + $fanControlRows.Count) -gt 0) { 'available' } else { 'unavailable' }
  source = if ($fanSources.Count -gt 0) { ($fanSources -join ', ') } else { $null }
  count = $fanSensorRows.Count
  controlCount = $fanControlRows.Count
  maxRpm = $maxFanRpm
  averageRpm = $avgFanRpm
  rpm = $fanSensorRows
  controls = $fanControlRows
  note = $fanNote
}
$events = @()
try {
  $eventMax = if ($highLoadTelemetry) { 8 } else { 24 }
  $eventStart = (Get-Date).AddHours(-8)
  $targetedEventStart = (Get-Date).AddHours(-24)
  function Convert-ControlPlaneEvent($record, $source) {
    $message = ([string]$record.Message -replace '\\s+', ' ').Trim()
    [pscustomobject]@{
      time = $record.TimeCreated.ToString('s')
      logName = $record.LogName
      provider = $record.ProviderName
      id = $record.Id
      level = $record.LevelDisplayName
      message = $message.Substring(0, [Math]::Min(900, $message.Length))
      recordId = $record.RecordId
      source = $source
    }
  }
  $eventFilters = @(
    @{ LogName='System'; Level=1,2,3; StartTime=$eventStart },
    @{ LogName='Application'; Level=1,2,3; StartTime=$eventStart }
  )
  foreach ($filter in $eventFilters) {
    try {
      $events += Get-WinEvent -FilterHashtable $filter -MaxEvents $eventMax -ErrorAction SilentlyContinue | ForEach-Object {
        Convert-ControlPlaneEvent $_ 'level-filter'
      }
    } catch {
    }
  }
  $targetedEventFilters = @(
    @{ LogName='System'; ProviderName='nvlddmkm'; Id=@(13,14,153); StartTime=$targetedEventStart },
    @{ LogName='System'; ProviderName='Display'; Id=4101; StartTime=$targetedEventStart },
    @{ LogName='Application'; ProviderName='Windows Error Reporting'; Id=1001; StartTime=$targetedEventStart },
    @{ LogName='Application'; ProviderName='WER-SystemErrorReporting'; Id=1001; StartTime=$targetedEventStart },
    @{ LogName='System'; ProviderName='WER-SystemErrorReporting'; Id=1001; StartTime=$targetedEventStart },
    @{ LogName='System'; ProviderName='Microsoft-Windows-WER-SystemErrorReporting'; Id=1001; StartTime=$targetedEventStart }
  )
  foreach ($filter in $targetedEventFilters) {
    try {
      $events += Get-WinEvent -FilterHashtable $filter -MaxEvents 12 -ErrorAction SilentlyContinue | ForEach-Object {
        $item = Convert-ControlPlaneEvent $_ 'targeted-failure-watch'
        $text = "$($item.provider) $($item.id) $($item.message)"
        if (
          $item.provider -match 'nvlddmkm|Display' -or
          $text -match 'LiveKernelEvent|LKD_0x1(41|17)|\\b0x1(41|17)\\b|\\b(141|117)\\b|Tdr|WATCHDOG|nvlddmkm'
        ) {
          $item
        }
      }
    } catch {
    }
  }
  $eventLimit = if ($highLoadTelemetry) { 16 } else { 48 }
  $seenEvents = @{}
  $events = $events |
    Sort-Object time -Descending |
    Where-Object {
      $key = "$($_.time)|$($_.logName)|$($_.provider)|$($_.id)|$($_.recordId)"
      if ($seenEvents.ContainsKey($key)) { $false } else { $seenEvents[$key] = $true; $true }
    } |
    Select-Object -First $eventLimit
} catch {}
$adapters = @()
$activeAdapter = $null
$netConfigs = @()
$dnsServers = @()
$dnsHealth = [pscustomobject]@{ ok = $false; tests = @(); servers = @() }
$latency = $null
$gatewayLatency = $null
$internetTcp = $null
$reachability = [pscustomobject]@{ web = @(); service = @(); deferred = $false; reason = $null }
$vpn = [pscustomobject]@{ active = $false; adapters = @() }
$bandwidthHeavyApps = @()
$processorBoost = $null
$usbSelectiveSuspend = $null
function Convert-SpeedMbps($value) {
  $text = [string]$value
  if ($text -match '([0-9.]+)\\s*Gbps') { return [math]::Round(([double]$matches[1]) * 1000, 1) }
  if ($text -match '([0-9.]+)\\s*Mbps') { return [math]::Round([double]$matches[1], 1) }
  return $null
}
function Test-TcpEndpoint($name, $endpointHost, $port) {
  $client = $null
  try {
    $client = [Net.Sockets.TcpClient]::new()
    $started = Get-Date
    $async = $client.BeginConnect($endpointHost, $port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(1500, $false)
    $latencyMs = $null
    if ($ok) {
      $client.EndConnect($async)
      $latencyMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds, 0)
    }
    [pscustomobject]@{ name = $name; host = $endpointHost; port = $port; reachable = [bool]($ok -and $client.Connected); latencyMs = $latencyMs }
  } catch {
    [pscustomobject]@{ name = $name; host = $endpointHost; port = $port; reachable = $false; latencyMs = $null }
  } finally {
    if ($client) { $client.Close() }
  }
}
function Test-WebEndpoint($name, $uri) {
  try {
    $started = Get-Date
    $response = Invoke-WebRequest -Uri $uri -Method Head -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    [pscustomobject]@{
      name = $name
      uri = $uri
      reachable = $true
      statusCode = [int]$response.StatusCode
      latencyMs = [math]::Round(((Get-Date) - $started).TotalMilliseconds, 0)
    }
  } catch {
    $statusCode = $null
    try { if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode } } catch {}
    [pscustomobject]@{
      name = $name
      uri = $uri
      reachable = [bool]($statusCode -and $statusCode -lt 500)
      statusCode = $statusCode
      latencyMs = $null
    }
  }
}
function Read-PowerSettingLines($subgroup, $setting, $includeHidden) {
  try {
    if ($includeHidden) {
      @(powercfg /qh SCHEME_CURRENT $subgroup $setting 2>$null)
    } else {
      @(powercfg /query SCHEME_CURRENT $subgroup $setting 2>$null)
    }
  } catch {
    @()
  }
}
function Parse-PowerSettingIndex($lines) {
  $ac = $null
  $dc = $null
  foreach ($line in $lines) {
    if ($line -match 'Current AC Power Setting Index:\\s*(0x[0-9a-fA-F]+)') { $ac = [Convert]::ToInt32(($matches[1] -replace '^0x', ''), 16) }
    if ($line -match 'Current DC Power Setting Index:\\s*(0x[0-9a-fA-F]+)') { $dc = [Convert]::ToInt32(($matches[1] -replace '^0x', ''), 16) }
  }
  [pscustomobject]@{ ac = $ac; dc = $dc }
}
function Get-PowerSettingIndex($subgroup, $setting) {
  try {
    $lines = Read-PowerSettingLines $subgroup $setting $false
    $parsed = Parse-PowerSettingIndex $lines
    $source = 'powercfg /query'
    if ($null -eq $parsed.ac -and $null -eq $parsed.dc) {
      $hiddenLines = Read-PowerSettingLines $subgroup $setting $true
      $hiddenParsed = Parse-PowerSettingIndex $hiddenLines
      if ($null -ne $hiddenParsed.ac -or $null -ne $hiddenParsed.dc) {
        $parsed = $hiddenParsed
        $source = 'powercfg /qh'
      }
    }
    [pscustomobject]@{
      ac = $parsed.ac
      dc = $parsed.dc
      source = $source
      available = [bool]($null -ne $parsed.ac -or $null -ne $parsed.dc)
    }
  } catch {
    [pscustomobject]@{ ac = $null; dc = $null; source = 'unavailable'; available = $false }
  }
}
function Get-PowerSettingPercent($subgroup, $setting) {
  try {
    $raw = Get-PowerSettingIndex $subgroup $setting
    $ac = $null
    $dc = $null
    if ($null -ne $raw.ac) { $ac = [math]::Min(100, [math]::Max(0, [int]$raw.ac)) }
    if ($null -ne $raw.dc) { $dc = [math]::Min(100, [math]::Max(0, [int]$raw.dc)) }
    [pscustomobject]@{ ac = $ac; dc = $dc; source = $raw.source; available = $raw.available }
  } catch {
    [pscustomobject]@{ ac = $null; dc = $null; source = 'unavailable'; available = $false }
  }
}
function Get-BoostLabel($value) {
  switch ($value) {
    0 { 'disabled' }
    1 { 'enabled' }
    2 { 'aggressive' }
    3 { 'efficient-enabled' }
    4 { 'efficient-aggressive' }
    5 { 'aggressive-at-guaranteed' }
    6 { 'efficient-aggressive-at-guaranteed' }
    default { if ($null -eq $value) { 'unknown' } else { "index-$value" } }
  }
}
function Get-UsbSuspendLabel($value) {
  switch ($value) {
    0 { 'disabled' }
    1 { 'enabled' }
    default { if ($null -eq $value) { 'unknown' } else { "index-$value" } }
  }
}
if (-not $skipNetwork) {
try {
  $netConfigs = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = True" -ErrorAction SilentlyContinue)
  $adapterRaw = @(Get-CimInstance Win32_NetworkAdapter -Filter "NetEnabled = True" -ErrorAction SilentlyContinue | Select-Object -First 8)
  $adapters = @($adapterRaw | ForEach-Object {
    $adapter = $_
    $adapterIndex = [int]$adapter.InterfaceIndex
    $config = $netConfigs | Where-Object { [int]$_.InterfaceIndex -eq $adapterIndex } | Select-Object -First 1
    $desc = [string]$adapter.Name
    $name = if ($adapter.NetConnectionID) { [string]$adapter.NetConnectionID } else { [string]$adapter.Name }
    $kind = if (($desc + ' ' + $name) -match 'wi-?fi|wireless|802\.11') { 'Wi-Fi' } elseif (($desc + ' ' + $name) -match 'vpn|wireguard|wintun|tap|tun|openvpn|tailscale|zerotier|nord|proton|express') { 'VPN' } else { 'Ethernet' }
    $speedMbps = if ($adapter.Speed) { [math]::Round(([double]$adapter.Speed / 1000000), 1) } else { $null }
    $speedLabel = if ($speedMbps -ge 1000) { "$([math]::Round($speedMbps / 1000, 1)) Gbps" } elseif ($speedMbps) { "$speedMbps Mbps" } else { $null }
    [pscustomobject]@{
      Name = $name
      InterfaceDescription = $adapter.Name
      LinkSpeed = $speedLabel
      Status = if ($adapter.NetEnabled) { 'Up' } else { 'Down' }
      ifIndex = $adapter.InterfaceIndex
      MacAddress = $adapter.MACAddress
      InterfaceMetric = $null
      ConnectionType = $kind
      LinkSpeedMbps = $speedMbps
      DefaultRoute = [bool]($config -and $config.DefaultIPGateway)
    }
  })
  $activeAdapter = $adapters | Where-Object { $_.DefaultRoute } | Select-Object -First 1
  if (-not $activeAdapter) { $activeAdapter = $adapters | Select-Object -First 1 }
  $vpnAdapters = @($adapters | Where-Object { $_.ConnectionType -eq 'VPN' })
  $vpn = [pscustomobject]@{ active = [bool]($vpnAdapters.Count -gt 0); adapters = $vpnAdapters }
} catch {}
try {
  if (-not $netConfigs.Count) {
    $netConfigs = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = True" -ErrorAction SilentlyContinue)
  }
  $dnsServers = @($netConfigs | Where-Object { $_.DNSServerSearchOrder -and $_.DNSServerSearchOrder.Count -gt 0 } | ForEach-Object {
    [pscustomobject]@{ interfaceAlias = $_.Description; serverAddresses = @($_.DNSServerSearchOrder) }
  })
  $dnsTests = @()
  foreach ($name in @('www.microsoft.com', 'one.one.one.one')) {
    try {
      $answer = Resolve-DnsName -Name $name -Type A -ErrorAction Stop | Select-Object -First 1
      $dnsTests += [pscustomobject]@{ name = $name; ok = $true; address = $answer.IPAddress }
    } catch {
      $dnsTests += [pscustomobject]@{ name = $name; ok = $false; address = $null }
    }
  }
  $dnsHealth = [pscustomobject]@{ ok = -not ($dnsTests | Where-Object { -not $_.ok }); tests = $dnsTests; servers = $dnsServers }
} catch {}
function Measure-Echo($target) {
  $times = @()
  $sent = 0
  $errors = 0
  $ping = [Net.NetworkInformation.Ping]::new()
  try {
    for ($i = 0; $i -lt 4; $i++) {
      try {
        $reply = $ping.Send($target, 450)
        if ($reply.Status -eq 'Success') { $sent++; $times += [double]$reply.RoundtripTime }
        elseif ($reply.Status -eq 'TimedOut') { $sent++ }
        else { $errors++ }
      } catch { $errors++ }
    }
  } finally { $ping.Dispose() }
  $received = $times.Count
  [pscustomobject]@{
    target = $target
    method = 'icmp'
    status = if ($errors -gt 0) { 'probe-error' } elseif ($received -eq 0) { 'no-reply' } else { 'measured' }
    sent = $sent
    received = $received
    packetLossPct = if ($received -gt 0 -and $errors -eq 0) { [math]::Round((($sent - $received) / $sent) * 100, 1) } else { $null }
    averageMs = if ($times.Count) { [math]::Round(($times | Measure-Object -Average).Average, 1) } else { $null }
    minMs = if ($times.Count) { [math]::Round(($times | Measure-Object -Minimum).Minimum, 1) } else { $null }
    maxMs = if ($times.Count) { [math]::Round(($times | Measure-Object -Maximum).Maximum, 1) } else { $null }
  }
}
try {
  $latency = Measure-Echo '1.1.1.1'
  if ($latency.status -ne 'measured') {
    $internetTcp = Test-TcpEndpoint 'Cloudflare' 'speed.cloudflare.com' 443
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
      Where-Object { $_.NextHop -ne '0.0.0.0' } | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    if ($route.NextHop) { $gatewayLatency = Measure-Echo $route.NextHop }
  }
} catch {}
try {
  if ($highLoadTelemetry) {
    $reachability = [pscustomobject]@{
      web = @()
      service = @()
      deferred = $true
      reason = 'deferred during competitive gaming session'
    }
  } else {
    $reachability = [pscustomobject]@{
      web = @(
        (Test-WebEndpoint 'Microsoft' 'https://www.microsoft.com'),
        (Test-WebEndpoint 'Cloudflare' 'https://one.one.one.one')
      )
      service = @(
        (Test-WebEndpoint 'GitHub' 'https://github.com')
      )
      deferred = $false
      reason = $null
    }
  }
} catch {}
try {
  if (-not $highLoadTelemetry) {
    $heavyNames = 'steam|steamwebhelper|epicgameslauncher|eadesktop|battle\.net|xbox|gamingservices|onedrive|dropbox|googledrive|docker|chrome|msedge|discord|nvidia'
    $groups = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Group-Object OwningProcess
    $bandwidthHeavyApps = @($groups | ForEach-Object {
      $pid = [int]$_.Name
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
      if ($proc -and (($proc.ProcessName -match $heavyNames) -or $_.Count -ge 25)) {
        [pscustomobject]@{
          name = $proc.ProcessName
          pid = $pid
          establishedConnections = $_.Count
          workingSetMB = [math]::Round([double]$proc.WorkingSet64 / 1MB, 1)
        }
      }
    } | Sort-Object establishedConnections -Descending | Select-Object -First 8)
  }
} catch {}
}
try {
  $processorSubgroup = '54533251-82be-4824-96c1-47b60b740d00'
  $boost = Get-PowerSettingIndex $processorSubgroup 'be337238-0d82-4146-a960-4f3749d470c7'
  $boostPolicy = Get-PowerSettingPercent $processorSubgroup '45bcc044-d885-43e2-8605-ee0ec6e96b59'
  $processorBoost = [pscustomobject]@{
    ac = $boost.ac
    dc = $boost.dc
    acLabel = Get-BoostLabel $boost.ac
    dcLabel = Get-BoostLabel $boost.dc
    acPolicyPct = $boostPolicy.ac
    dcPolicyPct = $boostPolicy.dc
    modeSource = $boost.source
    policySource = $boostPolicy.source
    available = [bool]($boost.available -or $boostPolicy.available)
  }
  $usb = Get-PowerSettingIndex '2a737441-1930-4402-8d77-b2bebba308a3' '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'
  $usbSelectiveSuspend = [pscustomobject]@{
    ac = $usb.ac
    dc = $usb.dc
    acLabel = Get-UsbSuspendLabel $usb.ac
    dcLabel = Get-UsbSuspendLabel $usb.dc
  }
  $processorMin = Get-PowerSettingIndex '54533251-82be-4824-96c1-47b60b740d00' '893dee8e-2bef-41e0-89c6-b55d0929964c'
  $processorMax = Get-PowerSettingIndex '54533251-82be-4824-96c1-47b60b740d00' 'bc5038f7-23e0-4960-96da-33abaf5935ec'
  $processorState = [pscustomobject]@{
    minAc = $processorMin.ac
    minDc = $processorMin.dc
    maxAc = $processorMax.ac
    maxDc = $processorMax.dc
  }
} catch {}
# Available memory (standby-aware) gives a truer pressure than Free alone:
# reclaimable standby cache counts as available, so the system stops acting on
# phantom exhaustion.
$ramAvailableMB = $null
$ramUsedRealPct = $null
try {
  $availB = [double]((Get-CimInstance Win32_PerfRawData_PerfOS_Memory).AvailableBytes)
  $totalMB = [double]$os.TotalVisibleMemorySize / 1024
  if ($totalMB -gt 0 -and $availB -gt 0) {
    $ramAvailableMB = [int][math]::Round($availB / 1MB)
    $ramUsedRealPct = [math]::Round((($totalMB - $ramAvailableMB) / $totalMB) * 100, 1)
  }
} catch {}
[pscustomobject]@{
  capturedAt = (Get-Date).ToString('o')
  host = [pscustomobject]@{
    name = $env:COMPUTERNAME
    user = $env:USERNAME
    manufacturer = $computer.Manufacturer
    model = $computer.Model
    elevated = $isElevated
  }
  system = [pscustomobject]@{
    cpuName = $cpu.Name
    cpuLoadPct = $cpu.LoadPercentage
    logicalProcessors = $cpu.NumberOfLogicalProcessors
    ramTotalGB = [math]::Round([double]$os.TotalVisibleMemorySize / 1MB, 1)
    ramFreeGB = [math]::Round([double]$os.FreePhysicalMemory / 1MB, 1)
    ramUsedPct = $ramPct
    ramAvailableMB = $ramAvailableMB
    ramUsedRealPct = $ramUsedRealPct
    uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    cpuTempC = $temperatures.cpuC
    systemTempC = $temperatures.systemC
    memoryTempC = $temperatures.memoryC
    storageTempC = $temperatures.storageC
  }
  gpu = $gpu
  temperatures = $temperatures
  fans = $fans
  power = [pscustomobject]@{
    activeLine = $powerLine
    plans = $plans
    hags = $hags
    processorBoost = $processorBoost
    processorState = $processorState
    usbSelectiveSuspend = $usbSelectiveSuspend
  }
  priorityApp = [pscustomobject]@{
    running = [bool]$priorityAppProcess
    process = $priorityAppProcess
  }
  foreground = $foreground
  gameRuntimes = @($gameRuntimes)
  input = $inputIdle
  network = [pscustomobject]@{
    adapters = $adapters
    activeAdapter = $activeAdapter
    dns = $dnsHealth
    latency = $latency
    gatewayLatency = $gatewayLatency
    internetTcp = $internetTcp
    reachability = $reachability
    vpn = $vpn
    bandwidthHeavyApps = $bandwidthHeavyApps
  }
  processes = @($processes)
  recentEvents = @($events)
} | ConvertTo-Json -Depth 9
`,
    {
      timeoutMs: TELEMETRY_TIMEOUT_MS,
      env: { PC_CONTROL_LHM_LIB: libreHardwareMonitorLibPath || "" }
    }
  );

  if (!result.ok || !result.stdout) {
    return telemetryCaptureErrorFallback({
      capturedAt: new Date().toISOString(),
      captureDurationMs: Date.now() - captureStartedAt,
      error: result.error || result.stderr || "Telemetry command failed.",
      processes: [],
      recentEvents: []
    }, telemetryCache.value);
  }

  const parsedTelemetry = parseJsonOutput(result.stdout, {
    capturedAt: new Date().toISOString(),
    error: "Telemetry JSON parse failed.",
    raw: result.stdout,
    processes: [],
    recentEvents: []
  });
  const toArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  parsedTelemetry.recentEvents = toArray(parsedTelemetry.recentEvents);
  parsedTelemetry.processes = toArray(parsedTelemetry.processes);
  if (parsedTelemetry.error) {
    return telemetryCaptureErrorFallback({
      ...parsedTelemetry,
      captureDurationMs: Date.now() - captureStartedAt
    }, telemetryCache.value);
  }
  parsedTelemetry.input = normalizeInputTelemetry(parsedTelemetry.input, {
    nowMs: Date.now(),
    thresholdMs: EXTENDED_IDLE_MS
  });
  if (!parsedTelemetry.error) {
    if (!skipNetwork && parsedTelemetry.network) {
      parsedTelemetry.network.sampledAt = new Date().toISOString();
      networkCache.value = parsedTelemetry.network;
      networkCache.at = Date.now();
    } else if (skipNetwork && networkCache.value) {
      parsedTelemetry.network = { ...networkCache.value, cached: true };
    }
  }
  try {
    parsedTelemetry.game = await resolveGameContext(parsedTelemetry);
  } catch (error) {
    parsedTelemetry.game = { detected: false, confirmed: null, candidates: [], error: error?.message || String(error) };
  }

  rawIdentityCache = {
    at: Date.now(),
    foreground: parsedTelemetry.foreground ? { name: parsedTelemetry.foreground.name, pid: parsedTelemetry.foreground.pid } : null,
    priorityProcess: parsedTelemetry.priorityApp?.process ? { name: parsedTelemetry.priorityApp.process.name, pid: parsedTelemetry.priorityApp.process.pid } : null
  };

  return sanitizeTelemetryIdentity({
    ...parsedTelemetry,
    captureDurationMs: Date.now() - captureStartedAt,
    networkCached: skipNetwork
  });
}

const GPU3D_PROBE_MIN_INTERVAL_MS = Number(process.env.PC_CONTROL_GPU3D_PROBE_MS || 60000);
const GPU3D_PROBE_ENABLED = process.env.PC_CONTROL_GPU3D_PROBE !== "0";
let gpu3dProbeState = { at: 0, value: null, pending: null };
let gameWatchState = { key: null, firstSeenMs: null, warmupRecorded: false };
let lastConfirmedGame = null;

export function __resetGameWatch() {
  gameWatchState = { key: null, firstSeenMs: null, warmupRecorded: false };
  gpu3dProbeState = { at: 0, value: null, pending: null };
  lastConfirmedGame = null;
}

export function getLastConfirmedGame() {
  return lastConfirmedGame;
}

export function attachCompetitiveSignals(policy) {
  if (policy && typeof policy === "object") {
    if (observerState.competitiveTrial) policy.competitiveTrial = observerState.competitiveTrial;
    if (observerState.gameTitleThermal) policy.gameTitleThermal = observerState.gameTitleThermal;
  }
  return policy;
}

export async function captureGpu3dByPid({ timeoutMs = 8000 } = {}) {
  const result = await runPowerShell(
    `
$ErrorActionPreference = 'SilentlyContinue'
$map = @{}
try {
  foreach ($s in (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples) {
    if ($s.CookedValue -gt 0 -and $s.InstanceName -match 'pid_(\\d+)_') {
      $key = $matches[1]
      $map[$key] = [double]$map[$key] + [double]$s.CookedValue
    }
  }
} catch {}
$map | ConvertTo-Json -Depth 3 -Compress
`,
    { timeoutMs }
  );
  if (!result.ok || !result.stdout) {
    return null;
  }
  const parsed = parseJsonOutput(result.stdout, null);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const byPid = {};
  for (const [pid, value] of Object.entries(parsed)) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      byPid[Number(pid)] = Math.round(n * 10) / 10;
    }
  }
  return byPid;
}

async function gpu3dSample() {
  if (!GPU3D_PROBE_ENABLED) {
    return null;
  }
  const now = Date.now();
  if (now - gpu3dProbeState.at < GPU3D_PROBE_MIN_INTERVAL_MS) {
    return gpu3dProbeState.value;
  }
  if (!gpu3dProbeState.pending) {
    gpu3dProbeState.pending = captureGpu3dByPid()
      .then((value) => {
        gpu3dProbeState.value = value;
        gpu3dProbeState.at = Date.now();
        return value;
      })
      .catch(() => gpu3dProbeState.value)
      .finally(() => {
        gpu3dProbeState.pending = null;
      });
  }
  return gpu3dProbeState.value;
}

let libraryScanPending = null;
function refreshGameLibraryInBackground(index) {
  if (libraryScanPending) return;
  const stale = !index?.scannedAt || (Date.now() - Date.parse(index.scannedAt)) > Number(process.env.PC_CONTROL_GAME_SCAN_TTL_MS || 12 * 60 * 60 * 1000);
  if (!stale) return;
  libraryScanPending = scanGameLibrary()
    .catch(() => null)
    .finally(() => {
      libraryScanPending = null;
    });
}

export async function resolveGameContext(telemetry = {}, { library = null, allowProbe = true } = {}) {
  const index = library || (await readGameLibrary());
  refreshGameLibraryInBackground(index);
  const processes = Array.isArray(telemetry.processes) ? telemetry.processes : [];
  const runtimes = Array.isArray(telemetry.gameRuntimes) ? telemetry.gameRuntimes : [];
  const evidenceProcesses = [...processes, ...runtimes];
  const foreground = telemetry.foreground || null;
  const gpuUtil = Number(telemetry?.gpu?.utilizationPct) || 0;
  const fullscreen = Boolean(foreground?.fullscreen);
  const borderlessFullscreen = Boolean(foreground?.borderlessFullscreen);
  const foregroundPid = Number(foreground?.pid);

  const pool = [];
  const seen = new Set();
  const push = (process) => {
    if (!process?.name) return;
    const id = `${process.pid ?? ""}:${process.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    pool.push(process);
  };
  push(telemetry.priorityApp?.process);
  if (Number.isFinite(foregroundPid)) {
    const match = processes.find((process) => Number(process.pid) === foregroundPid);
    push(match || (foreground?.name ? { name: foreground.name, pid: foregroundPid, path: foreground.path } : null));
  }
  for (const process of processes) push(process);

  const classify = (gpu3dPctByPid) =>
    pool
      .map((process) => {
        const isForeground = Number.isFinite(foregroundPid) && Number(process.pid) === foregroundPid;
        const verdict = classifyGameCandidate({
          process,
          foreground,
          processes: evidenceProcesses,
          library: index,
          gpuUtil,
          fullscreen: isForeground && fullscreen,
          borderlessFullscreen: isForeground && borderlessFullscreen,
          gpu3dPctByPid,
          computeApp: false
        });
        return { ...verdict, pid: process.pid ?? null, foreground: isForeground };
      })
      .filter((verdict) => verdict.likely || verdict.isGame)
      .sort((a, b) =>
        (Number(b.isGame) - Number(a.isGame))
        || (Number(b.foreground) - Number(a.foreground))
        || (b.confidence - a.confidence));

  let ranked = classify(null);
  let best = ranked[0] || null;

  if (allowProbe && best && shouldProbe3dEngine(best, { fullscreen: fullscreen || borderlessFullscreen, gpuUtil })) {
    const byPid = await gpu3dSample();
    if (byPid) {
      ranked = classify(byPid);
      best = ranked[0] || best;
    }
  }

  const confirmed = best && best.isGame ? best : null;
  const stanceEntry = confirmed ? index?.titles?.[confirmed.key] || null : null;
  const stance = confirmed ? decideLaunchStance(stanceEntry) : null;

  if (confirmed) {
    lastConfirmedGame = { key: confirmed.key, title: confirmed.title, name: confirmed.name, at: new Date().toISOString() };
    const nowMs = Date.now();
    if (gameWatchState.key !== confirmed.key) {
      gameWatchState = { key: confirmed.key, firstSeenMs: nowMs, warmupRecorded: false };
    }
    const cpuLoadPct = Number(telemetry?.system?.cpuLoadPct) || 0;
    const rendering = gpuUtil >= 25 || cpuLoadPct >= 25;
    if (rendering && !gameWatchState.warmupRecorded && gameWatchState.firstSeenMs) {
      gameWatchState.warmupRecorded = true;
      recordGameWarmup({
        key: confirmed.key,
        seconds: Math.max(0, Math.round((nowMs - gameWatchState.firstSeenMs) / 1000)),
        title: confirmed.title
      }).catch(() => {});
    }
  } else if (gameWatchState.key) {
    gameWatchState = { key: null, firstSeenMs: null, warmupRecorded: false };
  }

  return {
    detected: Boolean(confirmed),
    confirmed,
    candidates: ranked.slice(0, 5),
    preActivity: Boolean(confirmed) && !gameWatchState.warmupRecorded,
    stance: stance?.stance || (confirmed ? COMPETITIVE_PRIOR.startingStance : null),
    stanceReason: stance?.reason || null,
    engageNow: Boolean(confirmed) && stance?.stance === GAME_STANCES.immediateCompetitive,
    prior: confirmed ? COMPETITIVE_PRIOR.id : null,
    libraryScannedAt: index?.scannedAt || null,
    indexedTitles: index?.titles ? Object.keys(index.titles).length : 0
  };
}

export async function discoverPriorityAppInstallations() {
  const telemetry = await captureTelemetry({ maxAgeMs: 5000 });
  const candidates = [];
  const seen = new Set();

  function addProcessCandidate(process, source, reason) {
    if (!process || !process.name) {
      return;
    }
    const key = String(process.pid || process.name);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({
      source,
      name: process.name,
      pid: process.pid ?? null,
      path: process.path || null,
      cpuPct: process.cpuPct ?? null,
      workingSetMB: process.workingSetMB ?? null,
      reason,
      canTrack: true
    });
  }

  addProcessCandidate(telemetry.priorityApp?.process, "telemetry", "Current high-load workload candidate.");
  const foregroundPid = Number(telemetry.foreground?.pid);
  if (Number.isFinite(foregroundPid)) {
    addProcessCandidate(
      (telemetry.processes || []).find((process) => Number(process.pid) === foregroundPid),
      "foreground",
      "Current foreground workload."
    );
  }
  for (const process of telemetry.processes || []) {
    if (candidates.length >= 8) {
      break;
    }
    const cpuPct = Number(process.cpuPct);
    const privateMB = Number(process.privateMB);
    if ((Number.isFinite(cpuPct) && cpuPct >= 12) || (Number.isFinite(privateMB) && privateMB >= 1800)) {
      addProcessCandidate(process, "resource-load", "Resource-heavy process detected.");
    }
  }

  return { ok: true, candidates };
}

async function readStatusAuxiliary(options = {}) {
  const requireFresh = options.requireFresh === true;
  const now = Date.now();
  if (!requireFresh && statusAuxCache.value && now - statusAuxCache.at < STATUS_AUX_TTL_MS) {
    return statusAuxCache.value;
  }
  if (!requireFresh && statusAuxCache.pending) {
    return statusAuxCache.value || statusAuxCache.pending;
  }

  const pending = Promise.all([
    maybeArchiveOldAuditRecords(),
    readAudit({ limit: STATUS_AUDIT_LIMIT }),
    readLedger(80),
    readRecoveryState(),
    readSingleInstanceLock(),
    readPriorityAppSessions(5),
    readContextSessions(5),
    presentMonStatus(),
    listSnapshots(8),
    readReliefStore(),
    readEfficacy(),
    readSelfHealth(),
    readSelfTreatment(),
    readIncidentLearningStore(),
    readMlDecisionLedger(),
    getDiagnosticTrapStatus()
  ]).then(([
    auditArchiveMaintenance,
    audit,
    ledger,
    recovery,
    lock,
    sessions,
    contextSessions,
    frameTooling,
    snapshots,
    reliefStore,
    efficacyStore,
    selfHealthStore,
    selfTreatmentStore,
    incidentLearningStore,
    mlDecisionLedgerStore,
    diagnosticTraps
  ]) => ({
    audit,
    ledger,
    recovery,
    lock,
    sessions,
    contextSessions,
    frameTooling,
    snapshots,
    reliefStore,
    efficacyStore,
    selfHealthStore,
    selfTreatmentStore,
    incidentLearningStore,
    mlDecisionLedgerStore,
    diagnosticTraps,
    auditArchive: {
      ...getAuditArchiveStatus(),
      lastMaintenance: auditArchiveMaintenance
    }
  })).then((value) => {
    if (!requireFresh) {
      statusAuxCache.value = value;
      statusAuxCache.at = Date.now();
    }
    return value;
  }).finally(() => {
    if (statusAuxCache.pending === pending) {
      statusAuxCache.pending = null;
    }
  });

  if (!requireFresh) {
    statusAuxCache.pending = pending;
  }
  if (!requireFresh && statusAuxCache.value) {
    return statusAuxCache.value;
  }
  return pending;
}

export async function getStatus(options = {}) {
  const state = await readState();
  const telemetry = overlayLiveCore(await captureTelemetry({
    maxAgeMs: 5000,
    allowStaleSeed: options.requireFresh !== true
  }));
  const aux = await readStatusAuxiliary({ requireFresh: options.requireFresh === true });
  const learning = await learningStore.summary();
  const effectiveLearning = effectiveLearningForDecisions(state, learning);
  const policy = evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning));
  const adapterValidation = validateAdapterManifests();
  const efficacy = summarizeEfficacy(aux.efficacyStore);
  const selfHealth = summarizeSelfHealth(aux.selfHealthStore);
  const selfTreatment = summarizeSelfTreatment(aux.selfTreatmentStore, selfHealth);
  const incidentLearning = summarizeIncidentLearning(aux.incidentLearningStore, { state, telemetry, policy });
  const performanceKnowledge = summarizeExternalPerformanceKnowledge();
  const hardwareProfile = summarizeHardwareProfile(telemetry);
  const mlDecisionLedger = summarizeGovernorDecisionLedger(aux.mlDecisionLedgerStore);
  attachCompetitiveSignals(policy);
  const cachedAdaptive = getLastResolvedPlan();
  const adaptivePower = cachedAdaptive && cachedAdaptive.modeId === state.modeId
    ? cachedAdaptive
    : resolveAdaptivePlanStateless({ modeId: state.modeId, telemetry, policy, learning: effectiveLearning });
  const drift = detectDrift({ state, telemetry, desiredPowerPlan: adaptivePower?.plan });
  const observer = getObserverState();
  const inactivity = buildInactivityStatus({ telemetry, observer });
  const readiness = buildReadinessSummary({
    telemetry,
    observer,
    adapters: adapterValidation,
    drift,
    frameTooling: aux.frameTooling
  });
  const relief = buildReliefStatus({ state, telemetry, policy, store: aux.reliefStore });
  const mlGovernor = buildAutonomousMlGovernor({
    state,
    telemetry,
    policy,
    learning,
    efficacy,
    relief,
    adaptivePower,
    decisionLedger: mlDecisionLedger
  });
  const mlExecutionGate = buildMlExecutionGate({
    governor: mlGovernor,
    decisionLedger: mlDecisionLedger,
    state,
    relief
  });
  const mlExecutor = {
    ...(observerState.mlExecution || planMlExecution({
      gate: mlExecutionGate,
      automations: state.automations,
      state,
      decisionLedger: mlDecisionLedger,
      nowMs: Date.now(),
      lastExecMs: observerState.lastMlExecAt || 0
    })),
    executedCount: observerState.mlExecutedCount || 0,
    lastExecAt: observerState.lastMlExecAt ? new Date(observerState.lastMlExecAt).toISOString() : null
  };
  const mlOptimizer = buildNorthStarOptimizer({
    state,
    telemetry,
    policy,
    governor: mlGovernor,
    decisionLedger: mlDecisionLedger,
    executionGate: mlExecutionGate,
    efficacy,
    relief,
    adaptivePower,
    readiness,
    performanceKnowledge
  });
  const architectureSnapshot = buildArchitectureSnapshot({
    state,
    telemetry,
    policy,
    adaptivePower,
    observer,
    mlGovernor,
    mlDecisionLedger,
    mlExecutionGate,
    mlExecutor,
    mlOptimizer,
    readiness
  });
  return {
    app: {
      name: "PC Control Plane",
      version: "0.8.0",
      workspaceRoot
    },
    state,
    observer,
    modes,
    telemetry,
    hardwareProfile,
    policy,
    protectedApps: protectedAppRules,
    learning,
    explain: explainDecision({
      policy,
      adaptivePower,
      state,
      overdriveLock: overdriveLockStatus(state)
    }),
    audit: compactAuditForStatus(aux.audit),
    competitiveTuning: {
      ...(await competitiveTuningStatus()),
      trial: observerState.competitiveTrial || null,
      titleThermal: observerState.gameTitleThermal || null
    },
    v2: {
      adapters: {
        ok: adapterValidation.ok,
        errors: adapterValidation.errors,
        manifests: adapterManifests
      },
      ledger: aux.ledger,
      auditArchive: {
        ...aux.auditArchive
      },
      snapshots: aux.snapshots,
      recovery: aux.recovery,
      drift,
      lock: aux.lock,
      healthSessions: aux.sessions,
      priorityAppSessions: aux.sessions,
      contextSessions: aux.contextSessions,
      frameTooling: aux.frameTooling,
      inactivity,
      diagnosticTraps: aux.diagnosticTraps,
      adaptivePower,
      failureProactivePrevention: policy.failureProactivePrevention,
      failurePrevention: policy.failurePrevention,
      failureRemediation: policy.failureRemediation,
      relief,
      selfHealth,
      selfTreatment,
      incidentLearning,
      performanceKnowledge,
      hardwareProfile,
      mlGovernor,
      mlDecisionLedger,
      mlExecutionGate,
      mlExecutor,
      mlOptimizer,
      architecture: {
        schema: architectureSnapshot.schema,
        ...architectureSnapshot.runtime
      },
      readiness,
      learningInfluence: {
        enabled: learningInfluenceEnabled(state),
        summary: learningInfluenceEnabled(state)
          ? "Learning can bias power and app reputation recommendations within safety bounds."
          : "Learning is advisory-only; resolver bias, guardrails, and app reputation influence are ignored."
      }
    }
  };
}

export async function getArchitecture(options = {}) {
  const status = await getStatus({ requireFresh: options.requireFresh === true });
  return {
    ok: true,
    ...buildArchitectureSnapshot({
      state: status.state,
      telemetry: status.telemetry,
      policy: status.policy,
      adaptivePower: status.v2?.adaptivePower,
      observer: status.observer,
      mlGovernor: status.v2?.mlGovernor,
      mlDecisionLedger: status.v2?.mlDecisionLedger,
      mlExecutionGate: status.v2?.mlExecutionGate,
      mlExecutor: status.v2?.mlExecutor,
      mlOptimizer: status.v2?.mlOptimizer,
      readiness: status.v2?.readiness
    })
  };
}

export async function getFailureDiagnostics() {
  const state = await readState();
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  const eventAnalysis = analyzeEvents(telemetry?.recentEvents || [], telemetry);
  const diagnostics = buildFailureDiagnostics({ telemetry, eventAnalysis });
  return {
    ok: true,
    modeId: state.modeId,
    autonomy: state.autonomy,
    telemetryCapturedAt: telemetry?.capturedAt || null,
    ...diagnostics
  };
}

export async function getIncidentLearningReport(options = {}) {
  const state = await readState();
  const telemetry = overlayLiveCore(await captureTelemetry({
    maxAgeMs: 30000,
    allowStaleSeed: options.requireFresh !== true
  }));
  const learning = await learningStore.summary();
  const policy = evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning));
  return {
    ok: true,
    ...summarizeIncidentLearning(await readIncidentLearningStore(), { state, telemetry, policy })
  };
}

export async function getLearnedApps() {
  return { ok: true, appReputation: await learningStore.appReputationSummary() };
}

export async function setLearnedAppDecision(options = {}) {
  return learningStore.applyAppDecision(options);
}

export function overdriveLockDecision({
  currentModeId = null,
  armedAtIso = null,
  targetModeId = null,
  source = "user",
  nowMs = Date.now()
} = {}) {
  if (currentModeId !== "overdrive" || targetModeId === "overdrive") {
    return { blocked: false, remainingSeconds: 0, reason: "not leaving Overdrive" };
  }
  if (OVERDRIVE_LOCK_SAFETY_SOURCES.has(String(source))) {
    return { blocked: false, remainingSeconds: 0, safetyBypass: true, reason: "safety source bypasses the Overdrive hold" };
  }
  if (!OVERDRIVE_AGENT_SOURCES.has(String(source))) {
    return { blocked: false, remainingSeconds: 0, userChoice: true, reason: "user-initiated change is always allowed" };
  }
  const armedMs = Date.parse(armedAtIso || "");
  if (!Number.isFinite(armedMs)) {
    return { blocked: false, remainingSeconds: 0, reason: "no Overdrive arm timestamp" };
  }
  const elapsedMs = nowMs - armedMs;
  if (elapsedMs >= OVERDRIVE_LOCK_MS) {
    return { blocked: false, remainingSeconds: 0, reason: "Overdrive hold has expired" };
  }
  const remainingSeconds = Math.max(1, Math.ceil((OVERDRIVE_LOCK_MS - elapsedMs) / 1000));
  return {
    blocked: true,
    remainingSeconds,
    reason: `the autonomous system leaves user-selected Overdrive alone for ${Math.ceil(OVERDRIVE_LOCK_MS / 60000)} minutes`
  };
}

export async function getWhy() {
  const status = await getStatus();
  return { ok: true, explain: status.explain, mode: status.state.modeId, plan: status.v2?.adaptivePower?.plan || null };
}

export async function runSimulation(key = null) {
  const state = await readState();
  const learning = await learningStore.summary();
  if (key) {
    const result = simulateScenario(key, { learning, state });
    return result.ok ? { ok: true, ...result } : { ok: false, message: result.message, available: Object.keys(SIMULATION_SCENARIOS) };
  }
  return { ok: true, ...simulateAll({ learning, state }) };
}

export async function getGames() {
  const snapshot = await gameLibrarySnapshot();
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  return {
    ok: true,
    ...snapshot,
    current: telemetry?.game?.confirmed || null,
    candidates: (telemetry?.game?.candidates || []).map((candidate) => ({
      key: candidate.key,
      name: candidate.name,
      title: candidate.title,
      path: candidate.path,
      confidence: candidate.confidence,
      isGame: candidate.isGame,
      foreground: candidate.foreground === true,
      reason: candidate.reason,
      evidence: candidate.evidence
    })),
    stance: telemetry?.game?.stance || null,
    stanceReason: telemetry?.game?.stanceReason || null
  };
}

export async function rescanGames() {
  const library = await scanGameLibrary({ force: true });
  await appendAudit({
    level: "info",
    action: "games.scan",
    message: `Game library rescanned: ${Object.keys(library.titles || {}).length} known title(s), ${(library.installDirs || []).length} install directory(ies).`
  });
  return { ok: Boolean(library.scanOk), scannedAt: library.scannedAt, error: library.scanError, ...(await gameLibrarySnapshot()) };
}

export async function setGameVerdict(body = {}) {
  const result = await markGameVerdict({
    key: body.key || null,
    path: body.path || null,
    name: body.name || null,
    title: body.title || null,
    verdict: body.verdict === undefined ? null : body.verdict
  });
  if (!result.ok) {
    return result;
  }
  telemetryCache.at = 0;
  await appendAudit({
    level: "info",
    action: "games.mark",
    message: `You marked ${body.title || body.name || result.key} as ${result.verdict === null ? "unclassified" : result.verdict}.`,
    details: { key: result.key, verdict: result.verdict }
  });
  return { ok: true, ...result, ...(await gameLibrarySnapshot()) };
}

export async function labIrqAudit() {
  return auditIrqShepherd();
}

const labConsoleGuard = `
$ErrorActionPreference = 'Stop'
Add-Type 'using System.Runtime.InteropServices; public static class LabConsole { [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId(); }'
$session = (Get-Process -Id $PID).SessionId
if ($session -eq 0 -or $session -ne [LabConsole]::WTSGetActiveConsoleSessionId()) {
  throw 'Use Performance Lab from the local Windows desktop.'
}
`;
const labAdapters = `
function Get-LabAdapter {
  Get-NetAdapter -Physical | Where-Object {
    $_.HardwareInterface -and ($_.MediaType -in @('802.3', 'Native 802.11') -or $_.NdisPhysicalMedium -in @(9, 14))
  }
}
`;
let adapterRestartPending = false;
let adapterReadbackRequired = null;

export async function labNetworkAdapters() {
  if (adapterRestartPending) return { ok: false, message: "An adapter restart is in progress." };
  const result = await runPowerShell(labConsoleGuard + labAdapters + `
ConvertTo-Json -Compress -InputObject @(Get-LabAdapter | ForEach-Object {
  @{ id = [string]$_.InterfaceGuid; name = $_.Name; status = [string]$_.Status }
})
`);
  if (!result.ok) return { ok: false, message: "Adapter list unavailable. Use the local Windows desktop." };
  const adapters = JSON.parse(result.stdout);
  if (adapters.some((adapter) => adapter.id.replace(/[{}]/g, "").toLowerCase() === adapterReadbackRequired
      && ["Up", "Disconnected"].includes(adapter.status))) adapterReadbackRequired = null;
  return { ok: true, adapters };
}

export async function labRestartAdapter(body, deps = {
  run: runPowerShell, capture: captureTelemetry, audit: appendAudit, diagnose: runNetworkDiagnosis
}) {
  const id = typeof body?.id === "string" ? body.id.replace(/^\{|\}$/g, "") : "";
  if (body?.confirmed !== true || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
    return { ok: false, message: "Select an adapter and confirm the disconnect." };
  }
  if (adapterRestartPending || adapterReadbackRequired) {
    return { ok: false, message: "Wait for the current action or refresh adapter status before retrying." };
  }
  adapterRestartPending = true;
  try {
    const telemetry = await deps.capture({ force: true, skipNetwork: true });
    if (!telemetry?.foreground?.pid || telemetry?.game?.detected) {
      return { ok: false, message: "End gameplay and verify the foreground session before restarting an adapter." };
    }
    await deps.audit({ level: "info", action: "lab.adapter-restart", message: "Local adapter restart requested.", details: { id } });
    adapterReadbackRequired = id.toLowerCase();
    const result = await deps.run(labConsoleGuard + labAdapters + `
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'ADMIN_REQUIRED'; exit 1
}
$adapter = @(Get-LabAdapter | Where-Object { [guid]$_.InterfaceGuid -eq [guid]'${id}' })
if ($adapter.Count -ne 1 -or $adapter[0].Status -eq 'Disabled') {
  Write-Output 'ADAPTER_UNAVAILABLE'; exit 1
}
Restart-NetAdapter -InputObject $adapter[0] -Confirm:$false
Write-Output 'RESTARTED'
for ($i = 0; $i -lt 10; $i++) {
  $current = Get-LabAdapter | Where-Object { [guid]$_.InterfaceGuid -eq [guid]'${id}' }
  if ($current.Status -eq 'Up') { Write-Output 'LINK_UP'; break }
  Start-Sleep -Seconds 1
}
`, { timeoutMs: 30000 });
    const lines = result.stdout.split(/\r?\n/);
    const restarted = lines.includes("RESTARTED");
    const linkUp = lines.includes("LINK_UP");
    const refused = lines.includes("ADMIN_REQUIRED") || lines.includes("ADAPTER_UNAVAILABLE");
    if (result.ok || refused) adapterReadbackRequired = null;
    const diagnosis = restarted ? await deps.diagnose({ dryRun: true }).catch(() => null) : null;
    const message = lines.includes("ADMIN_REQUIRED") ? "Start PC Control Plane as administrator to restart an adapter."
      : lines.includes("ADAPTER_UNAVAILABLE") ? "The selected adapter is no longer available for restart."
      : !restarted ? "Restart not verified. Refresh adapter status before trying again."
      : linkUp ? "Adapter restarted and link restored. " + (diagnosis?.message || "Internet recovery unverified.")
      : "Adapter restarted; connection recovery unverified. " + (diagnosis?.message || "");
    await deps.audit({ level: restarted && linkUp ? "action" : "warn", action: "lab.adapter-restart", message, details: { id, restarted, linkUp } });
    return { ok: restarted, restarted, linkUp, message };
  } finally {
    adapterRestartPending = false;
  }
}

const comfortScript = path.join(appRoot, "scripts", "desktop-comfort.ps1");
const comfortPath = path.join(dataDir, "desktop-comfort.json");
let comfortWarm = null;

async function stopComfortWarmth() {
  const state = comfortWarm;
  if (!state) return;
  if (!state.child.stdin.writableEnded) state.child.stdin.end("stop\n");
  let timer;
  try {
    await Promise.race([state.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Warmth is still releasing. Wait before trying again.")), 6000);
    })]);
    if (!state.released) throw new Error("Windows could not confirm warmth restoration. Check other screen filters.");
  } finally { clearTimeout(timer); }
}

function requestComfortWarmth(state, strength, initial = false) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.child.stdin.end("stop\n");
      state.finish("Warmth timed out. Waiting for the previous colors to be restored.");
    }, 15000);
    state.requested = strength;
    state.finish = (warning) => {
      clearTimeout(timer);
      state.finish = () => {};
      resolve(warning);
    };
    if (!initial) state.child.stdin.write("strength:" + strength + "\n");
  });
}

async function setComfortWarmth(strength) {
  if (!strength) return stopComfortWarmth();
  if (comfortWarm) {
    if (!comfortWarm.active || comfortWarm.child.stdin.writableEnded) {
      throw new Error("The warmth helper is recovering. Wait before trying again.");
    }
    if (comfortWarm.strength === strength) return;
    const warning = await requestComfortWarmth(comfortWarm, strength);
    if (warning) throw new Error(warning);
    return;
  }
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", comfortScript,
    "-Action", "warm", "-Strength", String(strength), "-OwnerPid", String(process.pid)], { windowsHide: true });
  const state = { child, active: false, strength: null, released: false, finish: () => {} };
  comfortWarm = state;
  child.stdin.on("error", () => state.finish("The warmth helper disconnected. Please try again."));
  child.stderr.resume();
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    const lines = output.split(/\r?\n/);
    output = lines.pop();
    for (const line of lines) {
      const match = /^WARM_ACTIVE:(\d+)$/.exec(line);
      if (match) {
        state.active = true;
        state.strength = Number(match[1]);
        if (state.strength === state.requested) state.finish(null);
      } else if (["WARM_RESTORED", "WARM_RELEASED"].includes(line)) {
        state.released = true;
        state.active = false;
      } else if (line === "COLOR_CONFLICT") {
        state.active = false;
        state.finish("Another screen filter is active. Pause it before using warmth.");
      }
    }
  });
  state.closed = new Promise((resolve) => {
    child.once("error", () => state.finish("The Windows warmth helper could not start."));
    child.once("close", (code) => {
      state.active = false;
      state.finish("Windows did not confirm warmth. Check the desktop session and other screen filters.");
      if (comfortWarm === state) comfortWarm = null;
      resolve(code);
    });
  });
  const warning = await requestComfortWarmth(state, strength, true);
  if (warning) throw new Error(warning);
}

const comfortController = createComfortController({
  read: () => readJson(comfortPath, null),
  write: async (settings) => {
    await writeJson(comfortPath + ".tmp", settings);
    await fs.rename(comfortPath + ".tmp", comfortPath);
  },
  capture: () => captureTelemetry({ maxAgeMs: 3000, skipNetwork: true }),
  warmth: () => ({ active: Boolean(comfortWarm?.active), strength: comfortWarm?.strength ?? null }),
  setWarmth: setComfortWarmth,
  setTheme: async (theme) => {
    const result = await runPowerShellScript(comfortScript, ["-Action", theme || "restore"], { timeoutMs: 12000 });
    if (!result.ok || !["THEME_APPLIED", "THEME_RESTORED"].includes(result.stdout?.trim())) {
      throw new Error(result.stdout?.trim() === "THEME_CONFLICT"
        ? "Exit Auto Dark Mode before changing the theme. Only one app should manage appearance."
        : "Windows did not confirm the theme change. Open PC Control Plane as the signed-in desktop user.");
    }
  },
  audit: appendAudit
});
export const getDesktopComfort = () => comfortController.get();
export const setDesktopComfort = (body) => comfortController.set(body);
const tickDesktopComfort = (telemetry) => comfortController.tick(telemetry);

export async function labIrqApply() {
  const telemetry = await captureTelemetry({ maxAgeMs: 15000 });
  if (telemetry?.game?.detected) {
    return { ok: false, error: `${telemetry.game.confirmed?.title || "A game"} is running — applying restarts the NIC and would drop you mid-session. Try again after the session.` };
  }
  const result = await applyIrqShepherd();
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "lab.irq-shepherd",
    message: result.ok
      ? `Interrupt shepherding applied: ${result.adapterName} interrupts steered to cores ${result.steeredToCores.join("+")} (${result.maskHex}); adapter ${result.adapterStatus}, internet ${result.internetOk ? "verified" : "NOT verified"}. Owner-authorized 2026-08-13.`
      : `Interrupt shepherding apply refused/failed: ${result.error}`,
    details: result
  });
  return result;
}

export async function labIrqRevert() {
  const telemetry = await captureTelemetry({ maxAgeMs: 15000 });
  if (telemetry?.game?.detected) {
    return { ok: false, error: "A game is running — reverting restarts the NIC. Try again after the session." };
  }
  const result = await revertIrqShepherd();
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "lab.irq-shepherd",
    message: result.ok ? `Interrupt shepherding reverted on ${result.adapterName}; prior affinity restored.` : `Revert failed: ${result.error}`,
    details: result
  });
  return result;
}

export async function labFrameCheck({ seconds = 6 } = {}) {
  const telemetry = await captureTelemetry({ maxAgeMs: 15000 });
  const target = telemetry?.game?.confirmed?.name
    || telemetry?.foreground?.name
    || telemetry?.priorityApp?.process?.name
    || null;
  if (!target) return { ok: false, error: "No foreground workload to measure." };
  const captureTarget = telemetry?.game?.confirmed?.name || rawForegroundIdentity()?.name || target;
  const stats = await captureFrameStats({ processName: captureTarget, seconds: Math.max(3, Math.min(15, Number(seconds) || 6)) });
  return {
    ok: stats.available !== false,
    target,
    stats,
    delivery: stats.delivery || null,
    note: stats.available === false
      ? (stats.reason || "capture unavailable")
      : (stats.delivery?.flipAdvice || "No delivery details in this capture (older PresentMon builds omit PresentMode).")
  };
}

export async function labGpuThieves() {
  const byPid = await captureGpu3dByPid({ timeoutMs: 12000 });
  if (!byPid) return { ok: false, error: "Per-process GPU counters unavailable." };
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  const processes = Array.isArray(telemetry?.processes) ? telemetry.processes : [];
  const gameName = telemetry?.game?.confirmed?.name || null;
  const gamePid = rawForegroundIdentity()?.pid ?? null;
  const rows = Object.entries(byPid)
    .map(([pid, pct]) => {
      const proc = processes.find((p) => Number(p.pid) === Number(pid));
      return { pid: Number(pid), name: proc?.name || null, path: proc?.path || null, gpu3dPct: pct };
    })
    .filter((row) => row.gpu3dPct >= 1)
    .sort((a, b) => b.gpu3dPct - a.gpu3dPct);
  const game = rows.find((row) =>
    (gameName && row.name && row.name.toLowerCase() === gameName.toLowerCase())
    || (gamePid !== null && row.pid === Number(gamePid))
  ) || null;
  const thieves = rows.filter((row) => row !== game);
  return { ok: true, game, thieves, sampledAt: new Date().toISOString() };
}

export async function labInterruptions({ limit = 50 } = {}) {
  const steals = await readFocusSteals(limit);
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  const gameName = telemetry?.game?.confirmed?.name || getLastConfirmedGame()?.name || null;
  return {
    ok: true,
    gameName,
    steals: steals.map((entry) => ({
      ...entry,
      isGame: Boolean(gameName && entry.name && entry.name.toLowerCase() === String(gameName).toLowerCase())
    })),
    note: steals.length
      ? "Every foreground change logged during competitive sessions. Anything that isn't the game stole your focus."
      : "No focus changes logged yet — the watcher runs during competitive sessions."
  };
}

export async function labEcoCageAction(body = {}) {
  const result = await applyEcoCage({
    pid: body.pid,
    name: body.name,
    enable: body.enable !== false,
    gameName: getLastConfirmedGame()?.name || null
  });
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "lab.eco-cage",
    message: result.ok
      ? `Eco-cage ${result.enabled ? "applied to" : "removed from"} ${result.name || result.pid} — throttled via EcoQoS, not killed.`
      : `Eco-cage refused for ${body.name || body.pid}: ${result.error}`,
    details: result
  });
  return result;
}

const HZ_CHECK_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$sig = @'
using System; using System.Runtime.InteropServices;
public class Disp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct DEVMODE { public string dmDeviceName_pad; }
}
'@
Add-Type -AssemblyName System.Windows.Forms
$out = @()
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $name = $screen.DeviceName
  $dm = New-Object -TypeName PSObject
  $current = $null; $best = 0
  $code = @'
using System; using System.Runtime.InteropServices;
public class DM {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName; public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput; public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName; public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight; }
  [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
}
'@
  if (-not ([System.Management.Automation.PSTypeName]'DM').Type) { Add-Type -TypeDefinition $code }
  $d = New-Object DM+DEVMODE
  $d.dmSize = [short][System.Runtime.InteropServices.Marshal]::SizeOf($d)
  if ([DM]::EnumDisplaySettings($name, -1, [ref]$d)) {
    $curHz = $d.dmDisplayFrequency; $w = $d.dmPelsWidth; $h = $d.dmPelsHeight
    $i = 0
    $m = New-Object DM+DEVMODE
    $m.dmSize = $d.dmSize
    while ([DM]::EnumDisplaySettings($name, $i, [ref]$m)) {
      if ($m.dmPelsWidth -eq $w -and $m.dmPelsHeight -eq $h -and $m.dmDisplayFrequency -gt $best) { $best = $m.dmDisplayFrequency }
      $i++
    }
    $out += @{ device = $name; primary = $screen.Primary; width = $w; height = $h; currentHz = $curHz; maxHz = $best; mismatch = ($best -gt $curHz) }
  }
}
$out | ConvertTo-Json -Depth 3 -Compress
`;

export async function labHzCheck() {
  const result = await runPowerShell(HZ_CHECK_SCRIPT, { timeoutMs: 25000 });
  const parsed = parseJsonOutput(result.stdout, null);
  const displays = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const gamingMaxHz = displays.reduce((best, d) => Math.max(best, Number(d.maxHz) || 0), 0);
  const annotated = displays.map((d) => ({
    ...d,
    gamingDisplay: Number(d.maxHz) === gamingMaxHz && gamingMaxHz > 0,
    concern: Boolean(d.mismatch) && Number(d.maxHz) === gamingMaxHz
  }));
  const gamingMismatch = annotated.filter((d) => d.concern);
  const secondaryBelowMax = annotated.filter((d) => d.mismatch && !d.concern);
  if (gamingMismatch.length) {
    await appendAudit({
      level: "warn",
      action: "lab.hz-mismatch",
      message: `GAMING display below panel maximum: ${gamingMismatch.map((d) => `${d.device} at ${d.currentHz}Hz (panel supports ${d.maxHz}Hz)`).join("; ")}.`,
      details: { displays: annotated }
    });
  }
  return {
    ok: displays.length > 0,
    displays: annotated,
    summary: displays.length === 0
      ? "Could not read display modes."
      : gamingMismatch.length
        ? `Your GAMING display is below its panel maximum — fix in Settings > Display > Advanced.`
        : secondaryBelowMax.length
          ? `Gaming display at panel maximum. ${secondaryBelowMax.length} secondary display(s) below max — fine if deliberate (saves idle GPU power).`
          : "Every display is at its panel maximum refresh rate."
  };
}

const VRAM_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @{}
foreach ($s in (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples) {
  if ($s.InstanceName -match 'pid_(\\d+)' -and $s.CookedValue -gt 0) {
    $p = $matches[1]
    $rows[$p] = [double]$rows[$p] + $s.CookedValue
  }
}
$out = @()
foreach ($k in $rows.Keys) {
  $proc = Get-Process -Id ([int]$k) -ErrorAction SilentlyContinue
  $out += @{ pid = [int]$k; name = $proc.ProcessName; vramMB = [math]::Round($rows[$k] / 1MB, 0) }
}
$out | Sort-Object { -$_.vramMB } | Select-Object -First 15 | ConvertTo-Json -Depth 3 -Compress
`;

export async function labVramGuard() {
  const result = await runPowerShell(VRAM_SCRIPT, { timeoutMs: 25000 });
  const parsed = parseJsonOutput(result.stdout, null);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  const totalMB = Number(telemetry?.gpu?.memoryTotalMB) || null;
  const usedMB = Number(telemetry?.gpu?.memoryUsedMB) || null;
  const gameName = telemetry?.game?.confirmed?.name || null;
  return {
    ok: rows.length > 0,
    totalMB,
    usedMB,
    headroomMB: totalMB && usedMB ? totalMB - usedMB : null,
    consumers: rows.map((row) => ({ ...row, isGame: Boolean(gameName && row.name && row.name.toLowerCase() === gameName.toLowerCase()) })),
    warning: totalMB && usedMB && usedMB / totalMB > 0.9
      ? "VRAM over 90% — eviction stutter territory. Closing the biggest non-game consumer buys back headroom."
      : null
  };
}

const DRIVE_BENCH_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null -and $_.Name.Length -eq 1 })) {
  $root = $d.Root
  $target = Get-ChildItem $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 64MB } | Select-Object -First 1
  if (-not $target) {
    $target = Get-ChildItem (Join-Path $root 'SteamLibrary\\steamapps\\common'),(Join-Path $root 'Program Files (x86)\\Steam\\steamapps\\common') -Recurse -File -Depth 3 -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 64MB } | Select-Object -First 1
  }
  if (-not $target) { $out += @{ drive = $d.Name; ok = $false; note = 'no large file to read' }; continue }
  try {
    $fs = [System.IO.File]::Open($target.FullName, 'Open', 'Read', 'ReadWrite')
    $buf = New-Object byte[] (1MB)
    $bytes = 0
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($bytes -lt 128MB) {
      $r = $fs.Read($buf, 0, $buf.Length)
      if ($r -le 0) { break }
      $bytes += $r
    }
    $sw.Stop()
    $seqMBps = if ($sw.Elapsed.TotalSeconds -gt 0) { [math]::Round(($bytes / 1MB) / $sw.Elapsed.TotalSeconds, 0) } else { 0 }
    $rand = 0
    $len = $fs.Length
    $sw.Restart()
    for ($i = 0; $i -lt 120; $i++) {
      $pos = Get-Random -Maximum ([math]::Max(1, $len - 4096))
      [void]$fs.Seek($pos, 'Begin')
      [void]$fs.Read($buf, 0, 4096)
      $rand++
    }
    $sw.Stop()
    $iops = if ($sw.Elapsed.TotalSeconds -gt 0) { [math]::Round($rand / $sw.Elapsed.TotalSeconds, 0) } else { 0 }
    $fs.Close()
    $out += @{ drive = $d.Name; ok = $true; seqReadMBps = $seqMBps; randReadIOPS = $iops; testedFile = $target.FullName }
  } catch { $out += @{ drive = $d.Name; ok = $false; note = $_.Exception.Message } }
}
$out | ConvertTo-Json -Depth 3 -Compress
`;

export async function labDriveBench() {
  const result = await runPowerShell(DRIVE_BENCH_SCRIPT, { timeoutMs: 120000 });
  const parsed = parseJsonOutput(result.stdout, null);
  const drives = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const snapshot = await gameLibrarySnapshot();
  const titlesByDrive = {};
  for (const title of snapshot.titles || []) {
    const drive = String(title.path || "").charAt(0).toUpperCase();
    if (drive) {
      titlesByDrive[drive] = titlesByDrive[drive] || [];
      titlesByDrive[drive].push(title.title || title.key);
    }
  }
  const ranked = drives.filter((d) => d.ok).sort((a, b) => b.seqReadMBps - a.seqReadMBps);
  const fastest = ranked[0] || null;
  const advice = [];
  if (fastest) {
    for (const drive of ranked.slice(1)) {
      const titles = titlesByDrive[String(drive.drive).toUpperCase()] || [];
      if (titles.length && fastest.seqReadMBps > drive.seqReadMBps * 2) {
        const verb = titles.length > 1 ? "sit" : "sits";
        advice.push(`${titles.slice(0, 4).join(", ")} ${verb} on ${drive.drive}: (${drive.seqReadMBps} MB/s) — ${fastest.drive}: is ${Math.round(fastest.seqReadMBps / Math.max(1, drive.seqReadMBps))}x faster for load times.`);
      }
    }
  }
  return { ok: drives.length > 0, drives, titlesByDrive, advice, benchedAt: new Date().toISOString() };
}

const MOUSE_CONTROL_BACKUP_PATH = path.join(dataDir, "mouse-control-backup.json");
const MOUSE_POLLING_RATES = Object.freeze([125, 250, 500, 1000]);

export function normalizeMouseControlRequest(input = {}) {
  const body = input && typeof input === "object" ? input : {};
  const pointerSpeed = Number(body.pointerSpeed);
  const pollingHz = Number(body.pollingHz);
  const dpi = Number(body.dpi);
  const acceleration = body.acceleration;
  const normalized = {};

  if (body.pointerSpeed !== undefined) {
    if (!Number.isInteger(pointerSpeed) || pointerSpeed < 1 || pointerSpeed > 20) {
      throw new Error("Pointer speed must be a whole number from 1 through 20.");
    }
    normalized.pointerSpeed = pointerSpeed;
  }
  if (body.pollingHz !== undefined) {
    if (!MOUSE_POLLING_RATES.includes(pollingHz)) {
      throw new Error("Polling rate must be 125, 250, 500, or 1000 Hz.");
    }
    normalized.pollingHz = pollingHz;
  }
  if (body.dpi !== undefined) {
    if (!Number.isInteger(dpi) || dpi < 100 || dpi > 25600 || dpi % 50 !== 0) {
      throw new Error("DPI must be from 100 through 25600 in steps of 50.");
    }
    normalized.dpi = dpi;
  }
  if (body.acceleration !== undefined) {
    if (typeof acceleration !== "boolean") {
      throw new Error("Pointer acceleration must be true or false.");
    }
    normalized.acceleration = acceleration;
  }
  if (body.liveControl !== undefined) {
    if (typeof body.liveControl !== "boolean") {
      throw new Error("Live hardware control must be true or false.");
    }
    normalized.liveControl = body.liveControl;
  }
  const settingKeys = ["pointerSpeed", "pollingHz", "dpi", "acceleration"];
  if (!settingKeys.some((key) => Object.hasOwn(normalized, key))) {
    throw new Error("Choose at least one mouse setting to apply.");
  }
  return normalized;
}

async function runMouseControl(action, settings = {}) {
  const args = ["-Action", action];
  if (settings.pointerSpeed !== undefined) args.push("-PointerSpeed", String(settings.pointerSpeed));
  if (settings.acceleration !== undefined) args.push("-Acceleration", settings.acceleration ? "1" : "0");
  if (settings.pollingHz !== undefined) args.push("-PollingHz", String(settings.pollingHz));
  if (settings.dpi !== undefined) args.push("-Dpi", String(settings.dpi));
  if (settings.liveControl !== undefined) args.push("-EnableLiveControl", settings.liveControl ? "1" : "0");
  if (settings.profileMode !== undefined) args.push("-ProfileMode", String(settings.profileMode));
  const result = await runPowerShellScript(scripts.mouseControl, args, { timeoutMs: 15000, cwd: path.dirname(scripts.mouseControl) });
  const parsed = parseJsonOutput(result.stdout, null);
  if (!result.ok || !parsed) {
    return {
      ok: false,
      message: result.stderr || result.error || "Mouse control did not return a readable result."
    };
  }
  return parsed;
}

async function mouseControlRestoreState() {
  try {
    const baseline = JSON.parse(await fs.readFile(MOUSE_CONTROL_BACKUP_PATH, "utf8"));
    return { available: true, capturedAt: baseline.capturedAt || null };
  } catch {
    return { available: false, capturedAt: null };
  }
}

async function withMouseRestoreState(result) {
  return { ...result, restore: await mouseControlRestoreState() };
}

export async function labMouseStatus() {
  return withMouseRestoreState(await runMouseControl("status"));
}

async function saveMouseControlBaseline(status) {
  try {
    await fs.access(MOUSE_CONTROL_BACKUP_PATH);
    return;
  } catch {
  }
  const baseline = {
    schema: "pc-control-plane-mouse-baseline/v1",
    capturedAt: new Date().toISOString(),
    device: status?.device || null,
    settings: {
      pointerSpeed: status?.movement?.pointerSpeed ?? 10,
      acceleration: status?.movement?.acceleration === true,
      pollingHz: status?.polling?.currentHz ?? null,
      dpi: status?.dpi?.current ?? null,
      profileMode: status?.polling?.profileMode ?? null
    }
  };
  await fs.writeFile(MOUSE_CONTROL_BACKUP_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

export async function labMouseApply(input = {}) {
  let settings;
  try {
    settings = normalizeMouseControlRequest(input);
  } catch (error) {
    return { ok: false, message: error.message };
  }
  const before = await labMouseStatus();
  if (!before.ok) return before;
  await saveMouseControlBaseline(before);
  const result = await runMouseControl("apply", settings);
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "lab.mouse-control",
    message: result.ok
      ? `Mouse tuning applied: ${(result.changes || []).join(", ")}.`
      : `Mouse tuning failed: ${result.message}`,
    details: {
      ownerInvoked: true,
      residentHelper: false,
      requested: settings,
      before: {
        pointerSpeed: before?.movement?.pointerSpeed ?? null,
        acceleration: before?.movement?.acceleration ?? null,
        pollingHz: before?.polling?.currentHz ?? null,
        dpi: before?.dpi?.current ?? null
      },
      after: result.ok ? {
        pointerSpeed: result?.movement?.pointerSpeed ?? null,
        acceleration: result?.movement?.acceleration ?? null,
        pollingHz: result?.polling?.currentHz ?? null,
        dpi: result?.dpi?.current ?? null
      } : null
    }
  });
  return withMouseRestoreState(result);
}

export async function labMouseRestore() {
  let baseline;
  try {
    baseline = JSON.parse(await fs.readFile(MOUSE_CONTROL_BACKUP_PATH, "utf8"));
  } catch {
    return { ok: false, message: "No saved mouse baseline exists yet." };
  }
  let settings;
  try {
    const saved = Object.fromEntries(
      Object.entries(baseline.settings || {}).filter(([, value]) => value !== null && value !== undefined)
    );
    const profileMode = saved.profileMode;
    delete saved.profileMode;
    settings = normalizeMouseControlRequest({ ...saved, liveControl: true });
    if (profileMode === "onboard" || profileMode === "host") settings.profileMode = profileMode;
  } catch (error) {
    return { ok: false, message: `Saved mouse baseline is invalid: ${error.message}` };
  }
  const result = await runMouseControl("apply", settings);
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "lab.mouse-control.restore",
    message: result.ok ? "Mouse tuning restored to the saved baseline." : `Mouse baseline restore failed: ${result.message}`,
    details: { ownerInvoked: true, residentHelper: false, baselineCapturedAt: baseline.capturedAt || null, restored: settings }
  });
  return withMouseRestoreState(result.ok ? { ...result, message: "Restored the saved mouse baseline." } : result);
}

export function overdriveLockStatus(state = {}, nowMs = Date.now()) {
  if (state.modeId !== "overdrive" || !state.overdriveArmedAt) {
    return { active: false, remainingSeconds: 0 };
  }
  const armedMs = Date.parse(state.overdriveArmedAt);
  if (!Number.isFinite(armedMs)) {
    return { active: false, remainingSeconds: 0 };
  }
  const remainingMs = OVERDRIVE_LOCK_MS - (nowMs - armedMs);
  if (remainingMs <= 0) {
    return { active: false, remainingSeconds: 0, armedAt: state.overdriveArmedAt };
  }
  return {
    active: true,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    armedAt: state.overdriveArmedAt,
    note: "Holds the autonomous system only — you can change mode at any time. Safety downshifts (crash, critical thermal, Strained) still override."
  };
}

async function evaluateOverdriveLock(targetModeId, options = {}) {
  const state = await readState();
  const decision = overdriveLockDecision({
    currentModeId: state.modeId,
    armedAtIso: state.overdriveArmedAt || null,
    targetModeId,
    source: options.safety ? "safety" : (options.source || "user")
  });
  if (!decision.blocked) {
    return { blocked: false };
  }
  const minutes = Math.floor(decision.remainingSeconds / 60);
  const seconds = decision.remainingSeconds % 60;
  return {
    blocked: true,
    remainingSeconds: decision.remainingSeconds,
    message: `Autonomous switch away from user-selected Overdrive declined for another ${minutes}m ${seconds}s. You can change mode yourself at any time; safety downshifts still apply.`
  };
}

export function safeAutoTarget(policy, currentModeId, automations = defaultAutomations) {
  if (automations.crashRecovery !== false && policy.crashRecovery?.nextMode) {
    return policy.crashRecovery.nextMode;
  }

  if (automations.thermalProtection !== false && policy.thermalState?.severity === "critical") {
    return currentModeId === "conservative" ? null : "conservative";
  }

  if (
    automations.failureRemediation !== false &&
    policy.failureRemediation?.safetyTargetMode &&
    policy.failureRemediation.safetyTargetMode !== currentModeId
  ) {
    return policy.failureRemediation.safetyTargetMode;
  }

  if (
    automations.crashRecovery !== false &&
    policy.failureWatchlist?.autoDownshift &&
    ["overdrive", "performance", "competitive"].includes(currentModeId)
  ) {
    return "balanced";
  }

  if (automations.thermalProtection !== false && policy.thermalState?.recommendedAction === "conservative-cooldown") {
    const foregroundPerformance = ["competitive", "performance"].includes(policy.priority?.modeHint);
    if (foregroundPerformance && ["overdrive", "performance", "competitive"].includes(currentModeId)) {
      return "balanced";
    }
    return "conservative";
  }

  if (policy.health.state === "Strained") {
    if (!automations.thermalProtection) {
      return null;
    }
    if (["overdrive", "performance", "competitive"].includes(currentModeId)) {
      return "balanced";
    }
    return null;
  }

  if (currentModeId === "overdrive") {
    return null;
  }

  const target = policy.suggestedMode;
  if (
    target &&
    target !== "overdrive" &&
    ["conservative", "balanced", "performance", "competitive", "agentic"].includes(target)
  ) {
    if (target !== currentModeId && modeStaySuppressesSwitch(target, currentModeId, policy.priority)) {
      return null;
    }
    return target;
  }
  return null;
}

const REST_MODES = new Set(["balanced", "conservative"]);
const ACTIVE_WORKLOAD_MODES = new Set(["performance", "competitive", "agentic"]);

function modeStaySuppressesSwitch(target, currentModeId, priority = {}) {
  const posture = typeof priority === "string" ? priority : priority?.posture;
  if (posture === "inactivity") {
    return false;
  }
  if (posture === "cooling" || posture === "recovery") {
    return false;
  }
  if (!REST_MODES.has(target)) {
    return false;
  }
  if (isRestModeReturnTarget({ priority, currentModeId, target })) {
    return false;
  }
  const currentCeiling = modeBandCeiling(currentModeId);
  const targetCeiling = modeBandCeiling(target);
  if (!Number.isFinite(currentCeiling) || !Number.isFinite(targetCeiling)) {
    return false;
  }
  return targetCeiling <= currentCeiling;
}

function isRestModeReturnTarget({ priority = {}, currentModeId = null, target = null } = {}) {
  if (target !== "balanced" || !ACTIVE_WORKLOAD_MODES.has(currentModeId)) {
    return false;
  }
  const modeHint = typeof priority === "string" ? null : priority?.modeHint;
  const posture = typeof priority === "string" ? priority : priority?.posture;
  if (posture === "cooling" || posture === "inactivity") {
    return false;
  }
  return modeHint === "balanced";
}

export function evaluateIdleReturnTarget({
  input = {},
  currentModeId = null,
  storedMode = null,
  policy = {}
} = {}) {
  if (!storedMode) {
    return { target: null, clear: false, overdriveBlocked: false, reason: "no idle return mode stored" };
  }
  if (input?.isExtendedIdle === true) {
    return { target: null, clear: false, overdriveBlocked: false, reason: "extended inactivity is still active" };
  }
  if (currentModeId !== "conservative") {
    return { target: null, clear: true, overdriveBlocked: false, reason: "system already left Conservative" };
  }
  const thermalAction = policy.thermalState?.recommendedAction || "none";
  const thermalSeverity = policy.thermalState?.severity || "ok";
  const thermalSafetyPressure =
    ["floor", "balanced-downshift", "conservative-cooldown"].includes(thermalAction) ||
    ["hot", "critical"].includes(thermalSeverity);
  if (
    policy.health?.state === "Strained" ||
    thermalSafetyPressure ||
    policy.priority?.posture === "cooling" ||
    policy.failureRemediation?.safetyTargetMode ||
    policy.failureWatchlist?.autoDownshift
  ) {
    return { target: null, clear: false, overdriveBlocked: false, reason: "safety or cooling pressure still owns the mode" };
  }
  if (storedMode === "overdrive") {
    return {
      target: "balanced",
      clear: true,
      overdriveBlocked: true,
      reason: "Overdrive is user-only; restoring Balanced instead"
    };
  }
  if (storedMode === "conservative") {
    return { target: null, clear: true, overdriveBlocked: false, reason: "stored mode is already Conservative" };
  }
  if (!["balanced", "performance", "competitive", "agentic"].includes(storedMode)) {
    return { target: null, clear: true, overdriveBlocked: false, reason: "stored mode is not auto-restorable" };
  }
  return { target: storedMode, clear: true, overdriveBlocked: false, reason: `input resumed; restoring ${getMode(storedMode).label}` };
}

export function sessionQualifiedTarget(interactiveDesktop, policy, currentModeId, automations, target) {
  return interactiveDesktop || isSafetyAutoTarget(policy, currentModeId, automations, target) ? target : null;
}

function isSafetyAutoTarget(policy, currentModeId, automations = defaultAutomations, target = null) {
  if (!target) {
    return false;
  }
  if (automations.crashRecovery !== false && policy.crashRecovery?.nextMode === target) {
    return true;
  }
  if (
    automations.failureRemediation !== false &&
    policy.failureRemediation?.safetyTargetMode === target
  ) {
    return true;
  }
  if (
    automations.thermalProtection !== false &&
    policy.thermalState?.severity === "critical" &&
    ["balanced", "conservative"].includes(target)
  ) {
    return true;
  }
  if (
    automations.thermalProtection !== false &&
    policy.thermalState?.recommendedAction === "conservative-cooldown" &&
    ["balanced", "conservative"].includes(target)
  ) {
    return true;
  }
  return (
    automations.thermalProtection !== false &&
    policy.health.state === "Strained" &&
    ["overdrive", "performance", "competitive"].includes(currentModeId) &&
    target === "balanced"
  );
}

export function evaluateModeSwitchStability(previous = {}, {
  target = null,
  currentModeId = null,
  isSafety = false,
  nowMs = Date.now(),
  dwellMs = MODE_SWITCH_STABILITY_DWELL_MS,
  minConfirmations = MODE_SWITCH_STABILITY_CONFIRMATIONS
} = {}) {
  if (!target || target === currentModeId) {
    return { allow: false, reason: "no mode change needed", pending: null };
  }
  if (isSafety) {
    return { allow: true, reason: "safety target bypasses stability dwell", pending: null };
  }
  const priorTarget = previous?.target || null;
  const priorSince = Date.parse(previous?.since || "");
  const startedAtMs = priorTarget === target && Number.isFinite(priorSince) ? priorSince : nowMs;
  const confirmations = priorTarget === target ? Math.max(1, Number(previous?.confirmations || 0)) + 1 : 1;
  const pending = {
    target,
    since: new Date(startedAtMs).toISOString(),
    confirmations
  };
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const dwellComplete = elapsedMs >= Math.max(0, Number(dwellMs) || 0);
  const confirmationsComplete = confirmations >= Math.max(1, Number(minConfirmations) || 1);
  if (dwellComplete && confirmationsComplete) {
    return {
      allow: true,
      reason: "target remained stable",
      pending,
      elapsedMs,
      confirmations
    };
  }
  const waitReason = !dwellComplete
    ? `waiting ${formatDurationSummary(Math.max(0, (Number(dwellMs) || 0) - elapsedMs)) || "briefly"} for a stable target`
    : `waiting for ${Math.max(0, (Number(minConfirmations) || 1) - confirmations)} more confirmation(s)`;
  return {
    allow: false,
    reason: waitReason,
    pending,
    elapsedMs,
    confirmations
  };
}

export function modeSwitchStabilityConfig({
  policy = {},
  currentModeId = null,
  target = null,
  isSafety = false
} = {}) {
  const restReturn = !isSafety && isRestModeReturnTarget({
    priority: policy.priority,
    currentModeId,
    target
  });
  return {
    restReturn,
    dwellMs: restReturn ? REST_MODE_RETURN_DWELL_MS : MODE_SWITCH_STABILITY_DWELL_MS,
    minConfirmations: restReturn ? REST_MODE_RETURN_CONFIRMATIONS : MODE_SWITCH_STABILITY_CONFIRMATIONS
  };
}

function isCrashOrFailureTarget(policy, currentModeId, automations = defaultAutomations, target = null) {
  if (!target) {
    return false;
  }
  if (automations.crashRecovery !== false && policy.crashRecovery?.nextMode === target) {
    return true;
  }
  if (automations.failureRemediation !== false && policy.failureRemediation?.safetyTargetMode === target) {
    return true;
  }
  return (
    automations.crashRecovery !== false &&
    policy.failureWatchlist?.autoDownshift &&
    ["overdrive", "performance", "competitive"].includes(currentModeId) &&
    target === "balanced"
  );
}

const GAMING_CRITICAL_SUSTAINED_TICKS = 3;

export function evaluateCompetitiveModeAuthority({
  currentModeId = null,
  target = null,
  telemetry = {},
  policy = {},
  automations = defaultAutomations,
  criticalStreak = 0,
  resolvedPlan = null
} = {}) {
  const priorityConfirmsGame = policy?.priority?.modeHint === "competitive";
  const identifiedForegroundGame = Boolean(
    policy?.priority?.game ||
    telemetry?.game?.confirmed?.foreground === true
  );
  const activeGame =
    priorityConfirmsGame ||
    identifiedForegroundGame ||
    isCompetitiveGamingSession(currentModeId, telemetry);

  if (!activeGame) {
    return { target, activeGame: false, held: false, recovering: false, reason: "no active competitive game" };
  }

  const crashOrFailurePressure =
    isCrashOrFailureTarget(policy, currentModeId, automations, target) ||
    (automations.crashRecovery !== false && Boolean(policy?.crashRecovery?.nextMode)) ||
    (automations.failureRemediation !== false && Boolean(policy?.failureRemediation?.safetyTargetMode)) ||
    (automations.crashRecovery !== false && Boolean(policy?.failureWatchlist?.autoDownshift));
  if (crashOrFailurePressure) {
    return {
      target,
      activeGame: true,
      held: false,
      recovering: false,
      safetyRelease: true,
      reason: "correlated crash or failure remediation owns the mode"
    };
  }

  const critical = automations.thermalProtection !== false && policy?.thermalState?.severity === "critical";
  if (critical) {
    if (currentModeId !== "competitive") {
      return { target, activeGame: true, held: false, recovering: false, reason: "critical heat blocks Competitive recovery" };
    }
    const sustained = Number(criticalStreak) >= GAMING_CRITICAL_SUSTAINED_TICKS;
    const floor = MODE_BANDS.competitive.floor;
    const planAvailable = resolvedPlan?.modeId === "competitive" && Number.isFinite(Number(resolvedPlan?.tier));
    const bandAtFloor = !planAvailable || Number(resolvedPlan.tier) <= floor;
    if (sustained && bandAtFloor) {
      return {
        target,
        activeGame: true,
        held: false,
        recovering: false,
        safetyRelease: true,
        reason: "critical heat persisted at the Competitive cooling floor"
      };
    }
    return {
      target: null,
      activeGame: true,
      held: Boolean(target && target !== currentModeId),
      recovering: false,
      reason: sustained
        ? "critical heat is confirmed; waiting for the Competitive band to reach its cooling floor"
        : `confirming critical heat (${Math.max(0, Number(criticalStreak) || 0)}/${GAMING_CRITICAL_SUSTAINED_TICKS}) while the Competitive band cools first`
    };
  }

  if (currentModeId === "competitive") {
    return {
      target: target && target !== currentModeId ? null : target,
      activeGame: true,
      held: Boolean(target && target !== currentModeId),
      recovering: false,
      reason: "active game owns Competitive; ordinary pressure stays inside its power band"
    };
  }

  if (priorityConfirmsGame || identifiedForegroundGame) {
    return {
      target: "competitive",
      activeGame: true,
      held: false,
      recovering: currentModeId !== "competitive",
      reason: "confirmed active game restores Competitive through the normal stability gate"
    };
  }

  return { target, activeGame: true, held: false, recovering: false, reason: "game context is not strong enough to restore Competitive" };
}

export async function createDryRunPlan(modeId = null) {
  const state = await readState();
  const requestedModeId = modeId || state.modeId;
  holdManualTransition(requestedModeId, "dry-run");
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  const ledger = await readLedger(60);
  const plan = planPolicy({
    telemetry,
    modeId: requestedModeId,
    state,
    history: { priorPlans: ledger.filter((entry) => entry.action === "plan.created").length },
    config: {
      ignoreModeCooldown: true,
      learning: effectiveLearningForDecisions(state, await learningStore.summary())
    },
    correlationId: createCorrelationId("dryrun")
  });
  const persisted = await persistPlan(plan);
  await appendLedgerEvent({
    correlationId: plan.correlationId,
    action: "plan.created",
    status: plan.ok ? "planned" : "refused",
    adapterId: "state-store",
    adapterVersion: "2.0.0",
    message: `Created dry-run plan for ${plan.targetMode.label}.`,
    details: planSummaryForAudit(plan)
  });
  await appendAudit({
    level: plan.ok ? "info" : "warn",
    action: "plan.dry-run",
    dryRun: true,
    message: `Dry-run plan created for ${plan.targetMode.label}.`,
    details: planSummaryForAudit(plan)
  });
  return {
    ok: true,
    plan: persisted
  };
}

export async function applyPlannedActions(correlationId) {
  const plan = await readPlan(correlationId);
  if (!plan) {
    return { ok: false, message: `No persisted plan found for ${correlationId}.` };
  }
  holdManualTransition(plan.targetMode?.id, "plan-apply");
  const ageMs = planAgeMs(plan);
  if (ageMs > PLAN_APPLY_MAX_AGE_MS) {
    const message = "Dry-run plan expired. Create a fresh plan before applying.";
    await appendLedgerEvent({
      correlationId: plan.correlationId,
      action: "plan.apply",
      status: "refused",
      adapterId: "state-store",
      adapterVersion: "2.0.0",
      message,
      details: {
        planAgeMs: ageMs,
        maxAgeMs: PLAN_APPLY_MAX_AGE_MS,
        createdAt: plan.createdAt || null
      }
    });
    return {
      ok: false,
      plan,
      expired: true,
      planAgeMs: ageMs,
      maxAgeMs: PLAN_APPLY_MAX_AGE_MS,
      message
    };
  }
  if (plan.refusalReasons?.length) {
    await appendLedgerEvent({
      correlationId: plan.correlationId,
      action: "plan.apply",
      status: "refused",
      adapterId: "state-store",
      adapterVersion: "2.0.0",
      message: "Plan application refused because the dry-run contains refusal reasons.",
      details: { refusalReasons: plan.refusalReasons }
    });
    return {
      ok: false,
      plan,
      message: "Plan has refusal reasons. Re-run dry run after resolving them."
    };
  }

  const state = await readState();
  const telemetry = await captureTelemetry({ maxAgeMs: 30000 });
  const drift = detectDrift({ state, telemetry, plan });
  if (drift.length) {
    await appendLedgerEvent({
      correlationId: plan.correlationId,
      action: "plan.apply",
      status: "refused",
      adapterId: "state-store",
      adapterVersion: "2.0.0",
      message: "Plan application refused because state drifted after planning.",
      details: { drift }
    });
    return {
      ok: false,
      plan,
      drift,
      message: "State drifted after dry run. Create a fresh plan before applying."
    };
  }

  const actionsToRun = executableActions(plan);
  if (actionsToRun.length === 0) {
    const advisoryActionCount = (plan.plannedActions || []).length;
    const message = "No executable changes in this plan; advisory items remain for review.";
    await appendLedgerEvent({
      correlationId: plan.correlationId,
      action: "plan.apply",
      status: "skipped",
      adapterId: "state-store",
      adapterVersion: "2.0.0",
      message,
      details: { advisoryActionCount }
    });
    await appendAudit({
      level: "info",
      action: "plan.apply.noop",
      dryRun: false,
      message,
      details: { correlationId: plan.correlationId, advisoryActionCount }
    });
    return {
      ok: true,
      plan,
      snapshot: null,
      results: [],
      applied: false,
      noop: true,
      message
    };
  }

  const snapshot = await createSnapshot({
    reason: "Before applying planned V2 action chain.",
    correlationId: plan.correlationId,
    state,
    telemetry,
    plan
  });
  await appendLedgerEvent({
    correlationId: plan.correlationId,
    action: "plan.apply",
    status: "started",
    adapterId: "state-store",
    adapterVersion: "2.0.0",
    message: "Started planned action chain.",
    details: { snapshot: snapshot.filePath, actionCount: actionsToRun.length }
  });

  const results = [];
  for (const action of actionsToRun) {
    await appendLedgerEvent({
      correlationId: plan.correlationId,
      action: action.id,
      status: "started",
      adapterId: action.adapterId,
      adapterVersion: action.adapterVersion,
      message: action.label
    });
    let result = { ok: true, message: "No-op." };
    if (action.type === "state.setMode") {
      const current = await readState();
      await writeState({
        ...current,
        modeId: plan.targetMode.id,
        lastAppliedAt: new Date().toISOString(),
        lastAction: `Applied V2 plan ${plan.correlationId}.`,
        lastPlanCorrelationId: plan.correlationId
      });
      result = { ok: true, message: `State mode set to ${plan.targetMode.label}.` };
    } else if (action.type === "power.setPlan") {
      result = await setPowerPlanByName(action.desired, false);
    } else if (action.type === "session.applyPrep") {
      result = await applyPriorityAppConfig(false);
    }
    results.push({ actionId: action.id, result });
    await appendLedgerEvent({
      correlationId: plan.correlationId,
      action: action.id,
      status: result.ok ? "completed" : "failed",
      adapterId: action.adapterId,
      adapterVersion: action.adapterVersion,
      message: result.message || action.label,
      details: { result }
    });
    if (!result.ok) {
      break;
    }
  }

  const ok = results.every((entry) => entry.result?.ok);
  await appendLedgerEvent({
    correlationId: plan.correlationId,
    action: "plan.apply",
    status: ok ? "completed" : "failed",
    adapterId: "state-store",
    adapterVersion: "2.0.0",
    message: ok ? "Planned action chain completed." : "Planned action chain failed.",
    details: { results }
  });
  await appendAudit({
    level: ok ? "action" : "warn",
    action: "plan.apply",
    dryRun: false,
    message: ok ? `Applied V2 plan ${plan.correlationId}.` : `V2 plan ${plan.correlationId} failed.`,
    details: { results, snapshot: snapshot.filePath }
  });

  return {
    ok,
    plan,
    snapshot,
    results,
    message: ok ? "Applied planned action chain." : "Plan failed before completion."
  };
}

export async function panicRestore(dryRun = true) {
  const correlationId = createCorrelationId("panic");
  const actions = [
    {
      id: "power.restore-balanced",
      label: "Restore Balanced power plan",
      adapterId: "power-plan",
      desired: "03 - Balanced Mode (Daily Driver)"
    },
    {
      id: "session.restore-apps",
      label: "Restore session apps",
      adapterId: "health-session",
      desired: "Restore session-scoped state"
    },
    {
      id: "state.restore-balanced",
      label: "Return control-plane mode to Balanced",
      adapterId: "state-store",
      desired: "balanced"
    }
  ];
  if (dryRun) {
    return {
      ok: true,
      dryRun,
      correlationId,
      actions,
      message: "Would restore Balanced mode, restore session apps, and record recovery."
    };
  }

  const state = await readState();
  const telemetry = await captureTelemetry();
  const snapshot = await createSnapshot({
    reason: "Before panic restore.",
    correlationId,
    state,
    telemetry,
    plan: { targetMode: { id: "balanced", label: "Balanced" }, risk: "low", plannedActions: actions }
  });
  await appendLedgerEvent({
    correlationId,
    action: "restore.panic",
    status: "started",
    adapterId: "state-store",
    adapterVersion: "2.0.0",
    message: "Started panic restore.",
    details: { snapshot: snapshot.filePath }
  });

  const powerResult = await setPowerPlanByName("03 - Balanced Mode (Daily Driver)", false);
  const restoreResult = await restoreSessionApps(false);
  const priorState = await readState();
  await writeState({
    ...priorState,
    modeId: "balanced",
    automations: { ...(priorState.automations || {}), mlExecution: false },
    lastAppliedAt: new Date().toISOString(),
    lastAction: "Panic restore returned PC Control Plane to Balanced and disabled the autonomous executor."
  });
  observerState.mlExecution = { schema: "pc-control-plane-ml-executor/v1", active: false, status: "disabled", suppressRamRelief: false, suppressCpuRelief: false };
  const ok = Boolean(powerResult.ok && restoreResult.ok);
  await appendLedgerEvent({
    correlationId,
    action: "restore.panic",
    status: ok ? "restored" : "failed",
    adapterId: "state-store",
    adapterVersion: "2.0.0",
    message: ok ? "Panic restore completed." : "Panic restore had failures.",
    details: { powerResult, restoreResult }
  });
  await appendAudit({
    level: ok ? "action" : "warn",
    action: "restore.panic",
    dryRun: false,
    message: ok ? "Panic restore completed." : "Panic restore had failures.",
    details: { powerResult, restoreResult, snapshot: snapshot.filePath }
  });
  return {
    ok,
    dryRun,
    correlationId,
    snapshot,
    powerResult,
    restoreResult,
    message: ok ? "Panic restore completed." : "Panic restore had failures."
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runStressInvestigation(seconds = 60) {
  const durationSeconds = Math.max(1, Math.min(60, Number(seconds) || 60));
  const samples = [];
  const startedAt = Date.now();
  const sampleCount = durationSeconds <= 2 ? 1 : Math.min(5, Math.ceil(durationSeconds / 12));
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await captureTelemetry({ force: true }));
    const elapsed = (Date.now() - startedAt) / 1000;
    if (index < sampleCount - 1 && elapsed < durationSeconds) {
      await sleep(Math.min(12000, Math.max(1000, ((durationSeconds - elapsed) / (sampleCount - index - 1)) * 1000)));
    }
  }
  const latest = samples[samples.length - 1] || {};
  const state = await readState();
  const learning = await learningStore.summary();
  const policy = evaluatePolicy(latest, stateWithLearningInfluence(state, learning));
  const topProcesses = new Map();
  for (const sample of samples) {
    for (const process of sample.processes || []) {
      const key = `${process.name}:${process.pid}`;
      const existing = topProcesses.get(key) || {
        name: process.name,
        pid: process.pid,
        maxWorkingSetMB: 0,
        maxCpuSeconds: 0
      };
      existing.maxWorkingSetMB = Math.max(existing.maxWorkingSetMB, Number(process.workingSetMB) || 0);
      existing.maxCpuSeconds = Math.max(existing.maxCpuSeconds, Number(process.cpuSeconds) || 0);
      topProcesses.set(key, existing);
    }
  }
  const report = {
    ok: true,
    schema: "pc-control-plane-stress-investigation/v2",
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds,
    sampleCount: samples.length,
    health: policy.health,
    priority: policy.priority,
    likelyCulprits: [...topProcesses.values()]
      .sort((a, b) => b.maxWorkingSetMB - a.maxWorkingSetMB || b.maxCpuSeconds - a.maxCpuSeconds)
      .slice(0, 12),
    powerPlan: currentPowerPlanName(latest),
    gpu: latest.gpu || null,
    crashSignals: policy.eventAnalysis.crashSignals,
    hardwareSignals: policy.eventAnalysis.hardwareSignals,
    failureWatchlist: policy.failureWatchlist,
    fastPatchPlan: policy.fastPatchPlan,
    hardenedPatchPlan: policy.hardenedPatchPlan,
    dcomNoiseCount: policy.eventAnalysis.lowPriority.filter((event) => Number(event.id) === 10016).length
  };
  await appendLedgerEvent({
    correlationId: createCorrelationId("stress"),
    action: "diagnostics.stress-investigation",
    status: "completed",
    adapterId: "event-log",
    adapterVersion: "2.0.0",
    message: `Completed ${durationSeconds}s stress investigation.`,
    details: {
      health: report.health.state,
      priority: report.priority.label,
      sampleCount: report.sampleCount
    }
  });
  return report;
}

export async function armDiagnostics(options = {}) {
  const result = await armDiagnosticTraps(options);
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "diagnostics.traps.arm",
    dryRun: Boolean(options.dryRun),
    message: result.message,
    details: {
      status: result.status,
      registryBaseline: result.registryBaseline || null
    }
  });
  await appendLedgerEvent({
    correlationId: result.state?.id || createCorrelationId("diag"),
    action: "diagnostics.traps.arm",
    status: result.ok ? (options.dryRun ? "planned" : "completed") : "failed",
    adapterId: "diagnostic-traps",
    adapterVersion: "2.0.0",
    message: result.message,
    details: { status: result.status }
  });
  return result;
}

export async function disarmDiagnostics(options = {}) {
  const result = await disarmDiagnosticTraps(options);
  await appendAudit({
    level: result.ok ? "action" : "warn",
    action: "diagnostics.traps.disarm",
    dryRun: Boolean(options.dryRun),
    message: result.message,
    details: {
      status: result.status,
      restoreResult: result.restoreResult || null
    }
  });
  await appendLedgerEvent({
    correlationId: result.state?.id || createCorrelationId("diag"),
    action: "diagnostics.traps.disarm",
    status: result.ok ? (options.dryRun ? "planned" : "completed") : "failed",
    adapterId: "diagnostic-traps",
    adapterVersion: "2.0.0",
    message: result.message,
    details: { status: result.status, restoreResult: result.restoreResult || null }
  });
  return result;
}

export async function getPriorityAppSessionHistory() {
  return {
    ok: true,
    sessions: await readPriorityAppSessions(5)
  };
}

export async function setAutonomy(autonomy, pinned = null) {
  const allowed = new Set(["manual-first", "advisory", "auto-safe"]);
  if (!allowed.has(autonomy)) {
    return { ok: false, message: `Unsupported autonomy mode: ${autonomy}` };
  }
  const state = await readState();
  if (autonomy !== "auto-safe" || pinned === true) {
    const next = await writeState({
      ...state,
      lastAction: "Autonomy is managed full-time and remains auto-safe."
    });
    await appendAudit({
      level: "info",
      action: "autonomy.locked",
      message: "Autonomy is full-time and remains auto-safe.",
      details: { requested: autonomy, requestedPinned: pinned, enforcedPinned: false }
    });
    return { ok: true, state: next, message: "Autonomy is managed full-time and remains auto-safe." };
  }
  const next = await writeState({
    ...state,
    lastAction: "Autonomy is managed full-time and remains auto-safe."
  });
  await appendAudit({
    level: "action",
    action: "autonomy.set",
    message: "Autonomy remains auto-safe.",
    details: { pinned: next.pinned }
  });
  return { ok: true, state: next, message: "Autonomy is auto-safe." };
}

const FAILURE_TRAP_RETRY_MS = 10 * 60 * 1000;

function failureAutonomySignature(policy = {}) {
  const routes = policy.failureRemediation?.routes || [];
  if (!routes.length) {
    return "clear";
  }
  return routes
    .map((route) => `${route.profileId}:${route.recent ? "live" : "doc"}:${route.handler}`)
    .join("|");
}

function proactivePreventionSignature(policy = {}) {
  const guards = policy.failureProactivePrevention?.activeGuards || [];
  if (!guards.length) {
    return "clear";
  }
  return guards
    .map((guard) => `${guard.id}:${guard.state}`)
    .sort()
    .join("|");
}

function displayDriverContainmentRoute(remediation = {}) {
  const routes = Array.isArray(remediation.routes) ? remediation.routes : [];
  return routes.find((route) => route.profileId === "nvidia-driver-reset" && route.recent) || null;
}

function displayDriverContainmentSignature(remediation = {}) {
  const route = displayDriverContainmentRoute(remediation);
  if (!route) {
    return "clear";
  }
  return [
    route.profileId,
    route.action,
    route.handler,
    remediation.safetyTargetMode || "no-mode-target",
    remediation.evidenceFallback?.active ? `fallback:${(remediation.evidenceFallback.sources || []).join(",")}` : "live-telemetry"
  ].join("|");
}

async function maybeAutonomousFailureHandling({ state, policy, learning }) {
  if (state?.autonomy !== "auto-safe") {
    return;
  }
  if (
    state?.automations?.failureProactivePrevention === false &&
    state?.automations?.failureRemediation === false &&
    state?.automations?.failurePrevention === false
  ) {
    return;
  }
  const proactive = policy?.failureProactivePrevention || {};
  const remediation = policy?.failureRemediation || {};
  const prevention = policy?.failurePrevention || {};
  const proactiveSignature = proactivePreventionSignature(policy);
  if (
    state?.automations?.failureProactivePrevention !== false &&
    proactiveSignature !== "clear" &&
    observerState.lastFailureProactiveSignature !== proactiveSignature
  ) {
    observerState.lastFailureProactiveSignature = proactiveSignature;
    await appendAudit({
      level: "info",
      action: "failure.proactive-prevention.autonomous",
      message: `Proactive prevention is active: ${proactive.summary || "known-issue hygiene guards are watching."}`,
      details: {
        proactive,
        learning: {
          enabled: learningInfluenceEnabled(state),
          guardrails: learning?.guardrails || []
        }
      }
    });
  }
  if (proactiveSignature === "clear") {
    if (observerState.lastFailureProactiveSignature && observerState.lastFailureProactiveSignature !== "clear") {
      await appendAudit({
        level: "info",
        action: "failure.proactive-prevention.autonomous",
        message: "Proactive prevention guards cleared; known-issue hygiene remains on standby.",
        details: {
          proactive,
          clearedSignature: observerState.lastFailureProactiveSignature
        }
      });
    }
    observerState.lastFailureProactiveSignature = "clear";
  }

  const signature = failureAutonomySignature(policy);
  if (signature !== "clear" && observerState.lastFailureAutonomySignature !== signature) {
    observerState.lastFailureAutonomySignature = signature;
    await appendAudit({
      level: "action",
      action: "failure.remediation.autonomous",
      message: `Failure Watch is fully autonomous: ${remediation.summary || "all signatures routed."}`,
      details: {
        remediation,
        prevention,
        learning: {
          enabled: learningInfluenceEnabled(state),
          guardrails: learning?.guardrails || []
        }
      }
    });
  }
  if (signature === "clear") {
    observerState.lastFailureAutonomySignature = "clear";
    observerState.lastDriverContainmentAuditSignature = "clear";
    return;
  }

  const driverContainmentSignature = displayDriverContainmentSignature(remediation);
  if (
    driverContainmentSignature !== "clear" &&
    observerState.lastDriverContainmentAuditSignature !== driverContainmentSignature
  ) {
    observerState.lastDriverContainmentAuditSignature = driverContainmentSignature;
    const route = displayDriverContainmentRoute(remediation);
    await appendAudit({
      level: "action",
      action: "failure.remediation.driver-containment",
      message: "GPU driver reset/watchdog issue visible: kept the failure signature visible, preserved evidence, and routed only safe power/mode containment.",
      details: {
        route,
        remediationStatus: remediation.status,
        safetyTargetMode: remediation.safetyTargetMode || null,
        evidenceFallback: remediation.evidenceFallback || null,
        safeActions: [
          "power plan/mode downshift through existing safe handlers",
          "diagnostic capture/traps",
          "overlay and cache warning",
          "learn and prevent recurrence"
        ],
        boundaries: [
          "no driver install/uninstall",
          "no BIOS or firmware changes",
          "no voltage or fan mutation",
          "no process kill/suspend"
        ]
      }
    });
  } else if (driverContainmentSignature === "clear") {
    observerState.lastDriverContainmentAuditSignature = "clear";
  }

  const now = Date.now();
  const lastAttempt = observerState.lastFailureTrapAttemptAt
    ? Date.parse(observerState.lastFailureTrapAttemptAt)
    : 0;
  if (
    remediation.shouldArmDiagnosticTraps &&
    (!Number.isFinite(lastAttempt) || now - lastAttempt >= FAILURE_TRAP_RETRY_MS)
  ) {
    const status = await getDiagnosticTrapStatus();
    if (!status.active) {
      observerState.lastFailureTrapAttemptAt = new Date(now).toISOString();
      const result = await armDiagnosticTraps({ minutes: 60, dumpType: 1, dumpCount: 3 });
      await appendAudit({
        level: result.ok ? "action" : "warn",
        action: "failure.remediation.traps",
        message: result.ok
          ? "Autonomous failure remediation armed reversible diagnostic traps for live failure evidence."
          : `Autonomous failure remediation could not arm diagnostic traps: ${result.message}`,
        details: {
          remediationStatus: remediation.status,
          liveCount: remediation.liveCount || 0,
          result
        }
      });
    }
  }
}

function hasLearnedReliefRoute(policy = {}) {
  return (policy.failureRemediation?.routes || [])
    .some((route) => route.profileId === "memory-cpu-pressure" && route.handler === "learned-relief");
}

async function auditLearnedReliefGate({ state, policy, telemetry, ramGate, cpuGate, cpuEligibility, ran }) {
  if (ran || !hasLearnedReliefRoute(policy)) {
    if (!hasLearnedReliefRoute(policy)) {
      observerState.lastReliefGateSignature = "clear";
    }
    return;
  }
  const signature = [
    `mem:${state?.automations?.memoryRelief === false ? "disabled" : ramGate?.reason || "unknown"}`,
    `cpu:${state?.automations?.cpuRelief === false ? "disabled" : cpuGate?.reason || "unknown"}`,
    `elig:${cpuEligibility?.reason || "unknown"}`,
    `streak:${observerState.cpuPressureStreak || 0}`
  ].join("|");
  if (observerState.lastReliefGateSignature === signature) {
    return;
  }
  observerState.lastReliefGateSignature = signature;
  await appendAudit({
    level: "info",
    action: "failure.remediation.relief-gate",
    message: `Learned relief did not run: RAM ${ramGate?.reason || "unknown"}; CPU ${cpuGate?.reason || "unknown"} / ${cpuEligibility?.reason || "unknown"}.`,
    details: {
      memoryCpuPressure: true,
      ramGate,
      cpuGate,
      cpuEligibility,
      cpuPressureStreak: observerState.cpuPressureStreak || 0,
      cpuLoadPct: telemetry?.system?.cpuLoadPct ?? null,
      ramUsedPct: telemetry?.system?.ramUsedPct ?? null,
      thermalSeverity: policy?.thermalState?.severity || "ok"
    }
  });
}

const RELIEF_GAMING_RAM_EMERGENCY_PCT = 95;

async function maybeAutonomousRelief({ state, telemetry, policy }) {
  const automations = state?.automations || {};
  const now = Date.now();
  const influence = learningInfluenceEnabled(state);
  const gamingActive = isCompetitiveGamingSession(state?.modeId, telemetry);
  const priorityAppRunning = Boolean(telemetry?.priorityApp?.running);
  const ramUsedPct = effectiveRamUsedPct(telemetry?.system);
  const cpuLoadPct = Number(telemetry?.system?.cpuLoadPct);
  const thermalSeverity = policy?.thermalState?.severity || "ok";
  const store = await readReliefStore();
  let ramGate = Number.isFinite(ramUsedPct)
    ? null
    : { allowed: false, reason: "RAM pressure unavailable" };
  let cpuGate = Number.isFinite(cpuLoadPct)
    ? null
    : { allowed: false, reason: "CPU pressure unavailable" };
  let cpuEligibility = null;
  let ramRan = false;
  let cpuRan = false;

  const ramGamingDeferred = gamingActive && Number.isFinite(ramUsedPct) && ramUsedPct < RELIEF_GAMING_RAM_EMERGENCY_PCT;
  const ramPreventionHold = observerState.mlExecution?.suppressRamRelief === true;
  if (automations.memoryRelief !== false && Number.isFinite(ramUsedPct) && !ramGamingDeferred && !ramPreventionHold) {
    ramGate = evaluateReliefGate(store, "ram", {
      now, pressure: ramUsedPct, lastRunAt: observerState.lastMemoryReleaseAt, influence
    });
    if (ramGate.allowed) {
      observerState.lastMemoryReleaseAt = new Date(now).toISOString();
      const attribution = attributeResourcePressure({
        processes: telemetry?.processes || [],
        isProtected: (name) => isProtectedProcess(name)
      });
      const culprit = attribution.culprit;
      if (culprit && (culprit.kind === "leak-like" || culprit.kind === "duplicate-runaway")) {
        const sig = `${culprit.name}:${culprit.committedMB}`;
        if (observerState.lastMemoryCulpritAudit !== sig) {
          observerState.lastMemoryCulpritAudit = sig;
          await appendAudit({
            level: "info",
            action: "memory.attribution",
            message: `RAM pressure at ${Math.round(ramUsedPct)}% traced to ${culprit.name} (${culprit.kind === "duplicate-runaway" ? culprit.count + " copies" : "leak-like"}, ~${culprit.committedMB} MB). ${culprit.advice} Skipping a working-set trim because it cannot reclaim this.`,
            details: { ramUsedPct, culprit }
          });
        }
      } else {
        const res = await releaseMemory({ dryRun: false });
        ramRan = true;
        const freedMB = Number(res?.freedMB) || 0;
        await writeReliefStore(recordReliefSample(store, "ram", { metric: freedMB, at: observerState.lastMemoryReleaseAt }));
        await appendAudit({
          level: "observe",
          action: "memory.release.auto",
          message: `Autonomous RAM relief at ${Math.round(ramUsedPct)}% used: freed ${freedMB} MB${freedMB >= RELIEF_TUNING.ram.effectiveFreedMB ? "" : " (little reclaimable — likely committed/leaked memory, not a working-set issue)"}.`,
          details: { ramUsedPct, freedMB, trimmed: res?.trimmed ?? 0 }
        });
      }
    } else if (ramGate.reason === "learned-ineffective backoff" && observerState.lastMemoryBackoffAudit !== ramGate.backoffUntil) {
      observerState.lastMemoryBackoffAudit = ramGate.backoffUntil;
      await appendAudit({
        level: "info",
        action: "memory.release.backoff",
        message: "Autonomous RAM relief paused: recent trims freed little, so the pressure is committed/leaked memory a trim cannot reclaim (restart the offending process instead).",
        details: { backoffUntil: ramGate.backoffUntil || null }
      });
    }
  }

  observerState.cpuPressureStreak = Number.isFinite(cpuLoadPct)
    ? nextSustainedPressureStreak(observerState.cpuPressureStreak, cpuLoadPct)
    : 0;

  const lastResolved = getLastResolvedPlan();
  const powerAtFloor = lastResolved &&
    Number.isFinite(lastResolved.tier) && Number.isFinite(lastResolved.floor) &&
    lastResolved.tier <= lastResolved.floor;
  if (observerState.mlExecution?.suppressCpuRelief === true) {
    cpuEligibility = { eligible: false, reason: "executor prevention hold: CPU relief recently worsened outcomes" };
  } else if (gamingActive && thermalSeverity !== "hot" && thermalSeverity !== "critical") {
    cpuEligibility = { eligible: false, reason: "gaming supremacy: CPU relief deferred (no thermal emergency)" };
  } else {
    cpuEligibility = evaluateCpuReliefEligibility({
      cpuLoadPct: Number.isFinite(cpuLoadPct) ? cpuLoadPct : 0,
      thermalSeverity,
      powerAtFloor,
      pressureStreak: observerState.cpuPressureStreak,
      inFlight: observerState.cpuReliefInFlight
    });
  }
  if (automations.cpuRelief !== false && Number.isFinite(cpuLoadPct)) {
    cpuGate = evaluateReliefGate(store, "cpu", {
      now, pressure: cpuLoadPct, lastRunAt: observerState.lastCpuReliefAt, influence
    });
  }
  if (
    automations.cpuRelief !== false &&
    Number.isFinite(cpuLoadPct) &&
    cpuGate?.allowed &&
    cpuEligibility.eligible &&
    !observerState.cpuReliefInFlight &&
    !cpuPulseRunning
  ) {
    observerState.lastCpuReliefAt = new Date(now).toISOString();
    observerState.cpuReliefInFlight = true;
    cpuRan = true;
    trackObserverTask(relieveCpu({ dryRun: false })
      .then(async (res) => {
        if (!res?.ok || !res.applied || !Number.isFinite(res.beforeLoad) || res.beforeLoad < 0 ||
            !Number.isFinite(res.duringLoad) || res.duringLoad < 0) return;
        const easedPct = Number(res?.easedPct) || 0;
        await writeReliefStore(recordReliefSample(await readReliefStore(), "cpu", { metric: easedPct, at: observerState.lastCpuReliefAt }));
        await appendAudit({
          level: "observe",
          action: "cpu.relief.auto",
          message: `Autonomous CPU relief: ${cpuEligibility.reason} at ${Math.round(cpuLoadPct)}% CPU; soft cap eased load by ${easedPct} pts.`,
          details: {
            cpuLoadPct,
            thermalSeverity,
            powerAtFloor: Boolean(powerAtFloor),
            pressureStreak: observerState.cpuPressureStreak,
            eligibility: cpuEligibility,
            easedPct
          }
        });
      })
      .catch(() => {})
      .finally(() => { observerState.cpuReliefInFlight = false; }));
  }

  const networkPressure = networkDiagnosisPressure(policy?.networkHealth || {});
  if (
    automations.networkDiagnosis !== false &&
    observerState.mlExecution?.suppressNetworkDiagnosis !== true &&
    networkPressure >= RELIEF_TUNING.network.pressurePct &&
    (!priorityAppRunning || networkPressure >= 90)
  ) {
    const networkGate = evaluateReliefGate(await readReliefStore(), "network", {
      now,
      pressure: networkPressure,
      lastRunAt: observerState.lastNetworkDiagnosisAt,
      influence
    });
    if (networkGate.allowed) {
      await runNetworkDiagnosis({ dryRun: false, autonomous: true });
    }
  }

  const gpuSignals = gpuReliefSignals(telemetry, policy);
  const gpuBand2Gate = competitiveBand2GpuReliefGate(state, telemetry);
  if (
    automations.gpuRelief !== false &&
    observerState.mlExecution?.suppressGpuRelief !== true &&
    gpuSignals.pressurePct >= RELIEF_TUNING.gpu.pressurePct &&
    !activeFutureIso(observerState.gpuReliefHoldUntil) &&
    gpuBand2Gate.allowed
  ) {
    const gpuGate = evaluateReliefGate(await readReliefStore(), "gpu", {
      now,
      pressure: gpuSignals.pressurePct,
      lastRunAt: observerState.lastGpuReliefAt,
      influence
    });
    if (gpuGate.allowed) {
      await relieveGpu({ dryRun: false, autonomous: true });
    }
  }

  await auditLearnedReliefGate({
    state,
    policy,
    telemetry,
    ramGate,
    cpuGate,
    cpuEligibility,
    ran: ramRan || cpuRan
  });
}

export function startObserverLoop(intervalMs = Number(process.env.PC_CONTROL_OBSERVER_INTERVAL_MS) || 10000,
  { interactiveDesktop = true } = {}) {
  if (observerState.running) {
    return observerState;
  }
  observerState.running = true;

  async function tick() {
    if (observerState.tickInFlight) {
      observerState.skippedOverlappingTicks += 1;
      return;
    }
    observerState.tickInFlight = true;
    try {
      const state = await readState();
      const captured = overlayLiveCore(await captureTelemetry());
      const telemetry = interactiveDesktop ? captured : { ...captured, input: null };
      if (interactiveDesktop) trackObserverTask(tickDesktopComfort(telemetry));
      if (activeFutureIso(observerState.gpuReliefHoldUntil)) {
        telemetry.gpuReliefActive = true;
      } else if (observerState.gpuReliefHoldUntil) {
        observerState.gpuReliefHoldUntil = null;
      }
      const learning = await learningStore.summary();
      const effectiveLearning = effectiveLearningForDecisions(state, learning);
      const policy = attachCompetitiveSignals(evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning)));
      const priorityAppRunning = Boolean(telemetry?.priorityApp?.running);
      const previousPriorityAppRunning = observerState.lastHighLoadRunning;
      let mlExecutionGate = null;
      observerState.lastTickAt = new Date().toISOString();
      observerState.lastError = null;
      await recordPendingModeEfficacy(policy.health.state);
      await recordPendingGpuReliefOutcome(telemetry, policy);

      try {
        const reliefStore = await readReliefStore();
        const relief = buildReliefStatus({ state, telemetry, policy, store: reliefStore });
        const efficacy = summarizeEfficacy(await readEfficacy());
        const cachedAdaptive = getLastResolvedPlan();
        const adaptivePower = cachedAdaptive && cachedAdaptive.modeId === state.modeId
          ? cachedAdaptive
          : resolveAdaptivePlanStateless({ modeId: state.modeId, telemetry, policy, learning: effectiveLearning });
        const decisionLedger = summarizeGovernorDecisionLedger(await readMlDecisionLedger());
        const performanceKnowledge = summarizeExternalPerformanceKnowledge();
        const mlGovernor = buildAutonomousMlGovernor({
          state,
          telemetry,
          policy,
          learning: effectiveLearning || {},
          efficacy,
          relief,
          adaptivePower,
          decisionLedger
        });
        mlExecutionGate = buildMlExecutionGate({ governor: mlGovernor, decisionLedger, state, relief });
        const mlOptimizer = buildNorthStarOptimizer({
          state,
          telemetry,
          policy,
          governor: mlGovernor,
          decisionLedger,
          executionGate: mlExecutionGate,
          efficacy,
          relief,
          adaptivePower,
          performanceKnowledge
        });
        const experiment = mlOptimizer.selectedExperiment;
        const optimizerKey = `${experiment?.id || "none"}:${experiment?.executable ? "ready" : "advisory"}:${mlOptimizer.coverage.hypothesisCount}:${mlOptimizer.coverage.executableCount}`;
        if (observerState.lastMlOptimizerAudit !== optimizerKey) {
          observerState.lastMlOptimizerAudit = optimizerKey;
          await appendAudit({
            level: "observe",
            action: "ml.optimizer.hypothesis",
            message: `North-star optimizer formed ${mlOptimizer.coverage.hypothesisCount} hypothesis(es); top experiment: ${experiment?.label || "keep monitoring"}.`,
            details: {
              level: 5,
              ideology: mlOptimizer.ideology,
              status: mlOptimizer.status,
              selectedExperiment: experiment,
              coverage: mlOptimizer.coverage
            }
          });
        }
        await advanceMlGovernorDecisionLoop({ governor: mlGovernor, state, telemetry, policy, adaptivePower });

        const mlExec = planMlExecution({
          gate: mlExecutionGate,
          automations: state.automations,
          state,
          decisionLedger,
          nowMs: Date.now(),
          lastExecMs: observerState.lastMlExecAt || 0
        });
        observerState.mlExecution = mlExec;
        if (mlExec.executeSelected) {
          observerState.lastMlExecAt = Date.now();
          observerState.mlExecutedCount = (observerState.mlExecutedCount || 0) + 1;
          const execKey = `${mlExec.actionId}:${mlExec.evidence || ""}`;
          if (observerState.lastMlExecuteAudit !== execKey) {
            observerState.lastMlExecuteAudit = execKey;
            await appendAudit({
              level: "action",
              action: "ml.execute",
              message: `Autonomous executor owned ${mlExec.actionId} via ${mlExec.handler || "existing handler"} on verified evidence (${mlExec.evidence || "verified"}). Deterministic gates still applied.`,
              details: { actionId: mlExec.actionId, handler: mlExec.handler, evidence: mlExec.evidence, executedCount: observerState.mlExecutedCount }
            });
          }
        } else if (mlExec.status === "prevention-hold" && observerState.lastMlPreventAudit !== mlExec.actionId) {
          observerState.lastMlPreventAudit = mlExec.actionId;
          await appendAudit({
            level: "info",
            action: "ml.prevention-hold",
            message: `Autonomous executor held ${mlExec.actionId}: verified prevention flagged it as recently worsening. Suppress-only — safety floor unaffected.`,
            details: { actionId: mlExec.actionId, reason: mlExec.reason }
          });
        }
      } catch (error) {
        await noteSelfError("ml.governor.error", `ML governor decision loop failed: ${error.message}`);
      }

      const changed =
        observerState.lastHealth !== policy.health.state ||
        observerState.lastPriority !== policy.priority.label ||
        observerState.lastSuggestedMode !== policy.suggestedMode ||
        observerState.lastFailureSignature !== (policy.failureWatchlist?.active[0]?.id || "none") ||
        observerState.lastHighLoadRunning !== priorityAppRunning;

      if (changed) {
        await appendAudit({
          level: "observe",
          action: "observer.tick",
          message: `Health ${policy.health.state}; priority ${policy.priority.label}; suggested ${policy.suggestedMode}.`,
          details: {
            health: policy.health,
            priority: policy.priority,
            suggestedMode: policy.suggestedMode,
            failureWatchlist: {
              activeCount: policy.failureWatchlist?.activeCount || 0,
              top: policy.failureWatchlist?.active[0] || null,
              autoDownshift: Boolean(policy.failureWatchlist?.autoDownshift)
            },
            highLoadRunning: priorityAppRunning
          }
        });
      }

      observerState.lastHealth = policy.health.state;
      observerState.lastPriority = policy.priority.label;
      observerState.lastSuggestedMode = policy.suggestedMode;
      observerState.lastFailureSignature = policy.failureWatchlist?.active[0]?.id || "none";
      observerState.lastHighLoadRunning = priorityAppRunning;

      try {
        await maybeAutonomousFailureHandling({ state, policy, learning });
      } catch (error) {
        await appendAudit({ level: "warn", action: "failure.remediation.error", message: `Autonomous failure remediation failed: ${error.message}` });
      }

      try {
        const incidentResult = observeIncidentLearning(await readIncidentLearningStore(), { state, telemetry, policy });
        if (incidentResult.changed) {
          await writeIncidentLearningStore(incidentResult.store);
        }
      } catch (error) {
        await noteSelfError("incident-learning.error", `Quiet incident learning failed: ${error.message}`);
      }

      const trapWarning = await recordDiagnosticTrapWarning({ policy, telemetry });
      if (trapWarning.recorded) {
        await appendAudit({
          level: "warn",
          action: "diagnostics.traps.warning",
          message: `Diagnostic traps captured warning: ${trapWarning.warnings.at(-1)?.label || "failure signal"}.`,
          details: {
            status: trapWarning.status,
            warning: trapWarning.warnings.at(-1),
            topCpuProcesses: trapWarning.warnings.at(-1)?.telemetry?.topCpuProcesses || []
          }
        });
      }

      if (priorityAppRunning && previousPriorityAppRunning === false) {
        const discovery = await discoverPriorityAppInstallations();
        const session = await startPriorityAppSessionRecord({
          source: "observer",
          profile: "competitive",
          discovery,
          telemetry,
          policy
        });
        observerState.lastContextSessionStart = Date.now();
        observerState.frameCapturedForSession = null;
        await appendLedgerEvent({
          correlationId: session.id,
          action: "health-session.detected-start",
          status: "started",
          adapterId: "health-session",
          adapterVersion: "2.0.0",
          message: "Observer detected competitive gaming session start.",
          details: { sessionId: session.id }
        });
        try {
          const confirmedGame = telemetry?.game?.confirmed || null;
          const gameKey = confirmedGame?.key || null;
          observerState.sessionThermalPeaks = { cpuMaxC: null, gpuMaxC: null };
          observerState.competitiveTrial = null;
          observerState.gameTitleThermal = null;
          if (gameKey) {
            const library = await readGameLibrary();
            const entry = library.titles?.[gameKey] || null;
            const trial = decideBandTrial(entry);
            observerState.competitiveTrial = { key: gameKey, tier: trial.tier, active: trial.active, reason: trial.reason };
            observerState.gameTitleThermal = titleThermalBias(entry);
            if (confirmedGame?.path) {
              const flip = await enrollFlipOptimization({ key: gameKey, path: confirmedGame.path });
              if (flip.ok && flip.action === "set") {
                await appendAudit({
                  level: "action",
                  action: "games.flip-enroll",
                  message: `${confirmedGame.title || confirmedGame.name} enrolled in windowed-game flip optimization (per-exe, HKCU, reversible).`
                });
              }
            }
          }
          const engaged = await engageCompetitiveLatches({ sessionKey: gameKey });
          if (engaged.ok && !engaged.already) {
            await appendAudit({
              level: "action",
              action: "competitive.latches",
              message: `Session latches engaged: timer ${engaged.engaged.timerLatch ? "0.5ms" : "skipped"}, NIC de-moderation ${engaged.engaged.nicDeModerated ? "on" : "unchanged"}, ${engaged.engaged.bitsSuspended} background transfer(s) paused${engaged.engaged.doCapped ? ", DO bandwidth capped" : ""}, focus watcher ${engaged.engaged.focusWatcher ? "on" : "off"}.${observerState.competitiveTrial ? ` Band trial: ${observerState.competitiveTrial.reason}` : ""}`,
              details: { engaged: engaged.engaged, mmcssAudit: engaged.mmcssAudit, notes: engaged.notes, trial: observerState.competitiveTrial }
            });
          }
        } catch (error) {
          await noteSelfError("competitive-tuning.error", `Session latch engage failed: ${error.message}`);
        }
      }
      if (priorityAppRunning) {
        await samplePriorityAppSessionThermals({ telemetry, policy });
        try {
          const cpuT = Number(telemetry?.system?.cpuTempC);
          const gpuT = Number(telemetry?.gpu?.temperatureC);
          const peaks = observerState.sessionThermalPeaks || (observerState.sessionThermalPeaks = { cpuMaxC: null, gpuMaxC: null });
          if (Number.isFinite(cpuT)) peaks.cpuMaxC = Math.max(peaks.cpuMaxC ?? -Infinity, cpuT);
          if (Number.isFinite(gpuT)) peaks.gpuMaxC = Math.max(peaks.gpuMaxC ?? -Infinity, gpuT);
          if (state.modeId === "competitive") {
            const adaptive = getLastResolvedPlan();
            const thermalOk = !policy?.thermalState || policy.thermalState.severity === "ok";
            const tuning = await competitiveTuningStatus();
            if ((!thermalOk || adaptive?.competitiveLull) && tuning.gpuClockLocked) {
              const why = !thermalOk ? `thermal (${policy.thermalState?.summary || "warm"})` : "lull";
              await releaseGpuClockLatch(why);
              await appendAudit({
                level: "action",
                action: "competitive.gpu-clock-latch",
                message: `GPU clock latch released (${why}) — clocks free to idle down.`
              });
            } else if (thermalOk && adaptive?.competitivePlay && tuning.engaged && !tuning.gpuClockLocked) {
              const latch = await engageGpuClockLatch({ temps: { cpuC: cpuT, gpuC: gpuT } });
              if (latch.ok && !latch.already) {
                await appendAudit({
                  level: "action",
                  action: "competitive.gpu-clock-latch",
                  message: `GPU clock latch engaged at ${latch.floorMHz} MHz — no ramp lag on the next fight. Engagement temps: CPU ${Number.isFinite(cpuT) ? Math.round(cpuT) : "?"}°C / GPU ${Number.isFinite(gpuT) ? Math.round(gpuT) : "?"}°C (thermal banking).`
                });
              }
            }
          }
        } catch (error) {
          await noteSelfError("competitive-tuning.error", `GPU clock latch follow failed: ${error.message}`);
        }
      }

      if (
        priorityAppRunning &&
        !observerState.frameCaptureInFlight &&
        observerState.frameCapturedForSession !== observerState.lastContextSessionStart &&
        Date.now() - observerState.lastContextSessionStart > 30000
      ) {
        observerState.frameCaptureInFlight = true;
        const sessionMarker = observerState.lastContextSessionStart;
        trackObserverTask(captureFrameStats({ processName: telemetry?.priorityApp?.process?.name || "active-workload", seconds: 6 })
          .then(async (stats) => {
            observerState.frameCapturedForSession = sessionMarker;
            if (stats?.available) {
              await attachFrameStats(stats);
              await appendAudit({
                level: "action",
                action: "frames.captured",
                message: `Frame capture: ${stats.avgFps} avg FPS, ${stats.p1LowFps} 1% low, ${stats.stutterCount} stutters.`,
                details: stats
              });
            }
          })
          .catch(() => {})
          .finally(() => {
            observerState.frameCaptureInFlight = false;
          }));
      }

      if (!priorityAppRunning && previousPriorityAppRunning === true) {
        const session = await endPriorityAppSessionRecord({ telemetry, policy });
        if (session) {
          await appendLedgerEvent({
            correlationId: session.id,
            action: "health-session.detected-end",
            status: "completed",
            adapterId: "health-session",
            adapterVersion: "2.0.0",
            message: "Observer detected competitive gaming session end.",
            details: { sessionId: session.id, outcomeScore: session.outcomeScore }
          });
          try {
            await learningStore.updateFromSession(session);
          } catch (error) {
            await noteSelfError("learning.error", `Learning update failed: ${error.message}`);
          }
          try {
            const title = getLastConfirmedGame();
            const engagements = await drainEngagementTemps();
            const peaks = observerState.sessionThermalPeaks || {};
            if (title?.key) {
              await recordGameOutcome({
                key: title.key,
                modeId: policy?.mode?.id || session.profile || null,
                score: session.outcomeScore,
                thermal: {
                  cpuMaxC: Number.isFinite(peaks.cpuMaxC) ? peaks.cpuMaxC : null,
                  gpuMaxC: Number.isFinite(peaks.gpuMaxC) ? peaks.gpuMaxC : null,
                  engagementTemps: engagements
                }
              });
              if (observerState.competitiveTrial?.active && session.frameStats?.available
                && observerState.competitiveTrial.key === title.key) {
                const verdict = await recordBandTrialSample({
                  key: title.key,
                  tier: observerState.competitiveTrial.tier,
                  p1LowFps: session.frameStats.p1LowFps,
                  stutterRatio: session.frameStats.stutterRatio
                });
                if (verdict) {
                  await appendAudit({
                    level: "observe",
                    action: "competitive.band-trial",
                    message: `Band trial sample recorded for ${title.title || title.key} (arm ${observerState.competitiveTrial.tier === 4 ? "05 Ultra" : "04 High"}, 1% low ${session.frameStats.p1LowFps} fps). ${verdict.decided ? verdict.reason : verdict.reason}`,
                    details: { verdict }
                  });
                }
              }
            }
            if (engagements.length) {
              const avg = engagements.map((e) => Number(e.cpuC)).filter(Number.isFinite);
              if (avg.length) {
                await appendAudit({
                  level: "observe",
                  action: "competitive.thermal-banking",
                  message: `Thermal banking: entered play at avg ${Math.round(avg.reduce((a, b) => a + b, 0) / avg.length)}°C CPU across ${engagements.length} engagement(s) — lower means the queue pre-cool bought boost headroom.`,
                  details: { engagements }
                });
              }
            }
          } catch (error) {
            await noteSelfError("learning.error", `Per-title game learning failed: ${error.message}`);
          }
        }
        try {
          const released = await releaseCompetitiveLatches("session-end");
          if (!released.already) {
            await appendAudit({
              level: "action",
              action: "competitive.latches",
              message: "Session latches released: GPU clocks unlocked, timer restored, NIC moderation restored, background transfers resumed, focus watcher stopped."
            });
          }
        } catch (error) {
          await noteSelfError("competitive-tuning.error", `Session latch release failed: ${error.message}`);
        }
        observerState.competitiveTrial = null;
        observerState.gameTitleThermal = null;
        observerState.sessionThermalPeaks = null;
        try {
          await resumeAllSuspended("session-end");
        } catch (error) {
          await appendAudit({ level: "warn", action: "offender.resume-all", message: `Resume on session end failed: ${error.message}` });
        }
      }

      try {
        const contextLabel = priorityAppRunning ? null : policy.priority.label;
        const trackedProfile = contextLabel ? contextProfileFor(contextLabel) : null;
        await hydrateObserverContextFromActiveSession(contextLabel, trackedProfile);
        if (contextLabel !== observerState.lastContextLabel) {
          if (observerState.lastContextLabel && contextProfileFor(observerState.lastContextLabel)) {
            const ended = await endContextSession({ telemetry, policy });
            if (ended && !ended.tooShortToLearn) {
              await learningStore.updateFromSession(ended);
              await appendContextSessionAudit({
                level: "observe",
                action: "context.session-end",
                message: `${ended.label} session ended (${ended.durationSeconds}s, score ${ended.outcomeScore}).`,
                details: { id: ended.id, profile: ended.profile, score: ended.outcomeScore }
              });
            }
          }
          if (trackedProfile) {
            const started = await startContextSession({ label: contextLabel, profile: trackedProfile, telemetry });
            observerState.lastContextSessionStart = Date.now();
            await appendContextSessionAudit({
              level: "observe",
              action: "context.session-start",
              message: `${contextLabel} session started (profile ${trackedProfile}).`,
              details: { id: started.id }
            });
          }
          observerState.lastContextLabel = contextLabel;
        } else if (trackedProfile) {
          await sampleContextSessionThermals({ telemetry });
        }
      } catch (error) {
        await noteSelfError("context.session-error", `Context session update failed: ${error.message}`);
      }

      try {
        const worstTempC = Number(policy?.thermalState?.worstTempC);
        const worstComp = policy?.thermalState?.worstComponent || null;
        if (Number.isFinite(worstTempC)) {
          observerState.thermalHistory = pushThermalSample(observerState.thermalHistory, { tempC: worstTempC, at: Date.now() });
          observerState.thermalPeaks = [...(observerState.thermalPeaks || []), worstTempC].slice(-12);
        }
        const hotLine = Number(THERMAL_THRESHOLDS?.[worstComp]?.hot) || 85;
        const calMargin = calibrationMarginC(observerState.thermalPeaks, { hot: hotLine });
        const predictive = evaluatePredictiveCooling(observerState.thermalHistory || [], { hot: hotLine, marginC: 3 + calMargin });
        const gamingActive = isCompetitiveGamingSession(state.modeId, telemetry);
        const predictiveEase = predictive.ease && !gamingActive;
        telemetry.thermalTrend = {
          predictiveWarm: predictiveEase,
          slope: predictive.slope,
          projected: predictive.projected,
          hotLine,
          calibrationMarginC: calMargin,
          suppressedForGaming: predictive.ease && gamingActive
        };
        if (predictiveEase && observerState.lastPredictiveAudit !== `${worstComp}:${predictive.projected}`) {
          observerState.lastPredictiveAudit = `${worstComp}:${predictive.projected}`;
          await appendAudit({
            level: "observe",
            action: "thermal.predictive-cool",
            message: `Pre-emptive cooling: ${worstComp || "temperature"} ${predictive.reason}; easing one tier before the hot line.`,
            details: { ...telemetry.thermalTrend, worstComponent: worstComp }
          });
        }
      } catch (error) {
        await noteSelfError("thermal.trend-error", `Predictive cooling pass failed: ${error.message}`);
      }

      try {
        const delegated = await maybeExecuteMlGovernorSafeHandler({
          gate: mlExecutionGate,
          state,
          telemetry,
          policy,
          learning: effectiveLearning,
          handler: "convergeInvariants"
        });
        if (!delegated) {
          await convergeInvariants({ state, telemetry, policy, learning: effectiveLearning });
        }
      } catch (error) {
        await noteSelfError("selfheal.error", `Convergence pass failed: ${error.message}`);
      }

      try {
        const delegated = await maybeExecuteMlGovernorSafeHandler({
          gate: mlExecutionGate,
          state,
          telemetry,
          policy,
          learning: effectiveLearning,
          handler: "maybeAutonomousRelief"
        });
        if (!delegated) {
          await maybeAutonomousRelief({ state, telemetry, policy });
        }
      } catch (error) {
        await noteSelfError("relief.error", `Autonomous relief pass failed: ${error.message}`);
      }

      try {
        await handleOffenders({ state, telemetry, policy });
      } catch (error) {
        await noteSelfError("offender.error", `Offender pass failed: ${error.message}`);
      }

      try {
        await maybeSelfTreat("observer");
      } catch (error) {
        await noteSelfError("self-treatment.error", `Self-treatment pass failed: ${error.message}`);
      }

      if (state.autonomy === "auto-safe" && !state.pinned) {
        let target = safeAutoTarget(policy, state.modeId, state.automations);
        let idleRestore = null;
        const currentTargetIsSafety = target ? isSafetyAutoTarget(policy, state.modeId, state.automations, target) : false;
        const idleReturn = evaluateIdleReturnTarget({
          input: telemetry.input,
          currentModeId: state.modeId,
          storedMode: observerState.idleReturnMode,
          policy
        });
        if (idleReturn.target && !currentTargetIsSafety) {
          target = idleReturn.target;
          idleRestore = idleReturn;
          if (idleReturn.overdriveBlocked && observerState.lastIdleAudit !== "overdrive-blocked") {
            observerState.lastIdleAudit = "overdrive-blocked";
            await appendAudit({
              level: "info",
              action: "observer.inactivity-overdrive-block",
              message: "Input resumed after idle Conservative mode; Overdrive was the prior mode, so Balanced is restored and Overdrive remains manual.",
              details: {
                from: state.modeId,
                storedMode: observerState.idleReturnMode,
                restoreTarget: target,
                reason: idleReturn.reason
              }
            });
          }
        } else if (idleReturn.clear && !idleReturn.target) {
          observerState.idleReturnMode = null;
          observerState.idleReturnModeStoredAt = null;
          observerState.idleReturnOverdriveBlocked = false;
          observerState.lastIdleAudit = null;
        }
        const initialGamingAuthority = evaluateCompetitiveModeAuthority({
          currentModeId: state.modeId,
          target,
          telemetry,
          policy,
          automations: state.automations,
          criticalStreak: observerState.gamingCriticalStreak || 0,
          resolvedPlan: getLastResolvedPlan()
        });
        const gamingNow = initialGamingAuthority.activeGame && state.modeId === "competitive";
        if (gamingNow && policy?.thermalState?.severity === "critical") {
          observerState.gamingCriticalStreak = (observerState.gamingCriticalStreak || 0) + 1;
        } else {
          observerState.gamingCriticalStreak = 0;
        }
        const gamingAuthority = evaluateCompetitiveModeAuthority({
          currentModeId: state.modeId,
          target,
          telemetry,
          policy,
          automations: state.automations,
          criticalStreak: observerState.gamingCriticalStreak || 0,
          resolvedPlan: getLastResolvedPlan()
        });
        if (gamingAuthority.held) {
          const gamingHoldKey = `${state.modeId}:${target}:${gamingAuthority.reason}`;
          if (observerState.lastGamingHoldAudit !== gamingHoldKey) {
            observerState.lastGamingHoldAudit = gamingHoldKey;
            await appendAudit({
              level: "info",
              action: "observer.gaming-hold",
              message: `Staying in Competitive Gaming instead of switching to ${getMode(target).label}: ${gamingAuthority.reason}.`,
              details: {
                currentMode: state.modeId,
                skippedTarget: target,
                reason: gamingAuthority.reason,
                gamingCriticalStreak: observerState.gamingCriticalStreak || 0,
                resolvedPlan: getLastResolvedPlan()?.plan || null
              }
            });
          }
        } else if (!gamingAuthority.activeGame) {
          observerState.lastGamingHoldAudit = null;
        }
        if (gamingAuthority.recovering) {
          const recoveryKey = `${state.modeId}:competitive:${gamingAuthority.reason}`;
          if (observerState.lastGamingRecoveryAudit !== recoveryKey) {
            observerState.lastGamingRecoveryAudit = recoveryKey;
            await appendAudit({
              level: "info",
              action: "observer.gaming-recovery",
              message: `A confirmed active game is restoring Competitive Gaming through the normal stability check.`,
              details: { currentMode: state.modeId, target: "competitive", reason: gamingAuthority.reason }
            });
          }
        } else if (!gamingAuthority.activeGame || state.modeId === "competitive") {
          observerState.lastGamingRecoveryAudit = null;
        }
        target = sessionQualifiedTarget(interactiveDesktop, policy, state.modeId, state.automations, gamingAuthority.target);
        if (learningInfluenceEnabled(state) && target && target !== state.modeId) {
          const guardrails = await learningStore.activeGuardrails();
          const guarded = guardrails.find((entry) => entry.profileId === target);
          if (guarded && observerState.lastGuardrailBlock !== target) {
            observerState.lastGuardrailBlock = target;
            await appendAudit({
              level: "info",
              action: "learning.guardrail-capped",
              message: `Activating ${getMode(target).label} (candidate) now, with its power held at the home base by a learned guardrail until results improve: ${guarded.reason}`,
              details: { target, guarded }
            });
          }
        }
        if (target && target !== state.modeId) {
          const resolved = getLastResolvedPlan();
          const bandPosture = policy.bandFirstRecovery?.active ? "recovery" : policy.priority?.posture;
          const bandDecision = preferBandBeforeModeSwitch({
            posture: bandPosture,
            currentMode: state.modeId,
            target,
            isSafety: isSafetyAutoTarget(policy, state.modeId, state.automations, target),
            resolvedModeId: resolved?.modeId ?? null,
            resolvedTier: resolved?.tier ?? null,
            resolvedFloor: resolved?.floor ?? null,
            resolvedCeiling: resolved?.ceiling ?? MODE_BANDS[state.modeId]?.ceiling ?? null
          });
          if (!bandDecision.switchMode) {
            const bandKey = `${bandPosture}:${state.modeId}:${target}:${resolved?.tier ?? "?"}`;
            if (observerState.lastBandFirstAudit !== bandKey) {
              observerState.lastBandFirstAudit = bandKey;
              await appendAudit({
                level: "info",
                action: "observer.band-first",
                message: `Using the power level within ${getMode(state.modeId).label} first (now ${resolved?.plan || "current level"}) instead of switching to ${getMode(target).label} — ${bandDecision.reason}.`,
                details: {
                  currentMode: state.modeId,
                  deferredTarget: target,
                  reason: bandDecision.reason,
                  resolvedPlan: resolved?.plan ?? null,
                  resolvedTier: resolved?.tier ?? null,
                  floor: resolved?.floor ?? null,
                  ceiling: resolved?.ceiling ?? MODE_BANDS[state.modeId]?.ceiling ?? null,
                  posture: bandPosture
                }
              });
            }
            target = null;
          }
        }
        const hold = manualTransitionHold();
        if (
          target &&
          target !== state.modeId &&
          hold.active &&
          !isSafetyAutoTarget(policy, state.modeId, state.automations, target)
        ) {
          const auditKey = `${hold.target}:${target}:${hold.until}`;
          if (observerState.lastManualHoldAudit !== auditKey) {
            observerState.lastManualHoldAudit = auditKey;
            await appendAudit({
              level: "info",
              action: "observer.auto-hold",
              message: `Auto-switch to ${getMode(target).label} paused while ${getMode(hold.target).label} transition is pending.`,
              details: { hold, currentMode: state.modeId, skippedTarget: target }
            });
          }
          target = null;
        }
        if (target && target !== state.modeId) {
          const safetyTarget = isSafetyAutoTarget(policy, state.modeId, state.automations, target);
          const stabilityConfig = modeSwitchStabilityConfig({
            policy,
            currentModeId: state.modeId,
            target,
            isSafety: safetyTarget
          });
          const stability = evaluateModeSwitchStability({
            target: observerState.pendingAutoTarget,
            since: observerState.pendingAutoTargetSince,
            confirmations: observerState.pendingAutoTargetConfirmations
          }, {
            target,
            currentModeId: state.modeId,
            isSafety: safetyTarget,
            dwellMs: stabilityConfig.dwellMs,
            minConfirmations: stabilityConfig.minConfirmations
          });
          observerState.pendingAutoTarget = stability.pending?.target || null;
          observerState.pendingAutoTargetSince = stability.pending?.since || null;
          observerState.pendingAutoTargetConfirmations = stability.pending?.confirmations || 0;
          if (!stability.allow) {
            const stabilityKey = `${target}:${stability.pending?.since || "new"}`;
            if (observerState.lastModeStabilityAudit !== stabilityKey) {
              observerState.lastModeStabilityAudit = stabilityKey;
              const inactivityHold = policy.priority?.posture === "inactivity" && target === "conservative";
              await appendAudit({
                level: "info",
              action: "observer.mode-stability-hold",
              message: inactivityHold
                ? "Extended inactivity reached the threshold; waiting for a stable idle signal before switching to Conservative."
                : stabilityConfig.restReturn
                  ? `Workload appears finished; waiting for ${getMode(target).label} to stay stable before leaving ${getMode(state.modeId).label}.`
                  : `Auto-switch to ${getMode(target).label} is waiting for a stable signal before changing modes.`,
              details: {
                currentMode: state.modeId,
                pendingTarget: target,
                reason: stability.reason,
                restReturn: stabilityConfig.restReturn,
                posture: policy.priority?.posture || null,
                idleMinutes: telemetry.input?.idleMinutes ?? null,
                dwellMs: stabilityConfig.dwellMs,
                minConfirmations: stabilityConfig.minConfirmations,
                confirmations: stability.confirmations || 0,
                elapsedMs: stability.elapsedMs || 0
              }
              });
            }
            target = null;
          } else if (safetyTarget) {
            observerState.lastModeStabilityAudit = null;
          }
        } else {
          observerState.pendingAutoTarget = null;
          observerState.pendingAutoTargetSince = null;
          observerState.pendingAutoTargetConfirmations = 0;
          observerState.lastModeStabilityAudit = null;
        }
        const lastAuto = observerState.lastAutoApplyAt ? Date.parse(observerState.lastAutoApplyAt) : 0;
        const cooldownMs = Math.max(10, Number(state.automations?.cooldownSeconds) || 20) * 1000;
        const cooldownPassed = Date.now() - lastAuto > cooldownMs;
        if (target && target !== state.modeId && cooldownPassed) {
          const enteringIdleConservative = target === "conservative" && policy.priority?.posture === "inactivity";
          if (enteringIdleConservative && state.modeId !== "conservative") {
            observerState.idleReturnMode = state.modeId;
            observerState.idleReturnModeStoredAt = new Date().toISOString();
            observerState.idleReturnOverdriveBlocked = false;
            observerState.lastIdleAudit = `enter:${state.modeId}`;
            await appendAudit({
              level: "action",
              action: "observer.inactivity-enter",
              message: `Extended inactivity reached ${Math.round(Number(telemetry.input?.idleMinutes) || 0)} minutes; switching to Conservative idle cooling and remembering ${getMode(state.modeId).label} for resume.`,
              details: {
                from: state.modeId,
                to: target,
                idleMinutes: telemetry.input?.idleMinutes ?? null,
                thresholdMs: telemetry.input?.thresholdMs ?? EXTENDED_IDLE_MS,
                returnMode: observerState.idleReturnMode
              }
            });
          }
          observerState.lastAutoApplyAt = new Date().toISOString();
          await applyMode(target, false, {
            source: "observer",
            safety: isSafetyAutoTarget(policy, state.modeId, state.automations, target)
          });
          observerState.pendingModeEfficacy = {
            action: `mode:${target}`,
            before: healthScore(policy.health.state),
            at: new Date().toISOString()
          };
          await appendAudit({
            level: "action",
            action: "observer.auto-apply",
            message: `Auto-safe switched to ${getMode(target).label}.`,
            details: {
              from: state.modeId,
              to: target,
              reason: policy.priority.reason,
              health: policy.health.state
            }
          });
          if (idleRestore) {
            await appendAudit({
              level: "action",
              action: "observer.inactivity-restore",
              message: `Input resumed; restored ${getMode(target).label} after Conservative idle cooling.`,
              details: {
                from: state.modeId,
                to: target,
                storedMode: observerState.idleReturnMode,
                overdriveBlocked: idleRestore.overdriveBlocked,
                reason: idleRestore.reason
              }
            });
            observerState.idleReturnMode = null;
            observerState.idleReturnModeStoredAt = null;
            observerState.idleReturnOverdriveBlocked = idleRestore.overdriveBlocked;
            observerState.lastIdleAudit = null;
          }
          observerState.pendingAutoTarget = null;
          observerState.pendingAutoTargetSince = null;
          observerState.pendingAutoTargetConfirmations = 0;
          observerState.lastModeStabilityAudit = null;
        }
      }
    } catch (error) {
      observerState.lastError = error?.message || String(error);
      await noteSelfError("observer.error", observerState.lastError);
      try {
        await maybeSelfTreat("observer.catch");
      } catch {
      }
    } finally {
      observerState.tickInFlight = false;
    }
  }

  const runTick = () => {
    if (!observerState.running) return;
    if (observerState.tickInFlight) {
      observerState.skippedOverlappingTicks += 1;
      return;
    }
    observerTickPromise = tick();
    observerTickPromise.catch((error) => { observerState.lastError = error?.message || String(error); });
  };
  runTick();
  observerTimer = setInterval(runTick, intervalMs);
  observerTimer.unref?.();
  return observerState;
}

export async function applyMode(modeId, dryRun = true, options = {}) {
  const mode = getMode(modeId);
  const correlationId = createCorrelationId("mode");
  let snapshot = null;
  let targetPlanName = mode.powerPlanName;
  if (!dryRun) {
    const lockCheck = await evaluateOverdriveLock(mode.id, options);
    if (lockCheck.blocked) {
      await appendAudit({
        level: "info",
        action: "mode.overdrive-lock",
        message: lockCheck.message,
        details: { requested: mode.id, remainingSeconds: lockCheck.remainingSeconds }
      });
      return { ok: false, blocked: true, reason: "overdrive-lock", message: lockCheck.message, remainingSeconds: lockCheck.remainingSeconds };
    }
    if (options.source !== "observer") {
      holdManualTransition(mode.id, "mode-apply");
    }
    const state = await readState();
    const telemetry = await captureTelemetry();
    try {
      const learning = await learningStore.summary();
      const policy = evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning));
      const resolved = resolveAdaptivePlanStateless({
        modeId: mode.id,
        telemetry,
        policy,
        learning: effectiveLearningForDecisions(state, learning)
      });
      if (resolved?.plan) {
        targetPlanName = resolved.plan;
      }
    } catch {
    }
    snapshot = await createSnapshot({
      reason: `Before applying mode ${mode.label}.`,
      correlationId,
      state,
      telemetry,
      plan: {
        targetMode: { id: mode.id, label: mode.label },
        risk: mode.risk || "medium",
        plannedActions: [{ id: "mode.apply", adapterId: "power-plan" }]
      }
    });
    await appendLedgerEvent({
      correlationId,
      action: "mode.apply",
      status: "started",
      adapterId: "power-plan",
      adapterVersion: "2.0.0",
      message: `Started mode apply for ${mode.label}.`,
      details: { snapshot: snapshot.filePath }
    });
  }
  const planResult = targetPlanName ? await setPowerPlanByName(targetPlanName, dryRun) : null;
  const message = dryRun
    ? `Dry run mode switch to ${mode.label}.`
    : `Applied mode ${mode.label}.`;

  if (!dryRun) {
    const state = await readState();
    const overdriveArmedAt = mode.id === "overdrive"
      ? (state.modeId === "overdrive" && state.overdriveArmedAt ? state.overdriveArmedAt : new Date().toISOString())
      : null;
    await writeState({
      ...state,
      modeId: mode.id,
      overdriveArmedAt,
      lastAppliedAt: new Date().toISOString(),
      lastAction: message
    });
  }

  await appendAudit({
    level: dryRun ? "info" : "action",
    action: "mode.apply",
    modeId: mode.id,
    dryRun,
    message,
    details: { planResult }
  });

  if (!dryRun) {
    await appendLedgerEvent({
      correlationId,
      action: "mode.apply",
      status: !planResult || planResult.ok ? "completed" : "failed",
      adapterId: "power-plan",
      adapterVersion: "2.0.0",
      message,
      details: { planResult, snapshot: snapshot?.filePath }
    });
  }

  return {
    ok: !planResult || planResult.ok,
    dryRun,
    mode,
    planResult,
    snapshot,
    message
  };
}

export async function startPriorityAppSession(dryRun = true) {
  const discovery = await discoverPriorityAppInstallations();
  const correlationId = createCorrelationId("health-session");
  const candidate = discovery.candidates?.[0] || null;

  if (dryRun) {
    await appendAudit({
      level: "info",
      action: "health-session.dry-run",
      dryRun,
      message: candidate
        ? "Would begin tracking the current high-load workload."
        : "Would begin competitive gaming session tracking when a foreground workload is detected.",
      details: { candidateCount: discovery.candidates?.length || 0, candidate }
    });
    return { ok: true, dryRun, discovery, candidate };
  }

  const state = await readState();
  const telemetry = await captureTelemetry();
  const snapshot = await createSnapshot({
    reason: "Before starting competitive gaming session tracking.",
    correlationId,
    state,
    telemetry,
    plan: {
      targetMode: { id: "competitive", label: getMode("competitive").label },
      risk: "medium",
      plannedActions: [{ id: "health-session.start", adapterId: "health-session" }]
    }
  });
  await appendLedgerEvent({
    correlationId,
    action: "health-session.start",
    status: "started",
    adapterId: "health-session",
    adapterVersion: "2.0.0",
    message: "Started competitive gaming session tracking.",
    details: { snapshot: snapshot.filePath, candidate }
  });
  const session = await startPriorityAppSessionRecord({
    source: "manual-session",
    profile: "competitive",
    discovery,
    telemetry
  });
  await writeState({
    ...(await readState()),
    modeId: "competitive",
    lastAppliedAt: new Date().toISOString(),
    lastAction: "Started competitive gaming session tracking."
  });
  await appendAudit({
    level: "action",
    action: "health-session.start",
    dryRun,
    message: "Started competitive gaming session tracking.",
    details: { sessionId: session.id, candidate, snapshot: snapshot.filePath }
  });
  await appendLedgerEvent({
    correlationId,
    action: "health-session.start",
    status: "completed",
    adapterId: "health-session",
    adapterVersion: "2.0.0",
    message: "Competitive gaming session tracking started.",
    details: { sessionId: session.id, snapshot: snapshot.filePath }
  });
  return { ok: true, dryRun, discovery, candidate, session, snapshot };
}

export async function restoreSessionApps(dryRun = true) {
  const correlationId = createCorrelationId("restore");
  let snapshot = null;
  if (!dryRun) {
    snapshot = await createSnapshot({
      reason: "Before restoring session apps.",
      correlationId,
      state: await readState(),
      telemetry: await captureTelemetry(),
      plan: {
        targetMode: { id: "balanced", label: "Balanced" },
        risk: "low",
        plannedActions: [{ id: "session.restore", adapterId: "health-session" }]
      }
    });
    await appendLedgerEvent({
      correlationId,
      action: "session.restore",
      status: "started",
      adapterId: "health-session",
      adapterVersion: "2.0.0",
      message: "Started session app restore.",
      details: { snapshot: snapshot.filePath }
    });
  }

  let result = { ok: true, code: 0, stdout: "", stderr: "" };
  if (!dryRun) {
    try {
      await resumeAllSuspended("restore-all");
    } catch (error) {
      result = { ok: false, code: 1, stdout: "", stderr: String(error?.message || error) };
    }
  }

  await appendAudit({
    level: dryRun ? "info" : "action",
    action: "session.restore",
    dryRun,
    message: dryRun ? "Would restore session-scoped app changes." : "Restored session-scoped app changes.",
    details: { result, snapshot: snapshot?.filePath }
  });
  if (!dryRun) {
    await appendLedgerEvent({
      correlationId,
      action: "session.restore",
      status: result.ok ? "restored" : "failed",
      adapterId: "health-session",
      adapterVersion: "2.0.0",
      message: result.ok ? "Session app restore completed." : "Session app restore failed.",
      details: { result, snapshot: snapshot?.filePath }
    });
  }
  return { ok: result.ok, dryRun, result, snapshot };
}

export async function applyPriorityAppConfig(dryRun = true) {
  if (dryRun) {
    await appendAudit({
      level: "info",
      action: "session.prep.dry-run",
      dryRun,
      message: "Would prepare a competitive gaming health session with high-power plan and unrestricted pacing."
    });
    return {
      ok: true,
      dryRun,
      message: "Would prepare competitive gaming session settings without a frame cap or pacing limit."
    };
  }
  const correlationId = createCorrelationId("sessionprep");
  const snapshot = await createSnapshot({
    reason: "Before applying competitive gaming session prep.",
    correlationId,
    state: await readState(),
    telemetry: await captureTelemetry(),
    plan: {
      targetMode: { id: "competitive", label: getMode("competitive").label },
      risk: "medium",
      plannedActions: [{ id: "session.prep.apply", adapterId: "session-config" }]
    }
  });
  await appendLedgerEvent({
    correlationId,
    action: "session.prep.apply",
    status: "started",
    adapterId: "session-config",
    adapterVersion: "2.0.0",
    message: "Started competitive gaming session prep.",
    details: { snapshot: snapshot.filePath }
  });
  const result = await setPowerPlanByName("04 - High Power Mode", false);
  await appendAudit({
    level: "action",
    action: "session.prep.apply",
    dryRun,
    message: result.ok ? "Applied competitive gaming session prep." : "Competitive gaming session prep failed.",
    details: { result, snapshot: snapshot.filePath }
  });
  await appendLedgerEvent({
    correlationId,
    action: "session.prep.apply",
    status: result.ok ? "completed" : "failed",
    adapterId: "session-config",
    adapterVersion: "2.0.0",
    message: result.ok ? "Competitive gaming session prep applied." : "Competitive gaming session prep failed.",
    details: { result, snapshot: snapshot.filePath }
  });
  return { ok: result.ok, dryRun, result, snapshot };
}

export async function describeElevatedAction(actionId, dryRun = true) {
  const map = {
    fullCapacity: {
      script: scripts.fullCapacity,
      label: "Full-capacity hardware profile",
      reason: "Touches system-wide settings and may require an elevated Windows token."
    },
    inputLowLatency: {
      script: scripts.inputLowLatency,
      label: "Input low-latency profile",
      reason: "Edits input and USB settings; safe to preview first."
    },
    networkPerformance: {
      script: scripts.networkPerformance,
      label: "Network performance profile",
      reason: "Can change adapter/DNS/network prioritization."
    },
    hagsDisabled: {
      script: scripts.hagsDisabled,
      label: "Disable HAGS",
      reason: "Writes HKLM and requires elevation."
    },
    storageSmartTelemetry: {
      script: scripts.elevatedLauncher,
      label: "Enable storage SMART telemetry",
      reason: "Requires restarting the local service through the elevated launcher so Windows exposes physical disk temperature sensors."
    }
  };
  const action = map[actionId];
  if (!action) {
    return { ok: false, message: `Unknown action: ${actionId}` };
  }
  await appendAudit({
    level: "info",
    action: `elevated.${actionId}`,
    dryRun,
    message: dryRun
      ? `Would prepare ${action.label}.`
      : `${action.label} is intentionally not auto-elevated from the web UI.`,
    details: action
  });
  return {
    ok: true,
    dryRun,
    action,
    message: dryRun
      ? `Would prepare ${action.label}.`
      : `${action.label} needs an elevated PowerShell run and explicit confirmation.`
  };
}

export function evaluateNetworkActionSafety(actionId, { dryRun = true, confirmed = false, network = {} } = {}) {
  const safeResetRule = Boolean(
    network.activeAdapter &&
    network.state === "critical" &&
    (
      Number(network.packetLossPct) >= 100 ||
      (network.dnsOk === false && network.webReachable === false)
    )
  );
  return {
    safeResetRule,
    requiresConfirmation: actionId === "reset-adapter" && !safeResetRule,
    refused:
      actionId === "reset-adapter" &&
      !dryRun &&
      !confirmed &&
      !safeResetRule
  };
}

export async function runNetworkAction(actionId, options = {}) {
  const dryRun = options.dryRun !== false;
  const confirmed = Boolean(options.confirm);
  const forceTelemetry = !dryRun && ["detect-dns-failure", "warn-vpn-latency"].includes(actionId);
  const telemetry = await captureTelemetry({
    force: forceTelemetry,
    maxAgeMs: dryRun ? 30000 : 10000
  });
  const state = await readState();
  const learning = await learningStore.summary();
  const policy = evaluatePolicy(telemetry, stateWithLearningInfluence(state, learning));
  const network = policy.networkHealth || {};
  const safety = evaluateNetworkActionSafety(actionId, { dryRun, confirmed, network });
  const actionMap = {
    "prioritize-ethernet": {
      label: "Prioritize Ethernet",
      trustLevel: "elevated",
      message: "Would prepare the network performance profile to prefer Ethernet/interface metrics."
    },
    "pause-background-downloaders": {
      label: "Pause background launchers/downloaders",
      trustLevel: "recommend",
      message: "Would list launcher/downloader candidates for manual review."
    },
    "reset-adapter": {
      label: "Reset active adapter",
      trustLevel: "elevated",
      message: "Would reset the active adapter only after confirmation or a critical safe-rule match."
    },
    "detect-dns-failure": {
      label: "Detect DNS failure",
      trustLevel: "observe",
      message: "Would re-run DNS resolution checks against public service endpoints."
    },
    "warn-vpn-latency": {
      label: "Warn VPN latency",
      trustLevel: "observe",
      message: "Would keep warning while VPN is active and latency/loss is elevated."
    }
  };
  const action = actionMap[actionId];
  if (!action) {
    return { ok: false, message: `Unknown network action: ${actionId}` };
  }

  let ok = true;
  let message = action.message;
  if (safety.refused) {
    ok = false;
    message = "Adapter reset refused: confirmation is required unless total packet loss or DNS plus web failure matches the critical safe rule.";
  } else if (!dryRun && ["prioritize-ethernet", "reset-adapter"].includes(actionId)) {
    ok = false;
    message = `${action.label} requires the elevated network helper; the web UI will not mutate adapter state directly.`;
  } else if (!dryRun && actionId === "pause-background-downloaders") {
    ok = false;
    message = "Downloader pausing is recommendation-only until per-app pause/restore contracts are added.";
  }

  const result = {
    ok,
    dryRun,
    actionId,
    action,
    confirmed,
    requiresConfirmation: safety.requiresConfirmation,
    safeResetRule: safety.safeResetRule,
    network,
    candidates: network.bandwidthHeavyApps || [],
    message
  };
  await appendAudit({
    level: ok ? "info" : "warn",
    action: `network.${actionId}`,
    dryRun,
    message,
    details: { confirmed, safeResetRule: safety.safeResetRule, networkState: network.state, candidates: result.candidates.slice(0, 5) }
  });
  await appendLedgerEvent({
    correlationId: createCorrelationId("network"),
    action: `network.${actionId}`,
    status: ok ? (dryRun ? "planned" : "completed") : "refused",
    adapterId: "network-profile",
    adapterVersion: "2.0.0",
    message,
    details: { action, confirmed, safeResetRule: safety.safeResetRule, networkState: network.state }
  });
  return result;
}
