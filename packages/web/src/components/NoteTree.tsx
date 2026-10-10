import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { NoteSummary } from '../api/types';
import { noteUrl } from '../lib/paths';
import { buildTree, countNotes, type TreeFolder } from '../lib/tree';
import { Icon } from './Icon';

const OPEN_KEY = 'gmemo.treeOpen';

function loadOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function NoteTree({ notes, onNavigate }: { notes: NoteSummary[]; onNavigate?: () => void }) {
  const tree = useMemo(() => buildTree(notes), [notes]);
  const [open, setOpen] = useState<Set<string>>(loadOpen);
  const loc = useLocation();

  // Expand the folders of the note being viewed.
  useEffect(() => {
    if (!loc.pathname.startsWith('/n/')) return;
    const path = decodeURIComponent(loc.pathname.slice(3));
    const parts = path.split('/');
    parts.pop();
    if (!parts.length) return;
    setOpen((prev) => {
      const next = new Set(prev);
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        next.add(acc);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [loc.pathname]);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    } catch {
      /* ignore */
    }
  }, [open]);

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const renderFolder = (f: TreeFolder, depth: number) => (
    <ul
      className="tree"
      role={depth === 0 ? 'tree' : 'group'}
      aria-label={depth === 0 ? 'ノート一覧' : undefined}
    >
      {f.folders.map((sub) => {
        const isOpen = open.has(sub.path);
        return (
          <li key={sub.path} role="treeitem" aria-expanded={isOpen}>
            <button
              type="button"
              className="tree-folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggle(sub.path)}
            >
              <Icon name={isOpen ? 'down' : 'chevron'} size={14} />
              <Icon name="folder" size={16} />
              <span className="tree-label">{sub.name}</span>
              <span className="tree-count">{countNotes(sub)}</span>
            </button>
            {isOpen && renderFolder(sub, depth + 1)}
          </li>
        );
      })}
      {f.notes.map((n) => (
        <li key={n.path} role="treeitem">
          <NavLink
            to={noteUrl(n.path)}
            className="tree-note"
            style={{ paddingLeft: 8 + depth * 14 + 18 }}
            onClick={onNavigate}
            title={n.path}
          >
            <span className={n.createdBy === 'ai' ? 'dot dot-ai' : 'dot'} aria-hidden="true" />
            <span className="tree-label">{n.title}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );

  return renderFolder(tree, 0);
}
