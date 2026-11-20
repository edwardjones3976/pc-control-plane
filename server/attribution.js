
export const ATTRIBUTION_TUNING = Object.freeze({
  leakPrivateMB: 3000,     // a single process committing at least this much...
  leakRatio: 4,            // ...with committed >= ratio x resident => leak-like
  duplicateCount: 3,       // this many instances of one app...
  duplicateEachMB: 1000,   // ...each committing at least this much => runaway dups
  topN: 6
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function attributeResourcePressure({ processes = [], isProtected = () => false, tuning = {} } = {}) {
  const t = { ...ATTRIBUTION_TUNING, ...tuning };
  const procs = (Array.isArray(processes) ? processes : []).map((p) => ({
    name: String(p?.name || p?.process || "unknown"),
    pid: p?.pid ?? null,
    path: p?.path || null,
    privateMB: Math.max(0, Math.round(num(p?.privateMB))),
    workingSetMB: Math.max(0, Math.round(num(p?.workingSetMB))),
    cpuPct: Math.max(0, num(p?.cpuPct)),
    protectedApp: Boolean(isProtected(p?.name))
  }));

  const byPrivate = [...procs].sort((a, b) => b.privateMB - a.privateMB).slice(0, t.topN);
  const byCpu = [...procs].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, t.topN);

  const suspects = [];

  const groups = new Map();
  for (const p of procs) {
    const key = `${p.name.toLowerCase()}|${(p.path || "").toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const list of groups.values()) {
    const heavy = list.filter((p) => p.privateMB >= t.duplicateEachMB);
    if (heavy.length >= t.duplicateCount) {
      const totalMB = heavy.reduce((s, p) => s + p.privateMB, 0);
      const anyProtected = heavy.some((p) => p.protectedApp);
      suspects.push({
        kind: "duplicate-runaway",
        name: heavy[0].name,
        count: heavy.length,
        committedMB: totalMB,
        protectedApp: anyProtected,
        pids: heavy.map((p) => p.pid).filter((x) => x != null),
        explain: `${heavy.length} copies of "${heavy[0].name}" are each holding ~${Math.round(totalMB / heavy.length)} MB (~${totalMB} MB total) — duplicated or stuck runs.`,
        advice: anyProtected
          ? "These are protected/agentic tools; review them yourself — the control plane will not stop them."
          : "If these are stuck/duplicate runs, stopping the extra copies frees the memory. A memory trim cannot reclaim it."
      });
    }
  }

  const duplicateNames = new Set(suspects.map((s) => s.name.toLowerCase()));

  for (const p of byPrivate) {
    if (duplicateNames.has(p.name.toLowerCase())) continue;
    if (p.privateMB >= t.leakPrivateMB && p.workingSetMB > 0 && p.privateMB >= p.workingSetMB * t.leakRatio) {
      suspects.push({
        kind: "leak-like",
        name: p.name,
        count: 1,
        committedMB: p.privateMB,
        protectedApp: p.protectedApp,
        pids: p.pid != null ? [p.pid] : [],
        explain: `"${p.name}" has committed ~${p.privateMB} MB but only ~${p.workingSetMB} MB is resident — committed/leaked memory a trim cannot reclaim.`,
        advice: p.protectedApp
          ? "Protected/agentic tool; review it yourself — the control plane will not stop it."
          : "Restarting this process is the only way to reclaim this memory; a trim will not help."
      });
    }
  }

  suspects.sort((a, b) => b.committedMB - a.committedMB);
  const culprit = suspects[0] || null;

  return {
    topMemory: byPrivate.map((p) => ({ name: p.name, pid: p.pid, privateMB: p.privateMB, workingSetMB: p.workingSetMB, protectedApp: p.protectedApp })),
    topCpu: byCpu.filter((p) => p.cpuPct > 0).map((p) => ({ name: p.name, pid: p.pid, cpuPct: Math.round(p.cpuPct * 10) / 10, protectedApp: p.protectedApp })),
    suspects,
    culprit,
    summary: culprit
      ? `Likely memory cause: ${culprit.name} (${culprit.kind === "duplicate-runaway" ? culprit.count + " copies" : "leak-like"}, ~${culprit.committedMB} MB).`
      : "No standout memory culprit; usage looks distributed and healthy."
  };
}
