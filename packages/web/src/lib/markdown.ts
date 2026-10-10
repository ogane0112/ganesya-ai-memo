import { type BlockAttribution, parseNoteLenient, resolveLink, splitBlocks } from '@gmemo/core';
import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';
import { api } from '../api/client';
import { isImagePath, noteUrl } from './paths';

export interface RenderContext {
  /** All note paths, for resolving [[wiki links]]. */
  paths: readonly string[];
}

const WIKI_RE = /^(!?)\[\[([^[\]\n|#]+)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/;

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

interface WikiToken extends Tokens.Generic {
  type: 'wikilink';
  raw: string;
  embed: boolean;
  target: string;
  heading?: string;
  alias?: string;
}

/** HTML for one [[wiki link]] / ![[embed]]. Exported for tests. */
export function renderWikiLink(
  t: { embed: boolean; target: string; heading?: string; alias?: string },
  ctx: RenderContext,
): string {
  const target = t.target.trim();
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(target) && !/\.md$/i.test(target);
  if (hasExt) {
    // Attachment (image, pdf…): served raw by the API.
    const src = api.fileUrl(target.replace(/^\/+/, ''));
    const label = escapeHtml(t.alias || target.split('/').pop() || target);
    if (t.embed && isImagePath(target))
      return `<img src="${escapeHtml(src)}" alt="${label}" loading="lazy">`;
    return `<a href="${escapeHtml(src)}" class="attachment" target="_blank" rel="noopener">${label}</a>`;
  }
  const resolved = resolveLink(target, ctx.paths);
  const path = resolved ?? (/\.md$/i.test(target) ? target : `${target}.md`);
  const label = escapeHtml(t.alias || (t.heading ? `${target} › ${t.heading}` : target));
  const cls = ['wikilink', t.embed ? 'embed' : '', resolved ? '' : 'unresolved']
    .filter(Boolean)
    .join(' ');
  const title = resolved ? '' : ' title="まだ存在しないノート"';
  return `<a href="${escapeHtml(noteUrl(path))}" class="${cls}" data-internal="1"${title}>${label}</a>`;
}

function wikiExtension(ctx: RenderContext): TokenizerAndRendererExtension {
  return {
    name: 'wikilink',
    level: 'inline',
    start(src: string) {
      const i = src.search(/!?\[\[/);
      return i < 0 ? undefined : i;
    },
    tokenizer(src: string) {
      const m = WIKI_RE.exec(src);
      if (!m) return undefined;
      const tok: WikiToken = {
        type: 'wikilink',
        raw: m[0],
        embed: m[1] === '!',
        target: (m[2] ?? '').trim(),
      };
      if (m[3]) tok.heading = m[3].trim();
      if (m[4]) tok.alias = m[4].trim();
      return tok;
    },
    renderer(token) {
      return renderWikiLink(token as WikiToken, ctx);
    },
  };
}

let hooked = false;
function purify(html: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (/^https?:\/\//i.test(href)) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
    });
  }
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'loading', 'data-internal'],
    FORBID_TAGS: ['style', 'form'],
  });
}

function markedFor(ctx: RenderContext): Marked {
  return new Marked({ gfm: true, breaks: true, extensions: [wikiExtension(ctx)] });
}

/** Render a Markdown fragment to sanitized HTML. */
export function renderMarkdown(md: string, ctx: RenderContext = { paths: [] }): string {
  return purify(markedFor(ctx).parse(md, { async: false }));
}

export interface RenderedBlock {
  key: string;
  /** Markdown source of the block. */
  text: string;
  html: string;
  /** Who last changed this paragraph (from block-level blame). */
  author?: BlockAttribution['author'];
  date?: string;
}

/**
 * Split a note body into paragraph blocks (same segmentation as the server's
 * blame) and render each one, attaching its attribution. Attribution entries
 * index the non-empty blocks; an entry is only used when its text still
 * matches, so stale blame never colors the wrong paragraph.
 */
export function attributeBlocks(
  body: string,
  attributions: readonly BlockAttribution[],
): { text: string; author?: BlockAttribution['author']; date?: string }[] {
  const blocks = splitBlocks(body).filter((b) => b.key !== '');
  return blocks.map((b, i) => {
    const a = attributions[i];
    if (a && a.index === i && a.text.trim() === b.key)
      return { text: b.raw, author: a.author, date: a.date };
    return { text: b.raw };
  });
}

export function renderBlocks(
  body: string,
  attributions: readonly BlockAttribution[],
  ctx: RenderContext,
): RenderedBlock[] {
  const m = markedFor(ctx);
  return attributeBlocks(body, attributions).map((b, i) => ({
    key: `${i}:${b.text.length}`,
    text: b.text,
    html: purify(m.parse(b.text, { async: false })),
    ...(b.author ? { author: b.author } : {}),
    ...(b.date ? { date: b.date } : {}),
  }));
}

/** Body without frontmatter. */
export function noteBody(content: string): string {
  return parseNoteLenient(content).body;
}

/** Search snippets wrap matches in «»; turn them into <mark> safely. */
export function highlightSnippet(snippet: string): string {
  return escapeHtml(snippet)
    .replace(/«([^«»]*)»/g, '<mark>$1</mark>')
    .replace(/[«»]/g, '');
}

/** Replace [n] citations in an AI answer with links to the cited notes. */
export function linkCitations(
  answer: string,
  sources: readonly { n: number; path: string }[],
): string {
  return answer.replace(/\[(\d{1,2})\](?!\()/g, (whole, n: string) => {
    const s = sources.find((x) => x.n === Number(n));
    return s
      ? `[\\[${n}\\]](${noteUrl(s.path).replace(/\)/g, '%29').replace(/ /g, '%20')})`
      : whole;
  });
}
