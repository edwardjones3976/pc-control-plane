export const PERFORMANCE_KNOWLEDGE_SCHEMA = "pc-control-plane-performance-knowledge/v1";
export const VERIFIED_PERFORMANCE_KNOWLEDGE = Object.freeze({
  schema: PERFORMANCE_KNOWLEDGE_SCHEMA, updatedAt: null, authority: "advisory-only",
  hardwareScope: { status: "unconfigured", validatedCpu: null, currentCpu: null },
  boundaries: ["No private measurements, historical diagnoses or host tuning are bundled."]
});

export function summarizeExternalPerformanceKnowledge() {
  return {
    schema: PERFORMANCE_KNOWLEDGE_SCHEMA, updatedAt: null, status: "unconfigured",
    authority: "advisory-only", summary: "No external performance evidence has been imported.",
    active: {}, historical: {},
    revalidation: { required: true, status: "unconfigured", verifyWith: ["Local verified measurements"] },
    rules: [...VERIFIED_PERFORMANCE_KNOWLEDGE.boundaries],
    report: {
      title: "Performance evidence", lines: ["This public snapshot does not include personal diagnostics."],
      nextUse: ["Validate hardware-specific behavior before enabling any control path."]
    }
  };
}
