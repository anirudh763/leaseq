"""Install behaviour: the running version and scripts/up.sh. Each test fails
if the behaviour it names is removed. The real Docker path of up.sh (fresh
start, re-run keeps .env, bare compose fails closed) is gated in CI's compose job."""
import os
import re
import shutil
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

import leaseq
from leaseq.api import app

ROOT = Path(__file__).resolve().parent.parent


# --- version ------------------------------------------------------------------

def changelog_version() -> str:
    text = (ROOT / "CHANGELOG.md").read_text()
    m = re.search(r"^## \[?(\d+\.\d+\.\d+)\]? - (\d{4}-\d{2}-\d{2})", text, re.M)
    assert m, "CHANGELOG.md has no '## X.Y.Z - YYYY-MM-DD' heading"
    return m.group(1)


def test_running_version_matches_changelog(client):
    """Guards drift between the code, what /healthz reports and the release notes.
    (The dashboard footer is compared with /healthz in tests/e2e/dashboard.e2e.js.)"""
    assert leaseq.__version__ == "0.1.0"
    assert app.version == leaseq.__version__
    assert client.get("/openapi.json").json()["info"]["version"] == leaseq.__version__
    assert client.get("/healthz").json() == {"ok": True, "version": leaseq.__version__}
    assert changelog_version() == leaseq.__version__


# --- scripts/up.sh -----------------------------------------------------------------

class _Health(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        ok = self.path == "/healthz"
        self.send_response(200 if ok else 404)
        self.end_headers()
        self.wfile.write(b'{"ok": true, "version": "0.1.0"}' if ok else b"")

    def log_message(self, *a):
        pass


@pytest.fixture
def health_url():
    server = HTTPServer(("127.0.0.1", 0), _Health)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture
def up(tmp_path, health_url):
    """Run a copy of scripts/up.sh in an empty project dir with a fake `docker`
    that records its arguments. Returns (run, project_dir, docker_log)."""
    proj, bin_dir = tmp_path / "proj", tmp_path / "bin"
    (proj / "scripts").mkdir(parents=True)
    bin_dir.mkdir()
    shutil.copy(ROOT / "scripts" / "up.sh", proj / "scripts" / "up.sh")
    log = tmp_path / "docker.log"
    fake = bin_dir / "docker"
    fake.write_text(f'#!/bin/sh\necho "$@" >> "{log}"\n')
    fake.chmod(0o755)

    def run(*args, env=None, url=health_url):
        e = {k: v for k, v in os.environ.items() if k != "LEASEQ_API_TOKEN"}
        e.update(PATH=f"{bin_dir}:{os.environ['PATH']}", LEASEQ_URL=url,
                 LEASEQ_UP_TIMEOUT="3", **(env or {}))
        return subprocess.run(["bash", str(proj / "scripts" / "up.sh"), *args], cwd=proj,
                              env=e, capture_output=True, text=True, timeout=60)
    return run, proj, log


def _token(env_file: Path) -> str:
    m = re.search(r"^LEASEQ_API_TOKEN=(\S+)$", env_file.read_text(), re.M)
    assert m, env_file.read_text()
    return m.group(1)


def test_up_creates_private_env_with_random_token_and_starts_compose(up, health_url):
    run, proj, log = up
    r = run("--scale", "demo=0")
    assert r.returncode == 0, r.stdout + r.stderr
    env_file = proj / ".env"
    token = _token(env_file)
    assert len(token) >= 32 and re.fullmatch(r"[0-9a-f]+", token)
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    assert log.read_text().splitlines() == ["compose up -d --build --scale demo=0"]
    assert f"{health_url}/dashboard/" in r.stdout
    assert str(env_file) in r.stdout or ".env" in r.stdout
    assert "docker compose down" in r.stdout
    assert token not in r.stdout + r.stderr          # the secret is not printed


def test_up_never_overwrites_an_existing_env(up):
    run, proj, _ = up
    env_file = proj / ".env"
    env_file.write_text("LEASEQ_API_TOKEN=keep-this-token-0123456789\nOTHER=1\n")
    env_file.chmod(0o644)
    before = env_file.read_bytes()
    r = run()
    assert r.returncode == 0, r.stdout + r.stderr
    assert env_file.read_bytes() == before
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600


def test_up_adds_a_token_to_an_env_without_one_and_keeps_the_rest(up):
    run, proj, _ = up
    env_file = proj / ".env"
    env_file.write_text("COMPOSE_PROJECT_NAME=mine\n")
    assert run().returncode == 0
    text = env_file.read_text()
    assert text.startswith("COMPOSE_PROJECT_NAME=mine\n")
    assert len(_token(env_file)) >= 32


def test_up_tokens_are_random(up, tmp_path):
    run, proj, _ = up
    assert run().returncode == 0
    first = _token(proj / ".env")
    (proj / ".env").unlink()
    assert run().returncode == 0
    assert _token(proj / ".env") != first


def test_up_fails_when_the_api_never_becomes_healthy(up):
    run, _, _ = up
    r = run(url="http://127.0.0.1:9")                  # nothing listens on port 9
    assert r.returncode != 0
    assert "healthz" in r.stderr


def test_env_with_the_token_is_ignored_by_git():
    r = subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=ROOT)
    assert r.returncode == 0, ".env is not in .gitignore"
