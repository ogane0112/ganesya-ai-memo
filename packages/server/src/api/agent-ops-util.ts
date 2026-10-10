import type { Finding } from '@gmemo/core';

export { normalizeNotePath } from '@gmemo/core';

/** Short, value-free description of findings for error messages. */
export function publicFindingLabel(findings: Finding[]): string {
  return [...new Set(findings.map((f) => f.label))].join(', ');
}
