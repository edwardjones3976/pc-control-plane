
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { dataDir } from "./config.js";
import { gameKeyFor, isNonGameExe, normalizePath } from "./game-identity.js";

export const GAME_LIBRARY_SCHEMA = "pc-control-plane-game-library/v1";
export const gameLibraryPath = path.join(dataDir, "game-library.json");

const SCAN_TTL_MS = Number(process.env.PC_CONTROL_GAME_SCAN_TTL_MS || 12 * 60 * 60 * 1000);
const MAX_SAMPLES = 20;

const GENERIC_DIR_NAMES = new Set([
  "bin", "bin64", "binaries", "win64", "win32", "game", "games", "apps", "data",
  "temp", "tmp", "new folder", "desktop", "downloads", "documents", "users",
  "windows", "program files", "program files (x86)", "common", "shared", "release",
  "build", "content", "client", "launcher", "redist", "engine"
]);

export const COMPETITIVE_PRIOR = Object.freeze({
  id: "competitive-prior",
  startingStance: "engage-on-activity",
  minSamplesToPromote: 2,
  promoteWarmupSec: 45,
  minSamplesToDemote: 6,
  demoteScoreMargin: 12,
  note: "Asymmetric by design: a missed frame is unrecoverable, extra heat is not."
});

export const GAME_STANCES = Object.freeze({
  immediateCompetitive: "immediate-competitive",
  engageOnActivity: "engage-on-activity",
  balancedOk: "balanced-ok"
});

function emptyLibrary() {
  return {
    schema: GAME_LIBRARY_SCHEMA,
    scannedAt: null,
    scanOk: false,
    scanError: null,
    roots: [],
    gameConfigStorePaths: [],
    gameConfigStoreDirs: [],
    installDirs: [],
    titles: {}
  };
}

export function cleanTitleEntries(titles = {}) {
  const cleaned = {};
  for (const [key, entry] of Object.entries(titles && typeof titles === "object" ? titles : {})) {
    const pathKey = String(key || "").startsWith("path:") ? String(key).slice(5) : "";
    const exe = pathKey ? pathKey.split("\\").filter(Boolean).pop() || "" : "";
    if (exe && isNonGameExe(exe) && !entry?.userVerdict) {
      continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}

function normalizeLibrary(value) {
  if (!value || typeof value !== "object") return emptyLibrary();
  const base = emptyLibrary();
  return {
    ...base,
    ...value,
    roots: Array.isArray(value.roots) ? value.roots : [],
    gameConfigStorePaths: Array.isArray(value.gameConfigStorePaths) ? value.gameConfigStorePaths : [],
    gameConfigStoreDirs: Array.isArray(value.gameConfigStoreDirs) ? value.gameConfigStoreDirs : [],
    installDirs: Array.isArray(value.installDirs) ? value.installDirs : [],
    titles: cleanTitleEntries(value.titles)
  };
}

let cache = { value: null, at: 0 };

export async function readGameLibrary() {
  if (cache.value) return cache.value;
  try {
    const raw = await fs.readFile(gameLibraryPath, "utf8");
    cache = { value: normalizeLibrary(JSON.parse(raw)), at: Date.now() };
  } catch {
    cache = { value: emptyLibrary(), at: 0 };
  }
  return cache.value;
}

async function writeGameLibrary(library) {
  const next = normalizeLibrary(library);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(gameLibraryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  cache = { value: next, at: Date.now() };
  return next;
}

export function __resetGameLibraryCache() {
  cache = { value: null, at: 0 };
}

const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$titles  = @()
$roots   = @()
$dirs    = @()
$gcsDirs = @()

# Not everything a game STORE installs is a game. Epic in particular distributes the
# Unreal Engine/editor, peripheral software and redistributables through the same
# manifests as its games -- and the Unreal editor is heavy creative work that belongs
# in 100% Performance, never Competitive. One gate on every source so no branch can
# forget it.
$notAGame = '(?i)^(Launcher|UE_.*|Unreal.*|Epic Online Services|GameInputRedist|SteelSeries.*|Razer.*|Corsair.*|Logitech.*|DirectX.*|_?CommonRedist|.*Redist.*|.*Redistributable.*|EasyAntiCheat|Steamworks Shared|SteamVR|Proton.*|Steam Linux Runtime.*|Cleanup|Downloads?)$'
function Add-Title($name, $exe, $dir, $source) {
  if (-not $dir) { return }
  $leaf = Split-Path $dir -Leaf
  if ($leaf -match $script:notAGame -or ($name -and $name -match $script:notAGame)) { return }
  $script:titles += [pscustomobject]@{ name = $name; exe = $exe; dir = $dir; source = $source }
}

# --- Steam: libraryfolders.vdf -> appmanifest_*.acf -> common\<installdir> -----
$steamPaths = @()
$reg = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -Name SteamPath).SteamPath
if ($reg) { $steamPaths += ($reg -replace '/', '\') }
$steamPaths += 'C:\Program Files (x86)\Steam'
$steamPaths = $steamPaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$libs = @()
foreach ($sp in $steamPaths) {
  $libs += $sp
  $vdf = Join-Path $sp 'steamapps\libraryfolders.vdf'
  if (Test-Path $vdf) {
    foreach ($line in (Get-Content $vdf)) {
      if ($line -match '"path"\s+"([^"]+)"') { $libs += ($matches[1] -replace '\\\\', '\') }
    }
  }
}
foreach ($lib in ($libs | Select-Object -Unique)) {
  $apps = Join-Path $lib 'steamapps'
  if (-not (Test-Path $apps)) { continue }
  $roots += $apps
  foreach ($mf in (Get-ChildItem $apps -Filter 'appmanifest_*.acf')) {
    $raw = Get-Content $mf.FullName -Raw
    $nm = if ($raw -match '"name"\s+"([^"]+)"') { $matches[1] } else { $null }
    $id = if ($raw -match '"installdir"\s+"([^"]+)"') { $matches[1] } else { $null }
    # Steam ships redistributables and runtimes as "apps" with their own manifests
    # (Steamworks Shared, SteamVR, Proton, .NET/DirectX redists). They are not games
    # and must never be able to pin the machine to Competitive.
    if ($id -and $id -notmatch '(?i)^(Steamworks Shared|SteamVR|Steam Linux Runtime.*|Proton.*|.*Redistributable.*|.*Redist.*)$') {
      $dir = Join-Path (Join-Path $apps 'common') $id
      if (Test-Path $dir) { Add-Title $nm $null $dir 'steam' }
    }
  }
}

# --- Epic: per-title manifest .item files (JSON) -------------------------------
$epicManifests = 'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests'
if (Test-Path $epicManifests) {
  $roots += $epicManifests
  foreach ($item in (Get-ChildItem $epicManifests -Filter '*.item')) {
    $j = Get-Content $item.FullName -Raw | ConvertFrom-Json
    if ($j.InstallLocation) { Add-Title $j.DisplayName $j.LaunchExecutable $j.InstallLocation 'epic' }
  }
}

# --- Store roots we can only enumerate as directories --------------------------
$dirRoots = @(
  @{ p = 'C:\Program Files\Epic Games';        s = 'epic' },
  @{ p = 'C:\Program Files\EA Games';          s = 'ea' },
  @{ p = 'C:\Program Files (x86)\EA Games';    s = 'ea' },
  @{ p = 'C:\Program Files\Electronic Arts';   s = 'ea' },
  @{ p = 'C:\Riot Games';                      s = 'riot' },
  @{ p = 'C:\XboxGames';                       s = 'xbox' },
  @{ p = 'C:\Program Files\ModifiableWindowsApps'; s = 'xbox' },
  @{ p = 'C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\games'; s = 'ubisoft' },
  @{ p = 'C:\Program Files (x86)\Battle.net\Games'; s = 'battlenet' },
  @{ p = 'C:\Program Files (x86)\GOG Galaxy\Games'; s = 'gog' },
  @{ p = 'C:\Program Files\Rockstar Games';    s = 'rockstar' }
)
foreach ($r in $dirRoots) {
  if (Test-Path $r.p) {
    $roots += $r.p
    foreach ($d in (Get-ChildItem $r.p -Directory)) {
      # These roots hold more than games. UE_* is the Unreal ENGINE/editor -- heavy
      # creative work that belongs in 100% Performance, emphatically not a game; the
      # rest are launchers, redistributables and peripheral software.
      if ($d.Name -notmatch '(?i)^(Launcher|UE_.*|Unreal.*|Epic Online Services|GameInputRedist|SteelSeriesGG|DirectXRedist|_CommonRedist|.*Redist.*|EasyAntiCheat|Cleanup|Downloads?)$') {
        Add-Title $d.Name $null $d.FullName $r.s
      }
    }
  }
}

# --- Windows' own opinion: Game Bar's GameConfigStore ---------------------------
$gcsPaths = @()
foreach ($k in (Get-ChildItem 'HKCU:\System\GameConfigStore\Children')) {
  $p = Get-ItemProperty $k.PSPath
  if ($p.MatchedExeFullPath) { $gcsPaths += $p.MatchedExeFullPath }
  # ExeParentDirectory is usually a BARE FOLDER NAME ("tekken 8", "assettocorsa"),
  # not a full path, so it is emitted separately and matched as a path SEGMENT
  # rather than a prefix. Absolute values (some entries do carry one) still go to
  # the install-directory list where prefix matching works.
  if ($p.ExeParentDirectory) {
    if ($p.ExeParentDirectory -match '^[A-Za-z]:\\') {
      $dirs += [pscustomobject]@{ dir = $p.ExeParentDirectory; source = 'gameconfigstore' }
    } else {
      $gcsDirs += $p.ExeParentDirectory
    }
  }
}

foreach ($t in $titles) { $dirs += [pscustomobject]@{ dir = $t.dir; source = $t.source; name = $t.name } }

[pscustomobject]@{
  titles = @($titles)
  installDirs = @($dirs)
  gameConfigStorePaths = @($gcsPaths | Select-Object -Unique)
  gameConfigStoreDirs = @($gcsDirs | Select-Object -Unique)
  roots = @($roots | Select-Object -Unique)
} | ConvertTo-Json -Depth 5 -Compress
`;

function runPowerShell(script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: error.message || String(error), stderr: String(stderr || "") });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || "") });
      }
    );
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

export async function scanGameLibrary({ force = false } = {}) {
  const existing = await readGameLibrary();
  const age = existing.scannedAt ? Date.now() - Date.parse(existing.scannedAt) : Infinity;
  if (!force && existing.scanOk && Number.isFinite(age) && age < SCAN_TTL_MS) {
    return { ...existing, skipped: true, reason: "cached" };
  }
  if (process.platform !== "win32") {
    return { ...existing, skipped: true, reason: "not-windows" };
  }

  const result = await runPowerShell(SCAN_SCRIPT);
  if (!result.ok) {
    return writeGameLibrary({ ...existing, scanOk: false, scanError: result.error, scannedAt: new Date().toISOString() });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim() || "{}");
  } catch (error) {
    return writeGameLibrary({ ...existing, scanOk: false, scanError: `unparseable scan output: ${error.message}`, scannedAt: new Date().toISOString() });
  }

  const titles = { ...existing.titles };
  const installDirs = [];
  for (const dir of asArray(parsed.installDirs)) {
    const normalized = normalizePath(dir?.dir);
    if (normalized && !installDirs.some((entry) => entry.dir === normalized)) {
      installDirs.push({ dir: normalized, source: dir?.source || "scan", title: dir?.name || null });
    }
  }
  for (const gcs of asArray(parsed.gameConfigStorePaths)) {
    const key = gameKeyFor({ path: gcs });
    if (!key) continue;
    titles[key] = {
      ...(titles[key] || {}),
      key,
      title: titles[key]?.title || null,
      path: gcs,
      source: titles[key]?.source && titles[key].source !== "gameconfigstore" ? titles[key].source : "gameconfigstore",
      sourceLabel: "Windows Game Bar",
      gameConfigStore: true,
      lastSeenAt: new Date().toISOString()
    };
  }

  return writeGameLibrary({
    ...existing,
    schema: GAME_LIBRARY_SCHEMA,
    scannedAt: new Date().toISOString(),
    scanOk: true,
    scanError: null,
    roots: asArray(parsed.roots).map((r) => String(r)),
    gameConfigStorePaths: asArray(parsed.gameConfigStorePaths).map((p) => normalizePath(p)),
    gameConfigStoreDirs: asArray(parsed.gameConfigStoreDirs)
      .map((d) => String(d || "").trim().toLowerCase())
      .filter((d) => d.length >= 4 && !GENERIC_DIR_NAMES.has(d)),
    installDirs,
    titles
  });
}

export async function markGameVerdict({ key = null, path: exePath = null, name = null, verdict = null, title = null } = {}) {
  const resolvedKey = key || gameKeyFor({ path: exePath, name });
  if (!resolvedKey) return { ok: false, error: "no identifiable process" };
  if (!["game", "not-game", null].includes(verdict)) return { ok: false, error: `unknown verdict: ${verdict}` };
  const library = await readGameLibrary();
  const previous = library.titles[resolvedKey] || {};
  const titles = {
    ...library.titles,
    [resolvedKey]: {
      ...previous,
      key: resolvedKey,
      title: title || previous.title || null,
      path: exePath || previous.path || null,
      name: name || previous.name || null,
      source: previous.source || "user",
      sourceLabel: previous.sourceLabel || "You",
      userVerdict: verdict,
      userVerdictAt: new Date().toISOString()
    }
  };
  await writeGameLibrary({ ...library, titles });
  return { ok: true, key: resolvedKey, verdict };
}


export function decideLaunchStance(entry = null, prior = COMPETITIVE_PRIOR) {
  const learning = entry?.learning || {};
  const warmups = Array.isArray(learning.warmupSamples) ? learning.warmupSamples.filter((n) => Number.isFinite(n)) : [];
  const outcomes = Array.isArray(learning.outcomes) ? learning.outcomes : [];

  const competitive = outcomes.filter((o) => o.modeId === "competitive" && Number.isFinite(Number(o.score)));
  const alternative = outcomes.filter((o) => o.modeId && o.modeId !== "competitive" && Number.isFinite(Number(o.score)));
  if (alternative.length >= prior.minSamplesToDemote && competitive.length >= 1) {
    const mean = (list) => list.reduce((sum, o) => sum + Number(o.score), 0) / list.length;
    const altMean = mean(alternative);
    const compMean = mean(competitive);
    if (altMean - compMean >= prior.demoteScoreMargin) {
      return {
        stance: GAME_STANCES.balancedOk,
        confidence: 0.7,
        reason: `Across ${alternative.length} sessions this title scored ${Math.round(altMean - compMean)} points better outside Competitive — enough to clear the demotion bar (${prior.minSamplesToDemote} sessions, +${prior.demoteScoreMargin}).`,
        prior: prior.id
      };
    }
  }

  if (warmups.length >= prior.minSamplesToPromote) {
    const sorted = [...warmups].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= prior.promoteWarmupSec) {
      return {
        stance: GAME_STANCES.immediateCompetitive,
        confidence: 0.8,
        reason: `This title reaches real play in ~${Math.round(median)}s across ${warmups.length} launches — Competitive from launch rather than waiting.`,
        prior: prior.id
      };
    }
  }

  return {
    stance: GAME_STANCES.engageOnActivity,
    confidence: warmups.length ? 0.6 : 0.5,
    reason: warmups.length
      ? `Recognized as a game immediately; engaging Competitive once it is actually rendering (median warm-up ~${Math.round([...warmups].sort((a, b) => a - b)[Math.floor(warmups.length / 2)])}s).`
      : "Recognized as a game immediately; engaging Competitive once it is actually rendering. No launch history for this title yet.",
    prior: prior.id
  };
}

function bounded(list, value) {
  return [...(Array.isArray(list) ? list : []), value].slice(-MAX_SAMPLES);
}

export async function recordGameWarmup({ key = null, seconds = null, title = null } = {}) {
  const value = Number(seconds);
  if (!key || !Number.isFinite(value) || value < 0) return null;
  const library = await readGameLibrary();
  const previous = library.titles[key] || { key };
  const learning = previous.learning || {};
  const next = {
    ...previous,
    key,
    title: title || previous.title || null,
    learning: {
      ...learning,
      launches: Number(learning.launches || 0) + 1,
      warmupSamples: bounded(learning.warmupSamples, Math.round(value)),
      lastLaunchAt: new Date().toISOString()
    }
  };
  next.learning.stance = decideLaunchStance(next);
  await writeGameLibrary({ ...library, titles: { ...library.titles, [key]: next } });
  return next.learning.stance;
}

export async function recordGameOutcome({ key = null, modeId = null, score = null, rationaleId = COMPETITIVE_PRIOR.id, thermal = null } = {}) {
  const value = Number(score);
  if (!key || !modeId || !Number.isFinite(value)) return null;
  const library = await readGameLibrary();
  const previous = library.titles[key] || { key };
  const learning = previous.learning || {};
  const next = {
    ...previous,
    key,
    learning: {
      ...learning,
      outcomes: bounded(learning.outcomes, { modeId, score: value, at: new Date().toISOString(), rationaleId }),
      thermalProfile: thermal ? mergeThermalFingerprint(learning.thermalProfile, thermal) : (learning.thermalProfile || null)
    }
  };
  next.learning.stance = decideLaunchStance(next);
  await writeGameLibrary({ ...library, titles: { ...library.titles, [key]: next } });
  return next.learning.stance;
}

export function mergeThermalFingerprint(profile = null, sample = {}) {
  const prior = profile && typeof profile === "object" ? profile : { sessions: 0 };
  const n = Number(prior.sessions) || 0;
  const roll = (avg, value) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return avg ?? null;
    const a = Number(avg);
    return Number.isFinite(a) ? Math.round(((a * n + v) / (n + 1)) * 10) / 10 : v;
  };
  const engagements = Array.isArray(sample.engagementTemps) ? sample.engagementTemps : [];
  const engagementCpu = engagements.map((e) => Number(e?.cpuC)).filter(Number.isFinite);
  const engagementAvg = engagementCpu.length
    ? engagementCpu.reduce((a, b) => a + b, 0) / engagementCpu.length
    : null;
  return {
    sessions: n + 1,
    cpuMaxAvgC: roll(prior.cpuMaxAvgC, sample.cpuMaxC),
    gpuMaxAvgC: roll(prior.gpuMaxAvgC, sample.gpuMaxC),
    engagementCpuAvgC: roll(prior.engagementCpuAvgC, engagementAvg),
    lastSessionAt: new Date().toISOString()
  };
}

export function titleThermalBias(entry = null, { warmLineC = 90, minSessions = 3 } = {}) {
  const profile = entry?.learning?.thermalProfile;
  if (!profile || Number(profile.sessions) < minSessions) return { state: "unknown" };
  const cpuAvg = Number(profile.cpuMaxAvgC);
  if (Number.isFinite(cpuAvg) && cpuAvg >= warmLineC) {
    return { state: "warm-title", cpuMaxAvgC: cpuAvg, reason: `${entry.title || entry.key} averages ${cpuAvg}°C CPU peaks across ${profile.sessions} sessions — eases one tier sooner when warm.` };
  }
  return { state: "neutral", cpuMaxAvgC: Number.isFinite(cpuAvg) ? cpuAvg : null };
}

export const BAND_TRIAL = Object.freeze({
  arms: [3, 4],
  minSamplesPerArm: 4,
  marginPct: 3,           // 04 must beat 05's 1% lows by >3% to win a demotion
  redecideAfterDays: 30
});

export function decideBandTrial(entry = null, trial = BAND_TRIAL, nowMs = Date.now()) {
  const data = entry?.learning?.bandTrial || {};
  const samples = data.samples || {};
  const s3 = Array.isArray(samples["3"]) ? samples["3"] : [];
  const s4 = Array.isArray(samples["4"]) ? samples["4"] : [];
  const decidedMs = data.decidedAt ? Date.parse(data.decidedAt) : NaN;
  if (Number.isFinite(Number(data.decidedTier)) && Number.isFinite(decidedMs)
    && nowMs - decidedMs < trial.redecideAfterDays * 24 * 60 * 60 * 1000) {
    return { active: false, tier: Number(data.decidedTier), reason: data.decidedReason || "trial concluded", samples: { t3: s3.length, t4: s4.length } };
  }
  const median = (list) => {
    const values = list.map((s) => Number(s.p1LowFps)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  if (s3.length >= trial.minSamplesPerArm && s4.length >= trial.minSamplesPerArm) {
    const m3 = median(s3);
    const m4 = median(s4);
    if (m3 != null && m4 != null) {
      const tier = m3 > m4 * (1 + trial.marginPct / 100) ? 3 : 4;
      const reason = tier === 3
        ? `04 High measured better 1% lows than 05 (${m3} vs ${m4} fps median across ${s3.length}+${s4.length} sessions) — running this title at 04.`
        : `05 Ultra holds: 1% lows ${m4} vs ${m3} fps median (${s4.length}+${s3.length} sessions).`;
      return { active: false, tier, reason, decided: true, samples: { t3: s3.length, t4: s4.length } };
    }
  }
  const arm = s4.length <= s3.length ? 4 : 3;
  return {
    active: true,
    tier: arm,
    reason: `band trial in progress (04: ${s3.length}, 05: ${s4.length} of ${trial.minSamplesPerArm} sessions each) — this session runs ${arm === 4 ? "05 Ultra" : "04 High"}.`,
    samples: { t3: s3.length, t4: s4.length }
  };
}

export async function recordBandTrialSample({ key = null, tier = null, p1LowFps = null, stutterRatio = null } = {}) {
  const armTier = Number(tier);
  if (!key || ![3, 4].includes(armTier) || !Number.isFinite(Number(p1LowFps))) return null;
  const library = await readGameLibrary();
  const previous = library.titles[key] || { key };
  const learning = previous.learning || {};
  const data = learning.bandTrial || { samples: {} };
  const armKey = String(armTier);
  const samples = { ...(data.samples || {}) };
  samples[armKey] = [...(Array.isArray(samples[armKey]) ? samples[armKey] : []), {
    p1LowFps: Number(p1LowFps),
    stutterRatio: Number(stutterRatio) || 0,
    at: new Date().toISOString()
  }].slice(-10);
  const next = {
    ...previous,
    key,
    learning: { ...learning, bandTrial: { ...data, samples } }
  };
  const decision = decideBandTrial(next);
  if (decision.decided) {
    next.learning.bandTrial.decidedTier = decision.tier;
    next.learning.bandTrial.decidedAt = new Date().toISOString();
    next.learning.bandTrial.decidedReason = decision.reason;
  }
  await writeGameLibrary({ ...library, titles: { ...library.titles, [key]: next } });
  return decision;
}

export async function enrollFlipOptimization({ key = null, path: exePath = null } = {}) {
  if (process.platform !== "win32" || !key || !exePath) return { ok: false, skipped: true };
  const library = await readGameLibrary();
  const entry = library.titles[key];
  if (entry?.flipEnrolledAt) return { ok: true, already: true };
  const winPath = String(exePath).replace(/\//g, "\\");
  const script = `
$k = 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
New-Item -Path $k -Force | Out-Null
$name = '${winPath.replace(/'/g, "''")}'
$existing = (Get-ItemProperty -Path $k -Name $name -ErrorAction SilentlyContinue).$name
if ($existing -and $existing -match 'SwapEffectUpgradeEnable=1') { Write-Output 'already'; exit }
$value = if ($existing) { ($existing.TrimEnd(';') + ';SwapEffectUpgradeEnable=1;') } else { 'SwapEffectUpgradeEnable=1;' }
Set-ItemProperty -Path $k -Name $name -Value $value
Write-Output 'set'
`;
  const result = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15000, windowsHide: true },
      (error, stdout) => resolve({ ok: !error, out: String(stdout || "").trim(), error: error ? String(error.message) : null }));
  });
  if (result.ok) {
    const titles = { ...library.titles, [key]: { ...(entry || { key }), flipEnrolledAt: new Date().toISOString() } };
    await writeGameLibrary({ ...library, titles });
  }
  return { ok: result.ok, action: result.out || null, error: result.error };
}

export async function gameLibrarySnapshot() {
  const library = await readGameLibrary();
  const titles = Object.values(library.titles);
  return {
    scannedAt: library.scannedAt,
    scanOk: library.scanOk,
    scanError: library.scanError,
    roots: library.roots,
    indexedTitles: titles.length,
    installDirs: library.installDirs.length,
    gameConfigStoreEntries: library.gameConfigStorePaths.length + (library.gameConfigStoreDirs || []).length,
    userMarked: titles.filter((t) => t.userVerdict).length,
    prior: COMPETITIVE_PRIOR,
    titles: titles
      .map((t) => ({
        key: t.key,
        title: t.title,
        path: t.path || null,
        source: t.sourceLabel || t.source || null,
        userVerdict: t.userVerdict || null,
        launches: t.learning?.launches || 0,
        stance: t.learning?.stance?.stance || COMPETITIVE_PRIOR.startingStance,
        stanceReason: t.learning?.stance?.reason || null
      }))
      .sort((a, b) => (b.launches - a.launches) || String(a.title || a.key).localeCompare(String(b.title || b.key)))
  };
}
