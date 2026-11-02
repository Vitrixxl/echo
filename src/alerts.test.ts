import { expect, test } from 'bun:test';
import { coverage, digest, MEDIC_TTL_MS, merge, missingFrom, prune, SOS_TTL_MS, type Alert, type Store } from './alerts';

const now = 1_000_000_000_000;
const base: Alert = { id: 'a', kind: 'sos', lat: 48.85, lon: 2.35, note: '', status: 'need', createdAt: now, updatedAt: now };
const medic: Alert = { ...base, id: 'm-1', kind: 'medic' };

test('gossip converges across a chain of 3 phones', () => {
  const [p1, p2, p3]: Store[] = [{}, {}, {}];
  // p1 raises, floods to p2, p2 forwards only what changed to p3
  const fwd = merge(p2, merge(p1, [base], now), now);
  merge(p3, fwd, now);
  expect(p3.a.status).toBe('need');
  // p3 takes it; update flows back
  const taken = { ...base, status: 'taken' as const, updatedAt: now + 1 };
  merge(p1, merge(p2, merge(p3, [taken], now), now), now);
  expect(p1.a.status).toBe('taken');
  // re-delivery of an old copy is a no-op, so flooding stops
  expect(merge(p1, [base], now)).toEqual([]);
});

test('same timestamp: further status wins on every phone', () => {
  const s1: Store = {}, s2: Store = {};
  const done = { ...base, status: 'done' as const };
  merge(s1, [base, done], now);
  merge(s2, [done, base], now);
  expect(s1.a.status).toBe('done');
  expect(s2.a.status).toBe('done');
});

test('medic position: newest ping wins, disappears when pings stop', () => {
  const s: Store = {};
  merge(s, [medic], now);
  merge(s, [{ ...medic, lat: 48.86, updatedAt: now + 30_000 }], now);
  expect(s['m-1'].lat).toBe(48.86);
  expect(prune(s, now + 30_000 + MEDIC_TTL_MS - 1)).toBe(false);
  expect(prune(s, now + 30_000 + MEDIC_TTL_MS)).toBe(true);
  expect(s).toEqual({});
});

test('rejects garbage and expired records, prunes old SOS', () => {
  const s: Store = {};
  expect(merge(s, [
    null, 42, { ...base, lat: 999 }, { ...base, kind: 'x' }, { ...base, note: 'x'.repeat(500) },
    { ...base, createdAt: now - SOS_TTL_MS, updatedAt: now - SOS_TTL_MS },
    { ...medic, createdAt: now - MEDIC_TTL_MS, updatedAt: now - MEDIC_TTL_MS },
  ], now)).toEqual([]);
  merge(s, [base], now);
  prune(s, now + SOS_TTL_MS);
  expect(s).toEqual({});
});

test('coverage: en route by declaration, sur place by GPS distance', () => {
  const far = { ...medic, id: 'm-2', lat: 48.86, target: 'a' }; // ~1.1 km away, heading there
  const near = { ...medic, id: 'm-3', lat: 48.8502 }; // ~22 m away, no declaration
  const other = { ...medic, id: 'm-4', lat: 48.87, target: 'zzz' };
  expect(coverage(base, [far, near, other])).toEqual({ enRoute: 1, onSite: 1 });
  const s: Store = {};
  merge(s, [far], now);
  expect(s['m-2'].target).toBe('a'); // target survives the wire
});

test("coverage: the medic who raised the SOS doesn't count as sur place", () => {
  const author = { ...medic, id: 'm-abc123' };
  expect(coverage({ ...base, id: 'abc123xyz' }, [author])).toEqual({ enRoute: 0, onSite: 0 });
});

test('digest sync: each side sends only what the other lacks or has older', () => {
  const a: Store = {}, b: Store = {};
  const shared = { ...base, id: 's' };
  merge(a, [shared, { ...base, id: 'onlyA' }, { ...base, id: 'x', status: 'done', updatedAt: now + 5 }], now);
  merge(b, [shared, { ...base, id: 'onlyB' }, { ...base, id: 'x' }], now);
  const toB = missingFrom(a, digest(b)), toA = missingFrom(b, digest(a));
  expect(toB.map((r) => r.id).sort()).toEqual(['onlyA', 'x']); // not 'shared': same version
  expect(toA.map((r) => r.id)).toEqual(['onlyB']); // b's 'x' is older, not sent
  merge(a, toA, now); merge(b, toB, now);
  expect(digest(a).sort()).toEqual(digest(b).sort());
  // same time, further status wins, like merge
  expect(missingFrom({ x: { ...base, id: 'x', status: 'taken' } }, [['x', now, 0]]).length).toBe(1);
  // untrusted peer: a non-list digest gets nothing, junk entries are ignored (= peer has nothing)
  expect(missingFrom(a, 'nope')).toEqual([]);
  expect(missingFrom(a, [[1, 2], null, ['s', 'x', 0]]).length).toBe(Object.keys(a).length);
});
