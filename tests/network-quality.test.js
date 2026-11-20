import assert from "node:assert/strict";
import { test } from "node:test";
import { networkQuality, runSpeedTest } from "../public/network-quality.js";
import { analyzeNetworkHealth } from "../server/policy.js";

test("unanswered echo and collector errors do not trigger loss-based policy", () => {
  for (const status of ["no-reply", "probe-error", undefined]) {
    const health = analyzeNetworkHealth({ network: {
      activeAdapter: { Name: "Ethernet" },
      latency: { status, received: 0, packetLossPct: 100, averageMs: null }
    } });
    assert.equal(health.packetLossPct, null);
    assert.equal(health.latencyMs, null);
    assert.equal(health.actions.some(({ id }) => id === "network.reset-adapter-confirmed"), false);
  }
});

test("missing, stale and blocked ping never look healthy", () => {
  assert.equal(networkQuality({ ping: null, loss: null }).score, null);
  assert.equal(networkQuality({ ping: 10, loss: 0, stale: true }).score, null);
  assert.equal(networkQuality({ ping: null, loss: 100, web: true }).quality, "Ping target did not reply");
  assert.equal(networkQuality({ loss: 100, web: false }).score, 0);
  assert.equal(networkQuality({ ping: 10, loss: 0, variation: 2, dns: true, web: true }).score, 100);
});

test("speed test uses bounded payloads and reports both directions", async () => {
  const uploads = [];
  const phases = [];
  const result = await runSpeedTest({
    signal: new AbortController().signal,
    phase: (value) => phases.push(value),
    fetcher: async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, "https://speed.cloudflare.com");
      assert.equal(options.credentials, "omit");
      if (target.pathname === "/__up") {
        uploads.push(options.body.byteLength);
        return new Response();
      }
      const size = Number(target.searchParams.get("bytes"));
      assert.ok(size === 0 || size === 10_000_000);
      return new Response(new Uint8Array(size));
    }
  });
  assert.deepEqual(uploads, [4_000_000]);
  assert.equal(phases.length, 3);
  assert.ok(result.download > 0 && result.upload > 0 && result.idle >= 0);
});

test("short responses fail rather than presenting a fabricated speed", async () => {
  await assert.rejects(runSpeedTest({
    signal: new AbortController().signal,
    fetcher: async () => new Response(new Uint8Array(0))
  }), /Incomplete speed test download/);
});
