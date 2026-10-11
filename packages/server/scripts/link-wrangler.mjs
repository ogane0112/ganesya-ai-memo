// The cf CLI (beta) looks for its Wrangler delegate only in this package's own
// node_modules, but npm workspaces hoist wrangler to the repository root.
// Link it here so `cf dev` / `cf build` / `cf deploy` find it. Safe to re-run.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(pkgDir, 'node_modules', 'wrangler');
const hoisted = join(pkgDir, '..', '..', 'node_modules', 'wrangler');
if (!existsSync(local) && existsSync(hoisted)) {
  mkdirSync(dirname(local), { recursive: true });
  symlinkSync(relative(dirname(local), hoisted), local, 'junction');
}
