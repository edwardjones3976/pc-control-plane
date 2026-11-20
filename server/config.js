import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const appRoot = path.resolve(serverDir, "..");
export const workspaceRoot = path.resolve(appRoot, "..");
export const publicDir = path.join(appRoot, "public");
const configuredDataDir = process.env.PC_CONTROL_DATA_DIR;
const configuredOwnerDir = process.env.PC_CONTROL_OWNERSHIP_DIR;
for (const [name, value] of [["PC_CONTROL_DATA_DIR", configuredDataDir], ["PC_CONTROL_OWNERSHIP_DIR", configuredOwnerDir]]) {
  if (value && (!path.isAbsolute(value) ||
      (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(value)))) {
    throw new Error(`${name} must be an absolute local path.`);
  }
}
export const dataDir = configuredDataDir ? path.normalize(configuredDataDir) : path.join(appRoot, "data");
export const statePath = path.join(dataDir, "state.json");
export const auditPath = path.join(dataDir, "audit.jsonl");
export const auditArchiveRoot = process.env.PC_CONTROL_AUDIT_ARCHIVE_DIR ||
  path.join(dataDir, "audit-archive");
export const archiveRoot = process.env.PC_CONTROL_ARCHIVE_DIR ||
  path.join(dataDir, "learning-archive");
export const learnedSessionWindow = (() => {
  const n = Math.round(Number(process.env.PC_CONTROL_LEARN_SESSION_WINDOW || 40));
  return Number.isFinite(n) ? Math.max(10, Math.min(200, n)) : 40;
})();
export const auditDisplayDays = Number(process.env.PC_CONTROL_AUDIT_DISPLAY_DAYS || 6);
export const auditStatusLimit = Number(process.env.PC_CONTROL_AUDIT_STATUS_LIMIT || 3000);
export const ledgerPath = path.join(dataDir, "ledger.jsonl");
export const lockPath = path.join(configuredOwnerDir || dataDir, "server.lock.json");
export const plansDir = path.join(dataDir, "plans");
export const snapshotsDir = path.join(dataDir, "snapshots");
export const recoveryPath = path.join(dataDir, "recovery.json");
export const priorityAppSessionsPath = path.join(dataDir, "health-sessions.json");
export const contextSessionsPath = path.join(dataDir, "context-sessions.json");
export const diagnosticTrapsDir = path.join(dataDir, "diagnostic-traps");
export const diagnosticTrapsPath = path.join(dataDir, "diagnostic-traps.json");

export const scripts = Object.freeze({
  fullCapacity: path.join(workspaceRoot, "apply_full_capacity_hardware_profile.ps1"),
  inputLowLatency: path.join(workspaceRoot, "apply_input_low_latency_profile.ps1"),
  networkPerformance: path.join(workspaceRoot, "apply_network_performance_profile.ps1"),
  hagsDisabled: path.join(workspaceRoot, "Set-HAGS-Disabled-Elevated.ps1"),
  releaseMemory: path.join(appRoot, "scripts", "relieve-memory.ps1"),
  relieveCpu: path.join(appRoot, "scripts", "relieve-cpu.ps1"),
  mouseControl: path.join(appRoot, "scripts", "mouse-control.ps1"),
  elevatedLauncher: path.join(appRoot, "Start PC Control Plane.bat")
});

export const modes = Object.freeze([
  {
    id: "conservative",
    label: "Conservative",
    shortLabel: "Conserve",
    powerPlanName: "01 - Power Saver (Emergency)",
    risk: "low",
    color: "green",
    intent: "Quiet, cool, stable use with minimal intervention.",
    automation: "Observe first, refresh only when a helper is clearly stuck.",
    actorPolicy: "Observe contention without constraining user work."
  },
  {
    id: "balanced",
    label: "Balanced",
    shortLabel: "Balanced",
    powerPlanName: "03 - Balanced Mode (Daily Driver)",
    risk: "low",
    color: "cyan",
    intent: "Daily driver behavior for browsing, school, media, and normal work.",
    automation: "Keep health visible, avoid vendor churn, and prefer restore over force.",
    actorPolicy: "Mode switch and safe restore actions only."
  },
  {
    id: "performance",
    label: "100% Performance",
    shortLabel: "100%",
    powerPlanName: "04 - High Power Mode",
    risk: "medium",
    color: "amber",
    intent: "High responsiveness without overdrive behavior.",
    automation: "Raise power state, reduce obvious background contention, keep rollback state.",
    actorPolicy: "Use high power and session-scoped cleanup only."
  },
  {
    id: "competitive",
    label: "Competitive Gaming",
    shortLabel: "Competitive",
    powerPlanName: "04 - High Power Mode",
    risk: "medium",
    color: "red",
    intent: "Competitive gaming sessions with low latency, stable frametimes, and conservative system-health guardrails.",
    automation: "Raise the power profile, watch foreground contention, preserve protected apps, and avoid process constraints.",
    actorPolicy: "Only session-scoped health actions are allowed."
  },
  {
    id: "agentic",
    label: "Agentic Work",
    shortLabel: "Agentic",
    powerPlanName: "03 - Balanced Mode (Daily Driver)",
    risk: "medium",
    color: "violet",
    intent: "Codex, Claude, Docker, browsers, and local services get memory-aware protection.",
    automation: "Watch Python, Node, Docker, ports, and memory pressure without automatic process constraints.",
    actorPolicy: "Do not close or downgrade active agents automatically."
  },
  {
    id: "overdrive",
    label: "Overdrive",
    shortLabel: "Overdrive",
    powerPlanName: "05 - Ultra Performance",
    risk: "high",
    color: "red",
    intent: "Maximum Windows-side performance with a strict safety boundary.",
    automation: "Use the highest available power profile, but no BIOS, voltage, driver, firmware, or process-constraint automation.",
    actorPolicy: "Requires explicit apply. Dangerous low-level work stays manual/elevated."
  }
]);

export const protectedAppRules = Object.freeze([
  {
    id: "hyperx",
    label: "HyperX / NGENUITY",
    match: ["hyperx", "ngenuity"],
    reason: "Headset and audio control must stay available."
  },
  {
    id: "phone-link",
    label: "Phone Link / CrossDevice",
    match: ["phoneexperiencehost", "crossdevice", "yourphone"],
    reason: "User explicitly asked to keep Phone Link and CrossDevice active."
  },
  {
    id: "audio",
    label: "Windows Audio",
    match: ["audiodg", "sihost", "shellexperiencehost"],
    reason: "Core shell and audio stability."
  },
  {
    id: "input",
    label: "Input Devices",
    match: ["logi", "lghub", "onboardmemorymanager", "textinputhost", "ctfmon"],
    reason: "Mouse, keyboard, and text input should not be disrupted."
  },
  {
    id: "security",
    label: "Security Core",
    match: ["msmpeng", "securityhealthservice", "securityhealthsystray", "bdservicehost"],
    reason: "Security tools are never globally disabled by the control plane."
  },
  {
    id: "agentic-tools",
    label: "Agentic / Model Tooling",
    match: [
      "aider",
      "anythingllm",
      "chatbox",
      "chatgpt",
      "claude",
      "cline",
      "code",
      "codeium",
      "codex",
      "com.docker",
      "continue",
      "cursor",
      "deepseek",
      "docker",
      "docker desktop",
      "exllama",
      "gemini",
      "gh",
      "github copilot",
      "gpt4all",
      "grok",
      "huggingface",
      "jan",
      "kobold",
      "koboldcpp",
      "localai",
      "llama",
      "llama.cpp",
      "llama-server",
      "llamacpp",
      "llamafile",
      "lm studio",
      "lmstudio",
      "mistral",
      "node",
      "node_repl",
      "npm",
      "npx",
      "oobabooga",
      "ollama",
      "open-webui",
      "openai",
      "pearai",
      "perplexity",
      "pip",
      "pnpm",
      "powershell",
      "pwsh",
      "qwen",
      "roo",
      "roo-cline",
      "supermaven",
      "tabby",
      "text-generation-launcher",
      "text-generation-server",
      "python",
      "pythonw",
      "text-generation-webui",
      "trae",
      "transformers",
      "uv",
      "uvx",
      "vllm",
      "vmmem",
      "vscode",
      "windsurf",
      "wsl",
      "yarn"
    ],
    reason: "Agentic models, coding agents, runtimes, and local model servers are permanently whitelisted."
  },
]);

export const modeProtectedMatches = Object.freeze({
  agentic: ["codex", "claude", "docker desktop", "com.docker", "docker", "node", "python"],
  competitive: ["hyperx", "ngenuity", "phoneexperiencehost", "crossdevice", "yourphone", "audiodg", "logi", "lghub"]
});

export const backgroundHazards = Object.freeze([
  {
    id: "codex",
    label: "Codex",
    match: ["codex"],
    competitiveAction: "permanently whitelisted; observe only",
    agenticAction: "protect and monitor memory"
  },
  {
    id: "docker",
    label: "Docker Desktop",
    match: ["docker desktop", "com.docker", "docker"],
    competitiveAction: "permanently whitelisted; observe only",
    agenticAction: "protect and watch memory/ports"
  },
  {
    id: "grammarly",
    label: "Grammarly",
    match: ["grammarly"],
    competitiveAction: "observe only during competitive gaming sessions",
    agenticAction: "refresh only if broken"
  },
  {
    id: "webview",
    label: "Extra Browser/WebView",
    match: ["msedge", "chrome", "webview2"],
    competitiveAction: "observe nonessential windows by session rule",
    agenticAction: "observe unless memory pressure is high"
  }
]);

export const defaultState = Object.freeze({
  modeId: "balanced",
  pinned: false,
  autonomy: "auto-safe",
  learningInfluence: true,
  overdriveArmedAt: null,
  lastAppliedAt: null,
  lastAction: null,
  notes: [
    "Observer is always light.",
    "Actor only changes settings through explicit mode/session actions.",
    "Firmware, BIOS, voltage, and driver switching are not automated."
  ]
});
