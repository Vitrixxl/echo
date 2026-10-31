// Écho server, hosted by pihost (compose.yaml at the repo root). Stores nothing about anyone.
//   GET  /                         download page (the "link in bio")
//   GET  /download                 latest APK
//   GET  /count, POST /install     install counter (one install per IP per hour, IPs only kept in memory)
//   GET  /updates/manifest         expo-updates protocol 1: the signed manifest for the phone's runtime, or 204
//   GET  /updates/assets/:sha256   update files
//   PUT  /updates/assets/:sha256, PUT /updates, PUT /apk   uploads, `Authorization: Bearer $DEPLOY_TOKEN`
// Manifests are signed on the developer's machine (scripts/deploy.ts); this server only relays them, so taking it
// over is not enough to push code to phones.
// Env: PORT=8787, DATA=./data, DEPLOY_TOKEN, TRUST_PROXY=1 behind Caddy.
import { Database } from 'bun:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const HOUR = 60 * 60 * 1000;
const SHA = /^[0-9a-f]{64}$/;
const RUNTIME = /^[\w.-]{1,128}$/;

export function start(port = 8787, data = './data', token = '', trustProxy = false) {
  for (const d of ['', 'assets', 'updates']) mkdirSync(join(data, d), { recursive: true });
  const db = new Database(join(data, 'stats.sqlite'), { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)');
  db.run('INSERT OR IGNORE INTO counter VALUES (1, 0)');
  const get = db.query<{ n: number }, []>('SELECT n FROM counter WHERE id = 1');
  const inc = db.query<{ n: number }, []>('UPDATE counter SET n = n + 1 WHERE id = 1 RETURNING n');
  const count = () => get.get()!.n;

  // ponytail: per-process map; use a shared store if this ever runs as several instances.
  const seen = new Map<string, number>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, at] of seen) if (now - at > HOUR) seen.delete(ip);
  }, HOUR).unref();

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const authorized = (req: Request) => {
    const got = Buffer.from(req.headers.get('authorization') ?? '');
    const want = Buffer.from(`Bearer ${token}`);
    return token.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
  };
  // Write next to the target then rename: a phone never reads a half-written file.
  const save = async (path: string, body: ArrayBuffer | string) => {
    await Bun.write(path + '.tmp', body);
    renameSync(path + '.tmp', path);
  };
  const apk = join(data, 'echo.apk');

  return Bun.serve({
    port,
    maxRequestBodySize: 200 * 1024 * 1024,
    async fetch(req, server) {
      const { pathname } = new URL(req.url);
      const m = req.method;

      if (m === 'GET' && pathname === '/') return new Response(page(count(), existsSync(apk)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (m === 'GET' && pathname === '/download') {
        if (!existsSync(apk)) return json({ error: 'no apk yet' }, 404);
        return new Response(Bun.file(apk), {
          headers: { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="Echo.apk"' },
        });
      }
      if (m === 'GET' && pathname === '/count') return json({ count: count() });
      if (m === 'POST' && pathname === '/install') {
        const ip = (trustProxy && req.headers.get('x-forwarded-for')?.split(',')[0].trim()) || server.requestIP(req)?.address || '?';
        const now = Date.now();
        if (now - (seen.get(ip) ?? 0) < HOUR) return json({ count: count() });
        seen.set(ip, now);
        return json({ count: inc.get()!.n });
      }

      if (m === 'GET' && pathname === '/updates/manifest') {
        const runtime = req.headers.get('expo-runtime-version') ?? '';
        const platform = req.headers.get('expo-platform') ?? 'android';
        const file = join(data, 'updates', `${runtime}.json`);
        const h: Record<string, string> = { 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'cache-control': 'private, max-age=0' };
        if (platform !== 'android' || !RUNTIME.test(runtime) || !existsSync(file)) return new Response(null, { status: 204, headers: h });
        const u = await Bun.file(file).json();
        h['expo-signature'] = `sig="${u.signature}", keyid="main", alg="rsa-v1_5-sha256"`;
        h['content-type'] = 'application/json';
        return new Response(u.manifest, { headers: h });
      }
      const asset = pathname.match(/^\/updates\/assets\/([0-9a-f]{64})$/);
      if (m === 'GET' && asset) {
        const file = join(data, 'assets', asset[1]);
        if (!existsSync(file)) return json({ error: 'no such asset' }, 404);
        return new Response(Bun.file(file), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } });
      }

      if (m === 'PUT' && (asset || pathname === '/updates' || pathname === '/apk')) {
        if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
        if (asset) {
          const body = await req.arrayBuffer();
          if (createHash('sha256').update(new Uint8Array(body)).digest('hex') !== asset[1]) return json({ error: 'hash mismatch' }, 422);
          await save(join(data, 'assets', asset[1]), body);
          return json({ ok: true });
        }
        if (pathname === '/apk') {
          await save(apk, await req.arrayBuffer());
          return json({ ok: true });
        }
        // { runtimeVersion, manifest: <signed JSON text>, signature: <base64> }
        const u = await req.json().catch(() => null);
        if (!u || !RUNTIME.test(u.runtimeVersion) || typeof u.manifest !== 'string' || typeof u.signature !== 'string' || !/^[A-Za-z0-9+/=]{16,1024}$/.test(u.signature))
          return json({ error: 'runtimeVersion, manifest and signature are required' }, 422);
        const man = JSON.parse(u.manifest);
        if (man.runtimeVersion !== u.runtimeVersion) return json({ error: 'manifest runtimeVersion mismatch' }, 422);
        const missing = [man.launchAsset, ...man.assets]
          .map((a: { url: string }) => a.url.split('/').pop()!)
          .filter((h: string) => !SHA.test(h) || !existsSync(join(data, 'assets', h)));
        if (missing.length) return json({ error: 'missing assets', missing }, 422);
        await save(join(data, 'updates', `${u.runtimeVersion}.json`), JSON.stringify(u));
        return json({ ok: true, id: man.id });
      }
      return json({ error: 'not found' }, 404);
    },
  });
}

const page = (n: number, hasApk: boolean) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Écho</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0F1115;color:#F2F4F7;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:420px;padding:32px 24px}h1{font-size:40px;margin:0 0 8px}p{color:#9BA1A6;line-height:1.5}
a.b{display:block;text-align:center;background:#E5484D;color:#fff;text-decoration:none;font-weight:800;padding:18px;border-radius:18px;margin:28px 0 12px}
small{color:#9BA1A6}
</style></head><body><main>
<h1>Écho</h1>
<p>Alertes pour les street medics, qui passent de téléphone en téléphone, sans internet. Plus on est nombreux à l'avoir dans le cortège, plus l'alerte va loin.</p>
${hasApk ? '<a class="b" href="/download">Télécharger pour Android</a>' : '<p><b>Bientôt disponible.</b></p>'}
<small>${n.toLocaleString('fr-FR')} ${n > 1 ? 'personnes ont' : 'personne a'} installé Écho. Après le téléchargement, autorise l'installation depuis ton navigateur.</small>
</main></body></html>`;

if (import.meta.main) {
  const s = start(Number(process.env.PORT ?? 8787), process.env.DATA ?? './data', process.env.DEPLOY_TOKEN ?? '', process.env.TRUST_PROXY === '1');
  console.log(`echo server on :${s.port}`);
}
