import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DB } from './db/db.js';
import { git } from './git/git.js';
import type { NoteRepo } from './git/repo.js';

/**
 * Backup archive: the notes repository as a git bundle (all branches, full
 * history) plus a snapshot of app.db. The index is not included; it is rebuilt
 * from the repository. Optionally encrypted with AES-256-GCM (scrypt key).
 *
 * Layout: MAGIC(8) [salt(16) iv(12) tag(16)] gzip(header JSON + "\n" + files...)
 */
const MAGIC_PLAIN = Buffer.from('GMEMOBK0');
const MAGIC_ENC = Buffer.from('GMEMOBK1');

interface Header {
  version: 1;
  createdAt: string;
  files: { name: string; size: number }[];
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function createBackup(
  repo: NoteRepo,
  appDb: DB,
  passphrase?: string,
): Promise<Buffer> {
  const tmp = await mkdtemp(join(tmpdir(), 'gmemo-backup-'));
  try {
    const bundle = join(tmp, 'notes.bundle');
    await repo.bundle(bundle);
    const dbFile = join(tmp, 'app.db');
    await appDb.backup(dbFile);
    const files = [
      { name: 'notes.bundle', data: await readFile(bundle) },
      { name: 'app.db', data: await readFile(dbFile) },
    ];
    const header: Header = {
      version: 1,
      createdAt: new Date().toISOString(),
      files: files.map((f) => ({ name: f.name, size: f.data.length })),
    };
    const payload = gzipSync(
      Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), ...files.map((f) => f.data)]),
    );
    if (!passphrase) return Buffer.concat([MAGIC_PLAIN, payload]);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([MAGIC_ENC, salt, iv, cipher.getAuthTag(), enc]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function readBackup(
  archive: Buffer,
  passphrase?: string,
): { header: Header; files: Map<string, Buffer> } {
  const magic = archive.subarray(0, 8);
  let payload: Buffer;
  if (magic.equals(MAGIC_PLAIN)) payload = archive.subarray(8);
  else if (magic.equals(MAGIC_ENC)) {
    if (!passphrase) throw new Error('this backup is encrypted; a passphrase is required');
    const salt = archive.subarray(8, 24);
    const iv = archive.subarray(24, 36);
    const tag = archive.subarray(36, 52);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    try {
      payload = Buffer.concat([decipher.update(archive.subarray(52)), decipher.final()]);
    } catch {
      throw new Error('wrong passphrase or corrupted backup');
    }
  } else throw new Error('not a gmemo backup file');
  const raw = gunzipSync(payload);
  const nl = raw.indexOf(10);
  const header = JSON.parse(raw.subarray(0, nl).toString('utf8')) as Header;
  const files = new Map<string, Buffer>();
  let off = nl + 1;
  for (const f of header.files) {
    files.set(f.name, raw.subarray(off, off + f.size));
    off += f.size;
  }
  return { header, files };
}

/** Restore into an empty data directory. */
export async function restoreBackup(
  archive: Buffer,
  dataDir: string,
  passphrase?: string,
): Promise<void> {
  const notesDir = join(dataDir, 'notes');
  if (await stat(notesDir).catch(() => null))
    throw new Error(`${notesDir} already exists; restore needs an empty data directory`);
  const { files } = readBackup(archive, passphrase);
  const bundle = files.get('notes.bundle');
  const db = files.get('app.db');
  if (!bundle || !db) throw new Error('backup is missing files');
  await mkdir(dataDir, { recursive: true });
  const bundleFile = join(dataDir, 'restore.bundle');
  await writeFile(bundleFile, bundle);
  try {
    await git(['clone', '-q', '--mirror', bundleFile, join(notesDir, '.git')], { cwd: dataDir });
    await git(['config', '--bool', 'core.bare', 'false'], { cwd: notesDir });
    await git(['checkout', '-q', '-f', 'main'], { cwd: notesDir });
    await git(['remote', 'remove', 'origin'], { cwd: notesDir, okCodes: [0, 2] });
  } finally {
    await rm(bundleFile, { force: true });
  }
  await writeFile(join(dataDir, 'app.db'), db);
}
