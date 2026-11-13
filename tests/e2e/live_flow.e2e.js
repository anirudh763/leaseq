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
async function enterTokenByKeyboard(page) {
  await tabTo(page, (a) => a.id === "token-button");
  await page.keyboard.press("Enter");
  assert.equal((await active(page)).id, "token-input");
  await page.keyboard.type(TOKEN);
  await page.keyboard.press("Enter");
  await page.locator("#operator-label").waitFor({ state: "visible" });
}

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
    assert.deepEqual(noTokenCounts, Array(6).fill("\u2013"));   // unknown, not "0"
    assert.equal(await page.locator("#rows tr").count(), 0);
    report.axe["no-token"] = await axeViolations(page);
    step("reads without a token: 401, the page shows 'requires the API token'");

    // 2. Keyboard only: open the token dialog, submit it empty, then the real token.
    await tabTo(page, (a) => a.id === "token-button");
    await page.keyboard.press("Enter");
    assert.equal((await active(page)).id, "token-input");
    await page.keyboard.press("Enter");                                   // empty input
    await page.locator("#token-error").filter({ hasText: "at least 16 characters" }).waitFor();
    assert.equal(await page.locator("#token-input").getAttribute("aria-invalid"), "true");
    await page.keyboard.type(TOKEN);
    await page.keyboard.press("Enter");
    await page.locator("#operator-label").waitFor({ state: "visible" });
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
    await page.getByLabel("Job ID").fill("16");
    await page.getByLabel("Job ID").press("Enter");
    await page.locator("#detail-title").filter({ hasText: "Job 16" }).waitFor();
    assert.equal((await active(page)).id, "detail-title");
    await page.getByRole("button", { name: "Cancel job" }).click();
    await page.locator("#confirm-dialog").getByRole("button", { name: "Cancel job" }).click();
    await page.locator("#events li .what").filter({ hasText: "Cancelled by operator" }).waitFor();
    assert.match(await page.locator("#detail-state").innerText(), /Dead/);
    step("cancel of a queued job: confirmed, job is dead, 'Cancelled by operator' in the audit log");

    // 5. The worker runs jobs: job 1 completes and its events show it.
    await page.getByLabel("Job ID").fill("1");
    await page.getByLabel("Job ID").press("Enter");
    await page.locator("#detail-title").filter({ hasText: "Job 1" }).waitFor();
    await page.locator("#lease-rows").filter({ hasText: "Completed" }).waitFor({ timeout: 30000 });
    const ev1 = await page.locator("#events li .what").allInnerTexts();
    assert.deepEqual(ev1, ["Enqueued", "Claimed", "Completed"]);
    step("a worker process claimed and completed job 1; lease history and audit events show it");

    // 6. Retry: job 13 fails twice with backoff, then goes dead on attempt 3 of 3.
    await page.getByLabel("Job ID").fill("13");
    await page.getByLabel("Job ID").press("Enter");
    await page.locator("#detail-title").filter({ hasText: "Job 13" }).waitFor();
    await page.locator("#lease-rows").filter({ hasText: "Dead:" }).waitFor({ timeout: 60000 });
    const leases = await page.locator("#lease-rows tr").allInnerTexts();
    assert.equal(leases.length, 3);
    assert.match(leases[0], /Failed: .*upstream returned 503.*Retry in/s);
    assert.match(leases[1], /Failed: .*Retry in/s);
    assert.match(leases[2], /Dead:/);
    const ev13 = await page.locator("#events li .what").allInnerTexts();
    assert.deepEqual(ev13, ["Enqueued", "Claimed", "Failed", "Claimed", "Failed", "Claimed", "Dead"]);
    report.axe["operator-panel"] = await axeViolations(page);
    step("retry with backoff: two failed attempts, then dead; all three leases listed");

    // 7. Requeue it, Escape closes the panel and focus goes back to the job's row.
    await page.getByRole("button", { name: "Requeue job" }).click();
    await page.locator("#confirm-dialog").getByRole("button", { name: "Requeue job" }).click();
    await page.locator("#events li .what").filter({ hasText: "Requeued by operator" }).waitFor();
    await page.locator("#detail-title").focus();
    await page.keyboard.press("Escape");
    await page.locator("#detail").waitFor({ state: "hidden" });
    const back = await active(page);
    assert.ok(back.job === "13" || back.id === "goto-id", JSON.stringify(back));
    step("requeue logged; Escape closes the details and focus returns");

    // 8. Error states: empty job id, API unreachable, then recovery.
    await page.getByLabel("Job ID").fill("");
    await page.getByRole("button", { name: "Open job" }).click();
    await page.locator("#goto-error").filter({ hasText: "Enter a job number" }).waitFor();
    assert.equal(await page.getByLabel("Job ID").getAttribute("aria-invalid"), "true");
    await page.route("**/jobs?*", (route) => route.abort("connectionrefused"));
    await banner.filter({ hasText: "Cannot reach the API" }).waitFor();
    assert.equal(await page.locator("#updated").innerText(), "Offline");
    report.axe["api-down"] = await axeViolations(page);
    await page.unroute("**/jobs?*");
    await banner.waitFor({ state: "detached" });
    step("error states: empty job id is flagged; API failure shows a banner and recovers");

    // 9. Privacy: the token never stays in the input; job data goes with the token.
    const inputValue = () => page.$eval("#token-input", (e) => e.value);
    const payloadInDom = () => page.evaluate(() => document.body.textContent.includes("upstream returned 503"));
    await page.getByLabel("Job ID").fill("13");
    await page.getByLabel("Job ID").press("Enter");
    await page.locator("#payload").filter({ hasText: "upstream returned 503" }).waitFor();
    assert.equal(await inputValue(), "", "input must be empty after the token was accepted");
    // Hold the next poll (sent with the token) so it is still in flight when the
    // token is forgotten; its answer must not bring the data back.
    let held = 0;
    await page.route("**/jobs?*", async (route) => {
      held += 1;
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await page.waitForTimeout(2200);                                   // a poll is now held
    assert.ok(held >= 1, "no poll was in flight");
    await page.getByRole("button", { name: "Forget token" }).click();                // (a) + (c)
    await page.locator("#detail").waitFor({ state: "hidden" });
    assert.equal(await inputValue(), "");
    assert.equal(await page.locator("#payload").textContent(), "");
    assert.equal(await payloadInDom(), false);
    assert.equal(await page.locator("#rows tr").count(), 0);          // cleared at once
    await page.waitForTimeout(2000);                                   // the held poll answers
    assert.equal(await page.locator("#rows tr").count(), 0);
    assert.equal(await payloadInDom(), false);
    assert.deepEqual(await page.$$eval("[data-count]", (els) => els.map((e) => e.textContent)),
                     Array(6).fill("\u2013"));
    await page.unroute("**/jobs?*");
    step("Forget token: input empty; job panel closed and its payload gone from the DOM");

    await page.locator("#token-button").click();                                       // (b)
    await page.getByLabel("API token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await inputValue(), "");
    await page.locator("#token-button").click();
    await page.getByLabel("API token", { exact: true }).fill(TOKEN);
    await page.keyboard.press("Escape");
    assert.equal(await inputValue(), "");
    step("token dialog cancelled or escaped: input empty");

    await page.locator("#token-button").click();                                       // (d)
    await page.getByLabel("API token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Use token" }).click();
    await page.locator("#payload").filter({ hasText: "upstream returned 503" }).waitFor();
    await page.route("**/jobs?*", (route) => route.fulfill({
      status: 401, contentType: "application/json",
      headers: { "www-authenticate": "Bearer" }, body: '{"detail":"missing or invalid bearer token"}' }));
    await page.locator("#detail").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#payload").textContent(), "");
    assert.equal(await payloadInDom(), false);
    assert.equal(await page.locator("#rows tr").count(), 0);
    await page.unroute("**/jobs?*");
    await page.locator("#payload").filter({ hasText: "upstream returned 503" }).waitFor();
    step("a 401 on the next poll closes the job panel and removes its payload; it returns once reads work");
    assert.deepEqual(errors, []);
    await ctx.close();

    // 9. 375 px wide, and 640 px (a 1280 px window at 200% zoom), light and dark.
    for (const [width, scheme] of [[375, "light"], [375, "dark"], [640, "light"], [640, "dark"]]) {
      const c = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme, bypassCSP: true });
      const p = await c.newPage();
      await p.goto(`${BASE}/dashboard/?job=13`);
      await enterTokenByKeyboard(p);
      await p.locator("#lease-rows tr").first().waitFor();
      const sw = await p.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= width, `page is ${sw}px wide at ${width}px`);
      report.axe[`${scheme}-${width}px`] = await axeViolations(p);
      await c.close();
    }
    step("375 px and 640 px (200% zoom), light and dark: no sideways scroll");

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
