// Pure mesh-record logic, no React Native imports so it can be tested with `bun test`.
// A record is either an SOS ("someone needs a street medic") or a medic's live position.

export type Kind = 'sos' | 'medic';
export type Status = 'need' | 'taken' | 'done';

export type Alert = {
  id: string;
  kind: Kind;
  lat: number;
  lon: number;
  note: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
  target?: string; // medic only: id of the SOS this medic is heading to
};

export type Store = Record<string, Alert>;

export const SOS_TTL_MS = 6 * 60 * 60 * 1000; // SOS vanish 6h after creation
export const MEDIC_TTL_MS = 5 * 60 * 1000; // medic dot vanishes 5 min after its last ping
const RANK: Record<Status, number> = { need: 0, taken: 1, done: 2 };

const expired = (a: Alert, now: number) =>
  a.kind === 'medic' ? now - a.updatedAt >= MEDIC_TTL_MS : now - a.createdAt >= SOS_TTL_MS;

// Peers are untrusted: drop anything malformed instead of letting it into the store.
export function isValid(a: any, now = Date.now()): a is Alert {
  return (
    a && typeof a.id === 'string' && a.id.length > 0 && a.id.length <= 64 &&
    (a.kind === 'sos' || a.kind === 'medic') &&
    Number.isFinite(a.lat) && Math.abs(a.lat) <= 90 &&
    Number.isFinite(a.lon) && Math.abs(a.lon) <= 180 &&
    typeof a.note === 'string' && a.note.length <= 200 &&
    a.status in RANK &&
    (a.target === undefined || (typeof a.target === 'string' && a.target.length <= 64)) &&
    Number.isFinite(a.createdAt) && Number.isFinite(a.updatedAt) &&
    a.updatedAt >= a.createdAt &&
    a.updatedAt <= now + 5 * 60 * 1000 && // tolerate 5 min of clock drift
    !expired(a, now)
  );
}

// ponytail: last-write-wins on phone clocks, ties broken by status. Fine for
// "need -> taken -> done"; switch to vector clocks if edits get richer.
function newer(a: Alert, b: Alert) {
  return a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : RANK[a.status] > RANK[b.status];
}

/** Merges incoming records into the store (mutates it) and returns the ones that changed it. */
export function merge(store: Store, incoming: unknown[], now = Date.now()): Alert[] {
  const changed: Alert[] = [];
  for (const raw of incoming) {
    if (!isValid(raw, now)) continue;
    const a: Alert = {
      id: raw.id, kind: raw.kind, lat: raw.lat, lon: raw.lon, note: raw.note,
      status: raw.status, createdAt: raw.createdAt, updatedAt: raw.updatedAt,
      ...(raw.target ? { target: raw.target } : {}),
    };
    const cur = store[a.id];
    if (!cur || newer(a, cur)) {
      store[a.id] = a;
      changed.push(a);
    }
  }
  return changed;
}

/** Drops expired records, returns true if anything was removed. */
export function prune(store: Store, now = Date.now()) {
  let removed = false;
  for (const id in store) if (expired(store[id], now)) { delete store[id]; removed = true; }
  return removed;
}

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

export const ON_SITE_M = 40; // a medic this close to an SOS counts as "sur place"

/** Medics heading to an SOS (declared "J'y vais") and medics physically at it (GPS only). */
export function coverage(sos: Alert, medics: Alert[]) {
  let enRoute = 0, onSite = 0;
  for (const m of medics) {
    if (sos.id.startsWith(m.id.slice(2))) continue; // SOS ids start with their author's per-launch id ('m-' + id for medics)
    if (distanceM(m.lat, m.lon, sos.lat, sos.lon) <= ON_SITE_M) onSite++;
    else if (m.target === sos.id) enRoute++;
  }
  return { enRoute, onSite };
}
