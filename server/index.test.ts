import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './index';

const TOKEN = 'test-token-0123456789';
const boot = () => {
  const s = start(0, mkdtempSync(join(tmpdir(), 'echo-')), TOKEN);
  return { s, url: `http://127.0.0.1:${s.port}` };
};
const auth = { authorization: `Bearer ${TOKEN}` };

test('counts installs, once per IP per hour', async () => {
  const { s, url } = boot();
  expect(await (await fetch(url + '/count')).json()).toEqual({ count: 0 });
  expect(await (await fetch(url + '/install', { method: 'POST' })).json()).toEqual({ count: 1 });
  expect(await (await fetch(url + '/install', { method: 'POST' })).json()).toEqual({ count: 1 });
  s.stop(true);
});

test('publishes a signed update and serves it to the matching runtime only', async () => {
  const { s, url } = boot();
  const bundle = new TextEncoder().encode('console.log(1)');
  const sha = createHash('sha256').update(bundle).digest('hex');
  const manifest = JSON.stringify({ id: 'x', runtimeVersion: 'rt1', launchAsset: { url: `${url}/updates/assets/${sha}` }, assets: [] });
  const publish = () => fetch(url + '/updates', { method: 'PUT', headers: auth, body: JSON.stringify({ runtimeVersion: 'rt1', manifest, signature: 'c2lnbmF0dXJlLWJ5dGVz' }) });

  expect((await fetch(url + '/updates/assets/' + sha, { method: 'PUT', body: bundle })).status).toBe(401); // no token
  expect((await publish()).status).toBe(422); // asset not uploaded yet
  expect((await fetch(url + '/updates/assets/' + 'a'.repeat(64), { method: 'PUT', headers: auth, body: bundle })).status).toBe(422); // wrong hash
  expect((await fetch(url + '/updates/assets/' + sha, { method: 'PUT', headers: auth, body: bundle })).status).toBe(200);
  expect((await publish()).status).toBe(200);

  const res = await fetch(url + '/updates/manifest', { headers: { 'expo-runtime-version': 'rt1', 'expo-platform': 'android' } });
  expect(res.status).toBe(200);
  expect(res.headers.get('expo-protocol-version')).toBe('1');
  expect(res.headers.get('expo-signature')).toContain('sig="c2lnbmF0dXJlLWJ5dGVz"');
  expect(await res.text()).toBe(manifest); // served verbatim: the signature covers these exact bytes
  const other = await fetch(url + '/updates/manifest', { headers: { 'expo-runtime-version': 'rt2', 'expo-platform': 'android' } });
  expect(other.status).toBe(204);
  expect(await (await fetch(url + '/updates/assets/' + sha)).text()).toBe('console.log(1)');
  s.stop(true);
});
