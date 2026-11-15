#!/usr/bin/env python3
"""Start only the disposable local lab; generate no credential files."""

import argparse
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--stop",
        action="store_true",
        help="stop only the leaseq-local-lab Compose project",
    )
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    root = Path(__file__).resolve().parents[1]
    env = {
        **os.environ,
        "LEASEQ_SANDBOX_DB_PASSWORD": secrets.token_hex(32),
        "LEASEQ_SANDBOX_PORT": str(args.port),
    }
    command = [
        "docker",
        "compose",
        "--project-name",
        "leaseq-local-lab",
        "--file",
        str(root / "docker-compose.sandbox.yml"),
    ]
    if args.stop:
        command += ["down", "--remove-orphans"]
    else:
        print(
            "Starting a disposable local lab. Re-running this command resets only this lab's synthetic data.",
            flush=True,
        )
        command += ["up", "--detach", "--build", "--wait", "--wait-timeout", "120"]
    result = subprocess.run(command, cwd=root, env=env)
    if result.returncode:
        raise SystemExit(result.returncode)
    if not args.stop:
        reachable = False
        for _ in range(40):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/readyz", timeout=2) as response:
                    reachable = response.status == 200
                if reachable:
                    break
            except OSError:
                pass
            time.sleep(.25)
        if not reachable:
            raise SystemExit("The lab started, but its published loopback port is unreachable. Inspect the leaseq-local-lab gateway network and port binding before using it.")
        print(f"Open http://127.0.0.1:{args.port}/console/")
        print(
            "Local only; one run, four real workers, ten-minute expiry. Data is disposable; existing private services are untouched."
        )
        print("Stop with: python3 scripts/sandbox_up.py --stop")


if __name__ == "__main__":
    main()
