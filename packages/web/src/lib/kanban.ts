import { getProperty, type ViewDefinition, type ViewNote } from '@gmemo/core';
import type { ViewRows } from '../api/types';

/**
 * The note property a kanban card moves along, or null when the columns come
 * from something that is not a plain property ($folder, $tags…), or when this
 * card's value is a list: moving it would mean guessing which item to change.
 */
export function movableProperty(view: ViewDefinition, row?: ViewNote): string | null {
  const prop = view.groupBy ?? 'status';
  if (prop.startsWith('$')) return null;
  if (row && Array.isArray(getProperty(row, prop))) return null;
  return prop;
}

/**
 * The rows with one card moved to column `to` ('' = the "unset" column), as the
 * page shows them right away while the save goes out.
 */
export function moveCard(data: ViewRows, path: string, to: string, prop: string): ViewRows {
  const row = data.rows.find((r) => r.path === path);
  if (!row) return data;
  const properties = { ...row.properties };
  if (to === '') delete properties[prop];
  else properties[prop] = to;
  const moved: ViewNote = { ...row, properties };
  const rows = data.rows.map((r) => (r.path === path ? moved : r));
  if (!data.groups) return { ...data, rows };
  const groups = data.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.path !== path) }));
  let target = groups.find((g) => g.key === to);
  if (!target) {
    target = { key: to, rows: [] };
    groups.push(target);
  }
  target.rows.push(moved);
  return { ...data, rows, groups };
}
