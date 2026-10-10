import { parse } from 'yaml';

/**
 * Database-style views over notes. A view is a YAML file (`.views/<id>.yaml`)
 * that filters/sorts notes by their typed frontmatter properties.
 */
export type ViewType = 'table' | 'kanban' | 'calendar' | 'list';

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface ViewFilter {
  /** Property name. Special: `$path`, `$title`, `$tags`, `$folder`. */
  property: string;
  op: FilterOp;
  value?: unknown;
}

export interface ViewSort {
  property: string;
  direction: 'asc' | 'desc';
}

export interface ViewDefinition {
  id: string;
  name: string;
  type: ViewType;
  /** Only notes under this folder (prefix). */
  folder?: string;
  /** Only notes carrying this tag. */
  tag?: string;
  filters: ViewFilter[];
  sort: ViewSort[];
  /** Columns for table view. */
  columns: string[];
  /** Property to group by (kanban). */
  groupBy?: string;
  /** Fixed column order for kanban. */
  groups?: string[];
  /** Property holding the date (calendar). */
  dateProperty?: string;
}

export interface ViewNote {
  path: string;
  title: string;
  tags: string[];
  properties: Record<string, unknown>;
}

const OPS: FilterOp[] = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'gt',
  'gte',
  'lt',
  'lte',
];
const TYPES: ViewType[] = ['table', 'kanban', 'calendar', 'list'];

export class ViewError extends Error {}

export function parseView(id: string, yamlText: string): ViewDefinition {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new ViewError(`invalid YAML: ${(e as Error).message}`);
  }
  return normalizeView(id, raw);
}

export function normalizeView(id: string, raw: unknown): ViewDefinition {
  if (!raw || typeof raw !== 'object') throw new ViewError('view must be a mapping');
  const r = raw as Record<string, unknown>;
  const type = (r['type'] ?? 'table') as ViewType;
  if (!TYPES.includes(type)) throw new ViewError(`unknown view type: ${String(type)}`);
  const filters: ViewFilter[] = [];
  for (const f of Array.isArray(r['filters']) ? r['filters'] : []) {
    if (!f || typeof f !== 'object') continue;
    const fr = f as Record<string, unknown>;
    const op = (fr['op'] ?? 'eq') as FilterOp;
    if (typeof fr['property'] !== 'string' || !OPS.includes(op))
      throw new ViewError('invalid filter');
    filters.push({ property: fr['property'], op, value: fr['value'] });
  }
  const sort: ViewSort[] = [];
  for (const s of Array.isArray(r['sort']) ? r['sort'] : []) {
    if (typeof s === 'string') sort.push({ property: s, direction: 'asc' });
    else if (
      s &&
      typeof s === 'object' &&
      typeof (s as Record<string, unknown>)['property'] === 'string'
    ) {
      const sr = s as Record<string, unknown>;
      sort.push({
        property: sr['property'] as string,
        direction: sr['direction'] === 'desc' ? 'desc' : 'asc',
      });
    }
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const view: ViewDefinition = {
    id,
    name: str(r['name']) ?? id,
    type,
    filters,
    sort,
    columns: Array.isArray(r['columns'])
      ? r['columns'].filter((c): c is string => typeof c === 'string')
      : ['$title'],
  };
  const folder = str(r['folder']);
  const tag = str(r['tag']);
  const groupBy = str(r['groupBy']);
  const dateProperty = str(r['dateProperty']);
  if (folder) view.folder = folder;
  if (tag) view.tag = tag.replace(/^#/, '').toLowerCase();
  if (groupBy) view.groupBy = groupBy;
  if (Array.isArray(r['groups'])) view.groups = r['groups'].map(String);
  if (dateProperty) view.dateProperty = dateProperty;
  if (type === 'kanban' && !view.groupBy) view.groupBy = 'status';
  if (type === 'calendar' && !view.dateProperty) view.dateProperty = 'date';
  return view;
}

export function getProperty(note: ViewNote, property: string): unknown {
  switch (property) {
    case '$path':
      return note.path;
    case '$title':
      return note.title;
    case '$tags':
      return note.tags;
    case '$folder':
      return note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
    default:
      return note.properties[property];
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'ja', { numeric: true });
}

function matches(note: ViewNote, f: ViewFilter): boolean {
  const v = getProperty(note, f.property);
  const exists = v !== undefined && v !== null && v !== '';
  switch (f.op) {
    case 'exists':
      return exists;
    case 'not_exists':
      return !exists;
    case 'eq':
      return Array.isArray(v)
        ? v.some((x) => String(x) === String(f.value))
        : String(v ?? '') === String(f.value ?? '');
    case 'neq':
      return Array.isArray(v)
        ? !v.some((x) => String(x) === String(f.value))
        : String(v ?? '') !== String(f.value ?? '');
    case 'contains':
    case 'not_contains': {
      const needle = String(f.value ?? '').toLowerCase();
      const hit = Array.isArray(v)
        ? v.some((x) => String(x).toLowerCase() === needle)
        : String(v ?? '')
            .toLowerCase()
            .includes(needle);
      return f.op === 'contains' ? hit : !hit;
    }
    case 'gt':
      return exists && compare(v, f.value) > 0;
    case 'gte':
      return exists && compare(v, f.value) >= 0;
    case 'lt':
      return exists && compare(v, f.value) < 0;
    case 'lte':
      return exists && compare(v, f.value) <= 0;
  }
}

export function applyView(view: ViewDefinition, notes: readonly ViewNote[]): ViewNote[] {
  const folder = view.folder ? view.folder.replace(/^\/+|\/+$/g, '') + '/' : undefined;
  const rows = notes.filter(
    (n) =>
      (!folder || n.path.startsWith(folder)) &&
      (!view.tag || n.tags.includes(view.tag)) &&
      view.filters.every((f) => matches(n, f)),
  );
  const sort = view.sort.length ? view.sort : [{ property: '$title', direction: 'asc' as const }];
  rows.sort((a, b) => {
    for (const s of sort) {
      const c = compare(getProperty(a, s.property), getProperty(b, s.property));
      if (c !== 0) return s.direction === 'desc' ? -c : c;
    }
    return 0;
  });
  return rows;
}

/** Group rows for kanban. Notes without a value go to the "" group. */
export function groupRows(
  view: ViewDefinition,
  rows: readonly ViewNote[],
): { key: string; rows: ViewNote[] }[] {
  const prop = view.groupBy ?? 'status';
  const groups = new Map<string, ViewNote[]>();
  for (const g of view.groups ?? []) groups.set(g, []);
  for (const r of rows) {
    const v = getProperty(r, prop);
    const key = v === undefined || v === null ? '' : String(Array.isArray(v) ? (v[0] ?? '') : v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return [...groups].map(([key, rs]) => ({ key, rows: rs }));
}
