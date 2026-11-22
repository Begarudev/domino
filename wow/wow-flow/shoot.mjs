// Screenshot every key state of the talent-flow centrepiece.
//   PW=/path/to/playwright-core node wow/wow-flow/shoot.mjs [baseUrl]
//   env: SHOTS='s:name,...'  EXTRA='&slot=1'  VW/VH viewport  VIDEO=dir (records a full playthrough)  FPS=1
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright-core');
const base = process.argv[2] || 'http://localhost:5181/';
const out = new URL('.', import.meta.url).pathname;
const shots = (process.env.SHOTS || '0.6:01-start,7.2:02-river-forming,8.25:03-drain-cracked,10.6:04-frozen-predictions,14.35:05-first-hit,22.4:06-scored,25.0:07-zoom,27.75:08-letter-assembling,32.6:09-letter-done').split(',');
const browser = await chromium.launch({ headless: true });
const vw = Number(process.env.VW || 1440), vh = Number(process.env.VH || 900);
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, ...(process.env.VIDEO ? { recordVideo: { dir: process.env.VIDEO, size: { width: vw, height: vh } } } : {}) });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
for (const item of shots) {
  const [s, name] = item.split(':');
  const extra = process.env.EXTRA || '';
  await page.goto(`${base}?s=${s}${extra}`);
  await page.waitForTimeout(900);
  await page.locator('.tf-root').screenshot({ path: `${out}${name}.png` });
  console.log('shot', name);
}
if (process.env.VIDEO) {
  await page.goto(`${base}?speed=1${process.env.EXTRA || ''}`);
  await page.waitForTimeout(Number(process.env.VIDEO_MS || 36000));
}
if (process.env.FPS) {
  await page.goto(`${base}?speed=1`);
  await page.waitForTimeout(1200);
  const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(f); else res(n / 4); }; requestAnimationFrame(f); }));
  console.log('fps', fps);
}
console.log('errors', JSON.stringify(errs));
await ctx.close();
await browser.close();
