---
name: enterprise-ui-polish
description: Refine this repository's operational UI, navigation, forms, status and responsive behavior; use for interface changes and visual acceptance.
---

# Enterprise interface polish

Read the repository design tokens and current user workflow before editing. The owner's 2026-11-14 direction supersedes decorative numbered navigation/cards in older designs.

- Remove artificial 01/02 prefixes and numbered card badges. Preserve meaningful job IDs, packet sequences, offsets, counts and ordered procedures.
- Use concise navigation labels and Lucide icons from a versioned official source; retain the actual licence notices. Adjacent-label icons are decorative (`aria-hidden`); icon-only controls need accessible names.
- Display one clear status per decision. Distinguish native/queue/model results from application evidence completeness; never fabricate engine output or confidence.
- Use semantic color/focus tokens, 8px spacing rhythm, readable labelled inputs, 44px actionable targets and tabular numerals. Preserve each app's distinct light identity.
- A report viewer must be an operable details/drawer with accessible name, keyboard behavior, scroll bounds and real content. Do not ship inert controls, dead links, unstyled file fields, raw JSON as the primary user flow, or duplicated status strings.
- Validate 320/768/1440 layouts, keyboard/focus/history, live status announcements, target sizes, overflow and loading/empty/success/error/retry/cancel states. Run Playwright/axe and inspect screenshots; record actual failures and console errors.
- Pricing/cloud panels label proposed versus available functionality. Use real engine-derived previews; no fake KMS/notary/worker/model calls. Collect email only through a configured, working endpoint with explicit privacy/retention and abuse controls; otherwise do not display a fake working capture form.
- Keep actual repository/data licenses and permissions intact. Never label third-party issue text CC-BY or existing MIT code AGPL without verified rights and an explicit licensing decision.
- After a behavior fix reproduce the failure when practical, then verify the corrected path and adjacent states. No artificial failing tests for prose/cosmetics. Keep reports concise and evidence-linked.
