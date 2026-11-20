import { classifyThermalState } from "./thermal-hierarchy.js";
import { classifyCompetitiveActivity, evaluateSustainedLull } from "./gaming-profile.js";

export const POWER_LADDER = Object.freeze([
  "01 - Power Saver (Emergency)",
  "02 - Endurance Mode",
  "03 - Balanced Mode (Daily Driver)",
  "04 - High Power Mode",
  "05 - Ultra Performance"
]);

const TIER = Object.freeze({ POWER_SAVER: 0, ENDURANCE: 1, BALANCED: 2, HIGH: 3, ULTRA: 4 });

export const MODE_BANDS = Object.freeze({
  conservative: { floor: TIER.POWER_SAVER, ceiling: TIER.BALANCED },
  balanced: { floor: TIER.POWER_SAVER, ceiling: TIER.HIGH },
  performance: { floor: TIER.ENDURANCE, ceiling: TIER.HIGH },
  competitive: { floor: TIER.ENDURANCE, ceiling: TIER.ULTRA },
  agentic: { floor: TIER.ENDURANCE, ceiling: TIER.HIGH },
  overdrive: { floor: TIER.HIGH, ceiling: TIER.ULTRA }
});

const BALANCED_DEFAULT_MODES = new Set(["balanced", "performance", "agentic"]);

const DEMAND_HIGH = 80;
const DEMAND_MODERATE = 55;
const DEMAND_VERY_HIGH = 90;
const DEMAND_HYSTERESIS = 5;
const TARGET_DWELL_MS = 90 * 1000;
const BAND_FIRST_RECOVERY_DWELL_MS = Number(process.env.PC_CONTROL_BAND_FIRST_RECOVERY_DWELL_MS || 30 * 1000);
const MODE_TARGET_DWELL_MS = Object.freeze({
  conservative: 150 * 1000,
  balanced: 150 * 1000,
  agentic: 150 * 1000,
  performance: 75 * 1000,
  competitive: 45 * 1000,
  overdrive: 45 * 1000
});
const GPU_POWER_RATIO_HOT = 0.97;
const LEARN_MIN_SESSIONS = 3;
const LEARN_STRONG_AVG = 85;
const LEARN_WEAK_AVG = 70;
const EMA_ALPHA = 0.55;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function isCompetitiveGamingSession(modeId, telemetry) {
  return modeId === "competitive" && Boolean(telemetry?.priorityApp?.running);
}

export function demandFromTelemetry(telemetry = {}) {
  const cpu = Number(telemetry?.system?.cpuLoadPct);
  const gpu = Number(telemetry?.gpu?.utilizationPct);
  let demand = Math.max(
    Number.isFinite(cpu) ? cpu : 0,
    Number.isFinite(gpu) ? gpu : 0
  );
  if (telemetry?.priorityApp?.running) {
    demand = Math.max(demand, DEMAND_MODERATE);
  }
  return clamp(Math.round(demand), 0, 100);
}

export function learningSignalFromSummary(learning = null, modeId = "balanced") {
  if (!learning) {
    return { guardrailActive: false, avgScore: null, sessions: 0 };
  }
  const profile = learning.profiles?.[modeId] || null;
  const guardrailActive = Array.isArray(learning.guardrails)
    ? learning.guardrails.some((entry) => entry.profileId === modeId)
    : Boolean(profile?.guardrail);
  const thermal = profile?.thermal || { state: "unknown" };
  return {
    guardrailActive,
    avgScore: profile && Number.isFinite(Number(profile.avgScore)) ? Number(profile.avgScore) : null,
    sessions: profile ? Number(profile.sessions) || 0 : 0,
    thermal
  };
}

export function computeAdaptiveTarget({
  modeId = "balanced",
  demand = 0,
  gpuTempC = null,
  cpuTempC = null,
  vramTempC = null,
  storageTempC = null,
  thermalState = null,
  gpuPowerRatio = 0,
  crashSignals = 0,
  health = "Stable",
  predictiveWarm = false,
  gpuReliefActive = false,
  activeCompetitiveSession = false,
  competitiveLull = false,
  competitivePlay = false,
  extendedIdle = false,
  learningSignal = null,
  trialTier = null,
  titleThermal = null
} = {}) {
  const band = MODE_BANDS[modeId] || MODE_BANDS.balanced;
  const { ceiling } = band;
  const bandFloor = band.floor;
  const loadFloorBase = Number.isFinite(Number(band.loadFloor)) ? Number(band.loadFloor) : band.floor;
  const loadFloor = loadFloorBase;
  const reasons = [];

  const restFloor = BALANCED_DEFAULT_MODES.has(modeId)
    ? Math.min(ceiling, Math.max(loadFloor, TIER.BALANCED))
    : loadFloor;
  const criticalFloor = bandFloor;

  let bump = 0;
  const bandSpan = Math.max(0, ceiling - loadFloor);
  if (demand >= DEMAND_VERY_HIGH) {
    bump = bandSpan;
    reasons.push(`very high sustained load ${demand}% — full band to ${POWER_LADDER[ceiling]}`);
  } else if (demand >= DEMAND_HIGH) {
    bump = Math.min(bandSpan, 2);
    reasons.push(`sustained load ${demand}%`);
  } else if (modeId === "competitive" ? demand > DEMAND_MODERATE : demand >= DEMAND_MODERATE) {
    bump = Math.min(bandSpan, 1);
    reasons.push(`moderate load ${demand}%`);
  } else {
    reasons.push(`low load ${demand}%`);
  }

  const normalizedThermalState = thermalState || classifyThermalState({
    system: { cpuTempC, storageTempC },
    gpu: { temperatureC: gpuTempC },
    temperatures: { gpuMemoryC: vramTempC, storageC: storageTempC }
  });
  const thermalAction = normalizedThermalState.recommendedAction || "none";
  const nearPowerLimit = Number(gpuPowerRatio) >= GPU_POWER_RATIO_HOT;
  const strained = health === "Strained";
  const crashed = Number(crashSignals) > 0;

  let learnBump = 0;
  let learningEffect = "none";
  if (learningSignal && !learningSignal.guardrailActive && learningSignal.sessions >= LEARN_MIN_SESSIONS && learningSignal.avgScore != null) {
    const workloadDemand = modeId === "competitive" ? demand > DEMAND_MODERATE : demand >= DEMAND_MODERATE;
    if (learningSignal.avgScore >= LEARN_STRONG_AVG && workloadDemand) {
      learnBump = 1;
      learningEffect = "strong";
      reasons.push(`learning: strong history (avg ${learningSignal.avgScore})`);
    } else if (learningSignal.avgScore < LEARN_WEAK_AVG) {
      learnBump = -1;
      learningEffect = "weak";
      reasons.push(`learning: weak history (avg ${learningSignal.avgScore})`);
    }
  }
  if (
    learningSignal?.thermal?.state === "hot-prone" &&
    modeId !== "competitive" &&
    demand >= DEMAND_MODERATE &&
    !learningSignal.guardrailActive
  ) {
    learnBump = Math.min(learnBump, -1);
    learningEffect = "thermal-caution";
    reasons.push("learning: profile is heat-prone");
  } else if (
    learningSignal?.thermal?.state === "warm-prone" &&
    demand >= DEMAND_HIGH &&
    !learningSignal.guardrailActive
  ) {
    learnBump = Math.min(learnBump, 0);
    if (learningEffect === "strong") {
      learningEffect = "thermal-neutral";
      reasons.push("learning: warm-prone profile cancels upward bias");
    }
  }

  const acceleratorLoad = modeId === "competitive" ? demand > DEMAND_MODERATE : demand >= DEMAND_MODERATE;
  if (
    acceleratorLoad &&
    !learningSignal?.guardrailActive &&
    !crashed &&
    !strained &&
    !nearPowerLimit &&
    normalizedThermalState.severity === "ok" &&
    thermalAction === "none"
  ) {
    const cleanRep = learningSignal?.thermal?.state === "clean";
    const armed = modeId === "competitive" ? true : cleanRep;
    if (armed) {
      learnBump = Math.min(1, learnBump + 1);
      if (learningEffect === "none" || learningEffect === "weak" || learningEffect === "thermal-caution") {
        learningEffect = cleanRep ? "headroom-clean" : "headroom";
      }
      reasons.push(
        cleanRep
          ? "headroom: clean thermal reputation + cool under load — climb one tier sooner"
          : "headroom: live thermal room under load — climb one tier sooner"
      );
    }
  }

  let tier = clamp(loadFloor + bump + learnBump, restFloor, ceiling);

  if (modeId === "competitive" && activeCompetitiveSession) {
    if (competitiveLull) {
      tier = Math.min(tier, bandFloor + 1);
      reasons.push(`competitive lull — leaning to ${POWER_LADDER[bandFloor]} for efficiency`);
    } else if (competitivePlay) {
      tier = clamp(loadFloor + Math.min(bandSpan, bump + 1) + learnBump, restFloor, ceiling);
      reasons.push(`competitive play — leaning toward ${POWER_LADDER[ceiling]} (free to settle lower)`);
    }
  }

  if (modeId === "competitive" && activeCompetitiveSession && competitivePlay
    && Number(trialTier) === 3 && tier > 3) {
    tier = 3;
    reasons.push("band trial: this session runs 04 High (1% lows will judge)");
  }

  const hotWhy = thermalAction !== "none"
    ? normalizedThermalState.summary
    : crashed ? "crash signals" : "strained";
  const warmWhy = thermalAction === "hold-below-ceiling"
    ? normalizedThermalState.summary
    : "near GPU power limit";
  const criticalThermal = normalizedThermalState.severity === "critical"
    || thermalAction === "conservative-cooldown";
  const hotThermal = thermalAction === "floor" || thermalAction === "balanced-downshift";
  const learnerThermalState = learningSignal?.thermal?.state;
  let guard = null;

  if (modeId === "overdrive" && (criticalThermal || hotThermal || crashed || strained)) {
    tier = TIER.BALANCED;
    guard = `overdrive safety downshift to Balanced (${hotWhy})`;
  } else if (criticalThermal) {
    const criticalLean = learnerThermalState === "hot-prone" ? bandSpan + 1 : learnerThermalState === "clean" ? Math.max(1, bandSpan - 1) : bandSpan;
    tier = clamp(tier - criticalLean, criticalFloor, ceiling);
    guard = `critical thermal -> strong ease toward ${POWER_LADDER[tier]} (${hotWhy})`;
  } else if (hotThermal && !crashed && !strained) {
    const hotLean = learnerThermalState === "hot-prone" ? 3 : learnerThermalState === "clean" ? 1 : 2;
    tier = clamp(tier - hotLean, restFloor, ceiling);
    guard = `hot (crucial, not critical) -> ease toward ${POWER_LADDER[tier]} (${hotWhy})`;
  } else if (crashed || strained) {
    tier = restFloor;
    guard = `crash/strain guard -> ${POWER_LADDER[restFloor]} (${hotWhy})`;
  } else if ((thermalAction === "hold-below-ceiling" || nearPowerLimit) && ceiling > restFloor) {
    const warmTitleExtra = titleThermal?.state === "warm-title" ? 1 : 0;
    tier = clamp(Math.min(tier, ceiling - 1 - warmTitleExtra), restFloor, ceiling);
    guard = warmTitleExtra
      ? `${warmWhy} -> hold below ceiling (+1 extra: this title runs warm historically)`
      : `${warmWhy} -> hold below ceiling`;
  } else if (predictiveWarm && ceiling > restFloor) {
    tier = clamp(Math.min(tier, ceiling - 1), restFloor, ceiling);
    guard = "predictive cooling (rising temperature trend) -> hold below ceiling";
  } else if (gpuReliefActive && ceiling > restFloor) {
    tier = clamp(tier - 1, restFloor, ceiling);
    guard = "GPU relief request -> ease one tier inside current mode";
  }

  if (extendedIdle && demand < DEMAND_MODERATE && bandFloor < restFloor) {
    tier = Math.min(tier, bandFloor);
    guard = guard
      ? `${guard}; extended idle rests at ${POWER_LADDER[bandFloor]}`
      : `extended idle -> rest at ${POWER_LADDER[bandFloor]} to save power`;
  }

  if (learningSignal?.guardrailActive) {
    tier = Math.min(tier, restFloor);
    guard = guard ? `${guard}; learned guardrail caps to home base` : "learned guardrail caps to home base";
    learningEffect = "guardrail";
  }

  if (guard) {
    reasons.push(guard);
  }
  tier = clamp(tier, 0, POWER_LADDER.length - 1);

  return {
    plan: POWER_LADDER[tier],
    tier,
    floor: bandFloor,
    loadFloor,
    ceiling,
    demand,
    guard,
    competitiveLull: Boolean(competitiveLull),
    competitivePlay: Boolean(competitivePlay),
    gpuReliefRequested: Boolean(competitiveLull),
    learning: {
      biasTier: learnBump,
      effect: learningEffect,
      guardrailActive: Boolean(learningSignal?.guardrailActive),
      avgScore: learningSignal?.avgScore ?? null,
      sessions: learningSignal?.sessions ?? 0,
      thermal: learningSignal?.thermal || { state: "unknown" }
    },
    thermalState: normalizedThermalState,
    reason: reasons.join("; ")
  };
}

function buildTarget(modeId, telemetry, policy, learning, demand, gamingOverride = null) {
  const signal = learningSignalFromSummary(learning, modeId);
  const activity = classifyCompetitiveActivity(modeId, telemetry);
  const lull = activity.active && (gamingOverride ? Boolean(gamingOverride.lull) : activity.lullInstant);
  const play = activity.active && !lull;
  const gpu = telemetry?.gpu || {};
  const powerRatio = Number(gpu.powerDrawW) > 0 && Number(gpu.powerLimitW) > 0
    ? Number(gpu.powerDrawW) / Number(gpu.powerLimitW)
    : 0;
  const system = telemetry?.system || {};
  const cpuTempC = Number.isFinite(Number(system.cpuTempC))
    ? Number(system.cpuTempC)
    : (Number.isFinite(Number(system.systemTempC)) ? Number(system.systemTempC) : null);
  const activeCompetitiveSession = isCompetitiveGamingSession(modeId, telemetry);
  const actionableCrashSignals = policy?.eventAnalysis?.recentActionableCrashSignals?.length || 0;
  const ramUsedPct = Number.isFinite(Number(system.ramUsedRealPct))
    ? Number(system.ramUsedRealPct)
    : Number(system.ramUsedPct) || 0;
  const hardGamingPressure =
    actionableCrashSignals > 0 ||
    Boolean(policy?.crashRecovery?.nextMode) ||
    Boolean(policy?.failureRemediation?.safetyTargetMode) ||
    Boolean(policy?.failureWatchlist?.autoDownshift) ||
    policy?.thermalState?.severity === "critical" ||
    ramUsedPct >= 95;
  const adaptiveHealth = activeCompetitiveSession && policy?.health?.state === "Strained" && !hardGamingPressure
    ? "Warm"
    : (policy?.health?.state || "Stable");
  return computeAdaptiveTarget({
    modeId,
    demand,
    gpuTempC: gpu.temperatureC ?? telemetry?.temperatures?.gpuC ?? null,
    cpuTempC,
    vramTempC: telemetry?.temperatures?.gpuMemoryC ?? null,
    storageTempC: system.storageTempC ?? telemetry?.temperatures?.storageC ?? null,
    thermalState: policy?.thermalState || classifyThermalState(telemetry, {
      modeId,
      foregroundActive: Boolean(telemetry?.priorityApp?.running),
      gamingSession: activeCompetitiveSession
    }),
    gpuPowerRatio: powerRatio,
    crashSignals: actionableCrashSignals,
    health: adaptiveHealth,
    predictiveWarm: activeCompetitiveSession
      ? false
      : Boolean(telemetry?.thermalTrend?.predictiveWarm),
    gpuReliefActive: Boolean(telemetry?.gpuReliefActive) || lull,
    activeCompetitiveSession,
    competitiveLull: lull,
    competitivePlay: play,
    extendedIdle: Boolean(telemetry?.input?.isExtendedIdle),
    learningSignal: signal,
    trialTier: policy?.competitiveTrial?.tier ?? null,
    titleThermal: policy?.gameTitleThermal ?? null
  });
}

export function resolveAdaptivePlanStateless({ modeId, telemetry, policy = null, learning = null }) {
  return buildTarget(modeId, telemetry, policy, learning, demandFromTelemetry(telemetry));
}

let demandEma = null;
let lastResolved = null;
let competitiveLullSince = null;

function isSoftHoldGuard(guard) {
  return guard === "hysteresis hold" || guard === "dwell hold";
}

function demandBoundaryForTier(floor, tier) {
  if (tier >= floor + 2) {
    return DEMAND_HIGH;
  }
  if (tier >= floor + 1) {
    return DEMAND_MODERATE;
  }
  return 0;
}

function activePlanNameFromTelemetry(telemetry = {}) {
  const line = String(telemetry?.power?.activeLine || "");
  const first = line.indexOf("(");
  const last = line.lastIndexOf(")");
  if (first >= 0 && last > first) {
    return line.slice(first + 1, last);
  }
  return null;
}

function activePlanSeedFromTelemetry(modeId, telemetry, candidate, nowMs) {
  if (lastResolved || candidate.guard) {
    return;
  }
  const activePlan = activePlanNameFromTelemetry(telemetry);
  const activeTier = POWER_LADDER.indexOf(activePlan);
  if (activeTier < candidate.floor || activeTier > candidate.ceiling || activeTier <= candidate.tier) {
    return;
  }
  lastResolved = {
    ...candidate,
    plan: activePlan,
    tier: activeTier,
    guard: null,
    reason: `seeded from active Windows plan ${activePlan}`,
    modeId,
    at: new Date(nowMs).toISOString(),
    changedAtMs: nowMs
  };
}

function currentTierForRecovery(modeId, telemetry, candidate) {
  if (lastResolved?.modeId === modeId && Number.isFinite(Number(lastResolved.tier))) {
    return Number(lastResolved.tier);
  }
  const activePlan = activePlanNameFromTelemetry(telemetry);
  const activeTier = POWER_LADDER.indexOf(activePlan);
  if (activeTier >= candidate.floor && activeTier <= candidate.ceiling) {
    return activeTier;
  }
  return candidate.tier;
}

function applyBandFirstRecoveryJump(modeId, telemetry, candidate, policy = null) {
  const recovery = policy?.bandFirstRecovery;
  if (!recovery?.active || recovery.currentMode !== modeId || candidate.guard) {
    return candidate;
  }
  const currentTier = currentTierForRecovery(modeId, telemetry, candidate);
  if (!Number.isFinite(currentTier) || currentTier >= candidate.ceiling) {
    return candidate;
  }
  if (currentTier >= candidate.tier) {
    return candidate;
  }
  return {
    ...candidate,
    recoveryJump: true,
    reason: `${candidate.reason}; band-first recovery: select ${candidate.plan} within ${modeId} before switching to ${recovery.targetMode}`
  };
}

function dwellMsForMode(modeId) {
  return MODE_TARGET_DWELL_MS[modeId] || TARGET_DWELL_MS;
}

function stabilizeLiveTarget(modeId, candidate, demand, nowMs) {
  const candidateSafetyGuard = Boolean(candidate.guard) && !isSoftHoldGuard(candidate.guard);

  const previousSafetyGuard = lastResolved?.guard && !isSoftHoldGuard(lastResolved.guard);
  if (!lastResolved || lastResolved.modeId !== modeId || candidateSafetyGuard || previousSafetyGuard) {
    return candidate;
  }
  if (candidate.tier === lastResolved.tier) {
    return candidate;
  }

  const movingUp = candidate.tier > lastResolved.tier;
  const boundary = movingUp
    ? demandBoundaryForTier(candidate.floor, candidate.tier)
    : demandBoundaryForTier(candidate.floor, lastResolved.tier);
  const recoveryJump = Boolean(candidate.recoveryJump && movingUp);
  const confirmed = recoveryJump
    ? true
    : movingUp
      ? demand >= boundary + DEMAND_HYSTERESIS
      : demand <= boundary - DEMAND_HYSTERESIS;

  if (confirmed) {
    const changedAtMs = Number(lastResolved.changedAtMs) || Date.parse(lastResolved.at || "");
    const dwellMs = recoveryJump ? BAND_FIRST_RECOVERY_DWELL_MS : dwellMsForMode(modeId);
    if (Number.isFinite(changedAtMs) && nowMs - changedAtMs < dwellMs) {
      const remainingSeconds = Math.ceil((dwellMs - (nowMs - changedAtMs)) / 1000);
      return {
        ...candidate,
        plan: lastResolved.plan,
        tier: lastResolved.tier,
        guard: "dwell hold",
        reason: `${candidate.reason}; ${recoveryJump ? "band-first recovery" : "dwell"} hold at ${lastResolved.plan} for ${remainingSeconds}s`
      };
    }
    return candidate;
  }

  return {
    ...candidate,
    plan: lastResolved.plan,
    tier: lastResolved.tier,
    guard: "hysteresis hold",
    reason: `${candidate.reason}; hysteresis hold at ${lastResolved.plan} near ${boundary}% threshold`
  };
}

export function resolveAdaptivePlan({ modeId, telemetry, policy = null, learning = null, nowMs = Date.now() }) {
  const raw = demandFromTelemetry(telemetry);
  demandEma = demandEma == null ? raw : demandEma * (1 - EMA_ALPHA) + raw * EMA_ALPHA;
  const smoothed = clamp(Math.round(demandEma), 0, 100);
  const gamingActivity = classifyCompetitiveActivity(modeId, telemetry);
  const lullEval = evaluateSustainedLull({ activity: gamingActivity, lullSinceMs: competitiveLullSince, nowMs });
  competitiveLullSince = lullEval.lullSinceMs;
  let candidate = buildTarget(modeId, telemetry, policy, learning, smoothed, { lull: lullEval.lull });
  candidate = applyBandFirstRecoveryJump(modeId, telemetry, candidate, policy);
  activePlanSeedFromTelemetry(modeId, telemetry, candidate, nowMs);
  const result = stabilizeLiveTarget(modeId, candidate, smoothed, nowMs);
  const changedAtMs = lastResolved && lastResolved.modeId === modeId && lastResolved.tier === result.tier
    ? lastResolved.changedAtMs
    : nowMs;
  lastResolved = { ...result, modeId, at: new Date(nowMs).toISOString(), changedAtMs };
  return lastResolved;
}

export function getLastResolvedPlan() {
  return lastResolved;
}

export function __resetAdaptiveState() {
  demandEma = null;
  lastResolved = null;
  competitiveLullSince = null;
}
