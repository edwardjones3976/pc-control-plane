import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EXPECTED_HARDWARE_PROFILE, summarizeHardwareProfile } from "../server/hardware-profile.js";
import { summarizeExternalPerformanceKnowledge } from "../server/external-performance-knowledge.js";

const root = fileURLToPath(new URL("../", import.meta.url));

test("published profiles contain no installed hardware or historical measurements", () => {
  assert.deepEqual(EXPECTED_HARDWARE_PROFILE.cpu, {});
  assert.deepEqual(EXPECTED_HARDWARE_PROFILE.psu, {});
  assert.equal(EXPECTED_HARDWARE_PROFILE.updatedAt, null);
  const hardware = summarizeHardwareProfile({ system: { cpuName: "Synthetic CPU" } });
  assert.equal(hardware.status, "unconfigured");
  assert.equal(hardware.observed.cpuName, "Synthetic CPU");
  assert.deepEqual(hardware.checks, []);
  const knowledge = summarizeExternalPerformanceKnowledge();
  assert.deepEqual(knowledge.active, {});
  assert.deepEqual(knowledge.historical, {});
});

test("public engine entry refuses startup without launching Windows operations", () => {
  const result = spawnSync(process.execPath, ["server/index.js"], {
    cwd: root, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Source preview only/);
});

test("source directories exclude binaries, secret files and suspended standalone adapters", async () => {
  const deny = /\.(?:exe|dll|msi|pfx|p12|pem|key|ps1|psm1|zip|dmp|etl|jsonl)$/i;
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, file);
      assert.equal(deny.test(entry.name), false, file);
      assert.equal(entry.name.startsWith(".env"), false, file);
      if (entry.isDirectory()) {
        assert.equal(["bin", "obj", "node_modules"].includes(entry.name), false, file);
        await inspect(file);
      } else {
        const text = await fs.readFile(file, "utf8");
        assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
        assert.doesNotMatch(text, /(?:xox[baprs]-|xapp-|ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{16,}/);
        assert.doesNotMatch(text, /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_-]+/);
      }
    }
  }
  for (const folder of ["server", "public", "desktop", "scripts"]) {
    await inspect(path.join(root, folder));
  }
});
