import { type Choice, renderMerge } from '@gmemo/core';
import type { FileResolution, ProposalFile } from '../api/types';

/**
 * Conflict-resolution state for one proposal. "ours" is what is on main now
 * (いまの内容), "theirs" is the proposal (提案). Unlike the server, which
 * defaults unanswered blocks to "ours", the UI requires an explicit choice for
 * every conflict before merging.
 */
export type ResolutionState = Record<string, FileResolution>;

export type ResolutionAction =
  | { type: 'block'; path: string; index: number; choice: Choice }
  | { type: 'frontmatter'; path: string; key: string; choice: 'ours' | 'theirs' }
  | { type: 'file'; path: string; choice: 'keep' | 'delete' | 'theirs' }
  | { type: 'reject'; path: string; reject: boolean }
  | { type: 'all'; files: ProposalFile[]; choice: 'ours' | 'theirs' }
  | { type: 'reset' };

export function resolutionReducer(state: ResolutionState, a: ResolutionAction): ResolutionState {
  switch (a.type) {
    case 'block': {
      const cur = state[a.path] ?? {};
      return { ...state, [a.path]: { ...cur, blocks: { ...cur.blocks, [a.index]: a.choice } } };
    }
    case 'frontmatter': {
      const cur = state[a.path] ?? {};
      return {
        ...state,
        [a.path]: { ...cur, frontmatter: { ...cur.frontmatter, [a.key]: a.choice } },
      };
    }
    case 'file':
      return { ...state, [a.path]: { ...state[a.path], file: a.choice } };
    case 'reject': {
      const cur = { ...state[a.path] };
      if (a.reject) cur.reject = true;
      else delete cur.reject;
      return { ...state, [a.path]: cur };
    }
    case 'all': {
      let next = state;
      for (const f of a.files) {
        for (const c of conflictIndexes(f))
          next = resolutionReducer(next, {
            type: 'block',
            path: f.path,
            index: c,
            choice: a.choice,
          });
        for (const k of f.merge?.frontmatterConflicts ?? [])
          next = resolutionReducer(next, {
            type: 'frontmatter',
            path: f.path,
            key: k.key,
            choice: a.choice,
          });
        if (f.deleteConflict)
          next = resolutionReducer(next, {
            type: 'file',
            path: f.path,
            choice:
              a.choice === 'ours'
                ? f.current === null
                  ? 'delete'
                  : 'keep'
                : f.proposed === null
                  ? 'delete'
                  : 'keep',
          });
        else if (isBinaryClash(f))
          next = resolutionReducer(next, {
            type: 'file',
            path: f.path,
            choice: binaryFileChoice(a.choice),
          });
      }
      return next;
    }
    case 'reset':
      return {};
  }
}

export function conflictIndexes(f: ProposalFile): number[] {
  if (!f.merge || !f.mainChanged) return [];
  return f.merge.segments.flatMap((s) => (s.type === 'conflict' ? [s.index] : []));
}

/** Does this file need decisions from the user? */
export function needsDecision(f: ProposalFile): boolean {
  return (
    f.deleteConflict || (f.mainChanged && f.merge !== null && !f.merge.clean) || isBinaryClash(f)
  );
}

/**
 * For a binary clash the server reads `file: 'keep'` as "keep main's version"
 * and any other value as "take the proposal's version".
 */
export function binaryFileChoice(side: 'ours' | 'theirs'): 'keep' | 'theirs' {
  return side === 'ours' ? 'keep' : 'theirs';
}

/** A non-text file changed on both sides: keep main's or take the proposal's. */
export function isBinaryClash(f: ProposalFile): boolean {
  return f.mainChanged && f.merge === null && !f.deleteConflict && f.proposed !== null;
}

export interface Pending {
  path: string;
  blocks: number[];
  keys: string[];
  file: boolean;
}

/** Everything still undecided, per file. Empty array = ready to merge. */
export function unresolved(files: readonly ProposalFile[], state: ResolutionState): Pending[] {
  const out: Pending[] = [];
  for (const f of files) {
    const r = state[f.path] ?? {};
    if (r.reject) continue;
    const blocks = conflictIndexes(f).filter((i) => r.blocks?.[i] === undefined);
    const keys =
      f.mainChanged && f.merge
        ? f.merge.frontmatterConflicts
            .map((c) => c.key)
            .filter((k) => r.frontmatter?.[k] === undefined)
        : [];
    const file = (f.deleteConflict || isBinaryClash(f)) && !r.file;
    if (blocks.length || keys.length || file) out.push({ path: f.path, blocks, keys, file });
  }
  return out;
}

export function countUnresolved(files: readonly ProposalFile[], state: ResolutionState): number {
  return unresolved(files, state).reduce(
    (n, p) => n + p.blocks.length + p.keys.length + (p.file ? 1 : 0),
    0,
  );
}

/** Request body for POST /api/proposals/:id/merge (only files with decisions). */
export function toRequest(state: ResolutionState): Record<string, FileResolution> {
  const out: Record<string, FileResolution> = {};
  for (const [path, r] of Object.entries(state)) {
    const clean: FileResolution = {};
    if (r.reject) clean.reject = true;
    if (r.file) clean.file = r.file;
    if (r.blocks && Object.keys(r.blocks).length) clean.blocks = r.blocks;
    if (r.frontmatter && Object.keys(r.frontmatter).length) clean.frontmatter = r.frontmatter;
    if (Object.keys(clean).length) out[path] = clean;
  }
  return out;
}

/** Preview of the merged text with the current choices (undecided = いまの内容). */
export function previewMerged(f: ProposalFile, r: FileResolution | undefined): string | null {
  if (r?.reject) return f.current;
  if (!f.mainChanged) return f.proposed;
  if (!f.merge) {
    if (r?.file === 'theirs') return f.proposed;
    if (r?.file === 'delete') return null;
    return f.deleteConflict && r?.file === 'keep' ? (f.proposed ?? f.current) : f.current;
  }
  return renderMerge(f.merge, {
    ...(r?.blocks ? { blocks: r.blocks } : {}),
    ...(r?.frontmatter ? { frontmatter: r.frontmatter } : {}),
  });
}

export function choiceLabel(c: Choice | undefined): string {
  if (c === undefined) return '未選択';
  if (c === 'ours') return 'いまの内容';
  if (c === 'theirs') return '提案';
  if (c === 'both') return '両方';
  return '編集済み';
}
