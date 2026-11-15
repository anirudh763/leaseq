'use strict';

const MAX_REQUEST_BYTES = 65536;
const MAX_RESPONSE_BYTES = 131072;

class LeaseQError extends Error {}
class AuthenticationError extends LeaseQError {}

class LeaseQClient {
  constructor(apiUrl, token, timeoutMs = 10000) {
    if (!token) throw new TypeError('token is required');
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, headers = {}) {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    if (raw !== undefined && Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
      throw new RangeError('request exceeds 65536 bytes');
    }
    const response = await fetch(`${this.apiUrl}${path}`, {
      method, body: raw, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${this.token}`, ...(raw === undefined ? {} : {
        'Content-Type': 'application/json' }), ...headers },
    });
    if (response.status === 401) throw new AuthenticationError('LeaseQ rejected the API token');
    if (response.status < 200 || response.status >= 300) {
      throw new LeaseQError(`LeaseQ request failed with HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LeaseQError('LeaseQ response exceeds the 131072-byte limit');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  submit(kind, payload, { idempotencyKey, priority = 0, maxAttempts = 5,
    runAfter, delaySeconds } = {}) {
    if (!idempotencyKey) throw new TypeError('idempotencyKey is required');
    const body = { kind, payload, priority, max_attempts: maxAttempts };
    if (runAfter !== undefined) body.run_after = runAfter;
    if (delaySeconds !== undefined) body.delay_seconds = delaySeconds;
    return this.request('POST', '/jobs', body, { 'Idempotency-Key': idempotencyKey });
  }

  claim(workerId, kinds, leaseSeconds = 30) {
    return this.request('POST', '/jobs/claim', {
      worker_id: workerId, kinds, lease_seconds: leaseSeconds,
    });
  }

  heartbeat(job, leaseSeconds = 30) {
    return this.request('POST', `/jobs/${job.id}/heartbeat`, {
      lease_token: job.lease_token, lease_seconds: leaseSeconds,
    });
  }

  complete(job, result) {
    return this.request('POST', `/jobs/${job.id}/complete`, {
      lease_token: job.lease_token, result,
    });
  }

  fail(job, error, permanent = false) {
    return this.request('POST', `/jobs/${job.id}/fail`, {
      lease_token: job.lease_token, error, permanent,
    });
  }
}

async function runWorker(client, workerId, handlers, { signal, leaseSeconds = 30,
  pollMs = 200 } = {}) {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw new TypeError('handlers must be an object of task kinds');
  const kinds = Object.keys(handlers).sort();
  if (!kinds.length) throw new TypeError('register at least one task before starting a worker');
  if (kinds.length > 64 || kinds.some(kind => !kind.length || kind.length > 100 || /[^A-Za-z0-9_.:-]/.test(kind) || typeof handlers[kind] !== 'function')) throw new TypeError('workers accept at most 64 API-compatible task kinds with function handlers');
  while (!signal?.aborted) {
    const job = await client.claim(workerId, kinds, leaseSeconds);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    let leaseLost = false;
    const timer = setInterval(() => client.heartbeat(job, leaseSeconds).catch(() => {
      leaseLost = true;
    }), Math.max(100, leaseSeconds * 1000 / 3));
    try {
      const result = await handlers[job.kind](job, {
        jobKey: job.idempotency_key, workerId, signal,
      });
      if (!leaseLost) await client.complete(job, result);
    } catch (error) {
      if (!leaseLost) await client.fail(job, error?.name || 'Error', error?.permanent === true);
    } finally {
      clearInterval(timer);
    }
  }
}

module.exports = { AuthenticationError, LeaseQClient, LeaseQError, runWorker };
