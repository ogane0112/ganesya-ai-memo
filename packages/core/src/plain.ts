/**
 * Markdown → readable plain text for short previews (search snippets,
 * backlink context). Not a full renderer: it removes block markers and
 * inline syntax so a snippet reads like the rendered note.
 */
export function markdownToPlain(md: string): string {
  return (
    md
      .split('\n')
      .map(
        (line) =>
          line
            .replace(/^\s{0,3}#{1,6}\s+/, '') // headings
            .replace(/^\s*>\s?/, '') // quotes
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/, '') // task items
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '') // list markers
            .replace(/^\s*(?:```|~~~).*$/, '') // code fences
            .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/, '') // table separators
            .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/, ''), // rules
      )
      .join(' ')
      // Snippets can start mid-line (e.g. "…## 目的"), so drop heading marks anywhere.
      .replace(/(^|[\s…])#{1,6}\s+/g, '$1')
      // ![[embed]] and [[target#heading|alias]] → alias or target
      .replace(/!?\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, a?: string) =>
        (a ?? t).trim(),
      )
      // A snippet may cut a link in half: drop leftover brackets.
      .replace(/!?\[\[|\]\]/g, '')
      // ![alt](url) → alt, [text](url) → text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
