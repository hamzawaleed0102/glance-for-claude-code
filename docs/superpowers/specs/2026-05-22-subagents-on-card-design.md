# Subagent Rows on the Agent Card

**Status:** Approved design — ready for implementation planning
**Date:** 2026-05-22
**Project:** `glancer-vscode` ("Glance — Claude Code" VS Code extension)

---

## 1. Problem & goal

A Glance card shows a session's status — title, TL;DR, progress, working stripe —
but nothing about the **subagents** that session dispatches. When a session runs
subagents in the background, the card looks like a single working session; the
user can't see that three subagents are exploring, auditing, and testing in
parallel.

**Goal:** while a session has subagents running, its card shows a row per
subagent (a label + a running/done state) under the progress bar. Rows appear as
subagents start, flip to done as each finishes, and all clear when the parent
turn ends.

## 2. Goals & non-goals

**Goals**
- Show one row per subagent the session has dispatched this turn.
- Each row: a human-readable label + a running/done indicator.
- Rows are live: added on subagent start, marked done on subagent finish.
- Rows clear when the parent turn ends.
- Detection uses only **officially documented** Claude Code hook surfaces.

**Non-goals**
- Mid-subagent progress percentages (no hook exposes this).
- Subagent transcript drill-down / opening a subagent's output.
- Persisting subagent rows across an extension reload (they are turn-scoped).
- Any change to the MCP `update_state` path.

## 3. Background — current state (post in-process-HTTP-server migration)

- Claude Code hook events run `hook.mjs`, which POSTs the raw event payload to
  the extension's in-process `GlanceServer` (`POST /hook/<agentId>`).
- `GlanceServer` → `AgentManager.handleHookEvent(agentId, payload)` routes the
  event to the `Agent` by id.
- `hook-settings.json` (written once in the `AgentManager` constructor)
  currently registers `Stop`, `UserPromptSubmit`, `Notification`,
  `SessionStart`, each with an empty `matcher`.
- The card snapshot is `AgentSnapshot` (`src/shared/messages.ts`); patches flow
  to the React webview via the `agentUpdate` message.
- `AgentCard.tsx` renders reveal-animated sections (TL;DR, progress, skill pill)
  that grow/collapse via a `.reveal` grid-row transition.

## 4. Official mechanism (researched against the Claude Code docs)

- Subagents are dispatched via the **`Agent`** tool (`Task` is a deprecated
  alias). Hook matchers must target `"Agent"`.
- **`tool_use_id`** is a stable per-tool-call identifier, documented as
  consistent across `PreToolUse`, `PostToolUse`, and `SubagentStop` — the
  official correlation key.
- **`PreToolUse`** fires before a tool runs; with `matcher: "Agent"` it fires
  per subagent dispatch. Payload includes `hook_event_name`, `tool_name`,
  `tool_input`, `tool_use_id`, `session_id`, `cwd`.
- **`SubagentStop`** fires when a subagent finishes — **foreground or
  background**. Payload includes `hook_event_name`, `agent_id`, `agent_type`,
  `tool_use_id`.
- **Documented gap:** the exact `tool_input` schema of the `Agent` tool is not
  published. The label a row can show therefore needs confirming by a spike
  (see §12); `agent_type` is guaranteed, a richer description is not.

## 5. Detection design

- **Start signal:** `PreToolUse` with `matcher: "Agent"`. Gives `tool_use_id`
  and `tool_input` (label source).
- **Done signal:** `SubagentStop`. Gives the matching `tool_use_id` and
  `agent_type`. Chosen over `PostToolUse{Agent}` because `SubagentStop` fires
  for **background** subagents at their true completion, whereas `PostToolUse`
  fires when the `Agent` *tool call* returns — which can be early for a
  backgrounded subagent.
- **Correlation:** `tool_use_id` — the `PreToolUse` that started a subagent and
  the `SubagentStop` that ended it carry the same `tool_use_id`.
- `hook.mjs` needs **no change** — it already forwards any event payload
  verbatim.

## 6. Components

### `hook-settings.json` (`AgentManager` constructor)
Add two event registrations alongside the existing four:
- `PreToolUse` — a matcher group with `matcher: "Agent"` (scopes the hook to
  the `Agent` tool; without it the hook fires on every tool call).
- `SubagentStop` — the existing empty-`matcher` group shape.
Both invoke the same `hook.mjs`.

### `Agent` — turn-scoped subagent state
```ts
interface Subagent {
  id: string;     // the Agent call's tool_use_id
  label: string;  // from tool_input, or agent_type fallback
  done: boolean;
}
private _subagents: Subagent[] = [];
```
- `subagentStarted(id, label)` — append `{id, label, done: false}` if `id` is
  not already present; emit a `subagents` snapshot patch.
- `subagentFinished(id)` — mark the matching entry `done: true`; emit a patch.
  An unknown `id` is a no-op.
- The list is cleared (emptied + patch emitted) in `notifyTurnComplete()` (Stop
  hook), `clearTransient()` (UserPromptSubmit), and `resetCardState()`
  (`/clear`).
- `_subagents` is **transient** — hook-driven and turn-scoped, like
  `_streaming`. It is **not** written to `state/<id>.json` and not restored on
  reload.

### `subagentLabel(toolInput)` — pure helper
A `vscode`-free function deriving a row label from the `Agent` tool's
`tool_input`. Precedence: a description-like field → a `subagent_type` field →
`'subagent'`. Lives in `src/agents/subagentLabel.ts` — a `vscode`-free module
alongside the existing tested helpers (`ids.ts`, `pinSort.ts`, …) so it can be
unit-tested under `node --test`. The exact `tool_input` field names are
confirmed by the §12 spike.

### `handleHookEvent` (`AgentManager`)
Two new branches:
- `PreToolUse` — if `tool_name === 'Agent'`, read `tool_use_id` and
  `subagentLabel(tool_input)`, call `agent.subagentStarted(id, label)`.
- `SubagentStop` — read `tool_use_id`, call `agent.subagentFinished(id)`.

### `AgentSnapshot` (`src/shared/messages.ts`)
Add `subagents: { id: string; label: string; done: boolean }[]`. It travels in
the existing `agentUpdate` patch — no new message type.

### `AgentCard.tsx` + `styles.css`
A new `.reveal` section below the progress row, `data-open` when
`subagents.length > 0`. One row per subagent: an `↳`-prefixed label plus a
status glyph — running shows an accent dot, done shows a green `✓`. At most 5
rows render; a 6th `+N more` row covers any overflow.

## 7. Lifecycle & behavior

```
PreToolUse{Agent}   → row added, running
SubagentStop        → that row flips to done (✓)
Stop (parent turn)  → entire subagent list cleared, section collapses
UserPromptSubmit    → list cleared (defensive — a new turn starts fresh)
SessionStart/clear  → list cleared
```

Rows are a live, while-working detail. After the turn ends the card returns to
its normal done state with no subagent rows (per the approved "clear on turn
end" behavior).

## 8. Data flow

```
Claude calls the Agent tool
  → PreToolUse{Agent} hook → hook.mjs → POST /hook/<id> → GlanceServer
    → AgentManager.handleHookEvent → Agent.subagentStarted(tool_use_id, label)
    → snapshot patch → webview → AgentCard renders a running row

subagent finishes
  → SubagentStop hook → … → Agent.subagentFinished(tool_use_id)
    → row flips to done

parent turn ends
  → Stop hook → notifyTurnComplete → Agent clears _subagents → rows collapse
```

## 9. Edge cases & error handling

| Case | Behaviour |
|---|---|
| `PreToolUse` lost | That subagent gets no row; a later `SubagentStop` for its id is a no-op. |
| `SubagentStop` lost | Row stays "running" — but the turn-end `Stop` clears the whole list. Self-correcting. |
| Nested subagents (a subagent dispatches one) | Its `PreToolUse{Agent}` routes to the same card; shown flattened in the one list. Acceptable. |
| Many subagents | Cap at 5 rendered rows + a `+N more` row. |
| Duplicate `PreToolUse` for one id | `subagentStarted` dedupes on `id`. |
| MCP `update_state` | Untouched — `subagents` is a separate, hook-driven snapshot field. |

## 10. Files added / changed

**Changed**
- `src/agents/AgentManager.ts` — `hook-settings.json` gains `PreToolUse` +
  `SubagentStop`; `handleHookEvent` gains two branches.
- `src/agents/Agent.ts` — `_subagents` state, `subagentStarted` /
  `subagentFinished`, clearing in the three turn-boundary methods.
- `src/shared/messages.ts` — `subagents` field on `AgentSnapshot`.
- `src/view/webview/AgentCard.tsx` — subagent rows section.
- `src/view/webview/styles.css` — subagent row styling.
- `esbuild.config.mjs`, `package.json` — register the new helper test.

**Added**
- `src/agents/subagentLabel.ts` — the pure label helper.
- `src/agents/subagentLabel.test.ts` — its unit tests.

## 11. Testing

- **Unit-tested:** `subagentLabel(toolInput)` — label-precedence and fallback
  cases, registered in `esbuild.config.mjs::testEntries` and the `package.json`
  `test` script.
- **Not unit-testable:** the `Agent` / `AgentManager` wiring imports `vscode`
  and cannot run under `node --test` — the codebase's documented constraint.
  Verified by the §12 spike and a manual F5 run (dispatch parallel subagents,
  watch rows appear, flip to done, and clear at turn end).

## 12. Risks & the verification spike

The `Agent` tool's `tool_input` schema is not officially documented.
**Implementation step 1 is a verification spike:** in a real session, dispatch
two or three parallel subagents and capture the actual `PreToolUse{Agent}` and
`SubagentStop` hook payloads. Confirm:
1. `tool_use_id` is present in both and matches across the pair.
2. What field(s) `tool_input` exposes for a row label.

If `tool_input` carries no usable description, `subagentLabel` falls back to
`agent_type` (`"Explore"`, `"general-purpose"`, or a custom agent name) — still
a meaningful row label. The feature is viable either way; the spike only
determines label richness.

## 13. Out of scope

Mid-subagent progress, subagent transcript drill-down, persisting rows across
reload, and any change to the MCP `update_state` pipeline.
