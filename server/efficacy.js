
const MAX_SAMPLES = 20;
const MAX_ACTIONS = 50;
const MIN_RUNS_TO_JUDGE = 4;
const LOW_EFFICACY_PCT = 25;

export function healthScore(state) {
  const s = String(state || "").toLowerCase();
  if (s.includes("strain")) return 0;
  if (s.includes("warm")) return 1;
  if (s.includes("stable")) return 2;
  return 1;
}

export function normalizeEfficacy(store = {}) {
  const out = { actions: {}, updatedAt: store?.updatedAt || null };
  const src = store && typeof store.actions === "object" && store.actions ? store.actions : {};
  for (const [key, v] of Object.entries(src).slice(0, MAX_ACTIONS)) {
    out.actions[key] = {
      samples: Array.isArray(v?.samples)
        ? v.samples.slice(-MAX_SAMPLES).map((s) => ({
            at: s?.at || null,
            before: Number(s?.before) || 0,
            after: Number(s?.after) || 0,
            helped: Boolean(s?.helped)
          }))
        : [],
      runs: Math.max(0, Math.round(Number(v?.runs) || 0)),
      helped: Math.max(0, Math.round(Number(v?.helped) || 0))
    };
  }
  return out;
}

export function recordEfficacy(store, { action, before = 0, after = 0, at = new Date().toISOString() } = {}) {
  const next = normalizeEfficacy(store);
  const key = String(action || "action");
  const entry = next.actions[key] || { samples: [], runs: 0, helped: 0 };
  const helped = Number(after) > Number(before); // the metric improved
  entry.samples = [...entry.samples, { at, before: Number(before) || 0, after: Number(after) || 0, helped }].slice(-MAX_SAMPLES);
  entry.runs += 1;
  if (helped) entry.helped += 1;
  next.actions[key] = entry;
  next.updatedAt = at;
  return { store: next, helped };
}

export function summarizeEfficacy(store = {}) {
  const norm = normalizeEfficacy(store);
  const actions = Object.entries(norm.actions).map(([action, v]) => {
    const recent = v.samples.slice(-8);
    const effectivenessPct = v.runs ? Math.round((v.helped / v.runs) * 100) : null;
    return {
      action,
      runs: v.runs,
      helpedRuns: v.helped,
      effectivenessPct,
      recentHelped: recent.filter((s) => s.helped).length,
      recentRuns: recent.length,
      lowEfficacy: v.runs >= MIN_RUNS_TO_JUDGE && effectivenessPct !== null && effectivenessPct < LOW_EFFICACY_PCT
    };
  }).sort((a, b) => (a.effectivenessPct ?? 100) - (b.effectivenessPct ?? 100));
  return {
    actions,
    lowEfficacyActions: actions.filter((a) => a.lowEfficacy).map((a) => a.action),
    updatedAt: norm.updatedAt
  };
}

export function efficacyAllows(store, action, { influence = true } = {}) {
  if (!influence) return { allowed: true, reason: "learning influence off" };
  const v = normalizeEfficacy(store).actions[String(action || "")];
  if (!v || v.runs < MIN_RUNS_TO_JUDGE) return { allowed: true, reason: "insufficient history" };
  const pct = Math.round((v.helped / v.runs) * 100);
  if (pct < LOW_EFFICACY_PCT) return { allowed: false, reason: `low efficacy (${pct}% helped on this host)`, effectivenessPct: pct };
  return { allowed: true, reason: `efficacy ${pct}%` };
}
