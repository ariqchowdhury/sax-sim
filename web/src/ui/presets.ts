import { PARAMS, type ParamName } from '../engine/params';
import type { SaxGeometry } from '../scene/geometry';
import type { AppState } from '../state';

export interface Preset {
  name: string;
  description: string;
  /** params not listed fall back to defaults */
  params: Partial<Record<ParamName, number>>;
  /** target pressure for the space-bar blow, kPa */
  blow: number;
}

export const PRESETS: Preset[] = [
  { name: 'Default', description: 'Neutral classical-ish setup', params: {}, blow: 3.0 },
  {
    name: 'Jazz bright',
    description: 'High baffle, small chamber, open tip; firmer air, raised tongue',
    params: { tip_opening: 2.4, facing_length: 24, baffle_height: 0.8, chamber_size: 0.3, throat_diameter: 10, lip_force: 0.85, lip_position: 13, lip_damping: 0.3, tongue_x: 0.4, tongue_y: 0.55, breath_noise: 0.1 },
    blow: 3.8,
  },
  {
    name: 'Subtone',
    description: 'Less mouthpiece, soft damped lip, open jaw/low tongue, breathy',
    params: { lip_position: 8, lip_force: 0.55, lip_damping: 0.8, jaw_open: 0.5, tongue_x: 0.6, tongue_y: 0.25, breath_noise: 0.25, baffle_height: 0.2, chamber_size: 0.7 },
    blow: 2.2,
  },
  {
    // HOOK: replaced by a data/alto_sax.json `presets` entry whose name matches /altissimo/i
    // (acoustics lead's tract-tuning settings), see mergeDataPresets()
    name: 'Altissimo setup',
    description: 'High, front tongue (tract resonance tuned up toward the note), firm lip, narrower glottis',
    params: { tongue_x: 0.35, tongue_y: 0.88, tongue_tip: 0.5, lip_force: 1.6, lip_position: 13, lip_damping: 0.5, jaw_open: 0.2, glottis_open: 0.6, reed_strength: 3, baffle_height: 0.6 },
    blow: 4.5,
  },
  {
    name: 'Classical dark',
    description: 'Low baffle, large chamber, close tip, harder reed',
    params: { tip_opening: 1.6, facing_length: 20, baffle_height: 0.1, chamber_size: 0.75, throat_diameter: 12, reed_strength: 3, lip_damping: 0.5 },
    blow: 3.2,
  },
];

export function applyPreset(state: AppState, p: Preset): void {
  for (const d of PARAMS) {
    if (d.name === 'lung_pressure' || d.name === 'reed_model' || d.group === 'Engine' || d.group === 'Environment') continue;
    const v = p.params[d.name as ParamName];
    state.set(d.id, v ?? d.default, 'preset');
  }
}

// ---- data presets (hook for the acoustics lead) ------------------------------------------------
interface DataPreset { name: string; description?: string; params?: Record<string, number>; blow?: number; lung_pressure?: number }

/**
 * Presets from `data/alto_sax.json` → `presets: [{ name, description?, params: {param_name: value},
 * blow? }]` override built-ins with the same name (case-insensitive); an entry whose name matches
 * /altissimo/i replaces the built-in "Altissimo setup". Unknown param names are ignored.
 */
export function mergeDataPresets(geo: SaxGeometry): void {
  const list = (geo as { presets?: unknown }).presets;
  if (!Array.isArray(list)) return;
  for (const raw of list as DataPreset[]) {
    if (!raw || typeof raw.name !== 'string') continue;
    const params: Preset['params'] = {};
    for (const [k, v] of Object.entries(raw.params ?? {})) if (typeof v === 'number' && PARAMS.some((d) => d.name === k)) params[k as ParamName] = v;
    const p: Preset = { name: raw.name, description: raw.description ?? 'from data/alto_sax.json', params, blow: raw.blow ?? raw.lung_pressure ?? 3.0 };
    const i = PRESETS.findIndex((q) => q.name.toLowerCase() === raw.name.toLowerCase() || (/altissimo/i.test(raw.name) && /altissimo/i.test(q.name)));
    if (i >= 0) PRESETS[i] = p;
    else PRESETS.push(p);
  }
}

// ---- user presets (localStorage + JSON export/import) ---------------------------------------
const LS_KEY = 'saxsim.userPresets.v1';

export function loadUserPresets(): Preset[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Preset[];
    return Array.isArray(v) ? v.filter((p) => p && typeof p.name === 'string' && p.params) : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(list: Preset[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode) — presets live for this session only */
  }
}

/** snapshot of the current (non-Engine/Environment, non-lung) params as a preset */
export function capturePreset(state: AppState, name: string, blow: number): Preset {
  const params: Preset['params'] = {};
  for (const d of PARAMS) {
    if (d.name === 'lung_pressure' || d.group === 'Engine' || d.group === 'Environment') continue;
    params[d.name as ParamName] = +state.get(d.id).toFixed(4);
  }
  return { name, description: 'user preset', params, blow };
}

/** parse an exported JSON file: a single preset or an array of presets */
export function parsePresetFile(text: string): Preset[] {
  const v = JSON.parse(text) as unknown;
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((p): p is Preset => !!p && typeof (p as Preset).name === 'string' && typeof (p as Preset).params === 'object')
    .map((p) => ({ name: p.name, description: p.description ?? 'imported', params: p.params, blow: typeof p.blow === 'number' ? p.blow : 3 }));
}
