# LeaseQ canonical navigation and mutation acceptance

Status: **PASS** for the scoped checks below. Final deployed source is **client r15 / worker p6**, healthy image `31a92f67e5df11b5e6d5932f6d2789f4a9476cb14611276eb62f6bca8e455d2e`. The original mutation report is retained unchanged; this is **not a single fresh 100-control run**.

## Versioned mutation evidence

- **55 earlier nonbrowser controls: 55 CAUGHT, 0 MISSED/ERROR/SKIPPED**, with their earlier 135-test baseline green. They were not repeated. Evidence: `sabotage-nonbrowser.json` and `remaining-verification-summary.json`.
- **45 remaining browser controls ran against the frozen client r15 / worker p4 sandbox.** All eight unchanged E2E/REVIEW baseline cases passed in **182.20s**, with no skips/errors and one existing Starlette TestClient deprecation warning.
- The unchanged existing harness ran all 45 with its existing 900-second per-control bound: **44 CAUGHT, 1 MISSED, 0 ERROR/SKIPPED**, in **1566.79s**. All 45 logs were causally audited; all caught failures hit their intended existing assertions. Logs remain private with mode 0600. Original report: `sabotage-browser.json`; audit: `sabotage-browser-audit.json`.
- The missed original control 22 exposed a **test coverage gap**, not an app defect or equivalent mutation. On all four mobile routes, the baseline kept H1 focus after dialog closure; the original mutant briefly focused H1, then stole focus back to Menu. Traces: `focus22-baseline.json` and `focus22-original22.json`.
- The REVIEW test now waits for the **actual dialog close event plus two animation frames**, preserving the previous assertions and time bounds. The **same original control 22** then failed the intended settled-focus check (**1 failed in 23.65s**); unmutated REVIEW passed (**1 passed in 22.75s**). No app fix or mutation-definition change was made. Evidence: `focus22-coverage-closure.json`.
- Effective browser coverage is therefore **44 original catches + 1 caught after focused test coverage closure**. Do not rewrite the original 44/1 report as an all-green original run.

The four actual mutation targets—`app.js`, `app.css`, `theme.js`, and `index.html`—were restored and matched their frozen SHA256 pins and actual source after the batch. Later worker/document-alias changes are separately qualified; frozen version scope must remain explicit. Evidence: `sabotage-browser-target-pins.json` and `sabotage-browser-original-target-parity.json`.

## Earlier navigation and PWA checks

- r14 focused security/static/routes/local-demo/dashboard suite: **81 passed in 219.37s**; root visual recheck **1 passed in 41.09s**, 39 checks and 22 axe scans; route unit checks **4 passed**.
- Deployed r14 canonical flow: **7 flows**, **20 axe states**, five widths, zero page errors. Includes real isolated PostgreSQL crash/expiry/reclaim/stale-fence/completion and safe evidence readback. No persistent database restart/reseed/reset.
- r15 scope fix: **75 focused nonbrowser tests passed in 20.60s**. Real-server PWA/update/security acceptance: **38 assertions**, retained legacy registrations, private request passthrough, guarded multi-tab updates and offline Settings. Static acceptance: **8 viewport/theme cases, 24 axe scans, zero errors**, including actual `/leaseq/` prefix/offline simulator. This describes historical p4 acceptance, not approval of subsequent PWA changes. Evidence: `pwa-scope-r15.json`.

## Final current-source qualification

- Synced exactly six approved worker/API/test files after the independent p6 redirect fix; the strengthened REVIEW test already matched. **222 source/config/static files match** the sandbox, all four original UI mutation-target hashes remain identical, and all 100 existing mutation plans match. Evidence: `current-p6-sandbox-sync.json`.
- Full unchanged browser command from that sandbox: `/Users/anirudhyadav/Downloads/five-app-final-work/leaseq/.venv/bin/python -m pytest -q -x -p no:cacheprovider tests/test_dashboard_e2e.py`: **8 passed, 0 skipped/errors, 1 existing warning in 182.86s**. This includes the strengthened settled-focus REVIEW check. Evidence: `current-final-browser-baseline.json`.
- Root identified an old-prefix cache inspection that could pass with no matching p6 cache. Only that test caller changed: use the exact scoped dashboard cache prefix and require an existing cache, **30 distinct packaged paths**, and known packaged assets before content/private checks. The affected `test_operator_workflows[update_security.e2e.js]` then passed separately: **1 passed, 1 existing warning in 12.42s**, **41 recorded checks**, including the nonempty private-cache proof. This supersedes that one case of the eight-case baseline; the other seven are unchanged. Evidence: `current-p6-update-cache.json` and `current-p6-update-results.json`.
- Independent p6 actual-worker static and live alias gates passed, including redirect query/fragment inheritance and old busy/silent-client voting. Evidence supplied by the PWA owner: `pwa-p6-alias-browser.json`, `pwa-p6-live-browser.json`, and `pwa-scope-p6-deployment.json`.
- Final read-only proof: healthy current image, Git HEAD `03d5d96070e0fe489e78d441caa1c2335258eada`, all **30 served backend pins + 30 static file pins**, all four mutation-target hashes and all 222 source/config/static files match. Main job count stayed **41 before and after**; no main database writes, restart/reseed/reset, commits or pushes. Browser lock released; no checks from this agent remain running. Evidence: `current-p6-final-proof.json`.

Not performed here: manual screen-reader study or a single fresh run of all 100 mutation controls. Independent root/native/PWA evidence is reported separately.
