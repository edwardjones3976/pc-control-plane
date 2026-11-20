function activeProfiles(input = {}) {
  return Array.isArray(input.active) ? input.active : [];
}

function activeGuardrails(learning = null) {
  return Array.isArray(learning?.guardrails) ? learning.guardrails : [];
}

function thermalReliabilityFor(learning = null, modeId = "balanced") {
  return learning?.profiles?.[modeId]?.thermal || { state: "unknown" };
}

function routesFromRemediation(remediation = {}, fallbackProfiles = []) {
  if (Array.isArray(remediation.routes) && remediation.routes.length) {
    return remediation.routes;
  }
  return fallbackProfiles.map((profile) => ({
    profileId: profile.id,
    label: profile.label,
    severity: profile.severity,
    recent: Boolean(profile.recent),
    action: profile.recent ? "remediate-pending" : "verification-standby",
    handler: "pending",
    autonomous: true
  }));
}

function preventionForRoute(route) {
  if (route.recent) {
    return {
      profileId: route.profileId,
      label: route.label,
      severity: route.severity,
      recent: true,
      route: "post-remediation-recurrence-guard",
      autonomous: true,
      reason: "After remediation, keep watching for recurrence and treat repeats with the same or more cautious handler."
    };
  }
  return {
    profileId: route.profileId,
    label: route.label,
    severity: route.severity,
    recent: false,
    route: "learned-standby",
    autonomous: true,
    reason: "Documented signature remains available as learned standby if the remediated pattern recurs."
  };
}

export function buildFailurePrevention({
  modeId = "balanced",
  suggestedMode = null,
  failureWatchlist = {},
  remediation = {},
  learning = null,
  learningInfluence = true
} = {}) {
  const profiles = activeProfiles(failureWatchlist);
  const routes = routesFromRemediation(remediation, profiles).map(preventionForRoute);
  const recentCount = routes.filter((route) => route.recent).length;
  const guardrails = learningInfluence ? activeGuardrails(learning) : [];
  const suggestedGuardrail = guardrails.find((entry) => entry.profileId === suggestedMode);
  const thermalReliability = thermalReliabilityFor(learning, modeId);
  const heatProne = learningInfluence && ["warm-prone", "hot-prone"].includes(thermalReliability.state);
  const preventions = [];

  for (const route of routes.filter((entry) => entry.recent)) {
    preventions.push({
      id: `failure.recurrence.${route.profileId}`,
      layer: "failure-prevention",
      autonomous: true,
      source: "remediation-outcome",
      reason: `${route.label}: prevent recurrence after remediation by keeping the route active until verification clears.`
    });
  }
  if (suggestedGuardrail) {
    preventions.push({
      id: "learning.guardrail-prevention",
      layer: "failure-prevention",
      autonomous: true,
      source: "learning",
      reason: `Learning prevents repeat bad outcomes by pausing auto-escalation into ${suggestedGuardrail.profileId}: ${suggestedGuardrail.reason}`
    });
  }
  if (heatProne) {
    preventions.push({
      id: "learning.thermal-prevention",
      layer: "failure-prevention",
      autonomous: true,
      source: "learning",
      reason: `Learning treats repeated thermal outcomes more effectively: ${modeId} is ${thermalReliability.state}, so recovery and escalation stay more cautious.`
    });
  }

  const status = "fully-autonomous";
  const summary = routes.length
    ? `${routes.length} remediated signature route(s) feeding recurrence prevention; ${recentCount} live.`
    : `${failureWatchlist.monitored || 0} guarded signatures monitored; prevention waits for remediation outcomes.`;

  return {
    schema: "pc-control-plane-failure-prevention/v2",
    status,
    autonomous: true,
    loopPosition: "after-learn",
    loop: ["detect", "remediate", "verify", "learn", "prevent"],
    modeId,
    targetMode: null,
    targetReason: "Prevention is post-remediation recurrence control; immediate safety targets belong to remediation.",
    monitored: failureWatchlist.monitored || 0,
    activeCount: routes.length,
    recentCount,
    documentedCount: Math.max(0, routes.length - recentCount),
    routes,
    preventions,
    learning: {
      enabled: learningInfluence !== false,
      guardrailCount: guardrails.length,
      heatProne,
      thermalReliability
    },
    summary
  };
}
