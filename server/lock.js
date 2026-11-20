import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lockPath } from "./config.js";

const ownedLocks = new Map();

function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    return error.code === "ESRCH" ? "exited" : "unknown";
  }
}

async function readLock(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Invalid ownership record");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function withOwnershipGuard(file, operation) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const guard = `${file}.claim`;
  try {
    await fs.mkdir(guard);
  } catch (error) {
    if (error.code === "EEXIST") return { ok: false, reason: "claim-pending", message: "Another ownership check is pending. An interrupted check requires inspection; no process was stopped." };
    throw error;
  }
  try { return await operation(); } finally { await fs.rmdir(guard); }
}

export async function acquireSingleInstanceLock({ file = lockPath, probe = processState } = {}) {
  file = path.resolve(file);
  return withOwnershipGuard(file, async () => {
    let existing;
    try { existing = await readLock(file); } catch {
      return { ok: false, reason: "unverified-owner", message: "The ownership record cannot be verified. It was preserved for recovery." };
    }
    if (existing) {
      if (existing.token && existing.token === ownedLocks.get(file)) return { ok: true, lock: existing };
      const state = await probe(existing.pid);
      if (state !== "exited") return { ok: false, existing, reason: state, message: `PC Control Plane ownership belongs to PID ${existing.pid}; state is ${state}. No process was stopped.` };
      await fs.unlink(file);
    }
    const lock = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString(), host: process.env.COMPUTERNAME || null };
    await fs.writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    ownedLocks.set(file, lock.token);
    return { ok: true, lock };
  });
}

export async function releaseSingleInstanceLock({ file = lockPath } = {}) {
  file = path.resolve(file);
  const token = ownedLocks.get(file);
  if (!token) return false;
  const result = await withOwnershipGuard(file, async () => {
    let existing;
    try { existing = await readLock(file); } catch { return false; }
    if (existing?.pid !== process.pid || existing?.token !== token) return false;
    await fs.unlink(file);
    ownedLocks.delete(file);
    return true;
  });
  return result === true;
}

export async function readSingleInstanceLock({ file = lockPath, probe = processState } = {}) {
  try {
    const lock = await readLock(file);
    if (!lock) return null;
    const state = await probe(lock.pid);
    return { ...lock, active: state === "unknown" ? null : state === "running", processState: state };
  } catch {
    return { active: null, processState: "unknown", message: "Ownership record is unreadable; inspection required." };
  }
}
