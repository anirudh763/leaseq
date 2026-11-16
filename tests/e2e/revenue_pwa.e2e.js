const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../docs');
const evidence = process.env.LEASEQ_EVIDENCE || path.resolve(__dirname, '../../artifacts/verification/post-restart/revenue-pwa');
const axeSource = fs.readFileSync(require.resolve('axe-core'), 'utf8');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
let interestEndpoint = '';
let unavailablePort = 0;
let probePort = 0;
const rejectedLiveJobs = [];
const staticServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(requestUrl.pathname);
  if(pathname==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,version:'fixture'}));return;}
  if(pathname==='/auth/check'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true}));return;}
  if(pathname==='/jobs'&&req.method==='POST'){let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>65536)req.destroy();});req.on('end',()=>{try{rejectedLiveJobs.push(JSON.parse(raw));}catch{}res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({detail:'fixture intentionally unavailable'}));});return;}
  if(['/jobs','/workers'].includes(pathname)){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({ok:true,counts:{total:0,queued:0,leased:0,done:0,dead:0},items:[],workers:[]}));return;}
  const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, body) => { if (err) { res.writeHead(404).end(); return; }
    if(pathname==='/'&&requestUrl.searchParams.has('interest-test')) body=Buffer.from(body.toString().replace('<meta name="leaseq-waitlist-endpoint" content="">',`<meta name="leaseq-waitlist-endpoint" content="${interestEndpoint}">`));
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache' }); res.end(body); });
});
const receiverBodies = [];
const receiver = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  let raw = ''; req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
  req.on('end', () => { try { receiverBodies.push(JSON.parse(raw)); } catch {} res.writeHead(200, { 'Content-Type':'application/json' }).end(JSON.stringify({ accepted:true })); });
});
const probe = http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','authorization,content-type,accept');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204).end();return;}res.writeHead(401,{'Content-Type':'application/json'}).end('{"detail":"authentication required"}');});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

(async () => {
  fs.mkdirSync(evidence, { recursive:true });
  const staticPort = await listen(staticServer);
  const receiverPort = await listen(receiver);
  const unavailableServer=http.createServer();unavailablePort=await listen(unavailableServer);await close(unavailableServer);
  probePort=await listen(probe);
  interestEndpoint = `http://127.0.0.1:${receiverPort}/interest`;
  const browser = await chromium.launch({ headless:true, ...(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : {}) });
  const report = { viewports:[], axe:[], apiRequests:[], interest:{}, pwa:{} };
  const errors = [];
  try {
    const base = `http://127.0.0.1:${staticPort}/`;
    const context = await browser.newContext({ acceptDownloads:true, serviceWorkers:'allow' });
    await context.addInitScript(() => { try { const sw=navigator.serviceWorker, original=sw.register.bind(sw); sw.register=(...args)=>original(...args).catch(error=>{window.__leaseqSwRegisterError=String(error);throw error;}); } catch {} });
    context.on('page', (page) => page.on('pageerror', (e) => errors.push(String(e))));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    let expectedLiveFailure = false;
    page.on('console', (m) => { if (m.type() === 'error' && !(expectedLiveFailure && /Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(m.text()))) errors.push(`console: ${m.text()}`); });
    page.on('requestfailed', (req) => { if (!(expectedLiveFailure && req.url().startsWith(`http://127.0.0.1:${unavailablePort}/`))) errors.push(`requestfailed: ${req.method()} ${req.url()} ${req.failure()?.errorText||''}`); });
    page.on('request', (req) => { if (/\/(?:healthz|jobs)(?:\/|\?|$)/.test(new URL(req.url()).pathname + new URL(req.url()).search)) report.apiRequests.push(req.url()); });
    for (const [width,height] of (process.env.LEASEQ_QUICK?[[1440,900]]:[[1440,900],[390,844],[412,915],[375,812]])) {
      for (const theme of (process.env.LEASEQ_QUICK?['light']:['light','dark'])) {
        await page.setViewportSize({ width,height });
        await page.goto(base + '#/', { waitUntil:'networkidle' });
        await page.evaluate((themeName) => { localStorage.setItem('leaseq:theme:v1',themeName);document.documentElement.setAttribute('data-theme',themeName); },theme);
        await page.waitForSelector('#run-lease-simulation');
        assert.equal(await page.locator('#mode-label').isVisible(), false, 'public landing hides backend status chrome');
        await page.getByRole('link', { name:'Create account' }).first().waitFor();
        await page.getByRole('link', { name:'Launch Workspace' }).first().waitFor();
        const landingShot=path.join(evidence,`revenue-landing-${width}-${theme}.png`);await page.screenshot({path:landingShot});await page.screenshot({path:landingShot.replace('.png','-full.png'),fullPage:true});
        await page.evaluate(axeSource);
        const landingAxe = await page.evaluate(async () => { const r=await axe.run(); const full=x=>x.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary,any:n.any.map(c=>c.message),all:n.all.map(c=>c.message),none:n.none.map(c=>c.message)}))})); return {violations:full(r.violations),incomplete:full(r.incomplete)}; });
        report.axe.push({route:'landing',width,height,theme,...landingAxe});
        assert.equal(landingAxe.violations.filter(v=>['critical','serious'].includes(v.impact)).length,0,JSON.stringify(landingAxe.violations));
        await page.locator('#hero-sim-text').fill('alpha beta\ngamma');
        await page.getByRole('button',{name:'Run recovery simulation'}).click();
        await page.getByText(/3 words and 2 lines/).waitFor();
        await page.getByRole('link',{name:'Continue in Browser Simulator'}).click();
        await page.waitForURL(/#\/app\?mode=simulator$/,{timeout:10000});
        await page.waitForSelector('#simulator-title',{timeout:10000}).catch(async()=>{const d=await page.evaluate(()=>({hash:location.hash,route:app.route,routeKey:app.routeKey,viewState:app.view,view:document.getElementById('view')?.innerText,mode:document.getElementById('mode-label')?.textContent}));await page.screenshot({path:path.join(evidence,`revenue-route-failure-${width}-${theme}.png`),fullPage:true});throw new Error(`Simulator route did not render: ${JSON.stringify({d,errors})}`);});
        await page.getByRole('heading',{name:'Browser Simulator'}).waitFor();
        const simulatorShot=path.join(evidence,`revenue-simulator-${width}-${theme}.png`);await page.screenshot({path:simulatorShot});await page.screenshot({path:simulatorShot.replace('.png','-full.png'),fullPage:true});
        const simAxe = await page.evaluate(async () => { const r=await axe.run(); const full=x=>x.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary,any:n.any.map(c=>c.message),all:n.all.map(c=>c.message),none:n.none.map(c=>c.message)}))})); return {violations:full(r.violations),incomplete:full(r.incomplete)}; });
        report.axe.push({route:'simulator',width,height,theme,...simAxe});
        assert.equal(simAxe.violations.filter(v=>['critical','serious'].includes(v.impact)).length,0,JSON.stringify(simAxe.violations));
        await page.locator('#simulator-reset').click();
        await page.waitForFunction(() => document.querySelector('#simulator-status')?.textContent === 'No simulated job has been enqueued.');
        for(const action of ['enqueue','claim-a','heartbeat','crash','advance','claim-b','stale','complete']) await page.locator(`[data-sim-action="${action}"]`).click();
        await page.getByText(/attempt 2 of 3; virtual clock 5000 ms/).waitFor();
        await page.locator('#simulator-state').getByText('3 words, 2 lines',{exact:true}).waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        assert.equal(overflow,false,`horizontal overflow ${width}/${theme}`);
        await page.goto(base+'#/app/connection',{waitUntil:'networkidle'});
        await page.getByRole('heading',{name:'Settings'}).waitFor();
        const settingsShot=path.join(evidence,`revenue-settings-${width}-${theme}.png`);await page.screenshot({path:settingsShot});await page.screenshot({path:settingsShot.replace('.png','-full.png'),fullPage:true});
        const settingsAxe=await page.evaluate(async()=>{const r=await axe.run();const full=x=>x.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary,any:n.any.map(c=>c.message),all:n.all.map(c=>c.message),none:n.none.map(c=>c.message)}))}));return{violations:full(r.violations),incomplete:full(r.incomplete)};});
        report.axe.push({route:'settings',width,height,theme,...settingsAxe});
        assert.equal(settingsAxe.violations.filter(v=>['critical','serious'].includes(v.impact)).length,0,JSON.stringify(settingsAxe.violations));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false,`Settings overflow ${width}/${theme}`);
        report.viewports.push({width,height,theme,overflow:false, simulator:'complete + fenced stale rejection',settingsOverflow:false});
      }
    }
    assert.deepEqual(report.apiRequests, [], 'Browser Simulator must make no queue API calls.');

    // Deliberate no-endpoint behavior: no registration request, local draft only.
    await page.goto(base + '#/', {waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Express interest'}).click();
    await page.locator('#interest-email').fill('operator@example.test');
    await page.locator('#interest-size').selectOption({label:'2–5'});
    await page.locator('#interest-use').fill('Evaluate worker queue recovery');
    await page.locator('#interest-submit').click();
    await page.getByText(/No endpoint is configured/).waitFor();
    assert.equal(receiverBodies.length,0);
    await page.locator('#interest-save-draft').click();
    await page.getByText(/Draft saved on this browser only/).waitFor();
    await page.locator('#team-interest-dialog').getByRole('button',{name:'Close'}).click();
    report.interest.unconfigured='no network; explicitly saved local draft; no enrollment claim';

    // Owned local receiver: only a positive JSON receipt is reported as received.
    const interestContext=await browser.newContext();const interestPage=await interestContext.newPage();
    interestPage.on('pageerror',(e)=>errors.push(String(e)));
    interestPage.on('requestfailed',(r)=>errors.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText||''}`));
    await interestPage.goto(base + '?interest-test#/',{waitUntil:'networkidle'});
    await interestPage.getByRole('button',{name:'Express interest'}).click();
    await interestPage.locator('#interest-email').fill('receiver@example.test');
    await interestPage.locator('#interest-size').selectOption({label:'2–5'});
    await interestPage.locator('#interest-use').fill('Verify explicit local receipt');
    await interestPage.locator('#interest-submit').click();
    await interestPage.getByText(/configured endpoint confirmed receipt/).waitFor({timeout:10000}).catch(async()=>{throw new Error(JSON.stringify({destination:await interestPage.locator('#interest-destination').textContent(),status:await interestPage.locator('#interest-status').textContent(),receiverBodies}));});
    assert.equal(receiverBodies.length,1);
    assert.deepEqual(Object.keys(receiverBodies[0]).sort(),['email','teamSize','useCase']);
    report.interest.localReceiver='1 request; explicit accepted:true acknowledgment; fields bounded and expected';
    await interestContext.close();

    // Manifest and scope are served from the same static app root.
    const manifest = await (await page.request.get(base+'manifest.webmanifest')).json();
    assert.equal(manifest.scope,'./'); assert.equal(manifest.theme_color,'#183b2b');
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, { timeout:15000 }).catch(async()=>{const details=await page.evaluate(async()=>({secure:isSecureContext,supported:'serviceWorker'in navigator,controller:!!navigator.serviceWorker?.controller,registrations:await navigator.serviceWorker?.getRegistrations().then(rs=>rs.map(r=>({scope:r.scope,active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state}))),registerError:window.__leaseqSwRegisterError,status:document.querySelector('#pwa-status-text')?.textContent}));throw new Error(JSON.stringify({serviceWorker:details,errors}));});
    const readiness=await page.evaluate(async()=>await window.LeaseQPlatform.checkOfflineReadiness());
    assert.equal(readiness.ready,true,JSON.stringify(readiness));
    await context.setOffline(true);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'Browser Simulator'}).waitFor().catch(async()=>{ await page.goto(base+'#/app?mode=simulator'); await page.getByRole('heading',{name:'Browser Simulator'}).waitFor(); });
    await page.getByRole('button',{name:'Run complete recovery sequence'}).click();
    await page.locator('#simulator-state').getByText('5 words, 2 lines',{exact:true}).waitFor();
    report.pwa={manifest:true,workerControlled:true,allPinnedAssetsReady:true,offlineSimulator:'usable from cache'};

    // Exercise the iOS install guide and share fallbacks with a mobile Safari
    // user-agent fixture. This is browser automation, not native-device proof.
    const iosContext=await browser.newContext({serviceWorkers:'allow',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',isMobile:true,hasTouch:true,viewport:{width:390,height:844}});
    await iosContext.addInitScript(()=>window.addEventListener('beforeinstallprompt',event=>event.stopImmediatePropagation(),{capture:true}));
    const iosPage=await iosContext.newPage();await iosPage.goto(base+'#/app/connection',{waitUntil:'networkidle'});
    await iosPage.locator('[data-pwa-ios-guide]').first().waitFor({state:'visible',timeout:10000}).catch(async()=>{throw new Error(JSON.stringify(await iosPage.evaluate(()=>({ua:navigator.userAgent,platform:navigator.platform,standalone:navigator.standalone,secure:isSecureContext,buttons:[...document.querySelectorAll('[data-pwa-ios-guide]')].map(button=>({hidden:button.hidden,disabled:button.disabled})),displayMode:matchMedia('(display-mode: standalone)').matches}))));});
    await iosPage.screenshot({path:path.join(evidence,'pwa-ios-install-fallback.png')});
    await iosPage.locator('[data-pwa-ios-guide]').first().click();await iosPage.locator('#install-guide').waitFor();assert.equal(await iosPage.locator('#install-guide').evaluate(el=>el.open),true);
    assert.match(await iosPage.locator('#install-guide').innerText(),/Choose Add to Home Screen/);await iosPage.locator('#install-guide-close').click();
    assert.equal(await iosPage.locator('#install-guide').evaluate(el=>el.open),false);assert.equal(await iosPage.evaluate(()=>document.activeElement===document.querySelector('[data-pwa-ios-guide]')),true);
    await iosPage.goto(base+'#/app/jobs/123?mode=live',{waitUntil:'networkidle'});await iosPage.locator('#share-job').waitFor();
    await iosPage.evaluate(()=>{Object.defineProperty(navigator,'share',{configurable:true,value:undefined});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value)=>{window.__leaseqCopiedShare=value;}}});});
    const shareResult=await iosPage.evaluate(()=>window.LeaseQPlatformShareJob('123'));assert.equal(shareResult.copied,true);assert.match(await iosPage.locator('#share-job-status').textContent(),/Job link copied/);assert.match(await iosPage.evaluate(()=>window.__leaseqCopiedShare),/#\/jobs\/123$/);
    report.pwa.installGuide='iOS Safari fallback dialog and focus return verified in UA fixture';report.pwa.share='clipboard fallback verified with local stub';
    await iosContext.close();

    // Feedback copy failure must leave a reviewable local draft and send no
    // issue or telemetry request.
    await context.setOffline(false);await page.locator('#pwa-status-close').click().catch(()=>{});await page.goto(base+'#/',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Send feedback'}).click();await page.locator('#feedback-dialog').waitFor();
    await page.locator('#feedback-description-input').fill('PWA copy fallback check');await page.locator('#feedback-steps-input').fill('Open the local feedback dialog.');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('clipboard denied');}}}));
    await page.locator('#feedback-copy').click();await page.getByText(/Clipboard unavailable/).waitFor();assert.match(await page.locator('#feedback-draft').inputValue(),/PWA copy fallback check/);
    await page.locator('#feedback-dialog').getByRole('button',{name:'Close'}).click();report.feedback='clipboard failure leaves reviewable draft; no send action performed';

    // Explicit Live API setup remains live when unavailable; it is never swapped for a fake success.
    await page.goto(base+'#/app/connection',{waitUntil:'networkidle'});
    await page.locator('#api-origin-input').fill(`http://127.0.0.1:${unavailablePort}`);
    expectedLiveFailure=true;
    await page.getByRole('button',{name:'Use Live API origin'}).click();
    await page.getByText(/No Live API answered/).waitFor({timeout:10000}).catch(()=>{});
    await page.waitForTimeout(3000);
    const modeLabel=await page.locator('#mode-label').textContent();
    assert.match(modeLabel,/Live API · unavailable/);
    assert.equal(await page.locator('#simulator-run-recovery').count(),0);
    report.liveFailure={mode:modeLabel,simulatorSubstitution:false};

    // Startup with an explicitly configured but unreachable service selects the
    // clearly labelled browser model. This is distinct from a failed mutation.
    const unreachableContext=await browser.newContext({serviceWorkers:'allow'}),unreachablePage=await unreachableContext.newPage();
    await unreachableContext.addInitScript(origin=>localStorage.setItem('leaseq:api-origin:v1',origin),`http://127.0.0.1:${unavailablePort}`);
    const unreachableRequests=[];unreachablePage.on('request',request=>{if(new URL(request.url()).port===String(unavailablePort))unreachableRequests.push(request.url());});
    await unreachablePage.goto(base+'#/app',{waitUntil:'networkidle'});
    await unreachablePage.getByRole('heading',{name:'Browser Simulator'}).waitFor({timeout:15000}).catch(async()=>{throw new Error(JSON.stringify({url:unreachablePage.url(),mode:await unreachablePage.locator('#mode-label').textContent(),banner:await unreachablePage.locator('#banner').textContent(),view:(await unreachablePage.locator('#view').innerText()).slice(0,500),failures:unreachableRequests}));});
    const fallbackMode=await unreachablePage.locator('#mode-label').textContent();assert.match(fallbackMode,/Browser Simulator/);
    await unreachablePage.getByRole('button',{name:'Run complete recovery sequence'}).click();
    await unreachablePage.locator('#simulator-status').getByText(/done; attempt 2 of 3/).waitFor();
    assert.equal(unreachableRequests.filter(url=>new URL(url).pathname==='/jobs').length,0);
    report.unreachableStartup={mode:fallbackMode,healthProbe:true,simulatorWorks:true,noQueueCalls:unreachableRequests.filter(url=>/\/(?:jobs|healthz)(?:\?|$)/.test(new URL(url).pathname)).length===1};
    assert.equal(report.unreachableStartup.noQueueCalls,true);
    await unreachableContext.close();

    // An HTTP 401 during first-load probing remains a live authorization error.
    const unauthorizedContext=await browser.newContext({serviceWorkers:'allow'}),unauthorizedPage=await unauthorizedContext.newPage();
    await unauthorizedContext.addInitScript(origin=>localStorage.setItem('leaseq:api-origin:v1',origin),`http://127.0.0.1:${probePort}`);
    await unauthorizedPage.goto(base+'#/app',{waitUntil:'networkidle'});
    await unauthorizedPage.getByText(/requires authorization/).waitFor({timeout:15000});
    const unauthorizedMode=await unauthorizedPage.locator('#mode-label').textContent();assert.match(unauthorizedMode,/Live API · authorization required/);
    assert.equal(await unauthorizedPage.locator('#simulator-run-recovery').count(),0);
    report.unauthorizedStartup={mode:unauthorizedMode,simulatorSubstitution:false};
    await unauthorizedContext.close();

    // An accepted token followed by a failed POST is never rewritten as a
    // synthetic local completion or replayed into the browser model.
    const mutationContext=await browser.newContext({serviceWorkers:'allow'}),mutationPage=await mutationContext.newPage();
    await mutationPage.goto(base+'#/app/connection',{waitUntil:'networkidle'});
    await mutationPage.locator('#api-origin-input').fill(base.slice(0,-1));
    await mutationPage.getByRole('button',{name:'Use Live API origin'}).click();
    await mutationPage.waitForFunction(()=>document.querySelector('#mode-label')?.textContent.includes('connected endpoint')&&document.querySelector('#conn-status')?.textContent.includes('Reading without token'));
    await mutationPage.locator('#token-input').fill('leaseq-fixture-token-0001');
    await mutationPage.getByRole('button',{name:'Use token'}).click();
    await mutationPage.waitForFunction(()=>document.querySelector('#conn-status')?.textContent.includes('Connected with token'),{timeout:10000}).catch(async()=>{throw new Error(JSON.stringify({conn:await mutationPage.locator('#conn-status').textContent(),tokenError:await mutationPage.locator('#token-error').textContent(),tokenLength:await mutationPage.locator('#token-input').inputValue().then(v=>v.length),mode:await mutationPage.locator('#mode-label').textContent(),origin:await mutationPage.locator('#api-origin-input').inputValue()}));});
    await mutationPage.goto(base+'#/app/submit?mode=live',{waitUntil:'networkidle'});
    await mutationPage.getByLabel('Text to count').fill('this write will be refused');
    await mutationPage.getByRole('button',{name:'Submit job'}).click();
    await mutationPage.getByText(/API refused the job \(HTTP 503\)/).waitFor({timeout:10000}).catch(async()=>{throw new Error(JSON.stringify({mode:await mutationPage.locator('#mode-label').textContent(),status:await mutationPage.locator('#wc-error').textContent().catch(()=>''),tokenStatus:await mutationPage.locator('#conn-status').textContent(),submitDisabled:await mutationPage.locator('#submit-job').isDisabled().catch(()=>true),submitted:rejectedLiveJobs.length,view:(await mutationPage.locator('#view').innerText()).slice(0,500)}));});
    assert.equal(await mutationPage.locator('#simulator-run-recovery').count(),0);
    assert.equal(rejectedLiveJobs.length,1);
    report.failedMutation={httpStatus:503,mode:'Live API',simulatorSuccess:false,requests:rejectedLiveJobs.length};
    await mutationContext.close();

    assert.deepEqual(errors,[]);
    report.errors=errors;
    fs.writeFileSync(path.join(evidence,'revenue-pwa-results.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({viewports:report.viewports.length,axe:report.axe.length,interest:report.interest,pwa:report.pwa,liveFailure:report.liveFailure,errors}));
    await context.close();
  } finally { await browser.close(); await close(probe); await close(receiver); await close(staticServer); }
})().catch((error) => { console.error(error); process.exitCode=1; });
