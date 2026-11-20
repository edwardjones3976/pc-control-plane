
const MAX_CURES = 12;
const MAX_SAMPLES = 12;
const MAX_PENDING = 10;
export const SELF_TREATMENT_VERIFY_MS = 45 * 1000;
export const SELF_TREATMENT_COOLDOWN_MS = 10 * 60 * 1000;
export const SELF_TREATMENT_BACKOFF_MS = 30 * 60 * 1000;
export const SELF_TREATMENT_FAILED_STREAK = 3;

export const SELF_TREATMENT_CURES = Object.freeze({
  "telemetry-cache-refresh": Object.freeze({
    id: "telemetry-cache-refresh",
    label: "Refresh telemetry cache",
    risk: "safe",
    description: "Expires cached telemetry and performs a fresh light sensor capture.",
    matches: ["telemetry", "capture", "sensor", "status", "loading", "stale"]
  }),
  "observer-volatile-reset": Object.freeze({
    id: "observer-volatile-reset",
    label: "Reset observer volatile state",
    risk: "safe",
    description: "Clears stuck in-memory flags such as pending holds and in-flight relief markers.",
    matches: ["observer", "selfheal", "relief", "context", "thermal", "learning"]
  }),
  "audit-coalescer-reset": Object.freeze({
    id: "audit-coalescer-reset",
    label: "Reset audit coalescer",
    risk: "safe",
    description: "Clears the in-memory audit repeat-coalescing cache when audit formatting/logging faults recur.",
    matches: ["audit", "jsonl", "parse", "coalesce"]
  })
});

function isoFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function toMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function safeCount(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizeSelfTreatmentStore(store = {}) {
  const cures = {};
  const src = store && typeof store.cures === "object" && store.cures ? store.cures : {};
  for (const [id, value] of Object.entries(src).slice(0, MAX_CURES)) {
    if (!SELF_TREATMENT_CURES[id]) continue;
    cures[id] = {
      attempts: safeCount(value?.attempts),
      helped: safeCount(value?.helped),
      failed: safeCount(value?.failed),
      ineffectiveStreak: safeCount(value?.ineffectiveStreak),
      lastAt: value?.lastAt || null,
      lastOutcomeAt: value?.lastOutcomeAt || null,
      backoffUntil: value?.backoffUntil || null,
      samples: Array.isArray(value?.samples)
        ? value.samples.slice(-MAX_SAMPLES).map((sample) => ({
            at: sample?.at || null,
            signature: String(sample?.signature || "").slice(0, 160),
            beforeCount: safeCount(sample?.beforeCount),
            afterCount: safeCount(sample?.afterCount),
            helped: Boolean(sample?.helped)
          }))
        : []
    };
  }
  const pending = Array.isArray(store?.pending)
    ? store.pending.slice(-MAX_PENDING).map((attempt) => ({
        id: String(attempt?.id || ""),
        cureId: String(attempt?.cureId || ""),
        signature: String(attempt?.signature || "").slice(0, 180),
        action: String(attempt?.action || "error"),
        sample: String(attempt?.sample || "").slice(0, 200),
        beforeCount: safeCount(attempt?.beforeCount),
        at: attempt?.at || null,
        verifyAt: attempt?.verifyAt || null
      })).filter((attempt) => attempt.id && SELF_TREATMENT_CURES[attempt.cureId])
    : [];
  return {
    schema: "pc-control-plane-self-treatment/v1",
    cures,
    pending,
    updatedAt: store?.updatedAt || null
  };
}

export function classifySelfTreatmentCure(fault = {}) {
  const text = `${fault.action || ""} ${fault.signature || ""} ${fault.sample || ""}`.toLowerCase();
  if (/telemetry|capture|sensor|status|loading|stale/.test(text)) {
    return SELF_TREATMENT_CURES["telemetry-cache-refresh"];
  }
  if (/audit|jsonl|parse|coalesc/.test(text)) {
    return SELF_TREATMENT_CURES["audit-coalescer-reset"];
  }
  if (/observer|selfheal|relief|context|thermal|learning|governor|optimizer/.test(text)) {
    return SELF_TREATMENT_CURES["observer-volatile-reset"];
  }
  return null;
}

export function buildSelfTreatmentPlan({
  selfHealth = {},
  store = {},
  nowMs = Date.now(),
  recurringThreshold = 3,
  cooldownMs = SELF_TREATMENT_COOLDOWN_MS
} = {}) {
  const normalized = normalizeSelfTreatmentStore(store);
  const pending = normalized.pending.filter((attempt) => toMs(attempt.verifyAt) > nowMs);
  const recurring = Array.isArray(selfHealth?.recurring) ? selfHealth.recurring : [];
  const candidates = recurring
    .filter((fault) => safeCount(fault.count) >= recurringThreshold)
    .map((fault) => ({ fault, cure: classifySelfTreatmentCure(fault) }))
    .filter((item) => item.cure);

  if (pending.length) {
    return {
      status: "verifying",
      eligible: false,
      summary: `${pending.length} self-treatment outcome${pending.length === 1 ? "" : "s"} pending`,
      pending,
      candidates
    };
  }
  if (!candidates.length) {
    return {
      status: "watching",
      eligible: false,
      summary: "No recurring internal fault needs treatment.",
      pending: [],
      candidates: []
    };
  }

  const blocked = [];
  for (const candidate of candidates) {
    const entry = normalized.cures[candidate.cure.id] || {};
    const backoffMs = toMs(entry.backoffUntil);
    if (backoffMs > nowMs) {
      blocked.push({ ...candidate, blockedBy: "learned-backoff", until: entry.backoffUntil });
      continue;
    }
    const lastMs = toMs(entry.lastAt);
    if (lastMs && nowMs - lastMs < cooldownMs) {
      blocked.push({ ...candidate, blockedBy: "cooldown", until: isoFromMs(lastMs + cooldownMs) });
      continue;
    }
    return {
      status: "ready",
      eligible: true,
      summary: `${candidate.cure.label} is ready for ${candidate.fault.action}.`,
      cure: candidate.cure,
      fault: candidate.fault,
      candidates,
      blocked
    };
  }

  return {
    status: "gated",
    eligible: false,
    summary: blocked[0]?.blockedBy === "learned-backoff"
      ? `${blocked[0].cure.label} is backed off until ${blocked[0].until}.`
      : `${blocked[0]?.cure?.label || "Self-treatment"} is cooling down.`,
    pending: [],
    candidates,
    blocked
  };
}

export function recordSelfTreatmentAttempt(store = {}, {
  cureId,
  signature,
  action,
  sample,
  beforeCount = 0,
  at = new Date().toISOString(),
  verifyAt = null
} = {}) {
  const normalized = normalizeSelfTreatmentStore(store);
  const cure = SELF_TREATMENT_CURES[cureId];
  if (!cure) {
    return { store: normalized, attempt: null };
  }
  const verify = verifyAt || new Date((Date.parse(at) || Date.now()) + SELF_TREATMENT_VERIFY_MS).toISOString();
  const attempt = {
    id: `${cureId}:${Buffer.from(String(signature || action || at)).toString("base64url").slice(0, 24)}:${Date.parse(at) || Date.now()}`,
    cureId,
    signature: String(signature || ""),
    action: String(action || "error"),
    sample: String(sample || "").slice(0, 200),
    beforeCount: safeCount(beforeCount),
    at,
    verifyAt: verify
  };
  const entry = normalized.cures[cureId] || {
    attempts: 0,
    helped: 0,
    failed: 0,
    ineffectiveStreak: 0,
    lastAt: null,
    lastOutcomeAt: null,
    backoffUntil: null,
    samples: []
  };
  entry.attempts += 1;
  entry.lastAt = at;
  normalized.cures[cureId] = entry;
  normalized.pending = [...normalized.pending.filter((item) => item.id !== attempt.id), attempt].slice(-MAX_PENDING);
  normalized.updatedAt = at;
  return { store: normalized, attempt };
}

export function recordSelfTreatmentOutcome(store = {}, {
  attemptId,
  afterCount = 0,
  at = new Date().toISOString()
} = {}) {
  const normalized = normalizeSelfTreatmentStore(store);
  const attempt = normalized.pending.find((item) => item.id === attemptId);
  if (!attempt) {
    return { store: normalized, outcome: null };
  }
  const entry = normalized.cures[attempt.cureId] || {
    attempts: 0,
    helped: 0,
    failed: 0,
    ineffectiveStreak: 0,
    samples: []
  };
  const safeAfter = safeCount(afterCount);
  const helped = safeAfter <= safeCount(attempt.beforeCount);
  if (helped) {
    entry.helped += 1;
    entry.ineffectiveStreak = 0;
    entry.backoffUntil = null;
  } else {
    entry.failed += 1;
    entry.ineffectiveStreak += 1;
    if (entry.ineffectiveStreak >= SELF_TREATMENT_FAILED_STREAK) {
      entry.backoffUntil = new Date((Date.parse(at) || Date.now()) + SELF_TREATMENT_BACKOFF_MS).toISOString();
    }
  }
  entry.lastOutcomeAt = at;
  entry.samples = [
    ...(entry.samples || []),
    {
      at,
      signature: attempt.signature,
      beforeCount: attempt.beforeCount,
      afterCount: safeAfter,
      helped
    }
  ].slice(-MAX_SAMPLES);
  normalized.cures[attempt.cureId] = entry;
  normalized.pending = normalized.pending.filter((item) => item.id !== attemptId);
  normalized.updatedAt = at;
  return {
    store: normalized,
    outcome: {
      ...attempt,
      afterCount: safeAfter,
      helped,
      backoffUntil: entry.backoffUntil || null
    }
  };
}

export function summarizeSelfTreatment(store = {}, selfHealth = {}) {
  const normalized = normalizeSelfTreatmentStore(store);
  const cures = Object.values(SELF_TREATMENT_CURES).map((cure) => {
    const entry = normalized.cures[cure.id] || {};
    const attempts = safeCount(entry.attempts);
    const helped = safeCount(entry.helped);
    return {
      id: cure.id,
      label: cure.label,
      risk: cure.risk,
      attempts,
      helped,
      failed: safeCount(entry.failed),
      successPct: attempts ? Math.round((helped / attempts) * 100) : null,
      ineffectiveStreak: safeCount(entry.ineffectiveStreak),
      backoffUntil: entry.backoffUntil || null,
      lastAt: entry.lastAt || null,
      lastOutcomeAt: entry.lastOutcomeAt || null
    };
  });
  const activeBackoffs = cures.filter((cure) => cure.backoffUntil && toMs(cure.backoffUntil) > Date.now());
  const plan = buildSelfTreatmentPlan({ selfHealth, store: normalized });
  return {
    schema: normalized.schema,
    status: normalized.pending.length ? "verifying" : plan.status,
    summary: normalized.pending.length
      ? `${normalized.pending.length} self-treatment outcome${normalized.pending.length === 1 ? "" : "s"} pending.`
      : plan.summary,
    pendingCount: normalized.pending.length,
    activeBackoffs,
    cures,
    lastTreatment: cures
      .filter((cure) => cure.lastAt)
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0] || null,
    eligible: plan.eligible,
    next: plan.eligible ? { cureId: plan.cure.id, label: plan.cure.label, action: plan.fault.action } : null
  };
}
