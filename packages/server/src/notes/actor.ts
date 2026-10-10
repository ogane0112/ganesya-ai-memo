import type { GitIdentity } from '../git/repo.js';

export interface HumanActor {
  kind: 'human';
  name: string;
}

export interface AgentActor {
  kind: 'ai';
  agentId: string;
  name: string;
}

export type Actor = HumanActor | AgentActor;

export const AGENT_EMAIL_DOMAIN = 'agents.gmemo.local';
export const HUMAN_EMAIL = 'human@gmemo.local';

export function gitIdentity(actor: Actor): GitIdentity {
  return actor.kind === 'human'
    ? { name: actor.name, email: HUMAN_EMAIL }
    : { name: actor.name, email: `${actor.agentId}@${AGENT_EMAIL_DOMAIN}` };
}

/** Classify a commit author. */
export function authorKindFromEmail(email: string): 'human' | 'ai' | 'system' {
  if (email.endsWith('@' + AGENT_EMAIL_DOMAIN)) return 'ai';
  if (email === 'system@gmemo.local') return 'system';
  return 'human';
}

export function agentIdFromEmail(email: string): string | null {
  return email.endsWith('@' + AGENT_EMAIL_DOMAIN)
    ? email.slice(0, -(AGENT_EMAIL_DOMAIN.length + 1))
    : null;
}
