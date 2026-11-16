"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const { BASE_URL: BASE, API_TOKEN: TOKEN, JOB_ID: JOB, ARTIFACT_DIR: OUT, AXE_PATH } = process.env;
if (!BASE || !TOKEN || !JOB || !OUT || !AXE_PATH) throw new Error("Set BASE_URL, API_TOKEN, JOB_ID, ARTIFACT_DIR and AXE_PATH");
fs.mkdirSync(OUT, { recursive: true });
const axeSource = fs.readFileSync(AXE_PATH, "utf8");

const routes = [
  ["root", "#/", "Know what your queue is doing."],
  ["signup", "#/signup", "Create a local profile"],
  ["login", "#/login", "Log in to this browser"],
  ["app", "#/app", "Jobs"],
  ["app-detail", `#/app/jobs/${JOB}`, `Job ${JOB}`],
  ["jobs", "#/jobs", "Jobs"],
  ["filtered-jobs", "#/jobs?state=done&kind=word_count", "Jobs"],
  ["app-filtered-jobs", "#/app?state=done&kind=word_count", "Jobs"],
  ["detail", `#/jobs/${JOB}`, `Job ${JOB}`],
  ["submit", "#/submit", "New job"],
  ["operations", "#/operations", "Workers"],
  ["connection", "#/connection", "Settings"],
  ["missing-job", "#/jobs/9223372036854775806", "Job 9223372036854775806"],
  ["invalid-job", "#/jobs/not-a-number", "Invalid job ID"],
  ["not-found", "#/404-test", "Not found"],
];
const results = [];

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    for (const [width, height] of [[1440, 900], [375, 812]]) {
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light" });
        await context.addInitScript((value) => {
          if (value === "dark") localStorage.setItem("leaseq:theme:v1", "dark");
          else localStorage.removeItem("leaseq:theme:v1");
        }, theme);
        const page = await context.newPage();
        const errors = [], failed = [], httpErrors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
        page.on("requestfailed", (request) => failed.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText || "failed"}`));
        page.on("response", (response) => {
          if (response.status() >= 400) {
            const url = new URL(response.url());
            httpErrors.push({ path: url.pathname, status: response.status() });
          }
        });
        await page.goto(`${BASE}/dashboard/#/connection`);
        await page.getByLabel("API token", { exact: true }).fill(TOKEN);
        await page.getByRole("button", { name: "Use token", exact: true }).click();
        await page.getByRole("button", { name: "Forget token", exact: true }).first().waitFor();
        // Evaluate the local test library through DevTools; leave the app's
        // enforced Content Security Policy intact.
        await page.evaluate(axeSource);

        for (const [key, hash, heading] of routes) {
          await page.evaluate((value) => { location.hash = value; }, hash);
          await page.waitForTimeout(100);
          await page.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor();
          if (key === "detail") await page.locator("#result").filter({ hasText: '"words": 5' }).waitFor();
          if (key === "missing-job") await page.getByRole("heading", { level: 2, name: "No job 9223372036854775806 in this queue" }).waitFor();
          if (key === "operations") await page.getByRole("heading", { level: 2, name: "Schedules" }).waitFor();
          if (key === "filtered-jobs") {
            assert.equal(await page.locator(".lane[data-state=done]").getAttribute("aria-pressed"), "true");
            if (width < 600) assert.equal(await page.locator("details.filter-disclosure").getAttribute("open"), "");
          }
          const layout = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            theme: document.documentElement.dataset.theme || "light",
            shortTargets: [...document.querySelectorAll("#view button, #view a, #view input, #view select, #view textarea")]
              .filter((node) => {
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
              }).length,
          }));
          assert.equal(layout.width, width);
          assert.equal(layout.scrollWidth, width, `${width}x${height} ${theme} ${key} has document overflow`);
          assert.equal(layout.theme, theme === "dark" ? "dark" : "light");
          assert.equal(layout.shortTargets, 0, `${width}x${height} ${theme} ${key} has a touch target under 44px`);
          const axeReport = await page.evaluate(async () => {
            const report = await axe.run(document);
            const summarize = (items) => items.map((item) => ({
              id: item.id, impact: item.impact || null, nodes: item.nodes.length,
              descriptions: item.nodes.map((node) => ({ target: node.target,
                any: node.any.map((check) => check.message), all: node.all.map((check) => check.message),
                none: node.none.map((check) => check.message) })),
            }));
            return { violations: summarize(report.violations), incomplete: summarize(report.incomplete) };
          });
          const axe = axeReport.violations;
          const serious = axe.filter((violation) => ["serious", "critical"].includes(violation.impact));
          assert.deepEqual(serious, [], `${width}x${height} ${theme} ${key}: ${JSON.stringify(serious)}`);
          const file = path.join(OUT, `${width}x${height}-${theme}-${key}.png`);
          await page.screenshot({ path: file, animations: "disabled" });
          results.push({ width, height, theme, route: key, screenshot: file, axe_violations: axe,
            axe_incomplete: axeReport.incomplete, expected_http_errors: httpErrors });
        }

        if (width === 375 && theme === "dark") {
          await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
          await page.evaluate((value) => { location.hash = value; }, `#/jobs/${JOB}`);
          await page.getByRole("heading", { level: 1, name: `Job ${JOB}`, exact: true }).waitFor();
          const codeRegion = page.getByRole("region", { name: "Result" });
          await codeRegion.focus();
          const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
          assert.equal(layout.scroll, layout.width, "200% text caused page-level horizontal overflow");
          await page.screenshot({ path: path.join(OUT, "375x812-dark-200pct-keyboard-detail.png"), animations: "disabled" });

          await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
          await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
          await page.evaluate((value) => { location.hash = value; }, "#/jobs?state=done");
          await page.waitForTimeout(100);
          const doneLane = page.getByRole("button", { name: /^Done\b/ });
          await doneLane.focus();
          const media = await page.evaluate(() => ({
            forcedColors: matchMedia("(forced-colors: active)").matches,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
            transition: getComputedStyle(document.querySelector("#refresh-jobs")).transitionDuration,
            outlineWidth: getComputedStyle(document.querySelector('.lane[aria-pressed="true"]')).outlineWidth,
            outlineStyle: getComputedStyle(document.querySelector('.lane[aria-pressed="true"]')).outlineStyle,
            width: document.documentElement.clientWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          assert.equal(media.forcedColors, true);
          assert.equal(media.reducedMotion, true);
          assert.equal(media.transition, "0s");
          assert.equal(media.outlineWidth, "2px");
          assert.equal(media.outlineStyle, "solid");
          assert.equal(media.scroll, media.width, "forced colors caused page-level horizontal overflow");
          await page.screenshot({ path: path.join(OUT, "375x812-forced-colors-reduced-motion-keyboard.png"), animations: "disabled" });
        }
        const missingJobPath = "/jobs/9223372036854775806";
        const unexpectedHttp = httpErrors.filter(({ path, status }) => !(
          (path === "/jobs" && status === 401) ||
          ([missingJobPath, `${missingJobPath}/events`].includes(path) && status === 404)
        ));
        assert.deepEqual(unexpectedHttp, [], `${width}x${height} ${theme} unexpected HTTP failures`);
        assert.equal(httpErrors.some(({ path, status }) => path === "/jobs" && status === 401), true,
          "the unauthenticated Connection probe must remain private");
        assert.equal(httpErrors.some(({ path, status }) => path === missingJobPath && status === 404), true,
          "the nonexistent job route must be a real 404");
        assert.equal(httpErrors.some(({ path, status }) => path === `${missingJobPath}/events` && status === 404), true,
          "the nonexistent job events route must be a real 404");
        const expectedConsole = errors.filter((message) => /^Failed to load resource: the server responded with a status of (401|404)/.test(message));
        const unexpectedConsole = errors.filter((message) => !expectedConsole.includes(message));
        assert.equal(expectedConsole.length, httpErrors.length, `${width}x${height} ${theme} HTTP console messages do not match expected auth/not-found responses`);
        assert.deepEqual(unexpectedConsole, [], `${width}x${height} ${theme} unexpected console/page errors`);
        assert.deepEqual(failed, [], `${width}x${height} ${theme} failed requests`);
        await context.close();
      }
    }
    const report = { routes: routes.length, viewport_theme_cases: results.length, serious_or_critical_axe_violations: 0,
      console_errors: 0, failed_requests: 0,
      expected_auth_and_not_found_http_responses: results.reduce((sum, entry) => sum + entry.expected_http_errors.length, 0),
      enlarged_text_cases: 1, forced_colors_reduced_motion_cases: 1,
      special_screenshots: ["375x812-dark-200pct-keyboard-detail.png", "375x812-forced-colors-reduced-motion-keyboard.png"]
        .map((file) => path.join(OUT, file)),
      screenshots: [...results.map((entry) => entry.screenshot), ...[
        "375x812-dark-200pct-keyboard-detail.png", "375x812-forced-colors-reduced-motion-keyboard.png",
      ].map((file) => path.join(OUT, file))], results };
    fs.writeFileSync(path.join(OUT, "workstation-matrix.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ routes: report.routes, viewport_theme_cases: report.viewport_theme_cases,
      serious_or_critical_axe_violations: report.serious_or_critical_axe_violations, console_errors: 0, failed_requests: 0,
      expected_auth_and_not_found_http_responses: report.expected_auth_and_not_found_http_responses,
      enlarged_text_cases: report.enlarged_text_cases, forced_colors_reduced_motion_cases: report.forced_colors_reduced_motion_cases,
      screenshot_dir: OUT })}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
