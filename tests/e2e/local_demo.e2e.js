/* Real, explicitly enabled local PostgreSQL demo; never use a live/user queue. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3002';
const out = process.env.ARTIFACT_DIR || '/tmp/leaseq-local-demo-evidence';
fs.mkdirSync(out, {recursive:true});
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const errors = [], intentionalErrors = [], checks = [];
 let injectingDemoOutage = false;
 try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const tabs = [];
  for (const route of ['/workbench', '/leases', '/dead-letter']) {
   const page = await context.newPage(); tabs.push(page);
   page.on('pageerror', e => errors.push(String(e)));
   page.on('console', m => { if(m.type()!=='error') return; if(injectingDemoOutage && m.location().url===base+'/local-demo' && /503/.test(m.text())) intentionalErrors.push(m.text()); else errors.push(m.text()); });
   await page.goto(base+route);
   await page.getByRole('heading',{name:'Isolated local PostgreSQL demo',exact:true}).waitFor();
   if (route === '/workbench') {
    page.once('dialog',dialog => dialog.accept());
    await page.getByRole('button',{name:'Reset demo',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#local-demo-jobs article').length === 4);
   }
   await page.locator('#local-demo-jobs article').first().waitFor();
  }
  const [main, leases, failed] = tabs;
  assert.equal(await main.locator('#conn-status').innerText(),'Demo connected');
  assert.equal(await main.locator('#mode-label').innerText(),'Isolated PostgreSQL demo');
  const originalUrls = tabs.map(p => p.url());
  const snapshot = await main.request.get(base+'/local-demo').then(r=>r.json());
  assert.equal(snapshot.available, true);
  assert.ok(snapshot.jobs.length >= 4 && snapshot.jobs.length <= 12);
  assert.ok(snapshot.jobs.every(j => !('lease_token' in j)));
  await main.getByRole('button',{name:'Run Interactive Demo',exact:true}).click();
  await main.locator('#local-demo-status').filter({hasText:'Demo worker is running'}).waitFor();
  await main.getByRole('button',{name:'Simulate Worker Crash',exact:true}).click();
  await main.locator('#local-demo-status').filter({hasText:'Recovered:'}).waitFor({timeout:18000});
  const recovered = await main.request.get(base+'/local-demo').then(r=>r.json());
  assert.equal(recovered.stale_rejected,true);
  assert.notEqual(recovered.token_fingerprints.previous,recovered.token_fingerprints.current);
  const active = recovered.jobs.find(j => j.id === recovered.token_fingerprints.job_id);
  assert.equal(active.leased_by,'demo-recovery'); assert.ok(active.attempts>=2);
  assert.ok(active.events.some(e => e.event === 'rejected'));
  assert.deepEqual(tabs.map(p=>p.url()),originalUrls);
  await leases.reload(); await leases.locator('#local-demo-status').filter({hasText:'Recovered:'}).waitFor();
  await main.getByRole('button',{name:'Complete Active Lease',exact:true}).click();
  await main.getByRole('button',{name:'Enqueue Sample Job',exact:true}).click();
  await main.getByRole('button',{name:'Run Interactive Demo',exact:true}).click();
  await main.locator('#local-demo-status').filter({hasText:'Demo worker is running'}).waitFor();
  await main.getByRole('button',{name:'Complete Active Lease',exact:true}).click();
  await failed.getByRole('button',{name:'Replay Dead-Letter Job',exact:true}).click();
  await failed.getByText('No failed sample jobs.',{exact:false}).waitFor();
  checks.push('Real kill/expiry/reclaim/stale rejection, ordinary completion, real enqueue/replay, shared backend with three independent routes');
  for (const width of [320,375,768,1024,1440]) {
   await main.setViewportSize({width,height:1000});
   for (const route of ['/workbench','/leases','/dead-letter','/system']) {
    await main.goto(base+route); await main.locator('h1').waitFor();
    if (route!=='/system') await main.getByRole('heading',{name:'Isolated local PostgreSQL demo',exact:true}).waitFor();
    await main.evaluate(fs.readFileSync(require.resolve('axe-core'),'utf8'));
    const violations = await main.evaluate(async()=> (await axe.run()).violations.map(v=>v.id));
    assert.deepEqual(violations,[],`${width} ${route}`);
    assert.equal(await main.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await main.screenshot({path:`${out}/${width}-${route.replaceAll('/','')||'overview'}.png`});
   }
  }
  await main.goto(base+'/workbench'); await main.getByRole('button',{name:'Run Interactive Demo',exact:true}).waitFor();
  await main.locator('.wordmark a:visible').first().focus();
  await main.keyboard.press('Shift+Tab');
  assert.equal(await main.evaluate(()=>document.activeElement.classList.contains('skip')),true);
  await main.keyboard.press('Enter');
  assert.equal(await main.evaluate(()=>document.activeElement.id),'main');
  await main.goto(base+'/settings');
  const otherApps = main.locator('.workspace-utilities .suite-menu > summary');
  await otherApps.press('Enter');
  await main.locator('.workspace-utilities .suite-menu a').first().press('Escape');
  assert.equal(await main.locator('.workspace-utilities .suite-menu').getAttribute('open'),null);
  assert.equal(await otherApps.evaluate(el=>el===document.activeElement),true);
  checks.push('Secondary app links close with Escape and restore focus');
  await main.goto(base+'/leases'); await main.goto(base+'/dead-letter');
  await main.goBack(); assert.equal(new URL(main.url()).pathname,'/leases');
  await main.goForward(); assert.equal(new URL(main.url()).pathname,'/dead-letter');
  await main.goto(base+'/workbench'); await main.locator('#conn-status').filter({hasText:'Demo connected'}).waitFor();
  injectingDemoOutage = true;
  await main.route('**/local-demo', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Intentional demo outage'})}));
  await main.getByRole('button',{name:'Enqueue Sample Job',exact:true}).click();
  await main.locator('#conn-status').filter({hasText:'Demo disconnected'}).waitFor();
  assert.equal(await main.locator('#conn-status').getAttribute('class'),'conn warn');
  await main.unroute('**/local-demo');
  main.once('dialog',dialog=>dialog.accept());
  await main.getByRole('button',{name:'Reset demo',exact:true}).click();
  await main.waitForFunction(()=>document.querySelectorAll('#local-demo-jobs article').length===4 && document.querySelector('#conn-status')?.textContent==='Demo connected');
  injectingDemoOutage = false;
  checks.push('Demo outage uses warning state and real reset restores four samples');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(`${out}/result.json`,JSON.stringify({status:'PASS',checks,viewports:[320,375,768,1024,1440],routes:['/workbench','/leases','/dead-letter','/system'],errors,intentionalErrors},null,2));
  console.log('PASS actual queue engine flows, multi-tab, route refresh/history, 20 axe/overflow states, keyboard skip link');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
