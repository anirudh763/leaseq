#!/usr/bin/env python3
"""Exercise a production image using disposable, loopback-only Docker resources."""
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
    parser.add_argument("--image", required=True, help="an already-built LeaseQ production image")
    args = parser.parse_args()
    project = "leaseq-hosting-test-" + uuid.uuid4().hex[:12]
    token, password = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="leaseq-hosting-test-") as folder:
        config = Path(folder) / "compose.json"
        config.touch(mode=0o600)
        env = {"LEASEQ_DATABASE_URL": f"postgresql://leaseq:{password}@postgres:5432/leaseq",
               "LEASEQ_API_TOKEN": token, "LEASEQ_PUBLIC_READ": "0"}
        config.write_text(json.dumps({"services": {
            "postgres": {"image": "postgres:16", "environment": {
                "POSTGRES_USER": "leaseq", "POSTGRES_PASSWORD": password, "POSTGRES_DB": "leaseq"},
                "volumes": ["pgdata:/var/lib/postgresql/data"], "healthcheck": {
                    "test": ["CMD", "pg_isready", "-U", "leaseq"], "interval": "1s", "retries": 30}},
            "app": {"image": args.image, "environment": {**env, "PORT": "8090"},
                "ports": [f"127.0.0.1:{port}:8090"],
                "depends_on": {"postgres": {"condition": "service_healthy"}}, "healthcheck": {
                    "test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/readyz',timeout=3)"],
                    "interval": "1s", "timeout": "4s", "retries": 30}},
            "worker": {"image": args.image, "environment": env,
                "command": ["python", "-m", "leaseq.worker", "--api", "http://app:8090", "--worker-id", "hosting-test"],
                "depends_on": {"app": {"condition": "service_healthy"}}}}, "volumes": {"pgdata": {}}}))
        compose = ["docker", "compose", "-p", project, "-f", str(config)]

        def docker(*arguments):
            return subprocess.run([*compose, *arguments], check=True, capture_output=True, text=True)

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
            docker("up", "-d", "--wait", "--wait-timeout", "90")
            assert docker("exec", "-T", "app", "id", "-u").stdout.strip() != "0"
            check = "import importlib.util; assert importlib.util.find_spec('pytest') is None"
            docker("exec", "-T", "app", "python", "-c", check)
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
            print(json.dumps({"production_image": args.image, "nonroot": True, "pytest_absent": True,
                "port_override": True, "private_jobs": True, "worker_result": done["result"],
                "database_outage": {"livez": 200, "readyz": 503}, "restart_preserves_job": True}))
        finally:
            docker("down", "-v", "--remove-orphans")


if __name__ == "__main__":
    main()
