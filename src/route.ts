// Offline walking route: build a graph from road lines (read from the map tiles already on
// the phone) and run A*. No server, works with the network down.
import { distanceM } from './alerts';

export type LngLat = [number, number];
export type Graph = { nodes: LngLat[]; adj: { to: number; w: number }[][] };

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

const SNAP_SLACK_M = 15; // streets this much further than the nearest one are also candidates
const ACCESS_M = 12; // walker -> street legs shorter than this are dropped from the route

/** Closest points on the street segments near `p` (not just the closest vertex: on a long straight
 *  street that vertex can be behind you). Every segment within SNAP_SLACK_M of the nearest one is a
 *  candidate, so a walker between two streets isn't forced onto the wrong one first. */
function snaps(g: Graph, p: LngLat) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const all: { u: number; v: number; q: LngLat; m: number }[] = [];
  g.adj.forEach((es, u) => es.forEach(({ to: v }) => {
    if (u > v) return;
    const [a, b] = [g.nodes[u], g.nodes[v]];
    const dx = (b[0] - a[0]) * k, dy = b[1] - a[1], L = dx * dx + dy * dy;
    const s = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * k * dx + (p[1] - a[1]) * dy) / L)) : 0;
    const q: LngLat = [a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])];
    all.push({ u, v, q, m: d(q, p) });
  }));
  let best = Infinity;
  for (const c of all) best = Math.min(best, c.m); // no spread: tens of thousands of segments
  return best <= MAX_SNAP_M ? all.filter((c) => c.m <= best + SNAP_SLACK_M) : [];
}

/** A* from `from` to `to` through the streets near each of them. Null if unreachable. */
export function shortestPath(g: Graph, from: LngLat, to: LngLat): LngLat[] | null {
  const A = snaps(g, from), B = snaps(g, to);
  if (!A.length || !B.length) return null;
  // Extra nodes: s (the walker), t (the SOS), and one per candidate point on a nearby street.
  const n = g.nodes.length, more: LngLat[] = [from, to];
  const s = n, t = n + 1;
  const node = (i: number) => (i < n ? g.nodes[i] : more[i - n]);
  const add = (p: LngLat) => n + more.push(p) - 1;
  const extra = new Map<number, { to: number; w: number }[]>();
  const link = (u: number, v: number) => { const w = d(node(u), node(v)); extra.set(u, [...(extra.get(u) ?? []), { to: v, w }]); };
  const starts = A.map((c) => { const q = add(c.q); link(s, q); link(q, c.u); link(q, c.v); return { ...c, i: q }; });
  for (const c of B) {
    const q = add(c.q);
    link(c.u, q); link(c.v, q); link(q, t);
    for (const a of starts) if (a.u === c.u && a.v === c.v) link(a.i, q); // same segment: walk straight along it
  }
  const edges = (i: number) => [...(g.adj[i] ?? []), ...(extra.get(i) ?? [])];

  const dist = new Float64Array(n + more.length).fill(Infinity);
  const prev = new Int32Array(n + more.length).fill(-1);
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
  push(d(node(s), node(t)), s);
  while (heap.length) {
    const [f, u] = pop();
    if (u === t) break;
    if (f - d(node(u), node(t)) > dist[u] + 1e-9) continue; // stale entry
    for (const { to, w } of edges(u)) {
      const nd = dist[u] + w;
      if (nd < dist[to]) {
        dist[to] = nd;
        prev[to] = u;
        push(nd + d(node(to), node(t)), to);
      }
    }
  }
  if (dist[t] === Infinity) return null;
  const path: LngLat[] = [];
  for (let i = t; i >= 0; i = prev[i]) path.push(node(i));
  path.reverse();
  // The walker standing a few metres off the street centreline: start on the street itself. That short leg
  // would otherwise read as a turn ("tourne à gauche dans 2 m") before the real directions.
  if (path.length > 2 && d(path[0], path[1]) <= ACCESS_M) path.shift();
  return path;
}

export function lengthM(path: LngLat[]) {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += d(path[i - 1], path[i]);
  return m;
}

export type Turn = 'left' | 'right' | 'slight-left' | 'slight-right' | 'uturn' | 'arrive';
export type Guidance = { turn: Turn; toTurnM: number; leftM: number; offM: number };

const TURN_DEG = 30; // smaller bends are just the street curving
const SIMPLIFY_M = 6; // flattens the many small vertices of curved streets

/** Turn-by-turn from where the walker is: next real turn on the route, its distance,
 *  what's left to walk, and how far the walker is from the route (to offer a new one). */
export function guidance(route: LngLat[], at: LngLat): Guidance | null {
  if (route.length < 2) return null;
  // Local metres around the walker (accurate enough over a few km).
  const kx = 111320 * Math.cos((at[1] * Math.PI) / 180), ky = 110540;
  const xy = route.map(([lon, lat]) => [(lon - at[0]) * kx, (lat - at[1]) * ky]);
  let best = Infinity, seg = 0, proj = xy[0];
  for (let i = 0; i + 1 < xy.length; i++) {
    const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
    const L = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = L ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / L)) : 0;
    const p = [ax + t * (bx - ax), ay + t * (by - ay)];
    const dd = Math.hypot(p[0], p[1]);
    if (dd < best) { best = dd; seg = i; proj = p; }
  }
  // The walker's own point stays out of the simplification: a few metres before a corner it would be merged
  // with it, and the next turn would be announced instead of this one.
  const ahead = [proj, ...simplify(xy.slice(seg + 1))];
  let walked = 0, turn: Turn = 'arrive', toTurnM = -1;
  for (let k = 1; k < ahead.length; k++) {
    const [a, b] = [ahead[k - 1], ahead[k]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (toTurnM < 0 && k + 1 < ahead.length && walked + len > 0) {
      const c = ahead[k + 1];
      const deg = ((Math.atan2(c[0] - b[0], c[1] - b[1]) - Math.atan2(b[0] - a[0], b[1] - a[1])) * 180) / Math.PI;
      const delta = ((deg + 540) % 360) - 180; // > 0: clockwise, i.e. to the right
      const abs = Math.abs(delta);
      if (abs >= TURN_DEG) {
        turn = abs > 150 ? 'uturn' : abs < 60 ? (delta > 0 ? 'slight-right' : 'slight-left') : delta > 0 ? 'right' : 'left';
        toTurnM = walked + len;
      }
    }
    walked += len;
  }
  return { turn, toTurnM: toTurnM < 0 ? walked : toTurnM, leftM: walked, offM: best };
}

// Douglas-Peucker on [x, y] metres.
function simplify(p: number[][]): number[][] {
  if (p.length < 3) return p;
  const [a, b] = [p[0], p[p.length - 1]];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let far = 0, at = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const dd = L ? Math.abs((b[0] - a[0]) * (a[1] - p[i][1]) - (a[0] - p[i][0]) * (b[1] - a[1])) / L : Math.hypot(p[i][0] - a[0], p[i][1] - a[1]);
    if (dd > far) { far = dd; at = i; }
  }
  return far <= SIMPLIFY_M ? [a, b] : [...simplify(p.slice(0, at + 1)).slice(0, -1), ...simplify(p.slice(at))];
}
