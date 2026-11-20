const THERMAL_RANK = Object.freeze({
  unknown: 0,
  ok: 1,
  warm: 2,
  hot: 3,
  critical: 4
});

const SAFE_BOUNDARY = "observe, prepare, preflight, warn, and recommend only; no driver, BIOS, firmware, voltage, fan, process-kill, suspend, or permanent priority automation";

function activeProfiles(input = {}) {
  return Array.isArray(input.active) ? input.active : [];
}

function monitoredProfiles(input = {}) {
  return Array.isArray(input.monitoredProfiles) ? input.monitoredProfiles : [];
}

function guardrails(learning = null, learningInfluence = true) {
  if (learningInfluence === false) {
    return [];
  }
  return Array.isArray(learning?.guardrails) ? learning.guardrails : [];
}

function addGuard(collection, guard) {
  if (!guard?.id || collection.some((entry) => entry.id === guard.id)) {
    return;
  }
  collection.push({
    autonomous: true,
    layer: "failure-proactive-prevention",
    safeBoundary: SAFE_BOUNDARY,
    ...guard
  });
}

function knownSignatureStandby(profile) {
  return {
    id: `proactive.known-signature.${profile.id}`,
    profileId: profile.id,
    label: profile.label,
    severity: profile.severity,
    category: profile.category,
    phase: profile.phase,
    state: "standby",
    autonomous: true,
    layer: "failure-proactive-prevention",
    safeBoundary: SAFE_BOUNDARY,
    trigger: "documented-known-signature",
    action: "keep-signature-monitored",
    reason: `${profile.label}: known/documented issue remains monitored so a fresh recurrence routes directly to remediation.`
  };
}

export function buildFailureProactivePrevention({
  modeId = "balanced",
  failureWatchlist = {},
  failureDiagnostics = {},
  eventAnalysis = {},
  networkHealth = {},
  powerSystem = {},
  thermalState = {},
  learning = null,
  learningInfluence = true
} = {}) {
  const active = activeProfiles(failureWatchlist);
  const activeIds = new Set(active.map((profile) => profile.id));
  const activeGuards = [];
  const standbyGuards = monitoredProfiles(failureWatchlist)
    .filter((profile) => !activeIds.has(profile.id))
    .filter((profile) => Array.isArray(profile.documentedEvidence) && profile.documentedEvidence.length > 0)
    .map(knownSignatureStandby);

  const lowPriorityCount = (eventAnalysis.lowPriority || []).length;
  if (lowPriorityCount > 0) {
    addGuard(activeGuards, {
      id: "proactive.common-windows-noise",
      label: "Common Windows noise demotion",
      state: "watching",
      trigger: "common-low-priority-event",
      action: "demote-unless-correlated",
      reason: `${lowPriorityCount} low-priority/common event(s) are being demoted unless they correlate with a real failure.`
    });
  }

  if (networkHealth.state && networkHealth.state !== "good") {
    addGuard(activeGuards, {
      id: "proactive.network-preflight",
      label: "Network preflight",
      state: networkHealth.state,
      trigger: "network-health",
      action: "preflight-network-health",
      reason: networkHealth.issues?.[0] || "Network health is not clean; keep DNS, latency, VPN, adapter, and reachability checks visible."
    });
  }

  if (powerSystem.state && powerSystem.state !== "good") {
    addGuard(activeGuards, {
      id: "proactive.power-preflight",
      label: "Power capability preflight",
      state: powerSystem.state,
      trigger: "power-health",
      action: "preflight-power-capability",
      reason: powerSystem.issues?.[0] || "Power capability is not clean; keep plan, boost, USB, and GPU state checks visible."
    });
  }

  const thermalSeverity = thermalState.severity || "unknown";
  if (THERMAL_RANK[thermalSeverity] >= THERMAL_RANK.warm) {
    addGuard(activeGuards, {
      id: "proactive.thermal-preflight",
      label: "Thermal preflight",
      state: thermalSeverity,
      trigger: "thermal-hierarchy",
      action: "bias-caution-before-incident",
      reason: thermalState.summary
        ? `Thermal hierarchy is ${thermalSeverity}: ${thermalState.summary}.`
        : `Thermal hierarchy is ${thermalSeverity}; keep escalation cautious before this becomes an incident.`
    });
  }

  if ((eventAnalysis.storageSignals || []).length > 0) {
    addGuard(activeGuards, {
      id: "proactive.storage-preflight",
      label: "Storage warning preflight",
      state: "warning",
      trigger: "storage-event",
      action: "preserve-storage-context",
      reason: `${eventAnalysis.storageSignals.length} storage warning signal(s) are visible; preserve context and avoid treating them as generic noise.`
    });
  }

  for (const entry of guardrails(learning, learningInfluence).slice(0, 3)) {
    addGuard(activeGuards, {
      id: `proactive.learning-guardrail.${entry.profileId || "profile"}`,
      label: "Learned proactive caution",
      state: "learned",
      trigger: "learning-guardrail",
      action: "slow-repeat-risk",
      reason: `Learning is proactively restraining ${entry.profileId || modeId}: ${entry.reason || "guardrail active"}.`
    });
  }

  if (failureDiagnostics.state && !["clear", "critical"].includes(failureDiagnostics.state)) {
    addGuard(activeGuards, {
      id: "proactive.failure-watch-preflight",
      label: "Failure Watch preflight",
      state: failureDiagnostics.state,
      trigger: "known-failure-diagnostics",
      action: "keep-known-signatures-visible",
      reason: failureDiagnostics.summary || "Known signatures are present but not a live critical incident."
    });
  }

  const status = "fully-autonomous";
  const summary = activeGuards.length
    ? `${activeGuards.length} proactive hygiene guard(s) active; ${standbyGuards.length} known signature(s) on standby.`
    : `${standbyGuards.length} known signature(s) monitored proactively; no hygiene issue active.`;

  return {
    schema: "pc-control-plane-failure-proactive-prevention/v1",
    status,
    autonomous: true,
    layer: "failure-proactive-prevention",
    scope: "common, persistent, documented, and known-risk health hygiene",
    relation: "separate from the incident loop; recurrence prevention remains after remediation and learning",
    incidentLoop: ["detect", "remediate", "verify", "learn", "prevent"],
    proactiveLoop: ["observe", "preflight", "prepare", "warn", "recommend"],
    modeId,
    targetMode: null,
    activeCount: activeGuards.length,
    standbyCount: standbyGuards.length,
    guardCount: activeGuards.length + standbyGuards.length,
    activeGuards,
    standbyGuards,
    guards: [...activeGuards, ...standbyGuards],
    learning: {
      enabled: learningInfluence !== false,
      guardrailCount: guardrails(learning, learningInfluence).length
    },
    summary
  };
}
