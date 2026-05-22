# Subagent Rows on the Agent Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a row per subagent on a Glance card while the session has subagents running — label + running/done — cleared when the parent turn ends.

**Architecture:** Two new Claude Code hooks (`PreToolUse` scoped to the `Agent` tool, and `SubagentStop`) POST into the existing in-process HTTP server. `AgentManager.handleHookEvent` routes them to the `Agent`, which keeps a turn-scoped `_subagents` list exposed on the snapshot and rendered by `AgentCard`. Correlation is by the documented `tool_use_id`.

**Tech Stack:** TypeScript, esbuild, `node:test`, VS Code extension API, React webview.

**Spec:** `docs/superpowers/specs/2026-05-22-subagents-on-card-design.md`

**Hard constraints:**
- pnpm only. Build: `pnpm run build`. Test: `pnpm run test`.
- `src/agents/subagentLabel.ts` must NOT import `vscode` — it is unit-tested under `node --test`.
- You are on branch `subagents-on-card`. Commit there. Do not switch branches.
- The working tree has pre-existing unrelated user changes (`.vscodeignore`, `CLAUDE.md`, `src/view/AgentPanelProvider.ts`, `src/view/webview/index.html`, `src/view/webview/main.tsx`, untracked `yarn.lock` / `media/*.wav`). Never stage, commit, or modify those. Stage only the files each task's commit step names.
- Test files must be registered in BOTH `esbuild.config.mjs::testEntries` and the `package.json` `test` script — no glob.

---

## Task 1: Verification spike — capture the real `Agent` hook payloads

Manual gate. The `Agent` tool's `tool_input` schema is undocumented; confirm the hook payloads before building. Do not start Task 2 until this passes.

**Files:** throwaway under `/tmp/glance-subagent-spike/`, deleted at the end.

- [ ] **Step 1: Write a logging hook script**

Create `/tmp/glance-subagent-spike/loghook.mjs`:

```js
import { appendFileSync } from 'node:fs';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    appendFileSync('/tmp/glance-subagent-spike/events.log', raw + '\n');
  } catch {}
  process.exit(0);
});
```

- [ ] **Step 2: Write a settings file registering the two hooks**

Create `/tmp/glance-subagent-spike/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent", "hooks": [{ "type": "command", "command": "node /tmp/glance-subagent-spike/loghook.mjs" }] }
    ],
    "SubagentStop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /tmp/glance-subagent-spike/loghook.mjs" }] }
    ]
  }
}
```

- [ ] **Step 3: Run a session that dispatches parallel subagents**

Run:
```
cd /tmp/glance-subagent-spike && rm -f events.log && claude --dangerously-skip-permissions --settings /tmp/glance-subagent-spike/settings.json -p "Use the Agent tool to launch 2 subagents in parallel: one that runs 'echo one' and one that runs 'echo two'. Wait for both, then stop."
```

- [ ] **Step 4: Inspect the captured events**

Run: `cat /tmp/glance-subagent-spike/events.log`

Confirm and record:
1. `PreToolUse` events with `"hook_event_name":"PreToolUse"`, `"tool_name":"Agent"`, a `tool_use_id`, and a `tool_input` object.
2. `SubagentStop` events with `"hook_event_name":"SubagentStop"` and a `tool_use_id` that matches a `PreToolUse` one.
3. **The field names inside `tool_input`** — note whether there is a `description`, a `subagent_type`, a `prompt`, etc. This determines Task 2's label fields.

- [ ] **Step 5: Verdict**

- If `PreToolUse{Agent}` and `SubagentStop` both carry a correlatable `tool_use_id` → **PASS**, proceed to Task 2. If `tool_input` field names differ from `description` / `subagent_type`, note them — Task 2 Step 4 must use the real field names.
- If `SubagentStop` carries no usable `tool_use_id`, or `PreToolUse` does not fire for the `Agent` tool → **STOP**, report; the spec's detection design needs revision.

- [ ] **Step 6: Clean up**

Run: `rm -rf /tmp/glance-subagent-spike`. No commit.

---

## Task 2: `subagentLabel` — pure label helper

**Files:**
- Create: `src/agents/subagentLabel.ts`
- Test: `src/agents/subagentLabel.test.ts`
- Modify: `esbuild.config.mjs`, `package.json`

- [ ] **Step 1: Write the failing test**

Create `src/agents/subagentLabel.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentLabel } from './subagentLabel';

test('uses the description field when present', () => {
  assert.equal(subagentLabel({ description: 'explore api routes' }), 'explore api routes');
});

test('falls back to subagent_type when there is no description', () => {
  assert.equal(subagentLabel({ subagent_type: 'Explore' }), 'Explore');
});

test('falls back to "subagent" when neither field is present', () => {
  assert.equal(subagentLabel({ prompt: 'do a thing' }), 'subagent');
});

test('returns "subagent" for a non-object input', () => {
  assert.equal(subagentLabel(null), 'subagent');
  assert.equal(subagentLabel('nope'), 'subagent');
});

test('truncates an over-long description', () => {
  const long = 'a'.repeat(80);
  const out = subagentLabel({ description: long });
  assert.equal(out.length, 60);
  assert.ok(out.endsWith('…'));
});
```

- [ ] **Step 2: Register the test in the build**

In `esbuild.config.mjs`, add to the `testEntries` array (after the `renameSync` entries):

```js
  'src/agents/subagentLabel.ts',
  'src/agents/subagentLabel.test.ts',
```

In `package.json`, append to the `test` script command (before the closing `"`): ` out/agents/subagentLabel.test.js`

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm run build && pnpm run test`
Expected: FAIL — `Cannot find module './subagentLabel'`.

- [ ] **Step 4: Write `src/agents/subagentLabel.ts`**

```ts
// Derives a one-line card label for a subagent from the `Agent` tool's
// `tool_input`. The exact `tool_input` schema is not documented by Claude
// Code; this checks the plausible fields in priority order and always
// returns a non-empty string. MUST NOT import `vscode` — unit-tested under
// `node --test`.

/** Longest label rendered on a row before truncation (incl. the ellipsis). */
const MAX = 60;

export function subagentLabel(toolInput: unknown): string {
  if (typeof toolInput !== 'object' || toolInput === null) return 'subagent';
  const t = toolInput as Record<string, unknown>;
  const desc = typeof t.description === 'string' ? t.description.trim() : '';
  if (desc) return desc.length > MAX ? desc.slice(0, MAX - 1) + '…' : desc;
  const type = typeof t.subagent_type === 'string' ? t.subagent_type.trim() : '';
  if (type) return type;
  return 'subagent';
}
```

> If Task 1's spike showed `tool_input` uses different field names, replace `description` / `subagent_type` above with the real ones and update the test inputs to match.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm run build && pnpm run test`
Expected: PASS — all 5 `subagentLabel` tests green, plus the pre-existing suite.

- [ ] **Step 6: Commit**

```bash
git add src/agents/subagentLabel.ts src/agents/subagentLabel.test.ts esbuild.config.mjs package.json
git commit -m "feat: add subagentLabel helper for subagent row labels"
```

---

## Task 3: `Subagent` type + `AgentSnapshot.subagents` field

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add the `Subagent` interface and snapshot field**

In `src/shared/messages.ts`, immediately before `export interface AgentSnapshot {`, add:

```ts
/**
 * One subagent the session has dispatched this turn. `id` is the `Agent`
 * tool call's `tool_use_id` (correlation key + React row key).
 */
export interface Subagent {
  id: string;
  label: string;
  done: boolean;
}

```

Then, inside `AgentSnapshot`, immediately after the `streaming: boolean;` line, add:

```ts
  /**
   * Subagents the session has running this turn — one row per entry on the
   * card. Hook-driven and turn-scoped (cleared when the parent turn ends);
   * not persisted to `state/<id>.json`. Optional — shell-terminal cards
   * never have subagents and omit it.
   */
  subagents?: Subagent[];
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `pnpm run build`
Expected: BUILD OK. (`subagents` is optional, so no existing `snapshot()` needs to change yet — `Agent.snapshot()` gains it in Task 4; `ShellAgent.snapshot()` correctly omits it.)

- [ ] **Step 3: Commit**

```bash
git add src/shared/messages.ts
git commit -m "feat: add Subagent type and subagents field to AgentSnapshot"
```

---

## Task 4: `Agent` subagent state

**Files:**
- Modify: `src/agents/Agent.ts`

- [ ] **Step 1: Import the `Subagent` type**

In `src/agents/Agent.ts`, find the existing import of snapshot types from `../shared/messages` and add `Subagent` to it. The import currently brings in `AgentSnapshot` (and possibly others) — add `Subagent` to that same `import type { … } from '../shared/messages';` list.

- [ ] **Step 2: Add the `_subagents` field**

In `src/agents/Agent.ts`, immediately after the line `private _streaming = false;`, add:

```ts
  /** Subagents dispatched this turn. Turn-scoped; cleared at turn boundaries. */
  private _subagents: Subagent[] = [];
```

- [ ] **Step 3: Add the subagent methods**

In `src/agents/Agent.ts`, immediately after the `notifyInterrupted()` method's closing brace, add:

```ts
  /** A subagent (Agent tool call) started — add a running row. */
  subagentStarted(id: string, label: string): void {
    if (this._subagents.some((s) => s.id === id)) return;
    this._subagents.push({ id, label, done: false });
    this.changeEmitter.fire({ subagents: [...this._subagents] });
  }

  /** A subagent finished — flip its row to done. Unknown id is a no-op. */
  subagentFinished(id: string): void {
    const sub = this._subagents.find((s) => s.id === id);
    if (!sub || sub.done) return;
    sub.done = true;
    this.changeEmitter.fire({ subagents: [...this._subagents] });
  }

  /**
   * Empty the subagent list if non-empty, recording the change in `patch`.
   * Called from the turn-boundary methods so the rows clear with the rest
   * of the per-turn card state in a single emit.
   */
  private clearSubagents(patch: Partial<AgentSnapshot>): void {
    if (this._subagents.length > 0) {
      this._subagents = [];
      patch.subagents = [];
    }
  }
```

- [ ] **Step 4: Clear subagents in `notifyTurnComplete`**

In `notifyTurnComplete()`, immediately before the line `if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);`, add:

```ts
    this.clearSubagents(patch);
```

- [ ] **Step 5: Clear subagents in `clearTransient`**

In `clearTransient()`, find where `_skill` is cleared:

```ts
    if (this._skill !== null) {
      this._skill = null;
      patch.skill = null;
    }
```

Immediately after that block, add:

```ts
    this.clearSubagents(patch);
```

- [ ] **Step 6: Clear subagents in `resetCardState`**

In `resetCardState()`, find the line that clears streaming — `if (this._streaming) { this._streaming = false; patch.streaming = false; }`. Immediately after it, add:

```ts
    this.clearSubagents(patch);
```

- [ ] **Step 7: Add `subagents` to `snapshot()`**

In the `snapshot()` method's returned object, immediately after the `streaming: this._streaming,` line, add:

```ts
      subagents: [...this._subagents],
```

- [ ] **Step 8: Build**

Run: `pnpm run build && pnpm run test`
Expected: BUILD OK; all existing tests still pass (this task adds no tests — `Agent` imports `vscode` and is not unit-testable; verified by Task 7).

- [ ] **Step 9: Commit**

```bash
git add src/agents/Agent.ts
git commit -m "feat: track per-turn subagents on the Agent"
```

---

## Task 5: Hook registration + `handleHookEvent` routing

**Files:**
- Modify: `src/agents/AgentManager.ts`

- [ ] **Step 1: Import `subagentLabel`**

In `src/agents/AgentManager.ts`, add near the other `../agents` / local imports:

```ts
import { subagentLabel } from './subagentLabel';
```

- [ ] **Step 2: Register the two new hooks**

In the `AgentManager` constructor, replace the hook-settings block. The current code is:

```ts
    const matcherGroup = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: shellQuoted }],
      },
    ];
    fs.writeFileSync(
      this.hookSettingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: matcherGroup,
            UserPromptSubmit: matcherGroup,
            Notification: matcherGroup,
            SessionStart: matcherGroup,
          },
        },
        null,
        2,
      ),
    );
```

Replace it with:

```ts
    const matcherGroup = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: shellQuoted }],
      },
    ];
    // PreToolUse fires before every tool call; scope it to the `Agent` tool
    // (subagent dispatch) so the hook does not run on every Read/Edit/Bash.
    const agentMatcherGroup = [
      {
        matcher: 'Agent',
        hooks: [{ type: 'command', command: shellQuoted }],
      },
    ];
    fs.writeFileSync(
      this.hookSettingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: matcherGroup,
            UserPromptSubmit: matcherGroup,
            Notification: matcherGroup,
            SessionStart: matcherGroup,
            PreToolUse: agentMatcherGroup,
            SubagentStop: matcherGroup,
          },
        },
        null,
        2,
      ),
    );
```

- [ ] **Step 3: Extend the `evt` payload type in `handleHookEvent`**

In `handleHookEvent`, the `evt` cast currently is:

```ts
    const evt = payload as {
      hook_event_name?: string;
      session_id?: string;
      prompt?: string;
      message?: string;
      // SessionStart hook reports how the session began. Values per
      // Claude Code: 'startup' (fresh), 'resume' (--resume <id>),
      // 'clear' (/clear), 'compact' (/compact).
      source?: 'startup' | 'resume' | 'clear' | 'compact';
    };
```

Replace it with:

```ts
    const evt = payload as {
      hook_event_name?: string;
      session_id?: string;
      prompt?: string;
      message?: string;
      // SessionStart hook reports how the session began. Values per
      // Claude Code: 'startup' (fresh), 'resume' (--resume <id>),
      // 'clear' (/clear), 'compact' (/compact).
      source?: 'startup' | 'resume' | 'clear' | 'compact';
      // PreToolUse / SubagentStop fields for subagent tracking.
      tool_name?: string;
      tool_input?: unknown;
      tool_use_id?: string;
    };
```

- [ ] **Step 4: Add the `PreToolUse` and `SubagentStop` branches**

In `handleHookEvent`, the hook-event `if`/`else if` chain ends with the `Notification` branch:

```ts
    } else if (hookEvent === 'Notification') {
      // … existing Notification body …
      agent.setNeedsAttention(message);
    }
  }
```

Insert two `else if` branches between the end of the `Notification` branch body and its closing `}` — i.e. change the tail to:

```ts
    } else if (hookEvent === 'Notification') {
      // … existing Notification body, UNCHANGED …
      agent.setNeedsAttention(message);
    } else if (hookEvent === 'PreToolUse') {
      // Scoped to the `Agent` tool by the hook matcher; re-check tool_name
      // defensively. PreToolUse{Agent} = a subagent was dispatched.
      if (evt.tool_name === 'Agent' && typeof evt.tool_use_id === 'string') {
        agent.subagentStarted(evt.tool_use_id, subagentLabel(evt.tool_input));
      }
    } else if (hookEvent === 'SubagentStop') {
      // A subagent finished — the tool_use_id matches its dispatching
      // PreToolUse{Agent} event.
      if (typeof evt.tool_use_id === 'string') {
        agent.subagentFinished(evt.tool_use_id);
      }
    }
  }
```

(Do not change the `Notification` branch body — only append the two new `else if` branches after it.)

- [ ] **Step 5: Build and test**

Run: `pnpm run build && pnpm run test`
Expected: BUILD OK; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/AgentManager.ts
git commit -m "feat: route PreToolUse{Agent} and SubagentStop to subagent tracking"
```

---

## Task 6: Render subagent rows on the card

**Files:**
- Modify: `src/view/webview/AgentCard.tsx`, `src/view/webview/styles.css`

- [ ] **Step 1: Add the subagent rows section to `AgentCard.tsx`**

In `src/view/webview/AgentCard.tsx`, find the progress `.reveal` block — the `<div className="reveal" …>` whose body renders `agent.progress` and the `agent-progress-row`. Immediately AFTER that progress `.reveal` block's closing `</div>` (the outer `reveal` div) and BEFORE the skill-pill `.reveal` block, insert:

```tsx
      {/* Subagent rows — one per Agent-tool subagent running this turn.
       *  Turn-scoped; the list clears when the parent turn ends. Capped at
       *  5 visible rows with a "+N more" overflow line. */}
      <div
        className="reveal"
        data-open={agent.subagents && agent.subagents.length > 0 ? 'true' : 'false'}
      >
        <div className="reveal-inner">
          {agent.subagents && agent.subagents.length > 0 && (
            <div className="agent-subagents">
              {agent.subagents.slice(0, 5).map((s) => (
                <div key={s.id} className="agent-subagent-row">
                  <span className="agent-subagent-label" title={s.label}>
                    {`↳ ${s.label}`}
                  </span>
                  <span
                    className={`agent-subagent-glyph ${s.done ? 'done' : 'running'}`}
                    aria-label={s.done ? 'done' : 'running'}
                  >
                    {s.done ? '✓' : '●'}
                  </span>
                </div>
              ))}
              {agent.subagents.length > 5 && (
                <div className="agent-subagent-row agent-subagent-more">
                  {`+${agent.subagents.length - 5} more`}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
```

- [ ] **Step 2: Add the subagent row styles to `styles.css`**

In `src/view/webview/styles.css`, append at the end of the file:

```css
/* Subagent rows — shown under the progress bar while the session has
 * Agent-tool subagents running this turn. */
.agent-subagents {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 4px;
}
.agent-subagent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}
.agent-subagent-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-subagent-glyph {
  flex-shrink: 0;
  font-size: 9px;
}
.agent-subagent-glyph.running {
  color: var(--accent);
  animation: stripe-pulse 1.5s ease-in-out infinite;
}
.agent-subagent-glyph.done {
  color: var(--done);
}
.agent-subagent-more {
  color: var(--muted);
  opacity: 0.7;
  font-style: italic;
}
```

- [ ] **Step 3: Build and typecheck the webview**

Run: `pnpm run build && pnpm exec tsc -p tsconfig.webview.json --noEmit`
Expected: BUILD OK; no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/view/webview/AgentCard.tsx src/view/webview/styles.css
git commit -m "feat: render subagent rows on the agent card"
```

---

## Task 7: Manual end-to-end verification

**Files:** none.

- [ ] **Step 1: Build and launch the Extension Development Host**

Run `pnpm run build`, then launch the dev host on a real workspace folder:
`env -u ELECTRON_RUN_AS_NODE "/Applications/Visual Studio Code.app/Contents/MacOS/Code" --extensionDevelopmentPath="$(pwd)" "$(pwd)"`

- [ ] **Step 2: Dispatch subagents from a Glance agent**

Spawn an agent (`g`) and paste into its terminal:
```
Use the Agent tool to launch 3 subagents in parallel — one to count the .ts files under src/, one to list the package.json scripts, one to summarize esbuild.config.mjs. Run them in the background, then report all three results.
```

Expected on the card, while the turn runs:
- A row appears per subagent under the progress bar, each with `↳ <label>` and a pulsing `●`.
- Each row's `●` flips to a green `✓` as that subagent finishes.

- [ ] **Step 3: Verify rows clear at turn end**

When the parent turn finishes, confirm all subagent rows disappear and the card returns to its normal done state.

- [ ] **Step 4: Bump the version and changelog**

In `package.json`, increment `version`. Add a `CHANGELOG.md` entry describing the subagent rows feature.

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version for subagent card rows"
```

---

## Done

Cards now show live per-subagent rows whenever a session dispatches `Agent`-tool subagents, cleared when the parent turn ends.
