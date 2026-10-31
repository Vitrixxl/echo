import { expect, test } from 'bun:test';
import { buildGraph, lengthM, shortestPath, type LngLat } from './route';

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
