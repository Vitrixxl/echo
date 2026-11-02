import { expect, test } from 'bun:test';
import { coverage, coverageAll, digest, hashSecret, MAX_FUTURE_MS, MEDIC_TTL_MS, merge, missingFrom, prune, SOS_TTL_MS, type Alert, type Store } from './alerts';

const now = 1_000_000_000_000;
const SECRET = 'ab'.repeat(32);
const KEY = hashSecret(SECRET);
const base: Alert = { id: 'a', kind: 'sos', lat: 48.85, lon: 2.35, note: '', status: 'need', createdAt: now, updatedAt: now, key: KEY };
const closed: Alert = { ...base, status: 'done', proof: SECRET, updatedAt: now + 1 };
const medic: Alert = { id: 'm-1', kind: 'medic', lat: 48.85, lon: 2.35, note: '', status: 'need', createdAt: now, updatedAt: now };

test('gossip converges across a chain of 3 phones, author closes it everywhere', () => {
  const [p1, p2, p3]: Store[] = [{}, {}, {}];
  // p1 raises, floods to p2, p2 forwards only what changed to p3
  merge(p3, merge(p2, merge(p1, [base], now), now), now);
  expect(p3.a.status).toBe('need');
  // the author (on p3) closes it with the secret; the close flows back
  merge(p1, merge(p2, merge(p3, [closed], now), now), now);
  expect(p1.a.status).toBe('done');
  // re-delivery of an old copy is a no-op, so flooding stops
  expect(merge(p1, [base, closed], now)).toEqual([]);
});

test('nobody but the author can close, move or rewrite an SOS', () => {
  const s: Store = {};
  merge(s, [base], now);
  const forged = [
    { ...base, status: 'done', updatedAt: now + 50_000 }, // no proof
    { ...base, status: 'done', proof: 'cd'.repeat(32), updatedAt: now + 50_000 }, // wrong secret
    // a whole new key and its own proof: still not the key this SOS was created with
    { ...base, status: 'done', key: hashSecret('cd'.repeat(32)), proof: 'cd'.repeat(32), updatedAt: now + 50_000 },
    { ...base, lat: 48.9, note: 'fausse adresse', updatedAt: now + 50_000 }, // move the alert
    { ...base, kind: 'medic', updatedAt: now + 50_000 }, // turn it into something else
  ];
  expect(merge(s, forged, now)).toEqual([]);
  expect(s.a).toEqual(base);
});

test('a closed SOS reaches late phones, and only with a valid proof', () => {
  const s: Store = {};
  expect(merge(s, [{ ...closed, proof: 'cd'.repeat(32) }], now)).toEqual([]);
  expect(merge(s, [closed], now).length).toBe(1);
  expect(s.a.status).toBe('done');
});

test('medic position: newest ping wins, disappears when pings stop', () => {
  const s: Store = {};
  merge(s, [medic], now);
  merge(s, [{ ...medic, lat: 48.86, updatedAt: now + 30_000, target: 'a', state: 'help' }], now + 30_000);
  expect(s['m-1'].lat).toBe(48.86);
  expect(s['m-1'].state).toBe('help'); // survives the wire
  expect(prune(s, now + 30_000 + MEDIC_TTL_MS - 1)).toBe(false);
  expect(prune(s, now + 30_000 + MEDIC_TTL_MS)).toBe(true);
  expect(s).toEqual({});
});

test('rejects garbage, forged timestamps and expired records, prunes old SOS', () => {
  const s: Store = {};
  expect(merge(s, [
    null, 42, { ...base, lat: 999 }, { ...base, kind: 'x' }, { ...base, note: 'x'.repeat(500) },
    { ...base, key: undefined }, { ...base, key: 'nothex' }, { ...base, status: 'taken' },
    { ...base, status: 'toString' }, { ...medic, status: '__proto__' }, { ...medic, status: 'constructor' },
    { ...medic, updatedAt: now + MAX_FUTURE_MS + 1 }, // "newer than anything" to pin a record
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
  expect(coverage({ ...base, by: 'm-abc123' }, [author])).toEqual({ enRoute: 0, onSite: 0 });
  expect(coverage(base, [author])).toEqual({ enRoute: 0, onSite: 1 });
});

test('digest sync: each side sends only what the other lacks or has older', () => {
  const a: Store = {}, b: Store = {};
  merge(a, [{ ...base, id: 's' }, { ...base, id: 'onlyA' }, { ...closed, id: 'x' }], now);
  merge(b, [{ ...base, id: 's' }, { ...base, id: 'onlyB' }, { ...base, id: 'x' }], now);
  const toB = missingFrom(a, digest(b)), toA = missingFrom(b, digest(a));
  expect(toB.map((r) => r.id).sort()).toEqual(['onlyA', 'x']); // not 's': same version
  expect(toA.map((r) => r.id)).toEqual(['onlyB']); // b's 'x' is older, not sent
  merge(a, toA, now); merge(b, toB, now);
  expect(digest(a).sort()).toEqual(digest(b).sort());
  // untrusted peer: a non-list digest gets nothing, junk entries are ignored (= peer has nothing)
  expect(missingFrom(a, 'nope')).toEqual([]);
  expect(missingFrom(a, [[1, 2], null, ['s', 'x', 0]]).length).toBe(Object.keys(a).length);
});

test('a medic counts at one SOS only: two casualties 30 m apart are not both "sur place"', () => {
  const a = { ...base, id: 'a' }, b = { ...base, id: 'b', lat: 48.85027 }; // ~30 m north
  const m = { ...medic, lat: 48.85012 }; // between them, no declaration
  const cov = coverageAll([a, b], [m]);
  expect(cov.get('a')!.onSite + cov.get('b')!.onSite).toBe(1);
  // heading to b, standing at a: counted at b (en route), not at a
  const going = coverageAll([a, b], [{ ...medic, lat: 48.85, lon: 2.35, target: 'b' }]);
  expect(going.get('a')).toEqual({ enRoute: 0, onSite: 0 });
  expect(going.get('b')!.onSite + going.get('b')!.enRoute).toBe(1);
});

test('a phone whose clock is a few minutes off still gets through', () => {
  const s: Store = {};
  expect(merge(s, [{ ...base, createdAt: now + 4 * 60_000, updatedAt: now + 4 * 60_000 }], now).length).toBe(1);
});

test('a medic on site can close an SOS, one far away cannot', () => {
  const s: Store = {};
  merge(s, [base], now);
  const far = { ...base, status: 'done', doneBy: 'm-9', doneLat: 48.86, doneLon: 2.35, updatedAt: now + 1 }; // ~1 km
  expect(merge(s, [far], now)).toEqual([]);
  const there = { ...base, status: 'done', doneBy: 'm-9', doneLat: 48.8502, doneLon: 2.35, updatedAt: now + 1 }; // ~22 m
  expect(merge(s, [there], now).length).toBe(1);
  expect(s.a.status).toBe('done');
  expect(s.a.doneBy).toBe('m-9');
  // the position checked is the SOS we hold, not one the closer sends along
  const t: Store = {};
  merge(t, [base], now);
  expect(merge(t, [{ ...there, lat: 48.8502, doneLat: 48.8502 + 0.0001 }], now).length).toBe(1);
  const u: Store = {};
  merge(u, [base], now);
  expect(merge(u, [{ ...far, lat: 48.86 }], now)).toEqual([]);
});
