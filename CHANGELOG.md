# Changelog

## 0.0.28 — 2026-05-22

- **Polish: the session rename now lands instantly.** The `/rename` that syncs a session to its card title is sent the moment Claude assigns the title, instead of waiting for the turn to finish. If you're part-way through typing a message, it still holds until you've sent what you typed.

## 0.0.27 — 2026-05-21

- **New: the session name follows the card title.** When Claude assigns a title to a session, Glance now sends `/rename <title>` into that terminal so the session and its card share one name. Glance waits for an empty input box first — if you're mid-message, the rename holds until you've sent or cleared what you typed, so it never lands on top of half-typed text.

## 0.0.26 — 2026-05-21

- **New: plain shell terminals.** Press `t` with the panel focused to spawn an ordinary shell terminal as a Glance card — no Claude, no MCP, no hooks. The card titles itself from the first command you run and shows a working dot while a command runs. Shell cards are ephemeral — they vanish on reload — and carry a cyan tab marker to set them apart from green Claude cards.
- **New: rename a card from the keyboard.** Press `r` with a card highlighted to open its title for inline editing — the keyboard equivalent of double-clicking. The box opens with the whole name selected; `Enter` saves, `Esc` cancels, and focus returns to the panel afterward. Works on Claude and shell cards alike.
- **Polish: tighter agent-card spacing** — reduced padding, row gaps, and inter-card margin so more of the fleet fits on screen at once.
- **Internal: the panel keyboard map is now a pure, unit-tested module.** `AgentList`'s keydown handler delegates to `resolveAgentListKey`; 28 tests cover every shortcut, the `c c` / `p p` chords, arrow wrap-around, and modifier guards.

## 0.0.25 — 2026-05-18

- **Fix: drag order survives a card deletion**, the FLIP reorder animation is scroll-safe, and killing a card moves focus to a sensible neighbour instead of dropping it.

## 0.0.24 — 2026-05-15

- **New: pin agent cards.** Press `p` twice within 400 ms with a card focused to pin it. Pinned cards animate to the top of the list (FIFO), refuse `Cmd+Backspace` / X deletion, and persist across reloads. Press `p p` again or click the pin icon to unpin. `/clear` still works on pinned cards. Reorders use a FLIP-based slide so cards smoothly move into place instead of snapping.
- **New: closing a terminal from the VS Code panel kills the agent card.** Clicking the trash/X on a Glance terminal in VS Code's bottom panel now removes the corresponding card — matching what the in-sidebar trash button does, instead of leaving an orphan dormant entry. Cmd+R reload and full window-quit are filtered out so they still leave cards dormant for next launch.

## 0.0.17 — 2026-05-13

- **Fix: focused card no longer ping-pongs after rapid `g` presses.** Each new-agent spawn was scheduling four focus-stealing retries — pressing `g` three times queued twelve setTimeouts that ground the active card around for ~1.6 s and overrode any arrow-key navigation. Retries now bail the moment the user moves on.
- **Fix: a fresh agent no longer inherits an old chat's title/TL;DR/progress.** `nextAgentId` reuses the lowest free id slot, and the per-agent state file at `state/<id>.json` could outlive the agent that wrote it (orphaned by an earlier kill path). The next agent landing on that id would pick up its predecessor's markers. New agents now wipe the slot before constructing.
- **New: panel scrolls to bring the new card into view.** Spawning a card in a long list used to drop it off-screen.
- **New: arrow navigation keeps the active card in view.** Up/Down now scrolls the list when the focused card crosses the viewport edge.
- **Polish: default card title is `Glance` instead of `glance-XX`.** VS Code disambiguates the terminal tab labels automatically.
- **Polish: skill pill renders on its own row beneath the progress bar** instead of fighting the TL;DR row for width.
- **Polish: `update_state` reminder.** The UserPromptSubmit hook now injects a short nudge into the model's silent context so the per-turn card update is harder to forget. Schema already requires all six fields; this just makes the call itself harder to skip.

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
