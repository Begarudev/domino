// Etched tile faces drawn to canvas: colour map, bump map (engraving depth) and emissive map (the inlay that lights up).
import * as THREE from 'three';
import { TILE, mechWord, type TileSpec } from './layout.ts';

export const INK = '#262a2f';
export const IVORY = '#ebe4d2';
const PX = 360; // canvas px per world unit

const DISPLAY = '"Big Shoulders Display", "Arial Narrow", sans-serif';
const TEXT = '"Schibsted Grotesk", "Helvetica Neue", sans-serif';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

type Layer = 'color' | 'bump' | 'glow';

function draw(spec: TileSpec, width: number, layer: Layer): HTMLCanvasElement {
  const cw = Math.round(width * PX);
  const ch = Math.round(TILE.h * PX);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d')!;
  // background
  if (layer === 'color') {
    const g = ctx.createLinearGradient(0, 0, cw, ch);
    g.addColorStop(0, '#f1ebdb'); g.addColorStop(1, '#ddd4bf');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
    // fine grain so the lacquer reads as material, not plastic
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(90,70,40,${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * cw, Math.random() * ch, 1.5, 1.5);
    }
  } else {
    ctx.fillStyle = layer === 'bump' ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, cw, ch);
  }
  const ink = layer === 'color' ? INK : layer === 'bump' ? '#000000' : '#ffffff';
  const soft = layer === 'color' ? 'rgba(38,42,47,0.62)' : layer === 'bump' ? '#555555' : 'rgba(255,255,255,0.55)';
  const pad = Math.round(cw * 0.1);
  const half = ch / 2;

  // border groove
  ctx.strokeStyle = layer === 'glow' ? 'rgba(255,255,255,0.35)' : soft;
  ctx.lineWidth = 5;
  ctx.strokeRect(pad * 0.45, pad * 0.45, cw - pad * 0.9, ch - pad * 0.9);

  // top half: company name + mechanism
  ctx.fillStyle = ink;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const nameSize = Math.round(Math.min(74, cw * 0.15));
  ctx.font = `600 ${nameSize}px ${TEXT}`;
  const lines = wrap(ctx, spec.name, cw - pad * 2, 3);
  let y = pad * 1.05;
  for (const ln of lines) { ctx.fillText(ln, pad, y); y += nameSize * 1.08; }
  ctx.fillStyle = soft;
  ctx.font = `500 ${Math.round(nameSize * 0.5)}px ${TEXT}`;
  const sub = spec.role === 'baseline' ? 'hiring filter pick' : spec.role === 'trigger' ? 'the change' : mechWord(spec.mechanism);
  ctx.fillText(sub, pad, Math.min(y + nameSize * 0.25, half - nameSize * 0.8));

  // centre rule + spinner, the domino's divider
  ctx.strokeStyle = ink; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(pad * 0.9, half); ctx.lineTo(cw - pad * 0.9, half); ctx.stroke();
  ctx.fillStyle = layer === 'color' ? '#9c7a3c' : ink;
  ctx.beginPath(); ctx.arc(cw / 2, half, Math.max(10, cw * 0.032), 0, Math.PI * 2); ctx.fill();

  // bottom half: key number + caption
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let numSize = Math.round(Math.min(ch * 0.27, cw * 0.62));
  ctx.font = `800 ${numSize}px ${DISPLAY}`;
  while (ctx.measureText(spec.keyNumber).width > cw - pad * 2 && numSize > 40) { numSize -= 6; ctx.font = `800 ${numSize}px ${DISPLAY}`; }
  ctx.fillText(spec.keyNumber, cw / 2, half + (ch / 2) * 0.46);
  ctx.fillStyle = soft;
  ctx.font = `500 ${Math.round(nameSize * 0.52)}px ${TEXT}`;
  ctx.fillText(spec.keyCaption, cw / 2, ch - pad * 1.25);
  return c;
}

export interface FaceTextures { map: THREE.Texture; bump: THREE.Texture; glow: THREE.Texture }

export function makeFace(spec: TileSpec, width: number): FaceTextures {
  const mk = (layer: Layer) => {
    const t = new THREE.CanvasTexture(draw(spec, width, layer));
    t.anisotropy = 8;
    if (layer === 'color') t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: mk('color'), bump: mk('bump'), glow: mk('glow') };
}

let slateCache: THREE.Texture | null = null;
export function slateTexture(): THREE.Texture {
  if (slateCache) return slateCache;
  const s = 1024;
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#7f8a92'; ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 60000; i++) {
    const v = 100 + Math.random() * 60;
    ctx.fillStyle = `rgba(${v},${v + 6},${v + 10},${Math.random() * 0.25})`;
    const r = Math.random() * 2.2;
    ctx.fillRect(Math.random() * s, Math.random() * s, r, r);
  }
  // faint cleavage streaks, like honed slate
  for (let i = 0; i < 70; i++) {
    ctx.strokeStyle = `rgba(40,48,54,${0.04 + Math.random() * 0.06})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    const y0 = Math.random() * s;
    ctx.beginPath(); ctx.moveTo(0, y0);
    ctx.bezierCurveTo(s * 0.3, y0 + (Math.random() - 0.5) * 80, s * 0.6, y0 + (Math.random() - 0.5) * 80, s, y0 + (Math.random() - 0.5) * 60);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 5);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  slateCache = t;
  return t;
}

let poolCache: THREE.Texture | null = null;
export function poolTexture(): THREE.Texture {
  if (poolCache) return poolCache;
  const s = 256;
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  poolCache = new THREE.CanvasTexture(c);
  return poolCache;
}
