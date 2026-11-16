/* LeaseQ dashboard shell. Digest-pinned public assets only; API paths stay outside this worker's scope. */
'use strict';

// Increment the policy tag when changing worker behavior. Asset identity is
// derived from every pinned digest so an omitted manual release bump cannot
// overwrite a still-active shell cache.
const POLICY_VERSION = 'p3';
// Bump with policy/client changes. Unlike CACHE_NAME, this compact tab signal
// intentionally avoids a circular dependency on the assets it identifies.
const CLIENT_RELEASE = 'r10';
const CACHE_PREFIX = 'leaseq-dashboard-shell-';
const REQUIRED = [
  './', './manifest.webmanifest',
  './pages/privacy.html', './pages/terms.html', './pages/security-offline.html', './pages/cloud-sync.html',
  './assets/ui.css', './assets/app.css', './assets/trust.css', './assets/theme.js',
  './assets/profiles.js', './assets/platform.js', './assets/trust.js', './assets/app.js',
  './assets/simulator.js', './assets/interest.js',
  './assets/sync.js',
  './assets/favicon.svg', './assets/pwa-icon-180.png', './assets/pwa-icon-192.png',
  './assets/pwa-icon-512.png', './assets/pwa-maskable-192.png', './assets/pwa-maskable-512.png',
  './assets/plus-jakarta-sans.ttf', './assets/OFL-plus-jakarta-sans.txt',
  './assets/atkinson-hyperlegible-latin-400-normal.woff2',
  './assets/atkinson-hyperlegible-latin-700-normal.woff2', './assets/OFL.txt',
  './assets/sample/SOURCE.txt', './assets/sample/pride-and-prejudice-ch1.txt',
];
// Generated from the packaged files during release preparation.
const SHA256 = Object.freeze({
  './': '3035a4caf53f56915b8bf32c04235b7aa459f526e849b22b7ef47a4bb84bbc9d',
  './manifest.webmanifest': '237030fc793ba3b663020f629531cecd89d9cffb7389009360e08e71181c5e70',
  './pages/privacy.html': 'fcf24b03133cc9c98da6865c6ea94fa8397f29c8b347e328a1f6ed247f9b4e68',
  './pages/terms.html': 'd71e9bff0e8c2b5163f4b8a8a87500b06818894688e8634dbf74c7e1c51ca266',
  './pages/security-offline.html': '78b22dfd6180c08cd51b3ef1933af8c0a48e20ba60c43b648ccb5709a35d8dbb',
  './pages/cloud-sync.html': 'fbb11cd212911f36b7ef5fb71e8a1cf86897d00047d5d24bf91f4e2808a4d36e',
  './assets/ui.css': 'ee952cd91bc2ccdedccb46d5354064bef4971f9bfc143d339233f66c6c53b826',
  './assets/app.css': 'f5cd0eba1a676054a7139d797467318092d7c45b73387923e180c3968490aa19',
  './assets/trust.css': '8f6befaaf972d1caea2452351a2593d3c877475b9a8828ea0a57223d8ace6425',
  './assets/theme.js': '7fa908f0b4424acecda8c602ff1afbf09eba1ba410d2a2c78c1a0f74043bcb69',
  './assets/profiles.js': '979b7af49e179d9cf513cf1aeefb0d66cf271d7705f949b54e6b87b6af9c1dff',
  './assets/platform.js': '2dcd54a7867d42f1dbee88566aac7d3f127ac7fa996d3a28ba5bbc017834e041',
  './assets/trust.js': 'bd099c20a38bdf4d6657118dd52d1184199d67f1c1aee7d2b228b7e82513b488',
  './assets/app.js': '9c61a6c7eed55a1e741fd59aeac816adca4d4b88a9fafb39954153782d8290bb',
  './assets/simulator.js': '1e49fbdeac6bec639ff8006c491e51348aa447969938755431c551aeea7576b3',
  './assets/interest.js': '6419e62966b9d7960a335249172a2a39da6d8efd7ca622c43622810d1fb7db8b',
  './assets/sync.js': '9e3aa3a04443ca4768f51283c48aa2f08d97aa0d7ea120e90c78b125a84d2308',
  './assets/favicon.svg': 'e72bba498f46fd3cab26e1e431a6b46bc09d2601bd7a3ec110534f66f81e27af',
  './assets/pwa-icon-180.png': '88742db1d0558e3f979a647bd63c00b35673cd58d0fe6ad0d59c256c47c4402d',
  './assets/pwa-icon-192.png': '67889865b113934e49e6e63b2ec2a3f4e1250f7018495def139ef295d47dadf7',
  './assets/pwa-icon-512.png': '6a9906667bb7534770f5206c21fefd5ae3dcba1076262aa72560920b14a93b52',
  './assets/pwa-maskable-192.png': '25ffc70b1fb05eb5f5af54c28c96cfa8989fa1f4a92a1ccb70762180aa47d3bd',
  './assets/pwa-maskable-512.png': 'eb3ef9cb83b899e09c224cc768e108b751a6807884d49da7673763ea5e0704d1',
  './assets/plus-jakarta-sans.ttf': '89b3fb38aa0d275d7a731d0d817a4f1622b316b4d7fbdedcf02ee9099ff68bc8',
  './assets/OFL-plus-jakarta-sans.txt': '995c7199cab65954f545996326755daee7b63cc6b42b06c13da1f9502ab08a99',
  './assets/atkinson-hyperlegible-latin-400-normal.woff2': 'd64ba838ef5472bba248620ec4fd8b5aa7cf0db2908e0bb230600caf279ba7bc',
  './assets/atkinson-hyperlegible-latin-700-normal.woff2': '140e2bd25a7315c8a062508391426b0d8c3297400c947b8d847be28f73a199f0',
  './assets/OFL.txt': 'e137caeef2ff7c04fbf87078ad09cf3dcba8a3a58a4aa4e2f399d42c50bc4b18',
  './assets/sample/SOURCE.txt': '48c6f3eb264f12cb1d1b19b81d18fab75d80bc1df14af6dabceb217774631c2a',
  './assets/sample/pride-and-prejudice-ch1.txt': '7ef0c0fb64c590aa93b455a7285d264f2b70daa075355cd4b4b5bc7f5c56a93c',
});
const BUILD = `${POLICY_VERSION}-${REQUIRED.map((key) => SHA256[key]?.slice(0, 8) || 'missing00').join('')}`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD}`;
const EXPECTED_TYPES = new Map([
  ['.', 'text/html'], ['.webmanifest', 'manifest+json'], ['.html', 'text/html'],
  ['.css', 'text/css'], ['.js', 'javascript'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.txt', 'text/plain'],
]);
const scope = new URL(self.registration.scope);

function isInsideScope(url) { return url.origin === scope.origin && url.pathname.startsWith(scope.pathname); }
function keyFor(url) {
  if (url.pathname === scope.pathname) return './';
  return `./${url.pathname.slice(scope.pathname.length)}`;
}
function extension(path) { return path === './' ? '.' : path.slice(path.lastIndexOf('.')).toLowerCase(); }
async function validShellResponse(response, key) {
  if (!response?.ok || !Object.hasOwn(SHA256, key)) return false;
  const expectedType = EXPECTED_TYPES.get(extension(key));
  const actualType = (response.headers.get('content-type') || '').toLowerCase();
  if (!actualType.includes(expectedType) && !(['.ttf', '.woff2'].includes(extension(key)) && actualType.split(';')[0].trim() === 'application/octet-stream')) return false;
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return actual === SHA256[key];
}
async function fetchPinned(key) {
  const url = new URL(key, scope);
  const response = await fetch(url.href, { cache: 'reload', credentials: 'omit' });
  return await validShellResponse(response, key) ? response : null;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const pinned = [];
    for (const key of REQUIRED) {
      const response = await fetchPinned(key);
      if (!response) throw new Error(`Required offline asset unavailable or does not match ${BUILD}: ${key}`);
      pinned.push([new URL(key, scope), response]);
    }
    const existed = await caches.has(CACHE_NAME);
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const [url, response] of pinned) await cache.put(url, response);
    } catch (error) {
      // This name is content-versioned. Never delete a previously working cache
      // if storage fails while attempting to refresh an identical release.
      if (!existed) await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  // Keep the previous complete shell while old pages reload. Cleanup is requested
  // only after every open LeaseQ page reports the new pinned release ID.
  event.waitUntil(self.clients.claim());
});

function askClient(client, message, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve(null); }, timeoutMs);
    channel.port1.onmessage = (event) => { clearTimeout(timeout); channel.port1.close(); resolve(event.data || null); };
    client.postMessage(message, [channel.port2]);
  });
}
async function inScopeClients() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.filter((client) => { try { return isInsideScope(new URL(client.url)); } catch { return false; } });
}
async function pruneOldCachesIfAllClientsCurrent() {
  const clients = await inScopeClients();
  if (!clients.length) return false;
  const versions = await Promise.all(clients.map((client) => askClient(client, { type: 'LEASEQ_GET_BUILD' })));
  if (versions.some((version) => version?.build !== CLIENT_RELEASE)) return false;
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
  return true;
}
async function checkCache() {
  const cache = await caches.open(CACHE_NAME);
  const missing = [];
  for (const key of REQUIRED) {
    const cached = await cache.match(new URL(key, scope));
    if (!await validShellResponse(cached, key)) missing.push(key);
  }
  return { ready: missing.length === 0, missing };
}
async function repairCache() {
  const cache = await caches.open(CACHE_NAME);
  const missing = [];
  for (const key of REQUIRED) {
    const cached = await cache.match(new URL(key, scope));
    if (await validShellResponse(cached, key)) continue;
    const response = await fetchPinned(key);
    if (!response) { missing.push(key); continue; }
    try { await cache.put(new URL(key, scope), response); } catch { missing.push(key); }
  }
  return { ready: missing.length === 0, missing };
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'LEASEQ_CHECK_CACHE') {
    event.waitUntil(checkCache().then((result) => event.ports[0]?.postMessage(result)));
    return;
  }
  if (event.data?.type === 'LEASEQ_REPAIR_CACHE') {
    event.waitUntil(repairCache().then((result) => event.ports[0]?.postMessage(result)));
    return;
  }
  if (event.data?.type === 'LEASEQ_CLEAR_OWN_CACHE') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
      event.ports[0]?.postMessage({ cleared: true });
    })());
    return;
  }
  if (event.data?.type === 'LEASEQ_CLIENT_READY') {
    event.waitUntil(pruneOldCachesIfAllClientsCurrent().then((pruned) => event.ports[0]?.postMessage({ pruned })));
    return;
  }
  if (event.data?.type === 'LEASEQ_GET_BUILD') {
    event.ports[0]?.postMessage({ build: CLIENT_RELEASE });
    return;
  }
  if (event.data?.type === 'LEASEQ_APPLY_UPDATE') {
    event.waitUntil((async () => {
      const candidate = await checkCache();
      if (!candidate.ready) {
        event.ports[0]?.postMessage({ updated: false, reason: `The prepared update is incomplete (${candidate.missing.slice(0, 3).join(', ')}). Reconnect and prepare it again.` });
        return;
      }
      const clients = await inScopeClients();
      const checks = await Promise.all(clients.map((client) => askClient(client, { type: 'LEASEQ_CHECK_UPDATE_SAFE' })));
      const blocked = checks.find((result) => !result?.safe);
      if (checks.some((result) => !result?.safe) || checks.length !== clients.length) {
        event.ports[0]?.postMessage({ updated: false, reason: blocked?.reason || 'A LeaseQ tab did not confirm it is safe to reload.' });
        return;
      }
      event.ports[0]?.postMessage({ updated: true });
      await self.skipWaiting();
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.headers.has('authorization') || !isInsideScope(url)) return;
  const isNavigation = request.mode === 'navigate';
  const isShellAsset = url.pathname.startsWith(new URL('assets/', scope).pathname) || url.pathname.startsWith(new URL('pages/', scope).pathname) || url.pathname === new URL('manifest.webmanifest', scope).pathname;
  if (!isNavigation && !isShellAsset) return;
  event.respondWith((async () => {
    const key = isNavigation && url.pathname === scope.pathname ? './' : keyFor(url);
    if (!Object.hasOwn(SHA256, key)) return new Response('This LeaseQ page is not part of the offline shell. Reconnect and reload.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    const cache = await caches.open(CACHE_NAME);
    const pinned = await cache.match(new URL(key, scope));
    if (await validShellResponse(pinned, key)) return pinned;
    try {
      const response = await fetchPinned(key);
      if (!response) throw new Error('The network asset does not match the active shell.');
      await cache.put(new URL(key, scope), response.clone());
      return response;
    } catch {
      return new Response('This LeaseQ resource is missing or does not match the prepared offline version. Reconnect and reload to repair the shell.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
  })());
});
