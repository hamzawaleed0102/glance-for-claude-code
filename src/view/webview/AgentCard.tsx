import { useEffect, useState } from 'react';
import type { AgentSnapshot } from '../../shared/messages';
import { postToHost } from './api';

interface Props {
  agent: AgentSnapshot;
  active: boolean;
  onSelect: () => void;
  onKill: () => void;
  /** True when this card is the one currently being dragged. */
  dragging?: boolean;
  /** True when this card is the drop target the user is hovering. */
  dragOver?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

type StatusKind = 'starting' | 'error' | 'attention' | 'streaming' | 'done' | 'idle';

/**
 * Single source of truth for the left-rail status indicator. Precedence is
 * urgency-ordered: hard failure > awaiting-input > actively working >
 * finished. "Done" fires whenever a turn ended (not streaming) AND there's
 * any evidence Claude ran — a TL;DR or any progress value. "Idle" is the
 * only state with no icon at all, reserved for fresh cards that haven't
 * seen a single turn yet.
 */
function statusOf(agent: AgentSnapshot): StatusKind {
  if (agent.starting) return 'starting';
  if (agent.errorReason) return 'error';
  if (agent.attentionReason) return 'attention';
  if (agent.streaming) return 'streaming';
  if (agent.tldr || agent.progress) return 'done';
  return 'idle';
}

function StatusIcon({ status, title }: { status: StatusKind; title?: string }) {
  // Idle = no icon at all. Earlier states used a dim grey dot which read as
  // visual noise on cards that hadn't done anything yet.
  if (status === 'idle') return null;
  if (status === 'done') {
    return (
      <span className="agent-status done" title={title ?? 'Done'} aria-label="Done">
        ✓
      </span>
    );
  }
  return (
    <span
      className={`agent-status dot ${status}`}
      title={title ?? statusLabel(status)}
      aria-label={statusLabel(status)}
    />
  );
}

function statusLabel(s: StatusKind): string {
  switch (s) {
    case 'starting': return 'Starting…';
    case 'error': return 'Error';
    case 'attention': return 'Needs input';
    case 'streaming': return 'Working';
    case 'done': return 'Done';
    default: return '';
  }
}

/**
 * Splits a progress label that starts with a step counter like "1/3 " into
 * a separate counter chip + activity word. Without this, multi-todo turns
 * (where Claude formats the label as "<i>/<n> <activity>") render the
 * counter inline with the activity text and read as one blob. Pulling it
 * out gives the user a quick "where am I in the list" glance.
 *
 * Non-matching labels fall through unchanged.
 */
function ProgressLabel({ label }: { label: string }) {
  const m = label.match(/^(\d+\/\d+)\s+(.+)$/);
  if (!m) {
    return <div className="agent-progress-label">{label}</div>;
  }
  return (
    <div className="agent-progress-label">
      <span className="agent-progress-counter">{m[1]}</span>
      {m[2]}
    </div>
  );
}

export function AgentCard({
  agent,
  active,
  onSelect,
  onKill,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const isLocked = agent.titleSource === 'manual' || agent.titleSource === 'rename';
  const status = statusOf(agent);

  useEffect(() => { setDraft(agent.name); }, [agent.name]);

  // `r` pressed in the panel: AgentList dispatches `glancer:rename` carrying
  // the highlighted card's id. Flip into editing mode if it's us — the same
  // window-event bridge AgentList already uses for `glancer:focus`.
  useEffect(() => {
    const onRename = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id === agent.id) setEditing(true);
    };
    window.addEventListener('glancer:rename', onRename);
    return () => window.removeEventListener('glancer:rename', onRename);
  }, [agent.id]);

  const commit = (next: string) => {
    setEditing(false);
    postToHost({ type: 'rename', id: agent.id, name: next });
  };

  // After a keyboard-driven rename ends (Enter or Escape), hand focus back
  // to the panel's nav container so arrow-keys / another `r` work right
  // away. Deferred a tick so the rename input has fully unmounted first —
  // focusing synchronously would blur the still-mounted input and fire its
  // onBlur (a stray commit, and on Escape a save of the cancelled draft).
  const refocusNav = () => {
    setTimeout(() => {
      document.querySelector<HTMLElement>('[data-agent-list-nav]')?.focus();
    }, 0);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Webview HTML context menus are restricted; offer a simple inline switch.
    const action = window.prompt('Action? rename | reset | kill', 'rename');
    if (action === 'rename') setEditing(true);
    else if (action === 'reset') postToHost({ type: 'resetTitle', id: agent.id });
    else if (action === 'kill') onKill();
  };

  // Description-line precedence: error > attention > tldr. Whichever exists
  // and is highest-priority occupies the single description slot.
  const description =
    agent.errorReason ?? agent.attentionReason ?? agent.tldr ?? null;
  const descriptionTone =
    agent.errorReason ? 'danger'
      : agent.attentionReason ? 'warn'
        : 'muted';

  return (
    <div
      data-agent-id={agent.id}
      className={
        'agent-card' +
        (agent.kind === 'shell' ? ' kind-shell' : '') +
        (active ? ' active' : '') +
        (agent.starting ? ' starting' : '') +
        (dragging ? ' dragging' : '') +
        (dragOver ? ' drag-over' : '') +
        (agent.pinned ? ' pinned' : '') +
        ` status-${status}`
      }
      // Only draggable when not editing the rename input; otherwise the
      // text selection would start a drag.
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={editing ? undefined : onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
    >
      <StatusIcon
        status={status}
        title={agent.errorReason ?? agent.attentionReason ?? undefined}
      />

      <div className="agent-card-title">
        {editing ? (
          <input
            className="agent-name agent-name-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            // Pre-select the whole name so a keyboard rename (`r`) can be
            // typed straight over the top; click or arrow to edit in place.
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(draft);
                refocusNav();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                // Cancel: drop the draft back to the real name so a
                // re-open doesn't surface the abandoned text, then exit.
                setDraft(agent.name);
                setEditing(false);
                refocusNav();
              }
            }}
          />
        ) : (
          <>
            {agent.kind === 'shell' && (
              <span className="agent-shell-prefix" aria-hidden="true">{'>_'}</span>
            )}
            <span className="agent-name">{agent.name}</span>
            {isLocked && <span className="agent-title-lock" title="Manually set">●</span>}
            {agent.model !== 'default' && (
              <span className="agent-model-chip">{agent.model}</span>
            )}
          </>
        )}
      </div>

      <div className="reveal" data-open={description ? 'true' : 'false'}>
        <div className="reveal-inner">
          {description && (
            <div
              className={`agent-card-sub agent-tldr ${descriptionTone}`}
              title={description}
            >
              {description}
            </div>
          )}
        </div>
      </div>

      <div
        className="reveal"
        data-open={agent.progress && status !== 'done' ? 'true' : 'false'}
      >
        <div className="reveal-inner">
          {agent.progress && status !== 'done' && (
            // Render whenever progress data exists and the turn hasn't
            // finished cleanly. On a cleanly-done turn the green ✓ on
            // the left rail tells the user we're finished, so the bar
            // would be redundant. During streaming, error, or
            // needs-input states the bar still carries useful info.
            <div className="agent-progress-row">
              <div className="agent-progress-track">
                <div
                  className="agent-progress-fill"
                  style={{ width: `${Math.round(agent.progress.value * 100)}%` }}
                />
              </div>
              <ProgressLabel label={agent.progress.label} />
            </div>
          )}
        </div>
      </div>

      {/* Skill pill — bottom-right of the card, under the progress bar.
       *  Renders independently of progress visibility (the active-skill
       *  marker reflects what kind of work is happening, not step-by-
       *  step completion). Hidden while the agent is in the starting
       *  state to avoid overlapping the bottom-right starting indicator. */}
      <div
        className="reveal"
        data-open={agent.skill && !agent.starting ? 'true' : 'false'}
      >
        <div className="reveal-inner">
          {agent.skill && !agent.starting && (
            <div className="agent-skill-row">
              <span
                className="agent-skill-pill"
                title={`Skill: ${agent.skill}`}
              >
                {agent.skill}
              </span>
            </div>
          )}
        </div>
      </div>

      {agent.starting && (
        // Small bottom-right indicator while the PTY warms up. Persisted
        // card state (description / progress) stays visible above so a
        // revived dormant agent doesn't visually reset to its default
        // empty card during the few hundred ms before alt-screen flush.
        <div className="agent-starting-indicator" aria-label="Starting session">
          <span className="agent-starting-pulse" aria-hidden="true">
            <span /><span /><span />
          </span>
          <span className="agent-starting-label">starting…</span>
        </div>
      )}

      {agent.pinned ? (
        <button
          className="agent-kill pinned"
          title="Unpin"
          aria-label="Unpin session"
          onClick={(e) => {
            e.stopPropagation();
            postToHost({ type: 'togglePin', id: agent.id });
          }}
        >
          {/* Pin glyph — stroked, matches the X button's 12-unit viewBox
              so positioning and stroke weight align with the unpinned state. */}
          <svg
            viewBox="0 0 12 12"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 1.5 L8.5 4 L7.5 5 L4.5 5 L3.5 4 Z" />
            <line x1="6" y1="5" x2="6" y2="9.5" />
            <line x1="4" y1="9.5" x2="8" y2="9.5" />
          </svg>
        </button>
      ) : (
        <button
          className="agent-kill"
          title="Close session"
          aria-label="Close session"
          onClick={(e) => { e.stopPropagation(); onKill(); }}
        >
          <svg
            viewBox="0 0 12 12"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
          </svg>
        </button>
      )}
    </div>
  );
}
