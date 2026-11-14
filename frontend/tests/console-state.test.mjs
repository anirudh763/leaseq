import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceExport, formatMetric, summarize, validateAction, validateCreatedRun, validateJobDetail, validateSnapshot } from '../src/state.js';

test('summary uses only values observed in the gateway snapshot', () => {
  assert.deepEqual(summarize(null), [
    ['Workers', undefined], ['Jobs', undefined], ['Expired retries', undefined],
    ['Stale rejections', undefined], ['Committed effects', undefined],
  ]);
  assert.deepEqual(summarize({ workers: [{ id: 'w1' }], jobs: [{ id: 1 }, { id: 2 }], metrics: { expired_retries: 1, zombie_rejections: 0, effects: 3 } }), [
    ['Workers', 1], ['Jobs', 2], ['Expired retries', 1], ['Stale rejections', 0], ['Committed effects', 3],
  ]);
});

test('unknown metrics stay unknown while a measured zero is rendered as zero', () => {
  assert.equal(formatMetric(undefined), '—');
  assert.equal(formatMetric(null), '—');
  assert.equal(formatMetric(''), '—');
  assert.equal(formatMetric(0), '0');
  assert.equal(formatMetric(1200), '1,200');
});

test('evidence export includes observed contract fields and excludes capabilities and internals', () => {
  const snapshot = { run_id: 'run-1', observed_at: '2026-11-14T12:00:00Z', jobs: [], evidence: {}, capability: 'secret', database_url: 'secret', process_env: {} };
  assert.deepEqual(evidenceExport(snapshot), { run_id: 'run-1', observed_at: '2026-11-14T12:00:00Z', jobs: [], evidence: {} });
});

test('created run, snapshot, and detail contracts reject malformed successful responses', () => {
  assert.throws(() => validateCreatedRun({ run_id: 'run-1' }), /invalid or expired run response/);
  assert.throws(() => validateCreatedRun({ run_id: 'run-1', capability: 'cap', expires_at: '2000-01-01T00:00:00Z' }), /expired run response/);
  assert.throws(() => validateSnapshot({ run_id: 'run-1', workers: [] }, 'run-1'), /invalid run snapshot/);
  assert.throws(() => validateJobDetail({ job: { id: 5 }, events: [] }, 5), /invalid job detail/);
});

test('valid gateway responses preserve measured zero counts and safe detail fields', () => {
  const created = validateCreatedRun({ run_id: 'run-1', capability: 'ephemeral', expires_at: '2027-01-01T00:00:00Z' }, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(created.capability, 'ephemeral');
  const snapshot = validateSnapshot({ run_id: 'run-1', phase: 'active', workers: [], jobs: [], events: [], metrics: { expired_retries: 0, zombie_rejections: 0, effects: 0 }, counts: {}, evidence: {} }, 'run-1');
  assert.equal(snapshot.metrics.effects, 0);
  const detail = validateJobDetail({ job: { id: 5, kind: 'word_count', state: 'done' }, events: [], effect_count: 1 }, 5);
  assert.equal(detail.job.kind, 'word_count');
});

test('action responses require real batch, kill, and idempotency results', () => {
  assert.throws(() => validateAction('batch', { created: 32, job_ids: [] }), /invalid batch response/);
  assert.throws(() => validateAction('kill', {}), /invalid kill response/);
  assert.throws(() => validateAction('duplicate', { original_job_id: 1, existing_job_id: 1 }), /invalid duplicate response/);
  assert.deepEqual(validateAction('batch', { created: 0, job_ids: [], batches_remaining: 2 }), { created: 0, job_ids: [], batches_remaining: 2 });
  assert.deepEqual(validateAction('kill', { worker_id: 'worker-1', job_id: 7 }), { worker_id: 'worker-1', job_id: 7 });
  assert.deepEqual(validateAction('duplicate', { original_job_id: 7, existing_job_id: 7, created: false }), { original_job_id: 7, existing_job_id: 7, created: false });
});
