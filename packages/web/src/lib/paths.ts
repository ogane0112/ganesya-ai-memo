/** URL of a note inside the app. Each path segment is encoded separately. */
export function noteUrl(path: string, opts: { edit?: boolean; commit?: string } = {}): string {
  const base = '/n/' + path.split('/').map(encodeURIComponent).join('/');
  const q = new URLSearchParams();
  if (opts.edit) q.set('edit', '1');
  if (opts.commit) q.set('commit', opts.commit);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** Inverse of noteUrl for the splat part after `/n/`. */
export function pathFromSplat(splat: string): string {
  return splat
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function titleFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, '');
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const isImagePath = (p: string) => IMAGE_RE.test(p);

/** Make a safe file name from a title (mirrors the server's slugifyTitle). */
export function safeFileName(title: string): string {
  const s = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|#^[\]\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return s || 'Untitled';
}

/** Turn user input ("Folder/My note" or "My note.md") into a note path. */
export function toNotePath(input: string, defaultFolder = ''): string {
  let p = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  if (!p) return '';
  const parts = p
    .split('/')
    .map((seg, i, arr) =>
      i === arr.length - 1 ? safeFileName(seg.replace(/\.md$/i, '')) : seg.trim(),
    );
  p = parts.filter((s) => s && s !== '.' && s !== '..').join('/');
  if (!p.includes('/') && defaultFolder) p = `${defaultFolder.replace(/\/+$/, '')}/${p}`;
  return `${p}.md`;
}

/** Only allow same-app relative redirects (prevents open redirects via ?next=). */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback;
  if (
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.startsWith('/\\') ||
    next.includes('\\')
  )
    return fallback;
  return next;
}
