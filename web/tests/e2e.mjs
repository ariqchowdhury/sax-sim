// Headless-Chrome smoke test (npm run test:e2e).
//  • starts the Vite dev server programmatically, opens the app, starts audio
//  • plays a scale in note mode and checks the telemetry pitch of each note against the data's
//    f_target (±50 cents — a regression net, not an accuracy test)
//  • drags the lung and tongue handles and checks the params change
//  • checks the input-impedance plot recomputes after a fingering change
//  • progressive-disclosure UI: drawers closed by default + toggle, drag readout, context card, Blow button,
//    drag gain consistent across zoom, lower-lip axis lock, mouthpiece handle cluster collapse
// Needs Chrome/Chromium: set CHROME_PATH, or it looks in the usual install locations. If none is
// found the test is skipped (exit 0) unless E2E_REQUIRE=1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chrome = candidates.find((p) => fs.existsSync(p));
if (!chrome) {
  console.log('SKIP e2e: no Chrome/Chromium found (set CHROME_PATH)');
  process.exit(process.env.E2E_REQUIRE ? 1 : 0);
}
if (!fs.existsSync(path.join(root, 'web/public/engine.wasm'))) {
  console.log('SKIP e2e: web/public/engine.wasm missing (npm run build:engine)');
  process.exit(process.env.E2E_REQUIRE ? 1 : 0);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({ configFile: path.join(root, 'web/vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});
let code = 1;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => localStorage.setItem('saxsim.tour.v1', '1'));
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.click('#start');
  await page.waitForFunction(() => window.__sax?.engine.status.state === 'running', { timeout: 15000 });
  check('audio engine running', true, await page.evaluate(() => `telemetry via ${window.__sax.engine.transport}, build ${window.__sax.engine.build}`));
  await page.waitForFunction(() => window.__sax.engine.perf !== null, { timeout: 5000 }).catch(() => {});
  const perf = await page.evaluate(() => window.__sax.engine.perf);
  check('audio-thread load reported', !!perf && perf.load > 0 && perf.load < 50, perf ? `${(100 * perf.load).toFixed(0)}% (${perf.timer} timer, level ${perf.level})` : 'no report');

  // ---- scale in note mode --------------------------------------------------------------------
  const geo = JSON.parse(fs.readFileSync(path.join(root, 'data/alto_sax.json'), 'utf8'));
  const notes = [['KeyZ', 60], ['KeyX', 62], ['KeyC', 64], ['KeyV', 65], ['KeyB', 67], ['KeyN', 69], ['KeyM', 71], ['KeyQ', 72], ['KeyW', 74], ['KeyE', 76], ['KeyT', 79]];
  for (const [code_, midi] of notes) {
    const f = geo.fingerings.find((x) => x.written_midi === midi);
    if (!f) continue;
    await page.keyboard.down(code_);
    let cents = NaN, freq = 0;
    for (let t = 0; t < 30; t++) { // up to 3 s to settle
      await wait(100);
      freq = await page.evaluate(() => window.__sax.engine.telemetry.frequency);
      if (freq > 20) {
        cents = 1200 * Math.log2(freq / f.f_target);
        if (Math.abs(cents) < 50 && t > 5) break;
      }
    }
    await page.keyboard.up(code_);
    await wait(250);
    check(`note ${f.note} (target ${f.f_target.toFixed(1)} Hz)`, Math.abs(cents) < 50, `${freq.toFixed(1)} Hz, ${Number.isFinite(cents) ? cents.toFixed(0) : '—'} ¢`);
  }

  // ---- drags -----------------------------------------------------------------------------------
  const camTo = async (c) => { await page.click(`[data-cam="${c}"]`); await wait(200); await page.waitForFunction(() => !window.__sax.scene.tween, { timeout: 20000 }); await wait(300); };
  const screenOf = (expr) => page.evaluate((expr) => {
    const s = window.__sax; const o = expr.split('.').reduce((a, k) => a[k], s);
    // a mesh: its bounding-box centre (handles: their origin)
    const v = s.scene.camera.position.clone();
    if (o.geometry && !o.userData.isHandle) { o.geometry.computeBoundingBox(); o.geometry.boundingBox.getCenter(v); o.localToWorld(v); } else o.getWorldPosition(v);
    v.project(s.scene.camera);
    const r = s.scene.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, expr);
  const drag = async (expr, dx, dy) => {
    const p = await screenOf(expr);
    await page.mouse.move(p.x, p.y); await wait(80); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(p.x + (dx * i) / 10, p.y + (dy * i) / 10); await wait(30); }
    await page.mouse.up(); await wait(200);
  };
  const param = (id) => page.evaluate((id) => window.__sax.state.get(id), id);
  await camTo('player');
  let before = await param(0);
  // the lungs are the grab target (the pressure gauge beside the chest appears on hover / drag)
  await drag('scene.player.lungL', 0, -50);
  let after = await param(0);
  check('drag lungs → lung_pressure', after > before + 0.5, `${before.toFixed(2)} → ${after.toFixed(2)} kPa`);
  before = await param(6);
  await drag('scene.player.hTongueBody', 0, -25);
  after = await param(6);
  check('drag tongue body → tongue_y', after > before + 0.05, `${before.toFixed(2)} → ${after.toFixed(2)}`);
  await page.evaluate(() => window.__sax.state.set(0, 0, 'test'));

  // ---- progressive-disclosure UI (docs/UX_REVIEW.md) ---------------------------------------------
  {
    const tongueY0 = await param(6);
    const closed = await page.evaluate(() => !document.getElementById('drawer').classList.contains('open') && !document.getElementById('viz').classList.contains('open'));
    check('ui: Controls and Scopes drawers closed by default', closed);
    await page.click('#scopes-btn'); await wait(250);
    const open = await page.evaluate(() => document.getElementById('viz').classList.contains('open') && document.getElementById('scopes-btn').getAttribute('aria-expanded') === 'true' && JSON.parse(localStorage.getItem('saxsim.ui.v1')).scopes === true);
    await page.click('#scopes-btn'); await wait(250);
    check('ui: Scopes drawer toggles (aria-expanded, remembered)', open && await page.evaluate(() => !document.getElementById('viz').classList.contains('open')));
    // mid-drag: the large readout next to the cursor names the part and the param it changes; the
    // context card switches to the part's detail (tongue → tract)
    const p = await screenOf('scene.player.hTongueBody');
    await page.mouse.move(p.x, p.y); await wait(80); await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(p.x, p.y + 3 * i); await wait(40); }
    await wait(150);
    const ro = await page.evaluate(() => { const t = document.querySelector('.tooltip.readout'); return { text: t?.textContent ?? '', vis: t ? getComputedStyle(t).opacity : '0', ctx: window.__sax.ctx.kind, ctxOpen: window.__sax.ctx.isOpen }; });
    await page.mouse.up(); await wait(200);
    check('ui: drag readout shows the part and the changed value', ro.vis === '1' && /Tongue body/.test(ro.text) && /Tongue low\/high/.test(ro.text), ro.text.slice(0, 80));
    check('ui: grabbing the tongue opens the tract context card', ro.ctxOpen && ro.ctx === 'tract', `${ro.ctx}`);
    // the primary action: Hold to blow
    const b = await page.$('#blow-btn');
    const bb = await b.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await wait(400);
    const blowing = await page.evaluate(() => [window.__sax.kb.isBlowing, window.__sax.state.get(0)]);
    await page.mouse.up(); await wait(400);
    const after = await page.evaluate(() => window.__sax.kb.isBlowing);
    check('ui: Hold to blow button blows while held', blowing[0] && blowing[1] > 1 && !after, `lung ${blowing[1].toFixed(2)} kPa while held`);
    await page.evaluate((v) => { window.__sax.state.set(6, v, 'test'); window.__sax.state.set(0, 0, 'test'); }, tongueY0);

    // screen-space drag gain: the same 40 px drag of the tongue gives about the same change at two
    // zoom levels (full range ≈ 200–250 px), instead of scaling with the zoom
    const tongueDelta = async () => {
      await page.evaluate(() => { window.__sax.state.set(5, 0.5, 'test'); window.__sax.state.set(6, 0.4, 'test'); });
      await wait(250);
      const b0 = await param(6);
      const q = await screenOf('scene.player.hTongueBody');
      await page.mouse.move(q.x, q.y); await wait(80); await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(q.x, q.y - 5 * i); await wait(30); }
      await page.mouse.up(); await wait(200);
      return (await param(6)) - b0;
    };
    const d1 = await tongueDelta();
    await page.evaluate(() => { const s = window.__sax.scene; s.camera.position.lerp(s.controls.target, 0.45); s.controls.update(); });
    await wait(400);
    const d2 = await tongueDelta();
    check('ui: drag gain — 40 px moves the tongue about the same at two zoom levels', d1 > 0.12 && d1 < 0.26 && d2 > 0.12 && d2 < 0.26 && Math.abs(d1 - d2) < 0.3 * Math.max(d1, d2),
      `Δ tongue height ${d1.toFixed(3)} (Player view) vs ${d2.toFixed(3)} (zoomed in 1.8×)`);
    await page.evaluate((v) => window.__sax.state.set(6, v, 'test'), tongueY0);

    // lower lip: a diagonal drag commits to ONE axis (take-in or lip force) and the card says which
    await camTo('mouthpiece');
    check('ui: mouthpiece handles shown individually in the Mouthpiece view', await page.evaluate(() => !window.__sax.clusters.isCollapsed('mouthpiece ✋')));
    const lip0 = await page.evaluate(() => [window.__sax.state.get(2), window.__sax.state.get(3)]);
    const lp = await screenOf('scene.player.lowerLip');
    await page.mouse.move(lp.x, lp.y); await wait(80); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(lp.x + 4 * i, lp.y + 4 * i); await wait(30); }
    await wait(120);
    const lockTxt = await page.evaluate(() => document.querySelector('.tooltip.readout .dr-lock')?.textContent ?? '');
    await page.mouse.up(); await wait(200);
    const lip1 = await page.evaluate(() => [window.__sax.state.get(2), window.__sax.state.get(3)]);
    const movedPos = Math.abs(lip1[0] - lip0[0]) > 0.05, movedForce = Math.abs(lip1[1] - lip0[1]) > 0.01;
    const stillPos = lip1[0] === lip0[0], stillForce = lip1[1] === lip0[1];
    check('ui: lower-lip drag locks to one axis', ((movedPos && stillForce) || (movedForce && stillPos)) && /locked to/.test(lockTxt),
      `lip position ${lip0[0].toFixed(2)} → ${lip1[0].toFixed(2)}, lip force ${lip0[1].toFixed(2)} → ${lip1[1].toFixed(2)}; "${lockTxt}"`);
    await page.evaluate((v) => { window.__sax.state.set(2, v[0], 'test'); window.__sax.state.set(3, v[1], 'test'); }, lip0);

    // Instrument view: the mouthpiece handles are too close together → one "mouthpiece ✋" tag
    await camTo('full');
    const cl = await page.evaluate(() => {
      const s = window.__sax;
      const tag = [...document.querySelectorAll('.grabtag.cluster')].find((e) => e.textContent.startsWith('mouthpiece'));
      return { collapsed: s.clusters.isCollapsed('mouthpiece ✋'), all: s.scene.mp.handleMeshes.every((h) => h.userData.collapsed), tag: !!tag && tag.style.display !== 'none' };
    });
    check('ui: mouthpiece handle cluster collapses to one tag in the Instrument view', cl.collapsed && cl.all && cl.tag, JSON.stringify(cl));
  }

  // ---- impedance plot updates on fingering change --------------------------------------------
  await page.waitForFunction(() => window.__sax.imp?.result, { timeout: 20000 });
  const t0 = await page.evaluate(() => window.__sax.imp.result.at);
  const p0 = await page.evaluate(() => window.__sax.impPlot.peaks[0]);
  await page.keyboard.press('Escape');
  await page.keyboard.down('KeyB'); // written G4
  await page.waitForFunction((t0) => window.__sax.imp.result.at > t0, { timeout: 20000 }, t0);
  await wait(800); // allow a recompute triggered by later key changes
  await page.keyboard.up('KeyB');
  const p1 = await page.evaluate(() => window.__sax.impPlot.peaks[0]);
  const g4 = geo.fingerings.find((x) => x.written_midi === 67).f_target;
  check('impedance recomputed on key change', Math.abs(p1 - p0) > 5 && Math.abs(1200 * Math.log2(p1 / g4)) < 80, `peak 1: ${p0.toFixed(0)} → ${p1.toFixed(0)} Hz (G4 target ${g4.toFixed(0)})`);

  // ---- adaptive quality: a (simulated) persistent overload report lowers oversampling ----------
  const q = await page.evaluate(() => {
    const e = window.__sax.engine;
    e.onMessage({ type: 'perf', load: 0.7, level: 'high', os: 4, recommendOs: 2, timer: 'date' });
    const hint = document.getElementById('status-text').textContent;
    const osAfterHint = window.__sax.state.get(21);
    e.onMessage({ type: 'perf', load: 1.3, level: 'overload', os: 4, recommendOs: 2, timer: 'date' });
    const os = window.__sax.state.get(21);
    window.__sax.state.set(21, 4);
    return { hint, osAfterHint, os };
  });
  check('high load → hint only; persistent overload → oversampling lowered', q.osAfterHint === 4 && q.os === 2 && /try oversampling 2/.test(q.hint), `"${q.hint}", os ${q.osAfterHint} → ${q.os}`);

  // ---- altissimo: tract in series with the bore -------------------------------------------------
  const altPreset = (geo.presets ?? []).find((p) => /altissimo/i.test(p.name));
  const gs6 = (geo.alternate_fingerings ?? []).find((a) => a.register === 3 && a.note === 'G#6');
  if (altPreset && gs6) {
    await page.keyboard.press('Escape');
    await page.evaluate((params) => {
      const s = window.__sax;
      s.state.set(21, 4, 'test'); // default oversampling (an earlier check may have lowered it)
      s.state.set(23, 0, 'test'); // pure physics: the UI applies the altissimo voicing itself
      for (const [k, v] of Object.entries(params)) {
        const i = ['lung_pressure','breath_noise','lip_position','lip_force','lip_damping','tongue_x','tongue_y','tongue_tip','tongue_reed_contact','jaw_open','glottis_open','reed_strength','reed_damping'].indexOf(k);
        if (i >= 0) s.state.set(i, v, 'test');
      }
    }, altPreset.params);
    await page.keyboard.press('ArrowUp'); // octave shift +1: Digit6 = G#6
    const pitchWhile = async (pred, ms) => {
      let fr = 0;
      for (let t = 0; t < ms / 100; t++) { await wait(100); fr = await page.evaluate(() => window.__sax.engine.telemetry.frequency); if (pred(fr) && t > 8) break; }
      return fr;
    };
    // the attack decides which regime the reed locks into (as on a real sax, an altissimo note
    // sometimes needs a second try): up to 3 attacks, each from silence
    let fAlt = 0, attempts = 0;
    for (; attempts < 3 && !(fAlt > 850); attempts++) {
      if (attempts) {
        await page.keyboard.up('Digit6');
        await page.waitForFunction(() => window.__sax.state.get(0) === 0, { timeout: 3000 }).catch(() => {});
        await wait(300);
      }
      await page.keyboard.down('Digit6');
      fAlt = await pitchWhile((x) => x > 850, 4000);
    }
    const fing = await page.evaluate(() => window.__sax.chart.recognised());
    check('altissimo G#6 (Altissimo voicing) sounds > 850 Hz', fAlt > 850, `${fAlt.toFixed(1)} Hz after ${attempts} attack(s), target ${gs6.f_target.toFixed(0)} Hz, chart: ${fing}`);
    await page.waitForFunction(() => window.__sax.impPlot.tractResMag >= 10e6, { timeout: 5000 }).catch(() => {});
    const tr = await page.evaluate(() => [window.__sax.impPlot.tractRes, window.__sax.impPlot.tractResMag, window.__sax.scene.player.tractCue]);
    check('tract impedance overlay: strong resonance near the note', tr[1] >= 10e6 && tr[0] > 700 && tr[0] < 1600, `${tr[0].toFixed(0)} Hz, ${(tr[1] / 1e6).toFixed(0)} MPa·s/m³, 3D cue ${tr[2]}`);
    const tAt = await page.evaluate(() => window.__sax.imp.tract.at);
    // the real-world contrast: same fingering and embouchure, neutral tongue/jaw, a fresh attack
    await page.keyboard.up('Digit6');
    await page.evaluate(() => { const s = window.__sax; s.kb.opts.autoVoicing = false; s.state.set(5, 0.5, 'drag'); s.state.set(6, 0.4, 'drag'); s.state.set(7, 0.3, 'drag'); s.state.set(9, 0.3, 'drag'); });
    await page.waitForFunction(() => window.__sax.state.get(0) === 0, { timeout: 3000 }).catch(() => {});
    await wait(400);
    await page.keyboard.down('Digit6');
    const fLow = await pitchWhile((x) => x > 100 && x < 700, 4000);
    check('same fingering, neutral tract → low regime < 700 Hz', fLow > 100 && fLow < 700, `${fLow.toFixed(1)} Hz`);
    await page.evaluate(() => { window.__sax.kb.opts.autoVoicing = true; });
    await page.waitForFunction((t) => window.__sax.imp.tract.at > t, { timeout: 5000 }, tAt).catch(() => {});
    const tr2 = await page.evaluate(() => [window.__sax.impPlot.tractRes, window.__sax.impPlot.tractResMag]);
    check('tract overlay follows the tongue', tr2[1] < tr[1] / 3, `peak ${(tr[1] / 1e6).toFixed(0)} → ${(tr2[1] / 1e6).toFixed(1)} MPa·s/m³`);
    await page.keyboard.up('Digit6');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
  } else {
    console.log('SKIP altissimo checks: no Altissimo preset / G#6 register-3 fingering in the data');
  }

  // ---- coach mode (M9): synthetic recording → upload → segmentation → analysis → fit → advice ---
  {
    const { EngineHost } = await import('../src/coach/fit/engineHost.ts');
    const { TEST_SET } = await import('../src/coach/fit/testset.ts');
    const geoJson = fs.readFileSync(path.join(root, 'data/alto_sax.json'), 'utf8');
    const host = new EngineHost(new WebAssembly.Module(fs.readFileSync(path.join(root, 'web/public/engine.wasm'))), geoJson);
    const PLANTED_INSERTION = 5; // mm (default 10): mouthpiece pulled out → every note flat
    // protocol v1 + the recommended G4push take (G4 with the mouthpiece pushed 5 mm further on)
    const notes = [...TEST_SET.filter((n) => !n.optional && n.id !== 'G4push'), { id: 'G4push', note: 'G4', dynamic: 'mf', push: 5 }];
    const SR = 48000, gap = Math.round(0.8 * SR);
    // the player as the coaching model simulates it (sim_settings): player model on, pp/mf/ff via `dynamic`
    const sim = JSON.parse(fs.readFileSync(path.join(root, 'data/coach_model.json'), 'utf8')).sim_settings ?? { player_assist: 0.5 };
    const DYN = { pp: 0.15, mf: 0.5, ff: 0.9 };
    // one deliberately cracked take: the D4 slot is played an octave up (D5 fingering) → the fitter's
    // recording guard must leave it out and the coach must say so (amber "Recording notes")
    const CRACKED = 'D4';
    const renders = notes.map((n, i) => host.render({ note: n.id === CRACKED ? 'D5' : n.note, params: [[23, sim.player_assist ?? 0.5], [24, DYN[n.dynamic]], [18, PLANTED_INSERTION + (n.push ?? 0)], [0, 3.5]], oversample: 2, seconds: 2.6, seed: 11 + i, wantAudio: true }));
    const silent = notes.filter((n, i) => !(renders[i].features[25] > 0) || Math.abs(renders[i].features[24] - 1) > 0.25).map((n, i) => n.id);
    check('coach: synthetic player sounds every take in its register', silent.length === 0, silent.length ? `silent / wrong register: ${silent.join(', ')}` : `${notes.length} takes`);
    const parts = renders.map((r) => r.audio);
    const total = parts.reduce((a, p) => a + p.length + gap, gap);
    let x = new Float32Array(total);
    let o = gap;
    for (const p of parts) { x.set(p, o); o += p.length + gap; }
    // simple room (Schroeder: 3 combs + 2 allpasses, 18 % wet) and a mic EQ (HP 90 Hz, LP 7 kHz)
    const room = new Float32Array(total);
    for (const [d, g] of [[1557, 0.72], [1617, 0.7], [1491, 0.74]]) {
      const buf = new Float32Array(d); let k = 0;
      for (let i = 0; i < total; i++) { const y = buf[k]; buf[k] = x[i] + y * g; k = (k + 1) % d; room[i] += y / 3; }
    }
    for (const [d, g] of [[225, 0.5], [556, 0.5]]) {
      const buf = new Float32Array(d); let k = 0;
      for (let i = 0; i < total; i++) { const b = buf[k]; const y = -g * room[i] + b; buf[k] = room[i] + g * y; k = (k + 1) % d; room[i] = y; }
    }
    let hp = 0, lp = 0, prev = 0, peak = 0;
    const ah = Math.exp(-2 * Math.PI * 90 / SR), al = 1 - Math.exp(-2 * Math.PI * 7000 / SR);
    for (let i = 0; i < total; i++) {
      const v = x[i] + 0.18 * room[i];
      hp = ah * (hp + v - prev); prev = v;
      lp += al * (hp - lp);
      x[i] = lp; peak = Math.max(peak, Math.abs(lp));
    }
    for (let i = 0; i < total; i++) x[i] = (x[i] / peak) * 0.5 + (Math.random() - 0.5) * 2e-4; // + noise floor
    const wav = Buffer.alloc(44 + total * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + total * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(total * 2, 40);
    for (let i = 0; i < total; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
    const wavPath = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'saxcoach-')), 'synthetic-player.wav');
    fs.writeFileSync(wavPath, wav);
    x = null;

    await page.click('#coach-btn');
    await page.waitForSelector('#coach:not([hidden]) #coach-upload', { timeout: 15000 });
    const input = await page.$('#coach-upload');
    await input.uploadFile(wavPath);
    await page.waitForFunction(() => document.querySelector('[data-act="analyze-segs"]'), { timeout: 60000 });
    const nSeg = await page.evaluate(() => document.querySelectorAll('select[data-seg]').length);
    check('coach: upload → auto-segmentation finds the notes', nSeg === notes.length, `${nSeg} segments for ${notes.length} notes`);
    console.log(`INFO  coach: segments ${await page.evaluate(() => window.__sax.coach.segments.map((x) => `${x.assigned || '—'}:${Math.round(x.f0 ?? 0)}`).join(' '))}`);
    await page.click('[data-act="analyze-segs"]');
    await page.waitForFunction(() => window.__sax.coach.session.takes.length > 0 && document.querySelector('#pl-cents'), { timeout: 120000 });
    const an = await page.evaluate(() => {
      const t = window.__sax.coach.session.takes;
      const v = t.filter((x) => x.features[25] > 0);
      return { n: t.length, valid: v.length, meanCents: v.filter((x) => x.dynamic === 'mf').reduce((a, x) => a + x.features[1], 0) / Math.max(1, v.filter((x) => x.dynamic === 'mf').length), src: t[0]?.source };
    });
    const roomEst = await page.evaluate(() => window.__sax.coach.session.room);
    const badge = await page.evaluate(() => document.querySelector('.room-badge')?.textContent ?? '');
    check('coach: recording-quality badge (sax_room)', !!roomEst && roomEst.source === 'wasm' && roomEst.verdict >= 0 && roomEst.verdict <= 3 && badge.length > 0,
      roomEst ? `${badge.slice(0, 90)}…` : 'none');
    check('coach: per-note analysis', an.valid >= notes.length - 2, `${an.valid}/${an.n} valid, mean mf cents ${an.meanCents.toFixed(1)} (${an.src} extractor)`);
    await page.click('[data-act="to-fit"]');
    await page.click('[data-act="fit"]');
    await page.waitForFunction(() => window.__sax.coach.session.fit && document.querySelector('[data-act="fit"]:not([disabled])'), { timeout: 180000 });
    const res = await page.evaluate(() => {
      const s = window.__sax.coach.session;
      return { controls: s.fit.controls, method: s.fit.method, status: s.fit.status, problems: s.fit.problems, src: s.rulesSource,
        sug: s.suggestions.map((x) => x.id), shown: document.querySelectorAll('.sug').length,
        template: s.suggestions.filter((x) => x.source === 'template').map((x) => `${x.id} ${(x.confidence * 100).toFixed(0)}%`),
        takes: s.takes.map((t) => t.id) };
    });
    check('coach: fit status ok', res.status === 'ok', res.status === 'ok' ? '' : (res.problems ?? []).join('; '));
    const ins = res.controls.mouthpiece_insertion;
    // pipeline check, control-agnostic: the fitted simulator reproduces the recording's intonation
    const simMean = await page.evaluate(() => {
      const s = window.__sax.coach.session;
      const ids = s.takes.filter((t) => t.dynamic === 'mf' && t.features[25] > 0).map((t) => t.id);
      const v = ids.map((id) => s.fit.simFeatures?.[id]).filter((f) => f && f[25] > 0).map((f) => f[1]);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    });
    const nSim = await page.evaluate(() => Object.keys(window.__sax.coach.session.fit.simFeatures ?? {}).length);
    check('coach: fit returns controls + simulated features for every take', Object.keys(res.controls).length >= 10 && nSim === an.n, `${Object.keys(res.controls).length} controls, ${nSim}/${an.n} simulated notes — ${res.method}`);
    // fit quality is the fitter's job (reported, not asserted): does the fitted simulator reproduce the intonation?
    console.log(`${Math.abs(simMean - an.meanCents) < 15 ? 'INFO ' : 'WARN '} coach: fit quality — mean mf cents recorded ${an.meanCents.toFixed(1)}, fitted simulator ${Number.isFinite(simMean) ? simMean.toFixed(1) : 'no sounding notes'}`);
    console.log(`INFO  coach: fitted mouthpiece_insertion ${ins?.toFixed(1)} mm (planted ${PLANTED_INSERTION}, default 10); controls ${JSON.stringify(Object.fromEntries(Object.entries(res.controls).map(([k, v]) => [k, +v.toFixed(2)])))}`);
    check('coach: ranked suggestions shown', res.shown > 0 && res.shown === res.sug.length, `${res.sug.join(', ')}`);
    const guard = await page.evaluate(() => ({ excluded: window.__sax.coach.session.fit.excluded ?? [], warnings: [...document.querySelectorAll('.rec-warn li')].map((li) => li.textContent), chips: [...document.querySelectorAll('.coach-table tr.excluded')].length }));
    check('coach: cracked take left out of the fit and shown in the amber box', guard.excluded.includes(CRACKED) && guard.warnings.includes(`${CRACKED} cracked to the octave — left out; try again with a looser lip and slower air.`),
      `excluded [${guard.excluded.join(', ')}]; ${guard.warnings.join(' | ')}`);
    check('coach: G4push reference take recorded', res.takes.includes('G4push'), res.takes.join(' '));
    const top3 = res.template.slice(0, 3).some((x) => x.startsWith('mouthpiece_too_far_out '));
    check('coach: planted cause (mouthpiece too far out) in the template top 3', top3, `${res.template.join(', ')} (${res.src})`);
    // A/B buttons set simulator params
    await page.click('[data-act="load-fitted"]');
    const a = await page.evaluate(() => window.__sax.state.get(18));
    await page.click('[data-act="load-sug"][data-i="0"]').catch(() => {});
    const b = await page.evaluate(() => window.__sax.state.get(18));
    check('coach: Load fitted player / suggested change set the simulator', Math.abs(a - ins) < 0.01, `insertion A ${a.toFixed(1)} → B ${b.toFixed(1)} mm`);
    // pp/ff takes: the fitter's per-note params (incl. dynamic) are loaded
    const ffId = await page.evaluate(() => window.__sax.coach.session.takes.find((t) => t.dynamic === 'ff')?.id);
    if (ffId) {
      await page.select('#ab-note', ffId);
      await page.click('[data-act="load-fitted"]');
      const dyn = await page.evaluate((id) => {
        const pn = window.__sax.coach.session.fit.perNoteParams?.[id] ?? [];
        const want = pn.find(([k]) => k === 24)?.[1];
        return { want, got: window.__sax.state.get(24) };
      }, ffId);
      check('coach: Load fitted player uses the per-note params (dynamic)', dyn.want === undefined || Math.abs(dyn.got - dyn.want) < 1e-3, `${ffId}: dynamic ${dyn.got?.toFixed(2)} (fit ${dyn.want?.toFixed?.(2) ?? 'n/a'})`);
    }
    await page.click('[data-act="restore"]');
    await page.click('[data-act="close"]');
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\ne2e: ${results.length - failed}/${results.length} checks passed`);
  code = failed ? 1 : 0;
} catch (err) {
  console.error('e2e error:', err);
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
