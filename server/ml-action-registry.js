
export const ML_EXECUTION_SCHEMA = "pc-control-plane-ml-execution-gate/v1";

export const ML_SAFE_ACTION_REGISTRY = Object.freeze({
  "power.adaptive-tier": Object.freeze({
    actionId: "power.adaptive-tier",
    handler: "convergeInvariants",
    layer: "adaptive-power",
    executable: true,
    authority: "existing-self-heal",
    safety: "Power plan convergence remains bounded by the current mode band and thermal guards."
  }),
  "relief.ram": Object.freeze({
    actionId: "relief.ram",
    handler: "maybeAutonomousRelief",
    layer: "relief",
    executable: true,
    authority: "existing-relief-gates",
    safety: "RAM relief still requires memory pressure, cooldown clearance, and learned backoff clearance."
  }),
  "relief.cpu": Object.freeze({
    actionId: "relief.cpu",
    handler: "maybeAutonomousRelief",
    layer: "relief",
    executable: true,
    authority: "existing-relief-gates",
    safety: "CPU relief remains a short reversible cap and still requires sustained pressure or thermal-floor eligibility."
  }),
  "diagnose.network": Object.freeze({
    actionId: "diagnose.network",
    handler: "maybeAutonomousRelief",
    layer: "diagnostics",
    executable: true,
    authority: "existing-network-diagnosis-gates",
    safety: "Network diagnosis is observe-only; it may refresh DNS/reachability evidence but cannot reset adapters without the separate explicit safe rule."
  }),
  "relief.gpu": Object.freeze({
    actionId: "relief.gpu",
    handler: "maybeAutonomousRelief",
    layer: "relief",
    executable: true,
    authority: "existing-gpu-relief-gates",
    safety: "GPU relief only requests a short in-mode power-band ease; it never changes GPU clocks, voltage, fan curves, drivers, firmware, or process priority."
  }),
  "mode.switch": Object.freeze({
    actionId: "mode.switch",
    handler: "observerModeSwitch",
    layer: "mode-governor",
    executable: false,
    authority: "existing-mode-governor",
    safety: "Ordinary mode switches still require band-first checks, manual hold, stability dwell, cooldown, and guardrails."
  }),
  "mode.safety-downshift": Object.freeze({
    actionId: "mode.safety-downshift",
    handler: "deterministicSafety",
    layer: "deterministic-safety",
    executable: false,
    authority: "safety-bypass",
    safety: "Emergency safety remains deterministic and is never delayed or owned by ML."
  }),
  "mode.band-first-hold": Object.freeze({
    actionId: "mode.band-first-hold",
    handler: "none",
    layer: "mode-governor",
    executable: false,
    authority: "hold-only",
    safety: "Band-first holds do not mutate state; adaptive power handles the in-mode tier."
  }),
  "observe.verify": Object.freeze({
    actionId: "observe.verify",
    handler: "none",
    layer: "verification",
    executable: false,
    authority: "observe-only",
    safety: "Observation has no mutation authority."
  })
});

function verifiedEvidenceFor(decisionLedger = {}, actionId) {
  const last = decisionLedger.lastVerified || null;
  if (last?.selected?.id === actionId && last.helped) {
    return {
      available: true,
      reason: `Last verified outcome for ${actionId} ${last.outcome}.`
    };
  }
  const candidate = (decisionLedger.preventionCandidates || [])
    .find((entry) => entry.actionId === actionId && entry.treatment === "prefer-existing-safe-handler");
  if (candidate) {
    return {
      available: true,
      reason: candidate.reason
    };
  }
  return {
    available: false,
    reason: "Waiting for a verified helped/stable outcome before Level 5 delegation."
  };
}

function reliefGateOpen(actionId, relief = {}) {
  if (actionId === "relief.ram") {
    return relief.ram?.autonomousAllowed === true;
  }
  if (actionId === "relief.cpu") {
    return relief.cpu?.autonomousAllowed === true;
  }
  if (actionId === "diagnose.network") {
    return relief.network?.autonomousAllowed === true;
  }
  if (actionId === "relief.gpu") {
    return relief.gpu?.autonomousAllowed === true;
  }
  return true;
}

export function buildMlExecutionGate({
  governor = {},
  decisionLedger = {},
  state = {},
  relief = {}
} = {}) {
  const selected = governor.selected || {};
  const actionId = String(selected.id || "observe.verify");
  const registry = ML_SAFE_ACTION_REGISTRY[actionId] || null;
  const blockedBy = [];
  if (!registry) {
    blockedBy.push("selected action is not in the deterministic safe-action registry");
  }
  if (selected.allowed === false || selected.autonomous === false) {
    blockedBy.push("selected action is not allowed by the governor safety shield");
  }
  if (registry && !registry.executable) {
    blockedBy.push("selected action is observed or handled by a separate deterministic path");
  }
  if (state.autonomy !== "auto-safe") {
    blockedBy.push("autonomy is not auto-safe");
  }
  if (!reliefGateOpen(actionId, relief)) {
    blockedBy.push("relief gate is closed");
  }
  const evidence = verifiedEvidenceFor(decisionLedger, actionId);
  if (registry?.executable && !evidence.available) {
    blockedBy.push(evidence.reason);
  }
  const eligible = Boolean(registry?.executable) && blockedBy.length === 0;
  return {
    schema: ML_EXECUTION_SCHEMA,
    level: 5,
    status: eligible ? "eligible-existing-handler" : "waiting",
    actionId,
    label: selected.label || registry?.actionId || "Keep monitoring",
    handler: registry?.handler || null,
    layer: registry?.layer || selected.layer || "unknown",
    authority: registry?.authority || "none",
    eligible,
    delegatedToExistingHandler: eligible,
    blockedBy,
    evidence,
    safety: registry?.safety || "No registered safety contract.",
    summary: eligible
      ? `Level 5 gate may delegate ${actionId} to ${registry.handler}; existing deterministic gates still apply.`
      : `Level 5 gate is waiting: ${blockedBy[0] || "no executable safe handler selected"}.`
  };
}
