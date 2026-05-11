import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AgentSnapshot, HostToWebview } from '../../shared/messages';
import { AgentList } from './AgentList';
import { listenFromHost, postToHost } from './api';

function App() {
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

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
