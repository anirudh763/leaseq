"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL;
if (!BASE || !process.env.API_TOKEN) throw new Error("Set BASE_URL and API_TOKEN");
const DUMMY = "update-security-dummy-never-valid";
const A = "https://leaseq-update-a.invalid";
const B = "https://leaseq-update-b.invalid";
const results = [];
function check(name, actual, expected) {
  results.push({ name, actual: structuredClone(actual), expected, ok: JSON.stringify(actual) === JSON.stringify(expected) });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function message(page, type) {
  return page.evaluate((type) => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error(`${type} timed out`)); }, 8000);
    channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    navigator.serviceWorker.controller.postMessage({ type }, [channel.port2]);
  }), type);
}
async function pause(page) {
  const button = page.getByRole("button", { name: "Pause updates", exact: true });
  if (await button.count()) await button.click();
  await page.waitForFunction(() => app.paused && !app.inflight);
}
async function snapshot(page) {
  return page.evaluate(async () => ({ state: LeaseQGetUpdateState(), safety: await LeaseQBeforeUpdate() }));
}
async function setOrigin(page, origin) {
  await page.locator("#api-origin-input").fill(origin);
  await page.getByRole("button", { name: "Use Live API origin", exact: true }).click();
  await page.waitForFunction((origin) => app.apiOrigin === origin, origin);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    // Only public shell/API reads reach FastAPI; dummy credentials and writes are intercepted.
    const authContext = await browser.newContext();
    const authRequests = [];
    const authorized = [];
    const authArrived = deferred();
    let heldAuth;
    await authContext.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const authorization = request.headers().authorization;
      if (authorization) authorized.push({ origin: url.origin, path: url.pathname });
      if (url.pathname === "/auth/check") {
        authRequests.push({ origin: url.origin, hasAuthorization: authorization === `Bearer ${DUMMY}` });
        if (!heldAuth) {
          heldAuth = route;
          authArrived.resolve();
          return;
        }
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"unexpected fixture authentication"}' });
      }
      if (authorization || url.origin === A || url.origin === B || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"intercepted security fixture"}' });
      }
      return route.continue();
    });
    const authPage = await authContext.newPage();
    authPage.setDefaultTimeout(8000);
    await authPage.goto(`${BASE}/dashboard/#/connection`, { waitUntil: "networkidle" });
    await setOrigin(authPage, A);
    await authPage.locator("#token-input").fill(DUMMY);
    await authPage.getByRole("button", { name: "Use token", exact: true }).click();
    await authArrived.promise;
    check("auth uses configured HTTPS origin with dummy bearer", authRequests, [{ origin: A, hasAuthorization: true }]);
    // Remove the edited token form so only the pending authentication can block an update.
    await authPage.evaluate(() => { location.hash = "#/jobs"; });
    await authPage.waitForFunction(() => app.route.name === "jobs" && !document.querySelector("#token-input"));
    const pendingAuth = await snapshot(authPage);
    check("authentication request is in flight", pendingAuth.state.inFlight, true);
    check("authentication alone blocks updates", pendingAuth.safety.safe, false);
    await authPage.evaluate(() => { location.hash = "#/connection"; });
    await authPage.locator("#api-origin-input").waitFor();
    await setOrigin(authPage, B);
    const authResponse = authPage.waitForResponse((response) => response.url() === authRequests[0].origin + "/auth/check" && response.status() === 200);
    await heldAuth.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    await (await authResponse).finished();
    await authPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    await authPage.waitForFunction(() => !app.authPending);
    await authPage.evaluate(() => pollNow());
    check("late success for origin A cannot accept a token for B", await authPage.evaluate(() => !!app.token), false);
    check("dummy authorization never targets the frontend or B", authorized.every((request) => request.origin === A), true);
    await authContext.close();

    const context = await browser.newContext();
    // A capture listener installed before platform.js can model a tab that stops answering.
    await context.addInitScript(() => {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (window.__ignoreUpdateCheck && event.data?.type === "LEASEQ_CHECK_UPDATE_SAFE") event.stopImmediatePropagation();
      }, { capture: true });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`${BASE}/dashboard/#/jobs`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await pause(page);
    assert.deepEqual(await message(page, "LEASEQ_CHECK_CACHE"), { ready: true, missing: [] });
    const canonical = await context.newPage();
    canonical.setDefaultTimeout(8000);
    await canonical.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    await canonical.waitForFunction(() => !!navigator.serviceWorker.controller);
    check("canonical Settings has a ready root registration", await canonical.evaluate(async () =>
      new URL((await navigator.serviceWorker.ready).scope).pathname), "/");
    assert.deepEqual(await message(canonical, "LEASEQ_CHECK_CACHE"), { ready: true, missing: [] });
    for (const [path, expected] of [["/healthz",200],["/readyz",200],["/jobs",401],
      ["/auth/missing",401],["/missing-leaseq-pwa-page",401],
      ["/dashboard/assets/missing-leaseq.js",404],["/dashboard/pages/missing-leaseq.html",404]]) {
      const responseEvent = canonical.waitForResponse(response => response.url() === `${BASE}${path}` && response.request().method() === "GET");
      await canonical.evaluate(path => fetch(path).then(response => response.text()), path);
      const response = await responseEvent;
      check(`network-only ${path}`, {status:response.status(), worker:response.fromServiceWorker()}, {status:expected,worker:false});
    }
    const probe = await context.newPage();
    const unknown = await probe.goto(`${BASE}/missing-leaseq-pwa-navigation`);
    check("unknown navigation keeps the server authorization denial", {status:unknown.status(),worker:unknown.fromServiceWorker()}, {status:401,worker:false});
    await canonical.close();
    const peer = await context.newPage();
    peer.setDefaultTimeout(8000);
    await peer.goto(`${BASE}/dashboard/#/jobs`, { waitUntil: "networkidle" });
    await peer.waitForFunction(() => !!navigator.serviceWorker.controller);
    await pause(peer);
    await peer.evaluate(() => { location.hash = "#/connection"; });
    await peer.locator("#token-input").fill(DUMMY);
    const dirty = await message(page, "LEASEQ_APPLY_UPDATE");
    check("actual worker rejects another tab's edited form", dirty.updated, false);
    check("worker preserves edited-form explanation", /edited form/.test(dirty.reason || ""), true);
    await peer.locator("#token-input").fill("");
    await peer.evaluate(() => { window.__ignoreUpdateCheck = true; });
    const silent = await message(page, "LEASEQ_APPLY_UPDATE");
    check("actual worker rejects a silent in-scope tab", silent.updated, false);
    check("silent-peer denial explains missing consent", /did not confirm/.test(silent.reason || ""), true);
    await peer.evaluate(() => { window.__ignoreUpdateCheck = false; });
    const consenting = await message(page, "LEASEQ_APPLY_UPDATE");
    check("actual worker accepts when every frontend tab consents and unknown navigation does not vote", consenting.updated, true);
    await probe.close();
    await peer.close();

    const mutationArrived = deferred();
    let heldMutation;
    const writes = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push({ method: request.method(), path: url.pathname });
        if (url.pathname === "/jobs/123/cancel") {
          heldMutation = route;
          mutationArrived.resolve();
          return;
        }
        return route.abort("failed");
      }
      if (request.headers().authorization) {
        return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"fixture job does not exist"}' });
      }
      return route.continue();
    });
    // Delay JSON consumption of a real intercepted response; never set the app's request counters.
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.__bodyStarted = false;
      window.__bodyGate = new Promise((resolve) => { window.__releaseBody = resolve; });
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (new URL(args[0], location.href).pathname === "/jobs/123/cancel") {
          const json = response.json.bind(response);
          response.json = async () => { window.__bodyStarted = true; await window.__bodyGate; return json(); };
        }
        return response;
      };
      app.token = "update-security-dummy-never-valid";
      confirmAction("cancel", { id: 123, kind: "word_count", attempts: 1 }, document.querySelector("#refresh-jobs"));
    });
    await page.locator("#confirm-yes").click();
    await mutationArrived.promise;
    const pendingMutation = await snapshot(page);
    check("paused actual cancel caller is in flight", pendingMutation.state.inFlight, true);
    check("paused cancel blocks page update safety", pendingMutation.safety.safe, false);
    check("actual worker blocks held cancel", (await message(page, "LEASEQ_APPLY_UPDATE")).updated, false);
    await heldMutation.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"fixture mutation refused before server"}' });
    await page.waitForFunction(() => window.__bodyStarted);
    const pendingBody = await snapshot(page);
    check("request remains in flight while response JSON is pending", pendingBody.state.inFlight, true);
    check("pending response body blocks updates", pendingBody.safety.safe, false);
    await page.evaluate(() => window.__releaseBody());
    await page.waitForFunction(() => !LeaseQGetUpdateState().inFlight);
    check("counter clears after response body completes", (await snapshot(page)).state.inFlight, false);

    const patchArrived = deferred();
    let heldPatch;
    await context.route("**/jobs/123", (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      writes.push({ method: "PATCH", path: "/jobs/123" });
      heldPatch = route;
      patchArrived.resolve();
    });
    await page.evaluate(() => {
      window.__patchDone = false;
      window.__patchFailed = false;
      api("/jobs/123", { method: "PATCH", body: { priority: 1 } }).catch(() => {
        window.__patchFailed = true;
      }).finally(() => { window.__patchDone = true; });
    });
    await patchArrived.promise;
    const pendingPatch = await snapshot(page);
    check("shared API guard covers PATCH requests", pendingPatch.state.inFlight, true);
    check("held PATCH blocks updates", pendingPatch.safety.safe, false);
    await heldPatch.abort("failed");
    await page.waitForFunction(() => window.__patchDone);
    check("rejected transport preserves API error", await page.evaluate(() => window.__patchFailed), true);
    check("rejected transport clears request counter", (await snapshot(page)).state.inFlight, false);
    check("only expected fixture writes were intercepted", writes, [{ method: "POST", path: "/jobs/123/cancel" }, { method: "PATCH", path: "/jobs/123" }]);
    check("updates become safe after all requests settle", (await snapshot(page)).safety.safe, true);
    await context.close();
    // Model a retained narrower registration without unregistering it or forcing activation.
    const migration = await browser.newContext();
    await migration.addInitScript(() => {
      if (location.pathname !== '/dashboard/') return;
      const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = (url, options) => register(url, {...options,scope:'/dashboard/'});
      navigator.serviceWorker.addEventListener('message', event => {
        if (window.__ignoreUpdateCheck && event.data?.type === 'LEASEQ_CHECK_UPDATE_SAFE') event.stopImmediatePropagation();
      }, {capture:true});
    });
    const legacy = await migration.newPage();
    await legacy.goto(`${BASE}/dashboard/#/jobs`, {waitUntil:'networkidle'});
    await legacy.waitForFunction(() => !!navigator.serviceWorker.controller);
    await pause(legacy);
    const rootTab = await migration.newPage();
    await rootTab.goto(`${BASE}/settings`, {waitUntil:'networkidle'});
    await rootTab.waitForFunction(() => !!navigator.serviceWorker.controller);
    check('legacy registration remains alongside root registration', await rootTab.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map(reg=>new URL(reg.scope).pathname).sort()), ['/', '/dashboard/']);
    await legacy.evaluate(() => {location.hash='#/connection';});
    await legacy.locator('#token-input').fill(DUMMY);
    check('root worker respects edited old-registration tab', (await message(rootTab,'LEASEQ_APPLY_UPDATE')).updated, false);
    await legacy.locator('#token-input').fill('');
    await legacy.evaluate(() => {window.__ignoreUpdateCheck=true;});
    check('root worker respects silent old-registration tab', (await message(rootTab,'LEASEQ_APPLY_UPDATE')).updated, false);
    await legacy.evaluate(() => {window.__ignoreUpdateCheck=false;});
    check('root worker admits consenting old-registration tab', (await message(rootTab,'LEASEQ_APPLY_UPDATE')).updated, true);
    await migration.setOffline(true);
    await rootTab.reload({waitUntil:'domcontentloaded'});
    await rootTab.getByRole('heading',{level:1,name:'Settings',exact:true}).waitFor();
    check('canonical Settings works offline with exact pins', (await message(rootTab,'LEASEQ_CHECK_CACHE')).ready, true);
    const cacheInspection = await rootTab.evaluate(async () => {
      const prefix='leaseq-shell-'+encodeURIComponent('/dashboard/')+':';
      const names=(await caches.keys()).filter(name=>name.startsWith(prefix));
      const paths=[];
      for (const name of names) {
        for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
      }
      return {names,paths};
    });
    const cachePaths=cacheInspection.paths;
    const packagedAssets=['/dashboard/','/dashboard/manifest.webmanifest','/dashboard/assets/app.js',
      '/dashboard/assets/platform.js','/dashboard/pages/privacy.html'];
    const hasPackagedAssets=packagedAssets.every(path=>cachePaths.includes(path));
    check('own scoped dashboard cache exists', cacheInspection.names.length>0, true);
    check('own scoped cache has all 30 distinct packaged paths', new Set(cachePaths).size, 30);
    check('own scoped cache contains expected packaged assets', hasPackagedAssets, true);
    assert.ok(cacheInspection.names.length>0, 'The scoped dashboard cache must exist before checking private entries.');
    assert.equal(new Set(cachePaths).size,30, 'The actual packaged cache must be inspected.');
    assert.ok(hasPackagedAssets, 'Known packaged assets must be present before checking private entries.');
    check('cache contains only packaged dashboard resources', cachePaths.every(path=>path.startsWith('/dashboard/')), true);
    check('private API cache entries absent', cachePaths.some(path=>/^\/(jobs|auth|healthz|readyz)(\/|$)/.test(path)), false);
    await migration.close();
    const report = { ok: results.every((result) => result.ok), results,
      transport: "dummy credentials and all mutation HTTP intercepted before server; response JSON consumption explicitly held; actual packaged service worker installed" };
    if (process.env.ARTIFACT_DIR) {
      fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.ARTIFACT_DIR, "update-security.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
    assert.equal(report.ok, true, JSON.stringify(results.filter((result) => !result.ok), null, 2));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
