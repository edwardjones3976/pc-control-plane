import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { setTimeout as waitForRetry } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDisplayDays, dataDir, modes, publicDir, statePath } from "./config.js";
import { renderReadableAuditExport } from "./audit-export.js";
import { drainAuditWrites } from "./audit-archive.js";
import { handleStream, notifyChange, getLiveState, isActiveSession, stopLiveTelemetry } from "./live.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./lock.js";
import { createEngineLifecycle } from "./engine-lifecycle.js";
import { localRequestUrl, readJsonBody as readBody } from "./http-boundary.js";
import {
  applyPriorityAppConfig,
  applyMode,
  applyPlannedActions,
  armDiagnostics,
  createDryRunPlan,
  describeElevatedAction,
  disarmDiagnostics,
  discoverPriorityAppInstallations,
  ensureDataDir,
  getLearnedApps,
  getLearningHistory,
  getIncidentLearningReport,
  getArchitecture,
  getSelfHealth,
  getAttribution,
  getEfficacy,
  getUpdates,
  getPriorityAppSessionHistory,
  getFailureDiagnostics,
  getStatus,
  getObserverState,
  getWhy,
  runSimulation,
  getGames,
  rescanGames,
  setGameVerdict,
  labFrameCheck,
  getDesktopComfort,
  setDesktopComfort,
  labNetworkAdapters,
  labRestartAdapter,
  labIrqAudit,
  labIrqApply,
  labIrqRevert,
  labGpuThieves,
  labInterruptions,
  labEcoCageAction,
  labHzCheck,
  labVramGuard,
  labDriveBench,
  labMouseStatus,
  labMouseApply,
  labMouseRestore,
  inspectCrashRecovery,
  panicRestore,
  readAudit,
  readState,
  releaseMemory,
  relieveCpu,
  relieveGpu,
  restoreSessionApps,
  runNetworkDiagnosis,
  runNetworkAction,
  runStressInvestigation,
  setAutomationSetting,
  setAutonomy,
  setLearningInfluence,
  setLearnedAppDecision,
  getSelfTreatment,
  startPriorityAppSession,
  startObserverLoop,
  stopObserverLoop
} from "./system.js";
import { restoreOrphanedLatches } from "./competitive-tuning.js";

const port = Number(process.env.PC_CONTROL_PORT || 8792);
const host = process.env.PC_CONTROL_HOST || "127.0.0.1";
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function crashDiagnostic(reason, details = null) {
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    fsSync.writeFileSync(
      path.join(dataDir, "startup-crash.json"),
      JSON.stringify({ ts: new Date().toISOString(), reason, details }, null, 2),
      "utf8"
    );
  } catch {
  }
}

async function runtimeLog(message, details = null) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      message,
      details
    });
    await fs.appendFile(path.join(dataDir, "server-runtime.log"), `${line}\n`, "utf8");
  } catch {
  }
}

function registerFatalHandlers() {
  process.on("uncaughtException", (error) => {
    crashDiagnostic("uncaughtException", { message: error?.message, stack: error?.stack });
    runtimeLog("uncaughtException", { message: error.message, stack: error.stack }).finally(() => {
      process.exit(1);
    });
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : null;
    crashDiagnostic("unhandledRejection", { message: error?.message || String(reason), stack: error?.stack || null });
    runtimeLog("unhandledRejection", { message: error?.message || String(reason), stack: error?.stack || null }).finally(() => {
      process.exit(1);
    });
  });
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  const safePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = path.normalize(path.join(publicDir, safePath));
  const relative = path.relative(publicDir, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(target);
    const type = contentTypes[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "POST") {
    const sid = req.headers["x-pc-session"] || "";
    if (!isActiveSession(sid)) {
      sendJson(res, 409, {
        ok: false,
        superseded: true,
        message: "This window is no longer the active control window. Refresh it to take control."
      });
      return;
    }
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        notifyChange();
      }
    });
  }
  try {
    if (req.method === "POST") await readBody(req);
    if (req.method === "GET" && url.pathname === "/api/stream") {
      handleStream(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/live") {
      sendJson(res, 200, { ok: true, live: getLiveState() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { observer: { running: getObserverState().running === true },
        savedMode: await readSavedMode() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await getStatus({ requireFresh: url.searchParams.get("fresh") === "1" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/why") {
      sendJson(res, 200, await getWhy());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/simulate") {
      sendJson(res, 200, await runSimulation(url.searchParams.get("scenario")));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/lab/network-adapters") {
      sendJson(res, 200, await labNetworkAdapters());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/restart-adapter") {
      sendJson(res, 200, await labRestartAdapter(await readBody(req)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/desktop-comfort") {
      sendJson(res, 200, await getDesktopComfort());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/desktop-comfort") {
      sendJson(res, 200, await setDesktopComfort(await readBody(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/frames") {
      const body = await readBody(req);
      sendJson(res, 200, await labFrameCheck({ seconds: body.seconds }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/gpu-thieves") {
      sendJson(res, 200, await labGpuThieves());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/lab/interruptions") {
      sendJson(res, 200, await labInterruptions({ limit: Number(url.searchParams.get("limit")) || 50 }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/eco-cage") {
      const body = await readBody(req);
      sendJson(res, 200, await labEcoCageAction(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/hz-check") {
      sendJson(res, 200, await labHzCheck());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/vram") {
      sendJson(res, 200, await labVramGuard());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/drive-bench") {
      sendJson(res, 200, await labDriveBench());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/lab/mouse") {
      sendJson(res, 200, await labMouseStatus());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/mouse/apply") {
      const body = await readBody(req);
      sendJson(res, 200, await labMouseApply(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/mouse/restore") {
      sendJson(res, 200, await labMouseRestore());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/lab/irq") {
      sendJson(res, 200, await labIrqAudit());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/irq/apply") {
      sendJson(res, 200, await labIrqApply());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lab/irq/revert") {
      sendJson(res, 200, await labIrqRevert());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/games") {
      sendJson(res, 200, await getGames());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/games/scan") {
      sendJson(res, 200, await rescanGames());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/games/mark") {
      const body = await readBody(req);
      sendJson(res, 200, await setGameVerdict(body));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/architecture") {
      sendJson(res, 200, await getArchitecture({ requireFresh: url.searchParams.get("fresh") === "1" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/modes") {
      sendJson(res, 200, { modes });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/audit") {
      const days = Number(url.searchParams.get("days") || auditDisplayDays);
      const limit = Number(url.searchParams.get("limit") || 0);
      const format = String(url.searchParams.get("format") || "json").toLowerCase();
      const audit = await readAudit({ days, limit });
      if (["readable", "html", "friendly"].includes(format)) {
        sendHtml(res, 200, renderReadableAuditExport({
          audit,
          windowDays: days,
          rawHref: `/api/audit?days=${encodeURIComponent(days)}&limit=${encodeURIComponent(limit)}&format=json`
        }));
        return;
      }
      sendJson(res, 200, {
        audit,
        windowDays: days
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workload/discover") {
      sendJson(res, 200, await discoverPriorityAppInstallations());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions/health/history") {
      sendJson(res, 200, await getPriorityAppSessionHistory());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/diagnostics/failures") {
      sendJson(res, 200, await getFailureDiagnostics());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/learning/apps") {
      sendJson(res, 200, await getLearnedApps());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/learning/history") {
      const profileId = url.searchParams.get("profile") || null;
      const limit = url.searchParams.get("limit");
      sendJson(res, 200, await getLearningHistory({ profileId, limit: limit ? Number(limit) : undefined }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/learning/incidents") {
      sendJson(res, 200, await getIncidentLearningReport({ requireFresh: url.searchParams.get("fresh") === "1" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/self-health") {
      sendJson(res, 200, await getSelfHealth());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/self-treatment") {
      sendJson(res, 200, await getSelfTreatment());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/attribution") {
      sendJson(res, 200, await getAttribution());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/efficacy") {
      sendJson(res, 200, await getEfficacy());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/updates") {
      sendJson(res, 200, await getUpdates({ force: url.searchParams.get("refresh") === "1" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mode") {
      const body = await readBody(req);
      sendJson(res, 200, await applyMode(body.modeId, body.dryRun !== false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/plan/dry-run") {
      const body = await readBody(req);
      sendJson(res, 200, await createDryRunPlan(body.modeId || null));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/actions/apply") {
      const body = await readBody(req);
      sendJson(res, 200, await applyPlannedActions(body.correlationId));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/restore/panic") {
      const body = await readBody(req);
      sendJson(res, 200, await panicRestore(body.dryRun !== false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/diagnostics/stress-investigation") {
      const body = await readBody(req);
      sendJson(res, 200, await runStressInvestigation(body.seconds || 60));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/network/action") {
      const body = await readBody(req);
      sendJson(res, 200, await runNetworkAction(body.actionId, body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/network/diagnose") {
      const body = await readBody(req);
      sendJson(res, 200, await runNetworkDiagnosis({ dryRun: body.dryRun === true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/memory/release") {
      const body = await readBody(req);
      sendJson(res, 200, await releaseMemory({ dryRun: body.dryRun === true, minWorkingMB: body.minWorkingMB }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cpu/relieve") {
      const body = await readBody(req);
      sendJson(res, 200, await relieveCpu({ dryRun: body.dryRun === true, capPct: body.capPct, seconds: body.seconds }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/gpu/relieve") {
      const body = await readBody(req);
      sendJson(res, 200, await relieveGpu({ dryRun: body.dryRun === true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/diagnostics/traps/arm") {
      const body = await readBody(req);
      sendJson(res, 200, await armDiagnostics(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/diagnostics/traps/disarm") {
      const body = await readBody(req);
      sendJson(res, 200, await disarmDiagnostics(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/autonomy") {
      const body = await readBody(req);
      sendJson(res, 200, await setAutonomy(body.autonomy, body.pinned ?? null));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/automations") {
      const body = await readBody(req);
      sendJson(res, 200, await setAutomationSetting(body.key, body.value));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/learning/apps/decision") {
      const body = await readBody(req);
      sendJson(res, 200, await setLearnedAppDecision(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/learning/influence") {
      const body = await readBody(req);
      sendJson(res, 200, await setLearningInfluence(body.enabled));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/health/start") {
      const body = await readBody(req);
      sendJson(res, 200, await startPriorityAppSession(body.dryRun !== false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/restore") {
      const body = await readBody(req);
      sendJson(res, 200, await restoreSessionApps(body.dryRun !== false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session/prep") {
      const body = await readBody(req);
      sendJson(res, 200, await applyPriorityAppConfig(body.dryRun !== false));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/action/elevated") {
      const body = await readBody(req);
      sendJson(res, 200, await describeElevatedAction(body.actionId, body.dryRun !== false));
      return;
    }

    sendJson(res, 404, { ok: false, message: "API route not found." });
  } catch (error) {
    if ([408, 413].includes(error.status)) res.setHeader("Connection", "close");
    sendJson(res, error.status || 500, {
      ok: false,
      message: error?.message || String(error)
    });
  }
}

export async function createServer({ ready = () => true, apiHandler = handleApi, healthOnly = false,
  authorize = () => true } = {}) {
  return http.createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 15000 }, async (req, res) => {
    try {
      localRequestUrl(req);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (!authorize(req)) {
        sendJson(res, 401, { ok: false, message: "Managed engine authentication required." });
        return;
      }
      if (!ready()) {
        sendJson(res, 503, { ok: false, message: "PC Control Plane is starting or shutting down. Try again shortly." });
        return;
      }
      if (healthOnly) {
        if (req.method !== "GET" || req.url !== "/api/health") {
          sendJson(res, 403, { ok: false, message: "The managed engine exposes read-only health checks only." });
          return;
        }
        await apiHandler(req, res);
        return;
      }
      if (req.method === "GET" && req.url?.split("?")[0] === "/comfort") {
        res.writeHead(302, { Location: "/comfort.html" });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url?.split("?")[0] === "/lab") {
        res.writeHead(302, { Location: "/lab.html" });
        res.end();
        return;
      }
      if (req.url?.startsWith("/api/")) {
        await apiHandler(req, res);
        return;
      }
      await serveStatic(req, res);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.setHeader("Connection", "close");
      sendJson(res, error.status || 500, { ok: false, message: error.status ? error.message : "The request could not be completed. Check status before trying again." });
    }
  });
}

async function acquireLockWithRetry(signal, attempts = 12, delayMs = 300) {
  let result = await acquireSingleInstanceLock();
  for (let i = 0; !result.ok && i < attempts; i++) {
    await waitForRetry(delayMs, undefined, { signal });
    signal.throwIfAborted();
    result = await acquireSingleInstanceLock();
  }
  return result;
}

export async function listenWithRetry(server, { attempts = 12, delayMs = 300, bindPort = port, bindHost = host, signal } = {}) {
  for (let tries = 0; ; tries++) {
    signal?.throwIfAborted();
    try {
      await new Promise((resolve, reject) => {
        const clear = () => { server.removeListener("error", failed); server.removeListener("listening", listening); };
        const failed = (error) => { clear(); reject(error); };
        const listening = () => { clear(); resolve(); };
        server.once("error", failed);
        server.once("listening", listening);
        try { server.listen(bindPort, bindHost); } catch (error) { failed(error); }
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || tries >= attempts) throw error;
      await waitForRetry(delayMs, undefined, { signal });
    }
  }
}

export function superviseInput(input, shutdown) {
  input.once("end", () => shutdown("supervisor-disconnected"));
  input.once("error", () => shutdown("supervisor-input-failed"));
  input.resume();
}

function registerShutdown(engine, managed) {
  let requested = false;
  const shutdown = (signal) => {
    if (requested) return;
    requested = true;
    if (managed) process.stdin.pause();
    void runtimeLog("server.shutdown", { signal });
    engine.stop().catch((error) => {
      crashDiagnostic("shutdown-incomplete", { message: error.message });
      console.error("Shutdown could not be verified; ownership was not released.", error.message);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  if (managed) superviseInput(process.stdin, shutdown);
}

async function readSavedMode() {
  try {
    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    const mode = modes.find(mode => mode.id === saved?.modeId);
    if (mode) return { status: "saved", modeId: mode.id };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", modeId: null };
  }
  return { status: "unavailable", modeId: null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes("--read-engine-state")) {
  if (process.argv.length !== 3) {
    console.error("--read-engine-state must be used alone.");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ schema: "pc-control-plane-saved-state/v1", ...await readSavedMode() }));
  }
} else if (isMain && process.argv.includes("--check")) {
  await ensureDataDir();
  const indexPath = path.join(publicDir, "index.html");
  await fs.access(indexPath);
  console.log(`PC Control Plane check passed at ${fileURLToPath(import.meta.url)}`);
} else if (isMain) {
  console.error("Source preview only: Windows runtime startup is withheld pending adapter and hardware qualification.");
  process.exit(2);
  const readOnly = process.argv[2] === "--managed-read-only";
  const managed = readOnly || process.argv[2] === "--managed-worker";
  const probeKey = managed ? process.env.PC_CONTROL_PROBE_KEY || "" : "";
  if (managed) delete process.env.PC_CONTROL_PROBE_KEY;
  if (process.argv.length !== (managed ? 3 : 2) || (managed && process.stdin.isTTY)) {
    console.error("Managed startup requires redirected input and no additional arguments.");
    process.exit(2);
  }
  if (managed && (!process.env.PC_CONTROL_DATA_DIR || !process.env.PC_CONTROL_OWNERSHIP_DIR)) {
    console.error("Managed startup requires explicit data and ownership directories.");
    process.exit(1);
  }
  if (managed && !/^[a-f0-9]{64}$/.test(probeKey)) {
    console.error("Managed engine authentication is required.");
    process.exit(1);
  }
  if (managed && (!["127.0.0.1", "::1", "localhost"].includes(host) ||
      !Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error("Managed startup requires a valid loopback listener.");
    process.exit(1);
  }
  if (managed) {
    for (const variable of ["PC_CONTROL_DATA_DIR", "PC_CONTROL_OWNERSHIP_DIR"]) {
      const directory = path.resolve(process.env[variable]);
      const info = await fs.lstat(directory).catch(() => null);
      const resolved = info?.isDirectory() ? await fs.realpath(directory).catch(() => null) : null;
      if (!resolved || path.relative(directory, resolved) !== "") {
        console.error(`${variable} must be an existing directory, not a link.`);
        process.exit(1);
      }
    }
  }
  registerFatalHandlers();
  try {
    if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Only a loopback listener is supported.");
    let engine;
    const server = await createServer({
      ready: () => engine?.phase === "ready",
      healthOnly: managed,
      apiHandler: managed ? (_req, res) => sendJson(res, 200, {
        pid: process.pid,
        mode: readOnly ? "read-only" : "worker",
        observer: { running: getObserverState().running === true }
      }) : undefined,
      authorize: managed ? (req) => {
        const supplied = req.headers["x-pc-probe-key"];
        return typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied) &&
            timingSafeEqual(Buffer.from(supplied), Buffer.from(probeKey));
      } : undefined
    });
    engine = createEngineLifecycle({
      acquire: acquireLockWithRetry,
      listen: (signal) => listenWithRetry(server, { signal }),
      recover: async () => {
        if (readOnly) return;
        await ensureDataDir();
        const bootState = await readState();
        if (bootState.automations?.crashRecovery !== false) await inspectCrashRecovery();
        const restored = await restoreOrphanedLatches();
        if (restored.restored) await runtimeLog("competitive-tuning.orphan-restore", restored);
      },
      start: readOnly ? () => {} : () => startObserverLoop(undefined, { interactiveDesktop: !managed }),
      stop: async () => {
        if (readOnly) return;
        const liveDrain = stopLiveTelemetry();
        const observerDrain = stopObserverLoop();
        const results = await Promise.allSettled([liveDrain, observerDrain]);
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Background operations did not drain.");
      },
      close: () => new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
      }),
      release: async () => {
        await drainAuditWrites();
        return releaseSingleInstanceLock();
      }
    });
    registerShutdown(engine, managed);
    await engine.start();
    if (engine.phase === "ready") {
      const address = server.address();
      await runtimeLog("server.listen", { host, port: address.port });
      if (engine.phase === "ready" && server.listening) {
        if (managed)
          console.log(JSON.stringify({ schema: "pc-control-plane-ready/v1", pid: process.pid, port: address.port }));
        else
          console.log(`PC Control Plane running at http://${host}:${address.port}`);
      }
    }
  } catch (err) {
    if (managed) process.stdin.pause();
    crashDiagnostic("startup-sequence-failed", { message: err?.message || String(err), stack: err?.stack || null });
    try { await runtimeLog("startup-sequence-failed", { message: err?.message || String(err), stack: err?.stack || null }); } catch {}
    try { console.error(`PC Control Plane startup failed: ${err?.message || err}`); } catch {}
    process.exitCode = 1;
  }
}
