const HIGH_RISK_MODES = new Set(["overdrive", "performance", "competitive"]);

const REMEDIATION_HANDLERS = Object.freeze({
  "foreground-access-violation": {
    handler: "crash-evidence-downshift",
    capability: "capture evidence, downshift aggressive modes, and let learning score the next clean session"
  },
  "kernel-kmode-bugcheck": {
    handler: "kernel-crash-containment",
    capability: "preserve crash timeline, block aggressive modes, and require clean-session evidence before escalation"
  },
  "nvidia-driver-reset": {
    handler: "display-driver-containment",
    capability: "keep the GPU driver reset/watchdog signature visible, downshift only when recent or paired with pressure, and prevent overlay/cache-heavy foreground workload sessions"
  },
  "unexpected-restart": {
    handler: "restart-recovery",
    capability: "preserve reboot-adjacent evidence, offer restore, and move aggressive modes back to Balanced"
  },
  "unsupported-d3d11-rhi": {
    handler: "unsupported-config-prevention",
    capability: "detect unsupported override evidence and keep it as a reversible follow-up, not an unsafe live edit"
  },
  "nvidia-app-overlay-loop": {
    handler: "overlay-loop-prevention",
    capability: "treat overlay/self-update churn as session interference and keep cleanup reversible"
  },
  "cache-cleanup-locked": {
    handler: "session-boundary-cleanup",
    capability: "defer cleanup until the active workload and overlays are closed"
  },
  "protected-helper-failure": {
    handler: "protected-helper-watch",
    capability: "track repeat helper failures without constraining protected input/audio/security helpers"
  },
  "storage-disk-warning": {
    handler: "storage-health-prevention",
    capability: "preserve storage event timeline and avoid aggressive sessions during fresh warnings"
  },
  "service-control-manager-failure": {
    handler: "service-health-watch",
    capability: "classify service repeats before any restart rule is allowed"
  },
  "thermal-power-pressure": {
    handler: "thermal-adaptive-power",
    capability: "adaptive power holds below ceiling, floors hot states, and downshifts critical states"
  },
  "memory-cpu-pressure": {
    handler: "learned-relief",
    capability: "RAM trim and soft CPU relief run autonomously under strict learned gates"
  },
  "dcom-10016-noise": {
    handler: "noise-demotion",
    capability: "demote common Windows noise unless a real app failure correlates with it"
  }
});

function activeProfiles(input = {}) {
  return Array.isArray(input.active) ? input.active : [];
}

function handlerFor(profile) {
  return REMEDIATION_HANDLERS[profile.id] || {
    handler: "generic-failure-containment",
    capability: "capture evidence, route remediation, and keep the signature visible until it clears"
  };
}

function routeForProfile(profile) {
  const handler = handlerFor(profile);
  const live = Boolean(profile.recent && profile.severity !== "low");
  const action = live
    ? profile.autoDownshift || profile.blockHighModes
      ? "remediate-and-downshift"
      : "remediate-by-containment"
    : "verification-standby";

  return {
    profileId: profile.id,
    label: profile.label,
    severity: profile.severity,
    category: profile.category,
    recent: Boolean(profile.recent),
    action,
    handler: handler.handler,
    capability: handler.capability,
    autonomous: true,
    safeBoundary: "non-destructive; no driver, BIOS, firmware, voltage, fan, kill, suspend, or permanent process priority automation",
    fastPatch: (profile.fastPatch || [])[0] || null,
    hardenedPatch: (profile.hardenedPatch || [])[0] || null
  };
}

function learningSummary(learning = null, learningInfluence = true) {
  const guardrails = Array.isArray(learning?.guardrails) ? learning.guardrails : [];
  const profiles = learning?.profiles || {};
  const heatProneProfiles = Object.entries(profiles)
    .filter(([, profile]) => ["warm-prone", "hot-prone"].includes(profile?.thermal?.state))
    .map(([profileId, profile]) => ({
      profileId,
      state: profile.thermal.state,
      sessions: profile.sessions || 0,
      avgScore: profile.avgScore ?? null
    }));
  return {
    enabled: learningInfluence !== false,
    guardrailCount: learningInfluence === false ? 0 : guardrails.length,
    heatProneProfiles: learningInfluence === false ? [] : heatProneProfiles,
    role: learningInfluence === false
      ? "advisory-only"
      : "restrains escalation, lengthens caution, and scores whether remediation produced clean sessions"
  };
}

export function buildFailureRemediation({
  modeId = "balanced",
  failureWatchlist = {},
  failureDiagnostics = {},
  learning = null,
  learningInfluence = true
} = {}) {
  const profiles = activeProfiles(failureWatchlist);
  const routes = profiles.map(routeForProfile);
  const liveRoutes = routes.filter((route) => route.recent && route.severity !== "low");
  const evidenceFallback = failureWatchlist.evidenceFallback || null;
  const shouldArmDiagnosticTraps = liveRoutes.length > 0;
  const safetyTargetMode = HIGH_RISK_MODES.has(modeId) &&
    liveRoutes.some((route) => route.action === "remediate-and-downshift")
      ? "balanced"
      : null;
  const status = "fully-autonomous";
  const summary = profiles.length
    ? `${profiles.length} signature(s) fully routed: ${liveRoutes.length} live remediation, ${profiles.length - liveRoutes.length} verification standby.${evidenceFallback?.active ? " Retained failure evidence is being used after a telemetry capture error." : ""}`
    : `${failureWatchlist.monitored || 0} guarded signatures monitored; remediation standing by.`;

  return {
    schema: "pc-control-plane-failure-remediation/v1",
    status,
    autonomous: true,
    loop: ["detect", "remediate", "verify", "learn", "prevent"],
    modeId,
    active: profiles.length > 0,
    monitored: failureWatchlist.monitored || 0,
    activeCount: profiles.length,
    liveCount: liveRoutes.length,
    standbyCount: Math.max(0, profiles.length - liveRoutes.length),
    evidenceFallback,
    routes,
    unhandled: [],
    shouldArmDiagnosticTraps,
    safetyTargetMode,
    diagnosticsState: failureDiagnostics.state || "clear",
    nextAction: liveRoutes[0]?.capability || failureDiagnostics.nextAction || "Keep monitoring guarded signatures.",
    learning: learningSummary(learning, learningInfluence),
    summary
  };
}

export function remediationStatusLabel(remediation = {}) {
  return remediation.status === "fully-autonomous"
    ? "fully and autonomously handled"
    : "not fully routed";
}
