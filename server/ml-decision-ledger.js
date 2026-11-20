
const STORE_SCHEMA = "pc-control-plane-ml-decision-ledger/v1";
const MAX_PENDING = 12;
const MAX_VERIFIED = 80;
const MAX_PREVENTION = 12;
const DEFAULT_VERIFY_WINDOW_MS = 45 * 1000;
const DEFAULT_DEDUPE_MS = 30 * 1000;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function healthScore(state) {
  const s = String(state || "").toLowerCase();
  if (s.includes("strain")) return 0;
  if (s.includes("warm")) return 1;
  if (s.includes("stable")) return 2;
  return 1;
}

function metricSnapshot({ state = {}, policy = {}, telemetry = {}, adaptivePower = null } = {}) {
  const system = telemetry.system || {};
  const thermal = policy.thermalState || {};
  const healthState = policy.health?.state || thermal.severity || "unknown";
  return {
    modeId: state.modeId || "balanced",
    suggestedMode: policy.suggestedMode || null,
    healthState,
    healthScore: healthScore(healthState),
    thermalSeverity: thermal.severity || "unknown",
    worstComponent: thermal.worstComponent || null,
    cpuPct: Math.round(clamp(system.cpuLoadPct)),
    ramPct: Math.round(clamp(system.ramUsedPct ?? system.ramUsedRealPct)),
    adaptivePlan: adaptivePower?.plan || null,
    adaptiveTier: Number.isFinite(Number(adaptivePower?.tier)) ? Number(adaptivePower.tier) : null
  };
}

function compactAction(action = {}) {
  return {
    id: String(action.id || "observe.verify"),
    label: String(action.label || "Keep monitoring and verify"),
    layer: action.layer || "verification",
    intent: action.intent || "verify",
    score: clamp(action.score),
    risk: action.risk || "none"
  };
}

function decisionSignature({ selected = {}, before = {} } = {}) {
  return [
    selected.id || "observe.verify",
    selected.intent || "verify",
    before.modeId || "mode",
    before.suggestedMode || "same",
    before.healthState || "health",
    before.thermalSeverity || "thermal",
    before.adaptiveTier ?? "tier"
  ].join("|");
}

function normalizePending(entry = {}) {
  const before = entry.before || {};
  const selected = compactAction(entry.selected || {});
  return {
    id: String(entry.id || ""),
    at: entry.at || null,
    dueAt: entry.dueAt || null,
    signature: entry.signature || decisionSignature({ selected, before }),
    selected,
    before
  };
}

function normalizeVerified(entry = {}) {
  return {
    ...normalizePending(entry),
    verifiedAt: entry.verifiedAt || null,
    after: entry.after || {},
    outcome: entry.outcome || "unknown",
    helped: Boolean(entry.helped),
    confidence: entry.confidence || "observational",
    reason: entry.reason || "Outcome verification has no reason recorded."
  };
}

function normalizePrevention(entry = {}) {
  return {
    id: String(entry.id || "ml.prevent.unknown"),
    actionId: String(entry.actionId || "unknown"),
    label: String(entry.label || "Governor prevention candidate"),
    treatment: entry.treatment || "watch",
    confidence: entry.confidence || "low",
    evidenceCount: Math.max(0, Math.round(Number(entry.evidenceCount) || 0)),
    reason: entry.reason || "Governor evidence is not strong enough for action.",
    updatedAt: entry.updatedAt || null
  };
}

export function normalizeGovernorDecisionStore(store = {}) {
  return {
    schema: STORE_SCHEMA,
    updatedAt: store?.updatedAt || null,
    pending: Array.isArray(store?.pending) ? store.pending.map(normalizePending).filter((entry) => entry.id).slice(-MAX_PENDING) : [],
    verified: Array.isArray(store?.verified) ? store.verified.map(normalizeVerified).filter((entry) => entry.id).slice(-MAX_VERIFIED) : [],
    preventionCandidates: Array.isArray(store?.preventionCandidates)
      ? store.preventionCandidates.map(normalizePrevention).slice(0, MAX_PREVENTION)
      : []
  };
}

function isDuplicateDecision(store, signature, nowMs, dedupeMs) {
  const recent = [...store.pending, ...store.verified].slice(-8);
  return recent.some((entry) => {
    if (entry.signature !== signature) return false;
    const atMs = Date.parse(entry.verifiedAt || entry.at || "");
    return Number.isFinite(atMs) && nowMs - atMs < dedupeMs;
  });
}

export function recordGovernorDecision(
  store,
  { governor = {}, state = {}, policy = {}, telemetry = {}, adaptivePower = null, at = new Date().toISOString() } = {},
  { verifyWindowMs = DEFAULT_VERIFY_WINDOW_MS, dedupeMs = DEFAULT_DEDUPE_MS } = {}
) {
  const normalized = normalizeGovernorDecisionStore(store);
  const selected = compactAction(governor.selected || {});
  const before = metricSnapshot({ state, policy, telemetry, adaptivePower });
  const signature = decisionSignature({ selected, before });
  const nowMs = Date.parse(at) || Date.now();
  if (isDuplicateDecision(normalized, signature, nowMs, dedupeMs)) {
    return { store: normalized, record: null, skipped: "duplicate" };
  }
  const id = `ml-${nowMs}-${Math.abs(signature.split("").reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) | 0, 7))}`;
  const record = {
    id,
    at,
    dueAt: new Date(nowMs + verifyWindowMs).toISOString(),
    signature,
    selected,
    before
  };
  const next = {
    ...normalized,
    updatedAt: at,
    pending: [...normalized.pending, record].slice(-MAX_PENDING)
  };
  return { store: next, record, skipped: null };
}

function compareOutcome(before = {}, after = {}) {
  const scoreDelta = finite(after.healthScore) - finite(before.healthScore);
  const cpuDelta = finite(after.cpuPct) - finite(before.cpuPct);
  const ramDelta = finite(after.ramPct) - finite(before.ramPct);
  const thermalOrder = { ok: 0, warm: 1, hot: 2, critical: 3, unknown: 1 };
  const thermalDelta =
    (thermalOrder[String(after.thermalSeverity || "unknown")] ?? 1) -
    (thermalOrder[String(before.thermalSeverity || "unknown")] ?? 1);

  if (scoreDelta > 0 || thermalDelta < 0 || cpuDelta <= -15 || ramDelta <= -10) {
    return {
      outcome: "improved",
      helped: true,
      reason: "Health, thermal state, CPU pressure, or RAM pressure improved during the verification window."
    };
  }
  if (scoreDelta === 0 && thermalDelta <= 0 && cpuDelta <= 8 && ramDelta <= 5) {
    return {
      outcome: "held-stable",
      helped: true,
      reason: "Health stayed stable without material CPU, RAM, or thermal worsening."
    };
  }
  return {
    outcome: "worsened",
    helped: false,
    reason: "Health, thermal state, CPU pressure, or RAM pressure worsened during the verification window."
  };
}

export function buildGovernorPreventionCandidates(verified = [], at = new Date().toISOString()) {
  const byAction = new Map();
  for (const entry of verified.slice(-MAX_VERIFIED)) {
    const key = entry.selected?.id || "unknown";
    if (!byAction.has(key)) byAction.set(key, []);
    byAction.get(key).push(entry);
  }
  const candidates = [];
  for (const [actionId, entries] of byAction.entries()) {
    const recent = entries.slice(-6);
    if (recent.length < 3) continue;
    const helped = recent.filter((entry) => entry.helped).length;
    const worsened = recent.filter((entry) => entry.outcome === "worsened").length;
    const label = recent.at(-1)?.selected?.label || actionId;
    if (worsened >= 3) {
      candidates.push({
        id: `ml.prevent.${actionId}.caution`,
        actionId,
        label,
        treatment: "delay-or-require-stronger-evidence",
        confidence: worsened >= 4 ? "medium" : "low",
        evidenceCount: recent.length,
        reason: `${label} was followed by worsening in ${worsened}/${recent.length} recent verification windows; treat recurrence more cautiously.`,
        updatedAt: at
      });
    } else if (helped >= 4) {
      candidates.push({
        id: `ml.prevent.${actionId}.prefer-safe-handler`,
        actionId,
        label,
        treatment: "prefer-existing-safe-handler",
        confidence: helped >= 5 ? "medium" : "low",
        evidenceCount: recent.length,
        reason: `${label} held or improved health in ${helped}/${recent.length} recent verification windows; keep it as a favored safe response when the same pattern recurs.`,
        updatedAt: at
      });
    }
  }
  return candidates.slice(0, MAX_PREVENTION).map(normalizePrevention);
}

export function verifyGovernorDecisions(
  store,
  { state = {}, policy = {}, telemetry = {}, adaptivePower = null, at = new Date().toISOString() } = {}
) {
  const normalized = normalizeGovernorDecisionStore(store);
  const nowMs = Date.parse(at) || Date.now();
  const after = metricSnapshot({ state, policy, telemetry, adaptivePower });
  const stillPending = [];
  const verifiedNow = [];
  for (const pending of normalized.pending) {
    const dueMs = Date.parse(pending.dueAt || "");
    if (!Number.isFinite(dueMs) || dueMs > nowMs) {
      stillPending.push(pending);
      continue;
    }
    const outcome = compareOutcome(pending.before, after);
    verifiedNow.push({
      ...pending,
      verifiedAt: at,
      after,
      confidence: "observational",
      ...outcome
    });
  }
  if (!verifiedNow.length) {
    return { store: normalized, verified: [] };
  }
  const verified = [...normalized.verified, ...verifiedNow].slice(-MAX_VERIFIED);
  const preventionCandidates = buildGovernorPreventionCandidates(verified, at);
  return {
    store: {
      ...normalized,
      updatedAt: at,
      pending: stillPending.slice(-MAX_PENDING),
      verified,
      preventionCandidates
    },
    verified: verifiedNow
  };
}

export function summarizeGovernorDecisionLedger(store = {}) {
  const normalized = normalizeGovernorDecisionStore(store);
  const recent = normalized.verified.slice(-20);
  const helped = recent.filter((entry) => entry.helped).length;
  const successPct = recent.length ? Math.round((helped / recent.length) * 100) : null;
  const lastVerified = normalized.verified.at(-1) || null;
  const lastPending = normalized.pending.at(-1) || null;
  const summary = recent.length
    ? `Verified ${recent.length} governor decision(s); ${successPct}% held or improved health.`
    : normalized.pending.length
      ? `${normalized.pending.length} governor decision(s) awaiting verification.`
      : "No governor decisions have completed verification yet.";
  return {
    schema: STORE_SCHEMA,
    level: 4,
    targetLevel: 5,
    status: "verified-shadow-loop",
    pendingCount: normalized.pending.length,
    verifiedCount: normalized.verified.length,
    recentVerifiedCount: recent.length,
    successPct,
    lastPending,
    lastVerified,
    preventionCandidates: normalized.preventionCandidates,
    summary,
    updatedAt: normalized.updatedAt
  };
}
