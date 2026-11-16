import hashlib
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_static_site_build_is_simulator_only_and_digest_complete():
    result = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_static_site.py")], cwd=ROOT,
                            text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    out = ROOT / "docs"
    html = (out / "index.html").read_text()
    assert '<meta name="leaseq-api-base" content="none">' in html
    assert "LOCAL SIMULATION" in html or "Browser Simulator" in html
    assert (out / "og-card.png").is_file()
    assert "No endpoint is configured" in (ROOT / "leaseq" / "dashboard" / "assets" / "interest.js").read_text()
    worker = (out / "sw.js").read_text()
    required = re.search(r"const REQUIRED = \[(.*?)\];", worker, re.S)
    manifest = re.search(r"const SHA256 = Object.freeze\(\{(.*?)\}\);", worker, re.S)
    assert required and manifest
    keys = re.findall(r"'([^']+)'", required.group(1))
    hashes = dict(re.findall(r"'([^']+)': '([a-f0-9]{64})'", manifest.group(1)))
    assert len(keys) == len(hashes)
    for key in keys:
        path = out / ("index.html" if key == "./" else key.removeprefix("./"))
        assert path.is_file(), key
        assert hashlib.sha256(path.read_bytes()).hexdigest() == hashes[key], key
