import crypto from "node:crypto";
import { getAdapterManifest } from "./adapters.js";
import {
  currentPowerPlanName,
  desiredStateForMode,
  getModeInvariant,
  summarizeInvariantStatus
} from "./invariants.js";
import { evaluatePolicy, getMode } from "./policy.js";
import { resolveAdaptivePlanStateless } from "./power-adaptive.js";

const trustRisk = Object.freeze({
  observe: "low",
  recommend: "low",
  "auto-safe": "low",
  session: "medium",
  elevated: "high",
  "manual-only": "blocked"
});

const riskRank = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
  blocked: 4
});

export function createCorrelationId(prefix = "plan") {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function modeCooldown(state, nowMs, cooldownMs) {
  const lastApplied = state?.lastAppliedAt ? Date.parse(state.lastAppliedAt) : 0;
  if (!lastApplied || !Number.isFinite(lastApplied)) {
    return { active: false, remainingMs: 0 };
  }
  const elapsed = nowMs - lastApplied;
  return {
    active: elapsed >= 0 && elapsed < cooldownMs,
    remainingMs: Math.max(0, cooldownMs - elapsed)
  };
}

function actionRisk(action) {
  if (action.status === "refused") return "blocked";
  return trustRisk[action.trustLevel] || "medium";
}

function aggregateRisk(actions) {
  return actions.reduce((max, action) => {
    const risk = actionRisk(action);
    return riskRank[risk] > riskRank[max] ? risk : max;
  }, "low");
}

function planAction({
  id,
  label,
  adapterId,
  type,
  mutation = false,
  trustLevel = null,
  reason,
  current,
  desired,
  status = "planned",
  refusalReason = null
}) {
  const adapter = getAdapterManifest(adapterId);
  return {
    id,
    label,
    adapterId,
    adapterVersion: adapter?.version || null,
    type,
    mutation,
    trustLevel: trustLevel || adapter?.trustLevel || "recommend",
    status,
    reason,
    current,
    desired,
    verification: adapter?.verification || "No verification contract.",
    rollback: mutation ? adapter?.rollback || "No rollback contract." : "No mutation.",
    refusalReason
  };
}

export function planPolicy({
  telemetry,
  modeId,
  state = {},
  history = {},
  config = {},
  correlationId = createCorrelationId()
}) {
  const targetMode = getMode(modeId || state.modeId || "balanced");
  const policy = evaluatePolicy(telemetry, { ...state, modeId: targetMode.id });
  const invariant = getModeInvariant(targetMode.id);
  const desiredState = desiredStateForMode(targetMode.id);
  const adaptive = resolveAdaptivePlanStateless({
    modeId: targetMode.id,
    telemetry,
    policy,
    learning: config.learning || null
  });
  const targetPowerPlan = adaptive?.plan || desiredState.powerPlan;
  const activePowerPlan = currentPowerPlanName(telemetry);
  const currentState = {
    modeId: state.modeId || "balanced",
    modeLabel: getMode(state.modeId).label,
    powerPlan: activePowerPlan,
    hags: telemetry?.power?.hags ?? null,
    highLoadRunning: Boolean(telemetry?.priorityApp?.running),
    health: policy.health.state,
    priority: policy.priority.label,
    offenderCount: policy.offenders.length,
    crashSignals: policy.eventAnalysis.crashSignals.length,
    hardwareSignals: policy.eventAnalysis.hardwareSignals.length,
    failureSignals: policy.failureWatchlist?.activeCount || 0
  };
  const diffs = [];
  const actions = [];
  const refusalReasons = [];
  const nowMs = Number(config.nowMs) || Date.now();
  const cooldownMs = Number(config.cooldownMs) || 20000;
  const cooldown = config.ignoreModeCooldown
    ? { active: false, remainingMs: 0 }
    : modeCooldown(state, nowMs, cooldownMs);

  function addDiff(field, current, desired) {
    diffs.push({
      field,
      current,
      desired,
      matches: current === desired
    });
  }

  function refuse(message, details = {}) {
    refusalReasons.push({ message, ...details });
  }

  addDiff("mode", currentState.modeId, desiredState.modeId);
  addDiff("powerPlan", currentState.powerPlan, targetPowerPlan);
  if (desiredState.priorityApp?.configRequired) {
    addDiff("sessionPrep.framePacing", "unknown", desiredState.priorityApp.framePacing || "unrestricted");
  }

  if (invariant.refusalWhenStrained && policy.health.state === "Strained") {
    refuse(`${targetMode.label} is refused while health is Strained.`, {
      field: "health",
      current: policy.health.state,
      desired: "Stable or Warm"
    });
  }
  if (
    policy.failureWatchlist?.blockHighModes &&
    ["competitive", "performance", "overdrive"].includes(targetMode.id)
  ) {
    refuse(`${targetMode.label} is refused while a recent critical failure signature is active.`, {
      field: "failureWatchlist",
      current: policy.failureWatchlist.active[0]?.label || "Recent critical failure",
      desired: "No recent critical crash signatures"
    });
  }

  if (currentState.modeId !== targetMode.id) {
    actions.push(
      planAction({
        id: "state.set-mode",
        label: `Set active mode to ${targetMode.label}`,
        adapterId: "state-store",
        type: "state.setMode",
        mutation: true,
        reason: "The selected mode differs from the persisted mode.",
        current: currentState.modeId,
        desired: targetMode.id,
        status: cooldown.active ? "blocked" : "planned",
        refusalReason: cooldown.active
          ? `Mode cooldown active for ${Math.ceil(cooldown.remainingMs / 1000)}s.`
          : null
      })
    );
  }

  if (targetPowerPlan && currentState.powerPlan !== targetPowerPlan) {
    actions.push(
      planAction({
        id: "power.set-plan",
        label: `Set power plan to ${targetPowerPlan}`,
        adapterId: "power-plan",
        type: "power.setPlan",
        mutation: true,
        reason: adaptive?.reason
          ? `Adaptive target for ${targetMode.label}: ${adaptive.reason}.`
          : "The current power plan does not match the target invariant.",
        current: currentState.powerPlan || "Unknown",
        desired: targetPowerPlan
      })
    );
  }

  if (desiredState.priorityApp?.configRequired) {
    actions.push(
      planAction({
        id: "session.apply-prep",
        label: "Apply competitive gaming session prep",
        adapterId: "session-config",
        type: "session.applyPrep",
        mutation: true,
        reason: "Competitive gaming sessions use high-power system prep with unrestricted pacing.",
        current: "Current session prep unknown",
        desired: "High-power plan with no frame cap or workload pacing limit"
      })
    );
  }

  if (policy.offenders.length > 0) {
    actions.push(
      planAction({
        id: "process.review-offenders",
        label: `Review ${policy.offenders.length} offender(s)`,
        adapterId: "process-control",
        type: "process.review",
        mutation: false,
        trustLevel: "recommend",
        reason: "Background load crossed the active mode thresholds.",
        current: `${policy.offenders.length} offender(s)`,
        desired: "No unchecked offenders"
      })
    );
  }

  if (policy.eventAnalysis.crashSignals.length > 0 || policy.eventAnalysis.hardwareSignals.length > 0) {
    actions.push(
      planAction({
        id: "diagnostics.crash-correlation",
        label: "Correlate crash and hardware events",
        adapterId: "event-log",
        type: "diagnostics.crashCorrelation",
        mutation: false,
        trustLevel: "observe",
        reason: "Recent crash or hardware/driver signals are present.",
        current: `${policy.eventAnalysis.crashSignals.length} crash / ${policy.eventAnalysis.hardwareSignals.length} hardware-driver`,
        desired: "No recent critical signals"
      })
    );
  }
  if (policy.failureWatchlist?.activeCount > 0) {
    const topFailure = policy.failureWatchlist.active[0];
    actions.push(
      planAction({
        id: "diagnostics.failure-watch",
        label: `Review failure watch: ${topFailure.label}`,
        adapterId: "event-log",
        type: "diagnostics.failureWatch",
        mutation: false,
        trustLevel: "observe",
        reason: `${policy.failureWatchlist.activeCount} guarded failure signature(s) matched current evidence.`,
        current: topFailure.label,
        desired: "No active guarded failure signatures"
      })
    );
  }
  if (policy.fastPatchPlan?.active) {
    actions.push(
      planAction({
        id: "stability.fast-patch-plan",
        label: "Prepare fast stability patch",
        adapterId: "event-log",
        type: "stability.fastPatchPlan",
        mutation: false,
        trustLevel: "recommend",
        reason: policy.fastPatchPlan.actions[0],
        current: `${policy.failureWatchlist?.activeCount || 0} active failure signature(s)`,
        desired: "Bounded mitigation selected before relaunch"
      })
    );
  }

  const blockedActions = actions.filter((action) => action.status === "blocked");
  for (const action of blockedActions) {
    refuse(action.refusalReason || `${action.label} is blocked.`, { actionId: action.id });
  }

  const mutationActions = actions.filter((action) => action.mutation && action.status === "planned");
  const rollbackPath = mutationActions.map((action) => ({
    actionId: action.id,
    adapterId: action.adapterId,
    rollback: action.rollback
  }));

  return {
    ok: refusalReasons.length === 0,
    dryRun: true,
    version: "2.0.0",
    correlationId,
    createdAt: new Date(nowMs).toISOString(),
    targetMode: {
      id: targetMode.id,
      label: targetMode.label
    },
    currentState,
    desiredState,
    diffs,
    invariantStatus: summarizeInvariantStatus(
      telemetry,
      { ...state, modeId: targetMode.id },
      policy,
      { desiredPowerPlan: targetPowerPlan }
    ),
    plannedActions: actions,
    risk: aggregateRisk(actions),
    rollbackPath,
    refusalReasons,
    history: {
      lastAppliedAt: state.lastAppliedAt || null,
      cooldownActive: cooldown.active,
      cooldownRemainingMs: cooldown.remainingMs,
      priorPlans: history.priorPlans || 0
    }
  };
}

export function executableActions(plan) {
  return (plan?.plannedActions || []).filter((action) => action.mutation && action.status === "planned");
}
