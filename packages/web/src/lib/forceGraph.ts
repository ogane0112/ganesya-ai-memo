/**
 * A tiny force-directed layout (no dependencies): many-body repulsion,
 * spring links, centering and velocity damping. Deterministic for a given
 * input, so it is easy to test.
 */
export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned while dragged. */
  fx?: number | null;
  fy?: number | null;
  degree: number;
}

export interface SimLink {
  source: number;
  target: number;
}

export interface Simulation {
  nodes: SimNode[];
  links: SimLink[];
  alpha: number;
}

export function createSimulation(
  ids: readonly string[],
  edges: readonly { source: string; target: string }[],
): Simulation {
  const index = new Map(ids.map((id, i) => [id, i]));
  const links: SimLink[] = [];
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s !== undefined && t !== undefined && s !== t) links.push({ source: s, target: t });
  }
  const degree = new Array<number>(ids.length).fill(0);
  for (const l of links) {
    degree[l.source]!++;
    degree[l.target]!++;
  }
  // Phyllotaxis initial placement (like d3-force): spread out, deterministic.
  const nodes: SimNode[] = ids.map((id, i) => {
    const r = 10 * Math.sqrt(0.5 + i);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    return { id, x: r * Math.cos(a), y: r * Math.sin(a), vx: 0, vy: 0, degree: degree[i] ?? 0 };
  });
  return { nodes, links, alpha: 1 };
}

export interface TickOptions {
  repulsion?: number;
  linkDistance?: number;
  linkStrength?: number;
  center?: number;
  damping?: number;
}

/** Advance the simulation one step. Returns the new alpha (energy). */
export function tick(sim: Simulation, o: TickOptions = {}): number {
  const repulsion = o.repulsion ?? 1500;
  const linkDistance = o.linkDistance ?? 50;
  const linkStrength = o.linkStrength ?? 0.08;
  const center = o.center ?? 0.003;
  const damping = o.damping ?? 0.6;
  const { nodes, links } = sim;
  const a = sim.alpha;
  const n = nodes.length;

  // Many-body repulsion (O(n²) — fine for personal note graphs of a few thousand nodes at most).
  for (let i = 0; i < n; i++) {
    const p = nodes[i]!;
    for (let j = i + 1; j < n; j++) {
      const q = nodes[j]!;
      let dx = q.x - p.x;
      let dy = q.y - p.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (i - j) * 0.1 || 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      if (d2 > 250_000) continue;
      const f = (repulsion * a) / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      p.vx -= fx;
      p.vy -= fy;
      q.vx += fx;
      q.vy += fy;
    }
  }
  // Springs.
  for (const l of links) {
    const s = nodes[l.source]!;
    const t = nodes[l.target]!;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const k = ((d - linkDistance) / d) * linkStrength * a;
    s.vx += dx * k;
    s.vy += dy * k;
    t.vx -= dx * k;
    t.vy -= dy * k;
  }
  // Gravity to the center and integration.
  for (const p of nodes) {
    p.vx -= p.x * center * a;
    p.vy -= p.y * center * a;
    if (p.fx != null && p.fy != null) {
      p.x = p.fx;
      p.y = p.fy;
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx *= damping;
    p.vy *= damping;
    p.x += p.vx;
    p.y += p.vy;
  }
  sim.alpha = a * 0.985;
  return sim.alpha;
}

export function bounds(nodes: readonly SimNode[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (!nodes.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of nodes) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}
