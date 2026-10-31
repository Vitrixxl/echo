// First launch: the city you'll march in (its map is downloaded for offline use) + install counter.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OfflineManager } from '@maplibre/maplibre-react-native';

// OpenFreeMap Positron: OSM vector tiles, free, no key, allowed to cache for offline use. The app draws it
// with its own colours (mapStyle.ts); this URL is what the offline pack downloads.
export const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const STATS_URL = process.env.EXPO_PUBLIC_STATS_URL; // install counter (server/), optional
const CITY_KEY = 'echo.city.v1';
const INSTALLED_KEY = 'echo.installed.v1';
const MAX_DEG = 0.6; // big results (regions...) are capped to ~60 km so a pack stays a few thousand tiles

export type Bounds = [west: number, south: number, east: number, north: number];
export type City = { name: string; label: string; bounds: Bounds };

export const loadCity = async (): Promise<City | null> => JSON.parse((await AsyncStorage.getItem(CITY_KEY)) ?? 'null');
export const saveCity = (c: City) => AsyncStorage.setItem(CITY_KEY, JSON.stringify(c));
export const center = (b: Bounds): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

export function clampBounds([w, s, e, n]: Bounds): Bounds {
  const [cx, cy] = center([w, s, e, n]);
  const hw = Math.min(e - w, MAX_DEG) / 2, hh = Math.min(n - s, MAX_DEG) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

async function getJson(url: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Cities only (OSM city/town): no villages, districts or administrative areas. Nominatim can still
// return one city twice; same-name results less than 15 km apart are merged. Real homonyms
// (Saint-Denis 93 / La Réunion) stay.
const RANK: Record<string, number> = { city: 0, town: 1 };

/** Nominatim (OSM geocoder), France only. Called on submit, never per keystroke, as its usage policy requires. */
export async function searchCities(q: string): Promise<City[]> {
  const rows: any[] = await getJson(
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&accept-language=fr&countrycodes=fr&featureType=city&q=' +
      encodeURIComponent(q.trim()),
    { headers: { 'User-Agent': 'Echo/1.0 (offline street-medic alerts)' } },
  );
  const out: City[] = [];
  for (const r of rows.filter((r) => r.addresstype in RANK).sort((a, b) => RANK[a.addresstype] - RANK[b.addresstype])) {
    const [s, n, w, e] = (r.boundingbox as string[]).map(Number);
    const c: City = { name: r.name || String(r.display_name).split(',')[0], label: String(r.display_name), bounds: clampBounds([w, s, e, n]) };
    const [x, y] = center(c.bounds);
    const dup = out.some((o) => {
      const [ox, oy] = center(o.bounds);
      return o.name === c.name && Math.hypot((x - ox) * Math.cos((y * Math.PI) / 180), y - oy) * 111 < 15;
    });
    if (!dup) out.push(c);
  }
  return out;
}

/** Downloads the city's tiles (z10-14: vector tiles stop at z14 and overzoom) for offline use. */
export function downloadCity(city: City, onProgress: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    OfflineManager.createPack(
      { mapStyle: STYLE, bounds: city.bounds, minZoom: 10, maxZoom: 14, metadata: { name: city.label } },
      (_, st) => { onProgress(st.percentage); if (st.state === 'complete') resolve(); },
      (_, err) => reject(new Error(err.message)),
    ).catch(reject);
  });
}

/** Counts this install once (first successful call), returns how many people have the app. */
export async function installCount(): Promise<number | null> {
  if (!STATS_URL) return null;
  try {
    const first = !(await AsyncStorage.getItem(INSTALLED_KEY));
    const { count } = await getJson(STATS_URL + (first ? '/install' : '/count'), { method: first ? 'POST' : 'GET' });
    if (first) await AsyncStorage.setItem(INSTALLED_KEY, '1');
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}
