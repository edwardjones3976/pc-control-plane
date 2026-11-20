import fs from "node:fs/promises";
import path from "node:path";
import { adapterVersionMap } from "./adapters.js";
import { dataDir, snapshotsDir } from "./config.js";

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "");
}

export async function createSnapshot({ reason, correlationId, state, telemetry, plan }) {
  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const snapshot = {
    schema: "pc-control-plane-snapshot/v2",
    id: `${safeStamp()}-${String(correlationId || "manual").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    createdAt: new Date().toISOString(),
    reason,
    correlationId,
    adapterVersions: adapterVersionMap(),
    state,
    power: telemetry?.power || null,
    activeWorkload: telemetry?.priorityApp || null,
    foreground: telemetry?.foreground || null,
    activeProcesses: (telemetry?.processes || []).slice(0, 80),
    planSummary: plan
      ? {
          targetMode: plan.targetMode,
          risk: plan.risk,
          actionIds: (plan.plannedActions || []).map((action) => action.id)
        }
      : null
  };
  const filePath = path.join(snapshotsDir, `${snapshot.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return {
    ...snapshot,
    filePath
  };
}

export async function listSnapshots(limit = 20) {
  try {
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

export function validateSnapshotCompatibility(snapshot, currentVersions = adapterVersionMap()) {
  const errors = [];
  const snapshotVersions = snapshot?.adapterVersions || {};
  for (const [adapterId, version] of Object.entries(snapshotVersions)) {
    if (currentVersions[adapterId] && currentVersions[adapterId] !== version) {
      errors.push(`${adapterId} snapshot version ${version} does not match current ${currentVersions[adapterId]}.`);
    }
  }
  return {
    ok: errors.length === 0,
    errors
  };
}
