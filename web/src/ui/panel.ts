// Param panel (lil-gui), two-way synced with AppState (3D drags, keyboard, presets).
import GUI, { type Controller } from 'lil-gui';
import { PARAMS, type ParamGroup } from '../engine/params';
import type { CameraPreset, SceneApp } from '../scene/SceneApp';
import type { AppState } from '../state';
import type { KeyboardPlayer } from './keyboard';
import type { MidiInput } from './midi';
import type { Vibrato } from './vibrato';
import type { TelemetryCapture, WavRecorder } from '../engine/Recorder';
import { download, stamp } from '../engine/Recorder';
import { PRESETS, applyPreset, capturePreset, loadUserPresets, parsePresetFile, saveUserPresets, type Preset } from './presets';

export interface PanelExtras {
  midi: MidiInput;
  vibrato: Vibrato;
  recorder: WavRecorder;
  capture: TelemetryCapture;
  /** called when the audio engine is needed (recording) */
  ensureAudio: () => Promise<boolean>;
}

const GROUPS: ParamGroup[] = ['Air', 'Embouchure', 'Tongue & Tract', 'Reed', 'Mouthpiece', 'Instrument', 'Environment', 'Engine'];

export function buildPanel(container: HTMLElement, state: AppState, scene: SceneApp, kb: KeyboardPlayer, x: PanelExtras): GUI {
  const gui = new GUI({ container, title: 'Controls', width: 300 });
  const proxy: Record<string, number> = {};
  const ctrls: Controller[] = [];

  // presets + view
  const top = {
    preset: PRESETS[0].name,
    camera: 'full' as CameraPreset,
    releaseKeys: () => { state.clearKeys(); kb.releaseAll(); },
  };
  let userPresets: Preset[] = loadUserPresets();
  const USER = '★ ';
  const presetNames = (): string[] => [...PRESETS.map((p) => p.name), ...userPresets.map((p) => USER + p.name)];
  const findPreset = (name: string): Preset | undefined =>
    name.startsWith(USER) ? userPresets.find((p) => USER + p.name === name) : PRESETS.find((q) => q.name === name);
  // the preset dropdown sits alone in its folder: lil-gui's options() re-creates the controller at
  // the end of its parent, which is then still the right place
  const presetFolder = gui.addFolder('Preset');
  const onPreset = (name: string): void => {
    const p = findPreset(name);
    if (p) { applyPreset(state, p); kb.opts.blowPressure = p.blow; blowCtrl.updateDisplay(); }
  };
  let presetCtrl = presetFolder.add(top, 'preset', presetNames()).name('Preset').onChange(onPreset);
  const refreshPresets = (select?: string): void => {
    if (select) top.preset = select;
    presetCtrl = presetCtrl.options(presetNames()).name('Preset').onChange(onPreset);
    presetCtrl.updateDisplay();
  };

  for (const g of GROUPS) {
    const f = gui.addFolder(g);
    if (g === 'Engine' || g === 'Environment') f.close();
    for (const d of PARAMS.filter((p) => p.group === g)) {
      proxy[d.name] = state.get(d.id);
      const unit = d.unit && !d.unit.includes('–') ? ` (${d.unit})` : '';
      const c = f.add(proxy, d.name, d.min, d.max, d.step ?? (d.max - d.min) / 200).name(d.label + unit);
      c.onChange((v: number) => state.set(d.id, v, 'panel'));
      c.domElement.title = `${d.name} — ${d.description}`;
      ctrls[d.id] = c;
    }
    if (g === 'Air') {
      blowCtrl = f.add(kb.opts, 'blowPressure', 0, 10, 0.05).name('Blow target (kPa) [space]');
      f.add(kb.opts, 'attackMs', 1, 400, 1).name('Blow attack (ms)');
      f.add(kb.opts, 'releaseMs', 1, 600, 1).name('Blow release (ms)');
    }
    if (g === 'Reed') f.add(scene.opts, 'reedGain', 1, 20, 0.5).name('Reed motion ×(visual)');
  }

  // params appended later by the engine (ids ≥ 22) whose group is not one of the standard folders
  const extra = PARAMS.filter((d) => !GROUPS.includes(d.group));
  if (extra.length) {
    const f = gui.addFolder('Advanced');
    for (const d of extra) {
      proxy[d.name] = state.get(d.id);
      const c = f.add(proxy, d.name, d.min, d.max, d.step ?? (d.max - d.min) / 200).name(d.label ?? d.name);
      c.onChange((v: number) => state.set(d.id, v, 'panel'));
      c.domElement.title = `${d.name} — ${d.description ?? ''}`;
      ctrls[d.id] = c;
    }
  }

  const view = gui.addFolder('View');
  view.add(top, 'camera', { 'Full instrument': 'full', 'Mouthpiece close-up': 'mouthpiece', 'Player cutaway': 'player', 'Keys / hands': 'keys' })
    .name('Camera').onChange((v: CameraPreset) => scene.goto(v));
  view.add(scene.opts, 'xray').name('X-ray brass [⇧X]').onChange((v: boolean) => scene.setXray(v)).listen();
  view.add(scene.opts, 'cutaway').name('Cutaway [⇧C]').onChange((v: boolean) => scene.setCutaway(v)).listen();
  view.add(scene.opts, 'airflow').name('Air-flow particles [⇧F]').listen();
  view.add(scene.opts, 'wave').name('Standing wave line');
  view.add(scene.opts, 'player').name('Show player').onChange((v: boolean) => scene.setPlayerVisible(v));

  const play = gui.addFolder('Keyboard play');
  play.add(kb.opts, 'mode', { 'Notes (fingering chart)': 'note', 'Direct keys': 'keys' }).name('Mode [`]').onChange((m: 'note' | 'keys') => kb.setMode(m));
  play.add(kb.opts, 'autoBlow').name('Auto-blow on note');
  play.add(kb.opts, 'octaveShift', -1, 1, 1).name('Octave shift [↑↓]');
  play.add(top, 'releaseKeys').name('Release all keys [Esc]');

  // ---- MIDI + vibrato ---------------------------------------------------------------------------
  const midiF = gui.addFolder('MIDI & vibrato');
  const midiState = { status: x.midi.status, connect: () => void x.midi.connect() };
  midiF.add(midiState, 'connect').name('Connect MIDI input');
  const midiStatus = midiF.add(midiState, 'status').name('Status').disable();
  x.midi.onStatus = () => { midiState.status = x.midi.status; midiStatus.updateDisplay(); };
  midiF.add(x.midi.opts, 'notes', { 'written pitch': 'written', 'concert pitch': 'concert' }).name('MIDI notes are');
  midiF.add(x.midi.opts, 'modWheel', { 'vibrato depth': 'vibrato', 'tongue height': 'tongue_y' }).name('Mod wheel →');
  midiF.add(x.midi.opts, 'channel', 0, 16, 1).name('Channel (0 = omni)');
  midiF.add(kb.opts, 'velocitySensitive').name('Velocity → blow');
  midiF.add(kb.opts, 'breathMax', 1, 10, 0.1).name('Breath CC2/11 max (kPa)');
  midiF.add({ reset: () => kb.breath(null) }, 'reset').name('Release breath controller');
  midiF.add(x.vibrato.opts, 'enabled').name('Jaw vibrato').listen();
  midiF.add(x.vibrato.opts, 'rateHz', 3, 8, 0.1).name('Vibrato rate (Hz)');
  midiF.add(x.vibrato.opts, 'depth', 0, 1, 0.01).name('Vibrato depth').listen();
  midiF.add(x.vibrato.opts, 'onlyWhileBlowing').name('Only while blowing');

  // ---- presets, recording, export ------------------------------------------------------------
  const io = gui.addFolder('Presets & export');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const list = parsePresetFile(await f.text());
      for (const p of list) userPresets = [...userPresets.filter((q) => q.name !== p.name), p];
      saveUserPresets(userPresets);
      refreshPresets(list.length ? USER + list[0].name : undefined);
      if (list[0]) { applyPreset(state, list[0]); kb.opts.blowPressure = list[0].blow; blowCtrl.updateDisplay(); }
    } catch (err) {
      alert(`Could not import presets: ${(err as Error).message}`);
    }
    fileInput.value = '';
  };
  const actions = {
    save: () => {
      const name = prompt('Preset name', `My setup ${userPresets.length + 1}`)?.trim();
      if (!name) return;
      const p = capturePreset(state, name, kb.opts.blowPressure);
      userPresets = [...userPresets.filter((q) => q.name !== name), p];
      saveUserPresets(userPresets);
      refreshPresets(USER + name);
    },
    remove: () => {
      if (!top.preset.startsWith(USER)) { alert('Select a ★ user preset to delete.'); return; }
      userPresets = userPresets.filter((p) => USER + p.name !== top.preset);
      saveUserPresets(userPresets);
      refreshPresets(PRESETS[0].name);
    },
    exportCurrent: () => download(`sax-preset-${stamp()}.json`, JSON.stringify(capturePreset(state, `Exported ${stamp()}`, kb.opts.blowPressure), null, 2), 'application/json'),
    exportAll: () => download(`sax-user-presets-${stamp()}.json`, JSON.stringify(userPresets, null, 2), 'application/json'),
    importFile: () => fileInput.click(),
    record: async () => {
      if (x.recorder.recording) { x.recorder.stop(); recCtrl.name('● Record WAV'); return; }
      if (!(await x.ensureAudio())) { alert('Start audio first (engine must be running).'); return; }
      if (x.recorder.start()) recCtrl.name('■ Stop & save WAV');
    },
    capture: () => {
      if (x.capture.capturing) { x.capture.stop(); capCtrl.name('Capture telemetry CSV'); }
      else { x.capture.start(); capCtrl.name('■ Stop & save CSV'); }
    },
  };
  io.add(actions, 'save').name('Save current as user preset…');
  io.add(actions, 'remove').name('Delete selected ★ preset');
  io.add(actions, 'exportCurrent').name('Export current setup (JSON)');
  io.add(actions, 'exportAll').name('Export ★ user presets (JSON)');
  io.add(actions, 'importFile').name('Import presets (JSON)…');
  const recCtrl = io.add(actions, 'record').name('● Record WAV');
  const capCtrl = io.add(actions, 'capture').name('Capture telemetry CSV');

  state.onParam((id, v, source) => {
    const d = PARAMS[id];
    proxy[d.name] = v;
    if (source !== 'panel') ctrls[id]?.updateDisplay();
  });
  kb.onModeChange = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());
  return gui;
}

let blowCtrl: Controller;
