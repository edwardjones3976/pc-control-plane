import { backgroundHazards, modeProtectedMatches, modes, protectedAppRules } from "./config.js";
import { buildFailureDiagnostics, buildFailureWatchlist } from "./failures.js";
import { buildFailurePrevention } from "./failure-prevention.js";
import { buildFailureProactivePrevention } from "./failure-proactive-prevention.js";
import { buildFailureRemediation } from "./failure-remediation.js";
import { appIdentityForProcess } from "./learning.js";
import { MODE_BANDS } from "./power-adaptive.js";
import { classifyThermalState, THERMAL_SEVERITY_RANK } from "./thermal-hierarchy.js";

export function normalizeProcessName(name) {
  return String(name || "").trim().toLowerCase();
}

function isPriorityAppProcessName(name) {
  return false;
}

export function getMode(modeId) {
  return modes.find((mode) => mode.id === modeId) || modes.find((mode) => mode.id === "balanced");
}

export function effectiveRamUsedPct(system = {}) {
  const real = Number(system?.ramUsedRealPct);
  if (Number.isFinite(real)) return real;
  const free = Number(system?.ramUsedPct);
  return Number.isFinite(free) ? free : 0;
}

export function isProtectedProcess(name, modeId = "balanced") {
  const normalized = normalizeProcessName(name);
  if (!normalized) {
    return false;
  }

  const globalMatch = protectedAppRules.some((rule) =>
    rule.match.some((part) => normalized.includes(part))
  );
  if (globalMatch) {
    return true;
  }

  const modeMatches = modeProtectedMatches[modeId] || [];
  return modeMatches.some((part) => normalized.includes(part));
}

function processMatches(process, parts) {
  const normalized = normalizeProcessName(process?.name);
  return parts.some((part) => normalized.includes(part));
}

function reputationEntries(appReputation = null) {
  if (!appReputation) {
    return [];
  }
  if (Array.isArray(appReputation.entries)) {
    return appReputation.entries;
  }
  return Object.values(appReputation);
}

function reputationForProcess(process, appReputation = null) {
  const identity = appIdentityForProcess(process);
  const entries = reputationEntries(appReputation);
  const pathMatch = entries.find((entry) =>
    identity.identityConfidence === "high" &&
    entry.identityConfidence === "high" &&
    entry.key === identity.key
  );
  return pathMatch || null;
}

function isProtectedReputationEntry(entry, modeId = "balanced") {
  const label = entry?.name || entry?.normalizedName || entry?.key || "";
  return isProtectedProcess(label, modeId);
}

const AGENTIC_ACTIVITY_HOLD_MS = 25 * 1000;
const AGENTIC_LOW_ACTIVE_PCT = 2.5;
const AI_APP_PARTS = ["codex", "claude", "cursor", "ollama", "lmstudio", "lm studio", "continue", "copilot"];
const AGENTIC_IDLE_EXIT_MS = Number(process.env.PC_CONTROL_AGENTIC_IDLE_EXIT_MS || 10 * 60 * 1000);
let devToolActivityState = {};
let lastAgenticActiveMs = null;
export function __resetDevToolActivity() { devToolActivityState = {}; lastAgenticActiveMs = null; }
export function sustainDevToolActivity(devToolHits = [], prevState = {}, nowMs = Date.now(), {
  activePct = 8,
  lowActivePct = AGENTIC_LOW_ACTIVE_PCT,
  holdMs = AGENTIC_ACTIVITY_HOLD_MS,
  foregroundName = null
} = {}) {
  const prev = prevState && prevState.tools ? prevState : { tools: {}, seen: [] };
  const priorSeen = Array.isArray(prev.seen) ? prev.seen : [];
  const tools = { ...prev.tools };
  const seen = new Set(priorSeen);
  const fg = foregroundName ? normalizeProcessName(foregroundName) : null;
  for (const process of devToolHits) {
    const name = normalizeProcessName(process.name);
    const cpuPct = Number(process.cpuPct) || 0;
    const cpuSeconds = Number(process.cpuSeconds);
    const prevEntry = tools[name] || {};
    let integralPct = 0;
    if (Number.isFinite(cpuSeconds) && Number.isFinite(prevEntry.cpuSeconds) && Number.isFinite(prevEntry.lastSampleMs)) {
      const dt = (nowMs - prevEntry.lastSampleMs) / 1000;
      if (dt > 0) integralPct = ((cpuSeconds - prevEntry.cpuSeconds) / dt) * 100;
    }
    const isNewLaunch = !seen.has(name) && priorSeen.length > 0;
    const working = cpuPct >= activePct
      || integralPct >= lowActivePct
      || (fg && name === fg)
      || isNewLaunch;
    tools[name] = {
      lastSampleMs: nowMs,
      cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : prevEntry.cpuSeconds,
      activeMs: working ? nowMs : (prevEntry.activeMs ?? null)
    };
    seen.add(name);
  }
  const activeNames = [];
  for (const [name, entry] of Object.entries(tools)) {
    if (entry.activeMs != null && nowMs - entry.activeMs <= holdMs) activeNames.push(name);
    if (nowMs - Number(entry.lastSampleMs || 0) > holdMs * 4) delete tools[name];
  }
  return { activeNames, state: { tools, seen: Array.from(seen).slice(-64) } };
}

export function classifyPriority(telemetry, state = {}) {
  telemetry = telemetry && typeof telemetry === "object" ? telemetry : {};
  state = state && typeof state === "object" ? state : {};
  const processes = Array.isArray(telemetry.processes)
    ? telemetry.processes
    : (telemetry.processes && typeof telemetry.processes === "object" ? [telemetry.processes] : []);
  const gpuUtil = Number(telemetry?.gpu?.utilizationPct) || 0;
  const fullscreen = Boolean(telemetry?.foreground?.fullscreen);
  const agenticParts = ["codex", "claude", "docker", "node", "python"];
  const aiModelParts = ["codex", "claude"];
  const DEV_TOOL_CPU_ACTIVE_PCT = 8; // "active" = actually consuming CPU, not merely present
  const devToolHits = processes.filter((process) => processMatches(process, agenticParts));
  const fgNameForAgentic = normalizeProcessName(telemetry?.foreground?.name);
  const focusedDevTool = Boolean(fgNameForAgentic) && agenticParts.some((part) => fgNameForAgentic.includes(part));
  const nowMsForActivity = Date.parse(telemetry?.capturedAt);
  let sustainedActiveSet = null;
  if (Number.isFinite(nowMsForActivity)) {
    const sustained = sustainDevToolActivity(devToolHits, devToolActivityState, nowMsForActivity, { activePct: DEV_TOOL_CPU_ACTIVE_PCT, holdMs: AGENTIC_ACTIVITY_HOLD_MS, foregroundName: fgNameForAgentic });
    devToolActivityState = sustained.state;
    sustainedActiveSet = new Set(sustained.activeNames);
  }
  const cpuActiveDevTools = devToolHits.filter((process) =>
    sustainedActiveSet
      ? sustainedActiveSet.has(normalizeProcessName(process.name))
      : Number(process.cpuPct) >= DEV_TOOL_CPU_ACTIVE_PCT
  );
  const otherActiveDevTools = cpuActiveDevTools.filter((process) => normalizeProcessName(process.name) !== fgNameForAgentic).length;
  const aiModelsPresent = aiModelParts.filter((part) =>
    devToolHits.some((process) => normalizeProcessName(process.name).includes(part))
  ).length;
  const foregroundAgentic = focusedDevTool && otherActiveDevTools >= 1;
  const backgroundAgentic = cpuActiveDevTools.length >= 3;
  const aiPairAgentic = aiModelsPresent >= 2 && cpuActiveDevTools.length >= 1;
  const aiAppHits = devToolHits.filter((process) =>
    AI_APP_PARTS.some((part) => normalizeProcessName(process.name).includes(part))
  );
  const aiFamilyOf = (process) => {
    const n = normalizeProcessName(process.name);
    return AI_APP_PARTS.find((part) => n.includes(part)) || n;
  };
  const aiAppsPresent = new Set(aiAppHits.map(aiFamilyOf)).size;
  const aiAppsActive = new Set(
    aiAppHits
      .filter((process) =>
        sustainedActiveSet
          ? sustainedActiveSet.has(normalizeProcessName(process.name))
          : Number(process.cpuPct) >= DEV_TOOL_CPU_ACTIVE_PCT
      )
      .map(aiFamilyOf)
  ).size;
  const anyAgenticWork = aiAppsActive >= 1 || cpuActiveDevTools.length >= 1;
  if (Number.isFinite(nowMsForActivity)) {
    if (anyAgenticWork) {
      lastAgenticActiveMs = nowMsForActivity;
    }
  }
  const agenticIdleTooLong = Number.isFinite(nowMsForActivity)
    && lastAgenticActiveMs != null
    && !anyAgenticWork
    && nowMsForActivity - lastAgenticActiveMs > AGENTIC_IDLE_EXIT_MS;
  const aiActiveAgentic = aiAppsActive >= 1 && !agenticIdleTooLong;
  const aiPresenceAgentic = aiAppsPresent >= 2 && !agenticIdleTooLong;
  const agenticActive = foregroundAgentic || backgroundAgentic || aiPairAgentic || aiActiveAgentic;

  const cpuLoadPct = Number(telemetry?.system?.cpuLoadPct) || 0;
  const ramUsed = effectiveRamUsedPct(telemetry?.system);
  const priorityProc = telemetry?.priorityApp?.process || {};
  const priorityName = normalizeProcessName(priorityProc.name);
  const foregroundName = normalizeProcessName(telemetry?.foreground?.name);
  const priorityRunning = Boolean(telemetry?.priorityApp?.running);
  const priorityCpu = Number(priorityProc.cpuPct) || 0;
  const computeApp = COMPUTE_APPS.some(
    (app) => (priorityName && priorityName.includes(app)) || (foregroundName && foregroundName.includes(app))
  );
  const verdict = telemetry?.game?.confirmed || null;
  const heuristicGameLike = priorityRunning && !computeApp && (fullscreen || gpuUtil >= 25);
  const heuristicForeground = heuristicGameLike
    && (fullscreen || !foregroundName || !priorityName || priorityName === foregroundName);
  const hasVerdictLayer = Boolean(telemetry?.game);
  const gameName = verdict?.title || verdict?.name || priorityName || "the game";
  const verdictForeground = Boolean(verdict)
    && (verdict.foreground === true || fullscreen || !foregroundName || verdict.name === foregroundName);
  const gameForeground = hasVerdictLayer ? verdictForeground : heuristicForeground;
  const engageBeforeActivity = telemetry?.game?.engageNow === true;

  const thermalState = classifyThermalState(telemetry, {
    modeId: state.modeId,
    foregroundActive: gameForeground,
    gamingSession: gameForeground
  });

  if (gameForeground) {
    if (thermalState.severity === "critical") {
      return {
        label: "Gaming — Thermal Emergency",
        modeHint: "conservative",
        confidence: 0.9,
        posture: "cooling",
        reason: `Game is active but temperature is extreme (${thermalState.summary}) — Conservative until it clears.`
      };
    }
    const userAway = telemetry?.input?.isExtendedIdle === true;
    const quiet = gpuUtil < 25 && cpuLoadPct < 25;
    if (quiet && engageBeforeActivity && telemetry?.game?.preActivity === true && !userAway) {
      return {
        label: "Competitive Gaming Session",
        modeHint: "competitive",
        confidence: 0.85,
        game: verdict || null,
        reason: `${gameName} is starting and historically reaches play within seconds — holding Competitive through the launch rather than ramping late.`
      };
    }
    if (quiet || userAway) {
      return {
        label: "Competitive Gaming Rest",
        modeHint: "competitive",
        confidence: verdict ? 0.9 : 0.82,
        game: verdict || null,
        reason: userAway
          ? `${gameName} is in the foreground but you have been away ${Math.round(Number(telemetry?.input?.idleMinutes) || 0)} minutes — staying in Competitive and resting inside the 02-05 power band until play resumes.`
          : `${gameName} is in the foreground but idle (GPU ${Math.round(gpuUtil)}%, CPU ${Math.round(cpuLoadPct)}%) — staying in Competitive and resting inside the 02-05 power band until play resumes.`
      };
    }
    return {
      label: "Competitive Gaming Session",
      modeHint: "competitive",
      confidence: verdict ? 0.95 : 0.92,
      game: verdict || null,
      reason: verdict
        ? `${gameName} is active in the foreground (identified: ${verdict.reason || verdict.source}) — a game has a per-frame deadline, so frame stability and input latency come before efficiency.`
        : "A game is active in the foreground — gaming takes priority; favouring frame stability and input latency."
    };
  }

  if (telemetry?.input?.isExtendedIdle === true) {
    return {
      label: "Extended Inactivity",
      modeHint: "conservative",
      confidence: 0.74,
      posture: "inactivity",
      reason: `No keyboard/mouse input for ${Math.round(Number(telemetry.input.idleMinutes) || 0)} minutes — using Conservative as an away/idle power state.`
    };
  }

  const thermalPressure = THERMAL_SEVERITY_RANK[thermalState.severity] >= THERMAL_SEVERITY_RANK.hot;
  const memoryPressure = ramUsed >= 85;
  if (thermalPressure || memoryPressure) {
    const why = thermalPressure
      ? `temperature (${thermalState.summary})`
      : `memory pressure (RAM ${Math.round(ramUsed)}%)`;
    return {
      label: "Cooling Down-throttle",
      modeHint: "conservative",
      confidence: 0.66,
      posture: "cooling",
      reason: `Down-throttling to calm the PC and relieve ${why} — clocks/power lowered, running processes left untouched.`
    };
  }

  if (
    agenticActive
    || (state.modeId === "agentic" && !agenticIdleTooLong && cpuActiveDevTools.length >= 1)
  ) {
    return {
      label: "Agentic Work",
      modeHint: "agentic",
      confidence: state.modeId === "agentic" ? 0.9 : 0.72,
      reason: `AI/dev tooling working (${aiAppsPresent} AI app(s) present, ${aiAppsActive} active, ${cpuActiveDevTools.length} tool(s) using CPU${focusedDevTool ? ", one foreground" : ""}) — protecting agents with memory-aware headroom.`
    };
  }

  const heavy = classifyHeavyForegroundLoad(telemetry, {
    computeApp,
    priorityRunning,
    priorityCpu,
    priorityRamMB: Number(priorityProc.workingSetMB)
      || (priorityName ? sumProcessRamMB(telemetry, [priorityName]) : 0),
    priorityName,
    gpuUtil
  });
  if (heavy) {
    return heavy;
  }

  if (aiPresenceAgentic) {
    return {
      label: "Agentic Work",
      modeHint: "agentic",
      confidence: 0.6,
      reason: `${aiAppsPresent} AI applications open in the background — Agentic posture with memory-aware headroom.`
    };
  }

  const context = classifyForegroundContext(telemetry);
  if (context) {
    return context;
  }

  if (cpuLoadPct <= 12) {
    return {
      label: "Idle Desktop",
      modeHint: "balanced",
      confidence: 0.5,
      reason: `System is idle (CPU ${Math.round(cpuLoadPct)}%) — Balanced default; power floats low inside the Balanced band.`
    };
  }
  return {
    label: "Desktop",
    modeHint: "balanced",
    confidence: 0.5,
    reason: `General desktop use (CPU ${Math.round(cpuLoadPct)}%) — balanced daily-driver posture.`
  };
}

export function classifyHeavyForegroundLoad(telemetry = {}, {
  computeApp = false,
  priorityRunning = false,
  priorityCpu = 0,
  priorityRamMB = 0,
  priorityName = "",
  gpuUtil = 0
} = {}) {
  const fg = telemetry?.foreground || {};
  const name = normalizeProcessName(fg.name);
  const title = String(fg.title || "").toLowerCase();

  if (priorityRunning && computeApp) {
    return {
      label: "Heavy Compute",
      modeHint: "performance",
      confidence: 0.78,
      reason: `Sustained compute/creative workload (${priorityName || fg.name || "foreground app"}) — full performance, no overdrive.`
    };
  }
  if (priorityRunning && priorityCpu >= 60 && gpuUtil < 10) {
    return {
      label: "Heavy Compute",
      modeHint: "performance",
      confidence: 0.7,
      reason: `Sustained CPU-bound workload (${priorityName || "foreground app"}) with little GPU use — full performance.`
    };
  }

  const isBrowser = BROWSER_APPS.some((app) => name.includes(app));
  const isMediaPlayer = MEDIA_PLAYER_APPS.some((app) => name.includes(app) || title.includes(app));
  const videoTitle = VIDEO_TITLE_HINTS.some((hint) => title.includes(hint));
  const browserRamMB = sumProcessRamMB(telemetry, BROWSER_APPS);

  if ((isMediaPlayer || (isBrowser && videoTitle)) && (gpuUtil >= 8 || browserRamMB >= 1500 || fg.fullscreen)) {
    return {
      label: "Media / Video",
      modeHint: "performance",
      confidence: 0.72,
      reason: `Active video playback in focus (${fg.name || "player"}) — 100% Performance for smooth, memory-hungry playback.`
    };
  }
  if (isBrowser && browserRamMB >= 2500) {
    return {
      label: "Heavy Browsing",
      modeHint: "performance",
      confidence: 0.68,
      reason: `Browser using ${Math.round(browserRamMB)} MB in the foreground — 100% Performance for heavy pages.`
    };
  }
  const windows = Number(fg.visibleWindows);
  if (Number.isFinite(windows) && windows > 3) {
    return {
      label: "Multitasking",
      modeHint: "performance",
      confidence: 0.66,
      reason: `${windows} application windows in use — 100% Performance for multitasking headroom.`
    };
  }
  if (priorityRunning && Number(priorityRamMB) >= 1500) {
    return {
      label: "Heavy Foreground Work",
      modeHint: "performance",
      confidence: 0.64,
      reason: `Active foreground app (${priorityName || fg.name || "app"}) using ${Math.round(Number(priorityRamMB))} MB — 100% Performance for memory-hungry work.`
    };
  }
  return null;
}

function sumProcessRamMB(telemetry = {}, parts = []) {
  const processes = Array.isArray(telemetry?.processes) ? telemetry.processes : [];
  let total = 0;
  for (const process of processes) {
    const n = normalizeProcessName(process?.name);
    if (parts.some((part) => n.includes(part))) {
      total += Number(process?.workingSetMB) || 0;
    }
  }
  return total;
}

const MEDIA_PLAYER_APPS = ["vlc", "mpc-hc", "mpc-be", "wmplayer", "movies & tv", "plex", "kodi"];
const BROWSER_APPS = ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "zen"];
const PRODUCTIVITY_APPS = [
  "winword", "excel", "powerpnt", "onenote", "outlook", "acrobat", "acrord32",
  "notepad", "wordpad", "obsidian", "notion", "code", "sumatrapdf", "foxit"
];
const VIDEO_TITLE_HINTS = ["youtube", "netflix", "twitch", "hulu", "disney+", "prime video", "vimeo", "- vlc", "hbo max", "crunchyroll"];

const COMPUTE_APPS = [
  "handbrake", "ffmpeg", "blender", "premiere", "afterfx", "aftereffects", "resolve", "davinci", "vegas", "topaz",
  "obs64", "obs", "cinebench", "prime95", "aida64", "y-cruncher", "ycruncher",
  "7z", "7zg", "7zfm", "winrar", "peazip", "nanazip",
  "autocad", "solidworks", "fusion360", "sketchup", "maya", "3dsmax", "cinema4d", "zbrush", "keyshot",
  "lightroom", "photoshop", "captureone",
  "msbuild", "cl.exe", "clang", "gcc", "g++", "rustc", "cargo", "cmake", "ninja", "link.exe", "devenv"
];

function classifyForegroundContext(telemetry) {
  const fg = telemetry?.foreground;
  if (!fg || !fg.name) {
    return null;
  }
  const name = normalizeProcessName(fg.name);
  const title = String(fg.title || "").toLowerCase();
  const gpuUtil = Number(telemetry?.gpu?.utilizationPct) || 0;

  const isMediaPlayer = MEDIA_PLAYER_APPS.some((app) => name.includes(app) || title.includes(app));
  const isBrowser = BROWSER_APPS.some((app) => name.includes(app));
  const browserVideo = isBrowser && VIDEO_TITLE_HINTS.some((hint) => title.includes(hint));
  if (isMediaPlayer || (browserVideo && (fg.fullscreen || gpuUtil >= 12))) {
    return {
      label: "Media / Video",
      modeHint: "balanced",
      confidence: isMediaPlayer ? 0.8 : 0.66,
      reason: isMediaPlayer
        ? `Media player in focus (${fg.name}); favoring smooth, quiet playback.`
        : `Video playback in focus (${fg.name}); favoring smooth, quiet playback.`
    };
  }

  const isProductivity = PRODUCTIVITY_APPS.some((app) => name.includes(app));
  if (isProductivity) {
    return {
      label: "Focused Work",
      modeHint: "balanced",
      confidence: 0.62,
      reason: `Document/work app in focus (${fg.name}); Balanced daily-driver posture.`
    };
  }

  return null;
}

export function preferBandBeforeModeSwitch({
  posture = "context",
  currentMode = null,
  target = null,
  isSafety = false,
  resolvedModeId = null,
  resolvedTier = null,
  resolvedFloor = null,
  resolvedCeiling = null
} = {}) {
  if (!target || target === currentMode) {
    return { switchMode: false, reason: "no mode change requested" };
  }
  if (isSafety) {
    return { switchMode: true, reason: "safety downshift takes priority over the in-mode band" };
  }
  if (!["cooling", "recovery"].includes(posture)) {
    return { switchMode: true, reason: "workload/context change — mode switch is the right lever" };
  }
  const tier = Number(resolvedTier);
  const floor = Number(resolvedFloor);
  const ceiling = Number(resolvedCeiling);
  const sameMode = resolvedModeId != null && resolvedModeId === currentMode;
  if (posture === "recovery") {
    const bandCanRaise = sameMode && Number.isFinite(tier) && Number.isFinite(ceiling) && tier < ceiling;
    if (bandCanRaise) {
      return {
        switchMode: false,
        reason: `use the power plan within the current mode first — its band can still raise (tier ${tier} < ceiling ${ceiling})`
      };
    }
    return {
      switchMode: true,
      reason: "in-mode power band reached its ceiling — escalate to the recovered mode"
    };
  }
  const bandHasHeadroom = sameMode && Number.isFinite(tier) && Number.isFinite(floor) && tier > floor;
  if (bandHasHeadroom) {
    return {
      switchMode: false,
      reason: `use the power plan within the current mode first — its band can still lower (tier ${tier} > floor ${floor})`
    };
  }
  return {
    switchMode: true,
    reason: "in-mode power band is exhausted — escalate to a cooler mode"
  };
}

export function modeBandCeiling(modeId) {
  const ceiling = MODE_BANDS[modeId]?.ceiling;
  return Number.isFinite(Number(ceiling)) ? Number(ceiling) : null;
}

function buildBandFirstRecoveryHint({
  modeId,
  suggestedMode,
  priority,
  health,
  thermalState,
  telemetry,
  crashRecovery
} = {}) {
  if (process.env.PC_CONTROL_BAND_FIRST_RECOVERY !== "1") {
    return { active: false };
  }
  if (!suggestedMode || suggestedMode === modeId || suggestedMode === "overdrive") {
    return { active: false };
  }
  if (priority?.posture === "cooling" || telemetry?.priorityApp?.running || crashRecovery?.active) {
    return { active: false };
  }
  if (health?.state === "Strained" || thermalState?.severity !== "ok") {
    return { active: false };
  }
  if (thermalState?.recommendedAction && thermalState.recommendedAction !== "none") {
    return { active: false };
  }
  const currentCeiling = modeBandCeiling(modeId);
  const targetCeiling = modeBandCeiling(suggestedMode);
  if (!Number.isFinite(currentCeiling) || !Number.isFinite(targetCeiling) || targetCeiling <= currentCeiling) {
    return { active: false };
  }
  return {
    active: true,
    currentMode: modeId,
    targetMode: suggestedMode,
    currentCeiling,
    targetCeiling,
    reason: `stable recovery toward ${getMode(suggestedMode).label}; raise within ${getMode(modeId).label} first`
  };
}

export function evaluateHealth(telemetry, options = {}) {
  const reasons = [];
  const system = telemetry?.system || {};
  const gpu = telemetry?.gpu || {};
  const gamingSession = options.gamingSession === true;
  const thermalState = classifyThermalState(telemetry, options);
  const eventAnalysis = analyzeEvents(telemetry?.recentEvents || [], telemetry);
  const networkHealth = analyzeNetworkHealth(telemetry);
  const powerSystem = analyzePowerSystem(telemetry, options.modeId || "balanced");

  if (Number(system.cpuLoadPct) >= 90 && !gamingSession) {
    reasons.push(`CPU load is high at ${system.cpuLoadPct}%.`);
  }
  if (effectiveRamUsedPct(system) >= 90) {
    reasons.push(`RAM pressure is high at ${Math.round(effectiveRamUsedPct(system))}%.`);
  }
  if (THERMAL_SEVERITY_RANK[thermalState.severity] >= THERMAL_SEVERITY_RANK.warm) {
    reasons.push(`Thermal hierarchy is ${thermalState.severity}: ${thermalState.summary}.`);
  }
  if (Number(gpu.powerDrawW) > 0 && Number(gpu.powerLimitW) > 0) {
    const ratio = Number(gpu.powerDrawW) / Number(gpu.powerLimitW);
    if (ratio >= 0.95 && !gamingSession) {
      reasons.push("GPU is near its configured power limit.");
    }
  }

  if (eventAnalysis.recentCrashSignals.length > 0) {
    reasons.push(`${eventAnalysis.recentCrashSignals.length} recent crash signal(s) need attention.`);
  }
  if (eventAnalysis.hardwareSignals.length > 0) {
    reasons.push(`${eventAnalysis.hardwareSignals.length} recent hardware/driver signal(s) need attention.`);
  }
  if (networkHealth.state === "critical") {
    reasons.push(networkHealth.issues[0] || "Network health needs attention.");
  }
  if (powerSystem.state === "warning") {
    reasons.push(powerSystem.issues[0] || "Power capability check needs attention.");
  }

  if (THERMAL_SEVERITY_RANK[thermalState.severity] >= THERMAL_SEVERITY_RANK.critical) {
    return { state: "Strained", tone: "red", reasons };
  }
  if (reasons.length === 0) {
    return { state: "Stable", tone: "green", reasons: ["No immediate telemetry strain detected."] };
  }
  if (
    gamingSession &&
    eventAnalysis.recentActionableCrashSignals.length === 0 &&
    effectiveRamUsedPct(system) < 95
  ) {
    return { state: "Warm", tone: "amber", reasons };
  }
  if (reasons.length <= 2) {
    return { state: "Warm", tone: "amber", reasons };
  }
  return { state: "Strained", tone: "red", reasons };
}

const BUGCHECK_NAMES = Object.freeze({
  "0xa": "IRQL_NOT_LESS_OR_EQUAL",
  "0x1a": "MEMORY_MANAGEMENT",
  "0x1e": "KMODE_EXCEPTION_NOT_HANDLED",
  "0x3b": "SYSTEM_SERVICE_EXCEPTION",
  "0x50": "PAGE_FAULT_IN_NONPAGED_AREA",
  "0x7e": "SYSTEM_THREAD_EXCEPTION_NOT_HANDLED",
  "0x7f": "UNEXPECTED_KERNEL_MODE_TRAP",
  "0x9c": "MACHINE_CHECK_EXCEPTION",
  "0xc2": "BAD_POOL_CALLER",
  "0xd1": "DRIVER_IRQL_NOT_LESS_OR_EQUAL",
  "0xef": "CRITICAL_PROCESS_DIED",
  "0x101": "CLOCK_WATCHDOG_TIMEOUT",
  "0x109": "CRITICAL_STRUCTURE_CORRUPTION",
  "0x124": "WHEA_UNCORRECTABLE_ERROR",
  "0x133": "DPC_WATCHDOG_VIOLATION",
  "0x139": "KERNEL_SECURITY_CHECK_FAILURE"
});
const HARDWARE_BUGCHECKS = new Set(["0x124", "0x9c", "0x101"]);
const MEMORY_DRIVER_BUGCHECKS = new Set(["0x1a", "0x50", "0x1e", "0x3b", "0x7e", "0xa", "0xd1"]);

export function decodeBugcheck(message) {
  const codeRaw = String(message || "").match(/bugcheck was:\s*(0x[0-9a-fA-F]+)/i)?.[1] || null;
  if (!codeRaw) {
    return { code: null, name: null, accessViolation: false, likelyCause: "unknown" };
  }
  const code = `0x${codeRaw.slice(2).replace(/^0+/, "").toLowerCase() || "0"}`;
  const accessViolation = /c0000005/i.test(String(message));
  const name = BUGCHECK_NAMES[code] || null;
  let likelyCause;
  if (HARDWARE_BUGCHECKS.has(code)) {
    likelyCause = "hardware (CPU/memory/bus) — machine-check / WHEA class";
  } else if (MEMORY_DRIVER_BUGCHECKS.has(code) || accessViolation) {
    likelyCause = "a driver or unstable/failing RAM (access-violation / memory-management class)";
  } else {
    likelyCause = "a driver or kernel module";
  }
  return { code, name, accessViolation, likelyCause };
}

export function classifySystemEvent(event) {
  const provider = String(event.provider || "").toLowerCase();
  const message = String(event.message || "");
  const id = Number(event.id);
  const level = String(event.level || "").toLowerCase();
  const hasAccessViolationPattern = /exception[_\s-]*access[_\s-]*violation|read(?:ing)?\s+address|0xc0000005|c0000005|access violation/i.test(message);
  const applicationName = (
    message.match(/faulting application name:\s*([^,\r\n]*?\.exe)\b/i)?.[1] ||
    message.match(/faulting application name:\s*([^,.\r\n]+)/i)?.[1] ||
    ""
  ).trim() || null;
  const liveKernelCode = message.match(/(?:\bCode:|\bP1:)\s*(141|117)\b/i)?.[1]
    || message.match(/(?:LKD_0x|0x)(141|117)\b/i)?.[1]
    || null;
  const liveKernelGpuWatchdog =
    id === 1001 &&
    /windows error reporting|wer/i.test(provider) &&
    /livekernelevent|lkd_0x(?:141|117)|\b(?:Code|P1):\s*(?:141|117)\b|\b0x(?:141|117)\b|tdr|watchdog/i.test(message) &&
    /nvlddmkm|display|gpu|graphics|watchdog|tdr/i.test(message);

  if (liveKernelGpuWatchdog) {
    return {
      severity: "warning",
      category: "hardware-driver",
      subcategory: "nvidia-driver-reset",
      label: liveKernelCode
        ? `NVIDIA GPU driver reset/watchdog fault (${liveKernelCode})`
        : "NVIDIA GPU driver reset/watchdog fault",
      liveKernelCode,
      activeWorkloadRelated: true,
      guidance: "Windows recorded a GPU watchdog/TDR fault. Capture the dump and event timeline, contain the foreground workload with existing safe mode/power-band handlers, and warn on overlay/cache churn. No driver install/uninstall, BIOS, firmware, voltage, fan, process-kill, or dump-file mutation is taken automatically."
    };
  }
  if (provider.includes("nvlddmkm") && [13, 14, 153].includes(id)) {
    return {
      severity: "warning",
      category: "hardware-driver",
      subcategory: "nvidia-driver-reset",
      label: `GPU driver reset/watchdog issue (${id})`,
      guidance: "Windows reported a GPU driver reset or watchdog event. Keep the last known failure signature visible, preserve the event timeline, and use safe containment only; the control plane does not install/uninstall drivers or change firmware, BIOS, fans, voltage, or running processes."
    };
  }
  if ((provider === "display" || provider.includes("display")) && id === 4101) {
    return {
      severity: "warning",
      category: "hardware-driver",
      subcategory: "nvidia-driver-reset",
      label: "GPU driver reset/watchdog issue",
      guidance: "Windows reported a display driver timeout or reset. Keep the last known failure signature visible and use safe containment instead of driver, firmware, voltage, fan, or process-kill actions."
    };
  }
  if (provider.includes("wer-systemerrorreporting") && id === 1001) {
    const bc = decodeBugcheck(message);
    const named = bc.name ? `${bc.code} ${bc.name}` : (bc.code ? `Bugcheck ${bc.code}` : "Bugcheck");
    return {
      severity: "critical",
      category: "crash",
      subcategory: "bugcheck",
      label: bc.name ? `Bugcheck ${named}` : named,
      bugcheckCode: bc.code,
      bugcheckName: bc.name,
      accessViolation: bc.accessViolation,
      systemWide: true,
      likelyCause: bc.likelyCause,
      guidance: `Real kernel crash (${named}); likely ${bc.likelyCause}. Preserve MEMORY.DMP/minidump and hold a conservative posture; analyze with WinDbg "!analyze -v" to name the faulting module, and for the access-violation/memory pattern also test RAM (Windows Memory Diagnostic / MemTest86) and review recent driver or EXPO/XMP changes. The control plane preserves evidence and down-throttles only; it never modifies drivers, firmware, or RAM timings.`
    };
  }
  if (provider.includes("application error") && id === 1000 && hasAccessViolationPattern) {
    return {
      severity: "critical",
      category: "crash",
      subcategory: "application-access-violation",
      label: "Application access violation",
      applicationName,
      activeWorkloadRelated: false,
      guidance: "App-level access violation. Correlate the faulting executable with the active workload before changing modes."
    };
  }
  if (provider.includes(".net runtime") && id === 1026) {
    return {
      severity: "warning",
      category: "app-failure",
      subcategory: "dotnet-unhandled-exception",
      label: ".NET app failure",
      guidance: "Refresh the helper only if it repeats or affects the active profile."
    };
  }
  if (provider.includes("kernel-power") && id === 41) {
    return {
      severity: "critical",
      category: "crash",
      subcategory: "unexpected-restart",
      label: "Unexpected power/crash reboot",
      systemWide: true,
      guidance: "This confirms Windows did not shut down cleanly. It is an effect, not the root cause."
    };
  }
  if (provider === "eventlog" && id === 6008) {
    return {
      severity: "critical",
      category: "crash",
      label: "Unexpected shutdown",
      systemWide: true,
      guidance: "This is paired evidence for the crash timeline."
    };
  }
  if (provider.includes("volmgr") && id === 162) {
    return {
      severity: "info",
      category: "dump",
      subcategory: "dump-created",
      label: "Dump file created",
      guidance: "Useful evidence. Not a root cause by itself."
    };
  }
  if (provider === "disk" || provider.includes("stornvme") || provider.includes("storport") || provider.includes("ntfs")) {
    return {
      severity: "warning",
      category: "storage",
      subcategory: "storage-warning",
      label: "Storage warning",
      guidance: "Correlate with cache, dump, and storage access around the failure time."
    };
  }
  if (provider.includes("whea") || provider.includes("nvlddmkm") || provider.includes("display")) {
    return {
      severity: "warning",
      category: "hardware-driver",
      subcategory: provider.includes("nvlddmkm") ? "nvidia-driver-reset" : "hw-driver-event",
      label: provider.includes("nvlddmkm") ? "GPU driver reset/watchdog issue" : "Hardware/driver warning",
      guidance: "Correlate with crash time, GPU driver, RAM, PCIe, and thermals."
    };
  }
  if (provider.includes("service control manager") && [7000, 7009, 7023, 7031, 7034, 7043].includes(id)) {
    return {
      severity: "warning",
      category: "service-failure",
      subcategory: "service-control-manager",
      label: "Windows service failure",
      guidance: "Track the service name and repetition before adding automation."
    };
  }
  if (provider.includes("distributedcom") && id === 10016) {
    return {
      severity: "low",
      category: "windows-noise",
      subcategory: "dcom-perm",
      label: "Common DCOM permission warning",
      guidance: "Usually benign Windows permission noise unless an app failure points back to the same CLSID/APPID."
    };
  }
  if (level.includes("critical") || level.includes("error")) {
    return {
      severity: "warning",
      category: "system",
      subcategory: "system-error",
      label: "System error",
      guidance: "Review if it repeats or matches a crash/app failure timestamp."
    };
  }
  return {
    severity: "low",
    category: "system",
    subcategory: "system-warning",
    label: "System warning",
    guidance: "Watch for repetition or correlation with user-visible failure."
  };
}

function eventAgeSeconds(event) {
  const ts = Date.parse(String(event.time || ""));
  if (!Number.isFinite(ts)) {
    return null;
  }
  const ageMs = Date.now() - ts;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return null;
  }
  return Math.round(ageMs / 1000);
}

function isFreshEvent(event, maxMinutes = 45) {
  const ageSec = event.ageSeconds;
  return Number.isFinite(ageSec) && ageSec >= 0 && ageSec <= maxMinutes * 60;
}

function getCrashRecoveryMode(currentModeId, eventAnalysis) {
  const hasFreshActiveWorkloadCrash = (eventAnalysis.recentActiveWorkloadCrashSignals || []).length > 0;
  const hasFreshSystemWideCrash = (eventAnalysis.recentSystemWideCrashSignals || []).length > 0;
  if (!hasFreshActiveWorkloadCrash && !hasFreshSystemWideCrash) {
    return null;
  }
  if (["competitive", "agentic", "performance", "overdrive"].includes(currentModeId)) {
    return "balanced";
  }
  if (currentModeId === "balanced") {
    return "conservative";
  }
  return null;
}

function executableIdentity(value) {
  const leaf = String(value || "").trim().replace(/^['"]|['"]$/g, "").split(/[\\/]/).pop() || "";
  return leaf.toLowerCase().replace(/\.exe$/i, "");
}

function activeWorkloadExecutableNames(telemetry = {}) {
  const values = [
    telemetry?.game?.confirmed?.name,
    telemetry?.game?.confirmed?.path,
    telemetry?.priorityApp?.process?.name,
    telemetry?.priorityApp?.process?.path,
    telemetry?.foreground?.name,
    telemetry?.foreground?.path
  ];
  const generic = new Set(["foreground workload", "foreground", "unknown"]);
  return new Set(values.map(executableIdentity).filter((value) => value && !generic.has(value)));
}

function correlateActiveWorkloadCrash(analysis, telemetry = {}) {
  if (analysis?.systemWide === true || analysis?.activeWorkloadRelated === true && !analysis?.applicationName) {
    return analysis?.activeWorkloadRelated === true;
  }
  const crashedApp = executableIdentity(analysis?.applicationName);
  if (!crashedApp) {
    return false;
  }
  return activeWorkloadExecutableNames(telemetry).has(crashedApp);
}

export function analyzeEvents(events = [], telemetry = {}) {
  const list = Array.isArray(events) ? events : (events == null ? [] : [events]);
  const enriched = list.map((event) => {
    const classified = classifySystemEvent(event);
    const activeWorkloadRelated = correlateActiveWorkloadCrash(classified, telemetry);
    const analysis = classified?.subcategory === "application-access-violation" && activeWorkloadRelated
      ? {
          ...classified,
          subcategory: "foreground-access-violation",
          label: "Foreground access violation",
          activeWorkloadRelated: true
        }
      : { ...classified, activeWorkloadRelated };
    return {
      ...event,
      ageSeconds: eventAgeSeconds(event),
      analysis
    };
  });

  const crashSignals = enriched.filter((event) => event.analysis.category === "crash");
  const recentCrashSignals = crashSignals.filter((event) => isFreshEvent(event));
  const recentActiveWorkloadCrashSignals = recentCrashSignals.filter((event) => event.analysis?.activeWorkloadRelated);
  const recentSystemWideCrashSignals = recentCrashSignals.filter((event) => event.analysis?.systemWide === true);
  const recentActionableCrashSignals = recentCrashSignals.filter((event) =>
    event.analysis?.activeWorkloadRelated === true || event.analysis?.systemWide === true
  );
  const displayDriverSignals = enriched.filter((event) =>
    event.analysis.category === "hardware-driver" &&
    ["nvidia-driver-reset", "nvidia-driver-event"].includes(event.analysis.subcategory)
  );

  return {
    all: enriched,
    crashSignals,
    recentCrashSignals,
    recentActiveWorkloadCrashSignals,
    recentSystemWideCrashSignals,
    recentActionableCrashSignals,
    hardwareSignals: enriched.filter((event) => event.analysis.category === "hardware-driver"),
    displayDriverSignals,
    appFailureSignals: enriched.filter((event) => event.analysis.category === "app-failure"),
    serviceSignals: enriched.filter((event) => event.analysis.category === "service-failure"),
    storageSignals: enriched.filter((event) => event.analysis.category === "storage"),
    lowPriority: enriched.filter((event) => event.analysis.severity === "low"),
    dumpSignals: enriched.filter((event) => event.analysis.category === "dump")
  };
}

function groupReachability(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  return entries.some((entry) => entry.reachable === true);
}

export function analyzeNetworkHealth(telemetry = {}) {
  const network = telemetry.network || {};
  const adapters = Array.isArray(network.adapters) ? network.adapters : [];
  const activeAdapter = network.activeAdapter || adapters[0] || null;
  const latency = network.latency || {};
  const dns = network.dns || {};
  const reachability = network.reachability || {};
  const bandwidthHeavyApps = Array.isArray(network.bandwidthHeavyApps) ? network.bandwidthHeavyApps : [];
  const usableEcho = (!latency.status || latency.status === "measured") && latency.received !== 0;
  const packetLossPct = usableEcho && Number.isFinite(latency.packetLossPct) ? latency.packetLossPct : null;
  const latencyMs = usableEcho && Number.isFinite(latency.averageMs) ? latency.averageMs : null;
  const dnsOk = Array.isArray(dns.tests) && dns.tests.length ? dns.tests.every((test) => test.ok) : null;
  const webReachable = groupReachability(reachability.web);
  const serviceReachable = groupReachability(reachability.service);
  const vpnActive = Boolean(network.vpn?.active);
  const telemetryError = telemetry.error || network.error || null;
  const captureIncomplete = Boolean(telemetryError && !activeAdapter && adapters.length === 0);
  const ethernetAvailable = adapters.some((adapter) => adapter.ConnectionType === "Ethernet" || adapter.connectionType === "Ethernet");
  const activeType = activeAdapter?.ConnectionType || activeAdapter?.connectionType || null;
  const issues = [];
  const actions = [];

  if (captureIncomplete) {
    issues.push("Network telemetry probe failed; adapter state could not be verified.");
    actions.push({ id: "network.inspect-adapter", label: "Inspect active adapter", trustLevel: "observe" });
  } else if (!activeAdapter) {
    issues.push("No active network adapter was detected.");
    actions.push({ id: "network.inspect-adapter", label: "Inspect active adapter", trustLevel: "observe" });
  }
  if (dnsOk === false) {
    issues.push("DNS resolution failed for public service endpoints.");
    actions.push({ id: "network.detect-dns-failure", label: "Detect DNS failure", trustLevel: "observe" });
  }
  if (packetLossPct !== null && packetLossPct >= 25) {
    issues.push(`Packet loss is high at ${packetLossPct}%.`);
    actions.push({ id: "network.pause-downloaders", label: "Pause background launchers/downloaders", trustLevel: "recommend" });
  }
  if (latencyMs !== null && latencyMs >= 90) {
    issues.push(`Latency is high at ${latencyMs} ms.`);
  }
  if (webReachable === false) {
    issues.push("Web reachability checks are failing.");
  }
  if (serviceReachable === false) {
    issues.push("Service endpoint reachability failed.");
  }
  if (vpnActive && ((latencyMs !== null && latencyMs >= 60) || (packetLossPct !== null && packetLossPct > 0))) {
    issues.push("VPN is active while latency or packet loss is elevated.");
    actions.push({ id: "network.warn-vpn-latency", label: "Warn if VPN is hurting latency", trustLevel: "observe" });
  }
  if (ethernetAvailable && activeType && activeType !== "Ethernet") {
    actions.push({ id: "network.prioritize-ethernet", label: "Prioritize Ethernet", trustLevel: "elevated" });
  }
  if (bandwidthHeavyApps.length > 0) {
    actions.push({ id: "network.review-bandwidth-apps", label: "Review bandwidth-heavy apps", trustLevel: "recommend" });
  }
  if ((dnsOk === false || packetLossPct === 100) && activeAdapter) {
    actions.push({ id: "network.reset-adapter-confirmed", label: "Reset adapter only after confirmation", trustLevel: "elevated" });
  }

  const state = captureIncomplete
    ? "warning"
    : !activeAdapter || dnsOk === false || (packetLossPct !== null && packetLossPct >= 50)
    ? "critical"
    : issues.length
      ? "warning"
      : "good";

  return {
    state,
    tone: state === "critical" ? "red" : state === "warning" ? "amber" : "green",
    activeAdapter,
    latencyMs,
    packetLossPct,
    dnsOk,
    webReachable,
    serviceReachable,
    vpnActive,
    bandwidthHeavyApps,
    telemetryError: telemetryError ? String(telemetryError) : null,
    issues,
    actions
  };
}

function activePowerPlanName(power = {}) {
  return String(power.activeLine || "").match(/\((.*)\)/)?.[1] || null;
}

const FOREGROUND_CONTENTION_IGNORE = [
  "applicationframehost",
  "ctfmon",
  "dwm",
  "explorer",
  "lockapp",
  "searchhost",
  "shellexperiencehost",
  "sihost",
  "startmenuexperiencehost",
  "systemsettings",
  "textinputhost",
  "winlogon"
];

const FOREGROUND_CONTENTION_APPS = [
  ...BROWSER_APPS,
  "discord",
  "epicgameslauncher",
  "gamebar",
  "ms-teams",
  "nvidia app",
  "nvcontainer",
  "obs",
  "slack",
  "steam",
  "steamwebhelper",
  "teams",
  "widgets",
  "xboxgamebar"
];

function foregroundContentionCandidate(telemetry = {}) {
  const fg = telemetry.foreground || {};
  if (!fg.name || isPriorityAppProcessName(fg.name)) {
    return null;
  }

  const priorityAppPid = Number(telemetry.priorityApp?.process?.pid);
  if (Number.isFinite(priorityAppPid) && Number(fg.pid) === priorityAppPid) {
    return null;
  }

  const normalized = normalizeProcessName(fg.name);
  if (isProtectedProcess(normalized)) {
    return null;
  }
  if (FOREGROUND_CONTENTION_IGNORE.some((name) => normalized.includes(name))) {
    return null;
  }

  const process = (telemetry.processes || []).find((entry) => Number(entry.pid) === Number(fg.pid))
    || (telemetry.processes || []).find((entry) => normalizeProcessName(entry.name) === normalized)
    || {};
  const knownContentionApp = FOREGROUND_CONTENTION_APPS.some((name) => normalized.includes(name));
  const workingSetMB = Number(process.workingSetMB);
  const cpuSeconds = Number(process.cpuSeconds);

  return {
    name: fg.name,
    pid: Number.isFinite(Number(fg.pid)) ? Number(fg.pid) : null,
    title: fg.title || null,
    fullscreen: Boolean(fg.fullscreen),
    knownContentionApp,
    workingSetMB: Number.isFinite(workingSetMB) ? workingSetMB : null,
    cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : null
  };
}

function priorityAppProcessFor(telemetry = {}) {
  return telemetry.priorityApp?.process
    || (telemetry.processes || []).find((process) => isPriorityAppProcessName(process.name))
    || null;
}

export function analyzePowerSystem(telemetry = {}, modeId = "balanced") {
  const power = telemetry.power || {};
  const gpu = telemetry.gpu || {};
  const system = telemetry.system || {};
  const activePlan = activePowerPlanName(power);
  const boost = power.processorBoost || {};
  const processorState = power.processorState || {};
  const usb = power.usbSelectiveSuspend || {};
  const throttle = String(gpu.throttleReasonsActive || gpu.throttleReason || "").toLowerCase();
  const draw = Number(gpu.powerDrawW);
  const limit = Number(gpu.powerLimitW);
  const temp = Number(gpu.temperatureC);
  const gpuUtil = Number(gpu.utilizationPct);
  const cpuLoad = Number(system.cpuLoadPct);
  const priorityAppProcess = priorityAppProcessFor(telemetry);
  const priorityAppCpuPct = Number(priorityAppProcess?.cpuPct);
  const gpuDominant = Number.isFinite(gpuUtil) && Number.isFinite(priorityAppCpuPct) && gpuUtil > priorityAppCpuPct;
  const powerRatio = Number.isFinite(draw) && Number.isFinite(limit) && limit > 0 ? draw / limit : null;
  const performanceMode = ["performance", "competitive", "overdrive"].includes(modeId);
  const gpuPowerLimited = Boolean((powerRatio !== null && powerRatio >= 0.95) || throttle.includes("power"));
  const gpuThermalLimited = Boolean((Number.isFinite(temp) && temp >= 82) || throttle.includes("thermal"));
  const underfeedCandidate = Boolean(
    telemetry.priorityApp?.running &&
    Number.isFinite(gpuUtil) &&
    (gpuUtil < 65 || (Number.isFinite(priorityAppCpuPct) && !gpuDominant)) &&
    !gpuPowerLimited &&
    !gpuThermalLimited
  );
  const cpuUnderfed = Boolean(underfeedCandidate && (
    Number.isFinite(priorityAppCpuPct)
      ? priorityAppCpuPct >= Math.max(55, gpuUtil)
      : Number.isFinite(cpuLoad) && cpuLoad >= 85
  ));
  const backgroundCpuContention = Boolean(
    underfeedCandidate &&
    Number.isFinite(priorityAppCpuPct) &&
    Number.isFinite(cpuLoad) &&
    cpuLoad >= 85 &&
    priorityAppCpuPct < Math.max(55, gpuUtil)
  );
  const foregroundContention = underfeedCandidate ? foregroundContentionCandidate(telemetry) : null;
  const gpuUnderfed = Boolean(cpuUnderfed || backgroundCpuContention || foregroundContention);
  const pstate = String(gpu.pstate || "").toUpperCase();
  const gpuPerformanceStateOk = !telemetry.priorityApp?.running || !pstate || ["P0", "P2"].includes(pstate);
  const issues = [];
  const actions = [];

  if (performanceMode && activePlan && !/High Power|Ultra Performance/i.test(activePlan)) {
    issues.push(`Active power plan is ${activePlan}, not a performance plan.`);
    actions.push({ id: "power.switch-plan", label: "Switch Windows power plan", trustLevel: "auto-safe" });
  }
  if (performanceMode && boost.acLabel === "disabled") {
    issues.push("Processor boost is disabled on AC power.");
    actions.push({ id: "power.apply-processor-boost", label: "Apply processor boost policy", trustLevel: "elevated" });
  }
  if (performanceMode && Number(processorState.minAc) > 25) {
    issues.push(`Processor minimum state is ${processorState.minAc}% on AC; lower it to 5-10% so idle/background work can back off.`);
    actions.push({ id: "power.lower-processor-minimum", label: "Lower processor minimum state", trustLevel: "elevated" });
  }
  if (performanceMode && Number.isFinite(Number(processorState.maxAc)) && Number(processorState.maxAc) < 100) {
    issues.push(`Processor maximum state is ${processorState.maxAc}% on AC; set it to 100% for unrestricted boost headroom.`);
    actions.push({ id: "power.restore-processor-maximum", label: "Restore processor maximum state", trustLevel: "elevated" });
  }
  if (modeId === "competitive" && usb.acLabel === "enabled") {
    issues.push("USB selective suspend is enabled during a competitive gaming session.");
    actions.push({ id: "power.prevent-usb-selective-suspend", label: "Prevent USB selective suspend during high load", trustLevel: "elevated" });
  }
  if (!gpuPerformanceStateOk) {
    issues.push(`GPU performance state is ${gpu.pstate || "unknown"} during an active ${getMode(modeId).label} session.`);
    actions.push({ id: "power.keep-gpu-performance-state", label: "Keep GPU in correct performance state", trustLevel: "recommend" });
  }
  if (gpuPowerLimited) {
    issues.push("GPU appears power-limited.");
  }
  if (gpuThermalLimited) {
    issues.push("GPU appears thermal-limited.");
  }
  if (cpuUnderfed) {
    const comparedCpu = Number.isFinite(priorityAppCpuPct) ? priorityAppCpuPct : cpuLoad;
    issues.push(`Active workload looks CPU-fed: GPU load is ${Math.round(gpuUtil)}% while workload CPU is ${Math.round(comparedCpu)}%.`);
    actions.push({ id: "power.gpu-feed-bias", label: "Bias frame delivery toward GPU", trustLevel: "recommend" });
  }
  if (backgroundCpuContention) {
    issues.push(`GPU may be underfed by background CPU contention: total CPU is ${Math.round(cpuLoad)}% while workload CPU is ${Math.round(priorityAppCpuPct)}%.`);
    actions.push({ id: "power.reduce-background-cpu-contention", label: "Review background CPU contention", trustLevel: "recommend" });
  }
  if (foregroundContention) {
    issues.push(`GPU may be underfed by foreground contention: ${foregroundContention.name} is in focus during the competitive gaming session.`);
    actions.push({ id: "power.reduce-foreground-contention", label: "Reduce foreground contention", trustLevel: "recommend" });
  }

  return {
    state: issues.length ? "warning" : "good",
    tone: issues.length ? "amber" : "green",
    activePlan,
    processorBoost: boost,
    processorState,
    usbSelectiveSuspend: usb,
    gpuPerformanceState: gpu.pstate || null,
    gpuPowerLimited,
    gpuThermalLimited,
    gpuDominant: Number.isFinite(priorityAppCpuPct) ? gpuDominant : null,
    priorityAppCpuPct: Number.isFinite(priorityAppCpuPct) ? priorityAppCpuPct : null,
    totalCpuLoadPct: Number.isFinite(cpuLoad) ? cpuLoad : null,
    cpuUnderfed,
    backgroundCpuContention,
    foregroundContention,
    gpuUnderfed,
    gpuFeedBiasActive: gpuUnderfed,
    powerRatio: powerRatio === null ? null : Number(powerRatio.toFixed(3)),
    issues,
    actions
  };
}

function gpuFeedBiasCandidate(process, telemetry = {}, options = {}) {
  if (!options.gpuFeedBias) {
    return null;
  }

  const foreground = options.foregroundContention || null;
  if (
    foreground &&
    ((foreground.pid && Number(process.pid) === Number(foreground.pid)) ||
      normalizeProcessName(process.name) === normalizeProcessName(foreground.name))
  ) {
    return "foreground contention while GPU is CPU-fed";
  }

  const hazard = backgroundHazards.find((entry) => processMatches(process, entry.match));
  if (!hazard) {
    return null;
  }

  const cpuSeconds = Number(process.cpuSeconds);
  const workingSetMB = Number(process.workingSetMB);
  const cpuPct = Number(process.cpuPct);
  if (
    (Number.isFinite(cpuPct) && cpuPct >= 8) ||
    (Number.isFinite(cpuSeconds) && cpuSeconds >= 1800 && Number.isFinite(workingSetMB) && workingSetMB >= 1800)
  ) {
    return "background contention while GPU is CPU-fed";
  }

  return null;
}

export function findOffenders(telemetry, modeId = "balanced", appReputation = null, options = {}) {
  const processes = telemetry?.processes || [];
  const mode = getMode(modeId);
  const memoryThresholdMb = mode.id === "agentic" ? 4096 : 1800;

  return processes
    .filter((process) => !isProtectedProcess(process.name, mode.id))
    .map((process) => ({
      process,
      reputation: reputationForProcess(process, appReputation),
      gpuFeedReason: gpuFeedBiasCandidate(process, telemetry, options)
    }))
    .filter(({ reputation }) => reputation?.userDecision !== "allow")
    .filter(({ process, reputation, gpuFeedReason }) =>
      Number(process.workingSetMB) >= memoryThresholdMb ||
      Number(process.cpuSeconds) >= 1800 ||
      ["suspect", "blocked-this-session"].includes(reputation?.state) ||
      Boolean(gpuFeedReason)
    )
    .slice(0, 12)
    .map(({ process, reputation, gpuFeedReason }) => {
      const hazard = backgroundHazards.find((entry) => processMatches(process, entry.match));
      const reputationAction = reputation?.state === "blocked-this-session"
        ? "temporary caution active; keep advisory-only"
        : reputation?.state === "suspect"
          ? "learned suspect; review before allowing in this mode"
          : null;
      return {
        name: process.name,
        pid: process.pid,
        path: process.path || null,
        workingSetMB: process.workingSetMB,
        cpuPct: process.cpuPct ?? null,
        cpuSeconds: process.cpuSeconds,
        classification: reputationAction ? "learned app reputation" : hazard ? "known background load" : "resource-heavy process",
        gpuFeedBias: gpuFeedReason
          ? {
              active: true,
              reason: gpuFeedReason
            }
          : null,
        reputation: reputation
          ? {
              key: reputation.key,
              state: reputation.state,
              confidence: reputation.confidence,
              expiresAt: reputation.expiresAt,
              userDecision: reputation.userDecision || null
            }
          : null,
        suggestedAction: reputationAction || (gpuFeedReason
          ? "GPU feed bias: unrelated contention may be affecting responsiveness"
          : (
            mode.id === "competitive"
              ? hazard?.competitiveAction || "observe during competitive gaming sessions"
              : hazard?.agenticAction || "observe, then refresh only if repeated"
          ))
      };
    });
}

export function evaluatePolicy(telemetry, state = {}) {
  const mode = getMode(state.modeId);
  const gamingSession = mode.id === "competitive" && Boolean(telemetry?.priorityApp?.running);
  const thermalState = classifyThermalState(telemetry, {
    modeId: mode.id,
    foregroundActive: Boolean(telemetry?.priorityApp?.running),
    gamingSession
  });
  const priority = classifyPriority(telemetry, state);
  const health = evaluateHealth(telemetry, { modeId: mode.id, gamingSession });
  const eventAnalysis = analyzeEvents(telemetry?.recentEvents || [], telemetry);
  const failureWatchlist = buildFailureWatchlist({ telemetry, eventAnalysis });
  const failureDiagnostics = buildFailureDiagnostics({ telemetry, eventAnalysis, watchlist: failureWatchlist });
  const networkHealth = analyzeNetworkHealth(telemetry);
  const powerSystem = analyzePowerSystem(telemetry, mode.id);
  const appReputation = state.appReputation || state.learning?.appReputation || null;
  const learningInfluence = state.learningInfluence !== false;
  const offenders = findOffenders(telemetry, mode.id, appReputation, {
    gpuFeedBias: powerSystem.gpuFeedBiasActive,
    foregroundContention: powerSystem.foregroundContention
  });
  const crashRecovery = {
    active: (eventAnalysis.recentCrashSignals || []).length > 0,
    sourceSignals: eventAnalysis.recentCrashSignals.length,
    sourceSignalsActiveWorkload: eventAnalysis.recentActiveWorkloadCrashSignals.length,
    nextMode: getCrashRecoveryMode(mode.id, eventAnalysis),
    reason: "No recent crash signals detected."
  };
  if (crashRecovery.active) {
    crashRecovery.reason = `${crashRecovery.sourceSignals} recent crash signal(s) in the last 45m.`;
  }
  const suggestedMode = state.pinned ? mode.id : crashRecovery.nextMode || priority.modeHint;
  const bandFirstRecovery = buildBandFirstRecoveryHint({
    modeId: mode.id,
    suggestedMode,
    priority,
    health,
    thermalState,
    telemetry,
    crashRecovery
  });
  const failureRemediation = buildFailureRemediation({
    modeId: mode.id,
    failureWatchlist,
    failureDiagnostics,
    learning: state.learning || null,
    learningInfluence
  });
  const failurePrevention = buildFailurePrevention({
    modeId: mode.id,
    suggestedMode,
    failureWatchlist,
    remediation: failureRemediation,
    learning: state.learning || null,
    learningInfluence
  });
  const failureProactivePrevention = buildFailureProactivePrevention({
    modeId: mode.id,
    failureWatchlist,
    failureDiagnostics,
    eventAnalysis,
    networkHealth,
    powerSystem,
    thermalState,
    learning: state.learning || null,
    learningInfluence
  });

  const recommendedActions = [];
  if (mode.id !== suggestedMode && !state.pinned) {
    recommendedActions.push({
      id: "switch-mode",
      label: `Switch to ${getMode(suggestedMode).label}`,
      reason: priority.reason,
      dryRunOnly: false
    });
  }
  if (offenders.length > 0) {
    recommendedActions.push({
      id: "review-offenders",
      label: "Review resource-heavy background work",
      reason: `${offenders.length} process(es) crossed the current mode threshold.`,
      dryRunOnly: true
    });
  }
  if (health.state === "Strained") {
    recommendedActions.push({
      id: "calm-down",
      label: "Calm down one mode",
      reason: "Thermal, memory, event, or CPU pressure is too high.",
      dryRunOnly: false
    });
  }
  if (networkHealth.state !== "good") {
    recommendedActions.push({
      id: "network-health",
      label: "Network health check",
      reason: networkHealth.issues[0] || "Network telemetry needs review.",
      dryRunOnly: true
    });
  }
  if (powerSystem.state !== "good") {
    recommendedActions.push({
      id: "power-capability",
      label: "Power capability check",
      reason: powerSystem.issues[0] || "Power policy telemetry needs review.",
      dryRunOnly: true
    });
  }
  if (powerSystem.gpuFeedBiasActive) {
    recommendedActions.push({
      id: "gpu-feed-bias",
      label: "Keep high-load work GPU-dominant",
      reason: powerSystem.foregroundContention
        ? `Reduce foreground contention from ${powerSystem.foregroundContention.name}.`
        : powerSystem.backgroundCpuContention
          ? "Background CPU contention may be starving the GPU."
          : "The active workload GPU load is not above its CPU load.",
      dryRunOnly: true
    });
  }
  const advisoryReputationEntries = reputationEntries(appReputation)
    .filter((entry) => !isProtectedReputationEntry(entry, mode.id));
  const suspectApps = advisoryReputationEntries.filter((entry) => ["suspect", "blocked-this-session"].includes(entry.state));
  const allowSuggestions = advisoryReputationEntries.filter((entry) => ["probation-allow", "trusted-suggested"].includes(entry.state));
  const actionableAllowSuggestions = allowSuggestions.filter((entry) =>
    entry.identityConfidence === "high" &&
    entry.state === "trusted-suggested" &&
    Number(entry.confidence) >= 85 &&
    Number(entry.cleanSessions) >= 5
  );
  if (suspectApps.length > 0) {
    recommendedActions.push({
      id: "learned-suspect-apps",
      label: "Review learned suspect apps",
      reason: `${suspectApps.length} learned app reputation rule(s) need review.`,
      dryRunOnly: true
    });
  }
  if (actionableAllowSuggestions.length > 0) {
    recommendedActions.push({
      id: "learned-allow-candidates",
      label: "Review learned allow candidates",
      reason: `${actionableAllowSuggestions.length} high-confidence app(s) look safe enough to consider allowing.`,
      dryRunOnly: true
    });
  }
  if (crashRecovery.active && crashRecovery.nextMode && mode.id !== crashRecovery.nextMode) {
    const nextMode = getMode(crashRecovery.nextMode);
    recommendedActions.unshift({
      id: "crash-recovery",
      label: `Crash recovery: shift to ${nextMode.label}`,
      reason: crashRecovery.reason,
      dryRunOnly: false
    });
  }
  if (failureWatchlist.fastPatchPlan.active) {
    const topFailure = failureWatchlist.active[0];
    recommendedActions.unshift({
      id: "failure-fast-patch",
      label: `Fast patch: ${topFailure?.label || "failure watch"}`,
      reason: failureWatchlist.fastPatchPlan.actions[0],
      dryRunOnly: !failureWatchlist.autoDownshift
    });
  }
  if (failureWatchlist.hardenedPatchPlan.active) {
    const topFailure = failureWatchlist.active[0];
    recommendedActions.push({
      id: "failure-hardened-patch",
      label: `Harden: ${topFailure?.label || "failure watch"}`,
      reason: failureWatchlist.hardenedPatchPlan.actions[0],
      dryRunOnly: true
    });
  }

  return {
    mode,
    priority,
    health,
    crashRecovery,
    eventAnalysis,
    failureWatchlist,
    failureDiagnostics,
    failureProactivePrevention,
    failurePrevention,
    failureRemediation,
    networkHealth,
    powerSystem,
    thermalState,
    bandFirstRecovery,
    fastPatchPlan: failureWatchlist.fastPatchPlan,
    hardenedPatchPlan: failureWatchlist.hardenedPatchPlan,
    offenders,
    suggestedMode,
    recommendedActions
  };
}
