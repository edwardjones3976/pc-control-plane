const markup = new WeakMap();

export function monitoringState({ receivedAt = 0, failed = false, cached = false, observerRunning, superseded = false }, now = Date.now()) {
  if (superseded) return { kind: "inactive", label: "Inactive", readings: "Paused", message: "Another window has control.", retry: false };
  if (!receivedAt) return failed
    ? { kind: "offline", label: "Unavailable", readings: "Waiting", message: "Cannot reach PC Control Plane. No readings have been received.", retry: true }
    : { kind: "connecting", label: "Connecting", readings: "Waiting", message: "Waiting for the first readings.", retry: false };
  if (failed) return { kind: "offline", label: "Reconnecting", readings: "Last readings", message: "Updates were interrupted. Last readings are retained; current conditions are not confirmed.", retry: true };
  if (now - receivedAt > 20000) return { kind: "stale", label: "Updates delayed", readings: "Last readings", message: "No recent updates. Last readings are retained; current conditions are not confirmed.", retry: true };
  if (cached) return { kind: "cached", label: "Connected", readings: "Cached", message: "The engine returned cached readings. Some sensors may not be current.", retry: true };
  if (observerRunning === false) return { kind: "paused", label: "Monitor paused", readings: "Received", message: "Connected, but the autonomous observer is not running.", retry: false };
  return { kind: "live", label: "Connected", readings: "Live", message: "", retry: false };
}

export function setMarkup(element, html) {
  if (!element || markup.get(element) === html) return false;
  element.innerHTML = html;
  markup.set(element, html);
  return true;
}

export function createRefreshGate(read) {
  let active = null;
  let activeFresh = false;
  let queuedFresh = null;
  return function refresh({ requireFresh = false } = {}) {
    if (active) {
      if (!requireFresh || activeFresh) return active;
      if (!queuedFresh) {
        queuedFresh = active.catch(() => {}).then(() => {
          queuedFresh = null;
          return refresh({ requireFresh: true });
        });
      }
      return queuedFresh;
    }
    activeFresh = requireFresh;
    active = Promise.resolve().then(() => read({ requireFresh })).finally(() => {
      active = null;
      activeFresh = false;
    });
    return active;
  };
}
