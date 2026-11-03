// Pure mesh-record logic, no React Native imports so it can be tested with `bun test`.
// A record is either an SOS ("someone needs a street medic") or a medic's live position.
//
// Peers are untrusted (police or hostile people can run a modified app). So an SOS is immutable once seen:
// its position and details never change. Two ways to close it:
//  - its author: they keep a random secret and put its hash (`key`) in the SOS; closing reveals the secret
//    (`proof`), which nobody else can produce;
//  - a medic on site: the close carries the medic's position (`doneLat/doneLon`), which must be within 40 m of
//    the SOS. The normal app only offers it to a medic whose GPS is there. A modified app can still lie about
//    its position: without medic credentials, that is the limit of what a mesh with no server can check.
// A medic who arrives says how it goes in their heartbeat (`state`: "care" or "help" for reinforcements).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

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
  state?: 'care' | 'help'; // medic only, about their target: "on s'en occupe" / "besoin de renfort"
  key?: string; // SOS only: sha256 of the author's secret, hex
  proof?: string; // SOS only, when closed: the author's secret, hex
  by?: string; // SOS only: the author's medic id, when a medic raised it (so they don't count as "sur place")
  doneBy?: string; // SOS only, when closed by a medic on site: their medic id and position
  doneLat?: number;
  doneLon?: number;
};

export type Store = Record<string, Alert>;

export const SOS_TTL_MS = 6 * 60 * 60 * 1000; // SOS vanish 6h after creation
export const MEDIC_TTL_MS = 5 * 60 * 1000; // medic dot vanishes 5 min after its last ping
const RANK: Record<Status, number> = { need: 0, taken: 1, done: 2 };
// Phone clocks drift (no network for hours, wrong manual time): tolerate 10 min ahead. Beyond that it's broken or
// forged to pin a record. SOS can't be pinned anyway (immutable once seen); a medic record for 10 min at most.
export const MAX_FUTURE_MS = 10 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/; // the author's secret (32 bytes)
const HEX32 = /^[0-9a-f]{32}$/; // its key: the first 16 bytes of its sha256 (128 bits: no one finds a secret for it)
export const ON_SITE_M = 40; // a medic this close to an SOS counts as "sur place"
const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;
// Sizes in UTF-8 bytes, what the wire format holds (codec.ts): anything bigger couldn't be relayed.
const shortId = (s: unknown) => typeof s === 'string' && s.length > 0 && bytes(s) <= 63;

export const hashSecret = (secretHex: string) => bytesToHex(sha256(hexToBytes(secretHex)).slice(0, 16));
const onSiteClose = (a: any, sos: { lat: number; lon: number }) =>
  shortId(a.doneBy) && Number.isFinite(a.doneLat) && Number.isFinite(a.doneLon) &&
  distanceM(a.doneLat, a.doneLon, sos.lat, sos.lon) <= ON_SITE_M;
const opens = (proof: unknown, key: string | undefined) => typeof proof === 'string' && HEX64.test(proof) && !!key && hashSecret(proof) === key;

const expired = (a: Alert, now: number) =>
  a.kind === 'medic' ? now - a.updatedAt >= MEDIC_TTL_MS : now - a.createdAt >= SOS_TTL_MS;

// Peers are untrusted: drop anything malformed instead of letting it into the store.
export function isValid(a: any, now = Date.now()): a is Alert {
  return (
    a && shortId(a.id) &&
    (a.kind === 'sos' || a.kind === 'medic') &&
    Number.isFinite(a.lat) && Math.abs(a.lat) <= 90 &&
    Number.isFinite(a.lon) && Math.abs(a.lon) <= 180 &&
    typeof a.note === 'string' && a.note.length <= 200 && bytes(a.note) <= 255 &&
    Object.prototype.hasOwnProperty.call(RANK, a.status) &&
    (a.target === undefined || shortId(a.target)) &&
    (a.state === undefined || a.state === 'care' || a.state === 'help') &&
    (a.by === undefined || shortId(a.by)) &&
    // SOS: always a key; closed only with the matching proof; never "taken"
    (a.kind === 'medic' || (typeof a.key === 'string' && HEX32.test(a.key) &&
      (a.status === 'need' || (a.status === 'done' && (opens(a.proof, a.key) || onSiteClose(a, a)))))) &&
    Number.isFinite(a.createdAt) && Number.isFinite(a.updatedAt) &&
    a.updatedAt >= a.createdAt &&
    a.updatedAt <= now + MAX_FUTURE_MS &&
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
      ...(raw.state ? { state: raw.state } : {}),
      ...(raw.key ? { key: raw.key } : {}),
      ...(raw.proof ? { proof: raw.proof } : {}),
      ...(raw.by ? { by: raw.by } : {}),
      ...(raw.doneBy ? { doneBy: raw.doneBy, doneLat: raw.doneLat, doneLon: raw.doneLon } : {}),
    };
    const cur = store[a.id];
    if (cur && cur.kind !== a.kind) continue;
    if (a.kind === 'sos' && cur) {
      // Known SOS: content is frozen; the only accepted change is closing it, by its author (secret matching
      // the key we already hold, not one the sender supplies) or by a medic within 40 m of where it is.
      if (cur.status === 'done' || a.status !== 'done') continue;
      const close = opens(a.proof, cur.key) ? { proof: a.proof } : onSiteClose(a, cur) ? { doneBy: a.doneBy, doneLat: a.doneLat, doneLon: a.doneLon } : null;
      if (!close) continue;
      store[a.id] = { ...cur, status: 'done', ...close, updatedAt: Math.max(a.updatedAt, cur.updatedAt) };
      changed.push(store[a.id]);
    } else if (!cur || newer(a, cur)) {
      store[a.id] = a;
      changed.push(a);
    }
  }
  return changed;
}

// Sync on connect: each side sends a digest (id, version) instead of all its records, and the
// other side answers with only what is missing or older there (~45 B per entry vs ~190 B).
export type Digest = [id: string, updatedAt: number, rank: number][];
export const digest = (store: Store): Digest => Object.values(store).map((a) => [a.id, a.updatedAt, RANK[a.status]]);

/** Our records that the peer (described by its untrusted digest) lacks or has an older version of. */
export function missingFrom(store: Store, theirs: unknown): Alert[] {
  if (!Array.isArray(theirs)) return [];
  const has = new Map<string, [number, number]>();
  for (const e of theirs)
    if (Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1]) && Number.isFinite(e[2])) has.set(e[0], [e[1], e[2]]);
  return Object.values(store).filter((a) => {
    const h = has.get(a.id);
    return !h || (a.updatedAt !== h[0] ? a.updatedAt > h[0] : RANK[a.status] > h[1]);
  });
}

/** Cuts a note to what the wire format holds (255 UTF-8 bytes, 200 characters), never mid-character. */
export function fitNote(note: string) {
  let s = note.slice(0, 200);
  while (bytes(s) > 255) s = Array.from(s).slice(0, -1).join('');
  return s;
}

/** Keeps at most `max` closed SOS (the most recently closed): a flood of closed alerts can't fill memory. */
export function trimClosed(store: Store, max: number) {
  const closed = Object.values(store).filter((a) => a.kind === 'sos' && a.status === 'done');
  if (closed.length <= max) return;
  closed.sort((a, b) => a.updatedAt - b.updatedAt);
  for (const a of closed.slice(0, closed.length - max)) delete store[a.id];
}

/** How far our clock is off, in minutes, from neighbours' offsets (their time - ours, ms); null when fine.
 *  Records arrive up to ~2 min old, so "behind" shows as > +3 min and "ahead" as < -6 min. */
export function skewMinutes(offsets: number[]) {
  const s = [...offsets].sort((a, b) => a - b), m = s[Math.floor(s.length / 2)];
  return m > 3 * 60_000 || m < -6 * 60_000 ? Math.round(m / 60_000) : null;
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


/** For every SOS: medics heading to it (declared "J'y vais") and medics physically at it (GPS, within 40 m).
 *  A medic is counted at one SOS only: the one they head to, else the nearest within 40 m. Otherwise one medic
 *  standing between two close casualties would show both as cared for. The SOS author never counts. */
export function coverageAll(sos: Alert[], medics: Alert[]) {
  const out = new Map(sos.map((s) => [s.id, { enRoute: 0, onSite: 0 }]));
  const byId = new Map(sos.map((s) => [s.id, s]));
  for (const m of medics) {
    const t = m.target ? byId.get(m.target) : undefined;
    if (t) {
      if (m.id === t.by) continue;
      out.get(t.id)![distanceM(m.lat, m.lon, t.lat, t.lon) <= ON_SITE_M ? 'onSite' : 'enRoute']++;
      continue;
    }
    let best: Alert | null = null, bestM = ON_SITE_M;
    for (const s of sos) {
      if (m.id === s.by) continue;
      const d = distanceM(m.lat, m.lon, s.lat, s.lon);
      if (d <= bestM) { best = s; bestM = d; }
    }
    if (best) out.get(best.id)!.onSite++;
  }
  return out;
}

/** Coverage of one SOS (see coverageAll). */
export const coverage = (sos: Alert, medics: Alert[], all: Alert[] = [sos]) =>
  coverageAll(all.some((s) => s.id === sos.id) ? all : [...all, sos], medics).get(sos.id)!;
