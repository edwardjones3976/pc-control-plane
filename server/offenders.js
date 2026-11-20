import path from "node:path";
import { dataDir } from "./config.js";
import { appendAudit, readJson, runPowerShell, writeJson } from "./system.js";

const suspendedPath = path.join(dataDir, "suspended-offenders.json");
const ladder = new Map(); // pid -> { name, sightings, stage, strikes, lastActionAt }
const STAGE_LABELS = ["observe"];

const NEVER_TOUCH_NAMES = new Set([
  "memory compression",
  "system",
  "idle",
  "registry",
  "secure system",
  "csrss",
  "smss",
  "wininit",
  "winlogon",
  "services",
  "lsass",
  "svchost",
  "dwm",
  "fontdrvhost",
  "audiodg",
  "explorer",
  "ntoskrnl"
]);

function isNeverTouch(process, telemetry) {
  const name = String(process.name || "").toLowerCase();
  if (NEVER_TOUCH_NAMES.has(name)) {
    return true;
  }
  if (Number(process.pid) <= 100) {
    return true;
  }
  const priorityPid = Number(telemetry?.priorityApp?.process?.pid);
  if (Number.isFinite(priorityPid) && Number(process.pid) === priorityPid) {
    return true;
  }
  return false;
}

function pruneLadder(currentPids) {
  for (const pid of ladder.keys()) {
    if (!currentPids.has(pid)) {
      ladder.delete(pid);
    }
  }
}

async function readSuspendedRegistry() {
  const registry = await readJson(suspendedPath, { suspended: [] });
  return Array.isArray(registry.suspended) ? registry.suspended : [];
}

async function writeSuspendedRegistry(suspended) {
  await writeJson(suspendedPath, { schema: "pc-control-plane-suspended/v1", updatedAt: new Date().toISOString(), suspended });
}

const NT_RESUME_SIG =
  '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);';

async function resumeProcess(pid) {
  const result = await runPowerShell(
    `
$ErrorActionPreference = 'Stop'
try {
  $sig = '${NT_RESUME_SIG}'
  $nt = Add-Type -MemberDefinition $sig -Name NT -Namespace Win32 -PassThru -ErrorAction SilentlyContinue
  if (-not $nt) { $nt = [Win32.NT] }
  $p = Get-Process -Id ${Number(pid)}
  $rc = $nt::NtResumeProcess($p.Handle)
  $alive = [bool](Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue)
  [pscustomobject]@{ ok = ($rc -eq 0 -and $alive); rc = $rc; alive = $alive; name = $p.ProcessName } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
`,
    { timeoutMs: 10000 }
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, error: result.stderr || "resume readback failed" };
  }
}

export async function handleOffenders({ state, telemetry, policy }) {
  const outcome = { acted: null, recommended: [], skipped: 0 };
  const advisoryOffenders = (policy?.offenders || [])
    .filter((process) => Number.isFinite(Number(process.pid)))
    .filter((process) => !process.gpuFeedBias)
    .filter((process) => !isNeverTouch(process, telemetry));
  pruneLadder(new Set(advisoryOffenders.map((process) => Number(process.pid))));
  outcome.skipped = advisoryOffenders.length;
  return outcome;
}

export async function resumeAllSuspended(reason = "restore") {
  const suspended = await readSuspendedRegistry();
  if (!suspended.length) {
    return { resumed: [], failed: [] };
  }
  const resumed = [];
  const failed = [];
  for (const item of suspended) {
    const result = await resumeProcess(item.pid);
    const processGone = result.alive === false || /cannot find a process/i.test(String(result.error || ""));
    if (result.ok || processGone) {
      resumed.push(item);
      if (result.ok && item.priorityBefore && item.priorityBefore !== "BelowNormal") {
        await runPowerShell(
          `try { (Get-Process -Id ${Number(item.pid)}).PriorityClass = '${item.priorityBefore}' } catch {}`,
          { timeoutMs: 8000 }
        );
      }
    } else {
      failed.push({ ...item, error: result.error || `rc=${result.rc}` });
    }
    ladder.delete(Number(item.pid));
  }
  await writeSuspendedRegistry(failed);
  await appendAudit({
    level: failed.length ? "warn" : "action",
    action: "offender.resume-all",
    message: `Resumed ${resumed.length} suspended process(es) (${reason}).${failed.length ? ` ${failed.length} failed.` : ""}`,
    details: { resumed: resumed.map((item) => `${item.name}:${item.pid}`), failed }
  });
  return { resumed, failed };
}

export function getOffenderPipelineState() {
  return {
    tracked: [...ladder.entries()].map(([pid, entry]) => ({ pid, ...entry })),
    stageLabels: STAGE_LABELS
  };
}
