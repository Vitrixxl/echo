// Offline walking route: build a graph from road lines (read from the map tiles already on
// the phone) and run A*. No server, works with the network down.
import { distanceM } from './alerts';

export type LngLat = [number, number];
type Graph = { nodes: LngLat[]; adj: { to: number; w: number }[][] };

const SNAP_M = 3; // vertices closer than this are the same point (tile seams, rounding)
const CELL = 3e-5; // grid cell in degrees (~3 m), for snapping lookups
const MAX_SNAP_M = 200; // start/end further than this from any road -> no route

const d = (a: LngLat, b: LngLat) => distanceM(a[1], a[0], b[1], b[0]);

export function buildGraph(lines: LngLat[][]): Graph {
  const nodes: LngLat[] = [];
  const adj: Graph['adj'] = [];
  const grid = new Map<string, number[]>();
  const nodeAt = (p: LngLat) => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (const i of grid.get(x + ',' + y) ?? []) if (d(nodes[i], p) <= SNAP_M) return i;
    const i = nodes.push(p) - 1;
    adj.push([]);
    const k = cx + ',' + cy;
    grid.has(k) ? grid.get(k)!.push(i) : grid.set(k, [i]);
    return i;
  };
  for (const line of lines) {
    let prev = -1;
    for (const p of line) {
      const i = nodeAt(p);
      if (prev >= 0 && prev !== i) {
        const w = d(nodes[prev], nodes[i]);
        adj[prev].push({ to: i, w });
        adj[i].push({ to: prev, w });
      }
      prev = i;
    }
  }
  joinDeadEnds(nodes, adj);
  return { nodes, adj };
}

const JOIN_M = 12; // a dead end this close to another street is really connected to it
const SEG_CELL = 2e-4; // ~20 m grid for segment lookups

/** Map tiles lose junction vertices: T-junctions get simplified away and streets are cut at tile
 *  edges, leaving fake dead ends a few metres from the street they meet. Link each dead end to
 *  both ends of the nearest segment within JOIN_M, weighted through the projected point. */
function joinDeadEnds(nodes: LngLat[], adj: Graph['adj']) {
  const segs: [number, number][] = [];
  const grid = new Map<string, number[]>();
  adj.forEach((es, u) => es.forEach(({ to }) => {
    if (u > to) return;
    const s = segs.push([u, to]) - 1;
    const [a, b] = [nodes[u], nodes[to]];
    for (let x = Math.floor(Math.min(a[0], b[0]) / SEG_CELL); x <= Math.floor(Math.max(a[0], b[0]) / SEG_CELL); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / SEG_CELL); y <= Math.floor(Math.max(a[1], b[1]) / SEG_CELL); y++) {
        const k = x + ',' + y;
        grid.has(k) ? grid.get(k)!.push(s) : grid.set(k, [s]);
      }
  }));
  const ends = adj.flatMap((es, i) => (es.length === 1 ? [i] : []));
  for (const e of ends) {
    const p = nodes[e];
    const kx = Math.cos((p[1] * Math.PI) / 180); // flat projection, fine at street scale
    let best: { u: number; v: number; q: LngLat; dist: number } | null = null;
    const cx = Math.floor(p[0] / SEG_CELL), cy = Math.floor(p[1] / SEG_CELL);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (const s of grid.get(x + ',' + y) ?? []) {
          const [u, v] = segs[s];
          if (u === e || v === e || adj[e][0].to === u || adj[e][0].to === v) continue;
          const [a, b] = [nodes[u], nodes[v]];
          const vx = (b[0] - a[0]) * kx, vy = b[1] - a[1];
          const len2 = vx * vx + vy * vy;
          const t = len2 ? Math.max(0, Math.min(1, (((p[0] - a[0]) * kx) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
          const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const dist = d(p, q);
          if (dist <= JOIN_M && (!best || dist < best.dist)) best = { u, v, q, dist };
        }
    if (!best) continue;
    for (const n of [best.u, best.v]) {
      const w = best.dist + d(best.q, nodes[n]);
      adj[e].push({ to: n, w });
      adj[n].push({ to: e, w });
    }
  }
}

/** A* from the road point nearest `from` to the one nearest `to`. Null if unreachable. */
export function shortestPath(g: Graph, from: LngLat, to: LngLat): LngLat[] | null {
  const nearest = (p: LngLat) => {
    let best = -1, bd = Infinity;
    g.nodes.forEach((n, i) => { const x = d(n, p); if (x < bd) { bd = x; best = i; } });
    return bd <= MAX_SNAP_M ? best : -1;
  };
  const s = nearest(from), t = nearest(to);
  if (s < 0 || t < 0) return null;

  const dist = new Float64Array(g.nodes.length).fill(Infinity);
  const prev = new Int32Array(g.nodes.length).fill(-1);
  const heap: [number, number][] = []; // [f-score, node], binary min-heap
  const push = (f: number, n: number) => {
    heap.push([f, n]);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  dist[s] = 0;
  push(d(g.nodes[s], g.nodes[t]), s);
  while (heap.length) {
    const [f, u] = pop();
    if (u === t) break;
    if (f - d(g.nodes[u], g.nodes[t]) > dist[u] + 1e-9) continue; // stale entry
    for (const { to, w } of g.adj[u]) {
      const nd = dist[u] + w;
      if (nd < dist[to]) {
        dist[to] = nd;
        prev[to] = u;
        push(nd + d(g.nodes[to], g.nodes[t]), to);
      }
    }
  }
  if (dist[t] === Infinity) return null;
  const path: LngLat[] = [to];
  for (let n = t; n >= 0; n = prev[n]) path.push(g.nodes[n]);
  path.push(from);
  return path.reverse();
}

export function lengthM(path: LngLat[]) {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += d(path[i - 1], path[i]);
  return m;
}
