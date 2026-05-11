export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';
export type TitleSource = 'default' | 'ai' | 'rename' | 'manual';

export interface AgentSnapshot {
  id: string;
  name: string;
  titleSource: TitleSource;
  model: ClaudeModel;
  tldr: string | null;
  attentionReason: string | null;
  errorReason: string | null;
  progress: { value: number; label: string } | null;
  streaming: boolean;
}

export type HostToWebview =
  | { type: 'state'; agents: AgentSnapshot[]; activeId: string | null }
  | { type: 'agentAdded'; agent: AgentSnapshot }
  | { type: 'agentRemoved'; id: string }
  | { type: 'agentUpdate'; id: string; fields: Partial<AgentSnapshot> }
  | { type: 'activeChanged'; id: string | null };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newAgent'; model?: ClaudeModel }
  | { type: 'select'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'resetTitle'; id: string };
