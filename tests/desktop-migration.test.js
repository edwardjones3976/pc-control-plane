import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { normalizeRuntimeState } from "../server/system.js";

function run(script, ...args) {
  return spawnSync(process.execPath, [
    fileURLToPath(new URL(`../scripts/${script}-desktop-migration.mjs`, import.meta.url)), ...args
  ], { encoding: "utf8", timeout: 5000 });
}

test("migration verifies the snapshot and never replaces an existing target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const original = { enabled: true, override: "dark", day: "07:00", evening: "20:00", strength: 500 };
  await fs.writeFile(path.join(source, "desktop-comfort.json"), JSON.stringify(original));
  await fs.writeFile(path.join(source, "server.lock.json"), '{}');
  const prepared = run("prepare", source, root);
  assert.equal(prepared.status, 0, prepared.stderr);
  const snapshot = prepared.stdout.trim();
  const target = path.join(root, "target");
  assert.deepEqual((await fs.readdir(snapshot)).sort(), ["desktop-comfort.json", "manifest.json"]);
  const imported = run("import", snapshot, target);
  assert.equal(imported.status, 0, imported.stderr);
  const readComfort = async dir => JSON.parse(await fs.readFile(path.join(dir, "desktop-comfort.json"), "utf8"));
  assert.deepEqual(await readComfort(target), { ...original, enabled: false, override: null });
  assert.deepEqual(await readComfort(source), original);
  assert.deepEqual(await readComfort(snapshot), original);
  await assert.rejects(fs.stat(path.join(target, "state.json")), { code: "ENOENT" });
  assert.match(run("import", snapshot, target).stderr, /EEXIST/);
  await fs.writeFile(path.join(snapshot, "desktop-comfort.json"), "{}");
  const rejected = path.join(root, "rejected");
  assert.match(run("import", snapshot, rejected).stderr, /Snapshot verification failed/);
  await assert.rejects(fs.stat(rejected), { code: "ENOENT" });
});

test("migration preserves automation preferences but does not resume previous actions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-opt-out-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const settings = {
    modeId: "overdrive", overdriveArmedAt: "2026-01-01T00:00:00Z", lastAppliedAt: "2026-01-01T00:00:00Z",
    learningInfluence: false, automations: { mlExecution: false, cooldownSeconds: "120", profileOnLaunch: "overdrive" }
  };
  const records = {
    "state.json": settings,
    "efficacy.json": { actions: { "power.adaptive-tier": { runs: 1, helped: 1 } } },
    "ml-decisions.json": { pending: [{ id: "pending" }], verified: [{ id: "verified" }] },
    "recovery.json": { pending: true }
  };
  const read = async (dir, file) => JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
  await fs.mkdir(source);
  for (const [file, value] of Object.entries(records)) {
    await fs.writeFile(path.join(source, file), JSON.stringify(value));
  }
  const prepared = run("prepare", source, root);
  assert.equal(prepared.status, 0, prepared.stderr);
  const snapshot = prepared.stdout.trim();
  const imported = run("import", snapshot, target);
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(await fs.readdir(target), ["state.json"]);
  const projected = await read(target, "state.json");
  assert.deepEqual(projected, { learningInfluence: false, automations: { mlExecution: false, cooldownSeconds: 120 } });
  const runtime = normalizeRuntimeState(projected);
  assert.equal(runtime.modeId, "balanced");
  assert.equal(runtime.learningInfluence, false);
  assert.equal(runtime.automations.mlExecution, false);
  assert.equal(runtime.automations.cooldownSeconds, 120);
  assert.equal(runtime.overdriveArmedAt, null);
  assert.equal(runtime.lastAppliedAt, null);
  for (const [file, value] of Object.entries(records)) {
    assert.deepEqual(await read(source, file), value);
    if (file !== "recovery.json") assert.deepEqual(await read(snapshot, file), value);
  }
  await assert.rejects(fs.stat(path.join(snapshot, "recovery.json")), { code: "ENOENT" });
  await fs.writeFile(path.join(snapshot, "ml-decisions.json"), "{}");
  const rejected = path.join(root, "rejected");
  assert.match(run("import", snapshot, rejected).stderr, /Snapshot verification failed: ml-decisions.json/);
  await assert.rejects(fs.stat(rejected), { code: "ENOENT" });
});

test("migration refuses malformed explicit automation preferences before creating a target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.mkdir(source);
  for (const [saved, message] of [
    [{ learningInfluence: "false" }, /Invalid saved automation preferences/],
    [{ automations: null }, /Invalid saved automation preferences/],
    [{ automations: { mlExecution: "false" } }, /Invalid saved ML execution preference/],
    [{ automations: { cooldownSeconds: 3601 } }, /Invalid saved automation cooldown/]
  ]) {
    await fs.writeFile(path.join(source, "state.json"), JSON.stringify(saved));
    const prepared = run("prepare", source, root);
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = run("import", prepared.stdout.trim(), target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  }
});

test("a history-only backup cannot create an empty imported state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-history-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "efficacy.json"), "{}");
  const prepared = run("prepare", source, root);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(run("import", prepared.stdout.trim(), target).stderr, /history for backup only/);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});

test("a correctly hashed recovery record cannot be imported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-refusal-"));
  const source = path.join(root, "snapshot");
  const target = path.join(root, "target");
  await fs.mkdir(source);
  const name = "recovery.json";
  const contents = "{}";
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const manifest = path.join(source, "manifest.json");
  const record = path.join(source, name);
  try {
    await fs.writeFile(record, contents);
    await fs.writeFile(manifest, JSON.stringify({ version: 1, files: [{ name, sha256 }] }));
    const result = run("import", source, target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid migration manifest entry/);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally {
    await fs.rm(record, { force: true });
    await fs.rm(manifest, { force: true });
    await fs.rmdir(source);
    await fs.rmdir(root);
  }
});
