// Compact binary wire format for the mesh, so an alert fits in a single Bluetooth packet (one radio round trip
// per hop instead of two or three with JSON). Pure, tested with `bun test` (codec.test.ts).
//
//   message  = 1 byte type (1: records, 2: digest, 3: records with the sender's mesh name), then:
//     records: [6 bytes sender name if type 3], 1 byte count, records…
//     digest:  2 bytes count, entries of [id, updatedAt (6 bytes ms), rank (1 byte)]
//   record   = flags (2 bytes), id, lat, lon (int32, 1e-7 degree ≈ 1 cm), createdAt (6 bytes ms),
//              updatedAt - createdAt (4 bytes ms), then only the optional fields present
//   id       = 1 byte: bit 7 hex, bit 6 "m-" prefix, bits 0-5 length (bytes if hex, else UTF-8 bytes), then the bytes
// Sent as base64 text: both transports (BLE module, Nearby) carry strings.
//
// Decoding trusts nothing: every read is bounds-checked, a malformed message decodes to nothing, and decoded
// records still go through isValid/merge like any other.
import type { Alert, Status } from './alerts';

/** Preset alert details: sent as bits (1 byte), and the only ones shown on iPhone (no free text there). */
export const TAGS = ['Blessure', 'Saignement', 'Gaz lacrymo', 'Malaise', 'Inconscient', 'Brûlure'];
export type Digest = [string, number, number][];

const STATUS: Status[] = ['need', 'taken', 'done'];
const STATE = [undefined, 'care', 'help'] as const;
const SEP = ' · ';
const HEX = /^(?:[0-9a-f]{2})+$/;
// fatal: invalid UTF-8 (forged ids that would no longer fit once re-encoded) rejects the whole message.
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });

// ---- writing ----
class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 0xff); }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u16(Math.floor(v / 0x10000)); this.u16(v % 0x10000); }
  u48(v: number) { this.u16(Math.floor(v / 2 ** 32)); this.u32(v % 2 ** 32); }
  i32(v: number) { this.u32(v < 0 ? v + 2 ** 32 : v); }
  bytes(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.b.push(a[i]); }
  hex(h: string) { for (let i = 0; i < h.length; i += 2) this.b.push(parseInt(h.slice(i, i + 2), 16)); }
  id(s: string) {
    const m = s.startsWith('m-') ? 0x40 : 0, body = m ? s.slice(2) : s;
    if (HEX.test(body) && body.length / 2 < 64) { this.u8(0x80 | m | (body.length / 2)); this.hex(body); return; }
    const u = enc.encode(body);
    if (u.length > 63) throw new Error('id too long');
    this.u8(m | u.length); this.bytes(u);
  }
  coord(v: number) { this.i32(Math.round(v * 1e7)); }
}

function writeRecord(w: W, a: Alert) {
  const parts = a.note ? a.note.split(SEP) : [];
  let tags = 0;
  const text: string[] = [];
  for (const p of parts) { const i = TAGS.indexOf(p); if (i >= 0 && !(tags & (1 << i))) tags |= 1 << i; else text.push(p); }
  const note = enc.encode(text.join(SEP));
  if (note.length > 255) throw new Error('note too long'); // isValid caps it; never cut a character in half
  const created = a.kind === 'medic' ? Math.max(a.createdAt, a.updatedAt - 0xffffffff) : a.createdAt; // medics: only updatedAt matters
  const f1 = (a.kind === 'medic' ? 1 : 0) | (STATUS.indexOf(a.status) << 1) | (Math.max(0, STATE.indexOf(a.state)) << 3)
    | (a.target ? 0x20 : 0) | (a.proof ? 0x40 : 0) | (a.doneBy ? 0x80 : 0);
  const f2 = (a.by ? 1 : 0) | (a.key ? 2 : 0) | (tags ? 4 : 0) | (note.length ? 8 : 0);
  w.u8(f1); w.u8(f2); w.id(a.id); w.coord(a.lat); w.coord(a.lon); w.u48(created); w.u32(a.updatedAt - created);
  if (a.target) w.id(a.target);
  if (a.proof) w.hex(a.proof);
  if (a.doneBy) { w.id(a.doneBy); w.coord(a.doneLat!); w.coord(a.doneLon!); }
  if (a.by) w.id(a.by);
  if (a.key) w.hex(a.key);
  if (tags) w.u8(tags);
  if (note.length) { w.u8(note.length); w.bytes(note); }
}

// ---- reading (every read may throw; callers catch and drop the message) ----
class R {
  i = 0;
  constructor(public b: Uint8Array) {}
  u8() { if (this.i >= this.b.length) throw new Error('short'); return this.b[this.i++]; }
  u16() { return this.u8() * 256 + this.u8(); }
  u32() { return this.u16() * 0x10000 + this.u16(); }
  u48() { return this.u16() * 2 ** 32 + this.u32(); }
  i32() { const v = this.u32(); return v >= 2 ** 31 ? v - 2 ** 32 : v; }
  take(n: number) { if (this.i + n > this.b.length) throw new Error('short'); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
  hex(n: number) { return Array.from(this.take(n), (x) => x.toString(16).padStart(2, '0')).join(''); }
  id() {
    const h = this.u8(), n = h & 0x3f, pre = h & 0x40 ? 'm-' : '';
    return pre + (h & 0x80 ? this.hex(n) : dec.decode(this.take(n)));
  }
  coord() { return this.i32() / 1e7; }
}

function readRecord(r: R): Alert {
  const f1 = r.u8(), f2 = r.u8();
  const id = r.id(), lat = r.coord(), lon = r.coord(), createdAt = r.u48(), updatedAt = createdAt + r.u32();
  const a: Alert = {
    id, kind: f1 & 1 ? 'medic' : 'sos', lat, lon, note: '', status: STATUS[(f1 >> 1) & 3] ?? ('?' as Status), createdAt, updatedAt,
  };
  const state = STATE[(f1 >> 3) & 3];
  if (state) a.state = state;
  if (f1 & 0x20) a.target = r.id();
  if (f1 & 0x40) a.proof = r.hex(32);
  if (f1 & 0x80) { a.doneBy = r.id(); a.doneLat = r.coord(); a.doneLon = r.coord(); }
  if (f2 & 1) a.by = r.id();
  if (f2 & 2) a.key = r.hex(16);
  const parts: string[] = [];
  if (f2 & 4) { const t = r.u8(); TAGS.forEach((name, i) => { if (t & (1 << i)) parts.push(name); }); }
  if (f2 & 8) parts.push(dec.decode(r.take(r.u8())));
  a.note = parts.join(SEP);
  return a;
}

// ---- base64 (no Buffer/btoa dependency: same code on Hermes and in tests) ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Map([...B64].map((c, i) => [c, i]));
function toB64(b: number[]) {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}
function fromB64(s: string) {
  if (s.length % 4) throw new Error('b64');
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (s[i + k] === '=' ? 0 : B64I.get(s[i + k])));
    if (c.some((x) => x === undefined)) throw new Error('b64');
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    out.push(n >> 16);
    if (s[i + 2] !== '=') out.push((n >> 8) & 255);
    if (s[i + 3] !== '=') out.push(n & 255);
  }
  return new Uint8Array(out);
}

// ---- public API ----
/** from: the sender's mesh name (12 hex chars), so the receiver knows which neighbour already has these. */
export function encodeRecords(list: Alert[], from?: string) {
  const w = new W();
  if (from) { w.u8(3); w.hex(from); } else w.u8(1);
  w.u8(Math.min(list.length, 255));
  for (const a of list.slice(0, 255)) writeRecord(w, a);
  return toB64(w.b);
}

export function encodeDigest(d: Digest) {
  const w = new W();
  w.u8(2); w.u16(Math.min(d.length, 0xffff));
  for (const [id, at, rank] of d.slice(0, 0xffff)) { w.id(id); w.u48(at); w.u8(rank); }
  return toB64(w.b);
}

/** A received message: records, a digest, or null when malformed (dropped). */
export function decode(text: string): { records: Alert[]; from?: string } | { digest: Digest } | null {
  try {
    const r = new R(fromB64(text));
    const type = r.u8();
    if (type === 1 || type === 3) {
      const from = type === 3 ? r.hex(6) : undefined;
      const n = r.u8(), records: Alert[] = [];
      for (let k = 0; k < n; k++) records.push(readRecord(r));
      return from ? { records, from } : { records };
    }
    if (type === 2) {
      const n = r.u16(), digest: Digest = [];
      for (let k = 0; k < n; k++) digest.push([r.id(), r.u48(), r.u8()]);
      return { digest };
    }
  } catch {}
  return null;
}
