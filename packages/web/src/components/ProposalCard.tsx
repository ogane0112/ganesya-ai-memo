import type { ProposalRow } from '../api/types';
import { relativeTime } from '../lib/format';
import { Icon } from './Icon';
import { Badge } from './ui';

export const SOURCE_LABEL: Record<string, string> = {
  device: '端末の編集',
  revert: '取り消し',
  agent: 'AIの提案',
  mcp: 'AIの提案',
  api: 'AIの提案',
};

/** Who proposed it, where it came from, and when. */
export function ProposalMeta({ p }: { p: ProposalRow }) {
  return (
    <span className="proposal-meta">
      {p.author_kind === 'ai' ? (
        <Badge tone="ai">
          <Icon name="bot" size={12} /> {p.author_name}
        </Badge>
      ) : (
        <Badge>{p.author_name}</Badge>
      )}
      {SOURCE_LABEL[p.source] && <span className="hint">{SOURCE_LABEL[p.source]}</span>}
      <time className="hint" dateTime={p.created_at}>
        {relativeTime(p.created_at)}
      </time>
    </span>
  );
}

/** Summary of a proposal in the review list. */
export function ProposalCard({ p }: { p: ProposalRow }) {
  return (
    <div className="proposal-card">
      <ProposalMeta p={p} />
      <h2 className="proposal-title">{p.title}</h2>
      {p.description && <p className="proposal-desc">{p.description}</p>}
    </div>
  );
}
