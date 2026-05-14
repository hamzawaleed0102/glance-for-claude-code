import { useEffect, useRef, useState } from 'react';
import type { AgentSnapshot, ClaudeModel } from '../../shared/messages';
import { postToHost } from './api';
import { AgentCard } from './AgentCard';

// Maximum gap between the two `c` presses of the `c c` chord that runs
// `/clear` in the active agent's terminal. Matches the feel of similar
// two-key chords in other tools (e.g. tmux prefix sequences).
const CC_CHORD_WINDOW_MS = 400;

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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Local optimistic copy of the agent order. We update this immediately
  // on drop for a snappy UX; the host then re-persists. Falls back to
  // the prop-supplied order whenever the prop length/contents change
  // (agents added/removed).
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(agents.length);
  // Timestamp of the most recent unpaired `c` keystroke. A second `c`
  // within CC_CHORD_WINDOW_MS fires the `/clear` chord. Reset by any
  // non-plain-`c` key (modifier'd `c` included) so the chord is always
  // a clean two-keystroke sequence.
  const lastCRef = useRef<number | null>(null);

  // Drop the local order if it ever diverges from the actual agent set
  // (e.g. an agent was added or removed). The host's order is canonical
  // after that point.
  useEffect(() => {
    if (!localOrder) return;
    const propsIds = new Set(agents.map((a) => a.id));
    const localIds = new Set(localOrder);
    if (propsIds.size !== localIds.size) { setLocalOrder(null); return; }
    for (const id of propsIds) if (!localIds.has(id)) { setLocalOrder(null); return; }
  }, [agents, localOrder]);

  // Apply the local order if active; otherwise use the props' order.
  // Then enforce pinned-first as a stable sort on top — mirrors the
  // host's invariant so toggling pin updates the order even while
  // localOrder (drag optimism) is still held. Stable sort means
  // within-section order from the chosen base is preserved.
  const baseOrder = localOrder
    ? localOrder
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is AgentSnapshot => !!a)
    : agents;
  const orderedAgents = [...baseOrder].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned),
  );

  const lc = filter.toLowerCase();
  const filtered = filter
    ? orderedAgents.filter((a) => a.name.toLowerCase().includes(lc) || a.id.toLowerCase().includes(lc))
    : orderedAgents;

  // Snap the list to the bottom when the agent count grows so a newly-
  // spawned card is immediately visible — without this, a long panel
  // adds the card off-screen and the user has to scroll to find it.
  // Tracks count only (not identity); shrinks/reorders don't scroll.
  useEffect(() => {
    if (agents.length > prevCountRef.current) {
      const el = listRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    prevCountRef.current = agents.length;
  }, [agents.length]);

  // Keep the active card in view as the user arrow-navigates. `block:
  // 'nearest'` is a no-op when the card is already visible, so clicks
  // on a visible card don't trigger any movement; only navigation that
  // crosses the viewport edge scrolls.
  useEffect(() => {
    if (!activeId) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-agent-id="${activeId}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  useEffect(() => {
    const onFocus = () => {
      containerRef.current?.focus();
      // If nothing's selected yet (or the previously-active agent was
      // removed), anchor on the first visible card. Without this the user
      // has to press Down once before any card highlights — a wasted
      // keystroke when they just pressed Cmd+Shift+G to start navigating.
      const stillActive =
        activeId !== null && filtered.some((a) => a.id === activeId);
      if (!stillActive && filtered.length > 0) {
        onSelect(filtered[0].id);
      }
    };
    window.addEventListener('glancer:focus', onFocus);
    return () => window.removeEventListener('glancer:focus', onFocus);
  }, [activeId, filtered, onSelect]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    // Any keystroke that isn't a plain `c` cancels a pending chord —
    // includes Cmd+C / Ctrl+C copy, navigation keys, etc.
    const isPlainC =
      e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (!isPlainC) lastCRef.current = null;
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
      // Enter on a focused card hands keyboard focus to the agent's
      // terminal. The host's `focusTerminal` path uses `show(false)` —
      // focus-stealing, unlike `select` which preserves panel focus.
      if (!activeId) return;
      e.preventDefault();
      postToHost({ type: 'focusTerminal', id: activeId });
    } else if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `g` spawns a new agent (the second half of the Cmd+Shift+G,G
      // chord — first press focuses the panel, second `g` opens a session).
      e.preventDefault();
      postToHost({ type: 'newAgent' });
    } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `f` toggles the bottom panel maximize state — handy for
      // pulling the active terminal full-screen and dropping back. The
      // guard `e.target !== e.currentTarget` at the top means this only
      // fires when the panel container itself owns focus (not when a
      // rename input or other child does), so it doesn't eat typed Fs.
      e.preventDefault();
      postToHost({ type: 'toggleMaximizedPanel' });
    } else if (e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // Plain `p` toggles the pin on the active card. The
      // `e.target !== e.currentTarget` guard at the top of onKeyDown
      // already prevents this firing while the rename input owns focus,
      // so typing `p` in the rename box doesn't trigger.
      if (!activeId) return;
      e.preventDefault();
      postToHost({ type: 'togglePin', id: activeId });
    } else if (isPlainC) {
      // `c c` chord — second `c` within CC_CHORD_WINDOW_MS runs Claude's
      // `/clear` slash command in the active agent's terminal and pulls
      // focus into it. First `c` just arms the chord.
      if (!activeId) return;
      e.preventDefault();
      const now = Date.now();
      const last = lastCRef.current;
      if (last !== null && now - last < CC_CHORD_WINDOW_MS) {
        postToHost({ type: 'clearActive' });
        lastCRef.current = null;
      } else {
        lastCRef.current = now;
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      containerRef.current?.blur();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
      if (!activeId) return;
      e.preventDefault();
      onKill(activeId);
    }
  };

  // ---- Drag-and-drop reordering ----
  const onCardDragStart = (id: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    // setData is required for Firefox compatibility even if we don't use it.
    e.dataTransfer.setData('text/plain', id);
    setDraggingId(id);
  };
  const onCardDragOver = (id: string) => (e: React.DragEvent) => {
    if (!draggingId || draggingId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) setDragOverId(id);
  };
  const onCardDragLeave = () => {
    // Don't clear dragOverId here — dragLeave fires when crossing into
    // nested children too, causing flicker. The next dragOver will fix it.
  };
  const onCardDrop = (targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const sourceId = draggingId ?? e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    // Compute new order. Drop position: insert source at target's index
    // (pushing target and subsequent items down).
    const currentIds = orderedAgents.map((a) => a.id);
    const sourceIdx = currentIds.indexOf(sourceId);
    const targetIdx = currentIds.indexOf(targetId);
    if (sourceIdx < 0 || targetIdx < 0) return;
    currentIds.splice(sourceIdx, 1);
    // After removal, target index shifts if source was before it.
    const adjusted = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    currentIds.splice(adjusted, 0, sourceId);
    setLocalOrder(currentIds);
    postToHost({ type: 'reorder', ids: currentIds });
  };
  const onCardDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  // After any mouse interaction inside the panel, snap focus back to the
  // navigation container so subsequent Up/Down/Enter/G keys flow through
  // onKeyDown (which guards on target === currentTarget). Without this,
  // clicking a card leaves focus on the card and breaks chained keyboard
  // nav. We use onMouseUp because onClick fires after focus has already
  // moved; refocusing in mouseup gets us back in time for the next keydown.
  const refocusContainer = () => {
    // Don't yank focus out of the rename input.
    if (document.activeElement?.tagName === 'INPUT') return;
    containerRef.current?.focus();
  };

  return (
    <div
      className="panel agent-panel"
      ref={containerRef}
      tabIndex={-1}
      data-agent-list-nav
      onKeyDown={onKeyDown}
      onMouseUp={refocusContainer}
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
      <div className="agent-list" ref={listRef}>
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
            dragging={draggingId === a.id}
            dragOver={dragOverId === a.id && draggingId !== null && draggingId !== a.id}
            onDragStart={onCardDragStart(a.id)}
            onDragOver={onCardDragOver(a.id)}
            onDragLeave={onCardDragLeave}
            onDrop={onCardDrop(a.id)}
            onDragEnd={onCardDragEnd}
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
          className={`new-agent-btn-chevron${pickerOpen ? ' open' : ''}`}
          onClick={() => setPickerOpen((p) => !p)}
          title="Pick model"
          aria-label="Pick model"
          aria-expanded={pickerOpen}
        >
          <svg
            className="chev"
            viewBox="0 0 12 12"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 7.5 6 4.5 9 7.5" />
          </svg>
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
