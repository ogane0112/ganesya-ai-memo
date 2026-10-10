import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitOptions {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Exit codes to treat as success (default [0]). */
  okCodes?: number[];
}

export interface GitResult {
  stdout: string;
  code: number;
}

/** Run git with arguments (never through a shell). */
export function git(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        LC_ALL: 'C',
        ...opts.env,
      },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if ((opts.okCodes ?? [0]).includes(code ?? -1)) resolve({ stdout, code: code ?? 0 });
      else reject(new GitError(`git ${args[0]} failed (${code}): ${stderr.trim()}`, code, stderr));
    });
    if (child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }
  });
}

/** Simple promise mutex so repository writes never interleave. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Run git and return raw stdout bytes, or null on a non-zero exit. */
export function gitRaw(args: string[], cwd: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(out) : null));
  });
}
