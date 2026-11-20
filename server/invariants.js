import { getMode } from "./policy.js";

export const modeInvariants = Object.freeze({
  conservative: {
    desiredPowerPlan: "01 - Power Saver (Emergency)",
    protectedApps: ["Security Core", "Windows Audio", "Input Devices"],
    allowedBackgroundLoad: { ramMb: 4096, cpuSeconds: 2400 },
    crashTolerance: "zero-new-critical",
    restoreExpectation: "Return to Conservative without constraining user work.",
    trustCeiling: "auto-safe",
    priorityApp: { fpsCap: null, configRequired: false }
  },
  balanced: {
    desiredPowerPlan: "03 - Balanced Mode (Daily Driver)",
    protectedApps: ["Security Core", "Windows Audio", "Input Devices", "Phone Link / CrossDevice"],
    allowedBackgroundLoad: { ramMb: 4096, cpuSeconds: 2400 },
    crashTolerance: "zero-new-critical",
    restoreExpectation: "Return to Balanced after special sessions.",
    trustCeiling: "auto-safe",
    priorityApp: { fpsCap: null, configRequired: false }
  },
  performance: {
    desiredPowerPlan: "04 - High Power Mode",
    protectedApps: ["Security Core", "Windows Audio", "Input Devices", "Phone Link / CrossDevice"],
    allowedBackgroundLoad: { ramMb: 2600, cpuSeconds: 1800 },
    crashTolerance: "no-repeat-critical",
    restoreExpectation: "Restore previous mode when performance session ends.",
    trustCeiling: "auto-safe",
    priorityApp: { fpsCap: null, configRequired: false }
  },
  competitive: {
    desiredPowerPlan: "04 - High Power Mode",
    protectedApps: [
      "HyperX / NGENUITY",
      "Phone Link / CrossDevice",
      "Windows Audio",
      "Input Devices"
    ],
    allowedBackgroundLoad: { ramMb: 1800, cpuSeconds: 1200 },
    crashTolerance: "no-repeat-critical",
    restoreExpectation: "Return to the previous mode after the competitive gaming session ends without constraining apps.",
    trustCeiling: "session",
    priorityApp: {
      fpsCap: null,
      configRequired: true,
      framePacing: "unrestricted"
    }
  },
  agentic: {
    desiredPowerPlan: "03 - Balanced Mode (Daily Driver)",
    protectedApps: ["Codex", "Claude", "Docker", "Node", "Python", "Security Core"],
    allowedBackgroundLoad: { ramMb: 6144, cpuSeconds: 3600 },
    crashTolerance: "zero-new-critical",
    restoreExpectation: "Protect active agents; refresh only repeat offenders.",
    trustCeiling: "auto-safe",
    priorityApp: { fpsCap: null, configRequired: false }
  },
  overdrive: {
    desiredPowerPlan: "05 - Ultra Performance",
    protectedApps: ["Security Core", "Windows Audio", "Input Devices"],
    allowedBackgroundLoad: { ramMb: 1800, cpuSeconds: 900 },
    crashTolerance: "no-critical",
    restoreExpectation: "Downgrade to Balanced when thermal/crash pressure appears.",
    trustCeiling: "session",
    priorityApp: { fpsCap: null, configRequired: false },
    refusalWhenStrained: true
  }
});

export function getModeInvariant(modeId) {
  const mode = getMode(modeId);
  return modeInvariants[mode.id] || modeInvariants.balanced;
}

export function currentPowerPlanName(telemetry) {
  const text = String(telemetry?.power?.activeLine || "");
  const first = text.indexOf("(");
  const last = text.lastIndexOf(")");
  if (first >= 0 && last > first) {
    return text.slice(first + 1, last);
  }
  return null;
}

export function desiredStateForMode(modeId) {
  const mode = getMode(modeId);
  const invariant = getModeInvariant(mode.id);
  return {
    modeId: mode.id,
    modeLabel: mode.label,
    powerPlan: invariant.desiredPowerPlan,
    protectedApps: invariant.protectedApps,
    allowedBackgroundLoad: invariant.allowedBackgroundLoad,
    crashTolerance: invariant.crashTolerance,
    restoreExpectation: invariant.restoreExpectation,
    trustCeiling: invariant.trustCeiling,
    priorityApp: invariant.priorityApp
  };
}

export function summarizeInvariantStatus(telemetry, state, policy, options = {}) {
  const mode = getMode(state?.modeId);
  const desired = desiredStateForMode(mode.id);
  const desiredPowerPlan = options.desiredPowerPlan || desired.powerPlan;
  const activePower = currentPowerPlanName(telemetry);
  const offenderCount = policy?.offenders?.length || 0;
  const crashSignals = policy?.eventAnalysis?.crashSignals?.length || 0;
  return [
    {
      id: "power-plan",
      label: "Power Plan",
      ok: !desiredPowerPlan || activePower === desiredPowerPlan,
      current: activePower || "Unknown",
      desired: desiredPowerPlan || "No strict plan"
    },
    {
      id: "background-load",
      label: "Background Load",
      ok: offenderCount === 0,
      current: `${offenderCount} offender(s)`,
      desired: `RAM <= ${desired.allowedBackgroundLoad.ramMb} MB per offender threshold`
    },
    {
      id: "crash-tolerance",
      label: "Crash Tolerance",
      ok: crashSignals === 0,
      current: `${crashSignals} crash signal(s)`,
      desired: desired.crashTolerance
    },
    {
      id: "restore-expectation",
      label: "Restore Expectation",
      ok: true,
      current: "Armed",
      desired: desired.restoreExpectation
    }
  ];
}
