// Geometry JSON (data/alto_sax.json) types + loading.
// Schema: docs/ARCHITECTURE.md "Geometry JSON schema". Fields we do not strictly need are optional
// so the viewer stays tolerant while the data file evolves.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface ToneHole {
  id: string;
  x: number;
  radius: number;
  chimney: number;
  pad_rest: 'closed' | 'open';
  pad_open_height: number;
  /** hole outward direction d = cos(th)·n + sin(th)·X, n = t × X (see meta.conventions) */
  angle_deg: number;
  octave_vent?: boolean;
  /** hole centre on the bore wall (3D) */
  position?: Vec3;
  vents?: string | null;
  [k: string]: unknown;
}

export interface KeyAction {
  hole: string;
  set: 'closed' | 'open';
  [k: string]: unknown;
}

export interface KeyDef {
  id: string;
  label?: string;
  hand?: string;
  finger?: number | string | null;
  kind?: string;
  position?: Vec3;
  actions?: KeyAction[];
  [k: string]: unknown;
}

export interface Fingering {
  note: string;
  written_midi: number;
  keys: string[];
  [k: string]: unknown;
}

export interface SaxGeometry {
  meta?: { name?: string; sources?: string[]; notes?: string; [k: string]: unknown };
  mouthpiece: {
    length: number;
    air_length?: number;
    default_insertion?: number;
    profile: Vec2[];
    centerline?: Vec3[];
    centerline_s?: number[];
    nominal?: { window_length?: number; window_width?: number; [k: string]: unknown };
    reed: { length: number; width: number; tip_thickness: number; heel_thickness: number; [k: string]: unknown };
    [k: string]: unknown;
  };
  neck: { profile: Vec2[]; centerline: Vec3[]; centerline_s?: number[]; [k: string]: unknown };
  body: { profile: Vec2[]; centerline: Vec3[]; centerline_s?: number[]; [k: string]: unknown };
  bell: { end_x: number; end_radius: number; [k: string]: unknown };
  tone_holes: ToneHole[];
  keys: KeyDef[];
  linkages: unknown[];
  octave_logic?: unknown;
  fingerings: Fingering[];
  alternate_fingerings?: (Partial<Fingering> & { name?: string; keys: string[]; note: string })[];
  [k: string]: unknown;
}

export interface LoadedGeometry {
  geo: SaxGeometry;
  /** exact JSON text handed to the engine */
  json: string;
}

// Vite glob: resolves to {} if the file does not exist yet; HMR reloads once it is created.
const files = import.meta.glob('@data/alto_sax.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export function loadGeometry(): LoadedGeometry {
  const text = Object.values(files)[0];
  if (typeof text !== 'string' || !text.trim().length) throw new Error('data/alto_sax.json not found');
  const geo = JSON.parse(text) as SaxGeometry;
  validate(geo);
  return { geo, json: text };
}

function validate(g: SaxGeometry): void {
  const need = ['mouthpiece', 'neck', 'body', 'tone_holes', 'keys'] as const;
  for (const k of need) if (!(k in g)) throw new Error(`data/alto_sax.json: missing "${k}"`);
  if (!Array.isArray(g.neck.centerline) || g.neck.centerline.length < 2) throw new Error('data/alto_sax.json: neck.centerline');
  if (!Array.isArray(g.body.centerline) || g.body.centerline.length < 2) throw new Error('data/alto_sax.json: body.centerline');
  g.linkages ??= [];
  g.fingerings ??= [];
  const bp = g.body.profile;
  g.bell ??= { end_x: bp[bp.length - 1][0], end_radius: bp[bp.length - 1][1] };
}
