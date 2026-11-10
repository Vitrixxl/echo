/**
 * Deploy Brancard: the server through pihost, then what phones download.
 *
 *   bun scripts/deploy.ts               server + over-the-air update
 *   bun scripts/deploy.ts --apk         also build the APK and publish it on the download page
 *   bun scripts/deploy.ts --update-only only the over-the-air update (server untouched)
 *   --ios                               the over-the-air update is for iPhones instead of Android (each has its own runtime)
 *   --light                             low memory: one worker, small JVM heap, no Gradle daemon (slower)
 *
 * Over-the-air update: `expo export` gives the JavaScript bundle and assets; the manifest is written and
 * signed HERE with the key in ~/.config/echo/keys/expo-updates (never on the server), then the server stores
 * it as is. Phones only run it if the signature matches certs/certificate.pem and the runtime version (a
 * fingerprint of the native code) matches theirs. When native code changed, ship a new APK with --apk.
 *
 * DEPLOY_TOKEN authorises the uploads; when unset it is read over SSH from the server's .env.
 * The APK is signed with ~/.config/echo/keys/android/release.jks (password in release.pass next to it).
 * Back that key up: losing it means installed phones can never take a new APK again.
 * Env overrides: ECHO_PI (ssh target), ECHO_APP (pihost name), EXPO_PUBLIC_STATS_URL (public origin, from .env).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID, sign, verify, X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
// The Pi's ssh target stays out of this public repo: ECHO_PI, or one line in ~/.config/echo/pi.
const PI = process.env.ECHO_PI ?? (existsSync(join(homedir(), '.config/echo/pi')) ? readFileSync(join(homedir(), '.config/echo/pi'), 'utf8').trim() : '');
if (!PI) { console.error('Set ECHO_PI=user@host (or write it to ~/.config/echo/pi).'); process.exit(1); }
const APP = process.env.ECHO_APP ?? 'echo';
const ORIGIN = (process.env.EXPO_PUBLIC_STATS_URL ?? 'https://brancard.vitrixxl.fr').replace(/\/$/, '');
const KEY = process.env.ECHO_UPDATES_SIGNING_KEY ?? join(homedir(), '.config/echo/keys/expo-updates/private-key.pem');
const apk = process.argv.includes('--apk');
const updateOnly = process.argv.includes('--update-only');
const light = process.argv.includes('--light');
const OUT = resolve(root, 'dist/update');

const run = (cmd: string, args: string[], opts: { capture?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, env: opts.env ?? process.env, encoding: 'utf8', stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (r.status !== 0) { console.error(`${cmd} failed (${r.status})`); process.exit(r.status ?? 1); }
  return (r.stdout ?? '').trim();
};
const up = async () => { try { return (await fetch(`${ORIGIN}/count`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } };

if (!existsSync(KEY)) { console.error(`No signing key at ${KEY}: phones would refuse the update.`); process.exit(1); }
if (spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim())
  console.warn('Warning: uncommitted changes. The server is built from the pushed commit, the update from this working tree.');

// 1. Server
if (!updateOnly) {
  run('git', ['push']);
  run('ssh', [PI, 'pihost', 'update', APP]);
  for (let i = 0; !(await up()); i++) {
    if (i > 60) { console.error(`${ORIGIN} does not answer.`); process.exit(1); }
    await Bun.sleep(3000);
  }
}
const token = process.env.DEPLOY_TOKEN
  ?? run('ssh', [PI, `sed -n 's/^DEPLOY_TOKEN=//p' /srv/pihost/apps/${APP}/repo/.env`], { capture: true });
if (!token) { console.error('No DEPLOY_TOKEN (set it on the server with `pihost env echo`).'); process.exit(1); }
const put = async (path: string, body: BodyInit, type = 'application/octet-stream') => {
  const res = await fetch(ORIGIN + path, { method: 'PUT', body, headers: { authorization: `Bearer ${token}`, 'content-type': type } });
  if (!res.ok) { console.error(`PUT ${path}: ${res.status} ${await res.text()}`); process.exit(1); }
};

// 2. Over-the-air update
const platform = process.argv.includes('--ios') ? 'ios' : 'android';
const runtime = JSON.parse(run('bunx', ['expo-updates', 'runtimeversion:resolve', '--platform', platform], { capture: true })).runtimeVersion as string;
rmSync(OUT, { recursive: true, force: true });
run('bunx', ['expo', 'export', '--clear', '--platform', platform, '--output-dir', OUT, ...(light ? ['--max-workers', '1'] : [])], { env: { ...process.env, NODE_ENV: 'production' } });
const expoClient = JSON.parse(run('bunx', ['expo', 'config', '--type', 'public', '--json'], { capture: true }));
const TYPES: Record<string, string> = { hbc: 'application/javascript', js: 'application/javascript', json: 'application/json', ttf: 'font/ttf', otf: 'font/otf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const meta = JSON.parse(readFileSync(join(OUT, 'metadata.json'), 'utf8')).fileMetadata[platform] as { bundle: string; assets: { path: string; ext: string }[] };
const files = [{ path: meta.bundle, ext: extname(meta.bundle).slice(1) }, ...meta.assets].map(({ path, ext }) => {
  if (!TYPES[ext]) { console.error(`No content type for .${ext}`); process.exit(1); }
  const bytes = readFileSync(join(OUT, path));
  return { bytes, hex: createHash('sha256').update(bytes).digest('hex'), key: basename(path, extname(path)), contentType: TYPES[ext], fileExtension: `.${ext}` };
});
const served = (f: (typeof files)[number]) => ({
  hash: Buffer.from(f.hex, 'hex').toString('base64url'), key: f.key, contentType: f.contentType, fileExtension: f.fileExtension,
  url: `${ORIGIN}/updates/assets/${f.hex}`,
});
const manifest = JSON.stringify({
  id: randomUUID(), createdAt: new Date().toISOString(), runtimeVersion: runtime,
  launchAsset: served(files[0]), assets: files.slice(1).map(served), metadata: {}, extra: { expoClient },
});
const signature = sign('sha256', Buffer.from(manifest), readFileSync(KEY)).toString('base64');
const cert = new X509Certificate(readFileSync(join(root, 'certs/certificate.pem')));
if (!verify('sha256', Buffer.from(manifest), cert.publicKey, Buffer.from(signature, 'base64'))) {
  console.error(`${KEY} does not match certs/certificate.pem: phones would refuse every update.`); process.exit(1);
}
for (const f of files) await put(`/updates/assets/${f.hex}`, f.bytes);
await put('/updates', JSON.stringify({ runtimeVersion: runtime, manifest, signature }), 'application/json');
console.log(`Update published for ${platform}, runtime ${runtime.slice(0, 12)} (${files.length} files).`);

// 3. APK (only needed when native code changed, or for the download page)
if (apk) {
  const android = join(root, 'android');
  run('bunx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], { env: { ...process.env, CI: '1' } });
  const JAVA_HOME = process.env.JAVA_HOME ?? join(homedir(), '.local/share/jdk17');
  const env = { ...process.env, JAVA_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}`, ANDROID_HOME: process.env.ANDROID_HOME ?? join(homedir(), 'Android/Sdk') };
  run('./gradlew', ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a,armeabi-v7a', '-q', ...(light ? ['--no-daemon', '--max-workers=1', '-Dorg.gradle.jvmargs=-Xmx1g -XX:MaxMetaspaceSize=384m', '-Pkotlin.compiler.execution.strategy=in-process'] : [])], { cwd: android, env });
  spawnSync('./gradlew', ['--stop'], { cwd: android }); // the daemon keeps gigabytes of RAM otherwise
  // Gradle signs with the public React Native debug key; anyone could sign a fake "update" with it.
  // Re-sign with our own key (kept off the repo) so Android refuses any APK not signed by us.
  const ks = process.env.ECHO_ANDROID_KEYSTORE ?? join(homedir(), '.config/echo/keys/android/release.jks');
  const signed = join(android, 'app/build/outputs/apk/release/echo-signed.apk');
  const apksigner = join(env.ANDROID_HOME!, 'build-tools', readdirSync(join(env.ANDROID_HOME!, 'build-tools')).sort().pop()!, 'apksigner');
  const pass = `file:${ks.replace(/\.jks$/, '.pass')}`;
  run(apksigner, ['sign', '--ks', ks, '--ks-pass', pass, '--out', signed, join(android, 'app/build/outputs/apk/release/app-release.apk')], { env });
  run(apksigner, ['verify', signed], { env });
  await put('/apk', readFileSync(signed), 'application/vnd.android.package-archive');
  console.log(`APK published: ${ORIGIN}/download`);
}
