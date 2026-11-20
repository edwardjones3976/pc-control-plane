
const MAX_SIGNATURES = 60;
const SAMPLE_MAX = 200;

export function normalizeErrorSignature(action, message) {
  const msg = String(message || "")
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/[a-zA-Z]:\\[^\s'"]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/['"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${String(action || "error")}|${msg}`;
}

export function normalizeSelfHealth(store = {}) {
  const src = store && typeof store.signatures === "object" && store.signatures ? store.signatures : {};
  const signatures = {};
  for (const [key, value] of Object.entries(src).slice(0, MAX_SIGNATURES)) {
    signatures[key] = {
      action: value?.action || "error",
      sample: String(value?.sample || "").slice(0, SAMPLE_MAX),
      count: Math.max(0, Math.round(Number(value?.count) || 0)),
      firstAt: value?.firstAt || null,
      lastAt: value?.lastAt || null
    };
  }
  return { signatures, updatedAt: store?.updatedAt || null };
}

export function recordSelfError(store, { action, message, at = new Date().toISOString() } = {}) {
  const next = normalizeSelfHealth(store);
  const signature = normalizeErrorSignature(action, message);
  const existing = next.signatures[signature];
  if (existing) {
    existing.count += 1;
    existing.lastAt = at;
  } else {
    const keys = Object.keys(next.signatures);
    if (keys.length >= MAX_SIGNATURES) {
      let oldest = keys[0];
      for (const k of keys) {
        if ((next.signatures[k].lastAt || "") < (next.signatures[oldest].lastAt || "")) oldest = k;
      }
      delete next.signatures[oldest];
    }
    next.signatures[signature] = {
      action: String(action || "error"),
      sample: String(message || "").slice(0, SAMPLE_MAX),
      count: 1,
      firstAt: at,
      lastAt: at
    };
  }
  next.updatedAt = at;
  return { store: next, signature, count: next.signatures[signature].count, isNew: !existing };
}

export function summarizeSelfHealth(store = {}, { recurringThreshold = 3 } = {}) {
  const norm = normalizeSelfHealth(store);
  const entries = Object.entries(norm.signatures).map(([signature, v]) => ({ signature, ...v }));
  const recurring = entries.filter((e) => e.count >= recurringThreshold).sort((a, b) => b.count - a.count);
  const totalErrors = entries.reduce((sum, e) => sum + e.count, 0);
  return {
    state: recurring.length ? "faults" : entries.length ? "minor" : "clean",
    distinctSignatures: entries.length,
    totalErrors,
    recurring: recurring.slice(0, 5),
    updatedAt: norm.updatedAt
  };
}
