# LeaseQ dispatch-console design

The dashboard (`leaseq/dashboard/`) is an **operations console** for a local
recovery/reference queue: plain HTML, CSS and JavaScript, no build step, no CDN,
no third-party code. The owner's evening instruction on 2026-11-13 replaces the
shared sidebar shell with an independent cobalt dispatch console. The command
header and wide jobs table serve repeated operator scans; the other four apps
have separate compositions. Atkinson and the existing interaction model stay.

This branch is a design handoff to Claude, not an accepted release. Its layout
and contrast checks must pass alongside the review fixes before root approval.

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
  that expired (a claim with no report before the next claim) and "Current lease".
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
| canvas | #ffffff | #111b2b | page background |
| surface | #ffffff | #17243a | panels, table, dialogs |
| rail | #f2f6fc | #1c2c45 | status strip, table head/foot, code |
| command | #174aa6 | #162e56 | compact desktop command header |
| command text | #ffffff | #edf3fd | header navigation and wordmark |
| command secondary | #e2ebff | #c1d3f3 | purpose and theme boundary |
| ink | #192b43 | #edf3fd | text |
| muted | #4b5e76 | #afc0d8 | secondary text |
| input boundary | #72839b | #869bbb | input and button borders |
| divider | #d8e1ed | #344969 | decorative lines only |
| primary (LeaseQ) | #174aa6 | #aecbff | primary button, links, current nav, focus |
| positive | #12633c | #62d394 | done (always with icon + word) |
| warning | #925400 | #f0b450 | retrying, disconnected notice edge |
| danger | #b42318 | #ff8a80 | dead, errors, Cancel confirm fill |

Measure the current rendered token pairs before release, including header links,
selected navigation, statuses and both themes. Normal text needs 4.5:1;
component boundaries and focus need 3:1. Old shared-shell contrast values are
not evidence for this palette.

**Theme**: light by default, including when the OS prefers dark and on first
visit. `ui.css` no longer has a `prefers-color-scheme` switch. Dark applies only
after "Use dark theme" (command header on desktop, Menu sheet on narrower screens);
`assets/theme.js` applies a remembered choice before first paint. The theme is
the only thing in `localStorage`, read and written inside try/catch.

## Type, spacing, shape

- Atkinson Hyperlegible (local woff2, SIL OFL 1.1), body/UI 16px/1.5, H1 30px/1.2.
- System monospace 14px only for worker ids, idempotency keys, JSON and commands.
- Spacing 4/8/16/24/32. Controls 44px minimum height, radius 7px.
- Panels: 1px divider border, no shadows, no gradients. Motion: none beyond
  state changes; `prefers-reduced-motion` turns transitions off.

## Layout and routes

- Desktop (>= 1000px): cobalt command header with wordmark, purpose, Jobs,
  Submit test job, Connection & API and theme control. A pale connection/status
  strip follows it. The jobs workspace spans up to 1536px with 32px gutters,
  large tabular lane counts and a full-width table. There is no permanent sidebar.
- Below 1000px: no desktop command header; a labelled **Menu** button opens a modal sheet
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
