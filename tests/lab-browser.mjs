import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "../server/index.js";
import { readJsonBody } from "../server/http-boundary.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = path.resolve("output/playwright/lab");
await fs.mkdir(output, { recursive: true });
const processName = "O'Brien \"tool\" <test>');globalThis.labInjected=true;//";
const adapterId = "86ebaa9d-2f83-41e3-a60d-238d6383b5a4";
const commands = [], errors = [];
const server = await createServer({ apiHandler: async (req, res) => {
  const body = req.method === "POST" ? await readJsonBody(req) : null;
  if (body) commands.push({ path: req.url, body });
  const replies = {
    "/api/lab/mouse": { ok: false, message: "Mouse unavailable in this isolated test." },
    "/api/lab/network-adapters": { ok: true, adapters: [{ id: adapterId, name: "Test Ethernet", status: "Up" }] },
    "/api/lab/restart-adapter": { ok: true, message: "Test adapter restarted; connection verified." },
    "/api/lab/interruptions": { ok: true, steals: [{ pid: 4321, name: processName, title: "Quoted process", at: new Date().toISOString() }] },
    "/api/lab/eco-cage": { ok: false, message: "Fixture refusal: no process was changed." },
    "/api/lab/irq/apply": { ok: true, adapterName: "Test Ethernet", steeredToCores: [2,3], maskHex: "0C", adapterStatus: "Up", internetOk: true }
  };
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(replies[req.url] || { ok: false, message: "Unsupported fixture action." }));
} });
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (error) => errors.push(error.message));
  let accept = false;
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    if (dialog.type() === "alert" || accept) await dialog.accept(); else await dialog.dismiss();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/lab`);
  await page.waitForFunction(() => document.getElementById("mouse-status").textContent.includes("isolated test"));
  await page.locator('[data-run="interruptions"]').click();
  const cage = page.locator("button[data-cage-pid]");
  await cage.waitFor();
  assert.equal(await cage.getAttribute("data-cage-name"), processName);
  assert.equal(await page.evaluate(() => globalThis.labInjected), undefined);
  await cage.click();
  await page.waitForFunction(() => !document.querySelector("button[data-cage-pid]").disabled);
  assert.deepEqual(commands[0], { path: "/api/lab/eco-cage", body: { pid: 4321, name: processName } });
  assert.ok(dialogs.includes("Fixture refusal: no process was changed."));
  assert.equal(await page.evaluate(() => globalThis.labInjected), undefined);

  await page.locator("#recovery-refresh").click();
  await page.locator("#recovery-adapter").selectOption(adapterId);
  await page.locator("#recovery-restart").click();
  assert.equal(commands.length, 1, "cancel must not submit a restart");
  accept = true;
  await page.locator("#recovery-restart").click();
  await page.waitForFunction(() => document.getElementById("out-recovery").textContent.includes("connection verified"));
  assert.deepEqual(commands[1], { path: "/api/lab/restart-adapter", body: { id: adapterId, confirmed: true } });
  await page.locator('[data-irq-action="apply"]').click();
  await page.waitForFunction(() => document.getElementById("out-irq").textContent.includes("Applied: Test Ethernet"));
  assert.equal(commands[2].path, "/api/lab/irq/apply");

  const layouts = [];
  for (const width of [1280, 640, 360]) {
    await page.setViewportSize({ width, height: 720 });
    const content = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(content <= width, `Lab content overflow: ${content} > ${width}`);
    layouts.push({ width, content });
    await page.screenshot({ path: path.join(output, `lab-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ testedAt: new Date().toISOString(), errors, commands: commands.length, layouts }, null, 2));
  console.log("Lab browser checks passed: shared requests, escaped process names, confirmation/cancel, 3 layouts, no page errors. Windows operations were mocked.");
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
