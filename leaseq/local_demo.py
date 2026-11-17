"""Opt-in loopback demonstration; its database and worker never touch the live queue."""
import hashlib
import multiprocessing
import os
import threading
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Literal
from psycopg.conninfo import conninfo_to_dict

from . import db, queue, observability

LEASE_SECONDS = 6
router = APIRouter(prefix='/local-demo')


def worker(url, channel, identity):
    with db.connect(url) as conn:
        job = queue.claim(conn, identity, LEASE_SECONDS, ['localdemo.active'])
        channel.send(job)
        channel.close()
        if job:
            while True:
                time.sleep(1)
                if not queue.heartbeat(conn, job['id'], job['lease_token'], LEASE_SECONDS):
                    return


class Demo:
    def __init__(self, url):
        parsed = conninfo_to_dict(url)
        main = conninfo_to_dict(db.database_url())
        if not parsed.get('dbname', '').endswith('_demo') or parsed.get('dbname') == main.get('dbname'):
            raise RuntimeError('Local demo requires a separate database ending in _demo')
        self.url, self.lock = url, threading.RLock()
        self.process = self.lease = self.stale = None
        self.rejected = False
        self.fingerprints = None
        self.failure = None
        self.rate = observability.RateBuckets(auth_limit=120, public_limit=30)
        self.stop = threading.Event()
        with db.connect(url) as conn:
            db.apply_schema(conn)
            self.seed(conn)
        self.thread = threading.Thread(target=self.recover, daemon=True)
        self.thread.start()

    def seed(self, conn):
        for kind, title in [('completed', 'Generate weekly report'), ('failed', 'Deliver rejected webhook'), ('queued', 'Create image thumbnail'), ('active', 'Process recoverable export')]:
            job, created = queue.enqueue(conn, 'localdemo.' + kind, {'task': title}, 'local-demo-v1-' + kind, 1 if kind == 'failed' else 20)
            if created and kind in ('completed', 'failed'):
                lease = queue.claim(conn, 'demo-seed', LEASE_SECONDS, ['localdemo.' + kind])
                if kind == 'completed':
                    queue.complete(conn, job['id'], lease['lease_token'], {'report': 'Sample report generated'})
                else:
                    queue.fail(conn, job['id'], lease['lease_token'], 'Sample webhook destination rejected the payload')

    def start_worker(self):
        parent, child = multiprocessing.get_context('spawn').Pipe(duplex=False)
        identity = 'demo-recovery' if self.stale else 'demo-primary'
        process = multiprocessing.get_context('spawn').Process(target=worker, args=(self.url, child, identity), daemon=True)
        process.start()
        child.close()
        if not parent.poll(5):
            process.kill(); process.join(2); parent.close()
            raise RuntimeError('Demo worker did not acquire a lease in five seconds')
        lease = parent.recv(); parent.close()
        if lease is None:
            process.join(2)
            return
        self.process, self.lease = process, lease
        if self.stale:
            with db.connect(self.url) as conn:
                self.fingerprints = {'previous': hashlib.sha256(self.stale['lease_token'].encode()).hexdigest(), 'job_id': lease['id'], 'current': hashlib.sha256(lease['lease_token'].encode()).hexdigest()}
                self.rejected = queue.complete(conn, self.stale['id'], self.stale['lease_token'], {'late': True}, worker_id='demo-primary') is None
            self.stale = None

    def recover(self):
        while not self.stop.wait(0.5):
            try:
                with self.lock:
                    if self.stale:
                        with db.connect(self.url) as conn:
                            current = queue.get(conn, self.stale['id'])
                            expired = conn.execute('SELECT lease_expires_at <= now() AS expired FROM jobs WHERE id=%s', (self.stale['id'],)).fetchone()['expired']
                            if current['state'] != 'leased':
                                self.stale = None
                                continue
                        if expired:
                            self.start_worker()
            except Exception:
                self.failure = 'Recovery failed. Stop and restart the local demo service.'

    def close(self):
        self.stop.set(); self.thread.join(6)
        if self.process and self.process.is_alive():
            self.process.kill(); self.process.join(2)

    def action(self, action):
        with self.lock:
            if action == 'reset':
                if self.process and self.process.is_alive():
                    self.process.kill()
                    self.process.join(2)
                self.process = self.lease = self.stale = None
                self.rejected = False
                self.fingerprints = self.failure = None
                with db.connect(self.url) as conn, conn.transaction():
                    # Explicit reset destroys only this opt-in, dedicated demo database's samples.
                    conn.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
                    db.apply_schema(conn)
                    self.seed(conn)
            elif action == 'start':
                if not self.process or not self.process.is_alive():
                    if not self.stale:
                        self.rejected = False
                        self.fingerprints = None
                        self.start_worker()
            elif action == 'crash':
                if not self.process or not self.process.is_alive() or not self.lease:
                    raise HTTPException(409, 'Start a demo lease first')
                self.stale = self.lease.copy()
                self.process.kill(); self.process.join(2)
            elif action == 'complete':
                if not self.lease or self.stale or not self.process or not self.process.is_alive():
                    raise HTTPException(409, 'Start a demo lease first')
                with db.connect(self.url) as conn:
                    if queue.complete(conn, self.lease['id'], self.lease['lease_token'], {'export': 'Completed by current owner'}) is None:
                        raise HTTPException(409, 'Lease ownership changed; refresh before completing')
                if self.process and self.process.is_alive():
                    self.process.terminate(); self.process.join(2)
                self.lease = None
            elif action == 'enqueue':
                with db.connect(self.url) as conn, conn.transaction():
                    conn.execute('SELECT pg_advisory_xact_lock(761601)')
                    count = conn.execute('SELECT count(*) AS n FROM jobs').fetchone()['n']
                    if count >= 12:
                        raise HTTPException(409, 'Demo is limited to 12 jobs. Use Reset demo to delete only the isolated sample history and start again.')
                    queue.enqueue(conn, 'localdemo.active', {'task': 'Sample recoverable export'}, 'local-demo-added-' + str(count), 20)
            else:
                with db.connect(self.url) as conn:
                    job_id = conn.execute("SELECT id FROM jobs WHERE idempotency_key=%s", ('local-demo-v1-' + ('failed' if action == 'replay' else 'queued'),)).fetchone()['id']
                    job = queue.get(conn, job_id)
                    if action == 'replay':
                        if job['state'] != 'dead':
                            raise HTTPException(409, 'The sample failed job has already been replayed')
                        queue.requeue(conn, job_id, 1)
                    elif job['state'] == 'queued':
                        queue.enqueue(conn, job['kind'], job['payload'], 'local-demo-v1-queued', 20)
                    else:
                        raise HTTPException(409, 'The sample job already exists')
        return self.snapshot()

    def snapshot(self):
        with self.lock, db.connect(self.url) as conn:
            now = conn.execute('SELECT now() AS now').fetchone()['now']
            jobs, _ = queue.list_jobs(conn, limit=12)
            for job in jobs:
                job['events'], _ = queue.events(conn, job['id'], limit=30)
            return {'available': True, 'mode': 'Isolated local PostgreSQL demo', 'as_of': now, 'jobs': jobs, 'worker_alive': bool(self.process and self.process.is_alive()), 'stale_rejected': self.rejected, 'error': self.failure, 'token_fingerprints': self.fingerprints}


class Action(BaseModel):
    action: Literal['start', 'enqueue', 'crash', 'complete', 'replay', 'reset']


def service(request):
    demo = getattr(request.app.state, 'local_demo', None)
    if demo is None:
        raise HTTPException(404, 'Local PostgreSQL demo is not enabled')
    host = urlsplit('//' + request.headers.get('host', '')).hostname
    if host not in ('127.0.0.1', 'localhost', '::1'):
        raise HTTPException(403, 'Local demo accepts loopback hosts only')
    origin = request.headers.get('origin')
    if request.method != 'GET' and (not origin or origin != str(request.base_url).rstrip('/')):
        raise HTTPException(403, 'Use this local app to operate the demo')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site demo access refused')
    client = request.client.host if request.client else 'unknown'
    if demo.rate.allow(client, request.method == 'GET'):
        raise HTTPException(429, 'Demo action limit reached; retry in a minute', headers={'Retry-After': '60'})
    return demo


@router.get('')
def status(request: Request):
    demo = getattr(request.app.state, 'local_demo', None)
    if demo is None:
        return {'available': False}
    return service(request).snapshot()


@router.post('')
def mutate(body: Action, request: Request):
    return service(request).action(body.action)
