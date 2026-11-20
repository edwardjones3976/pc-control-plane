export function nextComfortChange(settings, now = new Date()) {
  if (!settings.enabled) return "Schedule saved. Turn on to follow it.";
  if (settings.override) return "Paused until you choose Automatic.";
  const changes = [["Day", settings.day], ["Evening", settings.evening]].map(([name, time]) => {
    const [hour, minute] = time.split(":").map(Number);
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return { name, date };
  }).sort((a, b) => a.date - b.date);
  const next = changes[0];
  const tomorrow = next.date.toDateString() !== now.toDateString();
  return next.name + (tomorrow ? " tomorrow at " : " at ") + next.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const clockMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export function minuteClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return [Math.floor(m / 60), m % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
export function validZone(zone) {
  if (typeof zone !== "string" || !zone || zone.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}
function zonedParts(now, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(now).map(({ type, value }) => [type, Number(value)]));
}
export function scheduleFor(settings, now = new Date()) {
  const zone = settings.zone || localZone;
  const p = zonedParts(now, zone);
  const result = { day: settings.day, evening: settings.evening, zone, minute: p.hour * 60 + p.minute, fallback: false };
  if (settings.scheduleMode !== "solar") return result;
  const date = Date.UTC(p.year, p.month - 1, p.day);
  const g = 2 * Math.PI / 365 * (date - Date.UTC(p.year, 0, 1)) / 86400000;
  const eq = 229.18 * (.000075 + .001868*Math.cos(g) - .032077*Math.sin(g) - .014615*Math.cos(2*g) - .040849*Math.sin(2*g));
  const dec = .006918 - .399912*Math.cos(g) + .070257*Math.sin(g) - .006758*Math.cos(2*g) + .000907*Math.sin(2*g) - .002697*Math.cos(3*g) + .00148*Math.sin(3*g);
  const rad = Math.PI / 180, lat = settings.latitude * rad;
  const cosine = (Math.cos(90.833 * rad) - Math.sin(lat)*Math.sin(dec)) / (Math.cos(lat)*Math.cos(dec));
  if (!Number.isFinite(cosine) || Math.abs(cosine) >= 1) return { ...result, fallback: true };
  const noon = 720 - 4 * settings.longitude - eq, delta = Math.acos(cosine) / rad * 4;
  const eventClock = (utcMinutes, offset) => {
    const e = zonedParts(new Date(date + Math.round(utcMinutes + (offset || 0)) * 60000), zone);
    return minuteClock(e.hour * 60 + e.minute);
  };
  const day = eventClock(noon - delta, settings.dayOffset), evening = eventClock(noon + delta, settings.eveningOffset);
  return day === evening ? { ...result, fallback: true } : { ...result, day, evening };
}
export function isDayAt({ day, evening }, minute) {
  const start = clockMinutes(day), end = clockMinutes(evening);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function timelineWarmth(schedule, minute, strength) {
  if (isDayAt(schedule, minute)) return 0;
  const dusk = clockMinutes(schedule.evening), dawn = clockMinutes(schedule.day);
  const night = (dawn - dusk + 1440) % 1440;
  const elapsed = (minute - dusk + 1440) % 1440;
  const ramp = Math.min(60, night / 2);
  return Math.round(strength * Math.min(elapsed, night - elapsed, ramp) / ramp);
}
