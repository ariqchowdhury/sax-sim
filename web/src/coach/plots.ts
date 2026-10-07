// Small canvas plots for the coach analysis view.
import { F } from './features';
import type { TakeResult } from './session';

const COL = { grid: 'rgba(140,160,190,0.15)', text: 'rgba(200,214,235,0.8)', rec: '#ffa94d', sim: '#5ec8ff', ok: '#5fd38d', warn: '#ffb347', bad: '#ff6b6b' };

function setup(c: HTMLCanvasElement, h = 180): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 520;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.height = `${h}px`;
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0d121b';
  g.fillRect(0, 0, w, h);
  g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  return g;
}

/** tuner-style bar chart of cents per note (±50 ¢), green within ±10 ¢ */
export function centsChart(c: HTMLCanvasElement, takes: TakeResult[], sim?: Record<string, number[]>): void {
  const g = setup(c);
  const w = c.clientWidth || 520, h = 180, top = 18, bot = h - 34, mid = (top + bot) / 2, range = 50;
  const y = (v: number): number => mid - (Math.max(-range, Math.min(range, v)) / range) * (bot - top) / 2;
  g.strokeStyle = COL.grid;
  for (const v of [-50, -25, 0, 25, 50]) { g.beginPath(); g.moveTo(34, y(v)); g.lineTo(w - 6, y(v)); g.stroke(); g.fillStyle = COL.text; g.fillText(`${v > 0 ? '+' : ''}${v}`, 2, y(v) + 4); }
  g.fillStyle = 'rgba(95,211,141,0.08)';
  g.fillRect(34, y(10), w - 40, y(-10) - y(10));
  const n = takes.length, bw = Math.max(8, Math.min(34, (w - 44) / Math.max(1, n) - 6));
  takes.forEach((t, i) => {
    const x = 40 + i * ((w - 44) / Math.max(1, n));
    const ok = t.features[F.valid] > 0;
    const v = t.features[F.cents];
    g.fillStyle = !ok ? '#333a48' : Math.abs(v) <= 10 ? COL.ok : Math.abs(v) <= 25 ? COL.warn : COL.bad;
    if (ok) g.fillRect(x, Math.min(y(0), y(v)), bw, Math.max(2, Math.abs(y(v) - y(0))));
    const s = sim?.[t.id];
    if (s && s[F.valid] > 0) { g.strokeStyle = COL.sim; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 2, y(s[F.cents])); g.lineTo(x + bw + 2, y(s[F.cents])); g.stroke(); g.lineWidth = 1; }
    g.fillStyle = COL.text;
    g.save(); g.translate(x + bw / 2, h - 4); g.rotate(-0.6); g.fillText(t.id, -18, 0); g.restore();
  });
  g.fillStyle = COL.text;
  g.fillText('cents vs target (bars = you' + (sim ? ', blue = fitted simulator)' : ')'), 36, 12);
}

/** harmonic levels H1..H10 (dB re H1) recorded vs simulated for one take */
export function harmonicChart(c: HTMLCanvasElement, t: TakeResult | undefined, sim?: number[]): void {
  const g = setup(c);
  const w = c.clientWidth || 520, h = 180, top = 18, bot = h - 20;
  const y = (db: number): number => top + ((0 - Math.max(-60, Math.min(10, db))) / 70) * (bot - top) + ((10 / 70) * (bot - top));
  g.strokeStyle = COL.grid;
  for (const v of [0, -20, -40, -60]) { g.beginPath(); g.moveTo(34, y(v)); g.lineTo(w - 6, y(v)); g.stroke(); g.fillStyle = COL.text; g.fillText(`${v}`, 6, y(v) + 4); }
  if (!t || t.features[F.valid] <= 0) { g.fillStyle = COL.text; g.fillText('no valid take', 40, 40); return; }
  const step = (w - 50) / 10;
  for (let k = 1; k <= 10; k++) {
    const x = 40 + (k - 1) * step;
    g.fillStyle = COL.rec;
    const v = t.features[F.h1 + k - 1];
    g.fillRect(x, y(v), step * 0.38, bot - y(v));
    if (sim && sim[F.valid] > 0) { const s = sim[F.h1 + k - 1]; g.fillStyle = COL.sim; g.fillRect(x + step * 0.42, y(s), step * 0.38, bot - y(s)); }
    g.fillStyle = COL.text;
    g.fillText(`H${k}`, x, h - 6);
  }
  g.fillStyle = COL.text;
  g.fillText(`${t.id}: harmonics dB re H1 (orange = you${sim ? ', blue = fitted simulator' : ''})`, 36, 12);
}

/** brightness (centroid / f0) across dynamics for G4 (and D5 if present) */
export function brightnessChart(c: HTMLCanvasElement, takes: TakeResult[], sim?: Record<string, number[]>): void {
  const g = setup(c, 150);
  const w = c.clientWidth || 520, h = 150, top = 20, bot = h - 22;
  const series: [string, string[]][] = [['G4', ['G4 pp', 'G4', 'G4 ff']], ['D5', ['D5 pp', 'D5', 'D5 ff']]];
  const by = new Map(takes.map((t) => [t.id, t.features]));
  const vals: number[] = [];
  for (const [, ids] of series) for (const id of ids) { const f = by.get(id); if (f && f[F.valid] > 0) vals.push(f[F.centroid_rel]); const s = sim?.[id]; if (s && s[F.valid] > 0) vals.push(s[F.centroid_rel]); }
  if (!vals.length) { g.fillStyle = COL.text; g.fillText('brightness: record G4 pp / mf / ff', 10, 20); return; }
  const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.1;
  const y = (v: number): number => bot - ((v - lo) / (hi - lo || 1)) * (bot - top);
  const xs = [w * 0.25, w * 0.5, w * 0.75];
  g.fillStyle = COL.text;
  ['pp', 'mf', 'ff'].forEach((d, i) => g.fillText(d, xs[i] - 6, h - 6));
  const line = (pts: (number | null)[], color: string, dash: number[]): void => {
    g.strokeStyle = color; g.setLineDash(dash); g.lineWidth = 2; g.beginPath();
    let started = false;
    pts.forEach((v, i) => { if (v === null) return; if (!started) { g.moveTo(xs[i], y(v)); started = true; } else g.lineTo(xs[i], y(v)); });
    g.stroke(); g.setLineDash([]); g.lineWidth = 1;
    pts.forEach((v, i) => { if (v !== null) { g.fillStyle = color; g.beginPath(); g.arc(xs[i], y(v), 3, 0, 7); g.fill(); } });
  };
  series.forEach(([name, ids], si) => {
    const rec = ids.map((id) => { const f = by.get(id); return f && f[F.valid] > 0 ? f[F.centroid_rel] : null; });
    if (rec.every((v) => v === null)) return;
    line(rec, si ? '#ffd27a' : COL.rec, []);
    if (sim) line(ids.map((id) => { const s = sim[id]; return s && s[F.valid] > 0 ? s[F.centroid_rel] : null; }), COL.sim, [4, 3]);
    g.fillStyle = si ? '#ffd27a' : COL.rec;
    g.fillText(name, 8 + si * 40, 14);
  });
  g.fillStyle = COL.text;
  g.fillText('brightness = spectral centroid / f0', w - 230, 14);
}
