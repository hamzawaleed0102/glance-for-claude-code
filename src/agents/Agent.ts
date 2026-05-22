import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { createClaudePty, type ClaudePty } from './pseudoterminal';
import type { AgentState } from '../server/mcpHandler';
import type { AgentSnapshot, AgentKind, ClaudeModel, Subagent, TitleSource } from '../shared/messages';
import type { ManagedAgent } from './ManagedAgent';
import { decideRename, decideFlush } from './renameSync';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/zsh';
}

/**
 * Strings the model emits when it confuses our string-typed marker
 * fields (tldr / title / needsInput / error / progress.label) with
 * booleans or "do I have a value" sentinels. None of these are
 * meaningful card content — they always come from a schema
 * misinterpretation. Compared case-insensitively after trim.
 */
const MARKER_STRING_BAD_VALUES: ReadonlySet<string> = new Set([
  'null',
  'undefined',
  'none',
  'true',
  'false',
  'n/a',
  'na',
]);

/**
 * Normalize a model-supplied string marker. Returns `null` for any
 * value that isn't a usable sentence/clause:
 *   - non-strings (booleans, numbers, objects)
 *   - empty / whitespace-only strings
 *   - schema-confusion literals like "null", "true", "n/a"
 * Trims surrounding whitespace on accepted values.
 *
 * Centralized here (not inlined per-call site) so every place that
 * consumes a model-written marker — applyState, setNeedsAttention,
 * progress.label, future fields — runs through the same gate. Adding
 * a new bad value to the blocklist propagates automatically.
 */
function sanitizeMarkerString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (MARKER_STRING_BAD_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function capitalizeFirstLetter(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface AgentInit {
  id: string;
  cwd: string;
  model: ClaudeModel;
  hookSettingsPath: string;
  /** Per-agent JSON file registering the Glance MCP server (http transport). */
  mcpConfigPath: string;
  /** The live in-process MCP/hook server — read at spawn time for port + token. */
  server: { readonly port: number; readonly token: string };
  /** Directory hook.mjs writes its debug log into. */
  logDir: string;
  /**
   * Absolute path of the per-agent JSON status file. The extension writes a
   * merged snapshot here on every `update_state` call (see
   * `AgentManager.applyAgentState`); a dormant agent re-seeds its card from
   * it once, in the Agent constructor.
   */
  stateFilePath: string;
  /**
   * When true, the Agent is restored from disk but no PTY is spawned. The
   * card shows last-known state; the first `reveal()` / `select` revives the
   * Agent and starts Claude with `--resume sessionId`. Used by the
   * AgentManager on extension reload so we don't spin up every Claude
   * session immediately.
   */
  dormant?: boolean;
  /** Existing Claude session id to resume (passed via `claude --resume`). */
  sessionId?: string | null;
  /** Snapshot fields to seed the dormant Agent with — usually the persisted name/titleSource. */
  initialSnapshot?: {
    name?: string;
    titleSource?: TitleSource;
  };
  /**
   * Whether the user has already chatted in this session. If true, the
   * Agent skips waiting for the next UserPromptSubmit before becoming
   * eligible for persistence. Set from sessions.json on restore.
   */
  hasUserPrompt?: boolean;
  /**
   * Whether this agent should restore in the pinned state. Read from
   * sessions.json. Defaults to false on fresh spawns.
   */
  pinned?: boolean;
}

export class Agent implements vscode.Disposable, ManagedAgent {
  readonly id: string;
  readonly kind: AgentKind = 'claude';
  private _name: string;
  private _titleSource: TitleSource = 'default';
  private _model: ClaudeModel;
  private _tldr: string | null = null;
  private _attentionReason: string | null = null;
  /**
   * Where the current `_attentionReason` came from:
   *  - 'mcp'  → Claude's `update_state` call (i.e. Claude explicitly
   *             said "I need input"). Stop must NOT clear this — the
   *             ball is in the user's court until they reply.
   *  - 'hook' → Claude Code's `Notification` hook (tool-permission
   *             prompt, slash-command picker). The user resolves these
   *             in VS Code's own UI and no follow-up hook fires, so
   *             Stop clears this on the user's behalf or the yellow
   *             gets stuck.
   *  - null   → no attention reason active.
   */
  private _attentionSource: 'mcp' | 'hook' | null = null;
  private _errorReason: string | null = null;
  private _progress: { value: number; label: string } | null = null;
  private _skill: string | null = null;
  private _streaming = false;
  /** Subagents dispatched this turn. Turn-scoped; cleared at turn boundaries. */
  private _subagents: Subagent[] = [];
  private _starting = true;
  /**
   * Best-effort "the user has typed into the terminal input box" flag. Set
   * true on any keystroke via the PTY's `onUserInput`; set false on
   * UserPromptSubmit and /clear (both empty the box). Gates the `/rename`
   * terminal echo so Glance never concatenates onto half-typed text.
   */
  private _inputDirty = false;
  /** Latest AI title waiting to be echoed as `/rename` once it is safe. */
  private _pendingRename: string | null = null;
  /**
   * Title of the `/rename` echo Glance has sent this conversation, or null if
   * none yet. Non-null means the session was already renamed — the once-per-
   * conversation guard. Reset to null by `resetCardState` on `/clear`.
   */
  private _lastSentRename: string | null = null;

  private claude: ClaudePty | null = null;
  private terminal: vscode.Terminal | null = null;
  private readonly stateFilePath: string;
  private readonly init: AgentInit;
  private _sessionId: string | null = null;
  private _dormant: boolean;
  /**
   * True once the user has submitted at least one prompt. Until this flips,
   * Claude hasn't written the session JSONL on disk and `--resume <id>`
   * would fail with "No conversation found". The manager uses this flag to
   * decide whether to persist the agent across launches.
   */
  private _hasUserPrompt: boolean;
  private _pinned: boolean;

  private readonly changeEmitter = new vscode.EventEmitter<Partial<AgentSnapshot>>();
  readonly onChange = this.changeEmitter.event;

  /** Fires when persistable metadata changes (sessionId, name, titleSource). */
  private readonly metaChangeEmitter = new vscode.EventEmitter<void>();
  readonly onMetaChange = this.metaChangeEmitter.event;

  private readonly exitEmitter = new vscode.EventEmitter<void>();
  readonly onExit = this.exitEmitter.event;

  /**
   * Fires when VS Code disposes the agent's terminal from the outside (user
   * clicked trash/X on the panel) — distinct from a PTY-driven exit or our
   * own `terminal.dispose()`. The manager translates this into `kill(id)`.
   * Suppressed during reload/quit via `AgentManager.shuttingDown`.
   */
  private readonly userCloseEmitter = new vscode.EventEmitter<void>();
  readonly onUserClose = this.userCloseEmitter.event;

  /**
   * Set true immediately before we invoke `this.terminal?.dispose()` from
   * within the Agent itself (becomeDormant, dispose). VS Code calls our
   * Pseudoterminal's `close()` as part of that disposal, which fires
   * `onCloseRequested` — we use this flag to skip the user-close path in
   * that case so internal disposal doesn't loop back as a kill.
   */
  private _selfDisposing = false;

  /**
   * Fires when Claude's Stop hook reports the end of a response. The Stop
   * hook is the cleanest "turn complete, ball is in user's court" signal —
   * far more reliable than guessing from PTY idle timers, which fire on
   * mid-turn pauses (slow tool calls, etc).
   */
  private readonly turnCompleteEmitter = new vscode.EventEmitter<void>();
  readonly onTurnComplete = this.turnCompleteEmitter.event;

  /**
   * True when the card is currently showing an "attention" signal that
   * warrants user action: an interactive prompt waiting on them, or a
   * hard error blocking progress. The manager sums these across all
   * agents into the activity-bar badge count. Computed from state, not
   * tracked separately — clearTransient (UserPromptSubmit) wipes both,
   * which naturally drops this back to false.
   */
  get needsAttention(): boolean {
    // Dormant agents (terminal closed — no live PTY, can't accept
    // input until the user revives them) shouldn't bump the badge.
    // The card still renders yellow via the snapshot's
    // `attentionReason` if that's how the prior turn ended, so the
    // visual signal is preserved; the activity-bar badge just stops
    // nagging for a session the user can't respond to right now.
    if (this._dormant) return false;
    return this._attentionReason !== null;
  }

  /**
   * True between UserPromptSubmit and Stop. Used by AgentManager to gate
   * the Notification hook: if the turn already ended (streaming=false),
   * any incoming "needs input" notification is Claude Code's 60s idle
   * ping rather than a real attention request, and should be ignored.
   */
  get streaming(): boolean {
    return this._streaming;
  }

  /**
   * True when the user has pinned this card. Pinned cards stay at the
   * top of the list (FIFO) and are protected from kill. Toggled via
   * the `p` key or the pin button on the card.
   */
  get pinned(): boolean {
    return this._pinned;
  }

  constructor(init: AgentInit) {
    this.init = init;
    this.id = init.id;
    this._name = init.initialSnapshot?.name ?? 'Glance';
    this._titleSource = init.initialSnapshot?.titleSource ?? 'default';
    this._model = init.model;
    this.stateFilePath = init.stateFilePath;
    this._sessionId = init.sessionId ?? null;
    this._dormant = init.dormant === true;
    this._hasUserPrompt = init.hasUserPrompt === true;
    this._pinned = init.pinned === true;

    // Dormant agents aren't "starting" — they're showing their last-known
    // state. The starting placeholder is for live launches only.
    if (this._dormant) this._starting = false;

    if (!this._dormant) this.spawn();

    // Seed the card from the persisted state file once. Dormant agents
    // restore their last-known markers this way; live agents thereafter
    // receive updates directly via applyState() from the HTTP server.
    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8').trim();
      if (raw.length > 0) this.applyState(JSON.parse(raw) as AgentState);
    } catch {
      // No prior state file — fresh agent. Expected.
    }
  }

  /**
   * Build the launch command and spawn the Claude PTY. Called once at
   * construction for live agents and on `revive()` for dormant ones.
   */
  private spawn(): void {
    // Reset the guard flag from any prior becomeDormant — the new terminal
    // we're about to create is a fresh subject for user-close detection.
    this._selfDisposing = false;
    const init = this.init;

    // Write this agent's MCP config: an http-transport server entry pointing
    // at the extension's in-process GlanceServer, scoped to this agent id.
    const mcpConfig = {
      mcpServers: {
        glancer: {
          type: 'http',
          url: `http://127.0.0.1:${init.server.port}/mcp/${init.id}`,
          headers: { Authorization: `Bearer ${init.server.token}` },
        },
      },
    };
    try {
      fs.writeFileSync(init.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    } catch (err) {
      console.warn('[glancer] failed to write mcp config', err);
    }

    const modelFlag = init.model === 'default' ? '' : ` --model ${init.model}`;
    // `--resume <id>` reconnects to the prior conversation. Only emitted
    // when we have a sessionId from a previous run; fresh agents start a
    // new Claude session and the SessionStart hook captures its id.
    const resumeFlag = this._sessionId
      ? ` --resume ${shellQuote(this._sessionId)}`
      : '';
    // No `--append-system-prompt` — the Glancer MCP server returns the
    // system instructions through its `initialize` response's
    // `instructions` field, the official MCP mechanism for it.
    const initialCommand =
      `clear && claude --dangerously-skip-permissions${modelFlag}` +
      ` --settings ${shellQuote(init.hookSettingsPath)}` +
      ` --mcp-config ${shellQuote(init.mcpConfigPath)}` +
      resumeFlag;

    this.claude = createClaudePty({
      cwd: init.cwd,
      shell: defaultShell(),
      env: {
        ...process.env,
        GLANCER_HOOK_URL: `http://127.0.0.1:${init.server.port}/hook/${init.id}`,
        GLANCER_TOKEN: init.server.token,
        GLANCER_LOG_DIR: init.logDir,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      initialCommand,
    });

    // Seed the terminal tab title with the current agent name so a restored
    // session with an AI/manual title shows that title in the VS Code
    // terminal panel from the moment it spawns — not just the default
    // `glance-XX`. Subsequent renames are pushed via `claude.setName`.
    //
    // Green tint on the tab indicator + eye icon visually distinguishes
    // Glancer-owned terminals from regular user shells in the same panel,
    // so it's obvious which sessions are managed by our extension.
    this.terminal = vscode.window.createTerminal({
      name: this._name,
      pty: this.claude.pty,
      color: new vscode.ThemeColor('terminal.ansiGreen'),
      iconPath: new vscode.ThemeIcon('eye'),
    });

    // NOTE: deliberately no `onData → markStreaming` wiring. Terminal echoes
    // (e.g. characters typed into Claude's input box) also flow through
    // onData, so a PTY-driven `streaming` flag spuriously turns the bubble
    // on while the user is just typing. The canonical signals come from
    // Claude's hooks: UserPromptSubmit flips streaming on (in
    // clearTransient), Stop flips it off (in notifyTurnComplete).
    this.claude.onExit(() => {
      this.exitEmitter.fire();
      // PTY exit is NOT the same as "user wants this agent deleted". It
      // happens on every Cmd+R reload (VS Code tears down terminals before
      // the extension can react) and on any accidental terminal close. We
      // transition to dormant so the card stays in sessions.json — the
      // user can revive it by clicking, or delete it deliberately via the
      // Glancer kill button. The user-trash-on-terminal case is upgraded
      // to a hard kill separately via `onCloseRequested` below.
      this.becomeDormant();
    });
    this.claude.onCloseRequested(() => {
      // VS Code is disposing the terminal externally. Three sources:
      //   - User clicked trash/X in the panel → fire userCloseEmitter so the
      //     manager can kill the agent (matches the Glance trash button).
      //   - Our own becomeDormant/dispose calling terminal.dispose() →
      //     `_selfDisposing` is set, so skip.
      //   - Extension host shutting down (reload/quit) → manager filters
      //     via its own `shuttingDown` flag.
      if (this._selfDisposing) return;
      if (this._dormant) return;
      this.userCloseEmitter.fire();
    });
    this.claude.onStartupComplete(() => {
      if (!this._starting) return;
      this._starting = false;
      this.changeEmitter.fire({ starting: false });
    });
    // Any real keystroke into the terminal marks the input box "dirty" so
    // the /rename echo waits rather than clobbering half-typed text.
    this.claude.onUserInput(() => {
      this._inputDirty = true;
    });
    // ESC during a streaming turn is Claude Code's interrupt gesture. No
    // Stop hook fires for an interrupt, so clear the working indicator here.
    this.claude.onInterruptKey(() => this.notifyInterrupted());
  }

  /**
   * Drop the live PTY/terminal references and mark the Agent dormant.
   * Triggered when the underlying Claude process exits for any reason
   * (terminal closed, VS Code reload, claude binary crash). The card stays
   * visible with last-known markers; reveal()/revive() can later spawn a
   * fresh PTY with `--resume <sessionId>`.
   */
  private becomeDormant(): void {
    if (this._dormant) return;
    this._dormant = true;
    this.claude = null;
    this._selfDisposing = true;
    try {
      this.terminal?.dispose();
    } catch {
      // already disposed by VS Code on shutdown
    }
    this.terminal = null;
    // The rename-echo fields (_pendingRename, _lastSentRename, _inputDirty)
    // intentionally survive dormancy — the conversation is unchanged, so a
    // revive()'d agent keeps its loop guard. They reset only on /clear via
    // resetCardState.
    if (this._streaming) {
      this._streaming = false;
      this.changeEmitter.fire({ streaming: false });
    }
  }

  /**
   * Revive a dormant agent — spawn the Claude PTY (with --resume if we have
   * a sessionId from the previous run). Subsequent reveals just show the
   * existing terminal.
   */
  revive(): void {
    if (!this._dormant) return;
    this._dormant = false;
    this._starting = true;
    this.changeEmitter.fire({ starting: true });
    this.spawn();
  }

  /**
   * Cwd / model / sessionId getters for the manager when persisting.
   * They're plain reads, not part of the snapshot diff machinery.
   */
  get cwd(): string { return this.init.cwd; }
  get model(): ClaudeModel { return this._model; }
  get sessionId(): string | null { return this._sessionId; }
  get titleSource(): TitleSource { return this._titleSource; }
  get name(): string { return this._name; }
  get hasUserPrompt(): boolean { return this._hasUserPrompt; }

  /**
   * Called when SessionStart hook fires with a new session id. Triggers
   * onMetaChange so the manager re-persists sessions.json.
   */
  setSessionId(id: string): void {
    if (this._sessionId === id) return;
    this._sessionId = id;
    this.metaChangeEmitter.fire();
  }

  /**
   * Called when UserPromptSubmit fires. Until this flips, Claude has not
   * written a session JSONL — `--resume` on a session with no user message
   * fails with "No conversation found". The manager filters un-prompted
   * agents out of sessions.json so they don't get restored on next launch.
   */
  markUserPrompted(): void {
    if (this._hasUserPrompt) return;
    this._hasUserPrompt = true;
    this.metaChangeEmitter.fire();
  }

  /**
   * Wipe every per-turn card marker AND the title back to default.
   * Used when Claude runs /clear (SessionStart with source='clear') —
   * the conversation just got reset, so any "needs input" / error /
   * tldr / progress / AI-assigned title carried over from the prior
   * conversation is stale. The title reverts to `glance-XX` so the
   * next turn's update_state can claim a fresh title.
   *
   * Also persists by writing nulls into the state file so the on-disk
   * snapshot used to seed dormant restores doesn't bring the stale
   * markers back on the next reload. Re-fires metaChange so sessions.json
   * picks up the title reset.
   */
  resetCardState(): void {
    const patch: Partial<AgentSnapshot> = {};
    // The /rename echo state is per-conversation — /clear starts a new one.
    this._pendingRename = null;
    this._lastSentRename = null;
    this._inputDirty = false;
    const defaultName = 'Glance';
    if (this._name !== defaultName || this._titleSource !== 'default') {
      this._name = defaultName;
      this._titleSource = 'default';
      patch.name = defaultName;
      patch.titleSource = 'default';
      this.claude?.setName(defaultName);
    }
    if (this._tldr !== null) { this._tldr = null; patch.tldr = null; }
    if (this._attentionReason !== null) {
      this._attentionReason = null;
      this._attentionSource = null;
      patch.attentionReason = null;
    }
    if (this._errorReason !== null) { this._errorReason = null; patch.errorReason = null; }
    if (this._progress !== null) { this._progress = null; patch.progress = null; }
    if (this._skill !== null) { this._skill = null; patch.skill = null; }
    if (this._streaming) { this._streaming = false; patch.streaming = false; }
    this.clearSubagents(patch);
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    if (patch.name !== undefined) this.metaChangeEmitter.fire();
    // Overwrite the persisted state file so a dormant restore re-seeds
    // from a clean slate (including the reset title).
    try {
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(
          { title: this._name, tldr: null, progress: null, needsInput: null, error: null, skill: null },
          null,
          2,
        ),
      );
    } catch {
      // Non-fatal — the next MCP update_state call will overwrite anyway.
    }
  }

  /** Called by AgentManager when Claude's Stop hook fires for this agent. */
  notifyTurnComplete(): void {
    // Explicit "turn ended" — flip streaming off so the bubble goes away
    // and the green ✓ takes over (based on tldr/progress). Without this,
    // streaming would stay true forever, since no PTY-data heuristic
    // resets it now.
    const patch: Partial<AgentSnapshot> = {};
    if (this._streaming) {
      this._streaming = false;
      patch.streaming = false;
    }
    // Clear attention markers set by the Notification hook (tool-permission
    // prompts / slash-command pickers). Those resolve in VS Code's own UI
    // without firing a follow-up hook, so without this clear the yellow
    // would persist past the answer. MCP-sourced attention (Claude
    // explicitly said "needsInput: ..." via update_state) is preserved —
    // the ball is in the user's court until they reply or Claude clears
    // it on the next turn. See _attentionSource doc.
    if (this._attentionReason !== null && this._attentionSource === 'hook') {
      this._attentionReason = null;
      this._attentionSource = null;
      patch.attentionReason = null;
    }
    this.clearSubagents(patch);
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
  }

  /**
   * The user pressed ESC to interrupt the turn. Claude Code fires no Stop
   * hook on an interrupt, so without this the card would stay stuck on the
   * working indicator. Flip streaming off — no toast/tone, since an
   * interrupt is not a clean finish.
   */
  notifyInterrupted(): void {
    if (!this._streaming) return;
    // An Esc interrupt terminates the turn and every subagent it dispatched —
    // they stop with it — so clear the subagent rows along with `streaming`.
    this._streaming = false;
    const patch: Partial<AgentSnapshot> = { streaming: false };
    this.clearSubagents(patch);
    this.changeEmitter.fire(patch);
  }

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
   * Empty the subagent list if non-empty, recording the change in `patch`
   * so it clears with the rest of the per-turn card state in one emit.
   */
  private clearSubagents(patch: Partial<AgentSnapshot>): void {
    if (this._subagents.length > 0) {
      this._subagents = [];
      patch.subagents = [];
    }
  }

  /**
   * Set the attention marker directly. Used by AgentManager when the
   * `Notification` hook fires — that hook represents "Claude (or one of
   * its slash commands) needs the user's input", which won't always flow
   * through the MCP update_state path (e.g. interactive pickers in slash
   * commands like /feedback never call MCP). Also flips streaming off and
   * re-uses the turnComplete event so the toast logic stays in one place.
   */
  setNeedsAttention(reason: string): void {
    // Sanitize through the same gate as model-supplied markers so a
    // junk Notification payload (literal "true", "null", etc.) can't
    // surface as attention text. Fall back to a generic label if the
    // payload was unusable.
    const next = sanitizeMarkerString(reason) ?? 'Waiting for input';
    let changed = false;
    const patch: Partial<AgentSnapshot> = {};
    if (this._attentionReason !== next) {
      this._attentionReason = next;
      // Hook-sourced — VS Code's permission prompt / picker resolution
      // doesn't emit a follow-up hook, so Stop is responsible for
      // clearing this. See _attentionSource doc and notifyTurnComplete.
      this._attentionSource = 'hook';
      patch.attentionReason = next;
      changed = true;
    }
    if (this._streaming) {
      this._streaming = false;
      patch.streaming = false;
      changed = true;
    }
    if (changed) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
  }

  /** True when this agent's terminal is the active VS Code terminal. */
  isTerminalActive(): boolean {
    return !!this.terminal && vscode.window.activeTerminal === this.terminal;
  }

  /** True when this agent owns the given VS Code terminal instance. */
  ownsTerminal(t: vscode.Terminal): boolean {
    return this.terminal === t;
  }

  clearTransient(): void {
    // Called on every UserPromptSubmit. Wipes every per-turn marker — TL;DR,
    // needs-input, error, progress — so the card resets to a clean state
    // while we wait for the next response. Title is intentionally preserved:
    // it's a session-level marker that Claude only emits on the first turn.
    //
    // Sets `streaming = true` to show the blinking bubble. The Stop hook
    // (via notifyTurnComplete) is responsible for flipping it back off —
    // there's no idle-timer fallback, so an agent that crashes mid-turn
    // would stay pulsing. That's an acceptable trade for not having the
    // bubble flicker every time the user types a character.
    //
    // A submitted prompt empties the input box — flush any /rename echo held
    // back while the user was mid-message. The dirty→clean transition here is
    // the watcher that releases a queued rename.
    this._inputDirty = false;
    this.flushPendingRename();
    const patch: Partial<AgentSnapshot> = {};
    if (this._tldr !== null) {
      this._tldr = null;
      patch.tldr = null;
    }
    if (this._attentionReason !== null) {
      this._attentionReason = null;
      this._attentionSource = null;
      patch.attentionReason = null;
    }
    if (this._errorReason !== null) {
      this._errorReason = null;
      patch.errorReason = null;
    }
    if (this._progress !== null) {
      this._progress = null;
      patch.progress = null;
    }
    if (this._skill !== null) {
      this._skill = null;
      patch.skill = null;
    }
    this.clearSubagents(patch);
    if (!this._streaming) {
      this._streaming = true;
      patch.streaming = true;
    }
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
  }

  setManualTitle(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // Empty input means "drop my override, go back to the auto-assigned
      // glance-id title". Flip titleSource to 'default' so the AI marker
      // can overwrite it from the next response.
      this._titleSource = 'default';
      this._name = 'Glance';
    } else {
      this._titleSource = 'manual';
      this._name = capitalizeFirstLetter(trimmed);
    }
    this.claude?.setName(this._name);
    this.changeEmitter.fire({ name: this._name, titleSource: this._titleSource });
    this.metaChangeEmitter.fire();
  }

  /**
   * Toggle the pinned flag. Fires changeEmitter so the webview snapshot
   * updates and metaChangeEmitter so AgentManager re-persists sessions.json.
   * Short-circuits if the flag is unchanged (avoids redundant writes and
   * an empty snapshot diff). Matches the dual-emitter pattern from
   * setManualTitle.
   */
  setPinned(pinned: boolean): void {
    if (this._pinned === pinned) return;
    this._pinned = pinned;
    this.changeEmitter.fire({ pinned: this._pinned });
    this.metaChangeEmitter.fire();
  }

  reveal(): void {
    // First reveal of a dormant agent revives it — spawns the Claude PTY
    // with `--resume <sessionId>` and shows the new terminal. Subsequent
    // reveals just bring the terminal to the foreground.
    if (this._dormant) this.revive();
    this.terminal?.show(true);
  }

  /**
   * Like reveal(), but pulls focus *into* the terminal. Used when the user
   * presses Enter on a focused card — reveal() alone keeps focus on the
   * Glancer panel (preserveFocus=true) so Up/Down navigation keeps working;
   * this variant deliberately steals focus.
   */
  focusTerminal(): void {
    if (this._dormant) this.revive();
    this.terminal?.show(false);
  }

  /**
   * Send Claude's `/clear` slash command into the terminal, then pull
   * keyboard focus into it so the user lands ready to type. Wired to
   * the `c c` chord on the focused agent panel.
   *
   * Uses `claude.sendInput` (a direct PTY write) rather than
   * `terminal.sendText` — `sendText` routes through `handleInput`, which
   * would falsely mark the input box dirty for the /rename echo. The PTY
   * still sees `/clear<Enter>` exactly as if the user typed it.
   *
   * We also call `resetCardState` directly here instead of waiting for
   * Claude's `SessionStart` hook to round-trip — we know /clear is
   * about to run because we're the ones sending it, so reset the card
   * synchronously. The hook-based reset still covers the case where
   * the user types /clear directly in the terminal (no chord); both
   * paths are idempotent because `resetCardState` only emits when
   * fields actually changed.
   */
  clearActive(): void {
    this.focusTerminal();
    this.claude?.sendInput('/clear\r');
    this.resetCardState();
  }

  /**
   * Echo `/rename <title>` into the terminal when Claude assigns a new card
   * title. Fires at most once per conversation — the first title sticks for
   * the rest of the session; later title changes never re-echo. Sent
   * immediately when the input box is clean — mid-turn or not. If the user
   * has typed into the box, the title is queued and `flushPendingRename`
   * sends it when the user next submits.
   * See docs/superpowers/specs/2026-05-21-instant-rename-echo-design.md.
   *
   * `/rename` renames the session in place — it does not start a new Claude
   * turn, so an instant mid-turn send cannot cascade.
   */
  private maybeSendRename(title: string): void {
    const decision = decideRename({
      inputDirty: this._inputDirty,
      lastSent: this._lastSentRename,
    });
    if (decision === 'send') {
      this.sendRename(title);
    } else if (decision === 'queue') {
      this._pendingRename = title;
    }
    // 'skip' — the session was already renamed once this conversation; do nothing.
  }

  /** Flush a queued `/rename` echo when the input box goes clean (on submit). */
  private flushPendingRename(): void {
    const pending = this._pendingRename;
    const decision = decideFlush({
      pending,
      inputDirty: this._inputDirty,
      lastSent: this._lastSentRename,
    });
    if (decision === 'send' && pending !== null) {
      this.sendRename(pending);
      this._pendingRename = null;
    } else if (decision === 'skip') {
      // Per decideFlush's caller contract: clear the queue even when
      // skipping, so an already-echoed title can't stay queued forever.
      this._pendingRename = null;
    }
    // 'queue' — unreachable here (clearTransient clears _inputDirty before
    // calling); the no-op branch keeps decideFlush's full contract handled.
  }

  /**
   * Write `/rename <title>` + Enter straight to the PTY via `sendInput`
   * (bypassing handleInput, so it is not counted as user typing). Strips any
   * CR/LF from the title so the line submits exactly once.
   */
  private sendRename(title: string): void {
    const clean = title.replace(/[\r\n]+/g, ' ').trim();
    if (clean.length === 0) return;
    this.claude?.sendInput(`/rename ${clean}\r`);
    // store the raw (pre-clean) title — decideRename/decideFlush compare
    // against this same raw value
    this._lastSentRename = title;
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      name: this._name,
      titleSource: this._titleSource,
      model: this._model,
      tldr: this._tldr,
      attentionReason: this._attentionReason,
      errorReason: this._errorReason,
      progress: this._progress,
      skill: this._skill,
      streaming: this._streaming,
      subagents: [...this._subagents],
      starting: this._starting,
      pinned: this._pinned,
    };
  }

  /**
   * Tear down runtime state (PTY, terminal, watchers, emitters) but LEAVE
   * the on-disk state file in place. Called on extension shutdown so the
   * next launch can restore the agent's last-known markers from the file.
   */
  dispose(): void {
    this.claude?.dispose();
    this._selfDisposing = true;
    this.terminal?.dispose();
    this.changeEmitter.dispose();
    this.exitEmitter.dispose();
    this.userCloseEmitter.dispose();
    this.metaChangeEmitter.dispose();
    this.turnCompleteEmitter.dispose();
  }

  /**
   * Delete the on-disk state file. Called by AgentManager only when the
   * user explicitly kills the agent (not on extension shutdown).
   */
  purgePersistentState(): void {
    try {
      fs.unlinkSync(this.stateFilePath);
    } catch {
      // file may not exist — Claude never wrote it
    }
  }

  /**
   * Applies a parsed state JSON from Claude's status file. Field semantics:
   *   - missing → leave current value alone
   *   - explicit null → clear
   *   - value → set
   */
  applyState(s: AgentState): void {
    const patch: Partial<AgentSnapshot> = {};

    if ('tldr' in s && s.tldr !== undefined) {
      const next = sanitizeMarkerString(s.tldr);
      if (next !== this._tldr) {
        this._tldr = next;
        patch.tldr = next;
      }
    }
    if (
      'title' in s &&
      this._titleSource !== 'manual' &&
      this._titleSource !== 'rename'
    ) {
      const sanitized = sanitizeMarkerString(s.title);
      const next = sanitized !== null ? capitalizeFirstLetter(sanitized) : null;
      if (next !== null && next !== this._name) {
        this._name = next;
        this._titleSource = 'ai';
        patch.name = next;
        patch.titleSource = 'ai';
        this.claude?.setName(next);
        this.maybeSendRename(next);
      }
    }
    if ('needsInput' in s && s.needsInput !== undefined) {
      const next = sanitizeMarkerString(s.needsInput);
      if (next !== this._attentionReason) {
        this._attentionReason = next;
        // MCP-sourced — Claude explicitly said "I need input" (or
        // explicitly null'd it). Stop must not wipe this; only Claude's
        // next update_state (or the next user prompt) can change it.
        this._attentionSource = next === null ? null : 'mcp';
        patch.attentionReason = next;
      }
    }
    if ('error' in s && s.error !== undefined) {
      const next = sanitizeMarkerString(s.error);
      if (next !== this._errorReason) {
        this._errorReason = next;
        patch.errorReason = next;
      }
    }
    if ('skill' in s && s.skill !== undefined) {
      // Strip any `superpowers:` (or other plugin) prefix so the pill stays
      // short — the user just wants to see "test-driven-development", not
      // "superpowers:test-driven-development".
      const sanitized = sanitizeMarkerString(s.skill);
      const next = sanitized !== null ? sanitized.replace(/^[\w-]+:/, '') : null;
      if (next !== this._skill) {
        this._skill = next;
        patch.skill = next;
      }
    }
    if ('progress' in s && s.progress !== undefined) {
      const p = s.progress;
      const cleanLabel =
        p && typeof p === 'object' ? sanitizeMarkerString(p.label) : null;
      const next =
        p &&
        typeof p === 'object' &&
        typeof p.value === 'number' &&
        Number.isFinite(p.value) &&
        cleanLabel !== null
          ? { value: Math.max(0, Math.min(1, p.value)), label: cleanLabel }
          : null;
      const same =
        (next === null && this._progress === null) ||
        (next !== null &&
          this._progress !== null &&
          next.value === this._progress.value &&
          next.label === this._progress.label);
      if (!same) {
        this._progress = next;
        patch.progress = next;
      }
    }

    if (Object.keys(patch).length > 0) {
      this.changeEmitter.fire(patch);
      // Name/titleSource end up in sessions.json — re-persist when either
      // moves so a restart picks up the AI-set title without losing the
      // user's manual override.
      if (patch.name !== undefined || patch.titleSource !== undefined) {
        this.metaChangeEmitter.fire();
      }
    }
  }

}
