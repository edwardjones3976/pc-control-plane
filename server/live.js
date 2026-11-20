import os from "node:os";
import { execFile } from "node:child_process";
import { captureLiveSensorTelemetry, getStatus } from "./system.js";

const FAST_MS_ACTIVE = 1000;
const FAST_MS_IDLE = 1500;
const STATUS_MS_ACTIVE = 30000;
const STATUS_MS_IDLE = 12000;
const LIVE_SENSOR_MS = 2500;

const clients = new Set();
let fastTimer = null;
let statusTimer = null;
let sessionActive = false;
let nvidiaAvailable = true;
let lastCpuTimes = null;
let pushingStatus = false;
let pushingFast = false;
let stopping = false;
const liveTasks = new Set();
const liveSensorCache = { value: null, at: 0, pending: null };

function trackLiveTask(promise) {
  liveTasks.add(promise);
  promise.then(() => liveTasks.delete(promise), () => liveTasks.delete(promise));
  return promise;
}

let activeSessionId = null;
const retiredSessions = new Set();
const MAX_RETIRED = 200;

function retire(sid) {
  if (!sid) {
    return;
  }
  retiredSessions.add(sid);
  if (retiredSessions.size > MAX_RETIRED) {
    const recent = [...retiredSessions].slice(-MAX_RETIRED);
    retiredSessions.clear();
    for (const s of recent) {
      retiredSessions.add(s);
    }
  }
}

function sendSuperseded(res, reason) {
  try {
    res.write(`event: superseded\ndata: ${JSON.stringify({ reason })}\n\n`);
    res.end();
  } catch {
  }
}

export function getActiveSessionId() {
  return activeSessionId;
}

export function isActiveSession(sid) {
  if (!activeSessionId) {
    return true;
  }
  return Boolean(sid) && sid === activeSessionId;
}

function cpuPercent() {
  const cpus = os.cpus();
  const totals = cpus.reduce(
    (acc, cpu) => {
      const t = cpu.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 }
  );
  let pct = null;
  if (lastCpuTimes) {
    const dTotal = totals.total - lastCpuTimes.total;
    const dIdle = totals.idle - lastCpuTimes.idle;
    if (dTotal > 0) {
      pct = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
    }
  }
  lastCpuTimes = totals;
  return pct;
}

function ramSample() {
  const totalB = os.totalmem();
  const freeB = os.freemem();
  return {
    ramTotalGB: Math.round((totalB / 1024 ** 3) * 10) / 10,
    ramFreeGB: Math.round((freeB / 1024 ** 3) * 10) / 10,
    ramUsedPct: totalB > 0 ? Math.round(((totalB - freeB) / totalB) * 1000) / 10 : null
  };
}

function gpuSample() {
  if (!nvidiaAvailable) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=temperature.gpu,power.draw,power.limit,utilization.gpu,memory.used,memory.total,clocks.gr,clocks.mem",
        "--format=csv,noheader,nounits"
      ],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          if (error.code === "ENOENT") {
            nvidiaAvailable = false;
          }
          resolve(null);
          return;
        }
        const p = String(stdout).trim().split(/,\s*/);
        if (p.length < 8) {
          resolve(null);
          return;
        }
        resolve({
          temperatureC: Number(p[0]),
          powerDrawW: Number(p[1]),
          powerLimitW: Number(p[2]),
          utilizationPct: Number(p[3]),
          memoryUsedMB: Number(p[4]),
          memoryTotalMB: Number(p[5]),
          graphicsClockMHz: Number(p[6]),
          memoryClockMHz: Number(p[7])
        });
      }
    );
  });
}

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      if (res.destroyed || res.writableEnded) {
        clients.delete(res);
        continue;
      }
      if (res.writableLength > 256 * 1024) {
        clients.delete(res);
        res.destroy();
        continue;
      }
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
  stopLoopsIfIdle();
}

async function fastTick() {
  if (clients.size === 0 || pushingFast || stopping) {
    return;
  }
  pushingFast = true;
  try {
    const sensors = await liveSensorSample();
    const gpu = await gpuSample();
    if (!stopping) broadcast("fast", {
      at: new Date().toISOString(), cpuLoadPct: cpuPercent(), ...ramSample(), gpu, sensors
    });
  } catch (error) {
    broadcast("liveerror", { message: error?.message || String(error) });
  } finally {
    pushingFast = false;
  }
}

async function liveSensorSample() {
  const now = Date.now();
  if (liveSensorCache.value && now - liveSensorCache.at < LIVE_SENSOR_MS) {
    return liveSensorCache.value;
  }
  if (!liveSensorCache.pending) {
    liveSensorCache.pending = captureLiveSensorTelemetry({ timeoutMs: 3000 })
      .then((sample) => {
        if (sample) {
          liveSensorCache.value = sample;
          liveSensorCache.at = Date.now();
        }
        return liveSensorCache.value;
      })
      .catch(() => liveSensorCache.value)
      .finally(() => {
        liveSensorCache.pending = null;
      });
  }
  if (liveSensorCache.value) {
    return liveSensorCache.value;
  }
  return liveSensorCache.pending;
}

async function statusTick(options = {}) {
  if (clients.size === 0 || pushingStatus || stopping) {
    return;
  }
  pushingStatus = true;
  try {
    const status = await getStatus({ requireFresh: options.requireFresh === true });
    const nowActive = Boolean(status?.telemetry?.priorityApp?.running);
    if (nowActive !== sessionActive) {
      sessionActive = nowActive;
      rescheduleFast();
      rescheduleStatus();
    }
    broadcast("status", status);
  } catch (error) {
    broadcast("liveerror", { message: error?.message || String(error) });
  } finally {
    pushingStatus = false;
  }
}

function rescheduleFast() {
  if (fastTimer) {
    clearInterval(fastTimer);
    fastTimer = null;
  }
  if (clients.size > 0 && !stopping) {
    fastTimer = setInterval(() => trackLiveTask(fastTick()), sessionActive ? FAST_MS_ACTIVE : FAST_MS_IDLE);
    trackLiveTask(fastTick());
    if (fastTimer.unref) {
      fastTimer.unref();
    }
  }
}

function rescheduleStatus() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (clients.size > 0 && !stopping) {
    statusTimer = setInterval(() => trackLiveTask(statusTick()), sessionActive ? STATUS_MS_ACTIVE : STATUS_MS_IDLE);
    if (statusTimer.unref) {
      statusTimer.unref();
    }
  }
}

function startLoops() {
  rescheduleFast();
  rescheduleStatus();
}

function stopLoopsIfIdle() {
  if (clients.size > 0) {
    return;
  }
  if (fastTimer) {
    clearInterval(fastTimer);
    fastTimer = null;
  }
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  lastCpuTimes = null;
}

export function handleStream(req, res) {
  if (stopping) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("PC Control Plane is shutting down.");
    return;
  }
  let sid = "";
  try {
    sid = new URL(req.url, "http://localhost").searchParams.get("sid") || "";
  } catch {
    sid = "";
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`retry: 4000\n\n`);
  res.__sid = sid;

  if (sid) {
    if (retiredSessions.has(sid)) {
      sendSuperseded(res, "retired");
      return;
    }
    if (activeSessionId && sid !== activeSessionId) {
      retire(activeSessionId);
      for (const other of [...clients]) {
        if (other.__sid !== sid) {
          retire(other.__sid);
          sendSuperseded(other, "newer-window");
          clients.delete(other);
        }
      }
    }
    activeSessionId = sid;
  }

  clients.add(res);
  startLoops();

  trackLiveTask(statusTick());

  const cleanup = () => {
    clients.delete(res);
    if (res.__sid && res.__sid === activeSessionId
      && ![...clients].some((client) => client.__sid === activeSessionId)) {
      activeSessionId = null;
    }
    stopLoopsIfIdle();
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

export function notifyChange() {
  if (clients.size === 0 || stopping) {
    return;
  }
  setTimeout(() => {
    trackLiveTask(statusTick({ requireFresh: true }));
  }, 150);
}

export async function stopLiveTelemetry() {
  stopping = true;
  for (const res of clients) res.end();
  clients.clear();
  activeSessionId = null;
  stopLoopsIfIdle();
  while (liveTasks.size) await Promise.allSettled([...liveTasks]);
  await liveSensorCache.pending;
}

export function getLiveState() {
  return {
    clients: clients.size,
    sessionActive,
    fastIntervalMs: sessionActive ? FAST_MS_ACTIVE : FAST_MS_IDLE,
    statusIntervalMs: sessionActive ? STATUS_MS_ACTIVE : STATUS_MS_IDLE,
    nvidiaAvailable
  };
}
