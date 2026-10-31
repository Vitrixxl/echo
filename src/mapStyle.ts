// White map with readable streets, day or night: OpenFreeMap's Positron, recoloured for contrast.
// The JSON is bundled so the style works offline; it references the same tiles/fonts/sprites URLs
// as the Positron offline pack, so those come from the downloaded city.
// ponytail: positron.json is a snapshot (Oct 2026); refresh it from STYLE if OpenFreeMap changes its sources.
import positron from './positron.json';

const PAINT: Record<string, Record<string, unknown>> = {
  background: { 'background-color': '#ffffff' },
  landuse_residential: { 'fill-color': '#f6f6f4' },
  park: { 'fill-color': '#e2efdb' },
  landcover_wood: { 'fill-color': '#e2efdb' },
  water: { 'fill-color': '#a9c9e8' },
  waterway: { 'line-color': '#a9c9e8' },
  building: { 'fill-color': '#ebebe8', 'fill-outline-color': '#c4c4c0' },
  road_pier: { 'line-color': '#b8b8b8' },
  highway_path: { 'line-color': '#c6c6c6', 'line-opacity': 1 },
  highway_minor: { 'line-color': '#b8b8b8', 'line-opacity': 1 },
  highway_major_casing: { 'line-color': '#7f7f7f' },
  highway_major_subtle: { 'line-color': '#9a9a9a' },
  highway_motorway_casing: { 'line-color': '#7f7f7f' },
  highway_motorway_bridge_casing: { 'line-color': '#7f7f7f' },
  tunnel_motorway_casing: { 'line-color': '#b8b8b8' },
  railway: { 'line-color': '#a8a8a8' },
  railway_transit: { 'line-color': '#a8a8a8' },
  railway_service: { 'line-color': '#a8a8a8' },
  'highway-name-path': { 'text-color': '#3a3a3a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  'highway-name-minor': { 'text-color': '#1c1c1c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  'highway-name-major': { 'text-color': '#1c1c1c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  label_other: { 'text-color': '#1c1c1c' },
};

export const MAP_STYLE = {
  ...positron,
  layers: positron.layers.map((l: any) => (PAINT[l.id] ? { ...l, paint: { ...l.paint, ...PAINT[l.id] } } : l)),
} as any;
