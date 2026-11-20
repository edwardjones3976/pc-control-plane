export const trustLevels = Object.freeze([
  "observe",
  "recommend",
  "auto-safe",
  "session",
  "elevated",
  "manual-only"
]);

export const adapterManifests = Object.freeze([
  {
    id: "state-store",
    label: "Control Plane State",
    version: "2.0.0",
    reads: ["data/state.json"],
    mutations: ["data/state.json"],
    adminRequired: false,
    verification: "Read state file and confirm selected mode/autonomy fields.",
    rollback: "Restore the prior state snapshot.",
    trustLevel: "auto-safe"
  },
  {
    id: "learning-apps",
    label: "Learned App Reputation",
    version: "1.0.0",
    reads: ["data/learning.json", "session outcomes", "process reputation evidence"],
    mutations: ["data/learning.json app reputation decisions"],
    adminRequired: false,
    verification: "Read learning summary and confirm app decision state, TTL, and evidence.",
    rollback: "Clear or demote the learned app decision from data/learning.json.",
    trustLevel: "recommend"
  },
  {
    id: "power-plan",
    label: "Windows Power Plan",
    version: "2.0.0",
    reads: ["powercfg /getactivescheme", "powercfg /list"],
    mutations: ["powercfg /setactive"],
    adminRequired: false,
    verification: "Read the active scheme and match the requested plan name.",
    rollback: "Restore the previously active plan from the snapshot.",
    trustLevel: "auto-safe"
  },
  {
    id: "session-config",
    label: "Competitive Gaming Session Prep",
    version: "2.0.0",
    reads: ["power state", "foreground process state", "GPU telemetry"],
    mutations: ["session-scoped power/profile settings"],
    adminRequired: false,
    verification: "Read power, foreground, and GPU telemetry after prep.",
    rollback: "Restore the previous mode and power state from snapshot metadata.",
    trustLevel: "session"
  },
  {
    id: "health-session",
    label: "Competitive Gaming Session Guard",
    version: "2.0.0",
    reads: ["process list", "foreground state", "session state file"],
    mutations: ["power plan", "session state"],
    adminRequired: false,
    verification: "Confirm session state and restore path are written.",
    rollback: "Restore the prior power plan and session state.",
    trustLevel: "session"
  },
  {
    id: "process-control",
    label: "Process Control",
    version: "2.0.0",
    reads: ["Get-Process", "Win32_Process command lines"],
    mutations: ["manual priority change", "manual close request"],
    adminRequired: false,
    verification: "Re-read process table and confirm action result.",
    rollback: "Restore the prior process priority when a manual priority change was applied.",
    trustLevel: "session"
  },
  {
    id: "event-log",
    label: "Windows Event Log",
    version: "2.0.0",
    reads: ["Get-WinEvent System", "Get-WinEvent Application"],
    mutations: [],
    adminRequired: false,
    verification: "Read-only diagnostic adapter.",
    rollback: "No rollback needed for read-only adapter.",
    trustLevel: "observe"
  },
  {
    id: "diagnostic-traps",
    label: "Reversible Diagnostic Traps",
    version: "2.0.0",
    reads: ["HKCU WER LocalDumps", "System/Application Event Log baselines", "nvidia-smi"],
    mutations: ["HKCU WER LocalDumps for selected foreground executables", "data/diagnostic-traps.json"],
    adminRequired: false,
    verification: "Read HKCU WER LocalDumps and diagnostic-traps state after arm/disarm.",
    rollback: "Restore prior HKCU WER LocalDumps values or remove keys created by the trap.",
    trustLevel: "session"
  },
  {
    id: "nvidia-telemetry",
    label: "NVIDIA Telemetry",
    version: "2.0.0",
    reads: ["nvidia-smi"],
    mutations: [],
    adminRequired: false,
    verification: "Read-only GPU telemetry adapter.",
    rollback: "No rollback needed for read-only adapter.",
    trustLevel: "observe"
  },
  {
    id: "input-profile",
    label: "Input Profile",
    version: "2.0.0",
    reads: ["mouse registry", "keyboard registry", "USB power settings"],
    mutations: ["mouse registry", "keyboard registry", "USB power settings"],
    adminRequired: false,
    verification: "Read registry and power setting values back after the profile script.",
    rollback: "Restore registry exports and power settings from snapshot.",
    trustLevel: "elevated"
  },
  {
    id: "network-profile",
    label: "Network Profile",
    version: "2.0.0",
    reads: ["adapter state", "DNS state", "latency/packet-loss probes", "service reachability", "VPN state", "route/interface metrics", "connection-heavy apps"],
    mutations: ["adapter settings", "DNS settings", "interface metrics", "confirmed adapter reset"],
    adminRequired: true,
    verification: "Read adapter state and connectivity probes after the profile script.",
    rollback: "Restore adapter/DNS metrics from snapshot where available.",
    trustLevel: "elevated"
  },
  {
    id: "elevated-scripts",
    label: "Elevated Scripts",
    version: "2.0.0",
    reads: ["script manifests", "current Windows state"],
    mutations: ["HKLM", "system-wide device and graphics settings"],
    adminRequired: true,
    verification: "Script-specific readback is required before success.",
    rollback: "Script-specific rollback or refusal when no compatible snapshot exists.",
    trustLevel: "manual-only"
  }
]);

export function getAdapterManifest(adapterId) {
  return adapterManifests.find((adapter) => adapter.id === adapterId) || null;
}

export function validateAdapterManifests(manifests = adapterManifests) {
  const errors = [];
  const ids = new Set();
  for (const manifest of manifests) {
    if (!manifest.id) errors.push("Adapter missing id.");
    if (manifest.id && ids.has(manifest.id)) errors.push(`Duplicate adapter id: ${manifest.id}`);
    ids.add(manifest.id);
    if (!manifest.version) errors.push(`${manifest.id} missing version.`);
    if (!Array.isArray(manifest.reads)) errors.push(`${manifest.id} reads must be an array.`);
    if (!Array.isArray(manifest.mutations)) errors.push(`${manifest.id} mutations must be an array.`);
    if (!trustLevels.includes(manifest.trustLevel)) {
      errors.push(`${manifest.id} has unsupported trust level ${manifest.trustLevel}.`);
    }
    if (manifest.mutations?.length && (!manifest.rollback || /^none$/i.test(manifest.rollback))) {
      errors.push(`${manifest.id} mutates state but has no rollback contract.`);
    }
    if (manifest.adminRequired && !["elevated", "manual-only"].includes(manifest.trustLevel)) {
      errors.push(`${manifest.id} requires admin but is not elevated/manual-only.`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    manifests
  };
}

export function adapterVersionMap(manifests = adapterManifests) {
  return Object.fromEntries(manifests.map((manifest) => [manifest.id, manifest.version]));
}

export function automationAllowed(manifest, autonomy = "manual-first") {
  if (!manifest) return false;
  if (manifest.trustLevel === "observe" || manifest.trustLevel === "recommend") return true;
  if (manifest.trustLevel === "auto-safe") return ["auto-safe", "manual-first", "advisory"].includes(autonomy);
  if (manifest.trustLevel === "session") return autonomy === "auto-safe";
  return false;
}
