import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AgentSnapshot, HostToWebview, OldSession } from '../../shared/messages';
import { AgentList } from './AgentList';
import { OldSessionsPicker } from './OldSessionsPicker';
import { listenFromHost, postToHost } from './api';

// The turn-complete sound. The audio file (mixkit-correct-answer-tone)
// ships in the extension bundle at out/webview/; the host resolves its
// webview URI and bakes it into the <audio id="completion-sound">
// element in index.html. Here we just rewind it and play.
function playAttentionTone() {
  try {
    const el = document.getElementById(
      'completion-sound',
    ) as HTMLAudioElement | null;
    if (!el) return;
    el.volume = 0.5;
    el.currentTime = 0;
    // play() *rejects* (it does not throw) when autoplay is blocked, so
    // the surrounding try/catch can't see it — swallow the rejection so
    // it never surfaces as an unhandled promise. The VS Code toast still
    // tells the user the turn finished.
    void el.play().catch(() => {});
  } catch {
    // Audio element missing / unavailable — VS Code toast still surfaces.
  }
}

function App() {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [oldSessions, setOldSessions] = useState<OldSession[] | null>(null);
  // Whether keyboard focus is currently inside the panel iframe. Drives
  // the active card's two looks: focused → "selected" (you're navigating
  // the panel), blurred → "terminal-focused" (you pressed Enter and
  // dropped into the session's terminal). Seeded from document.hasFocus()
  // so the first render is right even when Glance auto-spawned straight
  // into a terminal and the panel never held focus.
  const [panelFocused, setPanelFocused] = useState(() => document.hasFocus());

  // Dispatch `glancer:focus` whenever the webview iframe gains focus. VS
  // Code's built-in `glancer.agents.focus` command routes focus to the
  // iframe but stops there — the keyboard event target is whatever last had
  // focus inside (document.body by default), not our React container with
  // tabIndex=-1. AgentList listens for `glancer:focus` and pulls focus to
  // its container so Up/Down/Enter/G handlers actually receive keydown.
  //
  // Same focus/blur edges drive `panelFocus` messages to the host so it
  // can suppress turn-complete toasts when the user is already watching.
  useEffect(() => {
    const onFocus = () => {
      setPanelFocused(true);
      window.dispatchEvent(new Event('glancer:focus'));
      postToHost({ type: 'panelFocus', focused: true });
    };
    const onBlur = () => {
      setPanelFocused(false);
      postToHost({ type: 'panelFocus', focused: false });
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    if (document.hasFocus()) {
      setTimeout(onFocus, 0);
    }
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const off = listenFromHost((m: HostToWebview) => {
      switch (m.type) {
        case 'state':
          setAgents(m.agents);
          setActiveId(m.activeId);
          break;
        case 'agentAdded':
          setAgents((prev) => [...prev, m.agent]);
          break;
        case 'agentRemoved':
          setAgents((prev) => prev.filter((a) => a.id !== m.id));
          break;
        case 'agentUpdate':
          setAgents((prev) => {
            const next = prev.map((a) =>
              a.id === m.id ? { ...a, ...m.fields } : a,
            );
            // When the pinned flag flips, re-anchor the agent at the
            // bottom of its new partition so the render-time stable
            // sort preserves FIFO-by-pin-time. Without this, a card
            // pinned second-or-later lands above earlier pins because
            // the stable sort keeps the array's pre-pin (spawn) order
            // within the pinned bucket.
            if ('pinned' in m.fields) {
              const idx = next.findIndex((a) => a.id === m.id);
              if (idx >= 0) {
                const [moved] = next.splice(idx, 1);
                if (moved.pinned) {
                  const firstUnpinned = next.findIndex((a) => !a.pinned);
                  const insertAt =
                    firstUnpinned < 0 ? next.length : firstUnpinned;
                  next.splice(insertAt, 0, moved);
                } else {
                  next.push(moved);
                }
              }
            }
            return next;
          });
          break;
        case 'activeChanged':
          setActiveId(m.id);
          break;
        case 'focus':
          // Host asked us to grab keyboard focus (Cmd+Shift+G). AgentList
          // listens for this window event and focuses its container so
          // Up/Down/Enter/G are handled by the React keydown handler.
          window.dispatchEvent(new Event('glancer:focus'));
          break;
        case 'oldSessions':
          setOldSessions(m.sessions);
          break;
        case 'playTone':
          playAttentionTone();
          break;
      }
    });
    postToHost({ type: 'ready' });
    return off;
  }, []);

  return (
    <>
      <OldSessionsPicker
        sessions={oldSessions}
        onOpen={() => {
          // Wipe the previous list so the loading row shows while the
          // host scans — guarantees stale results from an earlier open
          // never flash on screen.
          setOldSessions(null);
          postToHost({ type: 'listOldSessions' });
        }}
      />
      <AgentList
        agents={agents}
        activeId={activeId}
        panelFocused={panelFocused}
        onSelect={(id) => postToHost({ type: 'select', id })}
        onKill={(id) => postToHost({ type: 'kill', id })}
      />
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
