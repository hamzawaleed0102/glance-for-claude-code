import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { Agent } from './Agent';
import { ShellAgent } from './ShellAgent';
import type { ManagedAgent } from './ManagedAgent';
import { nextAgentId } from './ids';
import { partitionPinnedFirst } from './pinSort';
import { neighborAfterRemoval } from './neighborSelection';
import { summarySystemPrompt } from '../markers/systemPrompt';
import type { AgentSnapshot, ClaudeModel, OldSession, TitleSource } from '../shared/messages';
import { listOldSessions as scanOldSessions } from './sessionScanner';

interface ManagerInit {
  context: vscode.ExtensionContext;
}

type ManagerEvent =
  | { type: 'added'; agent: AgentSnapshot }
  | { type: 'removed'; id: string }
  | { type: 'updated'; id: string; fields: Partial<AgentSnapshot> }
  | { type: 'active'; id: string | null }
  | { type: 'turnComplete'; id: string; snapshot: AgentSnapshot }
  | { type: 'unread'; total: number };

/**
 * Hook script writes one JSON file per event into the events dir. We watch that dir
 * (chokidar, 'add'), parse, route to the right Agent. The script self-heals: it
 * never throws and never blocks Claude's turn.
 */
export class AgentManager implements vscode.Disposable {
  private readonly agents = new Map<string, ManagedAgent>();
  private activeId: string | null = null;

  /**
   * Set true by `markShuttingDown()` (called from extension.deactivate
   * before VS Code disposes terminals on reload/quit). While true, each
   * agent's `onUserClose` handler short-circuits so Cmd+R doesn't wipe
   * sessions.json out from under the user. Cleared by being re-created
   * on the next activation.
   */
  private shuttingDown = false;

  private readonly storageDir: string;
  private readonly eventsDir: string;
  private readonly stateDir: string;
  private readonly hookScriptPath: string;
  private readonly mcpServerPath: string;
  private readonly hookSettingsPath: string;
  private readonly mcpConfigPath: string;
  private readonly instructionsPath: string;
  /**
   * Path to the per-workspace sessions.json (the list of session IDs the
   * user has surfaced as cards in this window). Null when no workspace
   * folder is open — the extension still loads but can't persist
   * anything because there's nowhere workspace-scoped to write to.
   */
  private readonly sessionsFile: string | null;
  /**
   * Per-workspace archive of session titles, keyed by Claude sessionId.
   * Survives card kills (unlike sessions.json, which only carries
   * entries for currently-tracked agents). Populated from every
   * onMetaChange when titleSource is non-default; consulted by the
   * old-sessions picker so closed cards still surface with their
   * AI/manual title instead of falling back to firstPrompt. Null when
   * no workspace folder is open.
   */
  private readonly titlesFile: string | null;
  private readonly eventsWatcher: FSWatcher;
  /**
   * VS Code's onDidChangeActiveTerminal subscription — mirrors the active
   * terminal pane's selection back into the Glance sidebar so clicking a
   * terminal tab at the bottom highlights its agent card without a second
   * trip through the panel.
   */
  private readonly activeTerminalSub: vscode.Disposable;

  private readonly changeEmitter = new vscode.EventEmitter<ManagerEvent>();
  readonly onChange = this.changeEmitter.event;

  constructor(init: ManagerInit) {
    this.storageDir = init.context.globalStorageUri.fsPath;
    fs.mkdirSync(this.storageDir, { recursive: true });

    // Workspace-scoped data dirs — events and state files are keyed by
    // short agent IDs (AG-01, AG-02, ...). Two VS Code windows each
    // number their own agents starting at AG-01, so if these dirs lived
    // in globalStorage they'd collide: Window 2's brand-new AG-01 would
    // write into the same state file Window 1's AG-01 watches, and the
    // card snapshots would swap across windows. Workspace-scoping fixes
    // that by giving every workspace its own state/ and events/ tree.
    // Binaries (hook.mjs / mcp-server.mjs / glancer-instructions.txt /
    // hook-settings.json / mcp-config.json) stay global — they're
    // install-once and don't carry per-agent state.
    const wsStorageDir = init.context.storageUri?.fsPath ?? null;
    const dataDir = wsStorageDir ?? this.storageDir;
    if (wsStorageDir) fs.mkdirSync(wsStorageDir, { recursive: true });

    this.eventsDir = path.join(dataDir, 'events');
    fs.mkdirSync(this.eventsDir, { recursive: true });

    // Per-agent JSON status files live here. Claude is instructed (via the
    // system prompt) to overwrite its file with `{title, tldr, progress,
    // needsInput, error}` after every response; each agent watches its own
    // file and routes the fields into the snapshot.
    this.stateDir = path.join(dataDir, 'state');
    fs.mkdirSync(this.stateDir, { recursive: true });

    // Copy the hook and MCP server scripts to storageDir so they have stable
    // absolute paths even when the extension is updated.
    this.hookScriptPath = path.join(this.storageDir, 'hook.mjs');
    const bundledHookPath = path.join(init.context.extensionPath, 'out', 'markers', 'hook.mjs');
    try {
      fs.copyFileSync(bundledHookPath, this.hookScriptPath);
      fs.chmodSync(this.hookScriptPath, 0o755);
    } catch (err) {
      console.warn('[glancer] failed to install hook script:', err);
    }

    this.mcpServerPath = path.join(this.storageDir, 'mcp-server.mjs');
    const bundledMcpPath = path.join(
      init.context.extensionPath,
      'out',
      'markers',
      'mcp-server.mjs',
    );
    try {
      fs.copyFileSync(bundledMcpPath, this.mcpServerPath);
      fs.chmodSync(this.mcpServerPath, 0o755);
    } catch (err) {
      console.warn('[glancer] failed to install MCP server script:', err);
    }

    this.hookSettingsPath = path.join(this.storageDir, 'hook-settings.json');
    // Claude Code runs hook commands through `/bin/sh -c`, so the path must be
    // shell-quoted. VS Code's globalStorageUri lives under
    // "~/Library/Application Support/..." on macOS — the space breaks
    // unquoted invocation.
    const shellQuoted = `'${this.hookScriptPath.replace(/'/g, `'\\''`)}'`;
    // Claude Code's hook schema: each event maps to an array of matcher groups,
    // each carrying its own `hooks` array of command entries. Empty `matcher`
    // means "match every invocation".
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

    // Glancer system instructions. The MCP server reads this file on
    // startup and returns its contents in the `initialize` response's
    // `instructions` field — the official MCP mechanism for surfacing
    // prompt-like guidance to the model. Written first so the path baked
    // into mcp-config.json (and read by Claude Code at session start)
    // already exists.
    this.instructionsPath = path.join(this.storageDir, 'glancer-instructions.txt');
    fs.writeFileSync(this.instructionsPath, summarySystemPrompt(''));

    this.mcpConfigPath = path.join(this.storageDir, 'mcp-config.json');
    fs.writeFileSync(
      this.mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            glancer: {
              command: 'node',
              args: [this.mcpServerPath],
              // The MCP server reads this file on startup and returns its
              // contents in the `initialize` response's `instructions`
              // field — the official MCP mechanism for surfacing
              // prompt-like guidance to the model. This is why we no
              // longer need `--append-system-prompt` on the claude CLI.
              env: {
                GLANCER_INSTRUCTIONS_FILE: this.instructionsPath,
              },
            },
          },
        },
        null,
        2,
      ),
    );

    this.eventsWatcher = chokidar.watch(this.eventsDir, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 200,
    });
    this.eventsWatcher.on('add', (filePath: string) => {
      this.handleHookEvent(filePath);
    });
    this.eventsWatcher.on('error', (err) => {
      console.error('[glancer] events watcher error', err);
    });

    // Sessions + titles persistence — workspace-scoped (same wsStorageDir
    // computed above). Source of truth for "what sessions exist on this
    // machine" remains Claude Code's own
    // `~/.claude/projects/<encoded-cwd>/*.jsonl`. Our sessions.json is
    // just the list of session IDs the user has chosen to surface as
    // cards in *this* window — kill drops one, opening a past chat via
    // the picker adds one. Other sessions stay on disk and remain
    // discoverable through the picker.
    if (wsStorageDir) {
      this.sessionsFile = path.join(wsStorageDir, 'sessions.json');
      this.titlesFile = path.join(wsStorageDir, 'session-titles.json');
      this.maybeMigrateGlobalSessions();
      this.maybeMigrateGlobalTitles();
      this.maybeMigrateGlobalState();
    } else {
      this.sessionsFile = null;
      this.titlesFile = null;
    }
    this.restorePersistedAgents();

    // Keep the sidebar's active card in sync with VS Code's active terminal.
    // Firing on every terminal switch is cheap (O(agents) scan) and avoids
    // adding a second source of truth — `activeId` is still owned here.
    this.activeTerminalSub = vscode.window.onDidChangeActiveTerminal((t) =>
      this.syncActiveFromTerminal(t),
    );
  }

  /**
   * After an extension reload (update install, "Developer: Reload Window")
   * the extension host restarts but VS Code keeps the Glance terminal
   * tabs visible in the panel. The new host can't recover those: VS Code's
   * Pseudoterminal I/O channel was owned by the dead host, so keystrokes
   * route to a handler that no longer exists — the terminal looks alive
   * but the cursor doesn't render and input doesn't reach Claude.
   *
   * Dispose them on activation so clicking an agent card produces one
   * fresh `--resume` terminal instead of a corpse + a live duplicate.
   * Match by name against the persisted set (sessions.json); iconPath
   * isn't reliably preserved across the host boundary because the
   * `ThemeIcon` instance came from the dead host's runtime.
   *
   * Earlier versions of this file tried to ADOPT instead of dispose
   * (0.0.12 – 0.0.14) on the theory that the terminals were still
   * usable. They aren't — the I/O channel is gone.
   */
  private disposeOrphanGlanceTerminals(expectedNames: Set<string>): void {
    if (expectedNames.size === 0) return;
    for (const t of vscode.window.terminals) {
      if (expectedNames.has(t.name)) {
        try {
          t.dispose();
        } catch {
          // already disposed
        }
      }
    }
  }

  /**
   * Read sessions.json (if present) and reconstruct each entry as a dormant
   * Agent. The card appears in the panel immediately with the last-known
   * snapshot; the PTY isn't spawned until the user clicks the card (which
   * calls reveal() → revive() and starts claude with `--resume <id>`).
   */
  /**
   * Set of cwds (workspace folder fsPaths) for THIS VS Code window.
   * Used by the one-shot migration helper to pick out entries belonging
   * to this workspace from the legacy global sessions.json.
   */
  private currentWorkspaceCwds(): Set<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return new Set(folders.map((f) => f.uri.fsPath));
  }

  /**
   * One-shot migration from the legacy globalStorage/sessions.json (which
   * mixed agents from every workspace together and was the source of
   * cross-workspace pollution) into per-workspace sessions.json. Only
   * runs when the workspace sessions.json doesn't yet exist; subsequent
   * launches use the workspace file directly. The legacy global file is
   * intentionally left in place so OTHER workspaces can still migrate
   * their own entries the first time they open under the new code.
   */
  private maybeMigrateGlobalSessions(): void {
    if (!this.sessionsFile) return;
    if (fs.existsSync(this.sessionsFile)) return;
    const legacyPath = path.join(this.storageDir, 'sessions.json');
    let raw: string;
    try {
      raw = fs.readFileSync(legacyPath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const ourCwds = this.currentWorkspaceCwds();
    const ours = (parsed as Array<{ cwd?: unknown }>).filter(
      (e) => e && typeof e.cwd === 'string' && ourCwds.has(e.cwd),
    );
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(ours, null, 2));
    } catch (err) {
      console.warn('[glancer] sessions migration failed:', err);
    }
  }

  /**
   * Companion to maybeMigrateGlobalSessions for the titles archive. Titles
   * are keyed by Claude sessionId (not cwd), so we copy the whole file
   * verbatim — same titles file ends up in every workspace's storage,
   * but the picker filters by cwd at read time so only the relevant
   * titles are surfaced. Without this migration, opening a previously-
   * known session via the picker shows "Glance" instead of the archived
   * title, because workspace-scoped readSessionTitles() finds an empty
   * file even though globalStorage/session-titles.json is populated.
   */
  /**
   * Move per-agent state files from globalStorage to the workspace-scoped
   * state dir on first launch under the new code. Without this, the
   * just-restored dormant agents would point their stateFilePath at the
   * empty workspace dir and lose their last-known tldr/progress/skill
   * snapshots until the next user prompt repopulates them.
   *
   * Only migrates entries we can trace to this workspace — IDs listed in
   * the workspace sessions.json (live cards) and sessionIds listed in
   * the workspace session-titles.json (covers killed sessions that
   * still have a by-session archive worth preserving). Other workspaces'
   * state files stay at the global path so their own migrations can
   * pick them up.
   */
  private maybeMigrateGlobalState(): void {
    if (!this.sessionsFile) return;
    const legacyStateDir = path.join(this.storageDir, 'state');
    if (!fs.existsSync(legacyStateDir)) return;
    if (legacyStateDir === this.stateDir) return; // same dir, nothing to do

    // Live state files: state/<agentId>.json for every agent in sessions.json.
    let sessionEntries: unknown = [];
    try {
      sessionEntries = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch {
      // sessions.json may be missing on a brand-new workspace — fine,
      // there's nothing to migrate then.
    }
    if (Array.isArray(sessionEntries)) {
      for (const e of sessionEntries as Array<{ id?: unknown }>) {
        if (!e || typeof e.id !== 'string') continue;
        const src = path.join(legacyStateDir, `${e.id}.json`);
        const dst = path.join(this.stateDir, `${e.id}.json`);
        if (fs.existsSync(dst)) continue; // already migrated
        if (!fs.existsSync(src)) continue;
        try {
          fs.copyFileSync(src, dst);
        } catch (err) {
          console.warn('[glancer] state file migration failed for', e.id, err);
        }
      }
    }

    // By-session archive: state/by-session/<sessionId>.json for every
    // sessionId in titles.json. Lets restoreArchivedState (called from
    // openOldSession) seed a re-opened card with the previous turn's
    // markers even if the kill happened before this update.
    if (this.titlesFile && fs.existsSync(this.titlesFile)) {
      let titles: unknown = {};
      try {
        titles = JSON.parse(fs.readFileSync(this.titlesFile, 'utf8'));
      } catch {
        // fall through
      }
      if (titles && typeof titles === 'object' && !Array.isArray(titles)) {
        const legacyArchiveDir = path.join(legacyStateDir, 'by-session');
        const wsArchiveDir = path.join(this.stateDir, 'by-session');
        if (fs.existsSync(legacyArchiveDir)) {
          for (const sessionId of Object.keys(titles as Record<string, unknown>)) {
            const src = path.join(legacyArchiveDir, `${sessionId}.json`);
            const dst = path.join(wsArchiveDir, `${sessionId}.json`);
            if (fs.existsSync(dst)) continue;
            if (!fs.existsSync(src)) continue;
            try {
              fs.mkdirSync(wsArchiveDir, { recursive: true });
              fs.copyFileSync(src, dst);
            } catch (err) {
              console.warn(
                '[glancer] by-session archive migration failed for',
                sessionId,
                err,
              );
            }
          }
        }
      }
    }
  }

  private maybeMigrateGlobalTitles(): void {
    if (!this.titlesFile) return;
    if (fs.existsSync(this.titlesFile)) return;
    const legacyPath = path.join(this.storageDir, 'session-titles.json');
    if (!fs.existsSync(legacyPath)) return;
    try {
      fs.copyFileSync(legacyPath, this.titlesFile);
    } catch (err) {
      console.warn('[glancer] titles migration failed:', err);
    }
  }

  private restorePersistedAgents(): void {
    if (!this.sessionsFile) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionsFile, 'utf8');
    } catch {
      // No sessions file yet — fresh install or first run in this workspace.
      return;
    }
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      console.warn(`[glancer] restorePersistedAgents: parse failed (${err}), raw=${raw.slice(0, 200)}`);
      return;
    }
    if (!Array.isArray(entries)) {
      console.warn('[glancer] restorePersistedAgents: file is not an array, ignoring');
      return;
    }
    // Dispose orphan Glance terminals from the previous extension host
    // BEFORE building any dormant Agents. Their PTY I/O channel was
    // owned by the dead host and can't be reattached, so leaving them
    // would just clutter the panel with un-typeable corpses while the
    // new spawned terminal (on click → revive → spawn) does the work.
    const expectedNames = new Set<string>();
    for (const e of entries as Array<{ name?: unknown }>) {
      if (e && typeof e.name === 'string') expectedNames.add(e.name);
    }
    this.disposeOrphanGlanceTerminals(expectedNames);
    for (const e of entries as Array<{
      id: string;
      cwd: string;
      model: ClaudeModel;
      sessionId: string | null;
      name: string;
      titleSource: AgentSnapshot['titleSource'];
      hasUserPrompt?: boolean;
      pinned?: boolean;
    }>) {
      // Mirror titled entries into the persistent titles archive on
      // every restore. Existing installs ship sessions.json full of
      // non-default titles that never went through this code path —
      // this seeds them so a kill right after upgrade doesn't drop
      // the title.
      if (
        e &&
        typeof e.sessionId === 'string' &&
        typeof e.name === 'string' &&
        e.titleSource &&
        e.titleSource !== 'default'
      ) {
        this.recordSessionTitle(e.sessionId, e.name, e.titleSource);
      }
      if (!e || typeof e.id !== 'string' || typeof e.cwd !== 'string') {
        console.warn('[glancer] restorePersistedAgents: skipping malformed entry', e);
        continue;
      }
      // Skip if the workspace folder no longer exists — Claude's --resume
      // would fail anyway, and the user can't meaningfully interact.
      if (!fs.existsSync(e.cwd)) {
        console.warn(`[glancer] restorePersistedAgents: skipping ${e.id} — cwd missing: ${e.cwd}`);
        continue;
      }
      const agent = this.makeAgent({
        id: e.id,
        cwd: e.cwd,
        model: e.model ?? 'default',
        dormant: true,
        sessionId: e.sessionId ?? null,
        initialSnapshot: {
          name: e.name,
          titleSource: e.titleSource,
        },
        hasUserPrompt: e.hasUserPrompt ?? true,
        pinned: e.pinned === true,
      });
      this.agents.set(e.id, agent);
    }
    // Dormant agents' stateWatchers fire applyState asynchronously as
    // chokidar's polling kicks in. The change listener will re-emit on
    // each of those, but we also publish a one-shot snapshot here so
    // the badge is correct the moment the webview first resolves —
    // even if no stateWatcher fires (e.g. dormant agent with no
    // persisted state file).
    this.emitUnreadCount();
    // Normalize pinned-first even if sessions.json was hand-edited.
    this.applyPinnedFirst();
  }

  /**
   * Serialize the current agent set to sessions.json. Called whenever an
   * agent is added, removed, or fires `onMetaChange` (sessionId / name /
   * titleSource updates). The marker fields (tldr / progress / etc.) are
   * NOT in this file — they live in each agent's state/<id>.json.
   */
  private persist(): void {
    if (!this.sessionsFile) return;
    // Only persist agents the user has actually chatted with. Empty sessions
    // (auto-spawned card, no UserPromptSubmit yet) have a sessionId from
    // SessionStart but no JSONL on disk — `claude --resume <id>` fails on
    // those with "No conversation found with session ID". Filtering them
    // out keeps the restore path clean.
    //
    // Workspace-scoped storage means this file only ever contains this
    // window's agents — no cross-workspace merge logic, no clobber
    // protection needed. Two windows on the SAME workspace still share
    // the file, but they're showing the same agent set anyway.
    const entries = Array.from(this.agents.values())
      // Only Claude agents are persisted — shell cards are ephemeral.
      .filter((a): a is Agent => a instanceof Agent && a.hasUserPrompt)
      .map((a) => ({
        id: a.id,
        cwd: a.cwd,
        model: a.model,
        sessionId: a.sessionId,
        name: a.name,
        titleSource: a.titleSource,
        hasUserPrompt: true,
        pinned: a.pinned,
      }));
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.warn('[glancer] failed to persist sessions:', err);
    }
  }

  /**
   * Delete the per-agent state file (if any) at `state/<id>.json`.
   * Called before constructing a brand-new agent on an id that may
   * have an orphan file from a prior session, so the new agent's
   * chokidar watcher doesn't seed the card with stale markers.
   */
  private wipeStateFile(id: string): void {
    try {
      fs.unlinkSync(path.join(this.stateDir, `${id}.json`));
    } catch {
      // ENOENT is the common case (no orphan); other errors are
      // non-fatal — Claude's first update_state will overwrite.
    }
  }

  /** Directory holding state snapshots keyed by Claude sessionId — used
   * to preserve `tldr`/`progress`/`skill`/etc. across kill→reopen. State
   * files in `stateDir` itself are keyed by glance agent id (Claude's
   * MCP server writes there via the GLANCER_STATE_FILE env), but agent
   * ids are reassigned on every reopen, so we promote the file to a
   * sessionId-keyed slot whenever a card with a sessionId is killed. */
  private archiveDir(): string {
    return path.join(this.stateDir, 'by-session');
  }

  /**
   * Move the just-killed agent's state file into the by-session archive
   * so a future `openOldSession` can seed the new card from it. No-op
   * if the agent never got a sessionId (killed before SessionStart) or
   * the source file is already gone.
   */
  private archiveStateOnKill(agent: Agent): void {
    if (!agent.sessionId) return;
    const src = path.join(this.stateDir, `${agent.id}.json`);
    if (!fs.existsSync(src)) return;
    const dst = path.join(this.archiveDir(), `${agent.sessionId}.json`);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // Use rename for atomicity — if it fails (e.g. cross-device on
      // some configs), fall back to copy+unlink so we don't leave the
      // file behind to confuse a future agent that grabs this id.
      fs.renameSync(src, dst);
    } catch (err) {
      console.warn('[glancer] state archive failed, falling back to copy:', err);
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
      } catch (err2) {
        console.warn('[glancer] state archive fallback failed:', err2);
      }
    }
  }

  /**
   * Pre-seed a fresh agent's state file from the by-session archive if
   * we have an entry for `sessionId`. Called by `openOldSession` after
   * `wipeStateFile` but before `makeAgent`, so the new agent's chokidar
   * watcher sees a populated file on its first poll and emits a
   * restored snapshot instead of the empty default. The archive entry
   * is consumed (moved) — if this card is later killed, it'll be re-
   * archived from the new id's path.
   */
  private restoreArchivedState(newAgentId: string, sessionId: string): void {
    const src = path.join(this.archiveDir(), `${sessionId}.json`);
    if (!fs.existsSync(src)) return;
    const dst = path.join(this.stateDir, `${newAgentId}.json`);
    try {
      fs.renameSync(src, dst);
    } catch (err) {
      console.warn('[glancer] state restore failed, falling back to copy:', err);
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
      } catch (err2) {
        console.warn('[glancer] state restore fallback failed:', err2);
      }
    }
  }

  /** Common Agent construction wiring used by both `newAgent` and restore. */
  private makeAgent(opts: {
    id: string;
    cwd: string;
    model: ClaudeModel;
    dormant?: boolean;
    sessionId?: string | null;
    initialSnapshot?: { name?: string; titleSource?: AgentSnapshot['titleSource'] };
    hasUserPrompt?: boolean;
    pinned?: boolean;
  }): Agent {
    const agent = new Agent({
      id: opts.id,
      cwd: opts.cwd,
      model: opts.model,
      hookSettingsPath: this.hookSettingsPath,
      mcpConfigPath: this.mcpConfigPath,
      eventsDir: this.eventsDir,
      hookScriptPath: this.hookScriptPath,
      stateFilePath: path.join(this.stateDir, `${opts.id}.json`),
      dormant: opts.dormant,
      sessionId: opts.sessionId,
      initialSnapshot: opts.initialSnapshot,
      hasUserPrompt: opts.hasUserPrompt,
      pinned: opts.pinned,
    });
    agent.onChange((fields) => {
      this.changeEmitter.fire({ type: 'updated', id: opts.id, fields });
      // Recompute the badge on EVERY change. Cheap (O(agents), single
      // pass). Was previously gated on attentionReason/errorReason keys
      // being in the patch — but that left edge cases (agent disposed
      // mid-event, race conditions in restore, future code paths that
      // forget to populate the key) where the badge could drift.
      // Unconditional recompute eliminates the entire class of bug.
      this.emitUnreadCount();
    });
    agent.onMetaChange(() => {
      this.persist();
      // Mirror the title into the session-titles archive so it survives
      // a future kill. Only non-default sources are worth archiving.
      if (agent.sessionId) {
        this.recordSessionTitle(agent.sessionId, agent.name, agent.titleSource);
      }
    });
    agent.onTurnComplete(() =>
      this.changeEmitter.fire({
        type: 'turnComplete',
        id: opts.id,
        snapshot: agent.snapshot(),
      }),
    );
    // NOTE: we deliberately do NOT auto-remove on PTY exit. VS Code reload
    // and accidental terminal closure both fire exit, and removing on those
    // events wipes sessions.json out from under us. The Agent transitions
    // to dormant on its own (see Agent.becomeDormant). Permanent removal
    // only happens via the explicit Glancer kill button → removeAgent(),
    // or via `onUserClose` below when the user trashes the terminal from
    // VS Code's panel.
    agent.onUserClose(() => {
      // `shuttingDown` is set in `markShuttingDown` (called from
      // extension.deactivate before VS Code disposes terminals on
      // reload/quit), so this handler only fires for real user-initiated
      // terminal closure.
      if (this.shuttingDown) return;
      this.kill(opts.id);
    });
    return agent;
  }

  list(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((a) => a.snapshot());
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  newAgent(opts: { cwd: string; model?: ClaudeModel }): string {
    const id = nextAgentId(this.agents.keys());
    // `nextAgentId` reuses the lowest free slot, so a kill of AG-03
    // followed by a `g` press lands the next agent back on AG-03 —
    // which inherits any stale state file at state/AG-03.json (an
    // orphan from a prior session that never made it into
    // sessions.json, or a failed earlier purge). The Agent's
    // chokidar watcher reads that file on attach and seeds the new
    // card with the previous chat's title/tldr/progress. Wipe it
    // here so fresh agents start with empty cards regardless of
    // what was left behind.
    this.wipeStateFile(id);
    const agent = this.makeAgent({
      id,
      cwd: opts.cwd,
      model: opts.model ?? 'default',
    });
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    this.persist();
    return id;
  }

  /**
   * Spawn a plain shell terminal card (the `t` key). Unlike `newAgent` this
   * starts no Claude process — `ShellAgent` wraps an ordinary VS Code
   * integrated terminal. Shell cards are never persisted, so there is no
   * `persist()` call and no orphan state file to wipe.
   */
  newTerminal(opts: { cwd: string }): string {
    const id = nextAgentId(this.agents.keys());
    const agent = new ShellAgent({ id, cwd: opts.cwd });
    agent.onChange((fields) => {
      this.changeEmitter.fire({ type: 'updated', id, fields });
      this.emitUnreadCount();
    });
    // A shell card can't be revived — closing its terminal removes the card.
    // Mirror makeAgent's onUserClose guard: terminal-close events also fire
    // during reload/quit teardown, and removeAgent → persist() would then
    // rewrite sessions.json mid-shutdown.
    agent.onClose(() => {
      if (this.shuttingDown) return;
      this.removeAgent(id);
    });
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    return id;
  }

  /**
   * Read the session-titles archive (sessionId → name/titleSource).
   * Returns an empty Map on missing file or invalid JSON. Written to
   * by recordSessionTitle on every onMetaChange; read by the picker
   * and openOldSession so titles survive card kills.
   */
  private readSessionTitles(): Map<string, { name: string; titleSource: TitleSource }> {
    const map = new Map<string, { name: string; titleSource: TitleSource }>();
    if (!this.titlesFile) return map;
    try {
      const raw = fs.readFileSync(this.titlesFile, 'utf8');
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [sessionId, entry] of Object.entries(
          data as Record<string, unknown>,
        )) {
          if (
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            typeof (entry as { titleSource?: unknown }).titleSource === 'string'
          ) {
            map.set(sessionId, {
              name: (entry as { name: string }).name,
              titleSource: (entry as { titleSource: TitleSource }).titleSource,
            });
          }
        }
      }
    } catch {
      // Missing or invalid — return empty map.
    }
    return map;
  }

  /**
   * Upsert one entry in the titles archive. No-op for default-source
   * titles (the `glance-NN` autoname carries no information worth
   * archiving). Read-modify-write — concurrent updates from two agents
   * race in theory, but each write captures the latest snapshot of
   * its own key, so worst case is one lost intermediate update that
   * the next title change will re-capture.
   */
  private recordSessionTitle(
    sessionId: string,
    name: string,
    titleSource: TitleSource,
  ): void {
    if (titleSource === 'default') return;
    if (!this.titlesFile) return;
    const map = this.readSessionTitles();
    map.set(sessionId, { name, titleSource });
    const obj: Record<string, { name: string; titleSource: TitleSource }> = {};
    for (const [k, v] of map) obj[k] = v;
    try {
      fs.writeFileSync(this.titlesFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.warn('[glancer] failed to write session-titles archive:', err);
    }
  }

  /**
   * Return past Claude Code sessions for `cwd`, excluding any whose
   * sessionId is currently held by a live agent in this manager. After
   * scanning, enriches each result with the Glance-assigned title (from
   * sessions.json) when we have one — Claude doesn't store a title in
   * its own transcript, so the picker prefers our title over the raw
   * first prompt.
   */
  async listOldSessions(cwd: string): Promise<OldSession[]> {
    const open = new Set<string>();
    for (const a of this.agents.values()) {
      // sessionId is Claude-only; shell cards have none to exclude.
      if (a instanceof Agent && a.sessionId) open.add(a.sessionId);
    }
    const titles = this.readSessionTitles();
    const sessions = await scanOldSessions(cwd, open);
    return sessions.map((s) => ({
      ...s,
      name: titles.get(s.sessionId)?.name ?? null,
    }));
  }

  /**
   * Open an existing Claude Code session as a new agent card. Spawns
   * the PTY immediately with `claude --resume <sessionId>` via the
   * normal makeAgent path. `hasUserPrompt: true` is hard-coded because
   * a session already on disk must have user prompts — otherwise the
   * resume would fail anyway, and Agent.onExit would drop it to
   * dormant naturally.
   */
  openOldSession(opts: { cwd: string; sessionId: string }): string {
    const id = nextAgentId(this.agents.keys());
    // Same orphan-state guard as `newAgent` — the chosen id may have
    // an orphan state file left behind by a prior agent. The picker
    // seeds the snapshot from the titles archive (by sessionId), but
    // the state file path is keyed by the new id, so we still need
    // to wipe whatever sits at state/<id>.json or chokidar's first
    // read will overwrite the seed with stale markers.
    this.wipeStateFile(id);
    // Restore the previous card's markers (tldr / progress / skill /
    // needsInput / error) by moving the by-session archive into the new
    // agent's state slot. chokidar's first poll on the constructor's
    // watcher will then emit a populated snapshot instead of the empty
    // default. Title is handled separately just below via the titles
    // archive — they're stored in different files because titles need
    // to survive even when the user opens an old session that was
    // killed before any state file was ever written.
    this.restoreArchivedState(id, opts.sessionId);
    // Carry the archived title (set by Claude via update_state or by
    // the user via rename) through to the new agent's snapshot so the
    // card opens with the same title the picker displayed, instead of
    // briefly flashing `glance-NN`. The titles archive survives kills,
    // so this works even for sessions whose previous card was closed.
    const archived = this.readSessionTitles().get(opts.sessionId);
    const initialSnapshot = archived
      ? { name: archived.name, titleSource: archived.titleSource }
      : undefined;
    const agent = this.makeAgent({
      id,
      cwd: opts.cwd,
      // Picker UX doesn't surface a model choice — model picking lives
      // on `newAgent`'s split button. Reopened sessions start fresh with
      // the default, matching the rest of the "reopened sessions start
      // clean" design (see the design spec's "Title source" section).
      model: 'default',
      sessionId: opts.sessionId,
      hasUserPrompt: true,
      dormant: false,
      initialSnapshot,
    });
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    this.persist();
    return id;
  }

  kill(id: string): void {
    const a = this.agents.get(id);
    // Pinned cards refuse kill until the user unpins them. No toast or
    // log — the pin icon (rendered in place of the X) is the visible
    // cue. Cmd+Backspace and the on-card pin button both route here.
    if (!a || a.pinned) return;
    this.removeAgent(id);
  }

  /**
   * Flip the pinned flag for `id`, then re-stable-partition the agents
   * Map so pinned entries lead and unpinned follow. Setter on the Agent
   * already triggers a persist via metaChangeEmitter — the explicit
   * persist() here writes the *order* after resort (the
   * metaChange-driven persist captured the pre-resort order). Two small
   * writes per toggle is acceptable; the file is tiny.
   */
  togglePin(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    a.setPinned(!a.pinned);
    this.applyPinnedFirst();
    this.persist();
  }

  /**
   * In-place pinned-first resort. Used after any operation that could
   * leave the Map order violating the invariant (togglePin, reorder
   * from the webview, hand-edited sessions.json on restore). Keeps the
   * `private readonly agents` field declaration intact — Map's `clear`
   * + `set` mutate in place, no reassignment needed.
   */
  private applyPinnedFirst(): void {
    const sorted = partitionPinnedFirst(this.agents);
    this.agents.clear();
    for (const [id, agent] of sorted) this.agents.set(id, agent);
  }

  private removeAgent(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    // Capture the neighbor BEFORE deleting — focus moves to the card
    // that was just above the killed one so the panel doesn't scroll
    // away from the delete site (was: jump to the first card).
    const neighbor = neighborAfterRemoval([...this.agents.keys()], id);
    // Delete from the map FIRST so the async `proc.onExit` triggered by
    // `a.dispose()` re-enters this function as a no-op.
    this.agents.delete(id);
    this.changeEmitter.fire({ type: 'removed', id });
    if (this.activeId === id) {
      this.setActive(neighbor);
    }
    a.dispose();
    // State archival / purge is Claude-only — shell agents have no
    // sessionId and no state file. For a Claude agent, promote the state
    // file into the by-session archive (keyed by the Claude sessionId) so
    // a future openOldSession can re-seed a new card with the previous
    // tldr/progress/skill; if there's no sessionId yet (kill before
    // SessionStart), purgePersistentState does the unconditional delete.
    if (a instanceof Agent) {
      this.archiveStateOnKill(a);
      a.purgePersistentState();
    }
    this.persist();
    // Always recompute — even if this agent wasn't in attention, closing
    // it can still shift other UI that derives from the agent set (and
    // costs nothing). Previously gated on `wasCounted`, which silently
    // dropped updates when the closing agent's attention state had just
    // changed in a way we hadn't sampled yet.
    this.emitUnreadCount();
  }

  select(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.setActive(id);
    a.reveal();
  }

  /**
   * Set active + show terminal with focus stolen into it. Wired to Enter on
   * a focused card in the webview; arrow navigation uses `select` so the
   * panel keeps keyboard focus.
   */
  focusTerminal(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.setActive(id);
    a.focusTerminal();
  }

  /**
   * Clear the active content in the currently selected agent's terminal and
   * focus it: `/clear` for a Claude card, scrollback clear for a shell card.
   * Wired to the `c c` chord on the focused agent panel. No-op when there
   * is no selected agent (fresh session, empty list).
   */
  clearActive(): void {
    if (!this.activeId) return;
    this.agents.get(this.activeId)?.clearActive();
  }

  /** True if the agent's terminal is the currently active VS Code terminal. */
  isAgentTerminalActive(id: string): boolean {
    return !!this.agents.get(id)?.isTerminalActive();
  }

  /**
   * Reveal the active agent's terminal without stealing focus. Used by
   * the provider when the user focuses Glancer — calling `terminal.show()`
   * un-hides the bottom panel if it was Cmd+J'd, so the user lands in a
   * workspace where both panels are visible.
   */
  revealActiveTerminal(): void {
    if (!this.activeId) return;
    this.agents.get(this.activeId)?.reveal();
  }

  /**
   * Total agents currently showing an "attention" or "error" marker.
   * Drives the activity-bar badge — simple state-derived count, no
   * "read/unread" bookkeeping. As soon as Claude clears the attentionReason
   * (e.g. via clearTransient on the next UserPromptSubmit) the count drops.
   */
  unreadCount(): number {
    let n = 0;
    for (const a of this.agents.values()) if (a.needsAttention) n++;
    return n;
  }

  /**
   * Fire `unread` event with the current total. Called whenever an agent's
   * attentionReason/errorReason changes, or an agent is removed.
   */
  private emitUnreadCount(): void {
    this.changeEmitter.fire({ type: 'unread', total: this.unreadCount() });
  }

  rename(id: string, name: string): void {
    this.agents.get(id)?.setManualTitle(name);
  }

  resetTitle(id: string): void {
    this.agents.get(id)?.setManualTitle('');
  }

  /**
   * Rebuild the internal agents Map in the order supplied by the
   * webview after a drag-drop. Map preserves insertion order, so
   * subsequent `list()` / `persist()` calls naturally follow the new
   * sequence. Any agents missing from the input list are appended at
   * the end (defensive — shouldn't happen in practice since the webview
   * sends the full ordering).
   */
  reorder(ids: string[]): void {
    const entries: [string, ManagedAgent][] = [];
    for (const id of ids) {
      const a = this.agents.get(id);
      if (a) entries.push([id, a]);
    }
    for (const [id, a] of this.agents) {
      if (!entries.some(([eid]) => eid === id)) entries.push([id, a]);
    }
    this.agents.clear();
    for (const [id, a] of entries) this.agents.set(id, a);
    // Enforce pinned-first invariant even if the user dragged across
    // the boundary. Snaps offending cards back to their legal slot.
    this.applyPinnedFirst();
    this.persist();
  }

  private setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.changeEmitter.fire({ type: 'active', id });
  }

  /**
   * Mirror the user's terminal-pane selection into the sidebar. Called from
   * `onDidChangeActiveTerminal`. Non-Glance terminals (and `undefined`) are
   * ignored — the previously active card stays put rather than blanking out
   * every time the user clicks an unrelated shell.
   */
  private syncActiveFromTerminal(t: vscode.Terminal | undefined): void {
    if (!t) return;
    for (const [id, a] of this.agents) {
      if (a.ownsTerminal(t)) {
        this.setActive(id);
        return;
      }
    }
  }

  private handleHookEvent(filePath: string): void {
    let payload: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch (err) {
      console.warn('[glancer] failed to read hook event', filePath, err);
      return;
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    if (typeof payload !== 'object' || payload === null) return;
    const wrapper = payload as {
      agentId?: string;
      payload?: {
        hook_event_name?: string;
        session_id?: string;
        prompt?: string;
        message?: string;
        // SessionStart hook reports how the session began. Values per
        // Claude Code: 'startup' (fresh), 'resume' (--resume <id>),
        // 'clear' (/clear), 'compact' (/compact).
        source?: 'startup' | 'resume' | 'clear' | 'compact';
      };
    };
    const agentId = wrapper.agentId;
    const hookEvent = wrapper.payload?.hook_event_name;
    const sessionId = wrapper.payload?.session_id;
    if (!agentId) return;
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn('[glancer] hook event for unknown agent', agentId);
      return;
    }
    // Shell-terminal cards have no hooks wired, so a hook event addressed
    // to one would be a bug. Narrowing to the Claude `Agent` also lets the
    // Claude-only calls below (setSessionId, notifyTurnComplete, …) typecheck.
    if (!(agent instanceof Agent)) {
      console.warn('[glancer] hook event for non-Claude agent', agentId);
      return;
    }
    if (hookEvent === 'SessionStart') {
      // Capture the Claude session id (if present) so --resume works on
      // next launch. The sessionId can be absent in some SessionStart
      // payloads — that's fine, we don't require it for the reset.
      if (sessionId) agent.setSessionId(sessionId);
      // /clear (and /compact) start a fresh conversation. Any tldr /
      // attention / error / progress from the prior session is stale,
      // and the badge would stay stuck on a now-meaningless "needs
      // input" marker. Wipe it. 'startup' and 'resume' deliberately
      // preserve state.
      const source = wrapper.payload?.source;
      if (source === 'clear' || source === 'compact') {
        agent.resetCardState();
      }
    } else if (hookEvent === 'UserPromptSubmit') {
      // First UserPromptSubmit promotes the agent from "empty session"
      // (won't survive --resume) to "real session" (persisted across
      // launches). Also clears transient marker rows — that wipes
      // attentionReason/errorReason which naturally drops this agent's
      // badge contribution.
      agent.markUserPrompted();
      agent.clearTransient();
    } else if (hookEvent === 'Stop') {
      // Claude's Stop hook fires when a response finishes — the canonical
      // "agent done, ball is in user's court" signal. We bubble this up so
      // the provider can chime + show a VS Code notification.
      agent.notifyTurnComplete();
    } else if (hookEvent === 'Notification') {
      // Notification hook fires for two distinct cases:
      //   1. Real attention required — tool-permission prompts, slash-
      //      command interactive pickers (e.g. /feedback). These fire
      //      mid-turn, while the agent is streaming.
      //   2. Claude Code's 60s idle timeout — fires automatically after
      //      a clean turn already ended. Streaming is already false by
      //      the time this arrives (Stop fired first). Informational
      //      only, not a real attention request.
      // Gate primarily on streaming state: if the turn already ended,
      // ignore the Notification regardless of its wording. Without this
      // every finished green ✓ card flipped to yellow attention after
      // a minute of user idle time. Message-regex kept as a defensive
      // fallback for the rare race where idle fires before Stop is
      // processed.
      if (!agent.streaming) return;
      const payload = wrapper.payload as { message?: string } | undefined;
      const raw = typeof payload?.message === 'string' ? payload.message.trim() : '';
      if (/claude is waiting for your input/i.test(raw)) return;
      const message = raw || 'Waiting for input';
      agent.setNeedsAttention(message);
    }
  }

  /**
   * Called from `extension.deactivate` before `dispose()`. Flips the
   * `shuttingDown` flag so that the terminal-close events VS Code fires
   * during reload/quit don't get routed into `kill()` — which would
   * permanently wipe agents the user expects to find dormant on the
   * next activation. Safe to call multiple times; idempotent.
   */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  dispose(): void {
    for (const a of this.agents.values()) a.dispose();
    this.agents.clear();
    this.eventsWatcher.close();
    this.activeTerminalSub.dispose();
    this.changeEmitter.dispose();
  }
}
