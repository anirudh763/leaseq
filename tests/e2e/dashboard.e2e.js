// Browser test for /dashboard. Run through tests/test_dashboard_e2e.py, which
// starts the API, seeds jobs in known states and passes these variables:
//   BASE_URL, API_TOKEN, AXE_PATH, EXPECTED (JSON: counts and job ids)
// Prints one JSON line with the results; exits non-zero on the first failure.
"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL;
const TOKEN = process.env.API_TOKEN;
const AXE = process.env.AXE_PATH;
const EXP = JSON.parse(process.env.EXPECTED);
const report = { steps: [], axe: {} };
const step = (name) => report.steps.push(name);

async function counts(page) {
  return page.$$eval("[data-count]", (els) =>
    Object.fromEntries(els.map((e) => [e.dataset.count, Number(e.textContent)])));
}

async function axeViolations(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
  });
}

async function storage(page) {
  return page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length,
                                cookie: document.cookie }));
}

async function newPage(browser, opts = {}) {
  // bypassCSP only so axe can be injected. It also makes the XSS check stricter:
  // the payload must be inert because of how it is rendered, not because of CSP.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  return page;
}

async function openDashboard(page, query = "") {
  await page.goto(`${BASE}/dashboard/${query}`);
  await page.waitForFunction(() => /^[1-9][0-9]*$/.test(document.querySelector('[data-count="all"]').textContent));
}

(async () => {
  const browser = await chromium.launch();
  try {
    // ---- 1. read-only view: counts, job panel, no operator buttons ---------------
    for (const scheme of ["light", "dark"]) {
      const page = await newPage(browser, { colorScheme: scheme });
      await openDashboard(page);
      assert.deepEqual(await counts(page), EXP.counts);
      assert.equal(await page.locator("#rows tr").count(), EXP.counts.all);
      assert.equal(await page.locator("#demo-note").isVisible(), false);   // no demo- keys here
      step(`${scheme}: counts match the database`);
      report.axe[`${scheme}-list`] = await axeViolations(page);

      await page.getByRole("button", { name: `Job ${EXP.dead}`, exact: true }).click();
      await page.locator("#detail-title").filter({ hasText: `Job ${EXP.dead}` }).waitFor();
      await assert.doesNotReject(page.locator("#lease-rows tr").first().waitFor());
      assert.equal(await page.locator("#lease-rows tr").count(), 1);
      assert.match(await page.locator("#lease-rows").innerText(), /Dead: boom/);
      const events = await page.locator("#events li .what").allInnerTexts();
      assert.deepEqual(events, ["Enqueued", "Claimed", "Dead"]);
      assert.equal(await page.getByRole("button", { name: /requeue/i }).count(), 0);
      assert.equal(await page.getByRole("button", { name: /cancel job/i }).count(), 0);
      assert.equal(await page.locator("#operator-label").isVisible(), false);
      step(`${scheme}: job panel shows lease history and audit events; no requeue/cancel without a token`);
      report.axe[`${scheme}-panel`] = await axeViolations(page);

      await page.getByRole("button", { name: "Enter API token" }).click();
      await page.locator("#token-dialog").waitFor({ state: "visible" });
      report.axe[`${scheme}-token-dialog`] = await axeViolations(page);
      await page.keyboard.press("Escape");
      assert.deepEqual(page.errors, []);
      await page.context().close();
    }

    // ---- 2. untrusted payload is shown as text -------------------------------------
    {
      const page = await newPage(browser);
      await openDashboard(page, `?job=${EXP.xss}`);
      await page.locator("#payload").filter({ hasText: "<img" }).waitFor();
      assert.equal(await page.locator("#payload img").count(), 0);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      step("HTML in a payload is rendered as text and does not run");
      await page.context().close();
    }

    // ---- 3. filters live in the URL; tabs work from the keyboard ------------------
    {
      const page = await newPage(browser);
      await openDashboard(page);
      const dead = EXP.counts.dead;
      await page.getByRole("tab", { name: /Dead/ }).click();
      await page.waitForFunction((n) => document.querySelectorAll("#rows tr").length === n, dead);
      assert.match(page.url(), /[?&]state=dead/);
      await page.reload();
      await page.waitForFunction((n) => document.querySelectorAll("#rows tr").length === n, dead);
      assert.equal(await page.getByRole("tab", { name: /Dead/ }).getAttribute("aria-selected"), "true");
      await page.getByRole("tab", { name: /Dead/ }).focus();
      await page.keyboard.press("Home");
      assert.equal(await page.getByRole("tab", { name: /All/ }).getAttribute("aria-selected"), "true");
      assert.doesNotMatch(page.url(), /state=/);
      await page.getByLabel("Kind").fill("email.send");
      await page.getByRole("button", { name: "Apply filters" }).click();
      await page.waitForFunction(() => document.querySelectorAll("#rows tr").length === 1);
      assert.match(page.url(), /kind=email\.send/);
      await page.getByLabel("Kind").fill("<bad>");
      await page.getByRole("button", { name: "Apply filters" }).click();
      assert.equal(await page.getByLabel("Kind").getAttribute("aria-invalid"), "true");
      step("tab and kind filter are kept in the URL; Home key moves between tabs; bad filter text is flagged");

      const pause = page.getByRole("button", { name: "Pause updates" });
      await pause.click();
      const resume = page.getByRole("button", { name: "Resume updates" });
      assert.equal(await resume.getAttribute("aria-pressed"), "true");
      const before = await page.locator("#updated").innerText();
      await page.waitForTimeout(2600);
      assert.equal(await page.locator("#updated").innerText(), before);
      step("pause stops automatic updates");
      await page.context().close();
    }

    // ---- 4. operator mode: token check, header-only auth, confirm, requeue, cancel
    {
      const page = await newPage(browser);
      const posts = [];
      page.on("request", (r) => { if (r.method() === "POST") posts.push({ url: r.url(), headers: r.headers() }); });
      await openDashboard(page, `?job=${EXP.dead}`);
      await page.getByRole("button", { name: "Enter API token" }).click();
      await page.getByLabel("API token", { exact: true }).fill("wrong-token-0123456789");
      await page.getByRole("button", { name: "Use token" }).click();
      await page.locator("#token-error").filter({ hasText: "rejected" }).waitFor();
      assert.equal(await page.getByLabel("API token", { exact: true }).getAttribute("aria-invalid"), "true");
      await page.getByLabel("API token", { exact: true }).fill(TOKEN);
      await page.getByRole("button", { name: "Use token" }).click();
      await page.locator("#operator-label").waitFor({ state: "visible" });
      const requeue = page.getByRole("button", { name: "Requeue job" });
      await requeue.waitFor();
      step("a wrong token is refused; the right one shows the requeue button");
      report.axe["light-operator"] = await axeViolations(page);

      await requeue.click();
      await page.locator("#confirm-dialog").waitFor({ state: "visible" });
      report.axe["light-confirm-dialog"] = await axeViolations(page);
      await page.getByRole("button", { name: "Keep as dead" }).click();
      assert.equal(posts.length, 0, "declining the confirmation must not send anything");
      await requeue.click();
      await page.locator("#confirm-dialog").getByRole("button", { name: "Requeue job" }).click();
      await page.locator("#events li .what").filter({ hasText: "Requeued by operator" }).waitFor();
      assert.equal(posts.length, 1);
      assert.equal(posts[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(posts[0].headers.cookie, undefined);
      assert.equal(await page.evaluate(() => document.cookie), "");
      assert.deepEqual(await storage(page), { local: 0, session: 0, cookie: "" });
      step("requeue asks first, sends the token only in the Authorization header, and is logged");

      await page.getByRole("button", { name: `Job ${EXP.running}`, exact: true }).click();
      await page.locator("#detail-title").filter({ hasText: `Job ${EXP.running}` }).waitFor();
      await page.getByRole("button", { name: "Cancel job" }).click();
      await page.locator("#confirm-dialog").getByRole("button", { name: "Cancel job" }).click();
      await page.locator("#events li .what").filter({ hasText: "Cancelled by operator" }).waitFor();
      assert.match(await page.locator("#lease-rows").innerText(), /Cancelled by operator/);
      step("cancel of a running job is confirmed and logged");

      await page.getByRole("button", { name: "Forget token" }).click();
      await page.getByRole("button", { name: `Job ${EXP.dead}`, exact: true }).click();
      await page.locator("#detail-title").filter({ hasText: `Job ${EXP.dead}` }).waitFor();
      assert.equal(await page.getByRole("button", { name: /requeue|cancel job/i }).count(), 0);
      step("forgetting the token hides the operator buttons again");
      // The one expected console error is the 401 for the deliberately wrong token.
      assert.deepEqual(page.errors.filter((e) => !/status of 401/.test(e)), []);
      assert.equal(page.errors.length, 1);
      await page.context().close();
    }

    // ---- 4b. CSP enforced (no bypass): hostile key, payload and error stay inert ---
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation",
          (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${BASE}/dashboard/?job=${EXP.hostile}`);
      await page.locator("#token-button").click();
      await page.getByLabel("API token", { exact: true }).fill(TOKEN);
      await page.getByRole("button", { name: "Use token" }).click();
      await page.locator("#operator-label").waitFor({ state: "visible" });
      await page.locator("#events").filter({ hasText: "<script>window.__xss=4</script>" }).waitFor();
      assert.match(await page.locator("#detail-fields").innerText(), /<img src=x onerror="window.__xss=3">/);
      assert.match(await page.locator("#payload").innerText(), /<svg onload=/);
      assert.match(await page.locator("#lease-rows").innerText(), /<script>window.__xss=4<\/script>/);
      await page.getByRole("button", { name: `Job ${EXP.xss}`, exact: true }).click();
      await page.locator("#payload").filter({ hasText: "<img" }).waitFor();
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.locator("#detail img, #detail svg:not([aria-hidden]) , #detail script").count(), 0);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(await storage(page), { local: 0, session: 0, cookie: "" });
      assert.deepEqual(errors, []);
      step("CSP enforced: hostile key, payload and error shown as text; no script ran; 0 CSP violations; no token in storage");
      await ctx.close();
    }

    // ---- 4c. JavaScript disabled: the noscript message is shown --------------------
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/dashboard/`);
      const msg = page.locator(".noscript");
      assert.equal(await msg.isVisible(), true, "noscript message is not visible with JavaScript off");
      assert.match(await msg.innerText(), /needs JavaScript/);
      assert.equal(await page.locator('.noscript a[href="/docs"]').count(), 1);
      await ctx.close();
      // ...and hidden when JavaScript runs.
      const on = await newPage(browser);
      await openDashboard(on);
      assert.equal(await on.locator(".noscript").count(), 0);
      const icon = await on.locator('link[rel="icon"]').getAttribute("href");
      const res = await on.request.get(new URL(icon, on.url()).href);
      assert.equal(res.status(), 200);
      assert.match(res.headers()["content-type"], /^image\/svg\+xml/);
      assert.match(await on.locator("#version").innerText(), /^leaseq \d+\.\d+\.\d+$/);
      await on.context().close();
      step("JavaScript off: noscript message with a link to /docs; JavaScript on: hidden; SVG favicon and footer version served");
    }

    // ---- 5. narrow screens: no sideways page scroll -------------------------------
    for (const width of [320, 640]) {
      const page = await newPage(browser, { viewport: { width, height: 800 } });
      await openDashboard(page, `?job=${EXP.dead}`);
      await page.locator("#detail-title").filter({ hasText: `Job ${EXP.dead}` }).waitFor();
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(sw <= width, `page is ${sw}px wide at a ${width}px viewport`);
      report.axe[`light-${width}px`] = await axeViolations(page);
      await page.context().close();
    }
    step("320px and 640px viewports: no horizontal page scroll");

    const total = Object.values(report.axe).reduce((n, v) => n + v.length, 0);
    report.axe_total = total;
    console.log(JSON.stringify(report));
    assert.equal(total, 0, `axe violations: ${JSON.stringify(report.axe, null, 1)}`);
  } catch (e) {
    console.log(JSON.stringify(report));
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
