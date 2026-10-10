import { Link } from 'react-router-dom';
import type { NoteSummary } from '../api/types';
import { relativeTime } from '../lib/format';
import { noteUrl } from '../lib/paths';
import { Badge } from './ui';

/** One note in the notes list: title, author, folder, update time and tags. */
export function NoteCard({ note, unsynced = false }: { note: NoteSummary; unsynced?: boolean }) {
  const n = note;
  return (
    <Link to={noteUrl(n.path)} className="note-card">
      <span className="note-card-title">{n.title}</span>
      <span className="note-card-meta">
        {n.createdBy === 'ai' && <Badge tone="ai">AI{n.aiAgent ? `: ${n.aiAgent}` : ''}</Badge>}
        {unsynced && <Badge tone="accent">未同期</Badge>}
        <span className="mono ellipsis">
          {n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''}
        </span>
        {n.updatedAt && <time dateTime={n.updatedAt}>{relativeTime(n.updatedAt)}</time>}
      </span>
      {n.tags.length > 0 && (
        <span className="tags">
          {n.tags.slice(0, 5).map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
        </span>
      )}
    </Link>
  );
}
