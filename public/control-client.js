export class ControlRequestError extends Error {
  constructor(message, { status = null, uncertain = false, superseded = false } = {}) {
    super(message);
    this.name = "ControlRequestError";
    this.status = status;
    this.uncertain = uncertain;
    this.superseded = superseded;
  }
}

function currentSession() {
  try { return typeof window === "undefined" ? "" : window.localStorage.getItem("pcControlPlaneSessionId") || ""; }
  catch { return ""; }
}

export function createControlClient({ fetcher = globalThis.fetch, session = currentSession, onSuperseded = () => {}, timeoutMs = 75000 } = {}) {
  return async function request(path, options = {}) {
    const method = options.method || "GET";
    if (typeof path !== "string" || !/^\/api\/[a-z0-9/-]+(?:\?[^#\\]*)?$/i.test(path) || !["GET", "POST"].includes(method)) {
      throw new ControlRequestError("This control is not supported.");
    }
    if (options.body !== undefined) {
      let body;
      try { body = JSON.parse(options.body); } catch { throw new ControlRequestError("Use valid settings for this control."); }
      if (!body || Array.isArray(body) || typeof body !== "object" || method !== "POST") {
        throw new ControlRequestError("Use valid settings for this control.");
      }
    }
    if (globalThis.location?.origin === "https://pc-control-plane.invalid") {
      throw new ControlRequestError("Offline preview: the desktop engine is not connected.", { status: 503 });
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let response, payload;
    try {
      response = await fetcher(path, {
        ...options, method, signal, cache: "no-store", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json", "x-pc-session": session() }
      });
      payload = await response.json();
    } catch {
      throw new ControlRequestError("Connection interrupted. Check status before trying another change.", { uncertain: method === "POST" });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ControlRequestError("The app returned an unreadable result. Check status before trying again.", { status: response.status, uncertain: method === "POST" });
    }
    if (!response.ok || payload.ok === false) {
      const message = typeof payload.message === "string" && payload.message
        || typeof payload.error === "string" && payload.error
        || `Request failed: ${response.status}`;
      const superseded = response.status === 409 && payload.superseded === true;
      if (superseded) onSuperseded(message);
      throw new ControlRequestError(message, { status: response.status, superseded, uncertain: method === "POST" && response.status >= 500 });
    }
    return payload;
  };
}
