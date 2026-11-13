# LeaseQ dashboard design

The dashboard (`leaseq/dashboard/`) is an **operations console** for a local
recovery/reference queue: plain HTML, CSS and JavaScript, no build step, no CDN,
no third-party code. This file replaces the earlier dark-first design notes; the
owner's light-first system (2026-11-13) is the source of truth.

## Signature pattern: operations console

- **State lanes** above the job table: All, Queued, Running, Retrying, Done,
  Dead. Each lane shows the server's real count (`GET /jobs` `counts`, at most
  5 s old per API process, with "Counts as of hh:mm:ss") and is a toggle button
  (`aria-pressed`) that filters the table. Unknown counts show "–", never a
  guessed 0.
- **Lease lifecycle timeline** on Job details: one item per audit event
  (enqueued, claimed with worker and lease length, failed with retry delay,
  completed, dead with the error, fence rejections of stale lease tokens,
  operator requeue/cancel). Two derived items are labelled "Derived": a lease
  that expired (a claim with no report before the next claim) and "Running now".
  Heartbeats are not in the audit log, and the page says so.
- **Why it is waiting**: a plain sentence computed from the job's state,
  `run_after` and `lease_expires_at` (ready for a worker, retry backoff until a
  time, running until a lease end, lease expired, dead after N of M attempts).
- **Protected actions**: Requeue and Cancel exist only with an accepted token;
  each opens a confirmation that names the job, its kind and the effect.
  Cancel is the danger style and focuses "Keep job".

## Tokens

| Token | Light (default) | Dark (opt-in) | Use |
|---|---|---|---|
| canvas | #f7f8fa | #10161c | page background |
| surface | #ffffff | #172029 | panels, header, table, dialogs |
| rail | #f0f3f5 | #131b22 | left rail, table head/foot, code |
| ink | #152536 | #e7edf3 | text |
| muted | #4b5e6f | #a9b7c4 | secondary text |
| input boundary | #748694 | #8595a3 | input and button borders |
| divider | #dce2e8 | #2e3c48 | decorative lines only |
| primary (LeaseQ) | #3d5267 | #a9c1d9 | primary button, links, current nav, focus |
| positive | #12633c | #62d394 | done (always with icon + word) |
| warning | #925400 | #f0b450 | retrying |
| danger | #b42318 | #ff8a80 | dead, errors, Cancel confirm fill |

Contrast (WCAG 2.x, computed from the hex values; light / dark): ink on canvas
14.64 / 15.44, ink on surface 15.56 / 13.96, muted on surface 6.71 / 8.04, muted
on lane tint 5.75 / 6.50, primary on surface 8.07 / 8.88, text on primary
8.07 / 9.81, positive 7.30 / 8.83, warning 6.02 / 8.90, danger 6.57 / 7.21,
input boundary on surface 3.76 / 5.35 (non-text, needs 3:1).

**Theme**: light by default, including when the OS prefers dark and on first
visit. `ui.css` no longer has a `prefers-color-scheme` switch. Dark applies only
after "Use dark theme" (rail on desktop, Menu sheet on narrower screens);
`assets/theme.js` applies a remembered choice before first paint. The theme is
the only thing in `localStorage`, read and written inside try/catch.

## Type, spacing, shape

- Atkinson Hyperlegible (local woff2, SIL OFL 1.1), body/UI 16px/1.5, H1 30px/1.2.
- System monospace 14px only for worker ids, idempotency keys, JSON and commands.
- Spacing 4/8/16/24/32. Every interactive element (buttons, inputs, lanes, nav,
  and every link, including links inside sentences) is at least 44 x 44 px;
  a test measures all of them on every route at 320 and 1440 px. Radius 7px.
- Panels: 1px border, no shadows, no gradients, no decorative coloured side
  stripes; a panel's heading says what it is. Motion: none beyond
  state changes; `prefers-reduced-motion` turns transitions off.

## Layout and routes

- Desktop (>= 1000px): 216px rail (text wordmark "LeaseQ", one-line purpose,
  "Work": Jobs, Submit test job; "Setup": Connection & API; theme button) +
  white location header (breadcrumb, connection status, Forget token) +
  workspace with 32px gutter, content max ~1100px.
- Below 1000px: no rail; a labelled **Menu** button opens a modal sheet
  (`<dialog>`: focus stays inside, Escape closes, focus returns to Menu).
- Below 600px: 16px gutter; lanes in 2 columns; header wraps.
- Hash routes: `#/jobs[?state=&kind=&worker=]`, `#/jobs/<id>`, `#/submit`,
  `#/connection`; anything else is a "Not found" screen with a link to Jobs.
  Old links `?job=N` and `?state=…&kind=…&worker=…` are rewritten to these.
- Every route change sets `document.title` ("Screen – LeaseQ"), renders one H1
  and moves focus to it. Back/Forward restore the screen, the filters (they are
  in the URL) and the Submit text (kept in page memory).
- Wide tables scroll inside their own labelled region; the page never scrolls
  sideways at 320px.

## States

- Not connected (401 without a token) and API unreachable are real states with
  their own notice that links to Connection & API. The 401 banner is rebuilt
  only when its text changes (stable live region).
- Loading, empty (with "Load sample jobs" when a token is set), filtered-empty
  (with Clear filters), job not found.
- **Sensitive data**: Forget token and any 401 drop the job list, every cached
  job (payload, result, events) and the Submit result at once; screens render
  only from that state, so Back to a job route cannot show a stale payload, and
  answers to requests sent before the clear are ignored.

## Do and don't

- Do render every API value with `textContent`; never `innerHTML`.
- Do pair every status colour with an icon and a word.
- Don't add fake accounts, monitoring graphs, invented numbers, logos,
  illustrations or marketing copy. Every number on screen comes from the API.
- Don't store the token anywhere but page memory.

## Known gaps

- A manual screen-reader pass has not been run; checks are automated (axe-core)
  plus keyboard-only Playwright flows.
- The timeline cannot show heartbeats, because the queue does not log them.
