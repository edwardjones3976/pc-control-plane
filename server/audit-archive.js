import fs from "node:fs/promises";
import path from "node:path";
import {
  auditArchiveRoot,
  auditDisplayDays,
  auditPath,
  auditStatusLimit
} from "./config.js";

export const AUDIT_RETENTION_MS = auditDisplayDays * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = Number(process.env.PC_CONTROL_AUDIT_ARCHIVE_INTERVAL_MS || 10 * 60 * 1000);
const AUDIT_TAIL_READ_BYTES = Number(process.env.PC_CONTROL_AUDIT_TAIL_READ_BYTES || 8 * 1024 * 1024);

let lastMaintenanceAt = 0;
let lastArchiveStatus = {
  ok: true,
  archiveRoot: auditArchiveRoot,
  retentionDays: auditDisplayDays,
  archivedCount: 0,
  keptCount: 0,
  skipped: true,
  reason: "Archive maintenance has not run yet.",
  at: null
};
let maintenanceInFlight = null;
const auditWrites = new Map();

function serializeAuditWrite(file, operation) {
  const resolved = path.resolve(file);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const pending = (auditWrites.get(key) || Promise.resolve()).then(operation);
  const tail = pending.catch(() => {});
  auditWrites.set(key, tail);
  return pending.finally(() => {
    if (auditWrites.get(key) === tail) auditWrites.delete(key);
  });
}

export function appendAuditRecords(records, sourcePath = auditPath) {
  const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  return serializeAuditWrite(sourcePath, () => fs.appendFile(sourcePath, text, "utf8"));
}

export async function drainAuditWrites() {
  await maintenanceInFlight;
  await Promise.all(auditWrites.values());
}

function parseAuditLine(line) {
  if (!line || String(line).includes("\u0000")) {
    return null;
  }
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

function auditTimestampMs(record) {
  const ts = Date.parse(record?.ts || "");
  return Number.isFinite(ts) ? ts : null;
}

function dayArchivePath(root, record) {
  const date = new Date(auditTimestampMs(record));
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return path.join(root, yyyy, mm, `audit-${yyyy}-${mm}-${dd}.jsonl`);
}

async function appendUniqueLines(filePath, lines) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing = new Set();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    existing = new Set(raw.split(/\r?\n/).filter(Boolean));
  } catch {
    existing = new Set();
  }
  const fresh = lines.filter((line) => !existing.has(line));
  if (fresh.length) {
    await fs.appendFile(filePath, `${fresh.join("\n")}\n`, "utf8");
  }
  return fresh.length;
}

function corruptArchivePath(root, now) {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return path.join(root, "_corrupt", `audit-corrupt-${yyyy}-${mm}-${dd}.log`);
}

export async function archiveOldAuditRecords({
  sourcePath = auditPath,
  archiveRoot = auditArchiveRoot,
  now = new Date(),
  retentionMs = AUDIT_RETENTION_MS
} = {}) {
  const cutoffMs = now.getTime() - retentionMs;
  const statusBase = {
    archiveRoot,
    retentionDays: Math.round(retentionMs / (24 * 60 * 60 * 1000)),
    cutoff: new Date(cutoffMs).toISOString(),
    at: now.toISOString()
  };

  try {
    if (!archiveRoot) {
      return { ...statusBase, ok: false, skipped: true, reason: "No audit archive root configured." };
    }
    await fs.mkdir(archiveRoot, { recursive: true });
    const raw = await fs.readFile(sourcePath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) {
      return { ...statusBase, ok: true, skipped: true, archivedCount: 0, keptCount: 0, reason: "No audit records to archive." };
    }

    const keepLines = [];
    const corruptLines = [];
    const archiveGroups = new Map();
    for (const line of lines) {
      const record = parseAuditLine(line);
      if (!record) {
        corruptLines.push(line);
        continue;
      }
      const tsMs = auditTimestampMs(record);
      if (tsMs !== null && tsMs < cutoffMs) {
        const filePath = dayArchivePath(archiveRoot, record);
        const group = archiveGroups.get(filePath) || [];
        group.push(line);
        archiveGroups.set(filePath, group);
      } else {
        keepLines.push(line);
      }
    }

    let quarantinedCorruptCount = 0;
    if (corruptLines.length) {
      quarantinedCorruptCount = await appendUniqueLines(corruptArchivePath(archiveRoot, now), corruptLines);
    }

    if (!archiveGroups.size && !corruptLines.length) {
      return {
        ...statusBase,
        ok: true,
        skipped: true,
        archivedCount: 0,
        keptCount: keepLines.length,
        quarantinedCorruptCount: 0,
        reason: "No records older than the local display window."
      };
    }

    const archivedLineSet = new Set(corruptLines);
    let archivedCount = 0;
    for (const [filePath, group] of archiveGroups.entries()) {
      group.forEach((line) => archivedLineSet.add(line));
      archivedCount += await appendUniqueLines(filePath, group);
    }

    const keptCount = await serializeAuditWrite(sourcePath, async () => {
      const latestRaw = await fs.readFile(sourcePath, "utf8");
      const latestKeepLines = latestRaw.split(/\r?\n/).filter((line) => line && !archivedLineSet.has(line));
      const tempPath = `${sourcePath}.tmp`;
      await fs.writeFile(tempPath, latestKeepLines.length ? `${latestKeepLines.join("\n")}\n` : "", "utf8");
      await fs.rename(tempPath, sourcePath);
      return latestKeepLines.length;
    });

    return {
      ...statusBase,
      ok: true,
      skipped: false,
      archivedCount,
      keptCount,
      quarantinedCorruptCount,
      archiveFiles: archiveGroups.size,
      reason: `Archived ${archivedCount} older audit record(s) to G-drive storage${quarantinedCorruptCount ? ` and quarantined ${quarantinedCorruptCount} corrupt row(s)` : ""}.`
    };
  } catch (error) {
    return {
      ...statusBase,
      ok: false,
      skipped: true,
      archivedCount: 0,
      reason: error?.message || String(error)
    };
  }
}

export async function maybeArchiveOldAuditRecords(options = {}) {
  const nowMs = Date.now();
  if (!options.force && nowMs - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) {
    return lastArchiveStatus;
  }
  if (maintenanceInFlight) {
    return maintenanceInFlight;
  }
  lastMaintenanceAt = nowMs;
  maintenanceInFlight = archiveOldAuditRecords(options)
    .then((status) => {
      lastArchiveStatus = status;
      return status;
    })
    .finally(() => {
      maintenanceInFlight = null;
    });
  return maintenanceInFlight;
}

export function getAuditArchiveStatus() {
  return {
    ...lastArchiveStatus,
    archiveRoot: lastArchiveStatus.archiveRoot || auditArchiveRoot,
    retentionDays: lastArchiveStatus.retentionDays || auditDisplayDays
  };
}

async function readAuditSourceWindow(sourcePath, limit) {
  const cappedLimit = Number(limit);
  if (!Number.isFinite(cappedLimit) || cappedLimit <= 0) {
    return fs.readFile(sourcePath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
  }
  const stat = await fs.stat(sourcePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || stat.size <= 0) {
    return "";
  }
  const bytesToRead = Math.min(stat.size, Math.max(64 * 1024, AUDIT_TAIL_READ_BYTES));
  const handle = await fs.open(sourcePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
    let text = buffer.toString("utf8");
    if (bytesToRead < stat.size) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

export async function readAuditWindow({
  sourcePath = auditPath,
  days = auditDisplayDays,
  limit = auditStatusLimit,
  now = new Date()
} = {}) {
  const cutoffMs = days > 0 ? now.getTime() - days * 24 * 60 * 60 * 1000 : null;
  const raw = await readAuditSourceWindow(sourcePath, limit);
  const records = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseAuditLine)
    .filter(Boolean)
    .filter((record) => {
      const tsMs = auditTimestampMs(record);
      return cutoffMs === null || tsMs === null || tsMs >= cutoffMs;
    })
    .reverse();
  const cappedLimit = Number(limit);
  return Number.isFinite(cappedLimit) && cappedLimit > 0
    ? records.slice(0, cappedLimit)
    : records;
}
