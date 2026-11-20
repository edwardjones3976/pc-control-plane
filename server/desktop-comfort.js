import { isDayAt, scheduleFor, validZone } from "../public/comfort-model.js";
export const comfortDefaults = Object.freeze({ enabled: false, day: "07:00", evening: "20:00", strength: 85, override: null });
const validTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const validStrength = (value) => Number.isInteger(value) && value >= 0 && value <= 500;
const bounded = (n, max) => Number.isFinite(n) && Math.abs(n) <= max;
function scheduleOptions(s) {
  const location = bounded(s.latitude, 90) && bounded(s.longitude, 180);
  return { scheduleMode: s.scheduleMode === "solar" && location ? "solar" : "fixed",
    zone: validZone(s.zone) ? s.zone : null,
    latitude: location ? s.latitude : null, longitude: location ? s.longitude : null,
    dayOffset: Number.isInteger(s.dayOffset) && bounded(s.dayOffset, 120) ? s.dayOffset : 0,
    eveningOffset: Number.isInteger(s.eveningOffset) && bounded(s.eveningOffset, 120) ? s.eveningOffset : 0 };
}

export function normalizeComfortSettings(saved) {
  if (!saved || !validTime(saved.day) || !validTime(saved.evening) || saved.day === saved.evening || !validStrength(saved.strength)) {
    return { ...comfortDefaults };
  }
  return { enabled: saved.enabled === true, day: saved.day, evening: saved.evening, strength: saved.strength,
    override: ["light", "dark"].includes(saved.override) ? saved.override : null, ...scheduleOptions(saved) };
}

export function desktopComfortPreset(settings, now = new Date()) {
  if (!settings.enabled) return null;
  if (settings.override) return settings.override;
  const schedule = scheduleFor(settings, now);
  return isDayAt(schedule, schedule.minute) ? "light" : "dark";
}

export function comfortSettingsForAction(previous, body) {
  if (!body || !["save", "enable", "strength", "light", "dark", "resume", "off"].includes(body.action)) {
    throw new Error("Choose a Desktop Comfort action.");
  }
  if (body.action === "save") {
    if (!validTime(body.day) || !validTime(body.evening) || body.day === body.evening
      || (body.strength !== undefined && !validStrength(body.strength))) {
      throw new Error("Choose two different times and a whole-number warmth from 0 to 500.");
    }
    const options = body.schedule === undefined ? {} : scheduleOptions(body.schedule || {});
    if (body.schedule !== undefined && (!body.schedule || !["fixed", "solar"].includes(body.schedule.scheduleMode)
        || options.scheduleMode !== body.schedule.scheduleMode || !options.zone
        || options.dayOffset !== body.schedule.dayOffset || options.eveningOffset !== body.schedule.eveningOffset)) {
      throw new Error("Check the time zone, location coordinates, and offsets (-120 to 120 minutes).");
    }
    return { ...previous, ...options, day: body.day, evening: body.evening,
      ...(body.strength === undefined ? {} : { strength: body.strength }) };
  }
  if (body.action === "strength") {
    if (!validStrength(body.strength)) throw new Error("Choose a whole-number warmth from 0 to 500.");
    return { ...previous, strength: body.strength };
  }
  if (body.action === "off") return { ...previous, enabled: false, override: null };
  if (body.action === "enable") return { ...previous, enabled: true, override: null };
  if (!previous.enabled) throw new Error("Turn on Desktop Comfort first.");
  return { ...previous, override: body.action === "resume" ? null : body.action };
}

export function createComfortController(deps) {
  const now = deps.now || (() => new Date());
  let busy = false;
  let retryAt = 0;
  let applied = { theme: null, strength: null, verifiedAt: null };
  let pendingReason = null;
  let problem = null;
  let status = "Not yet verified";
  const read = async () => normalizeComfortSettings(await deps.read());
  const target = (settings) => {
    const theme = desktopComfortPreset(settings, now());
    return { theme, strength: theme === "dark" ? settings.strength : 0 };
  };
  async function snapshot() {
    const settings = await read();
    const warm = deps.warmth();
    return { ok: !problem, settings, schedule: scheduleFor(settings, now()), preset: desktopComfortPreset(settings, now()), requested: target(settings),
      applied: { ...applied, strength: warm.active ? warm.strength : (applied.strength === 0 ? 0 : null) },
      warmthActive: warm.active, status, pendingReason, problem, busy };
  }
  async function apply(settings, suppliedTelemetry) {
    let wanted = target(settings);
    const warm = deps.warmth();
    const matches = applied.verifiedAt && wanted.theme === applied.theme
      && wanted.strength === (warm.active ? warm.strength : applied.strength)
      && (!wanted.strength || warm.active);
    if (matches) { pendingReason = null; problem = null; return; }
    const telemetry = wanted.theme ? (suppliedTelemetry || await deps.capture()) : null;
    wanted = target(settings);
    if (wanted.theme && (telemetry?.game?.detected || !telemetry?.foreground?.pid)) {
      pendingReason = telemetry?.game?.detected ? "gameplay" : "desktop-unavailable";
      status = telemetry?.game?.detected ? "Waiting for gameplay to end" : "Waiting for the Windows desktop";
      return;
    }
    pendingReason = "applying";
    if (!wanted.strength) await deps.setWarmth(0);
    if (wanted.theme !== applied.theme || !applied.verifiedAt) {
      await deps.setTheme(wanted.theme);
      applied = { theme: wanted.theme, strength: wanted.strength ? null : 0, verifiedAt: now().toISOString() };
    }
    if (wanted.strength) await deps.setWarmth(wanted.strength);
    applied = { ...wanted, verifiedAt: now().toISOString() };
    pendingReason = null;
    problem = null;
    status = !wanted.theme ? "Off - owned changes released" : wanted.theme === "light" ? "Day applied" : "Evening applied";
    await deps.audit({ level: "action", action: "desktop-comfort.apply", message: status,
      details: { theme: wanted.theme, strength: wanted.strength } });
  }
  async function failed(error) {
    problem = error?.message || "The display change could not be verified.";
    status = "Needs attention";
    pendingReason = "recovery";
    retryAt = now().getTime() + 60000;
    try { await deps.audit({ level: "warn", action: "desktop-comfort.apply", message: problem }); } catch { /* Keep the display failure visible even if audit storage is unavailable. */ }
  }
  return {
    get: snapshot,
    async set(body) {
      if (busy) return { ...await snapshot(), ok: false, message: "Desktop Comfort is busy. Wait for the current change to finish." };
      busy = true;
      let saved = false;
      try {
        const settings = comfortSettingsForAction(await read(), body);
        await deps.write(settings);
        saved = true;
        problem = null;
        retryAt = 0;
        if (!settings.enabled && ["save", "strength"].includes(body.action)) {
          return { ...await snapshot(), busy: false, saved, message: "Preference saved. Desktop Comfort remains off." };
        }
        await apply(settings);
        return { ...await snapshot(), busy: false, saved, message: pendingReason ? `Saved. ${status}.` : `${status}.` };
      } catch (error) {
        if (saved) await failed(error);
        return { ...await snapshot(), busy: false, ok: false, saved,
          message: saved ? problem : error.code ? "Preferences could not be saved. Check local disk space and app permissions." : error.message };
      } finally { busy = false; }
    },
    async tick(telemetry) {
      if (busy || now().getTime() < retryAt) return;
      busy = true;
      try {
        const settings = await read();
        if (settings.enabled || deps.warmth().active || applied.theme || problem) await apply(settings, telemetry);
      } catch (error) { await failed(error); }
      finally { busy = false; }
    }
  };
}
