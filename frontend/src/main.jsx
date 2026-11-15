import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowLeftRight, Check, ChevronRight,
  CircleHelp, Clock3, Copy, Database, ExternalLink, HeartPulse, Layers3, LoaderCircle,
  Menu, PackageOpen, Plus, RefreshCw, ShieldCheck, Skull, Square, X,
} from 'lucide-react';
import './style.css';
import { evidenceExport, formatMetric, summarize, validateAction, validateCreatedRun, validateJobDetail, validateSnapshot } from './state.js';

const API = '/sandbox/runs';
const views = [
  { id: 'operations', label: 'Jobs', Icon: Activity },
  { id: 'chaos', label: 'Recovery', Icon: Skull },
  { id: 'dlq', label: 'Dead letters', Icon: PackageOpen },
];
const metricIcons = [HeartPulse, Layers3, Clock3, ShieldCheck, Database];
const num = formatMetric;
const date = (v) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const safe = (v) => v === undefined || v === null || v === '' ? '—' : String(v);

class ApiError extends Error {
  constructor(status, method, path, detail) {
    super(`${method} ${path} returned ${status}: ${detail}`);
    this.status = status;
  }
}

function App() {
  const [view, setView] = useState(() => location.hash.replace(/^#\/?/, '') || 'operations');
  const [snapshot, setSnapshot] = useState(null);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingCleanup, setPendingCleanup] = useState(false);
  const [batchesRemaining, setBatchesRemaining] = useState(null);
  const epoch = useRef(0);
  const refreshController = useRef(null);
  const actionController = useRef(null);
  const headingRef = useRef(null);
  const snapshotRef = useRef(null);
  const snapshotFailure = useRef(false);
  const detailRequest = useRef(0);
  const cleanupRun = useRef(null);

  useEffect(() => {
    const change = () => {
      const route = location.hash.replace(/^#\/?/, '');
      setView(views.some((item) => item.id === route) ? route : 'operations');
    };
    addEventListener('hashchange', change);
    if (!views.some((item) => item.id === view)) location.hash = '#/operations';
    return () => removeEventListener('hashchange', change);
  }, []);

  useEffect(() => {
    const label = views.find((item) => item.id === view)?.label ?? 'Operations';
    document.title = `${label} – LeaseQ`;
    headingRef.current?.focus();
  }, [view]);

  const request = useCallback(async (path, { method = 'GET', capability, signal, timeoutMs = 8000 } = {}) => {
    const headers = { Accept: 'application/json' };
    if (capability) headers.Authorization = `Bearer ${capability}`;
    if (method !== 'GET') headers['X-LeaseQ-Sandbox'] = '1';
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(path, { method, headers, signal: requestSignal, credentials: 'same-origin' });
    let body = {};
    try { body = await response.json(); } catch { /* preserve the actual HTTP status */ }
    if (!response.ok) {
      const detail = body.detail || body.message || response.statusText || 'Request failed';
      throw new ApiError(response.status, method, path, detail);
    }
    return body;
  }, []);

  const refresh = useCallback(async (expected = epoch.current, { force = false } = {}) => {
    if (!run) return;
    if (snapshotFailure.current && !force) return;
    if (refreshController.current && !refreshController.current.signal.aborted) {
      if (!force) return;
      refreshController.current.abort();
    }
    const controller = new AbortController();
    refreshController.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Snapshot request timed out', 'TimeoutError'));
    }, 7000);
    try {
      const data = validateSnapshot(await request(`${API}/${encodeURIComponent(run.run_id)}`, { capability: run.capability, signal: controller.signal }), run.run_id);
      if (expected === epoch.current) {
        setSnapshot(data);
        snapshotRef.current = data;
        snapshotFailure.current = false;
        setError('');
        if (data.phase === 'expired' || data.phase === 'stopped') clearRun('Run expired or stopped by the gateway.');
      }
    } catch (e) {
      if (expected === epoch.current) {
        if (timedOut || e.name === 'TimeoutError') {
          snapshotFailure.current = true;
          const observed = snapshotRef.current?.observed_at ? ` Last successful snapshot: ${date(snapshotRef.current.observed_at)}.` : ' No successful snapshot is available.';
          setError(`GET ${API}/${run.run_id} timed out after 7 seconds.${observed} Retry the snapshot.`);
        } else if (e.status === 401 || e.status === 410) {
          clearRun(e.status === 410 ? 'Run expired. Local data and access were cleared.' : 'Run access rejected. Local data and access were cleared.');
        } else if (e.name !== 'AbortError') {
          snapshotFailure.current = true;
          if (e.message.includes('invalid run snapshot')) { setSnapshot(null); snapshotRef.current = null; }
          setError(e.message);
        }
      }
    } finally {
      clearTimeout(timeout);
      if (refreshController.current === controller) refreshController.current = null;
    }
  }, [request, run]);

  useEffect(() => {
    if (!run) return undefined;
    refresh();
    const timer = setInterval(() => refresh(), 2000);
    return () => { clearInterval(timer); refreshController.current?.abort(); refreshController.current = null; };
  }, [run, refresh]);

  function clearRun(message = '') {
    epoch.current += 1;
    detailRequest.current += 1;
    refreshController.current?.abort();
    actionController.current?.abort();
    setRun(null); setSnapshot(null); snapshotRef.current = null; snapshotFailure.current = false; setSelected(null); setLoading(false); setBusy(''); setError(''); setBatchesRemaining(null);
    setNotice(message);
  }

  async function startRun() {
    if (loading || run || cleanupRun.current) return;
    const mine = ++epoch.current;
    setLoading(true); setError(''); setNotice('');
    try {
      const created = validateCreatedRun(await request(API, { method: 'POST', timeoutMs: 30000 }));
      if (mine !== epoch.current) return;
      setRun(created);
      setBatchesRemaining(null);
      setNotice('Sandbox run started. Live state is read from the gateway.');
    } catch (e) {
      if (mine === epoch.current) {
        setError(e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'POST /sandbox/runs timed out after 30 seconds; startup outcome is inconclusive. The gateway must clean up any partial startup. Wait for gateway recovery before retrying.'
          : e.message);
      }
    }
    finally { if (mine === epoch.current) setLoading(false); }
  }

  async function mutate(action, method, suffix) {
    if (!run || busy) return;
    const target = run;
    const mine = epoch.current;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(action); setError(''); setNotice('');
    try {
      const result = validateAction(action, await request(`${API}/${encodeURIComponent(target.run_id)}${suffix}`, { method, capability: target.capability, signal: controller.signal }));
      if (mine !== epoch.current) return;
      if (action === 'stop') clearRun('Run stopped and client state cleared.');
      else {
        if (action === 'batch') setBatchesRemaining(result.batches_remaining);
        const detail = action === 'kill' ? `Killed and replaced ${safe(result.worker_id)} while it held ${safe(result.job_id)}.`
          : action === 'duplicate' ? `Key for original job ${safe(result.original_job_id)} returned job ${safe(result.existing_job_id)} (${result.created ? 'created' : 'existing'}).`
            : `Added ${num(result.created)} fixed synthetic jobs; ${num(result.batches_remaining)} extra batches remain.`;
        setNotice(detail); await refresh(mine);
      }
    } catch (e) {
      if (mine === epoch.current) {
        if (e.status === 401 || e.status === 410) clearRun(e.status === 410 ? 'Run expired. Local data and access were cleared.' : 'Run access rejected. Local data and access were cleared.');
        else setError(e.message);
      }
    }
    finally { if (actionController.current === controller) actionController.current = null; if (mine === epoch.current) setBusy(''); }
  }

  async function stopRun() {
    if (!run) return;
    const target = run;
    actionController.current?.abort();
    cleanupRun.current = target;
    setPendingCleanup(true);
    clearRun('Stopping run… client capability cleared.');
    const mine = epoch.current;
    setLoading(true);
    try {
      await request(`${API}/${encodeURIComponent(target.run_id)}`, { method: 'DELETE', capability: target.capability, timeoutMs: 30000 });
      if (mine === epoch.current) {
        cleanupRun.current = null; setPendingCleanup(false);
        setNotice('Run cleanup confirmed.');
      }
    } catch (e) {
      if (mine === epoch.current && e.status === 410) {
        cleanupRun.current = null; setPendingCleanup(false);
        setNotice('Run expired or closed; cleanup finished.');
      } else if (mine === epoch.current) setError(`Cleanup is unconfirmed: ${e.message}. Retry cleanup before starting another run.`);
    }
    finally { if (mine === epoch.current) setLoading(false); }
  }

  async function retryCleanup() {
    const target = cleanupRun.current;
    if (!target || loading) return;
    const mine = epoch.current;
    setLoading(true); setError('');
    try {
      await request(`${API}/${encodeURIComponent(target.run_id)}`, { method: 'DELETE', capability: target.capability, timeoutMs: 30000 });
      if (mine === epoch.current) {
        cleanupRun.current = null; setPendingCleanup(false);
        setNotice('Run cleanup confirmed.');
      }
    } catch (e) {
      if (mine === epoch.current && e.status === 410) {
        cleanupRun.current = null; setPendingCleanup(false);
        setNotice('Run expired or closed; cleanup finished.');
      } else if (mine === epoch.current) setError(`Cleanup is unconfirmed: ${e.message}. Retry cleanup before starting another run.`);
    } finally { if (mine === epoch.current) setLoading(false); }
  }

  async function showDetail(job) {
    if (!run) return;
    const mine = epoch.current;
    const detailMine = ++detailRequest.current;
    const target = run;
    setSelected({ loading: true, id: job.id });
    try {
      const detail = validateJobDetail(await request(`${API}/${encodeURIComponent(target.run_id)}/jobs/${encodeURIComponent(job.id)}`, { capability: target.capability }), job.id);
      if (mine !== epoch.current || detailMine !== detailRequest.current) return;
      setSelected({ ...detail, id: job.id });
    } catch (e) {
      if (mine !== epoch.current || detailMine !== detailRequest.current) return;
      if (e.status === 401 || e.status === 410) clearRun(e.status === 410 ? 'Run expired. Local data and access were cleared.' : 'Run access rejected. Local data and access were cleared.');
      else setSelected({ id: job.id, error: e.message });
    }
  }

  function closeDetail() { detailRequest.current += 1; setSelected(null); }

  const workers = snapshot?.workers ?? [];
  const jobs = snapshot?.jobs ?? [];
  const deadJobs = jobs.filter((j) => ['dead', 'dead_letter', 'dlq'].includes(String(j.state ?? j.status).toLowerCase()));

  function downloadEvidence() {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(evidenceExport(snapshot), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `leaseq-evidence-${snapshot.run_id}.json`; link.click();
    URL.revokeObjectURL(url);
  }

  const current = views.find((x) => x.id === view) ?? views[0];
  const counts = useMemo(() => summarize(snapshot), [snapshot]);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); headingRef.current?.closest('main')?.focus(); }}>Skip to main content</a>
    <header className="topbar">
      <a className="brand" href="#/operations" aria-label="LeaseQ console home"><span className="brand-mark"><Layers3 size={21} aria-hidden="true"/></span><span>Lease<span>Q</span></span></a>
      <nav className="primary-nav" aria-label="Main navigation">
        {views.map(({ id, label, Icon }) => <a key={id} href={`#/${id}`} aria-current={view === id ? 'page' : undefined} onClick={() => setMenuOpen(false)}><Icon size={17} aria-hidden="true"/><span>{label}</span></a>)}
      </nav>
      <div className="top-actions"><button className="button button-quiet plan-button" onClick={() => setPlanOpen(true)}>Plans</button><button className="icon-button menu-button" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Menu size={20} aria-hidden="true"/></button></div>
    </header>
    {menuOpen && <div className="mobile-menu"><nav id="mobile-navigation" aria-label="Mobile navigation">{views.map(({id,label,Icon}) => <a href={`#/${id}`} key={id} onClick={() => setMenuOpen(false)}><Icon size={18} aria-hidden="true"/>{label}</a>)}</nav></div>}

    <main className="main-content" id="main-content" tabIndex={-1}>
      <div className="page-heading"><div><h1 ref={headingRef} tabIndex={-1}>{current.label}</h1></div><div className="run-controls">
        {!run ? <button className="button button-primary" onClick={startRun} disabled={loading || pendingCleanup}><Plus size={17} aria-hidden="true"/>{loading ? pendingCleanup ? 'Cleaning up…' : 'Starting run…' : 'Start run'}</button> : <><span className="run-pill"><span className="live-dot"/>Run {run.run_id}</span><button className="button button-outline" onClick={downloadEvidence} disabled={!snapshot}><ArrowDownToLine size={16} aria-hidden="true"/>Evidence JSON</button><button className="button button-danger-outline" onClick={stopRun}><Square size={15} aria-hidden="true"/>Stop run</button></>}
      </div></div>

      <div className={`connection-strip ${error ? 'strip-error' : ''}`} role="status" aria-live="polite">
        {error ? <><AlertTriangle size={17} aria-hidden="true"/><span>{error}</span>{cleanupRun.current ? <button className="text-button" onClick={retryCleanup} disabled={loading}>Retry cleanup</button> : run ? <button className="text-button" onClick={() => refresh(epoch.current, { force: true })}>Retry snapshot</button> : <button className="text-button" onClick={startRun} disabled={loading || pendingCleanup}>Retry start</button>}</> : run ? snapshot ? <><HeartPulse size={17} aria-hidden="true"/><span>Snapshot observed {date(snapshot.observed_at)}</span><button className="text-button" onClick={() => refresh(epoch.current, { force: true })} aria-label="Refresh snapshot"><RefreshCw size={15} aria-hidden="true"/></button></> : <><LoaderCircle className="spin" size={17} aria-hidden="true"/><span>Waiting for first snapshot.</span></> : cleanupRun.current ? <><AlertTriangle size={17} aria-hidden="true"/><span>Previous run cleanup is not confirmed. Starting another run is blocked.</span><button className="text-button" onClick={retryCleanup} disabled={loading}>Retry cleanup</button></> : <><CircleHelp size={17} aria-hidden="true"/><span>No run active.</span></>}
      </div>
      {notice && <div className="notice" role="status"><Check size={16} aria-hidden="true"/>{notice}<button aria-label="Dismiss notice" className="dismiss" onClick={() => setNotice('')}><X size={16} aria-hidden="true"/></button></div>}

      <section className="metrics-grid" aria-label="Live run metrics">
        {counts.map(([label, value], i) => { const MetricIcon = metricIcons[i]; return <article className="metric-card" key={label}><div className="metric-label">{label}<span className="metric-icon"><MetricIcon aria-hidden="true"/></span></div><div className="metric-value tabular">{run ? num(value) : '—'}</div></article>; })}
      </section>

      {view === 'operations' && <section className="panel" aria-labelledby="workers-title"><div className="panel-heading"><div><h2 id="workers-title">Workers</h2></div><button className="button button-outline" onClick={() => mutate('batch','POST','/batch')} disabled={!run || !!busy || batchesRemaining === 0}><Plus size={16} aria-hidden="true"/>{busy === 'batch' ? 'Enqueuing…' : batchesRemaining === 0 ? 'Batch limit reached' : 'Add batch'}</button></div>
        <div className="table-wrap" role="region" aria-label="Workers table" tabIndex="0"><table><thead><tr><th>Worker</th><th>Status</th><th>Generation</th><th>Current job</th><th>Lease expires</th></tr></thead><tbody>{workers.length ? workers.map((worker) => <tr key={worker.id}><td className="mono">{worker.id}</td><td><Status state={worker.status}/></td><td className="tabular">{safe(worker.generation)}</td><td className="mono">{safe(worker.job_id)}</td><td className="tabular">{date(worker.lease_expires_at)}</td></tr>) : <tr><td colSpan="5" className="empty-cell">{run ? 'No worker records returned yet.' : 'Start a run to load workers.'}</td></tr>}</tbody></table></div>
      </section>}

      {view === 'chaos' && <section className="panel chaos-panel"><div className="panel-heading"><div><h2>Recovery actions</h2></div></div>
        <div className="action-grid"><Action title="Kill a leased worker" Icon={Skull} button="Kill random leased worker" disabled={!run || !!busy || !workers.some((w) => w.job_id)} busy={busy === 'kill'} onClick={() => mutate('kill','POST','/kill')}/><Action title="Enqueue another batch" Icon={Plus} button={batchesRemaining === 0 ? 'Batch limit reached' : 'Add fixed batch'} disabled={!run || !!busy || batchesRemaining === 0} busy={busy === 'batch'} onClick={() => mutate('batch','POST','/batch')}/><Action title="Repeat idempotency key" Icon={Copy} button="Check duplicate key" disabled={!run || !!busy} busy={busy === 'duplicate'} onClick={() => mutate('duplicate','POST','/duplicate')}/></div>
        <div className="evidence-box"><div><h3><ShieldCheck size={17}/> Results</h3></div><Evidence evidence={snapshot?.evidence}/></div>
      </section>}

      {(view === 'operations' || view === 'dlq') && <section className="panel jobs-panel"><div className="panel-heading"><div><h2>{view === 'dlq' ? 'Dead letters' : 'Jobs'}</h2></div><span className="count-label">{snapshot ? view === 'dlq' ? `${deadJobs.length} observed` : `${jobs.length} observed` : '—'}</span></div>
        <div className="table-wrap" role="region" aria-label={view === 'dlq' ? 'Dead letters table' : 'Jobs table'} tabIndex="0"><table><thead><tr><th>Job</th><th>Kind</th><th>State</th><th>Attempts</th><th>Effects</th><th>Updated</th></tr></thead><tbody>{(view === 'dlq' ? deadJobs : jobs).length ? (view === 'dlq' ? deadJobs : jobs).map((job) => <tr key={job.id}><td><button className="link-button mono" onClick={() => showDetail(job)}>{job.id}<ChevronRight size={14} aria-hidden="true"/></button></td><td>{safe(job.kind)}</td><td><Status state={job.state ?? job.status}/></td><td className="tabular">{safe(job.attempts)}</td><td className="tabular">{num(job.effect_count)}</td><td className="tabular">{date(job.updated_at ?? job.created_at)}</td></tr>) : <tr><td colSpan="6" className="empty-cell">{run ? view === 'dlq' ? 'No dead letters.' : 'No jobs.' : 'Start a run to load jobs.'}</td></tr>}</tbody></table></div>
      </section>}

      {(view === 'operations' || view === 'chaos') && <section className="panel timeline-panel"><div className="panel-heading"><div><h2>Events</h2></div><span className="count-label">{snapshot?.events?.length ?? '—'} events</span></div>
        <ol className="timeline">{(snapshot?.events ?? []).length ? snapshot.events.map((event, i) => <li key={event.id ?? `${event.created_at}-${i}`}><span className="timeline-node"/><div className="timeline-content"><strong>{eventLabel(event)}</strong>{eventLabel(event) !== event.event && <span className="raw-code">{event.event}</span>}<span>{safe(event.job_id)}{event.worker_id ? ` · ${event.worker_id}` : ''}</span><time>{date(event.created_at ?? event.observed_at)}</time></div></li>) : <li className="timeline-empty">{run ? 'No events yet.' : 'Start a run to load events.'}</li>}</ol>
      </section>}
      <footer className="footer"><span>Local runs use synthetic data and a disposable database.</span><a href="https://github.com/anirudh763/leaseq" target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden="true"/> Project repository</a></footer>
    </main>

    {selected && <Modal className="drawer-dialog" labelledby="detail-title" onClose={closeDetail}><div className="drawer-head"><div><h2 id="detail-title">Job {selected.id}</h2></div><button data-dialog-close className="icon-button" aria-label="Close job details"><X aria-hidden="true"/></button></div>{selected.loading ? <p>Loading job details…</p> : selected.error ? <p role="alert">{selected.error}</p> : <JobDetail detail={selected}/>}</Modal>}
    {planOpen && <Modal className="plans-dialog" labelledby="plans-title" onClose={() => setPlanOpen(false)}><div className="drawer-head"><h2 id="plans-title">Plans</h2><button data-dialog-close className="icon-button" aria-label="Close plans"><X aria-hidden="true"/></button></div><p className="drawer-summary">Plans are not available; prices and quotas are proposals.</p><div className="plans-grid"><Plan name="Free" price="50K jobs/month"/><Plan name="Pro" price="$19/mo"/><Plan name="Team" price="$79/mo"/></div><a className="button button-outline public-link" href="https://github.com/anirudh763/leaseq" target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true"/> Project repository</a></Modal>}
  </div>;
}

function Status({ state }) {
  const value = String(state ?? 'unknown').toLowerCase();
  const tone = /done|complete|pass/.test(value) ? 'good' : /dead|fail|error/.test(value) ? 'bad' : /run|claim|lease/.test(value) ? 'active' : /retry|wait|inconclusive/.test(value) ? 'warn' : 'neutral';
  const Icon = tone === 'good' ? Check : tone === 'bad' ? AlertTriangle : tone === 'active' ? Activity : tone === 'warn' ? Clock3 : CircleHelp;
  const label = ({ done: 'Completed', dead: 'Dead', dead_letter: 'Dead', dlq: 'Dead', leased: 'Leased', queued: 'Queued', running: 'Running', stopped: 'Stopped', pass: 'Passed', fail: 'Failed', inconclusive: 'Inconclusive', observed: 'Observed' })[value] ?? safe(state);
  return <span className={`status status-${tone}`}><Icon size={14} aria-hidden="true"/><span>{label}</span>{label !== safe(state) && <span className="raw-code">{safe(state)}</span>}</span>;
}
function eventLabel(event) {
  const raw = String(event?.event ?? 'Unknown event').toLowerCase();
  const detail = event?.detail;
  if (raw === 'claimed' && detail && typeof detail === 'object' && Object.hasOwn(detail, 'took_over_expired_lease_of')) return 'Expired lease retried';
  if (raw === 'rejected' && detail?.op === 'complete') return 'Stale result rejected';
  return ({ enqueued: 'Job enqueued', claimed: 'Lease claimed', completed: 'Job completed', failed: 'Attempt failed', dead: 'Moved to dead letters', rejected: 'Operation rejected', requeued: 'Job requeued', cancelled: 'Job cancelled' })[raw] ?? safe(event?.event);
}
function Modal({ className, labelledby, onClose, children }) {
  const dialog = useRef(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  const keepFocus = (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
      .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const target = event.shiftKey ? controls.at(-1) : controls[0];
    const boundary = event.shiftKey ? controls[0] : controls.at(-1);
    if (target && (document.activeElement === boundary || !dialog.current.contains(document.activeElement))) {
      event.preventDefault(); target.focus();
    }
  };
  return <dialog ref={dialog} className={className} aria-labelledby={labelledby} onKeyDown={keepFocus} onClose={() => closeHandler.current?.()} onClick={(event) => { if (event.target === event.currentTarget || event.target.closest('[data-dialog-close]')) dialog.current?.close(); }}>{children}</dialog>;
}

function JobDetail({ detail }) {
  const job = detail.job;
  const result = Object.hasOwn(job, 'result') && job.result !== undefined && job.result !== null;
  return <div className="job-detail-content">
    <dl className="job-metadata">
      <div><dt>Kind</dt><dd>{safe(job.kind)}</dd></div>
      <div><dt>State</dt><dd><Status state={job.state}/></dd></div>
      <div><dt>Attempts</dt><dd className="tabular">{safe(job.attempts)} / {safe(job.max_attempts)}</dd></div>
      <div><dt>Effect count</dt><dd className="tabular">{num(detail.effect_count)}</dd></div>
      <div><dt>Worker</dt><dd className="mono">{safe(job.leased_by)}</dd></div>
      <div><dt>Run after</dt><dd className="tabular">{date(job.run_after)}</dd></div>
      <div><dt>Lease expires</dt><dd className="tabular">{date(job.lease_expires_at)}</dd></div>
      <div><dt>Updated</dt><dd className="tabular">{date(job.updated_at)}</dd></div>
    </dl>
    <section className="result-section" aria-labelledby="job-result-title"><h3 id="job-result-title">Job result</h3>{result ? <dl className="result-fields">{typeof job.result === 'object' && !Array.isArray(job.result) ? Object.entries(job.result).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{safe(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>) : <div><dt>Value</dt><dd>{safe(job.result)}</dd></div>}</dl> : <p>No result returned.</p>}</section>
    <section className="detail-timeline" aria-labelledby="job-timeline-title"><h3 id="job-timeline-title">Events</h3><ol className="timeline">{detail.events.length ? detail.events.map((event, index) => <li key={event.id ?? `${event.created_at}-${index}`}><span className="timeline-node"/><div className="timeline-content"><strong>{eventLabel(event)}</strong>{eventLabel(event) !== event.event && <span className="raw-code">{event.event}</span>}<span>Attempt {safe(event.attempt)}{event.worker_id ? ` · ${event.worker_id}` : ''}</span><time>{date(event.created_at)}</time>{event.detail && <span className="event-detail">{typeof event.detail === 'string' ? event.detail : Object.entries(event.detail).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${typeof value === 'object' ? JSON.stringify(value) : safe(value)}`).join(' · ')}</span>}</div></li>) : <li className="timeline-empty">No events for this job.</li>}</ol></section>
    <details className="raw-evidence"><summary>Raw response</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details>
  </div>;
}
function Evidence({ evidence }) {
  const values = evidence && typeof evidence === 'object' ? Object.entries(evidence) : [];
  return values.length ? <ul className="evidence-list">{values.map(([name, item]) => { const result = typeof item === 'object' ? item.status ?? item.outcome : item; return <li key={name}><span>{name.replaceAll('_',' ')}</span><Status state={result}/></li>; })}</ul> : <p className="evidence-empty">{evidence ? 'No results returned.' : 'No results yet.'}</p>;
}
function Action({ title, Icon, button, disabled, busy, onClick }) { return <article className="action-card"><span className="action-icon"><Icon size={20} aria-hidden="true"/></span><h3>{title}</h3><button className="button button-outline" onClick={onClick} disabled={disabled}>{busy ? <LoaderCircle className="spin" size={16} aria-hidden="true"/> : <ArrowLeftRight size={16} aria-hidden="true"/>} {busy ? 'Working…' : button}</button></article>; }
function Plan({ name, price }) { return <article className="plan-card"><h3>{name}</h3><p className="plan-price">{price}</p></article>; }

createRoot(document.getElementById('root')).render(<App/>);
