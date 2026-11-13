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
        e.update({"PATH": f"{bin_dir}:{os.environ['PATH']}", "LEASEQ_URL": url,
                  "LEASEQ_UP_TIMEOUT": "3", **(env or {})})
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


# --- up.sh: .env copied from .env.example, shell token, stalled API ---------------

DOCUMENTED_READ = "sed -n 's/^LEASEQ_API_TOKEN=//p' .env"   # README and up.sh output


def _token_lines(env_file: Path) -> list[str]:
    return [line for line in env_file.read_text().splitlines()
            if line.startswith("LEASEQ_API_TOKEN=")]


def _documented_token(proj: Path) -> str:
    return subprocess.run(["bash", "-c", DOCUMENTED_READ], cwd=proj, capture_output=True,
                          text=True, check=True).stdout.rstrip("\n")


def test_up_fills_the_blank_token_of_a_copied_env_example_in_place(up):
    run, proj, _ = up
    env_file = proj / ".env"
    example = (ROOT / ".env.example").read_text()
    env_file.write_text(example + "COMPOSE_PROJECT_NAME=mine\n")
    others = [line for line in env_file.read_text().splitlines()
              if not line.startswith("LEASEQ_API_TOKEN=")]
    r = run()
    assert r.returncode == 0, r.stdout + r.stderr
    lines = _token_lines(env_file)
    assert len(lines) == 1, lines                      # replaced, not appended
    token = lines[0].split("=", 1)[1]
    assert len(token) >= 32
    assert [line for line in env_file.read_text().splitlines()
            if not line.startswith("LEASEQ_API_TOKEN=")] == others
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    assert _documented_token(proj) == token            # one line, no leading newline
    assert token not in r.stdout + r.stderr


def test_up_refuses_an_env_with_two_token_lines(up):
    run, proj, log = up
    env_file = proj / ".env"
    env_file.write_text("LEASEQ_API_TOKEN=\nLEASEQ_API_TOKEN=other-token-0123456789\n")
    before = env_file.read_bytes()
    r = run()
    assert r.returncode != 0
    assert "more than one" in r.stderr
    assert env_file.read_bytes() == before
    assert not log.exists()                            # docker was never called


def test_smoke_passes_with_the_token_read_from_a_copied_env_example(up, monkeypatch):
    """The documented flow end to end, against real processes instead of Docker:
    cp .env.example .env, scripts/up.sh, read the token the documented way,
    start the API and a worker with it, and run the unchanged scripts/smoke.sh."""
    import harness
    run, proj, _ = up
    shutil.copy(ROOT / ".env.example", proj / ".env")
    assert run().returncode == 0
    token = _documented_token(proj)
    db_url = harness.scratch_database("leaseq_up_smoke")
    monkeypatch.setenv("LEASEQ_API_TOKEN", token)
    monkeypatch.delenv("LEASEQ_PUBLIC_READ", raising=False)
    api, base = harness.start_api(db_url)
    worker = harness.start_worker(db_url, base, "up-smoke", 30)
    try:
        r = subprocess.run(["bash", "-c", f"LEASEQ_API_TOKEN=$({DOCUMENTED_READ}) "
                                          f"'{ROOT / 'scripts' / 'smoke.sh'}' {base}"],
                           cwd=proj, capture_output=True, text=True, timeout=300)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "smoke test passed" in r.stdout
    finally:
        for p in (worker, api):
            p.terminate()
            p.wait()


def test_up_uses_a_token_exported_in_the_shell_and_leaves_env_alone(up):
    run, proj, log = up
    shell_token = "shell-token-0123456789abcdef"
    r = run(env={"LEASEQ_API_TOKEN": shell_token})        # no .env at all
    assert r.returncode == 0, r.stdout + r.stderr
    assert not (proj / ".env").exists()
    assert "using leaseq_api_token from your shell environment" in r.stdout.lower()
    assert ".env" not in r.stdout.split("leaseq is running.")[1].split("Stop:")[0] \
        or "not .env" in r.stdout
    assert shell_token not in r.stdout + r.stderr
    assert log.read_text().splitlines() == ["compose up -d --build"]

    env_file = proj / ".env"                               # .env with another token
    env_file.write_text("LEASEQ_API_TOKEN=file-token-0123456789abcdef\n")
    env_file.chmod(0o600)
    before = env_file.read_bytes()
    r = run(env={"LEASEQ_API_TOKEN": shell_token})
    assert r.returncode == 0, r.stdout + r.stderr
    assert env_file.read_bytes() == before
    assert "using leaseq_api_token from your shell environment" in r.stdout.lower()
    assert "ignored" in r.stdout                           # says .env's token is not used


@pytest.mark.parametrize("value, why", [("", "blank"), ("   ", "blank"), ("short", "16")])
def test_up_refuses_an_unusable_shell_token(up, value, why):
    run, proj, log = up
    r = run(env={"LEASEQ_API_TOKEN": value})
    assert r.returncode != 0
    assert why in r.stderr
    assert not log.exists()
    assert not (proj / ".env").exists()


@pytest.fixture
def stalled_url():
    """Accepts connections and never answers."""
    import socket
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(16)
    held = []
    stop = threading.Event()

    def accept():
        srv.settimeout(0.2)
        while not stop.is_set():
            try:
                held.append(srv.accept()[0])
            except OSError:
                pass
    t = threading.Thread(target=accept, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.getsockname()[1]}"
    stop.set()
    t.join()
    for c in held:
        c.close()
    srv.close()


def test_up_gives_up_on_a_stalled_api_within_the_timeout(up, stalled_url):
    import time
    run, _, _ = up
    t0 = time.monotonic()
    r = run(url=stalled_url, env={"LEASEQ_UP_TIMEOUT": "4"})
    elapsed = time.monotonic() - t0
    assert r.returncode != 0
    assert "did not answer" in r.stderr
    assert elapsed < 4 + 3, f"took {elapsed:.1f}s with LEASEQ_UP_TIMEOUT=4"
