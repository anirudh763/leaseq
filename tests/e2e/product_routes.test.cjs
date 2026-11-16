const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const location = { pathname: '/', search: '', hash: '', origin: 'http://127.0.0.1:3002' };
const context = { window: { location }, location, URL, URLSearchParams, Map, Set, Date, BigInt,
  document: { currentScript: { src: 'http://127.0.0.1:3002/dashboard/assets/app.js' }, querySelector: () => ({ content: '' }), addEventListener() {} },
  localStorage: { getItem: () => null } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../leaseq/dashboard/assets/app.js'), 'utf8'), context);

test('direct queue routes preserve isolated URL filters and legacy hash interpretation', () => {
  for (const [pathname, name, page] of [['/', 'jobs', 'overview'], ['/leases', 'operations', 'leases'], ['/dead-letter', 'jobs', 'dead-letter'], ['/system', 'system', 'system']]) {
    const route = context.parseLocation({ pathname, search: '?kind=email.send&worker=a', hash: '' });
    assert.equal(route.name, name);
    assert.equal(route.page, page);
    assert.equal(route.direct, true);
    assert.equal(route.params.get('kind'), 'email.send');
  }
  assert.equal(context.parseLocation({ pathname: '/dead-letter', search: '?state=queued', hash: '' }).params.get('state'), 'dead');
  assert.equal(context.parseLocation({ pathname: '/dashboard/', search: '', hash: '#/jobs/42' }).id, '42');
  assert.equal(context.parseLocation({ pathname: '/', search: '', hash: '#/login' }).name, 'login');
  assert.equal(context.parseLocation({ pathname: '/unknown', search: '', hash: '' }).name, 'notfound');
  assert.equal(context.parseLocation({ pathname: '/dashboard/', search: '', hash: '' }).name, 'landing');
});


test('static Pages keeps its landing, hash routes and script-relative sample path', () => {
  const hostedLocation = { pathname: '/leaseq/', search: '', hash: '', origin: 'https://example.test', href: 'https://example.test/leaseq/' };
  const hosted = { ...context, window: { location: hostedLocation }, location: hostedLocation,
    document: { currentScript: { src: 'https://example.test/leaseq/assets/app.js' }, querySelector: () => ({ content: 'none' }), addEventListener() {} } };
  vm.createContext(hosted);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../leaseq/dashboard/assets/app.js'), 'utf8'), hosted);
  assert.equal(hosted.parseLocation({ pathname: '/', hash: '' }).name, 'landing');
  assert.equal(hosted.parseLocation({ pathname: '/leaseq/', hash: '#/jobs' }).name, 'jobs');
  assert.equal(vm.runInContext('SAMPLE_TEXT', hosted), 'https://example.test/leaseq/assets/sample/pride-and-prejudice-ch1.txt');
});

test('manual token validation invalidates older anonymous reads and releases its pending guard', async () => {
  let respond;
  const tokenInput = { value:'test-only-authorization-value', setAttribute(){}, focus(){} };
  const tokenError = { textContent:'' };
  const auth = { ...context, window:{ location }, AbortSignal,
    fetch:() => new Promise(resolve => { respond=resolve; }),
    document:{ currentScript:{src:'http://127.0.0.1:3002/dashboard/assets/app.js'}, querySelector:()=>({content:''}), addEventListener(){}, getElementById:(id)=>id==='token-input'?tokenInput:tokenError } };
  vm.createContext(auth);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../leaseq/dashboard/assets/app.js'),'utf8'),auth);
  const before=vm.runInContext('app.authGen',auth);
  const pending=auth.submitToken({preventDefault(){}});
  assert.equal(vm.runInContext('app.authGen',auth),before+1,'Older anonymous 401 responses must become stale before token validation.');
  assert.equal(vm.runInContext('app.authPending',auth),before+1);
  respond({status:401}); await pending;
  assert.equal(vm.runInContext('app.authPending',auth),null);
  assert.equal(tokenError.textContent,'The server rejected this token.');
});

test('anonymous probe rejection preserves token entry while rejected credentials still redraw safely', () => {
  const auth = { ...context, window:{ location }, document:{ currentScript:{src:'http://127.0.0.1:3002/dashboard/assets/app.js'}, querySelector:()=>({content:''}), addEventListener(){}, getElementById:()=>({textContent:''}) } };
  vm.createContext(auth);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../leaseq/dashboard/assets/app.js'),'utf8'),auth);
  vm.runInContext(`app.route={name:'connection'}; app.conn='unknown'; app.token=null; var clears=0, redraws=0; hasSensitive=()=>true; clearSensitive=()=>{clears++;app.authGen++}; setConn=(state)=>{app.conn=state}; showBanner=()=>{}; renderView=()=>{redraws++}; handleUnauthorized();`,auth);
  assert.equal(vm.runInContext('clears',auth),1,'A 401 still clears all sensitive state.');
  assert.equal(vm.runInContext('redraws',auth),0,'An anonymous probe must not replace a token form the operator is editing.');
  vm.runInContext(`app.token='old-test-token'; handleUnauthorized();`,auth);
  assert.equal(vm.runInContext('redraws',auth),1,'Rejected credentials still rebuild protected content.');
});
