// Coach mode (docs/COACHING.md M9): protocol wizard (mic or upload) → per-note analysis →
// fit → ranked suggestions with A/B in the simulator; sessions saved locally.
// Privacy: audio is processed in this browser only (Web Audio + a Web Worker) and never uploaded.
import type { EngineClient } from '../engine/EngineClient';
import { PARAMS } from '../engine/params';
import type { SaxGeometry } from '../scene/geometry';
import type { AppState } from '../state';
import { staticFingering } from '../ui/fingeringChart';
import { noteNameToMidi, type KeyboardPlayer } from '../ui/keyboard';
import { diagnose } from './advice';
import { COACH_SR, MicCapture, decodeFile } from './audioInput';
import { CoachEngine } from './CoachEngine';
import { F, FEATURE_NAMES, FEATURE_UNITS } from './features';
import { paramsForTake, runFit, takesToFitNotes } from './fitBridge';
import { recordingWarnings } from './warnings';
import { brightnessChart, centsChart, harmonicChart } from './plots';
import { PROTOCOL, dynamicLabel, fingeringFor, targetHz, type ProtocolNote } from './protocol';
import { deleteSession, listSessions, meanAbsCents, newSession, parseSessionFile, saveSession, type CoachSession, type RoomEstimate, type Suggestion, type TakeResult } from './session';

export interface CoachDeps {
  geo: SaxGeometry;
  geometryJson: string;
  wasmUrl: string;
  state: AppState;
  kb: KeyboardPlayer;
  engine: EngineClient;
  ensureAudio: () => Promise<boolean>;
}

type Tab = 'setup' | 'takes' | 'analysis' | 'fit' | 'sessions';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** features that reverberation makes unreliable (COACHING.md conventions) */
const ROOM_SENSITIVE = new Set<number>([F.attack, F.scoop, F.odd_even, F.tilt, F.h1 + 1, F.h1 + 2, F.h1 + 3]);
const fmt = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '—');

interface Segment { start: number; end: number; assigned: string; source: string; audio: Float32Array; f0?: number }

export class CoachView {
  readonly root: HTMLDivElement;
  private eng: CoachEngine | null = null;
  private mic = new MicCapture();
  session: CoachSession;
  private tab: Tab = 'setup';
  private audio = new Map<string, Float32Array>();
  private includeOptional = new Set<string>(PROTOCOL.filter((n) => n.recommended).map((n) => n.id));
  private cur = 0; // index into active protocol (mic)
  private segments: Segment[] = [];
  private harmonicSel = 'G4';
  private fitBusy = false;
  private fitProgress: [number, string] = [0, ''];
  private abNote = 'G4';
  private savedParams: Float32Array | null = null;
  private meterRaf = 0;
  private recState: 'idle' | 'countdown' | 'recording' | 'analysing' = 'idle';
  private status = '';
  /** for tests: resolves when the last analysis / fit finished */
  lastJob: Promise<unknown> = Promise.resolve();

  constructor(private d: CoachDeps) {
    this.session = newSession();
    this.root = document.createElement('div');
    this.root.id = 'coach';
    this.root.hidden = true;
    document.getElementById('app')!.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
  }

  private engine(): CoachEngine {
    this.eng ??= new CoachEngine(this.d.wasmUrl, this.d.geometryJson);
    return this.eng;
  }

  open(): void {
    this.root.hidden = false;
    this.engine();
    this.render();
  }

  close(): void {
    this.root.hidden = true;
    cancelAnimationFrame(this.meterRaf);
    this.mic.close();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private protocol(): ProtocolNote[] {
    return PROTOCOL.filter((n) => !n.optional || this.includeOptional.has(n.id));
  }

  // ---- rendering ---------------------------------------------------------------------------------
  private render(): void {
    const tabs: [Tab, string][] = [['setup', '1 · Setup'], ['takes', '2 · Takes'], ['analysis', '3 · Analysis'], ['fit', '4 · Fit & advice'], ['sessions', 'Sessions']];
    this.root.innerHTML = `
      <div class="coach-card">
        <header class="coach-head">
          <div><div class="coach-title">Tone coach</div><div class="coach-sub">${esc(this.session.label)} · A = ${this.session.refA} Hz · ${this.session.takes.length} takes</div></div>
          <nav class="coach-tabs">${tabs.map(([t, l]) => `<button data-tab="${t}" class="${t === this.tab ? 'on' : ''}">${l}</button>`).join('')}</nav>
          <button class="close" data-act="close" title="Back to the simulator">×</button>
        </header>
        <div class="coach-status" id="coach-status">${esc(this.status)}</div>
        <main class="coach-body">${this.body()}</main>
      </div>`;
    this.afterRender();
  }

  private setStatus(s: string): void {
    this.status = s;
    const el = this.root.querySelector('#coach-status');
    if (el) el.textContent = s;
  }

  private body(): string {
    switch (this.tab) {
      case 'setup': return this.setupHtml();
      case 'takes': return this.takesHtml();
      case 'analysis': return this.analysisHtml();
      case 'fit': return this.fitHtml();
      case 'sessions': return this.sessionsHtml();
    }
  }

  private setupHtml(): string {
    const opt = PROTOCOL.filter((n) => n.optional);
    return `
      <section class="coach-sec">
        <p class="privacy">🔒 Your audio is analysed <b>in this browser only</b> — nothing is uploaded. Sessions store the
          measured features (not the audio) locally; export them as JSON if you want to keep them.</p>
        <h3>The test set</h3>
        <p>Play each note ~3 s at mezzo-forte with a tongued start, and <b>stop it cleanly with the tongue (not a fade)</b>,
          with a short breath between notes (no tuner/drone). The room's echo right after each stop tells the coach how
          reverberant the recording is. Optional: <b>clap once</b> at the start of the recording for a better room measurement.
          ${PROTOCOL.filter((n) => !n.optional).length} notes, written pitch:</p>
        <div class="proto-list">${PROTOCOL.map((n) => `<span class="proto${n.optional && !n.recommended ? ' opt' : ''}${n.recommended ? ' rec' : ''}" title="${esc(n.why)}">${esc(n.id)}${n.recommended ? ' ★' : ''}</span>`).join('')}</div>
        <label class="row">Reference pitch A = <input type="number" id="coach-refa" min="415" max="466" step="0.5" value="${this.session.refA}" /> Hz</label>
        <div class="row">Optional notes: ${opt.map((n) => `<label title="${esc(n.why)}"><input type="checkbox" data-opt="${esc(n.id)}" ${this.includeOptional.has(n.id) ? 'checked' : ''}/> ${esc(n.id)}${n.recommended ? ' (recommended)' : ''}</label>`).join(' ')}</div>
        <p class="hint">★ <b>G4push</b>: ${esc(PROTOCOL.find((n) => n.id === 'G4push')?.why ?? '')}</p>
        <div class="coach-actions">
          <button class="primary" data-act="mic">🎙 Record with the microphone</button>
          <label class="btn">⤒ Upload recording(s)<input type="file" id="coach-upload" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac" multiple hidden /></label>
          <button data-act="demo" title="Render the test set with a simulated player (to explore the coach without a saxophone)">Try with a simulated player</button>
        </div>
        <p class="hint">Microphone tips: close-mic the horn (30–50 cm from the bell, slightly off-axis) or record in a dry room —
          reverberation blurs the attack, scoop and individual-harmonic measurements. Not too loud (keep the meter out of the red).
          The browser's echo cancellation, noise suppression and auto-gain are switched off.</p>
      </section>`;
  }

  private takesHtml(): string {
    const proto = this.protocol();
    const list = proto.map((n, i) => {
      const t = this.session.takes.find((x) => x.id === n.id);
      const st = !t ? '' : t.features[F.valid] > 0 ? `${t.features[F.cents] >= 0 ? '+' : ''}${fmt(t.features[F.cents], 0)}¢` : '✗';
      return `<li class="${i === this.cur && this.session.input === 'mic' ? 'cur' : ''}${t ? ' done' : ''}" data-goto="${i}"><b>${esc(n.id)}</b><span>${st}</span></li>`;
    }).join('');
    let main = '';
    if (this.segments.length) {
      main = `<h3>Assign the detected notes</h3>
        <table class="coach-table"><tr><th>#</th><th>start</th><th>length</th><th>pitch (concert)</th><th>note</th></tr>
        ${this.segments.map((s, i) => `<tr><td>${i + 1}</td><td>${fmt(s.start / COACH_SR, 1)} s</td><td>${fmt((s.end - s.start) / COACH_SR, 1)} s</td><td>${s.f0 ? `${fmt(s.f0, 0)} Hz` : '—'}</td>
          <td><select data-seg="${i}"><option value="">— skip —</option>${PROTOCOL.map((n) => `<option ${n.id === s.assigned ? 'selected' : ''}>${esc(n.id)}</option>`).join('')}</select></td></tr>`).join('')}
        </table>
        <div class="coach-actions"><button class="primary" data-act="analyze-segs">Analyse ${this.segments.filter((s) => s.assigned).length} notes</button>
        <span class="hint">segmentation: ${esc(this.segments[0]?.source ?? '')}</span></div>`;
    } else if (this.session.input === 'mic') {
      const n = proto[this.cur];
      if (n) {
        main = `${this.roomBadge()}<div class="prompt">
            <div class="prompt-note"><div class="big">${esc(n.note)}${n.id === 'G4push' ? ' <span class="push">push +5 mm</span>' : ''}</div><div>${dynamicLabel(n.dynamic)}</div>${n.instruction ? `<div class="instr">${esc(n.instruction)}</div>` : ''}<div class="hint">${esc(n.why)}</div>
              <div class="hint">target ${fmt(targetHz(n.note, this.session.refA), 1)} Hz (concert) · stop with the tongue</div></div>
            <div class="prompt-fing" id="coach-fing"></div>
          </div>
          <div class="meter"><div class="meter-fill" id="coach-meter"></div><span id="coach-clip" class="clip" hidden>CLIP — move back or play softer</span></div>
          <div class="rec-timer" id="coach-timer"></div>
          <div class="coach-actions">
            <button class="primary" data-act="rec" ${this.recState !== 'idle' ? 'disabled' : ''}>● Record ${esc(n.id)} (3 s)</button>
            <button data-act="next">Next ▶</button>
            <button data-act="skip">Skip</button>
            <button data-act="clap" title="Optional: record one hand clap so the coach can measure the room">👏 Room check (clap)</button>
            ${this.session.takes.length ? '<button data-act="to-analysis">Analysis ▶</button>' : ''}
          </div>`;
      } else main = '<p>All notes recorded. <button class="primary" data-act="to-analysis">Go to the analysis ▶</button></p>';
    } else {
      main = '<p>Upload a recording on the Setup tab, or switch to the microphone.</p>';
    }
    return `<section class="coach-takes"><ol class="take-list">${list}</ol><div class="take-main">${main}</div></section>`;
  }

  private analysisHtml(): string {
    const takes = this.orderedTakes();
    if (!takes.length) return '<p>No takes yet.</p>';
    const cols = [F.f0, F.cents, F.pitch_std, F.vib_rate, F.vib_depth, F.centroid_rel, F.tilt, F.hnr, F.edge, F.attack, F.scoop, F.regime];
    const chip = (t: TakeResult): string => {
      const f = t.features, c: string[] = [];
      if (f[F.valid] <= 0) return `<span class="chip warn">no stable pitch</span>${this.isExcluded(t) ? '<span class="chip warn">left out of fit</span>' : ''}`;
      c.push(f[F.pitch_std] > 8 ? '<span class="chip warn">unstable</span>' : '<span class="chip r1">stable</span>');
      if (Math.abs(f[F.scoop]) > 20) c.push('<span class="chip warn">scoop</span>');
      if (f[F.hnr] < 12) c.push('<span class="chip warn">breathy</span>');
      if (f[F.vib_rate] > 0) c.push('<span class="chip">vibrato</span>');
      if (Math.abs(f[F.regime] - 1) > 0.25) c.push('<span class="chip warn">wrong register</span>');
      if (t.clipped) c.push('<span class="chip warn">clipped</span>');
      if (this.isExcluded(t)) c.push('<span class="chip warn" title="the fitter left this take out">left out of fit</span>');
      return c.join('');
    };
    const src = takes.some((t) => t.source === 'fallback') ? 'TS stand-in extractor (the engine\'s sax_analyze is not in this build yet)' : 'engine analysis.rs (sax_analyze)';
    const grey = (this.session.room?.verdict ?? 0) >= 2;
    const extra = takes.some((t) => t.features.length > 29);
    return `
      <section class="coach-sec">
        ${this.roomBadge()}
        <div class="plots"><canvas id="pl-cents"></canvas><canvas id="pl-bright"></canvas></div>
        <div class="row">Harmonic spectrum <sup class="rs" title="individual harmonic levels are room-sensitive">room</sup> of <select id="harm-sel">${takes.map((t) => `<option ${t.id === this.harmonicSel ? 'selected' : ''}>${esc(t.id)}</option>`).join('')}</select></div>
        <canvas id="pl-harm"></canvas>
        <div class="table-wrap"><table class="coach-table">
          <tr><th>note</th>${cols.map((k) => `<th title="${FEATURE_UNITS[k]}${ROOM_SENSITIVE.has(k) ? ' — room-sensitive' : ''}">${FEATURE_NAMES[k]}${ROOM_SENSITIVE.has(k) ? '<sup class="rs">room</sup>' : ''}</th>`).join('')}${extra ? '<th title="release_clean: tongue stop (clean) vs fade">release</th>' : ''}<th></th></tr>
          ${takes.map((t) => `<tr class="${this.isExcluded(t) ? 'excluded' : ''}"><td><b>${esc(t.id)}</b></td>${cols.map((k) => `<td class="${grey && ROOM_SENSITIVE.has(k) ? 'rs-grey' : ''}">${t.features[F.valid] > 0 ? fmt(t.features[k], k === F.f0 ? 1 : k === F.regime || k === F.centroid_rel ? 2 : 1) : '—'}</td>`).join('')}${extra ? `<td>${t.features.length > 29 ? (t.features[29] > 0 ? 'clean' : '<span class="chip warn">fade</span>') : ''}</td>` : ''}<td>${chip(t)}</td></tr>`).join('')}
        </table></div>
        <p class="hint">Features: ${esc(src)}. Timbre numbers depend on your room and microphone; the coach compares notes with each other rather than with absolute targets.
          <sup class="rs">room</sup> = room-sensitive: in a reverberant room the attack, scoop and individual harmonic levels are unreliable (close-mic or record in a dry room).</p>
        <div class="coach-actions"><button class="primary" data-act="to-fit">Fit & advice ▶</button></div>
      </section>`;
  }

  private fitHtml(): string {
    const fit = this.session.fit;
    const sug = this.session.suggestions ?? [];
    const notes = this.orderedTakes().map((t) => t.id);
    const idf = (k: string): string => {
      const v = fit?.identifiability?.[k];
      return v === undefined ? '' : v < 0.5 ? '<span class="chip r1">well determined</span>' : v < 0.85 ? '<span class="chip">partly</span>' : '<span class="chip warn">not identifiable</span>';
    };
    const ctrl = fit ? Object.entries(fit.controls).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v, 2)}</td><td>${fit.uncertainty?.[k] !== undefined ? '± ' + fmt(fit.uncertainty[k], 2) : ''}</td><td>${idf(k)}</td></tr>`).join('') : '';
    return `
      <section class="coach-sec">
        <div class="coach-actions">
          <button class="primary" data-act="fit" ${this.fitBusy || !this.session.takes.length ? 'disabled' : ''}>${fit ? 'Re-fit' : 'Fit the simulator to my playing'}</button>
          <div class="progress"><div class="progress-fill" style="width:${(this.fitProgress[0] * 100).toFixed(0)}%"></div><span>${esc(this.fitProgress[1])}</span></div>
        </div>
        ${fit && this.simSounding() < 0.5 ? `<p class="flag">⚑ Only ${(this.simSounding() * 100).toFixed(0)} % of the simulated notes sound at the fitted controls — treat the fitted player with caution (re-fit, or record more notes).</p>` : ''}
        ${fit ? `<details ${sug.length ? '' : 'open'}><summary>Fitted player (${esc(fit.method)}, ${(fit.ms / 1000).toFixed(1)} s)</summary>
          <table class="coach-table small"><tr><th>control</th><th>value</th><th>uncertainty</th><th>from this recording</th></tr>${ctrl}</table></details>` : ''}
        ${fit && fit.status !== 'failed' ? this.recordingWarnings() : ''}
        ${fit?.status === 'failed' ? `<div class="fit-failed"><b>The fit failed</b> — the fitted simulator does not reproduce your recording, so no advice is given:<ul>${(fit.problems ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>Try re-recording the notes listed, or re-fit.</div>` : ''}
        ${this.session.roomNote ? `<div class="room-badge some">${esc(this.session.roomNote)}</div>` : ''}
        ${this.section('Most likely causes', 'template ranking — no fit needed', sug, 'template')}
        ${this.section('Also noticed', 'from the measured features', sug, 'observation')}
        ${this.section('From the fit', 'refinement: the fitted player along each cause', sug, 'fit')}
        ${this.section('What to try', '', sug, 'provisional')}
        ${this.session.hiddenRules?.length ? `<p class="hint">Not checked for this recording quality: ${esc(this.session.hiddenRules.join(', '))}.</p>` : ''}
        ${sug.length ? `<p class="hint">rules: ${esc(this.session.rulesSource ?? '')}</p>` : fit ? '<p>No clear issue found — nice playing. (Or record more notes.)</p>' : ''}
        ${fit && fit.status !== 'failed' ? `<div class="ab">
            <h3>Listen in the simulator (A/B)</h3>
            <div class="row">Note <select id="ab-note">${notes.map((n) => `<option ${n === this.abNote ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
              <button data-act="load-fitted">A · Load fitted player</button>
              <button data-act="play">▶ Play</button>
              <button data-act="restore" ${this.savedParams ? '' : 'disabled'}>Restore my previous settings</button></div>
            <p class="hint">"Load suggested change" on a suggestion loads B (fitted player + that change). Play the same note both ways.</p>
          </div>` : ''}
      </section>`;
  }

  private roomBadge(): string {
    const r = this.session.room;
    if (!r) return '';
    const label = ['dry', 'some room', 'too reverberant', 'uncertain'][r.verdict];
    const cls = ['ok', 'some', 'bad', 'unc'][r.verdict];
    const advice = r.source === 'unavailable' ? 'Room estimation is not in this engine build yet.'
      : r.verdict === 0 ? 'Good recording conditions — all measurements usable.'
      : r.verdict === 1 ? 'Some room sound: attack, scoop and single-harmonic numbers are shown with a caveat.'
      : r.verdict === 2 ? 'Too reverberant: move the mic closer to the bell or use a smaller, furnished room. Room-sensitive measurements are greyed out.'
      : 'Could not measure the room reliably (stop notes with the tongue, or clap once at the start).';
    const rt = Number.isFinite(r.rt60) && r.rt60 > 0 ? ` · RT60 ≈ ${r.rt60.toFixed(2)} s${r.rt60Spread > 0 ? ` ± ${r.rt60Spread.toFixed(2)}` : ''}${r.rt60 < 0.4 ? ' (short rooms read as dry)' : ''}` : '';
    const clap = r.clapRt60 !== undefined && r.clapRt60 > 0 ? ` · clap RT60 ≈ ${r.clapRt60.toFixed(2)} s` : '';
    return `<div class="room-badge ${cls}"><b>Recording: ${label}</b>${rt}${clap} — ${esc(advice)}</div>`;
  }

  /** blind room estimate of the given recording (whole upload, or the concatenated mic takes) */
  private async measureRoom(audio: Float32Array): Promise<void> {
    const v = await this.engine().room(audio, COACH_SR).catch(() => null);
    const room: RoomEstimate = v
      ? { rt60: v[0], rt60Spread: v[1], drr: v[2], noiseFloor: v[3], tails: v[4], confidence: v[5], verdict: (Math.max(0, Math.min(3, Math.round(v[6]))) as RoomEstimate['verdict']), clapRt60: v[7], tailRatio: v[8], source: 'wasm' }
      : { rt60: NaN, rt60Spread: NaN, drr: NaN, noiseFloor: NaN, tails: 0, confidence: 0, verdict: 3, source: 'unavailable' };
    this.session.room = room;
  }

  private clapAudio: Float32Array | null = null;

  private async micRoom(): Promise<void> {
    const parts = [...(this.clapAudio ? [this.clapAudio] : []), ...this.protocol().map((n) => this.audio.get(n.id)).filter((a): a is Float32Array => !!a)];
    if (!parts.length) return;
    const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    await this.measureRoom(all);
  }

  private async recordClap(): Promise<void> {
    if (this.recState !== 'idle') return;
    this.recState = 'recording';
    const timer = (s: string): void => { const t = this.root.querySelector('#coach-timer'); if (t) t.textContent = s; };
    timer('👏 clap once now…');
    this.mic.start();
    await new Promise((r) => setTimeout(r, 2000));
    this.clapAudio = await this.mic.stop();
    this.recState = 'idle';
    timer('');
    await this.micRoom();
    this.render();
  }

  private section(title: string, sub: string, all: Suggestion[], src: NonNullable<Suggestion['source']>): string {
    const list = all.map((x, i) => [x, i] as const).filter(([x]) => (x.source ?? 'provisional') === src);
    if (!list.length) return '';
    return `<h3>${esc(title)}${sub ? ` <span class="hint">(${esc(sub)})</span>` : ''}</h3>
      <ol class="suggestions" data-src="${src}">${list.map(([x, i]) => this.suggestionHtml(x, i)).join('')}</ol>`;
  }

  /** was this take left out of the fit by the fitter's recording guard? */
  private isExcluded(t: TakeResult): boolean {
    return !!this.session.fit?.excluded?.includes(t.id.replace(/\s+/g, ''));
  }

  /** player-facing amber warnings for takes the fitter left out (and other non-fatal problems) */
  private recordingWarnings(): string {
    const fit = this.session.fit;
    if (!fit) return '';
    const items = recordingWarnings(this.orderedTakes(), fit.excluded ?? [], fit.problems ?? []);
    return items.length ? `<div class="rec-warn"><b>Recording notes</b><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  }

  /** fraction of takes whose simulated counterpart sounds (valid) */
  private simSounding(): number {
    const sf = this.session.fit?.simFeatures;
    if (!sf) return 1;
    const v = Object.values(sf);
    return v.length ? v.filter((f) => f[F.valid] > 0).length / v.length : 1;
  }

  private suggestionHtml(s: Suggestion, i: number): string {
    return `<li class="sug${s.suppressed ? ' suppressed' : ''}">
      <div class="sug-head"><b>${s.alternatives?.length ? `${esc(s.cause)} <i>or</i> ${s.alternatives.map((a) => esc(a.cause)).join(' <i>or</i> ')}` : esc(s.cause)}</b><span class="confwrap">${s.source === 'template' ? `${(s.confidence * 100).toFixed(0)}%` : ''}<span class="conf" title="confidence"><span style="width:${(s.confidence * 100).toFixed(0)}%"></span></span></span></div>
      ${s.alternatives?.length ? `<div class="alts"><span class="lbl">One of these</span> the recording can't tell these apart — try them one at a time:
        <ul>${[s, ...s.alternatives].map((a) => `<li><b>${esc(a.cause)}</b> — ${esc(a.tryText)}</li>`).join('')}</ul></div>` : `<div><span class="lbl">Try</span> ${esc(s.tryText)}</div>`}
      <div><span class="lbl">Why</span> ${esc(s.why)}</div>
      ${s.lookalikes?.length ? `<div><span class="lbl">Look-alikes</span> sounds similar to: ${esc(s.lookalikes.join(' · '))} — if this doesn't help, try those.</div>` : ''}
      <div><span class="lbl">Listen for</span> ${esc(s.listen)}</div>
      ${s.flag ? `<div class="flag">⚑ ${esc(s.flag)}</div>` : ''}
      ${s.evidence ? `<div class="hint">evidence: ${esc(s.evidence)} · confidence ${(s.confidence * 100).toFixed(0)}%</div>` : ''}
      ${s.change?.length ? `<button data-act="load-sug" data-i="${i}">B · Load suggested change</button>` : ''}
    </li>`;
  }

  private sessionsHtml(): string {
    const all = listSessions();
    return `
      <section class="coach-sec">
        <div class="coach-actions">
          <button class="primary" data-act="save">Save this session</button>
          <button data-act="export">Export this session (JSON)</button>
          <button data-act="export-all">Export all (JSON)</button>
          <label class="btn">Import…<input type="file" id="coach-import" accept="application/json,.json" hidden /></label>
          <button data-act="new">New session</button>
        </div>
        <table class="coach-table"><tr><th>session</th><th>date</th><th>takes</th><th>mean |¢|</th><th></th></tr>
          ${all.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.created.slice(0, 10)}</td><td>${s.takes.length}</td><td>${fmt(meanAbsCents(s), 1)}</td>
            <td><button data-act="load-session" data-id="${esc(s.id)}">Open</button> <button data-act="del-session" data-id="${esc(s.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5">No saved sessions yet.</td></tr>'}
        </table>
        <p class="hint">Sessions keep the measured features, fit and advice — not the audio. Re-record the test set every few weeks and compare.</p>
      </section>`;
  }

  private afterRender(): void {
    if (this.tab === 'takes' && this.session.input === 'mic' && !this.segments.length) {
      const n = this.protocol()[this.cur];
      const host = this.root.querySelector('#coach-fing');
      if (n && host) host.appendChild(staticFingering(this.d.geo, fingeringFor(this.d.geo, n.note)));
      this.startMeter();
    } else cancelAnimationFrame(this.meterRaf);
    if (this.tab === 'analysis') {
      const takes = this.orderedTakes();
      const sim = this.session.fit?.simFeatures;
      const c1 = this.root.querySelector<HTMLCanvasElement>('#pl-cents'), c2 = this.root.querySelector<HTMLCanvasElement>('#pl-bright'), c3 = this.root.querySelector<HTMLCanvasElement>('#pl-harm');
      if (c1) centsChart(c1, takes, sim);
      if (c2) brightnessChart(c2, takes, sim);
      if (c3) harmonicChart(c3, takes.find((t) => t.id === this.harmonicSel) ?? takes[0], sim?.[this.harmonicSel]);
    }
  }

  private orderedTakes(): TakeResult[] {
    const order = PROTOCOL.map((n) => n.id);
    return [...this.session.takes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  // ---- events ------------------------------------------------------------------------------------
  private onClick(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tab],[data-act],[data-goto]');
    if (!el) return;
    if (el.dataset.tab) { this.tab = el.dataset.tab as Tab; this.render(); return; }
    if (el.dataset.goto) { this.cur = +el.dataset.goto; this.segments = []; this.render(); return; }
    const act = el.dataset.act;
    switch (act) {
      case 'close': this.close(); break;
      case 'mic': void this.startMic(); break;
      case 'demo': this.lastJob = this.demo(); break;
      case 'rec': void this.recordTake(); break;
      case 'next': this.cur = Math.min(this.protocol().length, this.cur + 1); this.render(); break;
      case 'clap': void this.recordClap(); break;
      case 'skip': this.cur = Math.min(this.protocol().length, this.cur + 1); this.render(); break;
      case 'to-analysis': this.tab = 'analysis'; this.render(); break;
      case 'to-fit': this.tab = 'fit'; this.render(); break;
      case 'analyze-segs': this.lastJob = this.analyzeSegments(); break;
      case 'fit': this.lastJob = this.fit(); break;
      case 'load-fitted': this.loadFitted(); break;
      case 'load-sug': this.loadSuggestion(+el.dataset.i!); break;
      case 'play': void this.playNote(); break;
      case 'restore': this.restore(); break;
      case 'save': saveSession(this.session); this.setStatus('Session saved in this browser.'); this.render(); break;
      case 'export': this.download(`sax-coach-${this.session.created.slice(0, 10)}.json`, JSON.stringify(this.session, null, 2)); break;
      case 'export-all': this.download('sax-coach-sessions.json', JSON.stringify(listSessions(), null, 2)); break;
      case 'new': this.session = newSession(this.session.refA); this.audio.clear(); this.segments = []; this.cur = 0; this.tab = 'setup'; this.render(); break;
      case 'load-session': { const s = listSessions().find((x) => x.id === el.dataset.id); if (s) { this.session = s; this.audio.clear(); this.tab = 'analysis'; this.render(); } break; }
      case 'del-session': deleteSession(el.dataset.id!); this.render(); break;
    }
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.id === 'coach-refa') { this.session.refA = Math.max(400, Math.min(480, +el.value || 440)); this.retarget(); }
    else if ((el as HTMLInputElement).dataset.opt) { const id = (el as HTMLInputElement).dataset.opt!; if ((el as HTMLInputElement).checked) this.includeOptional.add(id); else this.includeOptional.delete(id); }
    else if (el.id === 'coach-upload') { const files = (el as HTMLInputElement).files; if (files?.length) this.lastJob = this.upload([...files]); }
    else if (el.id === 'coach-import') void this.importSessions((el as HTMLInputElement).files?.[0]);
    else if ((el as HTMLSelectElement).dataset.seg) { this.segments[+(el as HTMLSelectElement).dataset.seg!].assigned = el.value; }
    else if (el.id === 'harm-sel') { this.harmonicSel = el.value; this.afterRender(); }
    else if (el.id === 'ab-note') this.abNote = el.value;
  }

  // ---- recording ---------------------------------------------------------------------------------
  private async startMic(): Promise<void> {
    try {
      await this.mic.open();
      this.session.input = 'mic';
      this.session.device = this.mic.deviceLabel;
      this.segments = [];
      this.tab = 'takes';
      this.setStatus(`Microphone: ${this.mic.deviceLabel || 'default'} @ ${this.mic.sampleRate} Hz`);
      this.render();
    } catch (err) {
      this.setStatus(`Microphone unavailable: ${(err as Error).message}`);
    }
  }

  private startMeter(): void {
    cancelAnimationFrame(this.meterRaf);
    const tick = (): void => {
      if (!this.isOpen || this.tab !== 'takes') return;
      const p = this.mic.meter();
      const fill = this.root.querySelector<HTMLElement>('#coach-meter');
      if (fill) {
        const dbv = 20 * Math.log10(Math.max(1e-5, p));
        fill.style.width = `${Math.max(0, Math.min(100, ((dbv + 60) / 60) * 100))}%`;
        fill.classList.toggle('hot', p > 0.7);
      }
      const clip = this.root.querySelector<HTMLElement>('#coach-clip');
      if (clip) clip.hidden = !this.mic.clipped;
      this.meterRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  private async recordTake(): Promise<void> {
    const n = this.protocol()[this.cur];
    if (!n || this.recState !== 'idle') return;
    const timer = (s: string): void => { const t = this.root.querySelector('#coach-timer'); if (t) t.textContent = s; };
    this.recState = 'countdown';
    for (const c of ['3', '2', '1']) { timer(`get ready… ${c}`); await new Promise((r) => setTimeout(r, 500)); }
    this.recState = 'recording';
    this.mic.start();
    const t0 = performance.now();
    await new Promise<void>((r) => {
      const iv = setInterval(() => {
        const el = (performance.now() - t0) / 1000;
        timer(`● recording ${n.id} — ${Math.max(0, 3.4 - el).toFixed(1)} s`);
        if (el >= 3.4) { clearInterval(iv); r(); }
      }, 100);
    });
    const audio = await this.mic.stop();
    this.recState = 'analysing';
    timer('analysing…');
    await this.addTake(n, audio, { clipped: this.mic.clipped, peak: this.mic.peak });
    await this.micRoom();
    await this.updateDiagnosis();
    this.recState = 'idle';
    timer('');
    const t = this.session.takes.find((x) => x.id === n.id);
    if (t && t.features[F.valid] > 0) this.cur = Math.min(this.protocol().length, this.cur + 1);
    this.render();
  }

  private async addTake(n: ProtocolNote, audio: Float32Array, extra: Partial<TakeResult> = {}): Promise<TakeResult> {
    const target = targetHz(n.note, this.session.refA);
    const { features, source } = await this.engine().analyze(audio, COACH_SR, target);
    const take: TakeResult = { id: n.id, note: n.note, dynamic: n.dynamic, target, features: Array.from(features), source, seconds: audio.length / COACH_SR, ...extra };
    this.session.takes = [...this.session.takes.filter((x) => x.id !== n.id), take];
    this.audio.set(n.id, audio);
    this.session.fit = undefined;
    this.session.suggestions = undefined;
    return take;
  }

  /** reference pitch changed: re-analyse kept audio (or shift cents of stored features) */
  private retarget(): void {
    for (const t of this.session.takes) {
      const nt = targetHz(t.note, this.session.refA);
      if (t.features[F.valid] > 0 && t.target > 0) t.features[F.cents] -= 1200 * Math.log2(nt / t.target);
      t.target = nt;
    }
    this.render();
  }

  // ---- upload ------------------------------------------------------------------------------------
  async upload(files: File[]): Promise<void> {
    this.setStatus(`Decoding ${files.length} file(s)…`);
    this.session.input = 'upload';
    this.segments = [];
    try {
      if (files.length === 1) {
        const audio = await decodeFile(files[0]);
        await this.measureRoom(audio);
        const { segments, source } = await this.engine().segment(audio, COACH_SR);
        // assign by pitch: align the detected notes with the protocol order (skips allowed both ways)
        const proto = this.protocol();
        const f0s: number[] = [];
        for (const [a, b] of segments) {
          const fv = b - a >= 0.4 * COACH_SR ? (await this.engine().analyze(audio.subarray(a, b), COACH_SR, 0)).features : null;
          f0s.push(fv && fv[F.valid] > 0 ? fv[F.f0] : 0);
        }
        const assign = alignToProtocol(f0s, proto.map((n) => targetHz(n.note, this.session.refA)));
        this.segments = segments.map(([a, b], i) => ({ start: a, end: b, assigned: assign[i] >= 0 ? proto[assign[i]].id : '', f0: f0s[i], source: source === 'wasm' ? 'engine sax_segment' : 'energy-based (JS)', audio: audio.subarray(a, b) }));
        this.setStatus(`${segments.length} notes detected in ${files[0].name} (${(audio.length / COACH_SR).toFixed(1)} s). Check the assignment and press Analyse.`);
      } else {
        const proto = this.protocol();
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (let i = 0; i < sorted.length; i++) {
          const audio = await decodeFile(sorted[i]);
          if (i === 0) await this.measureRoom(audio);
          const guess = guessNote(sorted[i].name) ?? proto[i]?.id ?? '';
          this.segments.push({ start: 0, end: audio.length, assigned: guess, source: 'one file per note', audio });
        }
        this.setStatus(`${files.length} files loaded — check the note of each and press Analyse.`);
      }
    } catch (err) {
      this.setStatus(`Could not read the audio: ${(err as Error).message}`);
    }
    this.tab = 'takes';
    this.render();
  }

  async analyzeSegments(): Promise<void> {
    const jobs = this.segments.filter((s) => s.assigned);
    for (let i = 0; i < jobs.length; i++) {
      const s = jobs[i];
      const n = PROTOCOL.find((p) => p.id === s.assigned);
      if (!n) continue;
      this.setStatus(`Analysing ${n.id} (${i + 1}/${jobs.length})…`);
      await this.addTake(n, s.audio);
    }
    this.segments = [];
    await this.updateDiagnosis();
    this.setStatus(`${jobs.length} notes analysed.`);
    this.tab = 'analysis';
    this.render();
  }

  // ---- demo: a simulated player renders the test set (through the same pipeline) -------------
  private async demo(): Promise<void> {
    this.session = newSession(this.session.refA, 'synthetic');
    this.session.label = 'Simulated player (mouthpiece pulled out ~7 mm)';
    const planted: Record<string, number> = { mouthpiece_insertion: 3, lip_force: 1.1 };
    const proto = this.protocol().filter((n) => n.id !== 'G6');
    for (let i = 0; i < proto.length; i++) {
      const n = proto[i];
      this.setStatus(`Simulated player: rendering ${n.id} (${i + 1}/${proto.length})…`);
      const p = paramsForTake(planted, n.note, n.dynamic);
      for (const [k, v] of Object.entries(n.controlOffsets ?? {})) p[k] = (p[k] ?? PARAMS.find((d) => d.name === k)!.default) + v;
      const r = await this.engine().render({ note: n.note, params: Object.entries(p).map(([k, v]) => [PARAMS.find((d) => d.name === k)!.id, v]), oversample: 2, seconds: 2.5, seed: 7 + i, wantAudio: true });
      if (r.audio) await this.addTake(n, r.audio);
    }
    await this.updateDiagnosis();
    this.setStatus('Simulated player recorded — see the analysis, then fit.');
    this.tab = 'analysis';
    this.render();
  }

  // ---- fit & advice ------------------------------------------------------------------------------
  async fit(): Promise<void> {
    if (this.fitBusy) return;
    this.fitBusy = true;
    this.fitProgress = [0, 'starting…'];
    this.render();
    try {
      const fit = await runFit({
        notes: takesToFitNotes(this.session.takes.filter((t) => t.features[F.valid] > 0)),
        refA: this.session.refA,
        wasmUrl: new URL(this.d.wasmUrl, location.href).href,
        geometry: this.d.geometryJson,
        roomVerdict: this.session.room?.source === 'wasm' ? this.session.room.verdict : undefined,
        onProgress: (f, m) => {
          this.fitProgress = [f, m];
          const bar = this.root.querySelector<HTMLElement>('.progress-fill');
          const txt = this.root.querySelector<HTMLElement>('.progress span');
          if (bar) bar.style.width = `${(f * 100).toFixed(0)}%`;
          if (txt) txt.textContent = m;
        },
      }, this.engine());
      this.session.fit = fit;
      await this.updateDiagnosis();
      if (fit.status === 'failed') this.setStatus(`Fit failed: ${(fit.problems ?? []).join('; ') || 'the simulator could not reproduce the recording'} — the template ranking below does not depend on the fit.`);
      else this.setStatus(`Fit done in ${(fit.ms / 1000).toFixed(1)} s · ${(this.session.suggestions ?? []).length} suggestions.`);
    } catch (err) {
      this.setStatus(`Fit failed: ${(err as Error).message}`);
    }
    this.fitBusy = false;
    this.fitProgress = [1, 'done'];
    this.render();
  }

  /** template ranking + observation triggers (instant) and, after a successful fit, its refinement */
  async updateDiagnosis(): Promise<void> {
    if (!this.session.takes.length) return;
    const fit = this.session.fit?.status === 'failed' ? undefined : this.session.fit;
    const d = await diagnose(this.session.takes, fit, this.session.room?.source === 'wasm' ? this.session.room.verdict : undefined);
    this.session.suggestions = d.suggestions;
    this.session.rulesSource = d.source;
    this.session.roomNote = d.roomNote;
    this.session.hiddenRules = d.hidden;
  }

  private take(id: string): TakeResult | undefined {
    return this.session.takes.find((t) => t.id === id);
  }

  private remember(): void {
    this.savedParams ??= Float32Array.from(this.d.state.values);
  }

  /** fitted engine params of a take: the fitter's per-note params (incl. dynamic, player_assist), else from the controls */
  private fittedParams(t: TakeResult): Record<string, number> {
    const fit = this.session.fit!;
    const pn = fit.perNoteParams?.[t.id];
    if (pn?.length) {
      const out: Record<string, number> = {};
      for (const [id, v] of pn) if (PARAMS[id]) out[PARAMS[id].name] = v;
      return out;
    }
    return paramsForTake(fit.controls, t.note, t.dynamic);
  }

  /** A: the fitted player for the selected note */
  loadFitted(): Record<string, number> {
    const t = this.take(this.abNote);
    if (!this.session.fit || !t) return {};
    this.remember();
    const p = this.fittedParams(t);
    this.applyParams(p);
    this.setStatus(`A · fitted player loaded for ${t.id}.`);
    this.render();
    return p;
  }

  /** B: fitted player + the suggestion's change (all alternatives' changes are listed; the first is applied) */
  loadSuggestion(i: number): Record<string, number> {
    const s = this.session.suggestions?.[i];
    const t = this.take(this.abNote);
    const p = this.session.fit && t ? this.fittedParams(t) : {};
    if (!s?.change) return p;
    this.remember();
    for (const c of s.change) {
      const d = PARAMS.find((q) => q.name === c.param);
      if (!d) continue;
      const base = p[c.param] ?? this.d.state.get(d.id);
      p[c.param] = c.value !== undefined ? c.value : base + (c.delta ?? 0);
    }
    this.applyParams(p);
    this.setStatus(`B · suggested change loaded (${s.change.map((c) => c.param).join(', ')}).`);
    this.render();
    return p;
  }

  private applyParams(p: Record<string, number>): void {
    for (const [k, v] of Object.entries(p)) {
      const d = PARAMS.find((q) => q.name === k);
      if (!d) continue;
      if (k === 'lung_pressure') this.d.kb.opts.blowPressure = v;
      else if (k !== 'master_gain' && k !== 'oversample') this.d.state.set(d.id, v, 'coach');
    }
  }

  private restore(): void {
    if (!this.savedParams) return;
    this.savedParams.forEach((v, i) => { if (i !== 0) this.d.state.set(i, v, 'coach'); });
    this.savedParams = null;
    this.setStatus('Your previous simulator settings are back.');
    this.render();
  }

  private async playNote(): Promise<void> {
    const t = this.take(this.abNote);
    if (!t || !(await this.d.ensureAudio())) { this.setStatus('Start the audio engine first.'); return; }
    const midi = noteNameToMidi(t.note);
    if (midi === null) return;
    this.d.kb.noteOn(midi, 100);
    await new Promise((r) => setTimeout(r, 2200));
    this.d.kb.noteOff(midi);
  }

  // ---- sessions ----------------------------------------------------------------------------------
  private async importSessions(file?: File): Promise<void> {
    if (!file) return;
    try {
      const list = parseSessionFile(await file.text());
      list.forEach(saveSession);
      if (list[0]) { this.session = list[list.length - 1]; this.audio.clear(); }
      this.setStatus(`Imported ${list.length} session(s).`);
    } catch (err) {
      this.setStatus(`Import failed: ${(err as Error).message}`);
    }
    this.render();
  }

  private download(name: string, text: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
}

/** "03_G4_pp.wav" → "G4 pp" if it names a protocol note */
function guessNote(name: string): string | null {
  const m = /([A-G](?:#|b|s)?\d)(?:[ _-]?(pp|ff|mf))?/i.exec(name.replace(/sharp/i, '#'));
  if (!m) return null;
  let n = m[1][0].toUpperCase() + m[1].slice(1).replace(/s(?=\d)/, '#');
  n = n.replace(/^([A-G])B/, '$1b');
  const id = m[2] && m[2].toLowerCase() !== 'mf' ? `${n} ${m[2].toLowerCase()}` : n;
  return PROTOCOL.some((p) => p.id === id) ? id : null;
}

/**
 * Monotone alignment of detected notes (f0 Hz, 0 = unpitched) to the protocol order (target Hz):
 * minimises the pitch distance (octave errors cost 250 ¢, a skipped protocol note 300, an
 * unassigned segment 400). Returns the protocol index per segment, −1 = unassigned.
 */
export function alignToProtocol(f0: number[], targets: number[]): number[] {
  const n = f0.length, m = targets.length;
  const cost = (i: number, j: number): number => {
    if (!(f0[i] > 0)) return 600;
    const c = Math.abs(1200 * Math.log2(f0[i] / targets[j]));
    const oct = Math.abs(c - 1200);
    return Math.min(c, oct + 250, 900);
  };
  const SKIP_P = 300, SKIP_S = 400;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const B = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  D[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (i && j && D[i - 1][j - 1] + cost(i - 1, j - 1) < D[i][j]) { D[i][j] = D[i - 1][j - 1] + cost(i - 1, j - 1); B[i][j] = 1; }
    if (j && D[i][j - 1] + SKIP_P < D[i][j]) { D[i][j] = D[i][j - 1] + SKIP_P; B[i][j] = 2; }
    if (i && D[i - 1][j] + SKIP_S < D[i][j]) { D[i][j] = D[i - 1][j] + SKIP_S; B[i][j] = 3; }
  }
  const out = new Array<number>(n).fill(-1);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const b = B[i][j];
    if (b === 1) { out[i - 1] = j - 1; i--; j--; } else if (b === 2) j--; else i--;
  }
  return out;
}
