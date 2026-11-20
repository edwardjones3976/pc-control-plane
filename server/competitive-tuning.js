
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { dataDir } from "./config.js";
import { isProtectedProcess } from "./policy.js";

export const tuningStatePath = path.join(dataDir, "competitive-tuning.json");
export const focusStealsPath = path.join(dataDir, "focus-steals.jsonl");

const IS_WINDOWS = process.platform === "win32";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

function runPS(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile("powershell.exe", [...PS_ARGS, script], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), error: error ? String(error.message || error) : null });
    });
  });
}

function runNvidiaSmi(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile("nvidia-smi", args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), error: error ? String(error.message || error) : null });
    });
  });
}

function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function emptyState() {
  return {
    schema: "pc-control-plane-competitive-tuning/v1",
    engagedAt: null,
    sessionKey: null,
    gpuClockLocked: false,
    gpuClockFloorMHz: null,
    timerLatchPid: null,
    focusWatcherPid: null,
    nic: null,          // { adapterName, priorValue } when de-moderated
    doPolicy: null,     // { hadValue, priorValue } when DO bandwidth capped
    bitsSuspended: false,
    engagements: [],    // °C-at-engagement samples for this session
    notes: []
  };
}

let memState = null;

export async function readTuningState() {
  if (memState) return memState;
  try {
    memState = { ...emptyState(), ...parseJson(await fs.readFile(tuningStatePath, "utf8"), {}) };
  } catch {
    memState = emptyState();
  }
  return memState;
}

async function writeTuningState(next) {
  memState = next;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tuningStatePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function __resetTuningState() { memState = null; }


export function computeGpuClockFloor(maxClockMHz) {
  const max = Number(maxClockMHz);
  if (!Number.isFinite(max) || max <= 0) return null;
  const floor = Math.floor((max * 0.9) / 15) * 15;
  return Math.max(210, Math.min(floor, max));
}

export function evaluateMmcss(values = {}) {
  const issues = [];
  const v = values || {};
  if (Number(v.SystemResponsiveness) > 10) {
    issues.push(`SystemResponsiveness=${v.SystemResponsiveness} reserves ${v.SystemResponsiveness}% CPU for background work (gaming-tuned boxes use 10 or less).`);
  }
  if (Number(v.NetworkThrottlingIndex) !== 0xffffffff && Number(v.NetworkThrottlingIndex) <= 10) {
    issues.push(`NetworkThrottlingIndex=${v.NetworkThrottlingIndex} throttles network packet processing during multimedia playback.`);
  }
  if (v.GPUPriority !== undefined && Number(v.GPUPriority) < 8) {
    issues.push(`Games task GPU Priority=${v.GPUPriority} (expected 8).`);
  }
  if (v.SchedulingCategory !== undefined && String(v.SchedulingCategory).toLowerCase() !== "high") {
    issues.push(`Games task Scheduling Category=${v.SchedulingCategory} (expected High).`);
  }
  return { ok: issues.length === 0, issues };
}

export function evaluateDpcSample(cores = []) {
  const rows = Array.isArray(cores) ? cores : [];
  let worst = null;
  for (const row of rows) {
    const dpc = Number(row.dpcAvgPct) || 0;
    const isr = Number(row.interruptAvgPct) || 0;
    if (!worst || dpc + isr > (Number(worst.dpcAvgPct) || 0) + (Number(worst.interruptAvgPct) || 0)) {
      worst = row;
    }
  }
  const dpc = Number(worst?.dpcAvgPct) || 0;
  const isr = Number(worst?.interruptAvgPct) || 0;
  const state = dpc >= 8 || isr >= 10 ? "storm" : dpc >= 3 || isr >= 5 ? "elevated" : "healthy";
  return {
    state,
    worstCore: worst?.core ?? null,
    dpcAvgPct: dpc,
    interruptAvgPct: isr,
    summary: state === "healthy"
      ? "DPC/interrupt time is healthy on every core."
      : `Core ${worst?.core}: ${dpc.toFixed(1)}% DPC / ${isr.toFixed(1)}% interrupt time — ${state === "storm" ? "a driver is stealing real frame time (DPC storm)" : "elevated; worth watching"}.`
  };
}

export async function engageGpuClockLatch({ temps = null } = {}) {
  if (!IS_WINDOWS) return { ok: false, skipped: "not-windows" };
  const state = await readTuningState();
  if (state.gpuClockLocked) return { ok: true, already: true };
  const q = await runNvidiaSmi(["--query-gpu=clocks.max.gr", "--format=csv,noheader,nounits"]);
  const floor = computeGpuClockFloor(q.ok ? q.stdout.split(/\r?\n/)[0] : null);
  if (!floor) return { ok: false, error: q.error || "could not read max graphics clock" };
  await writeTuningState({ ...state, gpuClockLocked: true, gpuClockFloorMHz: floor });
  const r = await runNvidiaSmi(["-lgc", `${floor}`]);
  if (!r.ok) {
    await writeTuningState({ ...(await readTuningState()), gpuClockLocked: false, gpuClockFloorMHz: null });
    return { ok: false, error: `nvidia-smi -lgc failed (needs elevation): ${r.error || r.stderr}` };
  }
  if (temps && (Number.isFinite(Number(temps.cpuC)) || Number.isFinite(Number(temps.gpuC)))) {
    const s = await readTuningState();
    await writeTuningState({
      ...s,
      engagements: [...(s.engagements || []), {
        at: new Date().toISOString(),
        cpuC: Number.isFinite(Number(temps.cpuC)) ? Number(temps.cpuC) : null,
        gpuC: Number.isFinite(Number(temps.gpuC)) ? Number(temps.gpuC) : null
      }].slice(-40)
    });
  }
  return { ok: true, floorMHz: floor };
}

export async function releaseGpuClockLatch(reason = "release") {
  const state = await readTuningState();
  if (!state.gpuClockLocked) return { ok: true, already: true };
  const r = await runNvidiaSmi(["-rgc"]);
  await writeTuningState({ ...state, gpuClockLocked: false, gpuClockFloorMHz: null });
  return { ok: r.ok, reason, error: r.ok ? null : (r.error || r.stderr) };
}

const TIMER_LATCH_SCRIPT = `
$sig = '[DllImport("ntdll.dll")] public static extern int NtSetTimerResolution(int DesiredResolution, bool SetResolution, ref int CurrentResolution);'
Add-Type -MemberDefinition $sig -Name Timer -Namespace Latch
$cur = 0
[Latch.Timer]::NtSetTimerResolution(5000, $true, [ref]$cur) | Out-Null
while ($true) { Start-Sleep -Seconds 3600 }
`;

export async function engageTimerLatch() {
  if (!IS_WINDOWS) return { ok: false, skipped: "not-windows" };
  const state = await readTuningState();
  if (state.timerLatchPid && (await pidAlive(state.timerLatchPid))) return { ok: true, already: true };
  const child = spawn("powershell.exe", [...PS_ARGS, TIMER_LATCH_SCRIPT], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.unref();
  await writeTuningState({ ...state, timerLatchPid: child.pid || null });
  return { ok: Boolean(child.pid), pid: child.pid || null };
}

async function pidAlive(pid) {
  if (pid === null || pid === undefined) return false;
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

async function stopHelper(pid) {
  if (pid === null || pid === undefined) return;
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return;
  try { process.kill(n); } catch { /* already gone */ }
}

export async function releaseTimerLatch() {
  const state = await readTuningState();
  await stopHelper(state.timerLatchPid);
  await writeTuningState({ ...state, timerLatchPid: null });
  return { ok: true };
}

function focusWatcherScript(logPath) {
  return `
$sig = @'
using System; using System.Text; using System.Runtime.InteropServices;
public class FW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$last = -1
while ($true) {
  try {
    $h = [FW]::GetForegroundWindow()
    $fpid = 0
    [void][FW]::GetWindowThreadProcessId($h, [ref]$fpid)
    if ($fpid -ne $last -and $fpid -gt 0) {
      $last = $fpid
      $t = New-Object System.Text.StringBuilder 260
      [void][FW]::GetWindowText($h, $t, 260)
      $p = Get-Process -Id $fpid -ErrorAction SilentlyContinue
      $rec = @{ at = (Get-Date).ToUniversalTime().ToString('o'); pid = $fpid; name = $p.ProcessName; title = $t.ToString() } | ConvertTo-Json -Compress
      Add-Content -Path '${logPath.replace(/\\/g, "\\\\").replace(/'/g, "''")}' -Value $rec
    }
  } catch {}
  Start-Sleep -Milliseconds 400
}
`;
}

export async function engageFocusWatcher() {
  if (!IS_WINDOWS) return { ok: false, skipped: "not-windows" };
  const state = await readTuningState();
  if (state.focusWatcherPid && (await pidAlive(state.focusWatcherPid))) return { ok: true, already: true };
  try {
    const raw = await fs.readFile(focusStealsPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length > 2000) await fs.writeFile(focusStealsPath, `${lines.slice(-1000).join("\n")}\n`, "utf8");
  } catch { /* no log yet */ }
  const child = spawn("powershell.exe", [...PS_ARGS, focusWatcherScript(focusStealsPath)], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.unref();
  await writeTuningState({ ...(await readTuningState()), focusWatcherPid: child.pid || null });
  return { ok: Boolean(child.pid), pid: child.pid || null };
}

export async function releaseFocusWatcher() {
  const state = await readTuningState();
  await stopHelper(state.focusWatcherPid);
  await writeTuningState({ ...state, focusWatcherPid: null });
  return { ok: true };
}

export async function readFocusSteals(limit = 50) {
  try {
    const raw = await fs.readFile(focusStealsPath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => parseJson(line)).filter(Boolean);
  } catch {
    return [];
  }
}

const ENGAGE_NET_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ elevated = $false; nic = $null; bits = $null; doPolicy = $null; mmcss = $null; irq = $null; oneDrive = $null }
try {
  $pr = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $out.elevated = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}

# NIC de-moderation (admin): store prior value, then disable.
if ($out.elevated) {
  $ad = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object -Property LinkSpeed -Descending | Select-Object -First 1
  if ($ad) {
    $prop = Get-NetAdapterAdvancedProperty -Name $ad.Name -DisplayName 'Interrupt Moderation' -ErrorAction SilentlyContinue
    if ($prop) {
      $out.nic = @{ adapterName = $ad.Name; priorValue = $prop.DisplayValue; changed = $false }
      if ($prop.DisplayValue -ne 'Disabled') {
        Set-NetAdapterAdvancedProperty -Name $ad.Name -DisplayName 'Interrupt Moderation' -DisplayValue 'Disabled' -NoRestart:$false
        $out.nic.changed = $true
      }
    } else {
      $out.nic = @{ adapterName = $ad.Name; priorValue = $null; unsupported = $true }
    }
  }
}

# Quiet hours: suspend background BITS jobs; cap DO background bandwidth (admin).
$jobs = @(Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.JobState -eq 'Transferring' -or $_.JobState -eq 'Queued' })
if ($jobs.Count -gt 0) { $jobs | Suspend-BitsTransfer -ErrorAction SilentlyContinue }
$out.bits = @{ suspended = $jobs.Count }
if ($out.elevated) {
  $doKey = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization'
  $prior = (Get-ItemProperty $doKey -Name DOMaxBackgroundDownloadBandwidth -ErrorAction SilentlyContinue).DOMaxBackgroundDownloadBandwidth
  New-Item -Path $doKey -Force | Out-Null
  Set-ItemProperty -Path $doKey -Name DOMaxBackgroundDownloadBandwidth -Value 64 -Type DWord
  $out.doPolicy = @{ hadValue = ($null -ne $prior); priorValue = $prior; capKBps = 64 }
}

# OneDrive: no supported pause API — detect and report only (honesty over theater).
$od = Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object -First 1
if ($od) { $out.oneDrive = @{ running = $true; pid = $od.Id; cpuPct = $null } } else { $out.oneDrive = @{ running = $false } }

# MMCSS audit (read-only).
$sp = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile'
$g = Get-ItemProperty (Join-Path $sp 'Tasks\\Games') -ErrorAction SilentlyContinue
$s = Get-ItemProperty $sp -ErrorAction SilentlyContinue
$out.mmcss = @{
  SystemResponsiveness = $s.SystemResponsiveness
  NetworkThrottlingIndex = $s.NetworkThrottlingIndex
  GPUPriority = $g.'GPU Priority'
  Priority = $g.Priority
  SchedulingCategory = $g.'Scheduling Category'
  SFIOPriority = $g.'SFIO Priority'
}

# IRQ audit (read-only): MSI + affinity policy for GPU and the active NIC.
$irq = @()
foreach ($dev in (Get-PnpDevice -Class Display,Net -Status OK -ErrorAction SilentlyContinue)) {
  $base = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$($dev.InstanceId)\\Device Parameters\\Interrupt Management"
  $msi = (Get-ItemProperty (Join-Path $base 'MessageSignaledInterruptProperties') -Name MSISupported -ErrorAction SilentlyContinue).MSISupported
  $aff = (Get-ItemProperty (Join-Path $base 'Affinity Policy') -Name DevicePolicy -ErrorAction SilentlyContinue).DevicePolicy
  $irq += @{ name = $dev.FriendlyName; class = $dev.Class; instanceId = $dev.InstanceId; msi = $msi; affinityPolicy = $aff }
}
$out.irq = $irq
$out | ConvertTo-Json -Depth 5 -Compress
`;

const RELEASE_NET_SCRIPT_TEMPLATE = (nic, doPolicy) => `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ nicRestored = $false; bitsResumed = 0; doRestored = $false }
${nic && nic.changed ? `
$prop = Get-NetAdapterAdvancedProperty -Name '${nic.adapterName.replace(/'/g, "''")}' -DisplayName 'Interrupt Moderation' -ErrorAction SilentlyContinue
if ($prop -and $prop.DisplayValue -ne '${String(nic.priorValue).replace(/'/g, "''")}') {
  Set-NetAdapterAdvancedProperty -Name '${nic.adapterName.replace(/'/g, "''")}' -DisplayName 'Interrupt Moderation' -DisplayValue '${String(nic.priorValue).replace(/'/g, "''")}' -NoRestart:$false
}
$out.nicRestored = $true
` : ""}
$jobs = @(Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.JobState -eq 'Suspended' })
if ($jobs.Count -gt 0) { $jobs | Resume-BitsTransfer -Asynchronous -ErrorAction SilentlyContinue }
$out.bitsResumed = $jobs.Count
${doPolicy ? `
$doKey = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization'
${doPolicy.hadValue
    ? `Set-ItemProperty -Path $doKey -Name DOMaxBackgroundDownloadBandwidth -Value ${Number(doPolicy.priorValue) || 0} -Type DWord`
    : `Remove-ItemProperty -Path $doKey -Name DOMaxBackgroundDownloadBandwidth -ErrorAction SilentlyContinue`}
$out.doRestored = $true
` : ""}
$out | ConvertTo-Json -Compress
`;

export async function engageCompetitiveLatches({ sessionKey = null } = {}) {
  if (!IS_WINDOWS) return { ok: false, skipped: "not-windows" };
  const prior = await readTuningState();
  if (prior.engagedAt) return { ok: true, already: true, state: prior };
  await writeTuningState({ ...emptyState(), engagedAt: new Date().toISOString(), sessionKey });

  const [net, timer, focus] = await Promise.all([
    runPS(ENGAGE_NET_SCRIPT, 45000),
    engageTimerLatch(),
    engageFocusWatcher()
  ]);
  const parsed = parseJson(net.stdout, {}) || {};
  const mmcss = evaluateMmcss(parsed.mmcss || {});
  const state = await readTuningState();
  const next = {
    ...state,
    nic: parsed.nic || null,
    doPolicy: parsed.doPolicy || null,
    bitsSuspended: Boolean(parsed.bits?.suspended),
    notes: [
      parsed.elevated ? null : "not elevated: NIC de-moderation and DO cap skipped",
      parsed.oneDrive?.running ? `OneDrive is running (pid ${parsed.oneDrive.pid}) — no supported pause API; reported only` : null,
      ...(mmcss.issues || [])
    ].filter(Boolean)
  };
  await writeTuningState(next);
  return {
    ok: true,
    engaged: {
      timerLatch: timer.ok,
      focusWatcher: focus.ok,
      nicDeModerated: Boolean(parsed.nic?.changed),
      bitsSuspended: Number(parsed.bits?.suspended) || 0,
      doCapped: Boolean(parsed.doPolicy),
      elevated: Boolean(parsed.elevated)
    },
    mmcssAudit: mmcss,
    irqAudit: Array.isArray(parsed.irq) ? parsed.irq : (parsed.irq ? [parsed.irq] : []),
    oneDrive: parsed.oneDrive || null,
    notes: next.notes
  };
}

export async function releaseCompetitiveLatches(reason = "session-end") {
  const state = await readTuningState();
  if (!state.engagedAt && !state.gpuClockLocked && !state.timerLatchPid && !state.focusWatcherPid && !state.nic && !state.doPolicy) {
    return { ok: true, already: true };
  }
  const gpu = await releaseGpuClockLatch(reason);
  await releaseTimerLatch();
  await releaseFocusWatcher();
  let net = { ok: true, stdout: "" };
  if (IS_WINDOWS && (state.nic?.changed || state.doPolicy || state.bitsSuspended)) {
    net = await runPS(RELEASE_NET_SCRIPT_TEMPLATE(state.nic, state.doPolicy), 45000);
  }
  const engagements = state.engagements || [];
  await writeTuningState(emptyState());
  return { ok: gpu.ok !== false && net.ok !== false, reason, engagements, netRestore: parseJson(net.stdout, null) };
}

export async function restoreOrphanedLatches() {
  const state = await readTuningState();
  const orphaned = state.engagedAt || state.gpuClockLocked || state.timerLatchPid || state.nic?.changed || state.doPolicy || state.bitsSuspended;
  if (!orphaned) return { ok: true, restored: false };
  const result = await releaseCompetitiveLatches("orphan-restore-on-start");
  return { ...result, restored: true };
}

export async function competitiveTuningStatus() {
  const state = await readTuningState();
  return {
    engaged: Boolean(state.engagedAt),
    engagedAt: state.engagedAt,
    gpuClockLocked: state.gpuClockLocked,
    gpuClockFloorMHz: state.gpuClockFloorMHz,
    timerLatch: Boolean(state.timerLatchPid),
    focusWatcher: Boolean(state.focusWatcherPid),
    nicDeModerated: Boolean(state.nic?.changed),
    quietHours: Boolean(state.doPolicy) || state.bitsSuspended,
    engagementSamples: (state.engagements || []).length,
    notes: state.notes || []
  };
}

export async function drainEngagementTemps() {
  const state = await readTuningState();
  const engagements = state.engagements || [];
  if (engagements.length) await writeTuningState({ ...state, engagements: [] });
  return engagements;
}

const DPC_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @{}
$samples = Get-Counter '\\Processor Information(*)\\% DPC Time','\\Processor Information(*)\\% Interrupt Time' -SampleInterval 1 -MaxSamples 6
foreach ($set in $samples) {
  foreach ($s in $set.CounterSamples) {
    if ($s.InstanceName -eq '_total' -or $s.InstanceName -like '*_Total') { continue }
    $key = $s.InstanceName
    if (-not $rows.ContainsKey($key)) { $rows[$key] = @{ core = $key; dpc = @(); isr = @() } }
    if ($s.Path -like '*dpc*') { $rows[$key].dpc += $s.CookedValue } else { $rows[$key].isr += $s.CookedValue }
  }
}
$out = @()
foreach ($r in $rows.Values) {
  $out += @{
    core = $r.core
    dpcAvgPct = if ($r.dpc.Count) { [math]::Round(($r.dpc | Measure-Object -Average).Average, 2) } else { 0 }
    interruptAvgPct = if ($r.isr.Count) { [math]::Round(($r.isr | Measure-Object -Average).Average, 2) } else { 0 }
  }
}
$out | ConvertTo-Json -Depth 3 -Compress
`;

export async function sampleDpcHealth() {
  if (!IS_WINDOWS) return { state: "unavailable", summary: "DPC sampling requires Windows." };
  const r = await runPS(DPC_SCRIPT, 25000);
  const rows = parseJson(r.stdout, null);
  if (!rows) return { state: "unavailable", summary: `DPC counters unavailable: ${r.error || "no data"}` };
  return evaluateDpcSample(Array.isArray(rows) ? rows : [rows]);
}

export const irqShepherdPath = path.join(dataDir, "irq-shepherd.json");

export function computeIrqAffinityMask(logicalProcessors, reserve = 2) {
  const lp = Number(logicalProcessors);
  if (!Number.isFinite(lp) || lp < 4) return null;
  const take = Math.min(Math.max(1, reserve), 4);
  const shift = lp - take;
  const mask = ((1 << take) - 1) * Math.pow(2, shift);
  const bytes = [];
  let rest = mask;
  while (rest > 0) { bytes.push(rest % 256); rest = Math.floor(rest / 256); }
  return {
    mask,
    maskHex: `0x${mask.toString(16).toUpperCase()}`,
    bytes,
    cores: Array.from({ length: take }, (_, i) => shift + i)
  };
}

const IRQ_AUDIT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ elevated = $false; logicalProcessors = 0; nic = $null; gpu = @() }
try {
  $pr = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  $out.elevated = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
$out.logicalProcessors = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
function Read-Irq($instanceId) {
  $base = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$instanceId\\Device Parameters\\Interrupt Management"
  $msi = (Get-ItemProperty (Join-Path $base 'MessageSignaledInterruptProperties') -Name MSISupported -ErrorAction SilentlyContinue).MSISupported
  $ap = Get-ItemProperty (Join-Path $base 'Affinity Policy') -ErrorAction SilentlyContinue
  $aso = $null
  if ($ap -and $null -ne $ap.AssignmentSetOverride) { $aso = @($ap.AssignmentSetOverride) }
  return @{ msiSupported = $msi; devicePolicy = $ap.DevicePolicy; assignmentSetOverride = $aso }
}
$ad = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object -Property LinkSpeed -Descending | Select-Object -First 1
if ($ad) {
  $pnp = Get-PnpDevice -Class Net -Status OK | Where-Object { $_.FriendlyName -eq $ad.InterfaceDescription } | Select-Object -First 1
  if ($pnp) {
    $out.nic = @{ adapterName = $ad.Name; description = $ad.InterfaceDescription; instanceId = $pnp.InstanceId; linkSpeed = "$($ad.LinkSpeed)" }
    $out.nic.irq = Read-Irq $pnp.InstanceId
  }
}
foreach ($g in (Get-PnpDevice -Class Display -Status OK)) {
  $out.gpu += @{ name = $g.FriendlyName; instanceId = $g.InstanceId; irq = (Read-Irq $g.InstanceId) }
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

export async function auditIrqShepherd() {
  if (!IS_WINDOWS) return { ok: false, error: "Windows only" };
  const r = await runPS(IRQ_AUDIT_SCRIPT, 30000);
  const parsed = parseJson(r.stdout, null);
  if (!parsed) return { ok: false, error: r.error || "audit produced no data" };
  let applied = null;
  try {
    applied = parseJson(await fs.readFile(irqShepherdPath, "utf8"), null);
  } catch { /* never applied */ }
  const plan = computeIrqAffinityMask(parsed.logicalProcessors, 2);
  return {
    ok: true,
    elevated: Boolean(parsed.elevated),
    logicalProcessors: parsed.logicalProcessors,
    nic: parsed.nic || null,
    gpu: Array.isArray(parsed.gpu) ? parsed.gpu : (parsed.gpu ? [parsed.gpu] : []),
    applied: applied ? { at: applied.appliedAt, adapterName: applied.adapterName, cores: applied.plan?.cores } : null,
    plan: plan ? { cores: plan.cores, maskHex: plan.maskHex } : null,
    gpuNote: "GPU interrupts stay on MSI-X defaults deliberately — the OS spreads them well; forcing GPU affinity is how hand-tuning causes stutter."
  };
}

export async function applyIrqShepherd() {
  if (!IS_WINDOWS) return { ok: false, error: "Windows only" };
  const audit = await auditIrqShepherd();
  if (!audit.ok) return audit;
  if (!audit.elevated) return { ok: false, error: "Server is not elevated — relaunch via the elevated starter." };
  if (!audit.nic?.instanceId) return { ok: false, error: "No active physical NIC found." };
  const plan = computeIrqAffinityMask(audit.logicalProcessors, 2);
  if (!plan) return { ok: false, error: `Unusable logical processor count (${audit.logicalProcessors}).` };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(irqShepherdPath, `${JSON.stringify({
    appliedAt: new Date().toISOString(),
    adapterName: audit.nic.adapterName,
    instanceId: audit.nic.instanceId,
    prior: audit.nic.irq || {},
    plan
  }, null, 2)}\n`, "utf8");

  const bytesPs = plan.bytes.map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(",");
  const script = `
$ErrorActionPreference = 'Stop'
$mutationOk = $false
$adapterStatus = $null
try {
  $base = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${audit.nic.instanceId.replace(/\\/g, "\\\\")}\\Device Parameters\\Interrupt Management"
  $ap = Join-Path $base 'Affinity Policy'
  New-Item -Path $ap -Force | Out-Null
  Set-ItemProperty -Path $ap -Name DevicePolicy -Value 4 -Type DWord
  Set-ItemProperty -Path $ap -Name AssignmentSetOverride -Value ([byte[]](${bytesPs})) -Type Binary
  Restart-NetAdapter -Name '${audit.nic.adapterName.replace(/'/g, "''")}' -Confirm:$false
  Start-Sleep -Seconds 3
  $adapterStatus = "$((Get-NetAdapter -Name '${audit.nic.adapterName.replace(/'/g, "''")}').Status)"
  $mutationOk = $true
} catch {
  @{ mutationOk = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit
}
$internetOk = $null
$ping = New-Object System.Net.NetworkInformation.Ping
for ($attempt = 0; $attempt -lt 3 -and $internetOk -ne $true; $attempt++) {
  try {
    $reply = $ping.Send('1.1.1.1', 2000)
    $internetOk = ($reply.Status -eq 'Success')
  } catch {
    $internetOk = $false
  }
  if ($internetOk -ne $true) { Start-Sleep -Milliseconds 700 }
}
@{ mutationOk = $mutationOk; adapterStatus = $adapterStatus; internetOk = $internetOk } | ConvertTo-Json -Compress
`;
  const r = await runPS(script, 60000);
  const verify = parseJson(r.stdout, null);
  if (!verify || verify.mutationOk !== true) {
    return { ok: false, error: `apply failed: ${verify?.error || r.error || r.stderr || "no verification output"}`, revertFile: irqShepherdPath };
  }
  return {
    ok: true,
    adapterName: audit.nic.adapterName,
    steeredToCores: plan.cores,
    maskHex: plan.maskHex,
    adapterStatus: verify.adapterStatus,
    internetOk: verify.internetOk === null ? null : Boolean(verify.internetOk),
    note: verify.internetOk === false
      ? "Applied and adapter is up, but the post-apply ping did not succeed — worth a manual connectivity check."
      : "NIC interrupts now land on the top cores, away from core 0's kernel DPCs. Takes full effect on interrupt reconnect (adapter was restarted; a reboot also renews it)."
  };
}

const IRQ_POLICY_MACHINE_DEFAULT = 0;

export async function revertIrqShepherd() {
  if (!IS_WINDOWS) return { ok: false, error: "Windows only" };
  let saved = null;
  try {
    saved = parseJson(await fs.readFile(irqShepherdPath, "utf8"), null);
  } catch { /* nothing to revert */ }
  if (!saved?.instanceId) return { ok: false, error: "No applied shepherding on record." };
  const prior = saved.prior || {};
  const priorPolicy = (prior.devicePolicy === null || prior.devicePolicy === undefined)
    ? IRQ_POLICY_MACHINE_DEFAULT
    : Number(prior.devicePolicy);
  const priorAso = Array.isArray(prior.assignmentSetOverride) && prior.assignmentSetOverride.length
    ? prior.assignmentSetOverride
    : [0]; // neutral single-zero-byte mask; inert once DevicePolicy is MachineDefault.
  const policyBytesPs = priorAso.map((b) => `0x${Number(b).toString(16).padStart(2, "0")}`).join(",");
  const script = `
$ErrorActionPreference = 'Stop'
$mutationOk = $false
$writeError = $null
$adapterStatus = $null
$readBackPolicy = $null
try {
  $ap = "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${saved.instanceId.replace(/\\/g, "\\\\")}\\Device Parameters\\Interrupt Management\\Affinity Policy"
  Set-ItemProperty -Path $ap -Name DevicePolicy -Value ${Number.isFinite(priorPolicy) ? priorPolicy : IRQ_POLICY_MACHINE_DEFAULT} -Type DWord
  Set-ItemProperty -Path $ap -Name AssignmentSetOverride -Value ([byte[]](${policyBytesPs})) -Type Binary
  Restart-NetAdapter -Name '${String(saved.adapterName).replace(/'/g, "''")}' -Confirm:$false
  Start-Sleep -Seconds 3
  $adapterStatus = "$((Get-NetAdapter -Name '${String(saved.adapterName).replace(/'/g, "''")}').Status)"
  # Read back the ACTUAL post-restart value: proof of effect, not just proof the
  # cmdlet ran without throwing (that distinction is exactly what caused this bug).
  $readBackPolicy = (Get-ItemProperty -Path $ap -Name DevicePolicy -ErrorAction SilentlyContinue).DevicePolicy
  $mutationOk = $true
} catch {
  $writeError = $_.Exception.Message
}
@{ mutationOk = $mutationOk; writeError = $writeError; adapterStatus = $adapterStatus; readBackPolicy = $readBackPolicy } | ConvertTo-Json -Compress
`;
  const r = await runPS(script, 60000);
  const verify = parseJson(r.stdout, null);
  const expectedPolicy = Number.isFinite(priorPolicy) ? priorPolicy : IRQ_POLICY_MACHINE_DEFAULT;
  const readBackMatches = verify && Number(verify.readBackPolicy) === expectedPolicy;
  if (!verify || verify.mutationOk !== true) {
    return { ok: false, error: `revert failed: ${verify?.writeError || r.error || r.stderr || "no verification output"}` };
  }
  if (!readBackMatches) {
    return {
      ok: false,
      error: `Registry write completed but did not take effect: expected DevicePolicy=${expectedPolicy}, read back ${verify.readBackPolicy}. The driver may require a full reboot (not just an adapter restart) to release the prior interrupt affinity on this device — the applied state was left in place so it is not lost; try again, or reboot then retry.`,
      adapterStatus: verify.adapterStatus,
      readBackPolicy: verify.readBackPolicy,
      expectedPolicy
    };
  }
  await fs.unlink(irqShepherdPath).catch(() => {});
  return {
    ok: true,
    adapterName: saved.adapterName,
    adapterStatus: verify.adapterStatus,
    readBackPolicy: verify.readBackPolicy,
    note: "Interrupt affinity restored to MachineDefault (OS-decided, no override) — verified by reading the value back after the adapter restart, not just assumed."
  };
}

export async function applyEcoCage({ pid = null, name = null, enable = true, gameName = null } = {}) {
  if (!IS_WINDOWS) return { ok: false, error: "Windows only" };
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 4) return { ok: false, error: "invalid pid" };
  const label = String(name || "");
  if (isProtectedProcess(label)) return { ok: false, error: `${label} is protected — eco-cage refused.` };
  if (gameName && label && String(gameName).toLowerCase().includes(label.toLowerCase())) {
    return { ok: false, error: "refusing to throttle the active game" };
  }
  const script = `
$sig = @'
using System; using System.Runtime.InteropServices;
public class Eco {
  [StructLayout(LayoutKind.Sequential)] public struct PPTS { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int cls, ref PPTS info, int size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$h = [Eco]::OpenProcess(0x0200 -bor 0x0400, $false, ${target})
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"error":"OpenProcess failed"}'; exit }
$s = New-Object Eco+PPTS
$s.Version = 1; $s.ControlMask = 1; $s.StateMask = ${enable ? 1 : 0}
$ok = [Eco]::SetProcessInformation($h, 4, [ref]$s, [System.Runtime.InteropServices.Marshal]::SizeOf($s))
[void][Eco]::CloseHandle($h)
@{ ok = [bool]$ok } | ConvertTo-Json -Compress
`;
  const r = await runPS(script, 15000);
  const parsed = parseJson(r.stdout, { ok: false, error: r.error || "no output" });
  return { ...parsed, pid: target, name: label, enabled: enable };
}
