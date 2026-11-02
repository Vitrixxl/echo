import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Camera, GeoJSONSource, Layer, Map as MapView, Marker, type CameraRef, type MapRef,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, Vibration, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Manif from './modules/manif';
import { coverage, distanceM, type Alert as MeshRecord } from './src/alerts';
import { ensurePermissions, useMesh } from './src/mesh';
import { MAP_STYLE } from './src/mapStyle';
import { center, downloadCity, installCount, loadCity, saveCity, searchCities, type City } from './src/onboarding';
import { buildGraph, guidance, lengthM, shortestPath, type LngLat, type Turn } from './src/route';

// Walkable road layers of that style; the router reads their geometry from tiles on the phone.
const ROAD_LAYERS = ['highway_path', 'highway_minor', 'highway_major_inner', 'highway_major_subtle', 'road_pier'];
const WALK_MPS = 1.25;
const MANIF_KEY = 'echo.manif.v1';
const ECO_KEY = 'echo.eco.v1';
const NO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
const OFF_ROUTE_M = 40; // further than this from the route: offer to recompute it
const ARRIVED_M = 25;
const TURN: Record<Turn, { icon: any; rot: string; label: string }> = {
  left: { icon: 'arrow-back', rot: '0deg', label: 'Tourne à gauche' },
  right: { icon: 'arrow-forward', rot: '0deg', label: 'Tourne à droite' },
  'slight-left': { icon: 'arrow-up', rot: '-45deg', label: 'Légèrement à gauche' },
  'slight-right': { icon: 'arrow-up', rot: '45deg', label: 'Légèrement à droite' },
  uturn: { icon: 'arrow-undo', rot: '0deg', label: 'Fais demi-tour' },
  arrive: { icon: 'arrow-up', rot: '0deg', label: "Tout droit jusqu'à l'urgence" },
};
const C = {
  bg: '#0F1115', card: '#171A21', line: '#262A33', text: '#F2F4F7', muted: '#9BA1A6',
  red: '#E5484D', orange: '#F5A524', green: '#30A46C', blue: '#3E8EF7',
};
// One dim for every overlay: dark enough that the white map doesn't wash through.
const DIM = C.bg + 'D9';
// Fills that carry text or icons, deep enough for 4.5:1 with white in daylight. The bright C.* hues
// stay for dots, map pins and icons on the dark surfaces; orange keeps its hue and takes dark ink.
const FILL: Record<string, string> = { [C.red]: '#D93A40', [C.green]: '#24804F', [C.blue]: '#2563D6' };
const fill = (c: string) => FILL[c] ?? c;
const ink = (c: string) => (c === C.orange ? '#111' : '#fff');
const TAGS = ['Blessure', 'Saignement', 'Gaz lacrymo', 'Malaise', 'Inconscient', 'Brûlure'];

type Role = 'medic' | 'civil';
type Pos = { lat: number; lon: number };
type Dialog = { title: string; body?: string; icon?: any; tone?: string; actions: { label: string; color?: string; onPress?: () => void }[] };
type Route = { to: string; coords: LngLat[]; m: number; exact: boolean };

export default function App() {
  const [city, setCity] = useState<City | null | undefined>(undefined); // undefined while loading
  const [skipped, setSkipped] = useState(false); // no network on first launch: let them in anyway
  const [role, setRole] = useState<Role | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useEffect(() => { loadCity().then(setCity, () => setCity(null)); }, []);

  // First launch: the city is mandatory (its map must be on the phone before the march).
  const firstCity = async (c: City | null) => {
    if (c) { await saveCity(c); setCity(c); } else setSkipped(true);
    const n = await installCount();
    if (n) setDialog({
      title: n === 1 ? '1 personne a Écho' : `${n.toLocaleString('fr-FR')} personnes ont Écho`,
      body: "L'alerte passe de téléphone en téléphone : plus on est nombreux dans le cortège, plus elle va loin. Fais-la installer autour de toi.",
      actions: [{ label: "C'est noté", color: C.red }],
    });
  };

  const pickRole = (r: Role) => r === 'civil' ? setRole(r) : setDialog({
    icon: 'warning',
    title: 'Réservé aux personnes formées',
    body: "Ne te déclare medic que si tu as une formation de secouriste ou de street medic. Les blessés compteront sur toi : un mauvais geste peut aggraver une blessure, et les autres medics peuvent ne pas venir s'ils te voient en route.\n\nEn medic, ta position est visible en continu par tous ceux qui ont l'application, y compris des personnes hostiles.",
    actions: [{ label: 'Retour' }, { label: 'Je suis formé·e', color: C.red, onPress: () => setRole('medic') }],
  });

  const screen =
    city === undefined ? <View style={{ flex: 1, backgroundColor: C.bg }} /> :
    !city && !skipped ? <CityPicker onDone={firstCity} /> :
    !role ? <RoleScreen onPick={pickRole} /> :
    <MapScreen role={role} city={city} onSwitch={() => setRole(null)} />;
  return (
    <SafeAreaProvider>
      <StatusBar style={role ? 'dark' : 'light'} />
      {screen}
      <DialogModal dialog={dialog} onClose={() => setDialog(null)} />
    </SafeAreaProvider>
  );
}

/** Search a city (Nominatim) then download its map. Full screen on first launch, in a modal from the map. */
function CityPicker({ onDone, onClose }: { onDone: (c: City | null) => void; onClose?: () => void }) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<City[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [dl, setDl] = useState<{ city: City; pct: number } | null>(null);

  const search = async () => {
    if (q.trim().length < 2 || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setErr(null);
    try {
      const r = await searchCities(q);
      setResults(r);
      if (!r.length) setErr('Aucune ville trouvée.');
    } catch {
      setErr('Pas de connexion. Il faut internet une fois pour télécharger la carte.');
      setOffline(true);
    }
    setBusy(false);
  };
  const pick = async (c: City) => {
    setDl({ city: c, pct: 0 });
    setErr(null);
    try {
      await downloadCity(c, (pct) => setDl({ city: c, pct }));
      onDone(c);
    } catch (e: any) {
      setErr('Téléchargement interrompu : ' + String(e?.message ?? e));
      setDl(null);
    }
  };

  return (
    <View style={[s.role, { paddingTop: insets.top + (onClose ? 24 : 48), paddingBottom: insets.bottom + 16 }]}>
      <StatusBar style="light" />
      <View style={s.row}>
        <Text style={[s.h1, { marginTop: 0, flex: 1 }]}>Où vas-tu manifester ?</Text>
        {onClose && !dl && (
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => [s.closeBtn, pressed && s.pressed]} accessibilityLabel="Fermer">
            <Ionicons name="close" size={22} color={C.text} />
          </Pressable>
        )}
      </View>
      <Text style={s.sub}>La carte de ta ville est enregistrée sur ton téléphone pour fonctionner sans réseau.</Text>
      {dl ? (
        <View style={{ marginTop: 40 }}>
          <Text style={s.roleTitle}>Carte de {dl.city.name}…</Text>
          <View style={s.bar}><View style={[s.barFill, { width: `${Math.max(3, dl.pct)}%` }]} /></View>
          <Text style={s.cardMeta}>{Math.round(dl.pct)} % · garde l'app ouverte</Text>
        </View>
      ) : (
        <>
          <View style={[s.row, { marginTop: 28 }]}>
            <TextInput value={q} onChangeText={setQ} onSubmitEditing={search} returnKeyType="search" autoFocus={!onClose}
              placeholder="Ville en France (ex : Lyon)" placeholderTextColor={C.muted} style={[s.input, { flex: 1, marginTop: 0 }]} />
            <Btn icon="search" a11y="Chercher" color={C.blue} busy={busy} onPress={search} />
          </View>
          <ScrollView style={{ marginTop: 16 }} keyboardShouldPersistTaps="handled">
            {results?.map((c) => (
              <Pressable key={c.label} onPress={() => pick(c)} style={({ pressed }) => [s.roleCard, pressed && s.pressed]}>
                <Ionicons name="location" size={22} color={C.red} />
                <View style={{ flex: 1 }}>
                  <Text style={s.roleTitle}>{c.name}</Text>
                  <Text style={s.roleBody} numberOfLines={2}>{c.label}</Text>
                </View>
                <Ionicons name="cloud-download-outline" size={22} color={C.muted} />
              </Pressable>
            ))}
          </ScrollView>
        </>
      )}
      {!!err && <Text style={[s.cardMeta, { color: C.orange }]}>{err}</Text>}
      {offline && !onClose && (
        <Pressable onPress={() => onDone(null)} style={{ paddingVertical: 14, alignItems: 'center' }}>
          <Text style={s.cancelText}>Pas de réseau ? Continuer sans carte</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Full-screen layer drawn inside the app's own window (no Modal window: on some phones a Modal
 *  doesn't cover the camera cutout / screen edges). Android back closes it. */
function Overlay({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: DIM }]}><StatusBar style="light" />{children}</View>;
}

function DialogModal({ dialog, onClose }: { dialog: Dialog | null; onClose: () => void }) {
  if (!dialog) return null;
  return (
    <Overlay onBack={onClose}>
      <View style={s.dialogWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={s.dialog}>
          <View style={s.row}>
            {dialog.icon && <View style={[s.dialogIcon, { backgroundColor: fill(dialog.tone ?? C.red) }]}><Ionicons name={dialog.icon} size={36} color={ink(dialog.tone ?? C.red)} /></View>}
            <Text style={[s.sheetTitle, { flex: 1 }]}>{dialog.title}</Text>
          </View>
          {!!dialog.body && <Text style={s.dialogBody}>{dialog.body}</Text>}
          <View style={[s.row, { marginTop: 22 }]}>
            {dialog.actions.map((a) => (
              <Btn key={a.label} label={a.label} color={a.color ?? C.line} onPress={() => { onClose(); a.onPress?.(); }} />
            ))}
          </View>
        </View>
      </View>
    </Overlay>
  );
}

function RoleScreen({ onPick }: { onPick: (r: Role) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.role, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}>
      <View style={s.logo}><Ionicons name="radio" size={38} color="#fff" /></View>
      <Text style={s.h1}>Écho</Text>
      <Text style={s.sub}>Les alertes passent de téléphone en téléphone, même sans réseau. Plus on est nombreux, plus ça porte loin.</Text>
      <View style={{ flex: 1 }} />
      <RoleCard icon="medkit" color={C.green} title="Je suis street medic"
        body="Formation aux premiers secours requise. Ta position est visible par tout le monde." onPress={() => onPick('medic')} />
      <RoleCard icon="person" color={C.blue} title="Je ne suis pas medic"
        body="Tu peux appeler un medic. Ta position n'est partagée que si tu lances une alerte." onPress={() => onPick('civil')} />
    </View>
  );
}

function RoleCard(p: { icon: any; color: string; title: string; body: string; onPress: () => void }) {
  return (
    <Pressable onPress={p.onPress} style={({ pressed }) => [s.roleCard, pressed && s.pressed]} accessibilityRole="button">
      <View style={[s.roleIcon, { backgroundColor: p.color }]}><Ionicons name={p.icon} size={24} color="#fff" /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.roleTitle}>{p.title}</Text>
        <Text style={s.roleBody}>{p.body}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={C.muted} />
    </Pressable>
  );
}

function MapScreen({ role, city, onSwitch }: { role: Role; city: City | null; onSwitch: () => void }) {
  const insets = useSafeAreaInsets();
  const mesh = useMesh();
  const map = useRef<MapRef>(null);
  const cam = useRef<CameraRef>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const [selected, setSelected] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ at: Pos | null } | null>(null); // at=null -> my GPS position
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [cityOpen, setCityOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routing, setRouting] = useState(false);
  const [, tick] = useState(0);

  // Mode manif (Android): shown over the lock screen, GPS + relay kept alive screen off, alerts wake the screen.
  const [manif, setManif] = useState(false);
  const manifRef = useRef(manif);
  manifRef.current = manif;
  useEffect(() => { AsyncStorage.getItem(MANIF_KEY).then((v) => v === '1' && setManif(true), () => {}); }, []);
  // Économie de batterie: the map draws at most 30 frames/s (pans and camera moves cost half the GPU).
  const [eco, setEco] = useState(false);
  useEffect(() => { AsyncStorage.getItem(ECO_KEY).then((v) => v === '1' && setEco(true), () => {}); }, []);
  const toggleEco = () => { setEco(!eco); AsyncStorage.setItem(ECO_KEY, eco ? '0' : '1').catch(() => {}); };
  useEffect(() => {
    if (!Manif) return;
    if (manif) ensurePermissions().finally(() => Manif!.setActive(true)); // the service needs its permissions first
    else Manif.setActive(false);
  }, [manif]);
  const toggleManif = () => {
    const set = (on: boolean) => { setManif(on); AsyncStorage.setItem(MANIF_KEY, on ? '1' : '0').catch(() => {}); };
    if (manif) return set(false);
    setDialog({
      icon: 'lock-open',
      title: 'Mode manif',
      body: "Écho s'affiche dès que tu rallumes l'écran, sans déverrouiller. Le reste du téléphone reste verrouillé."
        + (role === 'medic' ? '\n\nUne nouvelle alerte allume l\'écran.' : '')
        + "\n\nLe GPS et le relais des alertes restent actifs écran éteint : la batterie se vide plus vite.",
      actions: [{ label: 'Annuler' }, { label: 'Activer', color: C.red, onPress: () => set(true) }],
    });
  };

  // GPS. Battery: medics need precise, frequent fixes ("sur place" is GPS-based); civilians
  // get a coarse, slow fix and stop entirely in the background.
  const gps = useRef<Location.LocationSubscription | null>(null);
  const mapReady = useRef(false);
  const startGps = async () => {
    if (gps.current) return true;
    await ensurePermissions();
    if ((await Location.requestForegroundPermissionsAsync()).status !== 'granted') return false;
    let first = !posRef.current;
    const onPos = (l: Location.LocationObject) => {
      const p = { lat: l.coords.latitude, lon: l.coords.longitude };
      setPos(p);
      if (first) { first = false; if (mapReady.current) cam.current?.flyTo({ center: [p.lon, p.lat], zoom: 17.5, duration: 800 }); }
    };
    const last = await Location.getLastKnownPositionAsync().catch(() => null);
    if (last) onPos(last);
    gps.current ??= await Location.watchPositionAsync(
      role === 'medic'
        ? { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 }
        : { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 15000 },
      onPos,
    );
    return true;
  };
  const stopGps = () => { gps.current?.remove(); gps.current = null; };
  useEffect(() => {
    startGps().catch(() => {});
    const app = AppState.addEventListener('change', (st) => {
      if (role === 'medic' || manifRef.current) return; // medics and mode manif keep the GPS on
      if (st === 'active') startGps().catch(() => {});
      else stopGps();
    });
    const t = setInterval(() => tick((x) => x + 1), 60_000); // refresh "il y a X min"
    return () => { stopGps(); app.remove(); clearInterval(t); };
  }, []);

  const locate = async () => {
    if (pos) return cam.current?.flyTo({ center: [pos.lon, pos.lat], zoom: going ? 18.5 : 17.5, duration: 600, padding: going ? navPad : NO_PAD });
    if (!(await startGps().catch(() => false)))
      setDialog({
        title: 'Position désactivée',
        body: 'Autorise la position pour te situer et envoyer une alerte à ton emplacement.',
        actions: [{ label: 'Annuler' }, { label: 'Réglages', color: C.blue, onPress: () => Linking.openSettings() }],
      });
  };

  // Medic heartbeat: on movement (at most every 10 s) and every 60 s, carrying the SOS they head to.
  const [going, setGoing] = useState<string | null>(null);
  const goingRef = useRef(going);
  goingRef.current = going;
  const lastPing = useRef(0);
  const ping = (force = false) => {
    const p = posRef.current;
    if (role !== 'medic' || !p || (!force && Date.now() - lastPing.current < 10_000)) return;
    lastPing.current = Date.now();
    mesh.pingMedic(p.lat, p.lon, goingRef.current);
  };
  useEffect(() => ping(), [pos]);
  useEffect(() => ping(true), [going]);
  useEffect(() => {
    if (role !== 'medic') return;
    const t = setInterval(() => ping(true), 60_000);
    return () => clearInterval(t);
  }, [role]);

  // Medics get a loud alert for every new SOS: vibration + system notification when in background.
  useEffect(() => {
    if (role !== 'medic') return;
    (async () => {
      await ensurePermissions();
      await Notifications.setNotificationChannelAsync('sos', {
        name: 'Alertes medic', importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 500, 200, 500], sound: 'default',
      });
      await Notifications.requestPermissionsAsync();
    })().catch(() => {});
  }, [role]);
  useEffect(() => {
    const a = mesh.incoming;
    if (!a || role !== 'medic') return;
    Vibration.vibrate([0, 500, 200, 500, 200, 500]);
    const body = [a.note, describe(a, posRef.current)].filter(Boolean).join(' · ');
    if (AppState.currentState === 'active') return;
    if (manifRef.current && Manif) Manif.wake("🚨 Besoin d'un medic", body); // lights the screen, over the lock screen
    else Notifications.scheduleNotificationAsync({
      content: { title: "🚨 Besoin d'un medic", body, sound: 'default' },
      trigger: { channelId: 'sos' },
    }).catch(() => {});
  }, [mesh.incoming]);

  // Derived data, recomputed only when the mesh changes (not on every GPS fix).
  const { sos, medics, cov, medicsGeo } = useMemo(() => {
    const sos = mesh.records.filter((r) => r.kind === 'sos' && r.status !== 'done');
    const medics = mesh.records.filter((r) => r.kind === 'medic');
    const cov = new Map(sos.map((r) => [r.id, coverage(r, medics)]));
    const medicsGeo: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: medics.map((m) => ({
        type: 'Feature', properties: { me: m.id === mesh.me }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
      })),
    };
    return { sos, medics, cov, medicsGeo };
  }, [mesh.records]);
  const meGeo = useMemo<GeoJSON.Feature | null>(
    () => (pos ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] } } : null),
    [pos],
  );
  const routeGeo = useMemo<GeoJSON.Feature | null>(
    () => (route ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } } : null),
    [route],
  );

  // The SOS I'm heading to was closed by someone else (resolved or cancelled): tell me, stop the route.
  useEffect(() => {
    if (going && !sos.some((r) => r.id === going)) {
      setGoing(null);
      const body = "L'alerte vers laquelle tu allais a été clôturée : résolue par un medic ou annulée par la personne.";
      Vibration.vibrate([0, 300, 150, 300]);
      setDialog({ icon: 'checkmark-circle', tone: C.green, title: 'Intervention terminée', body, actions: [{ label: 'OK', color: C.green }] });
      if (AppState.currentState !== 'active')
        Notifications.scheduleNotificationAsync({ content: { title: 'Intervention terminée', body }, trigger: { channelId: 'sos' } }).catch(() => {});
    }
    if (route && !sos.some((r) => r.id === route.to)) setRoute(null);
  }, [sos]);

  const nav = going && route?.to === going && pos ? route : null;
  const g = useMemo(() => (nav?.exact && pos ? guidance(nav.coords, [pos.lon, pos.lat]) : null), [nav, pos]);
  const goingTo = sos.find((r) => r.id === going);
  const leftM = !nav || !pos ? 0 : g?.leftM ?? (goingTo ? distanceM(pos.lat, pos.lon, goingTo.lat, goingTo.lon) : nav.m);
  const arrived = !!nav && leftM < ARRIVED_M;
  const topH = nav ? 92 : 64; // banners sit under the top bar, or under the direction block
  const { height: screenH } = useWindowDimensions();

  const sel = sos.find((r) => r.id === selected) ?? null;
  const dist = (r: MeshRecord) => (pos ? distanceM(pos.lat, pos.lon, r.lat, r.lon) : 0);
  const nearest = pos ? sos.reduce<MeshRecord | null>((b, r) => (!b || dist(r) < dist(b) ? r : b), null) : sos[0] ?? null;
  const myAlert = sos.filter((r) => mesh.mine.includes(r.id)).pop();
  // Bottom card: tapped alert, else (medic) where I'm going / nearest emergency, else (civilian) my own alert.
  const featured = sel ?? (role === 'medic' ? sos.find((r) => r.id === going) ?? nearest : myAlert) ?? null;
  const featuredLabel = sel ? "Besoin d'un medic" : role === 'medic' ? (featured?.id === going ? 'Tu y vas' : 'Urgence la plus proche') : 'Ton alerte';

  // Markers are memoized, so they get a stable callback that reads the latest state through a ref.
  const onSos = useRef((_: MeshRecord) => {});
  onSos.current = (r) => {
    if (!going || r.id === going) {
      setSelected(r.id);
      cam.current?.flyTo({ center: [r.lon, r.lat], zoom: 17.5, duration: 600, padding: going ? navPad : NO_PAD });
      return;
    }
    const c = coverage(r, medics);
    setDialog({
      icon: 'navigate', tone: C.orange, title: 'Aller à cette urgence ?',
      body: [r.note, describe(r, pos), `${c.onSite} sur place · ${c.enRoute} en route`].filter(Boolean).join('\n'),
      actions: [{ label: 'Non, je continue' }, { label: 'Y aller', color: C.orange, onPress: () => { setGoing(r.id); computeRoute(r, true); } }],
    });
  };
  const focus = useCallback((r: MeshRecord) => onSos.current(r), []);

  // ---- Offline router: frame both points, let the tiles render, read their streets, A* ----
  const rendered = useRef<(() => void) | null>(null);
  // Padding keeps the medic in the clear area between the direction block and the alert card
  // (camera padding sticks, so every other move resets it with NO_PAD).
  const navPad = { top: insets.top + 110, bottom: insets.bottom + 190, left: 40, right: 40 };
  const computeRoute = async (r: MeshRecord, zoomOnMe = false) => {
    const p = posRef.current;
    if (!p || !map.current || routing) return;
    setRouting(true);
    const from: LngLat = [p.lon, p.lat], to: LngLat = [r.lon, r.lat];
    const pad = 0.002; // ~200 m around both points so detours fit in the graph
    cam.current?.fitBounds(
      [Math.min(from[0], to[0]) - pad, Math.min(from[1], to[1]) - pad, Math.max(from[0], to[0]) + pad, Math.max(from[1], to[1]) + pad],
      { padding: { top: insets.top + 70, bottom: 380, left: 30, right: 30 }, duration: 0 },
    );
    // ponytail: waits for the next full render (1.5 s cap); routes over ~3 km zoom out past the
    // tiles that carry small streets, then fall back to a straight line.
    await new Promise<void>((res) => { rendered.current = res; setTimeout(res, 1500); });
    const feats = await map.current.queryRenderedFeatures({ layers: ROAD_LAYERS }).catch(() => []);
    const lines: LngLat[][] = [];
    for (const f of feats) {
      const g = f.geometry;
      if (g.type === 'LineString') lines.push(g.coordinates as LngLat[]);
      else if (g.type === 'MultiLineString') lines.push(...(g.coordinates as LngLat[][]));
    }
    const path = shortestPath(buildGraph(lines), from, to);
    const coords = path ?? [from, to];
    setRoute({ to: r.id, coords, m: lengthM(coords), exact: !!path });
    setRouting(false);
    // "J'y vais": once the route is read from the tiles, put the medic's own position up close.
    // "J'y vais": the whole route, framed between the direction block and the bottom panel.
    if (zoomOnMe) {
      const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
      cam.current?.fitBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { padding: navPad, duration: 700 });
    }
  };

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeCity = useCallback(() => setCityOpen(false), []);
  const openSheet = (at: Pos | null) => { setTags([]); setNote(''); setSheet({ at }); };
  const target = sheet?.at ?? pos;
  const confirm = () => {
    if (!target) return;
    mesh.raise(target.lat, target.lon, [...tags, note.trim()].filter(Boolean).join(' · '));
    setSheet(null);
  };

  const close = (id: string) => {
    if (going === id) { setGoing(null); setRoute(null); }
    mesh.setStatus(id, 'done');
    setSelected(null);
  };
  const resolve = (id: string) => setDialog({
    title: 'Urgence résolue ?',
    body: "L'alerte disparaîtra de la carte de tout le monde.",
    actions: [{ label: 'Non' }, { label: 'Oui, résolu', color: C.green, onPress: () => close(id) }],
  });
  const cancelMine = (id: string) => setDialog({
    title: 'Annuler ton alerte ?',
    body: 'Les medics ne viendront plus pour cette alerte.',
    actions: [{ label: 'Non' }, { label: 'Oui, annuler', color: C.red, onPress: () => close(id) }],
  });

  const cityDownloaded = (c: City | null) => {
    setCityOpen(false);
    if (!c) return;
    cam.current?.flyTo({ center: center(c.bounds), zoom: 12, duration: 800 });
    setDialog({ title: 'Carte enregistrée', body: `La carte de ${c.name} marchera même sans réseau.`, actions: [{ label: 'OK', color: C.blue }] });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <MapView ref={map} style={{ flex: 1 }} mapStyle={MAP_STYLE} logo={false} compass={false} androidView="texture" preferredFramesPerSecond={eco ? 30 : 120}
        attributionPosition={nav ? { top: screenH * 0.3, left: 12 } : { top: insets.top + 64, left: 12 }}
        onPress={() => setSelected(null)}
        onDidFinishRenderingMapFully={() => { rendered.current?.(); rendered.current = null; }}
        onDidFinishLoadingMap={() => {
          mapReady.current = true;
          const p = posRef.current;
          if (p) cam.current?.jumpTo({ center: [p.lon, p.lat], zoom: 17.5 });
        }}
        onLongPress={(e) => { const [lon, lat] = e.nativeEvent.lngLat; openSheet({ lat, lon }); }}>
        <Camera ref={cam} initialViewState={{ center: city ? center(city.bounds) : [2.3522, 48.8566], zoom: 12 }} />
        {routeGeo && (
          <GeoJSONSource id="route" data={routeGeo}>
            <Layer id="route" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': C.blue, 'line-width': 6, 'line-opacity': route?.exact ? 0.85 : 0.4 }} />
          </GeoJSONSource>
        )}
        {/* Medics and me are drawn by the GL renderer (cheap), not as one native view each. */}
        <GeoJSONSource id="medics" data={medicsGeo}>
          <Layer id="medics" type="circle" paint={{
            'circle-radius': 9, 'circle-color': C.green, 'circle-stroke-width': 3,
            'circle-stroke-color': ['case', ['get', 'me'], C.blue, '#ffffff'],
          }} />
        </GeoJSONSource>
        {meGeo && (
          <GeoJSONSource id="me" data={meGeo}>
            <Layer id="me-halo" type="circle" paint={{ 'circle-radius': 16, 'circle-color': C.blue, 'circle-opacity': 0.2 }} />
            <Layer id="me" type="circle" paint={{ 'circle-radius': 7, 'circle-color': C.blue, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' }} />
          </GeoJSONSource>
        )}
        {sos.map((r) => {
          const c = cov.get(r.id)!;
          return <SosMarker key={r.id} r={r} enRoute={c.enRoute} onSite={c.onSite} selected={r.id === selected} onPress={focus} />;
        })}
      </MapView>

      {/* Heading to an SOS: big direction block instead of the status bar */}
      {nav && (() => {
        const off = g && g.offM > OFF_ROUTE_M;
        const here = arrived;
        const turn: Turn = here ? 'arrive' : g?.turn ?? 'arrive';
        return (
          <View style={[s.nav, { top: insets.top + 8 }]}>
            <View style={s.navIcon}>
              <Ionicons name={here ? 'flag' : !g ? 'navigate' : off ? 'help' : TURN[turn].icon} size={34} color="#fff"
                style={g && !off && !here ? { transform: [{ rotate: TURN[turn].rot }] } : undefined} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.navBig} numberOfLines={1}>
                {here ? 'Tu es arrivé·e' : off ? 'Hors du chemin' : fmtM(g ? g.toTurnM : leftM)}
                {!here && !off && <Text style={s.navText}>{'  '}{!g ? "à vol d'oiseau" : TURN[turn].label}</Text>}
              </Text>
              <Text style={s.navMeta} numberOfLines={1}>
                {here ? 'La personne est à moins de 25 m' : off ? `À ${fmtM(g.offM)} de l'itinéraire` : `Arrivée dans ${Math.max(1, Math.round(leftM / WALK_MPS / 60))} min · ${fmtM(leftM)}`}
              </Text>
            </View>
            {off && goingTo && <Btn icon="refresh" a11y="Recalculer l'itinéraire" color="#ffffff33" busy={routing} onPress={() => computeRoute(goingTo, true)} />}
          </View>
        );
      })()}

      {/* Top status bar */}
      {!nav && <View style={[s.top, { top: insets.top + 8 }]} pointerEvents="box-none">
        <Pressable style={({ pressed }) => [s.pill, pressed && s.pressed]} onPress={onSwitch} accessibilityLabel="Changer de rôle">
          <View style={[s.dot, { backgroundColor: role === 'medic' ? C.green : C.blue }]} />
          <Text style={s.pillText}>{role === 'medic' ? 'Medic' : 'Civil'}</Text>
        </Pressable>
        <View style={[s.pill, { flex: 1 }]}>
          <Ionicons name="git-network" size={15} color={mesh.peerCount ? C.green : C.muted} />
          <Text style={[s.pillText, { flexShrink: 1 }]} numberOfLines={1}>{mesh.peerCount} relais</Text>
          <Text style={s.pillMuted}>·</Text>
          <Ionicons name="medkit" size={14} color={C.green} />
          <Text style={s.pillText}>{medics.length}</Text>
          <Text style={s.pillMuted}>·</Text>
          <Ionicons name="alert-circle" size={15} color={sos.length ? C.red : C.muted} />
          <Text style={s.pillText}>{sos.length}</Text>
        </View>
        <Pressable style={({ pressed }) => [s.round, pressed && s.pressed]} onPress={() => setCityOpen(true)} accessibilityLabel="Télécharger la carte d'une ville">
          <Ionicons name="cloud-download-outline" size={20} color={C.text} />
        </Pressable>
      </View>}

      {mesh.error && !nav && (
        <Pressable onPress={() => Linking.openSettings()} style={[s.err, { top: insets.top + topH }]}>
          <Ionicons name="bluetooth" size={18} color="#111" />
          <Text style={s.errText}>{mesh.error}</Text>
        </Pressable>
      )}

      {mesh.incoming && role === 'medic' && (
        <Pressable style={[s.banner, { top: insets.top + topH }]}
          onPress={() => { focus(mesh.incoming!); mesh.clearIncoming(); }}>
          <Ionicons name="warning" size={22} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={s.bannerTitle}>Nouvelle alerte medic</Text>
            <Text style={s.bannerBody}>{describe(mesh.incoming, pos)}</Text>
          </View>
          <Pressable onPress={mesh.clearIncoming} hitSlop={12}><Ionicons name="close" size={20} color="#fff" /></Pressable>
        </Pressable>
      )}

      {/* Heading to an SOS: who is there, who is on the way, cancel. Nothing else. */}
      {nav && goingTo && (() => {
        const c = coverage(goingTo, medics.filter((m) => m.id !== mesh.me));
        return (
          <View style={[s.bottom, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
            <Pressable style={({ pressed }) => [s.round, { alignSelf: 'flex-end', marginBottom: 12 }, pressed && s.pressed]} accessibilityLabel="Me recentrer" onPress={locate}>
              <Ionicons name="locate" size={20} color={C.text} />
            </Pressable>
            <View style={s.navPanel}>
              {!!goingTo.note && <Text style={s.navNote} numberOfLines={1}>{goingTo.note}</Text>}
              <View style={[s.row, { flexWrap: 'wrap' }]}>
                <View style={s.stat}><Ionicons name="medkit" size={14} color={C.green} /><Text style={s.statText}>{c.onSite} sur place</Text></View>
                <View style={s.stat}><Ionicons name="walk" size={14} color={C.orange} /><Text style={s.statText}>{c.enRoute} en route, sans toi</Text></View>
              </View>
              <View style={[s.row, { marginTop: 10 }]}>
                <Btn icon="close" label="Annuler le trajet" color={C.line} onPress={() => { setGoing(null); setRoute(null); }} />
                {arrived && <Btn label="Résolu" color={C.green} onPress={() => resolve(goingTo.id)} />}
              </View>
            </View>
          </View>
        );
      })()}

      {/* Bottom: featured alert card + SOS button (always reachable) */}
      {!nav && <View style={[s.bottom, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
        <View style={[s.row, { marginBottom: 12, flexWrap: 'wrap' }]} pointerEvents="box-none">
        {Manif && (
          <Pressable style={({ pressed }) => [s.chip, manif && { backgroundColor: fill(C.red) }, pressed && s.pressed]} hitSlop={6}
            accessibilityRole="switch" accessibilityState={{ checked: manif }} onPress={toggleManif}>
            <Ionicons name={manif ? 'checkmark-circle' : 'lock-open'} size={15} color={C.text} />
            <Text style={s.chipText}>Mode manif</Text>
          </Pressable>
        )}
        <Pressable style={({ pressed }) => [s.chip, eco && { backgroundColor: fill(C.green) }, pressed && s.pressed]} hitSlop={6}
          accessibilityRole="switch" accessibilityState={{ checked: eco }} onPress={toggleEco}>
          <Ionicons name={eco ? 'checkmark-circle' : 'leaf'} size={15} color={C.text} />
          <Text style={s.chipText}>Éco batterie</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [s.round, { marginLeft: 'auto' }, pressed && s.pressed]} accessibilityLabel="Me recentrer" onPress={locate}>
          <Ionicons name="locate" size={20} color={C.text} />
        </Pressable>
        </View>
        {featured && (() => {
          const c = cov.get(featured.id)!;
          const mine = mesh.mine.includes(featured.id);
          const r = route?.to === featured.id ? route : null;
          return (
            <Pressable style={[s.card, { marginBottom: 12 }]} onPress={() => focus(featured)}>
              <View style={s.row}>
                <View style={[s.dot, { backgroundColor: tone(c) }]} />
                <Text style={s.cardTitle}>{featuredLabel}</Text>
                {sel && (
                  <Pressable onPress={() => setSelected(null)} hitSlop={12} style={{ marginLeft: 'auto' }}>
                    <Ionicons name="close" size={20} color={C.muted} />
                  </Pressable>
                )}
              </View>
              {!!featured.note && <Text style={s.cardNote}>{featured.note}</Text>}
              <Text style={s.cardMeta}>{describe(featured, pos)}</Text>
              <View style={[s.row, { marginTop: 10, flexWrap: 'wrap' }]}>
                <View style={s.stat}><Ionicons name="walk" size={14} color={C.orange} /><Text style={s.statText}>{c.enRoute} en route</Text></View>
                <View style={s.stat}><Ionicons name="medkit" size={14} color={C.green} /><Text style={s.statText}>{c.onSite} sur place</Text></View>
                {(routing || r) && (
                  <View style={s.stat}>
                    <Ionicons name="navigate" size={14} color={C.blue} />
                    <Text style={s.statText}>
                      {routing ? 'Calcul…' : `${Math.max(1, Math.round(r!.m / WALK_MPS / 60))} min · ${fmtM(r!.m)}${r!.exact ? '' : " à vol d'oiseau"}`}
                    </Text>
                  </View>
                )}
              </View>
              {(role === 'medic' || (!mine && pos)) && (
                <View style={[s.row, { marginTop: 14 }]}>
                  {role === 'medic' && (going === featured.id
                    ? <Btn label="Je n'y vais plus" color={C.line} onPress={() => { setGoing(null); setRoute(null); }} />
                    : <Btn label="J'y vais" color={C.orange} onPress={() => { setGoing(featured.id); computeRoute(featured, true); }} />)}
                  {role === 'medic' && <Btn label="Résolu" color={C.green} onPress={() => resolve(featured.id)} />}
                  {!mine && pos && <Btn icon="navigate" a11y="Itinéraire" color={C.blue} onPress={() => computeRoute(featured)} />}
                </View>
              )}
              {mine && (
                <View style={[s.row, { marginTop: 10 }]}>
                  <Btn label="Annuler mon alerte" color={C.line} onPress={() => cancelMine(featured.id)} />
                </View>
              )}
            </Pressable>
          );
        })()}
        <Pressable onPress={() => openSheet(null)} style={({ pressed }) => [s.sos, pressed && s.pressed]}
          accessibilityRole="button" accessibilityLabel="Appeler un street medic">
          <Ionicons name="medical" size={28} color="#fff" />
          <Text style={s.sosText}>APPELER UN MEDIC</Text>
        </Pressable>
      </View>}

      {/* Confirmation sheet: the confirm button sits exactly where the SOS button was, and the
          sheet fades in place (no slide), so a fast double tap confirms instead of closing. */}
      {sheet && <Overlay onBack={closeSheet}>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={{ flex: 1 }} onPress={closeSheet} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.row}>
            <Text style={s.sheetTitle}>Envoyer une alerte ?</Text>
            <Pressable onPress={closeSheet} hitSlop={16} style={({ pressed }) => [s.closeBtn, pressed && s.pressed]} accessibilityLabel="Annuler">
              <Ionicons name="close" size={22} color={C.text} />
            </Pressable>
          </View>
          <Text style={s.cardMeta}>
            {sheet?.at ? 'Au point choisi sur la carte' : pos ? 'À ta position GPS actuelle' : 'En attente du GPS… (ou appui long sur la carte)'}
            {' · '}visible par tous les téléphones du mesh
          </Text>
          <Text style={[s.label, { marginTop: 18 }]}>Précisions (facultatif)</Text>
          <View style={s.tags}>
            {TAGS.map((t) => {
              const on = tags.includes(t);
              return (
                <Pressable key={t} style={({ pressed }) => [s.tag, on && s.tagOn, pressed && s.pressed]}
                  onPress={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])}>
                  <Text style={[s.tagText, on && { color: '#fff' }]}>{t}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput value={note} onChangeText={setNote} maxLength={120} placeholder="Autre détail…"
            placeholderTextColor={C.muted} style={s.input} />
          <Pressable onPress={confirm} disabled={!target}
            style={({ pressed }) => [s.sos, { marginTop: 24 }, !target && { opacity: 0.4 }, pressed && s.pressed]}
            accessibilityRole="button" accessibilityLabel="Confirmer l'alerte">
            <Ionicons name="checkmark-circle" size={28} color="#fff" />
            <Text style={s.sosText}>CONFIRMER L'ALERTE</Text>
          </Pressable>
        </View>
        </KeyboardAvoidingView>
      </Overlay>}

      {cityOpen && <Overlay onBack={closeCity}><CityPicker onDone={cityDownloaded} onClose={closeCity} /></Overlay>}
      <DialogModal dialog={dialog} onClose={() => setDialog(null)} />
    </View>
  );
}

// Memoized: SOS markers are native views, so they only re-render when their own data changes.
const SosMarker = memo(function SosMarker(p: {
  r: MeshRecord; enRoute: number; onSite: number; selected: boolean; onPress: (r: MeshRecord) => void;
}) {
  const col = tone(p);
  return (
    <Marker id={p.r.id} lngLat={[p.r.lon, p.r.lat]} onPress={() => p.onPress(p.r)}>
      {/* spacer + halo + badge: equal heights above/below keep the pin centred on the point */}
      <View style={{ alignItems: 'center' }}>
        <View style={{ height: 20 }} />
        <View style={[s.halo, { backgroundColor: col + '40' }]}>
          <View style={[s.pin, { backgroundColor: col }, p.selected && s.pinSel]}>
            <Ionicons name={p.onSite ? 'medkit' : p.enRoute ? 'walk' : 'alert'} size={18} color="#fff" />
          </View>
        </View>
        <View style={[s.badge, !(p.enRoute || p.onSite) && { opacity: 0 }]}>
          <Ionicons name="walk" size={11} color={C.orange} />
          <Text style={s.badgeText}>{p.enRoute}</Text>
          <Ionicons name="medkit" size={11} color={C.green} />
          <Text style={s.badgeText}>{p.onSite}</Text>
        </View>
      </View>
    </Marker>
  );
});

function Btn(p: { label?: string; icon?: any; a11y?: string; color: string; busy?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={p.onPress} accessibilityRole="button" accessibilityLabel={p.label ?? p.a11y}
      style={({ pressed }) => [s.btn, !p.label && s.iconBtn, { backgroundColor: fill(p.color) }, pressed && s.pressed]}>
      {p.busy ? <ActivityIndicator color={ink(p.color)} /> : p.icon && <Ionicons name={p.icon} size={22} color={ink(p.color)} />}
      {!!p.label && <Text style={[s.btnText, { color: ink(p.color) }]}>{p.label}</Text>}
    </Pressable>
  );
}

// Red: nobody coming. Orange: medics en route. Green: a medic is there.
const tone = (c: { enRoute: number; onSite: number }) => (c.onSite ? C.green : c.enRoute ? C.orange : C.red);
// No-break space: "95 m" never splits across lines at large font sizes.
const fmtM = (m: number) => (m < 1000 ? Math.round(m) + '\u00a0m' : (m / 1000).toFixed(1) + '\u00a0km');

function describe(r: MeshRecord, pos: Pos | null) {
  const min = Math.max(0, Math.round((Date.now() - r.createdAt) / 60000));
  const ago = min < 1 ? "à l'instant" : `il y a ${min} min`;
  return pos ? `${fmtM(distanceM(pos.lat, pos.lon, r.lat, r.lon))} · ${ago}` : ago;
}

const shadow = { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 };
const s = StyleSheet.create({
  role: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 24 },
  logo: { width: 64, height: 64, borderRadius: 20, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center' },
  h1: { color: C.text, fontSize: 34, fontWeight: '800', marginTop: 20 },
  sub: { color: C.muted, fontSize: 16, lineHeight: 23, marginTop: 8 },
  roleCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderRadius: 24, padding: 18, marginTop: 12, borderWidth: 1, borderColor: C.line },
  roleIcon: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  roleTitle: { color: C.text, fontSize: 17, fontWeight: '700' },
  roleBody: { color: C.muted, fontSize: 14, lineHeight: 19, marginTop: 3 },

  top: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card + 'F2', borderRadius: 24, height: 48, paddingHorizontal: 16, ...shadow },
  pillText: { color: C.text, fontWeight: '700', fontSize: 14 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card + 'F2', borderRadius: 18, height: 36, paddingHorizontal: 12, ...shadow },
  chipText: { color: C.text, fontWeight: '700', fontSize: 13 },
  pillMuted: { color: C.muted },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.card + 'F2', alignItems: 'center', justifyContent: 'center', ...shadow },
  dot: { width: 10, height: 10, borderRadius: 5 },
  err: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.orange, padding: 14, borderRadius: 24, ...shadow },
  errText: { flex: 1, color: '#111', fontWeight: '600', fontSize: 14, lineHeight: 19 },
  banner: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: fill(C.red), borderRadius: 24, padding: 14, ...shadow },
  bannerTitle: { color: '#fff', fontWeight: '800', fontSize: 15 },
  bannerBody: { color: '#fff', opacity: 0.9, marginTop: 2 },

  halo: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  pin: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#fff', ...shadow },
  pinSel: { transform: [{ scale: 1.2 }] },
  badge: { height: 20, flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 7 },
  badgeText: { color: C.text, fontSize: 11, fontWeight: '800', marginRight: 2 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.bg, borderRadius: 10, paddingHorizontal: 10, height: 30 },
  statText: { color: C.text, fontWeight: '700', fontSize: 13 },

  bottom: { position: 'absolute', left: 16, right: 16, bottom: 0 },
  sos: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, height: 72, borderRadius: 24, backgroundColor: fill(C.red), ...shadow },
  sosText: { color: '#fff', fontSize: 19, fontWeight: '900', letterSpacing: 0.5 },
  card: { backgroundColor: C.card, borderRadius: 24, padding: 18, ...shadow },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: '800' },
  cardNote: { color: C.text, fontSize: 15, marginTop: 10 },
  cardMeta: { color: C.muted, fontSize: 14, marginTop: 6 },
  btn: { flex: 1, flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { flex: 0, width: 50 },
  pressed: { opacity: 0.75 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  sheet: { backgroundColor: C.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 22, paddingHorizontal: 16 }, // 16: confirm lands exactly on the SOS button
  closeBtn: { marginLeft: 'auto', width: 48, height: 48, borderRadius: 24, backgroundColor: C.line, alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  label: { color: C.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  tag: { paddingHorizontal: 16, height: 44, borderRadius: 22, borderWidth: 1, borderColor: C.line, justifyContent: 'center' },
  tagOn: { backgroundColor: fill(C.red), borderColor: fill(C.red) },
  tagText: { color: C.text, fontWeight: '600' },
  input: { marginTop: 12, height: 50, borderRadius: 14, backgroundColor: C.bg, color: C.text, paddingHorizontal: 14, fontSize: 15, borderWidth: 1, borderColor: C.line },
  cancelText: { color: C.muted, fontWeight: '700', fontSize: 16 },

  dialogWrap: { flex: 1, justifyContent: 'center', padding: 24 },
  dialog: { backgroundColor: C.card, borderRadius: 24, padding: 18, ...shadow },
  nav: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: fill(C.blue), borderRadius: 20, padding: 12, ...shadow },
  navIcon: { width: 52, height: 52, borderRadius: 14, backgroundColor: '#ffffff26', alignItems: 'center', justifyContent: 'center' },
  navBig: { color: '#fff', fontSize: 26, fontWeight: '900' },
  navText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  navMeta: { color: '#ffffffD9', fontSize: 14, marginTop: 2 },
  navPanel: { backgroundColor: C.card, borderRadius: 20, padding: 12, ...shadow },
  navNote: { color: C.text, fontSize: 15, fontWeight: '600', marginBottom: 8 },
  dialogIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', marginRight: 4 },
  dialogBody: { color: C.muted, fontSize: 15, lineHeight: 21, marginTop: 8 },
  bar: { height: 10, borderRadius: 5, backgroundColor: C.line, marginTop: 14, overflow: 'hidden' },
  barFill: { height: 10, borderRadius: 5, backgroundColor: C.red },
});
