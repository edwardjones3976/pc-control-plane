import { appendLedgerEvent } from "./ledger.js";
import { currentPowerPlanName } from "./invariants.js";
import { resolveAdaptivePlan } from "./power-adaptive.js";
import { getMode } from "./policy.js";
import { appendAudit, setPowerPlanByName } from "./system.js";

const MAX_HEALS_PER_HOUR = 4;
const LOSING_FIGHT_THRESHOLD = 3;
const POWER_PLAN_SETTLE_MS = 45 * 1000;
const DISABLE_MS_RATE_LIMIT = 60 * 60 * 1000;
const DISABLE_MS_LOSING_FIGHT = 2 * 60 * 60 * 1000;

const healState = {
  attempts: {}, // invariantId -> [timestamps]
  consecutiveFailures: {}, // invariantId -> count
  disabledUntil: {}, // invariantId -> timestamp
  lastDisableReason: {},
  lastExpected: null, // last adaptive target we converged toward
  lastPowerPlanHealAt: 0,
  lastPowerPlanHealExpected: null
};

function recentAttempts(id) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  healState.attempts[id] = (healState.attempts[id] || []).filter((ts) => ts > cutoff);
  return healState.attempts[id];
}

function disableInvariant(id, ms, reason) {
  healState.disabledUntil[id] = Date.now() + ms;
  healState.lastDisableReason[id] = reason;
}

export function getConvergenceState() {
  return {
    attempts: Object.fromEntries(
      Object.entries(healState.attempts).map(([id, list]) => [id, list.length])
    ),
    consecutiveFailures: { ...healState.consecutiveFailures },
    disabledUntil: { ...healState.disabledUntil },
    lastDisableReason: { ...healState.lastDisableReason },
    lastPowerPlanHealAt: healState.lastPowerPlanHealAt,
    lastPowerPlanHealExpected: healState.lastPowerPlanHealExpected
  };
}

async function healPowerPlan({ expected, actual, modeLabel, reason = null }) {
  const id = "power-plan";
  const correlationId = `selfheal-${Date.now().toString(36)}`;

  if (healState.lastExpected !== expected) {
    healState.attempts[id] = [];
    healState.consecutiveFailures[id] = 0;
    healState.lastExpected = expected;
  }

  if ((healState.disabledUntil[id] || 0) > Date.now()) {
    return { id, healed: false, skipped: "cooling-off" };
  }

  if (
    healState.lastPowerPlanHealExpected === expected &&
    Date.now() - healState.lastPowerPlanHealAt < POWER_PLAN_SETTLE_MS
  ) {
    return { id, healed: false, skipped: "settling" };
  }

  const attempts = recentAttempts(id);
  if (attempts.length >= MAX_HEALS_PER_HOUR) {
    disableInvariant(id, DISABLE_MS_RATE_LIMIT, "rate-limit");
    await appendAudit({
      level: "warn",
      action: "selfheal.rate-limited",
      message: `Power plan drifted ${attempts.length + 1}x in an hour; something keeps changing it. Pausing self-heal for 60m.`,
      details: { expected, actual, attempts: attempts.length }
    });
    return { id, healed: false, skipped: "rate-limit" };
  }

  attempts.push(Date.now());
  const result = await setPowerPlanByName(expected, false);
  const healed = Boolean(result.ok);

  if (healed) {
    healState.consecutiveFailures[id] = 0;
    healState.lastPowerPlanHealAt = Date.now();
    healState.lastPowerPlanHealExpected = expected;
  } else {
    healState.consecutiveFailures[id] = (healState.consecutiveFailures[id] || 0) + 1;
    if (healState.consecutiveFailures[id] >= LOSING_FIGHT_THRESHOLD) {
      disableInvariant(id, DISABLE_MS_LOSING_FIGHT, "losing-fight");
      await appendAudit({
        level: "warn",
        action: "selfheal.losing-fight",
        message: `Re-applying the power plan failed ${LOSING_FIGHT_THRESHOLD}x in a row. Backing off for 2h — check for a conflicting tool.`,
        details: { expected, actual }
      });
    }
  }

  await appendAudit({
    level: healed ? "action" : "warn",
    action: "selfheal.power-plan",
    message: healed
      ? `Adaptive power: set "${expected}" for ${modeLabel} (was "${actual}")${reason ? ` — ${reason}` : ""}.`
      : `Adaptive power attempt failed: could not set "${expected}".`,
    details: { expected, actual, mode: modeLabel, reason, correlationId, result: result.message }
  });
  await appendLedgerEvent({
    correlationId,
    action: "selfheal.power-plan",
    status: healed ? "completed" : "failed",
    adapterId: "power-plan",
    adapterVersion: "2.0.0",
    message: `Converged power plan from "${actual}" to "${expected}".`,
    details: { expected, actual, mode: modeLabel, reason }
  });

  return { id, healed };
}

export async function convergeInvariants({ state, telemetry, policy = null, learning = null }) {
  const results = { healed: [], skipped: [] };
  if (state.autonomy !== "auto-safe" || state.pinned) {
    return results;
  }
  if (state.automations?.selfHeal === false) {
    return results;
  }

  const mode = getMode(state.modeId);
  const resolved = resolveAdaptivePlan({ modeId: mode.id, telemetry, policy, learning });
  const expectedPower = resolved?.plan || mode.powerPlanName;
  const actualPower = currentPowerPlanName(telemetry);

  if (expectedPower && actualPower && expectedPower !== actualPower) {
    const outcome = await healPowerPlan({
      expected: expectedPower,
      actual: actualPower,
      modeLabel: mode.label,
      reason: resolved?.reason || null
    });
    (outcome.healed ? results.healed : results.skipped).push(outcome);
  }

  return results;
}
