import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopComfortPreset, labRestartAdapter, setDesktopComfort } from "../server/system.js";

const id = "f8a80f06-0fad-4dd8-9314-e6e50c31dff3";
const capture = async () => ({ foreground: { pid: 42 } });

test("desktop comfort respects opt-in, local time, midnight, and manual presets", async () => {
  const s = { enabled: true, day: "07:00", evening: "20:00" };
  const time = (h, m = 0) => new Date(2026, 10, 12, h, m);
  assert.equal(desktopComfortPreset({ ...s, enabled: false }, time(20)), null);
  assert.equal(desktopComfortPreset(s, time(7)), "light");
  assert.equal(desktopComfortPreset(s, time(19, 59)), "light");
  assert.equal(desktopComfortPreset(s, time(20)), "dark");
  assert.equal(desktopComfortPreset(s, time(0)), "dark");
  assert.equal(desktopComfortPreset({ ...s, day: "20:00", evening: "07:00" }, time(0)), "light");
  assert.equal(desktopComfortPreset({ ...s, override: "light" }, time(20)), "light");
  assert.equal((await setDesktopComfort({ action: "save", day: "07:00", evening: "07:00", strength: 35 })).ok, false);
  assert.equal((await setDesktopComfort({ action: "save", day: "07:00", evening: "20:00", strength: 501 })).ok, false);
});

test("adapter restart targets one GUID and rejects concurrent and unconfirmed requests", async () => {
  const request = { id, confirmed: true };
  const events = [];
  const deps = {
    capture, audit: async (entry) => events.push(entry),
    run: async (script) => {
      assert.match(script, new RegExp(id));
      assert.match(script, /Restart-NetAdapter -InputObject/);
      return { ok: true, stdout: "RESTARTED\r\nLINK_UP" };
    },
    diagnose: async ({ dryRun }) => {
      assert.equal(dryRun, true);
      return { message: "Diagnosis complete." };
    }
  };
  assert.equal((await labRestartAdapter({ id }, deps)).ok, false);
  const pending = labRestartAdapter(request, deps);
  assert.equal((await labRestartAdapter(request, deps)).ok, false);
  assert.equal((await pending).linkUp, true);
  assert.equal(events.length, 2);
  for (const token of ["ADMIN_REQUIRED", "ADAPTER_UNAVAILABLE"]) {
    const result = await labRestartAdapter(request, { ...deps, run: async () => ({ ok: false, stdout: token }) });
    assert.equal(result.restarted, false);
  }
});
