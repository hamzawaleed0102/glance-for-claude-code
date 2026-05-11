import { useEffect, useRef, useState } from 'react';
import type { AgentSnapshot, ClaudeModel } from '../../shared/messages';
import { postToHost } from './api';
import { AgentCard } from './AgentCard';

interface Props {
  agents: AgentSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onKill: (id: string) => void;
}

const MODELS: { id: ClaudeModel; label: string; detail: string }[] = [
  { id: 'default', label: 'Default', detail: 'auto' },
  { id: 'opus', label: 'Opus', detail: 'most capable' },
  { id: 'sonnet', label: 'Sonnet', detail: 'balanced' },
  { id: 'haiku', label: 'Haiku', detail: 'fastest' },
];

export function AgentList({ agents, activeId, onSelect, onKill }: Props) {
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lc = filter.toLowerCase();
  const filtered = filter
    ? agents.filter((a) => a.name.toLowerCase().includes(lc) || a.id.toLowerCase().includes(lc))
    : agents;

  useEffect(() => {
    const onFocus = () => containerRef.current?.focus();
    window.addEventListener('glancer:focus', onFocus);
    return () => window.removeEventListener('glancer:focus', onFocus);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (filtered.length === 0) return;
      e.preventDefault();
      const ids = filtered.map((a) => a.id);
      const i = activeId ? ids.indexOf(activeId) : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const len = ids.length;
      const next = i < 0 ? (step > 0 ? 0 : len - 1) : (i + step + len) % len;
      onSelect(ids[next]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      containerRef.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      containerRef.current?.blur();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
      if (!activeId) return;
      e.preventDefault();
      onKill(activeId);
    }
  };

  return (
    <div
      className="panel agent-panel"
      ref={containerRef}
      tabIndex={-1}
      data-agent-list-nav
      onKeyDown={onKeyDown}
    >
      <div className="panel-header">
        <div className="panel-header-left">
          <span>Agents</span>
          <span className="panel-header-count">[{String(agents.length).padStart(2, '0')}]</span>
        </div>
        <div className="panel-actions">
          <button className="icon-btn" title="Filter" onClick={() => setFilterOpen((p) => !p)}>⌕</button>
          <button className="icon-btn" title="New session" onClick={() => postToHost({ type: 'newAgent' })}>+</button>
        </div>
      </div>
      {filterOpen && (
        <div className="tree-search">
          <input
            placeholder="filter sessions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
        </div>
      )}
      <div className="agent-list">
        {agents.length === 0 && (
          <div className="agent-empty">
            <span className="faint">no sessions yet</span>
            <span className="faint" style={{ fontSize: 11, marginTop: 6 }}>click + to start</span>
          </div>
        )}
        {filtered.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            active={a.id === activeId}
            onSelect={() => onSelect(a.id)}
            onKill={() => onKill(a.id)}
          />
        ))}
      </div>
      <div className="new-agent-btn">
        <button
          className="new-agent-btn-main"
          onClick={() => postToHost({ type: 'newAgent' })}
        >
          + New Session
        </button>
        <button
          className="new-agent-btn-chevron"
          onClick={() => setPickerOpen((p) => !p)}
          title="Pick model"
        >
          ⌄
        </button>
        {pickerOpen && (
          <div className="model-picker">
            {MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setPickerOpen(false);
                  postToHost({ type: 'newAgent', model: m.id });
                }}
              >
                {m.label} · {m.detail}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
