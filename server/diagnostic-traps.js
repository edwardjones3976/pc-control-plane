import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, diagnosticTrapsDir, diagnosticTrapsPath } from "./config.js";

const MAX_BUFFER = 1024 * 1024 * 4;
const DEFAULT_EXECUTABLES = Object.freeze([]);
const DUMP_EXTENSIONS = new Set([".dmp", ".mdmp", ".hdmp"]);
const PROTECTED_PROCESS_NAMES = new Set([
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
  "audiodg",
  "explorer",
  "memory compression"
]);

function processNameKey(name) {
  return String(name || "").trim().toLowerCase();
}

export function summarizeTopCpuProcesses(telemetry = {}, { limit = 5 } = {}) {
  const foregroundPid = Number(telemetry?.foreground?.pid);
  const priorityPid = Number(telemetry?.priorityApp?.process?.pid);
  return (Array.isArray(telemetry?.processes) ? telemetry.processes : [])
    .map((process) => {
      const cpuPct = Number(process?.cpuPct);
      return {
        name: process?.name || null,
        pid: process?.pid ?? null,
        cpuPct: Number.isFinite(cpuPct) ? cpuPct : null,
        workingSetMB: process?.workingSetMB ?? null,
        privateMB: process?.privateMB ?? null,
        foreground: Number.isFinite(foregroundPid) && Number(process?.pid) === foregroundPid,
        priorityApp: Number.isFinite(priorityPid) && Number(process?.pid) === priorityPid,
        protected: PROTECTED_PROCESS_NAMES.has(processNameKey(process?.name))
      };
    })
    .filter((process) => process.name && Number.isFinite(Number(process.cpuPct)))
    .sort((a, b) => Number(b.cpuPct) - Number(a.cpuPct))
    .slice(0, Math.max(1, Number(limit) || 5));
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArray(values) {
  return `@(${values.map((value) => psString(value)).join(",")})`;
}

function b64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function runPowerShell(command, options = {}) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        cwd: options.cwd || path.resolve(dataDir, ".."),
        timeout: options.timeoutMs || 20000,
        maxBuffer: options.maxBuffer || MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error: error ? String(error.message || error) : null
        });
      }
    );
  });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJson(output, fallback) {
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function singleLine(value, limit = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

export function normalizeDiagnosticTrapOptions(options = {}) {
  const minutes = Math.max(5, Math.min(240, Number(options.minutes) || 60));
  const dumpType = [1, 2].includes(Number(options.dumpType)) ? Number(options.dumpType) : 1;
  const dumpCount = Math.max(1, Math.min(10, Number(options.dumpCount) || 3));
  const executables = Array.isArray(options.executables) && options.executables.length
    ? options.executables
    : DEFAULT_EXECUTABLES;
  return {
    minutes,
    dumpType,
    dumpCount,
    executables: [...new Set(executables.map((value) => String(value || "").trim()).filter(Boolean))]
  };
}

export function createDiagnosticTrapState({
  id,
  options,
  dumpRoot,
  registryBaseline,
  eventBaseline,
  dryRun = false
}) {
  const armedAt = new Date();
  const expiresAt = new Date(armedAt.getTime() + options.minutes * 60 * 1000);
  return {
    schema: "pc-control-plane-diagnostic-traps/v1",
    active: !dryRun,
    id,
    armedAt: armedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    disarmedAt: null,
    disarmReason: null,
    dumpRoot,
    options,
    hooks: {
      werLocalDumps: !dryRun,
      eventLogBaseline: true,
      telemetrySampler: true,
      observerWarnings: true,
      inProcessHooking: false
    },
    registryBaseline,
    eventBaseline,
    warnings: [],
    lastWarningAt: null,
    evidence: summarizeDiagnosticEvidence(),
    dryRun
  };
}

async function captureEventBaseline() {
  const result = await runPowerShell(
    `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
foreach ($name in @('System', 'Application')) {
  $event = Get-WinEvent -LogName $name -MaxEvents 1
  if ($event) {
    $rows += [pscustomobject]@{
      logName = $name
      time = $event.TimeCreated.ToString('o')
      recordId = $event.RecordId
      provider = $event.ProviderName
      id = $event.Id
    }
  } else {
    $rows += [pscustomobject]@{
      logName = $name
      time = $null
      recordId = $null
      provider = $null
      id = $null
    }
  }
}
$rows | ConvertTo-Json -Depth 4
`,
    { timeoutMs: 15000 }
  );
  if (!result.ok || !result.stdout) {
    return { ok: false, logs: [], error: result.error || result.stderr || "Event baseline failed." };
  }
  const parsed = parseJson(result.stdout, []);
  return { ok: true, logs: Array.isArray(parsed) ? parsed : [parsed] };
}

async function listDumpFiles(dumpRoot) {
  if (!dumpRoot) {
    return [];
  }
  try {
    const entries = await fs.readdir(dumpRoot, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !DUMP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const filePath = path.join(dumpRoot, entry.name);
      const stat = await fs.stat(filePath);
      files.push({
        name: entry.name,
        path: filePath,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)).slice(0, 8);
  } catch {
    return [];
  }
}

async function captureEventDelta(state) {
  const payload = {
    armedAt: state?.armedAt || null,
    baseline: state?.eventBaseline?.logs || []
  };
  const command = `
$ErrorActionPreference = 'SilentlyContinue'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64Json(payload))})) | ConvertFrom-Json
$start = (Get-Date).AddHours(-2)
if ($payload.armedAt) {
  try { $start = [DateTime]::Parse([string]$payload.armedAt) } catch {}
}
$baseline = @{}
foreach ($row in @($payload.baseline)) {
  if ($row.logName -and $null -ne $row.recordId) {
    $logKey = [string]$row.logName
    $baseline[$logKey] = [int64]$row.recordId
  }
}
$rows = @()
foreach ($name in @('System', 'Application')) {
  $events = Get-WinEvent -FilterHashtable @{ LogName=$name; Level=1,2,3; StartTime=$start } -MaxEvents 50
  foreach ($event in @($events)) {
    if ($baseline.ContainsKey($name) -and [int64]$event.RecordId -le [int64]$baseline[$name]) { continue }
    $message = $event.Message
    if ($message -and $message.Length -gt 520) { $message = $message.Substring(0, 519) + '...' }
    $rows += [pscustomobject]@{
      logName = $name
      time = $event.TimeCreated.ToString('o')
      recordId = $event.RecordId
      provider = $event.ProviderName
      id = $event.Id
      level = $event.LevelDisplayName
      message = $message
    }
  }
}
$rows | Sort-Object time -Descending | Select-Object -First 20 | ConvertTo-Json -Depth 5
`;
  const result = await runPowerShell(command, { timeoutMs: 18000 });
  if (!result.ok) {
    return { ok: false, events: [], error: result.error || result.stderr || "Event delta scan failed." };
  }
  const parsed = result.stdout ? parseJson(result.stdout, []) : [];
  const events = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((event) => ({
    logName: event.logName || null,
    time: event.time || null,
    recordId: event.recordId ?? null,
    provider: event.provider || null,
    id: event.id ?? null,
    level: event.level || null,
    message: singleLine(event.message)
  }));
  return { ok: true, events };
}

export function summarizeDiagnosticEvidence({
  dumps = [],
  events = [],
  warnings = [],
  scannedAt = null,
  eventScanError = null
} = {}) {
  const dumpList = Array.isArray(dumps) ? dumps : [];
  const eventList = Array.isArray(events) ? events : [];
  const warningList = Array.isArray(warnings) ? warnings : [];
  const newestDump = dumpList[0] || null;
  let state = "idle";
  let nextAction = "No trap evidence captured in the last diagnostic session.";
  if (newestDump) {
    state = "dump-ready";
    nextAction = "Analyze the newest WER dump before promoting a hardened patch.";
  } else if (warningList.length || eventList.length) {
    state = "warning-ready";
    nextAction = "Use the fast patch, keep the trap path available, and compare against the next run.";
  }
  return {
    state,
    dumpCount: dumpList.length,
    newestDump,
    dumps: dumpList.slice(0, 4),
    warningCount: warningList.length,
    newestWarning: warningList.slice(-1)[0] || null,
    eventCount: eventList.length,
    newestEvents: eventList.slice(0, 5),
    eventScanError,
    scannedAt: scannedAt || new Date().toISOString(),
    nextAction
  };
}

async function buildDiagnosticEvidence(state, { scanEvents = false } = {}) {
  const dumps = await listDumpFiles(state?.dumpRoot);
  const prior = state?.evidence || {};
  let events = Array.isArray(prior.newestEvents) ? prior.newestEvents : [];
  let eventScanError = prior.eventScanError || null;
  if (scanEvents) {
    const delta = await captureEventDelta(state);
    events = delta.events || [];
    eventScanError = delta.ok ? null : delta.error;
  }
  return summarizeDiagnosticEvidence({
    dumps,
    events,
    warnings: state?.warnings || [],
    eventScanError
  });
}

async function applyWerLocalDumps({ dumpRoot, options }) {
  const command = `
$ErrorActionPreference = 'Stop'
$dumpRoot = ${psString(dumpRoot)}
$executables = ${psArray(options.executables)}
$dumpType = ${Number(options.dumpType)}
$dumpCount = ${Number(options.dumpCount)}
New-Item -ItemType Directory -Path $dumpRoot -Force | Out-Null
$base = 'HKCU:\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps'
New-Item -Path $base -Force | Out-Null
function Export-LocalDumpKey($path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $item = Get-ItemProperty -LiteralPath $path
  $values = [ordered]@{}
  foreach ($name in @('DumpFolder', 'DumpCount', 'DumpType')) {
    $prop = $item.PSObject.Properties[$name]
    if ($prop) { $values[$name] = $prop.Value } else { $values[$name] = $null }
  }
  [pscustomobject]$values
}
$changes = @()
foreach ($exe in $executables) {
  $key = Join-Path $base $exe
  $existed = Test-Path -LiteralPath $key
  $before = Export-LocalDumpKey $key
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -LiteralPath $key -Name DumpFolder -PropertyType ExpandString -Value $dumpRoot -Force | Out-Null
  New-ItemProperty -LiteralPath $key -Name DumpCount -PropertyType DWord -Value $dumpCount -Force | Out-Null
  New-ItemProperty -LiteralPath $key -Name DumpType -PropertyType DWord -Value $dumpType -Force | Out-Null
  $after = Export-LocalDumpKey $key
  $changes += [pscustomobject]@{
    executable = $exe
    keyPath = $key
    existed = [bool]$existed
    before = $before
    after = $after
  }
}
[pscustomobject]@{
  ok = $true
  base = $base
  changes = $changes
} | ConvertTo-Json -Depth 8
`;
  const result = await runPowerShell(command, { timeoutMs: 20000 });
  if (!result.ok || !result.stdout) {
    return {
      ok: false,
      result,
      base: "HKCU:\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps",
      changes: []
    };
  }
  return parseJson(result.stdout, { ok: false, result, changes: [] });
}

async function restoreWerLocalDumps(state) {
  const payload = {
    entries: state?.registryBaseline?.changes || []
  };
  const command = `
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(b64Json(payload))})) | ConvertFrom-Json
function Convert-ToBoolean($value) {
  if ($null -eq $value) { return $false }
  if ($value -is [bool]) { return [bool]$value }
  $text = ([string]$value).Trim()
  return $text -match '^(true|1|yes)$'
}
function Restore-Value($path, $name, $value) {
  if ($null -eq $value) {
    Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue
    return
  }
  $type = if ($name -eq 'DumpFolder') { 'ExpandString' } else { 'DWord' }
  New-ItemProperty -LiteralPath $path -Name $name -PropertyType $type -Value $value -Force | Out-Null
}
$restored = @()
foreach ($entry in $payload.entries) {
  $path = [string]$entry.keyPath
  $existed = Convert-ToBoolean $entry.existed
  if (-not $existed) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
    $restored += [pscustomobject]@{
      keyPath = $path
      action = 'removed-created-key'
      verified = -not (Test-Path -LiteralPath $path)
    }
    continue
  }
  New-Item -Path $path -Force | Out-Null
  Restore-Value $path 'DumpFolder' $entry.before.DumpFolder
  Restore-Value $path 'DumpCount' $entry.before.DumpCount
  Restore-Value $path 'DumpType' $entry.before.DumpType
  $restored += [pscustomobject]@{
    keyPath = $path
    action = 'restored-prior-values'
    verified = Test-Path -LiteralPath $path
  }
}
$failures = @($restored | Where-Object { $_.verified -eq $false })
[pscustomobject]@{ ok = ($failures.Count -eq 0); restored = $restored } | ConvertTo-Json -Depth 6
`;
  const result = await runPowerShell(command, { timeoutMs: 20000 });
  if (!result.ok || !result.stdout) {
    return { ok: false, result };
  }
  return parseJson(result.stdout, { ok: false, result });
}

export async function readDiagnosticTrapState() {
  return readJson(diagnosticTrapsPath, {
    schema: "pc-control-plane-diagnostic-traps/v1",
    active: false,
    id: null,
    warnings: []
  });
}

export function summarizeDiagnosticTrapState(state) {
  const expiresMs = state?.expiresAt ? Date.parse(state.expiresAt) : null;
  const minutesRemaining = state?.active && Number.isFinite(expiresMs)
    ? Math.max(0, Math.ceil((expiresMs - Date.now()) / 60000))
    : 0;
  return {
    active: Boolean(state?.active),
    id: state?.id || null,
    armedAt: state?.armedAt || null,
    expiresAt: state?.expiresAt || null,
    disarmedAt: state?.disarmedAt || null,
    disarmReason: state?.disarmReason || null,
    minutesRemaining,
    dumpRoot: state?.dumpRoot || null,
    hooks: state?.hooks || {},
    warningCount: (state?.warnings || []).length,
    lastWarningAt: state?.lastWarningAt || null,
    lastWarning: (state?.warnings || []).slice(-1)[0] || null,
    evidence: state?.evidence || summarizeDiagnosticEvidence({ warnings: state?.warnings || [] }),
    options: state?.options || null
  };
}

export async function getDiagnosticTrapStatus(options = {}) {
  const state = await readDiagnosticTrapState();
  if (
    options.autoExpire !== false &&
    state.active &&
    state.expiresAt &&
    Date.parse(state.expiresAt) <= Date.now()
  ) {
    const disarmed = await disarmDiagnosticTraps({ reason: "expired" });
    return disarmed.status;
  }
  return summarizeDiagnosticTrapState({
    ...state,
    evidence: await buildDiagnosticEvidence(state, { scanEvents: false })
  });
}

export async function armDiagnosticTraps(options = {}) {
  const normalized = normalizeDiagnosticTrapOptions(options);
  const existing = await readDiagnosticTrapState();
  if (existing.active) {
    return {
      ok: true,
      alreadyActive: true,
      status: summarizeDiagnosticTrapState(existing),
      message: `Diagnostic traps already armed until ${existing.expiresAt}.`
    };
  }

  const id = `diag-${new Date().toISOString().replace(/[:.]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
  const trapRoot = path.join(diagnosticTrapsDir, id);
  const dumpRoot = path.join(trapRoot, "dumps");
  const eventBaseline = await captureEventBaseline();

  if (options.dryRun) {
    const state = createDiagnosticTrapState({
      id,
      options: normalized,
      dumpRoot,
      registryBaseline: { ok: true, dryRun: true, changes: [] },
      eventBaseline,
      dryRun: true
    });
    return {
      ok: true,
      dryRun: true,
      status: summarizeDiagnosticTrapState(state),
      state,
      message: `Would arm diagnostic traps for ${normalized.minutes} minutes.`
    };
  }

  await fs.mkdir(dumpRoot, { recursive: true });
  const registryBaseline = await applyWerLocalDumps({ dumpRoot, options: normalized });
  if (!registryBaseline.ok) {
    return {
      ok: false,
      status: summarizeDiagnosticTrapState(existing),
      registryBaseline,
      message: "Failed to arm WER LocalDumps diagnostic trap."
    };
  }
  const state = createDiagnosticTrapState({
    id,
    options: normalized,
    dumpRoot,
    registryBaseline,
    eventBaseline
  });
  state.evidence = await buildDiagnosticEvidence(state, { scanEvents: false });
  await writeJson(diagnosticTrapsPath, state);
  return {
    ok: true,
    status: summarizeDiagnosticTrapState(state),
    state,
    message: `Diagnostic traps armed for ${normalized.minutes} minutes.`
  };
}

export async function disarmDiagnosticTraps(options = {}) {
  const state = await readDiagnosticTrapState();
  const needsRestoreRetry = Boolean(options.force || state.restoreResult?.ok === false);
  if (!state.active && !needsRestoreRetry) {
    return {
      ok: true,
      alreadyInactive: true,
      status: summarizeDiagnosticTrapState(state),
      message: "Diagnostic traps are already disarmed."
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      status: summarizeDiagnosticTrapState(state),
      message: "Would disarm diagnostic traps and restore WER LocalDumps."
    };
  }

  const restoreResult = await restoreWerLocalDumps(state);
  const next = {
    ...state,
    active: false,
    disarmedAt: new Date().toISOString(),
    disarmReason: options.reason || "manual",
    restoreResult
  };
  next.evidence = await buildDiagnosticEvidence(next, { scanEvents: true });
  await writeJson(diagnosticTrapsPath, next);
  return {
    ok: restoreResult.ok !== false,
    status: summarizeDiagnosticTrapState(next),
    state: next,
    restoreResult,
    message: restoreResult.ok === false
      ? "Diagnostic traps disarmed, but WER LocalDumps restore reported a failure."
      : "Diagnostic traps disarmed and WER LocalDumps restored."
  };
}

export async function recordDiagnosticTrapWarning({ policy, telemetry } = {}) {
  const state = await readDiagnosticTrapState();
  if (!state.active) {
    return { ok: true, recorded: false, reason: "inactive" };
  }

  const active = policy?.failureWatchlist?.active || [];
  const signals = active.filter((profile) => profile.recent && profile.severity !== "low");
  if (!signals.length) {
    return { ok: true, recorded: false, reason: "no-recent-signals" };
  }

  const warnings = Array.isArray(state.warnings) ? state.warnings : [];
  const topCpuProcesses = summarizeTopCpuProcesses(telemetry, { limit: 5 });
  let recorded = false;
  for (const signal of signals) {
    const signature = `${signal.id}|${signal.newestAt || "now"}|${signal.count || 0}`;
    if (warnings.some((warning) => warning.signature === signature)) {
      continue;
    }
    warnings.push({
      ts: new Date().toISOString(),
      signature,
      profileId: signal.id,
      label: signal.label,
      severity: signal.severity,
      category: signal.category,
      newestAt: signal.newestAt || null,
      message: `${signal.label}: ${signal.fastPatch?.[0] || "Review current failure evidence."}`,
      telemetry: {
        health: policy?.health?.state || null,
        priority: policy?.priority?.label || null,
        cpuLoadPct: telemetry?.system?.cpuLoadPct ?? null,
        ramUsedPct: telemetry?.system?.ramUsedPct ?? null,
        gpuTemperatureC: telemetry?.gpu?.temperatureC ?? null,
        gpuPowerDrawW: telemetry?.gpu?.powerDrawW ?? null,
        priorityAppRunning: Boolean(telemetry?.priorityApp?.running),
        topCpuProcesses: signal.id === "memory-cpu-pressure" ? topCpuProcesses : []
      }
    });
    recorded = true;
  }

  if (!recorded) {
    return { ok: true, recorded: false, reason: "duplicate" };
  }

  const evidence = await buildDiagnosticEvidence({ ...state, warnings }, { scanEvents: true });
  const latest = await readDiagnosticTrapState();
  if (!latest.active || latest.id !== state.id) {
    return {
      ok: true,
      recorded: false,
      reason: "inactive-after-scan",
      status: summarizeDiagnosticTrapState(latest)
    };
  }

  const mergedWarnings = Array.isArray(latest.warnings) ? [...latest.warnings] : [];
  for (const warning of warnings) {
    if (!mergedWarnings.some((entry) => entry.signature === warning.signature)) {
      mergedWarnings.push(warning);
    }
  }
  const next = {
    ...latest,
    warnings: mergedWarnings.slice(-40),
    lastWarningAt: new Date().toISOString()
  };
  next.evidence = summarizeDiagnosticEvidence({
    dumps: evidence.dumps || [],
    events: evidence.newestEvents || [],
    warnings: next.warnings,
    eventScanError: evidence.eventScanError || null
  });
  await writeJson(diagnosticTrapsPath, next);
  return {
    ok: true,
    recorded: true,
    status: summarizeDiagnosticTrapState(next),
    warnings: next.warnings
  };
}
