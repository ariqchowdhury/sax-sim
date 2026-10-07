// Keys pressed → target pad openness, driven purely by data/alto_sax.json `keys` / `linkages`
// (octave logic is encoded in linkages). Must match engine/src/keywork.rs exactly.
//
// Semantics (data `keywork_semantics`, docs/PHYSICS.md "Keywork"):
//   rules = [each key's actions, in key-array order, as {when_all:[key], hole, set}] ++ linkages (in order)
//   state[h] = pad_rest(h) (open = 1, closed = 0)
//   for each rule:
//     a  = min( min_{k∈when_all} p_k , max_{k∈when_any} p_k )   (an empty list contributes 1 to its factor)
//     a *= 1 − max_{k∈unless_any} p_k                             (empty → 0)
//     state[h] = state[h]·(1−a) + target·a,   target = 1 for 'open', 0 for 'closed'
import type { SaxGeometry } from './geometry';

interface CompiledRule {
  hole: number;
  target: number;
  all: Int32Array;
  any: Int32Array;
  unless: Int32Array;
}

interface RawRule {
  id?: string;
  when_all?: string[];
  when_any?: string[];
  unless_any?: string[];
  hole: string;
  set: string;
}

export class Keywork {
  readonly rules: CompiledRule[] = [];
  readonly rest: Float32Array;
  readonly holeCount: number;
  readonly keyCount: number;
  readonly keyIndex = new Map<string, number>();
  readonly holeIndex = new Map<string, number>();
  readonly warnings: string[] = [];

  constructor(geo: SaxGeometry) {
    this.holeCount = geo.tone_holes.length;
    this.keyCount = geo.keys.length;
    this.rest = new Float32Array(this.holeCount);
    geo.tone_holes.forEach((h, i) => {
      this.holeIndex.set(h.id, i);
      this.rest[i] = h.pad_rest === 'open' ? 1 : 0;
    });
    geo.keys.forEach((k, i) => this.keyIndex.set(k.id, i));

    const raw: RawRule[] = [];
    for (const k of geo.keys) for (const a of k.actions ?? []) raw.push({ when_all: [k.id], hole: a.hole, set: a.set });
    for (const l of geo.linkages as RawRule[]) raw.push(l);

    for (const r of raw) {
      const hole = this.holeIndex.get(r.hole);
      const target = r.set === 'open' ? 1 : r.set === 'closed' || r.set === 'close' ? 0 : -1;
      if (hole === undefined || target < 0) {
        this.warnings.push(`rule ${r.id ?? ''}: unknown hole/set ${r.hole} ${r.set}`);
        continue;
      }
      // unknown key names are dropped (same as keywork.rs)
      const ids = (list: string[] | undefined): Int32Array => {
        const out: number[] = [];
        for (const id of list ?? []) {
          const i = this.keyIndex.get(id);
          if (i === undefined) this.warnings.push(`rule ${r.id ?? ''}: unknown key ${id}`);
          else out.push(i);
        }
        return Int32Array.from(out);
      };
      this.rules.push({ hole, target, all: ids(r.when_all), any: ids(r.when_any), unless: ids(r.unless_any) });
    }
  }

  /** pressed: key press amount 0..1 per key index → out: openness 0..1 per hole. Allocation-free. */
  evaluate(pressed: ArrayLike<number>, out: Float32Array): Float32Array {
    out.set(this.rest);
    for (let r = 0; r < this.rules.length; r++) {
      const rule = this.rules[r];
      let fAll = 1;
      for (let i = 0; i < rule.all.length; i++) fAll = Math.min(fAll, press(pressed, rule.all[i]));
      let fAny = 1;
      if (rule.any.length) {
        fAny = 0;
        for (let i = 0; i < rule.any.length; i++) fAny = Math.max(fAny, press(pressed, rule.any[i]));
      }
      let un = 0;
      for (let i = 0; i < rule.unless.length; i++) un = Math.max(un, press(pressed, rule.unless[i]));
      const a = Math.min(fAll, fAny) * (1 - un);
      out[rule.hole] = out[rule.hole] * (1 - a) + rule.target * a;
    }
    return out;
  }
}

function press(p: ArrayLike<number>, k: number): number {
  const v = p[k] ?? 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
