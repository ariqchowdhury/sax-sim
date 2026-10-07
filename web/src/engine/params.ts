// Mirrors the param table in docs/ARCHITECTURE.md and engine/src/params.rs.
// The array index IS the param id sent over the WASM ABI — never reorder.

export type ParamGroup =
  | 'Air'
  | 'Embouchure'
  | 'Tongue & Tract'
  | 'Reed'
  | 'Mouthpiece'
  | 'Instrument'
  | 'Environment'
  | 'Engine';

export interface ParamDef {
  readonly id: number;
  readonly name: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly label: string;
  readonly group: ParamGroup;
  readonly step?: number;
  readonly description: string;
}

export const PARAMS: readonly ParamDef[] = [
  { id: 0, name: 'lung_pressure', unit: 'kPa', min: 0, max: 10, default: 0, label: 'Lung pressure', group: 'Air', step: 0.01, description: 'target lung (blowing) pressure' },
  { id: 1, name: 'breath_noise', unit: '0–1', min: 0, max: 1, default: 0.05, label: 'Breath noise', group: 'Air', description: 'turbulence noise level' },
  { id: 2, name: 'lip_position', unit: 'mm', min: 2, max: 22, default: 12, label: 'Lip position', group: 'Embouchure', step: 0.1, description: 'where lower lip contacts reed, measured from reed tip' },
  { id: 3, name: 'lip_force', unit: 'N', min: 0, max: 3, default: 1.0, label: 'Lip force', group: 'Embouchure', description: 'lower-lip force pushing reed toward lay' },
  { id: 4, name: 'lip_damping', unit: '0–1', min: 0, max: 1, default: 0.4, label: 'Lip damping', group: 'Embouchure', description: 'lip tissue damping (soft ↔ firm)' },
  { id: 5, name: 'tongue_x', unit: '0–1', min: 0, max: 1, default: 0.5, label: 'Tongue front/back', group: 'Tongue & Tract', description: 'tongue body front(0)…back(1)' },
  { id: 6, name: 'tongue_y', unit: '0–1', min: 0, max: 1, default: 0.4, label: 'Tongue low/high', group: 'Tongue & Tract', description: 'tongue body low(0)…high(1)' },
  { id: 7, name: 'tongue_tip', unit: '0–1', min: 0, max: 1, default: 0.3, label: 'Tongue tip height', group: 'Tongue & Tract', description: 'tongue tip height' },
  { id: 8, name: 'tongue_reed_contact', unit: '0–1', min: 0, max: 1, default: 0, label: 'Tongue on reed', group: 'Tongue & Tract', description: 'tongue touching reed (tonguing/articulation)' },
  { id: 9, name: 'jaw_open', unit: '0–1', min: 0, max: 1, default: 0.3, label: 'Jaw open', group: 'Tongue & Tract', description: 'jaw opening (oral cavity size)' },
  { id: 10, name: 'glottis_open', unit: '0–1', min: 0, max: 1, default: 0.8, label: 'Glottis open', group: 'Tongue & Tract', description: 'glottal opening' },
  { id: 11, name: 'reed_strength', unit: '', min: 1.5, max: 5, default: 2.5, label: 'Reed strength', group: 'Reed', step: 0.25, description: 'commercial reed strength → stiffness' },
  { id: 12, name: 'reed_damping', unit: '0–1', min: 0, max: 1, default: 0.3, label: 'Reed damping', group: 'Reed', description: 'intrinsic reed damping' },
  { id: 13, name: 'tip_opening', unit: 'mm', min: 1.2, max: 3.2, default: 1.9, label: 'Tip opening', group: 'Mouthpiece', description: 'mouthpiece tip opening' },
  { id: 14, name: 'facing_length', unit: 'mm', min: 15, max: 30, default: 22, label: 'Facing length', group: 'Mouthpiece', step: 0.1, description: 'lay/facing length' },
  { id: 15, name: 'baffle_height', unit: '0–1', min: 0, max: 1, default: 0.3, label: 'Baffle height', group: 'Mouthpiece', description: 'low/rollover (0)…high/step baffle (1)' },
  { id: 16, name: 'chamber_size', unit: '0–1', min: 0, max: 1, default: 0.5, label: 'Chamber size', group: 'Mouthpiece', description: 'small (0)…large (1) chamber' },
  { id: 17, name: 'throat_diameter', unit: 'mm', min: 8, max: 16, default: 11, label: 'Throat diameter', group: 'Mouthpiece', step: 0.1, description: 'throat diameter' },
  { id: 18, name: 'mouthpiece_insertion', unit: 'mm', min: 0, max: 20, default: 10, label: 'Mouthpiece insertion', group: 'Instrument', step: 0.1, description: 'how far mouthpiece is pushed onto neck cork (tuning)' },
  { id: 19, name: 'temperature', unit: '°C', min: 0, max: 40, default: 22, label: 'Temperature', group: 'Environment', step: 0.5, description: 'air temperature' },
  { id: 20, name: 'master_gain', unit: '', min: 0, max: 4, default: 1, label: 'Master gain', group: 'Engine', description: 'output gain' },
  { id: 21, name: 'oversample', unit: '×', min: 1, max: 8, default: 4, label: 'Oversampling', group: 'Engine', step: 1, description: 'internal oversampling factor (integer)' },
  // appended by the engine (engine/src/params.rs)
  { id: 22, name: 'reed_model', unit: '', min: 0, max: 1, default: 0, label: 'Reed model (0 lumped · 1 beam)', group: 'Reed', step: 1, description: '0 = lumped single-DOF reed, 1 = distributed beam reed (M4)' },
  { id: 23, name: 'player_assist', unit: '0–1', min: 0, max: 1, default: 0.5, label: 'Player assist', group: 'Embouchure', description: '0 = pure physics … 1 = full automatic embouchure assistance' },
];

export const PARAM_COUNT = PARAMS.length;

/** Named ids for readable call sites. */
export const P = {
  lung_pressure: 0,
  breath_noise: 1,
  lip_position: 2,
  lip_force: 3,
  lip_damping: 4,
  tongue_x: 5,
  tongue_y: 6,
  tongue_tip: 7,
  tongue_reed_contact: 8,
  jaw_open: 9,
  glottis_open: 10,
  reed_strength: 11,
  reed_damping: 12,
  tip_opening: 13,
  facing_length: 14,
  baffle_height: 15,
  chamber_size: 16,
  throat_diameter: 17,
  mouthpiece_insertion: 18,
  temperature: 19,
  master_gain: 20,
  oversample: 21,
  reed_model: 22,
  player_assist: 23,
} as const;

export type ParamName = keyof typeof P;

export function clampParam(id: number, v: number): number {
  const d = PARAMS[id];
  if (!d) return v;
  let x = Math.min(d.max, Math.max(d.min, v));
  if (d.name === 'oversample') x = Math.round(x);
  return x;
}

export function defaultValues(): Float32Array {
  const a = new Float32Array(PARAM_COUNT);
  for (const p of PARAMS) a[p.id] = p.default;
  return a;
}

export function formatParam(id: number, v: number): string {
  const d = PARAMS[id];
  if (!d) return v.toFixed(2);
  const span = d.max - d.min;
  const digits = d.name === 'oversample' ? 0 : span >= 10 ? 1 : 2;
  return `${v.toFixed(digits)}${d.unit && !d.unit.includes('–') ? ' ' + d.unit : ''}`;
}

// Telemetry layout (ARCHITECTURE.md "Telemetry block")
export const T = {
  lung_pressure: 0,
  mouth_pressure: 1,
  mouthpiece_pressure: 2,
  reed_displacement: 3,
  reed_opening: 4,
  flow: 5,
  frequency: 6,
  output_rms: 7,
  cpu_us: 8,
  n_profile: 16,
  profile_start: 17,
} as const;
export const SCOPE_LEN = 64;
