"""Both local SDKs make authenticated requests to a real API backed by PostgreSQL."""
import json
import os
import subprocess
import threading
import time

import pytest

from leaseq.sdk import AuthenticationError, LeaseQClient, TaskRegistry, run_worker


@pytest.fixture
def running_api(db_url, monkeypatch):
    monkeypatch.setenv("LEASEQ_API_TOKEN", "sdk-integration-token-0123456789")
    import harness
    process, base = harness.start_api(db_url)
    try:
        yield base
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_python_and_node_clients_submit_claim_and_complete(running_api):
    token = os.environ["LEASEQ_API_TOKEN"]
    client = LeaseQClient(running_api, token)
    submitted = client.submit("python.sdk", {"name": "Python"}, idempotency_key="sdk-python")
    registry, stop = TaskRegistry(), threading.Event()

    @registry.task("python.sdk")
    def python_task(job, context):
        stop.set()
        time.sleep(.35)
        return {"job_key": context.job_key, "greeting": job["payload"]["name"]}

    thread = threading.Thread(target=run_worker, args=(client, registry, "python-sdk", stop),
                              kwargs={"poll_seconds": .01, "lease_seconds": .3}, daemon=True)
    thread.start()
    thread.join(5)
    assert not thread.is_alive()
    completed = client.request("GET", f"/jobs/{submitted['id']}")
    assert completed["state"] == "done"
    assert completed["result"] == {"job_key": "sdk-python", "greeting": "Python"}
    assert client.request("GET", "/workers")["workers"][0]["last_heartbeat_at"]
    invalid = LeaseQClient(running_api, "wrong-sdk-token")
    try:
        invalid.request("GET", "/workers")
        assert False, "expected explicit authentication error"
    except AuthenticationError:
        pass
    finally:
        invalid.close()
    client.close()

    script = r'''
const { LeaseQClient } = require('./sdks/node');
(async () => {
  const client = new LeaseQClient(process.env.LEASEQ_API, process.env.LEASEQ_API_TOKEN);
  const job = await client.submit('node.sdk', {name:'Node'}, {idempotencyKey:'sdk-node'});
  const claimed = await client.claim('node-sdk', ['node.sdk']);
  await client.heartbeat(claimed, 30);
  const result = await client.complete(claimed, {job_key:claimed.idempotency_key, greeting:claimed.payload.name});
  process.stdout.write(JSON.stringify({state:result.state, result:result.result}));
})().catch(() => { process.exitCode = 1; });
'''
    env = {**os.environ, "LEASEQ_API": running_api, "LEASEQ_API_TOKEN": token}
    node = subprocess.run(["node", "-e", script], cwd=os.getcwd(), env=env,
                          capture_output=True, text=True, timeout=20)
    assert node.returncode == 0
    assert json.loads(node.stdout) == {"state": "done", "result": {
        "job_key": "sdk-node", "greeting": "Node"}}
