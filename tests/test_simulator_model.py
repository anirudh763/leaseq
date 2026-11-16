"""Deterministic browser-model checks; these do not start or signal workers."""
import json
import subprocess
from pathlib import Path


def test_bounded_lease_fencing_retry_dlq_and_replay():
    script = Path(__file__).with_name("e2e") / "simulator_model.test.cjs"
    result = subprocess.run(["node", str(script)], text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1])["checks"] >= 12
