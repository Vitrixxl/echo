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

// The "link in bio": same look as the app (dark, app red, system font), one headline and the button.
// Android download; iPhone greyed out until the App Store version exists. No third-party requests.
const LOGO = `<svg width="34" height="34" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#E5484D"/>
<g fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"><path d="M64 34a20 20 0 0 1 0 32M36 34a20 20 0 0 0 0 32M73 25a33 33 0 0 1 0 50M27 25a33 33 0 0 0 0 50"/></g>
<circle cx="50" cy="50" r="7" fill="#fff"/></svg>`;
const ANDROID = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>`;
const APPLE = `<svg width="20" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 1.43c0 1.14-.42 2.2-1.25 3.03-.9.9-1.98 1.42-3.15 1.33-.15-1.1.4-2.26 1.2-3.08.88-.9 2.15-1.48 3.2-1.28zM20.5 17.2c-.56 1.3-.83 1.87-1.55 3.02-1 1.6-2.42 3.6-4.17 3.6-1.56.02-1.96-1.02-4.08-1-2.12 0-2.56 1.02-4.12 1-1.75-.02-3.1-1.83-4.1-3.42C-.33 15.95-.62 10.6 1.6 7.85c1.06-1.32 2.72-2.1 4.3-2.1 1.6 0 2.6 1.02 3.93 1.02 1.28 0 2.06-1.02 3.92-1.02 1.4 0 2.88.76 3.94 2.08-3.46 1.9-2.9 6.84.81 8.37z"/></svg>`;

const page = (n: number, hasApk: boolean) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Écho : organisons-nous face à la répression</title>
<meta name="description" content="Écho alerte les street medics quand quelqu'un est blessé en manifestation, sans internet.">
<meta property="og:title" content="Organisons-nous face à la répression">
<meta property="og:description" content="Écho alerte les street medics quand quelqu'un est blessé en manifestation, sans internet.">
<meta name="theme-color" content="#0F1115">
<style>
*{box-sizing:border-box}
body{margin:0;background:#0F1115;color:#F2F4F7;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{min-height:100svh;max-width:560px;margin:0 auto;padding:28px 24px 32px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px}
.hero{flex:1;display:flex;flex-direction:column;justify-content:center;padding:40px 0}
h1{font-size:clamp(40px,11vw,62px);line-height:1.02;font-weight:900;letter-spacing:-1.5px;margin:0;text-transform:uppercase}
h1 span{color:#E5484D}
.lead{color:#9BA1A6;font-size:17px;line-height:1.55;margin:22px 0 34px;max-width:440px}
.b{display:flex;align-items:center;justify-content:center;gap:12px;height:68px;border-radius:24px;font-weight:900;font-size:18px;letter-spacing:.3px;text-decoration:none;margin-bottom:12px}
.android{background:#E5484D;color:#fff}
.off{background:#171A21;color:#5E636B}
.off small{font-weight:700;font-size:13px}
.info{color:#9BA1A6;font-size:14px;line-height:1.55;margin:18px 2px 0}
footer{color:#5E636B;font-size:13px;line-height:1.6;border-top:1px solid #262A33;padding-top:16px}
footer a{color:#9BA1A6}
</style></head><body><main>
<div class="brand">${LOGO} Écho</div>
<div class="hero">
<h1>Organisons-nous face à <span>la répression.</span></h1>
<p class="lead">Écho alerte les street medics quand quelqu'un est blessé en manifestation. Sans internet : les téléphones se transmettent l'alerte entre eux.</p>
${hasApk
  ? `<a class="b android" href="/download">${ANDROID} TÉLÉCHARGER POUR ANDROID</a>`
  : `<div class="b off" aria-disabled="true">${ANDROID} ANDROID <small>bientôt</small></div>`}
<div class="b off" aria-disabled="true">${APPLE} IPHONE <small>bientôt</small></div>
<p class="info">L'alerte ne passe que par les téléphones à proximité qui ont l'application. Plus elle est installée, plus elle porte loin.${n > 0 ? ` ${n.toLocaleString('fr-FR')} installation${n > 1 ? 's' : ''}.` : ''}</p>
</div>
<footer>Gratuit, sans compte. Votre position n'est partagée qu'en cas d'alerte, ou en continu si vous êtes medic.<br>
Android : autorisez l'installation depuis votre navigateur après le téléchargement. Code source : <a href="https://github.com/Vitrixxl/echo">github.com/Vitrixxl/echo</a></footer>
</main></body></html>`;

if (import.meta.main) {
  const s = start(Number(process.env.PORT ?? 8787), process.env.DATA ?? './data', process.env.DEPLOY_TOKEN ?? '', process.env.TRUST_PROXY === '1');
  console.log(`echo server on :${s.port}`);
}
