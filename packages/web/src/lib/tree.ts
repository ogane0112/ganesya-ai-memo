import type { NoteSummary } from '../api/types';

export interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  notes: NoteSummary[];
}

/**
 * Build a folder tree from the flat note list (folders first, then notes, both
 * sorted). `folders` adds the ones created on their own, which may be empty.
 */
export function buildTree(
  notes: readonly NoteSummary[],
  folders: readonly string[] = [],
): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], notes: [] };
  const folderAt = (parts: string[]): TreeFolder => {
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
    return cur;
  };
  for (const f of folders) folderAt(f.split('/').filter(Boolean));
  for (const n of notes) folderAt(n.path.split('/').slice(0, -1)).notes.push(n);
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
