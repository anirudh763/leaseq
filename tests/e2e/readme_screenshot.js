// Takes docs/screenshots/dashboard.png from a running stack with demo jobs:
//   BASE_URL=http://127.0.0.1:8000 API_TOKEN=... JOB=13 node tests/e2e/readme_screenshot.js
// Light theme, 1440x900 viewport, deviceScaleFactor 2. The token is typed into the
// dashboard's token dialog, as a person would.
"use strict";
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const base = process.env.BASE_URL || "http://127.0.0.1:8000";
  const out = process.env.OUT || path.join(__dirname, "..", "..", "docs", "screenshots", "dashboard.png");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
                                         colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(`${base}/dashboard/${process.env.JOB ? `?job=${process.env.JOB}` : ""}`);
  if (process.env.API_TOKEN) {
    await page.locator("#token-button").click();
    await page.getByLabel("API token", { exact: true }).fill(process.env.API_TOKEN);
    await page.getByRole("button", { name: "Use token" }).click();
    await page.locator("#operator-label").waitFor({ state: "visible" });
  }
  await page.waitForFunction(() => /^[1-9][0-9]*$/.test(document.querySelector('[data-count="all"]').textContent));
  if (process.env.JOB) await page.locator("#lease-rows tr").first().waitFor();
  await page.getByRole("button", { name: "Pause updates" }).click();   // freeze the frame
  await page.evaluate(() => document.activeElement.blur());
  await page.screenshot({ path: out });
  await browser.close();
  console.log(out);
})();
