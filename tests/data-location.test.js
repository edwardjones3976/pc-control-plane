import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const config = new URL("../server/config.js", import.meta.url).href;
const names = ["dataDir", "statePath", "auditPath", "ledgerPath", "lockPath",
  "plansDir", "snapshotsDir", "recoveryPath", "auditArchiveRoot", "archiveRoot"];
function readConfig(overrides = {}) {
  const env = { ...process.env, PC_CONTROL_DATA_DIR: "", PC_CONTROL_OWNERSHIP_DIR: "", PC_CONTROL_ARCHIVE_DIR: "",
    PC_CONTROL_AUDIT_ARCHIVE_DIR: "", ...overrides };
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    `import * as config from ${JSON.stringify(config)}; console.log(JSON.stringify(${JSON.stringify(names)}.map(key => config[key])));`],
  { env, encoding: "utf8" });
}

test("installed data root owns engine state, ownership and both default archives", () => {
  const root = path.join(os.tmpdir(), "pc-control-data-fixture");
  const result = readConfig({ PC_CONTROL_DATA_DIR: root });
  assert.equal(result.status, 0, result.stderr);
  const [data, ...files] = JSON.parse(result.stdout);
  assert.equal(data, root);
  assert.deepEqual(files.map(file => path.relative(root, file)), ["state.json", "audit.jsonl",
    "ledger.jsonl", "server.lock.json", "plans", "snapshots", "recovery.json", "audit-archive", "learning-archive"]);
});

test("legacy storage defaults and explicit archive overrides remain intact", () => {
  const legacy = readConfig();
  assert.equal(legacy.status, 0, legacy.stderr);
  const [data] = JSON.parse(legacy.stdout);
  assert.equal(path.basename(data), "data");
  const audit = path.join(os.tmpdir(), "pc-control-audit-fixture");
  const learning = path.join(os.tmpdir(), "pc-control-learn-fixture");
  const configured = readConfig({ PC_CONTROL_DATA_DIR: data, PC_CONTROL_AUDIT_ARCHIVE_DIR: audit, PC_CONTROL_ARCHIVE_DIR: learning });
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout).slice(-2), [audit, learning]);
});

test("invalid data roots fail before engine startup", () => {
  for (const value of ["relative/data", ...(process.platform === "win32" ? ["\\relative", "\\\\host\\share"] : [])]) {
    const result = readConfig({ PC_CONTROL_DATA_DIR: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be an absolute local path/);
  }
});

test("desktop state command distinguishes saved, missing and unreadable data without taking ownership", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-control-read-"));
  const state = path.join(root, "state.json");
  t.after(async () => {
    await fs.unlink(state);
    await fs.rmdir(root);
  });
  const entry = fileURLToPath(new URL("../server/index.js", import.meta.url));
  const read = (...args) => spawnSync(process.execPath, [entry, "--read-engine-state", ...args], {
    env: { ...process.env, PC_CONTROL_DATA_DIR: root, PC_CONTROL_OWNERSHIP_DIR: root },
    encoding: "utf8",
    timeout: 5000
  });
  const expect = (status, modeId = null) => {
    const result = read();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { schema: "pc-control-plane-saved-state/v1", status, modeId });
  };
  expect("missing");
  assert.equal(read("--check").status, 2);
  assert.deepEqual(await fs.readdir(root), []);
  await fs.writeFile(state, "{");
  expect("unavailable");
  await fs.writeFile(state, '{"modeId":"competitive","privateField":"not exported"}');
  expect("saved", "competitive");
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
  assert.equal(await fs.readFile(state, "utf8"), '{"modeId":"competitive","privateField":"not exported"}');
});

test("managed read-only engine answers health, refuses writes and drains on EOF", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-managed-readonly-"));
  const entry = fileURLToPath(new URL("../server/index.js", import.meta.url));
  const deadline = AbortSignal.timeout(10000);
  const key = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [entry, "--managed-read-only"], {
    env: { ...process.env, PC_CONTROL_HOST: "127.0.0.1", PC_CONTROL_PORT: "0",
      PC_CONTROL_DATA_DIR: root, PC_CONTROL_OWNERSHIP_DIR: root, PC_CONTROL_PROBE_KEY: key },
    stdio: ["pipe", "pipe", "inherit"], signal: deadline
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  child.on("error", () => {});
  try {
    let output = "";
    let origin;
    for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
      output += chunk;
      if (!output.includes("\n")) continue;
      const { schema, pid, port } = JSON.parse(output.split("\n")[0]);
      assert.equal(schema, "pc-control-plane-ready/v1");
      assert.equal(pid, child.pid);
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      origin = `http://127.0.0.1:${port}`;
      break;
    }
    assert.ok(origin, output);
    for (const headers of [{}, { "x-pc-probe-key": randomBytes(32).toString("hex") }]) {
      const denied = await fetch(origin + "/api/health", { headers, signal: deadline });
      assert.equal(denied.status, 401);
      assert.equal((await denied.json()).observer, undefined);
    }
    const health = await fetch(origin + "/api/health", { headers: { "x-pc-probe-key": key }, signal: deadline });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { pid: child.pid, mode: "read-only", observer: { running: false } });
    for (const route of ["/", "/comfort", "/lab", "/app.js", "/api/status"]) {
      const response = await fetch(origin + route, {
        headers: { "x-pc-probe-key": key }, redirect: "manual", signal: deadline
      });
      assert.equal(response.status, 403, route);
      assert.match((await response.json()).message, /read-only/);
    }
    const refused = await fetch(origin + "/api/mode/apply", {
      method: "POST", headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-pc-probe-key": key },
      body: "{}", signal: deadline
    });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).message, /read-only/);
    assert.ok((await fs.readdir(root)).includes("server.lock.json"));
    child.stdin.end();
    assert.equal(await closed, 0);
    const remaining = await fs.readdir(root);
    assert.ok(!remaining.includes("server.lock.json") && !remaining.includes("state.json"));
  } finally {
    child.stdin.destroy();
    await closed;
    for (const file of await fs.readdir(root)) await fs.unlink(path.join(root, file));
    await fs.rmdir(root);
  }
});

test("managed engine exits and releases its lock when its port is occupied", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-managed-bind-"));
  const listener = net.createServer(socket => socket.end("original listener"));
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  try {
    const port = listener.address().port;
    const entry = fileURLToPath(new URL("../server/index.js", import.meta.url));
    const env = { ...process.env, PC_CONTROL_HOST: "127.0.0.1", PC_CONTROL_PORT: String(port),
      PC_CONTROL_DATA_DIR: root, PC_CONTROL_OWNERSHIP_DIR: root, PC_CONTROL_PROBE_KEY: "" };
    for (const invalidKey of ["", "not-a-valid-key"]) {
      const refused = spawnSync(process.execPath, [entry, "--managed-worker"], {
        env: { ...env, PC_CONTROL_PROBE_KEY: invalidKey }, encoding: "utf8", timeout: 5000
      });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /Managed engine authentication is required/);
      assert.deepEqual(await fs.readdir(root), []);
    }
    for (const variable of ["PC_CONTROL_DATA_DIR", "PC_CONTROL_OWNERSHIP_DIR"]) {
      const refused = spawnSync(process.execPath, [entry, "--managed-worker"], {
        env: { ...env, PC_CONTROL_PROBE_KEY: randomBytes(32).toString("hex"), [variable]: "" },
        encoding: "utf8", timeout: 5000
      });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /requires explicit data and ownership directories/);
      assert.deepEqual(await fs.readdir(root), []);
    }
    for (const overrides of [{ PC_CONTROL_HOST: "0.0.0.0" }, { PC_CONTROL_PORT: "65536" }]) {
      const refused = spawnSync(process.execPath, [entry, "--managed-worker"], {
        env: { ...env, ...overrides, PC_CONTROL_PROBE_KEY: randomBytes(32).toString("hex") },
        encoding: "utf8", timeout: 5000
      });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /requires a valid loopback listener/);
      assert.deepEqual(await fs.readdir(root), []);
    }
    const absent = path.join(root, "not-provisioned");
    for (const variable of ["PC_CONTROL_DATA_DIR", "PC_CONTROL_OWNERSHIP_DIR"]) {
      const refused = spawnSync(process.execPath, [entry, "--managed-worker"], {
        env: { ...env, PC_CONTROL_PROBE_KEY: randomBytes(32).toString("hex"), [variable]: absent },
        encoding: "utf8", timeout: 5000
      });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, new RegExp(variable + " must be an existing directory"));
      assert.deepEqual(await fs.readdir(root), []);
    }
    const link = path.join(root, "redirected");
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "pc-managed-target-"));
    try {
      await fs.mkdir(path.join(target, "child"));
      await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      for (const directory of [link, path.join(link, "child")]) {
        const refused = spawnSync(process.execPath, [entry, "--managed-worker"], {
          env: { ...env, PC_CONTROL_PROBE_KEY: randomBytes(32).toString("hex"), PC_CONTROL_DATA_DIR: directory },
          encoding: "utf8", timeout: 5000
        });
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /PC_CONTROL_DATA_DIR must be an existing directory, not a link/);
        assert.deepEqual(await fs.readdir(path.join(target, "child")), []);
      }
    } finally {
      await fs.unlink(link).catch(error => { if (error.code !== "ENOENT") throw error; });
      await fs.rmdir(path.join(target, "child"));
      await fs.rmdir(target);
    }
    const child = spawn(process.execPath, [entry, "--managed-worker"], {
      env: { ...env, PC_CONTROL_PROBE_KEY: randomBytes(32).toString("hex") },
      stdio: ["pipe", "ignore", "pipe"], signal: AbortSignal.timeout(10000)
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 1, stderr);
    assert.match(stderr, /EADDRINUSE/);
    assert.equal((await fs.readdir(root)).includes("server.lock.json"), false);
    const client = net.connect(port, "127.0.0.1");
    const [message] = await once(client, "data");
    client.destroy();
    assert.equal(message.toString(), "original listener");
  } finally {
    await new Promise(resolve => listener.close(resolve));
    for (const file of await fs.readdir(root)) await fs.unlink(path.join(root, file));
    await fs.rmdir(root);
  }
});

test("independent data roots can share one engine owner", { timeout: 10000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-control-owner-"));
  t.after(async () => {
    await fs.unlink(path.join(root, "server.lock.json")).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    await fs.rmdir(root);
  });
  assert.match(readConfig({ PC_CONTROL_OWNERSHIP_DIR: "relative" }).stderr,
    /PC_CONTROL_OWNERSHIP_DIR must be an absolute local path/);
  const fixture = fileURLToPath(new URL("./fixtures/lock-contender.mjs", import.meta.url));
  const children = ["legacy", "installed"].map(kind => fork(fixture, [], {
    env: { ...process.env, PC_CONTROL_DATA_DIR: path.join(root, kind), PC_CONTROL_OWNERSHIP_DIR: root }
  }));
  const exits = children.map(child => once(child, "exit"));
  try {
    await Promise.all(children.map(child => once(child, "message")));
    const results = await Promise.all(children.map(async child => {
      const reply = once(child, "message");
      child.send("acquire");
      return (await reply)[0];
    }));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(await fs.readdir(root), ["server.lock.json"]);
  } finally {
    for (const child of children) if (child.connected) child.send("release");
    await Promise.all(exits);
  }
  assert.deepEqual(await fs.readdir(root), []);
});
