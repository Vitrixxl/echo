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
import { digest, hashSecret, merge, missingFrom, prune, type Alert, type Store } from './alerts';
import { decode, encodeDigest, encodeRecords } from './codec';
import { Outbox } from './outbox';

const KEY = 'echo.records.v2'; // v2: SOS carry a key; records saved by older versions are not valid any more
const MINE_KEY = 'echo.mine.v2'; // { id: secret } of SOS raised from this phone: the secret closes them
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
// Random per launch. ME names this phone's medic record; NAME is what Nearby advertises over the air.
// They differ, and SOS ids are fully random, so radio observers can't tie a medic to the alerts it raised.
export const ME = randomHex(6);
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
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  // Battery/RAM: medic pings arrive constantly, so UI updates are batched (one render per
  // 500 ms max) and only SOS hit the disk (medic dots expire in minutes anyway), at most every 5 s.
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sosDirty = useRef(false);
  const commit = (changed: Alert[] = []) => {
    if (changed.some((a) => a.kind === 'sos')) sosDirty.current = true;
    uiTimer.current ??= setTimeout(() => {
      uiTimer.current = null;
      prune(store.current);
      setRecords(Object.values(store.current));
    }, 500);
    if (sosDirty.current)
      diskTimer.current ??= setTimeout(() => {
        diskTimer.current = null;
        sosDirty.current = false;
        const sos = Object.values(store.current).filter((a) => a.kind === 'sos');
        AsyncStorage.setItem(KEY, JSON.stringify(sos)).catch(() => {});
      }, 5000);
  };
  // Per neighbour: SOS first, latest version of each record, one message in flight (see outbox.ts).
  const [outbox] = useState(() => new Outbox((peerId, text) =>
    peerId.startsWith(BLE) ? BleMesh.send(peerId.slice(BLE.length), text) : Nearby.sendText(peerId, text), encodeRecords));
  const sendText = (peerId: string, text: string) => outbox.pushRaw(peerId, text);
  const send = (peerId: string, list: Alert[]) => outbox.push(peerId, list);
  const broadcast = (list: Alert[], except?: string) => {
    for (const p of peers.current) if (p !== except) send(p, list);
  };
  const publish = (a: Alert) => {
    if (merge(store.current, [a]).length) { broadcast([a]); commit([a]); }
  };

  useEffect(() => {
    const link = (peerId: string) => {
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
      peers.current.delete(peerId);
      outbox.drop(peerId);
      answered.delete(peerId);
      setPeerCount(peers.current.size);
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
      const known = new Set(Object.keys(store.current));
      let sos = 0, medics = 0;
      for (const a of Object.values(store.current)) a.kind === 'sos' ? sos++ : medics++;
      // Updates to records we hold always pass; new ones only while there is room.
      const room = data.filter((r: any) => {
        if (!r || typeof r.id !== 'string' || known.has(r.id)) return true;
        return r.kind === 'sos' ? sos++ < MAX_SOS : medics++ < MAX_MEDICS;
      });
      const changed = merge(store.current, room);
      if (!changed.length) return;
      broadcast(changed, peerId);
      commit(changed);
      const fresh = changed.find((a) => a.kind === 'sos' && a.status === 'need' && !known.has(a.id));
      if (fresh) setIncoming(fresh);
    };
    const connect = (peerId: string) => Nearby.requestConnection(peerId).catch(() => {});
    let nearbyOn = false; // Nearby started OK
    let discovering = false;

    const subs = [
      BleMesh.addListener('onPeer', ({ peerId }) => link(BLE + peerId)),
      BleMesh.addListener('onPeerLost', ({ peerId }) => unlink(BLE + peerId)),
      BleMesh.addListener('onText', ({ peerId, text }) => receive(BLE + peerId, text)),
      Nearby.onPeerFound(({ peerId, name }) => {
        found.current.set(peerId, name);
        if (NAME < name) connect(peerId); // the other side waits; the retry loop covers one-way discovery
      }),
      Nearby.onPeerLost(({ peerId }) => found.current.delete(peerId)),
      Nearby.onInvitationReceived(({ peerId }) => Nearby.acceptConnection(peerId).catch(() => {})),
      Nearby.onConnected(({ peerId }) => link(peerId)),
      Nearby.onDisconnected(({ peerId }) => unlink(peerId)),
      Nearby.onTextReceived(({ peerId, text }) => receive(peerId, text)),
    ].map((s) => (typeof s === 'function' ? s : () => s.remove()));

    // Each transport is optional: the mesh works as long as one of them starts.
    const start = async () => {
      const missing = (await ensurePermissions()).filter((p) => (MESH_PERMISSIONS as string[]).includes(p));
      if (missing.length)
        return setError('Autorise « Appareils à proximité » pour relayer les alertes. Touche ici pour ouvrir les réglages.');
      const errs: string[] = [];
      await BleMesh.start().catch((e) => errs.push('Bluetooth : ' + short(e)));
      try {
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
      setError(errs.length === 2 ? 'Mesh indisponible. ' + errs.join(' · ') : null);
    };

    (async () => {
      try {
        const saved = await AsyncStorage.getItem(KEY);
        if (saved) { merge(store.current, JSON.parse(saved)); commit(); }
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
      id, kind: 'sos', lat, lon, note: note.slice(0, 200), status: 'need', createdAt: now, updatedAt: now,
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
    publish({
      id: 'm-' + ME, kind: 'medic', lat, lon, note: '', status: 'need',
      createdAt: medicCreated.current, updatedAt: Date.now(), ...(target ? { target } : {}), ...(target && state ? { state } : {}),
    });
  };

  const mine = Object.keys(secrets);
  return { records, peerCount, error, incoming, mine, me: 'm-' + ME, clearIncoming: () => setIncoming(null), raise, cancel, resolve, pingMedic };
}
