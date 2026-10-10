import type { Frontmatter } from './frontmatter.js';

/** Where a note's content may be sent for AI processing. Ordered from most to least restrictive. */
export type AiAccess = 'none' | 'local' | 'external';

export type SensitiveMode = 'warn' | 'mask' | 'block';

export interface WorkspacePolicy {
  ai: {
    /** Workspace default. */
    default: AiAccess;
    /** Folder prefix → access. The longest matching prefix wins. */
    folders: Record<string, AiAccess>;
  };
  sensitive: {
    /** What to do when a finding is about to leave the machine. */
    mode: SensitiveMode;
    dictionary: string[];
    /** Fingerprints marked as "not a problem". */
    allow: string[];
    disabledRules: string[];
    /** Use the local LLM as an additional named-entity detector. */
    useLocalModel: boolean;
  };
  /** Has the user acknowledged the external-AI notice? */
  externalAcknowledged: boolean;
}

export const DEFAULT_POLICY: WorkspacePolicy = {
  ai: { default: 'local', folders: {} },
  sensitive: { mode: 'mask', dictionary: [], allow: [], disabledRules: [], useLocalModel: false },
  externalAcknowledged: false,
};

const ORDER: Record<AiAccess, number> = { none: 0, local: 1, external: 2 };

export function minAccess(a: AiAccess, b: AiAccess): AiAccess {
  return ORDER[a] <= ORDER[b] ? a : b;
}

export function isAiAccess(v: unknown): v is AiAccess {
  return v === 'none' || v === 'local' || v === 'external';
}

/**
 * Effective AI access for a note: folder policy, narrowed by the note's own
 * frontmatter. `sensitivity: secret` always forces local-only (or stricter).
 */
export function effectiveAccess(
  policy: WorkspacePolicy,
  path: string,
  frontmatter: Frontmatter = {},
): AiAccess {
  let access = policy.ai.default;
  let bestLen = -1;
  for (const [prefix, a] of Object.entries(policy.ai.folders)) {
    const p = prefix.replace(/^\/+/, '');
    const norm = p === '' || p.endsWith('/') ? p : p + '/';
    if ((norm === '' || path.startsWith(norm)) && norm.length > bestLen) {
      bestLen = norm.length;
      access = a;
    }
  }
  if (frontmatter['sensitivity'] === 'secret') access = minAccess(access, 'local');
  const noteAi = frontmatter['ai'];
  if (isAiAccess(noteAi)) access = minAccess(access, noteAi);
  return access;
}

/** Merge a partial (user-edited) policy over the defaults, dropping unknown values. */
export function normalizePolicy(input: unknown): WorkspacePolicy {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<Record<string, unknown>>;
  const ai = (p['ai'] && typeof p['ai'] === 'object' ? p['ai'] : {}) as Record<string, unknown>;
  const s = (p['sensitive'] && typeof p['sensitive'] === 'object' ? p['sensitive'] : {}) as Record<
    string,
    unknown
  >;
  const folders: Record<string, AiAccess> = {};
  if (ai['folders'] && typeof ai['folders'] === 'object') {
    for (const [k, v] of Object.entries(ai['folders'] as Record<string, unknown>))
      if (isAiAccess(v)) folders[k] = v;
  }
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const mode = s['mode'];
  return {
    ai: { default: isAiAccess(ai['default']) ? ai['default'] : DEFAULT_POLICY.ai.default, folders },
    sensitive: {
      mode:
        mode === 'warn' || mode === 'mask' || mode === 'block'
          ? mode
          : DEFAULT_POLICY.sensitive.mode,
      dictionary: strings(s['dictionary']),
      allow: strings(s['allow']),
      disabledRules: strings(s['disabledRules']),
      useLocalModel: s['useLocalModel'] === true,
    },
    externalAcknowledged: p['externalAcknowledged'] === true,
  };
}
