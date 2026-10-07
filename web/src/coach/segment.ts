// Energy-based note segmentation, used while the engine has no `sax_segment` export.
const db = (p: number): number => (p > 1e-20 ? 10 * Math.log10(p) : -120);

/** energy-based segmentation into sustained notes: [startSample, endSample][] */
export function segmentJS(x: Float32Array, sr: number, minNoteS = 0.6): [number, number][] {
  const hop = Math.round(sr * 0.02);
  const nf = Math.floor(x.length / hop);
  const lv: number[] = [];
  for (let f = 0; f < nf; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) s += x[f * hop + i] ** 2;
    lv.push(db(s / hop));
  }
  const mx = Math.max(...lv);
  const thr = Math.max(-60, mx - 30);
  const segs: [number, number][] = [];
  let st = -1, gap = 0;
  for (let f = 0; f <= nf; f++) {
    const on = f < nf && lv[f] > thr;
    if (on) { if (st < 0) st = f; gap = 0; }
    else if (st >= 0) {
      gap++;
      if (gap > 6 || f === nf) { // > 120 ms of silence ends the note
        const en = f - gap + 1;
        if ((en - st) * 0.02 >= minNoteS) segs.push([Math.max(0, (st - 2) * hop), Math.min(x.length, (en + 2) * hop)]);
        st = -1; gap = 0;
      }
    }
  }
  return segs;
}
