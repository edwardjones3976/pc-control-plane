
export const GAMING_PROFILE_TUNING = Object.freeze({
  gpuLullPct: 25,
  cpuLullPct: 25,
  fpsLullThreshold: 14,
  lullSustainMs: 5000
});

export function readFrameRate(telemetry = {}) {
  const candidates = [
    telemetry?.frames?.fps,
    telemetry?.frames?.fpsAvg,
    telemetry?.presentMon?.fps,
    telemetry?.priorityApp?.frameStats?.fps,
    telemetry?.frameStats?.fps
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function classifyCompetitiveActivity(modeId, telemetry = {}, tuning = GAMING_PROFILE_TUNING) {
  const active = modeId === "competitive" && Boolean(telemetry?.priorityApp?.running);
  const gpu = Number(telemetry?.gpu?.utilizationPct);
  const cpu = Number(telemetry?.system?.cpuLoadPct);
  const fps = readFrameRate(telemetry);
  const gpuLow = Number.isFinite(gpu) && gpu < tuning.gpuLullPct;
  const cpuLow = Number.isFinite(cpu) && cpu < tuning.cpuLullPct;
  const fpsLow = Number.isFinite(fps) && fps < tuning.fpsLullThreshold;
  const lullInstant = active && gpuLow && cpuLow;
  return {
    active,
    gpu: Number.isFinite(gpu) ? gpu : null,
    cpu: Number.isFinite(cpu) ? cpu : null,
    fps,
    gpuLow,
    cpuLow,
    fpsLow,
    lullInstant
  };
}

export function evaluateSustainedLull({ activity, lullSinceMs = null, nowMs = Date.now(), tuning = GAMING_PROFILE_TUNING } = {}) {
  if (!activity?.active || !activity.lullInstant) {
    return { lull: false, lullSinceMs: null, sustainedMs: 0 };
  }
  const since = Number.isFinite(Number(lullSinceMs)) ? Number(lullSinceMs) : nowMs;
  const sustainedMs = Math.max(0, nowMs - since);
  return { lull: sustainedMs >= tuning.lullSustainMs, lullSinceMs: since, sustainedMs };
}

export function competitiveTargetBias({ activity, lull } = {}) {
  if (!activity?.active) {
    return { target: null, gpuRelief: false, reason: null };
  }
  if (lull) {
    return {
      target: "floor",
      gpuRelief: true,
      reason: "competitive lull (low GPU+CPU sustained) — Endurance + GPU relief for efficiency"
    };
  }
  return {
    target: "ceiling",
    gpuRelief: false,
    reason: "competitive active play — holding Ultra Performance"
  };
}
