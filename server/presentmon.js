import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const ENV_OVERRIDE = process.env.PC_CONTROL_PRESENTMON;
const PRESENTMON_DISCOVERY_TTL_MS = Number(process.env.PC_CONTROL_PRESENTMON_DISCOVERY_TTL_MS || 5 * 60 * 1000);
const COMMON_NAMES = [
  "presentmon.exe",
  "PresentMon.exe",
  "PresentMonCli.exe",
  "PresentMon-2.4.1-x64.exe",
  "PresentMon-2.3.1-x64.exe",
  "PresentMon-2.3.0-x64.exe",
  "PresentMon-1.10.0-x64.exe"
];
const COMMON_DIRS = [
  path.join(process.env.LOCALAPPDATA || "C:\\", "Microsoft", "WinGet", "Packages", "Intel.PresentMon.Console_Microsoft.Winget.Source_8wekyb3d8bbwe"),
  path.join(process.env.LOCALAPPDATA || "C:\\", "Microsoft", "WinGet", "Packages", "Intel.PresentMon_Microsoft.Winget.Source_8wekyb3d8bbwe"),
  "C:\\Program Files\\PresentMon",
  "C:\\Program Files\\Intel\\PresentMon",
  "C:\\Program Files\\Intel\\PresentMon Console",
  "C:\\Tools\\PresentMon",
  path.join(process.env.LOCALAPPDATA || "C:\\", "PresentMon")
];
const SEARCH_ROOTS = [
  path.join(process.env.LOCALAPPDATA || "C:\\", "Microsoft", "WinGet", "Packages"),
  "C:\\Program Files\\Intel",
  "C:\\Program Files\\PresentMon",
  path.join(process.env.LOCALAPPDATA || "C:\\", "PresentMon")
];
const PRESENTMON_EXE_RE = /^presentmon(?:cli)?(?:-\d+(?:\.\d+)*-x64)?\.exe$/i;

let cachedPath; // undefined = not looked up, null = looked up & absent
let cachedAt = 0;

function existsExecutable(filePath) {
  return fs
    .access(filePath, fs.constants.X_OK)
    .then(() => true)
    .catch(() =>
      fs
        .access(filePath)
        .then(() => true)
        .catch(() => false)
    );
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function findPresentMonInTree(root, { maxDepth = 5, maxEntries = 2500 } = {}) {
  let visited = 0;
  async function visit(dir, depth) {
    if (!dir || visited >= maxEntries || depth > maxDepth) {
      return null;
    }
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const files = entries
      .filter((entry) => entry.isFile() && PRESENTMON_EXE_RE.test(entry.name))
      .sort((a, b) => {
        const aConsole = /presentmon\.exe/i.test(a.name) ? 0 : 1;
        const bConsole = /presentmon\.exe/i.test(b.name) ? 0 : 1;
        return aConsole - bConsole || a.name.localeCompare(b.name);
      });
    for (const file of files) {
      const candidate = path.join(dir, file.name);
      if (await existsExecutable(candidate)) {
        return candidate;
      }
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => {
        const aConsole = /PresentMon\.Console/i.test(a.name) ? 0 : 1;
        const bConsole = /PresentMon\.Console/i.test(b.name) ? 0 : 1;
        return aConsole - bConsole || a.name.localeCompare(b.name);
      });
    for (const entry of dirs) {
      const found = await visit(path.join(dir, entry.name), depth + 1);
      if (found) {
        return found;
      }
      if (visited >= maxEntries) {
        break;
      }
    }
    return null;
  }
  return visit(root, 0);
}

async function findOnPath() {
  const names = ["presentmon", "presentmon.exe", "PresentMon", "PresentMonCli"];
  for (const name of names) {
    const found = await new Promise((resolve) => {
      execFile("where", [name], { timeout: 4000, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const first = String(stdout).split(/\r?\n/).find(Boolean);
        resolve(first || null);
      });
    });
    if (found && (await existsExecutable(found))) {
      return found;
    }
  }
  return null;
}

export async function findPresentMon() {
  const now = Date.now();
  if (cachedPath !== undefined && now - cachedAt < PRESENTMON_DISCOVERY_TTL_MS) {
    return cachedPath;
  }
  const envOverride = process.env.PC_CONTROL_PRESENTMON || ENV_OVERRIDE;
  if (envOverride && (await existsExecutable(envOverride))) {
    cachedPath = envOverride;
    cachedAt = now;
    return cachedPath;
  }
  for (const dir of unique(COMMON_DIRS)) {
    for (const name of COMMON_NAMES) {
      const candidate = path.join(dir, name);
      if (await existsExecutable(candidate)) {
        cachedPath = candidate;
        cachedAt = now;
        return cachedPath;
      }
    }
  }
  const fromPath = await findOnPath();
  if (fromPath) {
    cachedPath = fromPath;
    cachedAt = now;
    return cachedPath;
  }
  for (const root of unique(SEARCH_ROOTS)) {
    const found = await findPresentMonInTree(root);
    if (found) {
      cachedPath = found;
      cachedAt = now;
      return cachedPath;
    }
  }
  cachedPath = null;
  cachedAt = now;
  return cachedPath;
}

export function parseFrameCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const frameCol = header.findIndex((h) =>
    ["msbetweenpresents", "msbetweendisplaychange", "frametime", "ms_between_presents"].includes(h)
  );
  if (frameCol < 0) {
    return [];
  }
  const frames = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    const value = Number(cols[frameCol]);
    if (Number.isFinite(value) && value > 0 && value < 1000) {
      frames.push(value);
    }
  }
  return frames;
}

export function summarizeFrames(frameTimesMs) {
  const frames = (frameTimesMs || []).filter((v) => Number.isFinite(v) && v > 0);
  if (frames.length < 10) {
    return { available: false, frames: frames.length };
  }
  const sorted = [...frames].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const ms99 = pct(0.99);
  const ms999 = pct(0.999);
  const stutters = frames.filter((v) => v > median * 2).length;
  const toFps = (ms) => (ms > 0 ? Math.round(1000 / ms) : null);
  return {
    available: true,
    frames: frames.length,
    avgFps: toFps(mean),
    p1LowFps: toFps(ms99),
    p01LowFps: toFps(ms999),
    stutterCount: stutters,
    stutterRatio: Math.round((stutters / frames.length) * 1000) / 1000
  };
}

export function parsePresentDetails(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return { available: false };
  }
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const modeCol = header.findIndex((h) => ["presentmode", "present_mode"].includes(h));
  const c2pCol = header.findIndex((h) =>
    ["msclicktophotonlatency", "clicktophotonlatency", "msinputlatency"].includes(h)
  );
  const modes = {};
  const c2p = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",");
    if (modeCol >= 0) {
      const mode = String(cols[modeCol] || "").trim();
      if (mode) modes[mode] = (modes[mode] || 0) + 1;
    }
    if (c2pCol >= 0) {
      const v = Number(cols[c2pCol]);
      if (Number.isFinite(v) && v > 0 && v < 1000) c2p.push(v);
    }
  }
  const total = Object.values(modes).reduce((a, b) => a + b, 0);
  const dominant = Object.entries(modes).sort((a, b) => b[1] - a[1])[0] || null;
  const composed = dominant ? /composed/i.test(dominant[0]) : false;
  const sortedC2p = [...c2p].sort((a, b) => a - b);
  return {
    available: total > 0 || c2p.length > 0,
    presentModes: modes,
    dominantMode: dominant ? dominant[0] : null,
    dominantSharePct: dominant && total ? Math.round((dominant[1] / total) * 100) : null,
    composedFlip: composed,
    flipAdvice: dominant
      ? (composed
        ? `Frames are reaching the screen via ${dominant[0]} — the compositor is adding ~1 frame of latency. Fullscreen exclusive, or the per-game "Optimizations for windowed games" flag, would restore the direct flip path.`
        : `Frames use ${dominant[0]} — the direct low-latency path. Nothing to fix.`)
      : null,
    clickToPhoton: c2p.length >= 5 ? {
      samples: c2p.length,
      medianMs: Math.round(sortedC2p[Math.floor(sortedC2p.length / 2)] * 10) / 10,
      p95Ms: Math.round(sortedC2p[Math.min(sortedC2p.length - 1, Math.floor(sortedC2p.length * 0.95))] * 10) / 10
    } : null
  };
}

export async function captureFrameStats({ processName = null, seconds = 6 } = {}) {
  const exe = await findPresentMon();
  if (!exe) {
    return { available: false, reason: "PresentMon not found" };
  }
  const out = path.join(os.tmpdir(), `pccp-frames-${Date.now()}.csv`);
  const args = [
    "--timed",
    String(Math.max(2, Math.min(20, seconds))),
    "--output_file",
    out,
    "--terminate_after_timed",
    "--stop_existing_session",
    "--no_top"
  ];
  if (processName) {
    args.push("--process_name", processName.endsWith(".exe") ? processName : `${processName}.exe`);
  }

  const ran = await new Promise((resolve) => {
    execFile(exe, args, { timeout: (seconds + 10) * 1000, windowsHide: true }, (error) => {
      resolve(!error);
    });
  });

  let csv = "";
  try {
    csv = await fs.readFile(out, "utf8");
    await fs.unlink(out).catch(() => {});
  } catch {
    return { available: false, reason: ran ? "no output file" : "capture failed" };
  }
  const stats = summarizeFrames(parseFrameCsv(csv));
  const delivery = parsePresentDetails(csv);
  return { ...stats, delivery: delivery.available ? delivery : null, source: "presentmon", capturedAt: new Date().toISOString() };
}

export async function presentMonStatus() {
  const exe = await findPresentMon();
  return { available: Boolean(exe), path: exe || null };
}
