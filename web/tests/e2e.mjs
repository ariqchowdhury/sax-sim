// Headless-Chrome smoke test (npm run test:e2e).
//  • starts the Vite dev server programmatically, opens the app, starts audio
//  • plays a scale in note mode and checks the telemetry pitch of each note against the data's
//    f_target (±50 cents — a regression net, not an accuracy test)
//  • drags the lung and tongue handles and checks the params change
//  • checks the input-impedance plot recomputes after a fingering change
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
    const v = s.scene.camera.position.clone(); o.getWorldPosition(v); v.project(s.scene.camera);
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
  await drag('scene.player.hLung', 0, -50);
  let after = await param(0);
  check('drag lung handle → lung_pressure', after > before + 0.5, `${before.toFixed(2)} → ${after.toFixed(2)} kPa`);
  before = await param(6);
  await drag('scene.player.hTongueBody', 0, -25);
  after = await param(6);
  check('drag tongue body → tongue_y', after > before + 0.05, `${before.toFixed(2)} → ${after.toFixed(2)}`);
  await page.evaluate(() => window.__sax.state.set(0, 0, 'test'));

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
