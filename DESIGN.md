---
version: 1
name: leaseq dashboard
extends: ui.css            # leaseq/dashboard/assets/ui.css, the shared base; this file lists what app.css adds
dial: ENERGY 1 / RHYTHM 1 / MOTION 1
colors:                    # semantic names only; components never use raw hex
  bg:            { light: "#ffffff", dark: "#0d1117", use: "page, table rows, dialogs", src: "ui.css:7,15" }
  bg-subtle:     { light: "#f6f8fa", dark: "#151b23", use: "header, table head and foot, buttons, JSON blocks, notes", src: "ui.css:7,15" }
  bg-inset:      { light: "#eef1f4", dark: "#010409", use: "button hover/active, tab count pill", src: "ui.css:7,15" }
  fg:            { light: "#1f2328", dark: "#e6edf3", use: "body text, state words", src: "ui.css:7,15" }
  fg-muted:      { light: "#59636e", dark: "#9198a1", use: "secondary text, table headers, 'none', queued icon", src: "ui.css:7,15" }
  border:        { light: "#d1d9e0", dark: "#3d444d", use: "decorative dividers only (tables, boxes, tab baseline)", src: "ui.css:8,16" }
  border-strong: { light: "#818b98", dark: "#656c76", use: "input borders, dialog border", src: "ui.css:8,16" }
  accent:        { light: "#0b57d0", dark: "#4493f8", use: "links, job-id buttons, selected tab underline, primary button, running icon", src: "ui.css:8,16" }
  accent-fg:     { light: "#ffffff", dark: "#0d1117", use: "text on accent", src: "ui.css:8,16" }
  accent-subtle: { light: "#e8f0fe", dark: "#121d2f", use: "selected table row", src: "ui.css:8,16" }
  ok:            { light: "#1a7f37", dark: "#3fb950", use: "done icon, 'Operator mode' label", src: "ui.css:9,17" }
  warn:          { light: "#9a6700", dark: "#d29922", use: "retrying icon", src: "ui.css:9,17" }
  bad:           { light: "#cf222e", dark: "#f85149", use: "dead icon, field errors, banner border, 'Cancel job' text and confirm fill", src: "ui.css:9,17" }
  bad-subtle:    { light: "#ffebe9", dark: "#25171c", use: "error banner background", src: "ui.css:9,17" }
  bad-fg:        { light: "#ffffff", dark: "#0d1117", use: "label on the bad-filled 'Cancel job' confirm button (app token)", src: "app.css:128-129" }
  focus:         { light: "#0b57d0", dark: "#4493f8", use: "2px focus ring, offset 2px", src: "ui.css:10,17,21" }
contrast:                  # WCAG 2.x ratios computed from the hex values above (tool: sRGB relative luminance)
  - { fg: fg,            bg: bg,            light: 15.80, dark: 16.02, need: 4.5 }
  - { fg: fg,            bg: bg-subtle,     light: 14.84, dark: 14.65, need: 4.5 }
  - { fg: fg,            bg: bg-inset,      light: 13.93, dark: 17.38, need: 4.5 }   # tab count pill
  - { fg: fg,            bg: bad-subtle,    light: 13.78, dark: 14.59, need: 4.5 }   # banner text
  - { fg: fg,            bg: accent-subtle, light: 13.79, dark: 14.30, need: 4.5 }   # selected row
  - { fg: fg-muted,      bg: bg,            light: 6.11,  dark: 6.50,  need: 4.5 }
  - { fg: fg-muted,      bg: bg-subtle,     light: 5.74,  dark: 5.94,  need: 4.5 }   # th, table foot
  - { fg: fg-muted,      bg: accent-subtle, light: 5.34,  dark: 5.80,  need: 4.5 }
  - { fg: accent,        bg: bg,            light: 6.39,  dark: 6.11,  need: 4.5 }
  - { fg: accent,        bg: bg-subtle,     light: 6.00,  dark: 5.59,  need: 4.5 }   # header source link
  - { fg: accent,        bg: accent-subtle, light: 5.57,  dark: 5.45,  need: 4.5 }   # job id in selected row
  - { fg: accent-fg,     bg: accent,        light: 6.39,  dark: 6.11,  need: 4.5 }   # primary button, rest
  - { fg: bad-fg,        bg: bad,           light: 5.36,  dark: 5.65,  need: 4.5 }   # danger confirm, rest
  - { fg: bad,           bg: bg,            light: 5.36,  dark: 5.65,  need: 4.5 }   # field errors
  - { fg: bad,           bg: bg-subtle,     light: 5.03,  dark: 5.16,  need: 4.5 }   # 'Cancel job' trigger
  - { fg: bad,           bg: bg-inset,      light: 4.72,  dark: 6.13,  need: 4.5 }   # 'Cancel job' trigger, hover
  - { fg: ok,            bg: bg,            light: 5.08,  dark: 7.45,  need: 4.5 }   # 'Operator mode' label
  - { fg: border-strong, bg: bg,            light: 3.45,  dark: 3.57,  need: 3 }     # input borders
  - { fg: accent,        bg: bg,            light: 6.39,  dark: 6.11,  need: 3 }     # focus ring, tab underline
  - { fg: warn,          bg: accent-subtle, light: 4.25,  dark: 6.70,  need: 3 }     # retrying icon in a selected row (icon, not text)
  - { fg: ok,            bg: accent-subtle, light: 4.43,  dark: 6.65,  need: 3 }     # done icon in a selected row
  - { fg: bad,           bg: bad-subtle,    light: 4.67,  dark: 5.14,  need: 3 }     # banner border (the text says the error)
  # Hover/active of filled buttons: ui.css:25 applies filter:brightness(.92)/(.85), app.css:133 limits the
  # danger button's active state to (.9). The filter scales label and fill alike (checked by sampling a
  # rendered pixel: dark #f85149 hovers to #e44b43).
  - { fg: accent-fg, bg: accent, state: hover,  light: 6.05, dark: 5.27, need: 4.5 }
  - { fg: accent-fg, bg: accent, state: active, light: 5.67, dark: 4.65, need: 4.5 }
  - { fg: bad-fg,    bg: bad,    state: hover,  light: 5.15, dark: 4.89, need: 4.5 }
  - { fg: bad-fg,    bg: bad,    state: active, light: 5.07, dark: 4.72, need: 4.5 }
typography:
  ui:   { family: "Atkinson Hyperlegible (bundled woff2, OFL 1.1)", root: "93.75% (15px at the default 16px)", lineHeight: 1.5, src: "ui.css:4-5,11,19" }
  mono: { family: "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono", use: "job ids, attempts, worker ids, idempotency keys, clock times, JSON, tab counts" }
  scale: { h1: 1rem (header product name, app.css:4), h2: 1.15em (job details, app.css:67), dialog-h2: 1.1em, h3: .95em, body: 1rem, small: .85em, min: "12.75px (th and .small at .85em)" }
spacing: [2, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 24, 28]   # px actually used in app.css and ui.css
rounded: { focus: 2px, md: 6px, label: 2em }   # 2em only for the tab count pill and the 'Operator mode' label
elevation: { page: flat, dialog: "1px border-strong + backdrop rgb(1 4 9/.45)" }   # app.css:93-95
motion:
  default: none
  allowed:
    - { name: ".btn background/border", duration: 120ms, easing: ease, iterations: 1, reduce: off, src: "ui.css:40-41" }
components:
  header:            { base: "ui.css:35-38 + app.css:3-5", parts: "h1.name 'leaseq operations', Counts as of hh:mm:ss (server counts_as_of), Pause updates, Operator mode label, token button, Source on GitHub link" }
  btn:               { base: "ui.css:23-24", radius: md, minTarget: "32px high", states: [hover, active, focus-visible, disabled] }
  btn.primary:       { base: "ui.css:24-25", use: "Use token, Requeue job (confirm), Load sample jobs", states: [hover, active, focus-visible] }
  btn.danger:        { base: "ui.css:27", use: "'Cancel job' in the details panel (opens the confirmation)", states: [hover, active, focus-visible] }
  btn.primary.danger: { base: "app.css:126-133", use: "'Cancel job' in the confirmation dialog only", states: [hover, active, focus-visible] }
  tabs:              { base: "app.css:13-25", role: "tablist with arrow/Home/End keys", minTarget: "40px high", states: [hover, selected, focus-visible] }
  count-pill:        { base: "app.css:23-24", radius: label, note: "shows '–' until the server has answered with counts" }
  banner:            { base: "app.css:9-11", role: alert, states: [hidden, shown], note: "rebuilt only when its text changes" }
  filters:           { base: "app.css:28-36", parts: "Kind, Worker, Job ID inputs with visible labels and linked errors" }
  job-table:         { base: "ui.css:33-34 + app.css:43-52", scroll: "inside a focusable region, sideways", states: [selected row, empty] }
  job-id-button:     { base: "app.css:54-56 (.linkish)", minTarget: "24x24", states: [hover, focus-visible, aria-current] }
  state-badge:       { base: "app.css:58-61", note: "icon in the state colour plus the state word in --fg" }
  details-panel:     { base: "app.css:63-80", note: "sticky beside the table above 960px, below it under 960px" }
  events-list:       { base: "app.css:82-88" }
  json-block:        { base: "app.css:90-91", note: "focusable, scrolls inside, max 16em high" }
  dialog:            { base: "app.css:93-99", use: "token entry, requeue/cancel confirmation" }
  demo-note:         { base: "app.css:118-119", note: "shown only when the table holds demo- jobs" }
  noscript:          { base: "app.css:122-123" }
---

# leaseq dashboard design

## Overview

The dashboard at `/dashboard/` is the operator view of one leaseq queue. Its job is to answer "what state is each job in, who holds its lease, and what happened to it". The focal point is the job table with its state tabs; the details panel (lease history and audit events of one job) opens beside it like the request panel in Chrome DevTools. Chrome is GitHub Primer-like: 1px borders, 6px radius, dense tables, one accent. The page polls `GET /jobs` every 2 seconds and can be paused.

## Colors

Every colour comes from `ui.css` (shared with the other four tools) except one app token:

- `--bad-fg` (`app.css:128-129`): label colour on the `--bad`-filled "Cancel job" confirm button. It mirrors `--accent-fg` (white in light, `#0d1117` in dark) because white on the dark `--bad` (#f85149) is too light; the dark value gives 5.65:1.

Status colours (ok, warn, bad, accent for running) appear only as the icon of a state badge, next to the state word, which is always `--fg`. `--border` (1.43:1 light) is used only for decorative separation; inputs use `--border-strong`.

## Typography

Atkinson Hyperlegible for all UI text, bundled as woff2 with `OFL.txt` (CSP `font-src 'self'`). The root size is `93.75%`, so a larger browser default font size scales the page. Monospace only for machine values: ids, attempts, worker ids, idempotency keys, clock times, JSON and the tab counts. Headings are sans: `h1` is the product name in the header, the screen's job is a visually hidden `h2` "Jobs", the details panel title ("Job 16") is an `h2`, its sections are `h3`.

## Layout

- Breakpoints: 960px (details panel moves below the table and stops being sticky), 600px (filters stack, tighter padding).
- The job table and the lease table scroll sideways inside labelled, focusable regions; the page itself never scrolls sideways (tested at 320 and 640px).
- The state tabs stay on one row and scroll sideways on narrow screens, so the selected underline always sits on the baseline. The baseline is an inset box-shadow so the scroll box does not clip the 2px underline.
- The details panel is `position:sticky` with its own scroll above 960px.

## Elevation and shapes

Flat page. Dialogs get a 1px `--border-strong` border and a dimmed backdrop; no shadows anywhere. Radius 6px on boxes, inputs and buttons; 2em only on the tab count pill and the "Operator mode" label.

Pills, with their reason: the tab count pill separates a real per-state count (from the `/jobs` `counts` object) from the tab word, as Primer's counter does; the "Operator mode" label marks a real state (the server accepted the token). Neither is decoration.

## Motion

None by default. Under `prefers-reduced-motion: no-preference` buttons fade their background and border over 120ms (`ui.css:40`); under `reduce` every animation and transition is off (`ui.css:41`). Nothing loops. The 2-second refresh changes text only, and "Pause updates" stops it.

## Components

- **Buttons** (`.btn`): 32px minimum height; hover and active use `--bg-inset`; filled buttons darken with `brightness(.92)` on hover and `(.85)` on active (`(.9)` for the danger fill), all still at 4.5:1 or more. `ui.css:26` also styles `.btn[aria-pressed="true"]` for toggles with a fixed label; this page has none (see Pause updates). Disabled is 55% opacity with a not-allowed cursor.
- **Destructive actions**: "Cancel job" in the details panel is `.btn.danger` (red label). It opens a `<dialog>` that names the job ("Cancel job 16?"), says what happens, focuses "Keep job", and offers "Cancel job" as `.btn.primary.danger` (filled `--bad`). "Requeue job" is not destructive and stays `.btn.primary`.
- **Pause updates**: one state mechanism, the label ("Pause updates" / "Resume updates"); no `aria-pressed`. The change is announced once in the polite status region.
- **Error banner** (`role="alert"`): rebuilt only when its text or its "Enter API token" button changes, so polling never moves focus to `<body>` and screen readers do not re-announce it every 2 seconds.
- **Tabs**: real `role="tab"` buttons, roving tabindex, arrow/Home/End keys; the selected tab has a 2px accent underline and bold text.
- **Job id buttons** (`.linkish`): buttons styled as links, 24x24 minimum, `aria-current` on the open job.
- **Dialogs**: native `<dialog>` with `showModal()`, Escape closes, focus returns to the trigger.

## States

- **Loading**: header shows "Connecting"; tab counts show "–" (never a guessed 0).
- **Token needed** (401): banner "This server requires the API token to read jobs." with an "Enter API token" button; the table shows one row, "Jobs appear here after you enter the API token."; header shows "Token needed".
- **Empty**: "No jobs yet." with the `python -m leaseq.demo` command and, with a token, a "Load sample jobs" button. Filtered and empty: "No jobs match these filters." with "Clear filters".
- **Error**: "Cannot reach the API. Trying again every 2 seconds." (header "Offline"); any other status: "The API answered HTTP 404. Check that this page is served by the leaseq API; it retries every 2 seconds."; action failures state the HTTP status and the server's detail.
- **Job not found**: the details title keeps the id and the state reads "not found".
- **No JavaScript**: a `<noscript>` paragraph points to the README curl steps and `/openapi.json`.

## Do and don't

- Do render every API string with `textContent`; API data is untrusted.
- Do keep the token in memory only; never in storage, cookies or the URL.
- Do keep inline `style` attributes out of the markup (CSP `style-src 'self'`); set custom properties from JS with `el.style.setProperty` if ever needed.
- Don't rewrite a live region or `role="alert"` with unchanged text on the 2-second timer.
- Don't give a destructive confirm the accent colour.
- Don't add a coloured left stripe to notes; the demo note and the noscript note use the plain 1px border.

## Known gaps

- `code` inside `.small` text (for example "From `job_events`") renders at about 11.7px (.85em x .92em of 15px), below the 12px minimum in the standard.
- On narrow screens the state tabs scroll sideways with no visual cue other than the cut-off last tab.
- `--border-strong` on `--bg-subtle` is 3.24:1 light / 3.26:1 dark; inputs sit on `--bg`, so this pair is not used today.
- Checks are automated (axe-core in light and dark, Playwright keyboard and focus tests). A manual screen-reader check has not been run.
