/**
 * Crowd simulation of the Brancard mesh: how fast an SOS reaches the medics in a dense march, and what the
 * relaying strategy changes. Uses the app's own record logic (src/alerts.ts: merge, digest, missingFrom).
 *
 *   bun scripts/simulate-crowd.ts            all scenarios, summary table
 *
 * Model (deliberately pessimistic where unsure):
 * - A march: phones spread along a street (length x width), walking forward with jitter; some stand still.
 * - Radio: a link is possible under RANGE m (bodies absorb 2.4 GHz: 15-35 m per pair); it drops past 1.2x.
 * - Discovery: a phone below its link cap finds one random neighbour in range with some probability per second;
 *   connecting takes 2-6 s and fails 25 % of the time. A phone accepts links up to its cap.
 * - Throughput: each link carries RATE records/s per direction (BLE write-with-response, ~2 ATT packets each).
 * - Load: medics announce their position; one SOS is raised mid-run by a random civilian.
 * Measured: time for the SOS to reach 50 % / 90 % / 100 % of medics, and records queued per phone (load).
 */
import { digest, hashSecret, merge, missingFrom, type Alert, type Store } from '../src/alerts';

type Strategy = {
  name: string;
  cap: number; // links per phone
  queue: 'fifo' | 'priority'; // priority: SOS first, and only the latest position per medic waits in a queue
  pingEvery: number; // medic heartbeat when moving (s)
  pingKeepalive: number; // when still (s)
  pingMoveM: number; // minimum move to send a moving heartbeat (m)
  longLinks: boolean; // keep one slot for a far neighbour (a "bridge" that speeds up crossing the crowd)
  rotate: number; // s: at the link cap, drop the oldest idle link this often to meet new neighbours (0 = never)
};

const STRATEGIES: Strategy[] = [
  { name: 'app (nouvelle)', cap: 7, queue: 'priority', pingEvery: 20, pingKeepalive: 90, pingMoveM: 20, longLinks: false, rotate: 0 },
  { name: 'actuel', cap: 7, queue: 'fifo', pingEvery: 10, pingKeepalive: 60, pingMoveM: 0, longLinks: false, rotate: 0 },
  { name: 'priorité + pings 20 s', cap: 5, queue: 'priority', pingEvery: 20, pingKeepalive: 90, pingMoveM: 20, longLinks: false, rotate: 0 },
  { name: '+ pont', cap: 5, queue: 'priority', pingEvery: 20, pingKeepalive: 90, pingMoveM: 20, longLinks: true, rotate: 0 },
  { name: '+ pont + rotation 45 s', cap: 5, queue: 'priority', pingEvery: 20, pingKeepalive: 90, pingMoveM: 20, longLinks: true, rotate: 45 },
];

type Scenario = { name: string; phones: number; medicShare: number; length: number; width: number; still: number; rate: number };
// rate: records/s per link direction. 6 = BLE with write-with-response, half kept for overhead; 2 = congested radio
const SCENARIOS: Scenario[] = [
  { name: 'cortège 300 tél.', phones: 300, medicShare: 0.05, length: 800, width: 25, still: 0.1, rate: 6 },
  { name: 'cortège dense 1000 tél.', phones: 1000, medicShare: 0.04, length: 1000, width: 30, still: 0.1, rate: 6 },
  { name: 'dense + radio saturée, 10 % medics', phones: 1000, medicShare: 0.1, length: 1000, width: 30, still: 0.1, rate: 2 },
  { name: 'peu installée 80 tél.', phones: 80, medicShare: 0.08, length: 800, width: 25, still: 0.1, rate: 6 },
];

const RANGE = [15, 35];
const DT = 0.5; // s per tick
const SOS_AT = 120; // s: let links and heartbeats settle first
const END = 420;

// Metres -> real coordinates (Lyon), so records pass the app's validation like real ones.
const LAT = (y: number) => 45.76 + y / 111_000, LON = (x: number) => 4.83 + x / 77_700;

// Deterministic randomness, so strategies are compared on the same crowd.
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

type Phone = {
  i: number; x: number; y: number; vx: number; medic: boolean;
  store: Store; links: Map<number, Link>; pending: Map<number, number>; // peer -> time the connection completes
  lastPing: number; lastPingX: number; lastPingY: number; got: number; // time it got the SOS, -1 if not
};
type Link = { to: number; out: Alert[]; budget: number; range: number; long: boolean; since: number; used: number };

function run(sc: Scenario, st: Strategy, seed: number) {
  const r = rng(seed);
  const phones: Phone[] = Array.from({ length: sc.phones }, (_, i) => ({
    i, x: r() * sc.length, y: r() * sc.width, vx: r() < sc.still ? 0 : 0.6 + r() * 0.5, medic: r() < sc.medicShare,
    store: {}, links: new Map(), pending: new Map(), lastPing: -1e9, lastPingX: 0, lastPingY: 0, got: -1,
  }));
  const medics = phones.filter((p) => p.medic);
  const pairRange = (a: number, b: number) => RANGE[0] + ((a * 7919 + b * 104729) % 1000) / 1000 * (RANGE[1] - RANGE[0]);
  const dist = (a: Phone, b: Phone) => Math.hypot(a.x - b.x, a.y - b.y);
  let now = 0, peakQueue = 0, sent = 0, sosId = '';
  const T0 = 1_800_000_000_000; // simulated clock (ms): every phone agrees

  const enqueue = (p: Phone, to: number, recs: Alert[]) => {
    const l = p.links.get(to);
    if (!l) return;
    for (const a of recs) {
      if (st.queue === 'priority' && a.kind === 'medic') {
        const k = l.out.findIndex((x) => x.id === a.id);
        if (k >= 0) { l.out[k] = a; continue; } // only the latest position waits
      }
      l.out.push(a);
    }
    if (st.queue === 'priority') l.out.sort((x, y) => (x.kind === 'sos' ? 0 : 1) - (y.kind === 'sos' ? 0 : 1));
    peakQueue = Math.max(peakQueue, l.out.length);
  };
  const flood = (p: Phone, recs: Alert[], except = -1) => { for (const to of p.links.keys()) if (to !== except) enqueue(p, to, recs); };
  const receive = (p: Phone, from: number, recs: Alert[]) => {
    const changed = merge(p.store, recs, T0 + now * 1000);
    if (!changed.length) return;
    if (p.got < 0 && changed.some((a) => a.id === sosId)) p.got = now;
    flood(p, changed, from);
  };
  const link = (a: Phone, b: Phone, long: boolean) => {
    const range = pairRange(a.i, b.i);
    a.links.set(b.i, { to: b.i, out: [], budget: 0, range, long, since: now, used: now });
    b.links.set(a.i, { to: a.i, out: [], budget: 0, range, long, since: now, used: now });
    // connect-time sync: each side sends what the other lacks (digest exchange)
    enqueue(a, b.i, missingFrom(a.store, digest(b.store)));
    enqueue(b, a.i, missingFrom(b.store, digest(a.store)));
  };
  const unlink = (a: Phone, b: number) => { a.links.delete(b); phones[b].links.delete(a.i); };

  // Spatial grid for neighbour search.
  const CELL = RANGE[1];
  for (; now < END; now += DT) {
    const grid = new Map<string, Phone[]>();
    for (const p of phones) {
      p.x += (p.vx + (r() - 0.5) * 0.4) * DT; p.y = Math.min(sc.width, Math.max(0, p.y + (r() - 0.5) * 0.6 * DT));
      const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.y / CELL);
      grid.get(k)?.push(p) ?? grid.set(k, [p]);
    }
    const near = (p: Phone) => {
      const out: Phone[] = [], cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const q of grid.get(x + ',' + y) ?? []) if (q !== p) out.push(q);
      return out;
    };
    for (const p of phones) {
      // links that stretched too far drop
      for (const [to, l] of p.links) if (dist(p, phones[to]) > l.range * 1.2) unlink(p, to);
      // rotation: at the cap, now and then let go of the oldest idle link to meet someone new
      if (st.rotate && p.links.size >= st.cap && r() < DT / st.rotate) {
        const idle = [...p.links.values()].filter((l) => !l.long && now - l.used > 10).sort((a, b) => a.since - b.since)[0];
        if (idle) unlink(p, idle.to);
      }
      // pending connections complete (or fail)
      for (const [to, at] of p.pending) {
        if (now < at) continue;
        p.pending.delete(to);
        const q = phones[to];
        if (p.links.has(to) || dist(p, q) > pairRange(p.i, to) || r() < 0.25) continue;
        if (p.links.size >= st.cap || q.links.size >= st.cap) continue;
        link(p, q, st.longLinks && dist(p, q) > 0.7 * pairRange(p.i, to));
      }
      // discovery: a free slot looks for a neighbour (~1 per 3 s), a "bridge" slot prefers the farthest one
      if (p.links.size + p.pending.size < st.cap && r() < DT / 3) {
        const cands = near(p).filter((q) => !p.links.has(q.i) && !p.pending.has(q.i) && dist(p, q) < pairRange(p.i, q.i) && q.links.size < st.cap);
        if (cands.length) {
          const hasLong = [...p.links.values()].some((l) => l.long);
          const q = st.longLinks && !hasLong ? cands.reduce((a, b) => (dist(p, a) > dist(p, b) ? a : b)) : cands[Math.floor(r() * cands.length)];
          p.pending.set(q.i, now + 2 + r() * 4);
        }
      }
      // medic heartbeat
      if (p.medic) {
        const moved = Math.hypot(p.x - p.lastPingX, p.y - p.lastPingY);
        const due = (now - p.lastPing >= st.pingEvery && moved >= st.pingMoveM && p.vx > 0) || now - p.lastPing >= st.pingKeepalive;
        if (due) {
          p.lastPing = now; p.lastPingX = p.x; p.lastPingY = p.y;
          const rec: Alert = { id: 'm-' + p.i, kind: 'medic', lat: LAT(p.y), lon: LON(p.x), note: '', status: 'need', createdAt: T0, updatedAt: T0 + Math.round(now * 1000) };
          merge(p.store, [rec], T0 + now * 1000);
          flood(p, [rec]);
        }
      }
    }
    // the SOS
    if (!sosId && now >= SOS_AT) {
      const civ = phones.filter((p) => !p.medic);
      const a = civ[Math.floor(r() * civ.length)];
      sosId = 'sos-' + a.i;
      const rec: Alert = { id: sosId, kind: 'sos', lat: LAT(a.y), lon: LON(a.x), note: 'Blessure', status: 'need', createdAt: T0 + now * 1000, updatedAt: T0 + now * 1000, key: hashSecret('ab'.repeat(32)) };
      merge(a.store, [rec], T0 + now * 1000);
      a.got = now;
      flood(a, [rec]);
    }
    // transmit: each link direction sends up to RATE records/s
    for (const p of phones) for (const l of p.links.values()) {
      l.budget = Math.min(l.budget + sc.rate * DT, sc.rate * 2);
      while (l.budget >= 1 && l.out.length) {
        const a = l.out.shift()!;
        l.budget--; sent++; l.used = now;
        if (phones[l.to].links.has(p.i)) receive(phones[l.to], p.i, [a]);
      }
    }
  }
  const t = medics.map((m) => (m.got < 0 ? Infinity : m.got - SOS_AT)).sort((a, b) => a - b);
  const pct = (q: number) => t[Math.min(t.length - 1, Math.floor(q * t.length))];
  const fmt = (v: number) => (v === Infinity ? 'jamais' : v.toFixed(0) + ' s');
  const reached = t.filter((v) => v !== Infinity).length;
  const links = phones.reduce((s, p) => s + p.links.size, 0) / phones.length;
  return { p50: fmt(pct(0.5)), p90: fmt(pct(0.9)), reached: `${reached}/${medics.length}`, links: links.toFixed(1), peakQueue, perPhone: (sent / phones.length / END).toFixed(1) };
}

for (const sc of SCENARIOS) {
  console.log(`\n## ${sc.name} (${sc.length} m x ${sc.width} m)`);
  console.log('stratégie'.padEnd(32), 'SOS→50 % medics', 'SOS→90 %', 'atteints', 'liens/tél.', 'file max', 'msg/s/tél.');
  for (const st of STRATEGIES) {
    // three crowds per strategy, same seeds for every strategy
    const runs = [1, 2, 3].map((s) => run(sc, st, s * 97));
    for (const res of runs) console.log(st.name.padEnd(32), res.p50.padStart(15), res.p90.padStart(9), res.reached.padStart(8), res.links.padStart(10), String(res.peakQueue).padStart(8), res.perPhone.padStart(10));
  }
}
