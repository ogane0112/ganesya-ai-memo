import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentStore } from '../src/auth/agents.js';
import { APP_MIGRATIONS, INDEX_MIGRATIONS, openDatabase } from '../src/db/db.js';
import { NoteRepo } from '../src/git/repo.js';
import { NoteService } from '../src/notes/service.js';
import { HashingEmbedder } from '../src/search/embedder.js';
import { Indexer } from '../src/search/indexer.js';

export async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'gmemo-test-'));
  const repo = new NoteRepo(join(dir, 'notes'));
  await repo.init();
  const appDb = openDatabase(':memory:', APP_MIGRATIONS);
  const indexDb = openDatabase(':memory:', INDEX_MIGRATIONS);
  let service!: NoteService;
  const indexer = new Indexer(indexDb, repo, new HashingEmbedder(), () => service.currentPolicy());
  service = new NoteService(repo, appDb, indexer, () => ({ kind: 'human', name: 'me' }));
  await service.init();
  const agents = new AgentStore(appDb);
  return {
    dir,
    repo,
    appDb,
    indexDb,
    indexer,
    service,
    agents,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
