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
      if (m === 'GET' && pathname === '/caveat.woff2')
        return new Response(Bun.file(join(import.meta.dir, 'fonts/caveat.woff2')), { headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' } });
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

// The "link in bio", in the notebook style of the promo video: dotted paper, red margin, handwritten
// notes (Caveat, subset in fonts/), cut-out tags. Self-contained, no third-party requests.
// Android download; iPhone greyed out until the App Store version exists.
const ANDROID = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22a11.5 11.5 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>`;
const APPLE = `<svg width="20" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 1.43c0 1.14-.42 2.2-1.25 3.03-.9.9-1.98 1.42-3.15 1.33-.15-1.1.4-2.26 1.2-3.08.88-.9 2.15-1.48 3.2-1.28zM20.5 17.2c-.56 1.3-.83 1.87-1.55 3.02-1 1.6-2.42 3.6-4.17 3.6-1.56.02-1.96-1.02-4.08-1-2.12 0-2.56 1.02-4.12 1-1.75-.02-3.1-1.83-4.1-3.42C-.33 15.95-.62 10.6 1.6 7.85c1.06-1.32 2.72-2.1 4.3-2.1 1.6 0 2.6 1.02 3.93 1.02 1.28 0 2.06-1.02 3.92-1.02 1.4 0 2.88.76 3.94 2.08-3.46 1.9-2.9 6.84.81 8.37z"/></svg>`;
const MESH = `<svg class="mesh" viewBox="0 0 350 170" role="img" aria-label="L'alerte passe de téléphone en téléphone jusqu'aux medics"><path class="e" d="M30 82L98 40"/><path class="f" pathLength="1" style="--h:0" d="M30 82L98 40"/><path class="e" d="M30 82L98 124"/><path class="f" pathLength="1" style="--h:0" d="M30 82L98 124"/><path class="e" d="M98 40L168 22"/><path class="f" pathLength="1" style="--h:1" d="M98 40L168 22"/><path class="e" d="M98 40L168 84"/><path class="f" pathLength="1" style="--h:1" d="M98 40L168 84"/><path class="e" d="M98 124L168 84"/><path class="f" pathLength="1" style="--h:1" d="M98 124L168 84"/><path class="e" d="M98 124L168 142"/><path class="f" pathLength="1" style="--h:1" d="M98 124L168 142"/><path class="e" d="M168 22L240 52"/><path class="f" pathLength="1" style="--h:2" d="M168 22L240 52"/><path class="e" d="M168 84L240 52"/><path class="f" pathLength="1" style="--h:2" d="M168 84L240 52"/><path class="e" d="M168 84L240 118"/><path class="f" pathLength="1" style="--h:2" d="M168 84L240 118"/><path class="e" d="M168 142L240 118"/><path class="f" pathLength="1" style="--h:2" d="M168 142L240 118"/><path class="e" d="M240 52L312 26"/><path class="f" pathLength="1" style="--h:3" d="M240 52L312 26"/><path class="e" d="M240 52L312 88"/><path class="f" pathLength="1" style="--h:3" d="M240 52L312 88"/><path class="e" d="M240 118L312 88"/><path class="f" pathLength="1" style="--h:3" d="M240 118L312 88"/><path class="e" d="M240 118L318 146"/><path class="f" pathLength="1" style="--h:3" d="M240 118L318 146"/><rect class="n" style="--h:0" x="21" y="68" width="18" height="28" rx="3"/><rect class="n" style="--h:1" x="89" y="26" width="18" height="28" rx="3"/><rect class="n" style="--h:1" x="89" y="110" width="18" height="28" rx="3"/><rect class="n" style="--h:2" x="159" y="8" width="18" height="28" rx="3"/><rect class="n" style="--h:2" x="159" y="70" width="18" height="28" rx="3"/><rect class="n" style="--h:2" x="159" y="128" width="18" height="28" rx="3"/><rect class="n" style="--h:3" x="231" y="38" width="18" height="28" rx="3"/><rect class="n" style="--h:3" x="231" y="104" width="18" height="28" rx="3"/><rect class="n m" x="303" y="12" width="18" height="28" rx="3"/><path class="plus" d="M312 20v12M306 26h12"/><rect class="n" style="--h:4" x="303" y="74" width="18" height="28" rx="3"/><rect class="n m" x="309" y="132" width="18" height="28" rx="3"/><path class="plus" d="M318 140v12M312 146h12"/><rect x="12" y="44" width="36" height="17" fill="#D9443F"/><text x="30" y="57" class="sos">SOS</text></svg>`;

const page = (n: number, hasApk: boolean) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Écho : alertes pour street medics</title>
<meta name="description" content="Application d'alerte pour les street medics en manifestation, qui fonctionne sans internet.">
<meta property="og:title" content="Écho : alertes pour street medics">
<meta property="og:description" content="Application d'alerte pour les street medics en manifestation, qui fonctionne sans internet.">
<meta name="theme-color" content="#FCFCF8">
<link rel="preload" href="/caveat.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:Caveat;src:url(/caveat.woff2) format("woff2");font-weight:400 700;font-display:swap}
*{box-sizing:border-box}
:root{--ink:#141416;--red:#D9443F;--blue:#2B3FF0;--green:#28995F;--yellow:#FFD84A;--paper:#FCFCF8;--muted:#5F5F5B}
body{margin:0;color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:var(--paper) radial-gradient(#d2d2cd 1.1px,transparent 1.3px) 0 0/22px 22px}
.paper{position:relative;max-width:520px;min-height:100vh;margin:0 auto;padding:22px 22px 48px 54px}
.paper::before{content:"";position:absolute;left:34px;top:0;bottom:0;width:2px;background:#E9A3A1}
.hand{font-family:Caveat,"Comic Sans MS",cursive}
header{display:flex;justify-content:space-between;align-items:baseline;color:var(--red)}
header .hand{font-size:30px;font-weight:700}header span:last-child{font-weight:700;font-size:15px}
h1{font-size:68px;line-height:1;font-weight:900;letter-spacing:-2.5px;margin:34px 0 0}
.scrib{color:var(--red);font-size:29px;font-weight:600;line-height:1.1;margin:6px 0 22px;transform:rotate(-2deg);transform-origin:left}
.lead{font-size:17px;line-height:1.55;margin:0 0 28px}
.tag{position:relative;display:flex;align-items:center;justify-content:center;gap:10px;height:62px;margin:0 0 18px;
  border:3px solid var(--ink);box-shadow:6px 6px 0 var(--ink);background:#fff;color:var(--ink);font-weight:800;font-size:17px;text-decoration:none}
a.tag{background:var(--red);color:#fff;transform:rotate(-1deg)}
a.tag:active{transform:translate(4px,4px) rotate(-1deg);box-shadow:2px 2px 0 var(--ink)}
.tag.off{color:#A2A29D;border-color:#C2C2BD;box-shadow:6px 6px 0 #C2C2BD;background:#F3F3EF;transform:rotate(.6deg)}
.stamp{position:absolute;right:12px;top:50%;transform:translateY(-50%) rotate(-9deg);border:2.5px solid var(--red);color:var(--red);
  background:rgba(252,252,248,.9);font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:3px 7px}
.note{position:relative;background:#fff;border:1px solid #DAD9D4;box-shadow:3px 5px 0 rgba(0,0,0,.07);padding:20px 18px 16px;margin:38px 0 0;transform:rotate(-1.2deg)}
.note::before,.note::after{content:"";position:absolute;top:-13px;width:84px;height:26px;background:rgba(255,216,74,.78)}
.note::before{left:-18px;transform:rotate(-22deg)}.note::after{right:-18px;transform:rotate(22deg)}
.mesh{display:block;width:100%;height:auto}
.e{fill:none;stroke:#B9B8B2;stroke-width:1.6}
.f{fill:none;stroke:var(--red);stroke-width:3.2;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:flow 6s infinite;animation-delay:calc(var(--h) * .45s)}
@keyframes flow{0%{stroke-dashoffset:1;opacity:1}9%{stroke-dashoffset:0}72%{stroke-dashoffset:0;opacity:1}88%,100%{stroke-dashoffset:0;opacity:0}}
.n{fill:#fff;stroke:var(--ink);stroke-width:2.4;animation:lit 6s infinite;animation-delay:calc(var(--h) * .45s + .3s)}
@keyframes lit{0%{fill:#fff}5%,72%{fill:#F8D9D7}88%,100%{fill:#fff}}
.n.m{fill:var(--green);stroke:var(--ink);animation:none}
.plus{stroke:#fff;stroke-width:3;stroke-linecap:round}
.sos{fill:#fff;font-size:11.5px;font-weight:800;text-anchor:middle;letter-spacing:.5px}
.cap{font-size:23px;color:var(--muted);text-align:center;margin:6px 0 0}
.count{display:flex;align-items:baseline;gap:10px;margin:34px 0 0;font-size:17px;font-weight:600}
.count .hand{font-size:60px;font-weight:700;color:var(--red);line-height:1;text-decoration:underline wavy rgba(217,68,63,.45) 2px;text-underline-offset:8px}
h2{font-family:Caveat,cursive;font-size:36px;font-weight:700;margin:44px 0 0;line-height:1}
.notes .note{margin-top:30px}.notes .note:nth-child(2){transform:rotate(1.1deg)}
.label{display:inline-block;color:#fff;font-weight:800;font-size:13px;letter-spacing:.8px;padding:5px 10px}
.blue{background:var(--blue)}.green{background:var(--green)}
.notes p{margin:12px 0 0;font-size:16px;line-height:1.5}
.why{font-size:17px;line-height:1.6;margin:34px 0 0}
mark{background:linear-gradient(transparent 12%,var(--yellow) 12%,var(--yellow) 88%,transparent 88%);color:inherit;font-weight:700;padding:0 3px}
ul{list-style:none;padding:0;margin:26px 0 0}
li{display:flex;gap:12px;align-items:flex-start;margin:0 0 12px;font-size:16px;line-height:1.45}
li::before{content:"";flex:none;width:21px;height:21px;margin-top:1px;border:2.5px solid var(--ink);background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M4 10.5l4 4 8-9' fill='none' stroke='%2328995F' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/88% no-repeat}
footer{margin-top:42px;color:var(--muted);font-size:13.5px;line-height:1.6}
footer a{color:var(--ink)}
@media (prefers-reduced-motion:reduce){.f,.n{animation:none}.f{stroke-dashoffset:0}}
</style></head><body><div class="paper">
<header><span class="hand">écho</span><span>street medics</span></header>
<h1>Écho</h1>
<p class="hand scrib">→ alerter les medics quand le réseau est coupé</p>
<p class="lead">Application d'alerte pour les street medics en manifestation. Les téléphones se transmettent l'alerte entre eux, sans internet.</p>
${hasApk
  ? `<a class="tag" href="/download">${ANDROID} Télécharger pour Android</a>`
  : `<div class="tag off" aria-disabled="true">${ANDROID} Android <span class="stamp">bientôt</span></div>`}
<div class="tag off" aria-disabled="true">${APPLE} iPhone <span class="stamp">bientôt</span></div>

<figure class="note" style="margin-left:0;margin-right:0">${MESH}<figcaption class="hand cap">l'alerte passe d'un téléphone à l'autre jusqu'aux medics</figcaption></figure>
${n > 0 ? `<p class="count"><span class="hand">${n.toLocaleString('fr-FR')}</span> installation${n > 1 ? 's' : ''}</p>` : ''}

<h2>comment ça marche</h2>
<div class="notes">
<div class="note"><span class="label blue">CIVIL</span><p>En cas de blessure, vous appuyez sur le bouton rouge et vous confirmez. L'alerte part avec votre position.</p></div>
<div class="note"><span class="label green">MEDIC</span><p>Vous recevez les alertes avec le chemin pour y aller, et vous voyez qui est en route ou sur place.</p></div>
</div>
<p class="why">L'alerte passe uniquement par les téléphones à proximité qui ont l'application : <mark>il faut qu'un maximum de personnes l'installe.</mark></p>
<ul>
<li>Pas de compte.</li>
<li>Votre position n'est partagée qu'en cas d'alerte, ou en continu si vous êtes medic.</li>
<li>La carte de votre ville est téléchargée pour fonctionner hors-ligne.</li>
</ul>
<footer>Android : après le téléchargement, autorisez l'installation depuis votre navigateur.<br>Code source : <a href="https://github.com/Vitrixxl/echo">github.com/Vitrixxl/echo</a></footer>
</div></body></html>`;

if (import.meta.main) {
  const s = start(Number(process.env.PORT ?? 8787), process.env.DATA ?? './data', process.env.DEPLOY_TOKEN ?? '', process.env.TRUST_PROXY === '1');
  console.log(`echo server on :${s.port}`);
}
