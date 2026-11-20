import { clockMinutes, isDayAt, localZone, minuteClock, scheduleFor, timelineWarmth, validZone } from "./comfort-model.js";
import { createControlClient } from "./control-client.js";

const $ = (id) => document.getElementById(id);
const day = $("comfort-day"), evening = $("comfort-evening"), strength = $("comfort-strength");
const amplifier = $("comfort-amplifier");
let warmth = strength.valueAsNumber + amplifier.valueAsNumber;
const modes = [...document.querySelectorAll('input[name="appearance"]')];
let state = null, busy = false, uncertain = false, editVersion = 0, dirtySchedule = false;
let pendingStrength = null, strengthDirty = false, dragging = false, settleTimer, minuteTimer;
let refreshGeneration = 0;
const scheduleFields = ["schedule-mode", "zone", "latitude", "longitude", "day-offset", "evening-offset"].map((key) => $("comfort-" + key));
const [scheduleMode, zone, latitude, longitude, dayOffset, eveningOffset] = scheduleFields;
const scrub = $("comfort-scrub");
const autoplay = $("comfort-autoplay");
let scrubbing = false, locating = false;
let timelineSchedule, playbackTimer;
const scheduleDraft = () => ({ scheduleMode: scheduleMode.value, zone: zone.value.trim(),
  latitude: Number.isFinite(latitude.valueAsNumber) ? latitude.valueAsNumber : null,
  longitude: Number.isFinite(longitude.valueAsNumber) ? longitude.valueAsNumber : null,
  dayOffset: dayOffset.valueAsNumber, eveningOffset: eveningOffset.valueAsNumber });

function timeline() {
  if (!state) return;
  const draft = scheduleDraft();
  const saved = state.schedule || scheduleFor(state.settings);
  const valid = validZone(draft.zone) && day.value && evening.value && day.value !== evening.value
    && (draft.scheduleMode === "fixed" || (draft.latitude !== null && draft.longitude !== null && latitude.validity.valid && longitude.validity.valid));
  const s = timelineSchedule = valid ? scheduleFor({ ...draft, day: day.value, evening: evening.value }) : saved;
  const a = clockMinutes(s.day) / 14.4, b = clockMinutes(s.evening) / 14.4;
  const night = "#59677e", light = "#c5a36b";
  scrub.style.setProperty("--timeline", a < b
    ? "linear-gradient(90deg," + night + " " + a + "%," + light + " " + a + "% " + b + "%," + night + " " + b + "%)"
    : "linear-gradient(90deg," + light + " " + b + "%," + night + " " + b + "% " + a + "%," + light + " " + a + "%)");
  $("comfort-solar-times").textContent = !valid ? "Enter a valid schedule to preview it."
    : (s.fallback ? "No sunrise/sunset pair today; using fixed hours. " : "") + "Day " + s.day + " / Evening " + s.evening + " (" + s.zone + ")";
  renderTimelineMinute();
  const nextDay = !isDayAt(saved, saved.minute);
  const nextTime = nextDay ? saved.day : saved.evening;
  const tomorrow = clockMinutes(nextTime) <= saved.minute;
  const nextSchedule = tomorrow ? scheduleFor(state.settings, new Date(Date.now() + (1560 - saved.minute) * 60000)) : saved;
  const next = (nextDay ? "Day" : "Evening") + (tomorrow ? " tomorrow at " : " at ") + (nextDay ? nextSchedule.day : nextSchedule.evening);
  $("comfort-next").textContent = !state.settings.enabled ? "Schedule saved. Turn on to follow it."
    : state.settings.override ? "Paused until you choose Automatic." : next;
}

function renderTimelineMinute() {
  if (!timelineSchedule) return;
  if (!scrubbing) scrub.value = timelineSchedule.minute;
  const minute = scrub.valueAsNumber, clock = minuteClock(minute);
  $("comfort-scrub-label").value = clock;
  scrub.setAttribute("aria-valuetext", clock);
  $("comfort-now").disabled = !scrubbing;
  $("comfort-preview").querySelector("figcaption").textContent = scrubbing
    ? "Schedule preview at " + clock + " (Windows unchanged)" : "Appearance preview";
  if (!scrubbing) return;
  const daytime = isDayAt(timelineSchedule, minute);
  $("comfort-preview").dataset.theme = daytime ? "light" : "dark";
  const value = autoplay.checked ? timelineWarmth(timelineSchedule, minute, warmth) : daytime ? 0 : warmth;
  if (autoplay.checked) renderWarmth(value);
  applyPreviewTint(value);
}

function applyPreviewTint(value) {
  const stops = [[0, 1, 1], [70, .79, .58], [100, .55, .20], [150, .30, .05], [300, .10, .01], [500, 0, 0]];
  const upper = stops.findIndex(([max], index) => index > 0 && value <= max);
  const [low, green, blue] = stops[upper - 1];
  const [high, nextGreen, nextBlue] = stops[upper];
  const fraction = (value - low) / (high - low);
  const tint = $("preview-tint");
  tint.style.backgroundColor = `rgb(255 ${255 * (green + (nextGreen - green) * fraction)} ${255 * (blue + (nextBlue - blue) * fraction)})`;
  tint.style.opacity = value ? "1" : "0";
}

function renderWarmth(value) {
  strength.value = Math.min(100, value);
  amplifier.value = Math.max(0, value - 100);
  $("comfort-strength-label").value = strength.value + "%";
  strength.setAttribute("aria-valuetext", strength.value + "%");
  $("comfort-amplifier-label").value = "+" + amplifier.value + "%";
  $("comfort-amplifier-note").textContent = autoplay.checked ? "Preview warmth: " + value + "%"
    : value >= 100 ? "Total warmth: " + value + "%" : "Available at 100% screen warmth.";
  amplifier.setAttribute("aria-valuetext", "+" + amplifier.value + "%, " + value + "% total");
}

function preview() {
  const selected = modes.find((input) => input.checked)?.value;
  const schedule = state && scheduleFor(state.settings);
  const theme = selected === "resume"
    ? (schedule && !isDayAt(schedule, schedule.minute) ? "dark" : "light")
    : selected;
  $("comfort-preview").dataset.theme = theme || "light";
  if (!autoplay.checked) {
    renderWarmth(warmth);
    applyPreviewTint(theme === "dark" ? warmth : 0);
  }
  timeline();
}

function controls() {
  const blocked = !state || busy || state.busy || uncertain;
  $("comfort-enabled").disabled = blocked;
  modes.forEach((input) => { input.disabled = blocked || !state?.settings.enabled; });
  day.disabled = evening.disabled = !state;
  scheduleFields.forEach((field) => { field.disabled = !state; });
  $("comfort-solar").hidden = scheduleMode.value !== "solar";
  $("comfort-day-label").textContent = scheduleMode.value === "solar" ? "Fallback day starts" : "Day starts";
  $("comfort-evening-label").textContent = scheduleMode.value === "solar" ? "Fallback evening starts" : "Evening starts";
  $("comfort-locate").disabled = !state || locating;
  latitude.required = longitude.required = scheduleMode.value === "solar";
  $("comfort-save").disabled = blocked || !dirtySchedule;
  strength.disabled = !state || uncertain || Boolean(state.busy) || autoplay.checked;
  amplifier.disabled = strength.disabled || warmth < 100;
  autoplay.disabled = !state;
  $("warmth-state").hidden = autoplay.checked;
  $("warmth-preview-state").hidden = !autoplay.checked;
  $("schedule-state").textContent = dirtySchedule ? "Unsaved changes" : "Schedule saved";
}

function render(result) {
  state = result;
  const s = result.settings;
  if (!dirtySchedule) {
    day.value = s.day; evening.value = s.evening;
    scheduleMode.value = s.scheduleMode || "fixed"; zone.value = s.zone || localZone;
    latitude.value = s.latitude ?? ""; longitude.value = s.longitude ?? "";
    dayOffset.value = s.dayOffset ?? 0; eveningOffset.value = s.eveningOffset ?? 0;
  }
  if (!strengthDirty) warmth = s.strength;
  $("comfort-enabled").checked = s.enabled;
  $("comfort-enabled-label").textContent = s.enabled ? "On" : "Off";
  modes.forEach((input) => { input.checked = input.value === (s.override || "resume"); });
  $("comfort-status").textContent = result.status || "Not yet verified";
  $("appearance-note").textContent = s.override
    ? "Manual appearance stays on until you choose Automatic."
    : "Follows your saved schedule.";
  const applied = result.applied;
  $("appearance-applied").textContent = applied?.theme && applied.verifiedAt
    ? "Windows: " + (applied.theme === "light" ? "Day" : "Evening") + (result.pendingReason ? " (change pending)" : "")
    : applied?.verifiedAt && !s.enabled ? "Owned appearance changes released." : "Windows appearance not yet verified.";
  $("warmth-state").textContent = strengthDirty ? "Warmth change pending"
    : !s.enabled ? "Saved for Evening. Desktop Comfort is off."
    : result.warmthActive && Number.isInteger(applied?.strength) ? "Applied strength: " + applied.strength
    : result.pendingReason ? "Saved strength: " + s.strength + ". Display change pending."
    : result.preset === "light" ? "Saved for Evening. Day stays neutral."
    : applied?.strength === 0 ? "Neutral" : "Warmth not yet verified.";
  const recovery = result.problem || (result.pendingReason === "gameplay"
    ? "Appearance changes will wait until gameplay ends. Windows Night Light follows its own schedule."
    : result.pendingReason === "desktop-unavailable" ? "Open PC Control Plane in your signed-in Windows desktop." : "");
  $("comfort-recovery").hidden = !recovery;
  $("recovery-message").textContent = recovery;
  updateClock();
  preview();
  controls();
}

function updateClock() {
  timeline();
  clearTimeout(minuteTimer);
  if (!document.hidden) minuteTimer = setTimeout(() => void refresh(), 60000 - Date.now() % 60000 + 20);
}

const controlRequest = createControlClient({ timeoutMs: 30000 });
async function request(body) {
  try {
    const result = await controlRequest("/api/desktop-comfort", body ? { method: "POST", body: JSON.stringify(body) } : {});
    if (!result.settings) throw new Error("Desktop Comfort is unavailable. Open PC Control Plane and check status.");
    return result;
  } catch (error) {
    if (error.superseded) throw new Error("Another Control Plane window has control. Reopen Desktop Comfort from that window.");
    throw error;
  }
}

function showError(message) {
  $("comfort-recovery").hidden = false;
  $("recovery-message").textContent = message;
}

async function refresh() {
  if (busy || dragging || pendingStrength !== null) { updateClock(); return; }
  const generation = ++refreshGeneration;
  try {
    const result = await request();
    if (generation !== refreshGeneration || busy) return;
    if (uncertain && !result.busy) strengthDirty = false;
    uncertain = Boolean(result.busy);
    render(result);
    if (uncertain) showError("A display change is still running. Check status before trying again.");
  } catch (error) {
    if (generation !== refreshGeneration) return;
    uncertain = true;
    showError(error.message);
    controls();
  } finally { updateClock(); }
}

async function apply(body) {
  if (busy || uncertain) return;
  busy = true;
  refreshGeneration++;
  const scheduleVersion = editVersion;
  controls();
  $("comfort-feedback").textContent = body.action === "strength" ? "Saving warmth..." : "Applying...";
  try {
    const result = await request(body);
    if (body.action === "save" && result.saved && scheduleVersion === editVersion) dirtySchedule = false;
    if (body.action === "strength" && pendingStrength === null && warmth === body.strength) strengthDirty = false;
    if (!result.ok) {
      pendingStrength = null;
      strengthDirty = false;
    }
    render(result);
    $("comfort-feedback").textContent = result.message || result.status;
    if (!result.ok) {
      showError(result.message || "This change could not be verified.");
    }
  } catch (error) {
    uncertain = true;
    pendingStrength = null;
    showError(error.message);
    $("comfort-feedback").textContent = "Result not yet verified.";
  } finally {
    busy = false;
    controls();
    if (pendingStrength !== null && !uncertain) {
      const value = pendingStrength;
      pendingStrength = null;
      void apply({ action: "strength", strength: value });
    }
  }
}

function submitWarmth() {
  clearTimeout(settleTimer);
  const value = warmth;
  if (!Number.isInteger(value) || value < 0 || value > 500) {
    showError("Choose a whole-number warmth from 0 to 500.");
    return;
  }
  if (!strengthDirty) return;
  pendingStrength = value;
  if (!busy && !uncertain) {
    pendingStrength = null;
    void apply({ action: "strength", strength: value });
  }
}


window.addEventListener("pointerup", () => { if (dragging) { dragging = false; submitWarmth(); } });
window.addEventListener("pointercancel", () => { if (dragging) { dragging = false; submitWarmth(); } });
for (const slider of [strength, amplifier]) {
  slider.addEventListener("pointerdown", () => { dragging = true; clearTimeout(settleTimer); });
  slider.addEventListener("input", () => {
    if (autoplay.checked) return;
    warmth = strength.valueAsNumber + (strength.valueAsNumber === 100 ? amplifier.valueAsNumber : 0);
    controls();
    strengthDirty = true;
    preview();
    $("warmth-state").textContent = "Warmth change pending";
    clearTimeout(settleTimer);
    if (!dragging) settleTimer = setTimeout(submitWarmth, 167);
  });
  slider.addEventListener("blur", () => { if (strengthDirty && !dragging) submitWarmth(); });
}
function editSchedule() {
  dirtySchedule = true; editVersion++; evening.setCustomValidity(""); controls(); timeline();
}
for (const input of [day, evening, ...scheduleFields]) input.addEventListener("input", editSchedule);
function syncPlaybackTimer() {
  clearTimeout(playbackTimer);
  if (!autoplay.checked || document.hidden) return;
  playbackTimer = setTimeout(() => {
    scrub.value = (scrub.valueAsNumber + 5) % 1440;
    renderTimelineMinute();
    syncPlaybackTimer();
  }, 100);
}
function setPlayback(enabled) {
  autoplay.checked = enabled;
  $("comfort-autoplay-label").textContent = enabled ? "On" : "Off";
  scrubbing = enabled;
  controls();
  preview();
  syncPlaybackTimer();
}
autoplay.addEventListener("change", () => setPlayback(autoplay.checked));
scrub.addEventListener("input", () => { scrubbing = true; renderTimelineMinute(); });
$("comfort-now").addEventListener("click", () => setPlayback(false));
$("comfort-locate").addEventListener("click", () => {
  const status = $("comfort-location-status");
  if (!navigator.geolocation) { status.textContent = "Location unavailable. Enter coordinates manually."; return; }
  locating = true; controls();
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    latitude.value = coords.latitude.toFixed(2); longitude.value = coords.longitude.toFixed(2);
    zone.value = localZone; locating = false; editSchedule();
    status.textContent = "Location found. Review the times and save.";
  }, () => {
    locating = false; controls();
    status.textContent = "Location unavailable or permission denied. Enter coordinates manually.";
  }, { timeout: 10000, maximumAge: 0 });
});
$("comfort-form").addEventListener("submit", (event) => {
  event.preventDefault();
  evening.setCustomValidity(day.value === evening.value ? "Choose different Day and Evening times." : "");
  if (event.currentTarget.reportValidity()) void apply({ action: "save", day: day.value, evening: evening.value, schedule: scheduleDraft() });
});
$("comfort-enabled").addEventListener("change", () => void apply({ action: $("comfort-enabled").checked ? "enable" : "off" }));
modes.forEach((input) => input.addEventListener("change", () => { preview(); void apply({ action: input.value }); }));
$("comfort-refresh").addEventListener("click", () => void refresh());
document.addEventListener("visibilitychange", () => {
  syncPlaybackTimer();
  if (!document.hidden) void refresh(); else clearTimeout(minuteTimer);
});
window.addEventListener("pagehide", () => clearTimeout(playbackTimer));
window.addEventListener("pageshow", (event) => { if (event.persisted) { syncPlaybackTimer(); void refresh(); } });
window.addEventListener("storage", (event) => { if (event.key === "pcControlPlaneSessionId") void refresh(); });
void refresh();
