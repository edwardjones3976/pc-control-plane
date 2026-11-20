import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { createEngineLifecycle } from "../server/engine-lifecycle.js";
import { acquireSingleInstanceLock, readSingleInstanceLock, releaseSingleInstanceLock } from "../server/lock.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fixture(overrides = {}) {
  const events = [];
  const step = (name, result) => async () => { events.push(name); return result; };
  const engine = createEngineLifecycle({
    acquire: step("acquire", { ok: true }), listen: step("listen"), recover: step("recover"),
    start: step("start"), stop: step("drain"), close: step("close"), release: step("release", true),
    ...overrides
  });
  return { engine, events };
}

async function withLock(testBody) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-control-plane-lock-test-"));
  const file = path.join(dir, "owner.json");
  try { await testBody(file); } finally {
    await releaseSingleInstanceLock({ file });
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("pc-control-plane-lock-test-"));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("engine binds before recovery and starts background work last", async () => {
  const { engine, events } = fixture();
  await engine.start();
  assert.equal(engine.phase, "ready");
  await engine.start();
  await engine.stop();
  await engine.stop();
  assert.deepEqual(events, ["acquire", "listen", "recover", "start", "drain", "close", "release"]);
  assert.equal(engine.phase, "stopped");
});

test("bind failure never executes recovery or automation", async () => {
  const { engine, events } = fixture({ listen: async () => { throw new Error("port occupied"); } });
  await assert.rejects(engine.start(), /port occupied/);
  assert.deepEqual(events, ["acquire", "drain", "close", "release"]);
  assert.equal(engine.phase, "failed");
});

test("lock refusal makes no Windows changes and releases no other owner's lock", async () => {
  const { engine, events } = fixture({ acquire: async () => ({ ok: false, message: "owner active" }) });
  await assert.rejects(engine.start(), /owner active/);
  await engine.stop();
  assert.deepEqual(events, []);
});

test("shutdown racing failed startup shares one cleanup", async () => {
  for (const drainFails of [false, true]) {
    const entered = deferred();
    const resume = deferred();
    let drains = 0;
    const { engine, events } = fixture({
      listen: async () => {
        entered.resolve();
        await resume.promise;
        throw new Error("bind failed");
      },
      stop: async () => {
        drains++;
        if (drainFails) throw new Error("drain failed");
      }
    });
    const starting = engine.start();
    await entered.promise;
    const stopping = engine.stop();
    resume.resolve();
    const [startup, shutdown] = await Promise.allSettled([starting, stopping]);
    assert.equal(startup.status, "rejected");
    assert.equal(drains, 1);
    if (drainFails) {
      assert.equal(shutdown.status, "rejected");
      assert.match(shutdown.reason.message, /drain failed/);
      assert.deepEqual(events, ["acquire"]);
    } else {
      assert.equal(shutdown.status, "fulfilled");
      assert.deepEqual(events, ["acquire", "close", "release"]);
      assert.equal(engine.phase, "stopped");
    }
  }
});

test("ownership I/O errors leave a failed engine, not a perpetually starting one", async () => {
  const { engine, events } = fixture({ acquire: async () => { throw new Error("Access denied"); } });
  await assert.rejects(engine.start(), /Access denied/);
  assert.equal(engine.phase, "failed");
  assert.deepEqual(events, []);
});

test("shutdown retains ownership until background work and requests drain", async () => {
  const draining = deferred();
  const requests = deferred();
  let released = false;
  const { engine } = fixture({ stop: () => draining.promise, close: () => requests.promise, release: async () => (released = true) });
  await engine.start();
  const stopping = engine.stop();
  assert.equal(engine.stop(), stopping);
  await Promise.resolve();
  assert.equal(engine.phase, "stopping");
  assert.equal(released, false);
  draining.resolve();
  await Promise.resolve();
  assert.equal(released, false);
  requests.resolve();
  await stopping;
  assert.equal(released, true);
});

test("stop cancels an ownership wait without touching the active owner", async () => {
  const { engine, events } = fixture({
    acquire: signal => new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  });
  const starting = engine.start();
  await engine.stop();
  await starting;
  assert.equal(engine.phase, "stopped");
  assert.deepEqual(events, []);
});

test("stop while waiting for ownership prevents binding and recovery", async () => {
  const acquired = deferred();
  const { engine, events } = fixture({ acquire: () => acquired.promise });
  const starting = engine.start();
  const stopping = engine.stop();
  acquired.resolve({ ok: true });
  await Promise.all([starting, stopping]);
  assert.equal(engine.phase, "stopped");
  assert.deepEqual(events, ["drain", "close", "release"]);
});

test("stop during startup prevents recovery and automation", async () => {
  const bound = deferred();
  const entered = deferred();
  const { engine, events } = fixture({ listen: async () => { entered.resolve(); await bound.promise; } });
  const starting = engine.start();
  await entered.promise;
  const stopping = engine.stop();
  bound.resolve();
  await starting;
  await stopping;
  assert.deepEqual(events, ["acquire", "drain", "close", "release"]);
});

test("failed drain does not release ownership", async () => {
  const { engine, events } = fixture({ stop: async () => { throw new Error("operation unresolved"); } });
  await engine.start();
  await assert.rejects(engine.stop(), /operation unresolved/);
  assert.equal(events.includes("release"), false);
  assert.equal(engine.phase, "stopping");
});

test("recovery failure does not start automation", async () => {
  const { engine, events } = fixture({ recover: async () => { throw new Error("restore failed"); } });
  await assert.rejects(engine.start(), /restore failed/);
  assert.deepEqual(events, ["acquire", "listen", "drain", "close", "release"]);
});

test("same-process ownership is active and release requires exact token", async () => withLock(async (file) => {
  const first = await acquireSingleInstanceLock({ file });
  assert.equal(first.ok, true);
  assert.equal((await readSingleInstanceLock({ file })).active, true);
  assert.deepEqual((await acquireSingleInstanceLock({ file })).lock, first.lock);
  await fs.writeFile(file, JSON.stringify({ ...first.lock, token: "another-owner" }));
  assert.equal(await releaseSingleInstanceLock({ file }), false);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, "another-owner");
  await fs.writeFile(file, JSON.stringify(first.lock));
}));

test("malformed ownership is preserved, not treated as a dead process", async () => withLock(async (file) => {
  await fs.writeFile(file, "\0broken");
  assert.equal((await acquireSingleInstanceLock({ file })).reason, "unverified-owner");
  assert.equal(await releaseSingleInstanceLock({ file }), false);
  assert.equal(await fs.readFile(file, "utf8"), "\0broken");
}));

test("permission uncertainty is not evidence of an exited owner", async () => withLock(async (file) => {
  const existing = JSON.stringify({ pid: 424242, token: "previous" });
  await fs.writeFile(file, existing);
  assert.equal((await acquireSingleInstanceLock({ file, probe: () => "unknown" })).ok, false);
  assert.equal((await readSingleInstanceLock({ file, probe: () => "unknown" })).active, null);
  assert.equal(await fs.readFile(file, "utf8"), existing);
  assert.equal((await acquireSingleInstanceLock({ file, probe: () => "exited" })).ok, true);
}));

test("interrupted ownership claim is held for reconciliation", async () => withLock(async (file) => {
  await fs.mkdir(`${file}.claim`);
  assert.equal((await acquireSingleInstanceLock({ file })).reason, "claim-pending");
  assert.equal(await releaseSingleInstanceLock({ file }), false);
  assert.equal((await fs.stat(`${file}.claim`)).isDirectory(), true);
}));

test("simultaneous independent processes elect exactly one owner", { timeout: 15000 }, async () => withLock(async (file) => {
  const children = Array.from({ length: 4 }, () => fork(new URL("./fixtures/lock-contender.mjs", import.meta.url), [file], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  try {
    await Promise.all(children.map((child) => once(child, "message")));
    const replies = children.map((child) => once(child, "message"));
    for (const child of children) child.send("acquire");
    const results = await Promise.all(replies);
    assert.equal(results.filter(([result]) => result.ok).length, 1);
    assert.equal((await readSingleInstanceLock({ file })).active, true);
  } finally {
    const exits = children.map((child) => once(child, "exit"));
    for (const child of children) child.send("release");
    await Promise.all(exits);
  }
  assert.equal(await readSingleInstanceLock({ file }), null);
}));

test("public preview blocks startup and retains explicit isolated coverage", async () => {
  const read = (file) => fs.readFile(new URL(file, import.meta.url), "utf8");
  await assert.rejects(read("../Start PC Control Plane.bat"), { code: "ENOENT" });
  assert.match(await read("../server/index.js"), /Source preview only/);
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(pkg.scripts.start, "node server/index.js");
  assert.equal(pkg.scripts.dev, undefined);
  for (const name of ["public-export", "lab-recovery", "network-quality", "engine-lifecycle"]) assert.ok(pkg.scripts.test.includes(`${name}.test.js`));
  const system = await read("../server/system.js");
  assert.match(system, /trackObserverTask\(relieveCpu/);
  assert.match(system, /if \(interactiveDesktop\) trackObserverTask\(tickDesktopComfort/);
  assert.match(system, /interactiveDesktop \? captured : \{ \.\.\.captured, input: null \}/);
  assert.match(await read("../server/index.js"), /startObserverLoop\(undefined, \{ interactiveDesktop: !managed \}\)/);
  assert.match(system, /trackObserverTask\(captureFrameStats/);
  assert.match(system, /export async function stopObserverLoop/);
});

test("worker without desktop context holds discretionary transitions but preserves safety targets", async () => {
  const { sessionQualifiedTarget } = await import("../server/system.js");
  const stable = { health: { state: "Stable" } };
  assert.equal(sessionQualifiedTarget(false, stable, "balanced", {}, "competitive"), null);
  assert.equal(sessionQualifiedTarget(true, stable, "balanced", {}, "competitive"), "competitive");
  const danger = { ...stable, failureRemediation: { safetyTargetMode: "conservative" } };
  assert.equal(sessionQualifiedTarget(false, danger, "competitive", {}, "conservative"), "conservative");
});
