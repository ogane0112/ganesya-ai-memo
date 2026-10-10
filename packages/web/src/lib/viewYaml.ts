import {
  parseView,
  type ViewDefinition,
  type ViewFilter,
  type ViewSort,
  type ViewType,
} from '@gmemo/core';
import { stringify } from 'yaml';

/** Editable form model of a view (strings for the free-text inputs). */
export interface ViewForm {
  name: string;
  type: ViewType;
  folder: string;
  tag: string;
  filters: ViewFilter[];
  sort: ViewSort[];
  columns: string;
  groupBy: string;
  groups: string;
  dateProperty: string;
}

export const emptyViewForm = (): ViewForm => ({
  name: '',
  type: 'table',
  folder: '',
  tag: '',
  filters: [],
  sort: [],
  columns: '$title',
  groupBy: 'status',
  groups: '',
  dateProperty: 'date',
});

const list = (s: string) =>
  s
    .split(/[,、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function formFromView(v: ViewDefinition): ViewForm {
  return {
    name: v.name,
    type: v.type,
    folder: v.folder ?? '',
    tag: v.tag ?? '',
    filters: v.filters.map((f) => ({ ...f })),
    sort: v.sort.map((s) => ({ ...s })),
    columns: v.columns.join(', '),
    groupBy: v.groupBy ?? 'status',
    groups: (v.groups ?? []).join(', '),
    dateProperty: v.dateProperty ?? 'date',
  };
}

/** Coerce filter values typed into a text box: numbers and booleans become typed. */
function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Serialize the form as the YAML stored in `.views/<id>.yaml`. */
export function formToYaml(f: ViewForm): string {
  const out: Record<string, unknown> = { name: f.name.trim() || undefined, type: f.type };
  if (f.folder.trim()) out['folder'] = f.folder.trim();
  if (f.tag.trim()) out['tag'] = f.tag.trim().replace(/^#/, '');
  const filters = f.filters
    .filter((x) => x.property.trim())
    .map((x) => {
      const o: Record<string, unknown> = { property: x.property.trim(), op: x.op };
      if (x.op !== 'exists' && x.op !== 'not_exists') o['value'] = coerce(x.value ?? '');
      return o;
    });
  if (filters.length) out['filters'] = filters;
  const sort = f.sort
    .filter((s) => s.property.trim())
    .map((s) => ({ property: s.property.trim(), direction: s.direction }));
  if (sort.length) out['sort'] = sort;
  const cols = list(f.columns);
  if (cols.length) out['columns'] = cols;
  if (f.type === 'kanban') {
    if (f.groupBy.trim()) out['groupBy'] = f.groupBy.trim();
    const g = list(f.groups);
    if (g.length) out['groups'] = g;
  }
  if (f.type === 'calendar' && f.dateProperty.trim()) out['dateProperty'] = f.dateProperty.trim();
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return stringify(out);
}

/** Parse YAML back into the form; throws ViewError on invalid input. */
export function yamlToForm(id: string, yaml: string): ViewForm {
  return formFromView(parseView(id, yaml));
}

export const VIEW_TYPES: { value: ViewType; label: string }[] = [
  { value: 'table', label: '表' },
  { value: 'kanban', label: 'カンバン' },
  { value: 'calendar', label: 'カレンダー' },
  { value: 'list', label: 'リスト' },
];

export const FILTER_OPS: { value: ViewFilter['op']; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'contains', label: '含む' },
  { value: 'not_contains', label: '含まない' },
  { value: 'exists', label: '値あり' },
  { value: 'not_exists', label: '値なし' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
];

export function propertyLabel(p: string): string {
  return { $title: 'タイトル', $path: 'パス', $tags: 'タグ', $folder: 'フォルダ' }[p] ?? p;
}
