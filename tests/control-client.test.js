import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { ControlRequestError, createControlClient } from "../public/control-client.js";

const reply = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

test("shared client sends the owner session and preserves verified results", async () => {
  const request = createControlClient({ session: () => "owner-window", fetcher: async (path, options) => {
    assert.equal(path, "/api/lab/mouse/apply");
    assert.equal(options.headers["x-pc-session"], "owner-window");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "same-origin");
    assert.deepEqual(JSON.parse(options.body), { pointerSpeed: 10 });
    return reply({ ok: true, applied: { pointerSpeed: 10 } });
  } });
  assert.deepEqual(await request("/api/lab/mouse/apply", { method: "POST", body: '{"pointerSpeed":10}' }), { ok: true, applied: { pointerSpeed: 10 } });
});

test("backend refusals use friendly message or error rather than treating HTTP 200 as success", async () => {
  for (const [payload, status, message] of [
    [{ ok: false, message: "End gameplay first.", error: "ignored" }, 200, "End gameplay first."],
    [{ ok: false, error: "Adapter disappeared." }, 200, "Adapter disappeared."],
    [{}, 403, "Request failed: 403"]
  ]) {
    const request = createControlClient({ fetcher: async () => reply(payload, status) });
    await assert.rejects(request("/api/status"), (error) => error instanceof ControlRequestError && error.message === message && !error.uncertain);
  }
});

test("only an explicit superseded response retires a control window", async () => {
  let retired = 0;
  for (const superseded of [false, true]) {
    const request = createControlClient({ onSuperseded: () => retired++, fetcher: async () => reply({ ok: false, superseded, message: "Control held." }, 409) });
    await assert.rejects(request("/api/mode", { method: "POST", body: "{}" }), (error) => error.superseded === superseded && !error.uncertain);
  }
  assert.equal(retired, 1);
});

test("failed or unreadable mutation responses stay uncertain and are never retried", async () => {
  for (const fetcher of [
    async () => { throw new Error("Disconnected"); },
    async () => new Response("not JSON"),
    async () => reply(null),
    async () => reply({ ok: false, message: "Readback failed." }, 500)
  ]) {
    let calls = 0;
    const request = createControlClient({ fetcher: async (...args) => { calls++; return fetcher(...args); } });
    await assert.rejects(request("/api/mode", { method: "POST", body: "{}" }), (error) => error.uncertain === true);
    assert.equal(calls, 1);
  }
});

test("caller cancellation reaches transport without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = createControlClient({ fetcher: async (_path, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const pending = request("/api/status", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => !error.uncertain && /Connection interrupted/.test(error.message));
  assert.equal(calls, 1);
});

test("remote destinations, unsupported methods and malformed settings never leave the page", async () => {
  let calls = 0;
  const request = createControlClient({ fetcher: async () => { calls++; return reply({ ok: true }); } });
  for (const path of ["https://other.invalid/api/status", "//other.invalid/api/status", "/api/../other", "/api/status#fragment"]) {
    await assert.rejects(request(path), /not supported/);
  }
  await assert.rejects(request("/api/status", { method: "DELETE" }), /not supported/);
  for (const body of ["[", "[]", "null", "2"]) await assert.rejects(request("/api/mode", { method: "POST", body }), /valid settings/);
  assert.equal(calls, 0);
});

test("all pages use the shared request helper; Lab markup never interpolates executable handlers", async () => {
  for (const file of ["app.js", "comfort.js", "lab.html"]) {
    const source = await fs.readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
    assert.match(source, /import \{ createControlClient \} from "\.\/control-client.js"/);
    assert.doesNotMatch(source, /await fetch\(/);
  }
  const lab = await fs.readFile(new URL("../public/lab.html", import.meta.url), "utf8");
  assert.doesNotMatch(lab, /onclick=|window\.cage|window\.irqAct/);
  assert.match(lab, /data-cage-name="\$\{esc\(s.name\)\}"/);
  assert.match(lab, /await cage\(Number\(button.dataset.cagePid\), button.dataset.cageName\)/);
});
