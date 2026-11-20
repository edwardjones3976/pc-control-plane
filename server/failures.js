const severityRank = Object.freeze({
  low: 0,
  info: 1,
  warning: 2,
  critical: 3
});

function textForEvent(event = {}) {
  return [
    event.logName,
    event.provider,
    event.level,
    event.failureSignature ? `failureSignature:${event.failureSignature}` : null,
    event.message,
    event.analysis?.category,
    event.analysis?.subcategory,
    event.analysis?.label
  ]
    .filter(Boolean)
    .join(" ");
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function matchesAll(text, patterns = []) {
  return patterns.every((pattern) => pattern.test(text));
}

function matcherMatchesEvent(event, matcher) {
  const text = textForEvent(event);
  if (matcher.provider && !matcher.provider.test(String(event.provider || ""))) {
    return false;
  }
  if (matcher.logName && !matcher.logName.test(String(event.logName || ""))) {
    return false;
  }
  if (matcher.id !== undefined) {
    const ids = Array.isArray(matcher.id) ? matcher.id : [matcher.id];
    if (!ids.includes(Number(event.id))) {
      return false;
    }
  }
  if (matcher.analysisCategory && event.analysis?.category !== matcher.analysisCategory) {
    return false;
  }
  if (matcher.analysisSubcategory && event.analysis?.subcategory !== matcher.analysisSubcategory) {
    return false;
  }
  if (matcher.any && !matchesAny(text, matcher.any)) {
    return false;
  }
  if (matcher.all && !matchesAll(text, matcher.all)) {
    return false;
  }
  return true;
}

function telemetryEvidence({ label, value, threshold, actual }) {
  return {
    time: new Date().toISOString(),
    provider: "telemetry",
    id: null,
    level: "Warning",
    message: `${label}: ${value}`,
    evidence: { threshold, actual },
    ageSeconds: 0,
    analysis: {
      severity: "warning",
      category: "pre-crash",
      subcategory: "telemetry-pressure",
      label
    }
  };
}

export const failureProfiles = Object.freeze([
  {
    id: "foreground-access-violation",
    label: "Foreground access violation",
    severity: "critical",
    category: "app-crash",
    phase: "post-crash",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      { analysisSubcategory: "foreground-access-violation" }
    ],
    autoDownshift: true,
    blockHighModes: true,
    fastPatch: [
      "Capture WER/minidump/event context before cleanup.",
      "Downshift high modes to Balanced and keep Auto-Safe cooldown active.",
      "Keep the next competitive gaming session on high-power prep without frame caps or process constraints.",
      "Defer cache cleanup until the active workload and overlays are closed."
    ],
    hardenedPatch: [
      "Keep unsupported render overrides removed.",
      "Track repeats by workload, GPU driver, HAGS state, monitor ID, and unrestricted pacing state.",
      "Promote a last-known-good competitive gaming profile only after a clean session."
    ]
  },
  {
    id: "kernel-kmode-bugcheck",
    label: "Kernel KMODE/access bugcheck",
    severity: "critical",
    category: "kernel-crash",
    phase: "post-crash",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      {
        provider: /WER-SystemErrorReporting/i,
        id: 1001,
        any: [/0x0000001e|0x1e|KMODE_EXCEPTION_NOT_HANDLED|c0000005/i]
      },
      { all: [/KMODE_EXCEPTION_NOT_HANDLED/i, /c0000005|access violation/i] }
    ],
    autoDownshift: false,
    blockHighModes: true,
    fastPatch: [
      "Downshift from Overdrive/Performance/Competitive to Balanced.",
      "Preserve dump analysis and the event timeline.",
      "Avoid starting a competitive gaming session until display, storage, and WHEA events are reviewed."
    ],
    hardenedPatch: [
      "Correlate loaded drivers from the dump with recent driver/app changes.",
      "Flag repeat third-party kernel drivers and overlay/filter drivers for manual review.",
      "Require a clean reboot window before re-enabling aggressive profiles."
    ]
  },
  {
    id: "nvidia-driver-reset",
    label: "GPU driver reset/watchdog issue",
    severity: "warning",
    category: "hardware-driver",
    phase: "pre-crash",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      { provider: /nvlddmkm/i, id: [13, 14, 153] },
      { provider: /display/i, id: 4101 },
      {
        provider: /Windows Error Reporting|WER/i,
        id: 1001,
        all: [
          /LiveKernelEvent|LKD_0x(?:141|117)|\b(?:Code|P1):\s*(?:141|117)\b|\b0x(?:141|117)\b|Tdr|WATCHDOG/i,
          /nvlddmkm|display|gpu|graphics|Tdr|WATCHDOG/i
        ]
      },
      { all: [/failureSignature:nvidia-driver-reset/i] },
      { analysisSubcategory: "nvidia-driver-reset" },
      { analysisSubcategory: "nvidia-driver-event" },
      { all: [/display driver/i, /stopped responding|nvlddmkm/i] }
    ],
    autoDownshift: true,
    blockHighModes: false,
    fastPatch: [
      "Treat the Windows GPU driver reset/watchdog signal as visible until a clean follow-up session clears it.",
      "Downshift high modes if paired with app crashes or thermal pressure.",
      "Keep overlay and extra telemetry capture out of clean foreground workload sessions unless explicitly needed."
    ],
    hardenedPatch: [
      "Compare crashes by GPU driver branch before changing drivers manually.",
      "Keep a rollback copy for NVIDIA App/overlay repairs.",
      "Add a clean-session proof run after driver or overlay changes."
    ]
  },
  {
    id: "unexpected-restart",
    label: "Unexpected restart",
    severity: "critical",
    category: "system-crash",
    phase: "post-crash",
    source: "common",
    documentedEvidence: [],
    eventMatchers: [
      { provider: /Kernel-Power/i, id: 41 },
      { provider: /^EventLog$/i, id: 6008 }
    ],
    autoDownshift: true,
    blockHighModes: true,
    fastPatch: [
      "Treat as timeline evidence and correlate with the preceding app, driver, or WHEA event.",
      "Offer Panic Restore if any action chain was incomplete."
    ],
    hardenedPatch: [
      "Keep reboot-adjacent event bundles in session history.",
      "Separate power-loss symptoms from the root trigger before applying driver or config fixes."
    ]
  },
  {
    id: "unsupported-d3d11-rhi",
    label: "Unsupported D3D11/RHI override",
    severity: "warning",
    category: "app-config",
    phase: "pre-crash",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      { any: [/unsupported D3D11/i, /DefaultGraphicsRHI/i, /LaunchOptions=-d3d11/i, /\s-d3d11\b/i] }
    ],
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Remove DefaultGraphicsRHI and -d3d11 overrides.",
      "Keep launcher overlays disabled for the active workload when they correlate with failures.",
      "Leave the app settings file writable after applying the supported settings profile."
    ],
    hardenedPatch: [
      "Do not reintroduce unsupported RHI forcing as a fast patch.",
      "Prefer supported app settings plus cache cleanup over render overrides."
    ]
  },
  {
    id: "nvidia-app-overlay-loop",
    label: "NVIDIA app/overlay loop",
    severity: "warning",
    category: "background-interference",
    phase: "pre-crash",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      { all: [/NVIDIA/i, /Overlay|FrameView|Downloader|SelfUpdate|SessionTelemetry/i] }
    ],
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Keep overlay and telemetry processes out of clean competitive gaming sessions.",
      "Prefer disabling self-update/overlay tasks with rollback over blanket service removal."
    ],
    hardenedPatch: [
      "Record service/task state before and after NVIDIA app repairs.",
      "Verify core display container services are restored after cleanup."
    ]
  },
  {
    id: "cache-cleanup-locked",
    label: "Shader/cache cleanup locked",
    severity: "warning",
    category: "cleanup-failure",
    phase: "pre-crash",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      { all: [/DXCache|GLCache|shader|cache/i, /being used by another process|cannot access the file/i] }
    ],
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Close the active workload, launcher overlays, and GPU tooling before cache cleanup.",
      "Retry cleanup as a session boundary action, not during active competitive gaming work."
    ],
    hardenedPatch: [
      "Treat locked cache files as cleanup debt and verify the next run, not as a fatal failure.",
      "Keep cache cleanup scoped to known graphics/cache paths."
    ]
  },
  {
    id: "protected-helper-failure",
    label: "Protected helper app failure",
    severity: "warning",
    category: "app-failure",
    phase: "runtime",
    source: "signature-catalog",
    documentedEvidence: [],
    eventMatchers: [
      { provider: /\.NET Runtime/i, id: 1026 },
      { provider: /Application Error/i, id: 1000, any: [/0xc0000005|c0000005|unhandled exception/i] }
    ],
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Refresh the failing helper only if it repeats or affects the active mode.",
      "Keep protected peripherals and Phone Link out of automatic process constraints."
    ],
    hardenedPatch: [
      "Add helper-specific restart rules only after repeat evidence.",
      "Keep security and input helpers on the allow list unless they are the proven offender."
    ]
  },
  {
    id: "storage-disk-warning",
    label: "Disk/storage warning",
    severity: "warning",
    category: "hardware-storage",
    phase: "pre-crash",
    source: "common",
    documentedEvidence: [],
    eventMatchers: [
      { provider: /^disk$/i, id: [7, 11, 51, 153] },
      { provider: /stornvme|storport|ntfs/i, id: [55, 129, 153] }
    ],
    autoDownshift: true,
    blockHighModes: false,
    fastPatch: [
      "Avoid starting competitive gaming sessions during fresh storage warnings.",
      "Preserve the storage event timeline with the crash bundle."
    ],
    hardenedPatch: [
      "Run storage health checks outside the web UI when warnings repeat.",
      "Correlate storage warnings with dump creation and cache paths."
    ]
  },
  {
    id: "service-control-manager-failure",
    label: "Windows service failure",
    severity: "warning",
    category: "service-failure",
    phase: "runtime",
    source: "common",
    documentedEvidence: [],
    eventMatchers: [
      { provider: /Service Control Manager/i, id: [7000, 7009, 7023, 7031, 7034, 7043] }
    ],
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Classify as service health, not an app crash, unless it aligns with the failure timestamp.",
      "Restart only known session helpers with rollback context."
    ],
    hardenedPatch: [
      "Track repeat service names before adding automation.",
      "Keep unrelated service noise out of crash counts."
    ]
  },
  {
    id: "thermal-power-pressure",
    label: "Thermal or GPU power pressure",
    severity: "warning",
    category: "pre-crash-telemetry",
    phase: "pre-crash",
    source: "common",
    documentedEvidence: [],
    matchTelemetry(telemetry = {}) {
      const matches = [];
      const temp = Number(telemetry.gpu?.temperatureC);
      if (Number.isFinite(temp) && temp >= 82) {
        matches.push(telemetryEvidence({
          label: "GPU temperature pressure",
          value: `${temp} C`,
          threshold: ">= 82 C",
          actual: temp
        }));
      }
      const draw = Number(telemetry.gpu?.powerDrawW);
      const limit = Number(telemetry.gpu?.powerLimitW);
      if (Number.isFinite(draw) && Number.isFinite(limit) && limit > 0 && draw / limit >= 0.95) {
        matches.push(telemetryEvidence({
          label: "GPU power limit pressure",
          value: `${Math.round((draw / limit) * 100)}%`,
          threshold: ">= 95%",
          actual: draw / limit
        }));
      }
      return matches;
    },
    autoDownshift: true,
    blockHighModes: false,
    fastPatch: [
      "Downshift from Overdrive/Performance/Competitive when pressure persists.",
      "Keep the next session unrestricted; use telemetry to detect whether load is CPU, GPU, or driver constrained."
    ],
    hardenedPatch: [
      "Record pressure alongside driver, power plan, and active profile.",
      "Tune mode thresholds only after repeated clean-session evidence."
    ]
  },
  {
    id: "memory-cpu-pressure",
    label: "CPU or RAM pressure",
    severity: "warning",
    category: "pre-crash-telemetry",
    phase: "pre-crash",
    source: "common",
    documentedEvidence: [],
    matchTelemetry(telemetry = {}) {
      const matches = [];
      const cpu = Number(telemetry.system?.cpuLoadPct);
      if (Number.isFinite(cpu) && cpu >= 95) {
        matches.push(telemetryEvidence({
          label: "CPU pressure",
          value: `${cpu}%`,
          threshold: ">= 95%",
          actual: cpu
        }));
      }
      const ram = Number(telemetry.system?.ramUsedPct);
      if (Number.isFinite(ram) && ram >= 90) {
        matches.push(telemetryEvidence({
          label: "RAM pressure",
          value: `${ram}%`,
          threshold: ">= 90%",
          actual: ram
        }));
      }
      return matches;
    },
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Review unchecked offenders before starting or continuing competitive gaming sessions.",
      "Downshift if pressure coexists with crash or driver signals."
    ],
    hardenedPatch: [
      "Promote repeat offenders into mode-specific advisory or protection rules.",
      "Keep agentic workloads protected in Agentic mode and out of Competitive mode."
    ]
  },
  {
    id: "dcom-10016-noise",
    label: "DCOM 10016 noise",
    severity: "low",
    category: "windows-noise",
    phase: "runtime",
    source: "common",
    documentedEvidence: [],
    eventMatchers: [
      { provider: /DistributedCOM/i, id: 10016 }
    ],
    autoDownshift: false,
    blockHighModes: false,
    fastPatch: [
      "Do not treat DCOM 10016 as a crash trigger by itself."
    ],
    hardenedPatch: [
      "Keep DCOM 10016 demoted unless an app-specific failure points to the same CLSID/APPID."
    ]
  }
]);

export function listFailureProfiles() {
  return failureProfiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    severity: profile.severity,
    category: profile.category,
    phase: profile.phase,
    source: profile.source,
    documentedEvidence: profile.documentedEvidence || []
  }));
}

function eventSummary(event) {
  return {
    time: event.time || null,
    logName: event.logName || null,
    provider: event.provider || null,
    id: event.id ?? null,
    level: event.level || null,
    ageSeconds: event.ageSeconds ?? null,
    message: String(event.message || "").slice(0, 220),
    analysis: event.analysis
      ? {
          severity: event.analysis.severity,
          category: event.analysis.category,
          subcategory: event.analysis.subcategory,
          label: event.analysis.label
        }
      : null
  };
}

function addProfileHit(map, profile, event) {
  const existing = map.get(profile.id) || {
    profile,
    events: [],
    count: 0,
    newestTime: null,
    recent: false
  };
  existing.count += 1;
  existing.events.push(event);
  const ts = Date.parse(String(event.time || ""));
  if (Number.isFinite(ts)) {
    existing.newestTime = Math.max(existing.newestTime || 0, ts);
  }
  if (Number(event.ageSeconds) >= 0 && Number(event.ageSeconds) <= 45 * 60) {
    existing.recent = true;
  }
  map.set(profile.id, existing);
}

function serializeHit(hit) {
  const { profile } = hit;
  return {
    id: profile.id,
    label: profile.label,
    severity: profile.severity,
    category: profile.category,
    phase: profile.phase,
    source: profile.source,
    count: hit.count,
    recent: hit.recent,
    newestAt: hit.newestTime ? new Date(hit.newestTime).toISOString() : null,
    autoDownshift: Boolean(profile.autoDownshift && hit.recent),
    blockHighModes: Boolean(profile.blockHighModes && hit.recent),
    documentedEvidence: profile.documentedEvidence || [],
    fastPatch: profile.fastPatch || [],
    hardenedPatch: profile.hardenedPatch || [],
    events: hit.events.slice(0, 4).map(eventSummary)
  };
}

function unique(items, max = 8) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

export function buildFailurePatchPlans(activeProfiles = []) {
  const actionable = activeProfiles.filter((profile) => profile.severity !== "low");
  const fastActions = unique(actionable.flatMap((profile) => profile.fastPatch || []), 8);
  const hardenedActions = unique(actionable.flatMap((profile) => profile.hardenedPatch || []), 8);
  return {
    fastPatchPlan: {
      active: fastActions.length > 0,
      actions: fastActions
    },
    hardenedPatchPlan: {
      active: hardenedActions.length > 0,
      actions: hardenedActions
    }
  };
}

export function buildFailureWatchlist({ telemetry = {}, eventAnalysis = {} } = {}) {
  const hits = new Map();
  const events = eventAnalysis.all || [];

  for (const event of events) {
    for (const profile of failureProfiles) {
      if ((profile.eventMatchers || []).some((matcher) => matcherMatchesEvent(event, matcher))) {
        addProfileHit(hits, profile, event);
      }
    }
  }

  for (const profile of failureProfiles) {
    if (typeof profile.matchTelemetry !== "function") {
      continue;
    }
    for (const event of profile.matchTelemetry(telemetry) || []) {
      addProfileHit(hits, profile, event);
    }
  }

  const active = [...hits.values()]
    .map(serializeHit)
    .sort((a, b) => {
      const severityDelta = severityRank[b.severity] - severityRank[a.severity];
      if (severityDelta) return severityDelta;
      return String(b.newestAt || "").localeCompare(String(a.newestAt || ""));
    });

  const { fastPatchPlan, hardenedPatchPlan } = buildFailurePatchPlans(active);
  return {
    monitored: failureProfiles.length,
    monitoredProfiles: listFailureProfiles(),
    evidenceFallback: telemetry.failureEvidenceFallback || null,
    active,
    activeCount: active.length,
    criticalCount: active.filter((profile) => profile.severity === "critical").length,
    warningCount: active.filter((profile) => profile.severity === "warning").length,
    recentCriticalCount: active.filter((profile) => profile.severity === "critical" && profile.recent).length,
    autoDownshift: active.some((profile) => profile.autoDownshift),
    blockHighModes: active.some((profile) => profile.blockHighModes),
    fastPatchPlan,
    hardenedPatchPlan
  };
}

function countBy(items = [], field) {
  return items.reduce((acc, item) => {
    const key = String(item?.[field] || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function evidenceRank(evidence) {
  return severityRank[evidence.severity] || 0;
}

export function buildFailureDiagnostics({ telemetry = {}, eventAnalysis = {}, watchlist = null } = {}) {
  const failureWatchlist = watchlist || buildFailureWatchlist({ telemetry, eventAnalysis });
  const active = failureWatchlist.active || [];
  const actionable = active.filter((profile) => profile.severity !== "low");
  const evidence = active
    .flatMap((profile) =>
      (profile.events || []).map((event) => ({
        profileId: profile.id,
        profileLabel: profile.label,
        severity: profile.severity,
        phase: profile.phase,
        source: profile.source,
        time: event.time || null,
        provider: event.provider || null,
        id: event.id ?? null,
        level: event.level || null,
        message: event.message || ""
      }))
    )
    .sort((a, b) => {
      const severityDelta = evidenceRank(b) - evidenceRank(a);
      if (severityDelta) return severityDelta;
      return String(b.time || "").localeCompare(String(a.time || ""));
    })
    .slice(0, 12);

  const state = failureWatchlist.recentCriticalCount > 0
    ? "critical"
    : actionable.length > 0
      ? "warning"
      : active.length > 0
        ? "info"
        : "clear";
  const topProfile = active[0] || null;
  const nextAction = failureWatchlist.fastPatchPlan.actions[0]
    || failureWatchlist.hardenedPatchPlan.actions[0]
    || "Keep monitoring documented failure signatures.";

  return {
    generatedAt: new Date().toISOString(),
    state,
    summary: active.length
      ? `${active.length} known signature${active.length === 1 ? "" : "s"} across ${failureWatchlist.monitored} monitored profiles.`
      : `${failureWatchlist.monitored} monitored profiles; no known signatures.`,
    nextAction,
    watch: {
      monitored: failureWatchlist.monitored,
      activeCount: failureWatchlist.activeCount,
      criticalCount: failureWatchlist.criticalCount,
      warningCount: failureWatchlist.warningCount,
      recentCriticalCount: failureWatchlist.recentCriticalCount,
      autoDownshift: failureWatchlist.autoDownshift,
      blockHighModes: failureWatchlist.blockHighModes
    },
    eventCounts: {
      crash: (eventAnalysis.crashSignals || []).length,
      recentCrash: (eventAnalysis.recentCrashSignals || []).length,
      hardwareDriver: (eventAnalysis.hardwareSignals || []).length,
      appFailure: (eventAnalysis.appFailureSignals || []).length,
      serviceFailure: (eventAnalysis.serviceSignals || []).length,
      storage: (eventAnalysis.storageSignals || []).length,
      dump: (eventAnalysis.dumpSignals || []).length,
      lowPriority: (eventAnalysis.lowPriority || []).length
    },
    profileCounts: {
      bySeverity: countBy(active, "severity"),
      byCategory: countBy(active, "category"),
      byPhase: countBy(active, "phase"),
      bySource: countBy(active, "source")
    },
    topProfile: topProfile
      ? {
          id: topProfile.id,
          label: topProfile.label,
          severity: topProfile.severity,
          category: topProfile.category,
          phase: topProfile.phase,
          source: topProfile.source,
          count: topProfile.count,
          recent: topProfile.recent,
          newestAt: topProfile.newestAt,
          fastPatch: topProfile.fastPatch?.[0] || null,
          hardenedPatch: topProfile.hardenedPatch?.[0] || null
        }
      : null,
    activeProfiles: active.slice(0, 8),
    evidence,
    patchPlan: {
      fast: failureWatchlist.fastPatchPlan,
      hardened: failureWatchlist.hardenedPatchPlan
    }
  };
}
