
import { MODE_BANDS, POWER_LADDER } from "./power-adaptive.js";
import { THERMAL_THRESHOLDS, GAMING_CPU_THERMAL } from "./thermal-hierarchy.js";

export { MODE_BANDS, POWER_LADDER, THERMAL_THRESHOLDS, GAMING_CPU_THERMAL };

export const TIER_NAMES = Object.freeze(["POWER_SAVER", "ENDURANCE", "BALANCED", "HIGH", "ULTRA"]);

export const MASTER_PRECEDENCE = Object.freeze([
  { rank: 0, id: "crash-failure", label: "Crash / failure remediation", note: "Bugcheck signatures and failure-watchlist downshifts. Bypass every discretionary gate." },
  { rank: 1, id: "thermal-critical", label: "Critical thermal", note: "Critical severity floors power now and may switch modes for deeper cooling." },
  { rank: 2, id: "thermal-hot-strained", label: "Hot thermal / Strained health", note: "Settles at the mode home base; blocks upward escalation." },
  { rank: 3, id: "gaming-supremacy", label: "Gaming supremacy hold", note: "Active competitive session: no discretionary mode switch; ordinary heat handled in-band; owner-raised 94.5 C software critical line with the CPU's 90 C hardware Tjmax unchanged." },
  { rank: 4, id: "band-first", label: "Band-first ordering", note: "Use the in-mode power band before switching modes (cooling defers down; recovery env-gated)." },
  { rank: 5, id: "manual-hold", label: "Manual-transition hold", note: "A recent manual mode choice pauses discretionary auto-switches until it expires." },
  { rank: 6, id: "stability-dwell", label: "Mode-switch stability dwell", note: "A candidate must persist for the dwell + confirmations before it is applied." },
  { rank: 7, id: "cooldown", label: "Auto-apply cooldown", note: "Rate-limit between autonomous mode applies." },
  { rank: 8, id: "workload", label: "Workload classification", note: "classifyPriority -> suggestedMode picks the target once all the above clear." },
  { rank: 9, id: "comfort-idle", label: "Comfort / idle / guardrail cap", note: "Extended-idle sleep, idle-return restore, and the learned-guardrail power cap (caps power, not entry)." }
]);


export const SAFETY_TARGET_PRECEDENCE = Object.freeze([
  { step: 1, id: "crashRecovery.nextMode", where: "system.js:~3861", effect: "Return crash-recovery mode; overrides everything incl. Overdrive." },
  { step: 2, id: "thermal.critical", where: "system.js:~3865", effect: "Critical thermal -> conservative." },
  { step: 3, id: "failureRemediation.safetyTargetMode", where: "system.js:~3869", effect: "Known failure shape -> its safety target." },
  { step: 4, id: "failureWatchlist.autoDownshift", where: "system.js:~3877", effect: "High modes -> balanced while a watchlist entry is hot." },
  { step: 5, id: "thermal.conservative-cooldown", where: "system.js:~3885", effect: "Foreground high mode -> balanced; else -> conservative." },
  { step: 6, id: "health.Strained", where: "system.js:~3893", effect: "Strained -> balanced from a high mode, else null." },
  { step: 7, id: "overdrive.user-only", where: "system.js:~3905", effect: "Never auto-switch away from Overdrive for workload reasons." },
  { step: 8, id: "workload.suggestedMode", where: "system.js:~3911", effect: "The classified workload target (conservative..agentic), then mode STICKINESS (rule 7c, modeStaySuppressesSwitch): stay in the current mode (return null) when the target is only a drift down to a REST mode whose ceiling it already covers. Climbing to a higher ceiling, moving between distinct active workloads, and extended-idle sleep still switch; safety targets returned in steps 1-6 bypass this." }
]);

export const OBSERVER_GATE_CHAIN = Object.freeze([
  { step: 1, id: "safeAutoTarget", where: "system.js:~5308", effect: "Produce the candidate target (safety or workload)." },
  { step: 2, id: "idle-return", where: "system.js:~5311", effect: "Input resumed from idle-conservative -> restore prior mode (unless safety target)." },
  { step: 3, id: "gaming-supremacy", where: "system.js:~5346", effect: "Active game: null out discretionary switches; safety still passes." },
  { step: 4, id: "guardrail-capped", where: "system.js:~5380", effect: "Guardrailed candidate ACTIVATES (not nulled); power capped in resolver. Audit learning.guardrail-capped." },
  { step: 5, id: "band-first", where: "system.js:~5401", effect: "Defer a cooling/recovery switch while the in-mode band still has room." },
  { step: 6, id: "manual-transition-hold", where: "system.js:~5437", effect: "Pause discretionary switches during the manual hold window." },
  { step: 7, id: "stability-dwell", where: "system.js:~5456", effect: "Require dwell + confirmations before applying (safety bypasses)." },
  { step: 8, id: "cooldown", where: "system.js:~5504", effect: "Skip if within the auto-apply cooldown." },
  { step: 9, id: "applyMode", where: "system.js:~5528", effect: "All gates passed -> applyMode(target, source: observer)." }
]);

export const RESOLVER_GUARD_ORDER = Object.freeze([
  { step: 1, id: "load-bump", where: "power-adaptive.js:~248", effect: "Demand climbs the tier from loadFloor toward ceiling (moderate/high/very-high)." },
  { step: 2, id: "learning-bias", where: "power-adaptive.js:~273", effect: "+/-1 tier from per-mode history; hot/warm-prone cancels upward bias." },
  { step: 3, id: "competitive-profile", where: "power-adaptive.js:~230 (gaming-profile.js)", effect: "Active competitive session: a strong SUGGESTION (not a pin) — bias the climb up toward Ultra (05) during play, lean down toward Endurance (02) on a sustained lull (low GPU AND low CPU). Learner + demand still free to settle on any band tier, incl. the balanced 03." },
  { step: 4, id: "overdrive-downshift", where: "power-adaptive.js:~320", effect: "Overdrive under any thermal/crash/strain -> Balanced." },
  { step: 5, id: "critical-thermal", where: "power-adaptive.js:~288", effect: "Critical thermal is a learner-modulated STRONG SUGGESTION, not a hard floor: a heavy downward bias that a clean profile blends to ~03, a default profile to the band floor (02), a heat-prone one hardest. Only the hardware throttle (and the observer's separate mode safety target) is a firm backstop." },
  { step: 6, id: "hot-crash-strained", where: "power-adaptive.js:~297", effect: "Crucial-but-not-critical HOT is a graduated, LEARNER-MODULATED downward SUGGESTION, not a fixed step: a clean profile eases ~1 tier, default ~2, heat-prone ~3, so the same 'hot' lands on 04/03/02 by context. Crash/Strained -> restFloor. No thermal line is a hard pin; only the hardware throttle is." },
  { step: 7, id: "hold-below-ceiling", where: "power-adaptive.js:~349", effect: "Warm or near GPU power limit -> one tier below ceiling." },
  { step: 8, id: "predictive-warm", where: "power-adaptive.js:~352", effect: "Rising-temp trend eases one tier early (suppressed during gaming)." },
  { step: 9, id: "gpu-relief", where: "power-adaptive.js:~358", effect: "Bounded GPU relief request eases one tier inside the band." },
  { step: 10, id: "extended-idle", where: "power-adaptive.js:~362", effect: "Genuine extended idle + low load -> sleep to bandFloor (pulls DOWN only)." },
  { step: 11, id: "guardrail-cap", where: "power-adaptive.js:~369", effect: "Learned guardrail caps the tier to restFloor (home base)." },
  { step: 12, id: "final-clamp", where: "power-adaptive.js:~379", effect: "Clamp to [0, ladder length-1]." }
]);

export const THERMAL_SEVERITY_PRECEDENCE = Object.freeze([
  { rank: 0, severity: "critical", action: "conservative-cooldown", effect: "Floor immediately; may switch modes." },
  { rank: 1, severity: "hot", action: "floor", effect: "Settle at the mode home base." },
  { rank: 2, severity: "warm", action: "hold-below-ceiling", effect: "Cap one tier below ceiling." },
  { rank: 3, severity: "ok", action: "none", effect: "Load is free to climb." }
]);
export const THERMAL_TIE_BREAK = Object.freeze(["cpu", "gpu", "vram", "storage"]);

export const WORKLOAD_PRIORITY = Object.freeze([
  { step: 1, id: "extended-idle", effect: "Away/idle power posture." },
  { step: 2, id: "heavy-foreground", effect: "IDENTIFIED game (game-identity.js: install provenance, Windows Game Bar, anti-cheat, measured 3D work) vs heavy compute (Performance). A confirmed game carries the COMPETITIVE PRIOR — the learner tunes WHEN Competitive engages, never whether a game warrants it; demotion needs a materially higher bar than agreement." },
  { step: 3, id: "thermal-memory-cooling", effect: "Hot part or memory pressure -> cooling posture." },
  { step: 4, id: "agentic", effect: "Dev/AI tools ACTIVELY using CPU: >=2 in foreground use OR >=3 in background -> Agentic Work." },
  { step: 5, id: "foreground-context", effect: "Focused foreground app context." },
  { step: 6, id: "baseline", effect: "Idle desktop -> Balanced baseline." }
]);

export const ML_EXECUTION_GATE_CHAIN = Object.freeze([
  { step: 1, id: "evidence-threshold", where: "ml-action-registry.js (buildMlExecutionGate)", effect: "Require a verified helped/stable ledger outcome or a prevention candidate." },
  { step: 2, id: "safe-action-registry", where: "ml-action-registry.js (ML_SAFE_ACTION_REGISTRY)", effect: "Action must be whitelisted AND executable:true." },
  { step: 3, id: "relief-gate-open", where: "relief.js (autonomousAllowed)", effect: "For relief actions, the relief module's own gate must already be open." },
  { step: 4, id: "autonomy-auto-safe", where: "system.js", effect: "state.autonomy must be auto-safe." },
  { step: 5, id: "plan-execution", where: "ml-executor.js (planMlExecution)", effect: "Kill switch (mlExecution) + executor cooldown + suppress-only prevention hold." },
  { step: 6, id: "dispatch", where: "system.js (maybeExecuteMlGovernorSafeHandler)", effect: "Delegate to the existing safe handler; audit ml.execute." },
  { step: 7, id: "deterministic-floor", where: "system.js (if !delegated)", effect: "If anything blocks, the deterministic safety handler runs unconditionally." }
]);

export const AUTONOMY_LEVELS = Object.freeze([
  { level: 2, id: "baseline-learner", status: "implemented", note: "Rolling session scores, guardrails, efficacy, app reputation. Advisory inputs only." },
  { level: 3, id: "governor-ranking", status: "implemented", note: "Governor ranks safe actions from evidence; still shadow/observe." },
  { level: 4, id: "verified-shadow-loop", status: "implemented", note: "Decision ledger records, verifies after ~45s, promotes prevention candidates." },
  { level: 5, id: "constrained-execution", status: "implemented", note: "Unconstrained reasoning, constrained execution: evidence-gated live dispatch via the action registry, kill switch, deterministic floor." },
  { level: 6, id: "prohibited", status: "out-of-scope", note: "Process control, driver/BIOS/voltage/firmware automation, self-promoting policies without a deterministic gate." }
]);

export const MODULE_LAYERS = Object.freeze({
  L0_entry_config: ["index.js", "config.js", "engine-lifecycle.js", "http-boundary.js"],
  L1_telemetry_capture: ["live.js", "presentmon.js", "updates.js", "hardware-profile.js"],
  L2_classification_policy: [
    "thermal-hierarchy.js", "thermal-trend.js", "failures.js", "failure-prevention.js",
    "failure-proactive-prevention.js", "failure-remediation.js", "policy.js", "invariants.js",
    "game-identity.js"
  ],
  L3_power_resolution: ["adapters.js", "power-adaptive.js", "gaming-profile.js", "planner.js"],
  L4_learning_efficacy: ["learning.js", "efficacy.js", "relief.js", "attribution.js", "self-health.js", "self-treatment.js", "incident-learning.js", "external-performance-knowledge.js"],
  L5_autonomy_ml: ["ml-governor.js", "ml-decision-ledger.js", "ml-executor.js", "ml-optimizer.js", "ml-action-registry.js"],
  L6_persistence_audit_sessions: [
    "ledger.js", "lock.js", "snapshots.js", "audit-archive.js", "audit-export.js",
    "explain.js",
    "game-library.js",
    "competitive-tuning.js",
    "sessions.js", "context-sessions.js", "diagnostic-traps.js", "convergence.js", "offenders.js"
  ],
  L7_orchestrator: ["system.js", "desktop-comfort.js"],
  L8_frontend: ["public/app.js", "public/index.html", "public/styles.css"]
});

export const KNOWN_DEPENDENCY_CYCLES = Object.freeze([
  { a: "convergence.js", b: "system.js", reason: "convergence imports appendAudit/setPowerPlanByName; system imports convergeInvariants." },
  { a: "offenders.js", b: "system.js", reason: "offenders imports appendAudit/runPowerShell/readJson/writeJson; system imports handleOffenders." }
]);


export function layerOf(moduleName) {
  for (const [layer, members] of Object.entries(MODULE_LAYERS)) {
    if (members.includes(moduleName)) return layer;
  }
  return null;
}

export function precedenceRank(id) {
  const hit = MASTER_PRECEDENCE.find((p) => p.id === id);
  return hit ? hit.rank : null;
}

export function outranks(idA, idB) {
  const a = precedenceRank(idA);
  const b = precedenceRank(idB);
  if (a == null || b == null) return null;
  return a < b;
}

export function tierName(index) {
  if (!Number.isInteger(index) || index < 0 || index >= POWER_LADDER.length) return null;
  return TIER_NAMES[index] ?? null;
}

export function bandOf(modeId) {
  return MODE_BANDS[modeId] || null;
}

export function allLayeredModules() {
  return Object.values(MODULE_LAYERS).flat();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function moduleCounts() {
  const modules = allLayeredModules();
  const frontend = modules.filter((name) => name.startsWith("public/")).length;
  return {
    total: modules.length,
    server: modules.length - frontend,
    frontend
  };
}

function registryHealth() {
  const ranks = MASTER_PRECEDENCE.map((item) => item.rank);
  const chains = [SAFETY_TARGET_PRECEDENCE, OBSERVER_GATE_CHAIN, RESOLVER_GUARD_ORDER, ML_EXECUTION_GATE_CHAIN];
  const orderedChains = chains.every((chain) => chain.every((item, index) => item.step === index + 1));
  const contiguousRanks = ranks.every((rank, index) => rank === index);
  const tierNamesAligned = TIER_NAMES.length === POWER_LADDER.length;
  const layerMembers = allLayeredModules();
  const uniqueLayerMembers = new Set(layerMembers).size === layerMembers.length;
  const ok = contiguousRanks && orderedChains && tierNamesAligned && uniqueLayerMembers;
  return {
    ok,
    summary: ok ? "Registry checks aligned" : "Registry needs attention",
    checks: {
      contiguousRanks,
      orderedChains,
      tierNamesAligned,
      uniqueLayerMembers
    }
  };
}

function signal(id, label, detail, active = true) {
  return active ? { id, label, detail: detail || "" } : null;
}

function activePrecedenceSignals({ state = {}, policy = {}, adaptivePower = {}, observer = {} } = {}) {
  const signals = [
    signal("crash-failure", "Crash or failure response", policy.crashRecovery?.nextMode || policy.failureRemediation?.safetyTargetMode, Boolean(policy.crashRecovery?.nextMode || policy.failureRemediation?.safetyTargetMode)),
    signal("thermal-critical", "Critical thermal protection", policy.thermalState?.summary || "Critical thermal state", policy.thermalState?.severity === "critical"),
    signal("thermal-hot-strained", "Thermal or strained health", policy.thermalState?.summary || policy.health?.state, ["hot"].includes(policy.thermalState?.severity) || policy.health?.state === "Strained"),
    signal("gaming-supremacy", "Gaming session protected", policy.priority?.reason || "Active competitive session", Boolean(policy.priority?.isCompetitive || policy.priority?.modeHint === "competitive")),
    signal("band-first", "Power band first", adaptivePower?.plan || adaptivePower?.guard || "Using in-mode power levels", Boolean(adaptivePower?.plan || policy.bandFirstRecovery?.active)),
    signal("manual-hold", "Manual choice hold", observer.manualTransitionReason || state.manualTransitionReason || "Recent manual mode choice", Boolean(observer.manualTransitionHoldUntil || state.manualTransitionHoldUntil)),
    signal("stability-dwell", "Mode switch stability", observer.modeSwitchStability?.target || observer.pendingAutoTarget || "Waiting for repeated confirmation", Boolean(observer.modeSwitchStability?.target || observer.pendingAutoTarget)),
    signal("cooldown", "Mode switch cooldown", "Rate limit active", Boolean(observer.autoApplyCooldown?.active || observer.cooldownActive)),
    signal("workload", "Workload classification", policy.priority?.label || policy.suggestedMode || "Watching current activity", Boolean(policy.priority?.label || policy.suggestedMode)),
    signal("comfort-idle", "Comfort or idle guard", policy.priority?.label || "Idle and guardrail checks", Boolean(policy.priority?.posture === "inactivity" || policy.priority?.posture === "idle" || policy.learningGuardrail?.active))
  ].filter(Boolean);
  return signals.slice(0, 5);
}

function compactRuntimeSummary(options = {}) {
  const {
    state = {},
    policy = {},
    adaptivePower = {},
    observer = {},
    mlGovernor = {},
    mlExecutionGate = {},
    mlExecutor = {},
    mlOptimizer = {}
  } = options;
  const modeId = state.modeId || adaptivePower.modeId || policy.mode?.id || "balanced";
  const counts = moduleCounts();
  return {
    registry: {
      ...registryHealth(),
      layers: Object.keys(MODULE_LAYERS).length,
      modules: counts.total,
      serverModules: counts.server,
      frontendModules: counts.frontend,
      cycles: KNOWN_DEPENDENCY_CYCLES.length
    },
    currentMode: {
      id: modeId,
      label: policy.mode?.label || modeId,
      band: bandOf(modeId)
    },
    adaptivePower: adaptivePower ? {
      plan: adaptivePower.plan || null,
      tier: Number.isInteger(adaptivePower.tier) ? adaptivePower.tier : null,
      floor: Number.isInteger(adaptivePower.floor) ? adaptivePower.floor : null,
      ceiling: Number.isInteger(adaptivePower.ceiling) ? adaptivePower.ceiling : null,
      guard: adaptivePower.guard || null,
      reason: adaptivePower.reason || null
    } : null,
    activeSignals: activePrecedenceSignals({ state, policy, adaptivePower, observer }),
    autonomy: {
      level: mlOptimizer.level || mlGovernor.level || mlExecutor.level || null,
      status: mlOptimizer.status || mlGovernor.status || mlExecutor.status || null,
      gateStatus: mlExecutionGate.status || null,
      eligible: Boolean(mlExecutionGate.eligible || mlExecutor.eligible)
    },
    controlLoop: ["Detect", "Remediate", "Verify", "Learn", "Prevent"]
  };
}

export const ARCHITECTURE_SCHEMA = "pc-control-plane-architecture/v1";

export function buildArchitectureSnapshot(options = {}) {
  const counts = moduleCounts();
  return {
    schema: ARCHITECTURE_SCHEMA,
    docs: [
      "docs/ARCHITECTURE.md",
      "docs/PRECEDENCE.md",
      "docs/MODULE_MANIFEST.md",
      "docs/README.md"
    ],
    registry: {
      ...registryHealth(),
      layers: Object.keys(MODULE_LAYERS).length,
      modules: counts.total,
      serverModules: counts.server,
      frontendModules: counts.frontend,
      cycles: KNOWN_DEPENDENCY_CYCLES.length
    },
    layers: clone(MODULE_LAYERS),
    moduleCounts: counts,
    knownDependencyCycles: clone(KNOWN_DEPENDENCY_CYCLES),
    masterPrecedence: clone(MASTER_PRECEDENCE),
    decisionChains: {
      safetyTarget: clone(SAFETY_TARGET_PRECEDENCE),
      observerGates: clone(OBSERVER_GATE_CHAIN),
      resolverGuards: clone(RESOLVER_GUARD_ORDER),
      thermalSeverity: clone(THERMAL_SEVERITY_PRECEDENCE),
      workloadPriority: clone(WORKLOAD_PRIORITY),
      mlExecution: clone(ML_EXECUTION_GATE_CHAIN)
    },
    liveConstants: {
      powerLadder: clone(POWER_LADDER),
      modeBands: clone(MODE_BANDS),
      thermalThresholds: clone(THERMAL_THRESHOLDS),
      gamingCpuThermal: clone(GAMING_CPU_THERMAL),
      thermalTieBreak: clone(THERMAL_TIE_BREAK)
    },
    autonomyLevels: clone(AUTONOMY_LEVELS),
    runtime: compactRuntimeSummary(options)
  };
}
