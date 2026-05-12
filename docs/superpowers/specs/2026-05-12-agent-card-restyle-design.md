# Agent card restyle + variable height — design

**Date:** 2026-05-12
**Status:** Approved (pending spec review)
**Versioning:** Bundled into the next release commit after implementation lands; the in-flight 0.0.6 icon-round commit will be amended or merged into the same release.

## Goal

Polish the agent card visuals to match a modern app-card aesthetic (subtle rounded border, generous padding, consistent rhythm) and replace the current fixed-height layout with a content-driven height that animates smoothly when content appears or disappears.

Two specific user complaints this fixes:
1. Cards look more "VS Code list row" than "app card."
2. When new content slots in (TL;DR after the first turn, progress bar mid-stream, error replacing TL;DR), the card jumps to a new height abruptly.

## Non-goals

- No collapse/expand chevron — cards always show everything they have.
- No new action chips — keep the existing kill button. (Future iteration may revisit.)
- No animation on list reordering during drag-drop — current snap behavior stays.
- No new dependencies.
- No changes to `Agent.ts`, the marker pipeline, or any webview messaging.

## Mechanism

CSS-only, using the `display: grid; grid-template-rows: 0fr → 1fr` reveal trick. Each conditionally-rendered content block gets wrapped in a `.reveal` element that transitions its row track between collapsed and expanded. The card itself drops its fixed `height: 86px` and lets natural flow + the reveals drive its overall height.

This approach was chosen over (a) JS `ResizeObserver` measurement and (b) adding `framer-motion`. The grid trick is pure CSS, no new dependencies, and works correctly inside the VS Code webview's CSP-restricted environment.

## What changes

### `src/view/webview/AgentCard.tsx`

JSX changes — wrap the conditional `description` block and the conditional `progress` block in `.reveal` containers. Each reveal has a `data-open` attribute that flips based on whether its content is present.

Before:

```tsx
{description && (
  <div className={`agent-card-sub agent-tldr ${descriptionTone}`} title={description}>
    {description}
  </div>
)}
{agent.progress && status === 'streaming' && (
  <div className="agent-progress-row">…</div>
)}
```

After:

```tsx
<div className="reveal" data-open={description ? 'true' : 'false'}>
  <div className="reveal-inner">
    {description && (
      <div className={`agent-card-sub agent-tldr ${descriptionTone}`} title={description}>
        {description}
      </div>
    )}
  </div>
</div>

<div
  className="reveal"
  data-open={agent.progress && status === 'streaming' ? 'true' : 'false'}
>
  <div className="reveal-inner">
    {agent.progress && status === 'streaming' && (
      <div className="agent-progress-row">…</div>
    )}
  </div>
</div>
```

Note: the inner conditional render stays — the reveal collapses the row track when `data-open="false"`, and the content is hidden by `overflow: hidden` on `.reveal-inner`. When `data-open` flips back to `"true"`, the React tree re-mounts the child and the grid expands to its natural size in one transition. (Keeping the conditional inside means React doesn't render a phantom empty inner div when no content exists — keeps the DOM lean.)

The `starting` row (`agent-starting-row` with the three pulsing dots) is left as a direct child of the card, NOT wrapped. The transition from "starting" to "streaming/done" is a hard swap — wrapping it in a reveal would compete with the card's `opacity: 0.85` starting state and feel less crisp.

### `src/view/webview/styles.css`

**Remove from `.agent-card`:**
- `height: 86px;` (the comment above it explaining why fixed height is also removed)
- `overflow: hidden;` — only the reveal-inner needs to clip; the card itself shouldn't (this was previously a safety net for runaway content, but with reveals controlling overflow it's redundant and would hide things like the kill button's focus ring).

**Adjust `.agent-card`:**
- `padding: 11px 30px 11px 18px` → `padding: 12px 30px 14px 20px`
- `border-radius: 8px` → `border-radius: 12px`
- Add `display: flex; flex-direction: column; gap: 6px;` so the title row, reveals, and (future) extra rows space consistently.

**Add `.reveal` rules:**

```css
.reveal {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms ease;
}
.reveal[data-open="true"] {
  grid-template-rows: 1fr;
}
.reveal-inner {
  overflow: hidden;
  min-height: 0; /* Required for grid track collapse to work in Chromium. */
}
```

**Update `.agent-card-sub` / `.agent-tldr`:**
- Remove `margin-top: 5px;` from `.agent-card-sub`. Confirmed against `styles.css:257` — this margin-top would stack with the new `gap: 6px` on the card and double-space the description row. The reveal-inner now handles top-spacing implicitly via the card's gap.

**Update `.agent-progress-row`:**
- Remove `margin-top: 8px;` from `.agent-progress-row` (`styles.css:270`) — same reasoning. The card's `gap: 6px` is the single source of inter-row spacing.

### Hover and active states

- `.agent-card:hover` — keep the existing `translateY(-1px)` lift and gradient brighten. With variable height, the lift continues to work because `transform` is decoupled from layout.
- `.agent-card.active` — keep the layered ring + halo glow. The 4px outer halo (`box-shadow: 0 0 0 4px rgba(...)`) won't be clipped because `.agent-card` no longer has `overflow: hidden`.

### Status stripe

Stays as-is. The `::before` left-rail stripe uses `top: 0; bottom: 0` so it tracks the card's full height regardless of content. No changes needed.

### Drag-and-drop

Drag visuals use `opacity` and `transform`, both of which work fine with variable-height cards. The drop-target hint (`.agent-card.drag-over`) uses border-color + box-shadow, also fine. No changes needed.

## Animation timing

- Reveal expand/collapse: `220ms ease` — same family as the existing `transition: transform 140ms ease, background 140ms ease, ...` on `.agent-card`, slightly longer because height changes are more noticeable than color/transform.
- The text content within the reveal does NOT cross-fade — it appears/disappears in lockstep with its container expanding. This is intentional: an empty reveal-inner reads as "nothing here" rather than "loading."

## Edge cases

| Case | Behavior |
| --- | --- |
| Fresh card, no turn yet | Both reveals are closed; card height is just `title row + padding`. |
| TL;DR arrives | Description reveal opens, card grows ~22px over 220ms. |
| Tone change (tldr → attention) | Reveal stays open; the inner row's color transitions via existing `.agent-tldr.warn` etc. rules. No height change. |
| Streaming starts | Progress reveal opens (if `agent.progress` exists). Description reveal stays open. |
| Turn ends | Progress reveal closes; description reveal stays. Card shrinks back by progress row height. |
| `/clear` resets state | Both reveals close; card shrinks to title row. |
| Long TL;DR text | Wraps to two lines naturally; reveal animates to the actual measured height. No `max-height` cap. |
| Title rename mid-stream | Input field replaces span; height of title row is the same, no reveal triggers. |
| Drag-drop reorder | Drag uses transform/opacity; height doesn't enter into the visual. |
| Card has no `progress` ever (most turns) | Progress reveal stays closed permanently — costs one extra DOM node per card (negligible). |

## Browser compatibility

The `grid-template-rows: 0fr → 1fr` transition pattern is supported in Chromium 117+ (released August 2023). VS Code uses Electron, which bundles a recent Chromium — confirm against `engines.vscode` in `package.json` (`^1.90.0` = Electron 28+ = Chromium 120+). Safe.

If a user is on an older VS Code build that predates Chromium 117, the transition won't run — the layout still works, height just snaps. Acceptable graceful degradation.

## Testing

No automated tests for visual changes. Manual verification:

1. Spawn a fresh agent → card shows only the title row.
2. Send a prompt → during streaming, progress row animates in (if Claude reports progress); card grows smoothly.
3. Turn completes → progress row animates out; TL;DR row animates in (or updates). Card height changes are visible but not jarring.
4. Force an error (e.g., `claude` not on PATH) → status flips to error; description tone transitions to `danger`; no height jump.
5. Multiple cards → reordering by drag-drop still snaps positions; cards lift on hover; active card has visible ring.
6. Long TL;DR — confirm text wraps cleanly and the reveal animates to the wrapped height, not a clipped fixed height.

## Risks

| Risk | Mitigation |
| --- | --- |
| Grid `0fr → 1fr` transition flickers on first paint in some Chromium builds | If observed, swap to a `max-height: 200px` ceiling with the same transition. Loses precision but is robust. Defer until observed. |
| Existing `margin-top` on `.agent-card-sub` or `.agent-progress-row` doubles with the new `gap: 6px` on `.agent-card` | Resolved in the CSS-changes section above — both margins are dropped. |
| Removing `overflow: hidden` from `.agent-card` exposes content outside the rounded corners (e.g., kill button focus ring) | The kill button is absolutely positioned inside the card and well within the rounded boundary; nothing else extends past the border. If it becomes an issue, restore `overflow: hidden` and accept that some focus-ring polish is clipped. |
| Active-card halo (`box-shadow: 0 0 0 4px ...`) overlaps the next card visually | The halo is 4px out from the border. Cards have `margin-bottom: 8px` already, so there's headroom. Confirm during manual verification. |

## Files touched

- `src/view/webview/AgentCard.tsx` — wrap two conditional blocks in `.reveal` containers (~6 added lines).
- `src/view/webview/styles.css` — remove fixed height, adjust radius/padding/gap, add `.reveal` ruleset, audit row margins (~15 net added lines).

## Out of scope (revisit later)

- Collapse/expand chevron.
- Action chips replacing the kill button (Rename / Clear / Close on hover).
- Card reorder animation during drag-drop.
- Theming tokens for the new border radius / gap (current setup uses hardcoded values to match existing style — fine for one card).
