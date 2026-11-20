import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { backupOnly, digest, snapshotFiles } from "./prepare-desktop-migration.mjs";

const [snapshotArg, targetArg, ...extra] = process.argv.slice(2);
if (!snapshotArg || !targetArg || extra.length || !path.isAbsolute(snapshotArg) || !path.isAbsolute(targetArg))
  throw new Error("Provide an absolute snapshot directory and a new absolute target directory.");
const snapshot = await fs.realpath(snapshotArg);
const parent = await fs.realpath(path.dirname(path.resolve(targetArg)));
const target = path.join(parent, path.basename(path.resolve(targetArg)));
const manifestPath = path.join(snapshot, "manifest.json");
const info = await fs.lstat(manifestPath);
if (!info.isFile() || info.size > 8192) throw new Error("Invalid migration manifest.");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest?.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
    manifest.files.length > snapshotFiles.length) throw new Error("Invalid migration manifest.");
const seen = new Set();
for (const file of manifest.files) {
  if (!file || !snapshotFiles.includes(file.name) || seen.has(file.name) ||
      typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))
    throw new Error("Invalid migration manifest entry.");
  seen.add(file.name);
  const source = path.join(snapshot, file.name);
  if (!(await fs.lstat(source)).isFile() || await digest(source) !== file.sha256)
    throw new Error(`Snapshot verification failed: ${file.name}`);
}
const entries = await fs.readdir(snapshot);
if (entries.length !== seen.size + 1 || entries.some(name => name !== "manifest.json" && !seen.has(name)))
  throw new Error("Snapshot contains unexpected files.");
if (manifest.files.every(file => backupOnly.includes(file.name)))
  throw new Error("Snapshot contains history for backup only, not importable settings or records.");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectState(saved) {
  const automations = saved.automations;
  if ((Object.hasOwn(saved, "learningInfluence") && typeof saved.learningInfluence !== "boolean") ||
      (Object.hasOwn(saved, "automations") && !isObject(automations)))
    throw new Error("Invalid saved automation preferences.");
  const settings = {};
  if (Object.hasOwn(saved, "learningInfluence")) settings.learningInfluence = saved.learningInfluence;
  const selected = {};
  if (automations && Object.hasOwn(automations, "mlExecution")) {
    if (typeof automations.mlExecution !== "boolean") throw new Error("Invalid saved ML execution preference.");
    selected.mlExecution = automations.mlExecution;
  }
  if (automations && Object.hasOwn(automations, "cooldownSeconds")) {
    const value = automations.cooldownSeconds;
    const cooldown = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(cooldown) || cooldown < 10 || cooldown > 3600)
      throw new Error("Invalid saved automation cooldown.");
    selected.cooldownSeconds = cooldown;
  }
  if (Object.keys(selected).length) settings.automations = selected;
  return settings;
}

const projected = new Map();
for (const file of manifest.files) {
  if (file.name !== "desktop-comfort.json" && file.name !== "state.json") continue;
  const bytes = await fs.readFile(path.join(snapshot, file.name));
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error(`Preferences changed during verification: ${file.name}`);
  const saved = JSON.parse(bytes.toString("utf8"));
  if (!isObject(saved)) throw new Error(`Invalid preferences: ${file.name}`);
  projected.set(file.name, file.name === "state.json"
    ? projectState(saved) : { ...saved, enabled: false, override: null });
}

await fs.mkdir(target);
const copied = [];
try {
  for (const file of manifest.files) {
    if (backupOnly.includes(file.name)) continue;
    const destination = path.join(target, file.name);
    await fs.copyFile(path.join(snapshot, file.name), destination, constants.COPYFILE_EXCL);
    copied.push(destination);
    if (await digest(destination) !== file.sha256) throw new Error(`Import verification failed: ${file.name}`);
    if (projected.has(file.name))
      await fs.writeFile(destination, JSON.stringify(projected.get(file.name), null, 2) + "\n");
  }
} catch (error) {
  for (const file of copied) await fs.unlink(file);
  await fs.rmdir(target);
  throw error;
}
console.log(target);
