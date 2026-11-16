#!/usr/bin/env python3
"""Exercise the production Compose override with disposable loopback resources."""
import argparse
import json
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="leaseq-hosting-test:local",
                        help="temporary image name used by the isolated Compose project")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    project = "leaseq-hosting-test-" + uuid.uuid4().hex[:12]
    token, postgres_password, app_password = secrets.token_hex(32), secrets.token_hex(32), secrets.token_hex(24)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]

    compose_env = {**__import__("os").environ,
                   "LEASEQ_API_TOKEN": token,
                   "LEASEQ_APP_PASSWORD": app_password,
                   "LEASEQ_POSTGRES_PASSWORD": postgres_password}
    with tempfile.TemporaryDirectory(prefix="leaseq-hosting-test-") as folder:
        overlay = Path(folder) / "compose-smoke.yaml"
        overlay.touch(mode=0o600)
        # Only a loopback host-port override and an image label live in this
        # file. All database roles/services come from the checked-in Compose
        # base and production override under test.
        overlay.write_text(
            "services:\n"
            "  app:\n"
            f"    image: {json.dumps(args.image)}\n"
            f'    ports: !override ["127.0.0.1:{port}:8000"]\n'
        )
        compose = ["docker", "compose", "-p", project,
                   "-f", str(root / "docker-compose.yml"),
                   "-f", str(root / "docker-compose.production.yml"),
                   "-f", str(overlay)]

        def docker(*arguments):
            result = subprocess.run([*compose, *arguments], env=compose_env,
                                    capture_output=True, text=True)
            if result.returncode:
                output = result.stdout + result.stderr
                for secret in (token, postgres_password, app_password):
                    output = output.replace(secret, "[redacted]")
                raise RuntimeError(f"docker compose {' '.join(arguments)} failed: {output[-5000:]}")
            return result

        def request(path, body=None, authenticated=False):
            headers = {"Authorization": "Bearer " + token} if authenticated else {}
            if body is not None:
                headers.update({"Content-Type": "application/json", "Idempotency-Key": project})
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.load(response)

        try:
            try:
                docker("up", "-d", "--build", "--wait", "--wait-timeout", "120", "app", "worker")
            except RuntimeError as exc:
                logs = subprocess.run([*compose, "logs", "--no-color", "db-bootstrap"],
                                      env=compose_env, capture_output=True, text=True)
                diagnostic = logs.stdout + logs.stderr
                for secret in (token, postgres_password, app_password):
                    diagnostic = diagnostic.replace(secret, "[redacted]")
                raise RuntimeError(f"{exc}\nbootstrap log (redacted): {diagnostic[-3000:]}") from exc

            assert docker("exec", "-T", "app", "id", "-u").stdout.strip() != "0"
            check = "import importlib.util; assert importlib.util.find_spec('pytest') is None"
            docker("exec", "-T", "app", "python", "-c", check)
            role_check = (
                "import os, psycopg; c=psycopg.connect(os.environ['LEASEQ_DATABASE_URL']); "
                "r=c.execute(\"SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication "
                "FROM pg_roles WHERE rolname=current_user\").fetchone(); "
                "assert r == ('leaseq_app', False, False, False, False), r; c.close()"
            )
            for service in ("app", "worker"):
                docker("exec", "-T", service, "python", "-c", role_check)
            assert request("/jobs")[0] == 401
            assert request("/livez")[0] == request("/readyz")[0] == 200
            status, job = request("/jobs", {"kind": "word_count", "payload": {"text": "one two\nthree"}}, True)
            assert status == 201
            path = f"/jobs/{job['id']}"
            for _ in range(60):
                _, done = request(path, authenticated=True)
                if done["state"] == "done":
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("worker did not complete the synthetic job")
            assert done["result"] == {"words": 3, "lines": 2}
            docker("stop", "postgres")
            assert request("/livez")[0] == 200
            assert request("/readyz") == (503, {"ok": False})
            docker("start", "postgres")
            for _ in range(60):
                if request("/readyz")[0] == 200:
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("readiness did not recover after PostgreSQL restart")
            assert request(path, authenticated=True)[1] == done
            print(json.dumps({"production_override": True, "nonroot": True,
                "pytest_absent": True, "loopback_port_override": True, "private_jobs": True,
                "worker_result": done["result"],
                "database_outage": {"livez": 200, "readyz": 503},
                "restart_preserves_job": True,
                "application_role": {"api_and_worker_non_superuser": True,
                                      "enqueue_claim_ack": True}}))
        finally:
            docker("down", "-v", "--remove-orphans")


if __name__ == "__main__":
    main()
