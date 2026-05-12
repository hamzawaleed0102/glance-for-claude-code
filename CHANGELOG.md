# Changelog

## 0.0.7 — 2026-05-12

- **Variable-height cards.** Agent cards no longer have a fixed 86px ceiling. They grow and shrink to fit their content (TL;DR, progress, error / needs-input), and the description and progress rows animate in and out smoothly (220ms grid-rows easing) instead of snapping.
- **Persisted state stays visible during revival.** Clicking a dormant agent no longer wipes its card back to a blank "starting session…" state. The persisted title, TL;DR, and progress stay in place; a small `••• starting…` chip pulses in the bottom-right while the PTY warms up.
- **Progress bar shows during error / needs-input too.** Previously the bar was hidden whenever the card carried an error or attention flag, even mid-stream. Now it stays visible until the turn finishes cleanly.
- **Visual polish.** Square corners, slightly more padding, consistent inter-row spacing, bare X close button (no chrome) in the top-right.
- **Slightly rounded Marketplace icon** (rx=24) so the listing tile reads as an app icon, not a flat poster.
- Internal: stripped `console.log` debug noise from the extension host. Failure-path `console.warn` / `console.error` sites kept.

## 0.0.5 — 2026-05-12

- Polish: auto-assigned agent names now read `glance-XX` (matches the product) instead of the legacy `glancer-XX`. Existing renamed cards keep their saved name.
- Polish: manual renames and AI-supplied titles are auto-capitalized on the first letter so cards present consistently.

## 0.0.4 — 2026-05-12

- Add: first-install welcome walkthrough that teaches the activity-bar location plus the focus / spawn / enter / cycle / kill shortcuts. Re-openable any time via **Glance: Show Welcome Tour** in the Command Palette.
- Polish: opaque, full-bleed extension icon so the Marketplace listing doesn't show transparent corners.
- Docs: drop the Marketplace badge from the README (redundant with the listing page itself) and add an author byline.

## 0.0.3 — 2026-05-12

- Docs: trim README to the user-facing surface (remove contributor-only build/test instructions).

## 0.0.2 — 2026-05-12

- Fix: clear the yellow "needs attention" marker when a turn ends, so answering or cancelling an interactive picker no longer leaves the card stuck in a waiting state.
- Improve: clicking a Glance terminal tab in the panel below now highlights its agent card in the sidebar automatically.
- Polish: active agent card has a stronger highlight (layered ring + bolder title) to stand out from the rest of the list.
- Refresh: new app icon and activity-bar glyph.

## 0.0.1 — 2026-05-11

- Initial Marketplace release.
- Multi-session Claude Code agent panel with per-session status cards (title, TL;DR, progress, needs-input, error).
- Real VS Code terminals via `node-pty`, per-agent state via MCP `update_state` tool.
- Activity-bar badge for agents needing attention; `/clear` resets the card; drag-to-reorder.
