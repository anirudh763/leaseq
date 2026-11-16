'use strict';
(() => {
  const button = document.getElementById('clear-leaseq-data');
  if (!button) return;
  const status = document.getElementById('clear-data-status');
  button.addEventListener('click', async () => {
    if (!window.confirm('Remove LeaseQ browser profiles, saved preferences, quick-start progress and this app’s offline cache? This does not delete jobs on your LeaseQ server.')) return;
    let removedKeys = 0, removedCaches = 0, workerRemoved = false;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith('leaseq:')) { localStorage.removeItem(key); removedKeys++; }
      }
    } catch { status.textContent = 'Browser storage could not be fully cleared. Use this browser’s site data settings to remove LeaseQ data.'; return; }
    try {
      const names = await caches.keys();
      for (const name of names) if (name.startsWith('leaseq-dashboard-shell-') && await caches.delete(name)) removedCaches++;
    } catch { /* Continue with service-worker removal and report partial completion. */ }
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
      const ownScope = new URL('../', location.href).href;
      for (const registration of registrations) if (registration.scope === ownScope) workerRemoved = await registration.unregister() || workerRemoved;
    } catch { /* Current app data can be removed without unregistering. */ }
    const detail = `${removedKeys} LeaseQ storage entries and ${removedCaches} LeaseQ offline caches removed${workerRemoved ? '; this app’s service worker was unregistered' : ''}.`;
    status.textContent = detail;
    button.disabled = true;
  });
})();
