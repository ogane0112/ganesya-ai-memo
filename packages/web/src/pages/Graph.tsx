import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { GraphData } from '../api/types';
import { EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';
import { bounds, createSimulation, type Simulation, tick } from '../lib/forceGraph';
import { useAsync, useDocumentTitle } from '../lib/hooks';
import { linkKindLabel } from '../lib/links';
import { noteUrl } from '../lib/paths';
import { useApp } from '../state/app';

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

export function GraphPage() {
  useDocumentTitle('グラフ');
  const { changeTick } = useApp();
  const data = useAsync(() => api.graph(), [changeTick]);
  const broken = useAsync(() => api.brokenLinks(), [changeTick]);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [query, setQuery] = useState('');
  const graph = useMemo<GraphData | null>(() => {
    if (!data.data) return null;
    if (!hideOrphans) return data.data;
    const linked = new Set(data.data.edges.flatMap((e) => [e.source, e.target]));
    return { nodes: data.data.nodes.filter((n) => linked.has(n.id)), edges: data.data.edges };
  }, [data.data, hideOrphans]);

  return (
    <div className="page page-wide graph-page">
      <PageHeader
        title="グラフ"
        sub={graph ? `${graph.nodes.length} ノート・${graph.edges.length} リンク` : undefined}
      />
      <div className="toolbar-row">
        <label className="visually-hidden" htmlFor="graph-q">
          ノートを探す
        </label>
        <input
          id="graph-q"
          className="input"
          type="search"
          placeholder="ノート名で強調"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={hideOrphans}
            onChange={(e) => setHideOrphans(e.target.checked)}
          />
          リンクのないノートを隠す
        </label>
      </div>
      {data.loading && !data.data ? (
        <Loading />
      ) : data.error ? (
        <ErrorBox error={data.error} onRetry={data.reload} />
      ) : !graph?.nodes.length ? (
        <EmptyState icon="graph" title="表示するノートがありません">
          <p>ノートの中で [[別のノート]] と書くと、つながりがここに表示されます。</p>
        </EmptyState>
      ) : (
        <>
          <GraphCanvas graph={graph} query={query} />
          <p className="hint graph-legend">
            <span className="legend-dot" /> 人が作成 <span className="legend-dot legend-ai" />{' '}
            AIが作成 ・ドラッグで移動、ホイール/ピンチで拡大、タップで開く
          </p>
          <details className="graph-list">
            <summary>リストで見る</summary>
            <ul>
              {graph.nodes.map((n) => (
                <li key={n.id}>
                  <Link to={noteUrl(n.id)}>{n.title}</Link>{' '}
                  <span className="hint">
                    ({graph.edges.filter((e) => e.source === n.id || e.target === n.id).length}{' '}
                    リンク)
                  </span>
                </li>
              ))}
            </ul>
          </details>
          {broken.data?.broken.length ? (
            <details className="graph-list">
              <summary>リンク切れ ({broken.data.broken.length})</summary>
              <ul>
                {broken.data.broken.map((b) => (
                  <li key={`${b.src} ${b.kind} ${b.target}`}>
                    <Link to={noteUrl(b.src)}>{b.src}</Link>{' '}
                    <span className="hint">
                      → {b.target}({linkKindLabel(b.kind)})
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function GraphCanvas({ graph, query }: { graph: GraphData; query: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const sim = useRef<Simulation | null>(null);
  const view = useRef({ x: 0, y: 0, k: 1 });
  const hover = useRef<number | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query.trim().toLowerCase();
  const kick = useRef<() => void>(() => undefined);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const s = createSimulation(
      graph.nodes.map((n) => n.id),
      graph.edges,
    );
    sim.current = s;
    for (let i = 0; i < 120; i++) tick(s); // pre-settle
    const meta = graph.nodes;
    const neighbors = new Map<number, Set<number>>();
    for (const l of s.links) {
      if (!neighbors.has(l.source)) neighbors.set(l.source, new Set());
      if (!neighbors.has(l.target)) neighbors.set(l.target, new Set());
      neighbors.get(l.source)!.add(l.target);
      neighbors.get(l.target)!.add(l.source);
    }
    const colors = {
      human: cssVar('--accent'),
      ai: cssVar('--ai'),
      edge: cssVar('--border-strong'),
      text: cssVar('--fg'),
      muted: cssVar('--muted'),
      bg: cssVar('--bg'),
    };

    let w = 0;
    let h = 0;
    const resize = () => {
      const rect = wrap.current!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = rect.width;
      h = rect.height;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    // Fit to view.
    const b = bounds(s.nodes);
    const k = Math.min(
      2,
      Math.max(0.2, Math.min(w / (b.maxX - b.minX + 80), h / (b.maxY - b.minY + 80))),
    );
    view.current = {
      k,
      x: w / 2 - ((b.minX + b.maxX) / 2) * k,
      y: h / 2 - ((b.minY + b.maxY) / 2) * k,
    };

    const radius = (i: number) => 4 + Math.sqrt(s.nodes[i]!.degree) * 2;
    let raf = 0;
    const draw = () => {
      const { x, y, k: z } = view.current;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(z, z);
      const hv = hover.current;
      const near = hv !== null ? neighbors.get(hv) : undefined;
      const q = queryRef.current;
      ctx.lineWidth = 1 / z;
      for (const l of s.links) {
        const a = s.nodes[l.source]!;
        const t = s.nodes[l.target]!;
        const active = hv !== null && (l.source === hv || l.target === hv);
        ctx.strokeStyle = active ? colors.human : colors.edge;
        ctx.globalAlpha = hv !== null && !active ? 0.25 : 0.8;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      s.nodes.forEach((p, i) => {
        const m = meta[i]!;
        const match = q && (m.title.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
        const dim = (hv !== null && hv !== i && !near?.has(i)) || (q && !match);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = m.createdBy === 'ai' ? colors.ai : colors.human;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius(i) + (match ? 3 : 0), 0, Math.PI * 2);
        ctx.fill();
        if (match || hv === i) {
          ctx.lineWidth = 2 / z;
          ctx.strokeStyle = colors.text;
          ctx.stroke();
        }
        if (z > 0.7 || hv === i || match || p.degree >= 4) {
          ctx.fillStyle = colors.text;
          ctx.font = `${12 / Math.max(z, 0.7)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(
            m.title.length > 24 ? m.title.slice(0, 23) + '…' : m.title,
            p.x,
            p.y + radius(i) + 12 / Math.max(z, 0.7),
          );
        }
      });
      ctx.restore();
    };
    const loop = () => {
      if (s.alpha > 0.02) {
        tick(s);
        draw();
        raf = requestAnimationFrame(loop);
      } else {
        draw();
        raf = 0;
      }
    };
    kick.current = () => {
      if (!raf) raf = requestAnimationFrame(loop);
      else draw();
    };
    s.alpha = Math.max(s.alpha, 0.3);
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(wrap.current!);

    // ---- interaction ----
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: {
      node: number | null;
      startX: number;
      startY: number;
      moved: boolean;
      vx: number;
      vy: number;
    } | null = null;
    let pinch: { dist: number; k: number } | null = null;
    const toWorld = (px: number, py: number) => ({
      x: (px - view.current.x) / view.current.k,
      y: (py - view.current.y) / view.current.k,
    });
    const pick = (px: number, py: number) => {
      const p = toWorld(px, py);
      let best: number | null = null;
      let bestD = Infinity;
      s.nodes.forEach((n, i) => {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        const r = radius(i) + 8 / view.current.k;
        if (d < r && d < bestD) {
          best = i;
          bestD = d;
        }
      });
      return best;
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, bb] = [...pointers.values()] as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        pinch = { dist: Math.hypot(a.x - bb.x, a.y - bb.y), k: view.current.k };
        drag = null;
        return;
      }
      drag = {
        node: pick(p.x, p.y),
        startX: p.x,
        startY: p.y,
        moved: false,
        vx: view.current.x,
        vy: view.current.y,
      };
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, bb] = [...pointers.values()] as [
          { x: number; y: number },
          { x: number; y: number },
        ];
        const d = Math.hypot(a.x - bb.x, a.y - bb.y);
        zoomAt((a.x + bb.x) / 2, (a.y + bb.y) / 2, (pinch.k * d) / pinch.dist / view.current.k);
        return;
      }
      if (!drag) {
        const hv = pick(p.x, p.y);
        if (hv !== hover.current) {
          hover.current = hv;
          c.style.cursor = hv !== null ? 'pointer' : 'grab';
          kick.current();
        }
        return;
      }
      if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.node !== null) {
        const wpt = toWorld(p.x, p.y);
        const n = s.nodes[drag.node]!;
        n.fx = wpt.x;
        n.fy = wpt.y;
        s.alpha = Math.max(s.alpha, 0.3);
        kick.current();
      } else {
        view.current.x = drag.vx + (p.x - drag.startX);
        view.current.y = drag.vy + (p.y - drag.startY);
        kick.current();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      if (drag.node !== null) {
        const n = s.nodes[drag.node]!;
        if (!drag.moved) navigate(noteUrl(n.id));
        n.fx = null;
        n.fy = null;
      }
      drag = null;
    };
    const zoomAt = (px: number, py: number, factor: number) => {
      const v = view.current;
      const k2 = Math.min(4, Math.max(0.1, v.k * factor));
      v.x = px - ((px - v.x) * k2) / v.k;
      v.y = py - ((py - v.y) * k2) / v.k;
      v.k = k2;
      kick.current();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointercancel', onUp);
      c.removeEventListener('wheel', onWheel);
    };
  }, [graph, navigate]);

  useEffect(() => {
    kick.current();
  }, [query]);

  return (
    <div ref={wrap} className="graph-wrap">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`ノートのリンクグラフ(${graph.nodes.length} ノート)`}
      />
    </div>
  );
}
