import { useCallback } from 'react';
import { api, describeError } from '../api/client';
import { useApp } from './app';
import { useToast } from './toast';

/**
 * Delete a folder that holds no notes (the empty folders inside it go too).
 * Resolves true when it was deleted. Folders with notes are never offered:
 * deleting those would mean deleting notes.
 */
export function useDeleteFolder() {
  const { refreshNotes } = useApp();
  const toast = useToast();
  return useCallback(
    async (path: string, opts: { hasSubfolders?: boolean } = {}): Promise<boolean> => {
      const what = opts.hasSubfolders
        ? `フォルダー「${path}」と、中の空のフォルダーを削除しますか?`
        : `フォルダー「${path}」を削除しますか?`;
      if (!confirm(what)) return false;
      try {
        await api.deleteFolder(path);
        refreshNotes();
        toast.show('フォルダーを削除しました', { kind: 'success', duration: 2000 });
        return true;
      } catch (e) {
        toast.show(describeError(e), { kind: 'error' });
        return false;
      }
    },
    [refreshNotes, toast],
  );
}
