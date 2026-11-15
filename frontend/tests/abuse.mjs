import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BASE_URL;
assert.ok(base, 'BASE_URL must identify the local sandbox console.');
const evidence = resolve(process.env.LEASEQ_ABUSE_EVIDENCE || '.test-artifacts/abuse.json');
const report = { checks: [], expectedHttpDiagnostics: [], pageErrors: [], allPassed: false };
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage();
let run;
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('response', response => {
  if ([413, 429].includes(response.status())) report.expectedHttpDiagnostics.push({ status: response.status(), path: new URL(response.url()).pathname });
});

async function request(path, method = 'GET', body) {
  return page.evaluate(async ({ path, method, body, capability }) => {
    const headers = { Accept: 'application/json' };
    if (capability) headers.Authorization = `Bearer ${capability}`;
    if (method !== 'GET') headers['X-LeaseQ-Sandbox'] = '1';
    const response = await fetch(path, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(30000) });
    return { status: response.status, retryAfter: response.headers.get('Retry-After'), json: await response.json().catch(() => ({})) };
  }, { path, method, body, capability: run?.capability });
}

try {
  await page.goto(base);
  let created = await request('/sandbox/runs', 'POST');
  if (created.status === 429) {
    const seconds = Number(created.retryAfter);
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60);
    await new Promise(done => setTimeout(done, (seconds + 1) * 1000));
    created = await request('/sandbox/runs', 'POST');
  }
  assert.equal(created.status, 200, 'A real isolated run must start before boundary checks.');
  run = created.json;
  assert.ok(typeof run.run_id === 'string' && typeof run.capability === 'string');
  const path = `/sandbox/runs/${encodeURIComponent(run.run_id)}`;

  // Change only this browser's clock. The real database and worker clocks remain untouched.
  await page.evaluate(() => { const realNow = Date.now.bind(Date); Date.now = () => realNow() + 86400000; });
  let snapshot;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await request(path);
    assert.equal(response.status, 200);
    snapshot = response.json;
    if (snapshot.jobs.some(job => job.state === 'leased')) break;
    await new Promise(done => setTimeout(done, 200));
  }
  assert.equal(snapshot.workers.length, 4);
  const leased = snapshot.jobs.find(job => job.state === 'leased');
  assert.ok(leased, 'Observe a real database lease.');
  const serverExpiry = Date.parse(leased.lease_expires_at);
  assert.ok(Math.abs(serverExpiry - Date.now()) < 15000, 'Lease expiry stays in the real server clock window.');
  assert.ok((await page.evaluate(() => Date.now())) - serverExpiry > 86000000, 'Browser clock is actually skewed.');
  report.checks.push({ name: 'browser clock skew leaves real PostgreSQL lease time authoritative', passed: true, scope: 'Client clock only; worker-clock and NOW() reclaim are covered by the native real-PostgreSQL test.' });

  const oversized = await request(`${path}/duplicate`, 'POST', 'x'.repeat(65537));
  assert.equal(oversized.status, 413);
  report.checks.push({ name: 'actual browser request above 64KiB is rejected before parsing', passed: true });

  let limited;
  for (let i = 0; i < 12; i++) {
    const response = await request(`${path}/duplicate`, 'POST');
    if (response.status === 429) { limited = response; break; }
    assert.equal(response.status, 200);
    assert.equal(response.json.created, false);
  }
  assert.ok(limited, 'The real mutation budget returns 429.');
  assert.ok(Number(limited.retryAfter) >= 1 && Number(limited.retryAfter) <= 60);
  report.checks.push({ name: 'actual browser mutation limit returns429 with bounded Retry-After', passed: true });

  const stopped = await request(path, 'DELETE');
  assert.equal(stopped.status, 204, 'The valid owner can clean up after quota exhaustion.');
  run = null;
  report.checks.push({ name: 'owner cleanup remains available after the mutation quota is exhausted', passed: true });
  assert.deepEqual(report.pageErrors, []);
  report.allPassed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (run) {
    const stopped = await request(`/sandbox/runs/${encodeURIComponent(run.run_id)}`, 'DELETE').catch(() => null);
    report.failureCleanupConfirmed = stopped?.status === 204;
    if (!report.failureCleanupConfirmed) { report.allPassed = false; process.exitCode = 1; }
  }
  await browser.close();
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checks: report.checks.length, allPassed: report.allPassed, evidence }));
}
