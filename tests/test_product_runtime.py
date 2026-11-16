"""Direct product pages expose UI only; operational data remains authenticated."""
import json

import psycopg
import pytest


@pytest.mark.parametrize('path', ['/', '/leases', '/dead-letter', '/system'])
def test_product_pages_are_directly_available_without_job_data(client, path):
    response = client.get(path, headers={'Authorization': 'Bearer invalid'})
    assert response.status_code == 200
    assert 'text/html' in response.headers['content-type']
    assert response.headers['x-frame-options'] == 'DENY'
    assert 'default-src' in response.headers['content-security-policy']
    assert 'http://[::1]' not in response.headers['content-security-policy']
    assert client.get('/jobs', headers={'Authorization': 'Bearer invalid'}).status_code == 401


def test_system_requires_auth_and_reports_real_process_totals(client):
    assert client.get('/api/system', headers={'Authorization': 'Bearer invalid'}).status_code == 401
    client.get('/jobs')
    response = client.get('/api/system')
    assert response.status_code == 200
    data = response.json()
    assert data['service'] == 'leaseq'
    assert data['health']['status'] == 'ok'
    assert data['readiness']['status'] == 'ready'
    assert data['uptime_seconds'] >= 0
    assert data['http']['requests_total'] >= 2
    assert data['http']['errors_total'] >= 1
    assert 'DATABASE_URL' not in response.text and 'lease_token' not in response.text


def test_system_and_metrics_handle_dependency_failure_without_killing_liveness(client, monkeypatch):
    def broken(*args, **kwargs):
        raise psycopg.OperationalError('private-database-diagnostic')
    monkeypatch.setattr(client.app.state.pool, 'connection', broken)
    assert client.get('/livez').status_code == 200
    assert client.get('/healthz').status_code == 200
    assert client.get('/readyz').status_code == 503
    system = client.get('/api/system')
    assert system.status_code == 200
    assert system.json()['readiness']['status'] == 'not_ready'
    metrics = client.get('/metrics')
    assert metrics.status_code == 503
    assert 'private-database-diagnostic' not in metrics.text + system.text


def test_request_logs_include_required_fields_without_removing_existing_fields(client, caplog):
    with caplog.at_level('INFO', logger='leaseq.requests'):
        client.get('/livez', headers={'X-Correlation-ID': 'product-runtime-test'})
    data = json.loads([r for r in caplog.records if r.name == 'leaseq.requests'][-1].message)
    for field in ['timestamp', 'level', 'service', 'trace_id', 'latency_ms', 'correlation_id', 'duration_ms']:
        assert field in data
    assert data['trace_id'] == data['correlation_id'] == 'product-runtime-test'


READ_PATHS = ['/stats', '/workers', '/operations/metrics', '/schedules',
              '/jobs', '/jobs/1/events', '/jobs/1']


@pytest.mark.parametrize('path', READ_PATHS)
def test_operational_reads_return_sanitized_503_when_database_unavailable(client, monkeypatch, caplog, path):
    diagnostic = 'private-database-diagnostic postgresql://private-user:private-password@private-host/db'

    def unavailable(*args, **kwargs):
        raise psycopg.OperationalError(diagnostic)

    monkeypatch.setattr(client.app.state.pool, 'connection', unavailable)
    with caplog.at_level('INFO', logger='leaseq.requests'):
        response = client.get(path)
    assert response.status_code == 503
    assert response.json() == {'detail': 'Database read unavailable; retry later.'}
    for private in ['private-database-diagnostic', 'postgresql://', 'private-password',
                    'conftest-token-0123456789abcdef']:
        assert private not in response.text + caplog.text


def test_operational_read_cancels_real_slow_query_within_its_budget(client, monkeypatch):
    import time
    from leaseq import api

    def slow_workers(conn, limit):
        conn.execute('SELECT pg_sleep(6)')
        return {'workers': []}

    with monkeypatch.context() as patch:
        patch.setattr(api.operations, 'workers', slow_workers)
        started = time.monotonic()
        response = client.get('/workers')
        elapsed = time.monotonic() - started
    print(f'slow_workers elapsed_seconds={elapsed:.3f} status={response.status_code}')
    assert response.status_code == 503
    assert 4.5 <= elapsed < 8, 'Five-second SQL timeout plus at most two seconds acquiring a connection.'
    assert 'pg_sleep' not in response.text
    assert client.get('/workers').status_code == 200, 'The canceled transaction must leave the pool usable.'


@pytest.mark.parametrize('error_type', [RuntimeError, psycopg.ProgrammingError])
def test_operational_read_does_not_mask_programming_errors(client, monkeypatch, error_type):
    from leaseq import api

    def broken_reader(conn, limit):
        raise error_type('test reader programming defect')

    monkeypatch.setattr(api.operations, 'workers', broken_reader)
    with pytest.raises(error_type, match='test reader programming defect'):
        client.get('/workers')


def test_operational_read_returns_503_when_real_pool_is_exhausted(client):
    from contextlib import ExitStack
    import time

    pool = client.app.state.pool
    with ExitStack() as occupied:
        for _ in range(pool.max_size):
            occupied.enter_context(pool.connection(timeout=2))
        started = time.monotonic()
        response = client.get('/workers')
        elapsed = time.monotonic() - started
    print(f'exhausted_pool elapsed_seconds={elapsed:.3f} status={response.status_code}')
    assert response.status_code == 503
    assert 1.5 <= elapsed < 4, 'Pool acquisition must stop after two seconds.'
    assert client.get('/workers').status_code == 200
