'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3002';
const envPath = path.resolve(__dirname, '../../../.local-state/launch.env');
const TOKEN = process.env.API_TOKEN || fs.readFileSync(envPath, 'utf8').match(/^LEASEQ_API_TOKEN=(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
if (!TOKEN) throw new Error('Set API_TOKEN or provide the task-owned launch environment.');
const OUT = path.resolve(__dirname, '../../artifacts/verification/post-restart/product-browser');
fs.mkdirSync(OUT, { recursive: true });
const AXE = require.resolve('axe-core/axe.min.js');
const routes = [['/', 'Live Queue Overview'], ['/leases', 'Active Workers and Lease/Lock Inspector'], ['/dead-letter', 'Failed Job Replay and Triage'], ['/system', 'Health and Metrics']];
const checks = [], axeReports = [], errors = [], failedAssets = [], consoleErrors = [], expectedConsole = [];
let controlledReadiness = false;
function captureConsole(message) {
  if (message.type() !== 'error') return;
  const text = message.text().split(TOKEN).join('[redacted]');
  const endpoint = new URL(message.location().url || BASE).pathname;
  const expected = (text.includes('401') && /^\/(jobs|workers|operations|schedules|auth)(\/|$)/.test(endpoint)) || (controlledReadiness && text.includes('503') && endpoint === '/readyz');
  (expected ? expectedConsole : consoleErrors).push({text, endpoint});
}
const pass = (name) => { checks.push(name); console.log('PASS '+name); };
async function api(endpoint, method='GET', body, extra={}) {
  const response = await fetch(BASE+endpoint, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type':'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, `Fixture API ${endpoint}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function localNavigate(page, url) {
  await page.evaluate((next) => { history.pushState(null, '', next); dispatchEvent(new PopStateEvent('popstate')); }, url);
}
async function connect(page) {
  await page.evaluate(() => { location.hash = '#/connection'; });
  await page.getByLabel('API token', { exact:true }).fill(TOKEN);
  await page.getByRole('button', { name:'Use token', exact:true }).click();
  await page.locator('#token-ok').waitFor();
}
(async () => {
 const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
 const context = await browser.newContext({ serviceWorkers:'block' });
 const page = await context.newPage();
 context.on('page', (tab) => { tab.on('pageerror', (e) => errors.push(String(e))); tab.on('console', captureConsole); });
 page.on('pageerror', (e) => errors.push(String(e)));
 page.on('console', captureConsole);
 page.on('response', (r) => { if (r.status() >= 400 && ['script','stylesheet','font','image'].includes(r.request().resourceType())) failedAssets.push(`${r.status()} ${r.url()}`); });
 const kind = 'product.route.'+Date.now();
 let active, dead;
 try {
  // A dedicated kind prevents claims from consuming unrelated queued jobs.
  dead = await api('/jobs','POST',{kind,payload:{note:'Owned route verification fixture'},max_attempts:1},{'Idempotency-Key':kind+'.dead'});
  const claimed = await api('/jobs/claim','POST',{worker_id:'product.route.worker',lease_seconds:600,kinds:[kind]});
  assert.equal(String(claimed.id),String(dead.id));
  await api(`/jobs/${dead.id}/fail`,'POST',{lease_token:claimed.lease_token,error:'Controlled route verification failure'});
  active = await api('/jobs','POST',{kind,payload:{note:'Owned lease inspection fixture'},max_attempts:3},{'Idempotency-Key':kind+'.active'});
  const lease = await api('/jobs/claim','POST',{worker_id:'product.route.worker',lease_seconds:600,kinds:[kind]});
  assert.equal(String(lease.id),String(active.id));
  for (const [route, heading] of routes) {
   for (const width of [320,768,1440]) {
    await page.setViewportSize({width,height:1000});
    await page.goto(BASE+route);
    await page.getByRole('heading',{level:1,name:heading,exact:true}).waitFor();
    await page.reload();
    await page.getByRole('heading',{level:1,name:heading,exact:true}).waitFor();
    await connect(page);
    await localNavigate(page,route);
    await page.getByRole('heading',{level:1,name:heading,exact:true}).waitFor();
    assert.ok((await page.title()).includes(heading));
    assert.equal(await page.locator('.profile-badge').count(),1);
    assert.ok(!(await page.locator('#mode-label').innerText()).includes('authorization required'));
    if(route==='/') await page.locator('#updated').filter({hasText:'Counts as of'}).waitFor();
    if(route==='/leases') await page.getByRole('link',{name:`Job ${active.id}`,exact:true}).waitFor();
    if(route==='/dead-letter') await page.getByRole('link',{name:`Job ${dead.id}`,exact:true}).waitFor();
    if(route==='/system') await page.getByText('HTTP requests',{exact:true}).waitFor();
    await page.evaluate(()=>document.fonts.ready);
    const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(size.scroll<=size.width+1,`${route} ${width}px overflow ${JSON.stringify(size)}`);
    await page.evaluate(fs.readFileSync(AXE, 'utf8'));
    const findings=await page.evaluate(()=>axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa','best-practice']}}));
    axeReports.push({route,width,violations:findings.violations});
    assert.equal(findings.violations.length,0,`${route} ${width}px axe: ${JSON.stringify(findings.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})))}`);
    const theme=await page.locator('html').getAttribute('data-theme');
    assert.equal(theme,'light');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--canvas').trim()),'#faf8f2');
    assert.match(await page.evaluate(()=>getComputedStyle(document.body).fontFamily),/Plus Jakarta Sans/);
    await page.screenshot({path:`${OUT}/${route.slice(1)||'overview'}-${width}.png`,fullPage:true});
    pass(`${route} direct/refresh/title/live data/axe/overflow ${width}px`);
   }
  }
  await localNavigate(page,'/');
  await page.getByRole('navigation',{name:'Main',exact:true}).getByRole('link',{name:'Leases',exact:true}).click();
  assert.equal(new URL(page.url()).pathname,'/leases');
  await page.goBack(); await page.getByRole('heading',{name:routes[0][1],exact:true}).waitFor();
  await page.goForward(); await page.getByRole('heading',{name:routes[1][1],exact:true}).waitFor();
  assert.equal(await page.locator(':focus').textContent(),routes[1][1]);
  pass('Path navigation and Back/Forward restore title and heading focus');
  await page.locator('.skip').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator(':focus').getAttribute('id'),'main');
  pass('Keyboard skip link focuses main');
  await localNavigate(page,`/dead-letter?kind=${kind}`);
  await page.getByRole('link',{name:`Job ${dead.id}`,exact:true}).click();
  await page.getByRole('button',{name:'Requeue job',exact:true}).waitFor();
  await page.getByRole('button',{name:'Requeue job',exact:true}).click();
  assert.equal(await page.locator('#confirm-dialog').evaluate(el=>el.open),true);
  assert.match(await page.locator('#confirm-text').innerText(),new RegExp(`Job ${dead.id}`));
  await page.locator('#confirm-no').click();
  assert.equal((await api(`/jobs/${dead.id}`)).state,'dead');
  await page.getByRole('button',{name:'Requeue job',exact:true}).click();
  await page.locator('#confirm-yes').click();
  await page.waitForFunction(()=>!document.querySelector('#requeue'));
  assert.equal((await api(`/jobs/${dead.id}`)).state,'queued');
  pass('Dead job details and protected requeue confirmation/cancel/success');
  const second=await context.newPage(); await second.goto(BASE+'/'); await connect(second); await localNavigate(second,`/?kind=${kind}&worker=product.route.worker`);
  await second.getByRole('link',{name:`Job ${active.id}`,exact:true}).waitFor();
  await localNavigate(page,'/leases');
  const secondUrl=second.url();
  await page.getByRole('link',{name:`Job ${active.id}`,exact:true}).click();
  await page.getByRole('button',{name:'Cancel job',exact:true}).click();
  await page.locator('#confirm-yes').click();
  await page.getByRole('button',{name:'Requeue job',exact:true}).waitFor();
  await second.bringToFront();
  await second.getByRole('row').filter({has:second.getByRole('link',{name:`Job ${active.id}`,exact:true})}).getByText('Dead',{exact:true}).waitFor();
  assert.equal(second.url(),secondUrl);
  assert.equal(await second.getByLabel('Kind',{exact:true}).inputValue(),kind);
  pass('Two authenticated tabs preserve filters during shared job mutation');
  await second.close(); await page.bringToFront();
  await page.evaluate(()=>{location.hash='#/submit'});
  await page.getByLabel('Job kind',{exact:true}).fill(kind);
  await page.getByLabel('JSON object payload',{exact:true}).fill('{"note":"Submitted by product-route browser test"}');
  await page.getByRole('button',{name:'Submit job',exact:true}).click();
  const created=page.getByRole('link',{name:/^Open job /}); await created.waitFor();
  pass('Job submission uses the actual authenticated API');
  await localNavigate(page,'/system');
  await page.getByText('Prometheus metric samples',{exact:true}).click();
  await page.getByRole('region',{name:'Prometheus metric samples'}).focus(); await page.keyboard.press('ArrowDown');
  assert.match(await page.getByRole('region',{name:'Prometheus metric samples'}).innerText(),/# (HELP|TYPE)/);
  pass('Authenticated health and keyboard-accessible Prometheus samples');
  controlledReadiness = true;
  await page.route('**/readyz',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({status:'not_ready'})}));
  await page.getByRole('button',{name:'Refresh health',exact:true}).click();
  await page.getByText('HTTP 503 · not_ready',{exact:true}).waitFor();
  pass('Controlled readiness failure stays visible');
  await page.getByRole('button',{name:'Forget token',exact:true}).click();
  await page.getByRole('link',{name:'Enter the API token',exact:true}).waitFor();
  assert.equal(await page.getByText('HTTP requests',{exact:true}).count(),0);
  const stores=await page.evaluate(()=>[localStorage,sessionStorage].map(store=>Object.keys(store).map(key=>[key,store.getItem(key)])));
  assert.ok(!JSON.stringify(stores).includes(TOKEN));
  pass('Forget token clears protected operational state and no token persists');
  assert.deepEqual(errors,[]); assert.deepEqual(failedAssets,[]); assert.deepEqual(consoleErrors,[]);
  console.log(JSON.stringify({passed:checks.length,checks,errors,failedAssets,consoleErrors,expectedConsole},null,2));
 } finally {
  fs.writeFileSync(`${OUT}/report.json`,JSON.stringify({checks,axeReports,errors,failedAssets,consoleErrors,expectedConsole},null,2));
  await browser.close();
  // No queue-wide cleanup; only task-owned custom-kind fixtures remain as audit evidence.
 }
})().catch(error=>{console.error(String(error.stack||error).split(TOKEN).join('[redacted]'));process.exitCode=1});
