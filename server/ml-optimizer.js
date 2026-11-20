
import { ML_SAFE_ACTION_REGISTRY } from "./ml-action-registry.js";

const OPTIMIZER_SCHEMA = "pc-control-plane-ml-optimizer/v1";

export const NORTH_STAR_LEVEL5_IDEOLOGY = Object.freeze([
  "broad hypothesis search across telemetry, policy, learning, efficacy, relief, failures, and readiness",
  "bounded experiments instead of blind actions",
  "verified outcomes become prevention or stronger future treatment",
  "execution remains constrained to the deterministic safe-action registry",
  "unsafe, irreversible, or unregistered changes stay advisory until hardened"
]);

const SEARCH_DOMAINS = Object.freeze([
  "power-fit",
  "thermal",
  "cpu-contention",
  "memory-pressure",
  "gpu-pressure",
  "network-health",
  "presentation-pacing",
  "competitive-tier-fit",
  "failure-recurrence",
  "mode-fit",
  "sensor-readiness",
  "verified-prevention"
]);
const RELIEF_NETWORK_VISIBLE_THRESHOLD = 55;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function addHypothesis(list, item) {
  const actionId = String(item.actionId || "observe.verify");
  const registry = ML_SAFE_ACTION_REGISTRY[actionId] || null;
  list.push({
    id: String(item.id || actionId),
    label: String(item.label || "Watch current system state"),
    domain: item.domain || "observe",
    confidence: clamp(item.confidence, 0, 100),
    urgency: item.urgency || "normal",
    actionId,
    expectedHandler: registry?.handler || null,
    executableByRegistry: Boolean(registry?.executable),
    reason: item.reason || "Optimizer hypothesis has no reason recorded.",
    evidence: Array.isArray(item.evidence) ? item.evidence.filter(Boolean).slice(0, 8) : [],
    reversible: item.reversible !== false,
    bounded: item.bounded !== false
  });
}

function registryExperimentFor(hypothesis, executionGate = {}) {
  const registry = ML_SAFE_ACTION_REGISTRY[hypothesis.actionId] || null;
  const gateMatches = executionGate.actionId === hypothesis.actionId;
  const gateEligible = gateMatches && executionGate.eligible === true;
  const blockedBy = [];
  if (!registry) {
    blockedBy.push("action is not registered");
  } else if (!registry.executable) {
    blockedBy.push("action is intentionally kept on a deterministic or advisory path");
  }
  if (registry?.executable && !gateEligible) {
    blockedBy.push(gateMatches ? (executionGate.blockedBy || ["execution gate not eligible"]).join("; ") : "execution gate is evaluating a different action");
  }
  if (!hypothesis.bounded || !hypothesis.reversible) {
    blockedBy.push("experiment is not bounded and reversible");
  }
  const executable = Boolean(registry?.executable && gateEligible && hypothesis.bounded && hypothesis.reversible);
  return {
    id: `experiment.${hypothesis.id}`,
    hypothesisId: hypothesis.id,
    label: hypothesis.label,
    actionId: hypothesis.actionId,
    handler: registry?.handler || null,
    type: "bounded-registry-experiment",
    executable,
    bounded: hypothesis.bounded,
    reversible: hypothesis.reversible,
    expectedSignal: expectedSignalFor(hypothesis),
    blockedBy,
    safety: registry?.safety || "No registered safety contract.",
    reason: executable
      ? `Experiment can delegate to ${registry.handler}; deterministic gates still apply.`
      : `Experiment remains advisory: ${blockedBy[0] || "waiting for stronger evidence"}.`
  };
}

function expectedSignalFor(hypothesis) {
  if (hypothesis.actionId === "power.adaptive-tier") {
    return "stable or improved health with lower thermal/CPU pressure inside the mode band";
  }
  if (hypothesis.actionId === "relief.cpu") {
    return "CPU load eases during the short reversible cap without process disruption";
  }
  if (hypothesis.actionId === "relief.ram") {
    return "reclaimable memory increases; ineffective trims back off automatically";
  }
  if (hypothesis.actionId === "diagnose.network") {
    return "network check produces actionable DNS/reachability/VPN/loss evidence or backs off when repeated checks add no value";
  }
  if (hypothesis.actionId === "relief.gpu") {
    return "GPU/VRAM pressure eases after a short in-mode power-band hold without changing GPU clocks or drivers";
  }
  if (hypothesis.actionId === "mode.switch") {
    return "foreground context remains stable through band-first, dwell, cooldown, and guardrail checks";
  }
  return "telemetry remains stable while the optimizer gathers more evidence";
}

function preventionHypotheses(decisionLedger = {}) {
  return Array.isArray(decisionLedger.preventionCandidates) ? decisionLedger.preventionCandidates : [];
}

function isCompetitiveContext({ state = {}, policy = {} } = {}) {
  return state.modeId === "competitive"
    || policy.mode?.id === "competitive"
    || policy.suggestedMode === "competitive"
    || policy.priority?.modeHint === "competitive"
    || /competitive/i.test(String(policy.priority?.label || ""));
}

function isAgenticContext({ state = {}, policy = {} } = {}) {
  return state.modeId === "agentic"
    || policy.mode?.id === "agentic"
    || policy.suggestedMode === "agentic"
    || policy.priority?.modeHint === "agentic"
    || /agentic/i.test(String(policy.priority?.label || ""));
}

function verifiedHighFrames(presentation = {}) {
  const avgFps = Number(presentation.avgFps);
  const frameCap = Number(presentation.frameCapFps);
  if (presentation.status !== "verified-good" || !Number.isFinite(avgFps) || avgFps <= 0) {
    return false;
  }
  if (Number.isFinite(frameCap) && frameCap > 0) {
    return avgFps >= frameCap * 0.95;
  }
  return avgFps >= 144;
}

function competitiveSafetyBlock(context = {}) {
  const { state = {}, policy = {} } = context;
  const thermalSeverity = policy.thermalState?.severity || policy.health?.thermalSeverity || "ok";
  const healthState = policy.health?.state || state.health?.state || "";
  const failureSafety = Boolean(policy.failureRemediation?.safetyTargetMode || policy.failureRemediation?.safety);
  const crashSafety = Boolean(policy.crashRecovery?.active || state.crashRecovery?.active || state.recentCrash);
  const displayReset = Boolean(policy.displayReset || state.displayReset);
  const worsePacing = Boolean(policy.performanceKnowledge?.verifiedWorsePacing || state.verifiedWorsePacing);
  if (thermalSeverity === "critical") return "critical thermal state";
  if (/strained/i.test(String(healthState))) return "Strained health";
  if (failureSafety) return "active failure safety target";
  if (crashSafety) return "active crash safety target";
  if (displayReset) return "display reset";
  if (worsePacing) return "verified worse pacing";
  return null;
}

function competitiveFrameTiebreaker(competitivePrior = {}, presentation = {}, context = {}) {
  const objective = competitivePrior.frameObjective || {};
  const safetyBlock = competitiveSafetyBlock(context);
  if (objective.status !== "soft-tiebreaker" || !verifiedHighFrames(presentation)) {
    return { bonus: 0, safetyBlock, evidence: [] };
  }
  if (safetyBlock) {
    return {
      bonus: 0,
      safetyBlock,
      evidence: [`Frame tie-breaker blocked by ${safetyBlock}`]
    };
  }
  return {
    bonus: clamp(objective.confidenceBonus ?? 3, 0, 5),
    safetyBlock: null,
    evidence: [
      objective.name ? `Objective ${objective.name}` : "Objective frames-first-safe",
      Number.isFinite(Number(presentation.avgFps)) ? `Avg FPS ${presentation.avgFps}` : null,
      Number.isFinite(Number(presentation.frameCapFps)) ? `Cap ${presentation.frameCapFps} FPS` : null
    ]
  };
}

function addPerformanceKnowledgeHypotheses(hypotheses, performanceKnowledge = null, context = {}) {
  const active = performanceKnowledge?.active || {};
  const presentation = active.presentationPath || {};
  const hierarchy = active.powerPlanHierarchy || {};
  const competitivePrior = active.competitiveGamingPrior || {};
  const agenticPrior = active.agenticWorkPrior || {};
  const diagnosis = active.diagnosis || {};

  if (presentation.status === "verified-good") {
    addHypothesis(hypotheses, {
      id: "performance-knowledge.presentation-path",
      label: "Preserve verified fullscreen pacing path",
      domain: "presentation-pacing",
      confidence: 88,
      urgency: "normal",
      actionId: "observe.verify",
      reason: "Recent validation found the best pacing from Fullscreen180 with HAGS enabled and stable Independent Flip; this is advisory unless a future safe-action registry entry is approved.",
      evidence: [
        presentation.profile ? `Profile ${presentation.profile}` : null,
        Number.isFinite(Number(presentation.frameCapFps)) ? `${presentation.frameCapFps} FPS cap` : null,
        Number.isFinite(Number(presentation.independentFlipPct)) ? `${presentation.independentFlipPct}% Independent Flip` : null,
        Number.isFinite(Number(presentation.p99FrameMs)) ? `P99 frame ${presentation.p99FrameMs} ms` : null,
        Number.isFinite(Number(presentation.p99GpuLatencyMs)) ? `P99 GPU latency ${presentation.p99GpuLatencyMs} ms` : null
      ]
    });
  }

  if (hierarchy.status === "verified-good") {
    addHypothesis(hypotheses, {
      id: "performance-knowledge.cpu-gpu-hierarchy",
      label: "Keep CPU/GPU power hierarchy aligned",
      domain: "power-fit",
      confidence: 84,
      urgency: "normal",
      actionId: "power.adaptive-tier",
      reason: hierarchy.principle || "Recent validation favored no-boost 03/04 for stability and low-boost 05 for safer Competitive headroom.",
      evidence: [
        hierarchy.activeBestTier ? `Best tier ${hierarchy.activeBestTier}` : null,
        hierarchy.noBoostBaselineTier ? `No-boost baseline ${hierarchy.noBoostBaselineTier}` : null,
        hierarchy.noBoostStrongTier ? `No-boost strong tier ${hierarchy.noBoostStrongTier}` : null,
        hierarchy.lowBoostUltraTier ? `Low-boost Ultra tier ${hierarchy.lowBoostUltraTier}` : null,
        hierarchy.commonAc?.boostMode ? `Boost ${hierarchy.commonAc.boostMode}` : null,
        diagnosis.weakPoint ? `Weak point ${diagnosis.weakPoint}` : null
      ]
    });
  }

  if (competitivePrior.status === "soft-prior" && isCompetitiveContext(context)) {
    const frameTiebreaker = competitiveFrameTiebreaker(competitivePrior, presentation, context);
    const reason = competitivePrior.principle || "Competitive Gaming should prefer 05 first and 04 second when clean, then verify by pacing and thermals.";
    addHypothesis(hypotheses, {
      id: "performance-knowledge.competitive-05-04-prior",
      label: "Test 05 first, 04 second for Competitive",
      domain: "competitive-tier-fit",
      confidence: 87 + frameTiebreaker.bonus,
      urgency: "normal",
      actionId: "power.adaptive-tier",
      reason: frameTiebreaker.bonus
        ? `${reason} Verified high frames get a small tie-breaker over soft caution while safety remains absolute.`
        : reason,
      evidence: [
        competitivePrior.primaryPlan ? `Primary ${competitivePrior.primaryPlan}` : null,
        competitivePrior.fallbackPlan ? `Fallback ${competitivePrior.fallbackPlan}` : null,
        presentation.profile ? `Profile ${presentation.profile}` : null,
        ...frameTiebreaker.evidence,
        diagnosis.weakPoint ? `Weak point ${diagnosis.weakPoint}` : null
      ]
    });
  }

  if (agenticPrior.status === "soft-prior" && isAgenticContext(context)) {
    addHypothesis(hypotheses, {
      id: "performance-knowledge.agentic-04-prior",
      label: "Prefer 04 for most Agentic work",
      domain: "agentic-tier-fit",
      confidence: 84,
      urgency: "normal",
      actionId: "power.adaptive-tier",
      reason: agenticPrior.principle || "Agentic Work should prefer 04 for most sustained agent/model/container work, then verify by load, thermals, memory pressure, and stability.",
      evidence: [
        agenticPrior.preferredPlan ? `Preferred ${agenticPrior.preferredPlan}` : null,
        agenticPrior.fallbackPlan ? `Fallback ${agenticPrior.fallbackPlan}` : null,
        agenticPrior.floorPlan ? `Floor ${agenticPrior.floorPlan}` : null,
        diagnosis.weakPoint ? `Weak point ${diagnosis.weakPoint}` : null
      ]
    });
  }
}

export function buildNorthStarOptimizer({
  state = {},
  telemetry = {},
  policy = {},
  governor = {},
  decisionLedger = {},
  executionGate = {},
  efficacy = {},
  relief = {},
  adaptivePower = null,
  readiness = {},
  performanceKnowledge = null
} = {}) {
  const hypotheses = [];
  const system = telemetry.system || {};
  const thermal = policy.thermalState || {};
  const cpuPct = clamp(system.cpuLoadPct);
  const ramPct = clamp(system.ramUsedPct ?? system.ramUsedRealPct);
  const selected = governor.selected || {};
  const selectedActionId = selected.id || "observe.verify";

  addHypothesis(hypotheses, {
    id: "power-fit.current-band",
    label: adaptivePower?.plan ? `Optimize power tier toward ${adaptivePower.plan}` : "Optimize current power tier",
    domain: "power-fit",
    confidence: adaptivePower?.plan ? 82 : 45,
    urgency: adaptivePower?.guard ? "high" : "normal",
    actionId: "power.adaptive-tier",
    reason: adaptivePower?.reason || adaptivePower?.guard || "Adaptive power is the primary reversible performance/health lever.",
    evidence: [
      adaptivePower?.plan ? `Target ${adaptivePower.plan}` : null,
      Number.isFinite(Number(adaptivePower?.tier)) ? `Tier ${adaptivePower.tier}` : null,
      policy.health?.state ? `Health ${policy.health.state}` : null
    ]
  });

  if (["warm", "hot", "critical"].includes(String(thermal.severity || ""))) {
    addHypothesis(hypotheses, {
      id: `thermal.${thermal.worstComponent || "component"}`,
      label: `Reduce ${thermal.worstComponent || "thermal"} pressure`,
      domain: "thermal",
      confidence: thermal.severity === "critical" ? 100 : thermal.severity === "hot" ? 92 : 74,
      urgency: thermal.severity === "critical" ? "safety" : "high",
      actionId: "power.adaptive-tier",
      reason: thermal.summary || "Thermal hierarchy indicates elevated temperature.",
      evidence: [
        thermal.severity ? `Severity ${thermal.severity}` : null,
        thermal.worstComponent ? `Worst ${thermal.worstComponent}` : null,
        Number.isFinite(Number(thermal.worstTempC)) ? `${Math.round(Number(thermal.worstTempC))} C` : null
      ]
    });
  }

  if (cpuPct >= 75 || relief.cpu?.sustainedPressure) {
    addHypothesis(hypotheses, {
      id: "cpu.contention",
      label: "Ease sustained CPU contention",
      domain: "cpu-contention",
      confidence: cpuPct >= 90 ? 90 : 72,
      urgency: cpuPct >= 90 ? "high" : "normal",
      actionId: relief.cpu?.autonomousAllowed ? "relief.cpu" : "power.adaptive-tier",
      reason: relief.cpu?.summary || "CPU load is elevated enough to evaluate a bounded relief experiment.",
      evidence: [
        `CPU ${Math.round(cpuPct)}%`,
        relief.cpu?.pressureStreak != null ? `CPU streak ${relief.cpu.pressureStreak}/${relief.cpu.sustainedSamples}` : null
      ]
    });
  }

  if (ramPct >= 80 || relief.ram?.autonomousAllowed) {
    addHypothesis(hypotheses, {
      id: "memory.pressure",
      label: "Evaluate reclaimable RAM pressure",
      domain: "memory-pressure",
      confidence: ramPct >= 90 ? 88 : 66,
      urgency: ramPct >= 90 ? "high" : "normal",
      actionId: "relief.ram",
      reason: relief.ram?.summary || "RAM pressure is elevated enough to test bounded relief.",
      evidence: [`RAM ${Math.round(ramPct)}%`]
    });
  }

  const gpuRelief = relief.gpu || {};
  if (Number(gpuRelief.pressurePct) >= 70 || gpuRelief.autonomousAllowed) {
    addHypothesis(hypotheses, {
      id: "gpu.pressure",
      label: "Ease GPU or VRAM pressure",
      domain: "gpu-pressure",
      confidence: gpuRelief.autonomousAllowed ? 86 : 64,
      urgency: Number(gpuRelief.pressurePct) >= 90 ? "high" : "normal",
      actionId: "relief.gpu",
      reason: gpuRelief.summary || gpuRelief.signals?.reason || "GPU/VRAM pressure is elevated enough to evaluate bounded relief.",
      evidence: [
        `GPU pressure ${Math.round(finite(gpuRelief.pressurePct))}`,
        gpuRelief.signals?.reason || null
      ]
    });
  }

  const networkRelief = relief.network || {};
  if (Number(networkRelief.pressurePct) >= RELIEF_NETWORK_VISIBLE_THRESHOLD || networkRelief.autonomousAllowed) {
    addHypothesis(hypotheses, {
      id: "network.diagnosis",
      label: "Diagnose network health",
      domain: "network-health",
      confidence: networkRelief.autonomousAllowed ? 78 : 55,
      urgency: networkRelief.networkState === "critical" ? "high" : "normal",
      actionId: "diagnose.network",
      reason: networkRelief.summary || "Network health is degraded enough to run an observe-only diagnosis.",
      evidence: [
        networkRelief.networkState ? `Network ${networkRelief.networkState}` : null,
        networkRelief.issues?.[0] || null
      ]
    });
  }

  if (policy.suggestedMode && policy.suggestedMode !== state.modeId) {
    addHypothesis(hypotheses, {
      id: "mode.fit",
      label: `Evaluate mode fit for ${policy.suggestedMode}`,
      domain: "mode-fit",
      confidence: 62,
      urgency: "normal",
      actionId: "mode.switch",
      reason: policy.priority?.reason || "Policy suggested a different operating mode.",
      evidence: [
        `Current ${state.modeId || "unknown"}`,
        `Suggested ${policy.suggestedMode}`,
        policy.priority?.label ? `Priority ${policy.priority.label}` : null
      ]
    });
  }

  const remediationRoutes = policy.failureRemediation?.routes || [];
  const preventionRoutes = policy.failurePrevention?.preventions || [];
  if (remediationRoutes.length || preventionRoutes.length) {
    addHypothesis(hypotheses, {
      id: "failure.recurrence",
      label: "Treat recurring failure signatures more effectively",
      domain: "failure-recurrence",
      confidence: remediationRoutes.length ? 82 : 64,
      urgency: remediationRoutes.some((route) => route.severity === "critical") ? "safety" : "normal",
      actionId: selectedActionId,
      reason: "Failure remediation/prevention is active, so the optimizer should keep measuring which safe response works.",
      evidence: [
        `${remediationRoutes.length} remediation route(s)`,
        `${preventionRoutes.length} prevention rule(s)`
      ]
    });
  }

  const readinessIssues = Array.isArray(readiness.items)
    ? readiness.items.filter((item) => item.state === "warn" || item.state === "fail")
    : [];
  if (readinessIssues.length) {
    addHypothesis(hypotheses, {
      id: "readiness.sensor-gap",
      label: "Improve optimizer input quality",
      domain: "sensor-readiness",
      confidence: 58,
      urgency: readinessIssues.some((item) => item.state === "fail") ? "high" : "normal",
      actionId: "observe.verify",
      reason: "Missing or degraded readiness signals reduce optimizer confidence.",
      evidence: readinessIssues.slice(0, 4).map((item) => `${item.label}: ${item.summary}`)
    });
  }

  for (const candidate of preventionHypotheses(decisionLedger).slice(0, 4)) {
    addHypothesis(hypotheses, {
      id: `verified-prevention.${candidate.actionId}`,
      label: candidate.label || "Use verified prevention candidate",
      domain: "verified-prevention",
      confidence: candidate.confidence === "medium" ? 76 : 61,
      urgency: candidate.treatment === "delay-or-require-stronger-evidence" ? "normal" : "low",
      actionId: candidate.actionId,
      reason: candidate.reason,
      evidence: [`Treatment ${candidate.treatment}`, `${candidate.evidenceCount || 0} evidence sample(s)`]
    });
  }

  addPerformanceKnowledgeHypotheses(hypotheses, performanceKnowledge, { state, policy, adaptivePower });

  const experiments = hypotheses.map((hypothesis) => registryExperimentFor(hypothesis, executionGate));
  const selectedExperiment =
    experiments.find((experiment) => experiment.executable) ||
    experiments.find((experiment) => experiment.actionId === selectedActionId) ||
    experiments[0] ||
    null;
  const registryBacked = experiments.filter((experiment) => ML_SAFE_ACTION_REGISTRY[experiment.actionId]).length;
  const executableCount = experiments.filter((experiment) => experiment.executable).length;

  return {
    schema: OPTIMIZER_SCHEMA,
    level: 5,
    ideology: "unconstrained-reasoning-constrained-execution",
    status: executableCount ? "experiment-ready" : "hypothesis-search",
    searchDomains: [...SEARCH_DOMAINS],
    principles: [...NORTH_STAR_LEVEL5_IDEOLOGY],
    hypotheses: hypotheses
      .sort((a, b) => b.confidence - a.confidence || a.domain.localeCompare(b.domain))
      .slice(0, 10),
    experiments: experiments
      .sort((a, b) => Number(b.executable) - Number(a.executable) || a.hypothesisId.localeCompare(b.hypothesisId))
      .slice(0, 10),
    selectedExperiment,
    coverage: {
      hypothesisCount: hypotheses.length,
      experimentCount: experiments.length,
      executableCount,
      registryBacked,
      advisoryCount: Math.max(0, experiments.length - executableCount),
      preventionCandidates: preventionHypotheses(decisionLedger).length,
      efficacyActions: Array.isArray(efficacy.actions) ? efficacy.actions.length : 0
    },
    summary: `North-star Level 5 formed ${hypotheses.length} hypothesis(es), designed ${experiments.length} bounded experiment(s), and found ${executableCount} registry-executable path(s).`
  };
}
