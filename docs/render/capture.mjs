// Render screenshots of the 3D scene for look-dev: node docs/render/capture.mjs <prefix> [--gpu] [--fps]
// Starts the Vite dev server, opens the app (headless Chrome; software GL unless --gpu), hides the UI,
// plays a note so the wave glow / airflow / reed are live, and writes docs/render/<prefix>_*.png.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = process.argv[2] ?? 'after';
const gpu = process.argv.includes('--gpu');
const measureFps = process.argv.includes('--fps');
const quality = (process.argv.find((a) => a.startsWith('--quality=')) ?? '').split('=')[1];
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1];
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean).find((p) => fs.existsSync(p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await createServer({ configFile: path.join(root, 'web/vite.config.ts'), server: { port: 0 }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const args = ['--autoplay-policy=no-user-gesture-required', '--window-size=1440,900'];
if (gpu) args.push('--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit');
else args.push('--enable-unsafe-swiftshader', '--use-angle=swiftshader');
const browser = await puppeteer.launch({ executablePath: chrome, headless: gpu ? false : true, args, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: Number(process.env.DPR ?? 1) } });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[render]')) console.log('console', m.type(), m.text()); });
  await page.evaluateOnNewDocument((q) => {
    localStorage.setItem('saxsim.tour.v1', '1');
    if (q) localStorage.setItem('saxsim.render.quality', q);
  }, quality ?? '');
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__sax?.scene, { timeout: 20000 });
  await page.click('#start').catch(() => {});
  await page.waitForFunction(() => window.__sax?.engine.status.state === 'running', { timeout: 15000 }).catch(() => console.log('engine not running'));
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } #viewport, #viewport * { visibility: visible !important; } .tooltip{display:none!important}' });
  await page.evaluate(() => { const s = window.__sax; s.state.set(0, 3.5, 'test'); });
  await wait(1500);
  if (measureFps) {
    for (const preset of ['full', 'player', 'mouthpiece']) {
      await page.evaluate((p) => window.__sax.scene.goto(p, true), preset);
      const r = await page.evaluate(() => new Promise((res) => {
        const ts = []; let n = 0;
        const f = (t) => { ts.push(t); if (++n < 240) requestAnimationFrame(f); else res(ts); };
        requestAnimationFrame(f);
      }));
      const d = r.slice(1).map((t, i) => t - r[i]).sort((a, b) => a - b);
      const q = await page.evaluate(() => window.__sax.scene.render?.quality ?? '-');
      console.log(`fps ${preset}: median ${(1000 / d[d.length >> 1]).toFixed(1)}  p90 frame ${d[Math.floor(d.length * 0.9)].toFixed(1)} ms  quality ${q}`);
    }
  }
  const shots = [
    ['full', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.goto('full', true); }); }],
    ['mouthpiece_xray', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(true); s.goto('mouthpiece', true); }); }],
    ['player', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.goto('player', true); }); }],
    ['keys', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.goto('keys', true); }); }],
    ['bell', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.goto('full', true); const c = s.camera, t = s.controls.target; t.set(0, 0.2, 0.09); c.position.set(0.36, 0.3, 0.4); s.controls.update(); }); }],
    ['stack', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.goto('full', true); const c = s.camera, t = s.controls.target; t.set(0.015, 0.4, 0.0); c.position.set(0.15, 0.45, 0.1); s.controls.update(); }); }],
    ['lowstack', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.goto('full', true); const c = s.camera, t = s.controls.target; t.set(0.015, 0.1, 0.03); c.position.set(0.2, 0.16, -0.12); s.controls.update(); }); }],
    ['nocutaway', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setXray(false); s.setCutaway(false); s.goto('player', true); }); }],
    ['xray_full', async () => { await page.evaluate(() => { const s = window.__sax.scene; s.setCutaway(true); s.setXray(true); s.goto('full', true); }); }],
  ];
  for (const [name, setup] of shots) {
    if (only && !only.split(',').includes(name)) continue;
    await setup();
    await wait(gpu ? 600 : 2500);
    await page.screenshot({ path: path.join(root, `docs/render/${prefix}_${name}.png`) });
    console.log('wrote', `${prefix}_${name}.png`);
  }
} catch (e) {
  console.error('capture failed:', e);
} finally {
  await Promise.race([browser.close(), wait(5000)]);
  await Promise.race([server.close(), wait(3000)]);
  process.exit(0);
}
