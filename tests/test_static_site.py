import hashlib
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
  self: { registration: { scope: 'http://localhost/dashboard/' }, addEventListener() {} } });
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
      self: {registration:{scope:'http://localhost/dashboard/'},
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
