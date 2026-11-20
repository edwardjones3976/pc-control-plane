import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

export const backupOnly = Object.freeze(["efficacy.json", "ml-decisions.json"]);
export const portable = Object.freeze(["state.json", "desktop-comfort.json", "game-library.json", "learning.json",
  "relief-learning.json", "incident-learning.json", "health-sessions.json",
  "context-sessions.json", "audit.jsonl", "ledger.jsonl"]);
export const snapshotFiles = Object.freeze([...portable, ...backupOnly]);

export async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepare([sourceArg, parentArg, ...extra]) {
if (!sourceArg || !parentArg || extra.length || !path.isAbsolute(sourceArg) || !path.isAbsolute(parentArg))
  throw new Error("Provide an absolute legacy data directory and an existing, separate backup directory.");
const source = await fs.realpath(sourceArg);
const parent = await fs.realpath(parentArg);
const relative = path.relative(source, parent);
if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)))
  throw new Error("The backup directory must not be inside the legacy data directory.");

const snapshot = await fs.mkdtemp(path.join(parent, "pc-control-migration-"));
const files = [];
for (const name of snapshotFiles) {
  const original = path.join(source, name);
  const info = await fs.lstat(original).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) continue;
  if (!info.isFile()) throw new Error(`Not a regular file: ${name}. Snapshot was not finalized.`);
  const before = await digest(original);
  const destination = path.join(snapshot, name);
  await fs.copyFile(original, destination);
  if (await digest(destination) !== before || await digest(original) !== before)
    throw new Error(`Source changed during copy: ${name}. Snapshot was not finalized.`);
  files.push({ name, sha256: before });
}
if (!files.length) throw new Error("No portable data found. Snapshot was not finalized.");
await fs.writeFile(path.join(snapshot, "manifest.json"), JSON.stringify({
  version: 1, createdAt: new Date().toISOString(), files
}, null, 2) + "\n", { flag: "wx" });
return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(await prepare(process.argv.slice(2)));
