
export const INCIDENT_LEARNING_SCHEMA = "pc-control-plane-incident-learning/v1";

const MAX_RECORDS = 40;
const CLEAN_SAMPLE_MS = 15 * 60 * 1000;
const CLEAN_SAMPLES_TO_PROVE = 3;

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function iso(value = Date.now()) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value) || Number(value) || Date.now();
  return new Date(ms).toISOString();
}

function hagsLabel(value) {
  const n = finite(value, null);
  if (n === 1) return "off";
  if (n === 2) return "on";
  if (n === 0) return "Windows default";
  return "unknown";
}

function activeNvidiaReset(policy = {}, telemetry = {}) {
  const activeProfiles = Array.isArray(policy.failureWatchlist?.active) ? policy.failureWatchlist.active : [];
  const remediationRoutes = Array.isArray(policy.failureRemediation?.routes) ? policy.failureRemediation.routes : [];
  const events = Array.isArray(telemetry.recentEvents) ? telemetry.recentEvents : [];
  const fromProfiles = activeProfiles.some((profile) => profile?.id === "nvidia-driver-reset");
  const fromRoutes = remediationRoutes.some((route) => route?.profileId === "nvidia-driver-reset" || route?.id === "nvidia-driver-reset");
  const fromEvents = events.some((event) => event?.analysis?.subcategory === "nvidia-driver-reset");
  const fromFallback = telemetry.failureEvidenceFallback?.observerLastFailureSignature === "nvidia-driver-reset";
  return Boolean(fromProfiles || fromRoutes || fromEvents || fromFallback);
}

function resetSources(telemetry = {}) {
  const sources = new Set();
  for (const event of Array.isArray(telemetry.recentEvents) ? telemetry.recentEvents : []) {
    if (event?.analysis?.subcategory === "nvidia-driver-reset") {
      sources.add(event.provider || event.source || "Windows event");
    }
  }
  for (const source of telemetry.failureEvidenceFallback?.sources || []) {
    sources.add(`fallback:${source}`);
  }
  return [...sources].slice(0, 8);
}

function resetEvidenceFingerprints(telemetry = {}) {
  const fingerprints = [];
  for (const event of Array.isArray(telemetry.recentEvents) ? telemetry.recentEvents : []) {
    if (event?.analysis?.subcategory !== "nvidia-driver-reset") {
      continue;
    }
    fingerprints.push([
      event.provider || event.source || "event",
      event.id || event.eventId || event.eventRecordId || "id-unknown",
      event.time || event.timestamp || event.createdAt || event.ts || "time-unknown",
      event.analysis?.subcategory || "nvidia-driver-reset"
    ].join("|"));
  }
  if (!fingerprints.length && telemetry.failureEvidenceFallback?.observerLastFailureSignature === "nvidia-driver-reset") {
    fingerprints.push([
      "fallback",
      telemetry.failureEvidenceFallback.priorCapturedAt || "prior-unknown",
      (telemetry.failureEvidenceFallback.sources || []).join(",") || "source-unknown"
    ].join("|"));
  }
  return [...new Set(fingerprints)].slice(0, 8);
}

export function normalizeIncidentLearningStore(store = {}) {
  const records = Array.isArray(store?.records) ? store.records : [];
  return {
    schema: INCIDENT_LEARNING_SCHEMA,
    updatedAt: store?.updatedAt || null,
    records: records
      .filter((record) => record && typeof record === "object")
      .slice(-MAX_RECORDS)
      .map((record) => ({
        id: String(record.id || `${record.signatureId || "incident"}:${record.firstSeenAt || Date.now()}`),
        key: record.key || null,
        signatureId: String(record.signatureId || "unknown"),
        label: String(record.label || "Known issue"),
        firstSeenAt: record.firstSeenAt || null,
        lastSeenAt: record.lastSeenAt || record.firstSeenAt || null,
        recurrenceCount: Math.max(1, Math.round(Number(record.recurrenceCount) || 1)),
        observedEvidence: Array.isArray(record.observedEvidence) ? record.observedEvidence.slice(-16) : [],
        status: record.status || "watching-clean-sessions",
        cleanSamples: Math.max(0, Math.round(Number(record.cleanSamples) || 0)),
        lastCleanSampleAt: record.lastCleanSampleAt || null,
        evidence: {
          driverVersion: record.evidence?.driverVersion || null,
          gpuName: record.evidence?.gpuName || null,
          hags: record.evidence?.hags || "unknown",
          gpuPowerLimitW: finite(record.evidence?.gpuPowerLimitW, null),
          gpuPowerDefaultLimitW: finite(record.evidence?.gpuPowerDefaultLimitW, null),
          gpuPowerDrawW: finite(record.evidence?.gpuPowerDrawW, null),
          sources: Array.isArray(record.evidence?.sources) ? record.evidence.sources.slice(0, 8) : []
        },
        report: Array.isArray(record.report) ? record.report.slice(0, 8) : []
      }))
  };
}

export function buildIncidentLearningSignal({ state = {}, telemetry = {}, policy = {}, now = Date.now() } = {}) {
  const gpu = telemetry.gpu || {};
  const hags = hagsLabel(telemetry.power?.hags);
  const signal = {
    active: activeNvidiaReset(policy, telemetry),
    signatureId: "nvidia-driver-reset",
    label: "GPU driver reset/watchdog issue",
    at: iso(now),
    state: {
      modeId: state.modeId || null,
      autonomy: state.autonomy || null
    },
    evidence: {
      driverVersion: gpu.driver || null,
      gpuName: gpu.name || null,
      hags,
      gpuPowerLimitW: finite(gpu.powerLimitW, null),
      gpuPowerDefaultLimitW: finite(gpu.powerDefaultLimitW, null),
      gpuPowerDrawW: finite(gpu.powerDrawW, null),
      sources: resetSources(telemetry),
      evidenceFingerprints: resetEvidenceFingerprints(telemetry)
    },
    report: [
      gpu.driver ? `NVIDIA driver observed: ${gpu.driver}.` : "NVIDIA driver version is not available in telemetry.",
      `HAGS observed: ${hags}.`,
      finite(gpu.powerLimitW, null) != null ? `GPU power limit observed: ${Math.round(Number(gpu.powerLimitW))}W.` : "GPU power limit is not available in telemetry."
    ]
  };
  return signal;
}

function recordSignatureKey(signal = {}) {
  return [
    signal.signatureId,
    signal.evidence?.driverVersion || "driver-unknown",
    signal.evidence?.hags || "hags-unknown",
    signal.evidence?.gpuPowerLimitW || "gpu-limit-unknown"
  ].join("|");
}

function policyLooksClean(policy = {}) {
  const health = String(policy.health?.state || "").toLowerCase();
  const active = Array.isArray(policy.failureWatchlist?.active) ? policy.failureWatchlist.active : [];
  return (health === "stable" || health === "warm") && !active.some((profile) => profile?.id === "nvidia-driver-reset" && profile?.recent);
}

export function observeIncidentLearning(store = {}, context = {}) {
  const next = normalizeIncidentLearningStore(store);
  const signal = buildIncidentLearningSignal(context);
  const nowIso = signal.at;
  const nowMs = Date.parse(nowIso);
  let changed = false;

  if (signal.active) {
    const key = recordSignatureKey(signal);
    let record = next.records.find((entry) => entry.key === key);
    let isNew = false;
    if (!record) {
      isNew = true;
      record = {
        id: `${signal.signatureId}:${nowMs}`,
        key,
        signatureId: signal.signatureId,
        label: signal.label,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        recurrenceCount: 0,
        observedEvidence: [],
        status: "watching-clean-sessions",
        cleanSamples: 0,
        lastCleanSampleAt: null,
        evidence: {},
        report: []
      };
      next.records.push(record);
    }
    const fingerprints = signal.evidence?.evidenceFingerprints || [];
    const unseenFingerprints = fingerprints.filter((fingerprint) => !record.observedEvidence.includes(fingerprint));
    const newOccurrence = isNew || unseenFingerprints.length > 0;
    if (newOccurrence) {
      record.lastSeenAt = nowIso;
      record.recurrenceCount = Math.max(1, Number(record.recurrenceCount || 0) + 1);
      record.status = "watching-clean-sessions";
      record.cleanSamples = 0;
      record.lastCleanSampleAt = null;
      record.evidence = signal.evidence;
      record.observedEvidence = [...new Set([...(record.observedEvidence || []), ...fingerprints])].slice(-16);
      record.report = signal.report;
      changed = true;
    }
  } else {
    const latest = [...next.records].reverse().find((entry) =>
      entry.signatureId === "nvidia-driver-reset" &&
      entry.status !== "verified-clean"
    );
    if (latest) {
      const lastCleanMs = Date.parse(latest.lastCleanSampleAt || latest.lastSeenAt || latest.firstSeenAt || 0);
      if (policyLooksClean(context.policy) && (!Number.isFinite(lastCleanMs) || nowMs - lastCleanMs >= CLEAN_SAMPLE_MS)) {
        latest.cleanSamples = Math.min(CLEAN_SAMPLES_TO_PROVE, Number(latest.cleanSamples || 0) + 1);
        latest.lastCleanSampleAt = nowIso;
        latest.status = latest.cleanSamples >= CLEAN_SAMPLES_TO_PROVE ? "verified-clean" : "clean-evidence-building";
        changed = true;
      }
    }
  }

  if (next.records.length > MAX_RECORDS) {
    next.records = next.records.slice(-MAX_RECORDS);
    changed = true;
  }
  if (changed) {
    next.updatedAt = nowIso;
  }
  return { store: next, changed, signal };
}

export function summarizeIncidentLearning(store = {}, context = {}) {
  const norm = normalizeIncidentLearningStore(store);
  const signal = buildIncidentLearningSignal(context);
  const latest = [...norm.records].reverse().find((record) => record.signatureId === "nvidia-driver-reset") || null;
  const lines = [];

  if (latest) {
    lines.push(`${latest.label}: ${latest.status.replace(/-/g, " ")} after ${latest.recurrenceCount} observed signal(s).`);
    if (latest.evidence.driverVersion) lines.push(`Driver observed: ${latest.evidence.driverVersion}.`);
    if (latest.evidence.hags) lines.push(`HAGS observed: ${latest.evidence.hags}.`);
    if (latest.evidence.gpuPowerLimitW != null) lines.push(`GPU power limit observed: ${Math.round(latest.evidence.gpuPowerLimitW)}W.`);
    if (latest.status !== "verified-clean") {
      lines.push(`Waiting for ${Math.max(0, CLEAN_SAMPLES_TO_PROVE - latest.cleanSamples)} more clean observation(s) before treating the mitigation as proven.`);
    }
  } else {
    lines.push("No GPU reset/watchdog incident has been learned yet.");
    lines.push(signal.report[0]);
  }

  return {
    schema: INCIDENT_LEARNING_SCHEMA,
    quiet: true,
    updatedAt: norm.updatedAt,
    status: latest?.status || "watching",
    activeSignal: signal.active,
    records: norm.records.slice(-8).map((record) => ({
      id: record.id,
      signatureId: record.signatureId,
      label: record.label,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      recurrenceCount: record.recurrenceCount,
      status: record.status,
      cleanSamples: record.cleanSamples,
      lastCleanSampleAt: record.lastCleanSampleAt,
      evidence: {
        driverVersion: record.evidence.driverVersion,
        gpuName: record.evidence.gpuName,
        hags: record.evidence.hags,
        gpuPowerLimitW: record.evidence.gpuPowerLimitW,
        gpuPowerDefaultLimitW: record.evidence.gpuPowerDefaultLimitW,
        gpuPowerDrawW: record.evidence.gpuPowerDrawW,
        sources: record.evidence.sources
      }
    })),
    report: {
      title: "Quiet Incident Learning Report",
      summary: lines[0],
      lines,
      recommendations: [
        "Compare future clean sessions before treating any mitigation as proven.",
        "Keep raw dumps and event details in audit/export; the learner stores only normalized evidence.",
        "Learning may adjust caution, dwell, recommendations, and prevention notes only; it must not edit drivers, BIOS, firmware, voltage, fans, or security tools."
      ]
    }
  };
}
