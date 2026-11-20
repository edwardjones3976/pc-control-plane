
export function parseWingetUpgrades(text) {
  const lines = String(text || "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /\bName\b/.test(l) && /\bId\b/.test(l) && /\bAvailable\b/.test(l));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx];
  const cName = header.indexOf("Name");
  const cId = header.indexOf("Id");
  const cVer = header.indexOf("Version");
  const cAvail = header.indexOf("Available");
  const cSrc = header.indexOf("Source");
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^[-\s]+$/.test(line)) continue; // separator row
    if (/upgrades?\s+available/i.test(line)) break; // footer count
    if (/package\(s\)\s+have/i.test(line)) break;
    const slice = (a, b) => (a >= 0 ? line.slice(a, b >= 0 ? b : undefined).trim() : "");
    const name = slice(cName, cId);
    const id = slice(cId, cVer);
    const current = slice(cVer, cAvail);
    const available = slice(cAvail, cSrc);
    if (name && id && available && available !== "Available") {
      out.push({ name, id, current, available });
    }
  }
  return out;
}

export function summarizeUpdates(wingetUpdates = [], { wingetOk = true } = {}) {
  const list = Array.isArray(wingetUpdates) ? wingetUpdates : [];
  return {
    count: list.length,
    updates: list.slice(0, 50),
    wingetOk,
    recommendation: list.length
      ? `${list.length} app update(s) available. Review and apply with "winget upgrade --all" or per app. The control plane will not install them for you.`
      : "No app updates detected via winget.",
    note: "For Windows and driver updates, open Settings -> Windows Update. The control plane never installs updates silently or autonomously."
  };
}
