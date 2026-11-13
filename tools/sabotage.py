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
FAST = ["tests/test_api.py", "tests/test_security.py", "tests/test_worker_kinds.py",
        "tests/test_audit_round2.py", "tests/test_usability.py", "tests/test_schema_startup.py",
        "tests/test_counts_cache.py", "tests/test_permanent_error.py"]
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
    ("Menu sheet does not return focus", [(JS, '    if (window.getComputedStyle(button).display !== "none") button.focus();\n', "")], E2E),
    ("old ?job= links not migrated", [(JS, "  migrateOldLink();\n  initMenu();", "  initMenu();")], E2E),
    ("state lanes show a guessed 0", [(JS, 'b.querySelector(".count").textContent = counts ? String(l.count(counts)) : NO_COUNT;',
                                       'b.querySelector(".count").textContent = counts ? String(l.count(counts)) : "0";')], E2E),
    ("lifecycle timeline drops claims", [(JS, '      list.append(step("claimed", e.created_at,', '      if (false) list.append(step("claimed", e.created_at,')], E2E),
    ("requeue confirm does not name the job", [(JS, "`Job ${job.id} (${job.kind}) goes back to the queue with 3 more attempts. `",
                                                "`It goes back to the queue with 3 more attempts. `")], E2E),
    ("submit result computed in the browser", [(JS, "  const job = s.job;\n  const link",
        "  const job = { ...s.job, state: \"done\", leased_by: \"browser\", result: { words: app.submitDraft.split(/\\s+/).length, lines: 1 } };\n  const link")], E2E),
    ("submit allowed over the limit", [(JS, "    submitBtn.disabled = over;\n", "    submitBtn.disabled = false;\n"),
                                        (JS, "  if (charCount(v) > WC_MAX) return fail(overLimitMessage(charCount(v)));\n", "")], E2E),
    ("long paste silently cut by maxlength", [(JS, '{ id: "wc-text", name: "text", spellcheck: "false",', '{ id: "wc-text", name: "text", maxlength: WC_MAX, spellcheck: "false",')], E2E),
    ("Forget/401 keep the Submit text", [(JS, '  app.submitDraft = "";      // text typed for a job is a would-be payload: dropped too\n', "")], E2E),
    ("failing events call reported as HTTP 200", [(JS, "`${call} answered HTTP ${status}. It retries every 2 seconds.`", "`The API answered HTTP ${jr.status}. It retries every 2 seconds.`")], E2E),
    ("Submit/Connection poll uncached /stats", [(JS, 'const r = await api(app.token ? "/auth/check" : "/jobs?limit=1");', 'const r = await api(app.token ? "/auth/check" : "/stats");')], E2E),
    ("endpoint table says token for public reads", [(JS, '["GET", "/jobs/{id}", "One job", "unless public read"],', '["GET", "/jobs/{id}", "One job", "yes"],')], E2E),
    # 44 x 44 px targets on every route (visual_gate.e2e.js 8c)
    ("job id links back to 24px", [("leaseq/dashboard/assets/app.css", ".job-link{font-weight:700}",
                                    ".job-link{font-weight:700}\na.job-link.job-link{display:inline;min-height:0;min-width:0}")], E2E),
    ("nav links shrink to 32px", [("leaseq/dashboard/assets/app.css", ".nav a{display:flex;align-items:center;min-height:44px;",
                                   ".nav a{display:flex;align-items:center;min-height:32px;")], E2E),
    ("state lanes shrink", [("leaseq/dashboard/assets/app.css", "gap:2px;min-height:76px;padding:10px 14px 12px;", "gap:0;min-height:0;padding:0;"),
                            ("leaseq/dashboard/assets/app.css", ".lane .count{font-size:1.5rem;", ".lane .count{display:none;font-size:1.5rem;"),
                            ("leaseq/dashboard/assets/app.css", "  .lane{min-height:64px;padding:8px 12px}\n", "")], E2E),
    ("links in text lose their 44px box", [("leaseq/dashboard/assets/app.css", "a:not(.btn){display:inline-flex;align-items:center;min-height:44px;min-width:44px;vertical-align:middle}", "")], E2E),
    ("long event tokens widen the page", [("leaseq/dashboard/assets/app.css", ".timeline > li{position:relative;padding:0 0 16px 36px;overflow-wrap:anywhere;min-width:0}", ".timeline > li{position:relative;padding:0 0 16px 36px}"),
                                          ("leaseq/dashboard/assets/app.css", ".timeline .ev-title{font-weight:700;overflow-wrap:anywhere}", ".timeline .ev-title{font-weight:700}"),
                                          ("leaseq/dashboard/assets/app.css", ".timeline .ev-detail{display:block;color:var(--muted);font-size:.9375rem;overflow-wrap:anywhere}", ".timeline .ev-detail{display:block;color:var(--muted);font-size:.9375rem}")], E2E),
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
