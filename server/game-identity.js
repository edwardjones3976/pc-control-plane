
export const GAME_MODE_RATIONALE = Object.freeze({
  id: "competitive-prior",
  headline: "A game is soft-real-time work: it has a per-frame deadline, and a missed frame cannot be made up.",
  points: Object.freeze([
    "Per-frame deadline (16.7 ms @60Hz, 8.3 ms @120Hz) — lateness is visible, not amortizable.",
    "Stutter comes from VARIANCE: core parking and lazy clock ramps miss the budget exactly when load spikes.",
    "Input-to-photon latency is the product being bought in a competitive title.",
    "Asymmetric loss: too much power costs a few recoverable degrees; too little costs an unrecoverable round.",
    "The downside is already bounded by the thermal hierarchy, the gaming CPU line and the learned guardrail — all of which outrank this prior."
  ]),
  learnerScope: "Find the exceptions (heat, lull, light titles). Do not re-derive whether gaming wants Competitive."
});

export const GAME_ROOTS = Object.freeze([
  { id: "steam", label: "Steam", parts: ["\\steamapps\\common\\"] },
  { id: "epic", label: "Epic Games", parts: ["\\epic games\\"] },
  { id: "riot", label: "Riot Games", parts: ["\\riot games\\"] },
  { id: "ea", label: "EA", parts: ["\\ea games\\", "\\electronic arts\\", "\\ea desktop\\games\\"] },
  { id: "ubisoft", label: "Ubisoft", parts: ["\\ubisoft\\ubisoft game launcher\\games\\", "\\ubisoft games\\"] },
  { id: "battlenet", label: "Battle.net", parts: ["\\battle.net\\games\\", "\\world of warcraft\\", "\\overwatch\\", "\\diablo iv\\", "\\hearthstone\\"] },
  { id: "xbox", label: "Xbox / Game Pass", parts: ["\\xboxgames\\", "\\modifiablewindowsapps\\"] },
  { id: "gog", label: "GOG", parts: ["\\gog galaxy\\games\\", "\\gog games\\"] },
  { id: "rockstar", label: "Rockstar", parts: ["\\rockstar games\\"] }
]);

export const NON_GAME_PATH_PARTS = Object.freeze([
  "\\ue_", "\\unreal engine\\", "\\engine\\binaries\\", "\\engine\\build\\",
  "\\epic games\\launcher\\", "\\epic online services\\", "\\gameinputredist\\",
  "\\unity\\hub\\", "\\unity\\editor\\", "\\godot\\", "\\cryengine\\",
  "\\_commonredist\\", "\\directxredist\\", "\\steamworks shared\\", "\\steamvr\\"
]);

export const NON_GAME_EXE_NAMES = Object.freeze([
  "steam", "steamwebhelper", "steamservice", "steamerrorreporter", "gameoverlayui",
  "epicgameslauncher", "epicwebhelper", "epiconlineservicesuserhelper", "eosoverlayrenderer",
  "riotclientservices", "riotclientux", "riotclientuxrender", "riotclientcrashhandler",
  "eadesktop", "ealauncher", "eabackgroundservice", "origin", "originwebhelperservice",
  "upc", "uplaywebcore", "ubisoftgamelauncher", "ubisoftconnect",
  "battle.net", "battle.net helper", "agent", "blizzarderror",
  "galaxyclient", "galaxyclienthelper", "gogglaxycommunication",
  "rockstarservice", "rockstarerrorhandler", "launcherpatcher",
  "unrealcefsubprocess", "cefsubprocess", "qtwebengineprocess", "msedgewebview2", "webview2",
  "crashreportclient", "crashreportclienteditor", "crashpad_handler",
  "easyanticheat", "easyanticheat_eos", "eac_launcher", "beservice", "bedaisy",
  "marvelrivals_launcher",
  "unrealeditor", "unrealeditor-cmd", "unrealeditor-win64-debuggame", "shadercompileworker",
  "unrealbuildtool", "unrealheadertool", "unrealpak", "unrealinsights", "unrealfrontend",
  "unrealversionselector", "livecodingconsole", "epicgamesbootstrapper",
  "unity", "unityhub", "unitycrashhandler64", "unityshadercompiler", "godot", "godot_console"
]);

export const ANTI_CHEAT_EXACT = Object.freeze(["vgc", "vgk", "eac", "beservice", "bedaisy"]);
export const ANTI_CHEAT_PARTS = Object.freeze([
  "easyanticheat", "battleye", "vanguard", "faceitclient", "esea", "ricochet"
]);

export function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/\.exe$/, "");
}

export function normalizePath(value) {
  return String(value || "").trim().replace(/\//g, "\\").toLowerCase();
}

export function gameKeyFor({ path = null, name = null } = {}) {
  const p = normalizePath(path);
  if (p) return `path:${p}`;
  const n = normalizeName(name);
  return n ? `name:${n}` : null;
}

export function titleFromPath(rawPath, fallbackName = null) {
  const raw = String(rawPath || "").replace(/\//g, "\\");
  const lower = raw.toLowerCase();
  for (const root of GAME_ROOTS) {
    for (const part of root.parts) {
      const at = lower.indexOf(part);
      if (at >= 0) {
        const rest = raw.slice(at + part.length);
        const folder = rest.split("\\").filter(Boolean)[0];
        if (folder && !/\.exe$/i.test(folder)) return folder;
      }
    }
  }
  return fallbackName ? String(fallbackName) : null;
}

export function isNonGamePath(rawPath) {
  const p = normalizePath(rawPath);
  if (!p) return false;
  return NON_GAME_PATH_PARTS.some((part) => p.includes(part));
}

export function rootForPath(rawPath) {
  const p = normalizePath(rawPath);
  if (!p || isNonGamePath(p)) return null;
  for (const root of GAME_ROOTS) {
    if (root.parts.some((part) => p.includes(part))) return root;
  }
  return null;
}

export function isNonGameExe(name) {
  return NON_GAME_EXE_NAMES.includes(normalizeName(name));
}

export function isAntiCheatProcess(name) {
  const n = normalizeName(name);
  if (!n) return false;
  return ANTI_CHEAT_EXACT.includes(n) || ANTI_CHEAT_PARTS.some((part) => n.includes(part));
}

export function antiCheatPresence(processes = []) {
  const list = Array.isArray(processes) ? processes : [];
  const hits = list.filter((process) => isAntiCheatProcess(process?.name)).map((process) => normalizeName(process.name));
  return { present: hits.length > 0, names: [...new Set(hits)] };
}

export const GAME_EVIDENCE_WEIGHTS = Object.freeze({
  userConfirmed: 1,      // the owner said so. Decisive, both directions.
  libraryTitle: 0.85,    // exe is in the scanned local game library
  gameConfigStore: 0.8,  // Windows' own Game Bar classified this exe as a game
  launcherPath: 0.75,    // installed under a known store root
  antiCheat: 0.45,       // EAC/BattlEye/Vanguard live on the machine
  engine3d: 0.4,         // this PID is measurably driving the GPU 3D engine
  fullscreenGpu: 0.25    // the legacy heuristic, demoted to a nudge
});

export const GAME_CONFIRMED_AT = 0.7;  // >= this is a game we act on
export const GAME_LIKELY_AT = 0.4;     // >= this is a candidate, below is not a game

export function matchLibraryEntry(library, { key = null, path: exePath = null } = {}) {
  const titles = library?.titles;
  if (!titles || typeof titles !== "object") return null;
  if (key && titles[key]) return titles[key];
  const p = normalizePath(exePath);
  if (p && titles[`path:${p}`]) return titles[`path:${p}`];
  return null;
}

export function matchInstallDir(library, exePath) {
  const p = normalizePath(exePath);
  const dirs = Array.isArray(library?.installDirs) ? library.installDirs : [];
  if (!p || dirs.length === 0) return null;
  let best = null;
  for (const entry of dirs) {
    const dir = normalizePath(entry?.dir);
    if (!dir) continue;
    const prefix = dir.endsWith("\\") ? dir : `${dir}\\`;
    if (p.startsWith(prefix) && (!best || prefix.length > best._len)) {
      best = { ...entry, dir, _len: prefix.length };
    }
  }
  return best;
}

export function matchGameConfigStoreDir(library, exePath) {
  const known = Array.isArray(library?.gameConfigStoreDirs) ? library.gameConfigStoreDirs : [];
  const p = normalizePath(exePath);
  if (!p || known.length === 0) return null;
  const segments = new Set(p.split("\\").filter(Boolean));
  return known.find((dir) => segments.has(String(dir || "").toLowerCase())) || null;
}

export function matchGameConfigStoreExeName(library, processName) {
  const n = normalizeName(processName);
  const known = Array.isArray(library?.gameConfigStorePaths) ? library.gameConfigStorePaths : [];
  if (!n || known.length === 0 || isNonGameExe(n)) return null;
  return known.find((exePath) => {
    const p = normalizePath(exePath);
    const exe = normalizeName(p.split("\\").filter(Boolean).pop() || "");
    return exe && exe === n;
  }) || null;
}

export function classifyGameCandidate({
  process = null,
  foreground = null,
  processes = [],
  library = null,
  gpuUtil = 0,
  fullscreen = false,
  borderlessFullscreen = false,
  gpu3dPctByPid = null,
  computeApp = false
} = {}) {
  const name = normalizeName(process?.name);
  const capturedPath = process?.path || (foreground && Number(foreground.pid) === Number(process?.pid) ? foreground.path : null);
  const inferredPath = capturedPath ? null : matchGameConfigStoreExeName(library, name);
  const rawPath = capturedPath || inferredPath;
  const path = normalizePath(rawPath);
  const key = gameKeyFor({ path: rawPath, name });
  const evidence = [];
  const none = {
    isGame: false, likely: false, confidence: 0, key, name: name || null, path: rawPath || null,
    title: null, source: null, evidence, userVerdict: null, rationale: GAME_MODE_RATIONALE
  };
  if (!name) return none;

  if (isNonGameExe(name)) {
    evidence.push({ id: "non-game-exe", weight: 0, detail: `${name} is a launcher, engine, or helper process — not a game binary.` });
    return { ...none, evidence };
  }
  if (isNonGamePath(path)) {
    evidence.push({ id: "non-game-path", weight: 0, detail: "Runs from a game-engine / toolchain directory, not a game install." });
    return { ...none, evidence };
  }

  const entry = matchLibraryEntry(library, { key, path });
  const installDir = matchInstallDir(library, path);

  if (entry?.userVerdict === "not-game") {
    evidence.push({ id: "user-verdict", weight: 0, detail: "You marked this as not a game." });
    return { ...none, evidence, userVerdict: "not-game", title: entry.title || null };
  }
  if (entry?.userVerdict === "game") {
    evidence.push({ id: "user-verdict", weight: GAME_EVIDENCE_WEIGHTS.userConfirmed, detail: "You marked this as a game." });
  }

  const displayTitle = entry?.title || installDir?.title || titleFromPath(rawPath, null) || name;

  if (entry && entry.source && entry.source !== "user") {
    evidence.push({
      id: "library-title",
      weight: GAME_EVIDENCE_WEIGHTS.libraryTitle,
      detail: `${displayTitle} is a known installed title (${entry.sourceLabel || entry.source}).`
    });
  }

  const gcsFolder = matchGameConfigStoreDir(library, path);
  if (entry?.gameConfigStore || (path && library?.gameConfigStorePaths?.includes(path))) {
    evidence.push({
      id: "gameconfigstore",
      weight: GAME_EVIDENCE_WEIGHTS.gameConfigStore,
      detail: inferredPath
        ? "Windows Game Bar has a matching game executable registered; live process path was unavailable."
        : "Windows Game Bar has this exe registered as a game."
    });
  } else if (gcsFolder) {
    evidence.push({
      id: "gameconfigstore",
      weight: GAME_EVIDENCE_WEIGHTS.gameConfigStore,
      detail: `Windows Game Bar knows "${gcsFolder}" as a game folder.`
    });
  }

  const root = rootForPath(path);
  if (root) {
    evidence.push({
      id: "launcher-path",
      weight: GAME_EVIDENCE_WEIGHTS.launcherPath,
      detail: `Installed under ${root.label} (${root.parts.find((part) => path.includes(part))}).`
    });
  } else if (installDir) {
    evidence.push({
      id: "launcher-path",
      weight: GAME_EVIDENCE_WEIGHTS.launcherPath,
      detail: `Installed in a known game directory (${installDir.title || installDir.dir}).`
    });
  }

  const ac = antiCheatPresence(processes);
  if (ac.present) {
    evidence.push({
      id: "anti-cheat",
      weight: GAME_EVIDENCE_WEIGHTS.antiCheat,
      detail: `Anti-cheat runtime active (${ac.names.join(", ")}).`
    });
  }

  const pid = Number(process?.pid);
  const engine3d = gpu3dPctByPid && Number.isFinite(pid) ? Number(gpu3dPctByPid[pid]) : null;
  if (Number.isFinite(engine3d) && engine3d >= 10) {
    evidence.push({
      id: "engine-3d",
      weight: GAME_EVIDENCE_WEIGHTS.engine3d,
      detail: `Driving the GPU 3D engine at ${Math.round(engine3d)}% (not video decode).`
    });
  }

  if (!computeApp && (fullscreen || borderlessFullscreen || Number(gpuUtil) >= 25)) {
    evidence.push({
      id: "fullscreen-gpu",
      weight: GAME_EVIDENCE_WEIGHTS.fullscreenGpu,
      detail: `Fullscreen/GPU-driven foreground workload (GPU ${Math.round(Number(gpuUtil) || 0)}%).`
    });
  }

  const weights = evidence.map((item) => item.weight).filter((w) => w > 0);
  if (weights.length === 0) return { ...none, evidence, title: entry?.title || null };
  const strongest = Math.max(...weights);
  const corroboration = Math.min(0.15, 0.05 * (weights.length - 1));
  const confidence = Math.min(1, Number((strongest + corroboration).toFixed(3)));
  const strongestEvidence = evidence.find((item) => item.weight === strongest) || null;

  return {
    isGame: confidence >= GAME_CONFIRMED_AT,
    likely: confidence >= GAME_LIKELY_AT,
    confidence,
    key,
    name,
    path: rawPath || null,
    pathInferred: Boolean(inferredPath),
    title: displayTitle,
    source: strongestEvidence?.id || null,
    reason: strongestEvidence?.detail || null,
    evidence,
    userVerdict: entry?.userVerdict || null,
    antiCheat: ac.names,
    engine3dPct: Number.isFinite(engine3d) ? engine3d : null,
    rationale: GAME_MODE_RATIONALE
  };
}

export function shouldProbe3dEngine(verdict, { fullscreen = false, gpuUtil = 0 } = {}) {
  if (!verdict) return false;
  if (verdict.userVerdict) return false;             // the owner already decided
  if (verdict.confidence >= GAME_CONFIRMED_AT) return false; // already certain
  const heuristicWouldFire = Boolean(fullscreen) || Number(gpuUtil) >= 25;
  return heuristicWouldFire && verdict.confidence < GAME_CONFIRMED_AT;
}
