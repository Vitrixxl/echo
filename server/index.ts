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
// Self-contained (no external fonts or scripts); animations stop with prefers-reduced-motion.
const LOGO = `<svg width="84" height="84" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="26" fill="#E5484D"/>
<g fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round"><path d="M64 34a20 20 0 0 1 0 32M36 34a20 20 0 0 0 0 32M73 25a33 33 0 0 1 0 50M27 25a33 33 0 0 0 0 50"/></g>
<circle cx="50" cy="50" r="6.5" fill="#fff"/></svg>`;
const ANDROID = `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>`;
const APPLE = `<svg width="20" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 1.43c0 1.14-.42 2.2-1.25 3.03-.9.9-1.98 1.42-3.15 1.33-.15-1.1.4-2.26 1.2-3.08.88-.9 2.15-1.48 3.2-1.28zM20.5 17.2c-.56 1.3-.83 1.87-1.55 3.02-1 1.6-2.42 3.6-4.17 3.6-1.56.02-1.96-1.02-4.08-1-2.12 0-2.56 1.02-4.12 1-1.75-.02-3.1-1.83-4.1-3.42C-.33 15.95-.62 10.6 1.6 7.85c1.06-1.32 2.72-2.1 4.3-2.1 1.6 0 2.6 1.02 3.93 1.02 1.28 0 2.06-1.02 3.92-1.02 1.4 0 2.88.76 3.94 2.08-3.46 1.9-2.9 6.84.81 8.37z"/></svg>`;
const MESH = `<svg class="mesh" viewBox="0 0 350 170" role="img" aria-label="L'alerte passe de téléphone en téléphone jusqu'aux medics"><path class="e" d="M30 82L98 40"/><path class="f" pathLength="1" style="--h:0" d="M30 82L98 40"/><path class="e" d="M30 82L98 124"/><path class="f" pathLength="1" style="--h:0" d="M30 82L98 124"/><path class="e" d="M98 40L168 22"/><path class="f" pathLength="1" style="--h:1" d="M98 40L168 22"/><path class="e" d="M98 40L168 84"/><path class="f" pathLength="1" style="--h:1" d="M98 40L168 84"/><path class="e" d="M98 124L168 84"/><path class="f" pathLength="1" style="--h:1" d="M98 124L168 84"/><path class="e" d="M98 124L168 142"/><path class="f" pathLength="1" style="--h:1" d="M98 124L168 142"/><path class="e" d="M168 22L240 52"/><path class="f" pathLength="1" style="--h:2" d="M168 22L240 52"/><path class="e" d="M168 84L240 52"/><path class="f" pathLength="1" style="--h:2" d="M168 84L240 52"/><path class="e" d="M168 84L240 118"/><path class="f" pathLength="1" style="--h:2" d="M168 84L240 118"/><path class="e" d="M168 142L240 118"/><path class="f" pathLength="1" style="--h:2" d="M168 142L240 118"/><path class="e" d="M240 52L312 26"/><path class="f" pathLength="1" style="--h:3" d="M240 52L312 26"/><path class="e" d="M240 52L312 88"/><path class="f" pathLength="1" style="--h:3" d="M240 52L312 88"/><path class="e" d="M240 118L312 88"/><path class="f" pathLength="1" style="--h:3" d="M240 118L312 88"/><path class="e" d="M240 118L318 146"/><path class="f" pathLength="1" style="--h:3" d="M240 118L318 146"/><rect class="n" style="--h:0" x="22" y="69" width="16" height="26" rx="4"/><rect class="n" style="--h:1" x="90" y="27" width="16" height="26" rx="4"/><rect class="n" style="--h:1" x="90" y="111" width="16" height="26" rx="4"/><rect class="n" style="--h:2" x="160" y="9" width="16" height="26" rx="4"/><rect class="n" style="--h:2" x="160" y="71" width="16" height="26" rx="4"/><rect class="n" style="--h:2" x="160" y="129" width="16" height="26" rx="4"/><rect class="n" style="--h:3" x="232" y="39" width="16" height="26" rx="4"/><rect class="n" style="--h:3" x="232" y="105" width="16" height="26" rx="4"/><rect class="n m" style="--h:4" x="304" y="13" width="16" height="26" rx="4"/><path class="plus" d="M312 21v10M307 26h10"/><rect class="n" style="--h:4" x="304" y="75" width="16" height="26" rx="4"/><rect class="n m" style="--h:4" x="310" y="133" width="16" height="26" rx="4"/><path class="plus" d="M318 141v10M313 146h10"/><text x="30" y="58" class="sos">SOS</text></svg>`;

const page = (n: number, hasApk: boolean) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Écho : alertes pour street medics</title>
<meta name="description" content="Application d'alerte pour les street medics en manifestation, qui fonctionne sans internet.">
<meta property="og:title" content="Écho : alertes pour street medics">
<meta property="og:description" content="Application d'alerte pour les street medics en manifestation, qui fonctionne sans internet.">
<meta name="theme-color" content="#0B0D11">
<style>
*{box-sizing:border-box}
:root{--bg:#0B0D11;--card:#14171D;--line:#22262E;--text:#F2F4F7;--muted:#9BA1A6;--red:#E5484D;--green:#30A46C}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);
  background:radial-gradient(700px 420px at 50% -8%,rgba(229,72,77,.24),transparent 70%),var(--bg);min-height:100vh}
main{max-width:460px;margin:0 auto;padding:56px 22px 40px}
.logo{position:relative;width:84px;height:84px;margin:0 auto}
.logo svg{position:relative;z-index:1;filter:drop-shadow(0 12px 30px rgba(229,72,77,.45))}
.ring{position:absolute;inset:0;border-radius:26px;border:2px solid var(--red);opacity:0;animation:ring 3s ease-out infinite}
.ring:nth-child(2){animation-delay:1s}.ring:nth-child(3){animation-delay:2s}
@keyframes ring{0%{transform:scale(1);opacity:.55}100%{transform:scale(2.3);opacity:0}}
h1{text-align:center;font-size:56px;line-height:1;margin:30px 0 16px;letter-spacing:-1.5px}
.lead{text-align:center;color:var(--muted);font-size:16.5px;line-height:1.55;margin:0 auto 30px;max-width:360px}
.b{display:flex;align-items:center;justify-content:center;gap:12px;height:62px;border-radius:18px;font-weight:800;font-size:17px;text-decoration:none;margin-bottom:12px;transition:transform .15s}
.android{background:linear-gradient(180deg,#EF5B60,#D93C41);color:#fff;box-shadow:0 14px 34px rgba(229,72,77,.38),inset 0 1px 0 rgba(255,255,255,.25)}
.android:active{transform:scale(.98)}
.off{background:rgba(255,255,255,.03);color:#5E636B;border:1px solid var(--line);cursor:not-allowed}
.pill{font-size:12px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:#8A9098;background:#1C2027;border:1px solid #2A2F38;border-radius:99px;padding:4px 9px}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:20px}
.mesh-card{margin-top:30px;padding:16px 14px 12px}
.mesh{display:block;width:100%;height:auto}
.e{fill:none;stroke:#252A33;stroke-width:2}
.f{fill:none;stroke:var(--red);stroke-width:3;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:flow 6s infinite;animation-delay:calc(var(--h) * .45s)}
@keyframes flow{0%{stroke-dashoffset:1;opacity:1}9%{stroke-dashoffset:0}72%{stroke-dashoffset:0;opacity:1}88%,100%{stroke-dashoffset:0;opacity:0}}
.n{fill:#171B22;stroke:#3A404A;stroke-width:2;animation:lit 6s infinite;animation-delay:calc(var(--h) * .45s + .3s)}
.n.m{stroke:var(--green);animation-name:litm}
@keyframes lit{0%{fill:#171B22;stroke:#3A404A}5%,72%{fill:#3B1518;stroke:var(--red)}88%,100%{fill:#171B22;stroke:#3A404A}}
@keyframes litm{0%{fill:#171B22}5%,72%{fill:#123622}88%,100%{fill:#171B22}}
.plus{stroke:var(--green);stroke-width:2.5;stroke-linecap:round}
.sos{fill:var(--red);font-size:11px;font-weight:800;text-anchor:middle;letter-spacing:.5px}
.stat{display:flex;align-items:center;gap:16px;margin-top:14px}
.stat .num{font-size:40px;font-weight:800;letter-spacing:-1px;color:#fff}
.stat p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.45}.stat p b{color:var(--text)}
h2{font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:#6B7076;margin:36px 4px 12px}
.steps{display:grid;gap:10px}
.step{display:flex;gap:14px;align-items:flex-start}
.step i{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:#1E222A;color:#fff;font-style:normal;font-weight:800;font-size:15px}
.step i.r{background:rgba(229,72,77,.16);color:var(--red)}.step i.g{background:rgba(48,164,108,.16);color:var(--green)}
.step p{margin:5px 0 0;color:var(--muted);font-size:15px;line-height:1.5}.step p b{color:var(--text)}
.note{color:var(--muted);font-size:14px;line-height:1.55;margin:16px 4px 0}
footer{margin-top:34px;text-align:center;color:#5E636B;font-size:13px;line-height:1.6}
footer a{color:#8A9098}
@media (prefers-reduced-motion:reduce){.ring,.f,.n{animation:none}.f{stroke-dashoffset:0}}
</style></head><body><main>
<div class="logo"><span class="ring"></span><span class="ring"></span><span class="ring"></span>${LOGO}</div>
<h1>Écho</h1>
<p class="lead">Application d'alerte pour les street medics en manifestation. Elle fonctionne sans internet : les téléphones se transmettent l'alerte entre eux.</p>
${hasApk
  ? `<a class="b android" href="/download">${ANDROID} Télécharger pour Android</a>`
  : `<div class="b off" aria-disabled="true">${ANDROID} Android <span class="pill">bientôt</span></div>`}
<div class="b off" aria-disabled="true">${APPLE} iPhone <span class="pill">bientôt</span></div>

<div class="card mesh-card">${MESH}</div>
${n > 0 ? `<div class="card stat"><span class="num">${n.toLocaleString('fr-FR')}</span><p>installation${n > 1 ? 's' : ''}</p></div>` : ''}

<h2>Fonctionnement</h2>
<div class="card steps">
<div class="step"><i class="r">C</i><p><b>Civil :</b> en cas de blessure, vous appuyez sur le bouton rouge et vous confirmez. L'alerte part avec votre position.</p></div>
<div class="step"><i class="g">M</i><p><b>Medic :</b> vous recevez les alertes avec le chemin pour y aller, et vous voyez qui est en route ou sur place.</p></div>
<div class="step"><i>!</i><p>L'alerte passe par les téléphones à proximité qui ont l'application. Elle doit donc être installée par le plus de monde possible.</p></div>
</div>
<p class="note">Pas de compte. Votre position n'est partagée qu'en cas d'alerte, ou en continu si vous êtes medic. La carte de votre ville est téléchargée pour fonctionner hors-ligne.</p>

<footer>Android : après le téléchargement, autorisez l'installation depuis votre navigateur.<br>Code source :
<a href="https://github.com/Vitrixxl/echo">github.com/Vitrixxl/echo</a></footer>
</main></body></html>`;

if (import.meta.main) {
  const s = start(Number(process.env.PORT ?? 8787), process.env.DATA ?? './data', process.env.DEPLOY_TOKEN ?? '', process.env.TRUST_PROXY === '1');
  console.log(`echo server on :${s.port}`);
}
