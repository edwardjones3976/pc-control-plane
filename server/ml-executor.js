
export const ML_EXECUTOR_SCHEMA = "pc-control-plane-ml-executor/v1";

export const ML_EXECUTOR_COOLDOWN_MS = 8000;

function suppressingCandidate(decisionLedger = {}, actionId) {
  const list = Array.isArray(decisionLedger?.preventionCandidates) ? decisionLedger.preventionCandidates : [];
  return list.find((c) =>
    c &&
    c.actionId === actionId &&
    c.treatment === "delay-or-require-stronger-evidence" &&
    (c.confidence === "medium" || c.confidence === "high")
  ) || null;
}

export function mlPreventionSuppressed(decisionLedger, actionId) {
  return Boolean(suppressingCandidate(decisionLedger, actionId));
}

export function planMlExecution({
  gate = {},
  automations = {},
  state = {},
  decisionLedger = {},
  nowMs = Date.now(),
  lastExecMs = 0
} = {}) {
  const enabled = automations?.mlExecution !== false;          // default ON
  const autoSafe = state?.autonomy === "auto-safe";
  const active = enabled && autoSafe;
  const actionId = String(gate?.actionId || "observe.verify");
  const handler = gate?.handler || null;
  const eligible = Boolean(gate?.eligible);
  const cooldownMs = Math.max(0, Number(automations?.mlExecutionCooldownMs) || ML_EXECUTOR_COOLDOWN_MS);
  const cooldownPassed = nowMs - Number(lastExecMs || 0) >= cooldownMs;
  const selectedSuppressed = active && mlPreventionSuppressed(decisionLedger, actionId);

  const executeSelected = active && eligible && cooldownPassed && !selectedSuppressed;

  const suppressRamRelief = active && mlPreventionSuppressed(decisionLedger, "relief.ram");
  const suppressCpuRelief = active && mlPreventionSuppressed(decisionLedger, "relief.cpu");
  const suppressNetworkDiagnosis = active && mlPreventionSuppressed(decisionLedger, "diagnose.network");
  const suppressGpuRelief = active && mlPreventionSuppressed(decisionLedger, "relief.gpu");

  let status;
  if (!enabled) status = "disabled";
  else if (!autoSafe) status = "idle";
  else if (selectedSuppressed) status = "prevention-hold";
  else if (executeSelected) status = "executing";
  else if (eligible && !cooldownPassed) status = "cooldown";
  else status = "monitoring";

  const reason = !enabled
    ? "Autonomous executor is turned off (kill switch); deterministic self-heal still runs."
    : !autoSafe
      ? "Autonomy is not auto-safe; executor idle."
      : selectedSuppressed
        ? `Holding ${actionId}: verified prevention flagged it as recently worsening.`
        : executeSelected
          ? `Executing ${actionId} via ${handler || "existing handler"} on verified evidence.`
          : eligible && !cooldownPassed
            ? "Within executor cooldown."
            : (gate?.evidence?.reason || "Waiting for verified evidence before autonomous execution.");

  return {
    schema: ML_EXECUTOR_SCHEMA,
    level: 5,
    enabled,
    active,
    status,
    actionId,
    handler,
    eligible,
    executeSelected,
    suppressRamRelief,
    suppressCpuRelief,
    suppressNetworkDiagnosis,
    suppressGpuRelief,
    evidence: gate?.evidence?.reason || null,
    reason
  };
}
