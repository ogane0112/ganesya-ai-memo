import { DEFAULT_POLICY, type WorkspacePolicy } from '@gmemo/core';
import { describe, expect, it } from 'vitest';
import { sharesNothingExternally } from '../src/components/ExternalShareWarning';

const policy = (ai: WorkspacePolicy['ai']): WorkspacePolicy => ({ ...DEFAULT_POLICY, ai });

describe('external AI sharing warning', () => {
  it('warns while no folder is shared with external AI (the default)', () => {
    expect(sharesNothingExternally(DEFAULT_POLICY)).toBe(true);
    expect(sharesNothingExternally(policy({ default: 'none', folders: { work: 'local' } }))).toBe(
      true,
    );
  });

  it('stays quiet once a folder or the default is shared', () => {
    expect(sharesNothingExternally(policy({ default: 'external', folders: {} }))).toBe(false);
    expect(
      sharesNothingExternally(policy({ default: 'local', folders: { manuals: 'external' } })),
    ).toBe(false);
  });
});
