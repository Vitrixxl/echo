// Offline mesh over two transports at once:
//  - BLE GATT (modules/ble-mesh): works Android <-> iPhone, no Google services needed
//  - Nearby (Google Nearby on Android, Multipeer on iOS): faster, same-platform only
// Every phone discovers neighbours, auto-connects and floods records. On connect: full
// sync (newcomers get everything they lack). On receive: forward only what changed to the other
// peers, so every record crosses the whole mesh once per link. Connect sync is by digest:
// both sides send {h: [[id, updatedAt, rank]…]} and answer with only what the other lacks.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Nearby from 'expo-nearby-connections';
import { useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import BleMesh from '../modules/ble-mesh';
import { digest, merge, missingFrom, prune, type Alert, type Status, type Store } from './alerts';

const KEY = 'echo.records.v1';
const MINE_KEY = 'echo.mine.v1'; // ids of SOS raised from this phone, so they can be cancelled
const CHUNK = 40; // records per payload, stays far below Nearby's 32 KB byte-payload limit
const DIGEST_MAX = 600; // ~27 KB: bigger digests don't fit one Nearby payload, send the records instead
const RETRY_MS = 15_000;
const BLE = 'ble:'; // peer ids from the BLE transport are prefixed to route sends

// Random per launch: used only to break connection ties, no stable identifier leaks.
export const ME = Math.random().toString(36).slice(2, 10);
const uid = () => ME + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const short = (e: any) => String(e?.message ?? e).split('\n')[0];

// Android drops overlapping permission dialogs, so every caller (mesh, GPS) shares one
// in-flight request. A failed request is forgotten so the next call asks again.
let pending: Promise<string[]> | null = null;
export function ensurePermissions() {
  pending ??= missingAndroidPermissions().catch(() => []).then((m) => { if (m.length) pending = null; return m; });
  return pending;
}

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
  const [mine, setMine] = useState<string[]>([]);

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
  const sendText = (peerId: string, text: string) =>
    (peerId.startsWith(BLE) ? BleMesh.send(peerId.slice(BLE.length), text) : Nearby.sendText(peerId, text)).catch(() => {});
  const send = (peerId: string, list: Alert[]) => {
    for (let i = 0; i < list.length; i += CHUNK) sendText(peerId, JSON.stringify(list.slice(i, i + CHUNK)));
  };
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
      const d = digest(store.current);
      if (d.length > DIGEST_MAX) send(peerId, Object.values(store.current));
      else sendText(peerId, JSON.stringify({ h: d }));
    };
    const unlink = (peerId: string) => {
      peers.current.delete(peerId);
      setPeerCount(peers.current.size);
    };
    const receive = (peerId: string, text: string) => {
      let data: unknown;
      try { data = JSON.parse(text); } catch { return; }
      if (data && typeof data === 'object' && 'h' in data) {
        const list = missingFrom(store.current, (data as { h: unknown }).h);
        if (list.length) send(peerId, list);
        return;
      }
      if (!Array.isArray(data)) return;
      const known = new Set(Object.keys(store.current));
      const changed = merge(store.current, data);
      if (!changed.length) return;
      broadcast(changed, peerId);
      commit(changed);
      const sos = changed.find((a) => a.kind === 'sos' && a.status === 'need' && !known.has(a.id));
      if (sos) setIncoming(sos);
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
        if (ME < name) connect(peerId); // the other side waits; the retry loop covers one-way discovery
      }),
      Nearby.onPeerLost(({ peerId }) => found.current.delete(peerId)),
      Nearby.onInvitationReceived(({ peerId }) => Nearby.acceptConnection(peerId).catch(() => {})),
      Nearby.onConnected(({ peerId }) => link(peerId)),
      Nearby.onDisconnected(({ peerId }) => unlink(peerId)),
      Nearby.onTextReceived(({ peerId, text }) => receive(peerId, text)),
    ].map((s) => (typeof s === 'function' ? s : () => s.remove()));

    // Each transport is optional: the mesh works as long as one of them starts.
    const start = async () => {
      const missing = await ensurePermissions();
      if (missing.length)
        return setError('Autorise « Appareils à proximité » et « Position » pour rejoindre le mesh. Touche ici pour ouvrir les réglages.');
      const errs: string[] = [];
      await BleMesh.start().catch((e) => errs.push('Bluetooth : ' + short(e)));
      try {
        if (Platform.OS === 'android' && !(await Nearby.isPlayServicesAvailable())) throw new Error('Google Play Services absent');
        await Nearby.stopDiscovery().catch(() => {});
        await Nearby.stopAdvertise().catch(() => {});
        // ponytail: P2P_CLUSTER caps each phone at a few direct links; multi-hop flooding covers the rest.
        await Nearby.startDiscovery(ME, Nearby.Strategy.P2P_CLUSTER);
        await Nearby.startAdvertise(ME, Nearby.Strategy.P2P_CLUSTER);
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
        setMine(JSON.parse((await AsyncStorage.getItem(MINE_KEY)) ?? '[]'));
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
        Nearby.startDiscovery(ME, Nearby.Strategy.P2P_CLUSTER).catch(() => { discovering = false; });
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

  const raise = (lat: number, lon: number, note: string) => {
    const now = Date.now();
    const id = uid();
    setMine((m) => {
      const next = [...m.filter((x) => store.current[x]), id];
      AsyncStorage.setItem(MINE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
    publish({ id, kind: 'sos', lat, lon, note: note.slice(0, 200), status: 'need', createdAt: now, updatedAt: now });
  };

  const setStatus = (id: string, status: Status) => {
    const cur = store.current[id];
    if (cur) publish({ ...cur, status, updatedAt: Math.max(Date.now(), cur.updatedAt + 1) });
  };

  // Medic heartbeat: one record per medic, refreshed on every GPS move and at least every 30s.
  const medicCreated = useRef(Date.now());
  const pingMedic = (lat: number, lon: number, target: string | null) => {
    publish({
      id: 'm-' + ME, kind: 'medic', lat, lon, note: '', status: 'need',
      createdAt: medicCreated.current, updatedAt: Date.now(), ...(target ? { target } : {}),
    });
  };

  return { records, peerCount, error, incoming, mine, me: 'm-' + ME, clearIncoming: () => setIncoming(null), raise, setStatus, pingMedic };
}
