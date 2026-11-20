
import { classifyPriority, getMode } from "./policy.js";
import {
  computeAdaptiveTarget,
  demandFromTelemetry,
  learningSignalFromSummary,
  MODE_BANDS,
  POWER_LADDER
} from "./power-adaptive.js";

export const EXPLAIN_DEMAND = Object.freeze({ moderate: 55, high: 80, veryHigh: 90 });

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function planLabel(tier) {
  return POWER_LADDER[tier] || null;
}

export function explainMode({ policy = {}, state = {} } = {}) {
  const currentId = state.modeId || policy.mode?.id || "balanced";
  const current = getMode(currentId);
  const priority = policy.priority || {};
  const suggested = policy.suggestedMode || null;
  const pinned = Boolean(state.pinned);

  let source = "workload";
  if (pinned) source = "pinned";
  else if (policy.crashRecovery?.nextMode) source = "crash-recovery";
  else if (currentId === "overdrive") source = "user";

  const agreeing = !suggested || suggested === currentId;
  return {
    id: currentId,
    label: current.label,
    source,
    detectedContext: priority.label || "Unknown",
    why: priority.reason || "No dominant workload detected.",
    confidence: Number.isFinite(Number(priority.confidence)) ? Number(priority.confidence) : null,
    agreesWithEvidence: agreeing,
    suggested: agreeing ? null : suggested,
    suggestedLabel: agreeing ? null : getMode(suggested).label
  };
}

export function explainBand({ adaptivePower = null, state = {} } = {}) {
  if (!adaptivePower) {
    return { plan: null, tier: null, why: "The adaptive resolver has not produced a target yet.", guard: null, band: null };
  }
  const modeId = state.modeId || adaptivePower.modeId || "balanced";
  const band = MODE_BANDS[modeId] || MODE_BANDS.balanced;
  const atCeiling = adaptivePower.tier >= adaptivePower.ceiling;
  const atFloor = adaptivePower.tier <= adaptivePower.floor;
  return {
    plan: adaptivePower.plan,
    tier: adaptivePower.tier,
    band: {
      floorPlan: planLabel(band.floor),
      ceilingPlan: planLabel(band.ceiling),
      range: `${planLabel(band.floor)} → ${planLabel(band.ceiling)}`
    },
    position: atCeiling ? "at the top of its band" : atFloor ? "at the bottom of its band" : "mid-band",
    demand: pct(adaptivePower.demand),
    guard: adaptivePower.guard || null,
    learningEffect: adaptivePower.learning?.effect || "none",
    why: adaptivePower.reason || "Selected from current load, thermals and learning."
  };
}

export function explainHolds({ adaptivePower = null, policy = {}, state = {}, overdriveLock = null } = {}) {
  const holds = [];
  const guard = adaptivePower?.guard || null;

  if (guard === "dwell hold" || guard === "hysteresis hold") {
    holds.push({
      id: "anti-flap",
      label: "Anti-flap hold",
      detail: adaptivePower.reason || "Waiting out the settling window before changing the power band.",
      severity: "info",
      clearsBy: "time"
    });
  } else if (guard) {
    holds.push({
      id: "safety-guard",
      label: "Safety guard",
      detail: guard,
      severity: "warn",
      clearsBy: "conditions improving"
    });
  }

  if (overdriveLock?.active) {
    holds.push({
      id: "overdrive-hold",
      label: "Overdrive held for you",
      detail: `You chose Overdrive, so the autonomous system will not switch away from it for another ${Math.floor(overdriveLock.remainingSeconds / 60)}m ${overdriveLock.remainingSeconds % 60}s. You can change mode yourself at any time; safety downshifts still override.`,
      severity: "info",
      clearsBy: "time"
    });
  }

  if (state.pinned) {
    holds.push({ id: "pinned", label: "Mode pinned", detail: "Autonomous mode switching is pinned off.", severity: "info", clearsBy: "user" });
  }
  if (state.autonomy !== "auto-safe") {
    holds.push({ id: "manual", label: "Manual-first autonomy", detail: "The governor recommends but does not switch modes on its own.", severity: "info", clearsBy: "user" });
  }
  if (adaptivePower?.learning?.guardrailActive) {
    holds.push({
      id: "learned-guardrail",
      label: "Learned guardrail",
      detail: "Recent sessions in this mode ended badly, so escalation is capped at its home base until clean sessions rebuild trust.",
      severity: "warn",
      clearsBy: "clean sessions"
    });
  }
  if (policy.crashRecovery?.active) {
    holds.push({
      id: "crash-recovery",
      label: "Crash recovery",
      detail: policy.crashRecovery.reason || "Recent crash signals are forcing a safer posture.",
      severity: "warn",
      clearsBy: "45 minutes without a crash signal"
    });
  }
  return holds;
}

export function explainTriggers({ adaptivePower = null, policy = {}, state = {} } = {}) {
  const triggers = [];
  if (!adaptivePower) return triggers;

  const modeId = state.modeId || adaptivePower.modeId || "balanced";
  const demand = Number(adaptivePower.demand) || 0;
  const tier = Number(adaptivePower.tier);
  const ceiling = Number(adaptivePower.ceiling);
  const floor = Number(adaptivePower.floor);

  if (tier < ceiling) {
    const next = demand < EXPLAIN_DEMAND.moderate
      ? EXPLAIN_DEMAND.moderate
      : demand < EXPLAIN_DEMAND.high
        ? EXPLAIN_DEMAND.high
        : EXPLAIN_DEMAND.veryHigh;
    triggers.push({
      direction: "up",
      what: `Sustained load reaching ~${next}%`,
      effect: `raises the power band toward ${planLabel(Math.min(ceiling, tier + 1))}`,
      current: `${pct(demand)}% now`
    });
  } else {
    triggers.push({
      direction: "up",
      what: "Already at this mode's ceiling",
      effect: `${planLabel(ceiling)} is the highest plan ${getMode(modeId).label} may use`,
      current: "at ceiling"
    });
  }

  const thermal = adaptivePower.thermalState || policy.thermalState || null;
  const worst = thermal?.components?.[thermal?.worstComponent] || null;
  if (worst?.threshold) {
    const t = worst.threshold;
    const now = pct(worst.tempC);
    triggers.push({
      direction: "down",
      what: `${t.label} reaching ${t.warm} °C (warm) / ${t.hot} °C (hot)`,
      effect: "eases the power band; a critical reading sheds to the band floor",
      current: now == null ? "unavailable" : `${now} °C now`
    });
  }
  if (tier > floor) {
    triggers.push({
      direction: "down",
      what: "Load falling away, or the user going idle",
      effect: `lets it rest toward ${planLabel(floor)}`,
      current: `${pct(demand)}% now`
    });
  }

  if (modeId !== "competitive") {
    triggers.push({
      direction: "mode",
      what: "A game taking the foreground",
      effect: "switches to Competitive Gaming — gaming overrides every other context",
      current: policy.priority?.label || "no game detected"
    });
  } else {
    triggers.push({
      direction: "mode",
      what: "The game going idle (low GPU AND low CPU), or you stepping away",
      effect: "stays in Competitive and rests inside the 02-05 band",
      current: policy.priority?.label || "playing"
    });
  }
  return triggers;
}

export function explainDecision({
  policy = {},
  adaptivePower = null,
  state = {},
  overdriveLock = null
} = {}) {
  const mode = explainMode({ policy, state });
  const band = explainBand({ adaptivePower, state });
  const holds = explainHolds({ adaptivePower, policy, state, overdriveLock });
  const triggers = explainTriggers({ adaptivePower, policy, state });

  const headline = band.plan
    ? `${mode.label} at ${band.plan}`
    : `${mode.label}`;

  const contextMatchesMode = String(mode.detectedContext || "").toLowerCase() === String(mode.label || "").toLowerCase();
  const opening = contextMatchesMode
    ? `Running ${mode.label}`
    : `${mode.detectedContext} detected, so it is running ${mode.label}`;
  const summaryParts = [opening];
  if (band.plan) summaryParts.push(`at ${band.plan} (${band.position})`);
  if (holds.length) summaryParts.push(`held by ${holds.map((h) => h.label.toLowerCase()).join(" and ")}`);
  const summary = `${summaryParts.join(", ")}.`;

  return {
    schema: "pc-control-plane-explain/v1",
    at: new Date().toISOString(),
    headline,
    summary,
    mode,
    band,
    holds,
    triggers,
    safety: {
      note: "Safety always overrides: crash recovery, critical thermal, Strained health and panic restore bypass every hold, including the Overdrive 20-minute lock.",
      thermal: adaptivePower?.thermalState?.summary || policy.thermalState?.summary || null,
      health: policy.health?.state || null
    }
  };
}

export const SIMULATION_SCENARIOS = Object.freeze({
  idle: {
    label: "Idle desktop",
    telemetry: { system: { cpuLoadPct: 4 }, gpu: { utilizationPct: 1, temperatureC: 40 } }
  },
  gameLaunch: {
    label: "A game launches (fullscreen, GPU-driven)",
    telemetry: {
      system: { cpuLoadPct: 55 },
      gpu: { utilizationPct: 96, temperatureC: 70 },
      foreground: { name: "SomeGame", title: "SomeGame", fullscreen: true, visibleWindows: 2 },
      priorityApp: { running: true, process: { name: "SomeGame", cpuPct: 45, workingSetMB: 4200 } },
      processes: [{ name: "SomeGame", cpuPct: 45, workingSetMB: 4200 }]
    }
  },
  gameIdle: {
    label: "Game sitting in a menu (foreground but idle)",
    telemetry: {
      system: { cpuLoadPct: 7 },
      gpu: { utilizationPct: 6, temperatureC: 52 },
      foreground: { name: "SomeGame", title: "SomeGame", fullscreen: true, visibleWindows: 2 },
      priorityApp: { running: true, process: { name: "SomeGame", cpuPct: 4, workingSetMB: 4200 } },
      processes: [{ name: "SomeGame", cpuPct: 4, workingSetMB: 4200 }]
    }
  },
  gameHot: {
    label: "Mid-game, CPU hits 92.4 °C",
    telemetry: {
      system: { cpuLoadPct: 85, cpuTempC: 92.4 },
      gpu: { utilizationPct: 97, temperatureC: 78 },
      foreground: { name: "SomeGame", title: "SomeGame", fullscreen: true, visibleWindows: 2 },
      priorityApp: { running: true, process: { name: "SomeGame", cpuPct: 50, workingSetMB: 4200 } },
      processes: [{ name: "SomeGame", cpuPct: 50, workingSetMB: 4200 }]
    }
  },
  agents: {
    label: "Agents working (Codex + Claude busy)",
    telemetry: {
      system: { cpuLoadPct: 62 },
      gpu: { utilizationPct: 8, temperatureC: 50 },
      foreground: { name: "Codex", title: "Codex", visibleWindows: 5 },
      processes: [
        { name: "Codex", cpuPct: 24, workingSetMB: 1400 },
        { name: "Claude", cpuPct: 12, workingSetMB: 1200 },
        { name: "node", cpuPct: 15, workingSetMB: 800 }
      ]
    }
  },
  video: {
    label: "Watching video full screen",
    telemetry: {
      system: { cpuLoadPct: 22 },
      gpu: { utilizationPct: 18, temperatureC: 48 },
      foreground: { name: "msedge", title: "Live Sports - YouTube", fullscreen: true, visibleWindows: 3 },
      processes: [{ name: "msedge", cpuPct: 14, workingSetMB: 3200 }]
    }
  },
  multitask: {
    label: "Multitasking across many windows",
    telemetry: {
      system: { cpuLoadPct: 38 },
      gpu: { utilizationPct: 10, temperatureC: 47 },
      foreground: { name: "winword", title: "report.docx - Word", visibleWindows: 7 },
      processes: [{ name: "winword", cpuPct: 6, workingSetMB: 700 }]
    }
  },
  away: {
    label: "You step away for an hour",
    telemetry: {
      system: { cpuLoadPct: 5 },
      gpu: { utilizationPct: 2, temperatureC: 41 },
      input: { available: true, idleMinutes: 75, isExtendedIdle: true }
    }
  }
});

export function simulateScenario(key, { learning = null, state = {} } = {}) {
  const scenario = SIMULATION_SCENARIOS[key];
  if (!scenario) {
    return { ok: false, message: `Unknown scenario: ${key}` };
  }
  const telemetry = {
    input: { available: true, idleMinutes: 0, isExtendedIdle: false },
    processes: [],
    ...scenario.telemetry
  };
  const priority = classifyPriority(telemetry, { modeId: state.modeId || "balanced" });
  const modeId = priority.modeHint;
  const signal = learningSignalFromSummary(learning, modeId);
  const target = computeAdaptiveTarget({
    modeId,
    demand: demandFromTelemetry(telemetry),
    cpuTempC: telemetry.system?.cpuTempC ?? null,
    gpuTempC: telemetry.gpu?.temperatureC ?? null,
    activeCompetitiveSession: modeId === "competitive" && Boolean(telemetry.priorityApp?.running),
    competitivePlay: modeId === "competitive",
    learningSignal: signal
  });
  return {
    ok: true,
    key,
    label: scenario.label,
    mode: { id: modeId, label: getMode(modeId).label, why: priority.reason, context: priority.label },
    band: { plan: target.plan, tier: target.tier, guard: target.guard, why: target.reason }
  };
}

export function simulateAll({ learning = null, state = {} } = {}) {
  return {
    schema: "pc-control-plane-simulation/v1",
    at: new Date().toISOString(),
    note: "Simulated with the same pure resolvers the live governor uses. Read-only: nothing on the machine is changed.",
    scenarios: Object.keys(SIMULATION_SCENARIOS).map((key) => simulateScenario(key, { learning, state }))
  };
}
