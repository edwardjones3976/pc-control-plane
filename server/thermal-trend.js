
const MAX_HISTORY = 8;

export function pushThermalSample(history = [], { tempC, at = Date.now() } = {}) {
  const t = Number(tempC);
  const stamp = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const next = Array.isArray(history) ? history.slice(-(MAX_HISTORY - 1)) : [];
  if (Number.isFinite(t)) next.push({ tempC: t, at: stamp });
  return next.slice(-MAX_HISTORY);
}

export function thermalSlopePerMin(history = []) {
  const h = (history || []).filter((s) => Number.isFinite(Number(s?.tempC)));
  if (h.length < 2) return 0;
  const first = h[0];
  const last = h[h.length - 1];
  const dtMin = (Number(last.at) - Number(first.at)) / 60000;
  if (!(dtMin > 0)) return 0;
  return (Number(last.tempC) - Number(first.tempC)) / dtMin;
}

export function evaluatePredictiveCooling(history = [], {
  hot = 85, slopeThreshold = 8, lookaheadMin = 0.75, marginC = 3
} = {}) {
  const h = (history || []).filter((s) => Number.isFinite(Number(s?.tempC)));
  if (h.length < 2) return { ease: false, reason: "insufficient history", slope: 0, projected: null };
  const current = Number(h[h.length - 1].tempC);
  const slope = thermalSlopePerMin(h);
  const projected = current + slope * lookaheadMin;
  const ease = slope >= slopeThreshold && projected >= (hot - marginC) && current < hot;
  return {
    ease,
    reason: ease ? `rising ${Math.round(slope)}C/min, projected ~${Math.round(projected)}C` : "stable trend",
    slope: Math.round(slope * 10) / 10,
    projected: Math.round(projected)
  };
}

export function calibrationMarginC(recentPeaks = [], { hot = 85 } = {}) {
  const peaks = (recentPeaks || []).map(Number).filter(Number.isFinite);
  if (peaks.length < 3) return 0;
  const nearHot = peaks.filter((p) => p >= hot - 5).length;
  if (nearHot >= peaks.length * 0.6) return 3;
  if (nearHot >= peaks.length * 0.3) return 1;
  return 0;
}
