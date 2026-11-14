import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL;
if (!baseUrl) throw new Error('Set BASE_URL to the live sandbox gateway console URL, for example http://127.0.0.1:8000/console/.');
const executablePath = process.env.CHROME_PATH;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const pageErrors = [];
const consoleErrors = [];
const httpFailures = [];
let cleanupCredential = null;
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400) httpFailures.push({ status: response.status(), url: response.url() });
});
const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const axeUrl = new URL('/console/test-axe.js', baseUrl).href;
// Serve only the pinned test dependency at same origin. App/API/worker responses remain real and unintercepted.
await page.route(axeUrl, (route) => route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: axeSource }));
const screenshotDir = process.env.SCREENSHOT_DIR || '/Users/anirudhyadav/Downloads/active/user-council-2026-11-14/leaseq/frontend/screenshots';
await mkdir(screenshotDir, { recursive: true });
const axeRuns = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshotUrlFor = (runId, origin) => new URL(`/sandbox/runs/${encodeURIComponent(runId)}`, origin).href;

async function checkAxe(label) {
  await page.addScriptTag({ url: axeUrl });
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  axeRuns.push({ label, violations: result.violations.length });
  assert.equal(result.violations.length, 0, `${label}: ${result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(',')).join('; ')}`).join(' | ')}`);
}

async function checkTargets(label) {
  const undersized = await page.evaluate(() => [...document.querySelectorAll('a[href], button, summary, input, select, textarea')]
    .filter((el) => {
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && (rect.width < 44 || rect.height < 44);
    })
    .map((el) => ({ name: el.getAttribute('aria-label') || el.textContent.trim(), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
  assert.deepEqual(undersized, [], `${label}: actionable targets under 44px: ${JSON.stringify(undersized)}`);
}

async function navigateView(label) {
  const width = page.viewportSize().width;
  if (width <= 720) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: label }).click();
  } else {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: label }).click();
  }
  await page.getByRole('heading', { level: 1, name: label }).waitFor();
}

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.match(await page.title(), /LeaseQ/);
  await page.getByRole('heading', { level: 1, name: 'Operations' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start sandbox run' }).count(), 1, 'initial page offers explicit start');
  assert.equal(await page.locator('.jobs-panel .count-label').innerText(), '—', 'a missing snapshot is not rendered as zero jobs');
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
  await page.keyboard.press('Tab');
  const firstTabTarget = await page.evaluate(() => ({ tag: document.activeElement.tagName, className: document.activeElement.className, text: document.activeElement.textContent.trim() }));
  assert.equal(firstTabTarget.className.includes('skip-link'), true, `first keyboard target is the skip link; received ${JSON.stringify(firstTabTarget)}`);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id === 'main-content'), true, 'skip link moves focus to main');

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    const dimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.body <= dimensions.viewport, `${width}px has horizontal page overflow (${dimensions.body}px)`);
    await checkAxe(`${width}px initial operations`);
    await checkTargets(`${width}px initial operations`);
    await page.screenshot({ path: `${screenshotDir}/operations-${width}.png`, fullPage: true });
    if (width === 320) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await checkAxe('320px open mobile navigation');
      await checkTargets('320px open mobile navigation');
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Chaos' }).click();
      await page.getByRole('heading', { level: 1, name: 'Chaos' }).waitFor();
      await page.goBack();
      await page.getByRole('heading', { level: 1, name: 'Operations' }).waitFor();
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Chaos' }).click();
  await page.getByRole('heading', { level: 1, name: 'Chaos' }).waitFor();
  await page.goBack();
  await page.getByRole('heading', { level: 1, name: 'Operations' }).waitFor();
  await page.getByRole('button', { name: 'Plans' }).click();
  await page.getByRole('dialog', { name: 'Plans under consideration' }).waitFor();
  await checkAxe('plans native dialog');
  await checkTargets('plans native dialog');
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.querySelector('dialog[open]')?.contains(document.activeElement)), true, 'Tab stays inside the native modal');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim() === 'Plans'), true, 'Escape restores focus to the opener');

  // This is an integration flow against the real gateway. It intentionally creates and cleans up a real run.
  let delayedFirstSnapshot = false;
  const runRoutePattern = '**/sandbox/runs/*';
  await page.route(runRoutePattern, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!delayedFirstSnapshot && route.request().method() === 'GET' && /^\/sandbox\/runs\/[^/]+$/.test(requestUrl.pathname)) {
      delayedFirstSnapshot = true;
      const actual = await route.fetch();
      await pause(3000);
      await route.fulfill({ response: actual });
    } else await route.continue();
  });
  const [createResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/sandbox/runs' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start sandbox run' }).click(),
  ]);
  cleanupCredential = await createResponse.json();
  assert.equal(createResponse.ok(), true, `real sandbox start returned HTTP ${createResponse.status()}: ${cleanupCredential.detail || 'no gateway detail'}`);
  await page.locator('.run-pill').waitFor({ timeout: 30000 });
  await page.getByText('Sandbox started · waiting for the first gateway snapshot.', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.connection-strip').innerText().then((text) => text.includes('Snapshot observed')), false, 'a delayed first response does not claim the gateway is connected');
  await page.getByText('Snapshot observed', { exact: false }).waitFor({ timeout: 6000 });
  assert.equal(delayedFirstSnapshot, true, 'the first snapshot was delayed while forwarding the real gateway response');
  await page.unroute(runRoutePattern);
  await page.getByRole('region', { name: 'Worker pool table' }).waitFor();

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await navigateView('Chaos');
    await checkAxe(`${width}px active Chaos`);
    await checkTargets(`${width}px active Chaos`);
    await navigateView('DLQ');
    await checkAxe(`${width}px active DLQ`);
    await checkTargets(`${width}px active DLQ`);
    const dimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.body <= dimensions.viewport, `${width}px active DLQ has horizontal page overflow`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigateView('Operations');
  await page.getByRole('button', { name: 'Add batch' }).click();
  await page.getByRole('status').filter({ hasText: /Added \d+ fixed synthetic jobs/ }).waitFor({ timeout: 15000 });
  await page.getByRole('status').filter({ hasText: '2 extra batches remain' }).waitFor();

  const jobLink = page.locator('.link-button').first();
  await jobLink.waitFor();
  await jobLink.click();
  const detailDialog = page.getByRole('dialog', { name: /^Job \d+$/ });
  await detailDialog.waitFor();
  await detailDialog.getByRole('heading', { name: 'Job event timeline' }).waitFor();
  await checkAxe('safe job detail dialog');
  await checkTargets('safe job detail dialog');
  assert.equal(await detailDialog.locator('.raw-evidence').evaluate((el) => el.open), false, 'raw JSON stays collapsed by default');
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.querySelector('dialog[open]')?.contains(document.activeElement)), true, 'detail dialog traps keyboard focus');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('link-button')), true, 'closing details returns focus to its job link');

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Chaos' }).click();
  await page.getByRole('button', { name: 'Check duplicate key' }).click();
  await page.getByRole('status').filter({ hasText: 'Key for original job' }).waitFor({ timeout: 15000 });

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'DLQ' }).click();
  const deadLetterLink = page.getByRole('region', { name: 'Dead letter queue table' }).locator('.link-button').first();
  await deadLetterLink.waitFor({ timeout: 30000 });
  await deadLetterLink.click();
  const deadDetail = page.getByRole('dialog', { name: /^Job \d+$/ });
  await deadDetail.waitFor();
  await deadDetail.locator('.status').filter({ hasText: 'DLQ' }).first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Chaos' }).click();

  const staleProof = page.locator('.evidence-list li').filter({ hasText: /stale completion/i });
  await staleProof.locator('.status-good').waitFor({ timeout: 45000 });
  const kill = page.getByRole('button', { name: 'Kill random leased worker' });
  await kill.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Kill random leased worker'));
    return button && !button.disabled;
  }, { timeout: 30000 });
  await kill.click();
  const killNotice = page.getByRole('status').filter({ hasText: 'Killed and replaced' });
  await killNotice.waitFor({ timeout: 20000 });
  const killedJob = (await killNotice.innerText()).match(/while it held (\d+)/)?.[1];
  assert.ok(killedJob, 'kill response identifies the leased job');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Operations' }).click();
  await page.waitForFunction((jobId) => {
    const row = [...document.querySelectorAll('.jobs-panel tbody tr')].find((item) => item.querySelector('.link-button')?.textContent.trim() === String(jobId));
    return row?.querySelector('.status')?.textContent.trim().startsWith('Completed') && row.cells[4]?.textContent.trim() === '1';
  }, killedJob, { timeout: 45000 });

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Evidence JSON' }).click()]);
  const downloadPath = await download.path();
  const evidence = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.ok(evidence.run_id);
  assert.ok(!('capability' in evidence) && !('database_url' in evidence) && !('process_env' in evidence), 'evidence omits capabilities and process internals');

  const snapshotUrl = new URL(`/sandbox/runs/${encodeURIComponent(cleanupCredential.run_id)}`, baseUrl).href;
  let delayNextSnapshot = true;
  let releaseStalledResponse;
  let completeStalledResponse;
  const stalledResponseReleased = new Promise((resolve) => { releaseStalledResponse = resolve; });
  const stalledResponseFinished = new Promise((resolve) => { completeStalledResponse = resolve; });
  await page.route(snapshotUrl, async (route) => {
    if (!delayNextSnapshot) return route.continue();
    delayNextSnapshot = false;
    try {
      const actual = await route.fetch();
      await stalledResponseReleased;
      await route.fulfill({ response: actual });
    } catch { /* the browser request is expected to be aborted at its real client timeout */ }
    finally { completeStalledResponse(); }
  });
  await page.getByRole('button', { name: 'Refresh gateway snapshot' }).click();
  const timeoutNotice = page.getByRole('status').filter({ hasText: `GET /sandbox/runs/${cleanupCredential.run_id} timed out after 7 seconds.` });
  await timeoutNotice.waitFor({ timeout: 9500 });
  assert.match(await timeoutNotice.innerText(), /Last successful snapshot:/, 'timeout marks the last displayed snapshot as stale');
  releaseStalledResponse();
  await stalledResponseFinished;
  await page.getByRole('button', { name: 'Retry snapshot' }).click();
  await page.getByText('Snapshot observed', { exact: false }).waitFor({ timeout: 10000 });
  await page.unroute(snapshotUrl);

  await page.getByRole('button', { name: 'Stop run' }).click();
  await page.getByRole('status').filter({ hasText: 'gateway confirmed owned process and database cleanup' }).waitFor({ timeout: 15000 });
  cleanupCredential = null;
  assert.equal(await page.getByRole('button', { name: 'Start sandbox run' }).count(), 1, 'stop clears the active run from the UI');

  const [expiredCreate] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/sandbox/runs' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Start sandbox run' }).click(),
  ]);
  cleanupCredential = await expiredCreate.json();
  assert.equal(expiredCreate.ok(), true, `second real run returned HTTP ${expiredCreate.status()}`);
  await page.getByText('Snapshot observed', { exact: false }).waitFor({ timeout: 30000 });
  const closedStatus = await page.evaluate(async ({ runId, capability }) => {
    const response = await fetch(`/sandbox/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${capability}`, 'X-LeaseQ-Sandbox': '1' },
      credentials: 'same-origin',
    });
    return response.status;
  }, { runId: cleanupCredential.run_id, capability: cleanupCredential.capability });
  assert.equal(closedStatus, 204, 'second run was deleted through the real gateway');
  await page.getByRole('status').filter({ hasText: 'Gateway reports that this run expired.' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.jobs-panel .count-label').innerText(), '—', 'a real 410 clears displayed job counts');
  const expiredPath = new URL(snapshotUrlFor(cleanupCredential.run_id, baseUrl)).pathname;
  const expiredResponses = httpFailures.filter((failure) => failure.status === 410 && new URL(failure.url).pathname === expiredPath);
  assert.equal(expiredResponses.length > 0, true, 'gateway returned a real expired-run 410');
  cleanupCredential = null;
  const unexpectedHttpFailures = httpFailures.filter((failure) => !(failure.status === 410 && new URL(failure.url).pathname === expiredPath));
  assert.deepEqual(unexpectedHttpFailures, [], JSON.stringify(unexpectedHttpFailures));
  assert.deepEqual(pageErrors, [], pageErrors.join('\n'));
  const expectedGoneDiagnostic = consoleErrors.filter((message) => /Failed to load resource:.*410 \(Gone\)/.test(message));
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource:.*410 \(Gone\)/.test(message));
  assert.equal(expectedGoneDiagnostic.length, expiredResponses.length, 'each closed-run 410 browser diagnostic matches the observed gateway response');
  assert.deepEqual(unexpectedConsoleErrors, [], unexpectedConsoleErrors.join('\n'));
  process.stdout.write(`${JSON.stringify({ result: 'pass', viewports: [320, 768, 1440], axe: axeRuns, pageErrors: pageErrors.length, consoleErrors: { expectedClosedRun410: expectedGoneDiagnostic.length, unexpected: unexpectedConsoleErrors.length }, httpFailures: { expectedClosedRun410: expiredResponses.length, unexpected: unexpectedHttpFailures.length }, screenshotDir, flow: ['real-start', 'three-second-real-snapshot-response', 'batch', 'duplicate', 'DLQ-detail', 'stale-completion-proof', 'SIGKILL-takeover', 'killed-job-completed-effect-one', 'evidence-download', 'seven-second-stale-snapshot-error', 'manual-retry-recovery', 'stop-cleanup', 'second-run-closed-410-cleared-client-state'] })}\n`);
} finally {
  if (page && !page.isClosed()) {
    const stopButton = page.getByRole('button', { name: 'Stop run' });
    if (await stopButton.count().catch(() => 0)) {
      await stopButton.click().catch(() => {});
      await page.getByRole('status').filter({ hasText: /cleanup/ }).waitFor({ timeout: 35000 }).catch(() => {});
    }
    const retryCleanup = page.getByRole('button', { name: 'Retry cleanup' });
    if (await retryCleanup.count().catch(() => 0)) {
      await retryCleanup.click().catch(() => {});
      await page.getByRole('status').filter({ hasText: /cleanup/ }).waitFor({ timeout: 35000 }).catch(() => {});
    }
    if (cleanupCredential?.run_id && cleanupCredential?.capability) {
      await page.evaluate(async ({ runId, capability }) => fetch(`/sandbox/runs/${encodeURIComponent(runId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${capability}`, 'X-LeaseQ-Sandbox': '1' },
        credentials: 'same-origin',
      }).then((response) => response.status), cleanupCredential).catch(() => {});
      cleanupCredential = null;
    }
  }
  await browser.close();
}
