import './style.css';
import { EngineClient, type EngineStatus } from './engine/EngineClient';
import { loadGeometry } from './scene/geometry';
import { SceneApp, type CameraPreset } from './scene/SceneApp';
import type * as THREE from 'three';
import { partMeta, type Pickable } from './scene/interaction';
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
import { ContextCard, partKindOf, type PartKind } from './ui/context';
import { GrabHints } from './ui/grabHints';
import { HandleClusters } from './ui/clusters';
import { AutoPlayer, CONTROL_GROUPS } from './ui/autoPlayer';
import { AUTO_CONTROLS, P, PARAMS, formatParam } from './engine/params';

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

// ---- remembered UI state (drawers closed by default) ---------------------------------------------
interface UiPrefs { controls: boolean; scopes: boolean; hints: boolean; labels: boolean }
const PREFS_KEY = 'saxsim.ui.v1';
function loadPrefs(): UiPrefs {
  const d: UiPrefs = { controls: false, scopes: false, hints: true, labels: false };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<UiPrefs>) }; } catch { return d; }
}
function savePrefs(p: UiPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable: session only */ }
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
  const prefs = loadPrefs();

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
  const ctx = new ContextCard($('context'), state, kb);
  const ap = new AutoPlayer(state, engine, geo, kb, geo.keys.map((k) => k.id));
  /** controls that shape the vocal tract (impedance overlay) */
  const TRACT_IDS: number[] = [P.tongue_x, P.tongue_y, P.tongue_tip, P.tongue_length, P.jaw_open, P.glottis_open];
  const tractSent = new Map<number, number>();
  /** keep the impedance worker's tract on the values in effect (Play: auto player; Explore: params) */
  const impTract = (): void => {
    if (!imp) return;
    for (const id of TRACT_IDS) {
      const v = ap.mode === 'play' ? ap.value(id) : state.get(id);
      const last = tractSent.get(id);
      if (last === undefined ? v !== state.get(id) : Math.abs(v - last) > (ap.mode === 'play' ? 0.02 : 0)) { imp.setParam(id, v); tractSent.set(id, v); }
    }
  };
  ctx.valueOf = (id) => (ap.mode === 'play' && !ap.owns(id) && (AUTO_CONTROLS as readonly number[]).includes(id) ? ap.value(id) : NaN);

  // debugging handle (console: __sax.state.set(0, 3) etc.)
  (window as unknown as { __sax: unknown }).__sax = { state, scene, engine, kb, geo, midi, vibrato, recorder, capture, chart, ctx, ap, get coach() { return coach; }, get imp() { return imp; }, get impPlot() { return impPlot; } };

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
      statusEl.title = `audio thread at ${pct} of real time (${engine.build}); lower Controls › Engine › Oversampling to ${p.recommendOs}× if you hear dropouts`;
    } else {
      statusText.textContent = 'engine running';
      statusEl.classList.remove('warn');
      statusEl.title = `audio thread at ${pct} of real time (${engine.build}) — click to pause`;
    }
  });
  const impPlot = new ImpedancePlot($<HTMLCanvasElement>('impedance'));
  let imp: ImpedanceClient | null = null;
  void engine.probe().then((ok) => {
    if (!ok) {
      $('overlay-msg').textContent = 'Engine not built yet (npm run build:engine) — you can still explore the model.';
      impPlot.status = ctx.imp.status = 'engine not built';
      return;
    }
    // second engine instance in a Web Worker computes |Z_in| on demand (never on the audio thread)
    imp = new ImpedanceClient(`${import.meta.env.BASE_URL}engine.wasm`, json, state.values, state.keyDown);
    imp.onResult = (res) => {
      if (res.kind === 'tract') { impPlot.setTract(res); ctx.imp.setTract(res); }
      else { impPlot.setData(res); ctx.imp.setData(res); }
    };
    // the tract overlay must describe the tract that is actually playing: in Play mode the auto
    // player's controls in effect are fed from the frame loop (impTract below), not the base params
    state.onParam((id, v) => { if (!(ap.mode === 'play' && TRACT_IDS.includes(id))) imp?.setParam(id, v); });
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
  // Resume audio on first keyboard play if the user skipped the overlay
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && engine.status.state === 'idle' && overlay.hidden) void engine.start();
  });

  // ---- drawers, menus, camera insets ---------------------------------------------------------
  const drawers = {
    controls: { el: $('drawer'), btn: $('controls-btn') },
    scopes: { el: $('viz'), btn: $('scopes-btn') },
  };
  const hud = $('hud');
  const phone = (): boolean => window.innerWidth <= 700;
  const updateInsets = (): void => {
    if (phone()) { scene.setViewInsets({ top: 88, right: 0, bottom: hud.offsetHeight + 8, left: 0 }); return; }
    const top = $('topbar').offsetHeight + 10;
    const right = prefs.controls ? drawers.controls.el.offsetWidth + 12 : 0;
    const bottom = hud.offsetHeight + 14 + (prefs.scopes ? drawers.scopes.el.offsetHeight + 12 : 0);
    scene.setViewInsets({ top, right, bottom, left: 0 });
  };
  const setDrawer = (name: keyof typeof drawers, open: boolean, focus = false): void => {
    const d = drawers[name];
    prefs[name] = open;
    savePrefs(prefs);
    d.el.classList.toggle('open', open);
    d.btn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle(`${name}-open`, open);
    updateInsets();
    if (open && focus) d.el.querySelector<HTMLElement>('button, input, select, [tabindex]')?.focus({ preventScroll: true });
    if (!open && d.el.contains(document.activeElement)) d.btn.focus({ preventScroll: true });
  };
  for (const name of Object.keys(drawers) as (keyof typeof drawers)[]) {
    const d = drawers[name];
    // move focus into the drawer only when it was opened from the keyboard (detail 0)
    d.btn.addEventListener('click', (e) => setDrawer(name, !prefs[name], e.detail === 0));
    d.el.querySelector<HTMLElement>(`[data-close="${name}"]`)!.addEventListener('click', () => setDrawer(name, false));
    d.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(name, false); });
    setDrawer(name, prefs[name]);
  }
  window.addEventListener('resize', updateInsets);
  new ResizeObserver(updateInsets).observe(hud);

  // popover menus (Layers, ⋯): click / Enter opens, Esc or outside click closes, ↑↓ move focus
  const menus = [...document.querySelectorAll<HTMLElement>('.menu')].map((m) => ({ btn: m.querySelector<HTMLButtonElement>('button[aria-haspopup]')!, pop: m.querySelector<HTMLElement>('.menu-pop')!, root: m }));
  const closeMenus = (except?: HTMLElement): void => menus.forEach((m) => { if (m.pop !== except) { m.pop.hidden = true; m.btn.setAttribute('aria-expanded', 'false'); } });
  for (const m of menus) {
    m.btn.addEventListener('click', () => {
      const open = m.pop.hidden;
      closeMenus(m.pop);
      m.pop.hidden = !open;
      m.btn.setAttribute('aria-expanded', String(open));
      if (open) m.pop.querySelector<HTMLElement>('button:not(.phone-only), button')?.focus({ preventScroll: true });
    });
    m.pop.addEventListener('keydown', (e) => {
      const items = [...m.pop.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.offsetParent !== null);
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') { closeMenus(); m.btn.focus(); e.stopPropagation(); }
      else if (e.key === 'ArrowDown') { items[(i + 1) % items.length]?.focus(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
    });
    // plain actions close the menu; checkboxes keep it open
    m.pop.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[role="menuitem"]')) closeMenus(); });
  }
  document.addEventListener('pointerdown', (e) => { if (!menus.some((m) => m.root.contains(e.target as Node))) closeMenus(); });

  // ---- camera buttons + layers ---------------------------------------------------------------
  const camButtons = document.querySelectorAll<HTMLButtonElement>('[data-cam]');
  const CAM_CONTEXT: Partial<Record<CameraPreset, PartKind>> = { mouthpiece: 'mouthpiece', player: 'tract', keys: 'keys' };
  const setCam = (c: CameraPreset): void => {
    scene.goto(c);
    clusters.view = c;
    camButtons.forEach((b) => { b.classList.toggle('on', b.dataset.cam === c); b.setAttribute('aria-pressed', String(b.dataset.cam === c)); });
    const k = CAM_CONTEXT[c];
    if (k) ctx.show(k);
  };
  camButtons.forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam as CameraPreset)));
  camButtons.forEach((b) => b.classList.toggle('on', b.dataset.cam === 'full'));

  const labels = new Labels($('labels'), scene.camera, scene.renderer.domElement);
  const keyView = scene.sax.keys.find((k) => k.def.id === 'LH1') ?? scene.sax.keys[0];
  const hints = new GrabHints($('grabtags'), scene.camera, scene.renderer.domElement, scene.interaction, keyView?.mesh);
  hints.setEnabled(prefs.hints);
  // declutter: handle clusters closer than 24 px collapse into one tag that flies to their view
  const clusters = new HandleClusters($('grabtags'), scene.camera, scene.renderer.domElement, (c) => setCam(c));
  clusters.add('mouthpiece ✋', 'mouthpiece', scene.mp.handleMeshes);
  clusters.add('tongue & throat ✋', 'player', scene.player.headHandles);
  (window as unknown as { __sax: Record<string, unknown> }).__sax.clusters = clusters;
  const toggles = document.querySelectorAll<HTMLButtonElement>('[data-toggle]');
  const toggleState = (k: string): boolean => {
    switch (k) {
      case 'xray': return scene.opts.xray;
      case 'cutaway': return scene.opts.cutaway;
      case 'airflow': return scene.opts.airflow;
      case 'hints': return prefs.hints;
      case 'labels': return prefs.labels;
    }
    return false;
  };
  const syncToggles = (): void => toggles.forEach((b) => {
    const on = toggleState(b.dataset.toggle ?? '');
    if (b.getAttribute('aria-checked') !== String(on)) b.setAttribute('aria-checked', String(on));
  });
  toggles.forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.toggle;
    if (k === 'xray') scene.setXray(!scene.opts.xray);
    else if (k === 'cutaway') scene.setCutaway(!scene.opts.cutaway);
    else if (k === 'airflow') scene.opts.airflow = !scene.opts.airflow;
    else if (k === 'hints') { prefs.hints = !prefs.hints; hints.setEnabled(prefs.hints, true); savePrefs(prefs); }
    else if (k === 'labels') { prefs.labels = !prefs.labels; savePrefs(prefs); }
    syncToggles();
  }));
  syncToggles();

  // ---- recording -------------------------------------------------------------------------------
  const recBtn = $('rec-btn');
  const recPill = $('rec-pill');
  let recStart = 0;
  recorder.onStop = (secs) => { recBtn.textContent = '● Record WAV'; recPill.hidden = true; recBtn.title = `saved ${secs.toFixed(1)} s`; };
  const toggleRec = async (): Promise<void> => {
    if (recorder.recording) { recorder.stop(); return; }
    if (!(await ensureAudio())) { statusText.textContent = 'recording needs the audio engine'; return; }
    if (recorder.start()) { recBtn.textContent = '■ Stop recording'; recPill.hidden = false; recStart = performance.now(); }
  };
  recBtn.addEventListener('click', () => void toggleRec());
  recPill.addEventListener('click', () => { if (recorder.recording) recorder.stop(); });

  // ---- tour, coach, help -----------------------------------------------------------------------
  const tour = setupTour(scene, setCam);
  // Coach mode (M9) — loaded on demand (separate chunk)
  let coach: import('./coach/CoachView').CoachView | null = null;
  const openCoach = async (): Promise<void> => {
    if (!coach) {
      const { CoachView } = await import('./coach/CoachView');
      coach = new CoachView({ geo, geometryJson: json, wasmUrl: `${import.meta.env.BASE_URL}engine.wasm`, state, kb, engine, ensureAudio });
    }
    if (coach.isOpen) coach.close(); else coach.open();
  };
  $('coach-btn').addEventListener('click', () => void openCoach());
  $('coach-menu').addEventListener('click', () => void openCoach());
  $('tour-btn').addEventListener('click', () => tour.open());
  const help = $('help');
  const setHelp = (open: boolean): void => { help.hidden = !open; if (open) $('help-close').focus({ preventScroll: true }); };
  $('help-btn').addEventListener('click', () => setHelp(help.hidden === true));
  $('help-close').addEventListener('click', () => setHelp(false));
  help.addEventListener('click', (e) => { if (e.target === help) setHelp(false); });
  help.addEventListener('keydown', (e) => { if (e.key === 'Escape') setHelp(false); });
  kb.onCommand = (cmd) => {
    if (cmd.startsWith('cam:')) setCam(cmd.slice(4) as CameraPreset);
    else if (cmd === 'xray') scene.setXray(!scene.opts.xray);
    else if (cmd === 'cutaway') scene.setCutaway(!scene.opts.cutaway);
    else if (cmd === 'airflow') scene.opts.airflow = !scene.opts.airflow;
    else if (cmd === 'help') setHelp(help.hidden === true);
    else if (cmd === 'scopes') setDrawer('scopes', !prefs.scopes);
    else if (cmd === 'controls') setDrawer('controls', !prefs.controls);
    syncToggles();
  };
  const tractToggle = $<HTMLInputElement>('tract-overlay');
  tractToggle.addEventListener('change', () => impPlot.setShowTract(tractToggle.checked));

  // ---- the primary action: Hold to blow ------------------------------------------------------
  const blowBtn = $<HTMLButtonElement>('blow-btn');
  const blowOn = (on: boolean): void => {
    if (on && engine.status.state === 'idle') void engine.start();
    kb.blow(on);
    blowBtn.setAttribute('aria-pressed', String(on));
  };
  blowBtn.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; blowBtn.setPointerCapture(e.pointerId); blowOn(true); });
  blowBtn.addEventListener('pointerup', () => blowOn(false));
  blowBtn.addEventListener('pointercancel', () => blowOn(false));
  blowBtn.addEventListener('lostpointercapture', () => blowOn(false));
  blowBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.repeat) blowOn(true); });
  blowBtn.addEventListener('keyup', (e) => { if (e.key === 'Enter') blowOn(false); });
  blowBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  // docked air control: the blow target (what Blow / Space / note keys blow at)
  const air = $<HTMLInputElement>('air-range'), airOut = $<HTMLOutputElement>('air-out');
  const syncAir = (): void => {
    if (document.activeElement !== air && Number(air.value) !== kb.opts.blowPressure) air.value = String(kb.opts.blowPressure);
    const t = `${kb.opts.blowPressure.toFixed(1)} kPa`;
    if (airOut.value !== t) airOut.value = t;
  };
  air.addEventListener('input', () => { kb.opts.blowPressure = Number(air.value); syncAir(); });
  syncAir();

  // ---- Play / Explore -------------------------------------------------------------------------
  // Play (auto player): keys + Volume; the player voices each note for the current mouthpiece.
  // Default for first-time users (press keys → a sax that speaks); the choice is remembered.
  const modeBtns = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
  const vol = $<HTMLInputElement>('vol-range'), volOut = $<HTMLOutputElement>('vol-out');
  const apStatus = $('ap-status'), apDoing = $('ap-doing'), apOwned = $('ap-owned'), apTune = $<HTMLButtonElement>('ap-tune');
  apTune.addEventListener('click', () => ap.applyTuning());
  const apSetup = $('ap-setup');
  const dynName = (v: number): string => (v < 0.12 ? 'pp' : v < 0.3 ? 'p' : v < 0.45 ? 'mp' : v < 0.6 ? 'mf' : v < 0.8 ? 'f' : 'ff');
  const syncVol = (): void => {
    const d = state.get(P.dynamic);
    if (document.activeElement !== vol && Math.abs(Number(vol.value) - d) > 1e-3) vol.value = String(d);
    const t = dynName(d);
    if (volOut.value !== t) volOut.value = t;
  };
  vol.addEventListener('input', () => { state.set(P.dynamic, Number(vol.value), 'volume'); syncVol(); });
  const renderMode = (): void => {
    document.body.classList.toggle('mode-play', ap.mode === 'play');
    document.body.classList.toggle('mode-explore', ap.mode === 'explore');
    modeBtns.forEach((b) => { const on = b.dataset.mode === ap.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    // "you control the tongue · reset" chips
    apOwned.textContent = '';
    if (ap.mode === 'play') {
      for (const g of CONTROL_GROUPS) {
        if (!g.ids.some((id) => ap.owns(id))) continue;
        const chip = document.createElement('span');
        chip.className = 'chip own';
        chip.dataset.group = g.name;
        chip.append(`you control the ${g.name} · `);
        const reset = document.createElement('button');
        reset.textContent = 'reset';
        reset.title = `Hand the ${g.name} back to the auto player`;
        reset.addEventListener('click', () => ap.release(g.ids));
        chip.append(reset);
        apOwned.append(chip);
      }
    }
    syncVol();
  };
  ap.onChange = renderMode;
  modeBtns.forEach((b) => b.addEventListener('click', () => ap.setMode(b.dataset.mode as 'play' | 'explore')));
  ap.setMode(AutoPlayer.initialMode(), false);
  renderMode();
  syncVol();

  // ---- grabbing a part: context card, drag readout, hints ------------------------------------
  const keyObjects = new Set<object>([...scene.sax.keys.map((k) => k.group), ...scene.sax.holes.map((h) => h.pivot)]);
  const isKeyPart = (p: Pickable): boolean => p.objects.some((o) => keyObjects.has(o));
  const grab = { from: new Map<number, number>(), f0: 0 };
  scene.interaction.onGrab = (p) => {
    const m = partMeta(p);
    // Play mode: grabbing a player part takes that control over from the auto player
    if (m && ap.mode === 'play') ap.take(m.ids.filter((id) => (AUTO_CONTROLS as readonly number[]).includes(id)));
    const kind = m ? partKindOf(m.ids) : isKeyPart(p) ? 'keys' : null;
    if (kind) ctx.show(kind);
    grab.from.clear();
    for (const id of m?.ids ?? []) grab.from.set(id, state.get(id));
    grab.f0 = smoothedFreq;
  };
  scene.interaction.onRelease = (p, moved) => {
    if (moved) hints.markGrabbed(p);
    else if (isKeyPart(p)) hints.markGrabbed('keys');
  };
  const signed = (x: number, d = 0): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
  scene.interaction.readout = (p) => {
    const m = partMeta(p);
    if (!m) return null;
    let rows = '';
    const changed = m.ids.filter((id) => Math.abs(state.get(id) - (grab.from.get(id) ?? state.get(id))) > (PARAMS[id].max - PARAMS[id].min) * 0.004);
    const lungBlow = m.ids.includes(P.lung_pressure) && kb.isBlowing;
    for (const id of changed.length ? changed : m.ids) {
      const v = lungBlow && id === P.lung_pressure ? kb.opts.blowPressure : state.get(id);
      const from = grab.from.get(id);
      const label = lungBlow && id === P.lung_pressure ? 'Blow target' : PARAMS[id].label;
      rows += `<div class="dr-row"><span>${label}</span><span>${changed.includes(id) && from !== undefined ? `<span class="from">${formatParam(id, from)} →</span>` : ''}<b>${formatParam(id, v)}</b></span></div>`;
    }
    let effect: string;
    if (smoothedFreq > 20) {
      const midi = 69 + 12 * Math.log2(smoothedFreq / 440);
      const cents = Math.round((midi - Math.round(midi)) * 100);
      const d = grab.f0 > 20 ? 1200 * Math.log2(smoothedFreq / grab.f0) : NaN;
      effect = `<span class="n">${midiName(midi + 9)}</span><span>${signed(cents)}¢</span>` +
        (Number.isFinite(d) ? `<span class="d ${d >= 0 ? 'up' : 'down'}">pitch ${signed(d, 1)}¢</span>` : '');
    } else {
      effect = `<span class="muted">${engine.running ? 'silent — hold Blow / Space to hear it' : 'start audio to hear it'}</span>`;
    }
    const lock = p.drag?.gain?.lock;
    const lockLine = lock ? `<div class="dr-lock">${scene.interaction.lockLabel ? `locked to <b>${scene.interaction.lockLabel}</b> · grab again to switch` : `move along the mouthpiece (${lock[0]}) or toward the reed (${lock[1]})`}</div>` : '';
    return `<div class="dr-title">${m.name}</div>${lockLine}${rows}<div class="dr-effect">${effect}</div><div class="dr-hint">Shift = fine adjust</div>`;
  };
  // the lung-pressure gauge (rail + fill + handle beside the chest) only appears while the lungs are
  // hovered or dragged — the lungs themselves are the grab target; the always-visible air control is
  // docked on the Blow button
  const lungP = scene.interaction.all.find((p) => /^Lungs/.test(partMeta(p)?.name ?? ''));
  const gauge: THREE.Object3D[] = [];
  if (lungP) {
    const [handle, , , fill] = lungP.objects;
    gauge.push(handle);
    if (fill) {
      gauge.push(fill);
      // the rail: the torso child standing at the gauge's x (not one of the pickable meshes)
      for (const c of fill.parent?.children ?? []) if (!lungP.objects.includes(c) && Math.abs(c.position.x - fill.position.x) < 1e-4 && Math.abs(c.position.z - fill.position.z) < 1e-4) gauge.push(c);
    }
  }
  const showGauge = (on: boolean): void => { for (const o of gauge) o.visible = on; };
  showGauge(false);
  scene.onFrame(() => showGauge(!!lungP && scene.interaction.current === lungP));

  // a lung drag while blowing moves the blow target (the envelope would overwrite the pressure)
  state.onParam((id, v, source) => {
    if (id === P.lung_pressure && source === 'drag' && kb.isBlowing) kb.setBlowTarget(v);
  });

  // ---- readouts + visualizers ----------------------------------------------------------------
  const scope = new Scope($<HTMLCanvasElement>('scope'));
  const spectrum = new Spectrum($<HTMLCanvasElement>('spectrum'));
  const bore = new BorePlot($<HTMLCanvasElement>('boreplot'));
  const r = {
    note: $('r-note'), freq: $('r-freq'), written: $('r-written'), cents: $('r-cents'), needle: $('r-cents-needle'), level: $('r-level'),
    lung: $('r-lung'), mouth: $('r-mouth'), mp: $('r-mp'), flow: $('r-flow'), h: $('r-h'), rms: $('r-rms'),
    fingering: $('r-fingering'), mode: $('r-mode'), perf: $('r-perf'), regime: $('r-regime'), regime2: $('r-regime2'), delta: $('r-delta'),
  };

  // ---- 3D-anchored readouts in the vocal tract (Layers → Airway readouts) ----------------------
  const lb = {
    lungs: labels.add(scene.player.anchors.lungs, 'lungs', '#4aa8ff', 70, 0),
    glottis: labels.add(scene.player.anchors.glottis, 'glottis', '#b48cff', 80, 0),
    mouth: labels.add(scene.player.anchors.mouth, 'mouth / tract', '#5ec8ff', 40, -30),
    reed: labels.add(scene.mp.reedAnchor, 'reed channel', '#ffa94d', -60, 30),
    tract: labels.add(scene.player.anchors.tract, 'vocal-tract resonance', '#5ec8ff', -40, -40),
  };

  // ---- "what changed": the param that moved most in the current gesture + Δ pitch ---------------
  // (a gesture ends after 1.5 s without changes; drags show the same live in the drag readout)
  const change = { from: new Map<number, number>(), f0: 0, t: 0 };
  let smoothedFreqForDelta = 0;
  const prevValues = Float32Array.from(state.values); // value before the current event
  state.onParam((id, _v, source) => {
    if (source === 'drag' || source === 'panel' || source === 'preset' || source === 'context') {
      const now = performance.now();
      if (now - change.t > 1500) { change.from.clear(); change.f0 = smoothedFreqForDelta; }
      if (!change.from.has(id)) change.from.set(id, prevValues[id]);
      change.t = now;
    }
  });
  state.onParam((id, v) => { prevValues[id] = v; });
  const fingerSets = geo.fingerings.map((f) => ({ name: f.note, full: f.note, keys: new Set(f.keys) }));
  // alternates: short label in the bar, the full name (with its keys) in the tooltip
  for (const a of geo.alternate_fingerings ?? []) fingerSets.push({ name: `${a.note} alt.`, full: `${a.note} (${a.name ?? 'alt'})`, keys: new Set(a.keys) });
  const updateFingering = (): void => {
    const down = new Set<string>();
    geo.keys.forEach((k, i) => { if (state.keyDown[i] > 0.5) down.add(k.id); });
    const m = fingerSets.find((f) => f.keys.size === down.size && [...f.keys].every((k) => down.has(k)));
    r.fingering.textContent = m ? `${m.name} fingering` : down.size ? `${down.size} keys: ${[...down].join(' ')}` : 'open (C♯5) fingering';
    r.fingering.title = m ? `${m.full} (written)` : [...down].join(' ');
  };
  state.onKeys(updateFingering);
  updateFingering();

  let acc = 0;
  let smoothedFreq = 0;
  let wasBlowing = false;
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
    if (prefs.scopes) {
      scope.draw(t, live);
      bore.draw(t, live, scene.peakPa);
      spectrum.draw(engine.analyser, live ? t.frequency : 0, engine.ctx?.sampleRate ?? 48000);
      impPlot.draw(live ? smoothedFreq : 0);
    }
    ap.update(dt, live, smoothedFreq);
    ctx.draw(t, live, engine.analyser, live ? smoothedFreq : 0, engine.ctx?.sampleRate ?? 48000);
    labels.enabled = scene.opts.player && prefs.labels;
    labels.update();
    clusters.update();
    hints.update(clusters.boxes());
    acc += dt;
    if (acc < 1 / 15) return;
    acc = 0;
    syncToggles();
    syncAir();
    syncVol();
    if (ap.mode === 'play') {
      set(apStatus, ap.statusText());
      if (apStatus.dataset.s !== ap.status) apStatus.dataset.s = ap.status;
      const match = ap.status === 'free' ? '' : ap.match === 1 ? ' · nearest fingering' : ap.match === 2 ? ' · default voicing' : '';
      set(apDoing, `${ap.source === 'estimate' ? 'Player (est.): ' : 'Player: '}${ap.describe()}${match}`);
      const note = ap.setupNote();
      apSetup.hidden = !note;
      if (note) set(apSetup, note);
      const hint = ap.tuningHint();
      apTune.hidden = !hint;
      if (hint) set(apTune, `${hint.text} · apply`);
    }
    if (kb.isBlowing !== wasBlowing) { wasBlowing = kb.isBlowing; blowBtn.classList.toggle('active', wasBlowing); }
    if (recorder.recording) { const s = Math.floor((performance.now() - recStart) / 1000); set($('rec-time'), `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); }
    const f = live ? t.frequency : 0;
    if (f > 20) {
      smoothedFreq = smoothedFreq > 0 && Math.abs(f / smoothedFreq - 1) < 0.03 ? smoothedFreq + (f - smoothedFreq) * 0.5 : f;
      const midi = 69 + 12 * Math.log2(smoothedFreq / 440);
      const cents = Math.round((midi - Math.round(midi)) * 100);
      set(r.note, midiName(midi));
      set(r.freq, smoothedFreq.toFixed(1));
      set(r.written, midiName(midi + 9));
      set(r.cents, `${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`);
      r.needle.style.left = `${50 + cents}%`;
    } else {
      smoothedFreq = 0;
      set(r.note, '—'); set(r.freq, '0.0'); set(r.written, '—'); set(r.cents, '±0¢');
      r.needle.style.left = '50%';
    }
    const db = live && t.outputRms > 0 ? 20 * Math.log10(t.outputRms) : -Infinity;
    r.level.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100)).toFixed(0)}%`;
    set(r.lung, (live ? t.lungPressure / 1000 : state.get(P.lung_pressure)).toFixed(2));
    set(r.mouth, live ? (t.mouthPressure / 1000).toFixed(2) : '—');
    set(r.mp, live ? (t.mouthpiecePressure / 1000).toFixed(2) : '—');
    set(r.flow, live ? (t.flow * 1000).toFixed(3) : '—');
    set(r.h, live ? (t.reedOpening * 1000).toFixed(2) : '—');
    set(r.rms, Number.isFinite(db) ? db.toFixed(1) : '-∞');
    set(r.mode, kb.opts.mode === 'note' ? (kb.opts.octaveShift ? `· octave ${kb.opts.octaveShift > 0 ? '+' : ''}${kb.opts.octaveShift}` : '') : '· direct-key mode');
    smoothedFreqForDelta = smoothedFreq;
    // register / regime
    const tip = state.get(P.tip_opening) / 1000;
    let rmax = -Infinity;
    for (let i = 0; i < t.scopeReed.length; i++) rmax = Math.max(rmax, t.scopeReed[i]);
    const chips: string[] = [];
    let chips2 = '';
    if (!live) chips.push(`<span class="chip">${engine.status.state === 'suspended' ? 'audio paused' : 'audio off'}</span>`);
    else if (state.get(P.tongue_reed_contact) > 0.6) chips.push('<span class="chip warn">tongue on reed</span>');
    else if (!(f > 20) || t.outputRms < 1e-4) chips.push(`<span class="chip">silent${state.get(P.lung_pressure) > 0.3 ? ' — below threshold?' : ''}</span>`);
    else {
      const k = impPlot.peakIndexFor(f);
      if (k === 1) chips.push('<span class="chip r1" title="playing on impedance peak 1">1st register</span>');
      else if (k === 2) chips.push('<span class="chip r2" title="playing on impedance peak 2">2nd register</span>');
      else if (k >= 3) chips.push(`<span class="chip r3" title="playing on impedance peak ${k}">altissimo · peak ${k}</span>`);
      else chips.push('<span class="chip warn" title="not on a bore resonance">squeak / multiphonic?</span>');
      if (impPlot.tractRes > 0 && impPlot.tractResMag >= 10e6 && (() => { const c = 1200 * Math.log2(impPlot.tractRes / f); return c >= -30 && c <= 400; })()) chips.push('<span class="chip r3">tract-supported</span>');
      chips2 = rmax >= 0.92 * tip ? '<span class="chip">beating reed</span>' : '<span class="chip">non-beating</span>';
    }
    const html = chips.join('');
    if (r.regime.innerHTML !== html) r.regime.innerHTML = html;
    if (r.regime2.innerHTML !== chips2) r.regime2.innerHTML = chips2;
    // what changed (outside drags, which have their own readout)
    if (change.from.size && performance.now() - change.t < 6000 && !scene.interaction.isDragging) {
      let id = -1, best = -1;
      for (const [k, from] of change.from) {
        const d = Math.abs(state.get(k) - from) / (PARAMS[k].max - PARAMS[k].min);
        if (d > best) { best = d; id = k; }
      }
      const d = PARAMS[id];
      const dc = change.f0 > 20 && f > 20 ? 1200 * Math.log2(smoothedFreq / change.f0) : NaN;
      const txt = `${d.label} ${formatParam(id, change.from.get(id)!)} → <b>${formatParam(id, state.get(id))}</b>` +
        (Number.isFinite(dc) ? ` · pitch <b>${signed(dc, 1)}¢</b>` : '');
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
    // vocal-tract resonance vs the note. The reed sees Z_bore + Z_tract in series: a strong tract
    // peak from just at to a few hundred cents ABOVE the playing frequency supports the note (that is
    // the altissimo / upper-register voicing, docs/ALTISSIMO.md: up to about a minor third above);
    // one sitting on a lower bore peak can pull the note down; elsewhere it does little.
    impTract();
    {
      const entry = chart.recognisedEntry();
      const target = live && f > 20 ? smoothedFreq : entry?.f_target ?? 0;
      const tr = impPlot.tractRes, trMag = impPlot.tractResMag;
      let cue = 0, txt = 'computing…', plain = 'Tract resonance: computing…';
      if (tr > 0) {
        const strong = trMag >= 10e6;
        txt = `≈ ${Math.round(tr)} Hz · ${(trMag / 1e6).toFixed(0)} MPa·s/m³`;
        plain = `Tract resonance ≈ ${Math.round(tr)} Hz`;
        if (target > 20) {
          const c = 1200 * Math.log2(tr / target);
          txt += ` · note ${Math.round(target)} Hz (${c >= 0 ? '+' : ''}${c.toFixed(0)}¢)`;
          const near = (fr: number): boolean => Math.abs(1200 * Math.log2(tr / fr)) <= 50;
          const lowerPeak = impPlot.peaks.find((p) => p < target * 0.97 && near(p));
          const harm = [2, 3].find((k) => near(k * target));
          let where: string;
          if (strong && c >= -30 && c <= 400) { cue = 2; where = `${signed(c)}¢: tuned just above the note — supporting it (altissimo / upper-register voicing)`; }
          else if (strong && lowerPeak) { cue = 1; where = `on a lower bore resonance (${Math.round(lowerPeak)} Hz) — may pull the note down`; }
          else if (strong && harm) { where = `near harmonic ${harm} of the note — colours the tone`; }
          else where = `${signed(c)}¢ from the note — little effect`;
          if (strong && cue !== 2 && c > -500 && c < 900 && !lowerPeak) cue = 1;
          plain += ` — ${where}`;
        }
        if (!strong) {
          const neutral = state.shown.get(P.tongue_y) < 0.5;
          txt += ` · weak${neutral ? ' (neutral tongue)' : ''}`;
          plain += ` (weak${neutral ? ': neutral tongue' : ''})`;
        }
      } else if (impPlot.status !== 'computing…') txt = plain = impPlot.status;
      set(lb.tract, txt);
      const el = lb.tract.parentElement!;
      el.classList.toggle('cue-aligned', cue === 2);
      el.classList.toggle('cue-near', cue === 1);
      scene.player.tractCue = cue;
      if (ctx.kind === 'tract') ctx.setNote(plain, cue === 2 ? 'cue-aligned' : cue === 1 ? 'cue-near' : '');
      else if (ctx.kind === 'keys') ctx.setNote(chart.recognised() ? `Fingering: ${chart.recognised()} (written)` : '');
      else ctx.setNote('');
    }
    if (imp?.error) impPlot.status = ctx.imp.status = imp.error;
    const cpu = t.cpuUs > 0 ? ` · engine ${t.cpuUs.toFixed(0)} µs/block` : '';
    set(r.perf, `${scene.fps.toFixed(0)} fps${cpu} · telemetry via ${engine.transport}${kb.isBlowing ? ' · blowing' : ''}`);
  });
}

main();
