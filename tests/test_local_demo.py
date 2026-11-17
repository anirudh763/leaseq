"""Opt-in demo uses PostgreSQL, separate storage and task-owned processes."""
import time
import pytest
from fastapi.testclient import TestClient
import harness
from leaseq import api, db, local_demo


def test_demo_requires_different_database(db_url):
    with pytest.raises(RuntimeError):
        local_demo.Demo(db_url)


def test_local_demo_isolation_crash_recovery(db_url, monkeypatch):
    demo_url = harness.scratch_database('leaseq_repair_demo')
    monkeypatch.setenv('LEASEQ_DEMO_DATABASE_URL', demo_url)
    monkeypatch.setenv('LEASEQ_API_TOKEN', 'local-demo-test-only-0123456789')
    with TestClient(api.app, base_url='http://127.0.0.1') as client:
        def action(name):
            response = client.post('/local-demo', json={'action': name}, headers={'Origin':'http://127.0.0.1'})
            assert response.status_code == 200, response.text
            return response.json()
        first = client.get('/local-demo').json()
        assert len(first['jobs']) == 4
        assert sorted(j['state'] for j in first['jobs']) == ['dead','done','queued','queued']
        assert len(action('enqueue')['jobs']) == 5
        assert client.post('/local-demo', json={'action':'start'}).status_code == 403
        assert client.get('/local-demo', headers={'Host':'evil.example'}).status_code == 403
        started = action('start')
        active = next(j for j in started['jobs'] if j['state'] == 'leased')
        active_id = active['id']
        assert active['state'] == 'leased' and active['attempts'] == 1
        action('crash')
        assert client.post('/local-demo', json={'action':'complete'}, headers={'Origin':'http://127.0.0.1'}).status_code == 409
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            recovered = client.get('/local-demo').json()
            if recovered['stale_rejected']:
                break
            time.sleep(.25)
        assert recovered['stale_rejected']
        active = next(j for j in recovered['jobs'] if j['id'] == active_id)
        assert active['leased_by'] == 'demo-recovery' and active['attempts'] == 2
        assert recovered['token_fingerprints']['previous'] != recovered['token_fingerprints']['current']
        assert any(e['event'] == 'rejected' for e in active['events'])
        done = action('complete')
        assert next(j for j in done['jobs'] if j['id']==active_id)['state'] == 'done'
        assert next(j for j in action('replay')['jobs'] if j['kind']=='localdemo.failed')['state'] == 'queued'
        second = action('start')
        assert second['stale_rejected'] is False and second['token_fingerprints'] is None
        assert any(j['state'] == 'leased' and j['id'] != active_id for j in second['jobs'])
        action('complete')
        assert client.post('/local-demo', json={'action':'arbitrary-pid'}, headers={'Origin':'http://127.0.0.1'}).status_code == 422
        for _ in range(30):
            response = client.post('/local-demo', json={'action':'enqueue'}, headers={'Origin':'http://127.0.0.1'})
            if response.status_code == 429:
                break
        assert response.status_code == 429
    with db.connect(db_url) as conn:
        assert conn.execute('SELECT count(*) AS n FROM jobs').fetchone()['n'] == 0


def test_disabled_demo(client):
    assert client.get('/local-demo').json() == {'available': False}


def test_demo_idempotent_seed_and_bounded_history(db_url):
    demo_url = harness.scratch_database('leaseq_bounded_demo')
    first = local_demo.Demo(demo_url)
    first.close()
    demo = local_demo.Demo(demo_url)
    try:
        assert len(demo.snapshot()['jobs']) == 4
        for _ in range(8):
            demo.action('enqueue')
        snapshot = demo.snapshot()
        assert len(snapshot['jobs']) == 12
        assert any(j['state'] == 'dead' for j in snapshot['jobs'])
        assert all('lease_token' not in j for j in snapshot['jobs'])
        with pytest.raises(Exception) as exc:
            demo.action('enqueue')
        assert exc.value.status_code == 409
        assert len(demo.snapshot()['jobs']) == 12
    finally:
        demo.close()


def test_reset_only_owned_demo_schema(monkeypatch):
    # Unique scratch names avoid the shared full-suite fixture database.
    main_url = harness.scratch_database('leaseq_reset_main_test')
    demo_url = harness.scratch_database('leaseq_reset_check_demo')
    monkeypatch.setenv('LEASEQ_DATABASE_URL', main_url)
    from leaseq import queue
    with db.connect(main_url) as conn:
        original, _ = queue.enqueue(conn, 'owner.keep', {'private': 'retain'}, 'owner-record')
        before = queue.events(conn, original['id'])[0]
    demo = local_demo.Demo(demo_url)
    try:
        demo.action('start')
        old_process = demo.process
        for _ in range(8):
            demo.action('enqueue')
        assert len(demo.snapshot()['jobs']) == 12
        reset = demo.action('reset')
        assert not old_process.is_alive()
        assert len(reset['jobs']) == 4 and reset['stale_rejected'] is False
        assert sorted(j['state'] for j in reset['jobs']) == ['dead','done','queued','queued']
        assert len(demo.action('reset')['jobs']) == 4
        demo.action('start')
        demo.action('complete')
        demo.action('replay')
        assert any(j['kind']=='localdemo.failed' and j['state']=='queued' for j in demo.snapshot()['jobs'])
        demo.action('reset')
        demo.action('start')
        demo.action('crash')
        demo.action('reset')
        assert demo.stale is None and demo.lease is None
        assert len(demo.snapshot()['jobs']) == 4
    finally:
        demo.close()
    with db.connect(main_url) as conn:
        assert queue.get(conn, original['id']) == original
        assert queue.events(conn, original['id'])[0] == before
        assert conn.execute('SELECT count(*) AS n FROM jobs').fetchone()['n'] == 1
    for invalid_url in (main_url, 'dbname=arbitrary', main_url.replace('leaseq_reset_main_test','leaseq_reset_check_demo')):
        if invalid_url == demo_url:
            continue
        if 'leaseq_reset_check_demo' in invalid_url:
            monkeypatch.setenv('LEASEQ_DATABASE_URL', invalid_url)
        with pytest.raises(RuntimeError):
            local_demo.Demo(invalid_url)
