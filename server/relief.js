
export const RELIEF_TUNING = Object.freeze({
  maxSamples: 12,
  ineffectiveStreakToBackoff: 3,
  backoffMs: 30 * 60 * 1000,
  ram: { pressurePct: 90, effectiveFreedMB: 400, cooldownMs: 10 * 60 * 1000 },
  cpu: { pressurePct: 92, effectiveEasedPct: 8, cooldownMs: 10 * 60 * 1000, sustainedSamples: 3 },
  network: { pressurePct: 55, effectiveSignal: 1, cooldownMs: 5 * 60 * 1000 },
  gpu: { pressurePct: 80, effectiveEasedPct: 4, cooldownMs: 10 * 60 * 1000, holdMs: 45 * 1000 }
});

const KINDS = new Set(["ram", "cpu", "network", "gpu"]);

export function normalizeReliefStore(store = {}) {
  const norm = (k) => {
    const entry = store?.[k] || {};
    return {
      samples: Array.isArray(entry.samples)
        ? entry.samples.slice(-RELIEF_TUNING.maxSamples).map((s) => ({
            at: s.at || null,
            metric: Number(s.metric) || 0,
            effective: Boolean(s.effective)
          }))
        : [],
      ineffectiveStreak: Number(entry.ineffectiveStreak) || 0,
      backoffUntil: entry.backoffUntil || null,
      lastAt: entry.lastAt || null
    };
  };
  return { ram: norm("ram"), cpu: norm("cpu"), network: norm("network"), gpu: norm("gpu") };
}

export function isReliefEffective(kind, metric) {
  if (kind === "ram") return Number(metric) >= RELIEF_TUNING.ram.effectiveFreedMB;
  if (kind === "cpu") return Number(metric) >= RELIEF_TUNING.cpu.effectiveEasedPct;
  if (kind === "network") return Number(metric) >= RELIEF_TUNING.network.effectiveSignal;
  if (kind === "gpu") return Number(metric) >= RELIEF_TUNING.gpu.effectiveEasedPct;
  return false;
}

export function recordReliefSample(store, kind, { metric = 0, at = new Date().toISOString() } = {}) {
  const next = normalizeReliefStore(store);
  if (!KINDS.has(kind)) return next;
  const effective = isReliefEffective(kind, metric);
  const entry = next[kind];
  entry.samples = [...entry.samples, { at, metric: Number(metric) || 0, effective }].slice(-RELIEF_TUNING.maxSamples);
  entry.lastAt = at;
  entry.ineffectiveStreak = effective ? 0 : entry.ineffectiveStreak + 1;
  if (effective) {
    entry.backoffUntil = null;
  } else if (entry.ineffectiveStreak >= RELIEF_TUNING.ineffectiveStreakToBackoff) {
    entry.backoffUntil = new Date(Date.parse(at) + RELIEF_TUNING.backoffMs).toISOString();
  }
  return next;
}

export function evaluateReliefGate(store, kind, { now = Date.now(), pressure = 0, lastRunAt = null, influence = true } = {}) {
  const tuning = RELIEF_TUNING[kind];
  if (!tuning) return { allowed: false, reason: "unknown relief kind" };
  if (Number(pressure) < tuning.pressurePct) {
    return { allowed: false, reason: `no pressure (${Math.round(Number(pressure) || 0)}% < ${tuning.pressurePct}%)` };
  }
  const lastMs = lastRunAt ? Date.parse(lastRunAt) : 0;
  if (Number.isFinite(lastMs) && lastMs > 0 && now - lastMs < tuning.cooldownMs) {
    return { allowed: false, reason: "cooldown" };
  }
  if (influence) {
    const entry = normalizeReliefStore(store)[kind];
    const backoffMs = entry.backoffUntil ? Date.parse(entry.backoffUntil) : 0;
    if (Number.isFinite(backoffMs) && backoffMs > now) {
      return { allowed: false, reason: "learned-ineffective backoff", backoffUntil: entry.backoffUntil };
    }
  }
  return { allowed: true, reason: "pressure + clear" };
}

export function nextSustainedPressureStreak(previous = 0, pressure = 0, threshold = RELIEF_TUNING.cpu.pressurePct) {
  return Number(pressure) >= threshold ? Math.min(Number(previous) + 1 || 1, RELIEF_TUNING.cpu.sustainedSamples) : 0;
}

export function evaluateCpuReliefEligibility({
  cpuLoadPct = 0,
  thermalSeverity = "ok",
  powerAtFloor = false,
  pressureStreak = 0,
  inFlight = false
} = {}) {
  if (inFlight) {
    return { eligible: false, reason: "pulse already running", sustainedPressure: false, thermalFloorRelief: false };
  }
  const sustainedPressure = Number(cpuLoadPct) >= RELIEF_TUNING.cpu.pressurePct &&
    Number(pressureStreak) >= RELIEF_TUNING.cpu.sustainedSamples;
  const heatJustifiesCap = thermalSeverity === "hot" || thermalSeverity === "critical";
  const thermalFloorRelief = heatJustifiesCap && Boolean(powerAtFloor);
  if (sustainedPressure || thermalFloorRelief) {
    return {
      eligible: true,
      reason: sustainedPressure ? "sustained CPU pressure" : "thermal floor relief",
      sustainedPressure,
      thermalFloorRelief
    };
  }
  if (Number(cpuLoadPct) >= RELIEF_TUNING.cpu.pressurePct) {
    return {
      eligible: false,
      reason: `sustained pressure ${Math.max(0, Number(pressureStreak) || 0)}/${RELIEF_TUNING.cpu.sustainedSamples}`,
      sustainedPressure: false,
      thermalFloorRelief: false
    };
  }
  return {
    eligible: false,
    reason: `CPU ${Math.round(Number(cpuLoadPct) || 0)}% < ${RELIEF_TUNING.cpu.pressurePct}%`,
    sustainedPressure: false,
    thermalFloorRelief: false
  };
}
