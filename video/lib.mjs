// Shared capture helpers: Playwright from a pinned path, a CDP screencast recorder with
// timestamped marks, a visible cursor (headless has none) and an in-page "camera" that zooms
// with a CSS transform so text is re-rasterised sharp instead of upscaled in post.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
export const PW = process.env.PW || '/Users/garudev/dev/umbra/node_modules/playwright-core';
export const { chromium } = require(PW);
export const W = 1920, H = 1080;

const CURSOR_INIT = `
(() => {
  const css = \`
    #__cur{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
      background:rgba(255,255,255,.92);box-shadow:0 0 0 2px rgba(20,24,40,.85),0 6px 18px rgba(0,0,0,.45);
      pointer-events:none;z-index:2147483647;transition:transform .12s ease,opacity .3s;opacity:0}
    #__cur.on{opacity:1} #__cur.down{transform:scale(.72)}
    .__rip{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;
      border:3px solid #ffd166;pointer-events:none;z-index:2147483646;animation:__rip .55s ease-out forwards}
    @keyframes __rip{to{transform:scale(3.6);opacity:0}}
    html.__cam,html.__cam body{overflow:hidden!important}
    html.__cam body{transform-origin:0 0;transition:transform var(--cam-ms,900ms) cubic-bezier(.45,.05,.2,1)}
  \`;
  const boot = () => {
    if (document.getElementById('__cur')) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    const c = document.createElement('div'); c.id = '__cur'; document.documentElement.appendChild(c);
    addEventListener('mousemove', e => { c.classList.add('on'); c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', e => {
      c.classList.add('down');
      const r = document.createElement('div'); r.className = '__rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();`;

export async function openStudio(outDir, { headless = true } = {}) {
  const framesDir = join(outDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript(CURSOR_INIT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  const marks = [];
  let n = 0;
  cdp.on('Page.screencastFrame', f => {
    const file = `${String(n++).padStart(6, '0')}.jpg`;
    writeFileSync(join(framesDir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  // Camera state lives here so boxes measured under a zoom can be mapped back.
  const cam = { s: 1, tx: 0, ty: 0 };
  const studio = {
    page, ctx, browser, cdp, frames, marks, cam,
    async start() { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 }); },
    mark(name, extra = {}) { const m = { name, t: Date.now() / 1000, ...extra }; marks.push(m); console.log('mark', name); return m; },
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      writeFileSync(join(outDir, 'frames.json'), JSON.stringify(frames));
      writeFileSync(join(outDir, 'marks.json'), JSON.stringify(marks, null, 1));
      await browser.close();
    },
    // Box in untransformed page coordinates.
    async box(locator) {
      const b = await locator.boundingBox();
      if (!b) throw new Error('no box for ' + locator);
      return { x: (b.x - cam.tx) / cam.s, y: (b.y - cam.ty) / cam.s, width: b.width / cam.s, height: b.height / cam.s };
    },
    // Zoom so the region fills ~fill of the frame, clamped so no empty edges show.
    async zoom(region, { fill = 0.8, ms = 900, max = 2.4 } = {}) {
      const s = Math.max(1, Math.min(max, fill * Math.min(W / region.width, H / region.height)));
      const cx = region.x + region.width / 2, cy = region.y + region.height / 2;
      const tx = Math.min(0, Math.max(W - s * W, W / 2 - s * cx));
      const ty = Math.min(0, Math.max(H - s * H, H / 2 - s * cy));
      Object.assign(cam, { s, tx, ty });
      await page.evaluate(([s, tx, ty, ms]) => {
        document.documentElement.classList.add('__cam');
        document.body.style.setProperty('--cam-ms', ms + 'ms');
        document.body.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
      }, [s, tx, ty, ms]);
      await page.waitForTimeout(ms + 80);
    },
    async zoomTo(locator, opts) { await studio.zoom(await studio.box(locator), opts); },
    async unzoom(ms = 800) {
      Object.assign(cam, { s: 1, tx: 0, ty: 0 });
      await page.evaluate(ms => { document.body.style.setProperty('--cam-ms', ms + 'ms'); document.body.style.transform = 'none'; }, ms);
      await page.waitForTimeout(ms + 80);
    },
    async moveTo(locator, steps = 22) {
      const b = await locator.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
      return b;
    },
    async click(locator, { pause = 250, steps = 22 } = {}) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await studio.moveTo(locator, steps);
      await page.waitForTimeout(pause);
      await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    },
    hold: ms => page.waitForTimeout(ms),
  };
  return studio;
}

export async function api(base, path, init) {
  const r = await fetch(base + path, init);
  return r.json();
}

export async function waitRun(base, id, done = s => !['running', 'queued', 'awaiting_input'].includes(s), timeoutMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const snap = await api(base, `/api/runs/${id}`);
    if (done(snap.status, snap)) return snap;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${id} still ${snap.status}`);
    await new Promise(r => setTimeout(r, 1000));
  }
}
