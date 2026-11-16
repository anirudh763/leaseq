"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL;
const TOKEN = process.env.API_TOKEN;
const EXP = JSON.parse(process.env.EXPECTED);
const results = [];

async function go(page, route) {
  await page.evaluate((r) => { location.hash = r; }, route);
  await page.waitForFunction((r) => location.hash === r && document.querySelector("main h1"), route);
  await page.waitForTimeout(80);
}
async function connect(page) {
  await page.goto(`${BASE}/dashboard/#/connection`);
  await page.getByLabel("API token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Use token", exact: true }).click();
  await page.getByRole("button", { name: "Forget token", exact: true }).first().waitFor();
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  // Context routing reaches API requests owned by an active service worker too.
  async function check(name, fn, width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try { await fn(page); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error.message).slice(0, 1000) }); }
    finally { await context.close(); }
  }
  try {
    await check("an anonymous connection answer preserves a token being entered", async (page) => {
      let release, requested;
      const held = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { requested = resolve; });
      await page.context().route((url) => url.pathname === "/jobs" && url.searchParams.get("limit") === "1", async (route) => {
        requested();
        await held;
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"jobs":[],"counts":{}}' });
      });
      await page.goto(`${BASE}/dashboard/#/connection`);
      await started;
      const input = page.getByLabel("API token", { exact: true });
      await input.fill(TOKEN);
      await input.evaluate((node) => { window.__tokenInput = node; });
      release();
      await page.locator("#conn-status").filter({ hasText: "Reading without token" }).waitFor();
      assert.equal(await input.inputValue(), TOKEN, "anonymous probe replaced the entered token");
      assert.equal(await input.evaluate((node) => node === window.__tokenInput), true);
      assert.equal(await input.evaluate((node) => node === document.activeElement), true);
      await page.getByRole("button", { name: "Use token", exact: true }).click();
      await page.getByRole("button", { name: "Forget token", exact: true }).first().waitFor();
    });
    await check("over-limit input stays intact and is rejected without a POST", async (page) => {
      await connect(page);
      await go(page, "#/submit");
      const posts = [];
      page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
      const text = "x".repeat(10001);
      await page.getByLabel("Text to count").fill(text);
      assert.equal(await page.getByLabel("Text to count").inputValue(), text);
      assert.match(await page.locator("#wc-count").innerText(), /10,001 of 10,000/);
      await page.getByRole("button", { name: "Submit job", exact: true }).click();
      assert.match(await page.locator("#wc-error").innerText(), /10,001.*limit is 10,000/);
      assert.equal(await page.getByLabel("Text to count").getAttribute("aria-invalid"), "true");
      assert.deepEqual(posts, []);
      await go(page, "#/jobs");
      await page.goBack();
      await page.getByLabel("Text to count").waitFor();
      assert.equal(await page.getByLabel("Text to count").inputValue(), text);
    });
    for (const endpoint of ["events", "job"]) {
      await check(`${endpoint} HTTP failure names its endpoint and actual status`, async (page) => {
        await connect(page);
        const path = `/jobs/${EXP.dead}${endpoint === "events" ? "/events" : ""}`;
        await page.context().route((url) => url.pathname === path, (r) => r.fulfill({
          status: 503, contentType: "application/json", body: '{"detail":"temporarily unavailable"}',
        }));
        const failedResponse = page.waitForResponse(response => new URL(response.url()).pathname === path && response.status() === 503);
        await go(page, `#/jobs/${EXP.dead}`);
        await failedResponse;
        await page.locator("#banner").filter({ hasText: /HTTP 503/ }).waitFor();
        assert.ok((await page.locator("#banner").innerText()).includes(path));
      });
    }
    await check("list omits result previews while job details show the real result", async (page) => {
      await connect(page);
      await go(page, "#/jobs");
      const link = page.locator(`#rows a[data-job="${EXP.done}"]`);
      await link.waitFor();
      const row = link.locator("xpath=ancestor::tr");
      assert.equal(await row.locator("td.result").innerText(), "Not loaded");
      await go(page, `#/jobs/${EXP.done}`);
      await page.waitForFunction(() => document.querySelector("#result")?.textContent.includes('"words": 10'));
      const result = JSON.parse(await page.locator("#result").innerText());
      assert.deepEqual(result, { lines: 2, words: 10 });
    });
    await check("skip link keeps the current route and filters and focuses main", async (page) => {
      await connect(page);
      await go(page, "#/jobs?state=dead&kind=fail");
      const route = await page.evaluate(() => location.hash);
      const skip = page.getByRole("link", { name: "Skip to content" });
      await skip.focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => location.hash), route);
      assert.equal(await page.evaluate(() => document.activeElement.id), "main");
      assert.equal(await page.locator("main h1").innerText(), "Jobs");
      await go(page, `#/jobs/${EXP.dead}`);
      await skip.focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.evaluate(() => location.hash), `#/jobs/${EXP.dead}`);
      assert.equal(await page.evaluate(() => document.activeElement.id), "main");
      for (const route of ["#/submit", "#/operations", "#/connection"]) {
        await go(page, route);
        await skip.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => location.hash), route);
        assert.equal(await page.evaluate(() => document.activeElement.id), "main");
      }
    });
    await check("detail polling preserves named regions and reading nodes across three cycles", async (page) => {
      await connect(page);
      let pollCount = 0;
      let pollsReady;
      const threeCycles = new Promise((resolve) => { pollsReady = resolve; });
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === `/jobs/${EXP.done}` && ++pollCount >= 4) pollsReady();
      });
      await go(page, `#/jobs/${EXP.done}`);
      await page.locator("#result").waitFor();
      const names = await page.locator(".code-region").evaluateAll((regions) => regions.map((region) =>
        [region.getAttribute("aria-labelledby"), region.getAttribute("role"), region.textContent.trim()]));
      assert.deepEqual(names.map((x) => x[0]), ["payload-title", "result-title"]);
      assert.ok(names.every((x) => x[1] === "region" && x[2].length));
      await page.evaluate(() => { window.__detailNodes = ["#detail-state", "#why", "#life-title", "#timeline", "#detail-fields", "#payload", "#result"]
        .map((selector) => document.querySelector(selector)); });
      await threeCycles;
      assert.ok(pollCount >= 4, `observed ${pollCount} detail polls`);
      assert.equal(await page.evaluate(() => window.__detailNodes.every((node, i) => node === document.querySelector(
        ["#detail-state", "#why", "#life-title", "#timeline", "#detail-fields", "#payload", "#result"][i]))), true);
      const pauseAction = page.getByRole("button", { name: "Pause updates", exact: true });
      assert.equal(await pauseAction.getAttribute("aria-pressed"), null);
      await pauseAction.click();
      const resumeAction = page.getByRole("button", { name: "Resume updates", exact: true });
      assert.equal(await resumeAction.getAttribute("aria-pressed"), null);
      await resumeAction.click();
      assert.equal(await page.getByRole("button", { name: "Pause updates", exact: true }).getAttribute("aria-pressed"), null);
    });
    await check("theme label, pressed state and persisted theme agree", async (page) => {
      await page.goto(`${BASE}/dashboard/#/jobs`);
      const control = page.locator("[data-theme-toggle]").first();
      assert.equal(await control.innerText(), "Use dark theme");
      assert.equal(await control.getAttribute("aria-pressed"), "false");
      await control.click();
      assert.equal(await page.locator("[data-theme-toggle]").first().innerText(), "Use light theme");
      assert.equal(await page.locator("[data-theme-toggle]").first().getAttribute("aria-pressed"), "true");
      await page.reload();
      assert.equal(await page.locator("[data-theme-toggle]").first().getAttribute("aria-pressed"), "true");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const mobileTheme = page.locator("#menu-sheet [data-theme-toggle]");
      assert.equal(await mobileTheme.innerText(), "Use light theme");
      assert.equal(await mobileTheme.getAttribute("aria-pressed"), "true");
      await mobileTheme.click();
      assert.equal(await mobileTheme.getAttribute("aria-pressed"), "false");
    });
    await check("an events network failure names the failed request", async (page) => {
      await connect(page);
      await page.context().route(`**/jobs/${EXP.dead}/events?*`, (r) => r.abort());
      await go(page, `#/jobs/${EXP.dead}`);
      await page.locator("#banner").filter({ hasText: /Cannot reach/ }).waitFor();
      assert.ok((await page.locator("#banner").innerText()).includes(`/jobs/${EXP.dead}/events`));
    });
    await check("a late private network failure cannot repopulate the page after Forget", async (page) => {
      await connect(page);
      let release;
      const blocked = new Promise((resolve) => { release = resolve; });
      let began;
      const started = new Promise((resolve) => { began = resolve; });
      await page.context().route(`**/jobs/${EXP.dead}/events?*`, async (r) => {
        began(); await blocked; await r.abort();
      });
      await go(page, `#/jobs/${EXP.dead}`);
      await started;
      await page.getByRole("button", { name: "Forget token", exact: true }).first().click();
      release();
      await page.waitForTimeout(300);
      assert.doesNotMatch(await page.locator("#banner").textContent(), /Cannot reach|\/events/);
      assert.equal(await page.getByRole("button", { name: "Forget token", exact: true }).count(), 0);
      await go(page, "#/connection");
      assert.equal(await page.getByLabel("API token", { exact: true }).inputValue(), "");
    });
    await check("a late job failure cannot overwrite a different route's connection message", async (page) => {
      await connect(page);
      let release;
      const blocked = new Promise((resolve) => { release = resolve; });
      let began;
      const started = new Promise((resolve) => { began = resolve; });
      await page.context().route(`**/jobs/${EXP.dead}/events?*`, async (r) => {
        began(); await blocked; await r.abort();
      });
      await go(page, `#/jobs/${EXP.dead}`);
      await started;
      await go(page, "#/submit");
      release();
      await page.waitForTimeout(300);
      assert.doesNotMatch(await page.locator("#banner").textContent(), /Cannot reach|\/events/);
    });
    await check("anonymous connection checks avoid uncached stats", async (page) => {
      const reads = [];
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (["/stats", "/jobs", "/auth/check"].includes(u.pathname)) reads.push(u.pathname + u.search);
      });
      await page.goto(`${BASE}/dashboard/#/connection`);
      await page.waitForTimeout(2200);
      assert.ok(reads.length >= 1);
      assert.ok(reads.every((path) => path === "/jobs?limit=1"), JSON.stringify(reads));
    });
    await check("a delayed Jobs HTTP error cannot overwrite Submit", async (page) => {
      await connect(page);
      let release;
      const blocked = new Promise((resolve) => { release = resolve; });
      let began;
      const started = new Promise((resolve) => { began = resolve; });
      await page.context().route((url) => url.pathname === "/jobs", async (r) => {
        began(); await blocked;
        await r.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"old Jobs failure"}' });
      });
      await go(page, "#/jobs");
      await started;
      await go(page, "#/submit");
      release();
      await page.waitForTimeout(300);
      assert.doesNotMatch(await page.locator("#banner").textContent(), /HTTP 503|old Jobs failure/);
    });
    await check("every route focuses its H1 including Not found", async (page) => {
      await connect(page);
      for (const [route, title] of [["#/jobs", "Jobs"], [`#/jobs/${EXP.dead}`, `Job ${EXP.dead}`],
        ["#/submit", "New job"], ["#/connection", "Settings"], ["#/missing", "Not found"]]) {
        await go(page, route);
        assert.deepEqual(await page.evaluate(() => ({ tag: document.activeElement.tagName,
          text: document.activeElement.textContent.trim() })), { tag: "H1", text: title });
        assert.equal(await page.title(), `${title} – LeaseQ`);
      }
    });
    await check("Menu close returns focus and Menu navigation focuses its destination H1", async (page) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`${BASE}/dashboard/#/jobs`);
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      const heading = page.locator("main h1");
      const assertFocused = async (expected) => assert.deepEqual(await page.evaluate(() => ({
        tag: document.activeElement.tagName, text: document.activeElement.textContent.trim(),
      })), expected);
      await menu.click();
      await page.keyboard.press("Escape");
      await assertFocused({ tag: "BUTTON", text: "Menu" });
      await menu.click();
      await page.getByRole("button", { name: "Close menu", exact: true }).click();
      await assertFocused({ tag: "BUTTON", text: "Menu" });
      await menu.click();
      await page.mouse.click(1, 1);
      await page.waitForFunction(() => !document.querySelector("#menu-sheet").open);
      await assertFocused({ tag: "BUTTON", text: "Menu" });
      for (const [route, title] of [["jobs", "Jobs"], ["jobs", "Jobs"],
        ["submit", "New job"], ["connection", "Settings"]]) {
        await menu.click();
        await page.locator(`#menu-sheet a[data-route="${route}"]`).click();
        await page.waitForFunction((expected) => !document.querySelector("#menu-sheet").open &&
          document.activeElement.tagName === "H1" && document.activeElement.textContent.trim() === expected, title);
        await page.waitForTimeout(100);
        await assertFocused({ tag: "H1", text: title });
        assert.equal(await heading.innerText(), title);
      }
      await page.goto(`${BASE}/dashboard/#/jobs`);
      await menu.click();
      await page.locator('#menu-sheet a[data-route="submit"]').click();
      await page.waitForFunction(() => location.hash === "#/submit");
      await menu.click();
      await page.goBack();
      await page.waitForFunction(() => location.hash === "#/jobs" && !document.querySelector("#menu-sheet").open);
      await page.waitForTimeout(100);
      await assertFocused({ tag: "H1", text: "Jobs" });
      await menu.click();
      await page.goForward();
      await page.waitForFunction(() => location.hash === "#/submit" && !document.querySelector("#menu-sheet").open);
      await page.waitForTimeout(100);
      await assertFocused({ tag: "H1", text: "New job" });
    }, 320);
    for (const state of ["queued", "leased"]) {
      await check(`Cancel ${state} explains lease revocation without promising to stop work`, async (page) => {
        await connect(page);
        await go(page, `#/jobs/${EXP[state]}`);
        await page.getByRole("button", { name: "Cancel job", exact: true }).click();
        const dialog = page.getByRole("dialog");
        const copy = await dialog.locator("#confirm-text").innerText();
        assert.match(copy, /revok/i);
        assert.match(copy, /may still/i);
        assert.match(copy, /external effects/i);
        assert.doesNotMatch(copy, /is still running|will not be run/);
        assert.equal(await page.locator(":focus").innerText(), "Keep job");
        await page.getByRole("button", { name: "Keep job", exact: true }).click();
      });
    }
    for (const width of [320, 768, 1440]) {
      await check(`visible controls and links have 44px targets at ${width}px`, async (page) => {
        await connect(page);
        for (const route of ["#/jobs", `#/jobs/${EXP.dead}`, "#/submit", "#/connection"]) {
          await go(page, route);
          const small = await page.locator("a,button,input,select,textarea,summary").evaluateAll((els) => els
            .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden" && !e.classList.contains("skip"))
            .map((e) => ({ name: e.id || e.textContent.trim().slice(0, 60), width: e.getBoundingClientRect().width,
              height: e.getBoundingClientRect().height }))
            .filter((e) => e.width < 43.9 || e.height < 43.9));
          assert.deepEqual(small, [], `${route}: ${JSON.stringify(small)}`);
          assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth));
        }
      }, width);
    }
    await check("a very long job URL reflows at 320px", async (page) => {
      await connect(page);
      await go(page, `#/jobs/${"9".repeat(120)}`);
      assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth));
    }, 320);
  } finally { await browser.close(); }
  console.log(JSON.stringify({ results }));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
