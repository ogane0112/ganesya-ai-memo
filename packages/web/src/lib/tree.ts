import type { NoteSummary } from '../api/types';

export interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  notes: NoteSummary[];
}

/** Build a folder tree from the flat note list (folders first, then notes, both sorted). */
export function buildTree(notes: readonly NoteSummary[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], notes: [] };
  for (const n of notes) {
    const parts = n.path.split('/');
    parts.pop();
    let cur = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let next = cur.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path: acc, folders: [], notes: [] };
        cur.folders.push(next);
      }
      cur = next;
    }
    cur.notes.push(n);
  }
  const sort = (f: TreeFolder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    f.notes.sort((a, b) => a.title.localeCompare(b.title, 'ja', { numeric: true }));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function countNotes(f: TreeFolder): number {
  return f.notes.length + f.folders.reduce((n, c) => n + countNotes(c), 0);
}
