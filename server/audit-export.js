const AUDIT_FRIENDLY = [
  { m: "observer.inactivity-enter", title: "Idle cooling started", why: "The app entered Conservative mode after extended keyboard/mouse inactivity." },
  { m: "observer.inactivity-restore", title: "Returned from idle cooling", why: "Input resumed, so the app restored the remembered mode." },
  { m: "observer.inactivity-overdrive-block", title: "Overdrive kept manual", why: "The app restored Balanced instead of automatically re-entering user-only Overdrive." },
  { m: "ml.governor.executed", title: "Autonomous executor acted", why: "The autonomous brain used a verified safe handler." },
  { m: "ml.optimizer.hypothesis", title: "Optimizer hypothesis", why: "The optimizer compared likely causes and chose a bounded experiment to watch." },
  { m: "ml.governor.verified", title: "Optimizer result checked", why: "The app checked whether the previous autonomous choice helped or kept the PC stable." },
  { m: "observer.band-first", title: "Adjusted power level first", why: "The app used the current mode's power band before switching modes." },
  { m: "observer.mode-stability-hold", title: "Waiting before switching modes", why: "The app waited for the same mode target to stay stable before changing modes." },
  { m: "observer.auto-apply", title: "Mode changed automatically", why: "The app changed modes after the signal was safe and stable enough." },
  { m: "selfheal.power-plan", title: "Power plan corrected", why: "The app corrected the Windows power plan to match the intended state." },
  { m: "failure.proactive-prevention", title: "Prevention guard updated", why: "The app watched for common or known issues before they became active." },
  { m: "failure.remediation", title: "Failure remediation ran", why: "The app routed a detected issue through safe remediation." },
  { m: "failure.prevention", title: "Recurrence prevention updated", why: "The app adjusted prevention for an issue that was already remediated." },
  { m: "diagnostics.traps.warning", title: "Diagnostic warning captured", why: "The app recorded pressure or warning evidence for troubleshooting." },
  { m: "diagnostics.traps.arm", title: "Evidence capture armed", why: "The app prepared temporary evidence capture for a known issue." },
  { m: "diagnostics.traps.disarm", title: "Evidence capture cleared", why: "The app cleared a temporary evidence capture rule." },
  { m: "memory.attribution", title: "Memory cause identified", why: "The app identified which process was holding memory." },
  { m: "memory.release.backoff", title: "Memory cleanup paused", why: "Memory cleanup was not helping, so the app backed off." },
  { m: "memory.release", title: "Memory cleanup ran", why: "The app trimmed reclaimable idle memory without closing apps." },
  { m: "cpu.relief", title: "CPU relief ran", why: "The app briefly eased peak CPU behavior and restored it." },
  { m: "thermal.predictive-cool", title: "Predictive cooling", why: "The app eased power early because temperature was trending upward." },
  { m: "learning.guardrail-block", title: "Risky switch skipped", why: "Learning held back a mode switch that recently had poor outcomes." },
  { m: "learning.guardrail-capped", title: "Mode activated, power capped", why: "A candidate mode with recent poor outcomes was activated anyway, but its power was held at the home base until results improve." },
  { m: "learning.guardrail-armed", title: "Learning caution added", why: "The app added caution after a weak or risky session." },
  { m: "learning.guardrail-cleared", title: "Learning caution cleared", why: "The app removed caution after healthier results." },
  { m: "context.session-start", title: "Activity tracking started", why: "The app started tracking the current workload." },
  { m: "context.session-end", title: "Activity tracking finished", why: "The app finished a workload record and learned from it." },
  { m: "mode.apply", title: "Mode applied", why: "A mode was applied or previewed." },
  { m: "power", title: "Power setting checked", why: "The app reviewed or adjusted a Windows power setting." },
  { m: "network", title: "Network checked", why: "The app reviewed network health." },
  { m: "observer.tick", title: "Health checked", why: "The observer sampled the current PC state." }
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanText(value, limit = 180) {
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

function friendly(entry = {}) {
  const action = String(entry.action || "");
  if (action.includes("failure.remediation") && remediationHasProfile(entry.details?.remediation || {}, "nvidia-driver-reset")) {
    return {
      title: "GPU driver reset/watchdog issue",
      why: "Windows reported the graphics driver reset or watchdog fired; the app kept the last known failure signature visible and used safe containment only."
    };
  }
  const found = AUDIT_FRIENDLY.find((item) => action.includes(item.m));
  if (found) {
    return found;
  }
  if (action.endsWith(".error") || entry.level === "warn") {
    return { title: "Needs attention", why: "The app recorded something that may need review." };
  }
  return { title: "System activity", why: "The app recorded routine activity." };
}

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : null;
}

function topProcessNames(details = {}) {
  const warningTop = details.warning?.telemetry?.topCpuProcesses;
  const top = Array.isArray(details.topCpuProcesses)
    ? details.topCpuProcesses
    : Array.isArray(warningTop)
      ? warningTop
      : [];
  return top
    .slice(0, 4)
    .map((process) => {
      const cpu = percent(process?.cpuPct);
      return cleanText(`${process?.name || "process"}${cpu ? ` (${cpu} CPU)` : ""}`, 60);
    })
    .filter(Boolean)
    .join(", ");
}

function remediationHasProfile(remediation = {}, id) {
  const routes = Array.isArray(remediation.routes) ? remediation.routes : [];
  return routes.some((route) => route?.profileId === id || route?.id === id);
}

function plainMode(modeId) {
  const mode = String(modeId || "");
  const labels = {
    conservative: "Conservative",
    balanced: "Balanced",
    performance: "100% Performance",
    competitive: "Competitive Gaming",
    agentic: "Agentic Work",
    overdrive: "Overdrive"
  };
  return labels[mode] || cleanText(mode, 80);
}

function entryDetails(entry = {}) {
  const details = entry.details || {};
  const action = String(entry.action || "");
  const items = [];
  const add = (label, value, limit = 180) => {
    const text = cleanText(value, limit);
    if (text) {
      items.push({ label, value: text });
    }
  };

  add("What happened", friendly(entry).title);
  add("Why", friendly(entry).why);

  if (details.coalesced) {
    add("Status", `${details.samples || "Several"} similar entries were summarized to keep the log readable.`);
  }

  if (action.includes("diagnostics.traps.warning") || action.includes("failure.remediation.relief-gate")) {
    const cpu = percent(details.cpuLoadPct ?? details.warning?.telemetry?.system?.cpuLoadPct);
    const ram = percent(details.ramUsedPct ?? details.warning?.telemetry?.system?.ramUsedPct);
    add("Pressure", [cpu ? `CPU ${cpu}` : null, ram ? `RAM ${ram}` : null].filter(Boolean).join(" / "));
    add("Top activity", topProcessNames(details));
    add("App response", action.includes("relief-gate")
      ? "Checked RAM and CPU relief gates and only acted if the safe rules allowed it."
      : "Recorded the warning and kept evidence capture ready.");
  } else if (action.includes("failure.proactive-prevention")) {
    const guards = details.proactive?.activeGuards || details.activeGuards || [];
    add("Status", guards.length ? `${guards.length} guard${guards.length === 1 ? "" : "s"} watching known issues.` : "No active guard.");
    add("App response", guards.slice(0, 4).map((guard) => guard.label || guard.title || guard.id).filter(Boolean).join(", "));
  } else if (action.includes("failure.remediation")) {
    const remediation = details.remediation || {};
    if (remediationHasProfile(remediation, "nvidia-driver-reset")) {
      add("Status", "GPU driver reset/watchdog issue visible");
      add("App response", "Kept the last known failure signature visible and used safe containment only.");
    } else {
      add("Status", remediation.status || `${remediation.liveCount || 0} live / ${remediation.standbyCount || 0} standby`);
      add("App response", remediation.summary || (remediation.routes || []).slice(0, 4).map((route) => route.label || route.id).filter(Boolean).join(", "));
    }
  } else if (action.includes("observer.inactivity-enter")) {
    add("Status", details.idleMinutes != null ? `Idle for ${Math.round(Number(details.idleMinutes))} minutes.` : "Extended inactivity threshold reached.");
    add("Mode change", [plainMode(details.from), plainMode(details.to)].filter(Boolean).join(" -> "));
    add("App response", details.returnMode ? `Remembered ${plainMode(details.returnMode)} for resume.` : "Remembered the prior mode for resume.");
  } else if (action.includes("observer.inactivity-restore") || action.includes("observer.inactivity-overdrive-block")) {
    add("Status", details.overdriveBlocked ? "Overdrive remains manual." : "Input resumed.");
    add("Mode change", [plainMode(details.from), plainMode(details.to || details.restoreTarget)].filter(Boolean).join(" -> "));
    add("App response", details.overdriveBlocked ? "Restored Balanced; Overdrive requires a direct user choice." : "Restored the remembered mode.");
  } else if (action.includes("observer.auto-apply") || action.includes("mode.apply")) {
    add("Mode change", [plainMode(details.from), plainMode(details.to)].filter(Boolean).join(" -> "));
    add("Reason", details.reason || details.health);
  } else if (action.includes("selfheal.power-plan") || action.includes("observer.band-first")) {
    add("Power plan", details.resolvedPlan || details.plan || details.actual || details.expected);
    add("Reason", details.guard || details.reason);
  } else if (action.includes("observer.mode-stability-hold")) {
    add("Pending change", [plainMode(details.currentMode), plainMode(details.pendingTarget)].filter(Boolean).join(" -> "));
    add("Status", `${details.confirmations || 0}/${details.minConfirmations || 2} confirmations`);
  } else if (action.includes("memory.release")) {
    add("Result", details.freedMB !== undefined ? `Freed ${details.freedMB} MB of reclaimable memory.` : entry.message);
  } else if (action.includes("cpu.relief")) {
    add("Result", details.easedPct !== undefined ? `CPU eased by ${details.easedPct} points.` : entry.message);
  } else {
    add("Status", entry.level === "warn" ? "Needs review" : "Recorded");
  }

  add("Next step", "Continue monitoring. Raw JSON is available separately if detailed troubleshooting is needed.");
  return items.slice(0, 7);
}

function dayLabel(ts, now = new Date()) {
  const date = new Date(ts || Date.now());
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === start) return "Today";
  if (day === start - 24 * 60 * 60 * 1000) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function groupAudit(audit = [], now = new Date()) {
  const groups = new Map();
  for (const entry of audit) {
    const label = dayLabel(entry.ts, now);
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label).push(entry);
  }
  return [...groups.entries()];
}

function summaryCounts(audit = []) {
  const counts = { warn: 0, action: 0, info: 0, observe: 0 };
  for (const entry of audit) {
    const level = String(entry.level || "info");
    counts[level] = (counts[level] || 0) + 1;
  }
  return counts;
}

function renderEntry(entry = {}) {
  const f = friendly(entry);
  const when = entry.ts ? new Date(entry.ts).toLocaleString([], { hour: "numeric", minute: "2-digit" }) : "time unknown";
  const details = entryDetails(entry)
    .map((item) => `<div class="detail"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`)
    .join("");
  const tone = entry.level === "warn" ? "warn" : entry.level === "action" ? "action" : "info";
  return `
    <article class="entry ${tone}">
      <div class="entry-head">
        <span class="dot"></span>
        <div>
          <h3>${escapeHtml(f.title)}</h3>
          <p>${escapeHtml(f.why)}</p>
        </div>
        <time>${escapeHtml(when)}</time>
      </div>
      <dl>${details}</dl>
    </article>`;
}

export function renderReadableAuditExport({
  audit = [],
  windowDays = 6,
  generatedAt = new Date(),
  rawHref = `/api/audit?days=${windowDays}&format=json`
} = {}) {
  const counts = summaryCounts(audit);
  const grouped = groupAudit(audit, generatedAt);
  const groupHtml = grouped.length
    ? grouped.map(([label, entries]) => `
      <section class="day">
        <h2>${escapeHtml(label)} <span>${entries.length} entr${entries.length === 1 ? "y" : "ies"}</span></h2>
        ${entries.map(renderEntry).join("")}
      </section>`).join("")
    : '<section class="empty">No audit entries found for this window.</section>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PC Control Plane Audit Export</title>
  <style>
    :root { color-scheme: dark; --bg:#081015; --panel:#111c24; --line:#233544; --text:#e7f2f5; --muted:#9db0ba; --green:#55d85a; --amber:#f3bf2d; --blue:#59a8ff; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 Segoe UI, Arial, sans-serif; }
    main { max-width: 980px; margin: 0 auto; padding: 28px 18px 40px; }
    header { display: grid; gap: 12px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 28px; }
    p { margin: 0; color: var(--muted); }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .card, .entry, .empty { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .card strong { display: block; font-size: 20px; }
    .card span { color: var(--muted); }
    .raw-link { color: var(--blue); text-decoration: none; }
    .day { margin-top: 18px; }
    .day h2 { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin: 0 0 8px; font-size: 18px; }
    .day h2 span { color: var(--muted); font-size: 13px; font-weight: 500; }
    .entry { margin: 8px 0; }
    .entry-head { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; gap: 10px; align-items: start; }
    .entry h3 { margin: 0; font-size: 15px; }
    .entry time { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 50%; background: var(--blue); }
    .entry.action .dot { background: var(--green); }
    .entry.warn .dot { background: var(--amber); }
    dl { display: grid; gap: 6px; margin: 10px 0 0 24px; }
    .detail { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px; }
    dt { color: var(--muted); font-weight: 700; }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 720px) { .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .detail { grid-template-columns: 1fr; gap: 1px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>PC Control Plane Audit Export</h1>
      <p>Readable summary for the last ${escapeHtml(windowDays)} day${Number(windowDays) === 1 ? "" : "s"}, generated ${escapeHtml(generatedAt.toLocaleString())}. Technical JSON remains available for troubleshooting: <a class="raw-link" href="${escapeHtml(rawHref)}">open raw JSON</a>.</p>
      <div class="summary">
        <div class="card"><strong>${audit.length}</strong><span>Total entries</span></div>
        <div class="card"><strong>${counts.warn || 0}</strong><span>Warnings</span></div>
        <div class="card"><strong>${counts.action || 0}</strong><span>Actions</span></div>
        <div class="card"><strong>${(counts.info || 0) + (counts.observe || 0)}</strong><span>Informational</span></div>
      </div>
    </header>
    ${groupHtml}
  </main>
</body>
</html>`;
}
