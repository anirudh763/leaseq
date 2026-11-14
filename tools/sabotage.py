#!/usr/bin/env python3
"""Sabotage check: break one protection at a time and confirm a test fails.

    LEASEQ_DATABASE_URL=... python tools/sabotage.py            # all
    LEASEQ_DATABASE_URL=... python tools/sabotage.py --no-e2e   # skip browser ones
    LEASEQ_DATABASE_URL=... python tools/sabotage.py -k body    # names containing "body"

Each entry applies text replacements to the source, runs the named tests, and
restores the files whatever happens. "CAUGHT" means the tests failed with the
sabotage in place. A browser test that is skipped (no Node/Playwright/axe)
counts as "SKIPPED", not as caught. Skips and test-runner errors fail the gate.
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAST = ["tests/test_api.py", "tests/test_security.py", "tests/test_worker_kinds.py",
        "tests/test_audit_round2.py", "tests/test_usability.py", "tests/test_schema_startup.py",
        "tests/test_counts_cache.py", "tests/test_permanent_error.py"]
E2E = ["tests/test_dashboard_e2e.py"]
REVIEW = ["tests/test_dashboard_e2e.py::test_dashboard_review_fixes"]
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
    ("payload depth unchecked", [(API, '    _payload_depth = field_validator("payload")(check_json_depth)\n', "")], FAST),
    ("result depth unchecked", [(API, '    _result_depth = field_validator("result")(check_json_depth)\n', "")], FAST),
    ("triggers recreated on every start", [("leaseq/schema.sql", "DO $$\nBEGIN\n    -- Only unfinished",
        "DROP TRIGGER IF EXISTS job_events_no_update_delete ON job_events;\nDO $$\nBEGIN\n    -- Only unfinished")], FAST),
    ("word_count input unbounded", [("leaseq/worker.py", "    if len(text) > WORD_COUNT_MAX_CHARS:\n", "    if False:\n")], FAST),
    ("word_count returns no counts", [("leaseq/worker.py", '        return word_count(payload.get("text"))\n', "        pass\n")], FAST),
    ("backoff exponent unclamped", [(QUEUE, "BACKOFF_BASE * 2 ** min(attempts - 1, 30))", "BACKOFF_BASE * 2 ** (attempts - 1))")], FAST),
    # Startup DDL takes no table lock when up to date, and is bounded when it must (test_schema_startup.py)
    ("index created unguarded on every start", [("leaseq/schema.sql", "    IF to_regclass('jobs_unfinished') IS NULL THEN\n        CREATE INDEX jobs_unfinished",
                                                 "    IF true THEN\n        CREATE INDEX IF NOT EXISTS jobs_unfinished")], FAST),
    ("startup DDL without lock_timeout", [("leaseq/db.py", '            conn.execute("SELECT set_config(\'lock_timeout\', %s, true)", (SCHEMA_LOCK_TIMEOUT,))\n', "")], FAST),
    # Dashboard counts: bounded staleness, declared age (test_counts_cache.py)
    ("counts computed on every poll", [(QUEUE, "return self._value is not None and self.clock() - self._taken < self.max_age", "return False")], FAST),
    ("counts recomputed by every waiting request", [(QUEUE, "            if not self._fresh():                 # another request may have refreshed it\n",
                                                     "            if True:\n")], FAST),
    ("counts age not reported", [(API, '"counts_as_of": as_of, ', "")], FAST),
    # PermanentJobError: ends the job now; everything else still retries (test_permanent_error.py)
    ("permanent errors retried (worker)", [("leaseq/worker.py", '        body["permanent"] = True\n', "        pass\n")], FAST),
    ("permanent flag ignored (queue)", [(QUEUE, "        if permanent:\n", "        if False:\n")], FAST),
    ("permanent flag dropped (API)", [(API, "body.error, permanent=body.permanent)", "body.error)")], FAST),
    ("every error treated as permanent", [("leaseq/worker.py", "    if isinstance(exc, PermanentJobError):", "    if True:")], FAST),
    ("word_count oversize retried", [("leaseq/worker.py", 'raise PermanentJobError(f"word_count: payload.text has', 'raise ValueError(f"word_count: payload.text has')], FAST),
    ("permanent flag not a strict boolean", [(API, "    permanent: StrictBool = False", "    permanent: bool = False")], FAST),
    ("permanent dead row without reason", [(QUEUE, '{"error": error, "permanent": True, "reason": "permanent error: not retried"}', '{"error": error}')], FAST),
    # Install and release hygiene (tests/test_usability.py)
    ("version missing from /healthz", [(API, 'return {"ok": True, "version": __version__}', 'return {"ok": True}')], FAST),
    # Not listed: dropping FastAPI(version=...) cannot be caught while the
    # version is 0.1.0, because that is FastAPI's own default version.
    ("up.sh overwrites an existing token", [("scripts/up.sh", 'if [ "$count" = 1 ] && ! blank "$current"; then', "if false; then")], FAST),
    ("up.sh leaves .env readable by others", [("scripts/up.sh", '  chmod 600 "$ENV_FILE"\n', ""),
                                               ("scripts/up.sh", "        umask 077                              # a new .env is never world-readable\n", "")], FAST),
    ("up.sh appends instead of filling a blank token", [("scripts/up.sh", 'if [ "$count" = 1 ]; then\n      # Fill', 'if false; then\n      # Fill')], FAST),
    ("up.sh ignores the shell token", [("scripts/up.sh", 'if [ -n "${LEASEQ_API_TOKEN+set}" ]; then', "if false; then")], FAST),
    ("up.sh health check without a per-request timeout", [("scripts/up.sh", '--connect-timeout "$left" --max-time "$left" ', "")], FAST),
    ("up.sh does not wait for /healthz", [("scripts/up.sh", 'echo "The API did not answer $URL/healthz within ${TIMEOUT}s. See: docker compose logs app" >&2\nexit 1',
                                           'exit 0')], FAST),
    (".env not ignored by git", [(".gitignore", "\n.env\n", "\n")], FAST),
    # Browser tests (dashboard)
    ("operator buttons without a token", [(JS, "function actions(job) {\n  if (!app.token) {", "function actions(job) {\n  if (false) {")], E2E),
    ("payload rendered as HTML", [(JS, '        el("pre", { class: "json", id: "payload", tabindex: "0", "aria-label": "Payload JSON",\n                    text: JSON.stringify(job.payload, null, 2) }),',
                                   '        Object.assign(el("pre", { class: "json", id: "payload" }), { innerHTML: job.payload.note || JSON.stringify(job.payload) }),')], E2E),
    ("token put in a cookie", [(JS, "  if (app.token) headers.Authorization = `Bearer ${app.token}`;",
                                "  if (app.token) { headers.Authorization = `Bearer ${app.token}`; document.cookie = `t=${app.token}`; }")], E2E),
    ("audit detail rendered as HTML", [(JS, '    detail.length ? el("span", { class: "ev-detail" }, ...detail) : null);',
        '    detail.length ? Object.assign(el("span", { class: "ev-detail" }), { innerHTML: detail.map((d) => (typeof d === "string" ? d : d.outerHTML)).join("") }) : null);')], E2E),
    ("demo-data note never shown", [(JS, '  $("demo-note").hidden = !jobs.some((j) => j.idempotency_key.startsWith("demo-"));',
                                      '  $("demo-note").hidden = true;')], E2E),
    ("Forget keeps job data until the next poll", [(JS, '  app.token = null;\n  clearSensitive();\n  setConn("unknown");', '  app.token = null;\n  setConn("unknown");')], E2E),
    ("Forget/401 keep cached job details", [(JS, "  app.list = null;\n  app.details.clear();\n", "  app.list = null;\n")], E2E),
    ("in-flight job read repopulates after Forget", [(JS, "  if (gen !== app.authGen) return;\n  if (jr.status === 401 || er.status === 401)", "  if (jr.status === 401 || er.status === 401)")], E2E),
    ("footer version drifts from /healthz", [(JS, '$("version").textContent = `leaseq ${app.version}`;', '$("version").textContent = "leaseq 0.0.9";')], E2E),
    ("noscript message removed", [("leaseq/dashboard/index.html", '<noscript><p class="noscript">', '<noscript><p class="nojs">')], E2E),
    # Design standard: stable live region, one toggle mechanism, danger confirm.
    ("banner rebuilt on every poll", [(JS, "  if (!b.hidden && b.dataset.key === key) return;\n", "")], E2E),
    ("pause has label and aria-pressed", [(JS, '  $("pause").textContent = app.paused ? "Resume updates" : "Pause updates";\n',
        '  $("pause").textContent = app.paused ? "Resume updates" : "Pause updates";\n  $("pause").setAttribute("aria-pressed", app.paused ? "true" : "false");\n')], E2E),
    ("cancel confirm styled like requeue", [(JS, 'yes.className = "btn primary danger";', 'yes.className = "btn primary";')], E2E),
    ("HTTP error banner without next step", [(JS, '"served by the leaseq API; it retries every 2 seconds."', '""')], E2E),
    ("no empty-state row without a token", [(JS, '? el("p", {}, "Jobs appear here after you connect. ", el("a", { href: "#/connection", text: "Enter the API token" }))', '? el("p", {})')], E2E),
    # Polling: none while hidden, refresh on return, counts age shown (dashboard.e2e.js 3a)
    ("hidden tab keeps polling", [(JS, "  if (!app.paused && !document.hidden) refresh();\n}", "  if (!app.paused) refresh();\n}"),
                                  (JS, "  if (document.hidden) { stopPolling(); return; }\n", "")], E2E),
    ("no refresh when the tab is visible again", [(JS, "  startPolling();\n  tick();\n}", "  startPolling();\n}")], E2E),
    ("counts age not shown", [(JS, '$("updated").textContent = `Counts as of ${clock(body.counts_as_of)}`;',
                               '$("updated").textContent = `Updated ${clock(new Date().toISOString())}`;')], E2E),
    ("pause does not stop polling", [(JS, "  if (!app.paused && !document.hidden) refresh();\n}", "  if (!document.hidden) refresh();\n}")], E2E),
    # Light rebuild: root visual gate and the operations console (visual_gate.e2e.js)
    ("OS dark preference switches the theme", [("leaseq/dashboard/assets/theme.js", '  var theme = "light";',
        '  var theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";')], E2E),
    ("route change leaves focus behind", [(JS, "    window.scrollTo(0, 0);\n    focusH1();", "    window.scrollTo(0, 0);")], E2E),
    ("Menu navigation leaves focus on Menu", [(JS, '    if (sheet.returnValue === "navigate") focusH1();\n',
        '    if (sheet.returnValue === "navigate") button.focus();\n')], REVIEW),
    ("old ?job= links not migrated", [(JS, "  migrateOldLink();\n  initMenu();", "  initMenu();")], E2E),
    ("state lanes show a guessed 0", [(JS, 'b.querySelector(".count").textContent = counts ? String(l.count(counts)) : NO_COUNT;',
                                       'b.querySelector(".count").textContent = counts ? String(l.count(counts)) : "0";')], E2E),
    ("lifecycle timeline drops claims", [(JS, '      list.append(step("claimed", e.created_at,', '      if (false) list.append(step("claimed", e.created_at,')], E2E),
    ("requeue confirm does not name the job", [(JS, "`Job ${job.id} (${job.kind}) goes back to the queue with 3 more attempts. `",
                                                "`It goes back to the queue with 3 more attempts. `")], E2E),
    ("submit result computed in the browser", [(JS, "  const job = s.job;\n  const link",
        "  const job = { ...s.job, state: \"done\", leased_by: \"browser\", result: { words: app.submitDraft.split(/\\s+/).length, lines: 1 } };\n  const link")], E2E),
    ("submit text not bounded", [(JS, "if (v.length > WC_MAX) return fail(", "if (false) return fail(")], REVIEW),
    ("paste silently truncated", [(JS, 'id: "wc-text", name: "text", spellcheck:', 'id: "wc-text", name: "text", maxlength: WC_MAX, spellcheck:')], REVIEW),
    ("events failure reported as job success", [(JS, "const failed = jr.status !== 200 ? jr : er;", "const failed = jr;")], REVIEW),
    ("events failure names wrong endpoint", [(JS, 'const path = jr.status !== 200 ? `/jobs/${id}` : `/jobs/${id}/events`;', 'const path = `/jobs/${id}`;')], REVIEW),
    ("network failure loses endpoint", [(JS, 'failure.path = path.split("?")[0];', 'failure.path = "";')], REVIEW),
    ("late failure ignores token generation", [(JS, 'if (gen !== app.authGen || key !== app.routeKey) return;', 'if (key !== app.routeKey) return;')], REVIEW),
    ("late failure ignores route change", [(JS, 'if (gen !== app.authGen || key !== app.routeKey) return;', 'if (gen !== app.authGen) return;')], REVIEW),
    ("anonymous probe uses uncached stats", [(JS, 'api(app.token ? "/auth/check" : "/jobs?limit=1")', 'api(app.token ? "/auth/check" : "/stats")')], REVIEW),
    ("Cancel promises to stop claimed work", [(JS, '"so it is unavailable for future claims. Previously claimed work may still be running; "', '"so it will not be run. "')], REVIEW),
    ("Cancel omits external effects caveat", [(JS, 'This does not undo external effects.', 'Cancellation finishes immediately.')], REVIEW),
    ("Cancel initially focuses danger action", [(JS, '  d.showModal();\n  $("confirm-no").focus();', '  d.showModal();\n  $("confirm-yes").focus();')], REVIEW),
    ("breadcrumb targets too short", [("leaseq/dashboard/assets/app.css", '.crumbs a{color:var(--muted)}', '.crumbs a{color:var(--muted);min-height:20px}')], REVIEW),
    ("job links too narrow", [("leaseq/dashboard/assets/app.css", '.job-link{display:inline-flex;', '.job-link{min-width:8px!important;display:inline-flex;')], REVIEW),
    ("footer links too short", [("leaseq/dashboard/assets/app.css", '.app-footer #version{margin-left:8px}', '.app-footer #version{margin-left:8px}\n.app-footer a{min-height:20px!important}')], REVIEW),
    ("input counter does not update", [(JS, '    if (app.submitIntent && app.submitIntent.text !== text.value) app.submitIntent = null;\n    setCount();\n  });', '    if (app.submitIntent && app.submitIntent.text !== text.value) app.submitIntent = null;\n  });')], REVIEW),
    ("input draft lost on navigation", [(JS, 'text.addEventListener("input", () => {\n    app.submitDraft = text.value;', 'text.addEventListener("input", () => {\n    app.submitDraft = "";')], REVIEW),
    ("invalid input lacks accessible state", [(JS, 'text.setAttribute("aria-invalid", "true"); text.focus();', 'text.focus();')], REVIEW),
    ("late Jobs HTTP error changes new route", [(JS, '  if (key !== app.routeKey) return;         // this response belongs to an earlier view\n', '')], REVIEW),
]


def planned_changes(patches):
    originals = {}
    changed = {}
    for rel, old, new in patches:
        path = ROOT / rel
        originals.setdefault(path, path.read_text())
        current = changed.get(path, originals[path])
        if current.count(old) != 1:
            raise SystemExit(f"patch target not found exactly once in {rel}: {old[:60]!r}")
        changed[path] = current.replace(old, new)
    return originals, changed


def apply(patches):
    originals, changed = planned_changes(patches)
    try:
        for path, text in changed.items():
            path.write_text(text)
    except BaseException:
        for path, text in originals.items():
            path.write_text(text)
        raise
    return originals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-e2e", action="store_true")
    ap.add_argument("-k", default="")
    ap.add_argument("--report", type=Path, help="save verdicts as JSON and individual test logs alongside it")
    a = ap.parse_args()
    todo = [s for s in SABOTAGE if a.k in s[0] and not (a.no_e2e and s[2] in (E2E, REVIEW))]
    for name, patches, _ in todo:                  # check every target first, change nothing
        planned_changes(patches)
    records = []
    log_dir = a.report.with_suffix("") if a.report else None
    if log_dir:
        log_dir.mkdir(parents=True, exist_ok=True)
    for index, (name, patches, tests) in enumerate(todo, 1):
        originals = apply(patches)
        t0 = time.monotonic()
        try:
            r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider",
                                *tests], cwd=ROOT, capture_output=True, text=True, timeout=900)
            last = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
            if r.returncode not in (0, 1) or re.search(r"\b[1-9]\d* errors?\b", last):
                verdict = "ERROR"
            elif re.search(r"\b[1-9]\d* skipped\b", last):
                verdict = "SKIPPED"
            elif r.returncode == 1 and re.search(r"\b[1-9]\d* failed\b", last):
                verdict = "CAUGHT"
            elif r.returncode != 0:
                verdict = "ERROR"
            else:
                verdict = "MISSED"
            output = r.stdout + "\n" + r.stderr
        except subprocess.TimeoutExpired:
            verdict, last, output = "ERROR", "test runner timed out", "test runner timed out"
        finally:
            for path, text in originals.items():
                path.write_text(text)
        seconds = round(time.monotonic() - t0, 2)
        record = {"name": name, "verdict": verdict, "summary": last, "seconds": seconds, "tests": tests}
        if log_dir:
            log = log_dir / f"{index:03d}.log"
            log.write_text(output)
            record["log"] = str(log)
        records.append(record)
        if a.report:
            a.report.write_text(json.dumps(records, indent=2) + "\n")
        print(f"{verdict:8s} {name:40s} {last} ({seconds:.0f} s)", flush=True)
    caught = sum(record["verdict"] == "CAUGHT" for record in records)
    print(f"\n{caught}/{len(todo)} sabotaged protections caught; {len(todo) - caught} incomplete or missed")
    return 0 if todo and caught == len(todo) else 1


if __name__ == "__main__":
    sys.exit(main())
