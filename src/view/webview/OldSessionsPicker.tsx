import { useEffect, useMemo, useRef, useState } from 'react';
import type { OldSession } from '../../shared/messages';
import { postToHost } from './api';

interface Props {
  /**
   * Latest list of past sessions from the host. `null` means a fetch is
   * in-flight (or never started); the popover shows a loading row in
   * that case. Reset to `null` by the parent every time the popover
   * opens so a stale result from the previous open doesn't briefly
   * flash before the new fetch arrives.
   */
  sessions: OldSession[] | null;
  /** Parent flips this back to `null` when invoking `onOpen()` requests a fresh fetch. */
  onOpen: () => void;
}

/**
 * Build a human-friendly relative-time string for a file mtime.
 * Decision boundaries match common UX expectations:
 *   < 60s        → "just now"
 *   < 60min      → "Nm ago"
 *   < 24h        → "Nh ago"
 *   < 48h        → "yesterday"
 *   same year    → "Mon D"
 *   else         → "Mon D, YYYY"
 */
export function formatRelativeTime(mtimeMs: number, now = Date.now()): string {
  const diffMs = now - mtimeMs;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diffMs < min) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / min)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 2 * day) return 'yesterday';
  const d = new Date(mtimeMs);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day_ = d.getDate();
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return sameYear ? `${month} ${day_}` : `${month} ${day_}, ${d.getFullYear()}`;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function OldSessionsPicker({ sessions, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Filtered + highlight-bounded list. Recomputed cheaply on every render
  // — 68 items per workspace is the realistic upper bound, no need to
  // memoize beyond `useMemo` for the filter result.
  const filtered = useMemo(() => {
    if (!sessions) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return sessions;
    return sessions.filter((s) => {
      if (s.sessionId.toLowerCase().includes(f)) return true;
      if (s.firstPrompt && s.firstPrompt.toLowerCase().includes(f)) return true;
      return false;
    });
  }, [sessions, filter]);

  // Click-outside to close. Listens at the document level so any click
  // anywhere outside the picker collapses it.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Whenever the popover opens, reset filter + highlight and ask the
  // host for a fresh list. The parent clears `sessions` to null on
  // `onOpen()` so the loading row renders correctly.
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setFilter('');
    setHighlightIdx(0);
    onOpen();
    setOpen(true);
    // Focus the filter input after the popover paints.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const choose = (sessionId: string) => {
    setOpen(false);
    postToHost({ type: 'openOldSession', sessionId });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlightIdx];
      if (pick) choose(pick.sessionId);
    }
  };

  // Loading == sessions is null and popover open. The row is never
  // disabled — clicking it always re-fetches so a session created since
  // the last open shows up. The "no past sessions" message lives inside
  // the popover.
  const loading = open && sessions === null;

  return (
    <div className="old-sessions" ref={containerRef}>
      <button
        type="button"
        className={`old-sessions-row${open ? ' open' : ''}`}
        onClick={toggle}
      >
        <span className="old-sessions-row-label">Open old session</span>
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
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div className="old-sessions-popover" onKeyDown={onKeyDown}>
          <div className="old-sessions-filter">
            <input
              ref={inputRef}
              placeholder="filter…"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setHighlightIdx(0);
              }}
            />
          </div>
          <div className="old-sessions-list">
            {loading && (
              <div className="old-sessions-empty faint">loading sessions…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="old-sessions-empty faint">
                {sessions && sessions.length === 0 ? 'no past sessions' : 'no matches'}
              </div>
            )}
            {!loading &&
              filtered.map((s, i) => (
                <button
                  key={s.sessionId}
                  type="button"
                  className={`old-sessions-item${i === highlightIdx ? ' active' : ''}`}
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => choose(s.sessionId)}
                >
                  <span
                    className={`old-sessions-item-title${
                      s.name || s.firstPrompt ? '' : ' untitled'
                    }`}
                  >
                    {s.name ?? s.firstPrompt ?? 'untitled session'}
                  </span>
                  <span className="old-sessions-item-meta">
                    {shortId(s.sessionId)} · {formatRelativeTime(s.mtimeMs)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
