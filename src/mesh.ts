// Offline mesh over two transports at once:
//  - BLE GATT (modules/ble-mesh): works Android <-> iPhone, no Google services needed
//  - Nearby (Google Nearby on Android, Multipeer on iOS): faster, same-platform only
// Every phone discovers neighbours, auto-connects and floods records. On connect: full
// sync (newcomers get everything they lack). On receive: forward only what changed to the other
// peers, so every record crosses the whole mesh once per link. Connect sync is by digest:
// both sides send {h: [[id, updatedAt, rank]…]} and answer with only what the other lacks.
import { bytesToHex } from '@noble/hashes/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as Nearby from 'expo-nearby-connections';
import { useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import BleMesh from '../modules/ble-mesh';
import { digest, fitNote, hashSecret, merge, skewMinutes, missingFrom, prune, trimClosed, type Alert, type Store } from './alerts';
import { decode, encodeDigest, encodeRecords } from './codec';
import { Outbox } from './outbox';

const KEY = 'echo.records.v2'; // v2: SOS carry a key; records saved by older versions are not valid any more
const ME_KEY = 'echo.me.v1'; // { id, at }: the medic id, kept across restarts for one day of march
const ME_KEEP_MS = 12 * 60 * 60 * 1000;
const MINE_KEY = 'echo.mine.v2'; // { id: secret } of SOS raised from this phone: the secret closes them
// Google Nearby / Multipeer is off for now: Bluetooth only (one radio, less battery, works across Android and iPhone).
// Turn back on only in a new build (App Store: no new features over the air). Everything else still handles Nearby links.
const USE_NEARBY = false;
const CHUNK = 40; // records per message when sending the whole store (Nearby payloads stay far below 32 KB)
const DIGEST_MAX = 1000; // ~27 KB in base64: bigger digests don't fit one Nearby payload, send the records instead
const RETRY_MS = 15_000;
// A hostile phone can send anything: cap what one payload and the whole store may hold, so a flood of
// fake records can't freeze the map or be relayed across the crowd. A real march has far fewer.
const MAX_PER_PAYLOAD = CHUNK;
const MAX_SOS = 300;
const MAX_MEDICS = 300;
const BLE = 'ble:'; // peer ids from the BLE transport are prefixed to route sends

// Cryptographic randomness (Math.random can be predicted from its outputs, and SOS secrets must not be).
const randomHex = (bytes: number) => bytesToHex(Crypto.getRandomBytes(bytes));
// ME names this phone's medic record: kept across restarts for 12 h (a restart mustn't leave a ghost medic on
// every map, nor make a medic's own alert look like someone else's), then a new one. NAME is what we advertise
// over the air, random per launch. They differ, and SOS ids are fully random, so radio observers can't tie a
// medic to the alerts it raised.
let ME = randomHex(6);
let meReady = false; // no medic record before the saved ME is back
const NAME = randomHex(6);
const uid = () => randomHex(12);

const short = (e: any) => String(e?.message ?? e).split('\n')[0];

// Android drops overlapping permission dialogs, so every caller (mesh, GPS) shares one
// in-flight request. A failed request is forgotten so the next call asks again.
let pending: Promise<string[]> | null = null;
export function ensurePermissions() {
  pending ??= missingAndroidPermissions().catch(() => []).then((m) => { if (m.length) pending = null; return m; });
  return pending;
}

// Location is needed for the GPS, not for relaying: a phone with only approximate (or no) location must still
// relay alerts, so the mesh only waits for these (location only matters before Android 12, for BLE scans).
export const MESH_PERMISSIONS = Platform.OS !== 'android' ? [] : Number(Platform.Version) >= 31
  ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
     ...(Number(Platform.Version) >= 33 ? [PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES] : [])]
  : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

async function missingAndroidPermissions() {
  if (Platform.OS !== 'android') return [];
  const P = PermissionsAndroid.PERMISSIONS;
  const v = Number(Platform.Version);
  const wanted = [
    P.ACCESS_FINE_LOCATION,
    ...(v >= 31 ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT] : []),
    ...(v >= 33 ? [P.NEARBY_WIFI_DEVICES] : []),
  ];
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.filter((p) => res[p] !== 'granted');
}

export function useMesh() {
  const store = useRef<Store>({});
  const peers = useRef(new Set<string>());
  const found = useRef(new Map<string, string>()); // Nearby peerId -> advertised name
  const [records, setRecords] = useState<Alert[]>([]);
  const [peerCount, setPeerCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef(error);
  errorRef.current = error;
  const [incoming, setIncoming] = useState<Alert | null>(null);
  const [meId, setMeId] = useState('m-' + ME);
  // Our clock against the neighbours': phones more than 10 min apart reject each other's records without a
  // word. Medic positions are stamped when sent (every 90 s at most) and relayed in seconds, so the median of
  // their (time - our time) tells how far off we are.
  const [clockSkewMin, setClockSkewMin] = useState<number | null>(null);
  const offsets = useRef(new Map<string, number>());
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  // Battery/RAM: medic pings arrive constantly, so UI updates are batched: within 500 ms when an alert changed,
  // 2 s when only medic positions did. Only SOS hit the disk (medic dots expire in minutes anyway), every 5 s max.
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sosDirty = useRef(false);
  const uiDue = useRef(0);
  const flushUi = () => {
    if (uiTimer.current) { clearTimeout(uiTimer.current); uiTimer.current = null; }
    prune(store.current);
    setRecords(Object.values(store.current));
  };
  const flushDisk = () => {
    if (diskTimer.current) { clearTimeout(diskTimer.current); diskTimer.current = null; }
    sosDirty.current = false;
    const sos = Object.values(store.current).filter((a) => a.kind === 'sos');
    AsyncStorage.setItem(KEY, JSON.stringify(sos)).catch(() => {});
  };
  const commit = (changed: Alert[] = []) => {
    const sos = !changed.length || changed.some((a) => a.kind === 'sos');
    if (sos) sosDirty.current = true;
    // Screen off, Android freezes the app's timers: the batching below would hold everything until the screen
    // comes back. So alerts and medics' "sur place / renfort" go through at once (their alarms ring now), and
    // alerts hit the disk at once (the system may kill the app before the screen comes back).
    if (AppState.currentState !== 'active') {
      if (sos || changed.some((a) => a.state)) flushUi();
      if (sos) flushDisk();
      if (sos || changed.some((a) => a.state)) return;
    }
    const due = Date.now() + (sos ? 500 : 2000);
    if (uiTimer.current && due < uiDue.current) { clearTimeout(uiTimer.current); uiTimer.current = null; }
    if (!uiTimer.current) {
      uiDue.current = due;
      uiTimer.current = setTimeout(flushUi, due - Date.now());
    }
    if (sosDirty.current) diskTimer.current ??= setTimeout(flushDisk, 5000);
  };
  // Per neighbour: SOS first, latest version of each record, one message in flight (see outbox.ts).
  const [outbox] = useState(() => new Outbox((peerId, text, urgent) =>
    peerId.startsWith(BLE) ? BleMesh.send(peerId.slice(BLE.length), text, urgent) : Nearby.sendText(peerId, text), (list) => encodeRecords(list, NAME)));
  // Alerts (new, closed) also go out in the Bluetooth advertising signal: every phone in range hears them at once,
  // linked or not. Each phone that learns one rebroadcasts it, so it floods without any link at all. Open alerts
  // stay on air (slowly) until closed: a medic arriving later in a crowd that has the alert hears it right away.
  // No sender name in it: every phone then broadcasts the very same bytes, which receivers drop as repeats
  // (with a name, each phone's copy would be new: hundreds of them per second in a dense crowd).
  const shout = (changed: Alert[]) => {
    for (const a of changed) if (a.kind === 'sos') { try { BleMesh.broadcast(a.id, encodeRecords([a]), a.status !== 'done'); } catch {} }
  };
  const sendText = (peerId: string, text: string) => outbox.pushRaw(peerId, text);
  const send = (peerId: string, list: Alert[]) => outbox.push(peerId, list);
  const broadcast = (list: Alert[], except?: string) => {
    for (const p of peers.current) if (p !== except) send(p, list);
  };
  const publish = (a: Alert) => {
    if (merge(store.current, [a]).length) { broadcast([a]); shout([a]); commit([a]); }
  };

  useEffect(() => {
    // One link per neighbour: two Android (or two iPhones) close by link over both Bluetooth and Nearby
    // (Multipeer), and every message would cross twice. Both sides advertise the same random NAME, so a
    // Bluetooth link to a phone already linked over Nearby (faster) is kept in reserve, used if Nearby drops.
    const names = new Map<string, string>(); // peerId -> mesh name, when known
    const spare = new Set<string>(); // Bluetooth links held back: their phone is linked over Nearby
    const twin = (peerId: string) => {
      const n = names.get(peerId);
      return n ? [...peers.current, ...spare].filter((q) => q !== peerId && names.get(q) === n) : [];
    };
    const link = (peerId: string, name?: string | null) => {
      if (name) names.set(peerId, name);
      const ble = peerId.startsWith(BLE);
      if (ble && twin(peerId).some((q) => !q.startsWith(BLE) && peers.current.has(q))) { spare.add(peerId); return; }
      if (!ble) for (const q of twin(peerId)) if (q.startsWith(BLE) && peers.current.has(q)) {
        peers.current.delete(q); outbox.drop(q); spare.add(q);
      }
      peers.current.add(peerId);
      setPeerCount(peers.current.size);
      const all = Object.values(store.current);
      // BLE: replies come back from a different address than the one we connect to, so a digest's answer
      // could never be routed back. Push the live SOS and our own records instead.
      if (peerId.startsWith(BLE)) return send(peerId, all.filter((a) => a.kind === 'sos' || a.id === 'm-' + ME));
      const d = digest(store.current);
      if (d.length > DIGEST_MAX) send(peerId, all);
      else sendText(peerId, encodeDigest(d));
    };
    const answered = new Set<string>(); // peers whose digest we already answered on this link
    const unlink = (peerId: string) => {
      const reserve = peerId.startsWith(BLE) ? [] : twin(peerId).filter((q) => spare.has(q));
      spare.delete(peerId);
      names.delete(peerId);
      peers.current.delete(peerId);
      outbox.drop(peerId);
      answered.delete(peerId);
      setPeerCount(peers.current.size);
      for (const q of reserve) { spare.delete(q); link(q); } // Nearby dropped: its Bluetooth twin takes over
    };
    const receive = (peerId: string, text: string) => {
      const msg = decode(text); // compact binary format (codec.ts); anything malformed decodes to null
      if (!msg) return;
      if ('digest' in msg) {
        // Once per link: a tiny digest must not make us resend the whole store over and over.
        if (answered.has(peerId)) return;
        answered.add(peerId);
        const list = missingFrom(store.current, msg.digest);
        if (list.length) send(peerId, list);
        return;
      }
      const data = msg.records;
      if (data.length > MAX_PER_PAYLOAD) return;
      const off = offsets.current;
      for (const r of data) if (r?.kind === 'medic' && r.id !== meId && Number.isFinite(r.updatedAt)) {
        off.delete(r.id);
        off.set(r.id, r.updatedAt - Date.now());
        if (off.size > 30) off.delete(off.keys().next().value!);
      }
      if (off.size >= 3) setClockSkewMin(skewMinutes([...off.values()]));
      const known = new Set(Object.keys(store.current));
      let sos = 0, medics = 0;
      for (const a of Object.values(store.current)) a.kind === 'medic' ? medics++ : a.status !== 'done' && sos++;
      // Updates to records we hold always pass; new ones only while there is room. Only open alerts count:
      // closed ones never block a new alert (they're trimmed below instead).
      const room = data.filter((r: any) => {
        if (!r || typeof r.id !== 'string' || known.has(r.id)) return true;
        return r.kind === 'medic' ? medics++ < MAX_MEDICS : r.status === 'done' || sos++ < MAX_SOS;
      });
      // Remember that the sender has these: never send them back to it. Bluetooth replies arrive from another
      // address than our link to that phone, so it's found by the mesh name carried in the message.
      const from = [peerId, ...(msg.from ? [...peers.current].filter((q) => names.get(q) === msg.from) : [])];
      for (const q of from) if (peers.current.has(q)) outbox.has(q, data);
      const changed = merge(store.current, room);
      if (!changed.length) return;
      trimClosed(store.current, MAX_SOS);
      broadcast(changed, peerId);
      shout(changed);
      commit(changed);
      const fresh = changed.find((a) => a.kind === 'sos' && a.status === 'need' && !known.has(a.id));
      if (fresh) setIncoming(fresh);
    };
    const connect = (peerId: string) => Nearby.requestConnection(peerId).catch(() => {});
    let nearbyOn = false; // Nearby started OK
    let discovering = false;

    const subs = [
      BleMesh.addListener('onPeer', ({ peerId, name }) => { setError(null); link(BLE + peerId, name); }), // Bluetooth back on
      BleMesh.addListener('onPeerLost', ({ peerId }) => unlink(BLE + peerId)),
      BleMesh.addListener('onText', ({ peerId, text }) => receive(peerId === 'adv' ? 'adv' : BLE + peerId, text)),
      Nearby.onPeerFound(({ peerId, name }) => {
        found.current.set(peerId, name);
        if (NAME < name) connect(peerId); // the other side waits; the retry loop covers one-way discovery
      }),
      Nearby.onPeerLost(({ peerId }) => found.current.delete(peerId)),
      Nearby.onInvitationReceived(({ peerId }) => Nearby.acceptConnection(peerId).catch(() => {})),
      Nearby.onConnected(({ peerId }) => link(peerId, found.current.get(peerId))),
      Nearby.onDisconnected(({ peerId }) => unlink(peerId)),
      Nearby.onTextReceived(({ peerId, text }) => receive(peerId, text)),
    ].map((s) => (typeof s === 'function' ? s : () => s.remove()));

    // Each transport is optional: the mesh works as long as one of them starts.
    const start = async () => {
      const missing = (await ensurePermissions()).filter((p) => (MESH_PERMISSIONS as string[]).includes(p));
      if (missing.length)
        return setError('Autorise « Appareils à proximité » pour relayer les alertes. Touche ici pour ouvrir les réglages.');
      const errs: string[] = [];
      await BleMesh.start(NAME).catch((e) => errs.push('Bluetooth : ' + short(e)));
      if (USE_NEARBY) try {
        if (Platform.OS === 'android' && !(await Nearby.isPlayServicesAvailable())) throw new Error('Google Play Services absent');
        await Nearby.stopDiscovery().catch(() => {});
        await Nearby.stopAdvertise().catch(() => {});
        // ponytail: P2P_CLUSTER caps each phone at a few direct links; multi-hop flooding covers the rest.
        await Nearby.startDiscovery(NAME, Nearby.Strategy.P2P_CLUSTER);
        await Nearby.startAdvertise(NAME, Nearby.Strategy.P2P_CLUSTER);
        nearbyOn = discovering = true;
      } catch (e) {
        errs.push('Wi-Fi direct : ' + short(e));
      }
      setError(errs.length === (USE_NEARBY ? 2 : 1) ? 'Mesh indisponible. ' + errs.join(' · ') : null);
    };

    (async () => {
      try {
        const me = JSON.parse((await AsyncStorage.getItem(ME_KEY)) ?? 'null');
        if (me && /^[0-9a-f]{12}$/.test(me.id) && Date.now() - me.at < ME_KEEP_MS && me.at <= Date.now()) ME = me.id;
        else AsyncStorage.setItem(ME_KEY, JSON.stringify({ id: ME, at: Date.now() })).catch(() => {});
      } catch {}
      meReady = true;
      setMeId('m-' + ME);
      try {
        const saved = await AsyncStorage.getItem(KEY);
        if (saved) { merge(store.current, JSON.parse(saved)); commit(); shout(Object.values(store.current)); }
        setSecrets(JSON.parse((await AsyncStorage.getItem(MINE_KEY)) ?? '{}'));
      } catch {}
      start();
    })();

    // Back from the settings screen (or Bluetooth turned on): try again.
    const appState = AppState.addEventListener('change', (s) => { if (s === 'active' && errorRef.current) start(); });

    // Retry Nearby peers we see but aren't linked to, and expire stale records.
    // Battery: Nearby discovery (BT classic + Wi-Fi scans) is the biggest drain, so it pauses
    // while we already have 2+ Nearby links; advertising stays on so others still find us.
    const timer = setInterval(() => {
      for (const peerId of found.current.keys()) if (!peers.current.has(peerId)) connect(peerId);
      if (prune(store.current)) commit();
      if (!nearbyOn) return;
      const links = [...peers.current].filter((p) => !p.startsWith(BLE)).length;
      if (links >= 2 && discovering) { discovering = false; Nearby.stopDiscovery().catch(() => {}); }
      else if (links < 2 && !discovering) {
        discovering = true;
        Nearby.startDiscovery(NAME, Nearby.Strategy.P2P_CLUSTER).catch(() => { discovering = false; });
      }
    }, RETRY_MS);

    return () => {
      clearInterval(timer);
      if (uiTimer.current) clearTimeout(uiTimer.current);
      appState.remove();
      subs.forEach((u) => u());
      BleMesh.stop().catch(() => {});
      Nearby.stopAdvertise().catch(() => {});
      Nearby.stopDiscovery().catch(() => {});
      Nearby.disconnect().catch(() => {});
    };
  }, []);

  // by: the author's medic id, when a medic raises it (they don't count as "sur place" for their own alert).
  const raise = (lat: number, lon: number, note: string, by?: string) => {
    const now = Date.now();
    const id = uid(), secret = randomHex(32);
    setSecrets((m) => {
      // keep only secrets of SOS still around: an expired one is useless and proves who raised it
      const next = Object.fromEntries(Object.entries(m).filter(([x]) => store.current[x]));
      next[id] = secret;
      AsyncStorage.setItem(MINE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
    publish({
      id, kind: 'sos', lat, lon, note: fitNote(note), status: 'need', createdAt: now, updatedAt: now,
      key: hashSecret(secret), ...(by ? { by } : {}),
    });
  };

  // The author closes their SOS for everyone by revealing the secret behind its key.
  const cancel = (id: string) => {
    const cur = store.current[id], secret = secrets[id];
    if (cur && secret) publish({ ...cur, status: 'done', proof: secret, updatedAt: Math.max(Date.now(), cur.updatedAt + 1) });
  };
  // A medic on site closes it with their position (peers check it is within 40 m of the SOS).
  const resolve = (id: string, lat: number, lon: number) => {
    const cur = store.current[id];
    if (cur) publish({ ...cur, status: 'done', doneBy: 'm-' + ME, doneLat: lat, doneLon: lon, updatedAt: Math.max(Date.now(), cur.updatedAt + 1) });
  };

  // Medic heartbeat: one record per medic, refreshed on every GPS move and at least every 60 s, with the SOS
  // they head to and, once there, how it goes ("care": on s'en occupe, "help": besoin de renfort).
  const medicCreated = useRef(Date.now());
  const pingMedic = (lat: number, lon: number, target: string | null, state: 'care' | 'help' | null) => {
    if (!meReady) return;
    publish({
      id: 'm-' + ME, kind: 'medic', lat, lon, note: '', status: 'need',
      createdAt: medicCreated.current, updatedAt: Date.now(), ...(target ? { target } : {}), ...(target && state ? { state } : {}),
    });
  };

  const mine = Object.keys(secrets);
  return { records, peerCount, error, incoming, mine, me: meId, clockSkewMin, clearIncoming: () => setIncoming(null), raise, cancel, resolve, pingMedic };
}
