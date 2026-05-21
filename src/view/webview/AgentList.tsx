import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentSnapshot, ClaudeModel } from '../../shared/messages';
import { postToHost } from './api';
import { AgentCard } from './AgentCard';
import { reconcileOrder } from './reconcileOrder';
import { contentRelativeTop } from './flipGeometry';

// Maximum gap between the two presses of any chord (`c c` for /clear,
// `p p` for pin/unpin). Matches the feel of similar two-key chords in
// other tools (e.g. tmux prefix sequences).
const CHORD_WINDOW_MS = 400;

// Reorder animation duration. FLIP technique: cards already moved to
// their new DOM positions before this kicks in; we apply an inverse
// transform synchronously in useLayoutEffect then transition it to
// identity over this window, giving the illusion of smooth movement.
const REORDER_ANIM_MS = 220;

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
  // The user-defined card order. Set on drag-drop, then kept across
  // add/remove churn by reconcileOrder (see the effect below). `null`
  // until the first drag — the prop-supplied order is used until then.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(agents.length);
  // Timestamps of the most recent unpaired chord keystrokes. A second
  // press of the same plain key within CHORD_WINDOW_MS fires the chord.
  // Reset by any keystroke that isn't a plain version of that key, so a
  // chord is always a clean two-keystroke sequence.
  const lastCRef = useRef<number | null>(null);
  const lastPRef = useRef<number | null>(null);
  // FLIP animation bookkeeping. `prevTopsRef` holds each card's
  // *content-relative* top (scroll-invariant — see flipGeometry) at the
  // previous commit, keyed by agent id. On every commit we re-measure,
  // compute deltas, apply inverse transforms, then transition to
  // identity — making cards slide between rows when the list reorders.
  // Content-relative (not viewport) coords are essential: arrow-key nav
  // fires a programmatic smooth-scroll, and viewport coords would make
  // that scroll look like a reorder, slamming transforms over the scroll
  // and visually destroying the list.
  const prevTopsRef = useRef<Map<string, number>>(new Map());

  // Reconcile the user-defined drag order against add/remove churn
  // instead of discarding it. Dropping it on any agent set change
  // snapped the whole list back to spawn order on every delete — the
  // user's expectation is that order only changes when they drag.
  // reconcileOrder keeps the dragged sequence, drops removed ids, and
  // appends newly-spawned ones at the end.
  useEffect(() => {
    setLocalOrder((prev) =>
      reconcileOrder(prev, agents.map((a) => a.id)),
    );
  }, [agents]);

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

  // FLIP reorder animation. Runs after every render synchronously
  // (useLayoutEffect → before paint). For each card whose top moved
  // since the previous commit, apply an inverse translateY so the card
  // visually starts at its old position, then transition transform back
  // to identity over REORDER_ANIM_MS — producing a smooth slide.
  // Mid-drag we skip the effect so the native drag preview isn't fought
  // over by our transforms.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || draggingId) return;
    const cards = list.querySelectorAll<HTMLElement>('[data-agent-id]');
    // Measure once against the scroll container so every card's stored
    // position is invariant to in-flight scrolling.
    const listTop = list.getBoundingClientRect().top;
    const scrollTop = list.scrollTop;
    const newTops = new Map<string, number>();
    for (const el of Array.from(cards)) {
      const id = el.dataset.agentId;
      if (id) {
        newTops.set(
          id,
          contentRelativeTop(
            el.getBoundingClientRect().top,
            listTop,
            scrollTop,
          ),
        );
      }
    }
    const prevTops = prevTopsRef.current;
    for (const el of Array.from(cards)) {
      const id = el.dataset.agentId;
      if (!id) continue;
      const prev = prevTops.get(id);
      const next = newTops.get(id);
      if (prev === undefined || next === undefined) continue;
      const deltaY = prev - next;
      if (Math.abs(deltaY) < 1) continue;
      // Snap to the old position with no transition…
      el.style.transition = 'none';
      el.style.transform = `translateY(${deltaY}px)`;
      // …force a synchronous reflow so the transition-none sticks…
      el.getBoundingClientRect();
      // …then animate back to identity.
      el.style.transition = `transform ${REORDER_ANIM_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1)`;
      el.style.transform = '';
      // Clear inline styles after the animation so future hover /
      // status transitions on the card aren't polluted by leftovers.
      el.addEventListener(
        'transitionend',
        function onEnd(ev) {
          if (ev.propertyName !== 'transform') return;
          el.style.transition = '';
          el.style.transform = '';
        },
        { once: true },
      );
    }
    prevTopsRef.current = newTops;
  });

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
    // Any keystroke that isn't a plain version of a chord key cancels
    // that key's pending chord — Cmd+C / Ctrl+C copy, navigation keys,
    // Shift+P typing, etc. Each chord tracks its own pending state.
    const isPlainC =
      e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const isPlainP =
      e.key === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (!isPlainC) lastCRef.current = null;
    if (!isPlainP) lastPRef.current = null;
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
    } else if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `t` spawns a plain shell terminal card — the sibling of `g`,
      // which spawns a Claude session.
      e.preventDefault();
      postToHost({ type: 'newTerminal' });
    } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Plain `f` toggles the bottom panel maximize state — handy for
      // pulling the active terminal full-screen and dropping back. The
      // guard `e.target !== e.currentTarget` at the top means this only
      // fires when the panel container itself owns focus (not when a
      // rename input or other child does), so it doesn't eat typed Fs.
      e.preventDefault();
      postToHost({ type: 'toggleMaximizedPanel' });
    } else if (isPlainP) {
      // `p p` chord — second `p` within CHORD_WINDOW_MS toggles the pin
      // on the active card. First `p` just arms the chord. Same shape
      // as `c c` for /clear so the two chords feel consistent.
      if (!activeId) return;
      e.preventDefault();
      const now = Date.now();
      const last = lastPRef.current;
      if (last !== null && now - last < CHORD_WINDOW_MS) {
        postToHost({ type: 'togglePin', id: activeId });
        lastPRef.current = null;
      } else {
        lastPRef.current = now;
      }
    } else if (isPlainC) {
      // `c c` chord — second `c` within CHORD_WINDOW_MS runs Claude's
      // `/clear` slash command in the active agent's terminal and pulls
      // focus into it. First `c` just arms the chord.
      if (!activeId) return;
      e.preventDefault();
      const now = Date.now();
      const last = lastCRef.current;
      if (last !== null && now - last < CHORD_WINDOW_MS) {
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
