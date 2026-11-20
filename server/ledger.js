import crypto from "node:crypto";
import fs from "node:fs/promises";
import { dataDir, ledgerPath } from "./config.js";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function checksumRecord(record) {
  const clone = { ...record };
  delete clone.checksum;
  return crypto.createHash("sha256").update(stableStringify(clone)).digest("hex");
}

export async function appendLedgerEvent(entry) {
  await fs.mkdir(dataDir, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    schema: "pc-control-plane-ledger/v2",
    status: "recorded",
    ...entry
  };
  record.checksum = checksumRecord(record);
  await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function readLedger(limit = 120) {
  try {
    const raw = await fs.readFile(ledgerPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          const record = JSON.parse(line);
          return {
            ...record,
            checksumValid: record.checksum === checksumRecord(record)
          };
        } catch {
          return {
            ts: null,
            action: "ledger.parse-error",
            status: "invalid",
            checksumValid: false,
            raw: line
          };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

export function findIncompleteChains(records = []) {
  const byCorrelation = new Map();
  for (const record of records.slice().reverse()) {
    if (!record.correlationId) continue;
    if (!byCorrelation.has(record.correlationId)) {
      byCorrelation.set(record.correlationId, []);
    }
    byCorrelation.get(record.correlationId).push(record);
  }

  const incomplete = [];
  for (const [correlationId, chain] of byCorrelation.entries()) {
    const statuses = new Set(chain.map((entry) => entry.status));
    const hasStart = chain.some(
      (entry) => entry.status === "started" && entry.details?.snapshot
    );
    const hasEnd = statuses.has("completed") || statuses.has("failed") || statuses.has("restored") || statuses.has("refused");
    if (hasStart && !hasEnd) {
      incomplete.push({
        correlationId,
        startedAt: chain[0]?.ts || null,
        lastEvent: chain[chain.length - 1] || null,
        count: chain.length
      });
    }
  }
  return incomplete;
}
