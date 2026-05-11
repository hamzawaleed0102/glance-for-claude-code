import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AgentSnapshot, HostToWebview } from '../../shared/messages';
import { AgentList } from './AgentList';
import { listenFromHost, postToHost } from './api';

// Lazily-created shared AudioContext — re-used across tones so we don't
// leak audio contexts or hit per-document limits. Some browsers gate
// audio behind a user gesture; the user opening Glancer + their first
// prompt submit counts.
let audioCtx: AudioContext | null = null;
function playAttentionTone() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    // Minimal single-note beep: A5 sine, ~90ms total with quick attack
    // and exponential decay. Soft so it's not jarring across many turns.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  } catch {
    // Audio unavailable / autoplay blocked — VS Code toast still surfaces.
  }
}

function App() {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

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
      window.dispatchEvent(new Event('glancer:focus'));
      postToHost({ type: 'panelFocus', focused: true });
    };
    const onBlur = () => postToHost({ type: 'panelFocus', focused: false });
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
          setAgents((prev) =>
            prev.map((a) => (a.id === m.id ? { ...a, ...m.fields } : a)),
          );
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
        case 'playTone':
          playAttentionTone();
          break;
      }
    });
    postToHost({ type: 'ready' });
    return off;
  }, []);

  return (
    <AgentList
      agents={agents}
      activeId={activeId}
      onSelect={(id) => postToHost({ type: 'select', id })}
      onKill={(id) => postToHost({ type: 'kill', id })}
    />
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
