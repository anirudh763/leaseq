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
  const browser = await chromium.launch();
  async function check(name, fn, width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try { await fn(page); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error.message).slice(0, 1000) }); }
    finally { await context.close(); }
  }
  try {
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
        await page.route((url) => url.pathname === path, (r) => r.fulfill({
          status: 503, contentType: "application/json", body: '{"detail":"temporarily unavailable"}',
        }));
        await go(page, `#/jobs/${EXP.dead}`);
        await page.locator("#banner").filter({ hasText: /HTTP 503/ }).waitFor();
        assert.ok((await page.locator("#banner").innerText()).includes(path));
      });
    }
    await check("an events network failure names the failed request", async (page) => {
      await connect(page);
      await page.route(`**/jobs/${EXP.dead}/events?*`, (r) => r.abort());
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
      await page.route(`**/jobs/${EXP.dead}/events?*`, async (r) => {
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
      await page.route(`**/jobs/${EXP.dead}/events?*`, async (r) => {
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
      await page.route((url) => url.pathname === "/jobs", async (r) => {
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
        ["#/submit", "Submit test job"], ["#/connection", "Connection & API"], ["#/missing", "Not found"]]) {
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
        ["submit", "Submit test job"], ["connection", "Connection & API"]]) {
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
      await assertFocused({ tag: "H1", text: "Submit test job" });
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
