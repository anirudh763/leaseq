// Takes the README screenshots from a running stack that has jobs in it:
//   BASE_URL=http://127.0.0.1:8000 API_TOKEN=... JOB=13 node tests/e2e/readme_screenshot.js
// Light theme (the default), deviceScaleFactor 2. The token is typed into the
// Connection screen, as a person would. Writes to docs/screenshots/:
//   jobs-1440.png, jobs-320.png            Jobs: state lanes + job table
//   job-details-1440.png, job-details-320.png  Job JOB: why waiting + lifecycle timeline
//   submit-1440.png                        Submit test job with the public-domain sample result
"use strict";
const path = require("node:path");
const { chromium } = require("playwright");

const base = process.env.BASE_URL || "http://127.0.0.1:8000";
const outDir = process.env.OUT_DIR || path.join(__dirname, "..", "..", "docs", "screenshots");
const job = process.env.JOB;

async function shoot(browser, width, route, file, prepare) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2,
                                         colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(`${base}/dashboard/#/connection`);
  await page.getByLabel("API token", { exact: true }).fill(process.env.API_TOKEN);
  await page.getByRole("button", { name: "Use token" }).click();
  await page.getByRole("button", { name: "Forget token" }).first().waitFor();
  await page.evaluate((r) => { window.location.hash = r; }, route);
  if (prepare) await prepare(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const out = path.join(outDir, file);
  await page.screenshot({ path: out, fullPage: width < 600 });
  console.log(out);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  const jobsReady = async (page) => {
    await page.waitForFunction(() => /^[1-9][0-9]*$/.test((document.querySelector('[data-count="all"]') || {}).textContent || ""));
    await page.getByRole("button", { name: "Pause updates" }).click();     // freeze the frame
  };
  const jobReady = async (page) => { await page.locator("#payload").waitFor(); };
  await shoot(browser, 1440, "#/jobs", "jobs-1440.png", jobsReady);
  await shoot(browser, 320, "#/jobs", "jobs-320.png", jobsReady);
  if (job) {
    await shoot(browser, 1440, `#/jobs/${job}`, "job-details-1440.png", jobReady);
    await shoot(browser, 320, `#/jobs/${job}`, "job-details-320.png", jobReady);
  }
  await shoot(browser, 1440, "#/submit", "submit-1440.png", async (page) => {
    await page.getByRole("button", { name: "Load sample text" }).click();
    await page.waitForFunction(() => document.getElementById("wc-text").value.startsWith("Chapter 1"));
    await page.getByRole("button", { name: "Submit job" }).click();
    await page.locator("#submit-result").filter({ hasText: /words/ }).waitFor({ timeout: 60000 });
  });
  await browser.close();
})();
