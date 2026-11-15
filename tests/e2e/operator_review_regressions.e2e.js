"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL;
const TOKEN = process.env.API_TOKEN;
if (!BASE || !TOKEN) throw new Error("Set BASE_URL and API_TOKEN");

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    await page.goto(`${BASE}/dashboard/#/connection`);
    await page.getByLabel("API token", { exact: true }).fill(TOKEN);
    await page.getByRole("button", { name: "Use token" }).click();
    await page.goto(`${BASE}/dashboard/#/operations`);
    await page.getByRole("heading", { name: "Durable schedules" }).waitFor();

    const scheduleRequests = [];
    const first = { id: 900001, name: "mock-first", kind: "noop", payload: {}, cron: "0 0 * * *", priority: 0,
      max_attempts: 5, next_run_at: "2026-11-15T00:00:00Z", enabled: true };
    const second = { ...first, id: 900002, name: "mock-second", payload: { intent: 2 } };
    await page.route("**/schedules", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const request = route.request();
      scheduleRequests.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
      if (scheduleRequests.length === 1) return route.abort("failed");
      const existing = scheduleRequests.length === 4 || scheduleRequests[2]?.key === scheduleRequests[1].key;
      const row = existing ? first : scheduleRequests.length <= 2 ? first : second;
      await route.fulfill({ status: existing ? 200 : 201, contentType: "application/json", body: JSON.stringify(row) });
    });
    await page.getByLabel("Schedule name", { exact: true }).fill("mock-first");
    await page.getByLabel("Job kind", { exact: true }).fill("noop");
    await page.getByLabel("Five-field UTC cron", { exact: true }).fill("0 0 * * *");
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.getByText("Could not reach the API; retry with the same idempotency key.", { exact: true }).waitFor();
    const retryKey = await page.getByLabel(/Idempotency key/).inputValue();
    await page.getByRole("button", { name: "Create schedule" }).click();
    await page.waitForFunction(() => /Schedule (created|saved)|Existing schedule returned/.test(document.querySelector("#schedule-error")?.textContent || ""));
    const failures = [];
    if ((await page.locator("#schedule-error").innerText()) !== "Schedule created: mock-first (ID 900001).") failures.push("created schedule status was not truthful");
    if (scheduleRequests[0]?.key !== retryKey || scheduleRequests[1]?.key !== retryKey) failures.push("ambiguous retry did not preserve its idempotency key");
    const firstKey = await page.getByLabel(/Idempotency key/).inputValue();
    const submit = await page.locator("#schedule-submit").count() ? page.locator("#schedule-submit") : page.getByRole("button", { name: "Create schedule" });
    if ((await submit.innerText()) === "Start new schedule") await submit.click();
    await page.getByLabel("Schedule name", { exact: true }).fill("mock-second");
    await page.getByLabel("JSON object payload", { exact: true }).fill('{"intent":2}');
    const secondKey = await page.getByLabel(/Idempotency key/).inputValue();
    if (secondKey === firstKey) failures.push("confirmed create reused its key for a changed intent");
    await submit.click();
    await page.waitForFunction(() => /Schedule (created|saved)|Existing schedule returned/.test(document.querySelector("#schedule-error")?.textContent || ""));
    if ((await page.locator("#schedule-error").innerText()) !== "Schedule created: mock-second (ID 900002).") failures.push("second schedule status did not identify its created row");
    if (scheduleRequests.length !== 3 || scheduleRequests[2].key === scheduleRequests[1].key || scheduleRequests[2].body.name !== "mock-second") failures.push("second create request did not carry its distinct intent");

    if ((await submit.innerText()) === "Start new schedule") await submit.click();
    await page.getByLabel(/Idempotency key/).fill(firstKey);
    await page.getByLabel("Schedule name", { exact: true }).fill("mock-third");
    await submit.click();
    await page.waitForFunction(() => /Schedule (created|saved)|Existing schedule returned/.test(document.querySelector("#schedule-error")?.textContent || ""));
    if ((await page.locator("#schedule-error").innerText()) !== "Existing schedule returned: mock-first (ID 900001).") failures.push("idempotent replay did not identify the existing row");

    if (!await page.evaluate(() => {
      const control = document.querySelector("#schedule-payload");
      return control?.getAttribute("aria-describedby")?.split(/\s+/).includes("schedule-payload-hint")
        && document.getElementById("schedule-payload-hint") !== null;
    })) failures.push("schedule payload description reference is missing or dangling");

    const ids = Array.from({ length: 201 }, (_, i) => 900000 - i);
    let bulkRequests = 0;
    let bulkFinished;
    const bulkDone = new Promise((resolve) => { bulkFinished = resolve; });
    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/jobs?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("kind") !== "operator-bulk-mock") return route.continue();
      const offset = url.searchParams.has("before_id") ? 200 : 0;
      const jobs = ids.slice(offset, offset + 200).map((id) => ({ id }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs,
        next_before_id: offset === 0 ? String(ids[199]) : null }) });
    });
    await page.route("**/jobs/bulk", async (route) => {
      bulkRequests += 1;
      if (bulkRequests === 2) { await route.abort("failed"); bulkFinished(); return; }
      const { job_ids } = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        results: job_ids.map((id) => ({ id, status: "changed" })), processed: 100, remaining: 0,
      }) });
    });
    await page.goto(`${BASE}/dashboard/#/jobs?kind=operator-bulk-mock`);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Snapshot and review" }).click();
    await Promise.race([bulkDone, new Promise((resolve) => setTimeout(resolve, 5000))]);
    const bulkText = await page.locator("#bulk-result").innerText();
    if (!/201 outcomes: 100 changed, 100 uncertain, 1 not_attempted\./i.test(bulkText)) failures.push(`partial bulk outcomes were lost or mislabeled (${bulkRequests} intercepted requests): ${bulkText}`);
    assert.equal(bulkRequests, 2);

    assert.deepEqual(failures, []);
    process.stdout.write(`${JSON.stringify({ ok: true, schedule_transport: "mock-route; first response aborted, then retried", bulk_transport: "mock-route; second response aborted", schedule_requests: scheduleRequests.length, bulk_requests: bulkRequests })}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
