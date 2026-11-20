export const HARDWARE_PROFILE_SCHEMA = "pc-control-plane-hardware-profile/v1";
export const EXPECTED_HARDWARE_PROFILE = Object.freeze({
  schema: HARDWARE_PROFILE_SCHEMA, updatedAt: null, authority: "read-only-profile",
  host: { label: "Local computer", platform: "Windows", verification: "Not configured" },
  cpu: {}, motherboard: {}, memory: {}, gpu: {}, psu: {}, firmware: {},
  rules: ["Hardware identity must come from local observations, not a published host profile."]
});

export function summarizeHardwareProfile(telemetry = {}) {
  const system = telemetry.system || {};
  const gpu = telemetry.gpu || {};
  return {
    schema: HARDWARE_PROFILE_SCHEMA, updatedAt: null, authority: "read-only-profile",
    status: "unconfigured",
    summary: "No expected hardware profile is bundled. Observed values are not verified inventory.",
    expected: structuredClone(EXPECTED_HARDWARE_PROFILE),
    observed: {
      cpuName: system.cpuName ?? null, logicalProcessors: system.logicalProcessors ?? null,
      ramTotalGB: system.ramTotalGB ?? null, gpuName: gpu.name ?? null,
      gpuMemoryMB: gpu.memoryTotalMB ?? null
    },
    checks: [],
    counts: { matches: 0, mismatches: 0, unavailable: 0 },
    rules: [...EXPECTED_HARDWARE_PROFILE.rules]
  };
}
