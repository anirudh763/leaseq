import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_static_site_build_is_simulator_only_and_digest_complete():
    result = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_static_site.py")], cwd=ROOT,
                            text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    out = ROOT / "docs"
    html = (out / "index.html").read_text()
    assert '<meta name="leaseq-api-base" content="none">' in html
    assert "LOCAL SIMULATION" in html or "Browser Simulator" in html
    assert (out / "og-card.png").is_file()
    static_manifest = json.loads((out / "manifest.webmanifest").read_text())
    assert {key: static_manifest[key] for key in ("id", "scope", "start_url")} == {"id": "./", "scope": "./", "start_url": "./#/"}
    assert "No endpoint is configured" in (ROOT / "leaseq" / "dashboard" / "assets" / "interest.js").read_text()
    worker = (out / "sw.js").read_text()
    required = re.search(r"const REQUIRED = \[(.*?)\];", worker, re.S)
    manifest = re.search(r"const SHA256 = Object.freeze\(\{(.*?)\}\);", worker, re.S)
    assert required and manifest
    keys = re.findall(r"'([^']+)'", required.group(1))
    hashes = dict(re.findall(r"'([^']+)': '([a-f0-9]{64})'", manifest.group(1)))
    assert len(keys) == len(hashes)
    for key in keys:
        path = out / ("index.html" if key == "./" else key.removeprefix("./"))
        assert path.is_file(), key
        assert hashlib.sha256(path.read_bytes()).hexdigest() == hashes[key], key


def test_dashboard_client_release_matches_worker_release():
    dashboard = ROOT / "leaseq" / "dashboard"
    platform = (dashboard / "assets" / "platform.js").read_text()
    worker = (dashboard / "sw.js").read_text()
    client = re.search(r"const SHELL_BUILD = '([^']+)'", platform)
    release = re.search(r"const CLIENT_RELEASE = '([^']+)'", worker)
    assert client and release
    assert client.group(1) == release.group(1)


def test_worker_required_asset_types_and_pinned_font_validation():
    dashboard = ROOT / "leaseq" / "dashboard"
    result = subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const dashboard = process.argv[1];
const context = vm.createContext({ URL, Response, crypto: require('node:crypto').webcrypto,
  self: { location: new URL('http://localhost/dashboard/sw.js'), registration: { scope: 'http://localhost/dashboard/' }, addEventListener() {} } });
vm.runInContext(fs.readFileSync(dashboard + '/sw.js', 'utf8'), context);
assert.equal(vm.runInContext('REQUIRED.every(key => EXPECTED_TYPES.has(extension(key)))', context), true,
  'Every pinned asset extension needs an explicit MIME validator');
(async () => {
  const valid = vm.runInContext('validShellResponse', context);
  for (const [key, fontType] of [
    ['./assets/plus-jakarta-sans.ttf', 'font/ttf'],
    ['./assets/atkinson-hyperlegible-latin-400-normal.woff2', 'font/woff2']]) {
  const font = fs.readFileSync(dashboard + '/' + key);
  for (const mime of [fontType, 'application/octet-stream']) {
    assert.equal(await valid(new Response(font, { headers: { 'content-type': mime } }), key), true);
  }
  assert.equal(await valid(new Response(font, { headers: { 'content-type': 'text/html' } }), key), false);
  assert.equal(await valid(new Response('corrupt font', { headers: { 'content-type': fontType } }), key), false);
  assert.equal(await valid(new Response('corrupt font', { headers: { 'content-type': 'application/octet-stream' } }), key), false);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
""", str(dashboard)], cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_worker_update_requires_every_client_to_reply_safely():
    result = subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(process.argv[1] + '/sw.js', 'utf8');
(async () => {
  for (const [name, replies, expected] of [
    ['all consent', [{safe:true}, {safe:true}], true],
    ['silent peer', [{safe:true}, null], false],
    ['dirty peer', [{safe:true}, {safe:false,reason:'Unsaved draft'}], false],
    ['invalid peer reply', [{safe:true}, {}], false]]) {
    const handlers = {}; let activated = 0, answer, pending;
    const context = vm.createContext({ URL, fixtureClients: replies.map(reply => ({reply})),
      self: {location:new URL('http://localhost/dashboard/sw.js'),registration:{scope:'http://localhost/dashboard/'},
        addEventListener: (type, handler) => {handlers[type] = handler;},
        skipWaiting: async () => {activated++;}} });
    vm.runInContext(source, context);
    // Isolate admission logic; the separate browser regression exercises real worker/client transport.
    vm.runInContext('checkCache=async()=>({ready:true}); inScopeClients=async()=>fixtureClients; askClient=async client=>client.reply;', context);
    handlers.message({data:{type:'LEASEQ_APPLY_UPDATE'}, ports:[{postMessage:value=>{answer=value;}}],
      waitUntil:promise=>{pending=promise;}});
    await pending;
    assert.equal(answer.updated, expected, name);
    assert.equal(activated, Number(expected), name + ': activation');
    if (name === 'dirty peer') assert.equal(answer.reason, 'Unsaved draft');
  }
})().catch(error => {console.error(error); process.exitCode=1;});
""", str(ROOT / "leaseq" / "dashboard")], cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_worker_canonical_scope_uses_only_pinned_frontend_paths():
    result = subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(process.argv[1] + '/sw.js', 'utf8');
(async () => {
  for (const [base, scope, canonical] of [['/dashboard/', '/', true], ['/dashboard/', '/dashboard/', false], ['/leaseq/', '/leaseq/', false]]) {
    const handlers = {}, fetched = [];
    const clients = [base, base+'pages/privacy.html', '/overview', '/settings', '/healthz', '/jobs', '/docs', '/missing'].map(path => ({url:'http://localhost'+path}));
    const context = vm.createContext({URL, Response, Headers, crypto:require('node:crypto').webcrypto,
      fetch:async (url, options)=>{fetched.push([url, options]); return new Response('invalid');},
      self:{location:new URL('http://localhost'+base+'sw.js'), registration:{scope:'http://localhost'+scope},
        clients:{matchAll:async()=>clients}, addEventListener:(type,handler)=>{handlers[type]=handler;}}});
    vm.runInContext(source, context);
    assert.equal(vm.runInContext('assetBase.pathname', context), base);
    const actual = (await vm.runInContext('inScopeClients()',context)).map(client=>new URL(client.url).pathname);
    assert.deepEqual(Array.from(actual), [base,base+'pages/privacy.html',...(canonical?['/overview','/settings']:[])]);
    await vm.runInContext("fetchPinned('./assets/app.js')",context);
    assert.equal(fetched[0][0], 'http://localhost'+base+'assets/app.js');
    assert.equal(fetched[0][1].credentials, 'omit');
    // Avoid a cache implementation: an intercepted request resolves to its selected pin.
    vm.runInContext("validShellResponse=async()=>true;",context);
    context.caches={open:async()=>({match:async url=>new Response(new URL(url).pathname)})};
    for (const [path, mode, method, auth, pin] of [
      [base,'navigate','GET',false,base],
      [base+'pages/privacy.html','navigate','GET',false,base+'pages/privacy.html'],
      ['/settings','navigate','GET',false,canonical?base:null],
      ['/overview','navigate','GET',false,canonical?base:null],
      ['/workbench','navigate','GET',false,canonical?base:null],
      ['/reports','navigate','GET',false,canonical?base:null],
      ['/leases','navigate','GET',false,canonical?base:null],
      ['/dead-letter','navigate','GET',false,canonical?base:null],
      ['/system','navigate','GET',false,canonical?base:null],
      ['/','navigate','GET',false,canonical?base:null],
      [base+'assets/app.js','cors','GET',false,base+'assets/app.js'],
      ...['/jobs','/jobs/x','/healthz','/readyz','/metrics','/auth/login','/docs','/openapi.json','/missing','/dashboard','/settings/missing',base+'assets/missing.js',base+'pages/missing.html'].flatMap(path=>['navigate','cors'].map(mode=>[path,mode,'GET',false,null])),
      [base+'assets/app.js','cors','GET',true,null], [base,'navigate','POST',false,null],
      ['https://other.invalid'+base,'navigate','GET',false,null]]) {
      let response;
      handlers.fetch({request:{url:path.startsWith('https:')?path:'http://localhost'+path,mode,method,headers:new Headers(auth?{authorization:'Bearer test'}:{})},respondWith:value=>{response=value;}});
      assert.equal(response !== undefined, pin !== null, `${scope}: ${method} ${mode} ${path} auth=${auth}`);
      if(response) assert.equal(await (await response).text(),pin);
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
""", str(ROOT / "leaseq" / "dashboard")], cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_platform_registers_backend_root_and_preserves_pages_namespace():
    result = subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(process.argv[1]+'/assets/platform.js','utf8');
for (const [base, setting, expected] of [['/dashboard/', '', '/'], ['/leaseq/', 'none', '/leaseq/'], ['/dashboard/', 'none', '/dashboard/']]) {
  let registration;
  const context=vm.createContext({URL, document:{currentScript:{src:'http://localhost'+base+'assets/platform.js'},
    querySelector:()=>({content:setting}),getElementById:()=>null,querySelectorAll:()=>[],addEventListener(){}},
    location:new URL('http://localhost/settings'),matchMedia:()=>({matches:false,addEventListener(){}}),
    navigator:{userAgent:'', serviceWorker:{addEventListener(){},register:(url,options)=>{registration={url,...options};return new Promise(()=>{});}}},
    window:{isSecureContext:true,addEventListener(){}}});
  vm.runInContext(source,context);
  assert.equal(registration.url,'http://localhost'+base+'sw.js');
  assert.equal(registration.scope,expected);
  assert.equal(registration.updateViaCache,'none');
  assert.equal(context.window.LeaseQPlatform.appRoot.pathname,base);
}
""", str(ROOT / "leaseq" / "dashboard")], cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_worker_exact_index_alias_votes_and_redirects_to_pinned_document():
    result = subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(process.argv[1]+'/sw.js','utf8');
(async()=>{
  for (const [base,scope] of [['/dashboard/','/'],['/dashboard/','/dashboard/'],['/leaseq/','/leaseq/']]) {
    const handlers = {}, voted = [];
    const clients = [{url:'https://example.test'+base,reply:{safe:true}},
      {url:'https://example.test'+base+'index.html',reply:{safe:false,reason:'busy alias'}},
      {url:'https://example.test'+base+'missing.html',reply:{safe:false}}];
    let activated=0, answer, pending;
    const context=vm.createContext({URL,Response,Headers,
      self:{location:new URL('https://example.test'+base+'sw.js'),registration:{scope:'https://example.test'+scope},
        clients:{matchAll:async()=>clients},skipWaiting:async()=>{activated++},
        addEventListener:(name,handler)=>{handlers[name]=handler;}}});
    vm.runInContext(source,context);
    context.vote=async client=>{voted.push(client.url);return client.reply;};
    vm.runInContext('checkCache=async()=>({ready:true});askClient=vote;',context);
    for (const reply of [{safe:false,reason:'busy alias'},null]) {
      clients[1].reply=reply; voted.length=0;
      handlers.message({data:{type:'LEASEQ_APPLY_UPDATE'},ports:[{postMessage:value=>{answer=value;}}],waitUntil:p=>{pending=p;}});
      await pending;
      assert.equal(answer.updated,false,base+': busy/silent index alias must veto');
      assert.equal(activated,0);
      assert.deepEqual(voted,clients.slice(0,2).map(client=>client.url));
    }
    vm.runInContext('validShellResponse=async()=>true;',context);
    context.caches={open:async()=>({match:async url=>new Response(new URL(url).pathname)})};
    assert.equal(vm.runInContext("keyFor(new URL('https://example.test'+assetBase.pathname+'index.html'))",context),'./');
    for (const suffix of ['index.html','index.html?route=public']) {
      let response;
      handlers.fetch({request:{url:'https://example.test'+base+suffix,mode:'navigate',method:'GET',headers:new Headers()},respondWith:value=>{response=value;}});
      assert.ok(response,base+': exact index alias must canonicalize offline');
      const redirect=await response;
      assert.equal(redirect.status,307);
      assert.equal(redirect.headers.get('location'),'https://example.test'+base+(suffix.includes('?')?'?route=public':''));
    }
    for(const path of [base+'index.html/private',base+'nested/index.html',base+'INDEX.html']) {
      let response;
      handlers.fetch({request:{url:'https://example.test'+path,mode:'navigate',method:'GET',headers:new Headers()},respondWith:value=>{response=value;}});
      assert.equal(response,undefined,'No broad index fallback: '+path);
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
""", str(ROOT / "leaseq" / "dashboard")], cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_worker_cleanup_preserves_other_mounts_and_unattributable_legacy_caches():
    result = subprocess.run(["node", "-e", r"""
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source=fs.readFileSync(process.argv[1]+'/sw.js','utf8');
function worker(base,scope=base) {
  const handlers={}, context=vm.createContext({URL,
    self:{location:new URL('https://example.test'+base+'sw.js'),registration:{scope:'https://example.test'+scope},
      clients:{matchAll:async()=>[{url:'https://example.test'+base}]},addEventListener:(name,handler)=>{handlers[name]=handler;}}});
  vm.runInContext(source,context);
  vm.runInContext('askClient=async()=>({build:CLIENT_RELEASE});',context);
  return {context,handlers,prefix:vm.runInContext('CACHE_PREFIX',context),name:vm.runInContext('CACHE_NAME',context)};
}
(async()=>{
  const workers=['/dashboard/','/leaseq/','/other/','/leaseq/-preview/','/dashboard/-copy/'].map(base=>worker(base));
  assert.equal(workers[0].prefix,worker('/dashboard/','/').prefix,'old and root backend registrations share asset namespace');
  assert.equal(new Set(workers.map(item=>item.prefix)).size,workers.length,'mounted deployments need distinct namespaces');
  for(const current of workers) {
    assert.ok(!current.prefix.startsWith('leaseq-dashboard-shell-'),'old worker cleanup must not match new caches');
    const foreign=workers.filter(item=>item!==current).map(item=>item.name);
    const legacy='leaseq-dashboard-shell-unattributable-build';
    let names=new Set([current.name,current.prefix+'older',...foreign,legacy,'unrelated-app']);
    current.context.caches={keys:async()=>[...names],delete:async name=>names.delete(name)};
    assert.equal(await vm.runInContext('pruneOldCachesIfAllClientsCurrent()',current.context),true);
    assert.deepEqual([...names].sort(),[current.name,...foreign,legacy,'unrelated-app'].sort());
    let pending,answer;
    current.handlers.message({data:{type:'LEASEQ_CLEAR_OWN_CACHE'},ports:[{postMessage:value=>{answer=value;}}],waitUntil:p=>{pending=p;}});
    await pending;
    assert.equal(answer.cleared,true);
    assert.deepEqual([...names].sort(),[...foreign,legacy,'unrelated-app'].sort());
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
""", str(ROOT / "leaseq" / "dashboard")], cwd=ROOT, text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
