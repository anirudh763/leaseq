'use strict';
/* Bounded in-memory model of LeaseQ's claim/lease/fencing rules. It never calls the API. */
(() => {
  const MAX_TEXT = 10000;
  const MAX_JOBS = 100;
  const MAX_BATCH = 10;
  const LEASE_MS = 3000;
  const fresh = (text) => ({
    now: 0, paused: false, nextId: 1, fence: 0, job: null, jobs: [],
    workers: { 'worker-a': { alive: true }, 'worker-b': { alive: true } },
    events: [], eventsDropped:0, text, staleToken: null,
  });
  function validateText(text) {
    if (typeof text !== 'string') throw new Error('Enter text for the sample word-count job.');
    if (text.length > MAX_TEXT) throw new Error(`The simulator accepts at most ${MAX_TEXT.toLocaleString()} characters.`);
  }
  function push(model, message) { model.events.push(message); if(model.events.length>100){const dropped=model.events.splice(0,model.events.length-100).length;model.eventsDropped=Math.min(Number.MAX_SAFE_INTEGER,model.eventsDropped+dropped);} return model; }
  function guard(model) { if (model.paused) throw new Error('Simulation paused. Resume it before changing queue state.'); }
  function createJob(model,text) {
    if(model.jobs.length>=MAX_JOBS)throw new Error(`Keep the local history below ${MAX_JOBS} jobs; reset the simulator to start a new session.`);
    const job={ id:model.nextId++, kind:'word_count', payload:{text}, state:'queued', attempts:0, maxAttempts:3, worker:null, leaseExpiresAt:null, token:null, result:null };
    model.jobs.push(job);if(!model.job||['done','dead'].includes(model.job.state))model.job=job;
    return job;
  }
  function enqueue(model, text = model.text) {
    guard(model); validateText(text);
    model.text = text;
    const job=createJob(model,text);
    return push(model, `Job ${job.id} enqueued as queued, attempt 0 of 3.`);
  }
  function enqueueBatch(model,text,count) {
    guard(model);validateText(text);
    if(!Number.isInteger(count)||count<1||count>MAX_BATCH)throw new Error(`Choose a batch size from 1 to ${MAX_BATCH}.`);
    if(model.jobs.length+count>MAX_JOBS)throw new Error(`The local session can retain at most ${MAX_JOBS} jobs. Reset before adding this batch.`);
    model.text=text;const ids=[];for(let i=0;i<count;i++)ids.push(createJob(model,text).id);
    return push(model,`Batch of ${count} identical word-count jobs enqueued: ${ids.join(', ')}. Each claim receives its own fencing token.`);
  }
  function claim(model, workerId) {
    guard(model);
    const worker = model.workers[workerId];
    if (!worker || !worker.alive) throw new Error(`${workerId} is not available.`);
    const eligible=(job)=>((job.state==='queued'&&(!job.runAfter||job.runAfter<=model.now)&&(!job.leaseExpiresAt||job.leaseExpiresAt<=model.now))||(job.state==='leased'&&job.leaseExpiresAt<=model.now));
    let job=model.job&&eligible(model.job)?model.job:model.jobs.find(eligible);
    if(!job)throw new Error('No due simulated job is available to claim.');
    model.job=job;
    if (job.attempts >= job.maxAttempts) { job.state = 'dead'; job.worker = null; job.token = null; job.leaseExpiresAt = null; return push(model, `Job ${job.id} is dead after its final expired attempt.`); }
    const expiredWorker = job.state === 'leased' ? job.worker : null;
    job.attempts += 1; model.fence += 1; job.token = `fence-${model.fence}`; job.worker = workerId; job.state = 'leased'; job.leaseExpiresAt = model.now + LEASE_MS;
    return push(model, expiredWorker ? `${workerId} takes over expired work from ${expiredWorker} on attempt ${job.attempts}; fencing token changed to ${job.token}.` : `${workerId} claims attempt ${job.attempts}; lease lasts ${LEASE_MS / 1000} virtual seconds; fencing token ${job.token}.`);
  }
  function heartbeat(model, workerId) {
    guard(model); const job = model.job;
    if (!job || job.state !== 'leased' || job.worker !== workerId || !model.workers[workerId]?.alive) throw new Error('Heartbeat rejected: this worker does not hold the current lease.');
    job.leaseExpiresAt = model.now + LEASE_MS;
    return push(model, `${workerId} heartbeat extends the lease to virtual time ${job.leaseExpiresAt} ms.`);
  }
  function crash(model, workerId) {
    guard(model); if (!model.workers[workerId]?.alive) throw new Error(`${workerId} is already stopped.`);
    if (model.job?.state === 'leased' && model.job.worker === workerId) model.staleToken = model.job.token;
    model.workers[workerId].alive = false;
    if (model.job?.state === 'leased' && model.job.worker === workerId) push(model, `${workerId} stopped. The lease remains until virtual time ${model.job.leaseExpiresAt} ms; no operating-system process was killed.`);
    else push(model, `${workerId} stopped. No server process or real queue was affected.`);
    return model;
  }
  function advance(model, milliseconds) {
    guard(model);
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 30000) throw new Error('Advance virtual time by 0 to 30,000 milliseconds.');
    model.now += milliseconds;
    const job = model.job;
    if (job?.state === 'leased' && job.leaseExpiresAt <= model.now) push(model, `Lease expired at virtual time ${job.leaseExpiresAt} ms; job is reclaimable.`);
    else if (job?.state === 'queued' && job.runAfter && job.runAfter <= model.now) push(model, `Backoff elapsed at virtual time ${model.now} ms; retry is due.`);
    else push(model, `Virtual clock advanced to ${model.now} ms.`);
    return model;
  }
  function complete(model, token, workerId) {
    guard(model); const job = model.job;
    if (!job || job.state !== 'leased' || job.token !== token || job.worker !== workerId || !model.workers[workerId]?.alive) {
      return push(model, `Completion from ${workerId} with ${token} rejected: it does not match the current live lease.`);
    }
    const text = job.payload.text;
    const lines = text === '' ? 0 : text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).length;
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    job.result = { words, lines }; job.state = 'done'; job.worker = null; job.token = null; job.leaseExpiresAt = null;
    return push(model, `Current lease completed on attempt ${job.attempts}: ${words} words, ${lines} lines.`);
  }
  function fail(model, token, workerId, reason = 'simulated handler failure') {
    guard(model); const job = model.job;
    if (!job || job.state !== 'leased' || job.token !== token || job.worker !== workerId) return push(model, `Failure report from ${workerId} rejected: it does not match the current lease.`);
    if (job.attempts >= job.maxAttempts) { job.state = 'dead'; job.worker = null; job.token = null; job.leaseExpiresAt = null; return push(model, `Attempt ${job.attempts} failed (${reason}); job moved to the dead-letter queue.`); }
    job.state = 'queued'; job.worker = null; job.token = null; job.leaseExpiresAt = null;
    job.runAfter = model.now + Math.min(30000, 1000 * (2 ** Math.min(job.attempts - 1, 5)));
    return push(model, `Attempt ${job.attempts} failed (${reason}); retry becomes available at virtual time ${job.runAfter} ms.`);
  }
  function replay(model, extraAttempts = 1) {
    guard(model); const job = model.job;
    if (!job || job.state !== 'dead') throw new Error('Only a dead simulated job can be replayed.');
    if (!Number.isInteger(extraAttempts) || extraAttempts < 1 || extraAttempts > 5 || job.attempts + extraAttempts > 100) throw new Error('Add 1 to 5 bounded attempts; the lifetime limit is 100 attempts.');
    const previous = job.maxAttempts;
    job.maxAttempts = job.attempts + extraAttempts; job.state = 'queued'; job.runAfter = model.now; job.token = null; job.worker = null; job.leaseExpiresAt = null;
    return push(model, `Dead-letter replayed with ${extraAttempts} added attempt${extraAttempts === 1 ? '' : 's'}; attempts remain ${job.attempts}, limit changes from ${previous} to ${job.maxAttempts}.`);
  }
  function runRecovery(text) {
    validateText(text);
    const model = fresh(text);
    enqueue(model, text); claim(model, 'worker-a');
    const staleToken = model.job.token;
    heartbeat(model, 'worker-a'); crash(model, 'worker-a'); advance(model, LEASE_MS + 1);
    claim(model, 'worker-b');
    complete(model, staleToken, 'worker-a');
    complete(model, model.job.token, 'worker-b');
    return model;
  }
  function persistable(model) {
    if (!model?.job) return null;
    return { state:model.job.state, attempts:model.job.attempts, maxAttempts:model.job.maxAttempts,
      text:model.job.payload.text, result:model.job.result, events:[...model.events].slice(-40).map(String),
      eventsDropped:Math.min(Number.MAX_SAFE_INTEGER,model.eventsDropped+Math.max(0,model.events.length-40)) };
  }
  function counts(model) {
    return Object.freeze({total:model.jobs.length,queued:model.jobs.filter((job)=>job.state==='queued').length,
      leased:model.jobs.filter((job)=>job.state==='leased').length,done:model.jobs.filter((job)=>job.state==='done').length,
      dead:model.jobs.filter((job)=>job.state==='dead').length});
  }
  window.LeaseQSimulator = Object.freeze({ fresh, enqueue, enqueueBatch, claim, heartbeat, crash, advance, complete, fail, replay, runRecovery, persistable, counts, maxText: MAX_TEXT, maxJobs:MAX_JOBS, maxBatch:MAX_BATCH, leaseMs: LEASE_MS });
})();
