import { renderNetworkQuality } from "./network-quality.js";
import { createControlClient } from "./control-client.js";
import { createRefreshGate, monitoringState, setMarkup } from "./render-state.js";

const state = {
  status: null,
  selectedModeId: null,
  modeSelectionDirty: false,
  workloadDiscovery: null,
  architecture: null,
  dryRunPlan: null,
  restorePreviewUntil: 0,
  restorePreviewTimer: null,
  stressReport: null,
  busy: false,
  lastUpdateAt: 0,
  connectionFailed: false,
  refreshing: false,
  modeStartedAt: Date.now(),
  visualTelemetry: null,
  telemetryAnimation: null,
  auditOpenGroups: new Set(),
  auditGroupsInitialized: false,
  viewMode: localStorage.getItem("pcControlPlaneViewMode") || "cockpit",
  telemetryHistory: {
    cpu: [],
    ram: [],
    gpu: [],
    vram: [],
    power: []
  }
};

const RESTORE_PREVIEW_WINDOW_MS = 60 * 1000;
const AUDIT_VISIBLE_PER_DAY = 8;
const TELEMETRY_STABLE_PAINT_DELAY_MS = 120;

const modeMeta = {
  conservative: { icon: "shield", color: "#dce5ea", subtitle: "Quiet • Cool • Stable" },
  balanced: { icon: "box", color: "#5ab9ff", subtitle: "Daily Driver" },
  performance: { icon: "bolt", color: "#f2bf24", subtitle: "High Power • Low Latency" },
  competitive: { icon: "gauge", color: "#59d34f", subtitle: "Competitive • Low Latency" },
  agentic: { icon: "agents", color: "#5ab9ff", subtitle: "Dev • Docker • Agents" },
  overdrive: { icon: "flame", color: "#ff684c", subtitle: "Exceeds Typical Limits" }
};

const protectedRows = [
  ["HyperX NGENUITY.exe", "Peripheral", "Headset / Audio", "Allowed"],
  ["phoneexperiencehost.exe", "System", "Phone Link", "Allowed"],
  ["explorer.exe", "System", "Shell", "Allowed"],
  ["Web.exe", "Platform", "Launcher", "Allowed"],
  ["audiodg.exe", "System", "Audio Engine", "Allowed"]
];

function $(id) {
  return document.getElementById(id);
}

function icon(name) {
  const icons = {
    shield: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg>',
    box: '<svg viewBox="0 0 24 24"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
    gauge: '<svg viewBox="0 0 24 24"><path d="M4 14a8 8 0 1 1 16 0"/><path d="M12 14l4-5"/><path d="M6 18h12"/><path d="M8 14h.01M16 14h.01"/></svg>',
    agents: '<svg viewBox="0 0 24 24"><path d="M12 3v4"/><path d="M6 8h12v8H6z"/><path d="M8 20h8"/><path d="M9 12h.01M15 12h.01"/><path d="M4 12H2M22 12h-2"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M8 14c0 4 3 7 4 7s4-3 4-7c0-2-1-4-3-6 .2 2-.5 3.3-1.3 4C11.4 9 10 6.5 8 4c.2 3-2 5-2 8 0 5 4 9 6 9"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19 12a7 7 0 0 0-.1-1.1l2-1.5-2-3.4-2.4 1a7.4 7.4 0 0 0-1.9-1.1L14.2 3h-4.4l-.4 2.9A7.4 7.4 0 0 0 7.5 7l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.1l-2 1.5 2 3.4 2.4-1a7.4 7.4 0 0 0 1.9 1.1l.4 2.9h4.4l.4-2.9a7.4 7.4 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1.1Z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>'
  };
  return icons[name] || icons.file;
}

function fmt(value, suffix = "") {
  if (value === null || value === undefined || value === "" || Number.isNaN(value)) {
    return "--";
  }
  const number = Number(value);
  if (Number.isFinite(number)) {
    return `${Math.floor(number)}${suffix}`;
  }
  return `${value}${suffix}`;
}

function fmtDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 60_000) {
    return `${Math.max(1, Math.round(value / 1000))}s`;
  }
  if (value < 60 * 60_000) {
    return `${Math.round(value / 60_000)}m`;
  }
  return `${Math.round(value / (60 * 60_000))}h`;
}

function fmtClock(timestamp) {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
}

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.floor(n)}%` : "--";
}

function clampNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractPowerName(line) {
  const text = String(line || "");
  const first = text.indexOf("(");
  const last = text.lastIndexOf(")");
  if (first >= 0 && last > first) {
    return text.slice(first + 1, last);
  }
  return "Unavailable";
}

function powerShort(name) {
  return String(name || "")
    .replace(/^\d+\s*-\s*/, "")
    .replace(/\s*\(Daily Driver\)/, "")
    .replace(/\s+Mode$/, "");
}

function powerTierFromPlanName(name) {
  const text = String(name || "").trim().toLowerCase();
  const prefix = text.match(/^0?([1-5])\s*-/);
  if (prefix) return Number(prefix[1]) - 1;
  if (text.includes("power saver")) return 0;
  if (text.includes("endurance")) return 1;
  if (text.includes("balanced")) return 2;
  if (text.includes("high power")) return 3;
  if (text.includes("ultra")) return 4;
  return null;
}

function titleSettingLabel(label) {
  const value = String(label || "").trim();
  if (!value || value === "unknown") return "";
  return value
    .split("-")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function processorBoostLabel(boost) {
  const mode = titleSettingLabel(boost?.acLabel);
  const policy = Number(boost?.acPolicyPct);
  if (mode && Number.isFinite(policy)) return `${mode} / ${policy}%`;
  if (mode) return mode;
  if (Number.isFinite(policy)) return `Policy ${policy}%`;
  return boost?.available === false ? "Unavailable" : "--";
}

function sensorSourceLabel(value) {
  return String(value || "")
    .replace(/LibreHardwareMonitorLib/g, "LHM")
    .replace(/LibreHardwareMonitor/g, "LHM")
    .replace(/OpenHardwareMonitor/g, "OHM");
}

function fanHardwareLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Hardware sensor";
  if (/nuvoton|nct\d|super\s*i\/o|motherboard|mainboard|asus|msi|gigabyte|asrock/i.test(raw)) {
    return "Motherboard sensor";
  }
  if (/nvidia|geforce|radeon|gpu|graphics/i.test(raw)) {
    return "Graphics card sensor";
  }
  if (/cpu/i.test(raw)) {
    return "CPU sensor";
  }
  if (/pump|aio/i.test(raw)) {
    return "Cooling pump sensor";
  }
  return raw.replace(/LibreHardwareMonitorLib|LibreHardwareMonitor|OpenHardwareMonitor/g, "hardware sensor");
}

function elapsedSince(timestamp) {
  const ms = Math.max(0, Date.now() - timestamp);
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 4200);
}

const SESSION_ID = (window.crypto && window.crypto.randomUUID)
  ? window.crypto.randomUUID()
  : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
localStorage.setItem("pcControlPlaneSessionId", SESSION_ID);
let superseded = false;

function handleSuperseded(message) {
  if (superseded) {
    return;
  }
  superseded = true;
  closeStream();
  renderConnectionStatus();
  const overlay = $("supersededOverlay");
  if (overlay) {
    const msg = overlay.querySelector(".superseded-msg");
    if (msg && message) {
      msg.textContent = message;
    }
    overlay.hidden = false;
  }
  document.body.classList.add("is-superseded");
  document.querySelectorAll("button, select, input").forEach((control) => {
    if (!control.closest("#supersededOverlay")) {
      control.disabled = true;
    }
  });
}

const api = createControlClient({ session: () => SESSION_ID, onSuperseded: handleSuperseded });

let gameCorrectionTarget = null;

function renderGameCorrection(game) {
  const row = $("gameCorrect");
  if (!row) return;
  const confirmed = game?.confirmed || null;
  const nearMiss = !confirmed
    ? (game?.candidates || []).find((candidate) => candidate.foreground && candidate.likely && !candidate.isGame) || null
    : null;
  const target = confirmed || nearMiss;
  if (!target || !target.key) {
    row.hidden = true;
    gameCorrectionTarget = null;
    return;
  }
  gameCorrectionTarget = target;
  const name = target.title || target.name;
  $("gameCorrectText").textContent = confirmed
    ? `Treating ${name} as a game.`
    : `${name} looks like it might be a game.`;
  $("gameMarkNot").hidden = !confirmed;
  $("gameMarkIs").hidden = Boolean(confirmed);
  row.hidden = false;
}

async function markGame(verdict) {
  if (!gameCorrectionTarget) return;
  const target = gameCorrectionTarget;
  try {
    setBusy(true);
    await api("/api/games/mark", {
      method: "POST",
      body: JSON.stringify({
        key: target.key,
        path: target.path || null,
        name: target.name || null,
        title: target.title || null,
        verdict
      })
    });
    showToast(`Saved: ${target.title || target.name} is ${verdict === "game" ? "a game" : "not a game"}.`);
    await refresh({ requireFresh: true });
  } catch (error) {
    showToast(error.message || "Could not save that.");
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll("button, select").forEach((control) => {
    if (!control.closest("#supersededOverlay")) control.disabled = value || superseded;
  });
  applyControlAvailability();
}

function hasStoppableActions(status) {
  const traps = status?.v2?.diagnosticTraps || {};
  const recovery = status?.v2?.recovery || {};
  return Boolean(traps.active || recovery.safeRestoreOffered);
}

function restorePreviewActive() {
  return Number(state.restorePreviewUntil || 0) > Date.now();
}

function armRestorePreviewWindow() {
  state.restorePreviewUntil = Date.now() + RESTORE_PREVIEW_WINDOW_MS;
  window.clearTimeout(state.restorePreviewTimer);
  state.restorePreviewTimer = window.setTimeout(() => {
    state.restorePreviewUntil = 0;
    render();
  }, RESTORE_PREVIEW_WINDOW_MS + 250);
}

function clearRestorePreviewWindow() {
  state.restorePreviewUntil = 0;
  window.clearTimeout(state.restorePreviewTimer);
  state.restorePreviewTimer = null;
}

async function previewOrApplyPanicRestore(confirmLabel = "Confirm Restore") {
  if (!restorePreviewActive()) {
    const result = await api("/api/restore/panic", { method: "POST", body: JSON.stringify({ dryRun: true }) });
    armRestorePreviewWindow();
    render();
    return {
      ...result,
      message: `${result.message || "Restore preview ready."} Click ${confirmLabel} within 60 seconds to apply.`
    };
  }
  clearRestorePreviewWindow();
  return api("/api/restore/panic", { method: "POST", body: JSON.stringify({ dryRun: false }) });
}

function applyControlAvailability() {
  if (superseded) return;
  const stop = $("stopActionsButton");
  if (!stop || !state.status) {
    return;
  }
  const restore = $("restoreButton");
  const restoreLabel = $("restoreButtonLabel");
  if (restore && restoreLabel) {
    const armed = restorePreviewActive();
    restoreLabel.textContent = armed ? "Confirm Restore" : "Restore All";
    restore.title = armed
      ? "Apply the restore preview now. The preview expires shortly."
      : "Preview the restore first; click again to apply.";
    restore.setAttribute("aria-label", armed ? "Confirm Restore All" : "Preview Restore All");
  }
  const stoppable = hasStoppableActions(state.status);
  stop.disabled = state.busy || !stoppable;
  stop.setAttribute("aria-disabled", String(!stoppable));
  stop.title = stoppable
    ? "Stop active reversible actions."
    : "No active reversible actions to stop.";

  const relief = state.status?.v2?.relief || {};
  const release = $("releaseRamButton");
  const releaseLabel = $("releaseRamLabel");
  if (release && releaseLabel) {
    const ram = relief.ram || {};
    const label = ram.backoffUntil ? "RAM Backoff" : "Release RAM";
    releaseLabel.textContent = label;
    release.disabled = state.busy || ram.enabled === false;
    release.title = ram.summary || "Conservatively trim idle process working sets. No process is suspended or stopped.";
    release.setAttribute("aria-disabled", String(release.disabled));
  }
  const cpu = $("relieveCpuButton");
  const cpuLabel = $("relieveCpuLabel");
  if (cpu && cpuLabel) {
    const cpuRelief = relief.cpu || {};
    cpuLabel.textContent = cpuRelief.inFlight ? "CPU Relief Running" : "Soft CPU Relief";
    cpu.disabled = state.busy || cpuRelief.enabled === false || Boolean(cpuRelief.inFlight);
    cpu.title = cpuRelief.summary || "Briefly cap processor peak clock, then restore it. No process is suspended or stopped.";
    cpu.setAttribute("aria-disabled", String(cpu.disabled));
  }
  const network = $("networkDiagnoseButton");
  const networkLabel = $("networkDiagnoseLabel");
  if (network && networkLabel) {
    const networkRelief = relief.network || {};
    networkLabel.textContent = networkRelief.backoffUntil ? "Network Backoff" : "Network Diagnose";
    network.disabled = state.busy || networkRelief.enabled === false;
    network.title = networkRelief.summary || "Refresh DNS, reachability, latency, packet-loss, VPN, adapter, and bandwidth-heavy app checks. Observe-only.";
    network.setAttribute("aria-disabled", String(network.disabled));
  }
  const gpu = $("relieveGpuButton");
  const gpuLabel = $("relieveGpuLabel");
  if (gpu && gpuLabel) {
    const gpuRelief = relief.gpu || {};
    gpuLabel.textContent = gpuRelief.holdUntil ? "GPU Relief Active" : gpuRelief.backoffUntil ? "GPU Backoff" : "GPU Relief";
    gpu.disabled = state.busy || gpuRelief.enabled === false;
    gpu.title = gpuRelief.summary || "Request a short in-mode power-band ease for GPU/VRAM pressure. No GPU clocks, fan, driver, firmware, or voltage setting is changed.";
    gpu.setAttribute("aria-disabled", String(gpu.disabled));
  }
}

function pushHistory(key, value) {
  const samples = state.telemetryHistory[key];
  const n = clampNumber(value, null);
  if (!samples || n === null) {
    return;
  }
  samples.push(n);
  while (samples.length > 42) {
    samples.shift();
  }
}

function updateHistory(status) {
  const system = status.telemetry?.system || {};
  const gpu = status.telemetry?.gpu || {};
  pushHistory("cpu", system.cpuLoadPct);
  pushHistory("ram", system.ramUsedPct);
  pushHistory("gpu", gpu.utilizationPct);
  pushHistory("vram", gpu.memoryTotalMB ? (gpu.memoryUsedMB / gpu.memoryTotalMB) * 100 : null);
  pushHistory("power", gpu.powerLimitW ? (gpu.powerDrawW / gpu.powerLimitW) * 100 : null);
}

function sparklineSvg(samples, color) {
  const data = samples.length > 1 ? samples : [0, samples[0] || 0, samples[0] || 0];
  const max = Math.max(1, ...data);
  const min = Math.min(0, ...data);
  const range = Math.max(1, max - min);
  const width = 220;
  const height = 46;
  const points = data.map((value, index) => {
    const x = (index / Math.max(1, data.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 8) - 4;
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const fill = `${line} L${width} ${height} L0 ${height} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="color:${color}"><path class="fill" d="${fill}"></path><path class="line" d="${line}"></path></svg>`;
}

function tempGaugeHtml(tempC, caption = "Temp", opts = {}) {
  const lo = 30;
  const hi = 95;
  const t = Number(tempC);
  const hasReading = tempC !== null && tempC !== undefined && tempC !== "" && Number.isFinite(t);
  if (!hasReading) {
    if (!opts.showMissing) return "";
    const hint = opts.missingHint || `${caption} temperature is unavailable.`;
    const missingValue = opts.missingValue || "n/a";
    const missingTone = opts.missingTone === "warn" ? " temp-gauge--warn" : "";
    return `
      <div class="temp-gauge temp-gauge--na${missingTone}" role="meter" aria-label="${caption} temperature unavailable" title="${escapeHtml(hint)}">
        <span class="temp-gauge-label">${caption}</span>
        <div class="temp-gauge-track"><div class="temp-gauge-fill" style="width:0%"></div></div>
        <span class="temp-gauge-value">${escapeHtml(missingValue)}</span>
      </div>`;
  }
  const pct = Math.max(0, Math.min(100, ((t - lo) / (hi - lo)) * 100));
  const color =
    t >= 88 ? "var(--red)" :
    t >= 82 ? "var(--orange)" :
    t >= 70 ? "var(--amber)" :
    "var(--green)";
  const rounded = Math.floor(t);
  const src = opts.source ? ` (${sensorSourceLabel(opts.source)})` : "";
  return `
      <div class="temp-gauge" role="meter" aria-label="${escapeHtml(caption)} temperature" aria-valuenow="${rounded}" aria-valuemin="${lo}" aria-valuemax="${hi}" title="${escapeHtml(`${caption} temperature: ${rounded}°C${src}`)}">
        <span class="temp-gauge-label">${caption}</span>
        <div class="temp-gauge-track"><div class="temp-gauge-fill" style="width:${pct.toFixed(0)}%;background:${color}"></div></div>
        <span class="temp-gauge-value" style="color:${color}">${rounded}°C</span>
      </div>`;
}

function renderModes() {
  const status = state.status;
  const modes = status?.modes || [];
  const activeMode = status?.state?.modeId || "balanced";
  const selected = state.modeSelectionDirty ? state.selectedModeId : activeMode;
  const root = $("modeButtons");
  const signature = JSON.stringify([modes, activeMode, selected, state.modeSelectionDirty,
    modes.map((mode) => modeConfidenceLabel(mode.id, status))]);
  if (root.dataset.renderSignature === signature) return;
  root.dataset.renderSignature = signature;
  root.innerHTML = "";

  modes.forEach((mode) => {
    const meta = modeMeta[mode.id] || modeMeta.balanced;
    const button = document.createElement("button");
    button.className = "mode-card";
    button.type = "button";
    button.style.setProperty("--mode-color", meta.color);
    button.setAttribute("aria-pressed", String(mode.id === activeMode));
    button.dataset.active = String(mode.id === activeMode);
    button.dataset.pending = String(state.modeSelectionDirty && mode.id === selected && selected !== activeMode);
    button.innerHTML = `
      <span class="mode-icon">${icon(meta.icon)}</span>
      <span>
        <strong>${mode.label}</strong>
        <small>${meta.subtitle}</small>
        <em>${escapeHtml(modeConfidenceLabel(mode.id, status))}</em>
      </span>
    `;
    button.addEventListener("click", () => {
      const currentMode = state.status?.state?.modeId || "balanced";
      state.selectedModeId = mode.id;
      state.modeSelectionDirty = mode.id !== currentMode;
      render();
    });
    root.appendChild(button);
  });
}

function modeConfidenceLabel(modeId, status) {
  const activeMode = status?.state?.modeId || "balanced";
  if (modeId === activeMode) return "Current";
  if (state.modeSelectionDirty && modeId === state.selectedModeId) return "Selected";
  const bandFirst = status?.policy?.bandFirstRecovery || {};
  if (bandFirst.active && bandFirst.targetMode === modeId) return "Waiting for band ceiling";
  const suggested = status?.policy?.suggestedMode;
  if (suggested === modeId) return "Candidate";
  const safetyTarget = status?.policy?.failureRemediation?.safetyTargetMode || status?.v2?.failureRemediation?.safetyTargetMode;
  if (safetyTarget === modeId) return "Safety target";
  if (modeId === "overdrive") return "User-only";
  return "Available";
}

function buildTelemetryCards(status) {
  const system = status.telemetry?.system || {};
  const gpu = status.telemetry?.gpu || {};
  const temps = status.telemetry?.temperatures || {};
  const host = status.telemetry?.host || {};
  const needsElevation = host.elevated === false;
  const elevationHint = "Service is not elevated. Start PC Control Plane with Start PC Control Plane.bat and approve UAC to restore full hardware temperature telemetry.";
  const missingSensorValue = needsElevation ? "elevate" : "n/a";
  const missingSensorTone = needsElevation ? "warn" : "na";
  const cpuTempC = Number.isFinite(system.cpuTempC)
    ? system.cpuTempC
    : Number.isFinite(temps.cpuC)
      ? temps.cpuC
      : Number.isFinite(system.systemTempC)
        ? system.systemTempC
        : Number.isFinite(temps.systemC)
          ? temps.systemC
          : null;
  const cpuTempSource = temps.cpuSource || temps.systemSource || null;
  const cpuTempHint = cpuTempC === null && needsElevation
    ? elevationHint
    : temps.note || "CPU temperature needs the service running elevated or a sensor agent (e.g. LibreHardwareMonitor).";
  const memoryTempC = Number.isFinite(system.memoryTempC)
    ? system.memoryTempC
    : Number.isFinite(temps.memoryC)
      ? temps.memoryC
      : null;
  const memoryTempSource = temps.memorySource || null;
  const memoryTempHint = memoryTempC === null && needsElevation
    ? elevationHint
    : temps.memoryName
    ? `Memory temperature source: ${temps.memoryName}.`
    : "Physical RAM temperature needs memory modules with thermal sensors exposed by LibreHardwareMonitor.";
  const gpuMemoryTempC = Number.isFinite(temps.gpuMemoryC) ? temps.gpuMemoryC : null;
  const vramGaugeTempC = gpuMemoryTempC ?? (gpu ? gpu.temperatureC : null);
  const power = status.telemetry?.power || {};
  const activePower = extractPowerName(power.activeLine);
  const vramPct = gpu?.memoryTotalMB ? (gpu.memoryUsedMB / gpu.memoryTotalMB) * 100 : null;
  const powerSystem = status.policy?.powerSystem || {};
  const powerContext = powerSystem.foregroundContention
    ? "Foreground Contention"
    : powerSystem.backgroundCpuContention
      ? "Background Contention"
      : powerSystem.cpuUnderfed
        ? "GPU CPU-Fed"
        : powerSystem.gpuPowerLimited
          ? "GPU Power-Limited"
          : powerSystem.gpuThermalLimited
            ? "GPU Thermal-Limited"
            : null;

  return [
    {
      key: "cpu",
      label: "CPU",
      color: "#6da5ff",
      value: percent(system.cpuLoadPct),
      sub: "Load",
      tempC: cpuTempC,
      tempLabel: "CPU",
      tempVital: true,
      tempSource: cpuTempSource,
      tempHint: cpuTempHint,
      tempMissingValue: missingSensorValue,
      tempMissingTone: missingSensorTone,
      detailValue: fmt(system.logicalProcessors, " LP"),
      detailLabel: "Logical Processors",
      secondValue: fmt(system.uptimeHours, " h"),
      secondLabel: "Uptime"
    },
    {
      key: "ram",
      label: "RAM",
      color: "#59d34f",
      value: percent(system.ramUsedPct),
      sub: `${fmt(system.ramFreeGB, " GB")} free / ${fmt(system.ramTotalGB, " GB")}`,
      tempC: memoryTempC,
      tempLabel: "Memory",
      tempVital: true,
      tempSource: memoryTempSource,
      tempHint: memoryTempHint,
      tempMissingValue: missingSensorValue,
      tempMissingTone: missingSensorTone,
      detailValue: fmt(system.ramUsedPct, "%"),
      detailLabel: "Commit Used",
      secondValue: fmt(system.ramFreeGB, " GB"),
      secondLabel: "Free"
    },
    {
      key: "gpu",
      label: "GPU",
      color: "#ff7a31",
      value: gpu ? percent(gpu.utilizationPct) : "--",
      sub: "3D Load",
      tempC: gpu ? gpu.temperatureC : null,
      tempLabel: "GPU",
      tempVital: true,
      tempSource: temps.gpuSource || "nvidia-smi",
      detailValue: gpu ? fmt(gpu.temperatureC, " C") : "--",
      detailLabel: "Temperature",
      secondValue: gpu ? fmt(gpu.graphicsClockMHz, " MHz") : "--",
      secondLabel: "Core Clock"
    },
    {
      key: "vram",
      label: "VRAM",
      color: "#c05ccf",
      value: vramPct === null ? "--" : percent(vramPct),
      sub: gpu ? `${Math.floor(gpu.memoryUsedMB || 0)} / ${Math.floor(gpu.memoryTotalMB || 0)} MB` : "Unavailable",
      tempC: vramGaugeTempC,
      tempLabel: gpuMemoryTempC === null ? "GPU" : "VRAM",
      tempVital: true,
      tempSource: gpuMemoryTempC === null ? (temps.gpuSource || "nvidia-smi") : (temps.gpuMemorySource || "LibreHardwareMonitorLib"),
      detailValue: gpu ? fmt(gpu.memoryClockMHz, " MHz") : "--",
      detailLabel: "Memory Clock",
      secondValue: gpu ? fmt(gpu.powerDrawW, " W") : "--",
      secondLabel: "Power Draw"
    },
    {
      key: "power",
      label: "Power",
      color: "#f2bf24",
      value: powerShort(activePower),
      sub: powerContext ? `Actual Plan / ${powerContext}` : "Actual Plan",
      actualPlan: activePower,
      detailValue: processorBoostLabel(power.processorBoost),
      detailLabel: "CPU Boost",
      secondValue: power.usbSelectiveSuspend?.acLabel || "--",
      secondLabel: "USB Suspend"
    },
    {
      key: "storage",
      label: "Storage",
      color: "#4dd6d1",
      value: Number.isFinite(temps.storageC) ? `${Math.floor(temps.storageC)}°C` : "--",
      sub: "Hottest Drive",
      tempC: Number.isFinite(temps.storageC) ? temps.storageC : null,
      tempLabel: "Drive",
      tempVital: true,
      tempSource: temps.storageSource || "SMART",
      tempHint: Number.isFinite(temps.storageC)
        ? "Storage drive temperature is read through SMART."
        : needsElevation
          ? elevationHint
          : "Storage drive temperature needs the service running elevated (read via SMART).",
      tempMissingValue: missingSensorValue,
      tempMissingTone: missingSensorTone,
      detailValue: Array.isArray(temps.drives) && temps.drives.length ? String(temps.drives.length) : "--",
      detailLabel: "Drives",
      secondValue: temps.storageName ? "SMART" : "--",
      secondLabel: temps.storageName ? "Source" : "—"
    }
  ];
}

function fanTelemetryItems(fans = {}) {
  const rpmRows = Array.isArray(fans.rpm) ? fans.rpm : [];
  const controlRows = Array.isArray(fans.controls) ? fans.controls : [];
  const maxRpmValue = Number(fans.maxRpm);
  const rowMax = rpmRows.reduce((max, row) => {
    const rpm = Number(row?.rpm);
    return Number.isFinite(rpm) ? Math.max(max, rpm) : max;
  }, Number.isFinite(maxRpmValue) ? maxRpmValue : 0);
  const rpmReference = Math.max(2400, Math.ceil(rowMax / 500) * 500 || 2400);
  const rpmItems = rpmRows.map((row, index) => {
    const rpm = Number(row?.rpm);
    const safeRpm = Number.isFinite(rpm) ? Math.max(0, rpm) : 0;
    if (safeRpm <= 0) return null;
    return {
      key: `rpm-${row?.identifier || row?.name || index}`,
      kind: "speed",
      label: row?.name || row?.hardware || `Fan ${index + 1}`,
      value: `${Math.floor(safeRpm)} RPM`,
      meta: fanHardwareLabel(row?.hardware || row?.source || fans.source),
      pct: Math.max(2, Math.min(100, (safeRpm / rpmReference) * 100)),
      tone: safeRpm >= 3000 ? "high" : safeRpm >= 1800 ? "medium" : "normal"
    };
  }).filter(Boolean);
  const controlItems = controlRows.map((row, index) => {
    const pct = Number(row?.pct);
    const safePct = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    if (safePct <= 0.5) return null;
    return {
      key: `pwm-${row?.identifier || row?.name || index}`,
      kind: "intensity",
      label: `${row?.name || row?.hardware || `Fan ${index + 1}`} intensity`,
      value: `${Math.floor(safePct)}%`,
      meta: fanHardwareLabel(row?.hardware || row?.source || fans.source),
      pct: Math.max(2, safePct),
      tone: safePct >= 80 ? "high" : safePct >= 45 ? "medium" : "normal"
    };
  }).filter(Boolean);
  return [...rpmItems, ...controlItems];
}

function fanDialPoint(angleDeg, radius = 51, cx = 70, cy = 70) {
  const angleRad = (angleDeg - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad)
  };
}

function fanDialArc(startAngle, endAngle, color) {
  const start = fanDialPoint(startAngle);
  const end = fanDialPoint(endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `<path class="fan-dial-segment" d="M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A 51 51 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}" stroke="${color}" />`;
}

function fanDialSegments() {
  const colors = [
    "#ef3f55", "#ef3f55", "#f05b4f", "#f47645",
    "#fb9340", "#ffa642", "#ffba45", "#ffc947",
    "#ffd84c", "#e9d94c", "#cfd653", "#9ed45f",
    "#70cc6f", "#4cc67a", "#34ba79", "#2baa70"
  ];
  const start = -115;
  const sweep = 230;
  const step = sweep / colors.length;
  return colors.map((color, index) => {
    const a = start + index * step + 1.3;
    const b = start + (index + 1) * step - 1.3;
    return fanDialArc(a, b, color);
  }).join("");
}

function fanGaugeHtml(item) {
  const pct = Math.max(0, Math.min(100, Number(item.pct) || 0));
  const needleAngle = -115 + (pct / 100) * 230;
  return `
    <article class="fan-gauge-card fan-gauge-card--${escapeHtml(item.tone || "normal")}" title="${escapeHtml(`${item.label}: ${item.value} (${item.meta})`)}">
      <svg class="fan-dial" viewBox="0 0 140 140" role="img" aria-label="${escapeHtml(`${item.label}: ${item.value}`)}">
        <circle class="fan-dial-shadow" cx="70" cy="70" r="62"></circle>
        <circle class="fan-dial-face" cx="70" cy="70" r="55"></circle>
        <g class="fan-dial-scale">${fanDialSegments()}</g>
        <text class="fan-dial-tick fan-dial-tick--low" x="34" y="88">0</text>
        <text class="fan-dial-tick fan-dial-tick--mid" x="68" y="48">50</text>
        <text class="fan-dial-tick fan-dial-tick--high" x="101" y="88">100</text>
        <line class="fan-dial-needle" x1="70" y1="73" x2="70" y2="32" transform="rotate(${needleAngle.toFixed(1)} 70 70)"></line>
        <circle class="fan-dial-hub" cx="70" cy="70" r="4"></circle>
        <text class="fan-dial-value" x="70" y="108">${escapeHtml(item.value)}</text>
      </svg>
      <div class="fan-dial-caption">
        <strong>${escapeHtml(item.label)}</strong>
        <small>${escapeHtml(item.meta)}</small>
      </div>
    </article>
  `;
}

function renderFanTelemetryRow(status) {
  const fans = status.telemetry?.fans || {};
  const items = fanTelemetryItems(fans);
  const fanCount = items.filter((item) => item.kind === "speed").length;
  const controlCount = items.filter((item) => item.kind === "intensity").length;
  const summary = items.length
    ? `${fanCount} speed sensor${fanCount === 1 ? "" : "s"} / ${controlCount} intensity reading${controlCount === 1 ? "" : "s"}`
    : "No active fan speed or intensity readings";
  const detail = items.length
    ? "Read-only fan data from hardware sensors."
    : (fans.note || "Zero fan readings are hidden; active fan data appears here when reported by hardware sensors.");
  return `
    <div class="fan-row-header">
      <div>
        <h3>Fans</h3>
        <span>${escapeHtml(summary)}</span>
      </div>
      <small>${escapeHtml(detail)}</small>
    </div>
    <div class="fan-gauge-grid${items.length ? "" : " empty"}">
      ${items.length
        ? items.map(fanGaugeHtml).join("")
        : `<div class="fan-empty-state">${escapeHtml(detail)} The thermal hierarchy still uses CPU, GPU, VRAM, and storage temperatures for safety.</div>`}
    </div>
  `;
}

function renderHardwareProfileRow(status) {
  const profile = status?.hardwareProfile || status?.v2?.hardwareProfile;
  if (!profile) {
    return `<div class="hardware-profile-empty">Current hardware profile is unavailable.</div>`;
  }
  const expected = profile.expected || {};
  const cpu = expected.cpu || {};
  const memory = expected.memory || {};
  const gpu = expected.gpu || {};
  const psu = expected.psu || {};
  const firmware = expected.firmware || {};
  const drift = profile.status === "drift-detected";
  const badge = drift ? "Drift detected" : "Verified current";
  const specs = [
    ["CPU", cpu.model || "Unknown", `${cpu.cores || "--"} cores / ${cpu.threads || "--"} threads · ${cpu.tjMaxC || "--"} °C ceiling`],
    ["Memory", `${memory.totalGB || "--"} GB ${memory.type || ""}`.trim(), `${memory.layout || "Layout unavailable"} · ${memory.operatingSpeedMTs || "--"} MT/s`],
    ["Graphics", gpu.model || "Unknown", `${gpu.memoryGB || "--"} GB · Resizable BAR ${firmware.resizableBar?.status || "unknown"}`],
    ["Power", `${psu.vendor || ""} ${psu.model || ""}`.trim() || "Unknown", `${psu.capacityW || "--"} W · owner-confirmed`],
    ["Firmware", `SVM ${firmware.svm?.status || "unknown"}`, `BIOS ${expected.motherboard?.biosVersion || "--"} · ${expected.motherboard?.model || "board unavailable"}`]
  ];
  return `
    <div class="hardware-profile-head">
      <div>
        <h3>Current PC Profile</h3>
        <span>${escapeHtml(profile.summary || "Read-only installed-hardware profile")}</span>
      </div>
      <strong class="hardware-profile-badge ${drift ? "drift" : "verified"}">${escapeHtml(badge)}</strong>
    </div>
    <div class="hardware-profile-grid">
      ${specs.map(([label, value, detail]) => `
        <article class="hardware-profile-item">
          <small>${escapeHtml(label)}</small>
          <strong>${escapeHtml(value)}</strong>
          <span>${escapeHtml(detail)}</span>
        </article>
      `).join("")}
    </div>
  `;
}

const POWER_TIER_SHORT = ["01 Saver", "02 Endurance", "03 Balanced", "04 High", "05 Ultra"];

function powerLadderStatusWord({ aligned, guard = "", bandFirstActive = false } = {}) {
  const text = String(guard || "").toLowerCase();
  if (!aligned) return "Converging";
  if (bandFirstActive) return "Adjusting";
  if (/thermal|cool|warm|hot|critical/.test(text)) return "Cooling";
  if (/guard|hold|cap|strain|crash|safety/.test(text)) return "Guarded";
  return "Stable";
}

function renderPowerLadder(adaptive = {}, bandFirst = {}, actualPlanName = null) {
  const targetTier = Number.isFinite(Number(adaptive?.tier)) ? Number(adaptive.tier) : null;
  const actualTier = powerTierFromPlanName(actualPlanName);
  const visibleTier = actualTier ?? targetTier;
  if (visibleTier === null) return "";
  const floor = Number.isFinite(Number(adaptive?.floor)) ? Number(adaptive.floor) : 0;
  const ceiling = Number.isFinite(Number(adaptive?.ceiling)) ? Number(adaptive.ceiling) : 4;
  const guard = adaptive?.guard ? String(adaptive.guard) : "";
  const bandFirstActive = Boolean(bandFirst?.active) || /band-first/i.test(guard);
  const actualLabel = actualTier !== null ? POWER_TIER_SHORT[actualTier] : powerShort(actualPlanName) || "Unknown";
  const targetLabel = targetTier !== null ? POWER_TIER_SHORT[targetTier] : "No target";
  const aligned = actualTier !== null && targetTier !== null && actualTier === targetTier;
  let rungs = "";
  for (let t = 0; t <= 4; t += 1) {
    const inBand = t >= floor && t <= ceiling;
    const isActual = actualTier === t;
    const isTarget = targetTier === t;
    const active = isActual || (actualTier === null && isTarget);
    const cls = `pl-rung${inBand ? " in-band" : ""}${active ? " active" : ""}${isActual ? " actual" : ""}${isTarget ? " target" : ""}`;
    const titleParts = [
      POWER_TIER_SHORT[t] || t + 1,
      isActual ? "actual Windows plan" : null,
      isTarget ? "adaptive target" : null,
      inBand ? "inside mode band" : "outside mode band"
    ].filter(Boolean);
    rungs += `<span class="${cls}" title="${escapeHtml(titleParts.join(" · "))}">${t + 1}</span>`;
  }
  const note = actualTier !== null && targetTier !== null && actualTier !== targetTier
    ? `Converging: Windows is on ${actualLabel}; target is ${targetLabel}. ${guard || adaptive?.reason || "Self-heal is aligning the plan."}`
    : bandFirstActive
    ? "Band-first: moving the level inside the mode before any switch."
    : guard
      ? guard.charAt(0).toUpperCase() + guard.slice(1)
      : "Floating inside the mode band.";
  const statusWord = powerLadderStatusWord({ aligned, guard, bandFirstActive });
  return `
    <div class="power-ladder" title="Actual ${escapeHtml(actualLabel)} · target ${escapeHtml(targetLabel)} · mode band ${floor + 1}-${ceiling + 1}">
      <div class="pl-track">${rungs}</div>
      <div class="pl-caption">
        <strong>Actual ${escapeHtml(actualLabel)}</strong>
        <span>${aligned ? "target aligned" : `target ${escapeHtml(targetLabel)}`} · band ${floor + 1}-${ceiling + 1}${bandFirstActive ? " · band-first" : ""}</span>
      </div>
      <div class="pl-reason" title="${escapeHtml(note)}" aria-label="${escapeHtml(note)}">${escapeHtml(statusWord)}</div>
    </div>
  `;
}

function autonomyTone(stateName) {
  if (["blocked", "fail", "critical"].includes(stateName)) return "blocked";
  if (["active", "executing", "ready"].includes(stateName)) return "active";
  if (["learning", "verifying", "pending"].includes(stateName)) return "learning";
  return "idle";
}

function autonomyStatusLabel(value) {
  return String(value || "idle").replace(/-/g, " ");
}

function autonomyLine(label, value, detail = null, tone = "idle") {
  return `
    <div class="autonomy-line ${autonomyTone(tone)}">
      <span class="autonomy-line-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "--")}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </div>
  `;
}

function renderAutonomyLoop(status) {
  const readiness = status.v2?.readiness || {};
  const observer = status.observer || {};
  const remediation = status.policy?.failureRemediation || status.v2?.failureRemediation || {};
  const prevention = status.policy?.failurePrevention || status.v2?.failurePrevention || {};
  const ledger = status.v2?.mlDecisionLedger || status.v2?.mlGovernor?.decisionLedger || {};
  const learnerActive = status.v2?.learningInfluence?.enabled !== false && status.settings?.learningInfluence !== false;
  const stages = [
    {
      label: "Detect",
      state: observer.running && readiness.state !== "blocked" ? "active" : "blocked",
      detail: observer.running ? readiness.summary || "watching telemetry" : "observer offline"
    },
    {
      label: "Remediate",
      state: remediation.liveCount > 0 ? "active" : remediation.active ? "learning" : "idle",
      detail: remediation.summary || `${remediation.activeCount || 0} routed`
    },
    {
      label: "Verify",
      state: ledger.pendingCount > 0 ? "verifying" : ledger.verifiedCount > 0 ? "active" : "idle",
      detail: ledger.pendingCount > 0 ? `${ledger.pendingCount} pending` : `${ledger.verifiedCount || 0} verified`
    },
    {
      label: "Learn",
      state: learnerActive ? "learning" : "blocked",
      detail: learnerActive ? `${ledger.successPct ?? "--"}% recent stability` : "learner disabled"
    },
    {
      label: "Prevent",
      state: (prevention.preventions || []).length || (ledger.preventionCandidates || []).length ? "active" : "idle",
      detail: `${(prevention.preventions || []).length + (ledger.preventionCandidates || []).length} prevention cue(s)`
    }
  ];
  return stages.map((stage, index) => `
    <div class="loop-stage ${autonomyTone(stage.state)}">
      <span class="loop-index">${index + 1}</span>
      <strong>${stage.label}</strong>
      <small>${escapeHtml(stage.detail)}</small>
    </div>
  `).join("");
}

function renderMlLearnerPanel(status) {
  const governor = status.v2?.mlGovernor || {};
  const optimizer = status.v2?.mlOptimizer || {};
  const executor = status.v2?.mlExecutor || {};
  const gate = status.v2?.mlExecutionGate || {};
  const ledger = status.v2?.mlDecisionLedger || governor.decisionLedger || {};
  const selected = executor.executeSelected
    ? { label: executor.actionId, reason: executor.reason }
    : optimizer.selectedExperiment || governor.selected || {};
  const lastVerified = ledger.lastVerified || {};
  return [
    autonomyLine("Autonomy level", `Level ${optimizer.level || governor.level || executor.level || "--"}`, optimizer.ideology || governor.status || "deterministic shield active", "active"),
    autonomyLine("Optimizer", autonomyStatusLabel(optimizer.status || executor.status || "monitoring"), `${optimizer.coverage?.hypothesisCount || 0} hypotheses / ${optimizer.coverage?.executableCount || 0} executable`, optimizer.status === "prevention-hold" ? "learning" : "active"),
    autonomyLine("Current safe action", selected.label || selected.actionId || selected.id || "Keep monitoring", selected.reason || executor.evidence || gate.evidence?.reason || "No mutation required", executor.executeSelected ? "active" : "idle"),
    autonomyLine("Execution gate", gate.status || executor.status || "waiting", gate.eligible || executor.eligible ? "Existing handler eligible" : (gate.blockedBy || []).slice(0, 1).join(" | ") || "Collecting verified evidence", gate.eligible || executor.eligible ? "active" : "learning"),
    autonomyLine("Last verified result", lastVerified.outcome || "pending", lastVerified.reason || ledger.summary || "Waiting for verification window", lastVerified.helped === false ? "blocked" : "learning")
  ].join("");
}

function bandStepLabel(adaptive = {}) {
  const tier = Number(adaptive.tier);
  const floor = Number(adaptive.floor);
  const ceiling = Number(adaptive.ceiling);
  if (![tier, floor, ceiling].every(Number.isFinite)) {
    return "Waiting for tier data";
  }
  if (tier > floor && /warm|hot|cool|guard|hold below/i.test(String(adaptive.guard || adaptive.reason || ""))) {
    return `Can ease down to level ${tier}`;
  }
  if (tier < ceiling) {
    return `Can climb to level ${tier + 2}`;
  }
  return "Band ceiling reached";
}

function renderPowerBandPanel(status) {
  const adaptive = status.v2?.adaptivePower || {};
  const mode = status.policy?.mode || {};
  const bandFirst = status.policy?.bandFirstRecovery || {};
  const ladder = renderPowerLadder(adaptive, bandFirst);
  return `
    <div class="autonomy-power" style="--metric-color: var(--amber)">
      ${ladder || "<span class=\"muted-label\">Power band pending.</span>"}
      ${autonomyLine("Mode band", `${mode.label || adaptive.modeId || "--"} / ${Number.isFinite(Number(adaptive.floor)) ? Number(adaptive.floor) + 1 : "-"}-${Number.isFinite(Number(adaptive.ceiling)) ? Number(adaptive.ceiling) + 1 : "-"}`, adaptive.plan || "No active plan", "active")}
      ${autonomyLine("Next in-band step", bandStepLabel(adaptive), adaptive.guard || adaptive.reason || "Band-first governor active", bandFirst.active ? "learning" : "idle")}
    </div>
  `;
}

function sensorChip(label, value, state = "info", detail = "") {
  const tone = state === "ok" ? "active" : state === "warn" ? "learning" : state === "fail" ? "blocked" : "idle";
  return `
    <div class="sensor-chip ${tone}" title="${escapeHtml(detail || label)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "--")}</strong>
    </div>
  `;
}

function renderSensorReadinessPanel(status) {
  const telemetry = status.telemetry || {};
  const temps = telemetry.temperatures || {};
  const readiness = status.v2?.readiness?.items || [];
  const byKey = new Map(readiness.map((item) => [item.key, item]));
  const cpu = byKey.get("cpuTemperature");
  const ram = byKey.get("memoryTemperature");
  const storage = byKey.get("storageTelemetry");
  const gpu = byKey.get("gpuTelemetry");
  const fans = byKey.get("fanTelemetry");
  const frames = byKey.get("frameTooling");
  const elevation = telemetry.host?.elevated
    ? { state: "ok", summary: "Elevated", detail: "Full privileged sensor capture available." }
    : { state: "warn", summary: "Not elevated", detail: "CPU/RAM/storage sensors need the elevated launcher." };
  return [
    sensorChip("CPU", cpu?.summary || "n/a", cpu?.state || "info", cpu?.detail),
    sensorChip("RAM", ram?.summary || "n/a", ram?.state || "info", ram?.detail),
    sensorChip("GPU", gpu?.summary || (Number.isFinite(temps.gpuC) ? `${Math.floor(temps.gpuC)} C` : "n/a"), gpu?.state || "info", gpu?.detail),
    sensorChip("VRAM", Number.isFinite(temps.gpuMemoryC) ? `${Math.floor(temps.gpuMemoryC)} C` : "n/a", Number.isFinite(temps.gpuMemoryC) ? "ok" : "info", temps.gpuMemorySource || "VRAM sensor"),
    sensorChip("Storage", storage?.summary || "n/a", storage?.state || "info", storage?.detail),
    sensorChip("Fans", fans?.summary || "Not exposed", fans?.state || "info", fans?.detail),
    sensorChip("Frames", frames?.summary || "Proxy only", frames?.state || "info", frames?.detail),
    sensorChip("Elevation", elevation.summary, elevation.state, elevation.detail)
  ].join("");
}

function renderReliefReadinessPanel(status) {
  const relief = status.v2?.relief || {};
  const ram = relief.ram || {};
  const cpu = relief.cpu || {};
  const network = relief.network || {};
  const gpu = relief.gpu || {};
  return [
    autonomyLine("RAM relief", ram.autonomousAllowed ? "Ready" : autonomyStatusLabel(ram.state || "watching"), `Pressure ${Math.floor(Number(ram.pressurePct || 0))}% / threshold ${ram.thresholdPct || 90}%`, ram.autonomousAllowed ? "active" : ram.backoffUntil ? "blocked" : "idle"),
    autonomyLine("CPU relief", cpu.autonomousAllowed ? "Ready" : autonomyStatusLabel(cpu.state || "gated"), `Streak ${cpu.pressureStreak || 0}/${cpu.sustainedSamples || 3} / thermal ${cpu.thermalSeverity || "unknown"}`, cpu.autonomousAllowed || cpu.inFlight ? "active" : cpu.backoffUntil ? "blocked" : "idle"),
    autonomyLine("Network diagnosis", network.autonomousAllowed ? "Ready" : autonomyStatusLabel(network.state || "watching"), `Network ${network.networkState || "unknown"} / pressure ${Math.floor(Number(network.pressurePct || 0))}`, network.autonomousAllowed ? "active" : network.backoffUntil ? "blocked" : "idle"),
    autonomyLine("GPU relief", gpu.holdUntil ? "Active" : gpu.autonomousAllowed ? "Ready" : autonomyStatusLabel(gpu.state || "watching"), `Pressure ${Math.floor(Number(gpu.pressurePct || 0))} / threshold ${gpu.thresholdPct || 80}`, gpu.holdUntil || gpu.autonomousAllowed ? "active" : gpu.backoffUntil ? "blocked" : "idle"),
    autonomyLine("Last effectiveness", relief.learningInfluence === false ? "advisory only" : "learner active", `RAM ${ram.latestSample?.effective === true ? "helped" : ram.latestSample ? "did not help" : "no sample"} / CPU ${cpu.latestSample?.effective === true ? "helped" : cpu.latestSample ? "did not help" : "no sample"} / Network ${network.latestSample?.effective === true ? "useful" : network.latestSample ? "no new signal" : "no sample"} / GPU ${gpu.latestSample?.effective === true ? "helped" : gpu.latestSample ? "did not help" : "no sample"}`, "learning")
  ].join("");
}

function recentAutonomousEntries(status) {
  const actions = [
    "ml.execute",
    "observer.band-first",
    "observer.auto-apply",
    "observer.mode-stability-hold",
    "cpu.relief",
    "gpu.relief",
    "network.diagnose",
    "memory.release",
    "failure.remediation",
    "failure.proactive-prevention",
    "failure.prevention",
    "selfheal.power-plan"
  ];
  return (status.audit || [])
    .filter((entry) => actions.some((action) => String(entry.action || "").includes(action)))
    .slice(0, 5);
}

function renderActionTimelinePanel(status) {
  const entries = recentAutonomousEntries(status);
  if (!entries.length) {
    return '<div class="timeline-row idle"><span></span><strong>No autonomous action yet</strong><small>Routine monitoring is still active.</small></div>';
  }
  return entries.map((entry) => `
    <div class="timeline-row ${entry.level === "warn" ? "learning" : "active"}">
      <span></span>
      <strong>${escapeHtml(auditTitle(entry))}</strong>
      <small>${escapeHtml(auditMessage(entry))}</small>
    </div>
  `).join("");
}

function failureLayerGroups(status) {
  const watch = status.policy?.failureWatchlist || {};
  const remediation = status.policy?.failureRemediation || status.v2?.failureRemediation || {};
  const prevention = status.policy?.failurePrevention || status.v2?.failurePrevention || {};
  const readinessWarnings = (status.v2?.readiness?.items || []).filter((item) => ["warn", "fail"].includes(item.state));
  const live = (watch.active || []).filter((profile) => profile.recent || profile.severity === "critical" || profile.autoDownshift);
  const known = (watch.active || []).filter((profile) => !live.includes(profile));
  const prevented = [
    ...(prevention.preventions || []),
    ...((status.v2?.mlDecisionLedger?.preventionCandidates || []).map((item) => ({ label: item.label, reason: item.reason })))
  ];
  const needsDecision = [
    ...(remediation.unhandled || []),
    ...readinessWarnings.map((item) => ({ label: item.label, reason: item.summary }))
  ];
  return [
    { title: "Live risks", count: live.length, tone: live.length ? "blocked" : "active", detail: live[0]?.label || "No live danger signals." },
    { title: "Known recurring", count: known.length, tone: known.length ? "learning" : "idle", detail: known[0]?.label || `${watch.monitored || 0} signatures guarded.` },
    { title: "Prevented recently", count: prevented.length, tone: prevented.length ? "active" : "idle", detail: prevented[0]?.reason || "No recurrence prevention currently needed." },
    { title: "Needs user decision", count: needsDecision.length, tone: needsDecision.length ? "learning" : "active", detail: needsDecision[0]?.label ? `${needsDecision[0].label}: ${needsDecision[0].reason || ""}` : "No decision required." }
  ];
}

function renderFailureGroupRows(status, compact = false) {
  return failureLayerGroups(status).map((group) => `
    <div class="failure-layer-row ${group.tone}">
      <span class="failure-layer-count">${group.count}</span>
      <span>
        <strong>${escapeHtml(group.title)}</strong>
        <small>${escapeHtml(group.detail)}</small>
      </span>
      ${compact ? "" : `<em>${escapeHtml(autonomyStatusLabel(group.tone))}</em>`}
    </div>
  `).join("");
}

function renderFailureGroupsPanel(status) {
  $("failureGroupsPanel").innerHTML = renderFailureGroupRows(status);
}

function renderAutonomyCockpit() {
  const status = state.status;
  $("autonomySummary").textContent = `${failureRemediationPolicyLine(status)} / ${failurePreventionPolicyLine(status)}`;
  $("autonomyLoop").innerHTML = renderAutonomyLoop(status);
  $("mlLearnerPanel").innerHTML = renderMlLearnerPanel(status);
  $("powerBandPanel").innerHTML = renderPowerBandPanel(status);
  $("sensorReadinessPanel").innerHTML = renderSensorReadinessPanel(status);
  $("reliefReadinessPanel").innerHTML = renderReliefReadinessPanel(status);
  $("actionTimelinePanel").innerHTML = renderActionTimelinePanel(status);
  renderFailureGroupsPanel(status);
  applyViewMode();
}

function systemMapLayerTitle(key) {
  const titles = {
    L0_entry_config: "Entry",
    L1_telemetry_capture: "Telemetry",
    L2_classification_policy: "Policy",
    L3_power_resolution: "Power",
    L4_learning_efficacy: "Learning",
    L5_autonomy_ml: "Autonomy",
    L6_persistence_audit_sessions: "Audit",
    L7_orchestrator: "Orchestrator",
    L8_frontend: "Interface"
  };
  return titles[key] || String(key || "Layer").replace(/^L\d+_/, "").replace(/_/g, " ");
}

function systemMapBandLabel(band) {
  if (!band || !Number.isFinite(Number(band.floor)) || !Number.isFinite(Number(band.ceiling))) {
    return "Waiting";
  }
  return `${Number(band.floor) + 1}-${Number(band.ceiling) + 1}`;
}

function systemMapRow(label, value, detail = "") {
  return `
    <div class="system-map-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "--")}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </div>
  `;
}

function renderSystemMapContent(architecture) {
  const runtime = architecture?.runtime || state.status?.v2?.architecture || {};
  const registry = runtime.registry || architecture?.registry || {};
  const activeSignals = runtime.activeSignals || [];
  const currentMode = runtime.currentMode || {};
  const adaptive = runtime.adaptivePower || {};
  const autonomy = runtime.autonomy || {};
  const layers = architecture?.layers || {};
  const loop = runtime.controlLoop || ["Detect", "Remediate", "Verify", "Learn", "Prevent"];
  const layerCards = Object.entries(layers).map(([key, modules]) => `
    <div class="system-layer-card">
      <strong>${escapeHtml(systemMapLayerTitle(key))}</strong>
      <small>${Array.isArray(modules) ? modules.length : 0} module${Array.isArray(modules) && modules.length === 1 ? "" : "s"}</small>
      <span>${registry.ok === false ? "Check" : "Ready"}</span>
    </div>
  `).join("");
  const signalRows = activeSignals.length
    ? activeSignals.map((item) => systemMapRow(item.label, "Active", item.detail)).join("")
    : systemMapRow("Current signals", "Watching", "No high-priority override is active.");
  return `
    <div class="system-map-section system-map-loop">
      <h3>Control Loop</h3>
      <div class="system-loop-steps">
        ${loop.map((stage, index) => `
          <span><b>${index + 1}</b>${escapeHtml(stage)}</span>
        `).join("")}
      </div>
    </div>
    <div class="system-map-grid">
      <article class="system-map-section">
        <h3>Active Priorities</h3>
        ${signalRows}
      </article>
      <article class="system-map-section">
        <h3>Power Path</h3>
        ${systemMapRow("Mode", currentMode.label || currentMode.id, `Band ${systemMapBandLabel(currentMode.band)}`)}
        ${systemMapRow("Target", adaptive.plan || "Waiting", adaptive.guard || adaptive.reason || "Band-first power resolver")}
        ${systemMapRow("Tier", Number.isFinite(Number(adaptive.tier)) ? `Level ${Number(adaptive.tier) + 1}` : "--", `Allowed ${systemMapBandLabel({ floor: adaptive.floor, ceiling: adaptive.ceiling })}`)}
      </article>
      <article class="system-map-section">
        <h3>Autonomy</h3>
        ${systemMapRow("Level", autonomy.level ? `Level ${autonomy.level}` : "Waiting", autonomy.status || "Monitoring")}
        ${systemMapRow("Gate", autonomy.eligible ? "Eligible" : "Watching", autonomy.gateStatus || "Existing safety handlers remain in charge")}
        ${systemMapRow("Registry", registry.ok === false ? "Check" : "Aligned", registry.summary || "Read-only architecture map")}
      </article>
    </div>
    <div class="system-map-section">
      <h3>Layer Health</h3>
      <div class="system-layer-grid">
        ${layerCards || '<div class="system-map-loading">Layer map unavailable.</div>'}
      </div>
    </div>
  `;
}

async function openSystemMap() {
  const overlay = $("systemMapOverlay");
  const content = $("systemMapContent");
  if (!overlay || !content) return;
  overlay.hidden = false;
  content.innerHTML = '<div class="system-map-loading">Loading system map...</div>';
  try {
    const architecture = await api("/api/architecture?fresh=1");
    state.architecture = architecture;
    content.innerHTML = renderSystemMapContent(architecture);
  } catch (error) {
    content.innerHTML = `
      <div class="system-map-error">
        <strong>System map unavailable</strong>
        <small>${escapeHtml(error.message || "The architecture endpoint did not respond.")}</small>
      </div>
    `;
  }
}

function closeSystemMap() {
  const overlay = $("systemMapOverlay");
  if (overlay) {
    overlay.hidden = true;
  }
}

function applyViewMode() {
  const mode = state.viewMode === "summary" ? "summary" : "cockpit";
  document.body.dataset.viewMode = mode;
  document.querySelectorAll("[data-view-mode]").forEach((button) => {
    const active = button.dataset.viewMode === mode;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("active", active);
  });
}

function renderTelemetry(status = null) {
  const sourceStatus = status || visualStatusFromTelemetry(state.visualTelemetry) || state.status;
  const cards = buildTelemetryCards(sourceStatus);
  const root = $("telemetryGrid");
  const hardwareRow = $("hardwareProfileRow");
  const fanRow = $("fanTelemetryRow");
  const existing = new Map(Array.from(root.children, (node) => [node.dataset.metric, node]));
  cards.forEach((card) => {
    const el = existing.get(card.key) || document.createElement("article");
    existing.delete(card.key);
    el.dataset.metric = card.key;
    el.className = "telemetry-card";
    el.style.setProperty("--metric-color", card.color);
    const ladder = card.key === "power"
      ? renderPowerLadder(sourceStatus?.v2?.adaptivePower, sourceStatus?.policy?.bandFirstRecovery, card.actualPlan)
      : "";
    const bottom = ladder || `<div class="sparkline">${sparklineSvg(state.telemetryHistory[card.key] || [], card.color)}</div>`;
    setMarkup(el, `
      <h3>${card.label}</h3>
      <div class="telemetry-value">${card.value}</div>
      <span class="telemetry-label">${card.sub}</span>
      ${tempGaugeHtml(card.tempC, card.tempLabel, { showMissing: card.tempVital, missingHint: card.tempHint, missingValue: card.tempMissingValue, missingTone: card.tempMissingTone, source: card.tempSource })}
      <div class="telemetry-detail">
        <strong>${card.detailValue}</strong>
        <span>${card.detailLabel}</span>
        <strong>${card.secondValue}</strong>
        <span>${card.secondLabel}</span>
      </div>
      ${bottom}
    `);
    if (el.parentElement !== root) root.appendChild(el);
  });
  for (const node of existing.values()) node.remove();
  if (fanRow) {
    setMarkup(fanRow, renderFanTelemetryRow(sourceStatus || {}));
  }
  if (hardwareRow) {
    setMarkup(hardwareRow, renderHardwareProfileRow(sourceStatus || {}));
    hardwareRow.classList.toggle("has-drift", sourceStatus?.hardwareProfile?.status === "drift-detected");
  }
  const netMeter = $("networkMeter");
  if (netMeter) {
    const kind = $("serviceStatus").dataset.state;
    renderNetworkQuality(netMeter, state.status || sourceStatus || {}, { monitoringAvailable: kind === "live" || kind === "paused" });
  }
}

function healthToneClass(tone) {
  if (tone === "red") return "var(--red)";
  if (tone === "amber") return "var(--amber)";
  return "var(--green)";
}

function displayProcessName(name) {
  const raw = String(name || "Unknown");
  return /win64[-_]?shipping/i.test(raw) ? "Foreground workload" : raw;
}

function displayNameList(entries = []) {
  return entries.map((entry) => displayProcessName(entry.name)).slice(0, 3).join(", ");
}

function performanceSessionLabel() {
  return "Competitive Gaming Session";
}

function sessionDisplayLabel(session = {}) {
  if (session.label) return session.label;
  const profileLabels = {
    competitive: performanceSessionLabel(),
    agentic: "Agentic Work",
    balanced: "Balanced",
    conservative: "Focused Work"
  };
  return profileLabels[session.profile] || session.profile || "Performance";
}

function sessionThermalLabel(session = {}) {
  const thermal = session.thermal || {};
  if (!thermal.worstSeverity || thermal.worstSeverity === "ok") {
    return thermal.samples ? "thermal ok" : "thermal pending";
  }
  const component = thermal.worstComponent ? `${thermal.worstComponent} ` : "";
  return `${component}${thermal.worstSeverity}`;
}

function renderSummary() {
  const status = state.status;
  if (!status) return;
  const mode = status.policy.mode;
  const meta = modeMeta[mode.id] || modeMeta.balanced;
  const health = status.policy.health;
  const priority = status.policy.priority;
  const workloadRunning = Boolean(status.telemetry?.priorityApp?.running);
  const activeProfile = (workloadRunning || mode.id === "competitive")
    ? (priority?.label || performanceSessionLabel())
    : mode.label;

  $("currentMode").textContent = mode.label;
  $("currentMode").style.color = meta.color;
  $("leftCurrentMode").textContent = mode.label;
  $("leftCurrentMode").style.color = meta.color;
  $("activeProfile").textContent = `Profile: ${activeProfile}`;
  $("activeProfileFooter").textContent = `Active Profile: ${activeProfile}`;
  $("appVersionFooter").innerHTML = `v${status.app?.version || "0.8.0"} <i></i>`;
  $("modeSince").textContent = elapsedSince(state.modeStartedAt);
  $("healthText").textContent = health.state;
  $("healthText").style.color = healthToneClass(health.tone);
  $("healthIcon").style.color = healthToneClass(health.tone);
  $("healthReason").textContent = health.reasons?.[0] || "No critical issues";
  const game = status.telemetry?.game || null;
  const identified = game?.confirmed || null;
  $("priorityLabel").textContent = identified ? (identified.title || identified.name) : priority.label;
  $("priorityReason").textContent = identified
    ? (identified.reason || "Identified game")
    : (workloadRunning ? "PID detected • Active" : priority.reason);
  $("priorityTile").textContent = identified
    ? String(identified.title || identified.name).slice(0, 2).toUpperCase()
    : (workloadRunning ? "HL" : priority.label.slice(0, 2).toUpperCase());
  renderGameCorrection(game);
  const captureDurationMs = Number(status.telemetry?.captureDurationMs);
  const captureDurationLabel = Number.isFinite(captureDurationMs) && captureDurationMs >= 1000
    ? ` • capture ${Math.floor(captureDurationMs / 1000)}s`
    : "";
  const staleAge = fmtDuration(status.telemetry?.seedAgeMs);
  const staleLabel = status.telemetry?.stale ? ` (cached${staleAge ? ` ${staleAge} old` : ""})` : "";
  $("captureTime").textContent = status.telemetry?.capturedAt
    ? `Last Updated: ${new Date(status.telemetry.capturedAt).toLocaleTimeString()}${staleLabel}${captureDurationLabel}`
    : "Last Updated: --";
  $("modeActiveChip").textContent = (status.state?.autonomy || "manual-first") === "auto-safe" ? "Auto-Safe" : "Manual";
  renderConnectionStatus();
  $("uptimeFooter").textContent = `System Uptime: ${fmt(status.telemetry?.system?.uptimeHours, " h")}`;
}

function buildActivePolicies(status) {
  const power = extractPowerName(status.telemetry?.power?.activeLine);
  const mode = status.policy.mode;
  const inactivity = status.v2?.inactivity || {};
  const eventAnalysis = status.policy.eventAnalysis || {};
  const failureWatchlist = status.policy.failureWatchlist || {};
  const failureDiagnostics = status.policy.failureDiagnostics || {};
  const traps = status.v2?.diagnosticTraps || {};
  const trapEvidence = traps.evidence || {};
  const networkHealth = status.policy.networkHealth || {};
  const powerSystem = status.policy.powerSystem || {};
  const adaptive = status.v2?.adaptivePower || {};
  const readiness = status.v2?.readiness || {};
  const readinessItems = readiness.items || [];
  const importantReadiness = [...readinessItems]
    .sort((a, b) => readinessPriority(a) - readinessPriority(b))
    .slice(0, 7);
  const discoveryCount = state.workloadDiscovery?.candidates?.length || 0;
  const activeFailures = failureWatchlist.active || [];
  const recentFailures = activeFailures.filter((profile) => profile.recent).length;
  const historicalFailures = Math.max(0, activeFailures.length - recentFailures);
  const failureCountText = recentFailures
    ? `${recentFailures} live${historicalFailures ? ` / ${historicalFailures} documented` : ""}`
    : `${activeFailures.length || 0} documented`;
  return [
    `Readiness: ${readiness.summary || "pending"}`,
    ...importantReadiness.map((item) => `${item.label}: ${item.summary}`),
    `Inactivity: ${inactivity.summary || "watching"}`,
    `Power Plan: ${power}`,
    adaptivePowerPolicyLine(adaptive, power),
    mlGovernorPolicyLine(status),
    mlOptimizerPolicyLine(status),
    selfTreatmentPolicyLine(status),
    reliefPolicyLine(status),
    buildLearningPowerBiasLine(status),
    `Profile Mode: ${mode.label}`,
    `Autonomy: ${status.state?.autonomy || "manual-first"}`,
    `HAGS Readback: ${fmt(status.telemetry?.power?.hags)}`,
    `Crash Signals: ${(eventAnalysis.crashSignals || []).length}`,
    `Failure Watch: ${failureDiagnostics.state || "clear"} / ${failureCountText} / ${failureWatchlist.monitored || 0} guarded`,
    incidentLearningPolicyLine(status),
    failureProactivePreventionPolicyLine(status),
    failureRemediationPolicyLine(status),
    failurePreventionPolicyLine(status),
    `Network: ${networkHealth.state || "unknown"} / ${networkHealth.latencyMs ?? "--"} ms / ${networkHealth.packetLossPct ?? "--"}% loss`,
    `DNS/Reachability: DNS ${networkHealth.dnsOk === false ? "fail" : "ok"} / Web ${networkHealth.webReachable === false ? "fail" : "ok"}`,
    `Power Capability: ${powerSystem.state || "unknown"} / Boost ${processorBoostLabel(powerSystem.processorBoost)} / Min ${powerSystem.processorState?.minAc ?? "--"}% / USB ${powerSystem.usbSelectiveSuspend?.acLabel || "--"}`,
    `Diagnostic Traps: ${traps.active ? `Armed (${traps.minutesRemaining}m)` : "Off"}`,
    `Trap Evidence: ${trapEvidence.dumpCount || 0} dumps / ${trapEvidence.warningCount || 0} warnings`,
    `Competitive Candidates: ${discoveryCount || "not scanned"}`,
    "Pacing: unrestricted",
    "Overlay Guard: Session-scoped",
    "Background App Rules: Active",
    buildLearningPolicyLine(status)
  ];
}

function incidentLearningPolicyLine(status) {
  const learning = status.v2?.incidentLearning || {};
  const report = learning.report || {};
  if (!learning.schema) {
    return "Incident Learning: watching";
  }
  if (learning.activeSignal) {
    return "Incident Learning: recording normalized evidence";
  }
  if (learning.status === "verified-clean") {
    return "Incident Learning: clean pattern verified";
  }
  if (report.summary && !/No GPU reset\/watchdog incident/.test(report.summary)) {
    return `Incident Learning: ${report.summary}`;
  }
  return "Incident Learning: quiet";
}

function reliefShortState(entry, label) {
  if (!entry || entry.enabled === false) {
    return `${label} disabled`;
  }
  if (entry.backoffUntil) {
    return `${label} backed off until ${fmtClock(entry.backoffUntil) || "later"}`;
  }
  if (entry.cooldownUntil) {
    return `${label} cooldown until ${fmtClock(entry.cooldownUntil) || "later"}`;
  }
  if (entry.autonomousAllowed) {
    return `${label} ready`;
  }
  if (entry.state === "no pressure" || String(entry.gate?.reason || "").startsWith("no pressure")) {
    return `${label} watching`;
  }
  return `${label} gated`;
}

function selfTreatmentPolicyLine(status) {
  const treatment = status.v2?.selfTreatment || {};
  if (!treatment.status) {
    return "Self-Treatment: watching";
  }
  if (treatment.pendingCount) {
    return `Self-Treatment: verifying ${treatment.pendingCount} cure${treatment.pendingCount === 1 ? "" : "s"}`;
  }
  if (treatment.activeBackoffs?.length) {
    return `Self-Treatment: backed off (${treatment.activeBackoffs[0].label})`;
  }
  if (treatment.next?.label) {
    return `Self-Treatment: ready / ${treatment.next.label}`;
  }
  return `Self-Treatment: ${autonomyStatusLabel(treatment.status)}`;
}

function reliefPolicyLine(status) {
  const relief = status.v2?.relief || {};
  if (!relief.ram && !relief.cpu) {
    return "Relief: status unavailable";
  }
  return `Relief: ${reliefShortState(relief.ram, "RAM")} / ${reliefShortState(relief.cpu, "CPU")} / ${reliefShortState(relief.network, "Network")} / ${reliefShortState(relief.gpu, "GPU")}`;
}

function buildLearningPowerBiasLine(status) {
  const influence = status.v2?.learningInfluence || {};
  const adaptive = status.v2?.adaptivePower || {};
  const learning = adaptive.learning || {};
  const thermal = learning.thermal || {};
  if (influence.enabled === false) {
    return "Learning Power Bias: advisory-only / ignored";
  }
  if (learning.guardrailActive) {
    return `Learning Power Bias: guardrail cap / ${learning.sessions || 0} session(s)`;
  }
  const bias = Number(learning.biasTier || 0);
  const direction = bias > 0 ? `+${bias}` : String(bias);
  const score = Number.isFinite(Number(learning.avgScore)) ? `avg ${learning.avgScore}` : "no avg";
  const thermalLabel = thermal.state && thermal.state !== "unknown" ? ` / thermal ${thermal.state}` : "";
  return `Learning Power Bias: ${direction} tier / ${score} / ${learning.sessions || 0} session(s)${thermalLabel}`;
}

function adaptivePowerPolicyLine(adaptive, fallbackPlan) {
  const plan = adaptive.plan || fallbackPlan;
  const guard = String(adaptive.guard || "");
  const suffix =
    guard === "dwell hold" || guard === "hysteresis hold"
      ? " — holding"
      : guard
        ? ` — guarded: ${guard}`
        : "";
  return `Adaptive Power: ${plan}${suffix}`;
}

function mlGovernorPolicyLine(status) {
  const governor = status.v2?.mlGovernor || {};
  const ledger = governor.decisionLedger || status.v2?.mlDecisionLedger || {};
  const gate = status.v2?.mlExecutionGate || {};
  if (!governor.schema) {
    return "ML Governor: unavailable";
  }
  const level = governor.level || ledger.level || 4;
  const target = governor.targetLevel || 5;
  const top = governor.selected?.label || "Keep monitoring";
  const statusLabel = String(governor.status || "shadow-governor").replace(/-/g, " ");
  const gateLabel = gate.eligible ? `gate ${gate.handler}` : `gate waiting`;
  const evidence = ledger.verifiedCount
    ? `${ledger.verifiedCount} verified / ${ledger.successPct ?? "--"}% stable`
    : ledger.pendingCount
      ? `${ledger.pendingCount} pending verification`
      : "collecting evidence";
  return `ML Governor: Level ${level}->${target} / ${statusLabel} / ${gateLabel} / ${evidence} / top ${top}`;
}

function mlOptimizerPolicyLine(status) {
  const optimizer = status.v2?.mlOptimizer || {};
  if (!optimizer.schema) {
    return "ML Optimizer: unavailable";
  }
  const coverage = optimizer.coverage || {};
  const selected = optimizer.selectedExperiment || {};
  const stateLabel = String(optimizer.status || "hypothesis-search").replace(/-/g, " ");
  const ready = coverage.executableCount || 0;
  return `ML Optimizer: ${stateLabel} / ${coverage.hypothesisCount || 0} hypotheses / ${ready} executable / top ${selected.label || "monitoring"}`;
}

function readinessPriority(item) {
  if (item.state === "fail") return 0;
  if (item.state === "warn") return 1;
  if (item.state === "info") return 2;
  return 3;
}

function buildLearningPolicyLine(status) {
  const influence = status.v2?.learningInfluence || {};
  const learning = status.learning;
  const guardrails = learning?.guardrails || [];
  const appRep = learning?.appReputation || {};
  const suspectCount = (appRep.suspects || []).length;
  const blockCount = (appRep.temporaryBlocks || []).length;
  const allowCount = (appRep.suggestedAllow || []).length;
  const influenceLabel = influence.enabled === false ? "advisory-only" : "active";
  if (blockCount || suspectCount || allowCount) {
    return `Learned Apps (${influenceLabel}): ${blockCount} temp block / ${suspectCount} suspect / ${allowCount} allow candidate`;
  }
  if (guardrails.length) {
    return `Learned Guardrails (${influenceLabel}): ${guardrails.map((g) => modeLabelFor(g.profileId)).join(", ")} paused`;
  }
  const profiles = Object.entries(learning?.profiles || {});
  if (!profiles.length) {
    return `Learning (${influenceLabel}): collecting session outcomes`;
  }
  const [id, stats] = profiles[0];
  const thermal = stats.thermal?.state && stats.thermal.state !== "unknown"
    ? ` / thermal ${stats.thermal.state}`
    : "";
  return `Learning (${influenceLabel}): ${modeLabelFor(id)} avg score ${stats.avgScore ?? "--"} over ${stats.sessions} session(s)${thermal}`;
}

function hasFailureProfileId(entries = [], id) {
  return (entries || []).some((entry) => entry?.id === id || entry?.profileId === id);
}

function remediationHasProfile(remediation = {}, id) {
  return hasFailureProfileId(remediation.routes || [], id);
}

function failureRemediationPolicyLine(status) {
  const remediation = status.policy?.failureRemediation || status.v2?.failureRemediation || {};
  const learning = remediation.learning || {};
  const learner = learning.enabled === false ? "learner advisory" : "learner active";
  const routed = Number(remediation.activeCount || 0);
  const live = Number(remediation.liveCount || 0);
  const gpuReset = remediationHasProfile(remediation, "nvidia-driver-reset")
    ? " / GPU driver reset/watchdog visible"
    : "";
  return `Failure Remediation: fully autonomous${gpuReset} / ${routed} routed / ${live} live / ${learner}`;
}

function failureProactivePreventionPolicyLine(status) {
  const proactive = status.policy?.failureProactivePrevention || status.v2?.failureProactivePrevention || {};
  const active = Number(proactive.activeCount || 0);
  const standby = Number(proactive.standbyCount || 0);
  return `Proactive Prevention: fully autonomous / ${active} hygiene guard(s) / ${standby} known standby`;
}

function failurePreventionPolicyLine(status) {
  const prevention = status.policy?.failurePrevention || status.v2?.failurePrevention || {};
  const learning = prevention.learning || {};
  const target = prevention.targetMode ? ` / target ${modeLabelFor(prevention.targetMode)}` : "";
  const heat = learning.heatProne ? " / heat-prone caution" : "";
  return `Failure Prevention: fully autonomous / ${prevention.recentCount || 0} recurrence guard(s)${target}${heat}`;
}

function buildAllActiveActions(status) {
  const actions = [];
  const recommendations = status.policy.recommendedActions || [];
  const fastPatch = status.policy.fastPatchPlan || {};
  const hardenedPatch = status.policy.hardenedPatchPlan || {};
  const proactive = status.policy.failureProactivePrevention || status.v2?.failureProactivePrevention || {};
  const remediation = status.policy.failureRemediation || status.v2?.failureRemediation || {};
  const prevention = status.policy.failurePrevention || status.v2?.failurePrevention || {};
  const trapEvidence = status.v2?.diagnosticTraps?.evidence || {};
  const networkHealth = status.policy.networkHealth || {};
  const powerSystem = status.policy.powerSystem || {};
  const appRep = status.learning?.appReputation || {};
  const readinessItems = status.v2?.readiness?.items || [];
  const elevatedSensorWarnings = readinessItems.filter((item) =>
    ["storageTelemetry", "cpuTemperature", "memoryTemperature"].includes(item.key) && item.state === "warn"
  );
  const reviewOnlyActionIds = new Set(["learned-suspect-apps", "learned-allow-candidates"]);
  recommendations.forEach((item) =>
    !item.dryRunOnly &&
      !reviewOnlyActionIds.has(item.id) &&
      actions.push({ label: item.label, reason: item.reason || item.detail || null })
  );
  if (elevatedSensorWarnings.length) {
    const labels = elevatedSensorWarnings.map((item) => item.label).join(", ");
    actions.push({
      label: "Hardware sensors elevated launcher",
      reason: `${labels} need the elevated launcher. Preview shows the exact launcher path; restart the service elevated for this to clear.`,
      manualAction: {
        type: "elevated-preview",
        actionId: "storageSmartTelemetry",
        label: "Launcher"
      }
    });
  }
  if ((appRep.temporaryBlocks || []).length > 0) {
    actions.push({
      label: "Learned temporary block active",
      reason: displayNameList(appRep.temporaryBlocks || [])
    });
  }
  if (proactive.activeCount > 0) {
    actions.push({
      label: "Proactive prevention active",
      reason: (proactive.activeGuards || []).map((entry) => entry.reason).slice(0, 2).join(" | ")
    });
  }
  if (remediation.active) {
    actions.push({
      label: "Failure remediation autonomous",
      reason: remediation.summary || "All Failure Watch entries are routed through safe autonomous handlers."
    });
  }
  if (prevention.preventions?.length > 0) {
    actions.push({
      label: "Failure recurrence prevention active",
      reason: prevention.preventions.map((entry) => entry.reason).slice(0, 2).join(" | ")
    });
  }
  if (fastPatch.active) {
    actions.push({ label: "Failure fast patch armed", reason: (fastPatch.actions || []).slice(0, 2).join(" | ") });
  }
  if (hardenedPatch.active) {
    actions.push({ label: "Hardened follow-up queued", reason: (hardenedPatch.actions || []).slice(0, 2).join(" | ") });
  }
  if (trapEvidence.dumpCount > 0) {
    actions.push({ label: "Trap evidence ready", reason: trapEvidence.nextAction || "Analyze newest WER dump." });
  } else if ((trapEvidence.warningCount || 0) > 0 || (trapEvidence.eventCount || 0) > 0) {
    actions.push({ label: "Trap warning captured", reason: trapEvidence.nextAction || "Compare event delta against current profile." });
  }
  if (networkHealth.state && networkHealth.state !== "good") {
    actions.push({ label: "Network guard", reason: networkHealth.issues?.[0] || "Review adapter, DNS, VPN, and reachability." });
  }
  if (powerSystem.state && powerSystem.state !== "good") {
    actions.push({ label: "Power guard", reason: powerSystem.issues?.[0] || "Review boost, USB suspend, and GPU state." });
  }
  return actions;
}

function failureDot(profile) {
  if (profile.severity === "critical") return '<span class="status-dot blocked">!</span>';
  if (profile.severity === "warning") return '<span class="status-dot warn">!</span>';
  return '<span class="status-dot info">i</span>';
}

function failureSubtext(profile) {
  const parts = [
    profile.recent ? "recent" : "historical",
    profile.phase || "runtime",
    `${profile.count || 0} hit${profile.count === 1 ? "" : "s"}`
  ];
  if (profile.autoDownshift) {
    parts.push("auto downshift");
  }
  return parts.join(" / ");
}

function failureTitle(parts = []) {
  return parts
    .filter(Boolean)
    .map((part) => String(part).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function failureCountLabel(active = []) {
  const recent = active.filter((profile) => profile.recent).length;
  const historical = Math.max(0, active.length - recent);
  if (recent) {
    return `${recent} live${historical ? ` / ${historical} documented` : ""}`;
  }
  return active.length ? `${active.length} documented` : "clear";
}

function failureReportLabel(reportState, active = []) {
  if (reportState === "clear") return "clear";
  if (hasFailureProfileId(active, "nvidia-driver-reset")) {
    return active.some((profile) => profile.id === "nvidia-driver-reset" && profile.recent)
      ? "GPU driver reset/watchdog"
      : "GPU driver reset/watchdog watch";
  }
  if (active.some((profile) => profile.recent && profile.severity === "critical")) return "critical live signal";
  if (active.some((profile) => profile.recent)) return "live warning";
  return "documented watch";
}

function failureBadge(profile) {
  if (profile.recent && profile.fastPatch?.length) return "Fast";
  if (profile.fastPatch?.length) return "Plan";
  return "Watch";
}

function renderFailureWatchList(status) {
  const watch = status.policy.failureWatchlist || {};
  const diagnostics = status.policy.failureDiagnostics || {};
  const remediation = status.policy.failureRemediation || status.v2?.failureRemediation || {};
  const traps = status.v2?.diagnosticTraps || {};
  const active = watch.active || [];
  const reportState = diagnostics.state || (active.length ? "warning" : "clear");
  const reportSummary = diagnostics.summary || `${watch.monitored || 0} guarded signatures monitored.`;
  const nextAction = diagnostics.nextAction || "Keep monitoring documented failure signatures.";
  const countLabel = failureCountLabel(active);
  const reportMeta = active.length
    ? `${countLabel} / ${watch.monitored || 0} guarded / remediation ${remediation.status || "pending"} / traps ${traps.active ? "armed" : "off"}`
    : `${watch.monitored || 0} guarded / remediation ${remediation.status || "pending"} / traps ${traps.active ? "armed" : "off"}`;
  const summaryRow = `
    <div class="failure-row summary ${reportState}" title="${escapeHtml(failureTitle([reportSummary, `Next: ${nextAction}`]))}">
      ${reportState === "critical" ? '<span class="status-dot blocked">!</span>' : reportState === "clear" ? '<span class="status-dot">&#10003;</span>' : '<span class="status-dot warn">!</span>'}
      <span>
        <strong>Failure watch: ${escapeHtml(failureReportLabel(reportState, active))}</strong>
        <small>${escapeHtml(reportMeta)}</small>
      </span>
      <em class="failure-badge">${escapeHtml(countLabel)}</em>
    </div>
  `;
  $("failureWatchList").innerHTML = summaryRow + renderFailureGroupRows(status, true);
}

const offenderHandlingLabels = {
  "observe-only": "Observe only"
};

function modeLabelFor(id) {
  return (state.status?.modes || []).find((mode) => mode.id === id)?.label || id;
}

function buildAutomations(status) {
  const autonomy = status.state?.autonomy || "manual-first";
  const observerRunning = Boolean(status.observer?.running);
  const auto = status.state?.automations || {};
  const autoSafeActive = autonomy === "auto-safe" && observerRunning;
  const traps = status.v2?.diagnosticTraps || {};
  const networkHealth = status.policy?.networkHealth || {};
  const powerSystem = status.policy?.powerSystem || {};
  const autoSubtext = observerRunning
    ? "Switch based on active app and rules"
    : "Observer disconnected; switch not connected";
  const launchValue = auto.profileOnLaunch || "competitive";
  const trapEvidence = traps.evidence || {};
  const trapSummary = trapEvidence.dumpCount > 0
    ? `${trapEvidence.dumpCount} dump${trapEvidence.dumpCount === 1 ? "" : "s"} captured`
    : trapEvidence.warningCount > 0
      ? `${trapEvidence.warningCount} warning${trapEvidence.warningCount === 1 ? "" : "s"} captured`
      : "No captures yet";
  return [
    { key: "autonomy", label: "Auto Mode Switch", sub: autoSubtext, active: autoSafeActive, type: "autonomy" },
    { key: "thermalProtection", label: "Thermal Protection", sub: "Downshift if temps exceed thresholds", active: auto.thermalProtection !== false, type: "toggle" },
    { key: "crashRecovery", label: "Crash Recovery", sub: "Apply next safe profile tier", active: auto.crashRecovery !== false, type: "toggle" },
    { key: "failureProactivePrevention", label: "Proactive Prevention", sub: "Known issue hygiene and preflight", active: auto.failureProactivePrevention !== false, type: "toggle" },
    { key: "failureRemediation", label: "Failure Remediation", sub: "Route live signatures through safe handlers", active: auto.failureRemediation !== false, type: "toggle" },
    { key: "failurePrevention", label: "Failure Prevention", sub: "Guard recurrence after remediation", active: auto.failurePrevention !== false, type: "toggle" },
    { key: "selfHeal", label: "Self-Heal", sub: "Re-apply mode settings if they drift", active: auto.selfHeal !== false, type: "toggle" },
    {
      key: "networkGuard",
      label: "Network Guard",
      sub: networkHealth.state === "good"
        ? "Adapter, latency, DNS, VPN, reachability"
        : networkHealth.issues?.[0] || "Review adapter, DNS, VPN, reachability",
      active: auto.networkGuard !== false,
      type: "toggle"
    },
    {
      key: "powerGuard",
      label: "Power Guard",
      sub: powerSystem.state === "good"
        ? "Plan, CPU boost, USB, GPU limit state"
        : powerSystem.issues?.[0] || "Review plan, boost, USB, GPU state",
      active: auto.powerGuard !== false,
      type: "toggle"
    },
    {
      key: "diagnosticTraps",
      label: "Diagnostic Traps",
      sub: traps.active
        ? `WER dumps armed; ${traps.minutesRemaining || 0}m left; ${trapSummary}`
        : trapEvidence.dumpCount || trapEvidence.warningCount
          ? trapSummary
          : "Arm reversible WER/event traps",
      active: Boolean(traps.active),
      type: "diagnostic-trap"
    },
    {
      key: "offenderHandling",
      label: "Offender Handling",
      sub: offenderHandlingLabels[auto.offenderHandling] || "Observe only",
      type: "select",
      value: auto.offenderHandling || "observe-only",
      options: Object.entries(offenderHandlingLabels).map(([value, label]) => ({ value, label }))
    },
    {
      key: "cooldownSeconds",
      label: "Cooldown",
      sub: `${auto.cooldownSeconds ?? 90} seconds`,
      type: "number",
      value: auto.cooldownSeconds ?? 90
    },
    {
      key: "profileOnLaunch",
      label: "Profile on Launch",
      sub: launchValue === "none" ? "Disabled" : modeLabelFor(launchValue),
      type: "select",
      value: launchValue,
      options: [
        ...(state.status?.modes || []).map((mode) => ({ value: mode.id, label: mode.label })),
        { value: "none", label: "Disabled" }
      ]
    }
  ];
}

function renderPolicySurface() {
  const policies = buildActivePolicies(state.status);
  $("activePolicies").innerHTML = policies
    .map((item) => `<div class="policy-row"><span class="status-dot">✓</span><span>${escapeHtml(item)}</span></div>`)
    .join("");

  const allActions = buildAllActiveActions(state.status);
  const actions = state.showAllActions ? allActions : allActions.slice(0, 10);
  $("actionCount").textContent = `(${allActions.length})`;
  if (!allActions.length) {
    $("activeActions").innerHTML = `
      <div class="action-row action-row--empty">
        <span class="action-dot">✓</span>
        <span>No active actions</span>
      </div>`;
    return;
  }
  $("activeActions").innerHTML = actions
    .map((item, index) => {
      const hasHiddenActions = allActions.length > actions.length;
      const showReason = state.showAllActions || allActions.length <= 3;
      const button = hasHiddenActions && index === Math.min(4, actions.length - 1)
        ? `<button class="mini-button" type="button" data-toggle-actions="1">${state.showAllActions ? "Less" : "View"}</button>`
        : "";
      const actionButton = item.manualAction?.type === "elevated-preview"
        ? `<button class="mini-button" type="button" data-elevated-action="${escapeHtml(item.manualAction.actionId)}">${escapeHtml(item.manualAction.label || "Preview")}</button>`
        : button;
      const reason = showReason && item.reason ? `<small class="action-reason">${escapeHtml(item.reason)}</small>` : "";
      return `<div class="action-row"><span class="action-dot">›</span><span>${escapeHtml(item.label)}${reason}</span>${actionButton}</div>`;
    })
    .join("");

  renderFailureWatchList(state.status);

  state.automationItems = buildAutomations(state.status);
}

function impactFor(process) {
  const ram = clampNumber(process.workingSetMB);
  const cpuPct = clampNumber(process.cpuPct);
  const cpu = clampNumber(process.cpuSeconds);
  if (ram >= 4000 || cpuPct >= 15 || cpu >= 600) return "High";
  if (ram >= 800 || cpuPct >= 5 || cpu >= 120) return "Medium";
  return "Low";
}

function offenderAction(process, impact) {
  if (process.gpuFeedBias) return "Review";
  if (process.reputation?.state === "blocked-this-session") return "Suppress";
  if (process.reputation?.state === "suspect") return "Review";
  const suggested = String(process.suggestedAction || "");
  if (suggested.includes("suppress") || suggested.includes("suspend")) return "Observe";
  if (suggested.includes("refresh")) return "Refresh";
  if (suggested.includes("priority")) return "Lower Priority";
  if (impact === "Medium") return "Lower Priority";
  return "Ignore";
}

function learningStatusText(entry) {
  if (entry.state === "blocked-this-session") return "Temp Block";
  if (entry.state === "suspect") return "Suspect";
  if (entry.userDecision === "allow") return "Allowed";
  if (entry.state === "trusted-suggested") return "Allow?";
  if (entry.state === "probation-allow") return "Probation";
  return "Observed";
}

function learningReason(entry) {
  const bits = [];
  if (entry.cleanSessions) bits.push(`${entry.cleanSessions} clean`);
  if (entry.offenderSightings) bits.push(`${entry.offenderSightings} offender`);
  if (entry.badSessions) bits.push(`${entry.badSessions} bad`);
  if (entry.crashCorrelations) bits.push(`${entry.crashCorrelations} crash-linked`);
  return bits.length ? bits.join(" / ") : "Collecting evidence";
}

function learningDecisionButtons(entry) {
  const key = escapeHtml(entry.key);
  if (entry.state === "blocked-this-session") {
    return `<button class="row-action" type="button" data-learning-decision="clear" data-learning-key="${key}">Clear</button>`;
  }
  return [
    `<button class="row-action" type="button" data-learning-decision="promote-allow" data-learning-key="${key}">Allow</button>`,
    `<button class="row-action" type="button" data-learning-decision="temporary-block" data-learning-key="${key}">Block</button>`,
    `<button class="row-action" type="button" data-learning-decision="ignore" data-learning-key="${key}">Ignore</button>`
  ].join("");
}

function renderTables() {
  const offenders = state.status?.policy?.offenders || [];
  const visible = state.showAllOffenders ? offenders : offenders.slice(0, 5);
  const offenderRows = visible.length
    ? visible
    : [{ name: "No unchecked offenders", cpuPct: "--", cpuSeconds: "--", workingSetMB: "--", suggestedAction: "Observe" }];

  $("offenderRows").innerHTML = offenderRows
    .map((process) => {
      const impact = impactFor(process);
      const impactClass = impact === "High" ? "impact-high" : impact === "Medium" ? "impact-medium" : "impact-low";
      const action = offenderAction(process, impact);
      return `
        <tr>
          <td><span class="process-cell"><span class="table-icon">□</span>${escapeHtml(displayProcessName(process.name))}</span></td>
          <td>${process.cpuPct === "--" ? "--" : process.cpuPct !== null && process.cpuPct !== undefined ? fmt(process.cpuPct, "%") : fmt(process.cpuSeconds, "s")}</td>
          <td>${process.workingSetMB === "--" ? "--" : fmt(process.workingSetMB, " MB")}</td>
          <td class="${impactClass}">${impact}</td>
          <td><span class="row-action-label">${action}</span></td>
        </tr>
      `;
    })
    .join("");

  if (offenders.length > 5) {
    $("offenderFooter").innerHTML = `<button id="showAllOffenders" class="table-footer-button" type="button">${state.showAllOffenders ? "Show Top 5" : `Show All (${offenders.length})`}</button>`;
  } else {
    $("offenderFooter").innerHTML = `<span class="table-footer-note">${offenders.length ? `${offenders.length} offender row(s)` : "No offender rows hidden"}</span>`;
  }

  const serverRules = state.status?.protectedApps;
  const protectedDisplay = Array.isArray(serverRules) && serverRules.length
    ? serverRules.map((rule) => [rule.label, "Rule", rule.reason, "Allowed", (rule.match || []).join(", ")])
    : protectedRows.map((row) => [...row, ""]);
  const staticRows = protectedDisplay
    .map(
      ([process, type, reason, status, match]) => `
        <tr title="${match ? `Matches: ${match}` : ""}">
          <td><span class="process-cell"><span class="table-icon">□</span>${process}</span></td>
          <td>${type}</td>
          <td>${reason}</td>
          <td class="allowed">✓ ${status}</td>
        </tr>
      `
    )
    .join("");
  const appRep = state.status?.learning?.appReputation || {};
  const learned = [
    ...(appRep.temporaryBlocks || []),
    ...(appRep.suspects || []),
    ...(appRep.suggestedAllow || [])
  ].slice(0, 8);
  const learnedRows = learned.map((entry) => `
    <tr title="${escapeHtml(entry.path || entry.key)}">
      <td><span class="process-cell"><span class="table-icon">□</span>${escapeHtml(displayProcessName(entry.name))}</span></td>
      <td>${entry.state === "trusted-suggested" || entry.state === "probation-allow" ? "Review" : "Learned"}</td>
      <td>${escapeHtml(learningReason(entry))}</td>
      <td class="allowed">${escapeHtml(learningStatusText(entry))} ${learningDecisionButtons(entry)}</td>
    </tr>
  `).join("");
  $("protectedRows").innerHTML = staticRows + learnedRows;
  const hiddenLearned = Math.max(0,
    (appRep.temporaryBlocks || []).length +
    (appRep.suspects || []).length +
    (appRep.suggestedAllow || []).length -
    learned.length
  );
  $("protectedSummary").textContent = learned.length
    ? `${protectedDisplay.length} protected rule(s), ${learned.length} learned review row(s)${hiddenLearned ? `, ${hiddenLearned} more` : ""}`
    : `${protectedDisplay.length} protected rule(s)`;
}

function auditGroupLabel(entry) {
  const now = new Date();
  const todayKey = now.toDateString();
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterdayKey = yesterdayDate.toDateString();
  const date = new Date(entry.ts);
  if (!Number.isFinite(date.getTime())) {
    return "Undated";
  }
  const key = date.toDateString();
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function groupAudit(audit) {
  const groups = new Map();
  audit.forEach((entry) => {
    const label = auditGroupLabel(entry);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(entry);
  });
  return groups;
}

const AUDIT_UI_NO_COALESCE = [
  "observer.auto-apply",
  "mode.apply",
  "selfheal.power-plan",
  "memory.release",
  "cpu.relief",
  "panic",
  "restore",
  "session.prep",
  "session.restore",
  "diagnostics.traps.arm",
  "diagnostics.traps.disarm",
  "crash"
];

function isAuditUiCoalescible(entry) {
  const action = String(entry?.action || "");
  if (!action) return false;
  if (entry?.level === "warn" && /crash|critical|danger|bugcheck|whea|access/i.test(`${action} ${entry?.message || ""}`)) {
    return false;
  }
  return !AUDIT_UI_NO_COALESCE.some((blocked) => action.includes(blocked));
}

function auditUiSignature(entry) {
  const bits = [
    entry?.level || "",
    entry?.action || "",
    auditTitle(entry),
    auditMessage(entry)
  ];
  return bits.filter(Boolean).join("|");
}

function coalesceAuditRuns(groupEntries, indexed) {
  const runs = [];
  for (const entry of groupEntries) {
    const index = indexed.get(entry);
    const signature = isAuditUiCoalescible(entry) ? auditUiSignature(entry) : null;
    const previous = runs[runs.length - 1];
    if (signature && previous?.signature === signature) {
      previous.entries.push({ entry, index });
      continue;
    }
    runs.push({ signature, entries: [{ entry, index }] });
  }
  return runs.map((run) => {
    const times = run.entries
      .map(({ entry }) => Date.parse(entry.ts || ""))
      .filter((ts) => Number.isFinite(ts));
    const firstTs = times.length ? Math.min(...times) : null;
    const lastTs = times.length ? Math.max(...times) : null;
    const representative = run.entries[0]?.entry || {};
    return {
      representative,
      index: run.entries[0]?.index,
      count: run.entries.length,
      firstTs,
      lastTs
    };
  });
}

function auditShortTime(ts) {
  return Number.isFinite(Number(ts))
    ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
}

function auditRepeatRange(run) {
  if (!run || run.count <= 1) return null;
  const first = auditShortTime(run.firstTs);
  const last = auditShortTime(run.lastTs);
  if (first && last && first !== last) return `${first}-${last}`;
  return last || first;
}

function auditDisplayEntry(run) {
  if (!run || run.count <= 1) return run?.representative;
  return {
    ...run.representative,
    details: {
      ...(run.representative.details || {}),
      uiCoalesced: true,
      uiRepeatCount: run.count,
      uiFirstTs: run.firstTs ? new Date(run.firstTs).toISOString() : null,
      uiLastTs: run.lastTs ? new Date(run.lastTs).toISOString() : null
    }
  };
}

function auditDisplayMessage(entry, run = null) {
  if (!run || run.count <= 1) return auditMessage(entry);
  const range = auditRepeatRange(run);
  return `Repeated ${run.count} times${range ? ` from ${range}` : ""}. ${auditMessage(entry)}`;
}

function auditIcon(entry) {
  const action = String(entry.action || "");
  if (action.includes("restore")) return ["↺", "restore"];
  if (entry.level === "warn") return ["!", "warn"];
  if (entry.level === "info" || entry.dryRun) return ["i", "info"];
  return ["✓", ""];
}

const AUDIT_FRIENDLY = [
  { m: "observer.inactivity-enter", t: "Idle cooling started", e: "No keyboard or mouse input was detected for the configured time, so the app moved into Conservative mode to save power and reduce heat." },
  { m: "observer.inactivity-restore", t: "Returned from idle cooling", e: "Keyboard or mouse input resumed, so the app restored the mode it remembered from before idle cooling." },
  { m: "observer.inactivity-overdrive-block", t: "Overdrive kept manual", e: "The prior mode was Overdrive, so the app restored Balanced instead. Overdrive still requires a direct user choice." },
  { m: "observer.auto-apply", t: "Power mode switched", e: "Automatically switched the power mode to match what you're doing." },
  { m: "observer.auto-hold", t: "Mode change paused", e: "Held off on an automatic mode change for the moment." },
  { m: "observer.mode-stability-hold", t: "Waiting for a steady signal", e: "The app saw a possible mode change, but is waiting briefly to make sure it is not a one-off spike." },
  { m: "observer.band-first", t: "Adjusted power level first", e: "Lowered the power level inside the current mode to shed heat, instead of switching modes — the in-mode power levels are tried first, and a full mode switch is held back unless it's really needed." },
  { m: "observer.gaming-hold", t: "Protected your game", e: "Kept your competitive session in its gaming mode instead of switching modes — during gaming, heat is handled by easing the power level, so the game isn't interrupted unless there's a real emergency." },
  { m: "ml.execute", t: "Autonomous executor acted", e: "The autonomous brain made and carried out a safe decision on its own — adjusting power or relief through the existing safe handlers, and only after it had verified evidence the action actually helps on this PC. Every safety gate still applied." },
  { m: "ml.prevention-hold", t: "Held back a learned-bad action", e: "The system has seen this action make things worse in recent checks, so it held it back this time. This only ever makes it more cautious — never more aggressive — and it never touches the core safety protections." },
  { m: "observer.error", t: "Minor internal hiccup", e: "The app hit an internal error and noted it. Nothing on your PC was harmed." },
  { m: "ml.optimizer.hypothesis", t: "Optimizer hypothesis", e: "The optimizer compared possible causes and chose a bounded experiment to watch or run through the safety registry." },
  { m: "ml.governor.executed", t: "Optimizer action delegated", e: "A verified optimizer choice was delegated to an existing safe handler; normal safety gates still applied." },
  { m: "ml.governor.verified", t: "Optimizer result checked", e: "Checked whether a previous optimizer choice actually helped or held the PC stable." },
  { m: "ml.governor.decision", t: "Optimizer choice recorded", e: "Recorded the optimizer's top safe choice so it can be verified later." },
  { m: "observer.tick", t: "Health check", e: "Routine check of your PC's health and current activity." },
  { m: "observer", t: "Health check", e: "Checked your PC's health and what it's doing." },
  { m: "mode.apply", t: "Power mode set", e: "Set the active power mode." },
  { m: "selfheal.power-plan", t: "Power plan tuned", e: "Nudged the Windows power plan to keep things responsive and cool." },
  { m: "selfheal.error", t: "Minor internal hiccup", e: "A self-tuning step hit an error and was recorded. No harm done." },
  { m: "failure.proactive-prevention", t: "Watching for issues", e: "Keeping an eye on known issues so they don't turn into problems." },
  { m: "failure.remediation.relief-gate", t: "Cleanup not needed", e: "Checked memory and CPU and decided no cleanup was necessary." },
  { m: "failure.remediation", t: "Issue handled safely", e: "Routed a known issue through a safe, reversible response." },
  { m: "failure.verification", t: "Checked an issue cleared", e: "Verified whether a recent issue actually resolved." },
  { m: "failure.prevention", t: "Staying cautious", e: "Kept higher-power modes off until things look clearly stable." },
  { m: "failure", t: "Issue-watch update", e: "Updated how a known issue is being watched or handled." },
  { m: "thermal.predictive-cool", t: "Cooled ahead of time", e: "Temperature was climbing fast, so the system eased power one step early to head off the heat before it became a problem." },
  { m: "diagnostics.traps.warning", t: "Noticed a brief spike", e: "Spotted a short CPU or memory spike and noted it for context." },
  { m: "diagnostics.traps.arm", t: "Evidence capture armed", e: "Armed a safe evidence trap in case an issue comes back." },
  { m: "diagnostics.traps.disarm", t: "Evidence capture cleared", e: "Cleared a previously armed evidence trap." },
  { m: "diagnostics", t: "Diagnostic note", e: "Recorded some diagnostic information." },
  { m: "learning.guardrail-armed", t: "Added a caution", e: "Paused auto-switching into a profile that recently had trouble." },
  { m: "learning.guardrail-cleared", t: "Caution cleared", e: "A profile is healthy again, so its caution was removed." },
  { m: "learning.guardrail-block", t: "Skipped a risky switch", e: "Avoided auto-switching into a profile that's under caution." },
  { m: "learning.archive-fallback", t: "History saved locally", e: "The configured archive wasn't available, so history was saved locally instead." },
  { m: "learning.failure-outcome", t: "Learned from an issue", e: "Recorded how a recent issue turned out, to handle it better next time." },
  { m: "learning.session", t: "Learning sample skipped", e: "Ignored a too-short or odd session so it can't skew what the system learns." },
  { m: "learning.influence", t: "Learning setting changed", e: "Turned the system's learning influence on or off." },
  { m: "learning.error", t: "Minor internal hiccup", e: "A learning step hit an error and was recorded. No harm done." },
  { m: "learning", t: "Learning update", e: "Updated what the system has learned about how you use the PC." },
  { m: "self-treatment.applied", t: "Self-treatment applied", e: "The control plane used a safe built-in repair for a recurring internal hiccup." },
  { m: "self-treatment.verified", t: "Self-treatment checked", e: "Checked whether a built-in repair stopped the internal issue from coming back." },
  { m: "self-treatment", t: "Self-treatment note", e: "The control plane reviewed one of its own safe repair steps." },
  { m: "memory.attribution", t: "Found the memory cause", e: "Pinpointed which program is using the memory — and skipped a cleanup that couldn't have helped because that memory is held by the program itself." },
  { m: "memory.release.backoff", t: "Paused a useless cleanup", e: "Memory cleanup wasn't helping (a program was holding the memory), so it backed off and suggested restarting that program." },
  { m: "memory.release.auto", t: "Freed up memory", e: "Automatically trimmed idle memory for more headroom. No app was closed." },
  { m: "memory.release", t: "Freed up memory", e: "Trimmed idle memory so the PC has more headroom. No app was closed." },
  { m: "cpu.relief.auto", t: "Eased the CPU", e: "Briefly lowered peak CPU speed to cool down, then restored it. Nothing was stopped." },
  { m: "cpu.relief", t: "Eased the CPU", e: "Briefly capped peak CPU speed to ease heat, then restored it." },
  { m: "network.diagnose.auto", t: "Network diagnosis", e: "Automatically refreshed DNS, reachability, latency, loss, VPN, adapter, and bandwidth checks. Nothing was reset." },
  { m: "network.diagnose", t: "Network diagnosis", e: "Checked DNS, reachability, latency, loss, VPN, adapter, and bandwidth-heavy apps. Nothing was reset." },
  { m: "gpu.relief.auto", t: "GPU relief requested", e: "Automatically requested a short in-mode power-band ease for GPU or VRAM pressure. No GPU clocks, fans, drivers, firmware, or voltage settings were changed." },
  { m: "gpu.relief", t: "GPU relief requested", e: "Requested a short in-mode power-band ease for GPU or VRAM pressure. No GPU clocks, fans, drivers, firmware, or voltage settings were changed." },
  { m: "autonomy", t: "Automation setting changed", e: "Adjusted how much the system manages on its own." },
  { m: "automations", t: "Automation setting changed", e: "Adjusted an automation toggle." },
  { m: "session.prep", t: "Session prepared", e: "Prepared the PC for a gaming/competitive session." },
  { m: "session.restore", t: "Settings restored", e: "Restored your PC's settings to a safe baseline." },
  { m: "panic", t: "Settings restored", e: "Rolled the PC back to a safe baseline." },
  { m: "restore", t: "Settings restored", e: "Restored settings to a safe baseline." },
  { m: "health-session", t: "Gaming session tracked", e: "Recorded the start or end of a gaming session." },
  { m: "context.session-start", t: "Started tracking", e: "Started tracking your current activity so it can learn from it." },
  { m: "context.session-end", t: "Finished tracking", e: "Finished a tracked session and learned from how it went." },
  { m: "context.session-error", t: "Minor internal hiccup", e: "Tracking a session hit an error and was recorded. No harm done." },
  { m: "frames.captured", t: "Measured smoothness", e: "Took a quick frame-rate sample during a game." },
  { m: "offender", t: "Reviewed background apps", e: "Looked at heavy background apps (advisory only — nothing was closed)." },
  { m: "elevated", t: "Action previewed", e: "Previewed an action that needs admin rights. Nothing was changed." },
  { m: "single-instance-lock", t: "Duplicate start blocked", e: "Stopped a second copy of the app from starting." },
  { m: "server.shutdown", t: "Service stopped", e: "The control-plane service stopped (for example, to reload after an update)." },
  { m: "server", t: "Service event", e: "A control-plane service event." },
  { m: "crash", t: "Crash recorded", e: "Recorded a Windows crash for review. Evidence was preserved; nothing was changed." },
  { m: "network", t: "Network check", e: "Checked network health." },
  { m: "power", t: "Power setting", e: "Reviewed or adjusted a Windows power setting." }
];

function auditFriendly(entry) {
  const action = String(entry.action || "");
  if (action.includes("failure.remediation") && remediationHasProfile(entry.details?.remediation || {}, "nvidia-driver-reset")) {
    return {
      title: "GPU driver reset/watchdog issue",
      explain: "Windows reported the graphics driver reset or watchdog fired; the app kept the last known failure signature visible and used safe containment only."
    };
  }
  for (const f of AUDIT_FRIENDLY) {
    if (action.includes(f.m)) {
      return { title: f.t, explain: f.e };
    }
  }
  if (action.endsWith(".error") || entry.details?.selfHealth) {
    return { title: "Minor internal hiccup", explain: "An internal step hit an error and was recorded. No harm done." };
  }
  const title = action
    ? action.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "System activity";
  return { title, explain: "Routine system activity." };
}

function auditTitle(entry) {
  return auditFriendly(entry).title;
}

function auditMessage(entry) {
  return auditFriendly(entry).explain;
}

function rawAuditMessage(entry) {
  return String(entry.message || "")
    .replace(/preventive standby/g, "verification standby")
    .replace(/detect -> prevent -> remediate -> verify -> learn/g, "detect -> remediate -> verify -> learn -> prevent");
}

function auditFriendlyMode(modeId) {
  const mode = state.status?.modes?.find((item) => item.id === modeId);
  return mode?.label || modeMeta[modeId]?.subtitle || modeId || null;
}

function cleanAuditText(value, limit = 150) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value)
    .replace(/["{}[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return null;
  }
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function auditPercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.floor(n)}%` : null;
}

function auditTopProcessNames(details = {}) {
  const warningTop = details.warning?.telemetry?.topCpuProcesses;
  const top = Array.isArray(details.topCpuProcesses)
    ? details.topCpuProcesses
    : Array.isArray(warningTop)
      ? warningTop
      : [];
  return top
    .slice(0, 3)
    .map((process) => {
      const cpu = auditPercent(process?.cpuPct);
      return cleanAuditText(`${process?.name || "process"}${cpu ? ` ${cpu}` : ""}`, 45);
    })
    .filter(Boolean)
    .join(", ");
}

function guardNames(guards = []) {
  return guards
    .slice(0, 4)
    .map((guard) => cleanAuditText(guard.label || guard.title || guard.id || "guard", 42))
    .filter(Boolean)
    .join(", ");
}

function routeNames(routes = []) {
  return routes
    .slice(0, 4)
    .map((route) => cleanAuditText(route.label || route.profileId || route.id || "issue", 42))
    .filter(Boolean)
    .join(", ");
}

function auditDetailItems(entry) {
  const details = entry.details || {};
  const friendly = auditFriendly(entry);
  const action = String(entry.action || "");
  const items = [];
  const add = (label, value) => {
    const cleaned = cleanAuditText(value, 170);
    if (cleaned) {
      items.push({ label, value: cleaned });
    }
  };

  add("When", entry.ts ? new Date(entry.ts).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) : null);
  add("What happened", friendly.title);
  add("Why", friendly.explain);

  if (details.coalesced) {
    add("Current status", `${details.samples || "Several"} similar checks were summarized so the trail stays readable.`);
  }
  if (details.uiCoalesced) {
    const first = details.uiFirstTs ? new Date(details.uiFirstTs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
    const last = details.uiLastTs ? new Date(details.uiLastTs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
    add("Visible summary", `${details.uiRepeatCount} consecutive matching entries${first && last ? ` from ${first} to ${last}` : ""}. Export Log keeps every raw entry.`);
  }

  if (action.includes("diagnostics.traps.warning") || action.includes("failure.remediation.relief-gate")) {
    const cpu = auditPercent(details.cpuLoadPct ?? details.warning?.telemetry?.system?.cpuLoadPct);
    const ram = auditPercent(details.ramUsedPct ?? details.warning?.telemetry?.system?.ramUsedPct);
    const top = auditTopProcessNames(details);
    add("Current status", [cpu ? `CPU ${cpu}` : null, ram ? `RAM ${ram}` : null].filter(Boolean).join(" / "));
    add("Top activity", top);
    add("What the app did", action.includes("relief-gate")
      ? "Checked whether RAM or CPU relief should run and held off because the gates said it was not useful yet."
      : "Kept diagnostic capture armed and recorded the pressure pattern.");
    add("Next step", "If this persists, the app will keep using relief, power-level changes, or failure handling within its safety rules.");
  } else if (action.includes("observer.inactivity-enter")) {
    add("Current status", details.idleMinutes != null ? `Idle for ${Math.floor(Number(details.idleMinutes))} minutes` : "Extended inactivity");
    add("What the app did", `${auditFriendlyMode(details.from)} -> ${auditFriendlyMode(details.to)}`);
    add("Next step", details.returnMode ? `Remember ${auditFriendlyMode(details.returnMode)} and restore it when input resumes.` : "Restore the prior mode when input resumes.");
  } else if (action.includes("observer.inactivity-restore") || action.includes("observer.inactivity-overdrive-block")) {
    add("Current status", details.overdriveBlocked ? "Overdrive remains manual" : "Input resumed");
    add("What the app did", `${auditFriendlyMode(details.from)} -> ${auditFriendlyMode(details.to || details.restoreTarget)}`);
    add("Next step", details.overdriveBlocked ? "Select Overdrive manually if you still want it." : "Continue normal autonomous mode selection.");
  } else if (action.includes("failure.proactive-prevention")) {
    const guards = details.proactive?.activeGuards || [];
    add("Current status", guards.length ? `${guards.length} guard${guards.length === 1 ? "" : "s"} watching` : "No active guard");
    add("What the app did", guardNames(guards) || "Kept known-issue hygiene on standby.");
    add("Next step", "It will only escalate if a watched issue becomes active.");
  } else if (action.includes("failure.remediation")) {
    const remediation = details.remediation || {};
    if (remediationHasProfile(remediation, "nvidia-driver-reset")) {
      add("Current status", "GPU driver reset/watchdog issue visible");
      add("What the app did", "Kept the last known failure signature visible and used safe containment only.");
      add("Next step", "Watch for repeats; detailed evidence stays in the export path.");
    } else {
      add("Current status", remediation.status || `${remediation.liveCount || 0} live / ${remediation.standbyCount || 0} standby`);
      add("What the app did", routeNames(remediation.routes || []) || remediation.summary || "Routed the issue through safe remediation.");
      add("Next step", "Verify the result, learn from it, then prevent the same issue from recurring.");
    }
  } else if (action.includes("observer.auto-apply") || action.includes("mode.apply")) {
    add("What the app did", [auditFriendlyMode(details.from), auditFriendlyMode(details.to)].filter(Boolean).join(" -> "));
    add("Current status", details.health || details.reason);
    add("Next step", "Keep monitoring and adjust again only if the signal stays stable or safety requires it.");
  } else if (action.includes("selfheal.power-plan") || action.includes("observer.band-first")) {
    add("What the app did", details.resolvedPlan || details.plan || details.actual || details.expected || details.reason);
    add("Current status", details.guard || details.reason);
    add("Next step", "Use the in-mode power level first before changing full modes.");
  } else if (action.includes("observer.mode-stability-hold")) {
    add("Current status", `${details.confirmations || 0}/${details.minConfirmations || 2} confirmations`);
    add("What the app did", `${auditFriendlyMode(details.currentMode)} -> ${auditFriendlyMode(details.pendingTarget)}`);
    add("Next step", "Switch only if the same target remains steady long enough.");
  } else if (action.includes("network.diagnose")) {
    add("Current status", [
      details.networkState ? `Network ${details.networkState}` : null,
      details.latencyMs != null ? `${details.latencyMs} ms` : null,
      details.packetLossPct != null ? `${details.packetLossPct}% loss` : null
    ].filter(Boolean).join(" / "));
    add("What the app did", (details.issues || [])[0] || "Refreshed network checks without resetting adapters.");
    add("Next step", (details.actions || [])[0]?.label || "Keep watching unless the same issue persists.");
  } else if (action.includes("gpu.relief")) {
    add("Current status", [
      details.pressurePct != null ? `GPU pressure ${Math.floor(Number(details.pressurePct))}` : null,
      details.signals?.gpuTempC != null ? `GPU ${details.signals.gpuTempC} C` : null,
      details.signals?.vramTempC != null ? `VRAM ${details.signals.vramTempC} C` : null
    ].filter(Boolean).join(" / "));
    add("What the app did", details.targetBefore?.plan && details.targetAfter?.plan
      ? `${details.targetBefore.plan} -> ${details.targetAfter.plan}`
      : "Requested a short power-band ease inside the current mode.");
    add("Next step", "Learn whether GPU/VRAM pressure eased, then back off if it stops helping.");
  } else if (action.includes("memory.release") || action.includes("cpu.relief")) {
    add("What the app did", rawAuditMessage(entry));
    add("Current status", details.easedPct !== undefined ? `CPU eased by ${details.easedPct} pts` : details.freedMB !== undefined ? `RAM freed ${details.freedMB} MB` : null);
    add("Next step", "Learn whether the action helped, then back off if it stops being useful.");
  } else if (action.includes("observer.tick")) {
    add("Current status", `${details.health?.state || "Health checked"} / ${details.priority?.label || "activity checked"}`);
    add("What the app did", details.suggestedMode ? `Suggested ${auditFriendlyMode(details.suggestedMode)}` : "Sampled current telemetry.");
    add("Next step", "No action unless the same signal persists or safety requires it.");
  } else {
    add("Current status", entry.level === "warn" ? "Needs attention" : "Recorded");
    add("Next step", "Export Log keeps the full technical detail if needed.");
  }

  return items.slice(0, 7);
}

function isRoutineAudit(entry) {
  const action = String(entry.action || "");
  return entry.level === "observe" && (
    action === "observer.tick" ||
    action === "context.session-start" ||
    action === "context.session-end"
  );
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function auditFilterMatch(entry, filterMode) {
  if (filterMode === "Important") {
    return !isRoutineAudit(entry);
  }
  if (filterMode === "Warnings") {
    return entry.level === "warn";
  }
  if (filterMode === "Actions") {
    return entry.level !== "warn" && !String(entry.action || "").includes("observer");
  }
  return true;
}

const AUDIT_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "autonomy", label: "Autonomy" },
  { id: "thermal", label: "Thermal" },
  { id: "relief", label: "Relief" },
  { id: "failure", label: "Failure" },
  { id: "mode", label: "Mode" }
];

function auditCategory(action = "") {
  const a = String(action);
  if (/^ml\.|^learning|^efficacy|optimizer/.test(a)) return "autonomy";
  if (/^thermal\./.test(a)) return "thermal";
  if (/^memory\.|^cpu\.relief|relief/.test(a)) return "relief";
  if (/^failure|^restore|^diagnostics/.test(a)) return "failure";
  if (/^mode\.|observer\.(auto-apply|auto-hold|band-first|gaming-hold)/.test(a)) return "mode";
  return "other";
}

function renderAuditChips() {
  const root = $("auditCategoryChips");
  if (!root) return;
  const active = state.auditCategory || "all";
  root.innerHTML = AUDIT_CATEGORIES
    .map((c) => `<button type="button" class="audit-chip${c.id === active ? " active" : ""}" data-cat="${c.id}" aria-pressed="${c.id === active}">${c.label}</button>`)
    .join("");
  root.querySelectorAll(".audit-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.auditCategory = btn.dataset.cat || "all";
      renderAuditChips();
      renderAudit();
    });
  });
}

function visibleAuditEntries() {
  const filterMode = $("auditFilter").value || "All";
  const category = state.auditCategory || "all";
  const clearedBefore = Number(localStorage.getItem("auditClearedBefore") || 0);
  return (state.status?.audit || []).filter((entry) => {
    const ts = Date.parse(entry.ts || "") || 0;
    if (clearedBefore && ts && ts <= clearedBefore) {
      return false;
    }
    if (category !== "all" && auditCategory(entry.action) !== category) {
      return false;
    }
    return auditFilterMatch(entry, filterMode);
  });
}

function renderAudit() {
  const entries = visibleAuditEntries();
  state.auditEntries = entries;
  const groups = groupAudit(entries);
  const root = $("auditGroups");
  const retention = $("auditRetentionNote");
  const archive = state.status?.v2?.auditArchive || {};
  const windowDays = archive.retentionDays || 6;
  const archiveLabel = archive.ok === false
    ? `Archive paused: ${archive.reason || "G-drive archive unavailable."}`
    : `Older records archive to ${archive.archiveRoot || "the configured local archive"}.`;
  if (retention) {
    retention.textContent = `Showing ${entries.length} audit entr${entries.length === 1 ? "y" : "ies"} from the last ${windowDays} days. ${archiveLabel}`;
  }
  const indexed = new Map();
  entries.forEach((entry, index) => indexed.set(entry, index));
  if (!state.auditGroupsInitialized) {
    const firstGroup = Array.from(groups.keys())[0];
    if (firstGroup) {
      state.auditOpenGroups.add(firstGroup);
    }
    state.auditGroupsInitialized = true;
  }
  const groupHtml = Array.from(groups.entries())
    .filter(([, groupEntries]) => groupEntries.length > 0)
    .map(([label, groupEntries]) => {
      const isOpen = state.auditOpenGroups.has(label);
      const displayRuns = isOpen ? coalesceAuditRuns(groupEntries, indexed) : [];
      const visibleRuns = displayRuns.slice(0, AUDIT_VISIBLE_PER_DAY);
      const visibleRawCount = visibleRuns.reduce((sum, run) => sum + run.count, 0);
      const hiddenCount = Math.max(0, groupEntries.length - visibleRawCount);
      const rows = visibleRuns.map((run) => {
        const entry = auditDisplayEntry(run);
        const [symbol, cls] = auditIcon(entry);
        const index = run.index;
        const expanded = state.expandedAudit === index;
        const detailItems = auditDetailItems(entry);
        const details = expanded
          ? `<div class="audit-details"><dl>${detailItems.map((item) => `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}</dl></div>`
          : "";
        return `
          <div class="audit-row ${expanded ? "expanded" : ""}" data-audit-index="${index}">
            <span class="audit-icon ${cls}">${symbol}</span>
            <span><strong>${auditTitle(entry)}${run.count > 1 ? ` <em class="audit-repeat">x${run.count}</em>` : ""}</strong><small>${escapeHtml(auditDisplayMessage(entry, run))}</small>${details}</span>
            <span class="chevron">${expanded ? "⌃" : "⌄"}</span>
          </div>
        `;
      });
      const hiddenSummary = isOpen && hiddenCount
        ? `
          <div class="audit-group-summary">
            Showing ${visibleRuns.length} summarized row${visibleRuns.length === 1 ? "" : "s"} covering ${visibleRawCount} of ${groupEntries.length} entries. ${hiddenCount} older entr${hiddenCount === 1 ? "y is" : "ies are"} available in Export Log.
          </div>
        `
        : "";
      return `
        <div class="audit-group ${isOpen ? "open" : "collapsed"}">
          <h3 class="audit-group-title">
            <button type="button" class="audit-group-button" data-audit-group="${escapeHtml(label)}" aria-expanded="${isOpen}">
              <span>${escapeHtml(label)}</span>
              <small>${groupEntries.length} entr${groupEntries.length === 1 ? "y" : "ies"}</small>
              <i>${isOpen ? "⌃" : "⌄"}</i>
            </button>
          </h3>
          ${rows.join("")}
          ${hiddenSummary}
        </div>
      `;
    })
    .join("");
  root.innerHTML =
    groupHtml ||
    '<div class="audit-group"><h3 class="audit-group-title">Audit Trail</h3><div class="audit-row"><span class="audit-icon info">i</span><span><strong>Nothing to show</strong><small>No important entries match this six-day view; Export Log keeps the readable audit report.</small></span><span class="chevron">⌄</span></div></div>';
}

function statusGlyph(ok, blocked = false) {
  if (blocked) return '<span class="status-dot blocked">!</span>';
  if (ok) return '<span class="status-dot">✓</span>';
  return '<span class="status-dot warn">!</span>';
}

function renderDryRunDiff() {
  const plan = state.dryRunPlan;
  const root = $("dryRunDiff");
  if (!plan) {
    root.innerHTML = `
      <div class="diff-row">
        <span class="status-dot info">i</span>
        <span class="diff-main"><strong>No active plan</strong><small>Plan previews appear here when generated.</small></span>
        <span class="diff-value">Ready</span>
      </div>
    `;
    return;
  }
  const diffRows = (plan.diffs || []).slice(0, 5).map((diff) => `
    <div class="diff-row">
      ${statusGlyph(diff.matches)}
      <span class="diff-main"><strong>${diff.field}</strong><small>${diff.current ?? "--"} -> ${diff.desired ?? "--"}</small></span>
      <span class="diff-value">${diff.matches ? "OK" : "Change"}</span>
    </div>
  `);
  const actionRows = (plan.plannedActions || []).slice(0, 4).map((action) => `
    <div class="diff-row">
      ${statusGlyph(action.status === "planned" || action.status === "completed", action.status === "blocked" || action.status === "refused")}
      <span class="diff-main"><strong>${action.label}</strong><small>${action.adapterId} | ${action.trustLevel}</small></span>
      <span class="diff-value">${action.status}</span>
    </div>
  `);
  root.innerHTML = `
    <div class="diff-row">
      ${statusGlyph(plan.ok, !plan.ok)}
      <span class="diff-main"><strong>${plan.targetMode?.label || "Plan"}</strong><small>${plan.correlationId}</small></span>
      <span class="diff-value">${plan.risk}</span>
    </div>
    ${diffRows.join("")}
    ${actionRows.join("")}
  `;
}

function renderFlightRecorder() {
  const v2 = state.status?.v2 || {};
  const ledger = v2.ledger || [];
  const mlDecisionLedger = v2.mlDecisionLedger || {};
  const mlExecutionGate = v2.mlExecutionGate || {};
  const mlOptimizer = v2.mlOptimizer || {};
  const recovery = v2.recovery || {};
  const snapshots = v2.snapshots || [];
  const rows = [
    ["Ledger Events", `${ledger.length}`, ledger[0]?.checksumValid === false ? false : true],
    ["ML Decisions", `${mlDecisionLedger.verifiedCount || 0} verified / ${mlDecisionLedger.pendingCount || 0} pending`, true],
    ["ML Gate", mlExecutionGate.eligible ? `Ready: ${mlExecutionGate.handler}` : "Waiting", mlExecutionGate.blockedBy?.length ? false : true],
    ["ML Optimizer", `${mlOptimizer.coverage?.hypothesisCount || 0} hypotheses / ${mlOptimizer.coverage?.executableCount || 0} ready`, true],
    ["Snapshots", `${snapshots.length}`, true],
    ["Recovery", recovery.safeRestoreOffered ? "Action Needed" : "Clean", !recovery.safeRestoreOffered],
    ["Stress Report", state.stressReport ? `${state.stressReport.health?.state} / ${state.stressReport.priority?.label}` : "Not run", true],
    ["Last Event", ledger[0]?.action || "None", ledger[0]?.status !== "failed"]
  ];
  $("flightRecorder").innerHTML = rows
    .map(([label, value, ok]) => `
      <div class="compact-row">
        ${statusGlyph(ok)}
        <span class="compact-main"><strong>${label}</strong><small>${value}</small></span>
        <span class="compact-value">${ok ? "OK" : "Check"}</span>
      </div>
    `)
    .join("");
}

function renderAdapterHealth() {
  const adapters = state.status?.v2?.adapters;
  if (!adapters) {
    $("adapterHealth").innerHTML = "";
    return;
  }
  const rows = [
    ["Manifest Validation", adapters.ok ? "All contracts valid" : `${adapters.errors.length} error(s)`, adapters.ok],
    ["Power Plan", "Rollback declared", true],
    [performanceSessionLabel(), "Session-scoped", true],
    ["Elevated Scripts", "Manual-only", true]
  ];
  $("adapterHealth").innerHTML = rows
    .map(([label, value, ok]) => `
      <div class="compact-row">
        ${statusGlyph(ok)}
        <span class="compact-main"><strong>${label}</strong><small>${value}</small></span>
        <span class="compact-value">${ok ? "OK" : "Fix"}</span>
      </div>
    `)
    .join("");
}

function renderSessionHistory() {
  const healthSessions = state.status?.v2?.healthSessions || state.status?.v2?.priorityAppSessions || [];
  const contextSessions = state.status?.v2?.contextSessions || [];
  const seen = new Set();
  const sessions = [...healthSessions, ...contextSessions]
    .filter((session) => {
      const key = session.id || `${session.startedAt}:${session.label || session.profile || "session"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  if (!sessions.length) {
    $("sessionHistory").innerHTML = `
      <div class="compact-row">
        <span class="status-dot info">i</span>
        <span class="compact-main"><strong>No sessions yet</strong><small>History will populate after context or workload start/end detection.</small></span>
        <span class="compact-value">Idle</span>
      </div>
    `;
    return;
  }
  $("sessionHistory").innerHTML = sessions.slice(0, 4).map((session) => `
    <div class="compact-row">
      ${statusGlyph(session.status !== "needs-review")}
      <span class="compact-main"><strong>${escapeHtml(sessionDisplayLabel(session))}</strong><small>${new Date(session.startedAt).toLocaleString()} | ${escapeHtml(session.status || "active")} | ${escapeHtml(sessionThermalLabel(session))}</small></span>
      <span class="compact-value">${session.outcomeScore ?? "--"}</span>
    </div>
  `).join("");
}

function renderDriftPanel() {
  const drift = state.status?.v2?.convergence?.drift || state.status?.v2?.drift || [];
  if (!drift.length) {
    $("driftPanel").innerHTML = `
      <div class="compact-row">
        ${statusGlyph(true)}
        <span class="compact-main"><strong>No drift detected</strong><small>Windows state matches active mode expectations.</small></span>
        <span class="compact-value">Clean</span>
      </div>
    `;
    return;
  }
  $("driftPanel").innerHTML = drift.slice(0, 4).map((item) => `
    <div class="compact-row">
      ${statusGlyph(item.state === "info")}
      <span class="compact-main"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.actual)} != ${escapeHtml(item.expected)}</small></span>
      <span class="compact-value">${item.state === "info" ? "Info" : "Drift"}</span>
    </div>
  `).join("");
}

function renderV2Panels() {
  renderDryRunDiff();
  renderFlightRecorder();
  renderAdapterHealth();
  renderSessionHistory();
  renderDriftPanel();
}

function essentialRow({ ok = true, label, sub, value = "OK", blocked = false }) {
  return `
    <div class="essential-row">
      ${statusGlyph(ok, blocked)}
      <span class="essential-main"><strong>${label}</strong><small>${sub}</small></span>
      <span class="essential-value">${value}</span>
    </div>
  `;
}

function renderEssentialBoxes() {
  const status = state.status;
  const mode = status.policy?.mode || {};
  const priority = status.policy?.priority || {};
  const health = status.policy?.health || {};
  const telemetry = status.telemetry || {};
  const gpu = telemetry.gpu || {};
  const eventAnalysis = status.policy?.eventAnalysis || {};
  const offenders = status.policy?.offenders || [];
  const drift = status.v2?.drift || [];
  const warningDrift = drift.filter((item) => item.state !== "info");
  const recovery = status.v2?.recovery || {};
  const adapters = status.v2?.adapters || {};
  const readiness = status.v2?.readiness || {};
  const thermal = status.policy?.thermalState || {};
  const ledger = status.v2?.ledger || [];
  const workloadCount = state.workloadDiscovery?.candidates?.length ?? null;
  const activePower = extractPowerName(telemetry.power?.activeLine);

  $("essentialFocus").innerHTML = [
    essentialRow({
      label: "Active Mode",
      sub: mode.label || "Unknown",
      value: mode.shortLabel || mode.id || "--"
    }),
    essentialRow({
      label: "Priority",
      sub: priority.label === "Agentic Work" ? "Codex, Claude, Docker, Node, or Python activity detected." : priority.reason || "No dominant workload detected.",
      value: priority.label || "--"
    }),
    essentialRow({
      label: "Power Plan",
      sub: activePower || "Unavailable",
      value: powerShort(activePower)
    })
  ].join("");

  $("essentialAttention").innerHTML = [
    essentialRow({
      ok: health.state !== "Strained",
      label: "System Health",
      sub: health.reasons?.[0] || "No immediate issue detected.",
      value: health.state || "--",
      blocked: health.state === "Strained"
    }),
    essentialRow({
      ok: !["hot", "critical"].includes(thermal.severity),
      label: "Thermal Hierarchy",
      sub: thermal.summary || "No thermal hierarchy reading.",
      value: thermal.recommendedAction || "--",
      blocked: thermal.severity === "critical"
    }),
    essentialRow({
      ok: (eventAnalysis.crashSignals || []).length === 0,
      label: "Crash Signals",
      sub: "Recent bugcheck, Kernel-Power, or WER records.",
      value: String((eventAnalysis.crashSignals || []).length)
    }),
    essentialRow({
      ok: offenders.length === 0,
      label: "Background Offenders",
      sub: offenders[0] ? displayProcessName(offenders[0].name) : "No unchecked offenders.",
      value: String(offenders.length)
    })
  ].join("");

  const tuning = status.competitiveTuning || {};
  const trial = tuning.trial || null;
  const titleThermal = tuning.titleThermal || null;
  const latchesOn = Boolean(tuning.engaged);
  const activeLatches = [
    tuning.gpuClockLocked ? "GPU clock" : null,
    tuning.timerLatch ? "0.5ms timer" : null,
    tuning.nicDeModerated ? "NIC de-mod" : null,
    tuning.focusWatcher ? "focus watcher" : null,
    tuning.quietHours ? "quiet hours" : null
  ].filter(Boolean);
  const trialTierLabel = trial ? (trial.tier === 4 ? "05 Ultra" : "04 High") : "--";
  const thermalLabel = titleThermal
    ? (titleThermal.state === "warm-title" ? "Warm title" : titleThermal.state === "neutral" ? "Neutral" : "Unknown")
    : "--";

  $("essentialWorkload").innerHTML = [
    essentialRow({
      ok: workloadCount === null || workloadCount > 0,
      label: "Workload Candidates",
      sub: workloadCount === null ? "Waiting for scan." : `${workloadCount} candidate(s) found.`,
      value: workloadCount === null ? "--" : String(workloadCount)
    }),
    essentialRow({
      ok: true,
      label: "Session Latches",
      sub: latchesOn ? `Active: ${activeLatches.join(", ") || "engaged"}.` : "No active competitive session.",
      value: latchesOn ? "Engaged" : "Idle"
    }),
    essentialRow({
      ok: true,
      label: "Power Tier Trial",
      sub: trial ? trial.reason : "Runs silently once a title has a confirmed Competitive session.",
      value: trial ? `${trialTierLabel}${trial.active ? " (trialling)" : ""}` : "--"
    }),
    essentialRow({
      ok: !titleThermal || titleThermal.state !== "warm-title",
      label: "Thermal Fingerprint",
      sub: titleThermal?.reason || "Needs 3+ sessions on a title before it reads.",
      value: thermalLabel
    })
  ].join("");

  $("essentialSafety").innerHTML = [
    essentialRow({
      ok: readiness.ok !== false,
      label: "System Readiness",
      sub: readiness.summary || "Readiness status pending.",
      value: readiness.state || "--",
      blocked: readiness.state === "blocked"
    }),
    essentialRow({
      ok: !recovery.safeRestoreOffered,
      label: "Recovery",
      sub: recovery.message || "No incomplete action chains detected.",
      value: recovery.safeRestoreOffered ? "Check" : "Clean"
    }),
    essentialRow({
      ok: adapters.ok !== false,
      label: "Adapter Contracts",
      sub: adapters.ok === false ? `${adapters.errors?.length || 0} contract issue(s).` : "Rollback manifests valid.",
      value: adapters.ok === false ? "Fix" : "OK"
    }),
    essentialRow({
      ok: warningDrift.length === 0,
      label: "Settings Drift",
      sub: drift[0]?.label || "No outside changes detected.",
      value: String(drift.length)
    })
  ].join("");
}

function renderWhy() {
  const explain = state.status?.explain;
  const headline = $("whyHeadline");
  const summary = $("whySummary");
  const holdsRoot = $("whyHolds");
  const triggersRoot = $("whyTriggers");
  if (!headline || !summary || !holdsRoot || !triggersRoot) return;

  if (!explain) {
    headline.textContent = "--";
    summary.textContent = "Waiting for the first decision.";
    holdsRoot.innerHTML = "";
    triggersRoot.innerHTML = "";
    return;
  }

  headline.textContent = explain.headline || "--";
  summary.textContent = explain.summary || "";

  const holds = Array.isArray(explain.holds) ? explain.holds : [];
  holdsRoot.innerHTML = holds.length
    ? holds
        .map(
          (hold) => `
        <div class="why-row ${hold.severity === "warn" ? "warn" : ""}">
          <span class="why-dot"></span>
          <span><strong>${escapeHtml(hold.label)}</strong><small>${escapeHtml(hold.detail)}</small></span>
          <span class="why-clears">${escapeHtml(hold.clearsBy || "")}</span>
        </div>`
        )
        .join("")
    : '<div class="why-row"><span class="why-dot ok"></span><span><strong>Nothing holding it</strong><small>Free to follow the evidence.</small></span></div>';

  const triggers = Array.isArray(explain.triggers) ? explain.triggers : [];
  const arrow = { up: "▲", down: "▼", mode: "⇄" };
  triggersRoot.innerHTML = triggers
    .map(
      (trigger) => `
      <div class="why-row">
        <span class="why-arrow ${trigger.direction}">${arrow[trigger.direction] || "•"}</span>
        <span><strong>${escapeHtml(trigger.what)}</strong><small>${escapeHtml(trigger.effect)}</small></span>
        <span class="why-clears">${escapeHtml(trigger.current || "")}</span>
      </div>`
    )
    .join("");

  const countdown = $("overdriveCountdown");
  if (countdown) {
    const hold = holds.find((entry) => entry.id === "overdrive-hold");
    if (hold) {
      const match = /(\d+)m\s*(\d+)s/.exec(hold.detail || "");
      countdown.textContent = match ? `Overdrive held ${match[1]}m ${match[2]}s` : "Overdrive held";
      countdown.hidden = false;
    } else {
      countdown.hidden = true;
    }
  }
}

async function renderSimulation() {
  const root = $("whySimulation");
  if (!root) return;
  if (!root.hidden) {
    root.hidden = true;
    return;
  }
  root.innerHTML = '<div class="why-row"><span class="why-dot"></span><span><strong>Simulating…</strong></span></div>';
  root.hidden = false;
  try {
    const result = await api("/api/simulate");
    const rows = (result.scenarios || [])
      .map(
        (entry) => `
        <div class="why-row sim">
          <span class="why-arrow mode">⇢</span>
          <span><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.mode.label)} · ${escapeHtml(entry.band.plan || "--")}</small></span>
        </div>`
      )
      .join("");
    root.innerHTML = `<div class="why-sim-note">${escapeHtml(result.note || "")}</div>${rows}`;
  } catch (error) {
    root.innerHTML = `<div class="why-row warn"><span class="why-dot"></span><span><strong>Simulation failed</strong><small>${escapeHtml(error.message)}</small></span></div>`;
  }
}

function render() {
  if (!state.status) return;
  applyViewMode();
  const visible = new Set(["whyHolds", "autonomySummary", "essentialFocus", "activePolicies", "flightRecorder"].filter(isRendered));
  renderModes();
  renderSummary();
  if (visible.has("whyHolds")) renderWhy();
  if (visible.has("autonomySummary")) renderAutonomyCockpit();
  renderTelemetry();
  if (visible.has("essentialFocus")) renderEssentialBoxes();
  if (visible.has("activePolicies")) renderPolicySurface();
  renderTables();
  renderAudit();
  if (visible.has("flightRecorder")) renderV2Panels();
  applyControlAvailability();
}

function isRendered(id) {
  return Boolean($(id)?.getClientRects().length);
}

function renderConnectionStatus() {
  const sampledAt = Date.parse(state.status?.telemetry?.capturedAt);
  const connection = monitoringState({
    receivedAt: state.lastUpdateAt,
    failed: state.connectionFailed,
    cached: Boolean(state.status && (state.status.telemetry?.stale || !Number.isFinite(sampledAt) || Date.now() - sampledAt > 20000)),
    observerRunning: state.status?.observer?.running,
    superseded
  });
  const service = $("serviceStatus");
  const previousKind = service.dataset.state;
  service.dataset.state = connection.kind;
  setMarkup(service, `<i aria-hidden="true"></i>${connection.label}`);
  const badge = $("telemetryFreshness");
  badge.dataset.state = connection.kind;
  setMarkup(badge, `<i aria-hidden="true"></i>${connection.readings}`);
  const notice = $("connectionNotice");
  notice.hidden = !connection.message;
  if ($("connectionMessage").textContent !== connection.message) $("connectionMessage").textContent = connection.message;
  const retry = $("connectionRetry");
  retry.hidden = !connection.retry;
  retry.disabled = state.refreshing || state.busy || superseded;
  const retryLabel = state.refreshing ? "Checking..." : "Retry connection";
  if (retry.textContent !== retryLabel) retry.textContent = retryLabel;
  const health = state.status?.policy?.health;
  if (health) {
    const current = connection.kind === "live" || connection.kind === "paused";
    const label = current ? health.state : `Last: ${health.state}`;
    if ($("healthText").textContent !== label) $("healthText").textContent = label;
    $("healthText").style.color = current ? healthToneClass(health.tone) : "var(--muted)";
    $("healthIcon").style.color = current ? healthToneClass(health.tone) : "var(--muted)";
  }
  if (state.status && previousKind !== connection.kind) {
    renderNetworkQuality($("networkMeter"), state.status, { monitoringAvailable: connection.kind === "live" || connection.kind === "paused" });
  }
}

function ingestStatus(status) {
  if (!status?.policy?.mode || !status.policy.health || !status.policy.priority || !status.telemetry) {
    throw new Error("Monitoring returned an incomplete update. Last readings were retained.");
  }
  const previousMode = state.status?.state?.modeId;
  const activeMode = status.state?.modeId || "balanced";
  cancelTelemetryAnimation();
  state.status = status;
  state.visualTelemetry = cloneData(status.telemetry || null);
  state.lastUpdateAt = Date.now();
  state.connectionFailed = false;
  if (previousMode && previousMode !== activeMode) {
    state.modeStartedAt = Date.now();
  }
  const knownModeIds = new Set((status.modes || []).map((mode) => mode.id));
  if (!state.modeSelectionDirty || state.selectedModeId === activeMode || !knownModeIds.has(state.selectedModeId)) {
    state.selectedModeId = activeMode;
    state.modeSelectionDirty = false;
  }
  updateHistory(status);
  render();
}

const refresh = createRefreshGate(async (options = {}) => {
  state.refreshing = true;
  renderConnectionStatus();
  try {
    ingestStatus(await api(options.requireFresh ? "/api/status?fresh=1" : "/api/status"));
  } catch (error) {
    state.connectionFailed = true;
    throw error;
  } finally {
    state.refreshing = false;
    renderConnectionStatus();
  }
});

function liveSensorValue(value) {
  return value !== null && value !== undefined && value !== "" ? value : undefined;
}

function cloneData(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function visualStatusFromTelemetry(telemetry) {
  return state.status ? { ...state.status, telemetry: telemetry || state.status.telemetry || {} } : null;
}

function cancelTelemetryAnimation() {
  window.clearTimeout(state.telemetryAnimation?.timer);
  if (state.telemetryAnimation?.frame) {
    window.cancelAnimationFrame(state.telemetryAnimation.frame);
  }
  state.telemetryAnimation = null;
}

function animateTelemetryTo(targetTelemetry) {
  if (!targetTelemetry || typeof window.requestAnimationFrame !== "function") {
    state.visualTelemetry = cloneData(targetTelemetry);
    renderTelemetry();
    return;
  }
  const target = cloneData(targetTelemetry);
  cancelTelemetryAnimation();
  const animation = {
    target,
    timer: null,
    frame: null
  };
  state.telemetryAnimation = animation;
  const step = () => {
    if (state.telemetryAnimation !== animation) {
      return;
    }
    state.visualTelemetry = animation.target;
    renderTelemetry(visualStatusFromTelemetry(state.visualTelemetry));
    state.telemetryAnimation = null;
  };
  animation.timer = window.setTimeout(() => {
    animation.frame = window.requestAnimationFrame(step);
  }, TELEMETRY_STABLE_PAINT_DELAY_MS);
}

function mergeLiveSensorSample(telemetry, sensors) {
  if (!telemetry || !sensors || typeof sensors !== "object") {
    return;
  }
  if (sensors.temperatures && typeof sensors.temperatures === "object") {
    const incoming = {};
    [
      "cpuC", "cpuSource", "systemC", "systemSource",
      "memoryC", "memorySource", "memoryName",
      "gpuMemoryC", "gpuMemorySource",
      "librarySource", "libraryError"
    ].forEach((key) => {
      const value = liveSensorValue(sensors.temperatures[key]);
      if (value !== undefined) incoming[key] = value;
    });
    telemetry.temperatures = { ...(telemetry.temperatures || {}), ...incoming };
  }
  if (sensors.fans && typeof sensors.fans === "object") {
    telemetry.fans = {
      ...(telemetry.fans || {}),
      ...sensors.fans,
      liveSampledAt: sensors.capturedAt || sensors.at || null
    };
  }
}

function ingestFastSample(sample) {
  if (!state.status?.telemetry) {
    return;
  }
  const telemetry = state.status.telemetry;
  telemetry.capturedAt = sample.at || telemetry.capturedAt;
  telemetry.system = telemetry.system || {};
  if (sample.cpuLoadPct !== null && sample.cpuLoadPct !== undefined) {
    telemetry.system.cpuLoadPct = sample.cpuLoadPct;
  }
  if (sample.ramUsedPct !== null && sample.ramUsedPct !== undefined) {
    telemetry.system.ramUsedPct = sample.ramUsedPct;
    telemetry.system.ramFreeGB = sample.ramFreeGB;
    telemetry.system.ramTotalGB = sample.ramTotalGB;
  }
  if (sample.gpu) {
    telemetry.gpu = { ...(telemetry.gpu || {}), ...sample.gpu };
  }
  mergeLiveSensorSample(telemetry, sample.sensors);
  state.lastUpdateAt = Date.now();
  state.connectionFailed = false;
  renderConnectionStatus();
  updateHistory(state.status);
  animateTelemetryTo(telemetry);
  $("captureTime").textContent = `Last Updated: ${new Date(telemetry.capturedAt).toLocaleTimeString()}`;
}

async function discoverWorkloadSilently() {
  if (state.workloadDiscovery) return;
  try {
    state.workloadDiscovery = await api("/api/workload/discover");
    render();
  } catch {
  }
}

async function doAction(label, callback) {
  try {
    setBusy(true);
    const result = await callback();
    showToast(result.message || `${label} complete.`);
    try {
      await refresh({ requireFresh: true });
    } catch {
      showToast(`${result.message || `${label} complete.`} Monitoring could not refresh. Check status before repeating the action.`);
    }
  } catch (error) {
    showToast(`${label} failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function mergeDiagnosticTrapResult(result) {
  if (!state.status || !result?.status) {
    return;
  }
  state.status.v2 = {
    ...(state.status.v2 || {}),
    diagnosticTraps: result.status
  };
  render();
}

function selectedOrSuggestedMode() {
  if (state.modeSelectionDirty && state.selectedModeId) {
    return state.selectedModeId;
  }
  return state.status?.policy?.suggestedMode || state.status?.state?.modeId || "balanced";
}

function executablePlanActions(plan) {
  return (plan?.plannedActions || []).filter((action) => action.mutation && action.status === "planned");
}

function planCanApply(plan) {
  return Boolean(plan?.correlationId && !plan.refusalReasons?.length && executablePlanActions(plan).length > 0);
}

function planMatchesMode(plan, modeId) {
  return Boolean(plan?.targetMode?.id && plan.targetMode.id === modeId);
}

function summarizePlanReadiness(plan) {
  if (plan?.refusalReasons?.length) {
    return `Plan refused: ${plan.refusalReasons[0]?.message || "resolve refusal reasons and re-run dry run."}`;
  }
  const executableCount = executablePlanActions(plan).length;
  if (!executableCount) {
    return "No executable changes; advisory items only.";
  }
  return `Plan ready: ${executableCount} executable change${executableCount === 1 ? "" : "s"}. Apply within 5 minutes.`;
}

function bindActions() {
  $("simulateButton")?.addEventListener("click", () => { renderSimulation(); });
  $("gameMarkNot")?.addEventListener("click", () => { markGame("not-game"); });
  $("gameMarkIs")?.addEventListener("click", () => { markGame("game"); });
  $("applySuggestedModeButton").addEventListener("click", () =>
    doAction("Apply mode", async () => {
      const modeId = selectedOrSuggestedMode();
      const result = await api("/api/mode", {
        method: "POST",
        body: JSON.stringify({ modeId, dryRun: false })
      });
      state.dryRunPlan = null;
      state.selectedModeId = modeId;
      state.modeSelectionDirty = false;
      renderV2Panels();
      return result;
    })
  );
  $("defaultModeButton").addEventListener("click", () =>
    doAction("Default mode", () =>
      api("/api/mode", { method: "POST", body: JSON.stringify({ modeId: "balanced", dryRun: false }) })
        .then((result) => {
          state.dryRunPlan = null;
          state.selectedModeId = "balanced";
          state.modeSelectionDirty = false;
          renderV2Panels();
          return result;
        })
    )
  );
  $("restoreButton").addEventListener("click", () =>
    doAction("Restore all", () => previewOrApplyPanicRestore("Confirm Restore"))
  );
  $("stopActionsButton").addEventListener("click", () =>
    doAction("Stop active actions", async () => {
      if (!hasStoppableActions(state.status)) {
        return Promise.resolve({ ok: true, message: "No active reversible actions to stop." });
      }
      return previewOrApplyPanicRestore("Stop Active Actions again");
    })
  );
  $("releaseRamButton")?.addEventListener("click", () =>
    doAction("Release RAM", () =>
      api("/api/memory/release", { method: "POST", body: JSON.stringify({ dryRun: false }) })
        .then((result) => ({
          ok: result.ok !== false,
          message: result.summary || (result.error ? `RAM release failed: ${result.error}` : "RAM release complete.")
        }))
    )
  );
  $("relieveCpuButton")?.addEventListener("click", () =>
    doAction("Soft CPU relief", () =>
      api("/api/cpu/relieve", { method: "POST", body: JSON.stringify({ dryRun: false }) })
        .then((result) => ({
          ok: result.ok !== false,
          message: result.summary || (result.error ? `CPU relief failed: ${result.error}` : "CPU relief complete.")
        }))
    )
  );
  $("networkDiagnoseButton")?.addEventListener("click", () =>
    doAction("Network diagnose", () =>
      api("/api/network/diagnose", { method: "POST", body: JSON.stringify({ dryRun: false }) })
        .then((result) => ({
          ok: result.ok !== false,
          message: result.message || "Network diagnosis complete."
        }))
    )
  );
  $("relieveGpuButton")?.addEventListener("click", () =>
    doAction("GPU relief", () =>
      api("/api/gpu/relieve", { method: "POST", body: JSON.stringify({ dryRun: false }) })
        .then((result) => ({
          ok: result.ok !== false,
          message: result.message || "GPU relief requested."
        }))
    )
  );
  $("applyPlanButton").addEventListener("click", () =>
    doAction("Apply plan", () => {
      if (!state.dryRunPlan?.correlationId) {
        return Promise.resolve({ ok: false, message: "Create a fresh plan preview before applying a plan." });
      }
      if (!planCanApply(state.dryRunPlan)) {
        return Promise.resolve({ ok: true, message: summarizePlanReadiness(state.dryRunPlan) });
      }
      return api("/api/actions/apply", {
        method: "POST",
        body: JSON.stringify({ correlationId: state.dryRunPlan.correlationId })
      }).then((result) => {
        state.dryRunPlan = null;
        renderV2Panels();
        return result;
      });
    })
  );
  $("stressButton").addEventListener("click", () =>
    doAction("Stress investigation", () =>
      api("/api/diagnostics/stress-investigation", {
        method: "POST",
        body: JSON.stringify({ seconds: 6 })
      }).then((result) => {
        state.stressReport = result;
        showToast(`Stress check: ${result.health?.state || "complete"} / ${result.priority?.label || "unknown"}`);
        return { ok: true, message: "Stress investigation complete." };
      })
    )
  );
  $("exportLogButton").addEventListener("click", () => {
    window.open("/api/audit?days=6&format=readable", "_blank", "noopener");
  });
  $("systemMapButton")?.addEventListener("click", () => {
    openSystemMap();
  });
  $("systemMapClose")?.addEventListener("click", () => {
    closeSystemMap();
  });
  $("systemMapOverlay")?.addEventListener("click", (event) => {
    if (event.target === $("systemMapOverlay")) {
      closeSystemMap();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("systemMapOverlay")?.hidden) {
      closeSystemMap();
    }
  });
  $("clearAuditButton").addEventListener("click", () => {
    localStorage.setItem("auditClearedBefore", String(Date.now()));
    state.expandedAudit = null;
    state.auditOpenGroups = new Set();
    state.auditGroupsInitialized = false;
    renderAudit();
    showToast("Audit view cleared. The on-disk ledger stays intact; new entries will appear as they happen.");
  });
  $("auditFilter").addEventListener("change", () => {
    state.expandedAudit = null;
    state.auditOpenGroups = new Set();
    state.auditGroupsInitialized = false;
    renderAudit();
  });
  $("viewModeToggle")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view-mode]");
    if (!button) return;
    state.viewMode = button.dataset.viewMode === "summary" ? "summary" : "cockpit";
    localStorage.setItem("pcControlPlaneViewMode", state.viewMode);
    applyViewMode();
  });
  renderAuditChips();
  $("auditGroups").addEventListener("click", (event) => {
    const groupButton = event.target.closest("[data-audit-group]");
    if (groupButton) {
      const label = groupButton.getAttribute("data-audit-group");
      if (state.auditOpenGroups.has(label)) {
        state.auditOpenGroups = new Set();
      } else {
        state.auditOpenGroups = new Set([label]);
      }
      state.expandedAudit = null;
      renderAudit();
      return;
    }
    const row = event.target.closest("[data-audit-index]");
    if (!row) {
      return;
    }
    const index = Number(row.getAttribute("data-audit-index"));
    state.expandedAudit = state.expandedAudit === index ? null : index;
    renderAudit();
  });
  $("offenderFooter").addEventListener("click", (event) => {
    if (!event.target.closest("#showAllOffenders")) {
      return;
    }
    state.showAllOffenders = !state.showAllOffenders;
    renderTables();
  });
  $("protectedRows").addEventListener("click", (event) => {
    const control = event.target.closest("[data-learning-decision]");
    if (!control) {
      return;
    }
    const action = control.getAttribute("data-learning-decision");
    const key = control.getAttribute("data-learning-key");
    doAction("Set learned app decision", () =>
      api("/api/learning/apps/decision", {
        method: "POST",
        body: JSON.stringify({ action, key, reason: "cockpit-ui" })
      })
    );
  });
  $("activeActions").addEventListener("click", (event) => {
    const elevatedControl = event.target.closest("[data-elevated-action]");
    if (elevatedControl) {
      const actionId = elevatedControl.getAttribute("data-elevated-action");
      doAction("Preview elevated action", () =>
        api("/api/action/elevated", {
          method: "POST",
          body: JSON.stringify({ actionId, dryRun: true })
        }).then((result) => ({
          ok: true,
          message: result.action?.script
            ? `Manual launcher: ${result.action.script}`
            : result.message
        }))
      );
      return;
    }
    if (!event.target.closest("[data-toggle-actions]")) {
      return;
    }
    state.showAllActions = !state.showAllActions;
    renderPolicySurface();
  });
}

let stream = null;

function openStream() {
  if (superseded || stream || document.hidden || typeof EventSource === "undefined") {
    return;
  }
  stream = new EventSource(`/api/stream?sid=${encodeURIComponent(SESSION_ID)}`);
  stream.addEventListener("status", (event) => {
    try {
      ingestStatus(JSON.parse(event.data));
    } catch {
    }
  });
  stream.addEventListener("fast", (event) => {
    try {
      ingestFastSample(JSON.parse(event.data));
    } catch {
    }
  });
  stream.addEventListener("superseded", () => {
    handleSuperseded("A newer window opened and took control. This window is now inactive.");
  });
  stream.addEventListener("error", () => {
    state.connectionFailed = true;
    renderConnectionStatus();
  });
}

function closeStream() {
  if (stream) {
    stream.close();
    stream = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (superseded) {
    return;
  }
  if (document.hidden) {
    closeStream();
    cancelTelemetryAnimation();
  } else {
    refresh().catch(() => {});
    openStream();
  }
});

bindActions();
$("connectionRetry").addEventListener("click", () => {
  refresh().catch(() => {});
});
$("supersededRefresh")?.addEventListener("click", () => window.location.reload());
refresh()
  .then(() => discoverWorkloadSilently())
  .catch((error) => showToast(error.message));
openStream();

window.setInterval(() => {
  if (document.hidden || superseded) return;
  $("modeSince").textContent = elapsedSince(state.modeStartedAt);
  renderConnectionStatus();
}, 1000);

window.setInterval(() => {
  if (superseded) {
    return;
  }
  const stale = !state.lastUpdateAt || Date.now() - state.lastUpdateAt > 20000;
  if (!document.hidden && !state.busy && stale) {
    refresh().catch(() => {});
  }
}, 10000);
