import { expect, test } from 'bun:test';
import type { Alert } from './alerts';
import { Outbox } from './outbox';

const rec = (id: string, kind: 'sos' | 'medic', updatedAt = 1): Alert =>
  ({ id, kind, lat: 45.76, lon: 4.83, note: '', status: 'need', createdAt: 1, updatedAt });

// A transport that holds each send until the test releases it, like a busy radio.
function slowRadio() {
  const sent: string[] = [];
  const waiting: (() => void)[] = [];
  const transport = (_peer: string, text: string, _urgent?: boolean) => new Promise<void>((done) => { sent.push(text); waiting.push(done); });
  const next = async () => { waiting.shift()?.(); await Promise.resolve(); await Promise.resolve(); };
  return { sent, transport, next };
}

test('one message at a time; SOS jump ahead of queued medic positions; positions coalesce', async () => {
  const radio = slowRadio();
  const box = new Outbox(radio.transport, JSON.stringify, 300); // ~2 records per message
  box.push('p', [rec('m-1', 'medic', 1)]); // leaves at once (link idle)
  for (let t = 2; t <= 6; t++) box.push('p', [rec('m-1', 'medic', t)]); // medic keeps moving while busy
  box.push('p', [rec('m-2', 'medic')]);
  box.push('p', [rec('sos-1', 'sos')]); // a new alert arrives last
  expect(radio.sent.length).toBe(1); // nothing else until the first send is written
  expect(box.pending('p')).toBe(3); // m-1 (latest only), m-2, sos-1
  await radio.next();
  expect(JSON.parse(radio.sent[1]).map((a: Alert) => a.id)).toEqual(['sos-1']); // the alert first, alone
  await radio.next();
  const third = JSON.parse(radio.sent[2]) as Alert[];
  expect(third.map((a) => a.id)).toEqual(['m-1', 'm-2']); // positions share a message
  expect(third[0].updatedAt).toBe(6); // only the latest position of m-1 was kept
  await radio.next();
  expect(radio.sent.length).toBe(3);
});

test('protocol messages first; a dropped peer is forgotten; after a failed send the next push resumes', async () => {
  const radio = slowRadio();
  const box = new Outbox(radio.transport);
  box.push('p', [rec('a', 'sos')]);
  box.pushRaw('p', '{"h":[]}');
  await radio.next();
  expect(radio.sent[1]).toBe('{"h":[]}');
  box.drop('p');
  expect(box.pending('p')).toBe(0);

  let calls = 0;
  const flaky = new Outbox(() => (++calls === 1 ? Promise.reject(new Error('lost')) : Promise.resolve()));
  flaky.push('q', [rec('x', 'sos')]);
  flaky.push('q', [rec('y', 'sos')]);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toBe(1); // stops: no retry storm on a link the native side is dropping
  expect(flaky.pending('q')).toBe(2); // x put back, y still waiting
  flaky.push('q', [rec('z', 'medic')]);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toBe(4); // x, y, z all go
});

test('A sent the alert to B and is linked to C; when B relays it to C and C to A, A sends it back to neither', async () => {
  const radio = slowRadio();
  const box = new Outbox(radio.transport, JSON.stringify);
  const sos = rec('sos-1', 'sos');
  box.push('B', [sos]); // A -> B
  await radio.next();
  box.has('C', [sos]); // C sends it to A (C got it from B)
  box.push('B', [sos]); box.push('C', [sos]); // A's relay after receiving from C
  expect(radio.sent.length).toBe(1);
  expect(box.pending('B') + box.pending('C')).toBe(0);
  box.push('C', [{ ...sos, status: 'done', updatedAt: 2 }]); // a newer version still goes
  expect(radio.sent.length).toBe(2);
});

test('a queued record the neighbour gets elsewhere meanwhile is not sent', async () => {
  const radio = slowRadio();
  const box = new Outbox(radio.transport, JSON.stringify);
  box.push('B', [rec('m-1', 'medic')]); // link busy
  box.push('B', [rec('sos-1', 'sos')]);
  box.has('B', [rec('sos-1', 'sos')]); // B sends it to us first
  await radio.next();
  expect(radio.sent.length).toBe(1);
});

test('a record that cannot be encoded is dropped instead of jamming the queue', async () => {
  const radio = slowRadio();
  const enc = (l: Alert[]) => { if (l.some((a) => a.id === 'bad')) throw new Error('too long'); return JSON.stringify(l); };
  const box = new Outbox(radio.transport, enc);
  box.push('p', [rec('bad', 'sos'), rec('sos-2', 'sos')]);
  expect(JSON.parse(radio.sent[0]).map((a: Alert) => a.id)).toEqual(['sos-2']);
  expect(box.pending('p')).toBe(0);
});

test('a failed send is not counted as received: the alert goes again on the next push', async () => {
  const sent: string[] = [];
  let fail = true;
  const box = new Outbox(async (_p, text) => { sent.push(text); if (fail) throw new Error('lost'); });
  const sos = rec('sos-1', 'sos');
  box.push('B', [sos]);
  await new Promise((r) => setTimeout(r, 0));
  expect(box.pending('B')).toBe(1); // back in the queue, not marked as known
  fail = false;
  box.push('B', [sos]);
  await new Promise((r) => setTimeout(r, 0));
  expect(sent.length).toBe(2);
  box.push('B', [sos]); // now it has it
  expect(sent.length).toBe(2);
});
