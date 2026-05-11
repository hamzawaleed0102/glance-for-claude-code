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

  const commit = (next: string) => {
    setEditing(false);
    postToHost({ type: 'rename', id: agent.id, name: next });
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
      className={
        'agent-card' +
        (active ? ' active' : '') +
        (agent.starting ? ' starting' : '') +
        (dragging ? ' dragging' : '') +
        (dragOver ? ' drag-over' : '') +
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
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
          />
        ) : (
          <>
            <span className="agent-name">{agent.name}</span>
            {isLocked && <span className="agent-title-lock" title="Manually set">●</span>}
            {agent.model !== 'default' && (
              <span className="agent-model-chip">{agent.model}</span>
            )}
          </>
        )}
      </div>

      {agent.starting ? (
        <div className="agent-card-sub agent-starting-row">
          <span className="agent-starting-pulse" aria-hidden="true">
            <span /><span /><span />
          </span>
          <span className="agent-starting-label">starting session…</span>
        </div>
      ) : (
        <>
          {description && (
            <div
              className={`agent-card-sub agent-tldr ${descriptionTone}`}
              title={description}
            >
              {description}
            </div>
          )}
          {agent.progress && status === 'streaming' && (
            // Only render while actively streaming. Once the turn ends
            // (status flips to 'done'), the green ✓ on the left rail tells
            // the user we're finished — the bar becomes redundant. It
            // reappears on the next UserPromptSubmit when streaming flips
            // back on.
            <div className="agent-progress-row">
              <div className="agent-progress-track">
                <div
                  className="agent-progress-fill"
                  style={{ width: `${Math.round(agent.progress.value * 100)}%` }}
                />
              </div>
              <div className="agent-progress-label">{agent.progress.label}</div>
            </div>
          )}
        </>
      )}

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
    </div>
  );
}
