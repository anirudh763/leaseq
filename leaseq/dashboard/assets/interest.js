'use strict';
/* Optional early-access expression of interest. No endpoint means no network request. */
(() => {
  const dialog = document.getElementById('team-interest-dialog');
  const form = document.getElementById('team-interest-form');
  if (!dialog || !form) return;
  const endpointMeta = document.querySelector('meta[name="leaseq-waitlist-endpoint"]');
  const rawEndpoint = endpointMeta?.content.trim() || '';
  let endpoint = null;
  try {
    if (rawEndpoint) {
      const url = new URL(rawEndpoint);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use an HTTPS endpoint.');
      if (url.username || url.password || url.hash) throw new Error('Endpoint may not contain credentials or a fragment.');
      endpoint = url.href;
    }
  } catch { endpoint = null; }
  const status = document.getElementById('interest-status');
  const destination = document.getElementById('interest-destination');
  const submit = document.getElementById('interest-submit');
  const key = 'leaseq:early-access:draft:v1';
  if (destination) destination.textContent = endpoint ? `configured endpoint at ${new URL(endpoint).host}; no credentials are embedded` : 'not configured; no remote enrollment is available';
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('[data-open-team-interest]')) return;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved) {
        document.getElementById('interest-email').value = saved.email || '';
        document.getElementById('interest-size').value = saved.teamSize || '';
        document.getElementById('interest-use').value = saved.useCase || '';
      }
    } catch { /* continue without restoring a corrupt/unavailable draft */ }
    dialog.showModal(); document.getElementById('interest-email').focus();
  });
  dialog.addEventListener('close', () => document.querySelector('[data-open-team-interest]')?.focus());
  document.getElementById('interest-save-draft')?.addEventListener('click', () => {
    const draft = { email: document.getElementById('interest-email').value.trim(), teamSize: document.getElementById('interest-size').value, useCase: document.getElementById('interest-use').value.trim() };
    if (!draft.email || !draft.teamSize || !draft.useCase) { status.textContent = 'Complete all three fields to save this draft.'; return; }
    try { localStorage.setItem(key, JSON.stringify(draft)); status.textContent = 'Draft saved on this browser only. No request was sent and no enrollment was recorded.'; }
    catch { status.textContent = 'Browser storage is unavailable. Copy the details before closing if you want to keep them.'; }
  });
  submit?.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    if (!endpoint) { status.textContent = 'No endpoint is configured. Nothing was sent and no enrollment was recorded. Save the draft on this browser or close this form.'; return; }
    const body = { email: document.getElementById('interest-email').value.trim(), teamSize: document.getElementById('interest-size').value, useCase: document.getElementById('interest-use').value.trim() };
    submit.disabled = true; status.textContent = 'Sending this expression of interest to the configured endpoint…';
    try {
      const response = await fetch(endpoint, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      const declared=Number(response.headers.get('content-length')||0);
      if(declared>4096)throw new Error('The endpoint response is too large.');
      let acknowledgement = null; try { const raw=await response.text();if(raw.length<=4096)acknowledgement=JSON.parse(raw); } catch { /* a status without an explicit acknowledgement is not enrollment */ }
      if (!response.ok || !(acknowledgement?.accepted === true || acknowledgement?.ok === true)) throw new Error('The endpoint did not confirm receipt.');
      try { localStorage.removeItem(key); } catch { /* acknowledgement remains accurate */ }
      status.textContent = 'The configured endpoint confirmed receipt. This is an expression of interest, not access to a managed service.';
    } catch {
      status.textContent = 'The endpoint did not confirm receipt. Nothing is reported as enrolled; save a local draft or retry after checking the endpoint.';
    } finally { submit.disabled = false; }
  });
})();
