#!/usr/bin/env python3
"""Sabotage check: break one protection at a time and confirm a test fails.

    LEASEQ_DATABASE_URL=... python tools/sabotage.py            # all
    LEASEQ_DATABASE_URL=... python tools/sabotage.py --no-e2e   # skip browser ones
    LEASEQ_DATABASE_URL=... python tools/sabotage.py -k body    # names containing "body"

Each entry applies text replacements to the source, runs the named tests, and
restores the files whatever happens. "CAUGHT" means the tests failed with the
sabotage in place. A browser test that is skipped (no Node/Playwright/axe)
counts as "SKIPPED", not as caught. Exit status 1 if anything was missed.
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAST = ["tests/test_api.py", "tests/test_security.py", "tests/test_worker_kinds.py"]
E2E = ["tests/test_dashboard_e2e.py"]
SEC, API, QUEUE, JS = ("leaseq/security.py", "leaseq/api.py", "leaseq/queue.py",
                       "leaseq/dashboard/assets/app.js")

# (name, [(file, old, new), ...], tests). `old` must occur exactly once.
SABOTAGE = [
    ("auth middleware removed", [(API, "app.add_middleware(security.Auth)\n", "")], FAST),
    ("blank token accepted", [(SEC, "    if not token:\n        raise", "    if False:\n        raise")], FAST),
    ("short token accepted", [(SEC, "len(token) < MIN_TOKEN_LENGTH", "False")], FAST),
    ("token compared with ==", [(SEC, "return hmac.compare_digest(_digest(supplied), _digest(expected))",
                                 "return supplied == expected")], FAST),
    ("unlisted routes open", [(SEC, '    return "token"\n', '    return "open" if method != "POST" else "token"\n')], FAST),
    ("public read opens /auth/check", [(SEC, 'PUBLIC_READ_PREFIXES = ("/stats", "/jobs")',
                                        'PUBLIC_READ_PREFIXES = ("/stats", "/jobs", "/auth")')], FAST),
    ("public read on any value", [(SEC, 'os.environ.get("LEASEQ_PUBLIC_READ") == "1"',
                                   'os.environ.get("LEASEQ_PUBLIC_READ") is not None')], FAST),
    ("prefix match not segment-exact", [(SEC, 'return any(path == p or path.startswith(p + "/") for p in prefixes)',
                                         "return path.startswith(prefixes)")], FAST),
    ("body read before auth", [(API, "app.add_middleware(security.BodyLimit)\napp.add_middleware(security.Auth)\n",
                                "app.add_middleware(security.Auth)\napp.add_middleware(security.BodyLimit)\n")], FAST),
    ("body limit removed", [(API, "app.add_middleware(security.BodyLimit)\n", "")], FAST),
    ("Content-Length not checked up front", [(SEC, "            if int(declared) > limit:\n                return await _reply(send, 413, _too_large(limit))\n", "")], FAST),
    ("chunked bodies not counted", [(SEC, "            if total > limit:\n                return await _reply(send, 413, _too_large(limit))\n            chunks.append(body)", "            chunks.append(body)")], FAST),
    ("413 only after the whole body is read", [
        (SEC, "            if total > limit:\n                return await _reply(send, 413, _too_large(limit))\n            chunks.append(body)", "            chunks.append(body)"),
        (SEC, "        buffered, replayed = b\"\".join(chunks), False", "        if total > limit:\n            return await _reply(send, 413, _too_large(limit))\n        buffered, replayed = b\"\".join(chunks), False")], FAST),
    ("kind allow-list removed", [(API, "kind: str = Field(min_length=1, max_length=100, pattern=KIND_PATTERN)",
                                  "kind: str = Field(min_length=1)")], FAST),
    ("DataError handler removed", [(API, "@app.exception_handler(psycopg.errors.DataError)", "@app.exception_handler(KeyError)")], FAST),
    ("422 echoes input again", [(API, "@app.exception_handler(RequestValidationError)", "@app.exception_handler(LookupError)")], FAST),
    ("worker_id limits removed", [(API, "worker_id: str = Field(min_length=1, max_length=200, pattern=WORKER_PATTERN)",
                                   "worker_id: str = Field(min_length=1)")], FAST),
    ("lease_token shape unchecked", [(API, "class CompleteIn(BaseModel):\n    lease_token: str = Field(min_length=1, max_length=64, pattern=TOKEN_PATTERN)",
                                      "class CompleteIn(BaseModel):\n    lease_token: str")], FAST),
    ("error text unbounded", [(API, 'error: str = Field(default="", max_length=4000)', 'error: str = ""')], FAST),
    ("job list cap removed (API)", [(API, "limit: int = Query(50, ge=1, le=queue.MAX_PAGE)", "limit: int = Query(50)")], FAST),
    ("job list cap removed (queue)", [(QUEUE, "    limit = max(1, min(limit, MAX_PAGE))\n    where", "    where")], FAST),
    ("event page cap removed", [(API, "limit: int = Query(200, ge=1, le=queue.MAX_EVENTS_PAGE)", "limit: int = Query(200)")], FAST),
    ("dashboard CSP removed", [(SEC, 'headers.append((b"content-security-policy", DASHBOARD_CSP.encode()))', "pass")], FAST),
    ("cancel keeps the lease", [(QUEUE, "f\"UPDATE jobs SET state = 'dead', lease_token = NULL, lease_expires_at = NULL, \"\n            f\"updated_at = now() WHERE id = %s RETURNING {PUBLIC}\"",
                                 "f\"UPDATE jobs SET state = 'leased', \"\n            f\"updated_at = now() WHERE id = %s RETURNING {PUBLIC}\"")], FAST),
    ("requeue from any state", [(QUEUE, "        if cur[\"state\"] != \"dead\":\n            return None\n", "")], FAST),
    ("stale lease survives requeue", [
        (QUEUE, "f\"UPDATE jobs SET state = %s, lease_token = NULL, lease_expires_at = NULL, \"",
         "f\"UPDATE jobs SET state = %s, lease_expires_at = NULL, \""),
        (QUEUE, "f\"WHERE id = %s AND state = 'leased' AND lease_token = %s RETURNING {PUBLIC}\"",
         "f\"WHERE id = %s AND lease_token = %s RETURNING {PUBLIC}\""),
        (QUEUE, "f\"updated_at = now() WHERE id = %s AND state = 'leased' AND lease_token = %s \"",
         "f\"updated_at = now() WHERE id = %s AND lease_token = %s \""),
        ("leaseq/schema.sql", "    CHECK ((state = 'leased') = (lease_token IS NOT NULL)),\n", "")], FAST),
    ("schema not widened on start", [("leaseq/schema.sql", "        ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_event_check;\n", "        RETURN;\n")], FAST),
    ("worker sends no token", [("leaseq/worker.py", 'headers = {"Authorization": f"Bearer {token}"} if token else {}', "headers = {}")], FAST),
    ("fail_first_n never fails", [("leaseq/worker.py", 'if job["kind"] == "fail_first_n" and job["attempts"] <= int(payload.get("n", 1)):',
                                   'if job["kind"] == "fail_first_n" and False:')], FAST),
    # Browser tests (dashboard)
    ("operator buttons without a token", [(JS, "  if (!app.token) return;                 // read-only: no operator buttons at all\n", "")], E2E),
    ("payload rendered as HTML", [(JS, '  $("payload").textContent = JSON.stringify(job.payload, null, 2);',
                                   '  $("payload").innerHTML = job.payload.note || JSON.stringify(job.payload);')], E2E),
    ("token put in a cookie", [(JS, "  if (app.token) headers.Authorization = `Bearer ${app.token}`;",
                                "  if (app.token) { headers.Authorization = `Bearer ${app.token}`; document.cookie = `t=${app.token}`; }")], E2E),
    ("token left in the input", [(JS, '  $("token-dialog").addEventListener("close", () => { $("token-input").value = ""; });', ""),
                                 (JS, '  $("token-dialog").addEventListener("cancel", () => { $("token-input").value = ""; });   // Escape\n', ""),
                                 (JS, '    $("token-input").value = "";\n    $("token-dialog").close();', '    $("token-dialog").close();'),
                                 (JS, '  saveToken(value);\n  input.value = "";', "  saveToken(value);"),
                                 (JS, '    saveToken(null);\n    $("token-input").value = "";', "    saveToken(null);")], E2E),
    ("job panel kept after a 401", [(JS, "      clearCounts();\n      clearDetail();", "      clearCounts();")], E2E),
]


def apply(patches):
    originals = {}
    for rel, old, new in patches:
        path = ROOT / rel
        text = originals.setdefault(path, path.read_text())
        current = path.read_text()
        if current.count(old) != 1:
            raise SystemExit(f"patch target not found exactly once in {rel}: {old[:60]!r}")
        path.write_text(current.replace(old, new))
    return originals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-e2e", action="store_true")
    ap.add_argument("-k", default="")
    a = ap.parse_args()
    todo = [s for s in SABOTAGE if a.k in s[0] and not (a.no_e2e and s[2] is E2E)]
    for name, patches, _ in todo:                  # check every target first, change nothing
        originals = apply(patches)
        for path, text in originals.items():
            path.write_text(text)
    missed = 0
    for name, patches, tests in todo:
        originals = apply(patches)
        try:
            t0 = time.monotonic()
            r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider",
                                *tests], cwd=ROOT, capture_output=True, text=True, timeout=900)
            last = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
        finally:
            for path, text in originals.items():
                path.write_text(text)
        if r.returncode != 0:
            verdict = "CAUGHT"
        elif "skipped" in last and "passed" not in last:
            verdict = "SKIPPED"
        else:
            verdict, missed = "MISSED", missed + 1
        print(f"{verdict:8s} {name:40s} {last} ({time.monotonic() - t0:.0f} s)", flush=True)
    print(f"\n{len(todo) - missed}/{len(todo)} sabotaged protections caught or skipped; {missed} missed")
    return 1 if missed else 0


if __name__ == "__main__":
    sys.exit(main())
