// Screenshot harness: node wow/wow-physical/shoot.mjs <outPrefix> <query> <w> <h> <ms,ms,...> [engine]
import { chromium, webkit } from 'playwright';
const [, , prefix = 'shot', query = 'mode=replay', w = '1440', h = '900', times = '0', engine = 'chromium'] = process.argv;
const browserType = engine === 'webkit' ? webkit : chromium;
const exe = process.env.PW_EXE || undefined;
const browser = await browserType.launch({ headless: true, executablePath: engine === 'chromium' ? exe : undefined, args: engine === 'chromium' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] : [] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(process.env.BASE_URL ? process.env.BASE_URL + '?' + query : `http://localhost:4410/wow-physical.html?${query}`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);
const gl = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
console.log('renderer:', gl);
const list = times.split(',').map(Number);
const t0 = Date.now();
let clicked = false;
for (const t of list) {
  if (t > 0 && !clicked) { const b = await page.$('.dp-play'); if (b) await b.click(); clicked = true; }
  const wait = t - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  const fps = await page.evaluate(() => new Promise((r) => { let n = 0; const s = performance.now(); const f = () => { n++; if (performance.now() - s < 500) requestAnimationFrame(f); else r(Math.round(n * 1000 / (performance.now() - s))); }; requestAnimationFrame(f); }));
  const cap = await page.evaluate(() => (document.querySelector('.dp-clock-date')?.textContent ?? '') + ' | ' + (document.querySelector('.dp-clock-cap')?.textContent ?? ''));
  await page.screenshot({ path: `${prefix}-${String(t).padStart(5, '0')}.png` });
  console.log(t, 'fps', fps, cap);
}
console.log(logs.slice(0, 15).join('\n'));
await browser.close();
