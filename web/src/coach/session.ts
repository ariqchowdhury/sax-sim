// Coaching sessions: analysed takes (features only — audio is never stored or sent anywhere),
// fit and advice; saved in localStorage and exportable as JSON to track progress over time.
import type { Dynamic } from './protocol';

export interface TakeResult {
  id: string;
  note: string;
  dynamic: Dynamic;
  /** sounding target (Hz) at the session's reference A */
  target: number;
  features: number[];
  source: 'wasm' | 'fallback';
  seconds: number;
  clipped?: boolean;
  peak?: number;
}

export interface FitSummary {
  method: string;
  /** fitted control values by key ("lip_force", "tongue_y@mid", "lung_pressure@pp", …) */
  controls: Record<string, number>;
  uncertainty?: Record<string, number>;
  /** posterior sd / prior sd per control: ≈ 1 = not identifiable from this recording */
  identifiability?: Record<string, number>;
  /** full engine params (id, value) per take at the fitted controls — incl. dynamic, player_assist */
  perNoteParams?: Record<string, [number, number][]>;
  /** 'failed' when takes that sound in the recording are silent in the fitted simulation */
  status?: 'ok' | 'failed';
  problems?: string[];
  /** simulated feature vectors at the fitted controls, by take id */
  simFeatures?: Record<string, number[]>;
  residual?: number;
  ms: number;
}

export interface Suggestion {
  id: string;
  cause: string;
  tryText: string;
  why: string;
  listen: string;
  confidence: number;
  /** model-gap / robustness flag shown to the player */
  flag?: string;
  /** fitted-control keys this cause is about (for confound grouping) */
  controls?: string[];
  /** confounded alternatives: "one of these" (the recording can't tell them apart) */
  alternatives?: Suggestion[];
  /** look-alike causes (titles) the test set can't separate from this one */
  lookalikes?: string[];
  /** template ranking (primary) · fired observation rule · fit refinement · provisional */
  source?: 'template' | 'observation' | 'fit' | 'provisional';
  /** param changes (param name → new value or delta) for "Load suggested change" */
  change?: { param: string; delta?: number; value?: number }[];
  evidence?: string;
  /** greyed out: not trustworthy for this recording (e.g. too reverberant) */
  suppressed?: boolean;
}

export interface CoachSession {
  version: 1;
  id: string;
  label: string;
  created: string;
  updated: string;
  refA: number;
  input: 'mic' | 'upload' | 'synthetic';
  device?: string;
  takes: TakeResult[];
  fit?: FitSummary;
  suggestions?: Suggestion[];
  rulesSource?: string;
  roomNote?: string;
  hiddenRules?: string[];
  /** blind room estimate (sax_room) of the recording */
  room?: RoomEstimate;
}

/** `sax_room` output (docs/COACHING.md): verdict 0 dry · 1 some room · 2 too reverberant · 3 uncertain */
export interface RoomEstimate {
  rt60: number;
  rt60Spread: number;
  /** DRR estimate (dB) — unreliable, not displayed */
  drr: number;
  noiseFloor: number;
  tails: number;
  confidence: number;
  verdict: 0 | 1 | 2 | 3;
  /** RT60 from a hand clap before the first note (−1 if none) */
  clapRt60?: number;
  tailRatio?: number;
  source: 'wasm' | 'unavailable';
}

const LS = 'saxsim.coach.sessions.v1';

export function newSession(refA = 440, input: CoachSession['input'] = 'mic'): CoachSession {
  const now = new Date().toISOString();
  return { version: 1, id: `s-${Date.now().toString(36)}`, label: `Session ${now.slice(0, 16).replace('T', ' ')}`, created: now, updated: now, refA, input, takes: [] };
}

export function listSessions(): CoachSession[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS) ?? '[]') as CoachSession[];
    return Array.isArray(v) ? v.filter((s) => s && s.version === 1) : [];
  } catch {
    return [];
  }
}

export function saveSession(s: CoachSession): void {
  s.updated = new Date().toISOString();
  const all = listSessions().filter((x) => x.id !== s.id);
  all.push(s);
  all.sort((a, b) => a.created.localeCompare(b.created));
  try {
    localStorage.setItem(LS, JSON.stringify(all.slice(-50)));
  } catch {
    /* storage full/unavailable: export still works */
  }
}

export function deleteSession(id: string): void {
  try {
    localStorage.setItem(LS, JSON.stringify(listSessions().filter((s) => s.id !== id)));
  } catch { /* ignore */ }
}

export function parseSessionFile(text: string): CoachSession[] {
  const v = JSON.parse(text) as unknown;
  const arr = (Array.isArray(v) ? v : [v]) as CoachSession[];
  return arr.filter((s) => s && s.version === 1 && Array.isArray(s.takes));
}

/** one-number progress summary: mean |cents| over valid mf takes */
export function meanAbsCents(s: CoachSession): number {
  const c = s.takes.filter((t) => t.dynamic === 'mf' && t.features[25] > 0).map((t) => Math.abs(t.features[1]));
  return c.length ? c.reduce((a, b) => a + b, 0) / c.length : NaN;
}
