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
//    going with the screen off, when the app's timers are frozen).
import type { Alert } from './alerts';

export type Transport = (peer: string, text: string) => Promise<unknown>;

export class Outbox {
  private wait = new Map<string, { raw: string[]; recs: Map<string, Alert>; busy: boolean }>();
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

  /** Records for this neighbour; a newer version replaces the one still waiting. */
  push(peer: string, list: Alert[]) {
    const q = this.q(peer);
    for (const a of list) q.recs.set(a.id, a);
    this.pump(peer);
  }

  /** A protocol message (digest), sent before any record. */
  pushRaw(peer: string, text: string) {
    this.q(peer).raw.push(text);
    this.pump(peer);
  }

  /** Neighbour gone: forget what it was owed. */
  drop(peer: string) {
    this.wait.delete(peer);
  }

  pending(peer: string) {
    const q = this.wait.get(peer);
    return q ? q.raw.length + q.recs.size : 0;
  }

  private pump(peer: string) {
    const q = this.wait.get(peer);
    if (!q || q.busy) return;
    let text = q.raw.shift();
    if (text === undefined) {
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
    }
    q.busy = true;
    this.transport(peer, text)
      .catch(() => {}) // a lost link is dropped by its disconnect event; the records reach it again on reconnect
      .finally(() => {
        q.busy = false;
        if (this.wait.get(peer) === q) this.pump(peer);
      });
  }
}
