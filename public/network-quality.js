const endpoint = "https://speed.cloudflare.com";
const valid = (value, max = Infinity) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
const valueOr = (value, unit) => valid(value) ? `${Math.round(value * 10) / 10} ${unit}` : "Unavailable";
const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[i] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
};

export function networkQuality({ ping, loss, variation, dns, web, stale }) {
  if (stale) return { score: null, quality: "Sample stale", readiness: "Awaiting a fresh sample", tone: "neutral" };
  if (loss === 100 && web === false) return { score: 0, quality: "Unreachable", readiness: "Connectivity checks failed", tone: "bad" };
  if (!valid(ping) && loss === 100) {
    return { score: null, quality: "Ping target did not reply", readiness: "Gaming latency unverified", tone: "warn" };
  }
  if (!valid(ping) || !valid(loss, 100)) {
    return { score: null, quality: "Awaiting measurements", readiness: "Not enough data", tone: "neutral" };
  }
  const score = Math.round(
    Math.max(0, 50 - Math.max(0, ping - 20) * 50 / 130) +
    Math.max(0, 30 - loss * 3) +
    (valid(variation) ? Math.max(0, 10 - Math.max(0, variation - 5) * 10 / 45) : 0) +
    (dns === true ? 5 : 0) + (web === true ? 5 : 0)
  );
  const partial = !valid(variation) || dns == null || web == null;
  const quality = partial ? "Partial sample" : score >= 85 ? "Excellent" : score >= 70 ? "Good" : score >= 50 ? "Fair" : "Poor";
  if (dns === false || web === false) return { score, quality, readiness: "Connectivity issue detected", tone: "bad" };
  if (!valid(variation)) return { score, quality, readiness: "Awaiting latency variation", tone: "neutral" };
  if (ping <= 40 && loss === 0 && variation <= 15) {
    return { score, quality, readiness: "Low-latency connection", tone: "good" };
  }
  if (ping <= 80 && loss <= 1 && variation <= 30) {
    return { score, quality, readiness: "Usable for casual play", tone: "warn" };
  }
  return { score, quality, readiness: "Lag risk detected", tone: "bad" };
}

export async function runSpeedTest({ signal, phase = () => {}, fetcher = fetch }) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  const request = async (path, options = {}, scope = deadline) => {
    const response = await fetcher(endpoint + path, {
      ...options, signal: scope, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer"
    });
    if (!response.ok) throw new Error("Speed test endpoint unavailable.");
    return response;
  };
  const ping = async (scope = deadline) => {
    const start = performance.now();
    await (await request("/__down?bytes=0", {}, scope)).arrayBuffer();
    return performance.now() - start;
  };
  const loaded = async (transfer) => {
    const stop = new AbortController();
    const scope = AbortSignal.any([deadline, stop.signal]);
    const samples = [];
    const probes = (async () => {
      for (let i = 0; i < 5 && !scope.aborted; i++) {
        try { samples.push(await ping(scope)); } catch { break; }
        if (!scope.aborted) await new Promise((resolve) => setTimeout(resolve, 120));
      }
    })();
    const start = performance.now();
    try {
      const bytes = await transfer();
      const ms = performance.now() - start;
      return { mbps: ms > 0 && bytes > 0 ? bytes * 8 / ms / 1000 : null, latency: median(samples) };
    } finally {
      stop.abort();
      await probes;
    }
  };
  phase("Measuring idle latency");
  await ping(); // Warm up the connection before collecting latency samples.
  const samples = [];
  for (let i = 0; i < 4; i++) samples.push(await ping());
  phase("Measuring download");
  const downloadBytes = 10_000_000;
  const download = await loaded(async () => {
    const response = await request(`/__down?bytes=${downloadBytes}`);
    const reader = response.body.getReader();
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > downloadBytes) throw new Error("Unexpected download size.");
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (total !== downloadBytes) throw new Error("Incomplete speed test download.");
    return total;
  });
  phase("Measuring upload");
  const uploadBytes = 4_000_000;
  const upload = await loaded(async () => {
    const response = await request("/__up", {
      method: "POST", body: new Uint8Array(uploadBytes), headers: { "Content-Type": "application/octet-stream" }
    });
    await response.arrayBuffer();
    return uploadBytes;
  });
  return { download: download.mbps, upload: upload.mbps, idle: median(samples),
    downloadLatency: download.latency, uploadLatency: upload.latency };
}

const views = new WeakMap();
function createView(root) {
  root.innerHTML = `
    <div class="net-meter">
      <header class="net-head"><h2>Network Quality</h2><span class="net-context" data-net="sample"></span></header>
      <div class="net-result">
        <p class="net-description" data-net="headline">Live quality score</p>
        <p class="net-value"><span data-net="value">--</span><small data-net="unit"></small></p>
        <p class="net-note" data-net="quality"></p>
      </div>
      <dl class="net-stats">
        <div><dt>Internet ICMP ping</dt><dd data-net="ping"></dd></div>
        <div><dt>Internet ICMP loss</dt><dd data-net="loss"></dd></div>
        <div><dt>Latency variation</dt><dd data-net="variation"></dd></div>
        <div><dt>Upload</dt><dd data-net="upload">Not tested</dd></div>
      </dl>
      <div class="net-readiness"><span>Gaming readiness</span><strong data-net="readiness"></strong></div>
      <div class="net-controls">
        <button type="button" data-net="test">Run speed test</button>
        <output data-net="progress" role="status">Cloudflare test · up to 14 MB of payload</output>
      </div>
      <details class="net-details"><summary>Show more info</summary>
        <dl>
          <div><dt>Live quality score</dt><dd data-net="score"></dd></div>
          <div><dt>Connection</dt><dd data-net="connection"></dd></div>
          <div><dt>DNS / web checks</dt><dd data-net="checks"></dd></div>
          <div><dt>Live ping target</dt><dd data-net="target"></dd></div>
          <div><dt>Gateway ping / loss</dt><dd data-net="gateway"></dd></div>
          <div><dt>Cloudflare TCP connect</dt><dd data-net="tcp"></dd></div>
          <div><dt>Test idle latency</dt><dd data-net="idle">Not tested</dd></div>
          <div><dt>While downloading</dt><dd data-net="downloadLatency">Not tested</dd></div>
          <div><dt>While uploading</dt><dd data-net="uploadLatency">Not tested</dd></div>
        </dl>
        <p class="net-note">Gateway, internet probes, and speed test measure different paths. Game-server ping and packet loss require in-game network statistics.</p>
      </details>
    </div>`;
  const fields = Object.fromEntries([...root.querySelectorAll("[data-net]")].map((el) => [el.dataset.net, el]));
  const put = (field, value) => { if (fields[field].textContent !== value) fields[field].textContent = value; };
  const view = { put, fields, running: null, result: null, game: false };
  fields.test.addEventListener("click", async () => {
    if (view.running) { view.running.abort(); return; }
    if (view.game) return;
    const controller = new AbortController();
    view.running = controller;
    put("test", "Cancel test");
    try {
      const result = await runSpeedTest({ signal: controller.signal, phase: (label) => put("progress", label + "...") });
      view.result = result;
      put("headline", "Download speed");
      put("value", valueOr(result.download, "").trim());
      put("unit", "Mbps");
      for (const name of ["upload", "idle", "downloadLatency", "uploadLatency"]) {
        put(name, valueOr(result[name], name === "upload" ? "Mbps" : "ms"));
      }
      put("progress", "Test complete · Cloudflare · " + new Date().toLocaleTimeString());
    } catch {
      put("progress", controller.signal.aborted ? "Test cancelled." : "Test unavailable or timed out. Live quality is still available.");
    } finally {
      view.running = null;
      put("test", view.result ? "Test again" : "Run speed test");
      fields.test.disabled = view.game;
    }
  });
  return view;
}

export function renderNetworkQuality(root, status, { monitoringAvailable = true } = {}) {
  let view = views.get(root);
  if (!view) { view = createView(root); views.set(root, view); }
  const { put, fields } = view;
  const network = status.telemetry?.network;
  const health = status.policy?.networkHealth || {};
  const raw = network?.latency;
  const usableEcho = raw && (!raw.status || raw.status === "measured") && raw.received !== 0;
  const ping = usableEcho ? raw.averageMs : null;
  const loss = usableEcho ? raw.packetLossPct : null;
  const variation = usableEcho && raw.received >= 2 && valid(raw.minMs) && valid(raw.maxMs) ? raw.maxMs - raw.minMs : null;
  const sampledAt = Date.parse(network?.sampledAt);
  const stale = !monitoringAvailable || !Number.isFinite(sampledAt) || Date.now() - sampledAt > 120000;
  const { score, quality, readiness, tone } = networkQuality({ ping, loss, variation, dns: health.dnsOk, web: health.webReachable, stale });
  const check = (value) => value === true ? "OK" : value === false ? "Failed" : "Not checked";
  put("sample", Number.isFinite(sampledAt) ? `${stale ? "Last sample" : "Sampled"} ${new Date(sampledAt).toLocaleTimeString()}` : "No sample time");
  put("score", score === null ? "Unavailable" : `${score} / 100`);
  if (!view.result) {
    put("headline", stale ? "Awaiting current network readings" : "Live quality score");
    put("value", score === null ? "--" : String(score));
    put("unit", score === null ? "" : "/100");
  }
  put("quality", !stale && raw?.status === "probe-error" ? "Public ping probe unavailable"
    : !stale && raw?.received === 0 ? "Public ping target did not reply" : quality);
  put("ping", valueOr(ping, "ms"));
  put("loss", valid(loss, 100) ? `${loss}%` : "Unavailable");
  put("variation", valueOr(variation, "ms"));
  put("readiness", score === null ? "Game latency and loss unverified" : readiness);
  fields.readiness.className = "net-tone-" + tone;
  const adapter = health.activeAdapter;
  const adapterName = adapter?.Name || adapter?.name || adapter?.ConnectionType || adapter?.connectionType;
  put("connection", health.vpnActive ? `VPN${adapterName ? ` · ${adapterName}` : ""}` : adapterName || "Unverified");
  put("checks", `${check(health.dnsOk)} / ${check(health.webReachable)}`);
  put("target", raw?.target || "Unavailable");
  const gateway = network?.gatewayLatency;
  put("gateway", gateway?.status === "measured" ? `${valueOr(gateway.averageMs, "ms")} / ${gateway.packetLossPct}% (${gateway.target})` : "Unavailable");
  put("tcp", network?.internetTcp?.reachable ? valueOr(network.internetTcp.latencyMs, "ms") : "Unavailable");
  view.game = Boolean(status.telemetry?.game?.detected);
  fields.test.disabled = view.game && !view.running;
  fields.test.title = view.game ? "End gameplay before running a speed test." : "";
  if (view.game) view.running?.abort();
}
