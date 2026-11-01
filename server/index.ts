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

// The "link in bio": Android download, iPhone greyed out until the App Store version exists.
const LOGO = `<svg width="72" height="72" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#E5484D"/>
<g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"><path d="M64 34a20 20 0 0 1 0 32M36 34a20 20 0 0 0 0 32M73 25a33 33 0 0 1 0 50M27 25a33 33 0 0 0 0 50"/></g>
<circle cx="50" cy="50" r="6" fill="#fff"/></svg>`;
const ANDROID = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>`;
const APPLE = `<svg width="20" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 1.43c0 1.14-.42 2.2-1.25 3.03-.9.9-1.98 1.42-3.15 1.33-.15-1.1.4-2.26 1.2-3.08.88-.9 2.15-1.48 3.2-1.28zM20.5 17.2c-.56 1.3-.83 1.87-1.55 3.02-1 1.6-2.42 3.6-4.17 3.6-1.56.02-1.96-1.02-4.08-1-2.12 0-2.56 1.02-4.12 1-1.75-.02-3.1-1.83-4.1-3.42C-.33 15.95-.62 10.6 1.6 7.85c1.06-1.32 2.72-2.1 4.3-2.1 1.6 0 2.6 1.02 3.93 1.02 1.28 0 2.06-1.02 3.92-1.02 1.4 0 2.88.76 3.94 2.08-3.46 1.9-2.9 6.84.81 8.37z"/></svg>`;

const page = (n: number, hasApk: boolean) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Écho : alertes street medic sans internet</title>
<meta name="description" content="Alertes pour les street medics, qui passent de téléphone en téléphone, sans internet.">
<meta name="theme-color" content="#0F1115">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0F1115;color:#F2F4F7;min-height:100vh;display:flex;align-items:center;justify-content:center}
main{width:100%;max-width:440px;padding:40px 24px}
h1{font-size:44px;margin:20px 0 6px;letter-spacing:-.5px}
.lead{color:#C9CDD1;font-size:18px;line-height:1.5;margin:0 0 28px}
.b{display:flex;align-items:center;justify-content:center;gap:12px;height:62px;border-radius:18px;font-weight:800;font-size:17px;text-decoration:none;margin-bottom:12px}
.android{background:#E5484D;color:#fff}
.off{background:#1D2027;color:#5E636B;border:1px solid #262A33;cursor:not-allowed}
.off span{font-weight:600;font-size:13px;margin-left:4px}
ul{list-style:none;padding:0;margin:28px 0 0;color:#9BA1A6;font-size:15px;line-height:1.5}
li{display:flex;gap:10px;margin-bottom:10px}li b{color:#F2F4F7}
.count{margin-top:28px;padding:14px 16px;border-radius:14px;background:#171A21;color:#C9CDD1;font-size:15px}
.count b{color:#fff}
small{display:block;color:#6B7076;font-size:13px;margin-top:20px;line-height:1.5}
</style></head><body><main>
${LOGO}
<h1>Écho</h1>
<p class="lead">Une alerte pour appeler un street medic, qui passe de téléphone en téléphone, <b>sans internet</b>.</p>
${hasApk
  ? `<a class="b android" href="/download">${ANDROID} Télécharger pour Android</a>`
  : `<div class="b off" aria-disabled="true">${ANDROID} Android <span>bientôt</span></div>`}
<div class="b off" aria-disabled="true">${APPLE} iPhone <span>bientôt</span></div>
<ul>
<li>📶 <span><b>Sans réseau :</b> l'alerte passe par les téléphones à proximité qui ont l'app.</span></li>
<li>🧑‍⚕️ <span><b>Pour les medics :</b> l'alerte, le chemin, qui est déjà en route.</span></li>
<li>🔒 <span><b>Pas de compte,</b> ta position ne part que si tu demandes de l'aide.</span></li>
</ul>
<div class="count"><b>${n.toLocaleString('fr-FR')}</b> ${n > 1 ? 'personnes ont' : 'personne a'} installé Écho. Plus on est nombreux, plus l'alerte va loin : fais passer.</div>
<small>Android : après le téléchargement, autorise l'installation depuis ton navigateur. Code source : <a href="https://github.com/Vitrixxl/echo" style="color:#9BA1A6">github.com/Vitrixxl/echo</a></small>
</main></body></html>`;

if (import.meta.main) {
  const s = start(Number(process.env.PORT ?? 8787), process.env.DATA ?? './data', process.env.DEPLOY_TOKEN ?? '', process.env.TRUST_PROXY === '1');
  console.log(`echo server on :${s.port}`);
}
