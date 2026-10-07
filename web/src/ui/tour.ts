// First-run quick tour, 4 steps of "grab this, hear that". Shown once (localStorage), reopen via
// ⋯ → Quick tour. Deeper topics (altissimo, panels, MIDI) live in Help.
import type { CameraPreset, SceneApp } from '../scene/SceneApp';

interface Step { title: string; body: string; cam?: CameraPreset; cutaway?: boolean }

const STEPS: Step[] = [
  {
    title: 'Blow',
    cam: 'full',
    body: `<p>Press and hold <b>Hold to blow</b> (bottom) or <kbd>Space</kbd>. Play notes on the keyboard —
      <kbd>Z</kbd>…<kbd>M</kbd> and <kbd>Q</kbd>…<kbd>U</kbd> finger the sax <i>and</i> blow. In <b>Play</b> mode (top
      left) set the <b>Volume</b> and the player voices every note for you; <b>Explore</b> hands you every control.
      The bar at the bottom shows the note, how many cents off it is, and what the player is doing.</p>`,
  },
  {
    title: 'Grab the tongue',
    cam: 'player',
    cutaway: true,
    body: `<p>Parts you can grab glow softly and carry a <b>✋ tag</b>. While blowing, drag the <b>tongue</b> up and
      forward: the note bends, and the card on the left shows the vocal-tract resonance moving toward it. Drag the
      <b>lungs</b> to blow harder or softer. In Play mode, grabbing a part takes it over from the auto player
      (<i>reset</i> hands it back).</p>`,
  },
  {
    title: 'Lips & mouthpiece',
    cam: 'mouthpiece',
    cutaway: true,
    body: `<p>Slide the <b>lower lip</b> along the mouthpiece (take-in) or press it toward the reed (bite). In the
      cutaway, drag the mouthpiece handles — tip opening, baffle, chamber — and the reed for its strength. Hold
      <kbd>Shift</kbd> while dragging for fine steps.</p>`,
  },
  {
    title: 'Keys — and everything else',
    cam: 'keys',
    body: `<p>Click keys to finger (<kbd>Shift</kbd>+click = momentary, <kbd>Esc</kbd> releases). When you want more:
      <b>Scopes</b> opens the oscilloscope, spectrum, standing wave and impedance; <b>Controls</b> has every parameter,
      presets, MIDI and recording; <b>Coach</b> analyses your own playing. <kbd>?</kbd> lists all shortcuts.</p>`,
  },
];

const LS = 'saxsim.tour.v1';

/** `go(cam)` moves the camera the way the camera buttons do (keeps the UI in sync) */
export function setupTour(scene: SceneApp, go: (cam: CameraPreset) => void): { open(): void; firstRun(): void; readonly isOpen: boolean } {
  const root = document.getElementById('tour')!;
  const stepEl = document.getElementById('tour-step')!;
  const dots = document.getElementById('tour-dots')!;
  const title = document.getElementById('tour-title')!;
  const body = document.getElementById('tour-body')!;
  const next = document.getElementById('tour-next') as HTMLButtonElement;
  const back = document.getElementById('tour-back') as HTMLButtonElement;
  dots.innerHTML = STEPS.map(() => '<i></i>').join('');
  let i = 0;
  const show = (): void => {
    const s = STEPS[i];
    stepEl.textContent = `${i + 1} of ${STEPS.length}`;
    dots.querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
    title.textContent = s.title;
    body.innerHTML = s.body;
    back.disabled = i === 0;
    back.style.visibility = i === 0 ? 'hidden' : '';
    next.textContent = i === STEPS.length - 1 ? 'Start playing' : 'Next';
    if (s.cutaway !== undefined && scene.opts.cutaway !== s.cutaway) scene.setCutaway(s.cutaway);
    if (s.cam) go(s.cam);
  };
  const close = (): void => {
    root.hidden = true;
    try { localStorage.setItem(LS, '1'); } catch { /* ignore */ }
  };
  next.onclick = () => { if (i < STEPS.length - 1) { i++; show(); } else close(); };
  back.onclick = () => { if (i > 0) { i--; show(); } };
  document.getElementById('tour-skip')!.onclick = close;
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const open = (): void => { i = 0; root.hidden = false; show(); next.focus({ preventScroll: true }); };
  return {
    open,
    firstRun: () => {
      let seen = false;
      try { seen = localStorage.getItem(LS) === '1'; } catch { /* ignore */ }
      if (!seen) open();
    },
    get isOpen() { return !root.hidden; },
  };
}
