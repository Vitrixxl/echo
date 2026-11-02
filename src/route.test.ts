import { expect, test } from 'bun:test';
import { buildGraph, guidance, lengthM, shortestPath, type LngLat } from './route';

// ~100 m blocks around Paris. Streets: a U shape from A to B, plus a dead end.
const o: LngLat = [2.35, 48.85];
const at = (x: number, y: number): LngLat => [o[0] + x * 0.00136, o[1] + y * 0.0009];

test('walks around the block instead of through it', () => {
  const lines = [
    [at(0, 0), at(0, 1), at(1, 1)], // A up then right
    // tile seam: same street split in two, endpoints 1 m apart
    [at(1, 1), [at(2, 1)[0], at(2, 1)[1] + 0.000009] as LngLat],
    [at(2, 1), at(2, 0)], // down to B
    [at(1, 0), at(1, -1)], // dead end, unconnected to A or B
  ];
  const p = shortestPath(buildGraph(lines), at(0, 0), at(2, 0))!;
  expect(p).not.toBeNull();
  const m = lengthM(p);
  expect(m).toBeGreaterThan(390); // 100 up + 200 across + 100 down
  expect(m).toBeLessThan(420);
});

test('no route when disconnected or far from any road', () => {
  const g = buildGraph([[at(0, 0), at(0, 1)], [at(5, 0), at(5, 1)]]);
  expect(shortestPath(g, at(0, 0), at(5, 0))).toBeNull();
  expect(shortestPath(g, at(0, 0), at(20, 20))).toBeNull();
});

test('T-junction whose shared vertex was simplified away still connects', () => {
  // main street A-B; side street ends 4 m short of it (vertex lost in the tile), target is on the side street
  const lines = [[at(0, 0), at(4, 0)], [[at(2, 0)[0], at(2, 0)[1] + 0.000036] as LngLat, at(2, 2)]];
  const p = shortestPath(buildGraph(lines), at(0, 0), at(2, 2));
  expect(p).not.toBeNull();
  expect(lengthM(p!)).toBeLessThan(430); // 200 along + ~200 up, no detour
});

test('guidance: next turn, its side and distance, ignoring street curves', () => {
  // North 200 m (with a slight 3 m wiggle), then east 100 m: a right turn 200 m ahead.
  const r: LngLat[] = [at(0, 0), at(0.01, 0.5), at(0, 1), at(0.01, 1.5), at(0, 2), at(1, 2)];
  const g = guidance(r, at(0, 0))!;
  expect(g.turn).toBe('right');
  expect(Math.abs(g.toTurnM - 200)).toBeLessThan(8);
  expect(Math.abs(g.leftM - 300)).toBeLessThan(10);
  expect(g.offM).toBeLessThan(1);
  // Same route walked the other way: left turn 100 m ahead.
  expect(guidance([...r].reverse(), at(1, 2))!.turn).toBe('left');
  // Past the corner: nothing but the destination left; 30 m off to the side is reported.
  const end = guidance(r, at(0.5, 2.3))!;
  expect(end.turn).toBe('arrive');
  expect(Math.abs(end.leftM - 50)).toBeLessThan(5);
  expect(Math.abs(end.offM - 27)).toBeLessThan(3);
});

test('starts on the street segment, not at a vertex behind the walker', () => {
  // One long street 400 m with vertices only at its ends, then a turn north at the far end.
  const g = buildGraph([[at(0, 0), at(4, 0), at(4, 1)]]);
  // Walker 150 m along, 2 m off the street: the nearest vertex (the street's start) is behind them.
  const p = shortestPath(g, at(1.5, 0.02), at(4, 1))!;
  expect(lengthM(p)).toBeLessThan(250 * 1.0 + 100 + 10); // 250 m east + 100 m north, no walking back
  const gd = guidance(p, at(1.5, 0.02))!;
  expect(gd.turn).toBe('left');
  expect(Math.abs(gd.toTurnM - 250)).toBeLessThan(10);
});

test('walker between two streets is not sent to the nearer one first', () => {
  // Street A runs east-west 20 m south of the walker; street B runs north 25 m east of them and
  // leads to the SOS. The route must go straight to B, not down to A and back up.
  const g = buildGraph([[at(-1, -0.2), at(1, -0.2)], [at(0.25, -0.2), at(0.25, 2)]]);
  const p = shortestPath(g, at(0, 0), at(0.25, 2))!;
  expect(lengthM(p)).toBeLessThan(25 + 200 + 10); // via street A it would be 20 + 25 + 220
});
