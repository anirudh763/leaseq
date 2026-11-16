import json
import subprocess
from pathlib import Path


def test_encrypted_profile_backup_staging_and_atomic_restore():
    script = Path(__file__).with_name("e2e") / "profile_backup.test.cjs"
    result = subprocess.run(["node", str(script)], text=True, capture_output=True, timeout=40)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1])["checks"] >= 15
