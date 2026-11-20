import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createRefreshGate, monitoringState, setMarkup } from "../public/render-state.js";

test("monitoring distinguishes first load, interrupted, stale, cached and paused states", () => {
  assert.equal(monitoringState({}, 100000).kind, "connecting");
  assert.equal(monitoringState({ failed: true }, 100000).kind, "offline");
  assert.equal(monitoringState({ receivedAt: 90000 }, 100000).kind, "live");
  assert.equal(monitoringState({ receivedAt: 70000 }, 100000).kind, "stale");
  assert.equal(monitoringState({ receivedAt: 90000, failed: true }, 100000).readings, "Last readings");
  assert.equal(monitoringState({ receivedAt: 90000, cached: true }, 100000).readings, "Cached");
  assert.equal(monitoringState({ receivedAt: 90000, observerRunning: false }, 100000).kind, "paused");
  assert.equal(monitoringState({ receivedAt: 90000, superseded: true, failed: true }, 100000).retry, false);
});

test("unchanged markup does not replace nodes; changed markup does", () => {
  let writes = 0;
  const element = { set innerHTML(value) { writes++; this.value = value; } };
  assert.equal(setMarkup(element, "CPU 40%"), true);
  assert.equal(setMarkup(element, "CPU 40%"), false);
  assert.equal(setMarkup(element, "CPU 41%"), true);
  assert.equal(writes, 2);
  assert.equal(setMarkup(null, ""), false);
});

test("overlapping refreshes share one read and fresh callers queue just one follow-up", async () => {
  const calls = [], finish = [];
  const refresh = createRefreshGate(({ requireFresh }) => {
    calls.push(requireFresh);
    return new Promise((resolve) => finish.push(resolve));
  });
  const normal = refresh();
  assert.equal(refresh(), normal);
  const fresh = refresh({ requireFresh: true });
  assert.equal(refresh({ requireFresh: true }), fresh);
  await Promise.resolve();
  assert.deepEqual(calls, [false]);
  finish.shift()("cached");
  assert.equal(await normal, "cached");
  await new Promise(setImmediate);
  assert.deepEqual(calls, [false, true]);
  const joined = refresh();
  finish.shift()("fresh");
  assert.equal(await fresh, "fresh");
  assert.equal(await joined, "fresh");
});

test("a rejected read releases the gate and does not discard queued fresh work", async () => {
  let count = 0;
  const refresh = createRefreshGate(async () => {
    if (++count === 1) throw new Error("offline");
    return count;
  });
  const first = refresh();
  const queued = refresh({ requireFresh: true });
  await assert.rejects(first, /offline/);
  assert.equal(await queued, 2);
  assert.equal(await refresh(), 3);
});

test("actual stream broadcaster drops slow/closed clients without delaying healthy clients", async () => {
  const source = await fs.readFile(new URL("../server/live.js", import.meta.url), "utf8");
  const broadcast = source.slice(source.indexOf("function broadcast("), source.indexOf("async function fastTick("));
  let destroyed = 0, stops = 0;
  const frames = [];
  const slow = { writableLength: 256 * 1024 + 1, destroy() { destroyed++; }, write() { assert.fail("slow write"); } };
  const closed = { destroyed: true, write() { assert.fail("closed write"); } };
  const healthy = { writableLength: 0, write(frame) { frames.push(frame); } };
  const clients = new Set([slow, closed, healthy]);
  const context = vm.createContext({ clients, stopLoopsIfIdle() { stops++; } });
  vm.runInContext(broadcast + '; broadcast("status", {ok:true});', context);
  assert.equal(destroyed, 1);
  assert.equal(clients.size, 1);
  assert.equal(stops, 1);
  assert.match(frames[0], /event: status/);
  assert.match(frames[0], /"ok":true/);
});
