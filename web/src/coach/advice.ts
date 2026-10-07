// Ranked diagnosis. Uses `data/coach_model.json` rules (physics lead, docs/COACHING.md §Diagnosis)
// when the file exists and its rules can be evaluated; until then a small PROVISIONAL rule set
// implementing the contract's example causes. Every suggestion: cause, what to try, why, what to
// listen for, confidence, model-gap flag.
import { F } from './features';
import { ROOM_NAMES, fired, modelLabel, roomAllows, templateRank, type FeatsByLabel, type RoomName, type Trigger } from './causes';
import type { FitSummary, Suggestion, TakeResult } from './session';

const files = import.meta.glob('@data/coach_model.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export interface CoachModel {
  rules?: unknown[];
  [k: string]: unknown;
}

export function loadCoachModel(): CoachModel | null {
  const t = Object.values(files)[0];
  if (typeof t !== 'string') return null;
  try {
    return JSON.parse(t) as CoachModel;
  } catch {
    return null;
  }
}

// ---- helpers ---------------------------------------------------------------------------------
type ById = Map<string, number[]>;
const valid = (f: number[] | undefined): f is number[] => !!f && f[F.valid] > 0;
const mean = (a: number[]): number => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN);
const sd = (a: number[]): number => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (a.length - 1)) : 0; };
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
function feats(by: ById, ids: string[], k: number): number[] {
  return ids.map((id) => by.get(id)).filter(valid).map((f) => f[k]);
}
const LOW = ['Bb3', 'D4', 'G4', 'C5'];
const MID = ['D5', 'G5', 'C6'];
const MF = ['Bb3', 'D4', 'G4', 'C5', 'C#5', 'D5', 'G5', 'C6', 'F6'];

/** PROVISIONAL rules (until data/coach_model.json rules land) */
function provisional(by: ById, fit?: FitSummary): Suggestion[] {
  const out: Suggestion[] = [];
  const cents = feats(by, MF, F.cents);
  // 1. uniform pitch offset → mouthpiece position on the cork
  if (cents.length >= 4) {
    const m = mean(cents), s = sd(cents);
    const score = clamp01((Math.abs(m) - 8) / 25) * clamp01(1.4 - s / Math.max(15, Math.abs(m)));
    if (score > 0.05) {
      const mm = Math.max(-10, Math.min(10, -m / 2.5)); // ≈ 2–4 ¢ per mm on alto
      out.push({
        id: 'mouthpiece_position', confidence: score,
        cause: `All notes ${m < 0 ? 'flat' : 'sharp'} by about ${Math.abs(m).toFixed(0)} ¢ (spread ±${s.toFixed(0)} ¢) — mouthpiece position on the cork`,
        tryText: m < 0 ? `Push the mouthpiece further onto the cork (≈ ${Math.abs(mm).toFixed(0)} mm).` : `Pull the mouthpiece out a little (≈ ${Math.abs(mm).toFixed(0)} mm).`,
        why: 'The mouthpiece position sets the total air-column length, which shifts every note by nearly the same number of cents.',
        listen: 'On a tuner all notes move together; the octaves stay the same.',
        change: [{ param: 'mouthpiece_insertion', delta: m < 0 ? Math.abs(mm) : -Math.abs(mm) }],
        evidence: `mean cents ${m.toFixed(1)}, sd ${s.toFixed(1)}`,
      });
    }
  }
  // 2. register 2 sharper/flatter than register 1 → biting / chamber
  {
    const lo = feats(by, LOW, F.cents), hi = feats(by, MID, F.cents);
    if (lo.length >= 2 && hi.length >= 2) {
      const d = mean(hi) - mean(lo);
      const score = clamp01((Math.abs(d) - 8) / 30);
      if (score > 0.05) out.push({
        id: d > 0 ? 'register2_sharp_biting' : 'register2_flat_loose', confidence: score,
        cause: d > 0 ? `Upper register ${d.toFixed(0)} ¢ sharp relative to the low register — biting / lip pressure (or a small-chamber mouthpiece)` : `Upper register ${(-d).toFixed(0)} ¢ flat relative to the low register — too little lip support`,
        tryText: d > 0 ? 'Relax the jaw pressure on the reed in the upper register; keep the air support instead of biting. If it persists, a larger-chamber mouthpiece.' : 'Firm up the lower lip slightly in the upper register (support, not bite).',
        why: 'Lip force stiffens the reed and shrinks its effective volume; the upper register is the most sensitive, so the octaves stretch or shrink.',
        listen: 'Octave D4–D5 and G4–G5 on a tuner: a well-balanced embouchure keeps them pure.',
        change: [{ param: 'lip_force', delta: d > 0 ? -0.3 : 0.3 }, ...(d > 0 ? [{ param: 'chamber_size', delta: 0.15 }] : [])],
        evidence: `register-2 minus register-1 ${d.toFixed(1)} ¢`,
      });
    }
  }
  // 3. palm-key notes off → voicing
  {
    const f6 = by.get('F6'), mid = feats(by, MID, F.cents);
    if (valid(f6) && mid.length) {
      const d = f6[F.cents] - mean(mid);
      const score = clamp01((Math.abs(d) - 15) / 35);
      if (score > 0.05) out.push({
        id: 'palm_voicing', confidence: score * 0.9,
        cause: `Palm-key F6 ${d > 0 ? 'sharp' : 'flat'} by ${Math.abs(d).toFixed(0)} ¢ relative to register 2 — voicing (tongue/throat)`,
        tryText: d < 0 ? 'Raise the back of the tongue a little ("ee" rather than "ah") for the palm-key notes.' : 'Lower/open the tongue and throat ("ah") for the palm-key notes.',
        why: 'Above C6 the bore resonances are weak, so the vocal tract in series with the instrument pulls the pitch; tongue height tunes that resonance.',
        listen: 'F6 settles and centres; the pitch no longer "floats" when you change the vowel.',
        change: [{ param: 'tongue_y', delta: d < 0 ? 0.15 : -0.15 }],
        evidence: `F6 ${f6[F.cents].toFixed(1)} ¢ vs register-2 mean ${mean(mid).toFixed(1)} ¢`,
      });
    }
  }
  // 4. edge + bright tilt → lip cushion / baffle (absolute timbre: robust only between notes)
  {
    const edge = feats(by, MF, F.edge), tilt = feats(by, MF, F.tilt);
    if (edge.length >= 3) {
      const score = clamp01((mean(edge) + 18) / 10) * clamp01((mean(tilt) + 8) / 6);
      if (score > 0.1) out.push({
        id: 'edgy_bright', confidence: score * 0.6,
        cause: 'Edgy/bright tone (strong 2–5 kHz energy, flat harmonic slope) — thin lip cushion or a high-baffle set-up',
        tryText: 'Bring a little more lower lip over the teeth (more cushion) and keep the corners in; for a darker sound, a lower baffle.',
        why: 'Lip damping absorbs the reed\'s high-frequency motion; a high baffle boosts the upper partials.',
        listen: 'Less buzz at loud dynamics; the sound "blooms" instead of spreading.',
        change: [{ param: 'lip_damping', delta: 0.2 }, { param: 'baffle_height', delta: -0.2 }],
        flag: 'Absolute brightness also depends on the room and microphone — compare with a reference recording made the same way.',
        evidence: `edge ${mean(edge).toFixed(1)} dB, tilt ${mean(tilt).toFixed(1)} dB/oct`,
      });
    }
  }
  // 5. breathiness
  {
    const hnr = feats(by, MF, F.hnr);
    if (hnr.length >= 3) {
      const score = clamp01((18 - mean(hnr)) / 12);
      if (score > 0.1) out.push({
        id: 'breathy', confidence: score * 0.7,
        cause: `Breathy/airy tone (harmonic-to-noise ${mean(hnr).toFixed(0)} dB) — lip seal or air support`,
        tryText: 'Seal the corners of the mouth around the mouthpiece and blow with steadier, faster air.',
        why: 'Air leaking past the lips and a lazily vibrating reed add turbulent noise between the harmonics.',
        listen: 'Less hiss between notes and at soft dynamics.',
        change: [{ param: 'lip_force', delta: 0.15 }, { param: 'breath_noise', value: 0.03 }],
        evidence: `mean HNR ${mean(hnr).toFixed(1)} dB`,
      });
    }
  }
  // 6. scoops → voicing set late
  {
    const sc = feats(by, MF, F.scoop);
    if (sc.length >= 3) {
      const m = mean(sc.map(Math.abs));
      const score = clamp01((m - 12) / 30);
      if (score > 0.05) out.push({
        id: 'scoop', confidence: score * 0.8,
        cause: `Notes start ${mean(sc) < 0 ? 'below' : 'off'} the pitch (≈ ${m.toFixed(0)} ¢ in the first 100 ms) — voicing/embouchure set late`,
        tryText: 'Set the embouchure and tongue position before the attack; start with the tongue on the reed and release it with the air already "on".',
        why: 'During the attack the reed locks to whatever the tract and lip settings are; adjusting afterwards drags the pitch.',
        listen: 'Clean starts: the tuner needle lands immediately.',
        flag: 'Room-sensitive: reverberation smears the attack — trust this only for a close-miked or dry-room recording.',
        evidence: `mean |scoop| ${m.toFixed(1)} ¢`,
      });
    }
  }
  // 7. cracked low notes / C#5 → air & lip balance
  for (const id of ['Bb3', 'C#5']) {
    const f = by.get(id);
    if (valid(f) && Math.abs(f[F.regime] - 1) > 0.25) out.push({
      id: `regime_${id}`, confidence: 0.75,
      cause: `${id} sounded in the wrong register (${f[F.regime] > 1 ? 'cracked up' : 'dropped down'}) — air/lip balance`,
      tryText: f[F.regime] > 1 ? 'Lower the jaw slightly, drop the tongue ("oh"), and use slower, warm air for the low notes.' : 'Firmer support and a slightly firmer lip.',
      why: 'Low notes need the reed to favour the first resonance; too much lip force or a high tongue lets the 2nd resonance win.',
      listen: 'The note speaks at the written pitch without an octave flip.',
      change: f[F.regime] > 1 ? [{ param: 'lip_force', delta: -0.2 }, { param: 'jaw_open', delta: 0.1 }] : [{ param: 'lip_force', delta: 0.2 }],
      evidence: `regime ${f[F.regime].toFixed(2)}`,
    });
  }
  // 8. pp intonation (known model gap → flagged)
  {
    const pp = by.get('G4 pp'), mf = by.get('G4');
    if (valid(pp) && valid(mf)) {
      const d = pp[F.cents] - mf[F.cents];
      const score = clamp01((Math.abs(d) - 10) / 30);
      if (score > 0.05) out.push({
        id: 'pp_intonation', confidence: score * 0.5,
        cause: `G4 pp ${d > 0 ? 'sharp' : 'flat'} by ${Math.abs(d).toFixed(0)} ¢ vs mf`,
        tryText: d > 0 ? 'At pp, relax the lip and drop the jaw a little instead of pinching.' : 'At pp keep the air fast and the lip supported.',
        why: 'Soft playing changes the reed\'s operating point; pinching to control the dynamic raises the pitch.',
        listen: 'Crescendo/diminuendo on one note without the tuner needle moving.',
        flag: 'Known model gap: the simulator\'s pp intonation is not yet calibrated (PLAN.md) — treat as a hint.',
        evidence: `pp − mf ${d.toFixed(1)} ¢`,
      });
    }
  }
  // 9. unstable pitch
  {
    const ps = feats(by, MF, F.pitch_std);
    if (ps.length >= 3) {
      const m = mean(ps);
      const score = clamp01((m - 6) / 15);
      if (score > 0.05) out.push({
        id: 'unstable', confidence: score * 0.7,
        cause: `Pitch wavers (±${m.toFixed(0)} ¢ without vibrato) — air support`,
        tryText: 'Long tones with a tuner: steady, supported air from the lower body; keep the jaw still.',
        why: 'Pressure fluctuations change the reed\'s average opening and therefore the pitch.',
        listen: 'A flat tuner needle on long tones.',
        evidence: `mean pitch std ${m.toFixed(1)} ¢`,
      });
    }
  }
  void fit;
  return out.sort((a, b) => b.confidence - a.confidence);
}

interface ModelRule {
  id: string;
  kind: 'control' | 'observation';
  cause: string;
  signature: Record<string, number>;
  evidence?: string;
  advice: string;
  why: string;
  listen_for: string;
  gaps?: string[];
  room?: string;
  evidence_features?: string[];
  validate?: boolean;
  trigger?: Trigger;
}
interface ModelControl { key: string; param: string; default: number; step: number; min: number; max: number }

/** room verdict (sax_room): 0 dry, 1 some room, 2 too reverberant, 3 uncertain */
export type RoomVerdict = 0 | 1 | 2 | 3;

export interface Diagnosis {
  /** primary: template ranking top-3 + fired observation rules, then the fit's refinement */
  suggestions: Suggestion[];
  source: string;
  /** user-facing note for the room verdict (weights.room_notes) */
  roomNote?: string;
  /** rules hidden because the recording quality doesn't meet their `room` requirement */
  hidden: string[];
}

const flagOf = (r: ModelRule): string | undefined => {
  const g = [...(r.gaps ?? [])];
  if (r.validate === false) g.push('Not yet validated on synthetic players.');
  return g.length ? g.join(' ') : undefined;
};

/** look-alike causes: rules whose controls the test set can't separate from this rule's (confounds) */
function lookalikes(rule: ModelRule, rules: ModelRule[], model: CoachModel): string[] {
  const conf = ((model.identifiability as Record<string, { confounds?: [string, string, number][] }> | undefined)?.v1?.confounds ?? []).filter((c) => Math.abs(c[2]) >= 0.6);
  const base = (k: string): string => k.split('@')[0];
  const mine = Object.keys(rule.signature).map(base);
  const linked = new Set<string>();
  for (const [a, b] of conf) {
    if (mine.includes(base(a))) linked.add(base(b));
    if (mine.includes(base(b))) linked.add(base(a));
  }
  return rules.filter((r) => r.kind === 'control' && r.id !== rule.id && Object.keys(r.signature).some((k) => linked.has(base(k)))).map((r) => r.cause);
}

function controlChange(rule: ModelRule, ctrls: ModelControl[]): Suggestion['change'] {
  // "Load suggested change": move the rule's controls one way-out step back toward the default
  return Object.entries(rule.signature).map(([k, sgn]) => {
    const c = ctrls.find((x) => x.key === k);
    return c ? { param: c.param, delta: -sgn * 2 * c.step } : null;
  }).filter((x): x is { param: string; delta: number } => !!x);
}

/** fit-based projection score (cause_ranking secondary method) */
function fitScores(rules: ModelRule[], ctrls: ModelControl[], fit: FitSummary, room: RoomName): { id: string; score: number }[] {
  const out: { id: string; score: number }[] = [];
  for (const r of rules) {
    if (r.kind !== 'control' || !roomAllows(r, room)) continue;
    let num = 0, norm = 0, ok = true;
    for (const [k, sgn] of Object.entries(r.signature)) {
      const c = ctrls.find((x) => x.key === k);
      const fk = k in fit.controls ? k : `${k}@mf` in fit.controls ? `${k}@mf` : null;
      if (!c || !fk) { ok = false; break; }
      const u = (fit.controls[fk] - c.default) / c.step;
      const sd = (fit.uncertainty?.[fk] ?? c.step) / c.step;
      num += (u / Math.max(sd, 0.3)) * sgn;
      norm += sgn * sgn;
    }
    if (ok && norm) out.push({ id: r.id, score: num / Math.sqrt(norm) });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function diagnose(takes: TakeResult[], fit?: FitSummary, verdict?: RoomVerdict): Promise<Diagnosis> {
  const by: ById = new Map(takes.map((t) => [t.id, t.features]));
  const model = loadCoachModel();
  const rules = model?.rules as ModelRule[] | undefined;
  const ctrls = model?.controls as ModelControl[] | undefined;
  const room: RoomName = verdict === undefined ? 'uncertain' : ROOM_NAMES[verdict];
  if (!model || !Array.isArray(rules) || !rules.length || !Array.isArray(ctrls)) {
    return { suggestions: provisional(by, fit), source: 'provisional rules (data/coach_model.json not available)', hidden: [] };
  }
  const roomNote = (model.weights as { room_notes?: Record<string, string> } | undefined)?.room_notes?.[room];
  const feats: FeatsByLabel = new Map(takes.map((t) => [modelLabel(t.id), t.features]));
  const mfLabels = ((model.test_set as { label: string; dynamic: number }[] | undefined) ?? []).filter((t) => t.dynamic === 0.5).map((t) => t.label);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const hidden = rules.filter((r) => !roomAllows(r, room)).map((r) => r.cause);
  const mk = (r: ModelRule, confidence: number, source: Suggestion['source'], evidence?: string): Suggestion => ({
    id: r.id, cause: r.cause, tryText: r.advice, why: r.why, listen: r.listen_for, confidence, flag: flagOf(r), source,
    change: r.kind === 'control' ? controlChange(r, ctrls) : undefined, controls: Object.keys(r.signature),
    lookalikes: r.kind === 'control' ? lookalikes(r, rules, model) : undefined, evidence,
  });
  const out: Suggestion[] = [];
  // 1. template ranking (primary): top 3 with softmax confidence
  const tr = await templateRank(model as never, feats, room);
  for (const c of tr.ranked.slice(0, 3)) {
    const r = byId.get(c.id);
    if (r) out.push(mk(r, c.p, 'template', `${tr.source}: χ² improvement ${c.score.toFixed(1)}${c.mag !== undefined ? ` at ${c.mag}× the template step` : ''}`));
  }
  // 2. observation rules (fired triggers)
  for (const r of rules) {
    if (r.kind !== 'observation') continue;
    if (fired(r, feats, room, mfLabels)) out.push(mk(r, 1, 'observation', r.evidence));
  }
  // 3. the fit's refinement (secondary): projections ≥ 1 posterior sd not already listed
  if (fit && fit.status !== 'failed') {
    for (const f of fitScores(rules, ctrls, fit, room).filter((x) => x.score >= 1).slice(0, 3)) {
      const r = byId.get(f.id)!;
      const prev = out.find((s) => s.id === f.id);
      if (prev) prev.evidence = `${prev.evidence ?? ''} · fit agrees (${f.score.toFixed(1)} sd)`;
      else out.push(mk(r, 1 - Math.exp(-f.score / 2.5), 'fit', `fitted controls → ${f.score.toFixed(1)} posterior sd along this cause`));
    }
  }
  return { suggestions: out, source: `data/coach_model.json v${String(model.version ?? '?')} · ${tr.source}`, roomNote, hidden };
}
