# Welcome Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native VS Code walkthrough that opens once on first install and teaches new users where Glance lives in the activity bar plus the five core shortcuts (`⌘⇧G`, `g`, `Enter`, `↑/↓`, `⌘⌫`).

**Architecture:** Pure manifest contribution (`contributes.walkthroughs`) + a tiny activation-time check in `src/extension.ts` that runs `workbench.action.openWalkthrough` once per user (gated on `context.globalState`). No new runtime dependencies, no changes to the marker pipeline or webview, no automated tests (manual verification only — matches the spec).

**Tech Stack:** VS Code Walkthrough API · `contributes.walkthroughs` · `vscode.commands.executeCommand('workbench.action.openWalkthrough', …)` · `globalState` · `@resvg/resvg-js` for rasterizing the two new SVG assets (already a devDep, used by `scripts/render-readme-pngs.mjs`).

**Spec reference:** `docs/superpowers/specs/2026-05-12-welcome-walkthrough-design.md`

---

## File Map

**Create:**
- `media/walkthrough/find.svg` — source for step 1 image (Glance icon highlighted on activity bar with a pointer)
- `media/walkthrough/find.png` — rasterized output, shipped in `.vsix`
- `media/walkthrough/spawn.svg` — source for step 3 image (agent list with a `g` keycap overlay)
- `media/walkthrough/spawn.png` — rasterized output
- `media/walkthrough/focus.md` — inline markdown rendered as step 2's media (a big ⌘⇧G keycap)
- `scripts/render-walkthrough-pngs.mjs` — rasterizer for `media/walkthrough/*.svg` (modeled on `scripts/render-readme-pngs.mjs`)

**Modify:**
- `package.json` — `activationEvents`, `contributes.commands`, `contributes.walkthroughs`
- `src/extension.ts` — one-time auto-open block + `glancer.showWalkthrough` command
- `.vscodeignore` — exclude `docs/**` and `media/walkthrough/*.svg` from the published `.vsix`
- `CLAUDE.md` — one paragraph noting the SEEN flag and `onStartupFinished` activation

**Reuse (no changes):**
- `resources/readme/card-anatomy.png` — step 4 image
- `resources/readme/notification.png` — step 5 image

---

## Task 1: Tighten `.vscodeignore` for new paths

**Files:**
- Modify: `.vscodeignore`

- [ ] **Step 1: Inspect current `.vscodeignore`**

Run: `cat .vscodeignore`
Expected output: shows the existing 21-line file ending at the `scripts/render-readme-pngs.mjs` line, with no entry for `docs/` or `media/walkthrough/`.

- [ ] **Step 2: Append two new exclusion rules**

Append to `.vscodeignore` (after the existing `scripts/render-readme-pngs.mjs` line, before the trailing blank line):

```
docs/**
media/walkthrough/*.svg
scripts/render-walkthrough-pngs.mjs
```

Rationale:
- `docs/**` — keeps spec/plan markdown out of the `.vsix` (matches the existing `CLAUDE.md` exclusion philosophy).
- `media/walkthrough/*.svg` — only the rasterized PNGs ship; SVG sources stay in-repo for editing (parity with `resources/readme/*.svg`).
- `scripts/render-walkthrough-pngs.mjs` — build-time tool, never executed inside the running extension (parity with the existing `scripts/render-readme-pngs.mjs` exclusion).

- [ ] **Step 3: Verify**

Run: `tail -5 .vscodeignore`
Expected output (the last lines):
```
scripts/render-readme-pngs.mjs

docs/**
media/walkthrough/*.svg
scripts/render-walkthrough-pngs.mjs
```

- [ ] **Step 4: Commit**

```bash
git add .vscodeignore
git commit -m "chore: exclude docs/ and walkthrough sources from .vsix"
```

---

## Task 2: Author SVG sources for step 1 and step 3 images

**Files:**
- Create: `media/walkthrough/find.svg`
- Create: `media/walkthrough/spawn.svg`

- [ ] **Step 1: Create the `media/walkthrough/` directory**

Run: `mkdir -p media/walkthrough`
Expected: no output.

- [ ] **Step 2: Write `media/walkthrough/find.svg`**

Create `media/walkthrough/find.svg` with exactly this content:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1158 600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
  <rect width="1158" height="600" fill="#07090c"/>

  <!-- VS Code activity bar slice (left edge) -->
  <g transform="translate(60, 60)">
    <rect width="68" height="480" rx="6" fill="#181818"/>

    <!-- Active stripe on the Glance slot -->
    <rect x="0" y="120" width="3" height="64" fill="#ffffff"/>

    <!-- Glance icon (active) -->
    <g transform="translate(22, 132) scale(1.8)" stroke="#ffffff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="10.5" width="8" height="8" rx="2.8"/>
      <rect x="13.5" y="10.5" width="8" height="8" rx="2.8"/>
      <path d="M 10.5 13 Q 12 14.5 13.5 13"/>
      <path d="M 3 11.5 L 1.2 9.5"/>
      <path d="M 21 11.5 L 22.8 9.5"/>
    </g>

    <!-- Dimmed sibling activity-bar slots -->
    <g fill="none" stroke="#858585" stroke-width="1.8" opacity="0.45" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 20 36 L 28 30 L 48 30 L 48 50 L 20 50 Z"/>
      <circle cx="34" cy="220" r="14"/>
      <rect x="20" y="280" width="28" height="28" rx="3"/>
      <path d="M 22 360 L 46 360 M 22 372 L 46 372 M 22 384 L 38 384"/>
      <circle cx="34" cy="436" r="3"/>
      <circle cx="34" cy="444" r="3"/>
      <circle cx="34" cy="452" r="3"/>
    </g>
  </g>

  <!-- Pointer arrow from label to Glance icon -->
  <g stroke="#cca700" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 380 300 Q 250 280 165 178"/>
    <path d="M 175 168 L 162 174 L 168 187"/>
  </g>

  <!-- Caption -->
  <g fill="#e6e6e6">
    <text x="400" y="285" font-size="34" font-weight="700">Glance lives here</text>
    <text x="400" y="325" font-size="22" font-weight="400" fill="#a8a8a8">Click the icon — or press ⌘⇧G / Ctrl+Shift+G</text>
  </g>
</svg>
```

- [ ] **Step 3: Write `media/walkthrough/spawn.svg`**

Create `media/walkthrough/spawn.svg` with exactly this content:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1158 600" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="card-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2128"/>
      <stop offset="1" stop-color="#161a20"/>
    </linearGradient>
  </defs>

  <rect width="1158" height="600" fill="#07090c"/>

  <!-- Glance panel (left column) -->
  <g transform="translate(60, 60)">
    <rect width="420" height="480" rx="10" fill="#0d1117" stroke="#22272e" stroke-width="1"/>

    <!-- Panel header -->
    <text x="20" y="40" fill="#e6e6e6" font-size="18" font-weight="700">Agents</text>
    <g transform="translate(330, 22)">
      <rect width="70" height="28" rx="6" fill="#2a6cf0"/>
      <text x="35" y="19" fill="#ffffff" font-size="13" font-weight="600" text-anchor="middle">+ New</text>
    </g>

    <!-- Empty state placeholder card -->
    <g transform="translate(20, 80)">
      <rect width="380" height="92" rx="8" fill="url(#card-bg)" stroke="#22272e" stroke-width="1" stroke-dasharray="4 4"/>
      <text x="190" y="50" fill="#6b7280" font-size="14" text-anchor="middle">No agents yet —</text>
      <text x="190" y="72" fill="#6b7280" font-size="14" text-anchor="middle">press the key on the right to spawn one</text>
    </g>
  </g>

  <!-- Big 'g' keycap on the right -->
  <g transform="translate(680, 200)">
    <rect width="200" height="200" rx="24" fill="#1c2128" stroke="#3a4150" stroke-width="2"/>
    <rect x="0" y="0" width="200" height="190" rx="24" fill="#262c36" stroke="#3a4150" stroke-width="2"/>
    <text x="100" y="138" fill="#ffffff" font-size="140" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Mono', Menlo, monospace">g</text>
  </g>

  <!-- Caption under keycap -->
  <g fill="#e6e6e6">
    <text x="780" y="450" font-size="26" font-weight="700" text-anchor="middle">press g</text>
    <text x="780" y="482" font-size="18" font-weight="400" fill="#a8a8a8" text-anchor="middle">with the panel focused</text>
  </g>

  <!-- Arrow from keycap to panel -->
  <g stroke="#2a6cf0" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.7">
    <path d="M 660 300 Q 580 300 500 220"/>
    <path d="M 510 210 L 497 217 L 503 230"/>
  </g>
</svg>
```

- [ ] **Step 4: Commit**

```bash
git add media/walkthrough/find.svg media/walkthrough/spawn.svg
git commit -m "feat: add walkthrough SVG sources for find/spawn steps"
```

---

## Task 3: Add the rasterizer script and generate PNGs

**Files:**
- Create: `scripts/render-walkthrough-pngs.mjs`
- Create: `media/walkthrough/find.png` (generated)
- Create: `media/walkthrough/spawn.png` (generated)

- [ ] **Step 1: Write `scripts/render-walkthrough-pngs.mjs`**

Create `scripts/render-walkthrough-pngs.mjs` with exactly this content:

```js
#!/usr/bin/env node
// Rasterize media/walkthrough/*.svg to PNG. VS Code walkthroughs render
// PNG cleanly; SVG is supported but flickers on theme change in some
// builds — same reason resources/readme is rasterized for the README.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'media', 'walkthrough');

const SCALE = 2;

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.svg')) continue;
  const svg = readFileSync(join(dir, f), 'utf8');
  const resvg = new Resvg(svg, { fitTo: { mode: 'zoom', value: SCALE } });
  const png = resvg.render().asPng();
  const out = join(dir, basename(f, '.svg') + '.png');
  writeFileSync(out, png);
  console.log(`rendered ${f} -> ${basename(out)} (${png.length} bytes)`);
}
```

- [ ] **Step 2: Run the rasterizer**

Run: `node scripts/render-walkthrough-pngs.mjs`
Expected output (order may vary):
```
rendered find.svg -> find.png (NNNNN bytes)
rendered spawn.svg -> spawn.png (NNNNN bytes)
```

If `Resvg` is not found: run `pnpm install` first — `@resvg/resvg-js` is already in `devDependencies`.

- [ ] **Step 3: Sanity-check the PNGs exist and are non-trivial**

Run: `ls -la media/walkthrough/*.png`
Expected: two files, each > 5 KB.

- [ ] **Step 4: Commit**

```bash
git add scripts/render-walkthrough-pngs.mjs media/walkthrough/find.png media/walkthrough/spawn.png
git commit -m "feat: rasterize walkthrough SVGs to PNG"
```

---

## Task 4: Write the step-2 inline markdown media

**Files:**
- Create: `media/walkthrough/focus.md`

- [ ] **Step 1: Write `media/walkthrough/focus.md`**

Create `media/walkthrough/focus.md` with exactly this content:

```markdown
<div align="center">

# ⌘⇧G

#### `Ctrl+Shift+G` on Windows / Linux

</div>

From anywhere in VS Code, this shortcut focuses the Glance panel. If the panel is already focused, the same keystroke spawns a new agent (it's a two-tap combo).
```

VS Code's walkthrough renderer supports a subset of HTML inside markdown media; the `<div align="center">` block is the documented way to center content.

- [ ] **Step 2: Commit**

```bash
git add media/walkthrough/focus.md
git commit -m "feat: add walkthrough step-2 inline media (focus shortcut)"
```

---

## Task 5: Contribute the walkthrough manifest entry

**Files:**
- Modify: `package.json`

This is a pure manifest edit. No code yet — that's Task 6.

- [ ] **Step 1: Read the current `contributes` block to confirm line locations**

Run: `grep -n '"contributes"\|"activationEvents"\|"commands"\|"keybindings"' package.json`
Expected: shows the line numbers of `activationEvents`, `contributes`, `commands`, and `keybindings`. Use these to anchor the edits in step 2–4.

- [ ] **Step 2: Add `onStartupFinished` to `activationEvents`**

Replace this block in `package.json`:

```json
  "activationEvents": [
    "onView:glancer.agents"
  ],
```

with:

```json
  "activationEvents": [
    "onView:glancer.agents",
    "onStartupFinished"
  ],
```

Rationale: `onView:glancer.agents` only fires when the user opens the panel. The first-install walkthrough must auto-open before the user has done anything, so we need a startup activation. The check itself is a single `globalState.get` — negligible cost.

- [ ] **Step 3: Add the `glancer.showWalkthrough` command**

In the `contributes.commands` array, append a third entry. Replace this block:

```json
    "commands": [
      {
        "command": "glancer.focusPanel",
        "title": "Glance: Focus Agent Panel"
      },
      {
        "command": "glancer.newAgent",
        "title": "Glance: New Agent"
      },
      {
        "command": "glancer.killActive",
        "title": "Glance: Kill Active Agent"
      }
    ],
```

with:

```json
    "commands": [
      {
        "command": "glancer.focusPanel",
        "title": "Glance: Focus Agent Panel"
      },
      {
        "command": "glancer.newAgent",
        "title": "Glance: New Agent"
      },
      {
        "command": "glancer.killActive",
        "title": "Glance: Kill Active Agent"
      },
      {
        "command": "glancer.showWalkthrough",
        "title": "Glance: Show Welcome Tour"
      }
    ],
```

- [ ] **Step 4: Add the `contributes.walkthroughs` block**

The `contributes` object currently ends with `keybindings`. Add a new sibling key `walkthroughs` immediately after the `keybindings` array's closing `]`, before the closing `}` of `contributes`.

Replace the last lines of `contributes` (currently):

```json
    "keybindings": [
      {
        "command": "glancer.focusPanel",
        "key": "ctrl+shift+g",
        "mac": "cmd+shift+g"
      },
      {
        "command": "glancer.newAgent",
        "key": "ctrl+shift+g",
        "mac": "cmd+shift+g",
        "when": "focusedView == glancer.agents"
      },
      {
        "command": "glancer.newAgent",
        "key": "ctrl+alt+n",
        "mac": "cmd+alt+n"
      },
      {
        "command": "glancer.killActive",
        "key": "ctrl+backspace",
        "mac": "cmd+backspace",
        "when": "focusedView == glancer.agents"
      }
    ]
  },
```

with:

```json
    "keybindings": [
      {
        "command": "glancer.focusPanel",
        "key": "ctrl+shift+g",
        "mac": "cmd+shift+g"
      },
      {
        "command": "glancer.newAgent",
        "key": "ctrl+shift+g",
        "mac": "cmd+shift+g",
        "when": "focusedView == glancer.agents"
      },
      {
        "command": "glancer.newAgent",
        "key": "ctrl+alt+n",
        "mac": "cmd+alt+n"
      },
      {
        "command": "glancer.killActive",
        "key": "ctrl+backspace",
        "mac": "cmd+backspace",
        "when": "focusedView == glancer.agents"
      }
    ],
    "walkthroughs": [
      {
        "id": "glancer.welcome",
        "title": "Glance — Claude Code: Quick Tour",
        "description": "Run multiple Claude Code sessions side-by-side. Learn the shortcuts in 30 seconds.",
        "steps": [
          {
            "id": "find",
            "title": "Find Glance in the activity bar",
            "description": "Glance lives on the **left activity bar** — the same column where Explorer, Search, and Source Control live.\n\n[Open the panel](command:glancer.focusPanel)",
            "media": {
              "image": "media/walkthrough/find.png",
              "altText": "The Glance icon highlighted on the VS Code activity bar"
            },
            "completionEvents": ["onView:glancer.agents"]
          },
          {
            "id": "focus",
            "title": "Open the panel — ⌘⇧G / Ctrl+Shift+G",
            "description": "From anywhere in VS Code, press this shortcut to focus the panel. Press it again with the panel focused to spawn a new agent.\n\n[Try it](command:glancer.focusPanel)",
            "media": {
              "markdown": "media/walkthrough/focus.md"
            },
            "completionEvents": ["onCommand:glancer.focusPanel"]
          },
          {
            "id": "spawn",
            "title": "Spawn an agent — press g",
            "description": "With the panel focused, press the **g** key to spawn a new Claude Code session. From anywhere else, ⌘⌥N / Ctrl+Alt+N works too.\n\n[Spawn one now](command:glancer.newAgent)",
            "media": {
              "image": "media/walkthrough/spawn.png",
              "altText": "Agent list with a `g` keycap overlay"
            },
            "completionEvents": ["onCommand:glancer.newAgent"]
          },
          {
            "id": "enter",
            "title": "Jump into its terminal — Enter",
            "description": "With a card selected in the panel, press **Enter** to hand keyboard focus to that agent's terminal. Press **Esc** to come back to the panel.",
            "media": {
              "image": "resources/readme/card-anatomy.png",
              "altText": "Anatomy of an agent card: title, TL;DR, progress bar, status stripe, kill"
            },
            "completionEvents": ["onCommand:workbench.action.terminal.focus"]
          },
          {
            "id": "more",
            "title": "Cycle, rename, kill",
            "description": "- **↑ / ↓** — cycle agents (panel focused)\n- **Double-click** a card title — rename it (renames are sticky until `/clear`)\n- **⌘⌫ / Ctrl+Backspace** — kill the active agent\n\nThat's everything. Have fun.",
            "media": {
              "image": "resources/readme/notification.png",
              "altText": "VS Code toast firing when an agent finishes a turn in the background"
            }
          }
        ]
      }
    ]
  },
```

- [ ] **Step 5: Validate JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`
Expected: no output (parsed cleanly). If it errors, you have a syntax issue — fix it before continuing.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "feat: contribute welcome walkthrough manifest"
```

---

## Task 6: Wire auto-open + re-open command in `src/extension.ts`

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Read the current file**

Run: `cat src/extension.ts`
Expected: shows the 49-line file. Confirm the `activate(context)` function and the `context.subscriptions.push(...)` block are still as captured in the spec.

- [ ] **Step 2: Add two module-scope constants**

Below the existing `let manager: AgentManager | null = null;` line, insert two new constants:

```ts
const WALKTHROUGH_ID = 'hamzawaleed.glance-claude-code#glancer.welcome';
const WALKTHROUGH_SEEN_KEY = 'glancer.walkthrough.seen';
```

`WALKTHROUGH_ID` is `<publisher>.<name>#<walkthrough.id>` — the format VS Code's `openWalkthrough` command requires. `WALKTHROUGH_SEEN_KEY` is the `globalState` key — namespaced to avoid colliding with other state if we add more later.

- [ ] **Step 3: Add the auto-open block at the end of `activate()`**

Inside `activate()`, immediately after the `context.subscriptions.push(...)` block closes (i.e., after the line `);` on the line currently at `src/extension.ts:42`), insert:

```ts

  context.subscriptions.push(
    vscode.commands.registerCommand('glancer.showWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false),
    ),
  );

  if (!context.globalState.get<boolean>(WALKTHROUGH_SEEN_KEY)) {
    // Defer one tick so the activity bar paints before the walkthrough
    // opens. The third arg `toSide=false` opens it as a full editor tab.
    setTimeout(() => {
      void vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        WALKTHROUGH_ID,
        false,
      );
      void context.globalState.update(WALKTHROUGH_SEEN_KEY, true);
    }, 0);
  }
```

After edits, the bottom of `activate()` should read:

```ts
    { dispose: () => manager?.dispose() },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('glancer.showWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false),
    ),
  );

  if (!context.globalState.get<boolean>(WALKTHROUGH_SEEN_KEY)) {
    setTimeout(() => {
      void vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        WALKTHROUGH_ID,
        false,
      );
      void context.globalState.update(WALKTHROUGH_SEEN_KEY, true);
    }, 0);
  }
}
```

- [ ] **Step 4: Type-check + bundle the host**

Run: `pnpm run build`
Expected: completes without TypeScript errors; produces `out/extension.js`. If TS complains about `void` on `Thenable`, that's fine — the build runs esbuild, not `tsc`. If it does fail on type-check anyway, the most likely cause is a stray syntax issue from the insertion — re-read `src/extension.ts` and fix.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat: auto-open welcome walkthrough on first install"
```

---

## Task 7: Document the new flow in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the right anchor in `CLAUDE.md`**

Run: `grep -n "^### 1\. Extension host" CLAUDE.md`
Expected: one match — the section that describes what `AgentManager` and `Agent` do on activation. The new paragraph goes at the end of that section, right before `### 2. Marker / state pipeline`.

- [ ] **Step 2: Insert the paragraph**

Find this exact line in `CLAUDE.md` (it ends section 1):

```
- `glancer-instructions.txt` — the system prompt the MCP server returns in its `initialize` response's `instructions` field. **No `--append-system-prompt` is used** — that path was removed because shell echo leaked the prompt into the terminal.
```

Insert immediately AFTER that bullet (and AFTER any blank line separating section 1 from section 2 — keep the blank line where it is), so the new paragraph becomes the last paragraph of section 1:

```
On activation, `extension.ts` also checks `context.globalState.get('glancer.walkthrough.seen')` and, if unset, opens the `glancer.welcome` walkthrough exactly once via `workbench.action.openWalkthrough`. This is the only reason `activationEvents` includes `onStartupFinished` alongside `onView:glancer.agents` — without it the first-install user wouldn't trigger activation until they opened the panel manually. The same walkthrough can be re-opened any time via `Glance: Show Welcome Tour` in the Command Palette.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note welcome walkthrough activation in CLAUDE.md"
```

---

## Task 8: Manual verification

No automated tests — walkthroughs are pure manifest + state. Verify end-to-end against a clean VS Code profile.

- [ ] **Step 1: Build the extension**

Run: `pnpm run build`
Expected: completes without errors; `out/extension.js`, `out/webview/main.js`, `out/markers/hook.mjs`, `out/markers/mcp-server.mjs` all updated.

- [ ] **Step 2: Launch a clean Extension Development Host**

From inside VS Code with this project open, press **F5**. A new VS Code window opens with the extension loaded.

In that new window: open the Command Palette, run **Developer: Reload Window** once to ensure a clean activation.

Expected: the **Glance — Claude Code: Quick Tour** walkthrough opens automatically as an editor tab. The first step ("Find Glance in the activity bar") is highlighted, with the `find.png` image visible to the right.

- [ ] **Step 3: Tick the steps interactively**

In order, perform each step's action and confirm the checkmark auto-ticks:

1. **find:** click the Glance icon in the activity bar. Step 1 should tick.
2. **focus:** press `Cmd+Shift+G` (or `Ctrl+Shift+G`). Step 2 should tick.
3. **spawn:** with the panel focused, press `g`. Step 3 should tick; a new agent card appears.
4. **enter:** with the new card selected, press `Enter`. Step 4 should tick; keyboard focus moves into the terminal.
5. **more:** no auto-tick — this step is a reference list.

If any step fails to tick: the most likely cause is the `completionEvents` string. Confirm `onCommand:<id>` in the manifest matches an actual registered command.

- [ ] **Step 4: Verify "show again" command**

In the dev host window's Command Palette, run **Glance: Show Welcome Tour**.
Expected: the walkthrough re-opens (or refocuses if already open).

- [ ] **Step 5: Verify the SEEN flag persists**

Close the dev host window. Press F5 again to relaunch it.
Expected: the walkthrough does **NOT** auto-open. The `globalState` flag set on the first launch suppresses re-show.

To reset for repeat testing, launch a fresh extension host with a clean user-data dir:

```bash
code --extensionDevelopmentPath="$(pwd)" --user-data-dir=/tmp/glance-walkthrough-test
```

`globalState` is scoped per user-data-dir, so the walkthrough auto-opens again on each fresh invocation. (Delete `/tmp/glance-walkthrough-test` between runs to fully reset.)

- [ ] **Step 6: Verify `.vsix` packaging**

Run: `npx --yes @vscode/vsce package --no-dependencies`
Expected: produces `glance-claude-code-0.0.3.vsix`. The command prints the file list — confirm:
- ✅ `media/walkthrough/find.png` IS listed
- ✅ `media/walkthrough/spawn.png` IS listed
- ✅ `media/walkthrough/focus.md` IS listed
- ❌ `media/walkthrough/find.svg` is NOT listed (excluded by `.vscodeignore`)
- ❌ `media/walkthrough/spawn.svg` is NOT listed
- ❌ `docs/` is NOT listed
- ❌ `scripts/render-walkthrough-pngs.mjs` is NOT listed

If any of those fail: re-check `.vscodeignore` from Task 1.

- [ ] **Step 7: Final commit (if anything changed during verification)**

If verification revealed a manifest typo or missing file and you fixed it inline, commit:

```bash
git add -A
git commit -m "fix: address walkthrough verification feedback"
```

Otherwise, no commit needed.

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task(s) |
| --- | --- |
| Goal — teach 5 shortcuts | Task 5 (manifest with 5 steps) |
| `contributes.walkthroughs` manifest | Task 5 |
| `contributes.commands += showWalkthrough` | Task 5 |
| `activationEvents += onStartupFinished` | Task 5 |
| Auto-open logic in `extension.ts` | Task 6 |
| `glancer.showWalkthrough` command registration | Task 6 |
| `media/walkthrough/find.png` | Tasks 2 + 3 |
| `media/walkthrough/spawn.png` | Tasks 2 + 3 |
| `media/walkthrough/focus.md` | Task 4 |
| Reuse existing `resources/readme/*.png` | Task 5 (referenced in manifest, no separate task needed) |
| `.vscodeignore` adds `docs/**` | Task 1 |
| `CLAUDE.md` notes new flow | Task 7 |
| Manual verification | Task 8 |

All spec requirements have a task. No gaps.

**Placeholder scan:** None — every step has exact paths, exact code, exact commands. The one parenthetical "(NNNNN bytes)" in Task 3 Step 2 expected output is a placeholder for runtime output that varies by render, not a placeholder for the engineer to fill in.

**Type consistency:** `WALKTHROUGH_ID`, `WALKTHROUGH_SEEN_KEY`, and the command id `glancer.showWalkthrough` are used consistently between Tasks 5 and 6. The walkthrough id `glancer.welcome` matches between the manifest (Task 5) and the `WALKTHROUGH_ID` constant (Task 6). Media paths in the manifest (Task 5) match the file creations in Tasks 2, 3, 4.
