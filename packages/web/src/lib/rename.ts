import { api } from '../api/client';
import { syncQueue } from './sync';

/**
 * Move or rename a note (the server rewrites links to it). A save of the note
 * still on its way lands first, so nothing written is left behind at the old
 * name.
 */
export async function moveNote(from: string, to: string): Promise<string> {
  if (to === from) return from;
  const r = await syncQueue.outcome(from);
  if (r === 'failed') throw new Error('保存できなかった変更があるため、名前や場所を変えられません');
  if (r === 'later')
    throw new Error('保存がまだ終わっていません。オンラインになってから、もう一度お試しください');
  await api.renameNote(from, to);
  return to;
}
