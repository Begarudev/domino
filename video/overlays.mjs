// Renders caption bands and title cards as 1920x1080 PNGs with Playwright (this ffmpeg has no drawtext/libass).
// The app video is overlaid into the window hole at APP (see assemble.mjs).
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from './lib.mjs';

export const APP = { x: 144, y: 14, w: 1632, h: 918 };

const fontDir = [
  process.env.DOMINO_APP && `${process.env.DOMINO_APP}/node_modules/@fontsource-variable/archivo/files`,
  new URL('../node_modules/@fontsource-variable/archivo/files', import.meta.url).pathname,
].find(d => d && existsSync(d));
const FONTS = fontDir ? `@font-face{font-family:Archivo;font-weight:100 900;font-stretch:62% 125%;src:url(${pathToFileURL(`${fontDir}/archivo-latin-wdth-normal.woff2`)})}` : '';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BASE_CSS = `${FONTS}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{font-family:Archivo,'Helvetica Neue',Arial,sans-serif;color:#f3ead8;
  background:radial-gradient(1200px 700px at 30% 20%,#17202f 0%,#0b0f17 60%,#080b11 100%)}
.pill{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 14px;border-radius:17px;font-size:19px;font-weight:600;
  letter-spacing:.01em;white-space:nowrap}
.pill i{width:9px;height:9px;border-radius:50%;background:currentColor;display:inline-block}
.p-speed{background:#ffd166;color:#14110a}
.p-live{background:rgba(88,214,141,.14);color:#7ee2a8;border:1.5px solid rgba(126,226,168,.55)}
.p-cache{background:rgba(120,170,255,.14);color:#a9c6ff;border:1.5px solid rgba(169,198,255,.55)}
.p-fault{background:rgba(255,120,90,.14);color:#ffab94;border:1.5px solid rgba(255,171,148,.6)}
.p-note{background:rgba(243,234,216,.08);color:#d8cfbd;border:1.5px solid rgba(243,234,216,.25)}
`;

function bandHtml({ step, total, stepLabel, headline, sub, pills = [] }) {
  const dots = Array.from({ length: total || 0 }, (_, i) => `<b class="${i + 1 < step ? 'done' : i + 1 === step ? 'on' : ''}"></b>`).join('');
  return `<!doctype html><html><head><style>${BASE_CSS}
  .win{position:absolute;left:${APP.x - 3}px;top:${APP.y - 3}px;width:${APP.w + 6}px;height:${APP.h + 6}px;border-radius:6px;
    background:#000;box-shadow:0 0 0 1px rgba(243,234,216,.18),0 18px 60px rgba(0,0,0,.55)}
  .band{position:absolute;left:${APP.x}px;right:${1920 - APP.x - APP.w}px;top:${APP.y + APP.h + 16}px;bottom:14px;display:flex;align-items:center;gap:30px}
  .step{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-width:150px}
  .step .n{font-size:22px;font-weight:800;letter-spacing:.14em;color:#ffd166;font-variant-numeric:tabular-nums}
  .step .lab{font-size:17px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#bfb6a3}
  .dots{display:flex;gap:6px}.dots b{width:20px;height:5px;border-radius:3px;background:rgba(243,234,216,.18)}
  .dots b.done{background:rgba(255,209,102,.55)}.dots b.on{background:#ffd166}
  .rule{width:2px;align-self:stretch;margin:6px 0;background:rgba(243,234,216,.14)}
  .txt{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:6px}
  .h{font-size:37px;line-height:1.08;font-weight:700;letter-spacing:-.005em;font-stretch:96%}
  .s{font-size:23px;line-height:1.25;color:#cfc6b4;font-weight:450}
  .pills{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
  </style></head><body>
  <div class="win"></div>
  <div class="band">
    ${step ? `<div class="step"><span class="n">STEP ${step}/${total}</span><span class="lab">${esc(stepLabel)}</span><span class="dots">${dots}</span></div><div class="rule"></div>` : ''}
    <div class="txt"><div class="h">${esc(headline)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>
    <div class="pills">${pills.map(p => `<span class="pill p-${p.kind}">${p.kind === 'live' || p.kind === 'cache' ? '<i></i>' : ''}${esc(p.text)}</span>`).join('')}</div>
  </div></body></html>`;
}

function cardHtml({ kicker, title, sub, foot, lines = [] }) {
  return `<!doctype html><html><head><style>${BASE_CSS}
  .c{position:absolute;left:180px;right:180px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:34px}
  .k{font-size:26px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#ffd166}
  .t{font-size:88px;line-height:1.02;font-weight:800;letter-spacing:-.015em;font-stretch:92%;max-width:1500px}
  .u{font-size:38px;line-height:1.3;color:#d8cfbd;max-width:1400px;font-weight:450}
  .l{display:flex;flex-direction:column;gap:14px;margin-top:6px}
  .l div{font-size:30px;color:#e9e0cc;display:flex;gap:18px;align-items:baseline}
  .l div b{color:#ffd166;font-weight:800;min-width:30px}
  .f{position:absolute;left:180px;bottom:70px;font-size:22px;color:#9d9585;letter-spacing:.04em}
  .mark{position:absolute;left:180px;top:70px;font-size:30px;font-weight:900;letter-spacing:.28em;color:#f3ead8}
  </style></head><body>
  <div class="mark">DOMINO</div>
  <div class="c">${kicker ? `<div class="k">${esc(kicker)}</div>` : ''}<div class="t">${esc(title)}</div>${sub ? `<div class="u">${esc(sub)}</div>` : ''}
  ${lines.length ? `<div class="l">${lines.map((x, i) => `<div><b>${i + 1}</b>${esc(x)}</div>`).join('')}</div>` : ''}</div>
  ${foot ? `<div class="f">${esc(foot)}</div>` : ''}</body></html>`;
}

export async function renderOverlays(items, outDir) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const it of items) {
    await page.setContent(it.card ? cardHtml(it.card) : bandHtml(it.band), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${outDir}/${it.id}.png` });
  }
  await browser.close();
}
