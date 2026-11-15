"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL;
const TOKEN = process.env.API_TOKEN;
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || "/tmp/leaseq-operator-ui-artifacts";
if (!BASE || !TOKEN) throw new Error("Set BASE_URL and API_TOKEN");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
let browser;

(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, bypassCSP: true });
  const page = await context.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(`${BASE}/dashboard/#/connection`);
  await page.getByLabel("API token", { exact: true }).fill(TOKEN);
  await page.getByLabel("Keep token until this tab closes").check();
  await page.getByRole("button", { name: "Use token" }).click();
  await page.locator("#forget-token").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("leaseq-api-token")), TOKEN);
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, cookie: document.cookie })), { local: 0, cookie: "" });

  await page.goto(`${BASE}/dashboard/#/submit`);
  const kind = `e2e.operator-ui-${Date.now()}`;
  await page.getByLabel("Job kind", { exact: true }).fill(kind);
  await page.getByLabel("JSON object payload", { exact: true }).fill('{"note":"operator UI contract"}');
  await page.getByLabel("Priority (-100 to 100)").fill("7");
  await page.getByLabel("Maximum attempts (1 to 100)").fill("2");
  await page.getByLabel(/UTC due time/).fill(new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  await page.getByLabel("Idempotency key", { exact: true }).fill(`operator-ui-${Date.now()}`);
  const payloadBox = page.getByLabel("JSON object payload", { exact: true });
  await payloadBox.fill(JSON.stringify({ note: "x".repeat(70000) }));
  await page.getByRole("button", { name: "Submit job" }).click();
  assert.match(await page.locator("#submit-error").innerText(), /65,536-byte API limit/);
  assert.equal((await payloadBox.inputValue()).length > 70000, true, "oversize payload was silently truncated");
  await payloadBox.fill('{"note":"operator UI contract"}');
  await page.getByRole("button", { name: "Submit job" }).click();
  const jobLink = page.getByRole("link", { name: /^Open job / });
  await jobLink.waitFor();
  const id = (await jobLink.innerText()).match(/\d+/)[0];
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const created = await (await fetch(`${BASE}/jobs/${id}`, { headers: auth })).json();
  assert.equal(created.kind, kind);
  assert.equal(created.priority, 7);
  assert.equal(created.max_attempts, 2);
  assert.deepEqual(created.payload, { note: "operator UI contract" });
  await page.getByRole("button", { name: "Submit job" }).click();
  await jobLink.waitFor();
  assert.equal((await jobLink.innerText()).match(/\d+/)[0], id, "ambiguous/repeated submission used a new idempotency key");

  await page.goto(`${BASE}/dashboard/#/jobs/job-${id}`);
  await page.getByRole("heading", { name: `Job ${id}`, exact: true }).waitFor();
  await page.goto(`${BASE}/dashboard/#/jobs/job-nope`);
  await page.getByRole("heading", { name: "Invalid job ID" }).waitFor();
  await page.goto(`${BASE}/dashboard/#/jobs/9223372036854775807`);
  await page.getByRole("heading", { name: /No job 9223372036854775807/ }).waitFor();

  await page.goto(`${BASE}/dashboard/#/jobs?kind=${kind}`);
  await page.getByRole("heading", { name: "Jobs" }).waitFor();
  await page.getByRole("button", { name: "Snapshot and review" }).waitFor();
  await page.locator("#bulk-action").selectOption("cancel");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Snapshot and review" }).click();
  await page.getByText(/1 outcomes: 1 changed/).waitFor();
  const cancelled = await (await fetch(`${BASE}/jobs/${id}`, { headers: auth })).json();
  assert.equal(cancelled.state, "dead");

  await page.goto(`${BASE}/dashboard/#/operations`);
  await page.getByRole("heading", { name: "Observed workers" }).waitFor();
  await page.getByRole("heading", { name: "Recent queue measurements" }).waitFor();
  await page.getByRole("heading", { name: "Durable schedules" }).waitFor();
  await page.waitForFunction(() => !document.querySelector("#metrics-data")?.textContent.includes("Loading sampled metrics"));
  const metricText = await page.locator("#metrics-data").innerText();
  assert.match(metricText, /15-minute window/);
  assert.match(metricText, /p50 .* p95/);

  const schedulePrefix = `e2e-operator-${Date.now()}`;
  const scheduleNames = [`${schedulePrefix}-first`, `${schedulePrefix}-second`];
  const scheduleUrl = new URL("/schedules?limit=100", BASE);
  const liveScheduleEvidence = { created: [], replay_returned: null, disabled: [] };
  try {
    await page.getByLabel("Schedule name", { exact: true }).fill(scheduleNames[0]);
    await page.getByLabel("Job kind", { exact: true }).fill("noop");
    await page.getByLabel("JSON object payload", { exact: true }).fill("{}");
    await page.getByLabel("Five-field UTC cron", { exact: true }).fill("0 0 * * *");
    const firstScheduleKey = await page.getByLabel(/Idempotency key \(reuse on ambiguous retry\)/).inputValue();
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.getByText(new RegExp(`Schedule created: ${scheduleNames[0]} \\(ID \\d+\\)\\.`)).waitFor();

    await page.getByRole("button", { name: "Start new schedule" }).click();
    await page.getByLabel("Schedule name", { exact: true }).fill(scheduleNames[1]);
    await page.getByLabel("JSON object payload", { exact: true }).fill('{"intent":2}');
    const secondScheduleKey = await page.getByLabel(/Idempotency key \(reuse on ambiguous retry\)/).inputValue();
    assert.notEqual(secondScheduleKey, firstScheduleKey);
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.getByText(new RegExp(`Schedule created: ${scheduleNames[1]} \\(ID \\d+\\)\\.`)).waitFor();

    const scheduleRows = (await (await fetch(scheduleUrl, { headers: auth })).json()).schedules;
    const firstSchedule = scheduleRows.find((s) => s.name === scheduleNames[0]);
    const secondSchedule = scheduleRows.find((s) => s.name === scheduleNames[1]);
    assert.ok(firstSchedule && secondSchedule && firstSchedule.id !== secondSchedule.id);
    liveScheduleEvidence.created = [firstSchedule.id, secondSchedule.id];
    await page.getByRole("button", { name: "Start new schedule" }).click();
    await page.getByLabel("Schedule name", { exact: true }).fill(`${schedulePrefix}-replay`);
    await page.getByLabel("JSON object payload", { exact: true }).fill('{"intent":3}');
    await page.getByLabel(/Idempotency key \(reuse on ambiguous retry\)/).fill(firstScheduleKey);
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.getByText(`Existing schedule returned: ${scheduleNames[0]} (ID ${firstSchedule.id}).`, { exact: true }).waitFor();
    liveScheduleEvidence.replay_returned = firstSchedule.id;
  } finally {
    const cleanup = await (await fetch(scheduleUrl, { headers: auth })).json();
    for (const schedule of cleanup.schedules.filter((s) => scheduleNames.includes(s.name))) {
      const response = await fetch(new URL(`/schedules/${schedule.id}`, BASE), { method: "PATCH", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
      assert.equal(response.status, 200, `schedule ${schedule.id} cleanup status`);
      liveScheduleEvidence.disabled.push(schedule.id);
    }
    const remaining = (await (await fetch(scheduleUrl, { headers: auth })).json()).schedules;
    assert.equal(remaining.some((s) => scheduleNames.includes(s.name) && s.enabled), false, "synthetic schedules remain enabled");
    await page.reload();
    await page.getByRole("heading", { name: "Durable schedules" }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#metrics-data")?.textContent.includes("Loading sampled metrics"));
  }

  const axeResults = [];
  if (process.env.AXE_PATH) await page.addScriptTag({ path: process.env.AXE_PATH });

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      h1: Boolean(document.querySelector("#view h1")),
      shortTargets: [...document.querySelectorAll("#view button, #view .btn")].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44;
      }).length,
    }));
    assert.equal(layout.scroll, layout.width, `${width}px page overflow: ${JSON.stringify(layout)}`);
    assert.equal(layout.h1, true);
    assert.equal(layout.shortTargets, 0, `${width}px controls below 44px`);
    if (process.env.AXE_PATH) {
      const axe = await page.evaluate(async () => (await axe.run(document)).violations.map((v) => `${v.id}: ${v.nodes.length}`));
      assert.deepEqual(axe, [], `${width}px axe violations: ${axe.join(", ")}`);
      axeResults.push({ width, violations: axe.length });
    }
    const out = path.join(ARTIFACT_DIR, `leaseq-operations-${width}.png`);
    await page.screenshot({ path: out, fullPage: true });
  }

  // A server 401 invalidates a remembered token and clears all tab storage.
  await page.route("**/operations/metrics", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ detail: "missing token" }),
  }));
  await page.reload();
  await page.waitForFunction(() => sessionStorage.getItem("leaseq-api-token") === null);
  assert.equal(await page.locator("#forget-token").isVisible(), false);
  assert.deepEqual(pageErrors, []);
  await context.close();

  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    const { getItem, setItem, removeItem } = Storage.prototype;
    Storage.prototype.getItem = function (key) { if (key === "leaseq-api-token") throw new Error("blocked"); return getItem.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key === "leaseq-api-token") throw new Error("blocked"); return setItem.call(this, key, value); };
    Storage.prototype.removeItem = function (key) { if (key === "leaseq-api-token") throw new Error("blocked"); return removeItem.call(this, key); };
  });
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(`${BASE}/dashboard/#/connection`);
  await blockedPage.getByLabel("API token", { exact: true }).fill(TOKEN);
  await blockedPage.getByLabel("Keep token until this tab closes").check();
  await blockedPage.getByRole("button", { name: "Use token" }).click();
  await blockedPage.getByText(/browser blocked session storage/i).waitFor();
  await blocked.close();
  await browser.close();
  process.stdout.write(`${JSON.stringify({ ok: true, axe: axeResults, screenshots: [320, 768, 1440].map((w) => path.join(ARTIFACT_DIR, `leaseq-operations-${w}.png`)), job_id: id, live_schedule_evidence: liveScheduleEvidence, page_errors: pageErrors, console_errors: consoleErrors })}\n`);
})().catch(async (e) => { console.error(e); if (browser) await browser.close(); process.exitCode = 1; });
