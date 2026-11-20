
export const THERMAL_THRESHOLDS = Object.freeze({
  cpu: Object.freeze({ label: "CPU", warm: 80, hot: 85, critical: 90 }),
  gpu: Object.freeze({ label: "GPU", warm: 82, hot: 88, critical: 92 }),
  vram: Object.freeze({ label: "VRAM", warm: 88, hot: 96, critical: 102 }),
  storage: Object.freeze({ label: "Storage", warm: 62, hot: 72, critical: 80 })
});

const GAMING_CPU_THERMAL_BASE = Object.freeze({ warm: 85, hot: 88, critical: 90 });
export const GAMING_CPU_THERMAL_MULTIPLIER = 1.05;
const raisedGamingCpuThreshold = (value) =>
  Math.round(value * GAMING_CPU_THERMAL_MULTIPLIER * 100) / 100;
export const GAMING_CPU_THERMAL = Object.freeze({
  label: "CPU",
  warm: raisedGamingCpuThreshold(GAMING_CPU_THERMAL_BASE.warm),
  hot: raisedGamingCpuThreshold(GAMING_CPU_THERMAL_BASE.hot),
  critical: raisedGamingCpuThreshold(GAMING_CPU_THERMAL_BASE.critical)
});

function thresholdsForOptions(options = {}) {
  if (options.gamingSession) {
    return { ...THERMAL_THRESHOLDS, cpu: GAMING_CPU_THERMAL };
  }
  return THERMAL_THRESHOLDS;
}

export const THERMAL_SEVERITY_RANK = Object.freeze({
  unavailable: -1,
  ok: 0,
  warm: 1,
  hot: 2,
  critical: 3
});

export const THERMAL_ACTION_RANK = Object.freeze({
  none: 0,
  "hold-below-ceiling": 1,
  floor: 2,
  "balanced-downshift": 3,
  "conservative-cooldown": 4
});

const COMPONENT_ORDER = Object.freeze(["cpu", "gpu", "vram", "storage"]);
const OUTCOME_SEVERITIES = Object.freeze(["ok", "warm", "hot", "critical"]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundTemp(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function classifyReading(component, value, source = null, thresholdsMap = THERMAL_THRESHOLDS) {
  const thresholds = thresholdsMap[component] || THERMAL_THRESHOLDS[component];
  const tempC = finiteNumber(value);
  if (!thresholds || tempC == null) {
    return {
      component,
      label: thresholds?.label || component,
      tempC: null,
      source: source || null,
      severity: "unavailable",
      available: false,
      threshold: thresholds || null
    };
  }
  const severity =
    tempC >= thresholds.critical ? "critical" :
      tempC >= thresholds.hot ? "hot" :
        tempC >= thresholds.warm ? "warm" :
          "ok";
  return {
    component,
    label: thresholds.label,
    tempC: roundTemp(tempC),
    source: source || null,
    severity,
    available: true,
    threshold: thresholds
  };
}

function actionForSeverity(severity) {
  if (severity === "critical") return "conservative-cooldown";
  if (severity === "hot") return "floor";
  if (severity === "warm") return "hold-below-ceiling";
  return "none";
}

function actionForMode(baseAction, modeId, foregroundActive = false) {
  if (baseAction !== "conservative-cooldown") {
    return baseAction;
  }
  if (foregroundActive && ["overdrive", "performance", "competitive"].includes(modeId)) {
    return "balanced-downshift";
  }
  return "conservative-cooldown";
}

function worstComponent(components) {
  return Object.values(components)
    .filter((entry) => entry.available)
    .sort((a, b) => {
      const rankDelta = THERMAL_SEVERITY_RANK[b.severity] - THERMAL_SEVERITY_RANK[a.severity];
      if (rankDelta) return rankDelta;
      return COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component);
    })[0] || null;
}

function componentReadings(telemetry = {}) {
  const source = telemetry && typeof telemetry === "object" ? telemetry : {};
  const system = source.system || {};
  const gpu = source.gpu || {};
  const temps = source.temperatures || {};
  return {
    cpu: {
      tempC: finiteNumber(system.cpuTempC) ?? finiteNumber(system.systemTempC) ?? finiteNumber(temps.cpuC) ?? finiteNumber(temps.systemC),
      source: temps.cpuSource || temps.systemSource || null
    },
    gpu: {
      tempC: finiteNumber(gpu.temperatureC) ?? finiteNumber(temps.gpuC),
      source: temps.gpuSource || (finiteNumber(gpu.temperatureC) != null ? "nvidia-smi" : null)
    },
    vram: {
      tempC: finiteNumber(temps.gpuMemoryC),
      source: temps.gpuMemorySource || null
    },
    storage: {
      tempC: finiteNumber(system.storageTempC) ?? finiteNumber(temps.storageC),
      source: temps.storageSource || null
    }
  };
}

export function classifyThermalState(telemetry = {}, options = {}) {
  const readings = componentReadings(telemetry);
  const thresholdsMap = thresholdsForOptions(options);
  const components = Object.fromEntries(
    COMPONENT_ORDER.map((component) => [
      component,
      classifyReading(component, readings[component]?.tempC, readings[component]?.source, thresholdsMap)
    ])
  );
  const worst = worstComponent(components);
  const severity = worst?.severity || "ok";
  const baseAction = actionForSeverity(severity);
  const recommendedAction = actionForMode(baseAction, options.modeId, Boolean(options.foregroundActive));
  const availableCount = Object.values(components).filter((entry) => entry.available).length;
  const summary = worst
    ? `${worst.label} ${Math.round(worst.tempC)} C (${severity})`
    : "No thermal sensors available";
  const reason = worst
    ? `${worst.label} temperature is ${Math.round(worst.tempC)} C (${severity}); action: ${recommendedAction}.`
    : "Thermal hierarchy has no valid sensor readings.";

  return {
    severity,
    recommendedAction,
    baseAction,
    worstComponent: worst ? worst.component : null,
    worstLabel: worst ? worst.label : null,
    worstTempC: worst ? worst.tempC : null,
    available: availableCount > 0,
    availableCount,
    summary,
    reason,
    components
  };
}

function normalizeOutcome(outcome = {}) {
  return {
    samples: Number(outcome.samples) || 0,
    startedAt: outcome.startedAt || null,
    lastSampleAt: outcome.lastSampleAt || null,
    lastSeverity: OUTCOME_SEVERITIES.includes(outcome.lastSeverity) ? outcome.lastSeverity : "ok",
    worstSeverity: OUTCOME_SEVERITIES.includes(outcome.worstSeverity) ? outcome.worstSeverity : "ok",
    worstComponent: outcome.worstComponent || null,
    guardActivations: Number(outcome.guardActivations) || 0,
    peaksC: {
      cpu: finiteNumber(outcome.peaksC?.cpu),
      gpu: finiteNumber(outcome.peaksC?.gpu),
      vram: finiteNumber(outcome.peaksC?.vram),
      storage: finiteNumber(outcome.peaksC?.storage)
    },
    severitySeconds: {
      ok: Number(outcome.severitySeconds?.ok) || 0,
      warm: Number(outcome.severitySeconds?.warm) || 0,
      hot: Number(outcome.severitySeconds?.hot) || 0,
      critical: Number(outcome.severitySeconds?.critical) || 0
    },
    current: outcome.current || null,
    penalty: Number(outcome.penalty) || 0
  };
}

function slimThermalState(state) {
  return {
    severity: state.severity,
    recommendedAction: state.recommendedAction,
    worstComponent: state.worstComponent,
    worstLabel: state.worstLabel,
    worstTempC: state.worstTempC,
    summary: state.summary
  };
}

export function updateThermalOutcome(outcome = {}, telemetry = {}, options = {}) {
  const next = normalizeOutcome(outcome);
  const sampleAt = options.at || telemetry.capturedAt || new Date().toISOString();
  const sampleMs = Date.parse(sampleAt);
  const lastMs = Date.parse(next.lastSampleAt || "");
  if (!next.startedAt) {
    next.startedAt = sampleAt;
  }
  if (Number.isFinite(sampleMs) && Number.isFinite(lastMs) && sampleMs > lastMs) {
    const delta = Math.min(300, Math.round((sampleMs - lastMs) / 1000));
    next.severitySeconds[next.lastSeverity] = (next.severitySeconds[next.lastSeverity] || 0) + delta;
  }

  const state = classifyThermalState(telemetry, options);
  for (const component of COMPONENT_ORDER) {
    const reading = state.components[component];
    if (reading?.available) {
      next.peaksC[component] = Math.max(next.peaksC[component] ?? reading.tempC, reading.tempC);
    }
  }
  if (THERMAL_SEVERITY_RANK[state.severity] > THERMAL_SEVERITY_RANK[next.worstSeverity]) {
    next.worstSeverity = state.severity;
    next.worstComponent = state.worstComponent;
  }
  if (state.recommendedAction !== "none") {
    next.guardActivations += 1;
  }
  next.samples += 1;
  next.lastSampleAt = sampleAt;
  next.lastSeverity = OUTCOME_SEVERITIES.includes(state.severity) ? state.severity : "ok";
  next.current = slimThermalState(state);
  next.penalty = thermalPenalty(next);
  return next;
}

export function thermalPenalty(outcome = {}) {
  const normalized = normalizeOutcome(outcome);
  let penalty = 0;
  if (normalized.worstSeverity === "critical") penalty += 20;
  else if (normalized.worstSeverity === "hot") penalty += 12;
  else if (normalized.worstSeverity === "warm") penalty += 4;
  penalty += Math.min(8, Math.floor((normalized.severitySeconds.hot || 0) / 60) * 2);
  penalty += Math.min(8, Math.floor((normalized.severitySeconds.critical || 0) / 30) * 4);
  if (normalized.guardActivations > 0) penalty += Math.min(5, normalized.guardActivations);
  return Math.min(30, penalty);
}

export function finalizeThermalOutcome(outcome = {}, telemetry = {}, options = {}) {
  return updateThermalOutcome(outcome, telemetry, options);
}

export function summarizeThermalReliability(sessions = []) {
  const recent = sessions.slice(-5);
  const thermals = recent.map((entry) => entry.thermal).filter(Boolean);
  const hotCount = thermals.filter((entry) => THERMAL_SEVERITY_RANK[entry.worstSeverity] >= THERMAL_SEVERITY_RANK.hot).length;
  const warmCount = thermals.filter((entry) => THERMAL_SEVERITY_RANK[entry.worstSeverity] >= THERMAL_SEVERITY_RANK.warm).length;
  const cleanCount = thermals.filter((entry) => (entry.penalty || 0) === 0 && entry.worstSeverity === "ok").length;
  const state =
    hotCount >= 2 ? "hot-prone" :
      warmCount >= 3 ? "warm-prone" :
        cleanCount >= 3 ? "clean" :
          thermals.length ? "collecting" : "unknown";
  return {
    state,
    sessions: thermals.length,
    hotSessions: hotCount,
    warmSessions: warmCount,
    cleanSessions: cleanCount,
    last: thermals.at(-1) || null
  };
}
