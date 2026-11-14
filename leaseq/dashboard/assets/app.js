"use strict";
/* LeaseQ operations console. Plain JavaScript, no build step, no third-party code.

   Screens are hash routes so the page works from any static host and every view
   has a shareable URL:
     #/jobs[?state=&kind=&worker=]  Jobs: state lanes (real counts, act as filters) + job table
     #/jobs/<id>                    Job details: why it waits, lifecycle timeline, payload, result,
                                    protected Cancel / Requeue
     #/submit                       Submit test job: word_count through the real queue and worker
     #/connection                   Connection & API: token, status, API guide
   Old links (?job=N, ?state=, ?kind=, ?worker=) are rewritten to these routes.

   Security notes
   * Everything the API returns (kinds, payloads, results, error text, worker ids,
     idempotency keys) was written by API clients, so it is untrusted. It reaches the
     page only via textContent / createTextNode, never as HTML.
   * The API token is kept only in this page's memory (never a cookie, localStorage,
     sessionStorage or the URL) and sent only in the Authorization header, so there is
     no CSRF surface. Reloading the page or "Forget token" drops it.
   * Job data is sensitive. "Forget token" and any 401 clear ALL of it at once: the job
     list, every cached job (payload, result, events) and the Submit result. Screens are
     rendered only from that state, so going Back to a job route afterwards cannot show
     a stale payload; responses to requests sent before the clear are dropped (authGen).
   * Requeue and cancel appear only while a token the server accepted is set, and each
     asks for confirmation naming the job and the effect. The server checks the token on
     every request regardless.
*/

const REFRESH_MS = 2000;
const PAGE = 50;
const MAX_ROWS = 200;            // the API's page cap
const WC_MAX = 10000;            // worker.WORD_COUNT_MAX_CHARS
const NO_COUNT = "–";       // shown until the server has answered: never a guessed "0"
const SAMPLE_TEXT = "assets/sample/pride-and-prejudice-ch1.txt";

const LANES = [
  { id: "", label: "All", count: (c) => c.total },
  { id: "queued", label: "Queued", count: (c) => c.queued },
  { id: "leased", label: "Running", count: (c) => c.leased },
  { id: "retrying", label: "Retrying", count: (c) => c.retrying },
  { id: "done", label: "Done", count: (c) => c.done },
  { id: "dead", label: "Dead", count: (c) => c.dead },
];

const app = {
  token: null,
  authGen: 0,          // bumped whenever job data must be dropped; older responses are ignored
  conn: "unknown",     // unknown | token | public | needs-token | offline
  route: { name: "jobs", id: null },
  routeKey: null,
  filters: { state: "", kind: "", worker: "" },
  rows: PAGE,
  list: null,          // last GET /jobs body (sensitive)
  details: new Map(),  // job id -> { job, events, more } | { notfound: true } (sensitive)
  submit: null,        // { id, job, started } of the last test job (sensitive)
  submitDraft: "",     // the person's own text; kept across routes
  submitIntent: null,  // text and key kept together so an ambiguous response can be retried
  submitInFlight: false,
  submitTimer: null,
  paused: false,
  inflight: false,
  timer: null,
  lastJobsHash: "#/jobs",
  version: null,
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
    if (c === null || c === undefined || c === false) continue;
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
  fence: [["path", { d: "M3 3v10M8 3v10M13 3v10M3 6h10M3 10h10", fill: "none", stroke: "currentColor",
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
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit",
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
function clock(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}
function refreshRelativeTimes() {
  for (const t of document.querySelectorAll("time[data-rel]")) t.textContent = fmtRel(t.dateTime);
}

function announce(msg) {
  const s = $("status");
  const gen = app.authGen;
  s.textContent = "";
  window.setTimeout(() => { if (gen === app.authGen) s.textContent = msg; }, 50);
}

/* ---------- API ---------- */

async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "omit",
      cache: "no-store",
    });
  } catch (e) {
    const failure = new Error("Cannot reach the API");
    failure.path = path.split("?")[0];
    throw failure;
  }
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

/* ---------- sensitive state ---------- */

function hasSensitive() {
  return app.list !== null || app.details.size > 0 || app.submit !== null;
}

// Drop every piece of job data at once and re-render the current screen from
// the now-empty state. Called on "Forget token" and on any 401.
function clearSensitive() {
  app.authGen += 1;
  app.list = null;
  app.details.clear();
  app.submit = null;
  app.submitDraft = "";
  app.submitIntent = null;
  app.submitInFlight = false;
  stopSubmitPoll();
  resetConfirmation();
  $("status").textContent = "";
}

function setConn(state) {
  app.conn = state;
  const s = $("conn-status");
  const text = { unknown: "Checking connection", token: "Connected with token", public: "Reading without token",
                 "needs-token": "Not connected", offline: "API unreachable" }[state];
  s.className = `conn ${state === "token" || state === "public" ? "ok" : state === "unknown" ? "" : "warn"}`;
  s.replaceChildren(icon(state === "token" || state === "public" ? "done" : state === "unknown" ? "queued" : "dead"),
                    el("span", { text }));
  $("forget-token").hidden = !app.token;
}

function handleUnauthorized() {
  const hadToken = app.token !== null;
  const dirty = hasSensitive() || hadToken || app.conn !== "needs-token";
  app.token = null;
  clearSensitive();
  setConn("needs-token");
  showBanner(hadToken
    ? "The server rejected the API token, so all job data was cleared from this page."
    : "This server requires the API token to read jobs.", true);
  if (dirty) renderView(false);
}

function forgetToken() {
  app.token = null;
  clearSensitive();
  setConn("unknown");
  hideBanner();
  renderView(false);
  focusH1();
  announce("API token forgotten. All job data was cleared from this page.");
  pollNow();
}

/* ---------- banner ---------- */

// Called on every poll. Rebuild the banner only when its content changes: a
// rebuild would drop keyboard focus from its link and make screen readers
// announce the role="alert" text again every 2 seconds.
function showBanner(text, offerToken) {
  const b = $("banner");
  const key = `${offerToken ? 1 : 0}|${text}`;
  if (!b.hidden && b.dataset.key === key) return;
  b.dataset.key = key;
  b.replaceChildren(document.createTextNode(text));
  if (offerToken && app.route.name !== "connection") {
    b.append(el("a", { href: "#/connection", text: "Enter the API token" }));
  }
  b.hidden = false;
}
function hideBanner() {
  const b = $("banner");
  if (b.hidden) return;
  b.hidden = true;
  b.replaceChildren();
  delete b.dataset.key;
}

/* ---------- routing ---------- */

function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "") || "/jobs";
  const [path, query = ""] = raw.split("?");
  const p = new URLSearchParams(query);
  if (path === "/jobs" || path === "/" || path === "") return { name: "jobs", id: null, params: p };
  const m = /^\/jobs\/([0-9]{1,19})$/.exec(path);
  if (m) return { name: "job", id: m[1], params: p };
  if (path === "/submit") return { name: "submit", id: null, params: p };
  if (path === "/connection") return { name: "connection", id: null, params: p };
  return { name: "notfound", id: null, params: p };
}

function jobsHash(f) {
  const p = new URLSearchParams();
  if (f.state) p.set("state", f.state);
  if (f.kind) p.set("kind", f.kind);
  if (f.worker) p.set("worker", f.worker);
  const qs = p.toString();
  return `#/jobs${qs ? `?${qs}` : ""}`;
}

// Old shared links: /dashboard/?job=12 and /dashboard/?state=dead&kind=x.
function migrateOldLink() {
  const q = new URLSearchParams(window.location.search);
  if (![...q.keys()].some((k) => ["job", "state", "kind", "worker"].includes(k))) return;
  let hash;
  const j = q.get("job");
  if (j && /^[0-9]{1,19}$/.test(j)) hash = `#/jobs/${j}`;
  else hash = jobsHash({ state: LANES.some((l) => l.id === q.get("state")) ? q.get("state") : "",
                         kind: q.get("kind") || "", worker: q.get("worker") || "" });
  window.history.replaceState(null, "", window.location.pathname + hash);
}

function readFilters(params) {
  const st = params.get("state") || "";
  app.filters = { state: LANES.some((l) => l.id === st) ? st : "", kind: params.get("kind") || "",
                  worker: params.get("worker") || "" };
}

function onLocationChange() {
  const key = window.location.hash || "#/jobs";
  if (key === app.routeKey) return;
  const prev = app.route;
  app.routeKey = key;
  app.route = parseHash(key);
  if (app.route.name === "jobs") {
    readFilters(app.route.params);
    app.lastJobsHash = key;
  }
  const sheet = $("menu-sheet");
  if (sheet.open) sheet.close("navigate");
  const sameScreen = prev.name === app.route.name && prev.id === app.route.id && app.view;
  renderView(!sameScreen);
  pollNow();
}

// Navigation inside the Jobs screen (filters): a new history entry, same screen.
function pushJobsFilters() {
  const hash = jobsHash(app.filters);
  if (hash === app.routeKey) { pollNow(); return; }
  window.history.pushState(null, "", window.location.pathname + hash);
  app.routeKey = hash;
  app.route = parseHash(hash);
  app.lastJobsHash = hash;
  app.rows = PAGE;
  renderLanes();
  pollNow();
}

const TITLES = { jobs: "Jobs", submit: "Submit test job", connection: "Connection & API", notfound: "Not found" };

function screenTitle() {
  return app.route.name === "job" ? `Job ${app.route.id}` : TITLES[app.route.name];
}

function focusH1() {
  const h = document.querySelector("#view h1");
  if (h) h.focus({ preventScroll: false });
}

function renderChrome() {
  const title = screenTitle();
  document.title = `${title} – LeaseQ`;
  for (const a of document.querySelectorAll("[data-nav] a[data-route]")) {
    const r = a.dataset.route;
    if (r === app.route.name) a.setAttribute("aria-current", "page");
    else if (r === "jobs" && app.route.name === "job") a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
  const crumbs = $("crumbs");
  const items = [el("li", {}, el("a", { href: "#/jobs", text: "LeaseQ" }))];
  if (app.route.name === "job") items.push(el("li", {}, el("a", { href: app.lastJobsHash, text: "Jobs" })));
  items.push(el("li", {}, el("span", { "aria-current": "page", text: title })));
  crumbs.replaceChildren(...items);
}

// Build the current screen from app state. moveFocus: a new screen (focus its H1,
// scroll to top); false: the same screen redrawn (for example after Forget).
function renderView(moveFocus) {
  renderChrome();
  const view = $("view");
  const build = { jobs: viewJobs, job: viewJob, submit: viewSubmit, connection: viewConnection,
                  notfound: viewNotFound }[app.route.name];
  view.replaceChildren(...build().filter((n) => n !== null && n !== undefined && n !== ""));
  app.view = app.route.name;
  if (app.route.name === "jobs") renderJobsData();
  if (app.route.name === "job") renderJobData();
  if (app.route.name === "submit") renderSubmitResult();
  if (moveFocus) {
    window.scrollTo(0, 0);
    focusH1();
  }
}

function h1(text) {
  return el("h1", { tabindex: "-1", text });
}

// Shown on data screens when there is no way to read jobs right now.
function connectionNotice(what) {
  if (app.conn === "needs-token") {
    return el("section", { class: "notice", "aria-labelledby": "notice-title", id: "conn-notice" },
      el("h2", { id: "notice-title", text: "Not connected" }),
      el("p", { text: `${what} This server needs its API token, and this page holds none ` +
                      "(it keeps the token in memory only, so a reload or Forget token removes it)." }),
      el("p", {}, el("a", { href: "#/connection", text: "Go to Connection & API to enter the token" })));
  }
  if (app.conn === "offline") {
    return el("section", { class: "notice", "aria-labelledby": "notice-title", id: "conn-notice" },
      el("h2", { id: "notice-title", text: "API unreachable" }),
      el("p", { text: "This page cannot reach the leaseq API that served it. It tries again every 2 seconds." }),
      el("p", {}, el("a", { href: "#/connection", text: "See Connection & API for how to start it" })));
  }
  return null;
}

/* ---------- Jobs screen ---------- */

function viewJobs() {
  const lanes = el("ul", { class: "lanes", id: "lanes", "aria-label": "Job states (each one filters the table)" });
  for (const l of LANES) {
    const b = el("button", { type: "button", class: `lane ${l.id || "all"}`, "data-state": l.id,
                             "aria-pressed": "false" },
      el("span", { class: "lane-name" }, icon(l.id || "all"), l.label),
      el("span", { class: "count", "data-count": l.id || "all", text: NO_COUNT }));
    b.addEventListener("click", () => {
      app.filters.state = app.filters.state === l.id ? "" : l.id;
      pushJobsFilters();
    });
    lanes.append(el("li", {}, b));
  }

  const kind = el("input", { class: "input", id: "f-kind", name: "kind", maxlength: 100, autocomplete: "off",
                             spellcheck: "false", "aria-describedby": "f-kind-error" });
  kind.value = app.filters.kind;
  const worker = el("input", { class: "input", id: "f-worker", name: "worker", maxlength: 200, autocomplete: "off",
                               spellcheck: "false", "aria-describedby": "f-worker-error" });
  worker.value = app.filters.worker;
  const goto = el("input", { class: "input goto", id: "goto-id", inputmode: "numeric", maxlength: 19,
                             autocomplete: "off", "aria-describedby": "goto-error" });
  const gotoBtn = el("button", { type: "button", class: "btn", id: "goto-button", text: "Open job" });
  const clear = el("button", { type: "button", class: "btn", id: "clear-filters", text: "Clear filters" });
  const filters = el("form", { id: "filters", class: "filters", role: "search", "aria-label": "Filter jobs", novalidate: true },
    el("div", { class: "field" }, el("label", { for: "f-kind", text: "Kind" }), kind,
       el("span", { class: "field-error", id: "f-kind-error" })),
    el("div", { class: "field" }, el("label", { for: "f-worker", text: "Worker" }), worker,
       el("span", { class: "field-error", id: "f-worker-error" })),
    el("button", { type: "submit", class: "btn", text: "Apply filters" }), clear,
    el("span", { class: "filters-gap" }),
    el("div", { class: "field" }, el("label", { for: "goto-id", text: "Job ID" }), goto,
       el("span", { class: "field-error", id: "goto-error" })),
    gotoBtn);
  filters.addEventListener("submit", applyFilters);
  clear.addEventListener("click", clearFilters);
  gotoBtn.addEventListener("click", gotoJob);
  goto.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gotoJob(); } });

  const pause = el("button", { type: "button", class: "btn", id: "pause",
                               text: app.paused ? "Resume updates" : "Pause updates" });
  pause.addEventListener("click", togglePause);
  const more = el("button", { type: "button", class: "btn", id: "more", text: "Show more jobs", hidden: true });
  more.addEventListener("click", () => { app.rows = Math.min(MAX_ROWS, app.rows + PAGE); pollNow(); });

  return [
    h1("Jobs"),
    el("p", { class: "lede", text: "Review background jobs, filter by state, and open a job to inspect its attempts, payload, result and history." }),
    connectionNotice("Job data cannot be shown."),
    el("div", { class: "console-bar" }, el("span", { id: "updated", text: "Waiting for the first update" }), pause),
    lanes,
    el("p", { id: "expired-note", class: "note", hidden: true }),
    el("p", { id: "demo-note", class: "demo-note", hidden: true },
       "Sample data. Jobs with keys starting ", el("code", { text: "demo-" }), " come from ",
       el("code", { text: "leaseq.demo" }), ", and the bundled worker does no real work for them: no email is sent " +
       "and nothing is rendered. ", el("code", { text: "sleep" }), " jobs only wait and ",
       el("code", { text: "fail" }), " jobs only fail. The queue itself (claim, heartbeat, complete, retry, audit log) is real."),
    el("section", { class: "panel", "aria-labelledby": "queue-title" },
      el("div", { class: "panel-head" }, el("h2", { id: "queue-title", text: "Job queue" }),
         el("a", { class: "btn primary", href: "#/submit", text: "Submit test job" })),
      filters,
      el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Job table, scrolls sideways" },
        el("table", { class: "jobs-table" },
          el("caption", { class: "sr-only", id: "table-caption", text: "Jobs, newest first" }),
          el("thead", {}, el("tr", {}, ...["Job", "State", "Kind", "Attempts", "Worker", "Updated", "Result",
                                            "Idempotency key"].map((t) => el("th", { scope: "col", text: t })))),
          el("tbody", { id: "rows" }))),
      el("div", { class: "table-foot" }, el("span", { id: "shown", class: "muted" }), more)),
  ];
}

function renderLanes() {
  const counts = app.list ? app.list.counts : null;
  for (const l of LANES) {
    const b = document.querySelector(`.lane[data-state="${l.id}"]`);
    if (!b) continue;
    b.setAttribute("aria-pressed", l.id === app.filters.state ? "true" : "false");
    b.querySelector(".count").textContent = counts ? String(l.count(counts)) : NO_COUNT;
  }
}

function resultSummary(job) {
  if (job.result === null || job.result === undefined) return el("span", { class: "muted", text: "none" });
  const r = job.result;
  if (job.kind === "word_count" && Number.isInteger(r.words) && Number.isInteger(r.lines)) {
    return `${r.words} words, ${r.lines} lines`;
  }
  const s = JSON.stringify(r);
  return s.length > 48 ? `${s.slice(0, 47)}…` : s;
}

function renderJobsData() {
  if (!$("rows")) return;
  renderLanes();
  const tbody = $("rows");
  const focusedJob = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.job : undefined;
  tbody.replaceChildren();
  const body = app.list;
  if (!body) {
    const msg = app.conn === "needs-token"
      ? el("p", {}, "Jobs appear here after you connect. ", el("a", { href: "#/connection", text: "Enter the API token" }))
      : app.conn === "offline" ? el("p", { text: "Jobs appear here when the API answers again." })
      : el("p", { text: "Loading jobs…" });
    tbody.append(el("tr", {}, el("td", { colspan: 8, class: "empty" }, msg)));
    $("shown").textContent = "";
    $("more").hidden = true;
    $("demo-note").hidden = true;
    $("expired-note").hidden = true;
    return;
  }
  const { jobs, counts, next_before_id: more } = body;
  if (jobs.length === 0) tbody.append(el("tr", {}, el("td", { colspan: 8, class: "empty" }, ...emptyState(counts))));
  for (const job of jobs) {
    const id = String(job.id);
    const selected = app.lastJob === id;
    tbody.append(el("tr", { class: selected ? "selected" : null },
      el("td", {}, el("a", { class: "job-link", href: `#/jobs/${id}`, "data-job": id },
                      el("span", { class: "sr-only", text: "Job " }), id)),
      el("td", {}, stateBadge(job)),
      el("td", { text: job.kind }),
      el("td", { text: `${job.attempts} of ${job.max_attempts}` }),
      el("td", {}, job.leased_by ? el("span", { class: "mono", text: job.leased_by }) : el("span", { class: "muted", text: "none" })),
      el("td", {}, timeEl(job.updated_at)),
      el("td", { class: "result" }, resultSummary(job)),
      el("td", { class: "mono key", title: job.idempotency_key, text: job.idempotency_key })));
  }
  if (focusedJob) {
    const again = tbody.querySelector(`a[data-job="${CSS.escape(focusedJob)}"]`);
    if (again) again.focus();
  }
  const lane = LANES.find((l) => l.id === app.filters.state);
  const filtered = app.filters.kind || app.filters.worker;
  $("shown").textContent = filtered
    ? `Showing ${jobs.length} matching job${jobs.length === 1 ? "" : "s"}, newest first`
    : `Showing ${jobs.length} of ${lane.count(counts)}, newest first`;
  $("more").hidden = !more || app.rows >= MAX_ROWS;
  $("demo-note").hidden = !jobs.some((j) => j.idempotency_key.startsWith("demo-"));
  const note = $("expired-note");
  note.hidden = !counts.expired_leases;
  note.textContent = counts.expired_leases
    ? `${counts.expired_leases} running job${counts.expired_leases > 1 ? "s have" : " has"} an expired lease; ` +
      "the next claim can reassign it, or mark it dead if its attempts are exhausted." : "";
  $("updated").textContent = `Counts as of ${clock(body.counts_as_of)}`;
}

function emptyState(counts) {
  const filtered = app.filters.state || app.filters.kind || app.filters.worker;
  if (filtered && counts && counts.total > 0) {
    const clear = el("button", { type: "button", class: "btn", text: "Clear filters" });
    clear.addEventListener("click", clearFilters);
    return [el("p", { text: "No jobs match these filters." }), clear];
  }
  const parts = [el("p", { text: "No jobs yet." }),
                 el("p", { class: "muted" }, "Submit a test job, run ", el("code", { text: "python -m leaseq.demo" }),
                    app.token ? ", or load the sample jobs here." : ", or enter the API token to add sample jobs from here.")];
  if (app.token) {
    const b = el("button", { type: "button", class: "btn", id: "load-sample", text: "Load sample jobs" });
    b.addEventListener("click", loadSample);
    parts.push(b);
  }
  return parts;
}

async function loadSample() {
  const gen = app.authGen;
  const r = await api("/demo/jobs", { method: "POST" });
  if (gen !== app.authGen) return;
  if (r.status === 201) announce(`Loaded ${r.body.enqueued} sample jobs.`);
  else if (r.status === 401) handleUnauthorized();
  else showBanner(`Loading sample jobs failed (HTTP ${r.status}). ${detailText(r.body)}`, false);
  pollNow();
}

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
  pushJobsFilters();
}

function clearFilters() {
  app.filters = { state: "", kind: "", worker: "" };
  $("f-kind").value = "";
  $("f-worker").value = "";
  for (const id of ["f-kind-error", "f-worker-error"]) $(id).textContent = "";
  pushJobsFilters();
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
  window.location.hash = `#/jobs/${v}`;
}

/* ---------- Job details screen ---------- */

function viewJob() {
  const id = app.route.id;
  app.lastJob = id;
  return [
    el("a", { class: "back", href: app.lastJobsHash, id: "back-link" }, "← Back to jobs"),
    el("div", { class: "title-row" }, h1(`Job ${id}`), el("span", { id: "detail-state" })),
    connectionNotice(`Job ${id} cannot be shown.`),
    el("div", { id: "job-body" }),
  ];
}

function renderJobData() {
  const box = $("job-body");
  if (!box) return;
  const id = app.route.id;
  const d = app.details.get(id);
  if (!d) {
    $("detail-state").replaceChildren();
    if (app.conn === "needs-token" || app.conn === "offline") box.replaceChildren();
    else box.replaceChildren(el("p", { class: "muted", text: `Loading job ${id}…` }));
    return;
  }
  if (d.notfound) {
    $("detail-state").replaceChildren(el("span", { class: "muted", text: "not found" }));
    box.replaceChildren(el("section", { class: "notice", "aria-labelledby": "nf-title" },
      el("h2", { id: "nf-title", text: `No job ${id} in this queue` }),
      el("p", {}, el("a", { href: app.lastJobsHash, text: "Back to jobs" }))));
    return;
  }
  const { job, events, more } = d;
  $("detail-state").replaceChildren(stateBadge(job));
  // Keep focus where it was if a poll redraws the screen.
  const focusedId = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;

  const why = whyWaiting(job);
  const fields = el("dl", { class: "fields", id: "detail-fields" });
  const add = (k, v) => fields.append(el("dt", { text: k }), el("dd", {}, v));
  add("Kind", job.kind);
  add("Attempts", `${job.attempts} of ${job.max_attempts}`);
  add("Last worker", job.leased_by ? el("span", { class: "mono", text: job.leased_by }) : el("span", { class: "muted", text: "none" }));
  add("Lease expires", timeEl(job.lease_expires_at));
  add("Run after", timeEl(job.run_after));
  add("Idempotency key", el("span", { class: "mono", text: job.idempotency_key }));
  add("Created", timeEl(job.created_at, false));
  add("Updated", timeEl(job.updated_at, false));

  box.replaceChildren(
    el("section", { class: "panel why", "aria-labelledby": "why-title" },
      el("div", { class: "panel-body" }, el("h2", { id: "why-title", text: why.title }),
         el("p", { id: "why" }, ...why.parts))),
    el("div", { class: "detail-grid" },
      el("section", { class: "panel", "aria-labelledby": "life-title" },
        el("div", { class: "panel-body" },
          el("h2", { id: "life-title", text: "Lease lifecycle" }),
          el("p", { class: "hint", text: "From the append-only audit log (job_events). Heartbeats extend a lease " +
                                          "but are not logged, so the lease expiry shown is the latest one." }),
          el("h3", { id: "timeline-label", text: "Lifecycle" }),
          timeline(job, events),
          more ? el("p", { class: "hint", id: "events-more", text: "Showing the first 500 events." }) : null)),
      el("div", {},
        el("section", { class: "panel", "aria-labelledby": "act-title" },
          el("div", { class: "panel-body" }, el("h2", { id: "act-title", text: "Operator actions" }),
             el("div", { class: "actions", id: "detail-actions" }, ...actions(job)))),
        el("section", { class: "panel", "aria-labelledby": "sum-title" },
          el("div", { class: "panel-body" }, el("h2", { id: "sum-title", text: "Summary" }), fields)))),
    el("section", { class: "panel", "aria-labelledby": "payload-title" },
      el("div", { class: "panel-body" },
        el("h2", { id: "payload-title", text: "Payload" }),
        el("pre", { class: "json", id: "payload", tabindex: "0", "aria-label": "Payload JSON",
                    text: JSON.stringify(job.payload, null, 2) }),
        el("h2", { id: "result-title", class: "spaced", text: "Result" }),
        el("pre", { class: "json", id: "result", tabindex: "0", "aria-label": "Result JSON",
                    text: job.result === null ? "none" : JSON.stringify(job.result, null, 2) }))));
  if (focusedId && $(focusedId)) $(focusedId).focus();
}

function whyWaiting(job) {
  const now = Date.now();
  const s = displayState(job);
  if (s === "done") {
    return { title: "Status", parts: [`Finished: completed on attempt ${job.attempts} of ${job.max_attempts}. Nothing is waiting.`] };
  }
  if (s === "dead") {
    return { title: "Why it is not running", parts: [
      `It is dead after ${job.attempts} of ${job.max_attempts} attempts and will not run again unless an operator requeues it. ` +
      "The lifecycle below shows the last error."] };
  }
  if (job.state === "leased") {
    const exp = job.lease_expires_at ? new Date(job.lease_expires_at).getTime() : 0;
    if (exp > now) {
      return { title: "Why it is waiting", parts: [
        "Running on worker ", el("span", { class: "mono", text: job.leased_by || "unknown" }), ". Its lease ends ",
        timeEl(job.lease_expires_at), " unless the worker heartbeats. If the worker stops, another worker can " +
        "reclaim the job after that. A late report is rejected once this lease is replaced or cancelled."] };
    }
    return { title: "Why it is waiting", parts: [
      "The lease expired ", timeEl(job.lease_expires_at), ". The next claim can reassign it, or mark it dead " +
      "if its attempts are exhausted. Until the lease is replaced or cancelled, a late report from ",
      el("span", { class: "mono", text: job.leased_by || "the old worker" }), " can still be accepted."] };
  }
  const after = job.run_after ? new Date(job.run_after).getTime() : 0;
  if (after > now) {
    return { title: "Why it is waiting", parts: [
      s === "retrying" ? `Retry backoff: attempt ${job.attempts} of ${job.max_attempts} failed. It can be claimed again `
                       : "Scheduled: it can be claimed ",
      timeEl(job.run_after), "."] };
  }
  return { title: "Why it is waiting", parts: [
    s === "retrying" ? `Ready to retry (attempt ${job.attempts} of ${job.max_attempts} failed). ` : "Queued and ready. ",
    "It runs when a worker asks for work; claims take the oldest runnable job first. If it stays here, " +
    "check that a worker is running."] };
}

const STEP = {
  enqueued: { title: "Enqueued", tone: "queued", icon: "queued" },
  claimed: { title: "Claimed", tone: "leased", icon: "leased" },
  completed: { title: "Completed", tone: "done", icon: "done" },
  failed: { title: "Failed, will retry", tone: "retrying", icon: "retrying" },
  dead: { title: "Dead", tone: "dead", icon: "dead" },
  rejected: { title: "Fence rejected a stale call", tone: "retrying", icon: "fence" },
  requeued: { title: "Requeued by operator", tone: "queued", icon: "retrying" },
  cancelled: { title: "Cancelled by operator", tone: "dead", icon: "dead" },
  expired: { title: "Lease expired", tone: "retrying", icon: "retrying" },
  running: { title: "Current lease", tone: "leased", icon: "leased" },
};

function step(kind, at, ...detail) {
  const s = STEP[kind] || { title: kind, tone: "queued", icon: "queued" };
  return el("li", { "data-step": kind, "data-tone": s.tone },
    el("span", { class: "marker" }, icon(s.icon)),
    el("span", { class: "ev-title", text: s.title }),
    at ? el("time", { class: "ev-when", datetime: at, title: fmtAbs(at), text: clock(at) }) : null,
    detail.length ? el("span", { class: "ev-detail" }, ...detail) : null);
}

/* The lifecycle as a timeline: one item per audit event, plus two derived items
   that are labelled as such: "Lease expired" (a claim with no report before the
   next claim) and "Current lease" (the current lease). */
function timeline(job, events) {
  const list = el("ol", { class: "timeline", "aria-labelledby": "timeline-label" });
  let open = null;   // the claim with no outcome yet
  for (const e of events) {
    const d = e.detail || {};
    const w = e.worker_id;
    if (e.event === "claimed") {
      if (open) list.append(step("expired", null, `Derived: worker ${open} sent no report before the next claim.`));
      open = w;
      list.append(step("claimed", e.created_at, "Attempt ", String(e.attempt), " by ", el("span", { class: "mono", text: w || "" }),
                       d.lease_seconds ? `, lease ${d.lease_seconds} s` : ""));
    } else if (e.event === "enqueued") {
      list.append(step("enqueued", e.created_at, "Added to the queue."));
    } else if (e.event === "completed") {
      open = null;
      list.append(step("completed", e.created_at, "Result stored with the job, in the same transaction as the fence check."));
    } else if (e.event === "failed") {
      open = null;
      list.append(step("failed", e.created_at, `${d.error || "no message"}. Retry in ${d.retry_in_seconds} s.`));
    } else if (e.event === "dead") {
      open = null;
      const why = d.error || d.reason || "out of attempts";
      list.append(step("dead", e.created_at, `${why}${d.permanent ? " (permanent error, not retried)" : ""}`));
    } else if (e.event === "rejected") {
      list.append(step("rejected", e.created_at, "Worker ", el("span", { class: "mono", text: w || "" }),
                       ` used an old lease token${d.op ? ` for ${d.op}` : ""}; nothing was written.`));
    } else if (e.event === "requeued") {
      list.append(step("requeued", e.created_at, d.extra_attempts ? `${d.extra_attempts} more attempts.` : ""));
    } else if (e.event === "cancelled") {
      open = null;
      list.append(step("cancelled", e.created_at, d.reason ? String(d.reason) :
        "Marked dead; its lease is revoked. Previously claimed work may still run; external effects are not undone."));
    } else {
      list.append(step(e.event, e.created_at, Object.keys(d).length ? JSON.stringify(d) : ""));
    }
  }
  if (open && job.state === "leased") {
    list.append(step("running", null, "Derived: the lease ends ", timeEl(job.lease_expires_at), " unless renewed."));
  }
  if (!events.length) list.append(el("li", { class: "muted", text: "No events." }));
  return list;
}

function actions(job) {
  if (!app.token) {
    return [el("p", {}, "Requeue and cancel need the API token. ",
               el("a", { href: "#/connection", text: "Enter it on Connection & API" }))];
  }
  const out = [];
  if (job.state === "dead") {
    const b = el("button", { type: "button", class: "btn", id: "requeue", text: "Requeue job" });
    b.addEventListener("click", () => confirmAction("requeue", job, b));
    out.push(b);
  }
  if (job.state === "queued" || job.state === "leased") {
    const b = el("button", { type: "button", class: "btn danger", id: "cancel", text: "Cancel job" });
    b.addEventListener("click", () => confirmAction("cancel", job, b));
    out.push(b);
  }
  if (!out.length) out.push(el("p", { class: "muted", text: "Finished jobs cannot be requeued or cancelled." }));
  return out;
}

function resetConfirmation() {
  const d = $("confirm-dialog");
  d.onclose = null;
  if (d.open) d.close();
  d.returnValue = "";
  $("confirm-title").textContent = "Confirm";
  $("confirm-text").textContent = "";
  $("confirm-yes").textContent = "Confirm";
  $("confirm-yes").className = "btn primary";
  $("confirm-no").textContent = "Keep as is";
}

function confirmAction(kind, job, trigger) {
  const d = $("confirm-dialog");
  const yes = $("confirm-yes");
  const gen = app.authGen;
  if (kind === "requeue") {
    $("confirm-title").textContent = `Requeue job ${job.id}?`;
    $("confirm-text").textContent = `Job ${job.id} (${job.kind}) goes back to the queue with 3 more attempts. ` +
      `Its attempt count (${job.attempts}) and audit history are kept.`;
    yes.textContent = "Requeue job";
    yes.className = "btn primary";
    $("confirm-no").textContent = "Keep as dead";
  } else {
    $("confirm-title").textContent = `Cancel job ${job.id}?`;
    $("confirm-text").textContent = `Job ${job.id} (${job.kind}) becomes dead and its lease is revoked, ` +
      "so it is unavailable for future claims. Previously claimed work may still be running; " +
      "any later completion using the revoked lease is rejected. This does not undo external effects.";
    yes.textContent = "Cancel job";
    yes.className = "btn primary danger";
    $("confirm-no").textContent = "Keep job";
  }
  d.returnValue = "";
  d.onclose = async () => {
    const confirmed = d.returnValue === "yes";
    resetConfirmation();
    const focusBack = () => {
      const again = trigger.id ? $(trigger.id) : null;
      if (again) again.focus();
      else focusH1();
    };
    focusBack();
    if (!confirmed || gen !== app.authGen || !app.token) return;
    const r = await api(`/jobs/${job.id}/${kind}`, { method: "POST", body: {} });
    if (gen !== app.authGen) return;
    if (r.status === 401) { handleUnauthorized(); return; }
    if (r.status === 200) announce(kind === "requeue" ? `Job ${job.id} requeued.` : `Job ${job.id} cancelled.`);
    else showBanner(`The action failed (HTTP ${r.status}). ${detailText(r.body)}`, false);
    await refreshJob(String(job.id));
    if (gen === app.authGen) focusBack();
  };
  d.showModal();
  $("confirm-no").focus();
}

/* ---------- Submit test job screen ---------- */

function viewSubmit() {
  const text = el("textarea", { id: "wc-text", name: "text", spellcheck: "false",
                                "aria-describedby": "wc-hint wc-count wc-error" });
  text.value = app.submitDraft;
  const count = el("p", { class: "hint", id: "wc-count" });
  const setCount = () => { count.textContent = `${text.value.length.toLocaleString("en-US")} of 10,000 characters`; };
  setCount();
  text.addEventListener("input", () => {
    app.submitDraft = text.value;
    if (app.submitIntent && app.submitIntent.text !== text.value) app.submitIntent = null;
    setCount();
  });
  const sample = el("button", { type: "button", class: "btn", id: "load-text", text: "Load sample text" });
  sample.addEventListener("click", async () => {
    const gen = app.authGen;
    try {
      const r = await fetch(SAMPLE_TEXT, { credentials: "omit" });
      if (!r.ok) throw new Error(String(r.status));
      const value = await r.text();
      if (gen !== app.authGen || $("wc-text") !== text) return;
      text.value = value;
      app.submitDraft = text.value;
      if (app.submitIntent && app.submitIntent.text !== text.value) app.submitIntent = null;
      setCount();
      text.removeAttribute("aria-invalid");
      $("wc-error").textContent = "";
      announce("Sample text loaded: Pride and Prejudice, chapter 1.");
    } catch (e) {
      if (gen !== app.authGen || $("wc-text") !== text) return;
      $("wc-error").textContent = "The sample text could not be loaded from this server.";
    }
  });
  const clear = el("button", { type: "button", class: "btn", text: "Clear text" });
  clear.addEventListener("click", () => { text.value = ""; app.submitDraft = ""; app.submitIntent = null; setCount(); text.focus(); });
  const form = el("form", { id: "submit-form", class: "form-stack", novalidate: true },
    el("label", { for: "wc-text", text: "Text to count" }),
    el("p", { class: "hint", id: "wc-hint", text: "The handler accepts up to 10,000 characters. Longer text stays " +
      "here for editing and cannot be submitted. Submitted text is stored as the job's payload on this server." }),
    text, count,
    el("p", { class: "field-error", id: "wc-error" }),
    el("p", { class: "hint" }, "Sample text: Jane Austen, ", el("cite", { text: "Pride and Prejudice" }),
       ", chapter 1, from Project Gutenberg eBook #1342. The novel is in the public domain; see ",
       el("a", { href: "assets/sample/SOURCE.txt", text: "source and licence note" }), "."),
    el("div", { class: "form-actions" },
       el("button", { type: "submit", class: "btn primary", id: "submit-job", text: "Submit job",
                      disabled: app.submitInFlight }), sample, clear));
  form.addEventListener("submit", submitJob);
  return [
    h1("Submit test job"),
    el("p", { class: "lede", text: "Submit text for word and line counts. The server queues the task; a worker processes it and returns its recorded result." }),
    app.token ? null : (connectionNotice("Submitting needs the API token.") ||
      el("section", { class: "notice", "aria-labelledby": "notice-title" },
        el("h2", { id: "notice-title", text: "Token needed to submit" }),
        el("p", {}, "Reading may be open on this server, but submitting always needs the API token. ",
           el("a", { href: "#/connection", text: "Enter it on Connection & API" })))),
    el("section", { class: "panel", "aria-label": "word_count job" },
      el("div", { class: "panel-body" }, form,
         el("div", { id: "submit-result", class: "result-box", "aria-live": "polite" }))),
  ];
}

async function submitJob(e) {
  e.preventDefault();
  if (app.submitInFlight) return;
  const text = $("wc-text");
  const err = $("wc-error");
  const fail = (msg) => { err.textContent = msg; text.setAttribute("aria-invalid", "true"); text.focus(); };
  const v = text.value;
  if (v.trim() === "") return fail("Enter some text to count.");
  if (v.length > WC_MAX) return fail(`The text has ${v.length.toLocaleString("en-US")} characters; the limit is 10,000.`);
  if (!app.token) return fail("Enter the API token on Connection & API first: submitting needs it.");
  text.removeAttribute("aria-invalid");
  err.textContent = "";
  if (!app.submitIntent || app.submitIntent.text !== v) {
    app.submitIntent = { text: v, key: `ui-word-count-${crypto.randomUUID()}` };
  }
  const intent = app.submitIntent;
  const gen = app.authGen;
  app.submitInFlight = true;
  $("submit-job").disabled = true;
  let r;
  try {
    r = await api("/jobs", { method: "POST", headers: { "Idempotency-Key": intent.key },
                             body: { kind: "word_count", payload: { text: intent.text }, max_attempts: 3 } });
  } catch (x) {
    if (gen !== app.authGen) return;
    return fail("Cannot reach the API. Check Connection & API and try again.");
  } finally {
    if (gen === app.authGen) {
      app.submitInFlight = false;
      const button = $("submit-job");
      if (button) button.disabled = false;
    }
  }
  if (gen !== app.authGen) return;
  if (r.status === 401) { handleUnauthorized(); return; }
  if (r.status !== 201 && r.status !== 200) return fail(`The API refused the job (HTTP ${r.status}). ${detailText(r.body)}`);
  app.submit = { id: String(r.body.id), job: r.body, started: Date.now() };
  renderSubmitResult();
  startSubmitPoll();
}

function startSubmitPoll() {
  stopSubmitPoll();
  const gen = app.authGen;
  const poll = async () => {
    const s = app.submit;
    if (!s || gen !== app.authGen) return;
    let r;
    try { r = await api(`/jobs/${s.id}`); } catch (e) { r = null; }
    if (gen !== app.authGen || app.submit !== s) return;
    if (r && r.status === 401) { handleUnauthorized(); return; }
    if (r && r.status === 200) s.job = r.body;
    renderSubmitResult();
    const finished = s.job.state === "done" || s.job.state === "dead";
    if (!finished && Date.now() - s.started < 120000) app.submitTimer = window.setTimeout(poll, 500);
  };
  app.submitTimer = window.setTimeout(poll, 300);
}
function stopSubmitPoll() {
  if (app.submitTimer !== null) window.clearTimeout(app.submitTimer);
  app.submitTimer = null;
}

function renderSubmitResult() {
  const box = $("submit-result");
  if (!box) return;
  const s = app.submit;
  if (!s) { box.replaceChildren(); return; }
  const job = s.job;
  const link = el("a", { href: `#/jobs/${s.id}`, text: `Open job ${s.id}` });
  const waited = Math.round((Date.now() - s.started) / 1000);
  if (job.state === "done" && job.result) {
    box.replaceChildren(
      el("h2", { text: `Job ${s.id} is done` }),
      el("div", { class: "result-figures" },
        el("div", {}, el("strong", { text: String(job.result.words) }), el("span", { text: "words" })),
        el("div", {}, el("strong", { text: String(job.result.lines) }), el("span", { text: "lines" }))),
      el("p", { class: "sr-only", text: `${job.result.words} words, ${job.result.lines} lines.` }),
      el("p", {}, `Counted by worker `, el("span", { class: "mono", text: job.leased_by || "" }),
         ` on attempt ${job.attempts}. `, link));
  } else if (job.state === "dead") {
    box.replaceChildren(el("h2", { text: `Job ${s.id} failed` }),
      el("p", {}, "The handler could not finish it. The error is in the job's lifecycle. ", link));
  } else if (job.state === "leased") {
    box.replaceChildren(el("p", {}, `Job ${s.id} is running on worker `,
      el("span", { class: "mono", text: job.leased_by || "" }), ". ", link));
  } else {
    box.replaceChildren(el("p", {}, `Job ${s.id} is queued, waiting for a worker to claim it. `, link),
      waited >= 10 ? el("p", { class: "hint" }, `No worker has claimed it after ${waited} s. Start one with `,
                        el("code", { text: "python -m leaseq.worker" }), " or ", el("code", { text: "docker compose up" }), ".") : null);
  }
}

/* ---------- Connection & API screen ---------- */

function viewConnection() {
  const origin = window.location.origin;
  const statusText = {
    unknown: "Checking…",
    token: "Connected. The server accepted the token in this page's memory.",
    public: "Reading without a token (the server runs with LEASEQ_PUBLIC_READ=1). Submit, requeue and cancel still need the token.",
    "needs-token": "Not connected: this server needs the API token to read jobs.",
    offline: "The API does not answer. Start it with scripts/up.sh (Docker Compose) or uvicorn leaseq.api:app.",
  }[app.conn];

  let tokenPart;
  if (app.token) {
    const forget = el("button", { type: "button", class: "btn", text: "Forget token" });
    forget.addEventListener("click", forgetToken);
    tokenPart = [el("p", { id: "token-ok" }, "A token is in this page's memory. It is sent only in the Authorization " +
                    "header and never stored; reloading the page forgets it. ", el("a", { href: app.lastJobsHash, id: "go-jobs", text: "Go to Jobs" })),
                 el("div", { class: "form-actions" }, forget)];
  } else {
    const input = el("input", { class: "input", id: "token-input", type: "password", autocomplete: "off",
                                spellcheck: "false", "aria-describedby": "token-hint token-error", required: true });
    const form = el("form", { id: "token-form", class: "form-stack", novalidate: true },
      el("label", { for: "token-input", text: "API token" }),
      el("p", { class: "hint", id: "token-hint" }, "The value of ", el("code", { text: "LEASEQ_API_TOKEN" }),
         " on the server (", el("code", { text: "scripts/up.sh" }), " writes it to ", el("code", { text: ".env" }),
         "). Kept in this page's memory only."),
      input,
      el("p", { class: "field-error", id: "token-error" }),
      el("div", { class: "form-actions" }, el("button", { type: "submit", class: "btn primary", text: "Use token" })));
    form.addEventListener("submit", submitToken);
    tokenPart = [form];
  }

  const ep = [
    ["POST", "/jobs", "Submit a job (Idempotency-Key header)", "yes"],
    ["POST", "/jobs/claim", "Worker takes the oldest runnable job under a lease", "yes"],
    ["POST", "/jobs/{id}/heartbeat", "Worker extends its lease", "yes"],
    ["POST", "/jobs/{id}/complete", "Worker stores the result (fenced by lease token)", "yes"],
    ["POST", "/jobs/{id}/fail", "Worker reports an error; retry with backoff or dead", "yes"],
    ["POST", "/jobs/{id}/requeue", "Operator: dead job back to the queue", "yes"],
    ["POST", "/jobs/{id}/cancel", "Operator: mark dead and revoke its lease; does not stop previously claimed work", "yes"],
    ["GET", "/jobs", "List jobs, newest first, with state counts", "unless public read"],
    ["GET", "/jobs/{id}", "One job", "unless public read"],
    ["GET", "/jobs/{id}/events", "A job's audit log", "unless public read"],
    ["GET", "/healthz", "Liveness and version", "no"],
  ];
  const errors = [
    ["401", "Missing or wrong token. This page clears all job data when it sees one."],
    ["404", "No job with that id."],
    ["409", "The lease token is not the current lease (the fence), or the job is in the wrong state for requeue/cancel."],
    ["413", "Request body larger than LEASEQ_MAX_BODY_BYTES (64 KiB by default)."],
    ["422", "Invalid input: says which field and why, without echoing the value."],
  ];
  const table = (head, rows, label) => el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": label },
    el("table", {}, el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col", text: h })))),
       el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => el("td", { class: i < 2 && head[0] === "Method" ? "mono" : null, text: c })))))));

  return [
    h1("Connection & API"),
    el("p", { class: "lede", text: "LeaseQ runs on your own machine. This page talks only to the leaseq API that " +
                                   "served it. It is a local recovery and reference queue, not a hosted service." }),
    el("section", { class: "panel", "aria-labelledby": "tok-title" },
      el("div", { class: "panel-body" }, el("h2", { id: "tok-title", text: "Token" }), ...tokenPart)),
    el("section", { class: "panel", "aria-labelledby": "st-title" },
      el("div", { class: "panel-body" }, el("h2", { id: "st-title", text: "Status" }),
        el("dl", { class: "fields" },
          el("dt", { text: "API address" }), el("dd", {}, el("code", { text: origin })),
          el("dt", { text: "Server version" }), el("dd", { id: "conn-version", text: app.version || "unknown" }),
          el("dt", { text: "Connection" }), el("dd", { id: "conn-detail", text: statusText })))),
    el("section", { class: "panel guide", "aria-labelledby": "guide-title" },
      el("div", { class: "panel-body" },
        el("h2", { id: "guide-title", text: "API guide" }),
        el("p", {}, "Every call except ", el("code", { text: "/healthz" }), " needs ",
           el("code", { text: "Authorization: Bearer <token>" }), ". Full reference: ",
           el("a", { href: "/docs", text: "interactive API docs" }), " (needs JavaScript) or the ",
           el("a", { href: "/openapi.json", text: "OpenAPI description (JSON)" }), "."),
        el("h3", { text: "Submit a job and read it back" }),
        el("pre", { class: "cmd", tabindex: "0", "aria-label": "Example commands" },
          el("code", { text: `export LEASEQ_API_TOKEN=...   # from .env\n` +
            `curl -s -X POST ${origin}/jobs \\\n  -H "Authorization: Bearer $LEASEQ_API_TOKEN" \\\n` +
            `  -H "Idempotency-Key: my-first-job" -H "Content-Type: application/json" \\\n` +
            `  -d '{"kind": "word_count", "payload": {"text": "to be or not to be"}}'\n\n` +
            `curl -s ${origin}/jobs/1 -H "Authorization: Bearer $LEASEQ_API_TOKEN"` })),
        el("h3", { text: "Endpoints" }),
        table(["Method", "Path", "What it does", "Token"], ep, "Endpoints, scrolls sideways"),
        el("h3", { text: "Error answers" }),
        table(["Status", "Meaning"], errors, "Error answers, scrolls sideways"))),
  ];
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
  const gen = app.authGen;
  const r = await fetch("/auth/check", {
    headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
    credentials: "omit", cache: "no-store",
  }).catch(() => null);
  if (gen !== app.authGen) return;
  if (!r) return fail("Cannot reach the API to check the token.");
  if (r.status === 401) return fail("The server rejected this token.");
  if (r.status !== 200) return fail(`Unexpected answer from the server (HTTP ${r.status}).`);
  input.value = "";
  app.token = value;
  clearSensitive();          // nothing read without the token survives into the new session
  setConn("token");
  hideBanner();
  renderView(false);
  announce("Token accepted. Job data, submit, requeue and cancel are available.");
  const go = $("go-jobs");
  if (go) go.focus();
  pollNow();
}

function viewNotFound() {
  return [h1("Not found"),
          el("p", { class: "lede", text: "There is no screen at this address." }),
          el("p", {}, el("a", { href: "#/jobs", text: "Go to Jobs" }))];
}

/* ---------- polling ---------- */

async function refreshJobs() {
  const p = new URLSearchParams({ limit: String(app.rows) });
  if (app.filters.state) p.set("state", app.filters.state);
  if (app.filters.kind) p.set("kind", app.filters.kind);
  if (app.filters.worker) p.set("worker", app.filters.worker);
  const gen = app.authGen;
  const key = app.routeKey;
  const r = await api(`/jobs?${p}`);
  if (gen !== app.authGen) return;          // sent before a token change or a clear
  if (r.status === 401) { handleUnauthorized(); return; }
  if (key !== app.routeKey) return;         // this response belongs to an earlier view
  if (r.status !== 200) {
    const why = detailText(r.body).replace(/\.$/, "");
    showBanner(`The API answered HTTP ${r.status}.${why ? ` ${why}.` : ""} Check that this page is ` +
               "served by the leaseq API; it retries every 2 seconds.", false);
    return;
  }
  hideBanner();
  noteReadable();
  app.list = r.body;
  if (app.route.name === "jobs") renderJobsData();
}

async function refreshJob(id) {
  const gen = app.authGen;
  const key = app.routeKey;
  const [jr, er] = await Promise.all([api(`/jobs/${id}`), api(`/jobs/${id}/events?limit=500`)]);
  if (gen !== app.authGen) return;
  if (jr.status === 401 || er.status === 401) { handleUnauthorized(); return; }
  if (jr.status === 200 && er.status === 200) {
    app.details.set(id, { job: jr.body, events: er.body.events, more: er.body.next_after_id !== null });
  } else if (jr.status === 404) {
    app.details.set(id, { notfound: true });
  } else {
    if (key !== app.routeKey) return;
    const failed = jr.status !== 200 ? jr : er;
    const path = jr.status !== 200 ? `/jobs/${id}` : `/jobs/${id}/events`;
    showBanner(`The API request ${path} answered HTTP ${failed.status}. It retries every 2 seconds.`, false);
    return;
  }
  if (key !== app.routeKey) return;
  hideBanner();
  noteReadable();
  if (app.route.name === "job" && app.route.id === id) renderJobData();
}

// A light check for screens that show no job list: is the API there, and does it
// accept what this page holds?
async function probe() {
  const gen = app.authGen;
  const r = await api(app.token ? "/auth/check" : "/jobs?limit=1");
  if (gen !== app.authGen) return;
  if (r.status === 401) { handleUnauthorized(); return; }
  if (r.status === 200) { hideBanner(); noteReadable(); }
}

function noteReadable() {
  const next = app.token ? "token" : "public";
  if (app.conn !== next) {
    const wasBlocked = app.conn === "needs-token" || app.conn === "offline";
    setConn(next);
    if (wasBlocked || app.route.name === "connection") renderView(false);
  }
}

async function refresh() {
  if (app.inflight) return;
  app.inflight = true;
  const gen = app.authGen;
  const key = app.routeKey;
  try {
    const r = app.route;
    if (r.name === "jobs") await refreshJobs();
    else if (r.name === "job") await refreshJob(r.id);
    else await probe();
  } catch (e) {
    if (gen !== app.authGen || key !== app.routeKey) return;
    if (app.conn !== "offline") {
      setConn("offline");
      showBanner(`Cannot reach the API${e.path ? ` (${e.path})` : ""}. Trying again every 2 seconds.`, false);
      if (!hasSensitive() || app.route.name !== "jobs") renderView(false);
    }
    if ($("updated")) $("updated").textContent = "Offline";
  } finally {
    app.inflight = false;
  }
}

function pollNow() { refresh(); }

function tick() {
  refreshRelativeTimes();
  if (app.route.name === "submit" && app.submit) renderSubmitResult();
  if (!app.paused && !document.hidden) refresh();
}

// No polling at all while the tab is hidden; one refresh as soon as it is
// visible again, then every REFRESH_MS as before.
function startPolling() {
  if (app.timer === null) app.timer = window.setInterval(tick, REFRESH_MS);
}
function stopPolling() {
  if (app.timer !== null) window.clearInterval(app.timer);
  app.timer = null;
}
function onVisibilityChange() {
  if (document.hidden) { stopPolling(); return; }
  startPolling();
  tick();
}

function togglePause() {
  app.paused = !app.paused;
  // The label says what the button will do; no aria-pressed as well (one state mechanism).
  $("pause").textContent = app.paused ? "Resume updates" : "Pause updates";
  announce(app.paused ? "Automatic updates paused." : "Automatic updates resumed.");
  if (!app.paused) refresh();
}

/* ---------- theme and menu ---------- */

function renderThemeButtons() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  for (const b of document.querySelectorAll("[data-theme-toggle]")) {
    b.textContent = dark ? "Use light theme" : "Use dark theme";
  }
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") !== "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try {
    if (dark) window.localStorage.setItem("leaseq-theme", "dark");
    else window.localStorage.removeItem("leaseq-theme");
  } catch (e) { /* storage unavailable: the choice lasts for this page only */ }
  renderThemeButtons();
  announce(dark ? "Dark theme on." : "Light theme on.");
}

function initMenu() {
  const sheet = $("menu-sheet");
  const button = $("menu-button");
  button.addEventListener("click", () => {
    button.setAttribute("aria-expanded", "true");
    sheet.returnValue = "";
    sheet.showModal();
    const current = sheet.querySelector('a[aria-current]');
    (current || sheet.querySelector("a")).focus();
  });
  // Menu exits return focus to Menu; navigation exits leave focus on the new screen heading.
  sheet.addEventListener("close", () => {
    button.setAttribute("aria-expanded", "false");
    if (sheet.returnValue === "navigate") focusH1();
    else if (window.getComputedStyle(button).display !== "none") button.focus();
  });
  $("menu-close").addEventListener("click", () => sheet.close());
  for (const a of sheet.querySelectorAll("a")) a.addEventListener("click", () => {
    sheet.close("navigate");
  });
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });   // backdrop
  button.setAttribute("aria-expanded", "false");
  window.matchMedia("(min-width: 1000px)").addEventListener("change", (m) => { if (m.matches && sheet.open) sheet.close(); });
}

/* ---------- start ---------- */

async function loadVersion() {
  try {
    const r = await fetch("/healthz", { credentials: "omit", cache: "no-store" });
    const b = await r.json();
    if (b && b.version) {
      app.version = String(b.version);
      $("version").textContent = `leaseq ${app.version}`;
      if ($("conn-version")) $("conn-version").textContent = app.version;
    }
  } catch (e) { /* shown as "unknown"; the poll reports the outage */ }
}

function init() {
  migrateOldLink();
  initMenu();
  renderThemeButtons();
  for (const b of document.querySelectorAll("[data-theme-toggle]")) b.addEventListener("click", toggleTheme);
  $("forget-token").addEventListener("click", forgetToken);
  setConn("unknown");
  window.addEventListener("hashchange", onLocationChange);
  window.addEventListener("popstate", onLocationChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  app.route = { name: "", id: null };
  onLocationChange();
  // First load: focus the page's H1 only if the person did not arrive with a
  // fragment-less URL; either way the H1 is the first heading.
  loadVersion();
  if (!document.hidden) startPolling();
}

document.addEventListener("DOMContentLoaded", init);
