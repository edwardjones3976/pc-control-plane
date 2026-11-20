const loopbacks = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const bodies = new WeakMap();

function refusal(status, message) {
  return Object.assign(new Error(message), { status });
}

export function localRequestUrl(req) {
  if (!loopbacks.has(req.socket.remoteAddress)) throw refusal(403, "Use PC Control Plane on this computer.");
  if (typeof req.url !== "string" || !req.url.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
    throw refusal(400, "Invalid local request.");
  }
  let origin;
  try { origin = new URL(`http://${req.headers.host}`); }
  catch { throw refusal(400, "Invalid local address."); }
  if (!localHosts.has(origin.hostname) || origin.username || origin.password || origin.pathname !== "/"
      || origin.search || origin.hash || Number(origin.port || 80) !== req.socket.localPort) {
    throw refusal(403, "This address is not the local Control Plane.");
  }
  const url = new URL(req.url, origin);
  try { decodeURIComponent(url.pathname); } catch { throw refusal(400, "Invalid page address."); }
  if (!["GET", "POST"].includes(req.method)) throw refusal(405, "This request method is not supported.");
  if (url.pathname.startsWith("/api/")) {
    const site = req.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(site)) throw refusal(403, "Open these controls inside PC Control Plane.");
    if (req.headers.origin && req.headers.origin !== origin.origin) throw refusal(403, "Open these controls inside PC Control Plane.");
    if (req.method === "POST") {
      if (req.headers.origin !== origin.origin || site !== "same-origin") {
        throw refusal(403, "Use the local Control Plane window to make changes.");
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) {
        throw refusal(415, "This control requires a JSON request.");
      }
    }
  } else if (req.method !== "GET") {
    throw refusal(405, "Pages are read-only.");
  }
  return url;
}

export function readJsonBody(req) {
  if (bodies.has(req)) return bodies.get(req);
  const maxBytes = 1024 * 1024;
  const pending = new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let tooLarge = Number(req.headers["content-length"]) > maxBytes;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { chunks.length = 0; reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(refusal(408, "The request was not received in time.")), 10000);
    timer.unref?.();
    req.on("data", (chunk) => {
      if (settled) return;
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) return finish(refusal(413, "The request is too large."));
      try {
        const body = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (!body || Array.isArray(body) || typeof body !== "object") throw new Error();
        finish(null, body);
      } catch { finish(refusal(400, "Use a valid settings object.")); }
    });
    req.on("error", (error) => finish(error));
    req.on("aborted", () => finish(refusal(400, "The request was interrupted.")));
    if (req.aborted) finish(refusal(400, "The request was interrupted."));
  });
  bodies.set(req, pending);
  return pending;
}
