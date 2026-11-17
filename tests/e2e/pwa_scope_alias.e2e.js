'use strict';
// Focused actual-worker regression; serves only the public packaged static files.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../docs');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.ttf':'font/ttf', '.txt':'text/plain' };
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const mount = ['/leaseq/-preview/', '/leaseq/', '/other/'].find(base => url.pathname.startsWith(base));
    if (!mount || req.method !== 'GET') { res.writeHead(404).end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(mount.length)) || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    const body=await fs.readFile(file);
    res.writeHead(200, {'content-type':mime[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache'}).end(body);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
async function message(page, type) {
  return page.evaluate(type => new Promise((resolve,reject) => {
    const channel = new MessageChannel();
    const timeout=setTimeout(()=>{channel.port1.close();reject(new Error(type+' timed out'));},8000);
    channel.port1.onmessage=event=>{clearTimeout(timeout);channel.port1.close();resolve(event.data);};
    navigator.serviceWorker.controller.postMessage({type},[channel.port2]);
  }),type);
}
async function ready(page,url) {
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal((await message(page,'LEASEQ_CHECK_CACHE')).ready,true);
}
(async()=>{
  let browser;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
    const context=await browser.newContext();
    await context.addInitScript(()=>{
      navigator.serviceWorker?.addEventListener('message',event=>{
        if (window.__silentUpdate && event.data?.type==='LEASEQ_CHECK_UPDATE_SAFE') event.stopImmediatePropagation();
      },{capture:true});
    });
    const main=await context.newPage(), alias=await context.newPage(), foreign=await context.newPage();
    const aliasRedirects=[];
    alias.on('response',response=>{
      if(new URL(response.url()).pathname==='/leaseq/index.html' && response.request().isNavigationRequest())
        aliasRedirects.push({status:response.status(),worker:response.fromServiceWorker(),location:response.headers().location});
    });
    await ready(main,base+'/leaseq/');
    await ready(alias,base+'/leaseq/index.html?entry=alias#/settings');
    assert.equal(alias.url(),base+'/leaseq/?entry=alias#/settings','online redirect retains query and fragment');
    assert.equal(await alias.locator('h1:visible').textContent(),'Settings');
    await ready(foreign,base+'/leaseq/-preview/');
    // Represent a still-open pre-canonicalization tab using the real History API;
    // its worker/client transport and dirty/silent checks remain unmodified.
    await alias.evaluate(()=>history.replaceState(null,'','/leaseq/index.html?entry=alias#/settings'));
    await alias.evaluate(()=>{document.getElementById('feedback-description-input').value='Unsaved alias regression draft';});
    assert.equal((await alias.evaluate(()=>LeaseQBeforeUpdate())).safe,false);
    assert.equal((await message(main,'LEASEQ_APPLY_UPDATE')).updated,false,'dirty explicit index tab vetoes update');
    await alias.evaluate(()=>{document.getElementById('feedback-description-input').value='';window.__silentUpdate=true;});
    assert.equal((await message(main,'LEASEQ_APPLY_UPDATE')).updated,false,'silent explicit index tab vetoes update');
    await alias.evaluate(()=>{window.__silentUpdate=false;});
    await context.setOffline(true);
    const offline=await alias.reload({waitUntil:'networkidle'});
    assert.equal(offline.status(),200);
    assert.equal(offline.fromServiceWorker(),true,'redirect destination uses pinned document offline');
    assert.equal(alias.url(),base+'/leaseq/?entry=alias#/settings','offline redirect retains query and fragment');
    assert.equal(await alias.locator('h1:visible').textContent(),'Settings');
    assert.ok(aliasRedirects.length>=2 && aliasRedirects.every(item=>item.status===307 && item.worker && item.location===base+'/leaseq/?entry=alias'));
    await context.setOffline(false);
    await alias.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const own='leaseq-shell-'+encodeURIComponent('/leaseq/')+':';
    const other='leaseq-shell-'+encodeURIComponent('/leaseq/-preview/')+':';
    const legacy='leaseq-dashboard-shell-unattributable-test';
    await main.evaluate(async({own,legacy})=>{
      await caches.open(own+'older-test');
      await caches.open(legacy);
    },{own,legacy});
    assert.equal((await message(main,'LEASEQ_CLIENT_READY')).pruned,true);
    const retained=await main.evaluate(()=>caches.keys());
    assert.ok(!retained.includes(own+'older-test'));
    assert.ok(retained.some(name=>name.startsWith(own)));
    assert.ok(retained.some(name=>name.startsWith(other)),'foreign mount survives prune');
    assert.ok(retained.includes(legacy),'unattributable legacy cache survives prune');
    assert.equal((await message(main,'LEASEQ_CLEAR_OWN_CACHE')).cleared,true);
    const cleared=await main.evaluate(()=>caches.keys());
    assert.ok(!cleared.some(name=>name.startsWith(own)));
    assert.ok(cleared.some(name=>name.startsWith(other)),'foreign mount survives clear');
    assert.ok(cleared.includes(legacy),'legacy cache survives clear');
    await context.setOffline(true);
    const otherOffline=await foreign.reload({waitUntil:'networkidle'});
    assert.equal(otherOffline.status(),200);
    assert.equal(otherOffline.fromServiceWorker(),true,'foreign mount remains usable offline');
    await context.close();
    console.log('PASS: actual-worker dirty/silent index alias, offline alias, scoped prune/clear, legacy retention, foreign offline shell');
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
