import { useEffect, useState } from 'react';
import type { AgentSnapshot } from '../../shared/messages';
import { postToHost } from './api';

interface Props {
  agent: AgentSnapshot;
  active: boolean;
  onSelect: () => void;
  onKill: () => void;
}

function modelDetail(model: AgentSnapshot['model']): string {
  switch (model) {
    case 'opus': return 'most capable';
    case 'sonnet': return 'balanced';
    case 'haiku': return 'fastest';
    default: return '';
  }
}

export function AgentCard({ agent, active, onSelect, onKill }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const isLocked = agent.titleSource === 'manual' || agent.titleSource === 'rename';

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

  return (
    <div
      className={'agent-card' + (active ? ' active' : '')}
      onClick={editing ? undefined : onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
    >
      <div className="agent-card-row top">
        <div className="agent-name-wrap">
          {agent.streaming && <span className="agent-status-dot streaming" />}
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
            </>
          )}
        </div>
      </div>
      <div className="agent-card-row bottom">
        {agent.model !== 'default' && (
          <>
            <span className="agent-model-chip">{agent.model}</span>
            <span className="agent-model-detail">{modelDetail(agent.model)}</span>
          </>
        )}
        {agent.attentionReason !== null && (
          <span className="agent-flag warn" title={agent.attentionReason}>
            <span className="agent-flag-dot" />
            needs input
          </span>
        )}
        {agent.errorReason !== null && (
          <span className="agent-flag danger" title={agent.errorReason}>
            <span className="agent-flag-dot" />
            error
          </span>
        )}
      </div>
      {agent.progress !== null && (
        <div className="agent-progress-row">
          <div className="agent-progress-label">{agent.progress.label}</div>
          <div className="agent-progress-track">
            <div
              className="agent-progress-fill"
              style={{ width: `${Math.round(agent.progress.value * 100)}%` }}
            />
          </div>
        </div>
      )}
      {agent.tldr && agent.progress === null && (
        <div className="agent-tldr">
          <button
            className="agent-tts-btn"
            title={agent.tldr}
            onClick={(e) => {
              e.stopPropagation();
              try {
                const u = new SpeechSynthesisUtterance(agent.tldr ?? '');
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(u);
              } catch { /* ignore — TTS unavailable */ }
            }}
          >
            ▶
          </button>
          <span className="agent-tldr-text">{agent.tldr}</span>
        </div>
      )}
      <button
        className="agent-kill"
        title="Close session"
        onClick={(e) => { e.stopPropagation(); onKill(); }}
      >
        ×
      </button>
    </div>
  );
}
