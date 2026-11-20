
const GOVERNOR_SCHEMA = "pc-control-plane-ml-governor/v1";

export const ML_AUTONOMY_LEVELS = Object.freeze({
  current: 5,
  target: 5,
  currentLabel: "North-star optimizer with deterministic execution shield",
  targetLabel: "Broad autonomous diagnosis, bounded experimentation, verification, learning, and recurrence prevention"
});

export const ML_SAFETY_INVARIANTS = Object.freeze([
  "thermal critical limits are deterministic and cannot be relaxed",
  "mode power bands are hard floors/ceilings",
  "Overdrive remains user-only",
  "protected apps and core system processes are never killed, suspended, or deprioritized",
  "relief actions stay reversible and bounded",
  "learning may suppress, delay, or rank actions but may not bypass safety gates",
  "optimizer hypotheses may be broad, but executable experiments must be registry-backed",
  "raw model output is advisory until it passes the deterministic action shield"
]);

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function normalizeAction(action = {}) {
  const risk = action.risk || "low";
  const score = clamp(action.score);
  return {
    id: String(action.id || "observe"),
    label: String(action.label || "Keep monitoring"),
    layer: action.layer || "observe",
    intent: action.intent || "stabilize",
    score,
    risk,
    allowed: action.allowed !== false,
    autonomous: action.autonomous !== false,
    reason: action.reason || "No additional reason.",
    evidence: Array.isArray(action.evidence) ? action.evidence.filter(Boolean).slice(0, 8) : [],
    blockedBy: Array.isArray(action.blockedBy) ? action.blockedBy.filter(Boolean).slice(0, 8) : []
  };
}

function safetyBlocked(action = {}, context = {}) {
  const blockedBy = [];
  if (action.destructive) {
    blockedBy.push("destructive process control is outside the safety contract");
  }
  if (action.id === "mode.overdrive.auto") {
    blockedBy.push("Overdrive is user-only");
  }
  if (action.id === "relief.ram" && context.relief?.ram?.autonomousAllowed !== true) {
    blockedBy.push(context.relief?.ram?.summary || "RAM relief gate is closed");
  }
  if (action.id === "relief.cpu" && context.relief?.cpu?.autonomousAllowed !== true) {
    blockedBy.push(context.relief?.cpu?.summary || "CPU relief gate is closed");
  }
  if (action.id === "diagnose.network" && context.relief?.network?.autonomousAllowed !== true) {
    blockedBy.push(context.relief?.network?.summary || "Network diagnosis gate is closed");
  }
  if (action.id === "relief.gpu" && context.relief?.gpu?.autonomousAllowed !== true) {
    blockedBy.push(context.relief?.gpu?.summary || "GPU relief gate is closed");
  }
  if (action.id === "mode.switch" && context.safetyModeTarget) {
    return blockedBy;
  }
  if (action.id === "mode.switch" && context.policy?.suggestedMode === "overdrive") {
    blockedBy.push("Overdrive cannot be auto-selected");
  }
  return blockedBy;
}

function addCandidate(candidates, action, context) {
  const blockedBy = safetyBlocked(action, context);
  candidates.push(normalizeAction({
    ...action,
    allowed: blockedBy.length === 0,
    autonomous: blockedBy.length === 0 && action.autonomous !== false,
    blockedBy: [...(action.blockedBy || []), ...blockedBy]
  }));
}

function efficacyFor(summary = {}, actionId) {
  const found = (summary.actions || []).find((entry) => entry.action === actionId);
  return found?.effectivenessPct ?? null;
}

function efficacyBias(summary = {}, actionId) {
  const pct = efficacyFor(summary, actionId);
  if (pct == null) return 0;
  if (pct >= 75) return 8;
  if (pct >= 50) return 3;
  if (pct < 25) return -18;
  return -6;
}

function learningProfile(learning = {}, modeId = null) {
  return modeId ? learning.profiles?.[modeId] || null : null;
}

function pressureEvidence(telemetry = {}, policy = {}) {
  const system = telemetry.system || {};
  const thermal = policy.thermalState || {};
  return [
    `CPU ${Math.round(finite(system.cpuLoadPct))}%`,
    `RAM ${Math.round(finite(system.ramUsedPct))}%`,
    thermal.summary ? `Thermal ${thermal.summary}` : null,
    policy.priority?.label ? `Priority ${policy.priority.label}` : null
  ].filter(Boolean);
}

export function buildAutonomousMlGovernor({
  state = {},
  telemetry = {},
  policy = {},
  learning = {},
  efficacy = {},
  relief = {},
  adaptivePower = null,
  decisionLedger = null
} = {}) {
  const modeId = state.modeId || "balanced";
  const targetMode = policy.suggestedMode || modeId;
  const profile = learningProfile(learning, targetMode);
  const efficacySummary = efficacy || {};
  const context = {
    state,
    telemetry,
    policy,
    learning,
    efficacy: efficacySummary,
    relief,
    adaptivePower,
    decisionLedger,
    safetyModeTarget: policy.failureRemediation?.safetyTargetMode || policy.crashRecovery?.nextMode || null
  };
  const candidates = [];
  const baseEvidence = pressureEvidence(telemetry, policy);

  if (context.safetyModeTarget && context.safetyModeTarget !== modeId) {
    addCandidate(candidates, {
      id: "mode.safety-downshift",
      label: `Safety mode shift to ${context.safetyModeTarget}`,
      layer: "deterministic-safety",
      intent: "protect",
      score: 100,
      risk: "safety",
      reason: "Safety target from crash/failure/thermal policy bypasses ML ranking.",
      evidence: baseEvidence
    }, context);
  }

  if (adaptivePower?.plan) {
    const guardBoost = adaptivePower.guard ? 14 : 0;
    addCandidate(candidates, {
      id: "power.adaptive-tier",
      label: `Converge power tier to ${adaptivePower.plan}`,
      layer: "adaptive-power",
      intent: "stabilize",
      score: 58 + guardBoost + efficacyBias(efficacySummary, "power.adaptive-tier"),
      risk: "low",
      reason: adaptivePower.reason || adaptivePower.guard || "Adaptive power target is the primary non-destructive control.",
      evidence: [
        ...baseEvidence,
        adaptivePower.guard ? `Guard: ${adaptivePower.guard}` : null,
        Number.isFinite(Number(adaptivePower.tier)) ? `Tier ${adaptivePower.tier}` : null
      ]
    }, context);
  }

  if (policy.bandFirstRecovery?.active || policy.priority?.posture === "cooling") {
    addCandidate(candidates, {
      id: "mode.band-first-hold",
      label: "Use in-mode power band before mode switch",
      layer: "mode-governor",
      intent: policy.bandFirstRecovery?.active ? "recover" : "cool",
      score: 74,
      risk: "low",
      reason: policy.bandFirstRecovery?.reason || "Power tier should move inside the current mode before switching modes.",
      evidence: baseEvidence
    }, context);
  }

  if (targetMode !== modeId && targetMode !== "overdrive") {
    const targetProfile = learningProfile(learning, targetMode);
    const guardrailPenalty = targetProfile?.guardrail ? -40 : 0;
    const score = 52 + (profile?.avgScore ? Math.round((Number(profile.avgScore) - 70) / 4) : 0) + guardrailPenalty;
    addCandidate(candidates, {
      id: "mode.switch",
      label: `Switch mode to ${targetMode}`,
      layer: "mode-governor",
      intent: "match-context",
      score,
      risk: "medium",
      reason: policy.priority?.reason || "Policy suggested a different operating mode.",
      evidence: [
        ...baseEvidence,
        targetProfile?.guardrail ? `Guardrail: ${targetProfile.guardrail.reason}` : null,
        profile?.avgScore ? `Target avg score ${profile.avgScore}` : null
      ]
    }, context);
  }

  if (relief?.ram?.enabled !== false) {
    addCandidate(candidates, {
      id: "relief.ram",
      label: "Run autonomous RAM relief",
      layer: "relief",
      intent: "relieve-memory",
      score: (relief.ram?.autonomousAllowed ? 70 : 24) + efficacyBias(efficacySummary, "relief.ram"),
      risk: "low",
      reason: relief.ram?.summary || "RAM relief is evaluated by pressure, cooldown, and learned backoff.",
      evidence: [
        ...baseEvidence,
        relief.ram?.latestSample ? `Last RAM relief ${relief.ram.latestSample.effective ? "helped" : "did not help"}` : null
      ]
    }, context);
  }

  if (relief?.cpu?.enabled !== false) {
    addCandidate(candidates, {
      id: "relief.cpu",
      label: "Run soft CPU relief",
      layer: "relief",
      intent: "relieve-cpu",
      score: (relief.cpu?.autonomousAllowed ? 72 : 26) + efficacyBias(efficacySummary, "relief.cpu"),
      risk: "low",
      reason: relief.cpu?.summary || "CPU relief is evaluated by sustained pressure, floor state, cooldown, and learned backoff.",
      evidence: [
        ...baseEvidence,
        relief.cpu?.pressureStreak != null ? `CPU streak ${relief.cpu.pressureStreak}/${relief.cpu.sustainedSamples}` : null
      ]
    }, context);
  }

  if (relief?.network?.enabled !== false) {
    addCandidate(candidates, {
      id: "diagnose.network",
      label: "Run network diagnosis",
      layer: "diagnostics",
      intent: "diagnose-network",
      score: (relief.network?.autonomousAllowed ? 67 : 22) + efficacyBias(efficacySummary, "diagnose.network"),
      risk: "low",
      reason: relief.network?.summary || "Network diagnosis is evaluated by network health, cooldown, and learned backoff.",
      evidence: [
        ...baseEvidence,
        relief.network?.networkState ? `Network ${relief.network.networkState}` : null,
        relief.network?.issues?.[0] || null
      ]
    }, context);
  }

  if (relief?.gpu?.enabled !== false) {
    addCandidate(candidates, {
      id: "relief.gpu",
      label: "Run GPU relief",
      layer: "relief",
      intent: "relieve-gpu",
      score: (relief.gpu?.autonomousAllowed ? 73 : 25) + efficacyBias(efficacySummary, "relief.gpu"),
      risk: "low",
      reason: relief.gpu?.summary || "GPU relief is evaluated by GPU/VRAM thermal pressure, power pressure, cooldown, and learned backoff.",
      evidence: [
        ...baseEvidence,
        relief.gpu?.signals?.reason || null,
        relief.gpu?.holdUntil ? `Hold active until ${relief.gpu.holdUntil}` : null
      ]
    }, context);
  }

  addCandidate(candidates, {
    id: "observe.verify",
    label: "Keep monitoring and verify",
    layer: "verification",
    intent: "verify",
    score: 35,
    risk: "none",
    reason: "No higher-ranked allowed action is required yet.",
    evidence: baseEvidence
  }, context);

  const ranked = candidates
    .map(normalizeAction)
    .sort((a, b) => Number(b.allowed) - Number(a.allowed) || b.score - a.score || a.risk.localeCompare(b.risk));
  const selected = ranked.find((candidate) => candidate.allowed && candidate.autonomous) || ranked[0] || normalizeAction();
  const blocked = ranked.filter((candidate) => !candidate.allowed);
  const recommendations = ranked.filter((candidate) => candidate.allowed).slice(0, 5);

  return {
    schema: GOVERNOR_SCHEMA,
    level: ML_AUTONOMY_LEVELS.current,
    targetLevel: ML_AUTONOMY_LEVELS.target,
    status: "safe-handler-gated",
    summary: `Level ${ML_AUTONOMY_LEVELS.current} governor ranked ${recommendations.length} allowed action(s) for the north-star optimizer and existing safe handlers; top: ${selected.label}. ${decisionLedger?.summary || "Decision verification is collecting evidence."}`,
    selected,
    recommendations,
    blocked,
    safetyInvariants: [...ML_SAFETY_INVARIANTS],
    decisionLedger: decisionLedger || null,
    learningInputs: {
      profiles: Object.keys(learning.profiles || {}).length,
      guardrails: Array.isArray(learning.guardrails) ? learning.guardrails.length : 0,
      efficacyActions: Array.isArray(efficacySummary.actions) ? efficacySummary.actions.length : 0,
      verifiedDecisions: Number(decisionLedger?.verifiedCount) || 0,
      preventionCandidates: Array.isArray(decisionLedger?.preventionCandidates) ? decisionLedger.preventionCandidates.length : 0,
      reliefLearning: {
        ram: relief?.ram?.latestSample || null,
        cpu: relief?.cpu?.latestSample || null,
        network: relief?.network?.latestSample || null,
        gpu: relief?.gpu?.latestSample || null
      }
    }
  };
}
