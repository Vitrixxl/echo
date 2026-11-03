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

test('protocol messages first; a dropped peer is forgotten; a failed send does not block the queue', async () => {
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
  expect(calls).toBe(2);
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
