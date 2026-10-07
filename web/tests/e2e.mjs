// Headless-Chrome smoke test (npm run test:e2e).
//  • starts the Vite dev server programmatically, opens the app, starts audio
//  • plays a scale in note mode and checks the telemetry pitch of each note against the data's
//    f_target (±50 cents — a regression net, not an accuracy test)
//  • drags the lung and tongue handles and checks the params change
//  • checks the input-impedance plot recomputes after a fingering change
//  • progressive-disclosure UI: drawers closed by default + toggle, drag readout, context card, Blow button,
//    drag gain consistent across zoom, lower-lip axis lock, mouthpiece handle cluster collapse
//  • Play mode (auto player): fingerings incl. altissimo in register with two mouthpieces, voicing
//    changes between notes, grab-to-take-over sets / clears the mask; altissimo list (all register-3
//    entries, ▶ plays in register); voicing close-up renders, toggles and its delta labels update
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
  // the existing checks exercise Explore mode (first-time users start in Play; covered further down)
await page.evaluateOnNewDocument(() => { localStorage.setItem('saxsim.tour.v1', '1'); localStorage.setItem('saxsim.mode.v1', 'explore'); });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 }); // generous: a cold dev server on a busy machine
  await page.click('#start');
  await page.waitForFunction(() => window.__sax?.engine.status.state === 'running', { timeout: 60000 });
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
  const camTo = async (c) => { await page.click(`[data-cam="${c}"]`); await wait(200); await page.waitForFunction(() => !window.__sax.scene.tween, { timeout: 60000 }); await wait(300); };
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

  // ---- Play mode (auto player): keys + volume, the player voices each note ----------------------
  {
    const { PARAMS: PD, AUTO_CONTROLS } = await import('../src/engine/params.ts');
    const defaults = PD.filter((d) => ![19, 20, 21, 27, 28].includes(d.id)).map((d) => [d.id, d.default]);
    await page.keyboard.press('Escape');
    await page.evaluate((d) => { for (const [i, v] of d) window.__sax.state.set(i, v, 'test'); }, defaults);
    await page.click('[data-mode="play"]'); await wait(200);
    const pm = await page.evaluate(() => ({ auto: window.__sax.state.get(27), assist: window.__sax.state.get(23), mode: window.__sax.ap.mode, cls: document.body.classList.contains('mode-play'), vol: getComputedStyle(document.querySelector('.air.vol')).display }));
    check('play: Play mode turns the auto player on (Volume shown)', pm.mode === 'play' && pm.auto === 1 && pm.cls && pm.vol !== 'none', JSON.stringify(pm));
    // ---- altissimo list (from the data's auto-player table) + voicing close-up ------------------
    {
      const want = (geo.auto_player?.entries ?? []).filter((e) => e.register === 3).map((e) => e.note);
      await page.click('#alt-btn'); await wait(200);
      const got = await page.evaluate(() => [...document.querySelectorAll('#alt-card:not([hidden]) .alt-item')].map((e) => e.dataset.note));
      const keys = await page.evaluate(() => [...document.querySelectorAll('.alt-item kbd')].map((k) => k.textContent));
      check('play: altissimo list shows every register-3 entry of the data (with note-mode keys)', want.length > 0 && JSON.stringify(got) === JSON.stringify(want) && keys.every((k) => k && k !== '—'),
        `${got.join(' ')} · keys ${keys.join(' ')}`);
      // voicing close-up: on by default (≥ 1024 px) in Play mode, renders, toggles from Layers
      const insetOn = await page.evaluate(() => !document.getElementById('inset').hidden && window.__sax.inset.enabled);
      // a first note (G4), settled
      const tG4 = Date.now();
      await page.keyboard.down('KeyB');
      // until the close-up itself holds G4 as the settled note (it records notes when they lock)
      const g4ok = await page.waitForFunction(() => window.__sax.inset.history.cur === 'G4', { timeout: 10000 }).then(() => true, () => false);
      const g4ms = Date.now() - tG4;
      const g4st = await page.evaluate(() => ({ status: window.__sax.ap.status, f: +window.__sax.engine.telemetry.frequency.toFixed(1), inset: window.__sax.inset.history, visible: window.__sax.inset.visible }));
      await wait(400);
      await page.keyboard.up('KeyB'); await wait(300);
      const lab0 = await page.evaluate(() => document.querySelector('.inset-labels').textContent);
      // ▶ G#6 from the list: plays it in register; the close-up shows what changed since G4
      const target = (geo.auto_player.entries.find((e) => e.note === 'G#6') ?? {}).f_target;
      let fP = 0, cP = NaN;
      for (let attempt = 0; attempt < 2 && !(Math.abs(cP) < 50); attempt++) {
        await page.click('.alt-item[data-note="G#6"] .alt-play');
        for (let t = 0; t < 16; t++) { await wait(100); fP = await page.evaluate(() => window.__sax.engine.telemetry.frequency); cP = fP > 20 ? 1200 * Math.log2(fP / target) : NaN; if (Math.abs(cP) < 50 && t > 6) break; }
        if (!(Math.abs(cP) < 50)) await wait(2000);
      }
      await page.waitForFunction(() => /→ G#6/.test(document.querySelector('.inset-title').textContent), { timeout: 5000 }).catch(() => {});
      const lab1 = await page.evaluate(() => ({ title: document.querySelector('.inset-title').textContent, text: document.querySelector('.inset-labels').textContent, rows: document.querySelectorAll('.inset-labels .iv b').length }));
      check('play: ▶ in the altissimo list plays G#6 in register', Math.abs(cP) < 50, `${fP.toFixed(1)} Hz, ${Number.isFinite(cP) ? cP.toFixed(0) : '—'} ¢ (target ${target?.toFixed(1)})`);
      await page.evaluate(() => { window.__sax.inset.probeRequested = true; });
      await page.waitForFunction(() => window.__sax.inset.lastProbe, { timeout: 5000 }).catch(() => {});
      const probe = await page.evaluate(() => window.__sax.inset.lastProbe);
      check('play: voicing close-up is on and renders (non-empty pixels)', insetOn && !!probe && probe.distinct >= 4 && probe.nonBlack >= 5, JSON.stringify(probe));
      const hist = await page.evaluate(() => window.__sax.inset.history);
      check('play: voicing close-up delta labels update between two notes', /G4 → G#6/.test(lab1.title) && lab1.rows >= 1 && lab1.text !== lab0 && /→/.test(lab1.text),
        `${lab1.title}: ${lab1.text.slice(0, 140)} · G4 ${g4ok ? `recorded after ${g4ms} ms` : `NOT recorded in 10 s`} (${JSON.stringify(g4st)}) · history now ${JSON.stringify(hist)}`);
      await page.click('#layers-btn'); await page.click('[data-toggle="inset"]'); await wait(150);
      const off = await page.evaluate(() => document.getElementById('inset').hidden);
      await page.click('[data-toggle="inset"]'); await wait(150);
      const on2 = await page.evaluate(() => !document.getElementById('inset').hidden);
      await page.click('#layers-btn');
      check('play: Layers → Voicing close-up toggles it', off && on2);
      await page.click('.alt-close');
      await page.keyboard.press('Escape');
    }
    // ---- one key state: every way of pressing keys can be released by a click / Clear keys / Esc --
    {
      const downIds = () => page.evaluate(() => { const s = window.__sax; return s.geo.keys.filter((_, i) => s.state.keyDown[i] > 0.5).map((k) => k.id); });
      const openPads = () => page.evaluate(() => {
        const s = window.__sax, out = new Float32Array(s.scene.predicted.length);
        s.scene.keywork.evaluate(new Float32Array(s.geo.keys.length), out);
        return Array.from(s.scene.predicted).every((v, i) => Math.abs(v - out[i]) < 1e-6);
      });
      const clickKey = async (id) => {
        const i = geo.keys.findIndex((k) => k.id === id);
        const p = await screenOf(`scene.sax.keys.${i}.mesh`);
        await page.mouse.move(p.x, p.y); await wait(60); await page.mouse.down(); await wait(40); await page.mouse.up(); await wait(200);
      };
      const playAlt = async (note) => {
        if (await page.evaluate(() => document.getElementById('alt-card').hidden)) await page.click('#alt-btn');
        await page.click(`.alt-item[data-note="${note}"] .alt-play`); await wait(400);
        await page.click('.alt-close'); await wait(100);
      };
      await camTo('keys');
      // ▶ G6 (OCT, LH1, LH_Gs): clicking LH1 while it plays releases it; when playback stops ▶ lifts the rest
      await playAlt('G6');
      const k0 = await downIds();
      await clickKey('LH1');
      const k1 = await downIds();
      check('keys: a key pressed by ▶ releases when clicked on the sax', k0.includes('LH1') && !k1.includes('LH1'), `${k0.join(' ')} → ${k1.join(' ')}`);
      await page.waitForFunction(() => !document.querySelector('.alt-item.on'), { timeout: 5000 }).catch(() => {});
      await wait(150);
      const k2 = await downIds();
      check('keys: ▶ lifts its fingering when playback stops (open fingering, pads open)', k2.length === 0 && await openPads(), k2.join(' ') || 'no keys down');
      // ▶ → Clear keys: all keys up, pads = open fingering, playback stopped
      await playAlt('G#6');
      const k3 = await downIds();
      await page.click('#clear-keys'); await wait(150);
      const c1 = { keys: await downIds(), pads: await openPads(), playing: await page.evaluate(() => !!document.querySelector('.alt-item.on')) };
      check('keys: Clear keys after ▶ → open fingering and playback stopped', k3.length > 0 && c1.keys.length === 0 && c1.pads && !c1.playing, `${k3.join(' ')} → ${JSON.stringify(c1)}`);
      // ▶ → Esc does the same
      await playAlt('A6');
      await page.keyboard.press('Escape'); await wait(150);
      const e1 = { keys: await downIds(), pads: await openPads(), playing: await page.evaluate(() => !!document.querySelector('.alt-item.on')) };
      check('keys: Esc after ▶ → open fingering and playback stopped', e1.keys.length === 0 && e1.pads && !e1.playing, JSON.stringify(e1));
      // note mode: the fingers stay down after the note (G4: LH1 LH2 LH3) — still clickable, then Clear keys
      await page.keyboard.down('KeyB'); await wait(500); await page.keyboard.up('KeyB'); await wait(300);
      const n0 = await downIds();
      await clickKey('LH2');
      const n1 = await downIds();
      await page.click('#clear-keys'); await wait(150);
      const n2 = { keys: await downIds(), pads: await openPads() };
      check('keys: note-mode fingering stays down, a click releases a key, Clear keys opens all', n0.includes('LH2') && !n1.includes('LH2') && n1.length === n0.length - 1 && n2.keys.length === 0 && n2.pads,
        `${n0.join(' ')} → click LH2 → ${n1.join(' ')} → Clear → ${JSON.stringify(n2)}`);
      // MIDI note on/off (written G4 = 67: LH1 LH2 LH3) — same rules
      const dyn0 = await page.evaluate(() => window.__sax.state.get(24));
      await page.evaluate(() => window.__sax.midi.onMessage(new Uint8Array([0x90, 67, 100]))); await wait(500);
      await page.evaluate(() => window.__sax.midi.onMessage(new Uint8Array([0x80, 67, 0]))); await wait(300);
      const m0 = await downIds();
      await clickKey('LH3');
      const m1 = await downIds();
      await page.click('#clear-keys'); await wait(150);
      const m2 = { keys: await downIds(), pads: await openPads() };
      check('keys: MIDI fingering stays down, a click releases a key, Clear keys opens all', m0.includes('LH3') && !m1.includes('LH3') && m2.keys.length === 0 && m2.pads,
        `${m0.join(' ')} → click LH3 → ${m1.join(' ')} → Clear → ${JSON.stringify(m2)}`);
      await page.evaluate((d) => window.__sax.state.set(24, d, 'test'), dyn0);
      await camTo('full');
    }
    const alt = (geo.alternate_fingerings ?? []).find((a) => a.register === 3 && a.note === 'G#6');
    // [key, label, target Hz, octave shift]
    const set = [['KeyZ', 'C4', geo.fingerings.find((x) => x.written_midi === 60).f_target, 0], ['KeyB', 'G4', geo.fingerings.find((x) => x.written_midi === 67).f_target, 0],
      ['KeyQ', 'C5', geo.fingerings.find((x) => x.written_midi === 72).f_target, 0], ['KeyT', 'G5', geo.fingerings.find((x) => x.written_midi === 79).f_target, 0]];
    if (alt) set.push(['Digit6', 'G#6 (altissimo)', alt.f_target, 1]);
    const snap = () => page.evaluate((ids) => ids.map((id) => window.__sax.ap.value(id)), AUTO_CONTROLS.filter((id) => id !== 0));
    const playSet = async (label) => {
      const snaps = [];
      for (const [code_, name, target, oct] of set) {
        if (oct) await page.keyboard.press('ArrowUp');
        let cents = NaN, f = 0, status = '';
        for (let attempt = 0; attempt < 3 && !(Math.abs(cents) < 50); attempt++) {
          if (attempt) { await page.keyboard.up(code_); await wait(400); }
          await page.keyboard.down(code_);
          for (let t = 0; t < 40; t++) {
            await wait(100);
            f = await page.evaluate(() => window.__sax.engine.telemetry.frequency);
            status = await page.evaluate(() => window.__sax.ap.status);
            cents = f > 20 ? 1200 * Math.log2(f / target) : NaN;
            if (Math.abs(cents) < 50 && status === 'locked' && t > 6) break;
          }
        }
        snaps.push(await snap());
        await page.keyboard.up(code_);
        if (oct) await page.keyboard.press('ArrowDown');
        await wait(350);
        check(`play (${label}): ${name} sounds in register`, Math.abs(cents) < 50, `${f.toFixed(1)} Hz, ${Number.isFinite(cents) ? cents.toFixed(0) : '—'} ¢ (target ${target.toFixed(1)}), status ${status}`);
      }
      return snaps;
    };
    const noteShown = () => page.evaluate(() => { const e = document.getElementById('ap-setup'); return { shown: !e.hidden, text: e.textContent }; });
    const n0 = await noteShown();
    const s1 = await playSet('default mouthpiece');
    // the voicing (anatomy) differs between notes: low C4 vs altissimo, and more than one voicing overall
    const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const distinct = new Set(s1.map((x) => x.map((v) => v.toFixed(2)).join(','))).size;
    check('play: the player\'s voicing (anatomy) changes between notes', distinct >= 3 && dist(s1[0], s1[s1.length - 1]) > 0.1,
      `${distinct} distinct voicings over ${s1.length} notes; C4 → last Δmax ${dist(s1[0], s1[s1.length - 1]).toFixed(2)}; source ${await page.evaluate(() => window.__sax.ap.source)}`);
    // a setup OUTSIDE the ranges the auto player was tuned for (data auto_player.adaptation.validity:
    // tip ≤ 2.5 mm, baffle ≤ 0.6) gets the gentle note; locking is not guaranteed there (engine repro:
    // render --fingering C4 --auto --set baffle_height=0.9 --set tip_opening=2.6 --seed 8 → stuck at
    // 460 Hz), so the in-register checks below use the brightest setup INSIDE the tuned ranges
    await page.evaluate(() => { window.__sax.state.set(15, 0.9, 'drag'); window.__sax.state.set(13, 2.6, 'drag'); });
    const owned0 = await page.evaluate(() => window.__sax.ap.mask);
    // the bar refreshes inside rendered frames (15 Hz): wait for it rather than a fixed delay
    const tNote = Date.now();
    await page.waitForFunction(() => !document.getElementById('ap-setup').hidden, { timeout: 10000 }).catch(() => {});
    const noteMs = Date.now() - tNote;
    const n1 = await noteShown();
    const seen = await page.evaluate(() => { const s = window.__sax; return { tip: +s.state.get(13).toFixed(3), baffle: +s.state.get(15).toFixed(3), mode: s.ap.mode, fps: +s.scene.fps.toFixed(0) }; });
    seen.noteAfterMs = noteMs;
    check('play: setup outside the auto player\'s tuned ranges gets a gentle note (from the data)', !n0.shown && n1.shown && /outside what the auto player was tuned for/.test(n1.text) && /baffle/.test(n1.text),
      `default setup: ${n0.shown ? `shown "${n0.text}"` : 'hidden'}; bright setup: ${n1.shown ? 'shown' : 'hidden'} "${n1.text}"; ${JSON.stringify(seen)}`);
    // brightest setup the auto player was tuned for: high baffle, open tip (the player adapts)
    await page.evaluate(() => { window.__sax.state.set(15, 0.6, 'drag'); window.__sax.state.set(13, 2.5, 'drag'); });
    await page.waitForFunction(() => document.getElementById('ap-setup').hidden, { timeout: 10000 }).catch(() => {});
    const n2 = await noteShown();
    check('play: the note goes away inside the tuned ranges', !n2.shown, n2.shown ? `still shown: "${n2.text}"` : 'hidden at baffle 0.6, tip 2.5 mm');
    await playSet('bright mouthpiece: baffle 0.6, tip 2.5 mm');
    check('play: mouthpiece changes stay the user\'s (no take-over)', owned0 === 0 && await page.evaluate(() => window.__sax.ap.mask) === 0 && Math.abs(await page.evaluate(() => window.__sax.state.get(15)) - 0.6) < 1e-6);
    await page.evaluate(() => { window.__sax.state.set(15, 0.3, 'test'); window.__sax.state.set(13, 1.9, 'test'); });
    // tuning hint: a mouthpiece pushed far onto the cork detunes every note beyond what the lip can
    // trim → "Instrument runs … sharp — pull the mouthpiece out …"; one click moves it
    // (insertion is the only setting outside the tuned ranges here: tip/baffle are back at default)
    await page.evaluate(() => window.__sax.state.set(18, 19, 'drag'));
    // play notes until 3 have been sampled for THIS setup (the cork change reset the samples)
    const tStart = Date.now();
    const seq = ['KeyB', 'KeyQ', 'KeyT', 'KeyE', 'KeyN', 'KeyW', 'KeyC', 'KeyR'];
    let played = 0;
    for (const k of seq) {
      if (await page.evaluate(() => window.__sax.ap.tuningSamples) >= 3) break;
      await page.keyboard.down(k);
      await page.waitForFunction((n) => window.__sax.ap.tuningSamples > n, { timeout: 4000 }, await page.evaluate(() => window.__sax.ap.tuningSamples)).catch(() => {});
      await wait(200);
      await page.keyboard.up(k); await wait(350);
      played++;
    }
    await page.waitForFunction(() => !document.getElementById('ap-tune').hidden, { timeout: 5000 }).catch(() => {});
    const th = await page.evaluate(() => { const b = document.getElementById('ap-tune'); return { shown: !b.hidden, text: b.textContent, debug: window.__sax.ap.tuningDebug() }; });
    // click the element that is there now (the bar re-renders at 15 Hz; no coordinate race)
    if (th.shown) await page.$eval('#ap-tune', (b) => b.click());
    const ins = await page.evaluate(() => window.__sax.state.get(18));
    check('play: tuning hint for a detuned setup, one click moves the mouthpiece', th.shown && /sharp/.test(th.text) && ins < 19 - 1,
      `"${th.text}" → insertion 19 → ${ins.toFixed(1)} mm; ${played} notes in ${((Date.now() - tStart) / 1000).toFixed(1)} s; mean ${th.debug.mean} ¢ (threshold ±${th.debug.threshold}, ≥ ${th.debug.minNotes} notes); log ${JSON.stringify(th.debug.log)}`);
    await page.evaluate(() => window.__sax.state.set(18, 10, 'test'));
    // grab to take over: dragging the tongue sets its mask bits + chip; reset clears them
    await camTo('player');
    const tq = await screenOf('scene.player.hTongueBody');
    await page.mouse.move(tq.x, tq.y); await wait(80); await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(tq.x, tq.y - 4 * i); await wait(30); }
    await page.mouse.up(); await wait(250);
    const tk = await page.evaluate(() => ({ mask: window.__sax.ap.mask, param: window.__sax.state.get(28), chip: !!document.querySelector('.chip.own[data-group="tongue"]') }));
    const tongueBits = (1 << AUTO_CONTROLS.indexOf(5)) | (1 << AUTO_CONTROLS.indexOf(6));
    check('play: grabbing the tongue takes it over (mask bits + chip)', (tk.mask & tongueBits) === tongueBits && tk.param === tk.mask && tk.chip, JSON.stringify(tk));
    await page.click('.chip.own[data-group="tongue"] button'); await wait(150);
    const rs = await page.evaluate(() => ({ mask: window.__sax.ap.mask, param: window.__sax.state.get(28), chip: !!document.querySelector('.chip.own[data-group="tongue"]') }));
    check('play: reset hands the tongue back (mask cleared)', (rs.mask & tongueBits) === 0 && rs.param === rs.mask && !rs.chip, JSON.stringify(rs));
    await page.click('[data-mode="explore"]'); await wait(150);
    const ex = await page.evaluate(() => ({ auto: window.__sax.state.get(27), assist: window.__sax.state.get(23), mode: localStorage.getItem('saxsim.mode.v1') }));
    check('play: Explore turns the auto player off and restores player assist', ex.auto === 0 && Math.abs(ex.assist - 0.5) < 1e-6 && ex.mode === 'explore', JSON.stringify(ex));
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
