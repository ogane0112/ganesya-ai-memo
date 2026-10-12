import { inlineViewSource } from '@gmemo/core';
import { type ReactNode, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BlockAttribution } from '../api/types';
import { formatDateTime } from '../lib/format';
import { renderBlocks, renderMarkdown } from '../lib/markdown';

/** Follow in-app links with the router instead of a full page load. */
export function useInternalLinks() {
  const navigate = useNavigate();
  return (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (
      a.target === '_blank' ||
      !href.startsWith('/') ||
      href.startsWith('//') ||
      href.startsWith('/api/')
    )
      return;
    e.preventDefault();
    navigate(href);
  };
}

/**
 * Renders a ```gmemo-view block (its YAML, and its position among the note's
 * inline views). Without it the block shows as code, as in any Markdown tool.
 */
export type RenderInlineView = (source: string, index: number) => ReactNode;

/** Render Markdown (no blame). */
export function Markdown({
  text,
  paths,
  className,
  renderView,
}: {
  text: string;
  paths: readonly string[];
  className?: string;
  renderView?: RenderInlineView;
}) {
  const html = useMemo(
    () => (renderView ? '' : renderMarkdown(text, { paths })),
    [text, paths, renderView],
  );
  const blocks = useMemo(
    () => (renderView ? renderBlocks(text, [], { paths }) : []),
    [text, paths, renderView],
  );
  const onClick = useInternalLinks();
  if (renderView) {
    let n = 0;
    return (
      <div className={className ? `md ${className}` : 'md'} onClick={onClick}>
        {blocks.map((b) => {
          const src = inlineViewSource(b.text);
          if (src !== null)
            return (
              <div key={b.key} className="blk">
                {renderView(src, n++)}
              </div>
            );
          return <div key={b.key} className="blk" dangerouslySetInnerHTML={{ __html: b.html }} />;
        })}
      </div>
    );
  }
  return (
    <div
      className={className ? `md ${className}` : 'md'}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Note body rendered paragraph by paragraph. Paragraphs last written by an AI
 * get a colored left border; tapping one shows which agent wrote it.
 */
export function BlameView({
  body,
  blame,
  paths,
  hideTitle,
  renderView,
}: {
  body: string;
  blame: readonly BlockAttribution[];
  paths: readonly string[];
  hideTitle?: string | undefined;
  renderView?: RenderInlineView | undefined;
}) {
  const blocks = useMemo(() => {
    const all = renderBlocks(body, blame, { paths });
    // The page header already shows the title: drop a leading "# Title" block that repeats it.
    const first = all[0];
    if (hideTitle && first && first.text.trim() === `# ${hideTitle}`) return all.slice(1);
    return all;
  }, [body, blame, paths, hideTitle]);
  const [open, setOpen] = useState<string | null>(null);
  const onClick = useInternalLinks();
  if (!body.trim()) return <p className="hint">(本文はまだありません)</p>;
  let viewIndex = 0;
  return (
    <div className="md blame" onClick={onClick}>
      {blocks.map((b) => {
        const src = renderView ? inlineViewSource(b.text) : null;
        if (src !== null)
          return (
            <div key={b.key} className="blk">
              {renderView!(src, viewIndex++)}
            </div>
          );
        const ai = b.author?.kind === 'ai';
        if (!ai)
          return <div key={b.key} className="blk" dangerouslySetInnerHTML={{ __html: b.html }} />;
        const label = `${b.author!.name} が書いた段落${b.date ? `(${formatDateTime(b.date)})` : ''}`;
        const isOpen = open === b.key;
        return (
          <div key={b.key} className={isOpen ? 'blk blk-ai open' : 'blk blk-ai'} title={label}>
            <button
              type="button"
              className="blk-author"
              aria-expanded={isOpen}
              aria-label={label}
              onClick={() => setOpen(isOpen ? null : b.key)}
            >
              <span aria-hidden="true">AI</span>
            </button>
            {isOpen && <div className="blk-author-label">{label}</div>}
            <div dangerouslySetInnerHTML={{ __html: b.html }} />
          </div>
        );
      })}
    </div>
  );
}
