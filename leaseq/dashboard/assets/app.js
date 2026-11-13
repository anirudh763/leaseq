"use strict";
/* leaseq operations dashboard. Plain JavaScript, no build step, no third-party code.

   Security notes
   * Everything the API returns (kinds, payloads, results, error text, worker ids)
     was written by API clients, so it is untrusted. It reaches the page only via
     textContent / createTextNode, never as HTML.
   * The API token is sent only in the Authorization header of fetch() calls this
     page makes. It is never stored in a cookie, so the browser never attaches it
     to a request that another site triggers: there is no CSRF surface. It is kept
     only in this page's memory: never in a cookie, localStorage, sessionStorage or
     the URL. Reloading the page or choosing "Forget token" drops it.
   * Requeue and cancel buttons exist only while a token that the server accepted
     (GET /auth/check) is set, and each action asks for confirmation first. The
     server checks the token on every request regardless of what this page shows.
*/

const REFRESH_MS = 2000;
const PAGE = 50;
const MAX_ROWS = 200;            // the API's page cap

const TABS = [
  { id: "", label: "All", count: (c) => c.total },
  { id: "queued", label: "Queued", count: (c) => c.queued },
  { id: "leased", label: "Running", count: (c) => c.leased },
  { id: "retrying", label: "Retrying", count: (c) => c.retrying },
  { id: "done", label: "Done", count: (c) => c.done },
  { id: "dead", label: "Dead", count: (c) => c.dead },
];

const app = {
  filters: { state: "", kind: "", worker: "" },
  jobId: null,
  rows: PAGE,
  paused: false,
  token: null,
  authGen: 0,          // bumped whenever the token changes; older responses are dropped
  inflight: false,
  lastUpdate: null,
  job: null,
  returnFocusTo: null,
};

const $ = (id) => document.getElementById(id);

/* ---------- small DOM helpers (text only) ---------- */

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";   // an XML namespace name; nothing is fetched
const ICONS = {
  queued: [["circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }]],
  leased: [["circle", { cx: 8, cy: 8, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }],
           ["circle", { cx: 8, cy: 8, r: 2.6, fill: "currentColor" }]],
  retrying: [["path", { d: "M12.6 9.2A4.8 4.8 0 1 1 11 4.4M11.6 1.8v3h-3", fill: "none", stroke: "currentColor",
                        "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }]],
  done: [["path", { d: "M3.2 8.6l3 3 6.6-7.2", fill: "none", stroke: "currentColor", "stroke-width": 1.8,
                    "stroke-linecap": "round", "stroke-linejoin": "round" }]],
  dead: [["path", { d: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6", fill: "none", stroke: "currentColor",
                    "stroke-width": 1.8, "stroke-linecap": "round" }]],
  all: [["path", { d: "M2.5 4h11M2.5 8h11M2.5 12h11", fill: "none", stroke: "currentColor",
                   "stroke-width": 1.6, "stroke-linecap": "round" }]],
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attrs] of ICONS[name] || []) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));
    svg.append(shape);
  }
  return svg;
}

/* A job's display state: "retrying" is a queued job that has already been tried. */
function displayState(job) {
  if (job.state === "queued" && job.attempts > 0) return "retrying";
  return job.state;
}
const STATE_LABEL = { queued: "Queued", leased: "Running", retrying: "Retrying", done: "Done", dead: "Dead" };

function stateBadge(job) {
  const s = displayState(job);
  return el("span", { class: `state ${s}` }, icon(s), el("span", { text: STATE_LABEL[s] || s }));
}

function fmtAbs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtRel(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const a = Math.abs(s);
  const v = a < 60 ? `${a} s` : a < 3600 ? `${Math.round(a / 60)} min` :
            a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return s >= 0 ? `${v} ago` : `in ${v}`;
}
function timeEl(iso, relative = true) {
  if (!iso) return el("span", { class: "muted", text: "none" });
  return el("time", { datetime: iso, title: fmtAbs(iso), "data-rel": relative ? "1" : null,
                      text: relative ? fmtRel(iso) : fmtAbs(iso) });
}
function clockEl(iso) {
  return el("time", { class: "mono", datetime: iso, title: fmtAbs(iso),
                      text: new Date(iso).toLocaleTimeString(undefined, { hour12: false }) });
}
function refreshRelativeTimes() {
  for (const t of document.querySelectorAll("time[data-rel]")) t.textContent = fmtRel(t.dateTime);
}

function announce(msg) {
  const s = $("status");
  s.textContent = "";
  window.setTimeout(() => { s.textContent = msg; }, 50);
}

/* ---------- token (memory only) ---------- */

function saveToken(t) {
  app.token = t || null;
  app.authGen += 1;
  renderTokenControls();
}

/* ---------- API ---------- */

async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "omit",
    cache: "no-store",
  });
  let body = null;
  if (res.status !== 204) {
    try { body = await res.json(); } catch (e) { body = null; }
  }
  return { status: res.status, body };
}

function detailText(body) {
  if (!body) return "";
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) return body.detail.map((d) => d.msg).join("; ");
  return "";
}

/* ---------- URL state ---------- */

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  const st = p.get("state") || "";
  app.filters.state = TABS.some((t) => t.id === st) ? st : "";
  app.filters.kind = p.get("kind") || "";
  app.filters.worker = p.get("worker") || "";
  const j = p.get("job");
  app.jobId = j && /^[0-9]{1,19}$/.test(j) ? j : null;
  $("f-kind").value = app.filters.kind;
  $("f-worker").value = app.filters.worker;
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (app.filters.state) p.set("state", app.filters.state);
  if (app.filters.kind) p.set("kind", app.filters.kind);
  if (app.filters.worker) p.set("worker", app.filters.worker);
  if (app.jobId) p.set("job", app.jobId);
  const qs = p.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : "");
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

/* ---------- tabs ---------- */

function buildTabs() {
  const list = $("tabs");
  for (const t of TABS) {
    const b = el("button", { type: "button", role: "tab", class: "tab", id: `tab-${t.id || "all"}`,
                             "aria-controls": "jobs-panel", "data-state": t.id },
                 icon(t.id || "all"), el("span", { text: t.label }),
                 el("span", { class: "count", "data-count": t.id || "all", text: NO_COUNT }));
    b.addEventListener("click", () => selectTab(t.id, false));
    list.append(b);
  }
  list.addEventListener("keydown", (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      selectTab(next.dataset.state, true);
    }
  });
}

// Shown instead of a number until the server has answered with counts
// (for example while it is waiting for the token), so "0" is never a guess.
const NO_COUNT = "\u2013";

function clearCounts() {
  for (const c of document.querySelectorAll("[data-count]")) c.textContent = NO_COUNT;
}

function renderTabs(counts) {
  for (const t of TABS) {
    const b = $(`tab-${t.id || "all"}`);
    const selected = t.id === app.filters.state;
    b.setAttribute("aria-selected", selected ? "true" : "false");
    b.tabIndex = selected ? 0 : -1;
    if (counts) b.querySelector(".count").textContent = String(t.count(counts));
  }
  $("jobs-panel").setAttribute("aria-labelledby", `tab-${app.filters.state || "all"}`);
}

function selectTab(id, focus) {
  app.filters.state = id;
  app.rows = PAGE;
  writeUrl(true);
  renderTabs(null);
  if (focus) $(`tab-${id || "all"}`).focus();
  refresh();
}

/* ---------- job table ---------- */

function renderRows(jobs, counts) {
  const tbody = $("rows");
  const focusedJob = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.job : undefined;
  tbody.replaceChildren();
  if (jobs.length === 0) {
    tbody.append(el("tr", {}, el("td", { colspan: 7, class: "empty" }, ...emptyState(counts))));
  }
  for (const job of jobs) {
    const id = String(job.id);
    const open = el("button", { type: "button", class: "linkish", "data-job": id,
                                "aria-current": app.jobId === id ? "true" : null },
                    el("span", { class: "sr-only", text: "Job " }), id);
    open.addEventListener("click", () => openJob(id, open));
    tbody.append(el("tr", { class: app.jobId === id ? "selected" : null },
      el("td", {}, open),
      el("td", { text: job.kind }),
      el("td", {}, stateBadge(job)),
      el("td", { class: "mono", text: `${job.attempts} / ${job.max_attempts}` }),
      el("td", { class: "mono" }, job.leased_by ? job.leased_by : el("span", { class: "muted", text: "none" })),
      el("td", {}, timeEl(job.updated_at)),
      el("td", { class: "mono key", title: job.idempotency_key, text: job.idempotency_key })));
  }
  if (focusedJob) {
    const again = tbody.querySelector(`button[data-job="${CSS.escape(focusedJob)}"]`);
    if (again) again.focus();
  }
}

function emptyState(counts) {
  const filtered = app.filters.state || app.filters.kind || app.filters.worker;
  if (filtered && counts && counts.total > 0) {
    const clear = el("button", { type: "button", class: "btn", text: "Clear filters" });
    clear.addEventListener("click", clearFilters);
    return [el("p", { text: "No jobs match these filters." }), clear];
  }
  const parts = [el("p", { text: "No jobs yet." }),
                 el("p", { class: "muted" }, "Run ", el("code", { text: "python -m leaseq.demo" }),
                    " to enqueue sample jobs", app.token ? ", or add them from here." :
                    ", or enter the API token to add them from here.")];
  if (app.token) {
    const b = el("button", { type: "button", class: "btn primary", id: "load-sample",
                             text: "Load sample jobs" });
    b.addEventListener("click", loadSample);
    parts.push(b);
  }
  return parts;
}

async function loadSample() {
  const r = await api("/demo/jobs", { method: "POST" });
  if (r.status === 201) announce(`Loaded ${r.body.enqueued} sample jobs.`);
  else handleActionError(r);
  refresh();
}

/* ---------- details panel ---------- */

function openJob(id, trigger) {
  app.jobId = String(id);
  app.returnFocusTo = trigger || null;
  writeUrl(true);
  showPanel(true);
  refresh().then(() => $("detail-title").focus());
}

function closeJob() {
  const back = app.jobId;
  app.jobId = null;
  app.job = null;
  writeUrl(true);
  showPanel(false);
  refresh();
  const btn = document.querySelector(`button[data-job="${CSS.escape(back || "")}"]`) || app.returnFocusTo;
  if (btn && document.body.contains(btn)) btn.focus();
  else $("jobs-panel").focus();
}

// Drop everything the details panel shows and close it: used when the token is
// forgotten or the server stops accepting it, so no job data stays on screen.
// The selected job id (also in the URL) is kept, so the panel comes back once
// reads succeed again.
function clearDetail() {
  app.job = null;
  for (const id of ["detail-fields", "detail-actions", "detail-state", "lease-rows", "events"]) {
    $(id).replaceChildren();
  }
  $("detail-title").textContent = "Job";
  $("payload").textContent = "";
  $("result").textContent = "";
  $("events-more").hidden = true;
  showPanel(false);
}

// Remove every piece of job data from the page at once: counts, table rows,
// the demo note and the details panel. Used on "Forget token" (immediately,
// not on the next poll) and whenever the server answers 401.
function clearJobData() {
  clearCounts();
  $("rows").replaceChildren();
  $("shown").textContent = "";
  $("more").hidden = true;
  $("demo-note").hidden = true;
  $("expired-note").hidden = true;
  clearDetail();
}

function showPanel(open) {
  $("detail").hidden = !open;
  document.querySelector(".split").classList.toggle("open", open);
}

function renderJob(job, events, more) {
  app.job = job;
  $("detail-title").textContent = `Job ${job.id}`;
  $("detail-state").replaceChildren(stateBadge(job));

  const f = $("detail-fields");
  f.replaceChildren();
  const add = (k, v) => f.append(el("dt", { text: k }), el("dd", {}, v));
  add("Kind", job.kind);
  add("Attempts", el("span", { class: "mono", text: `${job.attempts} of ${job.max_attempts}` }));
  add("Last worker", job.leased_by ? el("span", { class: "mono", text: job.leased_by }) : el("span", { class: "muted", text: "none" }));
  add("Lease expires", timeEl(job.lease_expires_at));
  add("Run after", timeEl(job.run_after));
  add("Idempotency key", el("span", { class: "mono", text: job.idempotency_key }));
  add("Created", timeEl(job.created_at, false));
  add("Updated", timeEl(job.updated_at, false));

  renderActions(job);
  renderLeases(job, events);

  const list = $("events");
  list.replaceChildren();
  for (const e of events) list.append(eventItem(e));
  $("events-more").hidden = !more;
  $("events-more").textContent = more ? "Showing the first 500 events." : "";

  $("payload").textContent = JSON.stringify(job.payload, null, 2);
  $("result").textContent = job.result === null ? "none" : JSON.stringify(job.result, null, 2);
}

const EVENT_LABEL = {
  enqueued: "Enqueued", claimed: "Claimed", completed: "Completed", failed: "Failed",
  dead: "Dead", rejected: "Rejected a call with an old lease token", requeued: "Requeued by operator",
  cancelled: "Cancelled by operator",
};

function eventItem(e) {
  const bits = [];
  if (e.worker_id) bits.push(`worker ${e.worker_id}`);
  bits.push(`attempt ${e.attempt}`);
  const extra = Object.keys(e.detail || {}).length ? JSON.stringify(e.detail) : "";
  return el("li", {},
    Object.assign(clockEl(e.created_at), { className: "when" }),
    el("span", {}, el("span", { class: "what", text: EVENT_LABEL[e.event] || e.event }),
       el("span", { class: "muted", text: `, ${bits.join(", ")}` })),
    extra ? el("span", { class: "extra", text: extra }) : null);
}

/* One row per claim; the outcome is the first ending event after it. */
function leaseHistory(job, events) {
  const rows = [];
  for (const e of events) {
    const cur = rows[rows.length - 1];
    if (e.event === "claimed") {
      if (cur && !cur.outcome) {
        cur.outcome = { tone: "retrying", text: `Lease expired; ${e.worker_id} took the job over` };
      }
      rows.push({ attempt: e.attempt, worker: e.worker_id, at: e.created_at,
                  lease: e.detail && e.detail.lease_seconds, outcome: null, rejected: 0 });
    } else if (cur) {
      if (e.event === "rejected") cur.rejected += 1;
      else if (!cur.outcome && e.event === "completed") cur.outcome = { tone: "done", text: "Completed" };
      else if (!cur.outcome && e.event === "failed") {
        cur.outcome = { tone: "retrying", text: `Failed: ${e.detail.error || "no message"}. Retry in ${e.detail.retry_in_seconds} s` };
      } else if (!cur.outcome && e.event === "dead") {
        cur.outcome = { tone: "dead", text: `Dead: ${e.detail.error || e.detail.reason || "out of attempts"}` };
      } else if (!cur.outcome && e.event === "cancelled") {
        cur.outcome = { tone: "dead", text: "Cancelled by operator" };
      }
    }
  }
  const last = rows[rows.length - 1];
  if (last && !last.outcome && job.state === "leased") {
    last.outcome = { tone: "leased", text: "Running", until: job.lease_expires_at };
  }
  return rows;
}

function renderLeases(job, events) {
  const tbody = $("lease-rows");
  tbody.replaceChildren();
  const rows = leaseHistory(job, events);
  if (rows.length === 0) {
    tbody.append(el("tr", {}, el("td", { colspan: 5, class: "muted", text: "Not claimed yet." })));
    return;
  }
  for (const r of rows) {
    const outcome = el("td", { class: "outcome" });
    if (r.outcome) {
      outcome.append(el("span", { class: `state ${r.outcome.tone}` }, icon(r.outcome.tone),
                        el("span", { text: r.outcome.text })));
      if (r.outcome.until) outcome.append(" until ", timeEl(r.outcome.until));
    } else {
      outcome.append(el("span", { class: "muted", text: "No report" }));
    }
    if (r.rejected) {
      outcome.append(el("div", { class: "muted",
        text: `${r.rejected} call${r.rejected > 1 ? "s" : ""} with an old token rejected` }));
    }
    tbody.append(el("tr", {},
      el("td", { class: "mono", text: String(r.attempt) }),
      el("td", { class: "mono", text: r.worker || "" }),
      el("td", {}, clockEl(r.at)),
      el("td", { class: "mono", text: r.lease ? `${r.lease} s` : "" }),
      outcome));
  }
}

function renderActions(job) {
  const box = $("detail-actions");
  box.replaceChildren();
  if (!app.token) return;                 // read-only: no operator buttons at all
  if (job.state === "dead") {
    const b = el("button", { type: "button", class: "btn", id: "requeue", text: "Requeue job" });
    b.addEventListener("click", () => confirmAction("requeue", job, b));
    box.append(b);
  }
  if (job.state === "queued" || job.state === "leased") {
    const b = el("button", { type: "button", class: "btn danger", id: "cancel", text: "Cancel job" });
    b.addEventListener("click", () => confirmAction("cancel", job, b));
    box.append(b);
  }
  if (!box.children.length) {
    box.append(el("p", { class: "muted small", text: "Finished jobs cannot be requeued or cancelled." }));
  }
}

/* ---------- operator actions ---------- */

function confirmAction(kind, job, trigger) {
  const d = $("confirm-dialog");
  const yes = $("confirm-yes");
  if (kind === "requeue") {
    $("confirm-title").textContent = `Requeue job ${job.id}?`;
    $("confirm-text").textContent = `It goes back to the queue with 3 more attempts. ` +
      `Its attempt count (${job.attempts}) and audit history are kept.`;
    yes.textContent = "Requeue job";
    yes.className = "btn primary";
    $("confirm-no").textContent = "Keep as dead";
  } else {
    $("confirm-title").textContent = `Cancel job ${job.id}?`;
    $("confirm-text").textContent = job.state === "leased"
      ? `It becomes dead now. Worker ${job.leased_by} is still running it; when it reports back ` +
        `its result is refused (logged as rejected).`
      : "It becomes dead and will not be run.";
    yes.textContent = "Cancel job";
    yes.className = "btn primary";
    $("confirm-no").textContent = "Keep job";
  }
  d.returnValue = "";
  d.onclose = async () => {
    d.onclose = null;
    if (document.body.contains(trigger)) trigger.focus();
    else $("detail-title").focus();
    if (d.returnValue !== "yes") return;
    const r = await api(`/jobs/${job.id}/${kind}`, { method: "POST", body: {} });
    if (r.status === 200) {
      announce(kind === "requeue" ? `Job ${job.id} requeued.` : `Job ${job.id} cancelled.`);
    } else {
      handleActionError(r);
    }
    await refresh();
    $("detail-title").focus();
  };
  d.showModal();
  $("confirm-no").focus();
}

function handleActionError(r) {
  if (r.status === 401) {
    saveToken(null);
    showBanner("The server rejected the API token. Enter it again to requeue or cancel.", true);
  } else {
    showBanner(`The action failed (HTTP ${r.status}). ${detailText(r.body)}`, false);
  }
}

/* ---------- banner ---------- */

function showBanner(text, offerToken) {
  const b = $("banner");
  b.replaceChildren(document.createTextNode(text));
  if (offerToken) {
    const btn = el("button", { type: "button", class: "btn", text: "Enter API token" });
    btn.addEventListener("click", openTokenDialog);
    b.append(btn);
  }
  b.hidden = false;
}
function hideBanner() { $("banner").hidden = true; $("banner").replaceChildren(); }

/* ---------- token dialog ---------- */

function renderTokenControls() {
  const b = $("token-button");
  b.textContent = app.token ? "Forget token" : "Enter API token";
  $("operator-label").hidden = !app.token;
  if (app.job) renderActions(app.job);
}

function openTokenDialog() {
  if (app.token) {
    saveToken(null);
    $("token-input").value = "";
    clearJobData();
    announce("API token forgotten. The dashboard is read-only.");
    refresh();
    return;
  }
  $("token-error").textContent = "";
  $("token-input").removeAttribute("aria-invalid");
  $("token-input").value = "";
  $("token-dialog").showModal();
  $("token-input").focus();
}

async function submitToken(e) {
  e.preventDefault();
  const input = $("token-input");
  const value = input.value.trim();
  const fail = (msg) => {
    $("token-error").textContent = msg;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  };
  if (value.length < 16) return fail("Tokens are at least 16 characters long.");
  const r = await fetch("/auth/check", {
    headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
    credentials: "omit", cache: "no-store",
  }).catch(() => null);
  if (!r) return fail("Cannot reach the API to check the token.");
  if (r.status === 401) return fail("The server rejected this token.");
  if (r.status !== 200) return fail(`Unexpected answer from the server (HTTP ${r.status}).`);
  saveToken(value);
  input.value = "";
  $("token-dialog").close();
  hideBanner();
  announce("Token accepted. Requeue and cancel are available.");
  $("token-button").focus();
  refresh();
}

/* ---------- filters ---------- */

// Same allow-lists as the API (KIND_PATTERN, WORKER_PATTERN in api.py).
const KIND_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const WORKER_RE = /^[A-Za-z0-9_.:@\/-]{1,200}$/;

function validField(input, re, errorId, message) {
  const v = input.value.trim();
  const ok = v === "" || re.test(v);
  if (ok) input.removeAttribute("aria-invalid");
  else input.setAttribute("aria-invalid", "true");
  $(errorId).textContent = ok ? "" : message;
  return ok;
}

function applyFilters(e) {
  if (e) e.preventDefault();
  const k = validField($("f-kind"), KIND_RE, "f-kind-error", "Letters, digits and _ . : - only.");
  const w = validField($("f-worker"), WORKER_RE, "f-worker-error", "Letters, digits and _ . : @ / - only.");
  if (!k || !w) return;
  app.filters.kind = $("f-kind").value.trim();
  app.filters.worker = $("f-worker").value.trim();
  app.rows = PAGE;
  writeUrl(true);
  refresh();
}

function clearFilters() {
  app.filters = { state: "", kind: "", worker: "" };
  $("f-kind").value = "";
  $("f-worker").value = "";
  for (const id of ["f-kind-error", "f-worker-error"]) $(id).textContent = "";
  app.rows = PAGE;
  writeUrl(true);
  renderTabs(null);
  refresh();
  announce("Filters cleared.");
}

function gotoJob() {
  const input = $("goto-id");
  const v = input.value.trim();
  if (!/^[0-9]{1,19}$/.test(v)) {
    input.setAttribute("aria-invalid", "true");
    $("goto-error").textContent = "Enter a job number.";
    input.focus();
    return;
  }
  input.removeAttribute("aria-invalid");
  $("goto-error").textContent = "";
  openJob(v, input);
}

/* ---------- refresh loop ---------- */

async function refresh() {
  if (app.inflight) return;
  app.inflight = true;
  try {
    const p = new URLSearchParams({ limit: String(app.rows) });
    if (app.filters.state) p.set("state", app.filters.state);
    if (app.filters.kind) p.set("kind", app.filters.kind);
    if (app.filters.worker) p.set("worker", app.filters.worker);
    const gen = app.authGen;
    const r = await api(`/jobs?${p}`);
    if (gen !== app.authGen) return;     // fetched with a token that has since changed
    if (r.status === 401) {
      showBanner("This server requires the API token to read jobs.", true);
      $("updated").textContent = "Token needed";
      clearJobData();
      return;
    }
    if (r.status !== 200) {
      showBanner(`The API answered HTTP ${r.status}. ${detailText(r.body)}`, false);
      return;
    }
    hideBanner();
    const { jobs, counts, next_before_id: more } = r.body;
    renderTabs(counts);
    renderRows(jobs, counts);
    const tab = TABS.find((t) => t.id === app.filters.state);
    const total = tab.count(counts);
    const filtered = app.filters.kind || app.filters.worker;
    $("shown").textContent = filtered
      ? `Showing ${jobs.length} matching job${jobs.length === 1 ? "" : "s"}, newest first`
      : `Showing ${jobs.length} of ${total}, newest first`;
    $("more").hidden = !more || app.rows >= MAX_ROWS;
    // Say plainly when the table shows seeded demo jobs, which do no real work.
    $("demo-note").hidden = !jobs.some((j) => j.idempotency_key.startsWith("demo-"));
    const note = $("expired-note");
    note.hidden = !counts.expired_leases;
    note.textContent = counts.expired_leases
      ? `${counts.expired_leases} running job${counts.expired_leases > 1 ? "s have" : " has"} an expired lease; ` +
        "the next claim hands it to another worker." : "";

    if (app.jobId) {
      const [jr, er] = await Promise.all([api(`/jobs/${app.jobId}`),
                                          api(`/jobs/${app.jobId}/events?limit=500`)]);
      if (gen !== app.authGen) return;
      if (jr.status === 200 && er.status === 200) {
        showPanel(true);
        renderJob(jr.body, er.body.events, er.body.next_after_id !== null);
      } else if (jr.status === 404) {
        showPanel(true);
        $("detail-title").textContent = `Job ${app.jobId}`;
        $("detail-state").replaceChildren(el("span", { class: "muted", text: "not found" }));
        for (const id of ["detail-fields", "detail-actions", "lease-rows", "events"]) $(id).replaceChildren();
        $("payload").textContent = "";
        $("result").textContent = "";
      }
    } else {
      showPanel(false);
    }
    app.lastUpdate = new Date();
    $("updated").textContent = `Updated ${app.lastUpdate.toLocaleTimeString(undefined, { hour12: false })}`;
  } catch (e) {
    showBanner("Cannot reach the API. Trying again every 2 seconds.", false);
    $("updated").textContent = "Offline";
  } finally {
    app.inflight = false;
  }
}

function tick() {
  refreshRelativeTimes();
  if (!app.paused && !document.hidden) refresh();
}

function togglePause() {
  app.paused = !app.paused;
  const b = $("pause");
  b.setAttribute("aria-pressed", app.paused ? "true" : "false");
  b.textContent = app.paused ? "Resume updates" : "Pause updates";
  announce(app.paused ? "Automatic updates paused." : "Automatic updates resumed.");
  if (!app.paused) refresh();
}

/* ---------- start ---------- */

function init() {
  buildTabs();
  readUrl();
  renderTabs(null);
  renderTokenControls();
  $("pause").addEventListener("click", togglePause);
  $("token-button").addEventListener("click", openTokenDialog);
  $("token-form").addEventListener("submit", submitToken);
  // However the dialog closes (accepted, Cancel, Escape), the secret leaves the input.
  $("token-dialog").addEventListener("cancel", () => { $("token-input").value = ""; });   // Escape
  $("token-dialog").addEventListener("close", () => { $("token-input").value = ""; });
  $("token-cancel").addEventListener("click", () => {
    $("token-input").value = "";
    $("token-dialog").close();
    $("token-button").focus();
  });
  $("filters").addEventListener("submit", applyFilters);
  $("clear-filters").addEventListener("click", clearFilters);
  $("goto-button").addEventListener("click", gotoJob);
  $("goto-id").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gotoJob(); } });
  $("detail-close").addEventListener("click", closeJob);
  $("detail").addEventListener("keydown", (e) => { if (e.key === "Escape") closeJob(); });
  $("more").addEventListener("click", () => { app.rows = Math.min(MAX_ROWS, app.rows + PAGE); refresh(); });
  window.addEventListener("popstate", () => { readUrl(); renderTabs(null); refresh(); });
  if (app.jobId) showPanel(true);
  refresh();
  window.setInterval(tick, REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
