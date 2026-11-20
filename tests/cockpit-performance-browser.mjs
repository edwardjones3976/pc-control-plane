import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(process.env.PCP_PUBLIC_DIR || "public");
const output = path.resolve("output/optimization-20261120");
await fs.mkdir(output, { recursive: true });
const modes = ["conservative", "balanced", "performance", "competitive", "agentic", "overdrive"].map((id, i) => ({
  id, label: ["Conservative", "Balanced", "100% Performance", "Competitive Gaming", "Agentic Work", "Overdrive"][i]
}));
const status = {
  ok: true, app: { version: "0.8.0" }, modes, state: { modeId: "balanced", autonomy: "auto-safe" },
  policy: { mode: modes[1], health: { state: "Stable", tone: "green", reasons: ["No immediate telemetry strain detected."] },
    priority: { label: "Agentic Work", reason: "Protected background work is active." }, offenders: [], actions: [],
    networkHealth: { dnsOk: true, webReachable: true, activeAdapter: { Name: "Ethernet" } } },
  telemetry: { capturedAt: new Date().toISOString(), host: { elevated: true },
    system: { cpuLoadPct: 28, logicalProcessors: 16, ramUsedPct: 35, ramFreeGB: 41, ramTotalGB: 64, uptimeHours: 12 },
    gpu: { utilizationPct: 22, temperatureC: 44, graphicsClockMHz: 1425, memoryClockMHz: 14001, memoryUsedMB: 1650, memoryTotalMB: 12288, powerDrawW: 31 },
    temperatures: { cpuC: 61, memoryC: 48, gpuMemoryC: 50, cpuSource: "LibreHardwareMonitorLib" },
    power: { activeLine: "Power Scheme GUID: 00000000-0000-0000-0000-000000000003 (03 - Balanced Mode)" },
    network: { sampledAt: new Date().toISOString(), latency: { status: "measured", received: 4, averageMs: 14, minMs: 13, maxMs: 15, packetLossPct: 0, target: "1.1.1.1" } } },
  v2: { adaptivePower: { tier: 3, floor: 1, ceiling: 4, plan: "03 - Balanced Mode", reason: "Moderate load" } },
  audit: [], learning: {}, observer: { running: true }, protectedApps: []
};
let baseline = false;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) { res.writeHead(500); res.end("Mock interception required"); return; }
  const file = path.resolve(root, pathname === "/" ? "index.html" : "." + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const source = baseline && ["app.js", "styles.css"].includes(path.basename(file)) ? path.join(output, "before", path.basename(file)) : file;
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[path.extname(file)] || "text/plain");
    res.end(await fs.readFile(source));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome" });
const report = { metrics: [], layouts: [], errors: [] };
const hasBaseline = process.env.PCP_SKIP_BASELINE !== "1" && await fs.access(path.join(output, "before", "app.js")).then(() => true, () => false);
try {
  for (const before of hasBaseline ? [true, false] : [false]) {
    baseline = before;
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    let unavailable = false;
    let failReadback = false, supersedeNext = false;
    const requests = [];
    page.on("pageerror", error => report.errors.push(error.message));
    await context.route("**/api/**", route => {
      requests.push({ method: route.request().method(), url: route.request().url() });
      if (route.request().method() === "POST") {
        if (supersedeNext) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, superseded: true, message: "Another window has control." }) });
        if (failReadback) unavailable = true;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, message: "Mode applied." }) });
      }
      return unavailable ? route.abort("connectionrefused") : route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().url().includes("/status") ? status : { ok: true }) });
    });
    await context.route("https://**", route => route.abort());
    await page.addInitScript(() => {
      window.EventSource = class {
        listeners = new Map();
        constructor() { window.testStream = this; }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        emit(name, sample) { this.listeners.get(name)?.({ data: JSON.stringify(sample) }); }
        close() {}
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("#telemetryGrid .telemetry-card");
    await page.waitForTimeout(100);
    const metric = await page.evaluate(sample => {
      const push = () => window.testStream.emit("status", sample);
      for (let i = 0; i < 70; i++) push();
      const card = document.querySelector(".telemetry-card");
      const mode = document.querySelector(".mode-card");
      mode.focus();
      const observer = new MutationObserver(() => {});
      observer.observe(document.getElementById("telemetryGrid"), { childList: true, subtree: true });
      const batches = [];
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        for (let i = 0; i < 20; i++) push();
        batches.push((performance.now() - start) / 20);
      }
      const mutations = observer.takeRecords().length;
      observer.disconnect();
      return { medianRenderMs: batches.sort((a, b) => a - b)[2], mutations,
        cardRetained: card === document.querySelector(".telemetry-card"),
        focusRetained: mode === document.activeElement,
        hiddenPanelChildren: document.getElementById("autonomyLoop").childElementCount };
    }, status);
    report.metrics.push({ phase: before ? "before" : "after", ...metric });
    if (!before) {
      assert.equal(metric.cardRetained, true);
      assert.equal(metric.focusRetained, true);
      assert.equal(metric.hiddenPanelChildren, 0);
      assert.equal(metric.mutations, 0);
      await page.evaluate(sample => window.testStream.emit("fast", sample), { at: new Date().toISOString(), cpuLoadPct: 47.99 });
      await page.waitForFunction(() => document.querySelector('[data-metric="cpu"] .telemetry-value').textContent === "47%");
    }
    for (const width of before ? [1920] : [1920, 1536, 1280, 960, 640, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(output, `${before ? "before" : "after"}-${width}.png`), fullPage: true });
      const layout = await page.evaluate(() => ({
        width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        overlap: [...document.querySelectorAll(".telemetry-card")].some(card => {
          const detail = card.querySelector(".telemetry-detail"), chart = card.querySelector(".sparkline");
          return chart && detail.getBoundingClientRect().bottom > chart.getBoundingClientRect().top + 1;
        })
      }));
      report.layouts.push({ phase: before ? "before" : "after", ...layout });
      if (!before) { assert.equal(layout.overflow, false, `page overflow at ${width}`); assert.equal(layout.overlap, false, `chart overlap at ${width}`); }
    }
    if (!before) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      for (const zoom of [1.5, 2]) {
        await page.evaluate(value => document.documentElement.style.zoom = value, zoom);
        await page.screenshot({ path: path.join(output, `after-zoom-${zoom}.png`), fullPage: true });
        const sizing = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
          inner: innerWidth, body: document.body.getBoundingClientRect().width,
          offenders: [...document.querySelectorAll("body *")].filter(el => {
            const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 1;
          }).slice(0, 12).map(el => ({ tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right }))
        }));
        report.layouts.push({ phase: "after", zoom, ...sizing });
        assert.ok(sizing.scroll <= sizing.client, `overflow at ${zoom} zoom: ${JSON.stringify(sizing)}`);
      }
      await page.evaluate(() => document.documentElement.style.zoom = 1);
      const retained = await page.locator('[data-metric="cpu"] .telemetry-value').textContent();
      await page.evaluate(() => window.testStream.emit("error", {}));
      assert.match(await page.locator("#serviceStatus").textContent(), /Reconnecting/);
      assert.match(await page.locator("#healthText").textContent(), /Last:/);
      assert.match(await page.locator('[data-net="headline"]').textContent(), /Awaiting current/);
      assert.equal(await page.locator('[data-metric="cpu"] .telemetry-value').textContent(), retained);
      assert.equal(await page.locator("#connectionNotice").isVisible(), true);
      await page.screenshot({ path: path.join(output, "reconnecting.png") });
      unavailable = true;
      await page.locator("#connectionRetry").click();
      await page.waitForFunction(() => !document.getElementById("connectionRetry").disabled);
      assert.match(await page.locator("#serviceStatus").textContent(), /Reconnecting/);
      unavailable = false;
      const beforeRetry = requests.filter(r => r.url.endsWith("/api/status")).length;
      await page.locator("#connectionRetry").click();
      await page.waitForFunction(() => document.getElementById("serviceStatus").dataset.state === "live");
      assert.equal(requests.filter(r => r.url.endsWith("/api/status")).length, beforeRetry + 1);
      assert.equal(await page.locator("#connectionNotice").isVisible(), false);
      assert.equal(await page.locator("#healthText").textContent(), "Stable");
      await page.evaluate(sample => window.testStream.emit("status", { ...sample, telemetry: { ...sample.telemetry, stale: true } }), status);
      assert.match(await page.locator("#telemetryFreshness").textContent(), /Cached/);
      await page.evaluate(sample => window.testStream.emit("status", { ...sample, observer: { running: false } }), status);
      assert.match(await page.locator("#serviceStatus").textContent(), /Monitor paused/);
      unavailable = true;
      await page.reload();
      await page.waitForFunction(() => document.getElementById("serviceStatus").dataset.state === "offline");
      assert.match(await page.locator("#connectionMessage").textContent(), /No readings/);
      unavailable = false;
      await page.locator("#connectionRetry").click();
      await page.waitForFunction(() => document.getElementById("serviceStatus").dataset.state === "live");
      assert.equal(requests.filter(r => r.method !== "GET").length, 0, "recovery must never replay mutations");
      failReadback = true;
      await page.locator("#defaultModeButton").click();
      await page.waitForFunction(() => document.getElementById("toast").textContent.includes("Monitoring could not refresh"));
      assert.match(await page.locator("#toast").textContent(), /^Mode applied\./);
      assert.equal(requests.filter(r => r.method === "POST").length, 1);
      unavailable = false;
      failReadback = false;
      await page.locator("#connectionRetry").click();
      await page.waitForFunction(() => document.getElementById("serviceStatus").dataset.state === "live");
      supersedeNext = true;
      await page.locator("#defaultModeButton").click();
      await page.waitForFunction(() => document.getElementById("serviceStatus").dataset.state === "inactive");
      assert.equal(await page.locator("#defaultModeButton").isDisabled(), true);
      assert.equal(await page.locator("#releaseRamButton").isDisabled(), true);
      assert.equal(await page.locator("#supersededRefresh").isDisabled(), false);
    }
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.writeFile(path.join(output, "browser-results.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
