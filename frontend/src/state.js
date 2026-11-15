export function summarize(snapshot) {
  const m = snapshot?.metrics ?? {};
  return [
    ['Workers', snapshot?.workers?.length],
    ['Jobs', snapshot?.jobs?.length],
    ['Expired retries', m.expired_retries],
    ['Stale rejections', m.zombie_rejections],
    ['Committed effects', m.effects],
  ];
}

export function formatMetric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
}

export function evidenceExport(snapshot) {
  const keys = ['run_id', 'observed_at', 'expires_at', 'phase', 'version', 'workers', 'counts', 'metrics', 'jobs', 'events', 'evidence', 'limits'];
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(snapshot ?? {}, key)).map((key) => [key, snapshot[key]]));
}

export function validateCreatedRun(value, now = Date.now()) {
  if (!value || typeof value.run_id !== 'string' || !value.run_id.trim()
      || typeof value.capability !== 'string' || !value.capability.trim()
      || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))
      || Date.parse(value.expires_at) <= now) {
    throw new Error('Gateway returned an invalid or expired run response. Startup outcome is inconclusive; check gateway cleanup before retrying.');
  }
  return value;
}

export function validateSnapshot(value, expectedRunId) {
  if (!value || value.run_id !== expectedRunId || typeof value.phase !== 'string'
      || !Array.isArray(value.workers) || !Array.isArray(value.jobs) || !Array.isArray(value.events)
      || !value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)
      || !['expired_retries', 'zombie_rejections', 'effects'].every((key) => Number.isFinite(value.metrics[key]) && value.metrics[key] >= 0)
      || !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)
      || !Object.values(value.counts).every((count) => Number.isFinite(count) && count >= 0)
      || !value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)
      || !value.workers.every((worker) => worker && typeof worker.id === 'string' && typeof worker.status === 'string' && Number.isFinite(worker.generation))
      || !value.jobs.every((job) => job && Number.isFinite(job.id) && typeof job.kind === 'string' && typeof job.state === 'string' && Number.isFinite(job.attempts) && Number.isFinite(job.max_attempts) && Number.isFinite(job.effect_count))
      || !value.events.every((event) => event && typeof event.event === 'string' && Number.isFinite(event.id))) {
    throw new Error('Gateway returned an invalid run snapshot; the response is not displayed as live state.');
  }
  return value;
}

export function validateJobDetail(value, expectedJobId) {
  if (!value || !value.job || String(value.job.id) !== String(expectedJobId)
      || !Array.isArray(value.events) || !Number.isFinite(value.effect_count) || value.effect_count < 0) {
    throw new Error('Gateway returned an invalid job detail response.');
  }
  return value;
}

export function validateAction(action, value) {
  const valid = action === 'batch'
    ? Number.isFinite(value?.created) && value.created >= 0 && Array.isArray(value.job_ids)
      && Number.isFinite(value.batches_remaining) && value.batches_remaining >= 0
    : action === 'kill'
      ? typeof value?.worker_id === 'string' && Number.isFinite(value.job_id)
      : action === 'duplicate'
        ? Number.isFinite(value?.original_job_id) && Number.isFinite(value.existing_job_id) && typeof value.created === 'boolean'
        : false;
  if (!valid) throw new Error(`Gateway returned an invalid ${action} response; the action outcome is not reported as successful.`);
  return value;
}
