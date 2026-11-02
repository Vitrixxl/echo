// Black-box tests of the Rust server (src/main.rs): each test boots the release binary on a free port.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = import.meta.dir;
const built = Bun.spawnSync(['cargo', 'build', '--release', '--quiet'], { cwd: DIR, stderr: 'inherit' });
if (built.exitCode !== 0) throw new Error('cargo build failed');

const TOKEN = 'test-token-0123456789';
const boot = async () => {
  const p = Bun.spawn([join(DIR, 'target/release/brancard-server')], {
    env: { PORT: '0', DATA: mkdtempSync(join(tmpdir(), 'brancard-')), DEPLOY_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  const reader = p.stdout.getReader();
  let out = '';
  while (!out.includes('\n')) out += new TextDecoder().decode((await reader.read()).value);
  const port = out.match(/:(\d+)/)![1];
  return { s: { stop: () => p.kill() }, url: `http://127.0.0.1:${port}` };
};
const auth = { authorization: `Bearer ${TOKEN}` };

test('counts installs, once per IP per hour', async () => {
  const { s, url } = await boot();
  expect(await (await fetch(url + '/count')).json()).toEqual({ count: 0 });
  expect(await (await fetch(url + '/install', { method: 'POST' })).json()).toEqual({ count: 1 });
  expect(await (await fetch(url + '/install', { method: 'POST' })).json()).toEqual({ count: 1 });
  s.stop();
});

test('publishes a signed update and serves it to the matching runtime only', async () => {
  const { s, url } = await boot();
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
  s.stop();
});

test('serves the tracts page: one card, the browser builds and prints the sheet', async () => {
  const { s, url } = await boot();
  const res = await fetch(url + '/tracts');
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<symbol id="card" viewBox="0 0 136.06 136.06">');
  expect(html).not.toContain('{{');
  expect(html).toContain('size:A4');
  expect(html).toContain('TÉLÉCHARGER LE PDF'); // made in the browser by tractsPdf()
  expect((await fetch(url + '/tracts.pdf', { redirect: 'manual' })).headers.get('location')).toBe('/tracts');
  expect(await (await fetch(url + '/')).text()).toContain('href="/tracts"');
  s.stop();
});

test('download button appears once an APK is uploaded, and the APK is served back', async () => {
  const { s, url } = await boot();
  expect(await (await fetch(url + '/')).text()).toContain('bientôt</small></div>');
  const apk = new Uint8Array(300_000).map((_, i) => i % 251);
  expect((await fetch(url + '/apk', { method: 'PUT', body: apk })).status).toBe(401);
  expect((await fetch(url + '/apk', { method: 'PUT', headers: auth, body: apk })).status).toBe(200);
  expect(await (await fetch(url + '/')).text()).toContain('href="/download"');
  const got = new Uint8Array(await (await fetch(url + '/download')).arrayBuffer());
  expect(got.length).toBe(apk.length);
  expect(got.every((b, i) => b === apk[i])).toBe(true);
  s.stop();
});
