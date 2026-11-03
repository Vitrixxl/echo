// What each neighbour still has to receive, sent one message at a time at the radio's real pace.
// Pure logic (no React Native) so it is tested with `bun test`; mesh.ts plugs in the transports.
//
// Why (scripts/simulate-crowd.ts): with a saturated radio, a plain first-in-first-out queue buries a new SOS behind
// thousands of medic positions, and many medics never get it. Here:
//  - SOS records (new alerts, closures) always go first, in a message of their own: an alert never waits
//    behind a batch of medic positions being written;
//  - each message fits in one Bluetooth packet (`budget` characters), so the radio is never busy for long;
//  - each record waits once per neighbour, in its latest version: a medic who moved 5 times while the link was
//    busy costs one send, not five;
//  - the next message leaves only when the transport says the previous one is written (no timers, so it keeps
//    going with the screen off, when the app's timers are frozen);
//  - nothing goes to a neighbour that already has it: what it sent us, and what we sent it, are remembered per
//    neighbour (A sent the alert to B; when C relays it to A, A doesn't send it back to B, nor to C). Checked
//    again just before sending, since the neighbour may have got it from someone else meanwhile.
import type { Alert } from './alerts';

const RANK = { need: 0, taken: 1, done: 2 } as const;
/** A record's version: a later update, or the same instant with a further status, is newer. */
const version = (a: Alert) => a.updatedAt * 4 + RANK[a.status];

export type Transport = (peer: string, text: string, urgent: boolean) => Promise<unknown>;

export class Outbox {
  private wait = new Map<string, { raw: string[]; recs: Map<string, Alert>; busy: boolean }>();
  private known = new Map<string, Map<string, number>>(); // neighbour -> record id -> version it has
  constructor(
    private transport: Transport,
    private encode: (list: Alert[]) => string = JSON.stringify,
    private budget = 176, // one BLE packet: MTU 185 minus ATT (3) and our chunk header (6)
  ) {}

  private q(peer: string) {
    let q = this.wait.get(peer);
    if (!q) this.wait.set(peer, (q = { raw: [], recs: new Map(), busy: false }));
    return q;
  }

  /** This neighbour has these records (it sent them to us, or we sent them to it). */
  has(peer: string, list: Alert[]) {
    let k = this.known.get(peer);
    if (!k) this.known.set(peer, (k = new Map()));
    for (const a of list) if ((k.get(a.id) ?? -1) < version(a)) k.set(a.id, version(a));
    if (k.size > 2000) for (const id of [...k.keys()].slice(0, 500)) k.delete(id); // long-lived link: forget the oldest
  }

  private hasAlready(peer: string, a: Alert) {
    return (this.known.get(peer)?.get(a.id) ?? -1) >= version(a);
  }

  /** Records for this neighbour, minus what it already has; a newer version replaces the one still waiting. */
  push(peer: string, list: Alert[]) {
    const q = this.q(peer);
    for (const a of list) if (!this.hasAlready(peer, a)) q.recs.set(a.id, a);
    this.pump(peer);
  }

  /** A protocol message (digest), sent before any record. */
  pushRaw(peer: string, text: string) {
    this.q(peer).raw.push(text);
    this.pump(peer);
  }

  /** Neighbour gone: forget what it was owed and what it had. */
  drop(peer: string) {
    this.wait.delete(peer);
    this.known.delete(peer);
  }

  pending(peer: string) {
    const q = this.wait.get(peer);
    return q ? q.raw.length + q.recs.size : 0;
  }

  private pump(peer: string) {
    const q = this.wait.get(peer);
    if (!q || q.busy) return;
    let text = q.raw.shift(), urgent = false;
    if (text === undefined) {
      for (const [id, a] of q.recs) if (this.hasAlready(peer, a)) q.recs.delete(id); // got it elsewhere meanwhile
      if (!q.recs.size) return;
      const all = [...q.recs.values()];
      const sos = all.filter((a) => a.kind === 'sos');
      const pool = sos.length ? sos : all; // alerts alone, before anything else
      // As many as fit in one packet (at least one: a bigger record is split by the transport).
      let batch = [pool[0]];
      text = this.encode(batch);
      for (const a of pool.slice(1)) {
        const t = this.encode([...batch, a]);
        if (t.length > this.budget) break;
        batch = [...batch, a];
        text = t;
      }
      for (const a of batch) q.recs.delete(a.id);
      this.has(peer, batch);
      urgent = sos.length > 0;
    }
    q.busy = true;
    this.transport(peer, text, urgent)
      .catch(() => {}) // a lost link is dropped by its disconnect event; the records reach it again on reconnect
      .finally(() => {
        q.busy = false;
        if (this.wait.get(peer) === q) this.pump(peer);
      });
  }
}
