// First-run guided tour: what to drag and what to watch. Shown once (localStorage), reopen via "Tour".
import type { CameraPreset, SceneApp } from '../scene/SceneApp';

interface Step { title: string; body: string; cam?: CameraPreset; cutaway?: boolean }

const STEPS: Step[] = [
  {
    title: 'Blow',
    cam: 'full',
    body: `<p>Hold <kbd>Space</kbd> to blow, or play notes on the keyboard (<kbd>Z</kbd>…<kbd>M</kbd> = C4…B4,
      <kbd>Q</kbd>…<kbd>U</kbd> = C5…B5) — a note fingers the sax <i>and</i> blows. A MIDI keyboard or breath controller
      works too (panel → <b>MIDI &amp; vibrato</b>). You can also drag the <b>blue lung handle</b> up/down to set the
      lung pressure directly.</p>`,
  },
  {
    title: 'Fingers',
    cam: 'keys',
    body: `<p>Click any key on the instrument (or on the small <b>fingering chart</b> on the left) to hold it;
      <kbd>Shift</kbd>+click for a momentary press. Pads open and close through the real key mechanism, and the
      chart names the fingering it recognises. <kbd>Esc</kbd> releases everything.</p>`,
  },
  {
    title: 'Lips & jaw',
    cam: 'mouthpiece',
    cutaway: true,
    body: `<p>Drag the <b>lower lip</b> along the mouthpiece to take in more/less mouthpiece, or toward the reed to bite
      harder (lip force). The <b>upper lip</b> sets firmness; the <b>green chin handle</b> opens the jaw.
      Turn on <b>Jaw vibrato</b> in the panel for a sax-style vibrato.</p>`,
  },
  {
    title: 'Tongue & throat',
    cam: 'player',
    cutaway: true,
    body: `<p>Drag the <b>pink tongue handle</b> (front/back, low/high) — a high, front tongue tunes the vocal tract up for
      altissimo and bends notes. Drop the <b>orange tip</b> onto the reed to tongue (or hold <kbd>/</kbd>).
      The <b>violet handle</b> opens the glottis. Labels show the pressures and flow in the airway.</p>`,
  },
  {
    title: 'Mouthpiece',
    cam: 'mouthpiece',
    cutaway: true,
    body: `<p>In the cutaway, drag the handles to reshape the mouthpiece: <b>tip opening</b> and <b>facing length</b>
      (amber), <b>baffle</b>, <b>chamber</b> and <b>throat</b> (blue), and the green handle slides it on the cork
      (tuning). Drag the reed up/down to change its strength.</p>`,
  },
  {
    title: 'Watch',
    cam: 'full',
    body: `<ul>
      <li><b>Input impedance</b> (bottom right): the resonances of the current fingering; the orange line is the note
        you are playing — the chip in the pitch card tells which resonance (register) it locked to.</li>
      <li><b>Standing wave</b>: the plot and the glowing line on the instrument (try <b>X-ray</b>).</li>
      <li><b>Scope</b>: mouthpiece pressure and reed motion; the reed itself moves in the cutaway.</li>
      <li>While you drag anything, the pitch card shows <b>what changed</b> and by how many cents.</li></ul>`,
  },
  {
    title: 'Altissimo: the tract in series',
    cam: 'player',
    cutaway: true,
    body: `<p>The reed is driven by the pressure difference across it, so it works against the bore
      <i>and</i> the vocal tract <b>in series</b>: Z<sub>bore</sub> + Z<sub>tract</sub>. Above the normal range the
      bore resonances are weak, but a <b>high, front tongue</b> with a nearly closed glottis makes a strong tract
      resonance. On the impedance plot (bottom right, “tract overlay”) the cyan curve is Z<sub>tract</sub> and the
      white one the series sum — drag the tongue and watch the tract peak move onto the note. The 3D label turns
      <b style="color:#5fd38d">green</b> when the tract is tuned to it.</p>
      <p>Try: preset <b>Altissimo</b>, note mode <kbd>↑</kbd> then <kbd>T</kbd>/<kbd>6</kbd>/<kbd>Y</kbd> (G6/G♯6/A6),
      or <kbd>]</kbd> <kbd>⌫</kbd> <kbd>\\</kbd>. Then flatten the tongue: the same fingering drops to a low note.</p>`,
  },
];

const LS = 'saxsim.tour.v1';

export function setupTour(scene: SceneApp): { open(): void; firstRun(): void } {
  const root = document.getElementById('tour')!;
  const stepEl = document.getElementById('tour-step')!;
  const title = document.getElementById('tour-title')!;
  const body = document.getElementById('tour-body')!;
  const next = document.getElementById('tour-next') as HTMLButtonElement;
  const back = document.getElementById('tour-back') as HTMLButtonElement;
  let i = 0;
  const show = (): void => {
    const s = STEPS[i];
    stepEl.textContent = `Step ${i + 1} of ${STEPS.length}`;
    title.textContent = s.title;
    body.innerHTML = s.body;
    back.disabled = i === 0;
    next.textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
    if (s.cutaway !== undefined && scene.opts.cutaway !== s.cutaway) scene.setCutaway(s.cutaway);
    if (s.cam) scene.goto(s.cam);
  };
  const close = (): void => {
    root.hidden = true;
    try { localStorage.setItem(LS, '1'); } catch { /* ignore */ }
  };
  next.onclick = () => { if (i < STEPS.length - 1) { i++; show(); } else close(); };
  back.onclick = () => { if (i > 0) { i--; show(); } };
  document.getElementById('tour-skip')!.onclick = close;
  const open = (): void => { i = 0; root.hidden = false; show(); };
  return {
    open,
    firstRun: () => {
      let seen = false;
      try { seen = localStorage.getItem(LS) === '1'; } catch { /* ignore */ }
      if (!seen) open();
    },
  };
}
