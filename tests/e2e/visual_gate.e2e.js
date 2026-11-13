// Root visual gate for the light rebuild (rebuild.md "Root visual gate").
// Run through tests/test_dashboard_e2e.py::test_root_visual_gate, which starts a
// real API (reads need the token: no LEASEQ_PUBLIC_READ) plus one worker process,
// seeds jobs and passes:
//   BASE_URL, API_TOKEN, AXE_PATH, EXPECTED (JSON: {dead, done, marker})
// Every check is recorded by name and the run continues after a failure, so the
// last stdout line reports exactly which checks pass and which fail.
"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL;
const TOKEN = process.env.API_TOKEN;
const AXE = process.env.AXE_PATH;
const EXP = JSON.parse(process.env.EXPECTED);
const DASH = `${BASE}/dashboard/`;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; " +
  "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const EXPECTED_401 = /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/;
const results = [];
const axe = {};
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: String(e && e.message ? e.message : e).slice(0, 400) });
  }
}

const SCREENS = [
  { route: "#/jobs", h1: /^Jobs$/ },
  { route: `#/jobs/${EXP.dead}`, h1: new RegExp(`^Job ${EXP.dead}$`) },
  { route: "#/submit", h1: /^Submit test job$/ },
  { route: "#/connection", h1: /^Connection & API$/ },
];

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true,
                                         colorScheme: "dark", ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  // The one expected browser message: the 401 that tells a token-less page this
  // server needs the token (its real disconnected state). Anything else fails.
  page.on("console", (m) => {
    if (m.type() === "error" && !EXPECTED_401.test(m.text())) page.errors.push(m.text());
  });
  page.setDefaultTimeout(8000);
  return page;
}

// The theme button sits in the rail (desktop) or in the Menu sheet (narrower).
async function themeButton(page, name) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    return page.getByRole("dialog", { name: "Menu" }).getByRole("button", { name });
  }
  return page.getByRole("button", { name }).first();
}
async function waitH1(page, re) {
  await page.waitForFunction((src) => {
    const h = document.querySelector("main h1");
    return h && new RegExp(src).test(h.textContent.trim());
  }, re.source);
}

// Enter the token on the Connection screen (it is kept in memory only).
async function connect(page) {
  await page.goto(`${DASH}#/connection`);
  await waitH1(page, /^Connection & API$/);
  await page.getByLabel("API token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Use token" }).click();
  await page.getByRole("button", { name: "Forget token" }).first().waitFor();
}

// In-app navigation (hash change, same document, token kept in memory).
async function go(page, route, re) {
  await page.evaluate((r) => { window.location.hash = r; }, route);
  await waitH1(page, re);
}

async function axeViolations(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    });
    return r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5) }));
  });
}

(async () => {
  const browser = await chromium.launch();
  try {
    // ---- 1. no page overflow at 320 / 768 / 1440 on every primary screen ------------
    for (const width of [320, 768, 1440]) {
      const page = await newPage(browser, { viewport: { width, height: 900 } });
      try { await connect(page); } catch (e) { /* recorded by the checks below */ }
      for (const s of SCREENS) {
        await check(`overflow ${width}px ${s.route}`, async () => {
          await go(page, s.route, s.h1);
          await page.waitForTimeout(150);
          const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, iw: innerWidth }));
          assert.ok(sw <= iw, `page is ${sw}px wide at ${iw}px`);
        });
      }
      await check(`wide job table scrolls inside a labelled region at ${width}px`, async () => {
        await go(page, "#/jobs", /^Jobs$/);
        const region = page.getByRole("region", { name: /job table/i });
        assert.equal(await region.count(), 1);
        assert.ok(await region.locator("table").count() === 1);
      });
      await page.context().close();
    }

    // ---- 2. mobile Menu sheet: opens, Escape closes, focus returns -------------------
    await check("mobile Menu opens, Escape closes it and focus returns to Menu", async () => {
      const page = await newPage(browser, { viewport: { width: 375, height: 800 } });
      await page.goto(`${DASH}#/jobs`);
      await waitH1(page, /^Jobs$/);
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      await menu.click();
      const sheet = page.getByRole("dialog", { name: "Menu" });
      await sheet.waitFor({ state: "visible" });
      assert.ok(await sheet.getByRole("link", { name: "Submit test job" }).isVisible());
      assert.ok(await page.evaluate(() => document.activeElement.closest("dialog") !== null),
                "focus is not inside the open sheet");
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label") ||
                                             document.activeElement.textContent.trim()), "Menu");
      // A link in the sheet navigates and closes the sheet.
      await menu.click();
      await sheet.getByRole("link", { name: "Connection & API" }).click();
      await waitH1(page, /^Connection & API$/);
      await sheet.waitFor({ state: "hidden" });
      await page.context().close();
    });
    await check("desktop shows the 216px rail and no Menu button", async () => {
      const page = await newPage(browser, { viewport: { width: 1440, height: 900 } });
      await page.goto(`${DASH}#/jobs`);
      await waitH1(page, /^Jobs$/);
      const rail = page.getByRole("navigation", { name: "Main" }).first();
      assert.ok(await rail.isVisible());
      const w = await page.locator(".rail").evaluate((e) => e.getBoundingClientRect().width);
      assert.equal(Math.round(w), 216);
      assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).isVisible(), false);
      assert.equal(await rail.getByRole("link", { name: "Jobs" }).getAttribute("aria-current"), "page");
      await page.context().close();
    });

    // ---- 3. route focus lands on the H1, title follows --------------------------------
    await check("route change moves focus to the H1 and sets the title", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, "#/jobs", /^Jobs$/);
      await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Submit test job" }).click();
      await waitH1(page, /^Submit test job$/);
      const f = await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent.trim() }));
      assert.deepEqual(f, { tag: "H1", text: "Submit test job" });
      assert.equal(await page.title(), "Submit test job – LeaseQ");
      await go(page, "#/jobs", /^Jobs$/);
      await page.getByRole("link", { name: `Job ${EXP.dead}`, exact: true }).click();
      await waitH1(page, new RegExp(`^Job ${EXP.dead}$`));
      assert.equal(await page.evaluate(() => document.activeElement.tagName), "H1");
      assert.equal(await page.title(), `Job ${EXP.dead} – LeaseQ`);
      assert.deepEqual(page.errors, []);
      await page.context().close();
    });

    // ---- 4. Back/Forward and deep links restore screen and state ----------------------
    await check("Back/Forward restore Jobs filters and the selected job", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, "#/jobs?state=dead", /^Jobs$/);
      await page.getByLabel("Kind").fill("fail");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await page.waitForURL(/kind=fail/);
      await page.getByRole("link", { name: `Job ${EXP.dead}`, exact: true }).click();
      await waitH1(page, new RegExp(`^Job ${EXP.dead}$`));
      await page.goBack();
      await waitH1(page, /^Jobs$/);
      assert.equal(await page.getByLabel("Kind").inputValue(), "fail");
      assert.equal(await page.getByRole("button", { name: /^Dead\b/ }).getAttribute("aria-pressed"), "true");
      await page.goForward();
      await waitH1(page, new RegExp(`^Job ${EXP.dead}$`));
      await page.context().close();
    });
    await check("Submit text survives navigating away and browser Back", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, "#/submit", /^Submit test job$/);
      await page.getByLabel("Text to count").fill("draft kept across routes");
      await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Jobs" }).click();
      await waitH1(page, /^Jobs$/);
      await page.goBack();
      await waitH1(page, /^Submit test job$/);
      assert.equal(await page.getByLabel("Text to count").inputValue(), "draft kept across routes");
      await page.context().close();
    });
    await check("deep links load directly; unknown route is a real Not found", async () => {
      const page = await newPage(browser);
      await page.goto(`${DASH}#/jobs/${EXP.dead}`);
      await waitH1(page, new RegExp(`^Job ${EXP.dead}$`));
      // Fresh page: no token in memory, so the screen says so and points to Connection.
      assert.ok(await page.getByRole("link", { name: /Connection/ }).first().isVisible());
      await page.goto(`${DASH}#/nope`);
      await waitH1(page, /^Not found$/);
      assert.ok(await page.locator("main").getByRole("link", { name: /Jobs/ }).first().isVisible());
      await page.context().close();
    });
    await check("old shared links (?job=, ?state=) map to the new routes", async () => {
      const page = await newPage(browser);
      await page.goto(`${DASH}?job=${EXP.dead}`);
      await waitH1(page, new RegExp(`^Job ${EXP.dead}$`));
      assert.match(page.url(), new RegExp(`#/jobs/${EXP.dead}$`));
      await page.goto(`${DASH}?state=dead&kind=fail`);
      await waitH1(page, /^Jobs$/);
      assert.match(page.url(), /#\/jobs\?state=dead&kind=fail$/);
      await page.context().close();
    });

    // ---- 5. axe: every primary screen, light and dark, 1280 and 320 --------------------
    for (const [width, theme] of [[1280, "light"], [320, "light"], [1280, "dark"], [320, "dark"]]) {
      const page = await newPage(browser, { viewport: { width, height: 900 } });
      await check(`axe 0 violations, ${theme} ${width}px`, async () => {
        if (theme === "dark") {
          await page.goto(`${DASH}#/jobs`);
          await waitH1(page, /^Jobs$/);
          // Disconnected state, before the token is entered.
          await (await themeButton(page, "Use dark theme")).click();
        }
        await page.goto(`${DASH}#/jobs`);
        await waitH1(page, /^Jobs$/);
        await page.getByText("Not connected").first().waitFor();
        axe[`${theme}-${width}-jobs-disconnected`] = await axeViolations(page);
        await connect(page);
        for (const s of SCREENS) {
          await go(page, s.route, s.h1);
          await page.waitForTimeout(400);
          axe[`${theme}-${width}-${s.route}`] = await axeViolations(page);
        }
        const n = Object.entries(axe).filter(([k]) => k.startsWith(`${theme}-${width}-`))
          .reduce((t, [, v]) => t + v.length, 0);
        assert.equal(n, 0, JSON.stringify(Object.fromEntries(Object.entries(axe).filter(([k, v]) => k.startsWith(`${theme}-${width}-`) && v.length))));
        assert.deepEqual(page.errors, []);
      });
      await page.context().close();
    }

    // ---- 6. light by default, even when the OS prefers dark ---------------------------
    await check("default is light under colorScheme dark; dark only after the toggle", async () => {
      const page = await newPage(browser, { colorScheme: "dark" });
      await page.goto(`${DASH}#/jobs`);
      await waitH1(page, /^Jobs$/);
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(await bg(), "rgb(247, 248, 250)");
      await page.getByRole("button", { name: "Use dark theme" }).first().click();
      assert.notEqual(await bg(), "rgb(247, 248, 250)");
      await page.reload();
      await waitH1(page, /^Jobs$/);
      assert.notEqual(await bg(), "rgb(247, 248, 250)", "dark choice not remembered");
      await page.getByRole("button", { name: "Use light theme" }).first().click();
      assert.equal(await bg(), "rgb(247, 248, 250)");
      await page.context().close();
    });

    // ---- 7. console, CSP, noscript ------------------------------------------------------
    await check("CSP unchanged and enforced: no violations, no console errors", async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective));
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error" && !EXPECTED_401.test(m.text())) errors.push(m.text()); });
      const res = await page.goto(`${DASH}#/connection`);
      assert.equal(res.headers()["content-security-policy"], CSP);
      await waitH1(page, /^Connection & API$/);
      await page.getByLabel("API token", { exact: true }).fill(TOKEN);
      await page.getByRole("button", { name: "Use token" }).click();
      await page.getByRole("button", { name: "Forget token" }).first().waitFor();
      for (const s of SCREENS) await go(page, s.route, s.h1);
      await page.waitForTimeout(500);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
      await ctx.close();
    });
    await check("JavaScript off: noscript message is shown", async () => {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(DASH);
      assert.equal(await page.locator(".noscript").isVisible(), true);
      assert.match(await page.locator(".noscript").innerText(), /needs JavaScript/);
      await ctx.close();
    });

    // ---- 8. Forget / 401 clear every sensitive view, including cached details ---------
    const markerInDom = (page) => page.evaluate((m) => document.documentElement.innerHTML.includes(m), EXP.marker);
    await check("after Forget token, Back to a job route cannot reveal the cached payload", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, `#/jobs/${EXP.dead}`, new RegExp(`^Job ${EXP.dead}$`));
      await page.locator("#payload").filter({ hasText: EXP.marker }).waitFor();
      await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Jobs" }).click();
      await waitH1(page, /^Jobs$/);
      await page.getByRole("button", { name: "Forget token" }).first().click();
      await page.goBack();
      await waitH1(page, new RegExp(`^Job ${EXP.dead}$`));
      await page.waitForTimeout(2500);                    // a poll, too
      assert.equal(await markerInDom(page), false, "stale payload shown after Forget");
      assert.ok(await page.getByText("Not connected").first().isVisible());
      await page.context().close();
    });
    await check("after a 401, a route change cannot reveal the cached payload", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, `#/jobs/${EXP.dead}`, new RegExp(`^Job ${EXP.dead}$`));
      await page.locator("#payload").filter({ hasText: EXP.marker }).waitFor();
      await go(page, "#/jobs", /^Jobs$/);
      await page.route("**/jobs?*", (r) => r.fulfill({ status: 401, contentType: "application/json",
        body: '{"detail":"missing or invalid bearer token"}' }));
      await page.getByRole("alert").filter({ hasText: /token/i }).waitFor();
      await page.unroute("**/jobs?*");
      await go(page, `#/jobs/${EXP.dead}`, new RegExp(`^Job ${EXP.dead}$`));
      await page.waitForTimeout(2500);
      assert.equal(await markerInDom(page), false, "stale payload shown after 401");
      assert.equal(await page.evaluate(() => ({ l: JSON.stringify(localStorage), s: sessionStorage.length }))
        .then((x) => x.l.includes("e2e") || x.s > 0), false, "token found in browser storage");
      await page.context().close();
    });

    // ---- 8b. operations console: state lanes, lifecycle timeline, protected actions --
    await check("state lanes show the API's real counts and filter the table", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, "#/jobs", /^Jobs$/);
      const api = await (await page.request.get(`${BASE}/jobs?limit=1`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      await page.waitForFunction(() => /^[0-9]+$/.test((document.querySelector('[data-count="dead"]') || {}).textContent || ""));
      const lanes = await page.$$eval("[data-count]", (els) => Object.fromEntries(els.map((e) => [e.dataset.count, Number(e.textContent)])));
      for (const k of ["queued", "leased", "retrying", "done", "dead"]) assert.equal(lanes[k], api.counts[k], k);
      assert.equal(lanes.all, api.counts.total);
      const dead = page.getByRole("button", { name: /^Dead\b/ });
      await dead.click();
      assert.equal(await dead.getAttribute("aria-pressed"), "true");
      await page.waitForURL(/state=dead/);
      await page.waitForFunction((n) => document.querySelectorAll("#rows [data-job]").length === n, api.counts.dead);
      await page.context().close();
    });
    await check("job details shows the lease lifecycle timeline and names the job and effect before requeue", async () => {
      const page = await newPage(browser);
      const posts = [];
      page.on("request", (r) => { if (r.method() === "POST" && /requeue|cancel/.test(r.url())) posts.push(r.url()); });
      await connect(page);
      await go(page, `#/jobs/${EXP.dead}`, new RegExp(`^Job ${EXP.dead}$`));
      const tl = page.getByRole("list", { name: "Lifecycle" });
      await tl.getByText("Dead").first().waitFor();
      const steps = await tl.locator("[data-step]").evaluateAll((els) => els.map((e) => e.dataset.step));
      assert.deepEqual(steps, ["enqueued", "claimed", "dead"]);
      await page.getByRole("button", { name: "Requeue job" }).click();
      const dlg = page.getByRole("dialog", { name: `Requeue job ${EXP.dead}?` });
      await dlg.waitFor();
      assert.match(await dlg.innerText(), /3 more attempts/);
      await dlg.getByRole("button", { name: "Keep as dead" }).click();
      await page.waitForTimeout(300);
      assert.deepEqual(posts, []);
      await page.context().close();
    });

    // ---- 9. Submit test job: bounded word_count through the real handler ---------------
    await check("Submit test job runs word_count through a worker and shows the real result", async () => {
      const page = await newPage(browser);
      await connect(page);
      await go(page, "#/submit", /^Submit test job$/);
      await page.getByRole("button", { name: "Submit job" }).click();
      await page.getByText(/Enter some text/).waitFor();
      assert.equal(await page.getByLabel("Text to count").getAttribute("aria-invalid"), "true");
      assert.equal(await page.getByLabel("Text to count").getAttribute("maxlength"), "10000");
      // Public-domain sample: Pride and Prejudice, chapter 1 (Project Gutenberg #1342).
      await page.getByRole("button", { name: "Load sample text" }).click();
      await page.waitForFunction(() => document.getElementById("wc-text").value.startsWith("Chapter 1"));
      assert.match(await page.locator("#submit-form").innerText(), /Pride and Prejudice/);
      await page.getByRole("button", { name: "Submit job" }).click();
      const out = page.locator("#submit-result");
      await out.filter({ hasText: /849 words/ }).waitFor({ timeout: 30000 });
      assert.match(await out.innerText(), /114 lines/);
      const link = out.getByRole("link", { name: /Open job \d+/ });
      await link.click();
      await waitH1(page, /^Job \d+$/);
      await page.locator("#result").filter({ hasText: '"words": 849' }).waitFor();
      assert.deepEqual(page.errors, []);
      await page.context().close();
    });
  } catch (e) {
    results.push({ name: "harness", ok: false, error: String(e && e.stack ? e.stack : e).slice(0, 600) });
  } finally {
    await browser.close();
    const failed = results.filter((r) => !r.ok);
    const axeTotal = Object.values(axe).reduce((n, v) => n + v.length, 0);
    console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length,
                                 failed: failed.length, axe_scans: Object.keys(axe).length,
                                 axe_total: axeTotal, results }));
    if (failed.length) process.exitCode = 1;
  }
})();
