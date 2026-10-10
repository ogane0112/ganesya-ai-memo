/**
 * In-memory stand-in for the subset of the GitHub REST API that GitHubStore
 * uses. It follows GitHub's observable behaviour closely enough for tests:
 * non-forced ref updates must fast-forward, empty repos only accept the
 * contents API, deleting a missing path in a tree fails, etc.
 */
import { objectId } from '../src/store/gitobj.js';

interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
}

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export function fakeGitHub(opts: { owner?: string; repo?: string; token?: string } = {}) {
  const owner = opts.owner ?? 'me';
  const repo = opts.repo ?? 'notes';
  const token = opts.token ?? 'ghp_test';
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, FakeCommit>();
  const refs = new Map<string, string>();
  const calls: string[] = [];

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function putBlob(bytes: Uint8Array) {
    const sha = await objectId('blob', bytes);
    blobs.set(sha, bytes);
    return sha;
  }
  async function putTree(map: Map<string, string>) {
    const sorted = [...map].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = await objectId('tree', enc.encode(JSON.stringify(sorted)));
    trees.set(sha, new Map(sorted));
    return sha;
  }
  function ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const q = [sha];
    while (q.length) {
      const s = q.shift()!;
      if (seen.has(s)) continue;
      seen.add(s);
      q.push(...(commits.get(s)?.parents ?? []));
    }
    return seen;
  }
  async function makeCommit(c: Omit<FakeCommit, 'sha'>) {
    const sha = await objectId('commit', enc.encode(JSON.stringify(c)));
    commits.set(sha, { ...c, sha });
    return sha;
  }
  const commitJson = (c: FakeCommit) => ({
    sha: c.sha,
    tree: { sha: c.tree },
    parents: c.parents.map((p) => ({ sha: p })),
    message: c.message,
    author: c.author,
  });

  const handler = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (headers.get('authorization') !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    const prefix = `/repos/${owner}/${repo}`;
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;

    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const sha = refs.get(m[1]!);
      return sha ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'PUT' && (m = /^\/contents\/(.+)$/.exec(path))) {
      const branch = String(body['branch'] ?? 'main');
      const parent = refs.get(branch);
      const base = parent ? trees.get(commits.get(parent)!.tree)! : new Map<string, string>();
      const next = new Map(base);
      next.set(m[1]!, await putBlob(unb64(String(body['content']))));
      const tree = await putTree(next);
      const sha = await makeCommit({
        tree,
        parents: parent ? [parent] : [],
        message: String(body['message']),
        author: { name: 'token owner', email: 'owner@example.com', date: new Date().toISOString() },
      });
      refs.set(branch, sha);
      return json(201, { commit: { sha } });
    }
    if (refs.size === 0) return json(409, { message: 'Git Repository is empty.' });

    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path))) {
      const c = commits.get(m[1]!);
      return c ? json(200, commitJson(c)) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path))) {
      const t = trees.get(m[1]!);
      if (!t) return json(404, { message: 'Not Found' });
      return json(200, { sha: m[1], tree: [...t].map(([p, sha]) => ({ path: p, type: 'blob', mode: '100644', sha })), truncated: false });
    }
    if (method === 'GET' && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path))) {
      const b = blobs.get(m[1]!);
      return b ? json(200, { sha: m[1], content: b64(b), encoding: 'base64' }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/blobs') {
      return json(201, { sha: await putBlob(unb64(String(body['content']))) });
    }
    if (method === 'POST' && path === '/git/trees') {
      const base = body['base_tree'] ? trees.get(String(body['base_tree'])) : new Map<string, string>();
      if (!base) return json(422, { message: 'base_tree not found' });
      const next = new Map(base);
      for (const e of body['tree'] as Record<string, unknown>[]) {
        const p = String(e['path']);
        if (e['sha'] === null) {
          if (!next.has(p)) return json(422, { message: `GitRPC::BadObjectState: ${p}` });
          next.delete(p);
        } else if (typeof e['content'] === 'string') next.set(p, await putBlob(enc.encode(e['content'])));
        else next.set(p, String(e['sha']));
      }
      return json(201, { sha: await putTree(next) });
    }
    if (method === 'POST' && path === '/git/commits') {
      const author = body['author'] as FakeCommit['author'];
      const sha = await makeCommit({
        tree: String(body['tree']),
        parents: body['parents'] as string[],
        message: String(body['message']),
        author: { name: author.name, email: author.email, date: author.date ?? new Date().toISOString() },
      });
      return json(201, commitJson(commits.get(sha)!));
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = String(body['ref']).replace(/^refs\/heads\//, '');
      if (refs.has(name)) return json(422, { message: 'Reference already exists' });
      refs.set(name, String(body['sha']));
      return json(201, { ref: body['ref'] });
    }
    if (method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(path))) {
      const cur = refs.get(m[1]!);
      if (!cur) return json(422, { message: 'Reference does not exist' });
      const sha = String(body['sha']);
      if (!body['force'] && !ancestors(sha).has(cur)) return json(422, { message: 'Update is not a fast forward' });
      refs.set(m[1]!, sha);
      return json(200, { object: { sha } });
    }
    if (method === 'DELETE' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(path))) {
      if (!refs.delete(m[1]!)) return json(422, { message: 'Reference does not exist' });
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && (m = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path))) {
      const [a, b] = [m[1]!, m[2]!];
      const status = a === b ? 'identical' : ancestors(b).has(a) ? 'ahead' : ancestors(a).has(b) ? 'behind' : 'diverged';
      return json(200, { status });
    }
    if (method === 'GET' && path === '/commits') {
      const start = url.searchParams.get('sha')!;
      const head = /^[0-9a-f]{40}$/.test(start) ? start : refs.get(start);
      if (!head) return json(404, { message: 'Not Found' });
      const filter = url.searchParams.get('path');
      const all = [...ancestors(head)].map((s) => commits.get(s)!).filter(Boolean);
      all.sort((x, y) => (x.author.date < y.author.date ? 1 : x.author.date > y.author.date ? -1 : 0));
      const touched = all.filter((c) => {
        if (!filter) return true;
        const mine = trees.get(c.tree)?.get(filter);
        const parentTree = c.parents[0] ? trees.get(commits.get(c.parents[0])!.tree) : undefined;
        return mine !== parentTree?.get(filter);
      });
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      return json(
        200,
        touched.slice((page - 1) * per, page * per).map((c) => ({
          sha: c.sha,
          parents: c.parents.map((p) => ({ sha: p })),
          commit: { message: c.message, author: c.author },
        })),
      );
    }
    return json(404, { message: `fake: unhandled ${method} ${path}` });
  };

  return { fetch: handler as typeof fetch, owner, repo, token, refs, calls };
}
