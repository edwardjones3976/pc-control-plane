import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { comfortDefaults, comfortSettingsForAction, desktopComfortPreset } from "../server/desktop-comfort.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve("public"), output = path.resolve("output/playwright/desktop-comfort");
await fs.mkdir(output, { recursive: true });
let settings = { ...comfortDefaults, enabled: true, override: "dark" };
let rejectNext = 0, responseDelay = 0, active = 0, maxActive = 0;
const posts = [], errors = [], layouts = [];
function status() {
  const theme = desktopComfortPreset(settings);
  return { ok: true, settings, preset: theme, requested: { theme, strength: theme === "dark" ? settings.strength : 0 },
    applied: { theme, strength: theme === "dark" ? settings.strength : 0, verifiedAt: new Date().toISOString() },
    warmthActive: theme === "dark" && settings.strength > 0, status: theme ? (theme === "dark" ? "Evening applied" : "Day applied") : "Off - owned changes released", busy: active > 0 };
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/api/desktop-comfort") {
    if (req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      const command = JSON.parse(body); posts.push(command); active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, responseDelay));
      active--;
      if (rejectNext) { res.writeHead(rejectNext); rejectNext = 0; res.end(JSON.stringify({ ok: false, superseded: true, message: "This window was superseded." })); return; }
      settings = comfortSettingsForAction(settings, command);
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ...status(), saved: req.method === "POST", message: "Saved and verified." })); return;
  }
  const relative = req.url === "/comfort" ? "comfort.html" : decodeURIComponent(req.url.split("?")[0]).slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader("Content-Type", ({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" })[path.extname(file)] || "text/plain");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const url = `http://127.0.0.1:${server.address().port}/comfort`;
const waitIdle = () => page.waitForFunction(() => !document.getElementById("comfort-enabled").disabled);
try {
  await page.goto(url); await waitIdle();
  assert.equal(await page.getByRole("heading", { name: "Desktop Comfort", exact: true }).count(), 1);
  await page.getByLabel("Day starts", { exact: true }).fill("08:00");
  await page.getByRole("radio", { name: "Day", exact: true }).check(); await waitIdle();
  assert.equal(await page.getByLabel("Day starts", { exact: true }).inputValue(), "08:00");
  assert.equal(await page.locator("#schedule-state").textContent(), "Unsaved changes");
  await page.getByRole("button", { name: "Save schedule" }).click(); await waitIdle();
  assert.equal(settings.override, "light");
  assert.equal(settings.day, "08:00");
  await page.getByRole("radio", { name: "Evening", exact: true }).check(); await waitIdle();
  const slider = page.getByRole("slider", { name: "Evening strength" });
  await slider.focus();
  await page.keyboard.press("End");
  const amplifier = page.getByRole("slider", { name: "Warmth amplifier" });
  await amplifier.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const tint = getComputedStyle(document.querySelector("#preview-tint"));
    return tint.backgroundColor === "rgb(255, 0, 0)" && tint.opacity === "1";
  });
  assert.equal(await slider.inputValue(), "100");
  assert.equal(await amplifier.inputValue(), "400");
  await page.waitForFunction(() => document.getElementById("warmth-state").textContent.includes("500"));
  await waitIdle();
  assert.equal(settings.strength, 500);
  await page.screenshot({ path: path.join(output, "evening-500.png"), fullPage: true });
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await amplifier.inputValue(), "0");
  assert.equal(await amplifier.isDisabled(), true);
  await page.waitForFunction(() => document.getElementById("warmth-state").textContent.includes("99"));
  const before = posts.length;
  await slider.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100); assert.equal(posts.length, before);
  await page.waitForTimeout(350); await waitIdle(); assert.equal(posts.length, before + 1); assert.equal(settings.strength, 2);
  responseDelay = 550;
  await page.keyboard.press("End"); await page.waitForTimeout(300);
  await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(300);
  await page.waitForTimeout(1000); await waitIdle();
  assert.equal(maxActive, 1); assert.equal(settings.strength, 1);
  assert.equal(await slider.inputValue(), "1");
  responseDelay = 0;
  const box = await slider.boundingBox(), count = posts.length;
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .85, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(300); assert.equal(posts.length, count);
  await page.mouse.up(); await page.waitForTimeout(100); await waitIdle(); assert.equal(posts.length, count + 1);
  await page.getByRole("switch", { name: "Desktop Comfort" }).uncheck(); await waitIdle();
  assert.equal(settings.enabled, false);
  await slider.focus(); await page.keyboard.press("Home"); await page.waitForTimeout(350); await waitIdle();
  assert.equal(settings.strength, 0); assert.equal(settings.enabled, false);
  await page.getByRole("switch", { name: "Desktop Comfort" }).check(); await waitIdle(); assert.equal(settings.override, null);
  rejectNext = 409;
  await page.getByRole("radio", { name: "Evening", exact: true }).check();
  await page.waitForFunction(() => document.getElementById("recovery-message").textContent.includes("Another Control Plane"));
  assert.equal(await page.getByRole("switch", { name: "Desktop Comfort" }).isDisabled(), true);
  await page.getByRole("button", { name: "Check status" }).click(); await waitIdle();
  await page.addInitScript(() => { const original = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => original(100); });
  await page.reload(); await waitIdle();
  responseDelay = 450;
  await page.getByRole("radio", { name: "Day", exact: true }).check();
  await page.waitForFunction(() => document.getElementById("recovery-message").textContent.includes("Connection interrupted"));
  assert.equal(await page.getByRole("switch", { name: "Desktop Comfort" }).isDisabled(), true);
  await page.waitForTimeout(500); responseDelay = 0;
  await page.getByRole("button", { name: "Check status" }).click(); await waitIdle();
  assert.equal(await page.locator("#appearance-applied").textContent(), "Windows: Day");
  settings = { ...settings, override: "dark", strength: 500 }; await page.reload(); await waitIdle();
  const autoplay = page.getByRole("switch", { name: "Auto-play day timeline" });
  const timeline = page.getByRole("slider", { name: "Day timeline" });
  const seek = (minute) => timeline.evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, minute);
  const beforePlayback = posts.length;
  assert.equal(await autoplay.isChecked(), false);
  await seek(720);
  await autoplay.press("Space");
  assert.equal(await autoplay.isChecked(), true);
  assert.equal(await slider.isDisabled(), true);
  assert.equal(await slider.inputValue(), "0");
  await seek(1200);
  await page.waitForFunction(() => Number(document.querySelector("#comfort-scrub").value) >= 1215);
  const linked = await page.evaluate(() => ({
    minute: document.querySelector("#comfort-scrub").valueAsNumber,
    total: document.querySelector("#comfort-strength").valueAsNumber + document.querySelector("#comfort-amplifier").valueAsNumber
  }));
  assert.equal(linked.total, Math.round(500 * Math.min(linked.minute - 1200, 60) / 60));
  await timeline.press("End");
  await page.waitForFunction(() => Number(document.querySelector("#comfort-scrub").value) < 120);
  assert.equal(await amplifier.inputValue(), "400");
  await page.screenshot({ path: path.join(output, "timeline-autoplay.png"), fullPage: true });
  const hiddenMinute = await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.querySelector("#comfort-scrub").value;
  });
  await page.waitForTimeout(250);
  assert.equal(await timeline.inputValue(), hiddenMinute);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction((minute) => document.querySelector("#comfort-scrub").value !== minute, hiddenMinute);
  await autoplay.press("Space");
  assert.equal(await autoplay.isChecked(), false);
  assert.equal(await slider.inputValue(), "100");
  assert.equal(await amplifier.inputValue(), "400");
  assert.equal(await slider.isEnabled(), true);
  const stoppedAt = await timeline.inputValue();
  await page.waitForTimeout(200);
  assert.equal(await timeline.inputValue(), stoppedAt);
  assert.equal(posts.length, beforePlayback);
  assert.equal(settings.strength, 500);

  await autoplay.press("Space");
  await page.getByRole("button", { name: "Preview now" }).click();
  assert.equal(await autoplay.isChecked(), false);
  assert.equal(posts.length, beforePlayback);
  await page.getByLabel("Schedule type").selectOption("solar");
  assert.equal(await page.getByLabel("Fallback day starts", { exact: true }).inputValue(), "08:00");
  assert.equal(await page.getByLabel("Fallback evening starts", { exact: true }).inputValue(), "20:00");
  await page.getByLabel("Time zone").fill("America/Los_Angeles");
  await page.getByLabel("Latitude", { exact: true }).fill("34.05");
  await page.getByLabel("Longitude", { exact: true }).fill("-118.24");
  const beforeScrub = posts.length;
  await page.getByRole("slider", { name: "Day timeline" }).press("Home");
  assert.match(await page.locator("figcaption").textContent(), /00:00.*Windows unchanged/);
  assert.equal(posts.length, beforeScrub);
  await page.getByRole("button", { name: "Preview now" }).click();
  await page.getByRole("button", { name: "Save schedule" }).click(); await waitIdle();
  assert.equal(settings.scheduleMode, "solar");
  assert.equal(settings.override, "dark");

  for (const palette of ["light", "dark"]) for (const [width, height] of [[1920,1080], [1280,720], [360,800]]) for (const zoom of [1,1.5,2]) {
    const size = { width: Math.floor(width / zoom), height: Math.floor(height / zoom) };
    if (size.width < 280) continue;
    await page.setViewportSize(size); await page.emulateMedia({ colorScheme: palette, reducedMotion: "reduce" });
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth,
      title: getComputedStyle(document.querySelector("h1")).fontSize,
      clipped: [...document.querySelectorAll("button,label,h1,h2,p,nav,fieldset")].filter((el) => el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 2).map((el) => el.id || el.tagName) }));
    assert.ok(geometry.content <= geometry.viewport, JSON.stringify({ size, geometry }));
    assert.deepEqual(geometry.clipped, [], JSON.stringify({ size, geometry }));
    assert.equal(geometry.title, "26px");
    const contrasts = await page.evaluate(() => {
      const luminance = (color) => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((n) => n / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const selected = getComputedStyle(document.querySelector('.comfort-segments input:checked + span'));
      return { link: contrast(luminance(getComputedStyle(document.querySelector('.comfort-nav a[href="/lab"]')).color), luminance(getComputedStyle(document.body).backgroundColor)),
        selection: contrast(luminance(selected.color), luminance(selected.backgroundColor)) };
    });
    assert.ok(contrasts.link >= 4.5 && contrasts.selection >= 4.5, JSON.stringify(contrasts));
    layouts.push({ palette, width, height, equivalentZoom: zoom, ...geometry });
    if (zoom === 1 || (width === 1280 && zoom === 2)) await page.screenshot({ path: path.join(output, `${palette}-${width}-${zoom}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await slider.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  assert.equal(await slider.evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
  await page.screenshot({ path: path.join(output, "high-contrast.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ testedAt: new Date().toISOString(), maxConcurrentRequests: maxActive, posts: posts.length, errors, layouts }, null, 2));
  console.log(`Desktop Comfort browser acceptance passed: ${layouts.length} layouts, timeline playback without writes, keyboard/pointer queue, unsaved edits, refusal recovery, no uncaught page errors.`);
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
