import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Camera, GeoJSONSource, Layer, Map as MapView, Marker, type CameraRef, type MapRef,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Image, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Pressable, Platform, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, Vibration, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Manif from './modules/manif';
import { TAGS } from './src/codec';
import { coverage, coverageAll, distanceM, ON_SITE_M, type Alert as MeshRecord } from './src/alerts';
import { ensurePermissions, useMesh } from './src/mesh';
import { MAP_STYLE } from './src/mapStyle';
import { center, downloadCity, installCount, loadCity, ORIGIN, saveCity, searchCities, type City } from './src/onboarding';
import { buildGraph, guidance, lengthM, shortestPath, type Graph, type LngLat, type Turn } from './src/route';

// Walkable road layers of that style; the router reads their geometry from tiles on the phone.
const ROAD_LAYERS = ['highway_path', 'highway_minor', 'highway_major_inner', 'highway_major_subtle', 'road_pier'];
const WALK_MPS = 1.25;
const MANIF_KEY = 'echo.manif.v1';
const ROLE_KEY = 'echo.role.v1';
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
  arrive: { icon: 'arrow-up', rot: '0deg', label: "Tout droit jusqu'à l'alerte" },
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
// App Store rule 1.2: text written by strangers needs reporting and blocking, impossible without accounts or a
// server. So on iPhone there is no free text: only the preset tags are typed, and shown from other phones.
const FREE_TEXT = Platform.OS !== 'ios';
const shownNote = (note: string) => (FREE_TEXT ? note : note.split(' · ').filter((x) => TAGS.includes(x)).join(' · '));

type Role = 'medic' | 'civil';
type Pos = { lat: number; lon: number; acc?: number; at?: number }; // acc: metres, at: fix time (ms)
type Dialog = { title: string; body?: string; icon?: any; tone?: string; actions: { label: string; color?: string; onPress?: () => void }[] };
type Route = { to: string; coords: LngLat[]; m: number; exact: boolean };

export default function App() {
  const [city, setCity] = useState<City | null | undefined>(undefined); // undefined while loading
  const [skipped, setSkipped] = useState(false); // no network on first launch: let them in anyway
  const [role, setRoleState] = useState<Role | null | undefined>(undefined); // undefined while loading
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useEffect(() => { loadCity().then(setCity, () => setCity(null)); }, []);
  // Saved: after a crash, an OTA restart or the system killing it, the app comes straight back to the map
  // (and the mesh) instead of waiting on the role screen.
  useEffect(() => { AsyncStorage.getItem(ROLE_KEY).then((r) => setRoleState(r === 'medic' || r === 'civil' ? r : null), () => setRoleState(null)); }, []);
  const setRole = (r: Role | null) => { setRoleState(r); (r ? AsyncStorage.setItem(ROLE_KEY, r) : AsyncStorage.removeItem(ROLE_KEY)).catch(() => {}); };

  // First launch: the city is mandatory (its map must be on the phone before the march).
  const firstCity = async (c: City | null) => {
    if (c) { await saveCity(c); setCity(c); } else setSkipped(true);
    const n = await installCount();
    if (n) setDialog({
      title: n === 1 ? '1 personne a installé Brancard' : `${n.toLocaleString('fr-FR')} personnes ont installé Brancard`,
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
    city === undefined || role === undefined ? <View style={{ flex: 1, backgroundColor: C.bg }} /> :
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
  const insets = useSafeAreaInsets();
  if (!dialog) return null;
  return (
    <Overlay onBack={onClose}>
      {/* at the bottom: the actions land under the thumb */}
      <View style={[s.dialogWrap, { paddingBottom: insets.bottom + 12 }]}>
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
      <View style={s.logo}><Image source={require('./assets/mark.png')} style={{ width: 56, height: 56 }} /></View>
      <Text style={s.h1}>Brancard</Text>
      <Text style={s.sub}>Les alertes passent de téléphone en téléphone, même sans réseau. Plus on est nombreux, plus ça porte loin.</Text>
      <View style={{ flex: 1 }} />
      <RoleCard icon="medkit" color={C.green} title="Je suis street medic"
        body="Formation aux premiers secours requise. Ta position est visible par tout le monde." onPress={() => onPick('medic')} />
      <RoleCard icon="person" color={C.blue} title="Je ne suis pas medic"
        body="Tu peux appeler un medic. Ta position n'est partagée que si tu lances une alerte." onPress={() => onPick('civil')} />
      <NotEmergency style={{ marginTop: 16 }} />
      <Pressable onPress={() => Linking.openURL(ORIGIN + '/confidentialite')} hitSlop={12} style={{ alignSelf: 'center', marginTop: 12 }}>
        <Text style={s.link}>Confidentialité</Text>
      </Pressable>
    </View>
  );
}

/** "J'entre en manif" (Android): turns mode manif on, the phone keeps relaying with the screen off. */
function EntryScreen({ medic, onEnter, onLater }: { medic: boolean; onEnter: () => void; onLater: () => void }) {
  const insets = useSafeAreaInsets();
  const points: [any, string][] = [
    ['radio', "Ton téléphone relaie les alertes même écran éteint, dans ta poche. C'est ce qui les fait porter loin."],
    ['lock-open', "Brancard s'affiche dès que tu rallumes l'écran, sans déverrouiller. Le reste du téléphone reste verrouillé."],
    ['navigate', 'Ta position reste à jour : une alerte part tout de suite au bon endroit.'],
    ...(medic ? [['alarm', "Une nouvelle alerte allume l'écran et sonne, comme un appel."] as [any, string]] : []),
  ];
  return (
    <View style={[StyleSheet.absoluteFill, s.role, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}>
      <View style={s.logo}><Ionicons name="megaphone" size={30} color="#fff" /></View>
      <Text style={s.h1}>Tu es en manif ?</Text>
      <Text style={s.sub}>Sans le mode manif, Android met Brancard en veille quand l'écran s'éteint : l'alerte s'arrête à toi.</Text>
      <View style={{ marginTop: 24, gap: 16 }}>
        {points.map(([icon, text]) => (
          <View key={icon} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
            <Ionicons name={icon} size={20} color={C.red} style={{ marginTop: 1 }} />
            <Text style={[s.roleBody, { flex: 1, fontSize: 15, lineHeight: 21, marginTop: 0 }]}>{text}</Text>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <Text style={[s.roleBody, { textAlign: 'center', marginBottom: 16 }]}>La batterie se vide plus vite. Pense à une batterie externe.</Text>
      <Pressable onPress={onLater} hitSlop={12} style={{ alignSelf: 'center', marginBottom: 16 }} accessibilityRole="button">
        <Text style={s.link}>Pas maintenant</Text>
      </Pressable>
      {/* the main action sits lowest, under the thumb */}
      <View style={{ flexDirection: 'row' }}><Btn label="J'entre en manif" color={C.red} onPress={onEnter} /></View>
    </View>
  );
}

/** Brancard coordinates volunteers; it doesn't replace the emergency services. One tap calls 112. */
function NotEmergency({ style }: { style?: any }) {
  return (
    <Pressable onPress={() => Linking.openURL('tel:112')} accessibilityRole="button" accessibilityLabel="Appeler le 112"
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10 }, style, pressed && s.pressed]}>
      <Ionicons name="call" size={16} color={C.muted} />
      <Text style={[s.roleBody, { flex: 1, marginTop: 0, fontSize: 13, lineHeight: 18 }]}>
        Brancard ne remplace pas les secours. Urgence vitale : <Text style={{ color: C.text, fontWeight: '700', textDecorationLine: 'underline' }}>appelle le 15 ou le 112</Text>.
      </Text>
    </Pressable>
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
  // "J'entre en manif" screen: on opening the app while mode manif is off (Android: without it the phone stops
  // relaying once the screen is off, and the alert stops there).
  const [entry, setEntry] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(MANIF_KEY).then((v) => (v === '1' ? setManif(true) : setEntry(!!Manif)), () => setEntry(!!Manif));
  }, []);
  // Économie de batterie: the map draws at most 30 frames/s (pans and camera moves cost half the GPU).
  const [eco, setEco] = useState(false);
  useEffect(() => { AsyncStorage.getItem(ECO_KEY).then((v) => v === '1' && setEco(true), () => {}); }, []);
  const toggleEco = () => { setEco(!eco); AsyncStorage.setItem(ECO_KEY, eco ? '0' : '1').catch(() => {}); };
  useEffect(() => {
    if (!Manif) return;
    Manif.setOverLock(manif);
    // A medic's phone must keep relaying and ringing once locked, mode manif or not: Android freezes apps that
    // aren't in the foreground. The service needs its permissions first.
    if (manif || role === 'medic') ensurePermissions().finally(() => Manif!.setRelay(true));
    else Manif.setRelay(false);
  }, [manif, role]);
  const setManifSaved = (on: boolean) => { setManif(on); AsyncStorage.setItem(MANIF_KEY, on ? '1' : '0').catch(() => {}); };
  const enterManif = () => { setEntry(false); setManifSaved(true); Manif?.keepAlive(); };
  const toggleManif = () => (manif ? setManifSaved(false) : setEntry(true));

  // GPS: always a fresh precise fix while the app is open (an alert must leave at once, from the right place).
  // Medics also keep it with the screen off ("sur place"), and so does everyone in mode manif.
  const gps = useRef<Location.LocationSubscription | null>(null);
  const mapReady = useRef(false);
  // One start at a time: the permission dialog itself fires background -> active, which starts it again.
  const starting = useRef<Promise<boolean> | null>(null);
  const startGps = () => (starting.current ??= startGpsOnce().finally(() => { starting.current = null; }));
  const startGpsOnce = async () => {
    if (gps.current) return true;
    await ensurePermissions();
    if ((await Location.requestForegroundPermissionsAsync()).status !== 'granted') return false;
    let first = !posRef.current;
    const onPos = (l: Location.LocationObject) => {
      const p = { lat: l.coords.latitude, lon: l.coords.longitude, acc: l.coords.accuracy ?? undefined, at: l.timestamp };
      setPos(p);
      if (first) { first = false; if (mapReady.current) cam.current?.flyTo({ center: [p.lon, p.lat], zoom: 17.5, duration: 800 }); }
    };
    // A last known fix only if recent and decent: an hours-old one (from home) must not place an SOS.
    const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 200 }).catch(() => null);
    if (last) onPos(last);
    gps.current ??= await Location.watchPositionAsync(
      role === 'medic'
        // a fix every 20 s even standing still (heartbeat), every 3 s while heading to an alert (guidance)
        ? { accuracy: Location.Accuracy.High, distanceInterval: 0, timeInterval: goingRef.current ? 3000 : 20_000 }
        // civilians too: a precise fix every 5 s, standing still included, so an alert leaves at once
        : { accuracy: Location.Accuracy.High, distanceInterval: 0, timeInterval: 5000 },
      onPos,
    );
    return true;
  };
  const stopGps = () => { gps.current?.remove(); gps.current = null; };
  useEffect(() => {
    startGps().catch(() => {});
    const app = AppState.addEventListener('change', (st) => {
      // Medics keep the GPS on (heartbeat, "sur place"), and so does everyone in mode manif: an alert raised
      // right after unlocking then starts from a recent position. Otherwise it stops with the screen off.
      if (role === 'medic' || manifRef.current) return;
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
  // Once on site: "care" (on s'en occupe) or "help" (besoin de renfort), sent in the heartbeat with the target.
  const [care, setCare] = useState<'care' | 'help' | null>(null);
  const careRef = useRef(care);
  careRef.current = care;
  useEffect(() => setCare(null), [going]);
  // Guidance needs fast fixes, the rest of the time a slow GPS saves battery: switch when a trip starts or ends.
  const tripping = !!going;
  useEffect(() => {
    if (role !== 'medic' || !gps.current) return;
    stopGps();
    startGps().catch(() => {});
  }, [tripping]);
  // Medic heartbeat (tuned with scripts/simulate-crowd.ts): when moved 20 m and 20 s passed, every 90 s otherwise,
  // at once when the target or the on-site answer changes. Every heartbeat is relayed by every phone of the
  // crowd, so fewer of them keep the radio free for alerts. Driven by GPS fixes, which keep coming with the
  // screen off (the app's timers don't); the medic GPS reports every 20 s even standing still.
  const lastPing = useRef({ at: 0, lat: 0, lon: 0 });
  const ping = (force = false) => {
    const p = posRef.current;
    if (role !== 'medic' || !p) return;
    if (p.at && Date.now() - p.at > 120_000) return; // stale fix (indoors, GPS off): say nothing rather than lie
    const last = lastPing.current, dt = Date.now() - last.at;
    const moved = distanceM(p.lat, p.lon, last.lat, last.lon);
    if (!force && !(dt >= 20_000 && moved >= 20) && dt < 90_000) return;
    lastPing.current = { at: Date.now(), lat: p.lat, lon: p.lon };
    mesh.pingMedic(p.lat, p.lon, goingRef.current, careRef.current);
  };
  useEffect(() => ping(), [pos]);
  useEffect(() => ping(true), [going, care]);
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
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE, // details only once unlocked
      });
      await Notifications.requestPermissionsAsync();
      checkAlarm();
    })().catch(() => {});
    // Back from the settings screen we opened: check again (one issue fixed, maybe another left).
    const app = AppState.addEventListener('change', (st) => { if (st === 'active' && sentToSettings.current) checkAlarm(); });
    return () => app.remove();
  }, [role]);
  // A medic whose alarm can't ring must know before the march, not when nobody comes.
  const sentToSettings = useRef(false);
  const checkAlarm = async () => {
    sentToSettings.current = false;
    const issues: string[] = Manif ? Manif.alarmIssues() : (await Notifications.getPermissionsAsync()).granted ? [] : ['notifications'];
    const issue = issues[0];
    if (!issue) return;
    const text: Record<string, string> = {
      notifications: "Les notifications de Brancard sont bloquées : une nouvelle alerte ne sonnera pas quand l'app est en arrière-plan.",
      fullscreen: "Android n'autorise pas Brancard à allumer l'écran : une nouvelle alerte n'apparaîtra pas écran verrouillé.",
      dnd: "Le mode Ne pas déranger est activé : une nouvelle alerte ne sonnera pas. Coupe-le pendant la manif.",
    };
    setDialog({
      icon: 'notifications-off', tone: C.orange, title: 'Tes alertes risquent de ne pas sonner', body: text[issue],
      actions: [{ label: 'Plus tard' }, {
        label: 'Réglages', color: C.orange,
        onPress: () => { sentToSettings.current = true; Manif ? Manif.openSettings(issue) : Linking.openSettings(); },
      }],
    });
  };
  // App not in front: a full-screen alert that lights the screen up, like a call (Android); a notification
  // where that doesn't exist (iPhone).
  const alarm = (title: string, body: string) => {
    if (Manif) Manif.wake(title, body);
    else Notifications.scheduleNotificationAsync({ content: { title, body, sound: 'default' }, trigger: { channelId: 'sos' } }).catch(() => {});
  };
  useEffect(() => {
    const a = mesh.incoming;
    // Every new alert rings, even seconds after another: several casualties at once is the norm in a charge.
    if (!a || role !== 'medic') return;
    Vibration.vibrate([0, 500, 200, 500, 200, 500]);
    const body = [shownNote(a.note), describe(a, posRef.current)].filter(Boolean).join(' · ');
    if (AppState.currentState === 'active') return;
    alarm("🚨 Besoin d'un medic", body);
  }, [mesh.incoming]);

  // Derived data, recomputed only when the mesh changes (not on every GPS fix).
  const { sos, medics, cov, medicsGeo, states } = useMemo(() => {
    const sos = mesh.records.filter((r) => r.kind === 'sos' && r.status !== 'done');
    const medics = mesh.records.filter((r) => r.kind === 'medic');
    const cov = coverageAll(sos, medics);
    const medicsGeo: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: medics.map((m) => ({
        type: 'Feature', properties: { me: m.id === mesh.me }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
      })),
    };
    // What the medics already there say, per SOS: taken care of, or asking for reinforcements.
    const states = new Map<string, { care: number; help: number }>();
    for (const m of medics) {
      if (!m.target || !m.state || m.id === mesh.me) continue;
      const st = states.get(m.target) ?? { care: 0, help: 0 };
      st[m.state]++;
      states.set(m.target, st);
    }
    return { sos, medics, cov, medicsGeo, states };
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
      const done = mesh.records.find((r) => r.id === going);
      const body = done?.doneBy ? "Un medic sur place a marqué résolue l'alerte vers laquelle tu allais." : "La personne qui a lancé l'alerte vers laquelle tu allais l'a annulée.";
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

  useEffect(() => {
    if (going && goingTo && pos && !routing && route?.to !== going) computeRoute(goingTo, true);
  }, [pos, going]);

  // Arriving (within 40 m of the SOS you head to): ask how it goes, once. The answer goes to the other medics.
  const asked = useRef(new Set<string>());
  const onSiteAt = (r: MeshRecord | undefined) => !!r && !!pos && distanceM(pos.lat, pos.lon, r.lat, r.lon) <= ON_SITE_M;
  useEffect(() => {
    if (role !== 'medic' || !going || !goingTo || !onSiteAt(goingTo) || asked.current.has(going)) return;
    asked.current.add(going);
    Vibration.vibrate([0, 300, 150, 300]);
    const body = "Comment ça se passe ? Les autres medics verront ta réponse. Seuls les medics sur place, comme toi, peuvent la marquer résolue.";
    setDialog({
      icon: 'medkit', tone: C.green, title: 'Tu es sur place', body,
      actions: [{ label: 'Besoin de renfort', color: C.red, onPress: () => setCare('help') }, { label: "On s'en occupe", color: C.green, onPress: () => setCare('care') }],
    });
    if (AppState.currentState !== 'active') alarm('Tu es sur place', "On s'en occupe, ou besoin de renfort ?");
  }, [pos, going]);

  // A medic on site asks for reinforcements: alert the other medics, every time.
  const toldHelp = useRef(new Set<string>());
  useEffect(() => {
    if (role !== 'medic') return;
    const id = [...states].find(([sid, st]) => st.help > 0 && sid !== going && !toldHelp.current.has(sid))?.[0];
    const r = id && sos.find((x) => x.id === id);
    if (!id || !r) return;
    toldHelp.current.add(id);
    Vibration.vibrate([0, 500, 200, 500]);
    const body = [shownNote(r.note), describe(r, posRef.current)].filter(Boolean).join(' · ');
    setDialog({
      icon: 'warning', title: 'Renfort demandé', body: 'Un medic sur place a besoin d\'aide.' + (body ? '\n' + body : ''),
      actions: [{ label: 'Plus tard' }, { label: "J'y vais", color: C.orange, onPress: () => { setGoing(r.id); computeRoute(r, true); } }],
    });
    if (AppState.currentState !== 'active') alarm('🚨 Renfort demandé', body || "Un medic sur place a besoin d'aide.");
  }, [states]);

  // The "new alert" banner goes once that alert is closed (by its author or a medic on site).
  useEffect(() => {
    if (mesh.incoming && !sos.some((r) => r.id === mesh.incoming!.id)) mesh.clearIncoming();
  }, [sos, mesh.incoming]);

  const sel = sos.find((r) => r.id === selected) ?? null;
  const dist = (r: MeshRecord) => (pos ? distanceM(pos.lat, pos.lon, r.lat, r.lon) : 0);
  const nearest = pos ? sos.reduce<MeshRecord | null>((b, r) => (!b || dist(r) < dist(b) ? r : b), null) : sos[0] ?? null;
  const myAlert = sos.filter((r) => mesh.mine.includes(r.id)).pop();
  // Bottom card: tapped alert, else (medic) where I'm going / nearest emergency, else (civilian) my own alert.
  const featured = sel ?? (role === 'medic' ? sos.find((r) => r.id === going) ?? nearest : myAlert) ?? null;
  const featuredLabel = sel ? "Besoin d'un medic" : role === 'medic' ? (featured?.id === going ? 'Tu y vas' : 'Alerte la plus proche') : 'Ton alerte';

  // Markers are memoized, so they get a stable callback that reads the latest state through a ref.
  const onSos = useRef((_: MeshRecord) => {});
  onSos.current = (r) => {
    if (!going || r.id === going) {
      setSelected(r.id);
      cam.current?.flyTo({ center: [r.lon, r.lat], zoom: 17.5, duration: 600, padding: going ? navPad : NO_PAD });
      return;
    }
    const c = cov.get(r.id) ?? coverage(r, medics, sos);
    setDialog({
      icon: 'navigate', tone: C.orange, title: 'Aller à cette alerte ?',
      body: [shownNote(r.note), describe(r, pos), `${c.onSite} sur place · ${c.enRoute} en route`].filter(Boolean).join('\n'),
      actions: [{ label: 'Non, je continue' }, { label: 'Y aller', color: C.orange, onPress: () => { setGoing(r.id); computeRoute(r, true); } }],
    });
  };
  const focus = useCallback((r: MeshRecord) => onSos.current(r), []);

  // ---- Offline router: frame both points, let the tiles render, read their streets, A* ----
  const rendered = useRef<(() => void) | null>(null);
  // Padding keeps the medic in the clear area between the direction block and the alert card
  // (camera padding sticks, so every other move resets it with NO_PAD).
  const navPad = { top: insets.top + 110, bottom: insets.bottom + 190, left: 40, right: 40 };
  // Streets read from the tiles last time, and the area they cover: a new route inside it (recalculating,
  // switching to a nearby SOS) skips the camera move and the wait for the map to draw.
  const streets = useRef<{ graph: Graph; box: [number, number, number, number] } | null>(null);
  const readStreets = async (box: [number, number, number, number], waitMs: number) => {
    // ponytail: waits for the next full render (capped); routes over ~3 km zoom out past the tiles
    // that carry small streets, then fall back to a straight line.
    await new Promise<void>((res) => { rendered.current = res; setTimeout(res, waitMs); });
    const feats = await map.current!.queryRenderedFeatures({ layers: ROAD_LAYERS }).catch(() => []);
    const lines: LngLat[][] = [];
    for (const f of feats) {
      const g = f.geometry;
      if (g.type === 'LineString') lines.push(g.coordinates as LngLat[]);
      else if (g.type === 'MultiLineString') lines.push(...(g.coordinates as LngLat[][]));
    }
    streets.current = { graph: buildGraph(lines), box };
    return streets.current.graph;
  };
  const computeRoute = async (r: MeshRecord, zoomOnMe = false) => {
    const p = posRef.current;
    if (!p || !map.current || routing) return;
    setRouting(true);
    try { // an error here must not leave routing stuck on for the whole session
      const from: LngLat = [p.lon, p.lat], to: LngLat = [r.lon, r.lat];
      const inBox = (b: number[], q: LngLat) => q[0] > b[0] + 0.0008 && q[0] < b[2] - 0.0008 && q[1] > b[1] + 0.0008 && q[1] < b[3] - 0.0008;
      const s = streets.current;
      let path = s && inBox(s.box, from) && inBox(s.box, to) ? shortestPath(s.graph, from, to) : null;
      if (!path) {
        const pad = 0.002; // ~200 m around both points so detours fit in the graph
        const box: [number, number, number, number] = [Math.min(from[0], to[0]) - pad, Math.min(from[1], to[1]) - pad, Math.max(from[0], to[0]) + pad, Math.max(from[1], to[1]) + pad];
        cam.current?.fitBounds(box, { padding: { top: insets.top + 70, bottom: 380, left: 30, right: 30 }, duration: 0 });
        // Short first wait; only if the streets read so far don't connect the two points, wait for the rest.
        path = shortestPath(await readStreets(box, 700), from, to) ?? shortestPath(await readStreets(box, 900), from, to);
      }
      const coords = path ?? [from, to];
      setRoute({ to: r.id, coords, m: lengthM(coords), exact: !!path });
      // "J'y vais": the whole route, framed between the direction block and the bottom panel.
      if (zoomOnMe) {
        let [w, s_, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of coords) { w = Math.min(w, x); e = Math.max(e, x); s_ = Math.min(s_, y); n = Math.max(n, y); }
        cam.current?.fitBounds([w, s_, e, n], { padding: navPad, duration: 700 });
      }
    } finally { setRouting(false); }
  };

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeCity = useCallback(() => setCityOpen(false), []);
  // A precise fix asked the moment the sheet opens: ready by the time the details are picked.
  const freshFix = useRef<Promise<Pos | null> | null>(null);
  const askFix = () => (freshFix.current ??= Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    .then((l) => { const p = { lat: l.coords.latitude, lon: l.coords.longitude, acc: l.coords.accuracy ?? undefined, at: l.timestamp }; setPos(p); return p; })
    .catch(() => null).finally(() => { freshFix.current = null; }));
  // 3 open alerts per phone at most (this app's limit: a modified app can't be stopped, the mesh has no identities).
  const MAX_MINE = 3;
  const openSheet = (at: Pos | null) => {
    if (sos.filter((r) => mesh.mine.includes(r.id)).length >= MAX_MINE) return setDialog({
      title: 'Déjà 3 alertes en cours',
      body: 'Annule une de tes alertes, ou attends qu\'un medic la résolve, pour en lancer une nouvelle.',
      actions: [{ label: 'OK', color: C.blue }],
    });
    setTags([]); setNote(''); setSheet({ at }); if (!at) askFix();
  };
  const target = sheet?.at ?? pos;
  const [locating, setLocating] = useState(false);
  const confirm = async () => {
    let at = target;
    if (!at || locating) return;
    if (!sheet?.at && (!pos?.at || Date.now() - pos.at > 20_000 || (pos.acc ?? 0) > 50)) {
      // Old or coarse fix (rare: the GPS runs every 5 s): use the one asked when the sheet opened, but never
      // hold the alert more than 1.5 s with someone hurt.
      setLocating(true);
      const fresh = await Promise.race([askFix(), new Promise<null>((ok) => setTimeout(() => ok(null), 1500))]);
      setLocating(false);
      if (fresh) at = fresh;
    }
    mesh.raise(at.lat, at.lon, [...tags, note.trim()].filter(Boolean).join(' · '), role === 'medic' ? mesh.me : undefined);
    setSheet(null);
  };

  // Closing: the author (cancel), or a medic on site (resolve, with their position, checked by every phone).
  const close = (id: string) => {
    if (going === id) { setGoing(null); setRoute(null); }
    if (mesh.mine.includes(id)) mesh.cancel(id);
    else if (pos) mesh.resolve(id, pos.lat, pos.lon);
    setSelected(null);
  };
  const resolve = (id: string) => setDialog({
    title: 'Alerte résolue ?',
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
        <Pressable style={({ pressed }) => [s.pill, pressed && s.pressed]} onPress={() => setDialog({ // one stray tap in a crowd must not stop the relay
          icon: 'swap-horizontal', title: 'Changer de rôle ?',
          body: "Le relais des alertes s'arrête tant que tu n'as pas choisi à nouveau." + (going ? ' Ton trajet en cours sera annulé.' : ''),
          actions: [{ label: 'Annuler' }, { label: 'Changer', color: C.red, onPress: onSwitch }],
        })} accessibilityLabel="Changer de rôle">
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

      {mesh.clockSkewMin !== null && !mesh.error && !nav && (
        // A wrong clock gets our alerts rejected by every other phone, silently.
        <Pressable onPress={() => (Platform.OS === 'android' ? Linking.sendIntent('android.settings.DATE_SETTINGS') : Linking.openSettings()).catch(() => {})}
          style={[s.err, { top: insets.top + topH }]} accessibilityRole="button">
          <Ionicons name="time" size={18} color="#111" />
          <Text style={s.errText}>
            L'heure de ton téléphone est {mesh.clockSkewMin > 0 ? 'en retard' : 'en avance'} d'environ {Math.abs(mesh.clockSkewMin)} min sur les autres : tes alertes risquent d'être ignorées. Touche ici et règle l'heure sur automatique.
          </Text>
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
        const c = coverage(goingTo, medics.filter((m) => m.id !== mesh.me), sos);
        return (
          <View style={[s.bottom, { paddingBottom: insets.bottom + 16 }]} pointerEvents="box-none">
            <Pressable style={({ pressed }) => [s.round, { alignSelf: 'flex-end', marginBottom: 12 }, pressed && s.pressed]} accessibilityLabel="Me recentrer" onPress={locate}>
              <Ionicons name="locate" size={20} color={C.text} />
            </Pressable>
            <View style={s.navPanel}>
              {!!shownNote(goingTo.note) && <Text style={s.navNote} numberOfLines={1}>{shownNote(goingTo.note)}</Text>}
              <View style={[s.row, { flexWrap: 'wrap' }]}>
                <View style={s.stat}><Ionicons name="medkit" size={14} color={C.green} /><Text style={s.statText}>{c.onSite} sur place</Text></View>
                <View style={s.stat}><Ionicons name="walk" size={14} color={C.orange} /><Text style={s.statText}>{c.enRoute} en route, sans toi</Text></View>
              </View>
              <View style={[s.row, { marginTop: 10 }]}>
                <Btn icon="close" label="Annuler le trajet" color={C.line} onPress={() => { setGoing(null); setRoute(null); }} />
                {onSiteAt(goingTo) && <Btn label="Résolu" color={C.green} onPress={() => resolve(goingTo.id)} />}
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
          const c = cov.get(featured.id) ?? coverage(featured, medics, sos);
          const mine = mesh.mine.includes(featured.id);
          const r = route?.to === featured.id ? route : null;
          const note = shownNote(featured.note);
          return (
            <Pressable style={[s.card, { marginBottom: 10 }]} onPress={() => focus(featured)}>
              {/* One line: what (or "Ton alerte"), distance and age, who's coming / there. */}
              <View style={s.row} accessibilityLabel={featuredLabel}>
                <View style={[s.dot, { backgroundColor: tone(c) }]} />
                <Text style={[s.cardTitle, { flexShrink: 1 }]} numberOfLines={1}>{mine ? 'Ton alerte' : note || 'Alerte'}</Text>
                <Text style={[s.cardMeta, { flex: 1 }]} numberOfLines={1}>{describe(featured, pos)}</Text>
                <View style={s.stat}><Ionicons name="walk" size={13} color={C.orange} /><Text style={s.statText}>{c.enRoute}</Text></View>
                <View style={s.stat}><Ionicons name="medkit" size={13} color={C.green} /><Text style={s.statText}>{c.onSite}</Text></View>
                {(routing || r) && (
                  <View style={s.stat}>
                    <Ionicons name="navigate" size={13} color={C.blue} />
                    <Text style={s.statText}>{routing ? '…' : `${Math.max(1, Math.round(r!.m / WALK_MPS / 60))} min`}</Text>
                  </View>
                )}
                {sel && (
                  <Pressable onPress={() => setSelected(null)} hitSlop={14} accessibilityLabel="Fermer">
                    <Ionicons name="close" size={20} color={C.muted} />
                  </Pressable>
                )}
              </View>
              {!!states.get(featured.id)?.help && <Text style={[s.hint, { color: C.red }]}>Renfort demandé par un medic sur place</Text>}
              {!states.get(featured.id)?.help && !!states.get(featured.id)?.care && <Text style={[s.hint, { color: C.green }]}>Pris en charge par un medic sur place</Text>}
              {mine && mesh.peerCount === 0 && <Text style={[s.hint, { color: C.orange }]}>Pas encore transmise : aucun téléphone à portée</Text>}
              <View style={[s.row, { marginTop: 8 }]}>
                {role === 'medic' && !mine && (going === featured.id
                  ? <Btn small label="Je n'y vais plus" color={C.line} onPress={() => { setGoing(null); setRoute(null); }} />
                  : <Btn small label="J'y vais" color={C.orange} onPress={() => { setGoing(featured.id); computeRoute(featured, true); }} />)}
                {role === 'medic' && !mine && onSiteAt(featured) && <Btn small label="Résolu" color={C.green} onPress={() => resolve(featured.id)} />}
                {mine && <Btn small label="Annuler mon alerte" color={C.line} onPress={() => cancelMine(featured.id)} />}
                {mine && role === 'medic' && <Btn small label="Résolu" color={C.green} onPress={() => resolve(featured.id)} />}
                {!mine && pos && <Btn small icon="navigate" a11y="Itinéraire" color={C.blue} onPress={() => computeRoute(featured)} />}
              </View>
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
          <Text style={[s.cardMeta, { marginTop: 6 }]}>
            {sheet?.at ? 'Au point choisi sur la carte'
              : pos ? `À ta position GPS${pos.acc ? ` (± ${Math.round(pos.acc)} m)` : ''}` : 'En attente du GPS… (ou appui long sur la carte)'}
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
          {FREE_TEXT && <TextInput value={note} onChangeText={setNote} maxLength={120} placeholder="Autre détail…"
            placeholderTextColor={C.muted} style={s.input} />}
          <NotEmergency style={{ marginTop: 18 }} />
          <Pressable onPress={confirm} disabled={!target || locating}
            style={({ pressed }) => [s.sos, { marginTop: 12 }, (!target || locating) && { opacity: 0.6 }, pressed && s.pressed]}
            accessibilityRole="button" accessibilityLabel="Confirmer l'alerte">
            {locating ? <ActivityIndicator color="#fff" /> : <Ionicons name="checkmark-circle" size={28} color="#fff" />}
            <Text style={s.sosText}>{locating ? 'LOCALISATION…' : "CONFIRMER L'ALERTE"}</Text>
          </Pressable>
        </View>
        </KeyboardAvoidingView>
      </Overlay>}

      {cityOpen && <Overlay onBack={closeCity}><CityPicker onDone={cityDownloaded} onClose={closeCity} /></Overlay>}
      {entry && <EntryScreen medic={role === 'medic'} onEnter={enterManif} onLater={() => setEntry(false)} />}
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

function Btn(p: { label?: string; icon?: any; a11y?: string; color: string; busy?: boolean; small?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={p.onPress} accessibilityRole="button" accessibilityLabel={p.label ?? p.a11y}
      style={({ pressed }) => [s.btn, p.small && s.btnSm, !p.label && (p.small ? s.iconBtnSm : s.iconBtn), { backgroundColor: fill(p.color) }, pressed && s.pressed]}>
      {p.busy ? <ActivityIndicator color={ink(p.color)} /> : p.icon && <Ionicons name={p.icon} size={22} color={ink(p.color)} />}
      {!!p.label && <Text style={[s.btnText, p.small && s.btnTextSm, { color: ink(p.color) }]} numberOfLines={1}>{p.label}</Text>}
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
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.bg, borderRadius: 9, paddingHorizontal: 8, height: 26 },
  statText: { color: C.text, fontWeight: '700', fontSize: 13 },

  bottom: { position: 'absolute', left: 16, right: 16, bottom: 0 },
  sos: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, height: 64, borderRadius: 22, backgroundColor: fill(C.red), ...shadow },
  sosText: { color: '#fff', fontSize: 19, fontWeight: '900', letterSpacing: 0.5 },
  card: { backgroundColor: C.card, borderRadius: 20, padding: 12, paddingHorizontal: 14, ...shadow },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '800' },
  cardNote: { color: C.text, fontSize: 14 },
  cardMeta: { color: C.muted, fontSize: 13 },
  btn: { flex: 1, flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { flex: 0, width: 50 },
  pressed: { opacity: 0.75 },
  btnSm: { height: 44, borderRadius: 12, paddingHorizontal: 10 },
  iconBtnSm: { flex: 0, width: 44 },
  btnTextSm: { fontSize: 15 },
  hint: { fontSize: 13, fontWeight: '600', marginTop: 6 },
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
  link: { color: C.muted, fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  cancelText: { color: C.muted, fontWeight: '700', fontSize: 16 },

  dialogWrap: { flex: 1, justifyContent: 'flex-end', padding: 12 },
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
