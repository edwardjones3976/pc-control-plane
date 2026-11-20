import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createServer, listenWithRetry, superviseInput } from "../server/index.js";
import { localRequestUrl, readJsonBody } from "../server/http-boundary.js";

async function fixture(run, options = {}) {
  let calls = 0;
  const server = await createServer({
    apiHandler: async (req, res) => {
      calls++;
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, body }));
    }, ...options
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (url = "/api/status", { method = "GET", headers = {}, body = "" } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method, agent: false, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const json = { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  try { await run({ request, origin, json, calls: () => calls }); }
  finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

test("managed engine input ignores payloads and requests shutdown on disconnect", async () => {
  const input = new PassThrough();
  const reasons = [];
  superviseInput(input, reason => reasons.push(reason));
  input.write("not a command");
  assert.deepEqual(reasons, []);
  const ended = once(input, "end");
  input.end();
  await ended;
  assert.deepEqual(reasons, ["supervisor-disconnected"]);

  const broken = new PassThrough();
  superviseInput(broken, reason => reasons.push(reason));
  broken.emit("error", new Error("pipe lost"));
  assert.deepEqual(reasons, ["supervisor-disconnected", "supervisor-input-failed"]);
  broken.destroy();
});

test("managed HTTP routes only authorized health requests to the handler", async () => {
  await fixture(async ({ request, json, calls }) => {
    assert.equal((await request("/api/health")).status, 401);
    const headers = { ...json, "x-test-authorized": "yes" };
    assert.equal((await request("/comfort", { headers })).status, 403);
    assert.equal((await request("/api/status", { headers })).status, 403);
    assert.equal((await request("/api/mode/apply", { method: "POST", headers, body: "{}" })).status, 403);
    assert.equal(calls(), 0);
    assert.equal((await request("/api/health", { headers })).status, 200);
    assert.equal(calls(), 1);
  }, { healthOnly: true, authorize: req => req.headers["x-test-authorized"] === "yes" });
});

test("health reads observer state without starting the engine", async () => {
  await fixture(async ({ request }) => {
    const response = await request("/api/health");
    assert.equal(response.status, 200);
    const { observer, savedMode } = JSON.parse(response.text);
    assert.deepEqual(observer, { running: false });
    assert.ok(["saved", "missing", "unavailable"].includes(savedMode.status));
    assert.deepEqual(Object.keys(savedMode).sort(), ["modeId", "status"]);
    assert.equal((await request("/api/health", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  }, { apiHandler: undefined });
  await fixture(async ({ request }) => {
    assert.equal((await request("/api/health")).status, 503);
  }, { ready: () => false, apiHandler: undefined });
});

test("all existing command routes reject cross-origin or untyped browser writes", async () => {
  const source = await fs.readFile(new URL("../server/index.js", import.meta.url), "utf8");
  const routes = [...source.matchAll(/req.method === "POST" && url.pathname === "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(routes.length >= 25, "coverage must include the current mutating API surface");
  await fixture(async ({ request, json, calls }) => {
    for (const route of routes) {
      assert.equal((await request(route, { method: "POST" })).status, 403, route);
      assert.equal((await request(route, { method: "POST", headers: { ...json, origin: "https://other.invalid" } })).status, 403, route);
    }
    assert.equal(calls(), 0);
    assert.equal((await request("/api/mode", { method: "POST", headers: { ...json, "content-type": "text/plain" } })).status, 415);
    assert.equal(calls(), 0);
  });
});

test("same-origin JSON writes and local readback reach the handler", async () => {
  await fixture(async ({ request, json, calls }) => {
    const result = await request("/api/mode", { method: "POST", headers: { ...json, "content-type": "application/json; charset=utf-8" }, body: '{"modeId":"balanced"}' });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text).body, { modeId: "balanced" });
    assert.equal(result.headers["x-frame-options"], "DENY");
    assert.equal((await request()).status, 200);
    assert.equal(calls(), 2);
  });
});

test("bad host, foreign peer, cross-site reads and malformed URLs cannot reach handlers", async () => {
  await fixture(async ({ request, origin, calls }) => {
    assert.equal((await request("/api/status", { headers: { host: "other.invalid:" + new URL(origin).port } })).status, 403);
    assert.equal((await request("/api/status", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await request("/api/status", { headers: { origin: "null" } })).status, 403);
    for (const url of ["/%not-hex", "//other.invalid/api/status", "http://other.invalid/api/status"]) {
      assert.equal((await request(url)).status, 400, url);
    }
    assert.equal(calls(), 0);
    assert.equal((await request()).status, 200, "invalid input must not terminate the server");
  });
  assert.throws(() => localRequestUrl({ socket: { remoteAddress: "192.0.2.1", localPort: 8792 }, headers: {}, url: "/api/status", method: "GET" }), { status: 403 });
});

test("invalid, non-object, and oversized bodies get explicit errors without a command result", async () => {
  await fixture(async ({ request, json }) => {
    for (const body of ["[", "null", "[]", '"text"', "7"]) {
      const result = await request("/api/mode", { method: "POST", headers: json, body });
      assert.equal(result.status, 400, body);
      assert.equal(JSON.parse(result.text).ok, false);
    }
    const result = await request("/api/mode", { method: "POST", headers: json, body: JSON.stringify({ value: "x".repeat(1024 * 1024) }) });
    assert.equal(result.status, 413);
    assert.equal(result.headers.connection, "close");
    assert.equal((await request()).status, 200);
  });
});

test("starting or stopping engine rejects requests before the handler", async () => {
  await fixture(async ({ request, json, calls }) => {
    assert.equal((await request()).status, 503);
    assert.equal((await request("/api/mode", { method: "POST", headers: json, body: "{}" })).status, 503);
    assert.equal(calls(), 0);
  }, { ready: () => false });
});

test("unexpected handler exceptions are contained and not disclosed", async () => {
  await fixture(async ({ request }) => {
    const result = await request();
    assert.equal(result.status, 500);
    assert.doesNotMatch(result.text, /private internal detail/);
    assert.equal((await request("/")).status, 200);
    assert.equal((await request("/comfort")).headers.location, "/comfort.html");
    assert.equal((await request("/lab")).headers.location, "/lab.html");
  }, { apiHandler: async () => { throw new Error("private internal detail"); } });
});

test("body disconnect settles the receiver without accepting partial settings", async () => {
  const { PassThrough } = await import("node:stream");
  const req = new PassThrough();
  req.headers = {};
  const result = readJsonBody(req);
  req.write('{"modeId":');
  req.emit("aborted");
  await assert.rejects(result, { status: 400 });
  req.destroy();
});

test("body validation is shared by the request boundary and the selected handler", async () => {
  const { PassThrough } = await import("node:stream");
  const req = new PassThrough();
  req.headers = {};
  const first = readJsonBody(req);
  assert.equal(readJsonBody(req), first);
  req.end('{"modeId":"balanced"}');
  assert.deepEqual(await first, { modeId: "balanced" });
  assert.equal(readJsonBody(req), first, "handlers reuse validation after end, without waiting for a second body");
  const source = await fs.readFile(new URL("../server/index.js", import.meta.url), "utf8");
  const routing = source.slice(source.indexOf("async function handleApi"), source.indexOf("export async function createServer"));
  assert.ok(routing.indexOf('if (req.method === "POST") await readBody(req);') < routing.indexOf('url.pathname === "/api/lab/irq/apply"'));
});

test("port retries remove old callbacks and never stop the current port owner", async () => {
  const owner = http.createServer((_req, res) => res.end("existing owner"));
  const contender = http.createServer();
  const initialListening = contender.listeners("listening");
  const initialErrors = contender.listeners("error");
  owner.listen(0, "127.0.0.1");
  await once(owner, "listening");
  const bindPort = owner.address().port;
  try {
    await assert.rejects(listenWithRetry(contender, { bindPort, attempts: 2, delayMs: 1 }), { code: "EADDRINUSE" });
    const controller = new AbortController();
    const busy = once(contender, "error");
    const retrying = listenWithRetry(contender, { bindPort, delayMs: 1000, signal: controller.signal });
    const [bindError] = await busy;
    controller.abort();
    await assert.rejects(retrying, { name: "AbortError" });
    assert.equal(bindError.code, "EADDRINUSE");
    assert.equal(owner.listening, true);
    assert.equal(contender.listening, false);
    assert.deepEqual(contender.listeners("listening"), initialListening);
    assert.deepEqual(contender.listeners("error"), initialErrors);
  } finally {
    await new Promise((resolve) => owner.close(resolve));
  }
  await listenWithRetry(contender, { bindPort, attempts: 0 });
  try {
    assert.deepEqual(contender.listeners("listening"), initialListening);
    assert.deepEqual(contender.listeners("error"), initialErrors);
  } finally { await new Promise((resolve) => contender.close(resolve)); }
});
