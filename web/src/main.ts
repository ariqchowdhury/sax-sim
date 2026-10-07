import './style.css';
import { EngineClient, type EngineStatus } from './engine/EngineClient';
import { loadGeometry } from './scene/geometry';
import { SceneApp, type CameraPreset } from './scene/SceneApp';
import { AppState } from './state';
import { KeyboardPlayer } from './ui/keyboard';
import { buildPanel } from './ui/panel';
import { BorePlot, ImpedancePlot, Scope, Spectrum } from './ui/visualizers';
import { ImpedanceClient } from './engine/ImpedanceClient';
import { Labels } from './ui/labels';
import { MidiInput } from './ui/midi';
import { Vibrato } from './ui/vibrato';
import { FingeringChart } from './ui/fingeringChart';
import { TelemetryCapture, WavRecorder } from './engine/Recorder';
import { mergeDataPresets } from './ui/presets';
import { setupTour } from './ui/tour';
import { P, PARAMS, formatParam } from './engine/params';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
function midiName(m: number): string {
  const r = Math.round(m);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

function fatal(msg: string): void {
  $('overlay-msg').textContent = msg;
  ($('start') as HTMLButtonElement).disabled = true;
  console.error(msg);
}

function main(): void {
  let loaded;
  try {
    loaded = loadGeometry();
  } catch (err) {
    fatal(`Cannot load geometry: ${(err as Error).message}`);
    return;
  }
  const { geo, json } = loaded;
  $('geo-name').textContent = geo.meta?.name ?? '';

  const state = new AppState(geo.keys.length);
  const engine = new EngineClient({ geometryJson: json, padCount: geo.tone_holes.length, keyCount: geo.keys.length });
  state.attachEngine(engine);

  const scene = new SceneApp($('viewport'), geo, state, engine);
  const kb = new KeyboardPlayer(state, geo);
  const vibrato = new Vibrato(state, () => kb.isBlowing || state.get(P.lung_pressure) > 0.3);
  const midi = new MidiInput(state, kb, vibrato);
  const recorder = new WavRecorder(engine);
  const chart = new FingeringChart($('fchart'), geo, state);
  const capture = new TelemetryCapture(engine, state.values, () => chart.recognised());
  mergeDataPresets(geo);
  const ensureAudio = async (): Promise<boolean> => {
    if (!engine.running) await engine.start();
    for (let i = 0; i < 40 && engine.status.state === 'loading'; i++) await new Promise((r) => setTimeout(r, 50));
    return engine.running;
  };
  buildPanel($('panel'), state, scene, kb, { midi, vibrato, recorder, capture, ensureAudio });

  // debugging handle (console: __sax.state.set(0, 3) etc.)
  (window as unknown as { __sax: unknown }).__sax = { state, scene, engine, kb, geo, midi, vibrato, recorder, capture, chart, get imp() { return imp; }, get impPlot() { return impPlot; } };

  // ---- status / start ------------------------------------------------------------------------
  const statusEl = $('status');
  const statusText = $('status-text');
  const showStatus = (s: EngineStatus): void => {
    statusEl.className = 'status';
    switch (s.state) {
      case 'idle': statusText.textContent = 'audio off'; break;
      case 'loading': statusText.textContent = 'loading engine…'; break;
      case 'running': statusText.textContent = 'engine running'; statusEl.classList.add('running'); break;
      case 'suspended': statusText.textContent = 'audio suspended'; statusEl.classList.add('warn'); break;
      case 'no-engine': statusText.textContent = 'engine not built'; statusEl.classList.add('warn'); statusEl.title = s.message; break;
      case 'error': statusText.textContent = 'engine error'; statusEl.classList.add('error'); statusEl.title = s.message; break;
    }
    if (s.state === 'no-engine' || s.state === 'error') $('overlay-msg').textContent = s.message;
  };
  engine.onStatus(showStatus);
  // audio-thread CPU load (engine/worklet.ts monitor): hint when high; drop oversampling only when
  // the audio has been overloaded (glitching) for seconds
  engine.onPerf((p) => {
    if (engine.status.state !== 'running') return;
    const pct = `${Math.round(100 * p.load)}%`;
    if (p.level === 'overload' && p.os > 1) {
      state.set(P.oversample, p.recommendOs, 'auto-quality');
      statusText.textContent = `CPU overload — oversampling lowered to ${p.recommendOs}×`;
      statusEl.classList.add('warn');
      statusEl.title = `audio thread at ${pct} of real time; oversampling reduced ${p.os}× → ${p.recommendOs}× to stop dropouts`;
    } else if (p.level === 'high' && p.os > 1) {
      statusText.textContent = `engine running · CPU ${pct} — try oversampling ${p.recommendOs}×`;
      statusEl.classList.add('warn');
      statusEl.title = `audio thread at ${pct} of real time (${engine.build}); lower Engine › Oversampling to ${p.recommendOs}× if you hear dropouts`;
    } else {
      statusText.textContent = 'engine running';
      statusEl.classList.remove('warn');
      statusEl.title = `audio thread at ${pct} of real time (${engine.build})`;
    }
  });
  const impPlot = new ImpedancePlot($<HTMLCanvasElement>('impedance'));
  let imp: ImpedanceClient | null = null;
  void engine.probe().then((ok) => {
    if (!ok) {
      $('overlay-msg').textContent = 'Engine not built yet (npm run build:engine) — you can still explore the model.';
      impPlot.status = 'engine not built';
      return;
    }
    // second engine instance in a Web Worker computes |Z_in| on demand (never on the audio thread)
    imp = new ImpedanceClient(`${import.meta.env.BASE_URL}engine.wasm`, json, state.values, state.keyDown);
    imp.onResult = (res) => (res.kind === 'tract' ? impPlot.setTract(res) : impPlot.setData(res));
    state.onParam((id, v) => imp?.setParam(id, v));
    state.onKeys(() => imp?.setKeys(state.keyDown));
  });
  const overlay = $('overlay');
  $('start').addEventListener('click', async () => {
    await engine.start();
    if (engine.status.state === 'running' || engine.status.state === 'loading') overlay.hidden = true;
    else if (engine.status.state === 'no-engine') overlay.hidden = true;
    if (overlay.hidden) tour.firstRun();
  });
  $('explore').addEventListener('click', () => { overlay.hidden = true; tour.firstRun(); });
  statusEl.addEventListener('click', () => {
    if (engine.status.state === 'idle' || engine.status.state === 'suspended') void engine.start();
    else if (engine.status.state === 'running') void engine.suspend();
  });
  statusEl.style.cursor = 'pointer';
  // Resume audio on first keyboard play if the user skipped the overlay
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && engine.status.state === 'idle' && overlay.hidden) void engine.start();
  });

  // ---- top bar buttons -----------------------------------------------------------------------
  const camButtons = document.querySelectorAll<HTMLButtonElement>('[data-cam]');
  const setCam = (c: CameraPreset): void => {
    scene.goto(c);
    camButtons.forEach((b) => b.classList.toggle('on', b.dataset.cam === c));
  };
  camButtons.forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam as CameraPreset)));
  const toggles = document.querySelectorAll<HTMLButtonElement>('[data-toggle]');
  const syncToggles = (): void => toggles.forEach((b) => b.classList.toggle('on', !!scene.opts[b.dataset.toggle as 'xray' | 'cutaway']));
  toggles.forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    if (k === 'xray') scene.setXray(!scene.opts.xray);
    if (k === 'cutaway') scene.setCutaway(!scene.opts.cutaway);
    syncToggles();
  }));
  syncToggles();
  const recBtn = $('rec-btn');
  recorder.onStop = (secs) => { recBtn.textContent = '● Rec'; recBtn.classList.remove('rec'); recBtn.title = `saved ${secs.toFixed(1)} s`; };
  recBtn.addEventListener('click', async () => {
    if (recorder.recording) { recorder.stop(); return; }
    if (!(await ensureAudio())) { $('overlay-msg').textContent = 'Recording needs the audio engine.'; return; }
    if (recorder.start()) { recBtn.textContent = '■ Stop'; recBtn.classList.add('rec'); }
  });
  const tour = setupTour(scene);
  $('tour-btn').addEventListener('click', () => tour.open());
  const help = $('help');
  $('help-btn').addEventListener('click', () => (help.hidden = !help.hidden));
  $('help-close').addEventListener('click', () => (help.hidden = true));
  help.addEventListener('click', (e) => { if (e.target === help) help.hidden = true; });
  kb.onCommand = (cmd) => {
    if (cmd.startsWith('cam:')) setCam(cmd.slice(4) as CameraPreset);
    else if (cmd === 'xray') scene.setXray(!scene.opts.xray);
    else if (cmd === 'cutaway') scene.setCutaway(!scene.opts.cutaway);
    else if (cmd === 'airflow') scene.opts.airflow = !scene.opts.airflow;
    else if (cmd === 'help') help.hidden = !help.hidden;
    syncToggles();
  };
  const tractToggle = $<HTMLInputElement>('tract-overlay');
  tractToggle.addEventListener('change', () => impPlot.setShowTract(tractToggle.checked));
  $('viz-toggle').addEventListener('click', () => {
    const v = $('viz');
    v.classList.toggle('collapsed');
    $('viz-toggle').textContent = v.classList.contains('collapsed') ? '▴' : '▾';
  });

  // ---- readouts + visualizers ----------------------------------------------------------------
  const scope = new Scope($<HTMLCanvasElement>('scope'));
  const spectrum = new Spectrum($<HTMLCanvasElement>('spectrum'));
  const bore = new BorePlot($<HTMLCanvasElement>('boreplot'));
  const r = {
    note: $('r-note'), freq: $('r-freq'), written: $('r-written'), cents: $('r-cents'), needle: $('r-cents-needle'),
    lung: $('r-lung'), mouth: $('r-mouth'), mp: $('r-mp'), flow: $('r-flow'), h: $('r-h'), rms: $('r-rms'),
    fingering: $('r-fingering'), mode: $('r-mode'), perf: $('r-perf'), regime: $('r-regime'), delta: $('r-delta'),
  };

  // ---- 3D-anchored readouts in the vocal tract ---------------------------------------------
  const labels = new Labels($('labels'), scene.camera, scene.renderer.domElement);
  const lb = {
    lungs: labels.add(scene.player.anchors.lungs, 'lungs', '#4aa8ff', 70, 0),
    glottis: labels.add(scene.player.anchors.glottis, 'glottis', '#b48cff', 80, 0),
    mouth: labels.add(scene.player.anchors.mouth, 'mouth / tract', '#5ec8ff', 40, -30),
    reed: labels.add(scene.mp.reedAnchor, 'reed channel', '#ffa94d', -60, 30),
    tract: labels.add(scene.player.anchors.tract, 'vocal-tract resonance', '#5ec8ff', -40, -40),
  };

  // ---- "what changed": Δ pitch since the start of the current param gesture -------------------
  const change = { id: -1, from: 0, f0: 0, t: 0 };
  let smoothedFreqForDelta = 0;
  const prevValues = Float32Array.from(state.values); // value before the current event
  state.onParam((id, _v, source) => {
    if (source === 'drag' || source === 'panel' || source === 'preset') {
      const now = performance.now();
      if (id !== change.id || now - change.t > 1500) {
        change.id = id;
        change.from = prevValues[id];
        change.f0 = smoothedFreqForDelta;
      }
      change.t = now;
    }
  });
  state.onParam((id, v) => { prevValues[id] = v; });
  const fingerSets = geo.fingerings.map((f) => ({ name: f.note, keys: new Set(f.keys) }));
  for (const a of geo.alternate_fingerings ?? []) fingerSets.push({ name: `${a.note} (${a.name ?? 'alt'})`, keys: new Set(a.keys) });
  let fingeringText = '—';
  const updateFingering = (): void => {
    const down = new Set<string>();
    geo.keys.forEach((k, i) => { if (state.keyDown[i] > 0.5) down.add(k.id); });
    const m = fingerSets.find((f) => f.keys.size === down.size && [...f.keys].every((k) => down.has(k)));
    fingeringText = m ? `${m.name} (written)` : down.size ? [...down].join(' ') : 'open (C♯5)';
    r.fingering.textContent = fingeringText;
  };
  state.onKeys(updateFingering);
  updateFingering();

  let acc = 0;
  let smoothedFreq = 0;
  const set = (el: HTMLElement, s: string): void => { if (el.textContent !== s) el.textContent = s; };
  // the blow envelope is control-rate, independent of the render loop (keeps working when rendering
  // is slow or rAF is throttled)
  let lastCtl = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const cdt = Math.min(0.1, (now - lastCtl) / 1000);
    kb.update(cdt);
    vibrato.update(cdt);
    engine.poll(); // telemetry at control rate too (CSV capture, readouts) — independent of rendering
    lastCtl = now;
  }, 8);
  scene.onFrame((dt) => {
    const t = engine.telemetry;
    const live = engine.running && t.valid && performance.now() - t.time < 250;
    scope.draw(t, live);
    bore.draw(t, live, scene.peakPa);
    spectrum.draw(engine.analyser, live ? t.frequency : 0, engine.ctx?.sampleRate ?? 48000);
    impPlot.draw(live ? smoothedFreq : 0);
    labels.enabled = scene.opts.player;
    labels.update();
    acc += dt;
    if (acc < 1 / 15) return;
    acc = 0;
    syncToggles();
    const f = live ? t.frequency : 0;
    if (f > 20) {
      smoothedFreq = smoothedFreq > 0 && Math.abs(f / smoothedFreq - 1) < 0.03 ? smoothedFreq + (f - smoothedFreq) * 0.5 : f;
      const midi = 69 + 12 * Math.log2(smoothedFreq / 440);
      const cents = Math.round((midi - Math.round(midi)) * 100);
      set(r.note, midiName(midi));
      set(r.freq, smoothedFreq.toFixed(1));
      set(r.written, midiName(midi + 9));
      set(r.cents, `${cents >= 0 ? '+' : ''}${cents}¢`);
      r.needle.style.left = `${50 + cents}%`;
    } else {
      smoothedFreq = 0;
      set(r.note, '—'); set(r.freq, '0.0'); set(r.written, '—'); set(r.cents, '±0¢');
      r.needle.style.left = '50%';
    }
    set(r.lung, (live ? t.lungPressure / 1000 : state.get(P.lung_pressure)).toFixed(2));
    set(r.mouth, live ? (t.mouthPressure / 1000).toFixed(2) : '—');
    set(r.mp, live ? (t.mouthpiecePressure / 1000).toFixed(2) : '—');
    set(r.flow, live ? (t.flow * 1000).toFixed(3) : '—');
    set(r.h, live ? (t.reedOpening * 1000).toFixed(2) : '—');
    set(r.rms, live && t.outputRms > 0 ? (20 * Math.log10(t.outputRms)).toFixed(1) : '-∞');
    set(r.mode, kb.opts.mode === 'note' ? `note mode${kb.opts.octaveShift ? ` (${kb.opts.octaveShift > 0 ? '+' : ''}${kb.opts.octaveShift} oct)` : ''}` : 'direct-key mode');
    smoothedFreqForDelta = smoothedFreq;
    // register / regime
    const tip = state.get(P.tip_opening) / 1000;
    let rmax = -Infinity;
    for (let i = 0; i < t.scopeReed.length; i++) rmax = Math.max(rmax, t.scopeReed[i]);
    const chips: string[] = [];
    if (!live) chips.push('<span class="chip">audio off</span>');
    else if (state.get(P.tongue_reed_contact) > 0.6) chips.push('<span class="chip warn">tongue on reed</span>');
    else if (!(f > 20) || t.outputRms < 1e-4) chips.push(`<span class="chip">silent${state.get(P.lung_pressure) > 0.3 ? ' (below threshold?)' : ''}</span>`);
    else {
      const k = impPlot.peakIndexFor(f);
      if (k === 1) chips.push('<span class="chip r1">1st register · Z peak 1</span>');
      else if (k === 2) chips.push('<span class="chip r2">2nd register · Z peak 2</span>');
      else if (k >= 3) chips.push(`<span class="chip r3">altissimo · Z peak ${k}</span>`);
      else chips.push('<span class="chip warn">off-resonance (squeak / multiphonic?)</span>');
      if (impPlot.tractRes > 0 && impPlot.tractResMag >= 10e6 && (() => { const c = 1200 * Math.log2(impPlot.tractRes / f); return c > -150 && c < 450; })()) chips.push('<span class="chip r3">tract-supported</span>');
      chips.push(rmax >= 0.92 * tip ? '<span class="chip">beating reed</span>' : '<span class="chip">non-beating</span>');
    }
    const html = chips.join('');
    if (r.regime.innerHTML !== html) r.regime.innerHTML = html;
    // what changed
    if (change.id >= 0 && performance.now() - change.t < 6000) {
      const d = PARAMS[change.id];
      const dc = change.f0 > 20 && f > 20 ? 1200 * Math.log2(smoothedFreq / change.f0) : NaN;
      const txt = `${d.label} ${formatParam(change.id, change.from)} → <b>${formatParam(change.id, state.get(change.id))}</b>` +
        (Number.isFinite(dc) ? ` · pitch <b>${dc >= 0 ? '+' : ''}${dc.toFixed(1)}¢</b>` : '');
      if (r.delta.innerHTML !== txt) r.delta.innerHTML = txt;
    } else if (r.delta.innerHTML) r.delta.innerHTML = '';
    // vocal-tract labels
    if (live) {
      set(lb.lungs, `p_lung ${(t.lungPressure / 1000).toFixed(2)} kPa`);
      set(lb.glottis, `open ${(state.get(P.glottis_open) * 100).toFixed(0)}% · Δp ${((t.lungPressure - t.mouthPressure) / 1000).toFixed(2)} kPa`);
      set(lb.mouth, `p_mouth ${(t.mouthPressure / 1000).toFixed(2)} kPa`);
      set(lb.reed, `U ${(t.flow * 1000).toFixed(3)} L/s · h ${(t.reedOpening * 1000).toFixed(2)} mm · p_mp ${(t.mouthpiecePressure / 1000).toFixed(2)} kPa`);
    } else {
      set(lb.lungs, `p_lung ${state.get(P.lung_pressure).toFixed(2)} kPa (target)`);
      set(lb.glottis, `open ${(state.get(P.glottis_open) * 100).toFixed(0)}%`);
      set(lb.mouth, '—');
      set(lb.reed, '—');
    }
    // vocal-tract resonance vs the note (series impedance: strong tract peak near the note supports it)
    {
      const entry = chart.recognisedEntry();
      const target = live && f > 20 ? smoothedFreq : entry?.f_target ?? 0;
      const tr = impPlot.tractRes, trMag = impPlot.tractResMag;
      let cue = 0, txt = 'computing…';
      if (tr > 0) {
        const strong = trMag >= 10e6;
        txt = `≈ ${Math.round(tr)} Hz · ${(trMag / 1e6).toFixed(0)} MPa·s/m³`;
        if (target > 20) {
          const c = 1200 * Math.log2(tr / target);
          txt += ` · note ${Math.round(target)} Hz (${c >= 0 ? '+' : ''}${c.toFixed(0)}¢)`;
          // a tract resonance supports a note from slightly below to a few hundred cents above it
          // (the series peak of Z_bore + Z_tract sits between the two)
          if (strong && c > -150 && c < 450) cue = 2;
          else if (strong && c > -500 && c < 900) cue = 1;
        }
        if (!strong) txt += ' · weak (neutral tongue)';
      } else if (impPlot.status !== 'computing…') txt = impPlot.status;
      set(lb.tract, txt);
      const el = lb.tract.parentElement!;
      el.classList.toggle('cue-aligned', cue === 2);
      el.classList.toggle('cue-near', cue === 1);
      scene.player.tractCue = cue;
    }
    if (imp?.error) impPlot.status = imp.error;
    const cpu = t.cpuUs > 0 ? ` · engine ${t.cpuUs.toFixed(0)} µs/block` : '';
    set(r.perf, `${scene.fps.toFixed(0)} fps${cpu} · telemetry via ${engine.transport}${kb.isBlowing ? ' · blowing' : ''}`);
  });
}

main();
