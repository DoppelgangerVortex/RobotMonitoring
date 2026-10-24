// @ts-check
// Sensor agent dashboard. Plain browser JavaScript, no build step.

(() => {
  "use strict";

  const POLL_MS = 4000;
  const AUTO_ASSESS_MS = 60_000;
  const AUTO_BACKOFF_MS = 120_000;

  /** @typedef {"ok"|"watch"|"warning"|"critical"|"unknown"} Status */

  const S = {
    /** @type {any} */ data: null,
    /** @type {string} */ password: "",
    auto: true,
    assessing: false,
    /** @type {string|null} */ assessError: null,
    autoBlockedUntil: 0,
    /** @type {{role:"user"|"assistant", content:string, error?:boolean}[]} */ chat: [],
    chatBusy: false,
    ctxDirty: false,
    /** @type {string|null} */ fatal: null,
    /** @type {Map<string, [number, number][]>} */ series: new Map(),
    pollTimer: 0,
  };

  // ---------- Small helpers ----------

  /** @param {unknown} s */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

  /** @param {string} key @param {string} [fallback] */
  function load(key, fallback = "") {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  /** @param {string} key @param {string} value */
  function save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }

  /** @param {number} v */
  function fmtNum(v) {
    if (!Number.isFinite(v)) return String(v);
    const a = Math.abs(v);
    const digits = Number.isInteger(v) ? 0 : a >= 1000 ? 0 : a >= 100 ? 1 : 2;
    return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  }

  /** @param {number} ms */
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  /** @param {number} t */
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const ICONS = {
    ok: '<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z" fill="currentColor"/><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    watch: '<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z" fill="currentColor"/><path d="M8 4.6v3.6l2.2 1.4" fill="none" stroke="#1a1a1a" stroke-width="1.7" stroke-linecap="round"/>',
    warning: '<path d="M7.1 1.9a1 1 0 0 1 1.8 0l6.1 11.2a1 1 0 0 1-.9 1.5H1.9a1 1 0 0 1-.9-1.5Z" fill="currentColor"/><path d="M8 6v3.6" stroke="#1a1a1a" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="#1a1a1a"/>',
    critical: '<path d="M5.3 1h5.4L15 5.3v5.4L10.7 15H5.3L1 10.7V5.3Z" fill="currentColor"/><path d="M8 4.5v4.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.3" r="1.05" fill="#fff"/>',
    unknown: '<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z" fill="currentColor"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".95" fill="#fff"/>',
  };

  /** @param {Status} s @param {number} [size] */
  const icon = (s, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[s] || ICONS.unknown}</svg>`;

  /** @type {Record<Status,string>} */
  const OVERALL_LABEL = {
    ok: "All normal",
    watch: "Keep an eye on it",
    warning: "Needs attention",
    critical: "Act now",
    unknown: "Not sure yet",
  };
  /** @type {Record<Status,string>} */
  const SENSOR_LABEL = { ok: "Normal", watch: "Watch", warning: "Attention", critical: "Act now", unknown: "Unclear" };
  /** @type {Record<string,Status>} */
  const SEVERITY_STATUS = { info: "watch", warning: "warning", critical: "critical" };
  /** @type {Record<string,string>} */
  const SEVERITY_LABEL = { info: "Note", warning: "Warning", critical: "Critical" };

  /** @param {string} s @returns {Status} */
  const asStatus = (s) => (["ok", "watch", "warning", "critical", "unknown"].includes(s) ? /** @type {Status} */ (s) : "unknown");

  // ---------- API ----------

  /** @param {string} path @param {RequestInit} [init] */
  async function api(path, init = {}) {
    const headers = new Headers(init.headers);
    if (S.password) headers.set("x-app-password", S.password);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(path, { ...init, headers, cache: "no-store" });
    if (res.status === 401) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === "password_required") {
        showGate(S.password ? "That password didn't work." : "");
        throw new Error("password_required");
      }
    }
    return res;
  }

  /** @param {Response} res */
  async function errorText(res) {
    const body = await res.json().catch(() => null);
    return (body && body.error) || `Request failed (${res.status}).`;
  }

  // ---------- Layout ----------

  function shell() {
    const root = $("app");
    root.innerHTML = `
      <div class="app">
        <header class="topbar">
          <div class="brand">
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M1 11h4l2.5-6 4 12 3-9 1.5 3H21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Sensor agent
          </div>
          <div id="link" class="link" role="status"></div>
        </header>
        <div id="banners"></div>
        <section id="verdict" class="verdict s-unknown" aria-live="polite"></section>
        <div class="main">
          <section aria-labelledby="h-readings">
            <div class="section-head"><h2 id="h-readings">Readings</h2><span id="readings-note" class="section-note"></span></div>
            <div id="sensors" class="sensor-grid"></div>
          </section>
          <aside class="side">
            <section aria-labelledby="h-warnings">
              <div class="section-head"><h2 id="h-warnings">Warnings</h2></div>
              <div id="alerts"></div>
            </section>
            <section class="chat" aria-labelledby="h-chat">
              <div class="section-head"><h2 id="h-chat">Ask about your readings</h2></div>
              <div id="messages" class="messages" aria-live="polite"></div>
              <form id="composer" class="composer">
                <label for="ask" class="sr-only">Your question</label>
                <textarea id="ask" rows="1" placeholder="Why is the humidity climbing?"></textarea>
                <button class="btn" id="ask-btn" type="submit">Ask</button>
              </form>
            </section>
          </aside>
        </div>
        <div class="lower">
          <section class="setup" aria-labelledby="h-setup">
            <div class="section-head"><h2 id="h-setup">Your setup</h2></div>
            <p class="hint">Describe what's connected and where it is. The agent uses this to identify each sensor and to judge what's normal. For example: <code>Uno, DHT22 on pin 2 in a bedroom, capacitive soil sensor on A0 in a basil pot</code>.</p>
            <label for="ctx" class="sr-only">Setup description</label>
            <textarea id="ctx" maxlength="2000" placeholder="What board and sensors are you using, and where are they?"></textarea>
            <div class="row">
              <button class="btn quiet" id="ctx-save" type="button">Save setup</button>
              <span id="ctx-note" class="saved-note"></span>
            </div>
            <div id="questions"></div>
          </section>
          <section aria-labelledby="h-serial">
            <div class="section-head">
              <h2 id="h-serial">Serial log</h2>
              <button class="btn quiet" id="clear" type="button">Clear readings</button>
            </div>
            <pre id="log" class="log" tabindex="0" aria-label="Most recent serial lines"></pre>
          </section>
        </div>
      </div>`;

    $("ctx").addEventListener("input", () => {
      S.ctxDirty = true;
      $("ctx-note").textContent = "Unsaved changes";
    });
    $("ctx-save").addEventListener("click", saveContext);
    $("clear").addEventListener("click", clearReadings);
    $("composer").addEventListener("submit", (e) => {
      e.preventDefault();
      ask();
    });
    $("ask").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        ask();
      }
    });
    $("verdict").addEventListener("click", (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest("#assess-btn")) assess(true);
    });
    $("verdict").addEventListener("change", (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.id === "auto") {
        S.auto = t.checked;
        save("sa:auto", S.auto ? "1" : "0");
      }
    });
    $("messages").addEventListener("click", (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest("button[data-q]");
      if (b) {
        /** @type {HTMLTextAreaElement} */ ($("ask")).value = b.getAttribute("data-q") || "";
        ask();
      }
    });
    renderChat();
  }

  // ---------- Rendering ----------

  function render() {
    const d = S.data;
    if (!d) return;
    renderLink(d);
    renderBanners(d);
    renderVerdict(d);
    renderSensors(d);
    renderAlerts(d);
    renderSetup(d);
    renderLog(d);
  }

  /** @param {any} d */
  function renderLink(d) {
    const el = $("link");
    const last = d.window.lastT;
    const stale = d.signals.some((/** @type {any} */ s) => s.code === "stale");
    el.className = `link ${!last ? "" : stale ? "stale" : "live"}`;
    const text = !last
      ? "Waiting for the Arduino"
      : stale
        ? `No data <span class="label-long">since ${esc(clock(last))}</span>`
        : `Receiving <span class="label-long">· last line ${esc(ago(d.now - last))}</span>`;
    el.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${text}</span>`;
  }

  /** @param {any} d */
  function renderBanners(d) {
    const out = [];
    if (S.fatal) out.push(`<div class="banner error">${esc(S.fatal)}</div>`);
    if (!d.apiKeyConfigured)
      out.push(
        `<div class="banner">The agent can't assess readings yet: set <code>ANTHROPIC_API_KEY</code> in your environment variables, then restart or redeploy.</div>`,
      );
    if (d.storageEphemeral)
      out.push(
        `<div class="banner">Readings aren't being saved between requests. Add an Upstash Redis database to this Vercel project (Storage tab), then redeploy.</div>`,
      );
    if (S.assessError) out.push(`<div class="banner error">Couldn't check the readings: ${esc(S.assessError)}</div>`);
    $("banners").innerHTML = out.join("");
  }

  /** @param {any} d */
  function renderVerdict(d) {
    const el = $("verdict");
    const a = d.assessment;
    const n = d.window.dataCount;
    /** @type {Status} */
    let status = "unknown";
    let label = OVERALL_LABEL.unknown;
    let headline;
    let summary;
    if (a) {
      status = asStatus(a.overall_status);
      label = OVERALL_LABEL[status];
      headline = a.headline;
      summary = a.summary;
    } else if (!d.window.lastT) {
      headline = "Waiting for the first readings";
      summary =
        "Plug in the Arduino and start the bridge script on that computer. Readings appear here within a few seconds, and the agent checks them automatically.";
    } else if (S.assessing) {
      headline = "Checking your readings";
      summary = "The agent is working out which sensors these are and whether the values look right.";
    } else {
      headline = `${n} reading${n === 1 ? "" : "s"} in. Ready to check them.`;
      summary = d.apiKeyConfigured
        ? "The first check runs automatically once a few readings arrive, or you can start it now."
        : "Add your Claude API key to let the agent check them.";
    }

    const meta = a
      ? `<span>Checked ${esc(ago(d.now - a.generatedAt))}</span><span>from ${esc(a.readingCount)} lines</span>`
      : "";
    const canAssess = d.apiKeyConfigured && !!d.window.lastT;
    el.className = `verdict s-${status}`;
    // Keep the checkbox focus stable by only replacing content when it changes.
    const html = `
      <div class="state">${icon(status, 18)}<span>${esc(label)}</span></div>
      <h1>${esc(headline)}</h1>
      <p class="summary">${esc(summary)}</p>
      <div class="controls">
        <button class="btn" id="assess-btn" type="button" ${!canAssess || S.assessing ? "disabled" : ""}>${S.assessing ? "Checking…" : a ? "Check again" : "Check readings"}</button>
        <label class="toggle"><input type="checkbox" id="auto" ${S.auto ? "checked" : ""}> Check automatically</label>
        <div class="meta">${meta}</div>
      </div>`;
    if (el.dataset.html !== html) {
      const hadFocus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : "";
      el.innerHTML = html;
      el.dataset.html = html;
      if (hadFocus) document.getElementById(hadFocus)?.focus();
    }
  }

  /** @param {any} d */
  function renderSensors(d) {
    const el = $("sensors");
    const a = d.assessment;
    /** @type {Map<string, any>} */
    const byField = new Map((a?.sensors || []).map((/** @type {any} */ s) => [s.field, s]));
    $("readings-note").textContent = d.stats.length
      ? `${d.stats.length} field${d.stats.length === 1 ? "" : "s"}, last ${d.window.dataCount} lines`
      : "";

    if (!d.stats.length) {
      el.innerHTML = `
        <div class="empty">
          No numbers yet. To start:
          <ol>
            <li>Upload a sketch that prints one line per reading, like <code>temp=23.4,hum=51</code>.</li>
            <li>Run the bridge on the computer the Arduino is plugged into: <code>npm start</code> in the <code>bridge</code> folder.</li>
            <li>Describe your setup below so the agent knows what it's looking at.</li>
          </ol>
        </div>`;
      return;
    }

    S.series = new Map();
    el.innerHTML = d.stats
      .map((/** @type {any} */ s) => {
        S.series.set(s.key, s.series);
        const info = byField.get(s.key);
        const status = info ? asStatus(info.status) : null;
        const unit = info && info.unit && info.unit !== "raw" ? info.unit : s.unit || (info?.unit === "raw" ? "raw" : "");
        const name = info?.likely_sensor || s.key;
        const flags = d.signals.filter((/** @type {any} */ g) => g.field === s.key && g.severity === "warning");
        const trend = Math.abs(s.slopePerMin) < Math.max(s.std * 0.05, 1e-9) ? "Steady" : `${s.slopePerMin > 0 ? "+" : ""}${fmtNum(s.slopePerMin)}/min`;
        return `
          <article class="gauge ${status ? `s-${status}` : ""}" data-key="${esc(s.key)}">
            <header>
              <h3>${esc(name)}</h3>
              ${name !== s.key ? `<span class="key">${esc(s.key)}</span>` : ""}
            </header>
            <div class="reading">
              <div class="value">${esc(fmtNum(s.latest))}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
              ${status ? `<div class="state">${icon(status)}<span>${esc(SENSOR_LABEL[status])}</span></div>` : ""}
            </div>
            <div class="spark" data-key="${esc(s.key)}">${sparkline(s)}</div>
            <dl class="range">
              <div><dt>Low</dt><dd>${esc(fmtNum(s.min))}</dd></div>
              <div><dt>High</dt><dd>${esc(fmtNum(s.max))}</dd></div>
              <div><dt>Trend</dt><dd>${esc(trend)}</dd></div>
            </dl>
            ${flags.map((/** @type {any} */ f) => `<p class="flag">${icon("warning", 14)}<span>${esc(f.message)}</span></p>`).join("")}
            ${info?.explanation ? `<p class="explain">${esc(info.explanation)}</p>` : ""}
          </article>`;
      })
      .join("");
  }

  /** @param {any} s */
  function sparkline(s) {
    const pts = /** @type {[number, number][]} */ (s.series);
    const label = `${s.key}: latest ${fmtNum(s.latest)}, low ${fmtNum(s.min)}, high ${fmtNum(s.max)} over the last ${s.count} readings`;
    if (pts.length < 2) return `<svg viewBox="0 0 300 56" role="img" aria-label="${esc(label)}"><line class="base" x1="0" y1="55" x2="300" y2="55"/></svg>`;
    const { x, y } = scales(pts);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    const area = `${line}L${x(pts[pts.length - 1][0]).toFixed(1)},56L${x(pts[0][0]).toFixed(1)},56Z`;
    return `<svg viewBox="0 0 300 56" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
      <path class="area" d="${area}"/>
      <line class="base" x1="0" y1="55.5" x2="300" y2="55.5"/>
      <path class="line" d="${line}"/>
    </svg>`;
  }

  /** @param {[number, number][]} pts */
  function scales(pts) {
    const t0 = pts[0][0];
    const t1 = pts[pts.length - 1][0];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
    }
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    return {
      x: (/** @type {number} */ t) => (t1 === t0 ? 150 : ((t - t0) / (t1 - t0)) * 300),
      y: (/** @type {number} */ v) => 56 - ((v - lo) / (hi - lo)) * 56,
    };
  }

  // Hover: crosshair-style marker and tooltip on the nearest point.
  /** @param {PointerEvent} e */
  function onSparkMove(e) {
    const box = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.(".spark"));
    document.querySelectorAll(".spark .marker, .spark .tip").forEach((n) => {
      if (!box || !box.contains(n)) n.remove();
    });
    if (!box) return;
    const key = box.getAttribute("data-key") || "";
    const pts = S.series.get(key);
    if (!pts || pts.length < 2) return;
    const rect = box.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const { x, y } = scales(pts);
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(x(p[0]) / 300 - fx);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    const px = (x(best[0]) / 300) * rect.width;
    const py = (y(best[1]) / 56) * rect.height;
    let marker = /** @type {HTMLElement|null} */ (box.querySelector(".marker"));
    let tip = /** @type {HTMLElement|null} */ (box.querySelector(".tip"));
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "marker";
      box.appendChild(marker);
    }
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip";
      box.appendChild(tip);
    }
    marker.style.left = `${px}px`;
    marker.style.top = `${py}px`;
    const unit = /** @type {HTMLElement|null} */ (box.closest(".gauge")?.querySelector(".unit") ?? null)?.textContent || "";
    tip.innerHTML = `<b>${esc(fmtNum(best[1]))}${unit ? ` ${esc(unit)}` : ""}</b> at ${esc(clock(best[0]))}`;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(rect.width - half, Math.max(half, px))}px`;
  }

  /** @param {any} d */
  function renderAlerts(d) {
    const el = $("alerts");
    const a = d.assessment;
    const agent = (a?.warnings || []).map((/** @type {any} */ w) => {
      const st = SEVERITY_STATUS[w.severity] || "watch";
      return `
        <li class="alert s-${st}">
          <div class="state">${icon(/** @type {Status} */ (st), 14)}<span>${esc(SEVERITY_LABEL[w.severity] || "Note")}</span></div>
          <h3>${esc(w.title)}</h3>
          ${w.detail ? `<p>${esc(w.detail)}</p>` : ""}
          ${w.action ? `<p class="action"><b>What to do:</b> ${esc(w.action)}</p>` : ""}
        </li>`;
    });
    // Per-sensor flags already appear on each reading panel; list the rest here.
    const shown = new Set(d.stats.map((/** @type {any} */ s) => s.key));
    const checks = d.signals.filter((/** @type {any} */ s) => !s.field || !shown.has(s.field)).map(
      (/** @type {any} */ s) => `
        <li class="flag">${icon(s.severity === "warning" ? "warning" : "watch", 14)}<span>${esc(s.message)}</span></li>`,
    );

    let html = "";
    if (agent.length) html += `<ul class="alert-list">${agent.join("")}</ul>`;
    else if (a) html += `<p class="quiet-note">The agent found nothing that needs attention.</p>`;
    else html += `<p class="quiet-note">Warnings from the agent show up here after the first check.</p>`;
    if (checks.length) html += `<div class="checks"><h3>Automatic checks</h3><ul>${checks.join("")}</ul></div>`;
    if (a?.data_quality?.length)
      html += `<div class="checks"><h3>Data quality</h3><ul>${a.data_quality
        .map((/** @type {string} */ q) => `<li class="flag">${icon("unknown", 14)}<span>${esc(q)}</span></li>`)
        .join("")}</ul></div>`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
  }

  /** @param {any} d */
  function renderSetup(d) {
    const ta = /** @type {HTMLTextAreaElement} */ ($("ctx"));
    if (!S.ctxDirty && document.activeElement !== ta && ta.value !== d.context) ta.value = d.context || "";
    const qs = d.assessment?.questions || [];
    const html = qs.length
      ? `<div class="questions"><h3>The agent would like to know</h3><ul>${qs.map((/** @type {string} */ q) => `<li>${esc(q)}</li>`).join("")}</ul></div>`
      : "";
    const el = $("questions");
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
  }

  /** @param {any} d */
  function renderLog(d) {
    const el = $("log");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    el.innerHTML = d.log.length
      ? d.log
          .map((/** @type {any} */ r) => `<span class="t">${esc(clock(r.t))}</span><span class="${r.kind === "message" ? "m" : ""}">${esc(r.raw)}</span>`)
          .join("\n")
      : "Nothing received yet.";
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function renderChat() {
    const el = $("messages");
    if (!S.chat.length) {
      const qs = ["What sensors do I have?", "Is anything wrong with my wiring?", "Explain what the readings mean"];
      el.innerHTML = `
        <p class="quiet-note">Ask anything about the live readings. The agent sees the same data as this page.</p>
        <div class="suggestions">${qs.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
      return;
    }
    el.innerHTML = S.chat
      .map((m) => `<div class="msg ${m.error ? "error" : m.role}">${esc(m.content || (m.role === "assistant" ? "…" : ""))}</div>`)
      .join("");
    el.scrollTop = el.scrollHeight;
  }

  // ---------- Actions ----------

  async function poll() {
    clearTimeout(S.pollTimer);
    try {
      const res = await api("/api/state");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        S.fatal = body.error || `The server returned ${res.status}.`;
        if (S.data) renderBanners(S.data);
        else showFatal(S.fatal || "");
      } else {
        S.fatal = null;
        S.data = await res.json();
        if (!$("verdict")) shell();
        render();
        maybeAutoAssess();
      }
    } catch (e) {
      if (/** @type {Error} */ (e).message === "password_required") return;
      S.fatal = "Can't reach the server. Retrying…";
      if (S.data) renderBanners(S.data);
    }
    if (document.visibilityState === "visible") S.pollTimer = window.setTimeout(poll, POLL_MS);
  }

  function maybeAutoAssess() {
    const d = S.data;
    if (!S.auto || S.assessing || !d || !d.apiKeyConfigured || Date.now() < S.autoBlockedUntil) return;
    const a = d.assessment;
    const lastT = d.window.lastT;
    if (!lastT) return;
    const warnCount = d.signals.filter((/** @type {any} */ s) => s.severity === "warning").length;
    if (!a) {
      if (d.window.dataCount >= 5 || d.window.count >= 10) assess(false);
      return;
    }
    const newData = lastT > a.basedOnT;
    if (newData && (d.now - a.generatedAt >= AUTO_ASSESS_MS || warnCount > a.localWarnCount)) assess(false);
  }

  /** @param {boolean} force */
  async function assess(force) {
    if (S.assessing) return;
    S.assessing = true;
    S.assessError = null;
    render();
    try {
      const res = await api("/api/assess", { method: "POST", body: JSON.stringify({ force }) });
      if (!res.ok) throw new Error(await errorText(res));
      const body = await res.json();
      if (S.data) S.data.assessment = body.assessment;
    } catch (e) {
      const msg = /** @type {Error} */ (e).message;
      if (msg !== "password_required") {
        S.assessError = msg;
        S.autoBlockedUntil = Date.now() + AUTO_BACKOFF_MS;
      }
    } finally {
      S.assessing = false;
      render();
    }
  }

  async function saveContext() {
    const ta = /** @type {HTMLTextAreaElement} */ ($("ctx"));
    const note = $("ctx-note");
    note.textContent = "Saving…";
    try {
      const res = await api("/api/context", { method: "PUT", body: JSON.stringify({ text: ta.value }) });
      if (!res.ok) throw new Error(await errorText(res));
      S.ctxDirty = false;
      if (S.data) S.data.context = ta.value.trim();
      note.textContent = "Saved. Rechecking with your description…";
      if (S.data?.window.lastT && S.data.apiKeyConfigured) {
        await assess(false);
        note.textContent = "Saved";
      } else note.textContent = "Saved";
    } catch (e) {
      note.textContent = `Couldn't save: ${/** @type {Error} */ (e).message}`;
    }
  }

  async function clearReadings() {
    if (!confirm("Clear all stored readings and the last assessment? This can't be undone.")) return;
    try {
      const res = await api("/api/readings", { method: "DELETE" });
      if (!res.ok) throw new Error(await errorText(res));
      poll();
    } catch (e) {
      alert(`Couldn't clear readings: ${/** @type {Error} */ (e).message}`);
    }
  }

  async function ask() {
    const ta = /** @type {HTMLTextAreaElement} */ ($("ask"));
    const q = ta.value.trim();
    if (!q || S.chatBusy) return;
    ta.value = "";
    S.chatBusy = true;
    $("ask-btn").setAttribute("disabled", "");
    S.chat.push({ role: "user", content: q });
    const reply = { role: /** @type {"assistant"} */ ("assistant"), content: "", error: false };
    S.chat.push(reply);
    renderChat();
    try {
      const history = S.chat.filter((m) => !m.error && m !== reply).map(({ role, content }) => ({ role, content }));
      const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ messages: history }) });
      if (!res.ok || !res.body) throw new Error(await errorText(res));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.content += dec.decode(value, { stream: true });
        renderChat();
      }
      if (!reply.content.trim()) throw new Error("The agent returned an empty answer.");
    } catch (e) {
      const msg = /** @type {Error} */ (e).message;
      reply.error = true;
      reply.content = msg === "password_required" ? "Enter the dashboard password first." : `Couldn't get an answer: ${msg}`;
    } finally {
      S.chatBusy = false;
      $("ask-btn").removeAttribute("disabled");
      renderChat();
      ta.focus();
    }
  }

  // ---------- Password gate & fatal errors ----------

  /** @param {string} err */
  function showGate(err) {
    clearTimeout(S.pollTimer);
    const root = $("app");
    root.innerHTML = `
      <form class="gate" id="gate">
        <h1>Sensor agent</h1>
        <p>Enter the dashboard password. It's the <code>APP_PASSWORD</code> you set when deploying.</p>
        ${err ? `<p class="err">${esc(err)}</p>` : ""}
        <label for="pw" class="sr-only">Password</label>
        <input id="pw" type="password" autocomplete="current-password" required>
        <button class="btn" type="submit">Open dashboard</button>
      </form>`;
    /** @type {HTMLInputElement} */ ($("pw")).focus();
    $("gate").addEventListener("submit", (e) => {
      e.preventDefault();
      S.password = /** @type {HTMLInputElement} */ ($("pw")).value;
      save("sa:pw", S.password);
      S.data = null;
      poll();
    });
  }

  /** @param {string} msg */
  function showFatal(msg) {
    $("app").innerHTML = `<div class="gate"><h1>Sensor agent</h1><p>${esc(msg)}</p><button class="btn" type="button" id="retry">Try again</button></div>`;
    $("retry").addEventListener("click", () => poll());
  }

  // ---------- Start ----------

  function start() {
    S.password = load("sa:pw");
    S.auto = load("sa:auto", "1") === "1";
    document.addEventListener("pointermove", onSparkMove);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") poll();
      else clearTimeout(S.pollTimer);
    });
    poll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
