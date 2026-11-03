import { expect, test } from 'bun:test';
import { hashSecret, merge, type Alert } from './alerts';
import { decode, encodeDigest, encodeRecords } from './codec';

const now = 1_800_000_000_123;
const SECRET = 'ab'.repeat(32);
const sos: Alert = {
  id: 'a1b2c3d4e5f6a7b8c9d0e1f2', kind: 'sos', lat: 45.7641234, lon: 4.8357123, note: 'Blessure · Saignement',
  status: 'need', createdAt: now, updatedAt: now, key: hashSecret(SECRET), by: 'm-0a1b2c3d4e5f',
};
const medic: Alert = {
  id: 'm-0a1b2c3d4e5f', kind: 'medic', lat: 45.76, lon: 4.83, note: '', status: 'need',
  createdAt: now - 3_600_000, updatedAt: now, target: sos.id, state: 'help',
};

test('round trip keeps every field (coordinates to 1e-7 degree)', () => {
  const closed: Alert = { ...sos, status: 'done', proof: SECRET, doneBy: 'm-ffeeddccbbaa', doneLat: 45.7641, doneLon: 4.8357, updatedAt: now + 5 };
  const free: Alert = { ...sos, id: 'zz-not-hex', note: 'Malaise · tombé près du métro', key: hashSecret('cd'.repeat(32)) };
  const out = decode(encodeRecords([sos, medic, closed, free]));
  expect(out && 'records' in out).toBe(true);
  expect((out as { records: Alert[] }).records).toEqual([sos, medic, closed, free]);
});

test('an alert fits in one Bluetooth packet; several medic positions share one', () => {
  const packet = 185 - 3 - 6; // MTU minus ATT and our chunk header
  expect(encodeRecords([sos]).length).toBeLessThanOrEqual(packet);
  expect(encodeRecords([medic, { ...medic, id: 'm-111111111111' }, { ...medic, id: 'm-222222222222' }]).length).toBeLessThanOrEqual(packet);
  console.log('sos', encodeRecords([sos]).length, 'chars (JSON:', JSON.stringify([sos]).length + ')',
    '· medic', encodeRecords([medic]).length, '(JSON:', JSON.stringify([medic]).length + ')');
});

test('digest round trip', () => {
  const d: [string, number, number][] = [[sos.id, now, 0], [medic.id, now + 1, 0], ['x-y', 5, 2]];
  expect(decode(encodeDigest(d))).toEqual({ digest: d });
});

test('garbage decodes to nothing, never throws; decoded records still go through validation', () => {
  for (const bad of ['', 'AAAA', '!!!!', 'not base64', encodeRecords([sos]).slice(0, 20), '/'.repeat(400)]) {
    expect(() => decode(bad)).not.toThrow();
  }
  expect(decode('')).toBeNull();
  expect(decode(encodeRecords([sos]).slice(0, 24))).toBeNull(); // truncated
  // a well-formed but forged record (SOS without key) is rejected by merge as usual
  const forged = decode(encodeRecords([{ ...sos, key: undefined }])) as { records: Alert[] };
  expect(merge({}, forged.records, now)).toEqual([]);
  expect(merge({}, (decode(encodeRecords([sos])) as { records: Alert[] }).records, now).length).toBe(1);
});
