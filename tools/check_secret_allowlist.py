"""Ensure the CI negative-control exception cannot hide a literal credential."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="leaseq-secret-check-") as directory:
    target = Path(directory)
    report = target / "report.json"

    def scan():
        result = subprocess.run(
            [binary, "dir", ".", "--config", str(root / ".gitleaks.toml"), "--redact=100",
             "--report-format", "json", "--report-path", str(report), "--no-banner"],
            cwd=target, capture_output=True, text=True, timeout=30)
        assert result.returncode in (0, 1), "Secret scan failed to execute"
        return result.returncode, json.loads(report.read_text())

    for name in (".github/workflows/ci.yml", "tools/check_secret_allowlist.py"):
        fixture = target / name
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_text('curl -H "Authorization: Bearer wrong-token-0123456789" https://example.invalid\n')
        code, findings = scan()
        assert code == 0 and not findings, f"Known invalid negative-control token should be allowed: {name}"
        synthetic = hashlib.sha256(b"scanner-only fixture; not an issued credential").hexdigest()
        fixture.write_text(fixture.read_text() + 'curl -H "Authorization: Bearer ' + synthetic + '" https://example.invalid\n')
        report.unlink()
        code, findings = scan()
        assert code == 1 and findings, f"Literal credential-shaped token in the same file must be reported: {name}"
        assert any(item["RuleID"] == "curl-auth-header" for item in findings)
        fixture.unlink()
print("Invalid CI/test tokens allowed; literal credential-shaped tokens in both files detected")
