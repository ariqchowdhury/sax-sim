// The coaching model (data/coach_model.json, produced by the physics lead's tools/coach/): test set,
// control definitions and the fitted subset, render settings, robust-feature weights, prior weight
// and the sensitivity table. `loadModel` follows that file's schema (docs/COACHING.md
// "Objective v1"); it fails soft — missing optional sections fall back to the defaults below
// (which mirror tools/coach/common.py) — and fails loudly with a clear message when a section is
// present but malformed.

export type RegisterGroup = 'low' | 'mid' | 'palm';
export type ControlScope = 'global' | RegisterGroup | 'dyn';

export interface ModelControl {
  key: string;
  /** engine param name (web/src/engine/params.ts) */
  param: string;
  min: number;
  max: number;
  default: number;
  /** control "step" (unit of the prior and of the fit coordinates u = (x − default)/step) */
  step: number;
  scope: ControlScope;
}

export interface ModelNote {
  label: string;
  /** written note = fingering name */
  written: string;
  /** engine `dynamic` param (0 pp … 0.5 mf … 1 ff) */
  dynamic: number;
  register_group: RegisterGroup;
  /** control offsets of a protocol extension (e.g. mouthpiece pushed in 5 mm) */
  control_offsets?: Record<string, number>;
}

export interface SimSettings {
  player_assist: number;
  oversample: number;
  seconds: number;
  tongue_release: number;
  seed: number;
  dynamic_by_label: Record<string, number>;
}

export interface CoachModel {
  version: number;
  test_set: ModelNote[];
  extensions: ModelNote[];
  controls: ModelControl[];
  fit_controls: string[];
  sim: SimSettings;
  /** robust-feature name → weight W_i = 1/σ_i (names absent here are not used) */
  weights: Map<string, number>;
  /** room verdict → weights (optional; `weightsFor(model, verdict)`) */
  weights_by_room: Record<string, Map<string, number>>;
  /** λ of the prior residuals λ·u */
  lambda_prior: number;
  /** ∂robust/∂control (per control unit) at the defaults: robust name list and one column per control key */
  sensitivity?: { robust_names: string[]; J_robust: Record<string, number[]> };
  /**
   * identifiability study: protocol variant ('v1', 'G4push', …) → posterior sd (control steps)
   * per control under room/mic colouration; used as a floor of the fitter's local uncertainty
   */
  identifiability: Record<string, Record<string, number>>;
  /** robust-feature name → σ_room (weights.sigma) */
  sigma: Map<string, number>;
  /** control (cause) rules with a signature (direction in control steps) */
  rules: { id: string; signature: Record<string, number>; room?: string; cause?: string }[];
  /** template cause ranking data per protocol ('v1', 'G4push'), see rank.ts */
  templates: Record<string, { names: string[]; default: number[]; templates: { id: string; mag: number; robust: number[] }[]; sigma_nuisance: number[] }>;
  /** confounded control pairs from the identifiability study: [a, b, correlation] */
  confounds: [string, string, number][];
  /** where the model came from (for reports) */
  source: string;
}

export class CoachModelError extends Error {
  constructor(msg: string) {
    super(`coach_model.json: ${msg}`);
    this.name = 'CoachModelError';
  }
}

// ---------------------------------------------------------------- defaults (= tools/coach/common.py)
const GLOBAL: [string, number, number, number, number][] = [
  ['lip_force', 0.3, 2.5, 1.0, 0.2],
  ['lip_position', 6.0, 20.0, 12.0, 1.5],
  ['lip_damping', 0.0, 1.0, 0.4, 0.15],
  ['mouthpiece_insertion', 0.0, 20.0, 10.0, 3.0],
  ['baffle_height', 0.0, 1.0, 0.3, 0.2],
  ['chamber_size', 0.0, 1.0, 0.5, 0.2],
  ['tip_opening', 1.4, 2.6, 1.9, 0.2],
  ['reed_strength', 1.5, 4.5, 2.5, 0.5],
];
const GROUP: [string, number, number, number, number][] = [
  ['tongue_y', 0, 1, 0.4, 0.15],
  ['tongue_x', 0, 1, 0.5, 0.15],
  ['jaw_open', 0, 1, 0.3, 0.15],
];

function defaultControls(): ModelControl[] {
  const out: ModelControl[] = GLOBAL.map(([n, lo, hi, d, s]) => ({ key: n, param: n, min: lo, max: hi, default: d, step: s, scope: 'global' }));
  for (const g of ['low', 'mid', 'palm'] as const) for (const [n, lo, hi, d, s] of GROUP) out.push({ key: `${n}@${g}`, param: n, min: lo, max: hi, default: d, step: s, scope: g });
  out.push({ key: 'lung_pressure', param: 'lung_pressure', min: 2.0, max: 7.0, default: 3.5, step: 0.4, scope: 'dyn' });
  return out;
}

const DEFAULT_TEST_SET: ModelNote[] = [
  ['Bb3', 'Bb3', 0.5, 'low'], ['D4', 'D4', 0.5, 'low'], ['G4', 'G4', 0.5, 'low'], ['C5', 'C5', 0.5, 'low'],
  ['C#5', 'C#5', 0.5, 'low'], ['D5', 'D5', 0.5, 'mid'], ['G5', 'G5', 0.5, 'mid'], ['C6', 'C6', 0.5, 'mid'],
  ['F6', 'F6', 0.5, 'palm'], ['G4pp', 'G4', 0.15, 'low'], ['G4ff', 'G4', 0.9, 'low'],
].map(([label, written, dynamic, register_group]) => ({ label, written, dynamic, register_group }) as ModelNote);

const DEFAULT_EXTENSIONS: ModelNote[] = [
  { label: 'G4push', written: 'G4', dynamic: 0.5, register_group: 'low', control_offsets: { mouthpiece_insertion: 5 } },
  { label: 'D5pp', written: 'D5', dynamic: 0.15, register_group: 'mid' },
  { label: 'D5ff', written: 'D5', dynamic: 0.9, register_group: 'mid' },
  { label: 'C6ff', written: 'C6', dynamic: 0.9, register_group: 'mid' },
];

/** Default robust-feature weights (1/σ) by name pattern, used when the file has none. */
export function defaultWeight(name: string): number {
  const base = name.split('@')[0];
  if (base === 'cents') return 0.5;
  if (base === 'regime') return 10;
  if (base === 'sounding') return 10;
  if (/^H\d_rel$/.test(base)) return 0.15;
  if (base === 'tilt_rel') return 0.5;
  if (base === 'odd_even_rel') return 0.3;
  if (base === 'edge_rel' || base === 'hnr_rel') return 0.4;
  if (base === 'pitch_std') return 1;
  if (base === 'scoop') return 0.033;
  if (base.endsWith('_mean')) return 0.15;
  if (/_(ff-pp|mf-pp|ff-mf)$/.test(base)) return 0.4;
  if (base.startsWith('cents_push')) return 0.5;
  return 0.2;
}

export const DEFAULT_MODEL: CoachModel = {
  version: 0,
  test_set: DEFAULT_TEST_SET,
  extensions: DEFAULT_EXTENSIONS,
  controls: defaultControls(),
  fit_controls: ['lip_force', 'lip_position', 'lip_damping', 'mouthpiece_insertion', 'baffle_height', 'chamber_size', 'tip_opening', 'reed_strength', 'lung_pressure', 'jaw_open@low'],
  sim: { player_assist: 0.5, oversample: 2, seconds: 2.0, tongue_release: 0.05, seed: 1, dynamic_by_label: {} },
  weights: new Map(),
  weights_by_room: {},
  lambda_prior: 0.5,
  identifiability: {},
  sigma: new Map(),
  templates: {},
  rules: [
    ['mouthpiece_too_far_out', { mouthpiece_insertion: -1 }], ['mouthpiece_too_far_in', { mouthpiece_insertion: 1 }],
    ['biting', { lip_force: 1 }], ['loose_embouchure', { lip_force: -1 }], ['too_much_mouthpiece', { lip_position: 1 }],
    ['too_little_mouthpiece', { lip_position: -1 }], ['too_much_lip_cushion', { lip_damping: 1 }], ['too_little_lip_cushion', { lip_damping: -1 }],
    ['reed_too_hard', { reed_strength: 1 }], ['reed_too_soft', { reed_strength: -1 }], ['tip_opening_large', { tip_opening: 1 }],
    ['bright_baffle', { baffle_height: 1, chamber_size: -0.5 }], ['large_chamber', { chamber_size: 1 }], ['weak_support', { lung_pressure: -1 }],
    ['over_blowing', { lung_pressure: 1 }], ['closed_low_voicing', { 'jaw_open@low': -1 }],
  ].map(([id, signature]) => ({ id: id as string, signature: signature as Record<string, number> })),
  confounds: [['jaw_open@low', 'lung_pressure', 0.7], ['baffle_height', 'chamber_size', 0.65], ['reed_strength', 'lung_pressure', 0.63], ['lip_damping', 'reed_strength', 0.62]],
  source: 'built-in defaults (tools/coach/common.py)',
};

// ---------------------------------------------------------------- loader
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CoachModelError(`${what} must be a finite number`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new CoachModelError(`${what} must be a string`);
  return v;
};

function parseNotes(v: unknown, what: string): ModelNote[] {
  if (!Array.isArray(v)) throw new CoachModelError(`${what} must be an array`);
  return v.map((n, i) => {
    if (!isObj(n)) throw new CoachModelError(`${what}[${i}] must be an object`);
    const g = str(n.register_group, `${what}[${i}].register_group`);
    if (g !== 'low' && g !== 'mid' && g !== 'palm') throw new CoachModelError(`${what}[${i}].register_group "${g}" is not low/mid/palm`);
    const off = n.control_offsets;
    return {
      label: str(n.label, `${what}[${i}].label`),
      written: str(n.written, `${what}[${i}].written`),
      dynamic: num(n.dynamic, `${what}[${i}].dynamic`),
      register_group: g,
      control_offsets: isObj(off) ? Object.fromEntries(Object.entries(off).map(([k, x]) => [k, num(x, `${what}[${i}].control_offsets.${k}`)])) : undefined,
    };
  });
}

function weightMap(names: unknown, weight: unknown, what: string): Map<string, number> {
  if (!Array.isArray(names) || !Array.isArray(weight) || names.length !== weight.length) throw new CoachModelError(`${what}: names and weight must be arrays of equal length`);
  return new Map(names.map((n, i) => [str(n, `${what}.names[${i}]`), num(weight[i], `${what}.weight[${i}]`)]));
}

/** Parse coach_model.json (object or JSON text). Throws CoachModelError on malformed sections. */
export function loadModel(json: unknown): CoachModel {
  if (json === undefined || json === null) return DEFAULT_MODEL;
  const j = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (!isObj(j)) throw new CoachModelError('top level must be an object');
  const m: CoachModel = { ...DEFAULT_MODEL, sim: { ...DEFAULT_MODEL.sim }, weights: new Map(), weights_by_room: {}, identifiability: {}, sigma: new Map(), templates: {}, rules: DEFAULT_MODEL.rules, confounds: DEFAULT_MODEL.confounds, source: 'data/coach_model.json' };
  if (j.version !== undefined) m.version = num(j.version, 'version');
  if (j.test_set !== undefined) m.test_set = parseNotes(j.test_set, 'test_set');
  if (j.protocol_extensions !== undefined) m.extensions = parseNotes(j.protocol_extensions, 'protocol_extensions');
  if (j.controls !== undefined) {
    if (!Array.isArray(j.controls)) throw new CoachModelError('controls must be an array');
    m.controls = j.controls.map((c, i) => {
      if (!isObj(c)) throw new CoachModelError(`controls[${i}] must be an object`);
      const scope = str(c.scope, `controls[${i}].scope`);
      if (!['global', 'low', 'mid', 'palm', 'dyn'].includes(scope)) throw new CoachModelError(`controls[${i}].scope "${scope}" unknown`);
      const ctl: ModelControl = {
        key: str(c.key, `controls[${i}].key`),
        param: str(c.param, `controls[${i}].param`),
        min: num(c.min, `controls[${i}].min`),
        max: num(c.max, `controls[${i}].max`),
        default: num(c.default, `controls[${i}].default`),
        step: num(c.step, `controls[${i}].step`),
        scope: scope as ControlScope,
      };
      if (!(ctl.step > 0) || !(ctl.max > ctl.min)) throw new CoachModelError(`controls[${i}] (${ctl.key}): need step > 0 and max > min`);
      return ctl;
    });
  }
  if (j.fit_controls !== undefined) {
    if (!Array.isArray(j.fit_controls)) throw new CoachModelError('fit_controls must be an array of control keys');
    m.fit_controls = j.fit_controls.map((k, i) => str(k, `fit_controls[${i}]`));
  }
  const unknown = m.fit_controls.filter((k) => !m.controls.some((c) => c.key === k));
  if (unknown.length) throw new CoachModelError(`fit_controls not defined in controls: ${unknown.join(', ')}`);
  if (j.sim_settings !== undefined) {
    if (!isObj(j.sim_settings)) throw new CoachModelError('sim_settings must be an object');
    const s = j.sim_settings;
    for (const k of ['player_assist', 'oversample', 'seconds', 'tongue_release', 'seed'] as const) if (s[k] !== undefined) m.sim[k] = num(s[k], `sim_settings.${k}`);
    if (s.dynamic_by_label !== undefined) {
      if (!isObj(s.dynamic_by_label)) throw new CoachModelError('sim_settings.dynamic_by_label must be an object');
      m.sim.dynamic_by_label = Object.fromEntries(Object.entries(s.dynamic_by_label).map(([k, v]) => [k, num(v, `sim_settings.dynamic_by_label.${k}`)]));
    }
  }
  if (j.weights !== undefined) {
    if (!isObj(j.weights)) throw new CoachModelError('weights must be an object {names, sigma, weight, by_room?}');
    const w = j.weights;
    const wt = w.weight ?? (Array.isArray(w.sigma) ? (w.sigma as unknown[]).map((s, i) => 1 / num(s, `weights.sigma[${i}]`)) : undefined);
    m.weights = weightMap(w.names, wt, 'weights');
    if (Array.isArray(w.sigma)) m.sigma = weightMap(w.names, w.sigma, 'weights(sigma)');
    if (isObj(w.by_room)) for (const [room, arr] of Object.entries(w.by_room)) m.weights_by_room[room] = weightMap(w.names, arr, `weights.by_room.${room}`);
  }
  if (j.objective !== undefined && isObj(j.objective) && j.objective.lambda_prior !== undefined) m.lambda_prior = num(j.objective.lambda_prior, 'objective.lambda_prior');
  if (j.sensitivity !== undefined && isObj(j.sensitivity) && Array.isArray(j.sensitivity.robust_names) && isObj(j.sensitivity.J_robust)) {
    const names = j.sensitivity.robust_names.map((n, i) => str(n, `sensitivity.robust_names[${i}]`));
    const J: Record<string, number[]> = {};
    for (const [k, col] of Object.entries(j.sensitivity.J_robust)) {
      if (!Array.isArray(col) || col.length !== names.length) throw new CoachModelError(`sensitivity.J_robust.${k} must have ${names.length} entries`);
      J[k] = col.map((v, i) => num(v, `sensitivity.J_robust.${k}[${i}]`));
    }
    m.sensitivity = { robust_names: names, J_robust: J };
  }
  if (j.rules !== undefined) {
    if (!Array.isArray(j.rules)) throw new CoachModelError('rules must be an array');
    m.rules = j.rules.flatMap((r, i) => {
      if (!isObj(r)) throw new CoachModelError(`rules[${i}] must be an object`);
      const sig = isObj(r.signature) ? Object.fromEntries(Object.entries(r.signature).map(([k, v]) => [k, num(v, `rules[${i}].signature.${k}`)])) : {};
      if (r.kind !== undefined && r.kind !== 'control') return [];
      return Object.keys(sig).length ? [{ id: str(r.id, `rules[${i}].id`), signature: sig, room: typeof r.room === 'string' ? r.room : undefined, cause: typeof r.cause === 'string' ? r.cause : undefined }] : [];
    });
  }
  if (isObj(j.cause_ranking)) {
    const cr = j.cause_ranking;
    if (cr.method !== undefined && cr.method !== 'template') throw new CoachModelError(`cause_ranking.method "${String(cr.method)}" not supported (template)`);
    if (isObj(cr.templates)) {
      for (const [proto, T] of Object.entries(cr.templates)) {
        if (!isObj(T) || !Array.isArray(T.names) || !Array.isArray(T.default) || !Array.isArray(T.templates)) throw new CoachModelError(`cause_ranking.templates.${proto} needs names, default, templates`);
        const names = T.names.map((n, i) => str(n, `cause_ranking.templates.${proto}.names[${i}]`));
        const L = names.length;
        const vec = (v: unknown, what: string) => {
          if (!Array.isArray(v) || v.length !== L) throw new CoachModelError(`${what} must have ${L} entries`);
          return v.map((x, i) => num(x, `${what}[${i}]`));
        };
        const sn = isObj(cr.sigma_nuisance) ? cr.sigma_nuisance[proto] : undefined;
        m.templates[proto] = {
          names,
          default: vec(T.default, `cause_ranking.templates.${proto}.default`),
          templates: T.templates.map((t, i) => {
            if (!isObj(t)) throw new CoachModelError(`cause_ranking.templates.${proto}.templates[${i}] must be an object`);
            return { id: str(t.id, `…templates[${i}].id`), mag: num(t.mag, `…templates[${i}].mag`), robust: vec(t.robust, `cause_ranking.templates.${proto}.templates[${i}].robust`) };
          }),
          sigma_nuisance: sn === undefined ? new Array(L).fill(0) : vec(sn, `cause_ranking.sigma_nuisance.${proto}`),
        };
      }
    }
  }
  if (isObj(j.identifiability)) {
    for (const [variant, v] of Object.entries(j.identifiability)) {
      if (variant === 'v1' && isObj(v) && Array.isArray(v.confounds)) {
        m.confounds = v.confounds.filter((c): c is [string, string, number] => Array.isArray(c) && c.length === 3 && typeof c[0] === 'string' && typeof c[1] === 'string' && typeof c[2] === 'number');
      }
      if (isObj(v) && isObj(v.posterior_sd_steps)) {
        m.identifiability[variant] = Object.fromEntries(Object.entries(v.posterior_sd_steps).filter(([, x]) => typeof x === 'number' && Number.isFinite(x)) as [string, number][]);
      }
    }
  }
  return m;
}

/** Robust-feature weight (1/σ) for a name, optionally for a room verdict ('dry', 'some', …). */
export function weightOf(m: CoachModel, name: string, room?: string): number {
  const w = (room && m.weights_by_room[room]) || m.weights;
  if (w.size) return w.get(name) ?? (name.startsWith('sounding@') ? defaultWeight(name) : 0);
  return defaultWeight(name);
}
