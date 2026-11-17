"use strict";
/* LeaseQ operations console. Plain JavaScript, no build step, no third-party code.

   Screens are hash routes so the page works from any static host and every view
   has a shareable URL:
     #/jobs[?state=&kind=&worker=]  Jobs: state lanes (real counts, act as filters) + job table
     #/jobs/<id>                    Job details: why it waits, lifecycle timeline, payload, result,
                                    protected Cancel / Requeue
     #/submit                       Submit a JSON job through the real queue and worker
     #/connection                   Connection & API: token, status, API guide
   Old links (?job=N, ?state=, ?kind=, ?worker=) are rewritten to these routes.

   Security notes
   * Everything the API returns (kinds, payloads, results, error text, worker ids,
     idempotency keys) was written by API clients, so it is untrusted. It reaches the
     page only via textContent / createTextNode, never as HTML.
   * The API token is page-memory-only and is sent only in the Authorization header, never a cookie,
     localStorage or URL. Forget and any 401 clear it.
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
const ASSET_ROOT = new URL(".", document.currentScript?.src || new URL("assets/app.js", location.href));
const SAMPLE_TEXT = new URL("sample/pride-and-prejudice-ch1.txt", ASSET_ROOT).href;
const DEFAULT_SIM_TEXT = "audit one two\nthree four";
const SUITE_LINKS = [["FlightSeal · HashWing","https://anirudh763.github.io/flightseal/console/"],["Mavframe","https://anirudh763.github.io/mavframe/"],["CueReport","https://anirudh763.github.io/talkback-triage-pilot/"],["Issue Warehouse","https://anirudh763.github.io/a11y-issue-warehouse/"],["LeaseQ","https://anirudh763.github.io/leaseq/"],["Portfolio","https://anirudh763.github.io/portfolio/"]];
function suiteNavigation(label="Connected tools") { return el("details",{class:"suite-menu"},el("summary",{},"Other apps"),el("nav",{"aria-label":label},...SUITE_LINKS.map(([name,href])=>el("a",{href,...(name==="LeaseQ"?{"aria-current":"page"}:{}),text:name})))); }
function initialApiOrigin() {
  try {
    const saved = localStorage.getItem("leaseq:api-origin:v1");
    if (saved) return new URL(saved).origin;
  } catch { /* unavailable storage means use only the page's configured default */ }
  const configured = document.querySelector('meta[name="leaseq-api-base"]')?.content.trim();
  return configured === "none" ? null : location.origin;
}
const STATIC_API_DISABLED = document.querySelector('meta[name="leaseq-api-base"]')?.content.trim() === "none";
const INITIAL_API_ORIGIN = initialApiOrigin();

const LANES = [
  { id: "", label: "All", count: (c) => c.total },
  { id: "queued", label: "Queued", count: (c) => c.queued },
  { id: "leased", label: "Running", count: (c) => c.leased },
  { id: "retrying", label: "Retrying", count: (c) => c.retrying },
  { id: "done", label: "Done", count: (c) => c.done },
  { id: "dead", label: "Dead", count: (c) => c.dead },
];

const app = {
  apiOrigin: INITIAL_API_ORIGIN,
  apiAvailability: INITIAL_API_ORIGIN ? "unknown" : "unavailable",
  mode: INITIAL_API_ORIGIN ? "live" : "simulator",
  modeUserChoice: false,
  simulator: window.LeaseQSimulator?.fresh(DEFAULT_SIM_TEXT) || null,
  simulation: null,
  token: null,
  profile: null,
  guestSimulation: null,
  syncProvider: null,
  syncConfig: null,
  syncRemote: null,
  syncStatus: "",
  syncEpoch: 0,
  profileSaveTimer: null,
  profileSaveGeneration: 0,
  profileAuthGeneration: 0,
  showcaseTimer: null,
  showcaseIndex: 0,
  showcasePaused: false,
  demo: false,
  authGen: 0,          // bumped whenever job data must be dropped; older responses are ignored
  conn: "unknown",     // unknown | token | public | needs-token | offline
  route: { name: "jobs", id: null },
  routeKey: null,
  filters: { state: "", kind: "", worker: "" },
  rows: PAGE,
  list: null,          // last GET /jobs body (sensitive)
  details: new Map(),  // job id -> { job, events, more } | { notfound: true } (sensitive)
  submit: null,        // { id, job, started } of the last test job (sensitive)
  submitDraft: '{\n  "text": "to be or not to be"\n}',
  submitText: "",
  submitFields: { kind: "word_count", priority: "0", attempts: "3", due: "", delay: "" },
  submitKey: null,
  submitKeyExplicit: false,
  scheduleKey: null,
  scheduleConfirmed: false,
  scheduleInFlight: false,
  submitIntent: null,  // text and key kept together so an ambiguous response can be retried
  submitInFlight: false,
  submitTimer: null,
  ops: { workers: null, metrics: null, schedules: null, result: null },
  workersFetchedAt: 0,
  bulkIds: [],
  paused: false,
  inflight: false,
  pendingApiRequests: 0,
  timer: null,
  lastJobsHash: "#/jobs",
  version: null,
};
window.LeaseQGetUpdateState = () => ({ inFlight: app.inflight || app.pendingApiRequests > 0 || !!app.authPending, submitInFlight: app.submitInFlight,
  submitIntent: !!app.submitIntent, scheduleInFlight: app.scheduleInFlight,
  profileDraftCanPersist: !!app.profile && app.route.name === "submit" });

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
  if (!app.apiOrigin) { const error = new Error("No Live API origin is configured"); error.path = path.split("?")[0]; throw error; }
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  app.pendingApiRequests += 1;
  try {
    let res;
    try {
      res = await fetch(new URL(path, app.apiOrigin).href, {
        method: options.method || "GET",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (e) {
      const failure = new Error("Cannot reach the API");
      failure.path = path.split("?")[0];
      throw failure;
    }
    let body = null;
    if (res.status !== 204) {
      try { body = options.text ? await res.text() : await res.json(); } catch (e) { body = null; }
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
    app.pendingApiRequests -= 1;
  }
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
  app.reportJobId = null;
  app.reportSource = null;
  app.system = null;
  app.guestSimulation = null;
  app.details.clear();
  app.submit = null;
  app.submitDraft = "";
  app.submitText = "";
  app.submitFields = { kind: "word_count", priority: "0", attempts: "3", due: "", delay: "" };
  app.submitKey = null;
  app.submitKeyExplicit = false;
  app.scheduleKey = null;
  app.scheduleConfirmed = false;
  app.scheduleDraft = null;
  app.scheduleInFlight = false;
  app.submitIntent = null;
  app.submitInFlight = false;
  app.ops = { workers: null, metrics: null, schedules: null, result: null };
  app.workersFetchedAt = 0;
  app.bulkIds = [];
  try { sessionStorage.removeItem("leaseq-api-token"); } catch (e) { /* storage may be blocked */ }
  stopSubmitPoll();
  resetConfirmation();
  $("status").textContent = "";
}

function setConn(state) {
  app.conn = state;
  syncModeChrome();
}

function syncModeChrome() {
  const state = app.conn;
  const localDemo = app.localDemo && (demoWorkspace() || app.route.name === 'overview' || app.route.name === 'reports' && reportSource() === 'demo');
  const s = $("conn-status");
  const text = localDemo ? (app.localDemoError ? "Demo disconnected" : "Demo connected") : { unknown: "Checking connection", token: "Connected with token", public: "Reading without token",
                 "needs-token": "Not connected", offline: "API unreachable" }[state];
  const connected = localDemo ? !app.localDemoError : state === "token" || state === "public";
  const checking = !localDemo && state === "unknown";
  s.className = `conn ${connected ? "ok" : checking ? "" : "warn"}`;
  s.replaceChildren(icon(connected ? "done" : checking ? "queued" : "dead"),
                    el("span", { text }));
  $("forget-token").hidden = !app.token;

  const label = $("mode-label"), toggle = $("mode-toggle");
  if (!label || !toggle) return;
  if (app.mode === "simulator") {
    label.textContent = "Browser Simulator · local session only";
    toggle.textContent = app.apiOrigin ? "Switch to Live API" : "Configure Live API";
    toggle.setAttribute("aria-label", app.apiOrigin ? "Switch to Live API" : "Configure Live API origin");
  } else {
    const status = app.apiAvailability === "unknown" ? "checking availability" : app.apiAvailability === "available" ? "connected endpoint" : app.apiAvailability === "auth" ? "authorization required" : app.apiAvailability === "unavailable" ? "unavailable" : "configuration needs review";
    label.textContent = localDemo ? "Isolated PostgreSQL demo" : `Live API · ${status}`;
    toggle.textContent = "Switch to Browser Simulator";
    toggle.setAttribute("aria-label", "Switch to Browser Simulator");
  }
}

function changeMode(mode) {
  app.modeUserChoice = true;
  app.mode = mode;
  if (mode === "simulator") {
    app.demo = false;
    stopPolling();
    if (app.route.name === "landing" || app.route.name === "signup" || app.route.name === "login") window.location.hash = "#/app?mode=simulator";
    else if (app.routeKey !== "#/app?mode=simulator") window.location.hash = "#/app?mode=simulator";
    syncModeChrome();
  } else {
    app.demo = false;
    if (!app.apiOrigin) {
      app.apiAvailability = "unavailable";
      window.location.hash = "#/connection";
      syncModeChrome();
      return;
    }
    app.apiAvailability = "unknown";
    syncModeChrome();
    window.location.hash = "#/app?mode=live";
    loadVersion();
  }
}

function handleUnauthorized() {
  const hadToken = app.token !== null;
  const dirty = hasSensitive() || hadToken || app.conn !== "needs-token";
  app.token = null;
  app.apiAvailability = "auth";
  app.mode = "live";
  clearSensitive();
  setConn("needs-token");
  showBanner(hadToken
    ? "The server rejected the API token, so all job data was cleared from this page."
    : "This server requires the API token to read jobs.", true);
  if (dirty && (hadToken || app.route.name !== 'connection')) renderView(false);
  else if ($('conn-detail')) $('conn-detail').textContent = 'Not connected. Enter the API token to continue.';
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

const PRODUCT_PATHS = { '/': ['overview', 'overview'], '/overview': ['overview', 'overview'], '/workbench': ['jobs', 'workbench'], '/reports': ['reports', 'reports'], '/settings': ['connection', 'settings'], '/leases': ['operations', 'leases'], '/dead-letter': ['jobs', 'dead-letter'], '/system': ['system', 'system'] };
const WORKBENCH_TOOLS = new Set(['demo', 'jobs', 'leases', 'new', 'dead-letter']);
function canonicalRoute(path, params) {
  const page = path === '/' ? 'overview' : path.slice(1);
  if (!['overview', 'workbench', 'reports', 'settings'].includes(page)) return null;
  const tool = page === 'workbench' && WORKBENCH_TOOLS.has(params.get('tool')) ? params.get('tool') : 'demo';
  const name = page === 'workbench' ? ({ leases: 'operations', new: 'submit' }[tool] || 'jobs') : page === 'settings' ? 'connection' : page;
  return { name, page: tool === 'dead-letter' && page === 'workbench' ? 'dead-letter' : tool === 'leases' && page === 'workbench' ? 'leases' : page, canonical: page, tool, id: null, params };
}
const workspaceHref = (page, params = {}) => `${STATIC_API_DISABLED ? '#/' : '/'}${page}${new URLSearchParams(params).size ? '?' + new URLSearchParams(params) : ''}`;
function parseLocation({ pathname = '/', search = '', hash = '' }) {
  if (hash || STATIC_API_DISABLED) return parseHash(hash || '#/');
  const product = PRODUCT_PATHS[pathname];
  if (!product) return parseHash(pathname.endsWith('/dashboard/') || STATIC_API_DISABLED ? '#/' : '#/not-found');
  const params = new URLSearchParams(search);
  const canonical = canonicalRoute(pathname, params);
  if (canonical) return { ...canonical, direct: true };
  if (pathname === '/dead-letter') params.set('state', 'dead');
  return { name: product[0], page: product[1], id: null, params, direct: true };
}
function productLocation() { return !STATIC_API_DISABLED && Object.hasOwn(PRODUCT_PATHS, window.location.pathname); }


function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "") || "/jobs";
  const [path, query = ""] = raw.split("?");
  const p = new URLSearchParams(query);
  if (path !== '/') {
    const canonical = canonicalRoute(path, p);
    if (canonical) return canonical;
  }
  if (path === "/" || path === "") return { name: "landing", id: null, params: p };
  if (path === "/signup") return { name: "signup", id: null, params: p };
  if (path === "/login") return { name: "login", id: null, params: p };
  if (path === "/app" || path === "/app/jobs") return { name: "jobs", id: null, params: p };
  if (path === "/app/submit") return { name: "submit", id: null, params: p };
  if (path === "/app/operations") return { name: "operations", id: null, params: p };
  if (path === "/app/connection") return { name: "connection", id: null, params: p };
  const nestedJob = /^\/app\/jobs\/(?:job-)?([0-9]{1,19})$/.exec(path);
  if (nestedJob && BigInt(nestedJob[1]) > 0n && BigInt(nestedJob[1]) <= 9223372036854775807n) return { name: "job", id: BigInt(nestedJob[1]).toString(), params: p };
  if (path === "/jobs" ) return { name: "jobs", id: null, params: p };
  const m = /^\/jobs\/(?:job-)?([0-9]{1,19})$/.exec(path);
  if (m && BigInt(m[1]) > 0n && BigInt(m[1]) <= 9223372036854775807n)
    return { name: "job", id: BigInt(m[1]).toString(), params: p };
  if (path.startsWith("/jobs/")) return { name: "invalidid", id: null, params: p };
  if (path === "/submit") return { name: "submit", id: null, params: p };
  if (path === "/system") return { name: "system", id: null, params: p };
  if (path === "/dead-letter") { p.set("state", "dead"); return { name: "jobs", page: "dead-letter", id: null, params: p }; }
  if (path === "/operations") return { name: "operations", id: null, params: p };
  if (path === "/connection") return { name: "connection", id: null, params: p };
  return { name: "notfound", id: null, params: p };
}

function jobsHash(f) {
  const p = new URLSearchParams();
  if (f.state) p.set("state", f.state);
  if (f.kind) p.set("kind", f.kind);
  if (f.worker) p.set("worker", f.worker);
  const qs = p.toString();
  if (productLocation()) {
    const path = app.route.canonical === 'workbench' ? '/workbench' : app.route.page === 'dead-letter' && f.state === 'dead' ? '/dead-letter' : '/workbench';
    if (path === '/workbench') p.set('tool', app.route.page === 'dead-letter' && f.state === 'dead' ? 'dead-letter' : 'jobs');
    if (path === '/dead-letter') p.delete('state');
    return `${path}${p.size ? `?${p}` : ''}`;
  }
  return `#/jobs${qs ? `?${qs}` : ""}`;
}

// Old shared links: /dashboard/?job=12 and /dashboard/?state=dead&kind=x.
function migrateOldLink() {
  const q = new URLSearchParams(window.location.search);
  if (productLocation() && !q.has('job')) return;
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
  const key = window.location.hash || (productLocation() ? window.location.pathname + window.location.search : '#/');
  if (key === "#main") { $("main").focus({ preventScroll: true }); return; }
  if (key.startsWith("#") && !key.startsWith("#/")) { const target = document.getElementById(key.slice(1)); if (target) { target.scrollIntoView(); return; } }
  if (key === app.routeKey) return;
  const prev = app.route;
  app.routeKey = key;
  app.route = parseLocation(window.location);
  if (app.route.canonical === 'workbench') app.lastWorkbenchHref = window.location.pathname + window.location.search + window.location.hash;
  if (app.route.direct) { app.mode = 'live'; app.modeUserChoice = true; }
  app.demo = app.route.name === "jobs" && app.route.params.get("demo") === "1";
  const requestedMode = app.route.params.get("mode");
  if (requestedMode === "simulator" || app.demo) { app.mode = "simulator"; app.modeUserChoice = true; }
  else if (requestedMode === "live") { app.mode = "live"; app.modeUserChoice = true; }
  else if (!app.modeUserChoice && app.apiAvailability === "unavailable") app.mode = "simulator";
  syncModeChrome();
  app.profileAuthGeneration += 1;
  if (["landing","signup","login"].includes(app.route.name) || app.demo) stopPolling();
  else if (!document.hidden) startPolling();
  if (app.route.name === "jobs") {
    readFilters(app.route.params);
    if (app.route.page === 'dead-letter') app.filters.state = 'dead';
    app.lastJobsHash = key;
  }
  const sheet = $("menu-sheet");
  if (sheet.open) sheet.close("navigate");
  const sameScreen = prev.name === app.route.name && prev.id === app.route.id && prev.page === app.route.page && app.view;
  renderView(!sameScreen);
  pollNow();
}

// Navigation inside the Jobs screen (filters): a new history entry, same screen.
function pushJobsFilters() {
  const hash = jobsHash(app.filters);
  if (hash === app.routeKey) { pollNow(); return; }
  window.history.pushState(null, "", hash.startsWith('#') ? window.location.pathname + hash : hash);
  const previousPage = app.route.page;
  app.routeKey = hash;
  app.route = parseLocation(window.location);
  if (previousPage !== app.route.page) renderView(true);
  if (app.route.canonical === 'workbench') app.lastWorkbenchHref = hash;
  app.lastJobsHash = hash;
  app.rows = PAGE;
  renderLanes();
  pollNow();
}

const TITLES = { landing: "LeaseQ", signup: "Create local profile", login: "Log in", jobs: "Jobs", submit: "New job", operations: "Workers", connection: "Settings", notfound: "Not found", invalidid: "Invalid job ID" };

function screenTitle() {
  if (app.route.canonical) return { overview: 'Overview', workbench: 'Workbench', reports: 'Reports', settings: 'Settings' }[app.route.canonical];
  if (app.localDemo && app.route.direct && !app.token) return {overview:'Queue operations', leases:'Lease ownership', 'dead-letter':'Failed jobs', system:'Health and Metrics'}[app.route.page];
  if (app.route.direct) return { overview: 'Live Queue Overview', leases: 'Active Workers and Lease/Lock Inspector', 'dead-letter': 'Failed Job Replay and Triage', system: 'Health and Metrics' }[app.route.page];
  if (app.route.page === 'dead-letter') return 'Failed Job Replay and Triage';
  if (app.route.name === 'system') return 'Health and Metrics';
  return app.route.name === "job" ? `Job ${app.route.id}` : TITLES[app.route.name];
}

function focusH1() {
  const h = document.querySelector("#view h1");
  if (h) h.focus({ preventScroll: false });
}

function renderChrome() {
  const title = screenTitle();
  const inPublic = ["landing","signup","login"].includes(app.route.name);
  document.body.classList.toggle('canonical-shell', !inPublic);
  const right = $("account-session");
  right.replaceChildren(el("span", { class: "profile-badge", text: app.profile ? `Local profile: ${app.profile.email}` : app.demo ? "Synthetic demo session" : "No local profile" }));
  if (app.profile || app.demo) { const logout = el("button", { id: "profile-logout", class: "btn", type: "button", text: "Log out" }); logout.addEventListener("click", logoutProfile); right.append(logout); }
  $("settings-utilities").hidden = app.route.name !== 'connection';
  document.title = `${title} – LeaseQ`;
  const active = app.route.canonical || (app.route.name === 'connection' || app.route.name === 'system' ? 'settings' : 'workbench');
  for (const a of document.querySelectorAll('[data-canonical]')) {
    const page = a.dataset.canonical;
    a.href = page === 'workbench' && app.lastWorkbenchHref ? app.lastWorkbenchHref : workspaceHref(page);
    if (a.closest('[data-nav]') && page === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const crumbs = $("crumbs");
  const items = [el("li", {}, el("a", { href: "#/jobs", text: "LeaseQ" }))];
  if (app.route.name === "job") items.push(el("li", {}, el("a", { href: app.lastJobsHash, text: "Jobs" })));
  items.push(el("li", {}, el("span", { "aria-current": "page", text: title })));
  crumbs.replaceChildren(...items);
}

// Keep detail descendants stable while polling; only changed text and attributes move.
function reconcileChildren(parent, nextNodes) {
  const current = [...parent.childNodes];
  const used = new Set();
  nextNodes.forEach((next, index) => {
    let old = next.id ? [...parent.querySelectorAll("[id]")].find((node) => node.id === next.id) : null;
    if (!old || old.parentNode !== parent || used.has(old)) {
      const candidate = current[index];
      old = candidate && candidate.nodeType === next.nodeType &&
        (candidate.nodeType !== Node.ELEMENT_NODE || candidate.tagName === next.tagName) && !used.has(candidate)
        ? candidate : null;
    }
    if (!old) {
      parent.insertBefore(next, current[index] || null);
      used.add(next);
      return;
    }
    used.add(old);
    if (old.nodeType === Node.TEXT_NODE) {
      if (old.textContent !== next.textContent) old.textContent = next.textContent;
      return;
    }
    for (const attr of [...old.attributes]) if (!next.hasAttribute(attr.name)) old.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
    old.onclick = next.onclick;
    reconcileChildren(old, [...next.childNodes]);
    if (old !== current[index]) parent.insertBefore(old, current[index] || null);
  });
  for (const node of current) if (!used.has(node) && node.parentNode === parent) node.remove();
}

// Build the current screen from app state. moveFocus: a new screen (focus its H1,
// scroll to top); false: the same screen redrawn (for example after Forget).
function renderView(moveFocus) {
  renderChrome();
  const view = $("view");
  document.querySelector(".shell").classList.toggle("public-page", ["landing","signup","login"].includes(app.route.name));
  const simulatorRoute = app.mode === "simulator" && !["landing","signup","login","connection","system","notfound","invalidid"].includes(app.route.name);
  const build = { overview: viewOverview, reports: viewReports, landing: viewLanding, signup: viewAuth, login: viewAuth, jobs: simulatorRoute || app.demo ? viewDemo : viewJobs, job: simulatorRoute ? viewDemo : viewJob, submit: simulatorRoute ? viewDemo : viewSubmit, operations: simulatorRoute ? viewDemo : viewOperations, connection: viewConnection, system: viewSystem,
                  notfound: viewNotFound, invalidid: viewInvalidId }[app.route.name];
  const demo = demoWorkspace();
  const content = demo ? app.localDemo ? viewLocalPostgresDemo() : [h1(screenTitle()), el('p', { id: 'demo-unavailable', role: 'status', text: app.apiAvailability === 'unknown' ? 'Checking availability of the isolated PostgreSQL demo…' : 'The isolated PostgreSQL demo is unavailable here. Connect to an authorized API in Settings, or use the browser simulator.' }), el('a', { href: '#/app?mode=simulator', text: 'Open browser simulator' })] : build();
  view.replaceChildren(...content.filter((n) => n !== null && n !== undefined && n !== ""));
  if (app.route.canonical) view.querySelector('h1').textContent = screenTitle();
  if (app.route.canonical === 'workbench' || (!app.route.canonical && ['jobs','job','operations','submit'].includes(app.route.name))) view.querySelector('h1').after(workbenchTabs());
  if (demo) renderLocalPostgresDemo();
  if (app.route.name === 'overview') renderOverviewStatus();
  if (app.route.name === 'reports') renderReports();
  if (app.route.canonical === 'settings') { view.append(...viewSystem().slice(1)); renderSystem(); }
  app.view = app.route.name;
  if (app.route.name === "jobs" && !app.demo) renderJobsData();
  if (app.route.name === "job") renderJobData();
  if (app.route.name === "submit") renderSubmitResult();
  if (app.route.name === "operations") renderOperations();
  if (app.route.name === 'system') renderSystem();
  if (["landing","signup","login"].includes(app.route.name)) initLandingControls();
  if (moveFocus) {
    window.scrollTo(0, 0);
    focusH1();
  }
}

function demoWorkspace() {
  return app.route.canonical === 'workbench' ? app.route.tool === 'demo' : !app.route.canonical && app.localDemo && app.route.direct && !app.token && ['jobs', 'operations'].includes(app.route.name);
}

function workbenchTabs() {
  const nav = el('nav', { class: 'workbench-tabs', 'aria-label': 'Queue workflow' });
  const current = app.route.tool || (app.route.name === 'submit' ? 'new' : app.route.name === 'operations' ? 'leases' : app.route.page === 'dead-letter' ? 'dead-letter' : 'jobs');
  for (const [tool, label] of [['demo', 'Isolated demo'], ['jobs', 'Jobs'], ['leases', 'Leases'], ['new', 'New job'], ['dead-letter', 'Dead letter']]) {
    const params = { tool };
    if (['jobs', 'dead-letter'].includes(tool)) for (const [key, value] of Object.entries(app.filters)) if (value && !(tool === 'dead-letter' && key === 'state')) params[key] = value;
    const legacy = !app.route.canonical && !app.route.direct;
    const href = legacy ? ({ demo: '#/app?mode=simulator', jobs: '#/jobs', leases: '#/operations', new: '#/submit', 'dead-letter': '#/dead-letter' })[tool] : workspaceHref('workbench', params);
    nav.append(el('a', { href, 'aria-current': current === tool ? 'page' : null, text: label }));
  }
  return nav;
}

function viewOverview() {
  return [h1('Overview'), el('p', { class: 'page-purpose', text: 'Inspect jobs, lease ownership and recovery in a PostgreSQL queue.' }),
    el('section', { class: 'panel', 'aria-labelledby': 'overview-status-title' }, el('div', { class: 'panel-body' },
      el('h2', { id: 'overview-status-title', text: 'Available on this instance' }), el('div', { id: 'overview-status', role: 'status' }))),
    el('section', { class: 'panel quick-start', 'aria-labelledby': 'quick-start-title' }, el('div', { class: 'panel-body' },
      el('h2', { id: 'quick-start-title', text: 'Try lease recovery' }),
      el('p', { text: 'Run a sample job, crash its worker, then inspect the replacement lease and rejected stale completion.' }),
      el('a', { class: 'btn primary', href: workspaceHref('workbench'), text: 'Open isolated PostgreSQL demo' }),
      el('p', { class: 'hint', text: 'The demo uses a separate database and process-owned worker. Your live queue is untouched.' }))),
    el('nav', { class: 'workspace-next', 'aria-label': 'Next workspace' }, el('a', { href: workspaceHref('reports'), text: 'Review job evidence' }), el('a', { href: workspaceHref('settings'), text: 'Configure an authorized API' }))];
}

function renderOverviewStatus() {
  const target = $('overview-status'); if (!target) return;
  const demo = app.localDemo;
  target.replaceChildren(el('p', { text: demo ? app.localDemoError ? `Isolated demo unavailable: ${app.localDemoError}` : 'Isolated PostgreSQL demo available.' : app.apiAvailability === 'unknown' ? 'Checking this instance…' : 'Isolated PostgreSQL demo unavailable on this instance.' }),
    ...(demo ? [el('dl', { class: 'overview-facts' }, ...[['Sample jobs', demo.jobs.length], ['Active leases', demo.jobs.filter(job => job.state === 'leased').length], ['Database observation', fmtAbs(demo.as_of)]].map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: String(value) }))))] : []),
    el('p', { class: 'hint', text: app.token ? 'Authorized API token accepted in this tab.' : 'Live queue data requires an authorized API token in Settings.' }));
}

function reportSource() { return app.reportSource || (app.token ? 'queue' : 'demo'); }
function reportJobs() { return reportSource() === 'demo' ? app.localDemo?.jobs || [] : app.list?.jobs || []; }
function selectedEvidence() {
  const jobs = reportJobs();
  const job = jobs.find(job => String(job.id) === app.reportJobId) || jobs[0];
  if (!job) return null;
  if (reportSource() === 'demo') return { job, events: job.events, more: job.events.length >= 30, observed: app.localDemo.as_of };
  const detail = app.details.get(String(job.id));
  return detail?.job ? detail : null;
}

function viewReports() {
  const source = el('select', { id: 'report-source' }, el('option', { value: 'demo', text: 'Isolated PostgreSQL demo' }), el('option', { value: 'queue', text: 'Authorized queue' })); source.value = reportSource();
  source.addEventListener('change', () => { app.reportSource = source.value; app.reportJobId = null; renderReports(); pollNow(); });
  const jobs = el('select', { id: 'report-job' });
  jobs.addEventListener('change', () => { app.reportJobId = jobs.value; renderReports(); pollNow(); });
  const json = el('button', { class: 'btn primary', type: 'button', id: 'report-json', text: 'Download JSON evidence', disabled: true });
  const markdown = el('button', { class: 'btn', type: 'button', id: 'report-markdown', text: 'Download Markdown evidence', disabled: true });
  json.addEventListener('click', () => downloadJobEvidence('json')); markdown.addEventListener('click', () => downloadJobEvidence('md'));
  return [h1('Reports'), el('p', { class: 'page-purpose', text: 'Read observed jobs and audit events. Downloads contain the selected evidence; no run archive is created.' }),
    el('section', { class: 'panel' }, el('div', { class: 'panel-body report-controls' }, el('label', { for: 'report-source', text: 'Evidence source' }), source, el('label', { for: 'report-job', text: 'Job' }), jobs, el('div', { class: 'form-actions' }, json, markdown))),
    el('p', { id: 'report-status', role: 'status' }), el('div', { id: 'report-evidence' })];
}

function renderReports() {
  const target = $('report-evidence'); if (!target) return;
  const jobs = reportJobs(), select = $('report-job');
  if (!jobs.some(job => String(job.id) === app.reportJobId)) app.reportJobId = jobs[0] ? String(jobs[0].id) : null;
  reconcileChildren(select, jobs.map(job => el('option', { value: String(job.id), text: `Job ${job.id} · ${job.kind}` })));
  select.value = app.reportJobId || ''; select.disabled = !jobs.length;
  const evidence = selectedEvidence();
  $('report-json').disabled = $('report-markdown').disabled = !evidence;
  $('report-status').textContent = reportSource() === 'demo' ? app.localDemoError || (app.localDemo ? `Observed ${fmtAbs(app.localDemo.as_of)}. Up to 12 demo jobs and 30 events per job.` : 'No isolated demo evidence is available. Open Workbench to check availability.') : app.token || app.conn === 'public' ? 'Authorized queue observations from this tab; up to 200 jobs and the first 500 events per selected job.' : 'Enter an authorized API token in Settings to read queue evidence.';
  if (!evidence) { target.replaceChildren(el('p', { text: jobs.length ? 'Reading selected job events…' : 'No job evidence available.' })); return; }
  const { job, events, more } = evidence;
  reconcileChildren(target, [el('section', { class: 'panel' }, el('div', { class: 'panel-body' }, el('h2', { text: `Job ${job.id}` }),
    el('dl', { class: 'fields' }, ...[['Kind', job.kind], ['State', displayState(job)], ['Worker', job.leased_by || 'Unassigned'], ['Attempts', `${job.attempts} of ${job.max_attempts}`]].flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })])),
    el('h3', { id: 'timeline-label', text: 'Audit events' }), el('p', { class: 'hint', text: 'Heartbeats are not audit events; inferred lease expiry is labelled Derived.' }), timeline(job, events), more ? el('p', { class: 'hint', text: 'This bounded event history may be incomplete.' }) : null))]);
}

function downloadJobEvidence(format) {
  const evidence = selectedEvidence(); if (!evidence) return;
  const { job, events } = evidence;
  const fields = ['id', 'kind', 'state', 'attempts', 'max_attempts', 'leased_by', 'lease_expires_at', 'created_at', 'updated_at'];
  const report = { source: reportSource() === 'demo' ? 'Isolated local PostgreSQL demo' : 'Authorized LeaseQ API', observed_at: evidence.observed, history_may_be_incomplete: !!evidence.more,
    job: Object.fromEntries(fields.map(key => [key, job[key] ?? null])), events: events.map(event => ({ id: event.id, event: event.event, attempt: event.attempt, worker_id: event.worker_id, created_at: event.created_at, detail: { error: event.detail?.error || null, lease_seconds: event.detail?.lease_seconds || null } })) };
  const text = format === 'json' ? JSON.stringify(report, null, 2) : [`# LeaseQ job ${job.id} evidence`, '', `Source: ${report.source}`, `Observed: ${report.observed_at}`, `State: ${job.state}`, `History may be incomplete: ${report.history_may_be_incomplete}`, '', '## Audit events', ...report.events.map(event => `- ${event.created_at}: ${event.event}; attempt ${event.attempt}; worker ${event.worker_id || 'queue'}${event.detail.error ? '; ' + event.detail.error : ''}`), '', 'Payloads, results, lease tokens and API credentials are excluded.'].join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' }));
  const link = el('a', { href: url, download: `leaseq-job-${job.id}-evidence.${format}` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function refreshReports() {
  if (reportSource() === 'demo') { if (app.localDemo) await readLocalDemo(); }
  else if (app.token || app.conn === 'public') { await refreshJobs(); const job = reportJobs().find(job => String(job.id) === app.reportJobId) || reportJobs()[0]; if (job) await refreshJob(String(job.id)); }
  renderReports();
}

function viewLanding() {
  const menu = (key,label,columns) => el("div",{class:"mega-wrap","data-mega":key},
    el("button",{type:"button",class:"mega-trigger",id:`mega-${key}`,"data-mega-button":key,"aria-expanded":"false","aria-controls":`panel-${key}`,text:label}),
    el("div",{class:"mega-panel",id:`panel-${key}`,hidden:true},...columns.map(([title,desc,href])=>el("a",{class:"mega-item",href},el("strong",{text:title}),el("span",{text:desc})))));
  const slides = [
    ["Queue lanes","Sample states, labeled as illustrative fixtures.","Queued: 3 | Running: 1 | Retrying: 1 | Done: 8"],
    ["Job chronology","A sample lease timeline, with attempts distinct from logged events.","Created, claimed, lease expired, retried"],
    ["Owned submission","A synthetic word-count example, not sent to a production queue.","Input: audit one two / three four. Result: 5 words, 2 lines."],
    ["Recovery review","Review the scope and outcome before acting in a connected workspace.","Selected 1 job. Confirm action. Inspect the result."]
  ];
  const slideNodes=slides.map(([title,desc,example],i)=>el("section",{class:"showcase-slide",id:`showcase-slide-${i}`,role:"group","aria-roledescription":"slide","aria-label":`${i+1} of ${slides.length}: ${title}`,hidden:i!==0},el("h2",{text:title}),el("p",{text:desc}),el("pre",{class:"showcase-example",text:example})));
  const showcase=el("section",{class:"preview showcase",id:"showcase","aria-label":"Product examples"},el("p",{class:"hint",text:"Illustrative fixtures. No live service activity."}),el("div",{id:"showcase-slides"},...slideNodes),el("div",{class:"showcase-controls",role:"group","aria-label":"Product example controls"},...slides.map(([title],i)=>{const b=el("button",{type:"button",class:"showcase-tab","data-showcase-index":String(i),"aria-pressed":i===0?"true":"false",text:title});return b;}),el("button",{type:"button",id:"showcase-pause",class:"btn",text:"Pause examples"})));
  const featureContent = [
    ["Queue and attempts","Inspect current state, attempts and the reason work is waiting.","#/app"],
    ["Job details","Review lease chronology, payload and result with polling controls.","#/app/jobs"],
    ["Submit work","Use the existing API to submit a job when you explicitly connect.","#/app/submit"],
    ["Workers and schedules","See actual observations and schedule definitions from your service.","#/app/operations"]
  ];
  const useContent = [["On-call operations","Understand a waiting or retried job before taking action.","#/app"],["Worker development","Inspect handler output and retry behavior against your API.","#/app/operations"],["Local evaluation","Try a synthetic workspace without using queue data.","#/app?demo=1"]];
  const howContent = [["Connect","Enter a server-issued API token in Settings; local profiles do not provide one.","#/app/connection"],["Inspect","Read live API state and event history.","#/app"],["Recover","Use protected actions, then verify the server response.","#/app"]];
  const productNav=el("nav",{"aria-label":"Product"},menu("features","Features",featureContent),menu("usecases","Use Cases",useContent),menu("how","How it works",howContent),el("a",{href:"#/app/connection",text:"Docs"}),suiteNavigation());
  const mobilePanel=el("div",{class:"mobile-panel",id:"mobile-panel",hidden:true},el("a",{href:"#features",text:"Features"}),el("a",{href:"#use-cases",text:"Use Cases"}),el("a",{href:"#how",text:"How it works"}),el("a",{href:"#/app/connection",text:"Docs and API"}),el("a",{href:"#/signup",text:"Create account"}),el("a",{href:"#/app?mode=simulator",text:"Try Browser Simulator"}),...SUITE_LINKS.map(([name,href])=>el("a",{href,text:name})));
  const mobileButton=el("button",{type:"button",class:"mobile-nav-trigger",id:"mobile-nav-trigger","aria-expanded":"false","aria-controls":"mobile-panel",text:"Menu"});
  const landingActions = [el("a",{href:"#/login",text:"Log in"}),el("a",{class:"btn",href:"#/signup",text:"Create account"}),el("a",{class:"btn primary",href:"#/app",text:"Launch Workspace"})];
  if (app.profile) landingActions.unshift(el("span",{class:"profile-badge",text:`Saved on this browser: ${app.profile.email}`}),el("button",{class:"btn",type:"button",id:"landing-profile-logout",text:"Log out"}));
  const header=el("header",{class:"landing-nav"},el("a",{class:"landing-logo",href:"#/",text:"LeaseQ"}),productNav,el("div",{class:"landing-actions"},...landingActions),mobileButton,mobilePanel);
  const heroText=el("textarea",{id:"hero-sim-text",maxlength:String(LeaseQSimulator.maxText),"aria-label":"Text for the local word-count example"});heroText.value=app.simulator?.text||DEFAULT_SIM_TEXT;
  const heroTask=el("section",{class:"hero-simulation panel",id:"hero-simulation","aria-labelledby":"hero-simulation-title"},el("p",{class:"eyebrow",text:"LOCAL SIMULATION — NO POSTGRESQL WORKER"}),el("h2",{id:"hero-simulation-title",text:"See a worker lease recover"}),el("p",{class:"hint",text:"Try a bounded word-count job. Nothing is sent to the Live API."}),el("label",{for:"hero-sim-text",text:"Sample job text (maximum 10,000 characters)"}),heroText,el("button",{type:"button",class:"btn primary",id:"run-lease-simulation",text:"Run recovery simulation"}),el("div",{id:"lease-simulation-output","aria-live":"polite"}),el("a",{href:"#/app?mode=simulator",class:"btn",id:"continue-simulation",hidden:true,text:"Continue in Browser Simulator"}));
  const hero=el("div",{class:"hero"},el("div",{},el("p",{class:"eyebrow",text:"Queue operations"}),h1("Know what your queue is doing."),el("p",{class:"hero-copy",text:"Inspect jobs, understand why they wait, and recover them with the evidence in view."}),el("div",{class:"form-actions"},el("a",{class:"btn primary",href:"#/app",text:"Launch Workspace"}),el("a",{class:"btn",href:"#/signup",text:"Save to profile"})),el("p",{class:"hint",text:"Free tools for everyone. Profiles save convenience settings on this browser; they do not connect to the API."}),el("a",{class:"hero-docs",href:"#/app/connection",text:"Read the API guide"})),el("div",{class:"hero-product-preview"},heroTask,showcase));
  return [el("section",{class:"landing"},header,hero,el("section",{id:"features",class:"landing-sections"},el("h2",{text:"Operational evidence, close to the work."}),el("div",{class:"feature-grid"},...featureContent.map(([a,b])=>el("article",{},el("h3",{text:a}),el("p",{text:b}))))),el("section",{id:"use-cases",class:"landing-sections"},el("h2",{text:"For the person on call and the person building the worker."}),el("p",{text:"Inspect delayed work, confirm the current lease, and make a deliberate recovery decision."})),el("section",{id:"how",class:"landing-sections"},el("h2",{text:"Connect. Inspect. Act with context."}),el("ol",{},...howContent.map(([x])=>el("li",{text:x})))),el("section",{class:"landing-sections early-access"},el("h2",{text:"Team and cloud early access"}),el("p",{text:"Current features remain free. Share interest in possible future hosted collaboration; no hosted service is available now."}),el("button",{type:"button",class:"btn",text:"Express interest","data-open-team-interest":""})),el("footer",{class:"landing-footer trust-links","aria-label":"Trust and feedback"},el("a",{href:new URL('../pages/privacy.html', ASSET_ROOT).href,text:"Privacy"}),el("a",{href:new URL('../pages/terms.html', ASSET_ROOT).href,text:"Terms"}),el("a",{href:new URL('../pages/security-offline.html', ASSET_ROOT).href,text:"Security & offline"}),el("button",{type:"button",class:"btn",text:"Send feedback","data-feedback-open":""})) )];
}

function simulatorControls() {
  let model = app.simulator || (app.simulator = LeaseQSimulator.fresh(DEFAULT_SIM_TEXT));
  const text = el("textarea",{id:"simulator-text",maxlength:String(LeaseQSimulator.maxText),"aria-describedby":"simulator-limit"});
  text.value = model.text || DEFAULT_SIM_TEXT;
  const status = el("p",{id:"simulator-status",role:"status","aria-live":"polite"});
  const state = el("dl",{class:"simulator-state",id:"simulator-state"});
  const events = el("ol",{id:"simulator-events",class:"simulator-events"});
  const error = el("p",{id:"simulator-error",class:"field-error",role:"alert"});
  const batchSize=el("input",{id:"simulator-batch-size",type:"number",min:"1",max:String(LeaseQSimulator.maxBatch),step:"1",value:"3"});
  const actions = [
    ["enqueue","Enqueue sample job"],["batch","Enqueue batch"],["claim-a","Claim as Worker A"],["heartbeat","Heartbeat current worker"],
    ["crash","Simulate worker crash"],["advance","Advance virtual time 5 seconds"],["claim-b","Reclaim as Worker B"],
    ["stale","Attempt stale completion"],["complete","Complete current lease"],["fail","Fail current attempt"],
    ["replay","Replay dead-letter (+1 attempt)"],
  ];
  const actionButtons=actions.map(([action,label])=>el("button",{type:"button",class:"btn","data-sim-action":action,text:label}));
  const reportText=el("pre",{id:"simulator-report-text",class:"simulator-report-text"});
  const reportPrint=el("section",{id:"simulator-report-print",class:"simulator-report-print","aria-labelledby":"sim-report-title"},el("h2",{id:"sim-report-title",text:"LeaseQ Browser Simulator incident report"}),reportText);
  const reportStatus=el("p",{id:"simulator-report-status",role:"status","aria-live":"polite"});
  const section=el("section",{class:"panel simulator-panel","aria-labelledby":"simulator-title"},
    el("div",{class:"panel-body"},el("p",{class:"eyebrow",text:"LOCAL SIMULATION — NO POSTGRESQL WORKER"}),
      el("h2",{id:"simulator-title",text:"Browser Simulator"}),
      el("p",{class:"hint",text:"This bounded in-memory model uses virtual time. “Simulate worker crash” does not kill an operating-system process or prove server/PostgreSQL behavior. Event history lasts only in this page session."}),
      el("label",{for:"simulator-text",text:"Sample word-count job text"}),text,
      el("p",{id:"simulator-limit",class:"hint",text:`Maximum ${LeaseQSimulator.maxText.toLocaleString()} characters. Word and line totals are computed from the entered text.`}),
      el("div",{class:"form-actions"},el("button",{type:"button",class:"btn primary",id:"simulator-run-recovery",text:"Run complete recovery sequence"}),el("button",{type:"button",class:"btn",id:"simulator-pause",text:model.paused?"Resume simulation":"Pause simulation"}),el("button",{type:"button",class:"btn",id:"simulator-reset",text:"Reset simulation"})),
      el("label",{for:"simulator-batch-size",text:`Batch size (1 to ${LeaseQSimulator.maxBatch})`}),batchSize,
      el("div",{class:"simulator-actions",role:"group","aria-label":"Individual simulator steps"},...actionButtons),error,status,state,
      el("details",{class:"simulator-event-detail"},el("summary",{},"Session event history"),events),
      el("details",{class:"simulator-report"},el("summary",{},"Incident report · Browser Simulator"),el("p",{class:"hint",text:"This report contains computed local task output and page-session events; it is not evidence of PostgreSQL durability or production crash safety."}),el("div",{class:"form-actions"},el("button",{type:"button",class:"btn",id:"simulator-download-report",text:"Download Markdown report"}),el("button",{type:"button",class:"btn",id:"simulator-print-report",text:"Print report or save as PDF"})),reportStatus,reportPrint),
      el("section",{class:"simulator-alert-preview","aria-labelledby":"sim-alert-title"},el("h3",{id:"sim-alert-title",text:"Alert delivery preview"}),el("p",{text:"No webhook or Slack destination is configured. Static Browser Simulator mode cannot deliver alerts; secrets and destination validation belong on a separately operated server."}))))
  const sync=()=>{
    const job=model.job; status.textContent=job?`Local simulation state: ${job.state}; attempt ${job.attempts} of ${job.maxAttempts}; virtual clock ${model.now} ms.`:"No simulated job has been enqueued.";
    const totals=LeaseQSimulator.counts(model);
    state.replaceChildren(el("dt",{text:"Queue state"}),el("dd",{text:job?`Job ${job.id}: ${job.state}`:"empty"}),el("dt",{text:"Queued / leased / done / dead"}),el("dd",{text:`${totals.queued} / ${totals.leased} / ${totals.done} / ${totals.dead}`}),el("dt",{text:"Attempts"}),el("dd",{text:job?`${job.attempts} of ${job.maxAttempts}`:"0"}),el("dt",{text:"Current worker"}),el("dd",{text:job?.worker||"none"}),el("dt",{text:"Fencing token"}),el("dd",{class:"mono",text:job?.token||"none"}),el("dt",{text:"Lease expires at"}),el("dd",{text:job?.leaseExpiresAt===null||job?.leaseExpiresAt===undefined?"none":`${job.leaseExpiresAt} virtual ms`}),el("dt",{text:"Result"}),el("dd",{text:job?.result?`${job.result.words} words, ${job.result.lines} lines`:"not completed"}),el("dt",{text:"Session events"}),el("dd",{text:`${model.events.length} retained; ${model.eventsDropped>=Number.MAX_SAFE_INTEGER?`at least ${Number.MAX_SAFE_INTEGER}`:model.eventsDropped} earlier entries omitted`}));
    events.replaceChildren(...model.events.map((entry)=>el("li",{text:entry})));
    batchSize.max=String(Math.min(LeaseQSimulator.maxBatch,LeaseQSimulator.maxJobs-totals.total));batchSize.disabled=totals.total>=LeaseQSimulator.maxJobs;
    reportText.textContent=simulatorIncidentMarkdown(model);
    section.querySelector("#simulator-download-report").disabled=!model.jobs.length;section.querySelector("#simulator-print-report").disabled=!model.jobs.length;
    section.querySelector("#simulator-pause").textContent=model.paused?"Resume simulation":"Pause simulation";
    section.querySelector("#simulator-pause").setAttribute("aria-pressed",model.paused?"true":"false");
    for(const button of section.querySelectorAll("[data-sim-action]")) button.disabled=model.paused;
    section.querySelector("#simulator-run-recovery").disabled=model.paused;
    error.textContent="";
  };
  section.addEventListener("click",(event)=>{
    const button=event.target.closest("button");if(!button)return;
    try{
      const action=button.dataset.simAction, job=model.job;
      if(button.id==="simulator-pause"){model.paused=!model.paused;sync();return;}
      if(button.id==="simulator-reset"){model=app.simulator=LeaseQSimulator.fresh(text.value||DEFAULT_SIM_TEXT);app.simulation=null;document.getElementById("continued-simulation-title")?.closest(".saved-example")?.remove();try{sessionStorage.removeItem("leaseq:guest-simulation:v1");}catch{}sync();return;}
      if(button.id==="simulator-download-report"){downloadIncidentReport(simulatorIncidentMarkdown(model));reportStatus.textContent="Markdown report downloaded. It contains the selected local task text and simulation history; it was not sent to the API.";return;}
      if(button.id==="simulator-print-report"){section.querySelector(".simulator-report").open=true;document.body.classList.add("print-incident-report");window.addEventListener("afterprint",()=>{document.body.classList.remove("print-incident-report");section.querySelector(".simulator-report").open=false;},{once:true});window.print();return;}
      if(button.id==="simulator-run-recovery"){Object.assign(model,LeaseQSimulator.runRecovery(text.value));renderSimulatorOutcome();sync();return;}
      if(action==="enqueue")LeaseQSimulator.enqueue(model,text.value);
      else if(action==="batch")LeaseQSimulator.enqueueBatch(model,text.value,Number(batchSize.value));
      else if(action==="claim-a")LeaseQSimulator.claim(model,"worker-a");
      else if(action==="claim-b")LeaseQSimulator.claim(model,"worker-b");
      else if(action==="heartbeat")LeaseQSimulator.heartbeat(model,job?.worker);
      else if(action==="crash")LeaseQSimulator.crash(model,job?.worker||"worker-a");
      else if(action==="advance")LeaseQSimulator.advance(model,5000);
      else if(action==="stale")LeaseQSimulator.complete(model,model.staleToken||"stale-token","worker-a");
      else if(action==="complete")LeaseQSimulator.complete(model,job?.token,job?.worker);
      else if(action==="fail")LeaseQSimulator.fail(model,job?.token,job?.worker);
      else if(action==="replay")LeaseQSimulator.replay(model,1);
      sync();
    }catch(e){error.textContent=e.message||"The simulator could not perform that step.";}
  });
  sync();
  return section;
}

function simulatorIncidentMarkdown(model) {
  const job=model.job;
  const clean=(value)=>String(value??"").replace(/\r\n?/g,"\n");
  const fenceFor=(value)=>"`".repeat(Math.max(3,...(clean(value).match(/`+/g)||[]).map((run)=>run.length+1)));
  const fence=fenceFor(job?.payload?.text||"");
  const jobs=model.jobs.map((entry)=>`| ${entry.id} | ${entry.state} | ${entry.attempts}/${entry.maxAttempts} | ${entry.token||"none"} | ${entry.result?`${entry.result.words} words / ${entry.result.lines} lines`:"pending"} |`).join("\n");
  const logged=model.events.length?model.events.map((event)=>`- ${clean(event)}`):["- No simulator events yet."];
  const dropped=model.eventsDropped>=Number.MAX_SAFE_INTEGER?`at least ${Number.MAX_SAFE_INTEGER}`:String(model.eventsDropped);
  return ["# LeaseQ Browser Simulator incident report","",`Generated: ${new Date().toISOString()}`,"Mode: Browser Simulator — no PostgreSQL worker.","","## Workload","",`Jobs retained in this page session: ${model.jobs.length}.`,job?`Selected job: ${job.id} (${job.kind}).`:"Selected job: none.","","| Job | State | Attempts / limit | Current fencing token | Computed result |","| --- | --- | ---: | --- | --- |",jobs||"| — | — | — | — | — |","","## Selected job evidence","",job?`State: ${job.state}; attempts: ${job.attempts} of ${job.maxAttempts}.`:"No job has been enqueued.",job?`Current lease: ${job.leaseExpiresAt===null?"none":`expires at virtual time ${job.leaseExpiresAt} ms`}; current fencing token: ${job.token||"none"}.`:"Current lease: none.",job?.result?`Task result: ${job.result.words} words and ${job.result.lines} lines, computed from this job's sample text in this browser.`:"No completed task result is available for the selected job.","","## Selected input","",fence+"text",clean(job?.payload?.text||""),fence,"","## Session event history","",`Retained event strings: ${model.events.length} of the session history; ${dropped} older events were dropped to bound memory.`,"Logged entries are page-session strings produced by the simulator. They are not tamper-proof or server audit events.",...logged,"","## Derived evidence","",job?.result?"The result values above were computed from the retained input with the simulator's word-count task. The job-state and result table is derived from the current in-memory model at report time.":"No task result has been derived yet.","","## Evidence boundary","","This report describes a bounded in-memory browser model only. It does not establish PostgreSQL durability, FastAPI authorization, real worker termination, production crash recovery, external side-effect guarantees, or service throughput. No API request or live queue mutation is included.",""].join("\n");
}
function downloadIncidentReport(markdown) {
  const blob=new Blob([markdown],{type:"text/markdown;charset=utf-8"}),url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=`leaseq-simulator-report-${new Date().toISOString().slice(0,10)}.md`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
}

function renderSimulatorOutcome() {
  app.simulation=LeaseQSimulator.persistable(app.simulator);
  const output=$("lease-simulation-output");
  if(output)output.replaceChildren(el("h3",{text:`Outcome: ${app.simulation.state} on attempt ${app.simulation.attempts}`}),el("p",{text:app.simulation.result?`${app.simulation.result.words} words, ${app.simulation.result.lines} lines. Worker B completed with the current fencing token; Worker A's stale completion was rejected.`:"The simulated job did not complete."}),el("ol",{},...app.simulation.events.map((event)=>el("li",{text:event}))));
  const continueLink=$("continue-simulation");if(continueLink)continueLink.hidden=false;
}

function viewDemo() {
  const activeSimulation = app.simulation || app.guestSimulation;
  const progressKey = `leaseq:quickstart:v1:${app.profile?.id || "guest"}`;
  let progress = { demo: true, lifecycle: false, recovery: false, dismissed: false };
  try { progress = { ...progress, ...JSON.parse(localStorage.getItem(progressKey) || "{}"), demo: true }; localStorage.setItem(progressKey, JSON.stringify(progress)); } catch { /* demo remains usable without storage */ }
  const save = (field, value) => { progress[field] = value; try { localStorage.setItem(progressKey, JSON.stringify(progress)); } catch { announce("Progress could not be saved in this browser."); } };
  const check = (field, label) => el("li", {}, el("label", {}, el("input", { type: "checkbox", checked: progress[field], disabled: true }), ` ${label}`));
  const checklist = el("section", { class: "quickstart", "aria-labelledby": "quickstart-title" },
    el("div", { id: "quickstart-content", hidden: progress.dismissed },
    el("h2", { id: "quickstart-title", text: "Optional quick start" }),
    el("ol", {}, check("demo", "Open the labelled synthetic demo"), check("lifecycle", "Inspect the sample job lifecycle"), check("recovery", "Review safe recovery boundaries")),
    el("button", { type: "button", class: "btn", id: "quickstart-dismiss", text: "Dismiss checklist" })),
    el("button", { type: "button", class: "btn", id: "quickstart-restart", text: "Restart checklist", hidden: !progress.dismissed }));
  const lifecycle = el("details", { id: "sample-lifecycle" }, el("summary", {}, "Inspect sample lifecycle"),
    el("p", { text: "Sample Job 1042 was created, claimed on attempt 1, lost its lease, and retried. The current sample state is waiting for a worker on attempt 2. This is an illustrative fixture; it is not a live job." }));
  const recovery = el("details", { id: "safe-recovery" }, el("summary", {}, "Review safe recovery boundaries"),
    el("p", { text: "This demo cannot cancel or requeue anything. In a connected workspace, review the exact job and server response before acting; a local profile never grants API access." }),
    el("a", { href: "#/connection", text: "Connect an explicitly owned backend" }));
  const simulationPanel = activeSimulation ? el("section",{class:"panel saved-example","aria-labelledby":"continued-simulation-title"},el("h2",{id:"continued-simulation-title",text:"Continued worker lease simulation"}),el("p",{text:`Outcome: ${activeSimulation.state} on attempt ${activeSimulation.attempts}. This local example did not contact the LeaseQ API.`}),el("p",{class:"hint",text:activeSimulation.eventsDropped===null||activeSimulation.eventsDropped===undefined?"Earlier event retention is unknown for this saved example.":`${activeSimulation.events.length} entries retained; ${activeSimulation.eventsDropped} older event entries omitted.`}),el("ol",{},...activeSimulation.events.map((event)=>el("li",{text:event}))),app.profile&&app.simulation?el("button",{type:"button",class:"btn",id:"save-simulation-to-profile",text:"Save this example to profile"}):null):null;
  const section = el("section", { class: "landing-sections demo-workspace" }, el("p", { class: "eyebrow", text: "SYNTHETIC DEMO" }), h1("Sample queue"),
    el("p", { class: "hint", text: "Illustrative data only. This demo does not contact the API or change your queue." }), checklist,
    simulationPanel, simulatorControls(),
    el("div", { class: "sample-lanes" }, ...[["Queued","3"],["Running","1"],["Retrying","1"],["Done","8"],["Dead","0"]].map(([n,v]) => el("div", { class: "sample-lane" }, el("span", { text:n }), el("strong", { text:v })))),
    el("p", { class: "mono", text: "Sample Job 1042 · attempt 2 · waiting for worker" }), lifecycle, recovery,
    el("a", { href: "#/", text: "Return to LeaseQ" }));
  const syncProgress = () => { ["demo", "lifecycle", "recovery"].forEach((key, i) => { const input = checklist.querySelectorAll('input[type="checkbox"]')[i]; if (input) input.checked = !!progress[key]; }); };
  lifecycle.addEventListener("toggle", () => { if (lifecycle.open && !progress.lifecycle) { save("lifecycle", true); syncProgress(); } });
  recovery.addEventListener("toggle", () => { if (recovery.open && !progress.recovery) { save("recovery", true); syncProgress(); } });
  checklist.querySelector("#quickstart-restart").addEventListener("click", (event) => { progress = { demo:true, lifecycle:false, recovery:false, dismissed:false }; try { localStorage.setItem(progressKey, JSON.stringify(progress)); } catch {} lifecycle.open = false; recovery.open = false; checklist.querySelector("#quickstart-content").hidden = false; event.currentTarget.hidden = true; syncProgress(); checklist.querySelector("#quickstart-title")?.focus(); });
  checklist.querySelector("#quickstart-dismiss").addEventListener("click", () => { save("dismissed", true); checklist.querySelector("#quickstart-content").hidden = true; checklist.querySelector("#quickstart-restart").hidden = false; });
  if(app.profile&&app.simulation){const saveButton=section.querySelector("#save-simulation-to-profile");saveButton?.addEventListener("click",()=>{try{const saved=LeaseQProfiles.load(app.profile.id);LeaseQProfiles.save(app.profile.id,{...saved,guestSimulation:app.simulation});app.guestSimulation=app.simulation;saveButton.textContent="Saved on this browser";saveButton.disabled=true;announce("Example saved to this local profile.");}catch{announce("Could not save the example in this browser.");}});}
  return [section];
}

function viewAuth() {
  const signup = app.route.name === "signup";
  let pendingSimulation = null;
  try { const raw=sessionStorage.getItem("leaseq:guest-simulation:v1");if(raw&&new TextEncoder().encode(raw).byteLength<=16000){const candidate=JSON.parse(raw);if(candidate&&Array.isArray(candidate.events)&&candidate.events.length<=40)pendingSimulation=candidate;} } catch { /* the current browser session remains usable without task restoration */ }
  const form = el("form", { class:"local-auth", id:"profile-form" }, el("nav",{class:"auth-actions","aria-label":"Account and workspace"},el("a",{href:"#/login",text:"Log in"}),el("a",{href:"#/signup",text:"Create account"}),el("a",{class:"btn primary",href:"#/app",text:"Launch Workspace"}),app.profile?el("span",{class:"profile-badge",text:`Saved on this browser: ${app.profile.email}`}):null,app.profile?el("button",{type:"button",class:"btn",id:"auth-profile-logout",text:"Log out"}):null),el("h1", { tabindex:"-1", text:signup?"Create a local profile":"Log in to this browser" }),
    el("p", { class:"hint", text:"Saved on this browser. Email is not verified; there is no password reset or cloud sync." }),
    el("label", { for:"profile-email", text:"Email" }), el("input", { id:"profile-email", class:"input", type:"email", autocomplete:"email", required:true, maxlength:"254" }),
    el("label", { for:"profile-password", text:"Password" }), el("input", { id:"profile-password", class:"input", type:"password", autocomplete:signup?"new-password":"current-password", required:true, minlength:"10", maxlength:"1024" }),
    el("button", { type:"button", class:"btn", id:"password-toggle", text:"Show password" }),
    el("p", { class:"hint", text:"Password verifies this local profile; it does not encrypt saved work or authorize API requests." }),
    pendingSimulation ? el("fieldset",{class:"pending-import"},el("legend",{text:"Unsaved guest example"}),el("p",{text:"This tab has a completed lease recovery simulation. It remains available in this session unless you explicitly save it below."}),el("label",{},el("input",{type:"checkbox",id:"save-pending-simulation"})," Save this simulation in the local profile after sign-in")) : null,
    el("p", { id:"profile-error", class:"field-error", role:"alert" }), el("button", { type:"submit", class:"btn primary", id:"profile-submit", text:signup?"Create profile":"Log in" }),
    el("a", { href:signup?"#/login":"#/signup", text:signup?"Already have a profile? Log in":"Create a local profile" }),
    el("a", { href:"#/app?demo=1", class:"btn", text:"Continue with synthetic demo" }));
  return [el("section", { class:"auth-layout" }, form, el("aside", {}, el("h2",{text:"Local convenience, separate from the service"}),el("p",{text:"Profiles can restore small saved UI preferences and drafts on this browser. API access still requires an explicit connection and a server-authorized token."}),el("nav",{class:"trust-links","aria-label":"Trust information"},el("a",{href:new URL('../pages/privacy.html', ASSET_ROOT).href,text:"Privacy"}),el("a",{href:new URL('../pages/terms.html', ASSET_ROOT).href,text:"Terms"}),el("a",{href:new URL('../pages/security-offline.html', ASSET_ROOT).href,text:"Security & offline"}),el("button",{type:"button",class:"btn",text:"Send feedback","data-feedback-open":""})),el("a",{href:"#/",text:"Back to LeaseQ"})))];
}
function initLandingControls() {
  $("landing-profile-logout")?.addEventListener("click", logoutProfile);
  $("auth-profile-logout")?.addEventListener("click", logoutProfile);
  const runSimulation = $("run-lease-simulation");
  if (runSimulation && !runSimulation.dataset.ready) {
    runSimulation.dataset.ready = "1";
    const output = $("lease-simulation-output"), continueLink = $("continue-simulation"), textInput=$("hero-sim-text");
    const renderSimulation = (simulation) => {
      if (!simulation || !Array.isArray(simulation.events)) return;
      const summary=simulation.result?`Outcome: ${simulation.state} on attempt ${simulation.attempts}; ${simulation.result.words} words and ${simulation.result.lines} lines.`:`Outcome: ${simulation.state} on attempt ${simulation.attempts}.`;
      output.replaceChildren(el("h3", { text: summary }),
        el("p", { text: "Worker B took over after Worker A’s virtual lease expired. The stale completion was rejected by the local fencing check." }),
        el("ol", {}, ...simulation.events.map((event) => el("li", { text: event }))));
      continueLink.hidden = false;
    };
    try { renderSimulation(app.simulation || JSON.parse(sessionStorage.getItem("leaseq:guest-simulation:v1") || "null")); } catch { /* fresh deterministic task */ }
    runSimulation.addEventListener("click", () => {
      output.textContent = "Running the local lease model…";
      runSimulation.disabled = true;
      try {
        app.simulator=LeaseQSimulator.runRecovery(textInput?.value||DEFAULT_SIM_TEXT);
        app.simulation=LeaseQSimulator.persistable(app.simulator);
        try { sessionStorage.setItem("leaseq:guest-simulation:v1", JSON.stringify(app.simulation)); }
        catch { output.textContent = "The simulation ran, but this tab could not preserve it across routes. You can still inspect the result here."; }
        renderSimulation(app.simulation);
      } catch(error) { output.replaceChildren(el("p",{class:"field-error",role:"alert",text:error.message||"The local simulation could not run."})); }
      finally { runSimulation.disabled = false; }
    });
  }
  const form = $("profile-form");
  if (form && !form.dataset.ready) {
    form.dataset.ready="1";
    const pw=$("profile-password"), toggle=$("password-toggle"), error=$("profile-error"), submit=$("profile-submit");
    toggle.addEventListener("click",()=>{const show=pw.type==="password";pw.type=show?"text":"password";toggle.textContent=show?"Hide password":"Show password";});
    form.addEventListener("submit", async (e)=>{e.preventDefault();error.textContent="";submit.disabled=true;submit.textContent="Working…";const generation=app.profileAuthGeneration,key=app.routeKey;try{const op=app.route.name==="signup"?LeaseQProfiles.create:LeaseQProfiles.login;const profile=await op($("profile-email").value,pw.value);if(generation!==app.profileAuthGeneration||key!==app.routeKey)return;const savePending=$("save-pending-simulation")?.checked===true;let pending=null;try{const raw=sessionStorage.getItem("leaseq:guest-simulation:v1");if(raw&&new TextEncoder().encode(raw).byteLength<=16000)pending=JSON.parse(raw);}catch{}const previousId=app.profile?.id||null;if(!previousId||previousId!==profile.id){app.simulator=LeaseQSimulator.fresh(DEFAULT_SIM_TEXT);app.simulation=null;if(!savePending)try{sessionStorage.removeItem("leaseq:guest-simulation:v1");}catch{}}activateProfile(profile);if(savePending&&pending){try{const saved=LeaseQProfiles.load(profile.id);LeaseQProfiles.save(profile.id,{...saved,guestSimulation:pending});app.guestSimulation=pending;app.simulation=pending;}catch{showBanner("Your profile is ready, but the guest example could not be saved. It remains in this tab.",false);}}window.location.hash="#/app";}catch(err){if(generation===app.profileAuthGeneration&&key===app.routeKey)error.textContent=err.message||"Could not use local storage. Check browser settings and try again.";}finally{submit.disabled=false;submit.textContent=app.route.name==="signup"?"Create profile":"Log in";}});
  }
  const mobileButton=$("mobile-nav-trigger"), mobilePanel=$("mobile-panel");
  if(mobileButton&&!mobileButton.dataset.ready){mobileButton.dataset.ready="1";mobileButton.addEventListener("click",()=>{const open=mobileButton.getAttribute("aria-expanded")!=="true";mobileButton.setAttribute("aria-expanded",String(open));mobilePanel.hidden=!open;if(open)mobilePanel.querySelector("a").focus();});mobilePanel.addEventListener("keydown",e=>{if(e.key==="Escape"){mobilePanel.hidden=true;mobileButton.setAttribute("aria-expanded","false");mobileButton.focus();}});mobilePanel.addEventListener("click",()=>{mobilePanel.hidden=true;mobileButton.setAttribute("aria-expanded","false");});}
  const closeMenus=(returnTo)=>{for(const button of document.querySelectorAll("[data-mega-button]")){const panel=$(button.getAttribute("aria-controls"));button.setAttribute("aria-expanded","false");panel.hidden=true;}if(returnTo)returnTo.focus();};
  for(const button of document.querySelectorAll("[data-mega-button]")) if(!button.dataset.ready){button.dataset.ready="1";const panel=$(button.getAttribute("aria-controls"));const open=()=>{closeMenus();button.setAttribute("aria-expanded","true");panel.hidden=false;};button.addEventListener("click",e=>{if(e.detail>0){if(button.getAttribute("aria-expanded")!=="true")open();}else button.getAttribute("aria-expanded")==="true"?closeMenus():open();});button.addEventListener("pointerenter",open);button.closest("[data-mega]").addEventListener("pointerleave",()=>{if(!button.closest("[data-mega]").contains(document.activeElement))closeMenus();});button.addEventListener("focus",open);}
  if(!document.body.dataset.megaKeys){document.body.dataset.megaKeys="1";document.addEventListener("keydown",e=>{if(e.key==="Escape"){const active=document.activeElement.closest?.("[data-mega]")?.querySelector("[data-mega-button]");if(active){e.preventDefault();closeMenus(active);}}});document.addEventListener("click",e=>{if(!e.target.closest("[data-mega]"))closeMenus();});}
  const stage=$("showcase");
  if(stage){
    if(app.showcaseTimer!==null)clearInterval(app.showcaseTimer);
    try{let savedPause=localStorage.getItem("leaseq:showcase:v1:paused");if(savedPause===null){savedPause=localStorage.getItem("leaseq-showcase-paused");if(savedPause!==null){localStorage.setItem("leaseq:showcase:v1:paused",savedPause);localStorage.removeItem("leaseq-showcase-paused");}}app.showcasePaused=savedPause==="1";}catch(e){app.showcasePaused=false;}
    const tabs=[...stage.querySelectorAll("[data-showcase-index]")], slides=[...stage.querySelectorAll(".showcase-slide")], pause=$("showcase-pause");
    const show=(i)=>{app.showcaseIndex=i;slides.forEach((slide,n)=>{slide.hidden=n!==i;});tabs.forEach((tab,n)=>tab.setAttribute("aria-pressed",n===i?"true":"false"));};
    const paused=()=>app.showcasePaused||stage.matches(":hover")||stage.contains(document.activeElement)||matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sync=()=>{pause.textContent=app.showcasePaused?"Play examples":"Pause examples";pause.setAttribute("aria-pressed",app.showcasePaused?"true":"false");};
    tabs.forEach((tab,i)=>tab.addEventListener("click",()=>show(i)));
    pause.addEventListener("click",()=>{app.showcasePaused=!app.showcasePaused;try{localStorage.setItem("leaseq:showcase:v1:paused",app.showcasePaused?"1":"0");}catch(e){}sync();});
    stage.addEventListener("mouseenter",()=>{});stage.addEventListener("focusin",()=>{});
    show(app.showcaseIndex%slides.length);sync();
    if(!matchMedia("(prefers-reduced-motion: reduce)").matches)app.showcaseTimer=window.setInterval(()=>{if(!paused())show((app.showcaseIndex+1)%slides.length);},6000);
  }else if(app.showcaseTimer!==null){clearInterval(app.showcaseTimer);app.showcaseTimer=null;}
}
function saveProfileNow(){if(!app.profile)return true;try{if(app.profileSaveTimer!==null){clearTimeout(app.profileSaveTimer);app.profileSaveTimer=null;}const id=app.profile.id,old=LeaseQProfiles.load(id);LeaseQProfiles.save(id,{...old,theme:document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light",submitDraft:app.submitDraft,submitText:app.submitText,submitFields:app.submitFields});return true;}catch(e){showBanner("Could not save this browser profile.",false);return false;}}
window.LeaseQFlushProfile = saveProfileNow;
function cancelProfileSave(){app.profileSaveGeneration+=1;if(app.profileSaveTimer!==null){clearTimeout(app.profileSaveTimer);app.profileSaveTimer=null;}}
function clearSyncSession(){const provider=app.syncProvider;app.syncProvider=null;app.syncConfig=null;app.syncRemote=null;app.syncEpoch+=1;if(provider)provider.logout();}
function activateProfile(profile) { if(app.profile){saveProfileNow();cancelProfileSave();if(app.profile.id!==profile.id){clearSyncSession();app.profile=null;app.token=null;clearSensitive();}}else if(app.demo)clearSensitive();app.profile=profile;app.profileSaveGeneration+=1;app.demo=false;try{const saved=LeaseQProfiles.load(profile.id);const theme=saved.theme||"light";document.documentElement.setAttribute("data-theme",theme);app.submitDraft=saved.submitDraft||app.submitDraft;app.submitText=saved.submitText||"";app.submitFields={...app.submitFields,...(saved.submitFields||{})};app.guestSimulation=saved.guestSimulation||null;if(!saved.theme)LeaseQProfiles.save(profile.id,{...saved,theme});}catch(e){showBanner("Could not load saved browser preferences.",false);}try{localStorage.setItem("leaseq:profile-active",profile.id);}catch(e){} }
function logoutProfile() { saveProfileNow();cancelProfileSave();clearSyncSession();app.profileAuthGeneration+=1;app.profile=null;app.demo=false;app.token=null;app.simulator=LeaseQSimulator.fresh(DEFAULT_SIM_TEXT);app.simulation=null;try{sessionStorage.removeItem("leaseq:guest-simulation:v1");}catch{}stopPolling();clearSensitive();try{localStorage.removeItem("leaseq:profile-active");}catch(e){}window.location.hash="#/"; }

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
      el("p", {}, el("a", { href: "#/connection", text: "Go to Settings to enter the token" })));
  }
  if (app.conn === "offline") {
    return el("section", { class: "notice", "aria-labelledby": "notice-title", id: "conn-notice" },
      el("h2", { id: "notice-title", text: "API unreachable" }),
      el("p", { text: "This page cannot reach the leaseq API that served it. It tries again every 2 seconds." }),
      el("p", {}, el("a", { href: "#/connection", text: "See Settings for server status and API details" })));
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
  const filterDisclosure = el("details", { class: "filter-disclosure", open:
    window.matchMedia("(min-width: 600px)").matches || activeFilterCount() > 0 },
    el("summary", {}, "Filters ", el("span", { id: "filter-count", text: activeFilterCount() })), filters);

  const pause = el("button", { type: "button", class: "btn", id: "pause",
                               text: app.paused ? "Resume updates" : "Pause updates" });
  pause.addEventListener("click", togglePause);
  const more = el("button", { type: "button", class: "btn", id: "more", text: "Show more jobs", hidden: true });
  more.addEventListener("click", () => { app.rows = Math.min(MAX_ROWS, app.rows + PAGE); pollNow(); });

  return [
    h1(screenTitle()),
    app.route.page === 'dead-letter' ? el('p', { class: 'hint', text: 'Open a dead job to inspect its failure and confirm a requeue. Replay requires an accepted API token.' }) : null,
    app.guestSimulation ? el("section",{class:"panel saved-example","aria-labelledby":"saved-example-title"},el("h2",{id:"saved-example-title",text:"Saved synthetic recovery example"}),el("p",{text:`State: ${app.guestSimulation.state}. Attempts: ${app.guestSimulation.attempts} of ${app.guestSimulation.maxAttempts}. This was saved from a local demonstration, not from your server.`}),el("ol",{},...app.guestSimulation.events.map((event)=>el("li",{text:event})))) : null,
    connectionNotice("Job data cannot be shown."),
    el("div", { class: "console-bar" }, el("span", { id: "updated", text: "Waiting for the first update" }),
      el("button", { type: "button", class: "btn", id: "refresh-jobs", text: "Refresh" }), pause),
    lanes,
    el("p", { id: "expired-note", class: "note", hidden: true }),
    el("p", { id: "demo-note", class: "demo-note", hidden: true },
       "Sample jobs (", el("code", { text: "demo-*" }), ") use bundled handlers; they do not send email or render pages. ",
       el("code", { text: "sleep" }), " waits; ", el("code", { text: "fail" }), " fails. Queue processing uses the real API."),
    el("section", { class: "panel", "aria-labelledby": "queue-title" },
      el("div", { class: "panel-head" }, el("h2", { id: "queue-title", text: "Job queue" }),
         el("a", { class: "btn primary", href: "#/submit", text: "New job" })),
      filterDisclosure,
      el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Job table, scrolls sideways" },
        el("table", { class: "jobs-table" },
          el("caption", { class: "sr-only", id: "table-caption", text: "Jobs, newest first" }),
          el("thead", {}, el("tr", {}, ...["Job", "State", "Kind", "Attempts", "Worker", "Updated", "Result",
                                            "Idempotency key"].map((t) => el("th", { scope: "col", text: t })))),
          el("tbody", { id: "rows" }))),
      el("div", { class: "table-foot" }, el("span", { id: "shown", class: "muted" }), more)),
    app.token ? bulkPanel() : null,
  ];
}

function activeFilterCount() {
  return [app.filters.state, app.filters.kind, app.filters.worker].filter(Boolean).length;
}

function bulkPanel() {
  const action = el("select", { id: "bulk-action", "aria-label": "Bulk action" },
    el("option", { value: "requeue", text: "Requeue dead jobs" }),
    el("option", { value: "cancel", text: "Cancel queued or running jobs" }));
  const button = el("button", { type: "button", class: "btn", id: "bulk-run", text: "Snapshot and review" });
  const result = el("div", { id: "bulk-result", "aria-live": "polite" });
  button.addEventListener("click", prepareBulk);
  return el("section", { class: "panel", "aria-labelledby": "bulk-title" },
    el("div", { class: "panel-body" }, el("h2", { id: "bulk-title", text: "Bulk actions" }),
      el("p", { class: "hint", id: "bulk-scope", text: bulkScopeLabel() }),
      el("p", { class: "hint" }, "Uses one snapshot of up to 1,000 matching job IDs; later matches are excluded."),
      el("div", { class: "form-actions" }, action, button), result));
}

function bulkScopeLabel() {
  const active = Object.entries(app.filters).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`);
  return `Scope: ${active.length ? active.join(", ") : "all jobs"}`;
}

async function prepareBulk() {
  const button = $("bulk-run");
  if (!button || !app.token) return;
  const action = $("bulk-action").value;
  const filters = { state: app.filters.state, kind: app.filters.kind, worker: app.filters.worker };
  const gen = app.authGen;
  button.disabled = true;
  $("bulk-result").textContent = "Reading a bounded snapshot…";
  const ids = [];
  const all = [];
  let batchIndex = null;
  let failure = null;
  let before = null;
  try {
    try {
    while (ids.length < 1000) {
      const p = new URLSearchParams({ limit: String(Math.min(200, 1000 - ids.length)) });
      if (before) p.set("before_id", before);
      for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
      const r = await api(`/jobs?${p}`);
      if (gen !== app.authGen) return;
      if (r.status === 401) { handleUnauthorized(); return; }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      ids.push(...r.body.jobs.map((j) => j.id));
      before = r.body.next_before_id;
      if (!before || !r.body.jobs.length) break;
    }
    app.bulkIds = [...new Set(ids)].slice(0, 1000);
    if (!app.bulkIds.length) { $("bulk-result").textContent = "No jobs matched the current filters."; return; }
    const label = action === "cancel" ? "Cancel" : "Requeue";
    if (!window.confirm(`${label} ${app.bulkIds.length} snapshotted jobs? This runs in batches of up to 100 and may have partial outcomes.`)) {
      $("bulk-result").textContent = `${app.bulkIds.length} IDs snapshotted; no changes made.`;
      return;
    }
    for (let i = 0; i < app.bulkIds.length; i += 100) {
      if (gen !== app.authGen || !app.token) return;
      batchIndex = i;
      const r = await api("/jobs/bulk", { method: "POST", body: { action, job_ids: app.bulkIds.slice(i, i + 100) } });
      if (gen !== app.authGen) return;
      if (r.status === 401) { handleUnauthorized(); return; }
      if (r.status !== 200) {
        all.push(...app.bulkIds.slice(i, i + 100).map((id) => ({ id, status: "uncertain" })));
        all.push(...app.bulkIds.slice(i + 100).map((id) => ({ id, status: "not_attempted" })));
        failure = `Bulk request failed (HTTP ${r.status}); the current batch is uncertain.`;
        batchIndex = null;
        break;
      }
      all.push(...r.body.results);
      batchIndex = null;
      if (r.body.remaining) {
        all.push(...app.bulkIds.slice(i + 100).map((id) => ({ id, status: "not_attempted" })));
        break;
      }
    }
    } catch (e) {
      if (batchIndex !== null) {
        all.push(...app.bulkIds.slice(batchIndex, batchIndex + 100).map((id) => ({ id, status: "uncertain" })));
        all.push(...app.bulkIds.slice(batchIndex + 100).map((id) => ({ id, status: "not_attempted" })));
        failure = `Bulk request failed: ${e.message}; the current batch is uncertain and was not retried.`;
      } else failure = `Snapshot request failed: ${e.message}.`;
    }
    if (gen === app.authGen) {
      if (all.length) {
        const counts = {};
        for (const row of all) counts[row.status] = (counts[row.status] || 0) + 1;
        const summary = `${all.length} outcomes: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}.`;
        const result = $("bulk-result");
        result.replaceChildren(el("p", { text: failure ? `${summary} ${failure}` : summary }),
          el("details", {}, el("summary", {}, `${all.length} per-item outcomes`),
            el("ul", { class: "bulk-outcomes" }, ...all.map((row) => el("li", {},
              el("span", { class: "mono", text: String(row.id) }), `: ${row.status.replaceAll("_", " ")}`)))));
        announce(`Bulk ${action} stopped with ${all.length} outcomes${failure ? "; no automatic retry was made" : ""}.`);
        pollNow();
      } else if (failure) $("bulk-result").textContent = failure;
    }
  } finally {
    if (gen === app.authGen && $("bulk-run")) $("bulk-run").disabled = false;
  }
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
  if (job.result === undefined) return el("span", { class: "muted", text: "Not loaded" });
  if (job.result === null) return el("span", { class: "muted", text: "none" });
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
  if ($("filter-count")) $("filter-count").textContent = String(activeFilterCount());
  if ($("bulk-scope")) $("bulk-scope").textContent = bulkScopeLabel();
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
    el("div", { class: "title-row" }, h1(`Job ${id}`), el("span", { id: "detail-state" }), el("button", { type: "button", class: "btn", id: "share-job", text: "Share job link" })),
    el("p", { id: "share-job-status", role: "status", class: "muted" }),
    connectionNotice(`Job ${id} cannot be shown.`),
    el("div", { class: "detail-poll" }, el("span", { class: "muted" }, "Job details refresh automatically."),
      el("button", { type: "button", class: "btn", id: "detail-pause", text: app.paused ? "Resume updates" : "Pause updates" })),
    el("div", { id: "job-body" }),
  ];
}

function renderJobData() {
  const box = $("job-body");
  if (!box) return;
  const id = app.route.id;
  const d = app.details.get(id);
  const pause = $("detail-pause");
  if (pause) {
    pause.textContent = app.paused ? "Resume updates" : "Pause updates";
    pause.onclick = togglePause;
  }
  if (!d) {
    reconcileChildren($("detail-state"), []);
    if (app.conn === "needs-token" || app.conn === "offline") reconcileChildren(box, []);
    else reconcileChildren(box, [el("p", { class: "muted", text: `Loading job ${id}…` })]);
    return;
  }
  if (d.notfound) {
    reconcileChildren($("detail-state"), [el("span", { class: "muted", text: "not found" })]);
    reconcileChildren(box, [el("section", { class: "notice", "aria-labelledby": "nf-title" },
      el("h2", { id: "nf-title", text: `No job ${id} in this queue` }),
      el("p", {}, el("a", { href: app.lastJobsHash, text: "Back to jobs" })))]);
    return;
  }
  const { job, events, more } = d;
  reconcileChildren($("detail-state"), [stateBadge(job)]);
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

  const content = [
    el("section", { class: "panel why", "aria-labelledby": "why-title" },
      el("div", { class: "panel-body" }, el("h2", { id: "why-title", text: why.title }),
         el("p", { id: "why" }, ...why.parts))),
    el("div", { class: "detail-grid" },
      el("section", { class: "panel", "aria-labelledby": "life-title" },
        el("div", { class: "panel-body" },
          el("h2", { id: "life-title", text: "Events" }),
          el("p", { class: "hint", text: "Heartbeats are not logged; expired leases are inferred from claims." }),
          el("h3", { id: "timeline-label", text: "Timeline" }),
          el("div", { id: "timeline" }, timeline(job, events)),
          more ? el("p", { class: "hint", id: "events-more", text: "Showing the first 500 events." }) : null)),
      el("div", {},
        el("section", { class: "panel", "aria-labelledby": "act-title" },
          el("div", { class: "panel-body" }, el("h2", { id: "act-title", text: "Operator actions" }),
             el("div", { class: "actions", id: "detail-actions" }, ...actions(job)))),
        el("section", { class: "panel", "aria-labelledby": "sum-title" },
          el("div", { class: "panel-body" }, el("h2", { id: "sum-title", text: "Summary" }), fields)))),
    el("div", { class: "panel", role: "group", "aria-labelledby": "payload-title" },
      el("div", { class: "panel-body" },
        el("h2", { id: "payload-title", text: "Payload" }),
        el("div", { class: "code-region", role: "region", "aria-labelledby": "payload-title", tabindex: "0" },
          el("pre", { class: "json", id: "payload", text: JSON.stringify(job.payload, null, 2) })),
        el("h2", { id: "result-title", class: "spaced", text: "Result" }),
        el("div", { class: "code-region", role: "region", "aria-labelledby": "result-title", tabindex: "0" },
          el("pre", { class: "json", id: "result", text: job.result === null ? "none" : JSON.stringify(job.result, null, 2) }))))];
  reconcileChildren(box, content);
  const share = $("share-job");
  if (share) share.onclick = () => window.LeaseQPlatformShareJob?.(id);
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
               el("a", { href: "#/connection", text: "Enter it in Settings" }))];
  }
  const out = [];
  if (job.state === "dead") {
    const b = el("button", { type: "button", class: "btn", id: "requeue", text: "Requeue job" });
    b.onclick = () => confirmAction("requeue", job, b);
    out.push(b);
  }
  if (job.state === "queued" || job.state === "leased") {
    const b = el("button", { type: "button", class: "btn danger", id: "cancel", text: "Cancel job" });
    b.onclick = () => confirmAction("cancel", job, b);
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
  if (!app.submitKey) app.submitKey = `ui-${crypto.randomUUID()}`;
  const kind = el("input", { class: "input", id: "job-kind", maxlength: 100, required: true });
  kind.value = app.submitFields.kind;
  const payload = el("textarea", { id: "job-payload", spellcheck: "false", "aria-describedby": "payload-hint payload-size" });
  payload.value = app.submitDraft;
  app.submitDraft = payload.value;
  const word = el("textarea", { id: "wc-text", spellcheck: "false", "aria-describedby": "wc-hint wc-count wc-error" });
  word.value = app.submitText;
  const count = el("p", { class: "hint", id: "wc-count" });
  const setCount = () => { count.textContent = `${word.value.length.toLocaleString("en-US")} of 10,000 characters`; };
  setCount();
  const key = el("input", { class: "input mono", id: "job-key", maxlength: 200, required: true }); key.value = app.submitKey;
  const priority = el("input", { class: "input", id: "job-priority", type: "number", min: -100, max: 100, step: 1 }); priority.value = app.submitFields.priority;
  const attempts = el("input", { class: "input", id: "job-attempts", type: "number", min: 1, max: 100, step: 1 }); attempts.value = app.submitFields.attempts;
  const due = el("input", { class: "input", id: "job-due", placeholder: "2026-11-14T15:30:00Z" }); due.value = app.submitFields.due;
  const delay = el("input", { class: "input", id: "job-delay", type: "number", min: 0, max: 31536000, step: "any" }); delay.value = app.submitFields.delay;
  const size = el("p", { class: "hint", id: "payload-size" });
  const update = () => {
    app.submitDraft = payload.value;
    app.submitFields = { kind: kind.value, priority: priority.value, attempts: attempts.value, due: due.value, delay: delay.value };
    let p; try { p = kind.value === "word_count" ? { text: word.value } : JSON.parse(payload.value); } catch { p = payload.value; }
    const body = {kind: kind.value, payload: p, max_attempts: Number(attempts.value), priority: Number(priority.value)};
    if (due.value.trim()) body.run_after = due.value.trim();
    if (delay.value !== "") body.delay_seconds = Number(delay.value);
    const content = JSON.stringify(body);
    if (app.submitIntent && app.submitIntent.content !== content) {
      app.submitIntent = null;
      if (!app.submitKeyExplicit) { app.submitKey = `ui-${crypto.randomUUID()}`; key.value = app.submitKey; }
    }
    size.textContent = `${new TextEncoder().encode(content).length.toLocaleString()} of 65,536 request-body bytes`;
    if (app.profile) {
      if (app.profileSaveTimer !== null) clearTimeout(app.profileSaveTimer);
      const profileId=app.profile.id, generation=app.profileSaveGeneration;
      app.profileSaveTimer=window.setTimeout(()=>{app.profileSaveTimer=null;if(!app.profile||app.profile.id!==profileId||generation!==app.profileSaveGeneration)return;try{const old=LeaseQProfiles.load(profileId);LeaseQProfiles.save(profileId,{...old,submitDraft:app.submitDraft,submitText:app.submitText,submitFields:app.submitFields});}catch(e){showBanner("Could not save this draft on the browser.",false);}},500);
    }
  };
  for (const c of [kind, payload, priority, attempts, due, delay]) c.addEventListener("input", update);
  word.addEventListener("input", () => { app.submitText = word.value; setCount(); update(); });
  key.addEventListener("input", () => { app.submitKey = key.value; app.submitKeyExplicit = true; app.submitIntent = null; });
  const wordFields = el("div", { id: "word-fields" },
    el("label", { for: "wc-text", text: "Text to count" }),
    el("p", { class: "hint", id: "wc-hint", text: "The word_count handler accepts up to 10,000 characters. Longer text remains editable and cannot be submitted." }),
    word, count, el("p", { class: "hint" }, "Sample text: Jane Austen, ", el("cite", { text: "Pride and Prejudice" }), ", chapter 1; see ", el("a", { href: new URL('sample/SOURCE.txt', ASSET_ROOT).href, text: "source and licence note" }), "."));
  const jsonFields = el("div", { id: "json-fields" },
    el("label", { for: "job-payload", text: "JSON object payload" }), payload,
    el("p", { class: "hint", id: "payload-hint", text: "No silent truncation. Encoded request bodies are limited to 65,536 bytes." }), size);
  const mode = () => {
    wordFields.hidden = kind.value !== "word_count"; jsonFields.hidden = kind.value === "word_count";
    sample.hidden = kind.value !== "word_count"; clear.hidden = kind.value === "word_count"; clearWord.hidden = kind.value !== "word_count";
    update();
  };
  kind.addEventListener("input", mode);
  const preset = (label, k, p) => { const b = el("button", { type: "button", class: "btn", text: label }); b.addEventListener("click", () => { kind.value = k; if (k === "word_count") { word.value = p.text; app.submitText = word.value; setCount(); } else payload.value = JSON.stringify(p, null, 2); mode(); }); return b; };
  const generate = el("button", { type: "button", class: "btn", text: "Generate key" });
  generate.addEventListener("click", () => { app.submitKey = `ui-${crypto.randomUUID()}`; app.submitKeyExplicit = false; key.value = app.submitKey; app.submitIntent = null; });
  const sample = el("button", { type: "button", class: "btn", text: "Load sample text" });
  sample.addEventListener("click", async () => {
    try {
      const r = await fetch(SAMPLE_TEXT, { credentials: "omit" });
      if (!r.ok) throw new Error(String(r.status));
      kind.value = "word_count"; word.value = await r.text(); app.submitText = word.value; setCount(); mode();
      announce("Sample text loaded: Pride and Prejudice, chapter 1.");
    } catch { $("wc-error").textContent = "The sample text could not be loaded from this server."; }
  });
  const clear = el("button", { type: "button", class: "btn", text: "Clear payload" });
  clear.addEventListener("click", () => { payload.value = ""; update(); payload.focus(); });
  const clearWord = el("button", { type: "button", class: "btn", text: "Clear text" });
  clearWord.addEventListener("click", () => { word.value = ""; app.submitText = ""; setCount(); update(); word.focus(); });
  const form = el("form", { id: "submit-form", class: "form-stack submit-form", novalidate: true },
    el("div", { class: "submit-editor" },
      el("label", { for: "job-kind", text: "Job kind" }), kind,
      el("p", { class: "hint", id: "kind-observed", text: app.ops.workers ? `Worker kinds: ${[...new Set(app.ops.workers.workers.flatMap((w) => w.kinds || []))].join(", ") || "none reported"}. Unhandled kinds may remain queued.` : "Worker kinds not loaded. Unhandled kinds may remain queued." }),
      el("div", { class: "form-actions" }, preset("word_count", "word_count", { text: "" }), preset("sleep", "sleep", { ms: 1000 }), sample, clear, clearWord),
      wordFields, jsonFields),
    el("div", { class: "submit-options" },
      el("label", { for: "job-priority", text: "Priority (-100 to 100)" }), priority,
      el("label", { for: "job-attempts", text: "Maximum attempts (1 to 100)" }), attempts,
      el("label", { for: "job-due", text: "UTC due time (ISO 8601 ending in Z, optional)" }), due,
      el("label", { for: "job-delay", text: "Delay seconds (optional)" }), delay,
      el("label", { for: "job-key", text: "Idempotency key" }), el("div", { class: "form-actions" }, key, generate),
      el("p", { class: "hint" }, "Reuse this key after an ambiguous request."),
      el("p", { class: "field-error", id: "submit-error", "aria-live": "polite" }, el("span", { id: "wc-error" })),
      el("div", { class: "form-actions" }, el("button", { type: "submit", class: "btn primary", id: "submit-job", text: "Submit job", disabled: app.submitInFlight })),
      el("div", { id: "submit-result", class: "result-box", "aria-live": "polite" })));
  form.addEventListener("submit", submitJob); mode();
  return [h1("New job"),
    app.token ? null : (connectionNotice("Submitting needs the API token.") || el("p", {}, "Enter an API token in Settings.")),
    el("section", { class: "panel", "aria-label": "Job composer" }, el("div", { class: "panel-body" }, form))];
}

async function submitJob(e) {
  e.preventDefault();
  if (app.submitInFlight) return;
  const form = $("submit-form");
  const fail = (msg, id = $("job-kind").value === "word_count" ? "wc-text" : "job-payload") => {
    $("wc-error").textContent = msg;
    $(id).setAttribute("aria-invalid", "true"); $(id).focus();
  };
  const kind = $("job-kind").value.trim(); let payload;
  if (kind === "word_count") {
    const text = $("wc-text").value;
    if (!text.trim()) return fail("Enter some text to count.");
    if (text.length > WC_MAX) return fail(`The text has ${text.length.toLocaleString("en-US")} characters; the limit is 10,000.`);
    payload = { text };
  } else try { payload = JSON.parse($("job-payload").value); } catch { return fail("Payload must be valid JSON."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("Payload must be a JSON object.");
  if (!KIND_RE.test(kind)) return fail("Enter a valid job kind.", "job-kind");
  const priority = Number($("job-priority").value), max_attempts = Number($("job-attempts").value);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) return fail("Priority must be from -100 to 100.", "job-priority");
  if (!Number.isInteger(max_attempts) || max_attempts < 1 || max_attempts > 100) return fail("Attempts must be from 1 to 100.", "job-attempts");
  const due = $("job-due").value.trim(), delay = $("job-delay").value;
  if (due && delay !== "") return fail("Choose a UTC due time or delay, not both.", "job-due");
  if (due && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/.test(due) || !Number.isFinite(Date.parse(due)))) return fail("Use a valid timezone-aware UTC ISO time ending in Z.", "job-due");
  if (delay !== "" && (!Number.isFinite(Number(delay)) || Number(delay) < 0 || Number(delay) > 31536000)) return fail("Delay must be 0 to 31,536,000 seconds.", "job-delay");
  if (!app.token) return fail("Enter an API token in Settings.", "job-kind");
  const body = { kind, payload, max_attempts, priority }; if (due) body.run_after = due; if (delay !== "") body.delay_seconds = Number(delay);
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).length > 65536) return fail("Request exceeds the 65,536-byte API limit; no content was removed.");
  const idem = $("job-key").value.trim(); if (!idem || idem.length > 200) return fail("Enter an idempotency key up to 200 characters.", "job-key");
  const signature = `${idem}\n${serialized}`; if (!app.submitIntent || app.submitIntent.signature !== signature) app.submitIntent = { signature, content: serialized, key: idem };
  const gen = app.authGen; app.submitInFlight = true; $("submit-job").disabled = true;
  let r;
  try { r = await api("/jobs", { method: "POST", headers: { "Idempotency-Key": app.submitIntent.key }, body }); }
  catch { if (gen === app.authGen) $("wc-error").textContent = "Cannot reach the API. Retry with the same idempotency key."; }
  finally { if (gen === app.authGen) { app.submitInFlight = false; const button = form.querySelector("#submit-job"); if (button) button.disabled = false; } }
  if (!r || gen !== app.authGen) return;
  if (r.status === 401) { handleUnauthorized(); return; }
  if (r.status !== 201 && r.status !== 200) { $("wc-error").textContent = `The API refused the job (HTTP ${r.status}). ${detailText(r.body)}`; return; }
  app.submit = { id: String(r.body.id), job: r.body, started: Date.now() };
  if (form !== $("submit-form")) { startSubmitPoll(); return; }
  $("job-payload").removeAttribute("aria-invalid"); $("wc-text").removeAttribute("aria-invalid");
  $("wc-error").textContent = "";
  renderSubmitResult(); startSubmitPoll();
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
  if (job.state === "done" && job.result && job.kind === "word_count" && Number.isInteger(job.result.words) && Number.isInteger(job.result.lines)) {
    box.replaceChildren(
      el("h2", { text: `Job ${s.id} is done` }),
      el("div", { class: "result-figures" },
        el("div", {}, el("strong", { text: String(job.result.words) }), el("span", { text: "words" })),
        el("div", {}, el("strong", { text: String(job.result.lines) }), el("span", { text: "lines" }))),
      el("p", { class: "sr-only", text: `${job.result.words} words, ${job.result.lines} lines.` }),
      el("p", {}, `Counted by worker `, el("span", { class: "mono", text: job.leased_by || "" }),
         ` on attempt ${job.attempts}. `, link));
  } else if (job.state === "done") {
    box.replaceChildren(el("h2", { text: `Job ${s.id} is done` }),
      el("pre", { class: "json", "aria-label": "Recorded job result", text: JSON.stringify(job.result, null, 2) }),
      el("p", {}, "Result recorded by worker ", el("span", { class: "mono", text: job.leased_by || "unknown" }), ". ", link));
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

function profileBackupPanel() {
  const status=el("p",{id:"profile-backup-status",role:"status","aria-live":"polite"});
  const preview=el("p",{id:"profile-backup-preview",class:"hint"});
  const file=el("input",{id:"profile-backup-file",type:"file",accept:"application/json,.json","aria-describedby":"profile-backup-file-help"});
  const exportPass=el("input",{id:"profile-backup-export-pass",type:"password",autocomplete:"new-password",minlength:"12",maxlength:"1024",required:true});
  const importPass=el("input",{id:"profile-backup-import-pass",type:"password",autocomplete:"current-password",minlength:"12",maxlength:"1024",required:true});
  const panel=el("section",{class:"panel profile-backup","aria-labelledby":"profile-backup-title"},
    el("div",{class:"panel-body"},el("h2",{id:"profile-backup-title",text:"Encrypted profile backup"}),
      el("p",{class:"hint",text:"Offline JSON backup uses PBKDF2-HMAC-SHA-256 (600,000 iterations) and AES-256-GCM. The file excludes profile login verifiers and API bearer tokens. Keep the passphrase separate from the file."}),
      app.profile?el("div",{class:"profile-backup-controls"},
        el("fieldset",{},el("legend",{},"Choose what to export"),
          el("label",{},el("input",{type:"checkbox",id:"backup-preferences"})," Saved theme preference"),
          el("label",{},el("input",{type:"checkbox",id:"backup-drafts"})," Saved submit draft and fields"),
          el("label",{},el("input",{type:"checkbox",id:"backup-simulation"})," Saved simulator example and selected evidence")),
        el("label",{for:"profile-backup-export-pass",text:"Backup passphrase (12–1024 characters)"}),exportPass,
        el("button",{type:"button",class:"btn primary",id:"profile-backup-export",text:"Create encrypted backup"}),
        el("label",{for:"profile-backup-file",text:"Encrypted JSON backup file"}),file,
        el("p",{id:"profile-backup-file-help",class:"hint",text:`Maximum ${LeaseQProfiles.backupMaxBytes.toLocaleString()} bytes. Decryption is staged before anything is written.`}),
        el("label",{for:"profile-backup-import-pass",text:"Backup passphrase"}),importPass,
        el("div",{class:"form-actions"},el("button",{type:"button",class:"btn",id:"profile-backup-preview-button",text:"Decrypt and preview"}),el("button",{type:"button",class:"btn primary",id:"profile-backup-apply",text:"Restore selected data",disabled:true}),el("button",{type:"button",class:"btn",id:"profile-backup-cancel",text:"Cancel restore",disabled:true})),preview,status):el("p",{},"Create or log in to a local browser profile to export or restore selected settings.")),
    );
  if(!app.profile)return panel;
  let prepared=null;
  file.addEventListener("change",()=>{prepared=null;panel.querySelector("#profile-backup-apply").disabled=true;panel.querySelector("#profile-backup-cancel").disabled=true;preview.textContent="";status.textContent=file.files?.length?"Backup selection changed. Decrypt and preview it again before restoring.":"";});
  const exportButton=panel.querySelector("#profile-backup-export");
  exportButton.addEventListener("click",async()=>{
    status.textContent="";const generation=app.profileAuthGeneration,id=app.profile.id,pass=exportPass.value;
    const selection={preferences:$("backup-preferences").checked,drafts:$("backup-drafts").checked,simulation:$("backup-simulation").checked};
    exportButton.disabled=true;status.textContent="Encrypting the selected local data…";
    try{const contents=await LeaseQProfiles.exportBackup(id,pass,selection);if(generation!==app.profileAuthGeneration||app.profile?.id!==id)return;
      const url=URL.createObjectURL(new Blob([contents],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="leaseq-encrypted-profile-backup.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),0);status.textContent="Encrypted backup downloaded. The passphrase was not saved.";
    }catch(error){status.textContent=error.message||"Could not create the encrypted backup.";}finally{exportPass.value="";exportButton.disabled=false;}
  });
  panel.querySelector("#profile-backup-preview-button").addEventListener("click",async()=>{
    prepared=null;panel.querySelector("#profile-backup-apply").disabled=true;panel.querySelector("#profile-backup-cancel").disabled=true;preview.textContent="";status.textContent="";
    const selected=file.files?.[0],pass=importPass.value,generation=app.profileAuthGeneration,id=app.profile.id;
    if(!selected){status.textContent="Choose an encrypted JSON file first.";return;}
    if(selected.size>LeaseQProfiles.backupMaxBytes){status.textContent=`The selected file exceeds ${LeaseQProfiles.backupMaxBytes.toLocaleString()} bytes; current profile data is unchanged.`;return;}
    try{const text=await selected.text();if(generation!==app.profileAuthGeneration||app.profile?.id!==id)return;const candidate=await LeaseQProfiles.prepareBackup(text,pass);if(generation!==app.profileAuthGeneration||app.profile?.id!==id)return;prepared=candidate;
      preview.textContent=`Preview ready: selected categories ${candidate.categories.join(", ")}. ${candidate.hasSimulation?"A saved local simulator example is included; it will not run automatically.":"No simulator example is included."} Applying this selection merges only these keys into this local profile.`;
      panel.querySelector("#profile-backup-apply").disabled=false;panel.querySelector("#profile-backup-cancel").disabled=false;status.textContent="Decryption and validation passed. No local data has changed yet.";
    }catch(error){status.textContent=error.message||"Could not decrypt this backup. Current profile data is unchanged.";}
    finally{importPass.value="";}
  });
  panel.querySelector("#profile-backup-cancel").addEventListener("click",()=>{prepared=null;panel.querySelector("#profile-backup-apply").disabled=true;panel.querySelector("#profile-backup-cancel").disabled=true;file.value="";preview.textContent="";status.textContent="Restore canceled. Current profile data is unchanged.";});
  panel.querySelector("#profile-backup-apply").addEventListener("click",()=>{
    if(!prepared){status.textContent="Decrypt and preview a file before restoring.";return;}
    const generation=app.profileAuthGeneration,id=app.profile.id;
    try{const saved=LeaseQProfiles.commitBackup(id,prepared);cancelProfileSave();prepared=null;if(generation!==app.profileAuthGeneration||app.profile?.id!==id)return;
      document.documentElement.setAttribute("data-theme",saved.theme||"light");app.submitDraft=saved.submitDraft||"";app.submitText=saved.submitText||"";app.submitFields={kind:"word_count",priority:"0",attempts:"3",due:"",delay:"",...(saved.submitFields||{})};app.guestSimulation=saved.guestSimulation||null;app.simulator=LeaseQSimulator.fresh(saved.guestSimulation?.text||DEFAULT_SIM_TEXT);app.simulation=null;try{sessionStorage.removeItem("leaseq:guest-simulation:v1");}catch{}
      panel.querySelector("#profile-backup-apply").disabled=true;panel.querySelector("#profile-backup-cancel").disabled=true;file.value="";preview.textContent="";status.textContent="Selected data restored to this local browser profile. Simulator examples are saved evidence and do not execute.";renderThemeButtons();
    }catch(error){status.textContent=error.message||"Restore failed. The existing local profile data was preserved.";}
  });
  return panel;
}

function profileCloudSyncPanel(){
  const status=el("p",{id:"cloud-sync-status",role:"status","aria-live":"polite",text:app.syncStatus||"Not connected. No cloud endpoint or account is configured."});
  const project=el("input",{id:"cloud-project-origin",type:"url",autocomplete:"url",placeholder:"https://your-project.supabase.co"});
  const key=el("input",{id:"cloud-publishable-key",type:"password",autocomplete:"off",maxlength:"4096"});
  const email=el("input",{id:"cloud-email",type:"email",autocomplete:"email",maxlength:"254"});
  const password=el("input",{id:"cloud-password",type:"password",autocomplete:"current-password",maxlength:"1024"});
  if(app.syncConfig){project.value=app.syncConfig.origin;key.value=app.syncConfig.key;}
  const connected=!!app.syncProvider?.session;
  if(connected){project.disabled=true;key.disabled=true;email.disabled=true;password.disabled=true;}
  const consent=el("input",{id:"cloud-sync-consent",type:"checkbox"});
  const includeTheme=el("input",{id:"cloud-include-theme",type:"checkbox"});
  const includeDrafts=el("input",{id:"cloud-include-drafts",type:"checkbox"});
  const includeSimulation=el("input",{id:"cloud-include-simulation",type:"checkbox"});
  const remote=app.syncRemote;
  const summary=remote?remote.deleted?`Remote deletion marker at revision ${remote.revision}.`: `Remote revision ${remote.revision}; saved categories: ${Object.keys(remote.data).join(", ")||"none"}.`:"No remote workspace has been read in this session.";
  const panel=el("section",{class:"panel cloud-sync","aria-labelledby":"cloud-sync-title"},el("div",{class:"panel-body"},
    el("h2",{id:"cloud-sync-title",text:"Optional cloud workspace sync"}),
    el("p",{class:"hint",text:"Reference connector: Supabase Auth and row-level security. This is unconfigured by default. Cloud identity is separate from LeaseQ API bearer access and does not create user-owned queue jobs."}),
    el("p",{class:"hint"},"Install the reviewed ",el("a",{href:new URL('../pages/cloud-sync.html', ASSET_ROOT).href,text:"Supabase table and RLS policy"})," in a project you control. Use a publishable or legacy anon key only; never use an sb_secret or service_role key."),
    app.profile?el("div",{},
      el("label",{for:"cloud-project-origin",text:"Supabase project origin"}),project,
      el("label",{for:"cloud-publishable-key",text:"Publishable or legacy anon key"}),key,
      connected?el("p",{class:"hint",text:`Signed in to Supabase account ${app.syncProvider.session.email||app.syncProvider.session.userId}. Bearer is held in memory only; it is never used for the LeaseQ API.`}):el("div",{},el("label",{for:"cloud-email",text:"Supabase account email"}),email,el("label",{for:"cloud-password",text:"Supabase account password"}),password),
      el("div",{class:"form-actions"},connected?el("button",{type:"button",class:"btn",id:"cloud-signout",text:"Sign out of cloud sync"}):el("button",{type:"button",class:"btn primary",id:"cloud-signin",text:"Connect to Supabase"})),
      connected?el("fieldset",{},el("legend",{},"Select saved local data for this action"),el("label",{},consent," I consent to access the configured Supabase project."),el("label",{},includeTheme," Include saved theme preference"),el("label",{},includeDrafts," Include saved submit drafts"),el("label",{},includeSimulation," Include saved simulator example and selected evidence"),el("p",{class:"hint",text:"No live API job, token, password verifier, session or mutation queue is eligible for sync."}),el("div",{class:"form-actions"},el("button",{type:"button",class:"btn",id:"cloud-read",text:"Read remote revision"}),el("button",{type:"button",class:"btn primary",id:"cloud-sync",text:"Sync selected local data"}),el("button",{type:"button",class:"btn",id:"cloud-restore",text:"Restore remote selection locally",disabled:!remote||remote.deleted}),el("button",{type:"button",class:"btn",id:"cloud-replace",text:"Replace remote with selected local data",disabled:!remote}),el("button",{type:"button",class:"btn danger",id:"cloud-delete",text:"Mark remote copy deleted",disabled:!remote||remote.deleted})),el("p",{class:"hint",id:"cloud-remote-preview",text:summary})):null):el("p",{},"Create or log in to a local browser profile before selecting data to sync."),status));
  if(!app.profile)return panel;
  if(!connected){panel.querySelector("#cloud-signin").addEventListener("click",async()=>{
    const button=panel.querySelector("#cloud-signin"),epoch=++app.syncEpoch;app.syncStatus="Connecting to Supabase Auth…";status.textContent=app.syncStatus;button.disabled=true;
    try{const provider=new LeaseQSync.SupabaseRlsProvider(project.value,key.value);app.syncProvider=provider;app.syncConfig={origin:provider.origin,key:key.value};app.syncRemote=null;const user=await provider.signIn(email.value,password.value);if(epoch!==app.syncEpoch||app.syncProvider!==provider)return;app.syncStatus=`Connected to Supabase account ${user.email||user.userId}. No LeaseQ API authority was granted.`;renderView(false);}
    catch(error){if(epoch===app.syncEpoch){app.syncStatus=error.message||"Supabase sign-in failed.";status.textContent=app.syncStatus;}}
    finally{password.value="";button.disabled=false;}
  });return panel;}
  const provider=app.syncProvider;
  const current=()=>{if(!consent.checked)throw Error("Select the consent checkbox before reading or writing the configured cloud workspace.");if(app.syncProvider!==provider)throw Error("Cloud session changed; this operation was canceled.");};
  const selection=()=>{const saved=LeaseQProfiles.load(app.profile.id),data={};if(includeTheme.checked&&saved.theme)data.theme=saved.theme;if(includeDrafts.checked)for(const field of ["submitDraft","submitText","submitFields"])if(saved[field]!==undefined)data[field]=saved[field];if(includeSimulation.checked){if(!saved.guestSimulation)throw Error("Save a simulator example in this local profile before selecting it for cloud sync.");data.guestSimulation=saved.guestSimulation;}const clean=LeaseQProfiles.validateData(data);if(!Object.keys(clean).length)throw Error("Select at least one saved data category.");return clean;};
  const run=async(label,operation)=>{const epoch=app.syncEpoch,id=app.profile.id;status.textContent=label;try{const result=await operation();if(epoch!==app.syncEpoch||app.syncProvider!==provider||app.profile?.id!==id)return result;return result;}catch(error){if(epoch===app.syncEpoch){app.syncStatus=error.message||"Cloud sync request failed.";status.textContent=app.syncStatus;}return null;}};
  panel.querySelector("#cloud-signout").addEventListener("click",()=>{clearSyncSession();app.syncStatus="Cloud session cleared; selected data remains in this local profile.";renderView(false);});
  panel.querySelector("#cloud-read").addEventListener("click",()=>run("Reading the authenticated user's remote workspace…",async()=>{current();const found=await provider.read();if(app.syncProvider!==provider)return;app.syncRemote=found;app.syncStatus=found?found.deleted?`Remote deletion marker read at revision ${found.revision}.`:`Remote revision ${found.revision} read; local profile is unchanged.`:"No remote workspace exists yet. A later sync may create revision 1.";renderView(false);}));
  panel.querySelector("#cloud-sync").addEventListener("click",()=>run("Checking remote revision before syncing…",async()=>{current();const data=selection();const result=await provider.sync(data);if(app.syncProvider!==provider)return;if(result.ok){app.syncRemote=result.unchanged?app.syncRemote:{revision:result.revision,deleted:false,data};app.syncStatus=result.unchanged?`Remote revision ${result.revision} already matches the selected local data.`:`Selected local data written as remote revision ${result.revision}.`;}else{app.syncRemote=result.remote;app.syncStatus=`Conflict preserved. ${result.reason||`Remote revision ${result.remote?.revision??"unknown"} differs.`} Review the remote selection or explicitly replace it.`;}renderView(false);}));
  panel.querySelector("#cloud-restore").addEventListener("click",()=>{try{current();}catch(error){status.textContent=error.message;return;}if(!remote||remote.deleted)return;try{const saved=LeaseQProfiles.load(app.profile.id);LeaseQProfiles.save(app.profile.id,{...saved,...remote.data});cancelProfileSave();const restored=LeaseQProfiles.load(app.profile.id);document.documentElement.setAttribute("data-theme",restored.theme||"light");app.guestSimulation=restored.guestSimulation||null;app.submitDraft=restored.submitDraft||"";app.submitText=restored.submitText||"";app.submitFields={...app.submitFields,...(restored.submitFields||{})};app.simulator=LeaseQSimulator.fresh(restored.guestSimulation?.text||DEFAULT_SIM_TEXT);app.simulation=null;app.syncStatus="Selected remote data restored locally. No job commands were replayed.";status.textContent=app.syncStatus;renderThemeButtons();}catch(error){status.textContent=error.message||"Remote data could not be restored locally.";}});
  panel.querySelector("#cloud-replace").addEventListener("click",()=>run("Writing against the revision shown in the preview…",async()=>{current();const data=selection();const result=await provider.write(data,remote?.revision??null);if(app.syncProvider!==provider)return;if(result.ok){app.syncRemote={revision:result.revision,deleted:false,data};app.syncStatus=`Selected local data written as remote revision ${result.revision}.`; }else{app.syncRemote=result.remote;app.syncStatus="A newer remote revision arrived. Neither copy was overwritten; review it again.";}renderView(false);}));
  panel.querySelector("#cloud-delete").addEventListener("click",()=>{try{current();}catch(error){status.textContent=error.message;return;}if(!remote)return;if(!window.confirm(`Create a remote deletion marker at revision ${remote.revision+1}? Local profile data will remain.`))return;run("Creating the explicit remote deletion marker…",async()=>{const result=await provider.deleteRemote(remote.revision);if(app.syncProvider!==provider)return;if(result.ok){app.syncRemote={revision:result.revision,deleted:true,data:{}};app.syncStatus=`Remote data marked deleted at revision ${result.revision}. Local data was preserved.`;}else{app.syncRemote=result.remote;app.syncStatus="Remote revision changed; deletion was not applied.";}renderView(false);});});
  return panel;
}

function table(head, rows, label) { return el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": label },
    el("table", {}, el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col", text: h })))),
       el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c, i) => el("td", { class: i < 2 && head[0] === "Method" ? "mono" : null, }, c))))))) }

function viewConnection() {
  const origin = app.apiOrigin || window.location.origin;
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
    tokenPart = [el("p", { id: "token-ok" }, "The token is in this page's memory only and is sent only in the Authorization header; reloading forgets it. ",
                    el("a", { href: app.lastJobsHash, id: "go-jobs", text: "Go to Jobs" })),
                 el("div", { class: "form-actions" }, forget)];
  } else {
    const input = el("input", { class: "input", id: "token-input", type: "password", autocomplete: "off",
                                spellcheck: "false", "aria-describedby": "token-hint token-error", required: true });
    const form = el("form", { id: "token-form", class: "form-stack", novalidate: true },
      el("label", { for: "token-input", text: "API token" }),
      el("p", { class: "hint", id: "token-hint" }, "Use the server's ", el("code", { text: "LEASEQ_API_TOKEN" }),
         ". ", el("code", { text: "scripts/up.sh" }), " writes it to ", el("code", { text: ".env" }),
         ". Stored in this page's memory only."),
      input,
      el("p", { class: "field-error", id: "token-error" }),
      el("div", { class: "form-actions" }, el("button", { type: "submit", class: "btn primary", text: "Use token" })));
    form.addEventListener("submit", submitToken);
    tokenPart = [form];
  }

  const apiOriginInput = el("input", { class:"input", id:"api-origin-input", type:"url", autocomplete:"url", placeholder:STATIC_API_DISABLED?"https://your-api.example":"same origin", "aria-describedby":"api-origin-help api-origin-error" });
  apiOriginInput.value = app.apiOrigin === location.origin ? "" : app.apiOrigin || "";
  const apiOriginForm = el("form",{id:"api-origin-form",class:"form-stack",novalidate:true},
    el("label",{for:"api-origin-input",text:"Live API origin (optional)"}),
    el("p",{id:"api-origin-help",class:"hint",text:"Leave blank to use this page's same-origin API. On static hosting, configure an HTTPS API origin with CORS enabled. Only the origin is stored; the bearer token stays in page memory and is never sent to the simulator."}),
    apiOriginInput,el("p",{id:"api-origin-error",class:"field-error",role:"alert"}),
    el("button",{type:"submit",class:"btn primary",text:"Use Live API origin"}));
  apiOriginForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const error=$("api-origin-error"), raw=apiOriginInput.value.trim(); let next=null;
    try {
      if(raw){const parsed=new URL(raw);if(parsed.username||parsed.password||parsed.pathname!=="/"||parsed.search||parsed.hash)throw new Error("Enter an origin only: scheme and host, with no path, query, credentials or fragment.");if(parsed.protocol!=="https:"&&!(parsed.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(parsed.hostname)))throw new Error("Use HTTPS for remote APIs; HTTP is allowed only on loopback.");next=parsed.origin;}
      else next=STATIC_API_DISABLED?null:location.origin;
      if(next!==app.apiOrigin){app.authGen+=1;app.authPending=null;if(app.token){app.token=null;clearSensitive();setConn("unknown");showBanner("The API target changed; the in-memory bearer token was cleared. Enter a token for the new origin.",false);}try{if(next)localStorage.setItem("leaseq:api-origin:v1",next);else localStorage.removeItem("leaseq:api-origin:v1");}catch{throw new Error("Browser storage is unavailable; the API origin was not changed.");}app.apiOrigin=next;app.apiAvailability=next?"unknown":"unavailable";app.modeUserChoice=true;app.mode=next?"live":"simulator";syncModeChrome();if(next)await loadVersion();else{stopPolling();setConn("offline");renderView(false);}}
      error.textContent="";
    }catch(e){error.textContent=e.message||"The Live API origin is invalid.";}
  });

  const ep = [
    ["POST", "/jobs", "Submit a job (Idempotency-Key header)", "yes"],
    ["POST", "/jobs/claim", "Worker takes the oldest runnable job under a lease", "yes"],
    ["POST", "/jobs/{id}/heartbeat", "Worker extends its lease", "yes"],
    ["POST", "/jobs/{id}/complete", "Worker stores the result (fenced by lease token)", "yes"],
    ["POST", "/jobs/{id}/fail", "Worker reports an error; retry with backoff or dead", "yes"],
    ["POST", "/jobs/{id}/requeue", "Operator: dead job back to the queue", "yes"],
    ["POST", "/jobs/{id}/cancel", "Operator: mark dead and revoke its lease; does not stop previously claimed work", "yes"],
    ["POST", "/jobs/bulk", "Operator: bounded requeue or cancel batches", "yes"],
    ["GET", "/workers", "Observed worker reports and actual heartbeats", "yes"],
    ["GET", "/operations/metrics", "Sampled 15-minute queue events and wait percentiles", "yes"],
    ["GET/POST", "/schedules", "List or create durable UTC cron schedules", "yes"],
    ["PATCH", "/schedules/{id}", "Enable or disable a durable schedule", "yes"],
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


  return [
    h1("Settings"),
    profileBackupPanel(),
    profileCloudSyncPanel(),
    el("div", { class: "connection-grid" },
      el("section", { class: "panel", "aria-labelledby": "tok-title" },
      el("div", { class: "panel-body" }, el("h2", { id: "tok-title", text: "Token" }), ...tokenPart)),
    el("section",{class:"panel","aria-labelledby":"api-origin-title"},el("div",{class:"panel-body"},el("h2",{id:"api-origin-title",text:"API target"}),apiOriginForm)),
    el("section", { class: "panel", "aria-labelledby": "st-title" },
      el("div", { class: "panel-body" }, el("h2", { id: "st-title", text: "Status" }),
        el("dl", { class: "fields" },
          el("dt", { text: "API address" }), el("dd", {}, el("code", { text: origin })),
          el("dt", { text: "Server version" }), el("dd", { id: "conn-version", text: app.version || "unknown" }),
          el("dt", { text: "Connection" }), el("dd", { id: "conn-detail", text: statusText }))))),
    el("details", { class: "panel guide" },
      el("summary", { class: "panel-head" }, "API help"),
      el("div", { class: "panel-body" },
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
  if (!app.apiOrigin) return fail("Configure a Live API origin before entering a token.");
  const origin = app.apiOrigin;
  // Invalidate anonymous probes before validating a new token.
  const gen = ++app.authGen;
  app.authPending = gen;
  app.pendingApiRequests += 1;
  let r = null;
  try {
    r = await fetch(new URL("/auth/check", origin).href, {
      headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(5000),
    });
  } catch { /* The same actionable connection error is shown below. */ }
  finally { app.pendingApiRequests -= 1; }
  if (app.authPending === gen) app.authPending = null;
  if (gen !== app.authGen || origin !== app.apiOrigin) return;
  if (!r) return fail("Cannot reach the API to check the token.");
  if (r.status === 401) return fail("The server rejected this token.");
  if (r.status !== 200) return fail(`Unexpected answer from the server (HTTP ${r.status}).`);
  input.value = "";
  clearSensitive();          // nothing read without the token survives into the new session
  app.token = value;
  app.apiAvailability = "available";
  try { sessionStorage.removeItem("leaseq-api-token"); } catch (e) { /* storage may be blocked */ }
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

function viewInvalidId() {
  return [h1("Invalid job ID"), el("p", { class: "lede", text: "Job IDs must be positive 64-bit integers. Check the link and try again." }),
    el("p", {}, el("a", { href: "#/jobs", text: "Go to Jobs" }))];
}

function viewOperations() {
  const name = el("input", { class: "input", id: "schedule-name", maxlength: 200, required: true });
  const kind = el("input", { class: "input", id: "schedule-kind", maxlength: 100, required: true });
  const cron = el("input", { class: "input", id: "schedule-cron", placeholder: "*/5 * * * *", required: true, "aria-describedby": "cron-hint" });
  const payload = el("textarea", { id: "schedule-payload", "aria-describedby": "schedule-payload-hint" }); payload.value = "{}";
  if (!app.scheduleKey) app.scheduleKey = `ui-schedule-${crypto.randomUUID()}`;
  const key = el("input", { class: "input mono", id: "schedule-key", maxlength: 200, required: true }); key.value = app.scheduleKey;
  key.addEventListener("input", () => { app.scheduleKey = key.value; });
  const priority = el("input", { class: "input", id: "schedule-priority", type: "number", min: -100, max: 100, value: "0" });
  const attempts = el("input", { class: "input", id: "schedule-attempts", type: "number", min: 1, max: 100, value: "5" });
  const error = el("p", { class: "field-error", id: "schedule-error", "aria-live": "polite" });
  const form = el("form", { class: "form-stack", id: "schedule-form", novalidate: true },
    el("label", { for: "schedule-name", text: "Schedule name" }), name,
    el("label", { for: "schedule-kind", text: "Job kind" }), kind,
    el("label", { for: "schedule-payload", text: "JSON object payload" }), payload,
    el("p", { class: "hint", id: "schedule-payload-hint", text: "Enter a JSON object to use as the payload for each scheduled job." }),
    el("label", { for: "schedule-cron", text: "Five-field UTC cron" }), cron,
    el("p", { class: "hint", id: "cron-hint", text: "Numeric minute hour day month weekday fields only. UTC; no seconds, names, random or year syntax." }),
    el("label", { for: "schedule-priority", text: "Priority (-100 to 100)" }), priority,
    el("label", { for: "schedule-attempts", text: "Maximum attempts" }), attempts,
    el("label", { for: "schedule-key", text: "Idempotency key (reuse on ambiguous retry)" }), key,
    error, el("button", { class: "btn primary", id: "schedule-submit", type: "submit",
      text: app.scheduleConfirmed ? "Start new schedule" : "Create schedule", disabled: app.scheduleInFlight }));
  form.addEventListener("submit", createSchedule);
  for (const input of form.querySelectorAll('input,textarea')) {
    if (app.scheduleDraft && Object.hasOwn(app.scheduleDraft, input.id)) input.value = app.scheduleDraft[input.id];
    input.addEventListener('input', () => { (app.scheduleDraft ||= {})[input.id] = input.value; });
  }
  return [h1(screenTitle()),
    el("p", { class: "field-error", id: "ops-error", role: "status", "aria-live": "polite" }),
    app.token ? null : connectionNotice("Operator observations and schedule changes need an API token."),
    app.route.page === 'leases' ? el('section', { class: 'panel', 'aria-labelledby': 'leases-title' }, el('div', { class: 'panel-body' }, el('h2', { id: 'leases-title', text: 'Current leases' }), el('p', { class: 'hint', text: 'Queue lease records; an expiry does not prove a worker process has stopped.' }), el('div', { id: 'leases-data' }))) : null,
    el("div", { class: "operations-grid" },
      el("section", { class: "panel", "aria-labelledby": "workers-title" }, el("div", { class: "panel-body" }, el("h2", { id: "workers-title", text: "Worker status" }), el("p", { class: "hint" }, "Reports and heartbeats are separate observations; neither confirms a process is alive."), el("div", { id: "workers-data" }, el("p", { class: "muted", text: "Loading workers…" })))),
      el("div", { class: "operations-side" },
        el("section", { class: "panel", "aria-labelledby": "metrics-title" }, el("div", { class: "panel-body" }, el("h2", { id: "metrics-title", text: "Metrics" }), el("div", { id: "metrics-data" }, el("p", { class: "muted", text: "Loading metrics…" })))),
        app.token ? el("section", { class: "panel", "aria-labelledby": "schedules-title" }, el("div", { class: "panel-head" }, el("h2", { id: "schedules-title", text: "Schedules" })), el("div", { class: "panel-body" }, el("div", { id: "schedules-data" }, el("p", { class: "muted", text: "Loading schedules…" })), form)) : null))];
}

function renderOperations() {
  if (!$("workers-data")) return;
  const focusedSchedule = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.schedule : null;
  $("ops-error").textContent = app.ops.error || "";
  const workers = app.ops.workers;
  $("workers-data").replaceChildren(...(!app.token ? [el("p", { class: "muted", text: "Connect with an API token to read worker observations." })] : !workers ? [el("p", { class: "muted", text: app.ops.error || "Loading worker observations…" })] : workers.workers.length ? [
    el("p", { class: "hint" }, `Observed as of ${fmtAbs(workers.as_of)}${workers.truncated ? "; list truncated" : ""}.`),
    el("ul", {}, ...workers.workers.map((w) => {
      const seenAge = new Date(workers.as_of).getTime() - new Date(w.last_seen_at).getTime();
      const recent = seenAge >= 0 && seenAge <= 30000;
      return el("li", {}, el("strong", { text: w.worker_id }), ` — ${recent ? "seen recently" : "no recent report"} (last report ${fmtAbs(w.last_seen_at)}); active leases ${w.active_jobs}; last actual heartbeat ${w.last_heartbeat_at ? fmtAbs(w.last_heartbeat_at) : "not observed"}; kinds ${(w.kinds || []).join(", ") || "none reported"}`);
    }))
  ] : [el("p", { class: "muted", text: "No worker reports have been observed." })]));
  const leases = $('leases-data');
  if (leases) leases.replaceChildren(...(!app.token ? [el('p', { text: 'Connect with an API token to inspect current leases.' })] : !app.ops.leases ? [el('p', { text: app.ops.error || 'Loading leases…' })] : !app.ops.leases.jobs.length ? [el('p', { text: 'No leased jobs were returned.' })] : [table(['Job', 'Worker', 'Lease expiry', 'Attempts'], app.ops.leases.jobs.map((job) => [el('a', { href: `#/jobs/${job.id}`, text: `Job ${job.id}` }), job.leased_by || 'Not reported', job.lease_expires_at ? fmtAbs(job.lease_expires_at) : 'Unavailable', `${job.attempts} of ${job.max_attempts}`]), 'Current leases, scrolls sideways'), el('p', { class: 'hint', text: `At most 100 returned jobs; ${app.ops.leases.next_before_id ? 'more leases exist. Open Jobs and filter Running to continue.' : 'no next page reported.'}` })]));
  const m = app.ops.metrics;
  $("metrics-data").replaceChildren(...(!app.token ? [el("p", { class: "muted", text: "Connect with an API token to read sampled metrics." })] : !m ? [el("p", { class: "muted", text: app.ops.error || "Loading sampled metrics…" })] : [
    el("p", { class: "hint" }, `15-minute window as of ${fmtAbs(m.as_of)}; sample cap ${m.sample_limit}${m.truncated ? " (truncated)" : ""}. No capacity estimate is implied.`),
    el("p", {}, `First-claim wait: p50 ${m.wait_ms.p50 === null ? "unavailable" : `${m.wait_ms.p50} ms`}, p95 ${m.wait_ms.p95 === null ? "unavailable" : `${m.wait_ms.p95} ms`} from ${m.wait_ms.samples} known samples.`),
    el("ul", {}, ...m.buckets.map((b) => el("li", {}, `${new Date(b.start).toISOString()} — ${b.completed} completed, ${b.failed} failed`)))
  ]));
  const s = app.ops.schedules;
  if ($("schedules-data")) $("schedules-data").replaceChildren(...(!s ? [el("p", { class: "muted", text: app.ops.error || "Loading schedules…" })] : s.schedules.length ? [
    el("p", { class: "hint" }, `${s.schedules.length} schedules${s.truncated ? "; list truncated" : ""}. Execution requires a running API polling worker.`),
    el("ul", {}, ...s.schedules.map((x) => {
      const b = el("button", { type: "button", class: "btn", text: x.enabled ? "Disable" : "Enable", "data-schedule": x.id });
      b.addEventListener("click", () => setScheduleEnabled(x.id, !x.enabled));
      return el("li", {}, el("strong", { text: x.name }), ` — ${x.kind}; ${x.cron} UTC; next ${fmtAbs(x.next_run_at)}; ${x.enabled ? "enabled" : "disabled"}. `, b);
    }))
  ] : [el("p", { class: "muted", text: "No durable schedules yet." })]));
  if (focusedSchedule) {
    const again = document.querySelector(`#schedules-data [data-schedule="${CSS.escape(focusedSchedule)}"]`);
    if (again) again.focus();
  }
}

async function refreshOperations() {
  if (!app.token) return;
  const gen = app.authGen;
  const paths = ["/workers?limit=100", "/operations/metrics", "/schedules?limit=100", ...(app.route.page === 'leases' ? ['/jobs?state=leased&limit=100'] : [])];
  const answers = await Promise.all(paths.map((p) => api(p)));
  if (gen !== app.authGen) return;
  if (answers.some((r) => r.status === 401)) { handleUnauthorized(); return; }
  const bad = answers.find((r) => r.status !== 200);
  if (bad) app.ops.error = `Operations request failed (HTTP ${bad.status}).`;
  else { app.ops.error = ""; [app.ops.workers, app.ops.metrics, app.ops.schedules, app.ops.leases] = answers.map((r) => r.body); app.workersFetchedAt = Date.now(); }
  if (app.route.name === "operations") renderOperations();
}

async function refreshWorkerObservations() {
  if (!app.token || Date.now() - app.workersFetchedAt < 5000) return;
  const gen = app.authGen;
  const r = await api("/workers?limit=100");
  if (gen !== app.authGen) return;
  if (r.status === 401) { handleUnauthorized(); return; }
  if (r.status !== 200) { app.ops.error = `Worker observations failed (HTTP ${r.status}).`; return; }
  app.ops.workers = r.body;
  app.workersFetchedAt = Date.now();
  const kinds = [...new Set(r.body.workers.flatMap((w) => w.kinds || []))];
  const note = $("kind-observed");
  if (note) note.textContent = `Observed worker kinds: ${kinds.join(", ") || "none reported"}. A kind without an observed handler may remain queued.`;
}

async function createSchedule(e) {
  e.preventDefault();
  const error = $("schedule-error"); error.textContent = "";
  if (app.scheduleInFlight) return;
  if (app.scheduleConfirmed) {
    app.scheduleKey = `ui-schedule-${crypto.randomUUID()}`;
    app.scheduleConfirmed = false;
    $("schedule-key").value = app.scheduleKey;
    $("schedule-submit").textContent = "Create schedule";
    error.textContent = "A fresh idempotency key is ready. Review the schedule details and submit again.";
    return;
  }
  let payload; try { payload = JSON.parse($("schedule-payload").value); } catch { error.textContent = "Payload must be valid JSON."; return; }
  const cron = $("schedule-cron").value.trim();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) { error.textContent = "Payload must be a JSON object."; return; }
  if (!/^\s*[\d*,\/-]+(?:\s+[\d*,\/-]+){4}\s*$/.test(cron)) { error.textContent = "Enter five numeric UTC cron fields."; $("schedule-cron").focus(); return; }
  const body = { name: $("schedule-name").value, kind: $("schedule-kind").value, payload, cron, priority: Number($("schedule-priority").value), max_attempts: Number($("schedule-attempts").value) };
  if (new TextEncoder().encode(JSON.stringify(body)).length > 65536) { error.textContent = "The schedule request exceeds 65,536 bytes."; return; }
  const gen = app.authGen;
  app.scheduleInFlight = true;
  $("schedule-submit").disabled = true;
  try {
    const r = await api("/schedules", { method: "POST", headers: { "Idempotency-Key": $("schedule-key").value.trim() }, body });
    if (gen !== app.authGen) return;
    if (r.status === 401) { handleUnauthorized(); return; }
    if (r.status !== 200 && r.status !== 201) { error.textContent = `Schedule rejected (HTTP ${r.status}). ${detailText(r.body)}`; return; }
    app.scheduleConfirmed = true;
    $("schedule-submit").textContent = "Start new schedule";
    error.textContent = r.status === 201
      ? `Schedule created: ${r.body.name} (ID ${r.body.id}).`
      : `Existing schedule returned: ${r.body.name} (ID ${r.body.id}).`;
    app.ops.schedules = null; await refreshOperations();
  } catch { if (gen === app.authGen) error.textContent = "Could not reach the API; retry with the same idempotency key."; }
  finally {
    if (gen === app.authGen) {
      app.scheduleInFlight = false;
      const button = $("schedule-submit");
      if (button) button.disabled = false;
    }
  }
}

async function setScheduleEnabled(id, enabled) {
  const gen = app.authGen;
  try {
    const r = await api(`/schedules/${id}`, { method: "PATCH", body: { enabled } });
    if (gen !== app.authGen) return;
    if (r.status === 401) { handleUnauthorized(); return; }
    if (r.status !== 200) { showBanner(`Schedule update failed (HTTP ${r.status}).`, false); return; }
    await refreshOperations();
  } catch { if (gen === app.authGen) showBanner("Could not reach the API while updating the schedule.", false); }
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
    app.details.set(id, { job: jr.body, events: er.body.events, more: er.body.next_after_id !== null, observed: new Date().toISOString() });
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
    if (app.route.name === "connection" && !app.token && $("token-form")) {
      // Anonymous probes must not replace a token the user is entering.
      $("conn-detail").textContent = "Reading without a token (the server runs with LEASEQ_PUBLIC_READ=1). Submit, requeue and cancel still need the token.";
    } else if (wasBlocked || app.route.name === "connection") renderView(false);
  }
}

async function refresh() {
  if (app.route.name === 'overview') { if (app.localDemo) await readLocalDemo(); renderOverviewStatus(); return; }
  if (app.route.name === 'reports') { await refreshReports(); return; }
  if (app.localDemo && demoWorkspace()) {
    await readLocalDemo(); renderLocalPostgresDemo(); return;
  }
  // An unauthenticated canonical editor must not discard its draft on repeated 401 probes.
  if (app.route.canonical === 'workbench' && !app.token && app.conn !== 'public') { setConn('needs-token'); return; }
  if (app.authPending || app.mode === "simulator" || app.apiAvailability === "unknown" || !app.apiOrigin) return;
  if (["landing","signup","login"].includes(app.route.name) || app.demo) return;
  if (app.inflight) return;
  app.inflight = true;
  const gen = app.authGen;
  const key = app.routeKey;
  try {
    const r = app.route;
    if (r.name === "jobs") await refreshJobs();
    else if (r.name === "job") await refreshJob(r.id);
    else if (r.name === "operations") await refreshOperations();
    else if (r.name === 'system') await refreshSystem();
    else if (r.canonical === 'settings') { await refreshSystem(); if (app.token || app.conn === 'public') await probe(); }
    else if (r.name === "submit") { await refreshWorkerObservations(); await probe(); }
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
  if (["landing","signup","login"].includes(app.route.name) || app.demo || app.mode === "simulator" || !app.apiOrigin) return;
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
  if ($("pause")) {
    $("pause").textContent = app.paused ? "Resume updates" : "Pause updates";
  }
  if ($("detail-pause")) {
    $("detail-pause").textContent = app.paused ? "Resume updates" : "Pause updates";
  }
  announce(app.paused ? "Automatic updates paused." : "Automatic updates resumed.");
  if (!app.paused) refresh();
}

/* ---------- theme and menu ---------- */

function renderThemeButtons() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  for (const b of document.querySelectorAll("[data-theme-toggle]")) {
    b.textContent = dark ? "Use light theme" : "Use dark theme";
    b.setAttribute("aria-pressed", dark ? "true" : "false");
  }
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") !== "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try {
    if (dark) window.localStorage.setItem("leaseq:theme:v1", "dark");
    else window.localStorage.removeItem("leaseq:theme:v1");
  } catch (e) { /* storage unavailable: the choice lasts for this page only */ }
  if (app.profile) { try { const saved=LeaseQProfiles.load(app.profile.id); LeaseQProfiles.save(app.profile.id,{...saved,theme:dark?"dark":"light"}); } catch(e) { showBanner("Theme changed, but this browser could not save the local profile preference.",false); } }
  renderThemeButtons();
  announce(dark ? "Dark theme on." : "Light theme on.");
}

function initMenu() {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const disclosure = event.target.closest?.("details[open]");
    if (!disclosure) return;
    event.preventDefault(); event.stopPropagation();
    disclosure.open = false; disclosure.querySelector("summary")?.focus();
  });

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
  sheet.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll('a[href], button:not([disabled]), summary')].filter(node => node.getClientRects().length && !node.closest('details:not([open]) > :not(summary)'));
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  for (const a of sheet.querySelectorAll("a")) a.addEventListener("click", () => {
    sheet.close("navigate");
  });
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });   // backdrop
  button.setAttribute("aria-expanded", "false");
  window.matchMedia("(min-width: 1000px)").addEventListener("change", (m) => { if (m.matches && sheet.open) sheet.close(); });
}

/* ---------- start ---------- */

async function loadVersion() {
  if (!app.apiOrigin) {
    app.apiAvailability = "unavailable"; if (!app.modeUserChoice) app.mode = "simulator";
    stopPolling();
    setConn("offline"); syncModeChrome();
    if (app.route.name !== "landing" && app.route.name !== "signup" && app.route.name !== "login") renderView(false);
    return;
  }
  try {
    const response = await api("/healthz", { timeoutMs: 2500 });
    if (response.status === 200 && response.body?.ok) {
      if (response.body.local_demo_available && ['127.0.0.1','localhost','[::1]'].includes(location.hostname)) { await readLocalDemo(); if (app.localDemo && app.route.direct) renderView(false); }
      app.apiAvailability = "available";
      if (response.body.version) { app.version = String(response.body.version); $("version").textContent = `leaseq ${app.version}`; if ($("conn-version")) $("conn-version").textContent = app.version; }
      syncModeChrome();
      if (app.mode === "live" && !["landing","signup","login"].includes(app.route.name)) pollNow();
      return;
    }
    if (response.status === 401) {
      app.apiAvailability = "auth"; if (!app.modeUserChoice) app.mode = "live"; setConn("needs-token");
      showBanner("The Live API answered but requires authorization. Browser Simulator is available from the mode control; no simulated result will replace this response.", true);
      syncModeChrome(); if (app.route.name !== "connection") renderView(false); return;
    }
    app.apiAvailability = response.status === 403 ? "configuration-error" : "unavailable";
    if (!app.modeUserChoice) app.mode = "simulator"; setConn("offline");
    stopPolling();
    showBanner(response.status === 403 ? "The API denied this origin. Check server authorization and CORS settings; no local result replaces a Live API response." : `The configured API returned HTTP ${response.status}. Browser Simulator is available, but it does not represent a live queue.`, true);
    syncModeChrome(); if (!app.modeUserChoice && app.route.name !== "landing") renderView(false);
  } catch {
    app.apiAvailability = "unavailable"; if (!app.modeUserChoice) app.mode = "simulator";
    stopPolling();
    setConn("offline"); showBanner("No Live API answered the bounded health check. Browser Simulator uses only this tab and does not connect to PostgreSQL.", true);
    syncModeChrome(); if (!app.modeUserChoice && !["landing","signup","login"].includes(app.route.name)) renderView(false);
  }
}

function init() {
  migrateOldLink();
  initMenu();
  renderThemeButtons();
  document.querySelector(".skip").addEventListener("click", (event) => {
    event.preventDefault();
    $("main").focus({ preventScroll: false });
  });
  for (const b of document.querySelectorAll("[data-theme-toggle]")) b.addEventListener("click", toggleTheme);
  $("mode-toggle").addEventListener("click",()=>changeMode(app.mode==="simulator"?"live":"simulator"));
  $("forget-token").addEventListener("click", forgetToken);
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.('a[href]');
    if (link && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !link.target && !link.hasAttribute('download')) {
      const target = new URL(link.href, location.href);
      if (target.origin === location.origin && !target.hash && Object.hasOwn(PRODUCT_PATHS, target.pathname)) {
        event.preventDefault(); history.pushState(null, '', target.pathname + target.search); onLocationChange(); return;
      }
    }
    if (event.target && event.target.id === "refresh-jobs") pollNow();
  });
  try { sessionStorage.removeItem("leaseq-api-token"); } catch (e) { /* storage may be blocked */ }
  app.token = null;
  setConn(app.token ? "token" : "unknown");
  window.addEventListener("storage", (e)=>{if(e.key!=="leaseq:profile-active")return;const current=app.profile?.id||null;if(e.newValue===current)return;app.profileAuthGeneration+=1;if(app.profile){clearSyncSession();cancelProfileSave();app.profile=null;app.demo=false;app.token=null;clearSensitive();stopPolling();window.location.hash="#/";}});
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

/* Read-only service observations; separate from queue outcomes and the simulator. */
function viewSystem() {
  const refresh = el('button', { type: 'button', class: 'btn', text: 'Refresh health' });
  refresh.addEventListener('click', refreshSystem);
  return [h1('Health and Metrics'),
    el('section', { class: 'panel', 'aria-labelledby': 'health-title' },
      el('div', { class: 'panel-head' }, el('h2', { id: 'health-title', text: 'Service checks' }), refresh),
      el('div', { class: 'panel-body', id: 'system-health' }, el('p', { role: 'status', text: 'Checking this API…' }))),
    app.token ? null : el('p', { class: 'hint' }, 'Operational counters and metrics need an API token. ', el('a', { href: '#/connection', text: 'Enter the API token' }))];
}
function renderSystem() {
  const target = $('system-health');
  if (!target) return;
  if (app.mode !== 'live' || !app.apiOrigin) { target.replaceChildren(el('p', { text: 'Live API health is unavailable in Browser Simulator. Connect to a Live API in Settings.' })); return; }
  if (!app.system) { target.replaceChildren(el('p', { role: 'status', text: 'Checking this API…' })); return; }
  const rows = app.system;
  const system = rows.find((row) => row.path === '/api/system' && row.status === 200)?.body;
  const metrics = rows.find((row) => row.path === '/metrics' && row.status === 200)?.body;
  target.replaceChildren(
    el('dl', { class: 'service-checks' }, ...rows.filter((row) => row.path !== '/metrics').map((row) => el('div', {}, el('dt', {}, el('code', { text: row.path })), el('dd', { text: row.error || `HTTP ${row.status} · ${row.body?.status || (row.body?.ok ? 'Available' : row.status === 200 ? 'Response received' : 'Unavailable')}` })))),
    ...(system ? [el('dl', { class: 'system-stats' }, ...[['Uptime', Number.isFinite(system.uptime_seconds) ? `${system.uptime_seconds.toFixed(1)} seconds` : 'Unavailable'], ['HTTP requests', system.http?.requests_total ?? 'Unavailable'], ['HTTP errors', system.http?.errors_total ?? 'Unavailable']].map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: String(value) })))), el('p', { class: 'hint', text: system.scope || 'HTTP API process only; worker outcomes are measured separately.' })] : []),
    ...(metrics ? [el('details', {}, el('summary', { text: 'Prometheus metric samples' }), el('pre', { class: 'metrics-samples', tabindex: '0', role: 'region', 'aria-label': 'Prometheus metric samples', text: metrics }))] : app.token ? [el('p', { text: 'Metrics unavailable. Check the serving process and refresh health.' })] : []));
}
async function refreshSystem() {
  if (app.route.name !== 'system' && app.route.canonical !== 'settings') return;
  if (app.mode !== 'live' || !app.apiOrigin) { renderSystem(); return; }
  if (app.systemInFlight) return;
  app.systemInFlight = true;
  const gen = app.authGen;
  try {
    const paths = ['/livez', '/readyz', ...(app.token ? ['/api/system', '/metrics'] : [])];
    const rows = await Promise.all(paths.map(async (path) => {
      try { return { path, ...await api(path, { timeoutMs: 5000, text: path === '/metrics' }) }; }
      catch (error) { return { path, error: 'Request failed or exceeded five seconds. Refresh health to retry.' }; }
    }));
    if (gen !== app.authGen) return;
    if (rows.some((row) => row.status === 401)) { handleUnauthorized(); return; }
    app.system = rows;
    renderSystem();
  } finally { app.systemInFlight = false; }
}


/* The optional local PostgreSQL demo has its own database and process-owned worker. */
async function readLocalDemo(action) {
  try {
    const response = await fetch('/local-demo', {method: action ? 'POST' : 'GET',
      headers: action ? {'Content-Type':'application/json'} : {},
      body: action ? JSON.stringify({action}) : undefined, signal: AbortSignal.timeout(8000)});
    if (!response.ok) { const body = await response.json(); throw new Error(body.detail || `Demo HTTP ${response.status}`); }
    const data = await response.json();
    if (data.available) { app.localDemo = data; app.localDemoError = data.error || ''; }
  } catch (error) { if (app.localDemo) app.localDemoError = error.message; }
  syncModeChrome();
}
function viewLocalPostgresDemo() {
  const button = (label, action) => {
    const node = el('button', {type:'button', class:'btn', text:label});
    node.onclick = async () => {
      if (app.localDemoBusy) return;
      if (action === 'reset' && !window.confirm('Delete only the isolated local demo jobs and their history, stop its demo worker, and restore four samples? Your live queue is untouched.')) return;
      app.localDemoBusy = true;
      document.querySelectorAll('[data-demo-action]').forEach(n => n.disabled = true);
      try { await readLocalDemo(action); renderLocalPostgresDemo(); }
      finally { app.localDemoBusy = false; document.querySelectorAll('[data-demo-action]').forEach(n => n.disabled = false); }
    };
    node.dataset.demoAction = action; return node;
  };
  return [el('h1', {tabindex:'-1', text:screenTitle()}), el('section', {class:'panel', 'aria-labelledby':'local-demo-title'},
    el('div', {class:'panel-head'}, el('h2', {id:'local-demo-title', text:'Isolated local PostgreSQL demo'})),
    el('div', {class:'panel-body'},
      el('p', {text:'Starts with four sample jobs in a separate database. Your live queue is untouched.'}),
      el('details', {open:true}, el('summary', {text:'Demo workflow'}), el('ol', {}, el('li', {text:'Run the demo to lease a sample job.'}), el('li', {text:'Complete it normally, or crash its worker and wait for recovery.'}), el('li', {text:'Inspect ownership history; enqueue another sample to repeat.'}))),
      el('div', {class:'actions'}, button('Run Interactive Demo','start'), button('Enqueue Sample Job','enqueue'), button('Simulate Worker Crash','crash'), button('Complete Active Lease','complete'), button('Replay Dead-Letter Job','replay'), button('Reset demo','reset')),
      el('p', {id:'local-demo-status', role:'status', 'aria-live':'polite'}),
      el('div', {id:'local-demo-jobs'}),
      el('p', {class:'hint', text:'Up to 12 sample jobs. Enqueue another sample to repeat; Reset demo deletes only these sample jobs and their history.'}),
      el('details', {}, el('summary', {text:'Jobs, workers and recovery'}), el('p', {text:'A job is one task. A worker owns it for a short lease, renewed by heartbeats. A crash kills only this demo worker. PostgreSQL must let the real lease expire before a recovery worker claims it. The old token is then tested and rejected. Failed jobs can be replayed once.'})),
      el('a', {href:'#/connection', text:'Connect to your Live API'})))];
}
function renderLocalPostgresDemo() {
  const target = $('local-demo-jobs'); if (!target || !app.localDemo) return;
  const demo = app.localDemo;
  const status = app.localDemoError || (demo.stale_rejected ? 'Recovered: lease recovery verified; stale completion rejected.' : demo.worker_alive ? 'Demo worker is running and renewing its lease.' : 'Run the demo to acquire a lease. A crashed worker must wait for actual lease expiry.');
  if ($('local-demo-status').textContent !== status) $('local-demo-status').textContent = status;
  let jobs = demo.jobs;
  if (app.route.page === 'dead-letter') jobs = jobs.filter(j => j.state === 'dead');
  const openHistory = new Set([...target.querySelectorAll('article')].filter(n => n.querySelector('details')?.open).map(n => n.id));
  reconcileChildren(target, [...jobs.map(job => {
    const seconds = Math.max(0, Math.ceil((new Date(job.lease_expires_at) - new Date(demo.as_of)) / 1000));
    return el('article', {class:'panel', id:`demo-job-${job.id}`}, el('h3', {text:`Job ${job.id}: ${job.kind.replace('localdemo.','')}`}),
      el('p', {text:`${({queued:'Queued', leased:'Running', dead:'Failed', done:'Completed'})[job.state]} · Worker: ${job.leased_by || 'Unassigned'} · Attempt ${job.attempts} of ${job.max_attempts}`}),
      job.state === 'leased' ? el('p', {text:`Lease remaining at database observation: ${seconds} seconds`}) : null,
      job.state === 'leased' ? el('progress', {value:Math.min(6, seconds), max:6, 'aria-label':'Remaining lease time'}) : null,
      el('details', {open:openHistory.has(`demo-job-${job.id}`)}, el('summary', {text:'Ownership and retry history'}),
        el('p', {text:`Lease epoch (attempt): ${job.attempts}. Opaque fencing tokens remain server-side.`}),
        demo.token_fingerprints && job.id === demo.token_fingerprints.job_id ? el('dl', {class:'fields'}, el('dt', {text:'Previous token SHA-256'}), el('dd', {text:demo.token_fingerprints.previous}), el('dt', {text:'Replacement token SHA-256'}), el('dd', {text:demo.token_fingerprints.current})) : null,
        el('ol', {}, ...job.events.map(event => el('li', {text:`${event.event}: ${event.worker_id || 'queue'}${event.detail?.error ? ' — ' + event.detail.error : ''}`})))));
  }), !jobs.length ? el('p', {text:'No failed sample jobs. Replayed jobs are queued on the overview.'}) : null].filter(Boolean));
}
