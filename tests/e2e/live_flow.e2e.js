// Live flow against a real API and real worker processes (started by
// tests/test_dashboard_e2e.py). LEASEQ_PUBLIC_READ is NOT set, so the dashboard
// must ask for the token before it can show anything.
//   BASE_URL, API_TOKEN, AXE_PATH
"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL;
const TOKEN = process.env.API_TOKEN;
const AXE = process.env.AXE_PATH;
const report = { steps: [], axe: {} };
const step = (s) => report.steps.push(s);

async function axeViolations(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    });
    return r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
  });
}
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { id: a.id, text: (a.textContent || "").trim(), job: a.dataset ? a.dataset.job : undefined };
});
async function tabTo(page, predicate, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (predicate(await active(page))) return;
  }
  throw new Error("could not reach the element with Tab");
}
// Keyboard only: open Connection & API from the Menu or rail, type the token, press Enter.
async function enterTokenByKeyboard(page) {
  await page.evaluate(() => { window.location.hash = "#/connection"; });
  await page.locator("h1").filter({ hasText: "Connection & API" }).waitFor();
  await tabTo(page, (a) => a.id === "token-input");
  await page.keyboard.type(TOKEN);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Forget token" }).first().waitFor();
}
const steps = (page) => page.locator(".timeline [data-step]").evaluateAll((els) => els.map((e) => e.dataset.step));
const openJobById = async (page, id) => {
  await page.evaluate(() => { window.location.hash = "#/jobs"; });
  await page.getByLabel("Job ID").fill(String(id));
  await page.getByLabel("Job ID").press("Enter");
  await page.locator("h1").filter({ hasText: new RegExp(`^Job ${id}$`) }).waitFor();
};

(async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    // 1. Without the token, reads are refused and the page says so.
    await page.goto(`${BASE}/dashboard/`);
    const banner = page.getByRole("alert");
    await banner.filter({ hasText: "requires the API token to read jobs" }).waitFor();
    assert.equal(await page.locator("#demo-note").isVisible(), false);
    const noTokenCounts = await page.$$eval("[data-count]", (els) => els.map((e) => e.textContent));
    assert.deepEqual(noTokenCounts, Array(6).fill("–"));   // unknown, not "0"
    assert.equal(await page.locator("#rows tr").count(), 1);
    assert.equal(await page.locator("#rows").innerText(), "Jobs appear here after you connect. Enter the API token");
    assert.equal(await page.locator("#conn-notice h2").innerText(), "Not connected");
    report.axe["no-token"] = await axeViolations(page);
    step("reads without a token: 401, the Jobs screen shows the Not connected state");

    // 2. Keyboard only: submit the token form empty, then the real token.
    await page.evaluate(() => { window.location.hash = "#/connection"; });
    await page.locator("h1").filter({ hasText: "Connection & API" }).waitFor();
    await tabTo(page, (a) => a.id === "token-input");
    await page.keyboard.press("Enter");                                   // empty input
    await page.locator("#token-error").filter({ hasText: "at least 16 characters" }).waitFor();
    assert.equal(await page.locator("#token-input").getAttribute("aria-invalid"), "true");
    await page.keyboard.type(TOKEN);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Forget token" }).first().waitFor();
    assert.equal((await active(page)).id, "go-jobs");
    await page.keyboard.press("Enter");
    await page.getByText("No jobs yet.").waitFor();
    assert.equal(await banner.count(), 0);
    step("keyboard only: empty token is refused with a message; the right token unlocks reads");

    // 3. Enqueue from the dashboard (empty state button), with the keyboard.
    await tabTo(page, (a) => a.id === "load-sample");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-count="all"]').textContent === "16");
    await page.locator("#demo-note").waitFor({ state: "visible" });
    assert.match(await page.locator("#demo-note").innerText(), /no email is sent and nothing is\s+rendered/);
    step("'Load sample jobs' enqueued 16 jobs through POST /demo/jobs; the sample-data note says demo jobs do no real work");

    // 4. Cancel the last job while it is still queued (job 16 of 16).
    await openJobById(page, 16);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "H1");
    await page.getByRole("button", { name: "Cancel job" }).click();
    await page.locator("#confirm-dialog").getByRole("button", { name: "Cancel job" }).click();
    await page.locator(".timeline [data-step=cancelled]").waitFor();
    assert.match(await page.locator("#detail-state").innerText(), /Dead/);
    step("cancel of a queued job: confirmed, job is dead, 'Cancelled by operator' on the timeline");

    // 5. The worker runs jobs: job 1 completes and its timeline shows it.
    await openJobById(page, 1);
    await page.locator(".timeline [data-step=completed]").waitFor({ timeout: 30000 });
    assert.deepEqual(await steps(page), ["enqueued", "claimed", "completed"]);
    step("a worker process claimed and completed job 1; the lifecycle timeline shows it");

    // 6. Retry: job 13 fails twice with backoff, then goes dead on attempt 3 of 3.
    await openJobById(page, 13);
    await page.locator(".timeline [data-step=dead]").waitFor({ timeout: 60000 });
    assert.deepEqual(await steps(page), ["enqueued", "claimed", "failed", "claimed", "failed", "claimed", "dead"]);
    const tl = await page.locator(".timeline").innerText();
    assert.match(tl, /upstream returned 503.*Retry in/s);
    assert.match(await page.locator("#why").innerText(), /dead after 3 of 3 attempts/);
    report.axe["operator-panel"] = await axeViolations(page);
    step("retry with backoff: two failed attempts, then dead; all three claims on the timeline; 'why' explains it");

    // 7. Requeue it; Back returns to the Jobs screen with focus on its H1.
    await page.getByRole("button", { name: "Requeue job" }).click();
    await page.locator("#confirm-dialog").getByRole("button", { name: "Requeue job" }).click();
    await page.locator(".timeline [data-step=requeued]").waitFor();
    await page.getByRole("link", { name: "← Back to jobs" }).click();
    await page.locator("h1").filter({ hasText: /^Jobs$/ }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "H1");
    step("requeue logged; Back to jobs moves focus to the Jobs heading");

    // 8. Error states: empty job id, API unreachable, then recovery.
    await page.getByLabel("Job ID").fill("");
    await page.getByRole("button", { name: "Open job" }).click();
    await page.locator("#goto-error").filter({ hasText: "Enter a job number" }).waitFor();
    assert.equal(await page.getByLabel("Job ID").getAttribute("aria-invalid"), "true");
    await page.route("**/jobs?*", (route) => route.abort("connectionrefused"));
    await banner.filter({ hasText: "Cannot reach the API" }).waitFor();
    await page.locator("#conn-status").filter({ hasText: "API unreachable" }).waitFor();
    report.axe["api-down"] = await axeViolations(page);
    await page.unroute("**/jobs?*");
    await banner.waitFor({ state: "detached" });
    step("error states: empty job id is flagged; API failure shows a banner and recovers");

    // 9. Privacy: the token never stays in an input; job data goes with the token.
    const payloadInDom = () => page.evaluate(() => document.documentElement.innerHTML.includes("upstream returned 503"));
    await openJobById(page, 13);
    await page.locator("#payload").filter({ hasText: "upstream returned 503" }).waitFor();
    // Hold the next job read (sent with the token) so it is still in flight when the
    // token is forgotten; its answer must not bring the data back.
    let held = 0;
    await page.route("**/jobs/13*", async (route) => {
      held += 1;
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await page.waitForTimeout(2200);
    assert.ok(held >= 1, "no poll was in flight");
    await page.getByRole("button", { name: "Forget token" }).first().click();
    assert.equal(await payloadInDom(), false);
    assert.equal(await page.locator("#payload").count(), 0);
    await page.waitForTimeout(2000);                                   // the held poll answers
    assert.equal(await payloadInDom(), false);
    await page.unroute("**/jobs/13*");
    await page.evaluate(() => { window.location.hash = "#/jobs"; });
    await page.locator("h1").filter({ hasText: /^Jobs$/ }).waitFor();
    assert.equal(await page.locator("#rows [data-job]").count(), 0);
    assert.deepEqual(await page.$$eval("[data-count]", (els) => els.map((e) => e.textContent)), Array(6).fill("–"));
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length,
      session: sessionStorage.length, cookie: document.cookie })), { local: 0, session: 0, cookie: "" });
    step("Forget token: payload gone at once; a read in flight does not bring it back; job rows and counts cleared");

    await page.evaluate(() => { window.location.hash = "#/connection"; });
    await page.getByLabel("API token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Use token" }).click();
    await page.locator("#token-ok").waitFor();
    assert.equal(await page.locator("#token-input").count(), 0, "token input still present after it was accepted");
    await openJobById(page, 13);
    await page.locator("#payload").filter({ hasText: "upstream returned 503" }).waitFor();
    await page.route("**/jobs/13*", (route) => route.fulfill({
      status: 401, contentType: "application/json",
      headers: { "www-authenticate": "Bearer" }, body: '{"detail":"missing or invalid bearer token"}' }));
    await banner.filter({ hasText: "rejected the API token" }).waitFor();
    assert.equal(await payloadInDom(), false);
    await page.unroute("**/jobs/13*");
    await page.waitForTimeout(2500);
    assert.equal(await payloadInDom(), false, "data came back without a token");
    step("a 401 clears the token and the job's payload; nothing returns until the token is entered again");
    assert.deepEqual(errors, []);
    await ctx.close();

    // 10. 375 px wide, and 640 px (a 1280 px window at 200% zoom), light and dark.
    for (const [width, scheme] of [[375, "light"], [375, "dark"], [640, "light"], [640, "dark"]]) {
      const c = await browser.newContext({ viewport: { width, height: 800 }, bypassCSP: true });
      const p = await c.newPage();
      if (scheme === "dark") await p.addInitScript(() => { try { localStorage.setItem("leaseq-theme", "dark"); } catch (e) {} });
      await p.goto(`${BASE}/dashboard/#/jobs/13`);
      await enterTokenByKeyboard(p);
      await p.evaluate(() => { window.location.hash = "#/jobs/13"; });
      await p.locator(".timeline [data-step]").first().waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), scheme);
      const sw = await p.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= width, `page is ${sw}px wide at ${width}px`);
      report.axe[`${scheme}-${width}px`] = await axeViolations(p);
      await c.close();
    }
    step("375 px and 640 px (200% zoom), light and dark: no sideways scroll");

    // 11. Submit test job with the public-domain sample through the real workers.
    {
      const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
      const p = await c.newPage();
      await p.goto(`${BASE}/dashboard/#/connection`);
      await p.getByLabel("API token", { exact: true }).fill(TOKEN);
      await p.getByRole("button", { name: "Use token" }).click();
      await p.getByRole("button", { name: "Forget token" }).first().waitFor();
      await p.evaluate(() => { window.location.hash = "#/submit"; });
      await p.getByRole("button", { name: "Load sample text" }).click();
      await p.waitForFunction(() => document.getElementById("wc-text").value.startsWith("Chapter 1"));
      await p.getByRole("button", { name: "Submit job" }).click();
      await p.locator("#submit-result").filter({ hasText: /849 words, 114 lines/ }).waitFor({ timeout: 60000 });
      report.axe["submit-done"] = await axeViolations(p);
      await c.close();
      step("Submit test job: Pride and Prejudice ch. 1 (public domain) -> word_count on a real worker -> 849 words, 114 lines");
    }

    report.axe_total = Object.values(report.axe).reduce((n, v) => n + v.length, 0);
    console.log(JSON.stringify(report));
    assert.equal(report.axe_total, 0, JSON.stringify(report.axe));
  } catch (e) {
    console.log(JSON.stringify(report));
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
