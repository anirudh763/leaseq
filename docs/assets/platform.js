'use strict';
(() => {
  const SHELL_BUILD = 'r9';
  const script = document.currentScript;
  const appRoot = new URL('../', script?.src || location.href);
  const swUrl = new URL('sw.js', appRoot);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iosDevice = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const iosSafari = () => iosDevice() && /Safari/i.test(navigator.userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(navigator.userAgent);
  const status = document.getElementById('pwa-status');
  const statusText = document.getElementById('pwa-status-text');
  const checkButton = document.getElementById('pwa-status-check');
  const closeButton = document.getElementById('pwa-status-close');
  const installGuide = document.getElementById('install-guide');
  let deferredPrompt = null;
  let registration = null;
  let hasController = !!navigator.serviceWorker?.controller;
  let currentMessage = null;

  function setStatus(message, { check = false, updateWorker = null } = {}) {
    if (!status || !statusText) return;
    currentMessage = message;
    statusText.textContent = message;
    status.hidden = !message;
    if (checkButton) checkButton.hidden = !check;
    let updateButton = status.querySelector('[data-pwa-update]');
    if (updateWorker && !updateButton) {
      updateButton = document.createElement('button');
      updateButton.type = 'button'; updateButton.className = 'btn primary'; updateButton.dataset.pwaUpdate = '';
      updateButton.textContent = 'Apply update'; status.insertBefore(updateButton, closeButton || null);
    }
    if (!updateWorker && updateButton) updateButton.remove();
    if (updateButton && updateWorker) updateButton._waitingWorker = updateWorker;
  }

  function syncInstallControls() {
    const inApp = standalone();
    const showInstall = !inApp && !!deferredPrompt;
    const showGuide = !inApp && !deferredPrompt && iosSafari();
    document.querySelectorAll('[data-pwa-install]').forEach((button) => { button.hidden = !showInstall; button.disabled = !showInstall; });
    document.querySelectorAll('[data-pwa-ios-guide]').forEach((button) => { button.hidden = !showGuide; button.disabled = !showGuide; });
  }

  async function checkOfflineReadiness(repair = false) {
    const worker = navigator.serviceWorker?.controller || registration?.active;
    if (!worker) return { ready: false, missing: ['service worker does not control this page'] };
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve({ ready: false, missing: ['offline readiness check timed out'] }); }, 3000);
      channel.port1.onmessage = (event) => { clearTimeout(timeout); channel.port1.close(); resolve(event.data || { ready: false, missing: ['empty cache response'] }); };
      worker.postMessage({ type: repair ? 'LEASEQ_REPAIR_CACHE' : 'LEASEQ_CHECK_CACHE' }, [channel.port2]);
    });
  }

  async function reportConnectivity() {
    if (navigator.onLine) return;
    const result = await checkOfflineReadiness();
    if (result.ready && hasController) setStatus('Offline. The prepared shell, synthetic demo and bundled sample are available; real queue actions need the server.', { check: true });
    else setStatus('Offline. This app has not confirmed a complete cached shell. Reconnect to prepare it before relying on offline access.', { check: true });
  }

  function updateAvailable(worker) {
    if (!worker || !status) return;
    setStatus('Update available. Queue and API requests are never replayed; reloading clears the in-memory API token.', { updateWorker: worker });
  }

  function watchRegistration(reg) {
    registration = reg;
    if (reg.waiting && navigator.serviceWorker.controller) updateAvailable(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) updateAvailable(reg.waiting || installing);
      if (installing.state === 'redundant' && status) setStatus('The update could not be prepared completely. The previous app shell remains available; reconnect and try again later.');
      });
    });
  }

  async function requestUpdate(worker) {
    if (!worker) return;
    const button = status?.querySelector('[data-pwa-update]');
    if (button) { button.disabled = true; button.textContent = 'Checking open tabs…'; }
    const accepted = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve({ updated: false, reason: 'The update check timed out. Keep working and try again.' }); }, 8000);
      channel.port1.onmessage = (event) => { clearTimeout(timeout); channel.port1.close(); resolve(event.data || { updated: false, reason: 'The update did not respond.' }); };
      worker.postMessage({ type: 'LEASEQ_APPLY_UPDATE' }, [channel.port2]);
    });
    if (!accepted.updated) {
      if (button) { button.disabled = false; button.textContent = 'Apply update'; }
      setStatus(`Update delayed. ${accepted.reason || 'Finish or save work in every LeaseQ tab, then try again.'}`, { updateWorker: worker });
    }
  }

  async function install() {
    if (!deferredPrompt || standalone()) return;
    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    syncInstallControls();
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') setStatus('The browser accepted the install request. It will show the app if installation completes.');
      else setStatus('Install was dismissed. You can continue using LeaseQ in this browser.');
    } catch {
      setStatus('The browser could not open its install prompt. Continue using LeaseQ in this browser.');
    }
  }

  function openInstallGuide(trigger) {
    if (!installGuide || !iosSafari() || standalone()) return;
    installGuide.showModal();
    document.getElementById('install-guide-close')?.focus();
    installGuide.addEventListener('close', () => trigger?.focus(), { once: true });
  }

  function safeRoutePattern() {
    const route = location.hash.split('?')[0].split('/').filter(Boolean);
    return route.length ? `#/${route.map((part, i) => /^\d+$/.test(part) ? ':id' : part).join('/')}` : '#/';
  }
  function feedbackDraft() {
    const diagnostic = `LeaseQ ${document.getElementById('version')?.textContent || 'version unavailable'}\nViewport: ${innerWidth}×${innerHeight}\nRoute: ${safeRoutePattern()}`;
    const description = document.getElementById('feedback-description-input')?.value.trim() || '';
    const steps = document.getElementById('feedback-steps-input')?.value.trim() || '';
    return `${description}\n\nSteps to reproduce:\n${steps || '(not provided)'}\n\nDiagnostics:\n${diagnostic}`;
  }
  const feedback = document.getElementById('feedback-dialog');
  const feedbackDraftField = document.getElementById('feedback-draft');
  let feedbackTrigger = null;
  const refreshFeedback = () => {
    const diagnostic = `LeaseQ ${document.getElementById('version')?.textContent || 'version unavailable'}\nViewport: ${innerWidth}×${innerHeight}\nRoute: ${safeRoutePattern()}`;
    const diagnosticField = document.getElementById('feedback-diagnostics');
    if (diagnosticField) diagnosticField.value = diagnostic;
    if (feedbackDraftField) feedbackDraftField.value = feedbackDraft();
  };
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-feedback-open]');
    if (!trigger) return;
    feedbackTrigger = trigger;
    refreshFeedback();
    feedback?.showModal();
    document.getElementById('feedback-description-input')?.focus();
  });
  feedback?.addEventListener('close', () => {
    (feedbackTrigger?.isConnected ? feedbackTrigger : document.querySelector('[data-feedback-open]'))?.focus();
    feedbackTrigger = null;
  });
  for (const field of ['feedback-description-input', 'feedback-steps-input']) document.getElementById(field)?.addEventListener('input', refreshFeedback);
  document.getElementById('feedback-copy')?.addEventListener('click', async () => {
    refreshFeedback();
    try { await navigator.clipboard.writeText(feedbackDraftField.value); document.getElementById('feedback-status').textContent = 'Draft copied. Review it before sharing.'; }
    catch { feedbackDraftField.focus(); feedbackDraftField.select(); document.getElementById('feedback-status').textContent = 'Clipboard unavailable. Select and copy the reviewable draft above.'; }
  });
  document.getElementById('feedback-open')?.addEventListener('click', () => {
    refreshFeedback();
    const description = document.getElementById('feedback-description-input');
    if (!description?.value.trim()) { description?.focus(); document.getElementById('feedback-status').textContent = 'Add a description before opening a draft.'; return; }
    const url = new URL('https://github.com/anirudh763/leaseq/issues/new');
    url.searchParams.set('title', 'LeaseQ feedback'); url.searchParams.set('body', feedbackDraft());
    const opened = window.open(url.href, '_blank');
    if (opened) opened.opener = null;
    document.getElementById('feedback-status').textContent = opened ? 'GitHub draft opened. Review and submit it there; LeaseQ did not send it.' : 'Popup blocked. Copy the draft above and open the LeaseQ GitHub issue form manually.';
  });

  window.LeaseQPlatformShareJob = async (id) => {
    if (!/^\d{1,19}$/.test(String(id))) return { shared: false, reason: 'Invalid job link.' };
    const url = new URL('#/jobs/' + encodeURIComponent(id), location.origin + appRoot.pathname).href;
    const statusNode = document.getElementById('share-job-status');
    try {
      if (navigator.share) { await navigator.share({ title: `LeaseQ job ${id}`, url }); if (statusNode) statusNode.textContent = 'Share sheet closed. LeaseQ cannot tell whether it was sent.'; return { shared: true }; }
      await navigator.clipboard.writeText(url);
      if (statusNode) statusNode.textContent = 'Job link copied. Anyone opening it still needs access to the authorized server.';
      return { shared: false, copied: true };
    } catch (error) {
      if (error?.name === 'AbortError') { if (statusNode) statusNode.textContent = 'Sharing canceled.'; return { shared: false, canceled: true }; }
      if (statusNode) statusNode.textContent = `Copy this link to share: ${url}`;
      return { shared: false, url };
    }
  };

  window.LeaseQBeforeUpdate = async () => {
    if (location.pathname.startsWith(new URL('pages/', appRoot).pathname)) return { safe: true };
    const app = window.LeaseQGetUpdateState?.() || {};
    if (app.inFlight || app.submitInFlight || app.submitIntent || app.scheduleInFlight) return { safe: false, reason: 'Finish or safely resolve the current queue request before updating.' };
    let dirty = [...document.querySelectorAll('form:not(#filters) input,form:not(#filters) textarea,form:not(#filters) select')].some((field) => {
      if (field.readOnly || field.disabled) return false;
      if (field.type === 'password') return field.value.length > 0;
      if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked;
      return field.value !== (field.defaultValue ?? field.value);
    });
    if (dirty && app.profileDraftCanPersist && window.LeaseQFlushProfile?.()) dirty = false;
    if (dirty) return { safe: false, reason: 'Save or discard the edited form before updating.' };
    return { safe: true };
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.matches('[data-pwa-install]')) { event.preventDefault(); install(); }
    else if (target.matches('[data-pwa-ios-guide]')) { event.preventDefault(); openInstallGuide(target); }
    else if (target.matches('[data-pwa-update]')) { event.preventDefault(); requestUpdate(target._waitingWorker); }
    else if (target.id === 'pwa-status-check') {
      event.preventDefault();
      checkOfflineReadiness(navigator.onLine).then((result) => setStatus(result.ready && hasController
        ? 'Offline shell ready. Queue operations still require the authorized server.'
        : `Offline shell is not ready: ${(result.missing || []).slice(0, 3).join(', ')}. Reconnect and retry this check.`));
    } else if (target.id === 'pwa-status-close') { status.hidden = true; }
    else if (target.id === 'install-guide-close') { event.preventDefault(); installGuide.close(); }
  });

  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredPrompt = event; syncInstallControls(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; syncInstallControls(); setStatus('The browser reported that LeaseQ was installed.'); });
  const displayMode = matchMedia('(display-mode: standalone)');
  if (displayMode.addEventListener) displayMode.addEventListener('change', syncInstallControls);
  else displayMode.addListener?.(syncInstallControls);
  window.addEventListener('online', () => { setStatus('Connection restored. LeaseQ will contact the server only when you use a server-backed tool.'); });
  window.addEventListener('offline', reportConnectivity);
  closeButton?.addEventListener('click', () => { status.hidden = true; });
  syncInstallControls();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    const announceClientReady = () => {
      const worker = navigator.serviceWorker.controller;
      if (worker) worker.postMessage({ type: 'LEASEQ_CLIENT_READY' });
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const wasControlled = hasController;
      hasController = !!navigator.serviceWorker.controller;
      if (wasControlled && hasController) window.location.reload();
      else { announceClientReady(); checkOfflineReadiness().then((result) => {
        let seen = true;
        try { seen = sessionStorage.getItem('leaseq:pwa:v1:ready-notice') === '1'; } catch { /* private browsing can deny session storage */ }
        if (result.ready && !seen) {
          try { sessionStorage.setItem('leaseq:pwa:v1:ready-notice', '1'); } catch { /* the status remains available for this session */ }
          setStatus('Offline shell ready for this browser session. Real queue actions still need the authorized server.');
        }
      }); }
    });
    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event.data?.type === 'LEASEQ_GET_BUILD') { event.ports[0]?.postMessage({ build: SHELL_BUILD }); return; }
      if (event.data?.type !== 'LEASEQ_CHECK_UPDATE_SAFE') return;
      let result = { safe: false, reason: 'This tab could not verify its unsaved work.' };
      try { if (typeof window.LeaseQBeforeUpdate === 'function') result = await window.LeaseQBeforeUpdate(); }
      catch { result = { safe: false, reason: 'This tab could not verify its unsaved work.' }; }
      event.ports[0]?.postMessage(result);
    });
    navigator.serviceWorker.register(swUrl.href, { scope: appRoot.pathname, updateViaCache: 'none' })
      .then((reg) => { watchRegistration(reg); return navigator.serviceWorker.ready; })
      .then((reg) => { registration = reg || registration; announceClientReady(); return checkOfflineReadiness(); })
      .then((result) => { if (!result.ready && navigator.onLine) setStatus('The shell needs repair. Use Check offline readiness to verify and restore the exact current files.', { check: true }); })
      .catch(() => setStatus('Offline preparation is unavailable here. The online dashboard remains available.'));
  } else {
    setStatus('Offline preparation needs a secure context and service-worker support. The online dashboard remains available.');
  }

  window.LeaseQPlatform = Object.freeze({ appRoot, checkOfflineReadiness, syncInstallControls });
})();
