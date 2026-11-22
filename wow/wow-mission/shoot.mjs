// Screenshots every key state of the mission-control harness.
// Usage: PW_DIR=<dir with node_modules/playwright> CHROME=<chromium binary> node wow/wow-mission/shoot.mjs [baseUrl]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(`${process.env.PW_DIR}/`);
const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://localhost:4330/';
const out = fileURLToPath(new URL('.', import.meta.url));
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--force-device-scale-factor=1'] });
const errors = [];

async function page(url, w = 1440, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${url}: ${m.text()}`); });
  await p.goto(base + url, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  return p;
}
const shot = async (p, name) => { await p.screenshot({ path: `${out}${name}.png` }); console.log('shot', name); };
const stepIs = (p, step, status) => p.waitForFunction(([s, st]) => {
  const li = [...document.querySelectorAll('.mc-rail__step')].find((el) => el.querySelector('.mc-rail__label')?.textContent === s);
  return li && li.className.includes(`is-${st}`);
}, [step, status], { timeout: 60000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!only || only.has('live')) {
  const p = await page('');
  await shot(p, '01-ready');
  await p.click('.hx-go');
  await wait(1500);
  await shot(p, '02a-calling');
  await stepIs(p, 'Finding changes', 'done');
  await wait(150);
  await shot(p, '02b-reading-desk');
  await stepIs(p, 'Checking companies', 'running');
  await wait(1700);
  await shot(p, '02c-desk-signals');
  await stepIs(p, 'Linking companies', 'running');
  await wait(500);
  await p.click('.mc-kill');
  await wait(180);
  await shot(p, '03-kill-glitch');
  await wait(1700);
  await shot(p, '04-engine-down');
  await p.waitForSelector('.mc-resumed', { timeout: 15000 });
  await wait(1400);
  await shot(p, '05-resumed-chain-building');
  await wait(3550);
  await shot(p, '06-cant-verify-shatter');
  await wait(2600);
  await shot(p, '07-chain-built');
  await p.click('.hx-btn');
  await wait(400);
  await shot(p, '07b-hiring-filter-view');
  await p.click('.hx-btn');
  await p.waitForSelector('.mc-hold', { timeout: 60000 });
  await wait(1100);
  await shot(p, '08a-draft-assembling');
  await wait(3200);
  await shot(p, '08-approval-gate');
  const box = await p.locator('.mc-hold').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await wait(600);
  await shot(p, '09-holding');
  await wait(700);
  await p.mouse.up();
  await wait(550);
  await shot(p, '10-sealing');
  await wait(2600);
  await shot(p, '11-sent-once');
  await p.click('.mc-again');
  await wait(250);
  await shot(p, '12-already-sent-skipped');
  await p.close();
}

if (!only || only.has('replay')) {
  const p = await page('?run=replay');
  await p.click('.hx-go');
  await p.waitForSelector('.mc-score', { timeout: 60000 });
  await wait(500);
  await shot(p, '13-replay-frozen-1-sep');
  await wait(4300);
  await shot(p, '14-replay-falling');
  await wait(5200);
  await shot(p, '15-replay-scored');
  await p.close();
}

if (!only || only.has('cap')) {
  const p = await page('');
  await p.click('.hx-go');
  await wait(2600);
  const cap = await p.locator('.mc-gauge__cap').boundingBox();
  const tube = await p.locator('.mc-gauge__tube').boundingBox();
  await p.mouse.move(cap.x + 8, cap.y + 1);
  await p.mouse.down();
  await p.mouse.move(cap.x + 8, tube.y + tube.height * 0.86, { steps: 12 });
  await p.mouse.up();
  await wait(300);
  await shot(p, '16-cap-dragged');
  await p.waitForSelector('.mc-gauge.is-exhausted', { timeout: 30000 }).catch(() => {});
  await wait(400);
  await shot(p, '17-stopped-at-cap');
  await p.close();
}

if (!only || only.has('slot')) {
  const p = await page('?slot=1&speed=3');
  await p.click('.hx-go');
  await p.waitForSelector('.mc-hold', { timeout: 60000 });
  await wait(1200);
  await shot(p, '18-slot-780x540-gate');
  await p.close();
  const q = await page('?slot=1&speed=3');
  await q.click('.hx-go');
  await stepIs(q, 'Ranking accounts', 'done');
  await wait(3500);
  await shot(q, '19-slot-780x540-chain');
  await q.close();
}

await browser.close();
if (errors.length) { console.log('ERRORS'); for (const e of errors) console.log(' ', e); }
