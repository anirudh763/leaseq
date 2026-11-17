/* Canonical workspaces against the actual local API; mutations use only /local-demo. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3002';
const OUT = process.env.ARTIFACT_DIR || path.resolve('artifacts/verification/canonical-persistence-20261116/browser');
const widths = [320, 375, 768, 1024, 1440];
const routes = [['/overview', 'Overview'], ['/workbench', 'Workbench'], ['/reports', 'Reports'], ['/settings', 'Settings']];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const errors = [], checks = [];
  try {
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const [route, title] of routes) {
        const response = await page.goto(BASE + route);
        assert.equal(response.status(), 200);
        await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
        if (route === '/reports') await page.locator('#report-json:not([disabled])').waitFor();
        await page.reload();
        await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
        assert.equal(await page.title(), `${title} – LeaseQ`);
        assert.equal(await page.locator('#rail nav [aria-current=page]').count(), 1);
        assert.equal(await page.locator('#rail [aria-current=page]').getAttribute('data-canonical'), route.slice(1));
        assert.equal(await page.locator('#rail nav a').count(), 4);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, route + ' overflow at ' + width);
        await page.evaluate(fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));
        assert.deepEqual(await page.evaluate(async () => (await axe.run(document)).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))), [], route + ' axe at ' + width);
        await page.screenshot({ path: `${OUT}/${title.toLowerCase()}-${width}.png`, fullPage: true });
      }
    }
    checks.push('20 direct/refresh/title/active-state/overflow/axe states including 320px');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/');
    await page.getByRole('heading', { level: 1, name: 'Overview', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Workbench', exact: true }).click();
    await page.goBack(); assert.equal(new URL(page.url()).pathname, '/');
    await page.goForward(); assert.equal(new URL(page.url()).pathname, '/workbench');
    await page.waitForFunction(() => document.activeElement.tagName === 'H1' && document.activeElement.textContent === 'Workbench');
    await page.getByRole('navigation', { name: 'Queue workflow' }).getByRole('link', { name: 'New job', exact: true }).click();
    const draft = 'Unsent local draft stays in this tab';
    await page.locator('#wc-text').fill(draft);
    for (const name of ['Reports', 'Settings', 'Workbench']) {
      await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name, exact: true }).click();
    }
    assert.equal(await page.locator('#wc-text').inputValue(), draft);
    assert.ok(!page.url().includes(encodeURIComponent(draft)));
    checks.push('Root alias, real navigation/history/heading focus and unsent draft preservation');
    await page.setViewportSize({ width: 375, height: 812 });
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await menu.click(); assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); assert.equal(await page.locator('#menu-sheet').evaluate(el => el.contains(document.activeElement)), true); }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#menu-sheet').open && document.querySelector('#menu-button').getAttribute('aria-expanded') === 'false');
    assert.equal(await menu.evaluate(el => el === document.activeElement), true);
    await menu.click(); await page.locator('#menu-sheet a[data-canonical=reports]').click();
    await page.waitForFunction(() => !document.querySelector('#menu-sheet').open && document.activeElement.tagName === 'H1');
    checks.push('Native mobile drawer containment, expanded state, Escape and navigation focus');

    await page.goto(BASE + '/workbench');
    await page.getByRole('heading', { name: 'Isolated local PostgreSQL demo', exact: true }).waitFor();
    const snapshot = await page.request.get(BASE + '/local-demo').then(response => response.json());
    assert.equal(snapshot.available, true);
    assert.ok(snapshot.jobs.length > 0 && snapshot.jobs.length <= 12);
    if (!snapshot.jobs.some(job => job.kind === 'localdemo.active' && job.state === 'queued')) await page.getByRole('button', { name: 'Enqueue Sample Job', exact: true }).click();
    await page.getByRole('button', { name: 'Run Interactive Demo', exact: true }).click();
    await page.locator('#local-demo-status').filter({ hasText: 'Demo worker is running' }).waitFor();
    await page.getByRole('button', { name: 'Simulate Worker Crash', exact: true }).click();
    await page.locator('#local-demo-status').filter({ hasText: 'Recovered:' }).waitFor({ timeout: 22000 });
    const recovered = await page.request.get(BASE + '/local-demo').then(response => response.json());
    assert.equal(recovered.stale_rejected, true);
    assert.notEqual(recovered.token_fingerprints.previous, recovered.token_fingerprints.current);
    const job = recovered.jobs.find(job => job.id === recovered.token_fingerprints.job_id);
    assert.ok(job.events.some(event => event.event === 'rejected'));
    await page.getByRole('button', { name: 'Complete Active Lease', exact: true }).click();
    checks.push('Actual PostgreSQL claim, worker crash, expiry/reclaim, stale rejection and completion; no database reset');
    await page.goto(BASE + '/reports');
    await page.locator('#report-json:not([disabled])').waitFor();
    await page.locator('#report-job').selectOption(String(job.id));
    const pending = page.waitForEvent('download'); await page.locator('#report-json').click();
    const evidence = JSON.parse(fs.readFileSync(await (await pending).path(), 'utf8'));
    assert.equal(evidence.job.id, job.id);
    assert.equal(evidence.source, 'Isolated local PostgreSQL demo');
    assert.ok(evidence.events.some(event => event.event === 'rejected'));
    assert.ok(!Object.hasOwn(evidence.job, 'lease_token') && !Object.hasOwn(evidence.job, 'payload'));
    const markdown = page.waitForEvent('download'); await page.locator('#report-markdown').click();
    assert.match(fs.readFileSync(await (await markdown).path(), 'utf8'), /Audit events/);
    checks.push('JSON/Markdown downloads read back actual selected job/event evidence without tokens or payloads');
    for (const route of ['/leases', '/dead-letter', '/system', '/dashboard/#/jobs', '/dashboard/#/submit', '/dashboard/#/connection']) {
      assert.equal((await page.request.get(BASE + route.split('#')[0])).status(), 200);
      await page.goto(BASE + route);
      await page.locator('#view h1').waitFor();
    }
    checks.push('Legacy product paths and dashboard hash links remain usable');
    for (const endpoint of ['/healthz', '/livez', '/readyz']) assert.equal((await page.request.get(BASE + endpoint)).status(), 200);
    for (const endpoint of ['/jobs', '/workers', '/metrics', '/api/system', '/reports/private']) assert.equal((await page.request.get(BASE + endpoint)).status(), 401);
    assert.equal((await page.request.get(BASE + '/dashboard/assets/missing.js')).status(), 404);
    checks.push('Actual health/readiness and protected API/missing-asset boundaries');
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ status: 'PASS', checks, widths, errors }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', checks: checks.length, axeStates: 20, widths, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
