// Player-facing messages for takes the fitter's recording guard left out (FitResult.excluded) and
// other non-fatal fit problems. Pure (no DOM) so it is unit-tested (web/tests/coachWarnings.test.ts).
import { F } from './fit/features.ts';

export interface WarnTake {
  /** UI take id ("G4 pp") */
  id: string;
  features: ArrayLike<number>;
}

/**
 * @param takes     analysed takes in protocol order
 * @param excluded  model labels of the left-out takes ("G4pp")
 * @param problems  FitResult.problems ("<id>: <why>")
 */
export function recordingWarnings(takes: readonly WarnTake[], excluded: readonly string[], problems: readonly string[]): string[] {
  const ex = new Set(excluded);
  const items: string[] = [];
  const covered = new Set<string>();
  for (const t of takes) {
    if (!ex.has(t.id.replace(/\s+/g, ''))) continue;
    covered.add(t.id);
    const f = t.features;
    const r = Number(f[F.regime]);
    const c = Number(f[F.cents]);
    items.push(
      Number(f[F.valid]) <= 0 ? `${t.id} didn't sound — left out; try again with more support.`
        : r > 1.1 ? `${t.id} cracked ${r >= 1.9 && r <= 2.1 ? 'to the octave' : `up (×${r.toFixed(1)})`} — left out; try again with a looser lip and slower air.`
        : r < 0.9 ? `${t.id} dropped a register — left out; try again with firmer support.`
        : `${t.id} was ${c > 0 ? '+' : ''}${c.toFixed(0)} ¢ off the written note (wrong note or fingering?) — left out.`,
    );
  }
  // problems not about a take covered above (e.g. "D5: not recorded — the fit uses the other takes")
  for (const p of problems) if (!covered.has(p.split(':')[0])) items.push(p);
  return items;
}
