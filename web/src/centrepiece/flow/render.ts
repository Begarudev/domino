// Canvas renderer for the talent-flow time-lapse. draw() is a pure function of (model, story second, view).
import { RIVER_MIN, dayAt, fmtDay, phaseAt, type FlowCompany, type FlowModel } from './model.ts';

export const C = {
  abyss: '#060b22',
  deep: '#0d1640',
  bone: '#ede6d6',
  ember: '#ffb23e',
  emberHot: '#ffe2a8',
  wound: '#ff4f7b',
  tide: '#6fe3ff',
  slate: '#9aa2c8',
  frost: '#b9c7ff',
};

export const FONT = "'Archivo Flow', 'Archivo', system-ui, sans-serif";
const FLIGHT_DAYS = 13;

export interface View {
  w: number; h: number; dpr: number; k: number; compact: boolean;
  rect: { x: number; y: number; w: number; h: number };
  filterView: boolean; hoverId: string | null; selId: string | null; reduced: boolean;
  slots: { x: number; y: number }[];         // landing points (left-middle) of letter sentences, CSS px in the canvas frame
  letterLeft: number;                        // x where the letter panel starts
}

export interface Frame {
  nodes: Map<string, { x: number; y: number; r: number }>;
  beads: Map<string, { x: number; y: number }>;   // evidence id -> screen point (finale)
  rivers: { key: string; edgeId: string | null; pts: [number, number][] }[];
  zoom: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeBack = (t: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const sineIO = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a)})`;
}

const sprites = new Map<string, HTMLCanvasElement>();
function glow(color: string): HTMLCanvasElement {
  let c = sprites.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, rgba(color, 1));
  gr.addColorStop(0.18, rgba(color, 0.55));
  gr.addColorStop(0.45, rgba(color, 0.12));
  gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  sprites.set(color, c);
  return c;
}

let bgCache: { key: string; c: HTMLCanvasElement } | null = null;
function background(w: number, h: number, dpr: number): HTMLCanvasElement {
  const key = `${w}x${h}@${dpr}`;
  if (bgCache?.key === key) return bgCache.c;
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = C.abyss;
  g.fillRect(0, 0, w, h);
  const gr = g.createRadialGradient(w * 0.52, h * 0.46, 0, w * 0.52, h * 0.46, Math.max(w, h) * 0.75);
  gr.addColorStop(0, 'rgba(26,40,110,0.55)');
  gr.addColorStop(0.5, 'rgba(14,22,68,0.35)');
  gr.addColorStop(1, 'rgba(3,6,20,0.9)');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < Math.round((w * h) / 3200); i++) {
    g.fillStyle = rgba(C.bone, 0.04 + r() * r() * 0.4);
    const s = r() < 0.94 ? 0.8 : 1.6;
    g.fillRect(r() * w, r() * h, s, s);
  }
  bgCache = { key, c };
  return c;
}

// quadratic curve between two points, always bowing the same way so flows swirl rather than cross
function ctrl(ax: number, ay: number, bx: number, by: number, bend = -0.22): [number, number] {
  const dx = bx - ax, dy = by - ay;
  return [(ax + bx) / 2 - dy * bend, (ay + by) / 2 + dx * bend];
}
function qpt(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, t: number): [number, number] {
  const u = 1 - t;
  return [u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by];
}

function cracks(seed: number): [number, number][][] {
  let s = Math.floor(seed * 1e9) || 1;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: [number, number][][] = [];
  for (let i = 0; i < 4; i++) {
    let a = (i / 4) * Math.PI * 2 + r() * 1.2;
    let x = (r() - 0.5) * 0.25, y = (r() - 0.5) * 0.25;
    const pts: [number, number][] = [[x, y]];
    for (let j = 0; j < 5; j++) {
      a += (r() - 0.5) * 1.1;
      const step = 0.16 + r() * 0.12;
      x += Math.cos(a) * step; y += Math.sin(a) * step;
      pts.push([x, y]);
    }
    out.push(pts);
  }
  return out;
}
const crackCache = new Map<string, [number, number][][]>();

export function nodeRadius(c: FlowCompany, k: number) {
  return k * (5 + 3.1 * Math.sqrt(c.headcount / 20));
}

function text(g: CanvasRenderingContext2D, str: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center') {
  g.font = font;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(6,11,34,0.85)';
  g.strokeText(str, x, y);
  g.fillStyle = color;
  g.fillText(str, x, y);
}

function pill(g: CanvasRenderingContext2D, str: string, x: number, y: number, k: number, color: string, alpha: number, sub?: string, anchor: 'center' | 'left' | 'right' = 'center') {
  g.font = `600 ${12.5 * k}px ${FONT}`;
  const w1 = g.measureText(str).width;
  let w2 = 0;
  if (sub) { g.font = `500 ${12.5 * k}px ${FONT}`; w2 = g.measureText(sub).width + 8 * k; }
  const pw = w1 + w2 + 18 * k, ph = 24 * k;
  if (alpha <= 0.01) return;
  if (anchor === 'left') x += pw / 2; else if (anchor === 'right') x -= pw / 2;
  g.globalAlpha = alpha;
  g.fillStyle = 'rgba(8,14,40,0.92)';
  g.strokeStyle = rgba(color, 0.7);
  g.lineWidth = 1;
  g.beginPath();
  g.roundRect(x - pw / 2, y - ph / 2, pw, ph, ph / 2);
  g.fill(); g.stroke();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.font = `700 ${12.5 * k}px ${FONT}`;
  g.fillStyle = color;
  g.fillText(str, x - pw / 2 + 9 * k, y + 0.5);
  if (sub) { g.font = `500 ${12.5 * k}px ${FONT}`; g.fillStyle = rgba(C.bone, 0.88); g.fillText(sub, x - pw / 2 + 9 * k + w1 + 8 * k, y + 0.5); }
  g.globalAlpha = 1;
}

export function draw(g: CanvasRenderingContext2D, m: FlowModel, s: number, v: View): Frame {
  const { w, h, k } = v;
  const day = dayAt(m, s);
  const phase = phaseAt(m, s);
  const frame: Frame = { nodes: new Map(), beads: new Map(), rivers: [], zoom: 1 };

  g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;

  // ---- camera ----
  const zt = clamp((s - m.sZoom) / (m.sLetter - m.sZoom));
  const ez = easeInOut(zt);
  const focus = m.focusId ? m.byId.get(m.focusId) : undefined;
  const Z = 1 + ez * 1.15;
  frame.zoom = Z;
  const base = (c: FlowCompany): [number, number] => [v.rect.x + c.x * v.rect.w, v.rect.y + c.y * v.rect.h];
  const fb = focus ? base(focus) : [w / 2, h / 2];
  const targetX = Math.min(v.letterLeft * 0.5, w * 0.3);
  const tx = fb[0] + (targetX - fb[0]) * ez, ty = fb[1] + (h * 0.5 - fb[1]) * ez;
  const P = (c: FlowCompany): [number, number] => { const b = base(c); return [(b[0] - fb[0]) * Z + tx, (b[1] - fb[1]) * Z + ty]; };
  const rz = Math.pow(Z, 0.75);

  // ---- background ----
  const bg = background(w, h, v.dpr);
  g.drawImage(bg, 0, 0, w, h);
  if (phase === 'freeze') {
    const ft = clamp((s - m.sFreeze) / 0.5) * (1 - clamp((s - m.sForward0 + 0.6) / 0.6));
    g.fillStyle = `rgba(150,190,255,${0.05 * ft})`;
    g.fillRect(0, 0, w, h);
  }

  const dimOf = (id: string) => {
    let a = 1;
    if (v.filterView && m.filterIds.has(id)) a *= 0.22;
    if (focus && id !== focus.id) a *= 1 - ez * 0.9;
    return a;
  };

  for (const c of m.companies) { const [x, y] = P(c); frame.nodes.set(c.id, { x, y, r: nodeRadius(c, k) * rz }); }
  const N = (id: string) => frame.nodes.get(id)!;

  g.globalCompositeOperation = 'lighter';

  // ---- cross-company links (displacement, contagion) ----
  for (const l of m.links) {
    const a = clamp((s - l.sAppear) / 0.8);
    if (a <= 0) continue;
    const A = N(l.from), B = N(l.to);
    const [cx, cy] = ctrl(A.x, A.y, B.x, B.y, 0.12);
    const col = l.mechanism === 'DISPLACEMENT' ? C.wound : C.slate;
    g.strokeStyle = rgba(col, 0.5 * a * Math.min(dimOf(l.from), dimOf(l.to)) + 0.05);
    g.lineWidth = 1.4 * k;
    g.setLineDash(l.mechanism === 'DISPLACEMENT' ? [7 * k, 6 * k] : [1.5 * k, 6 * k]);
    g.lineDashOffset = -s * 14 * k;
    g.beginPath();
    const steps = 40, upto = Math.round(steps * easeOut(a));
    for (let i = 0; i <= upto; i++) { const p = qpt(A.x, A.y, cx, cy, B.x, B.y, i / steps); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
    g.stroke();
    g.setLineDash([]);
  }

  // ---- trails and rivers ----
  for (const r of m.rivers) {
    const A = N(r.from), B = N(r.to);
    const [cx, cy] = ctrl(A.x, A.y, B.x, B.y);
    const arrived = r.moves.filter((mv) => mv.day <= day).length;
    const formDay = r.sForm < Infinity ? r.moves[Math.min(r.moves.length - 1, 2)].day : Infinity;
    const formed = day >= formDay && r.sForm < Infinity;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 48; i++) pts.push(qpt(A.x, A.y, cx, cy, B.x, B.y, i / 48));
    frame.rivers.push({ key: r.key, edgeId: r.edgeId, pts });
    const dim = Math.min(dimOf(r.from), dimOf(r.to));
    const path = () => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts) g.lineTo(p[0], p[1]); };
    if (arrived > 0 && !formed) {
      path();
      g.strokeStyle = rgba(C.ember, (0.12 + 0.12 * arrived) * dim);
      g.lineWidth = (1 + arrived * 0.8) * k;
      g.stroke();
      if (arrived >= 2) {
        const [mx, my] = pts[24];
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 0.9 * dim;
        const side = mx < cx ? -1 : 1;
        const al: CanvasTextAlign = side < 0 ? 'right' : 'left';
        text(g, `${arrived} serving moves`, mx + side * 12 * k, my - 8 * k, `650 ${12 * k}px ${FONT}`, rgba(C.ember, 0.95), al);
        text(g, `the rule needs ${RIVER_MIN} to call a drain`, mx + side * 12 * k, my + 8 * k, `450 ${11.5 * k}px ${FONT}`, rgba(C.slate, 0.95), al);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'lighter';
      }
    }
    if (formed) {
      const e = clamp((day - formDay) / 7) * dim;
      const thick = (1 + Math.min(arrived, 8) * 0.25) * rz;
      path();
      g.strokeStyle = rgba(C.ember, 0.09 * e); g.lineWidth = 26 * k * thick; g.stroke();
      g.strokeStyle = rgba(C.ember, 0.2 * e); g.lineWidth = 10 * k * thick; g.stroke();
      g.strokeStyle = rgba(C.emberHot, 0.9 * e); g.lineWidth = 2.4 * k * thick; g.stroke();
      g.setLineDash([2 * k, 16 * k]);
      g.lineDashOffset = -day * 9 * k;
      g.strokeStyle = rgba('#ffffff', 0.85 * e); g.lineWidth = 3 * k * thick; g.stroke();
      g.setLineDash([]);
      const spr = glow(C.ember);
      for (let i = 0; i < 18; i++) {
        const t = ((i / 18) + day * 0.045) % 1;
        const [x, y] = qpt(A.x, A.y, cx, cy, B.x, B.y, t);
        const sz = (10 + 8 * Math.sin(i * 2.3)) * k * thick;
        g.globalAlpha = e * 0.9;
        g.drawImage(spr, x - sz, y - sz, sz * 2, sz * 2);
      }
      g.globalAlpha = 1;
    }
  }

  // ---- move particles ----
  for (const mv of m.moves) {
    const dd = mv.day - day;
    const A = N(mv.from), B = N(mv.to);
    if (dd >= 0 && dd <= FLIGHT_DAYS) {
      const p = sineIO(1 - dd / FLIGHT_DAYS);
      const [cx, cy] = ctrl(A.x, A.y, B.x, B.y);
      const col = mv.serving ? C.ember : mv.afterFreeze ? C.frost : C.slate;
      const spr = glow(col);
      const dim = Math.min(dimOf(mv.from), dimOf(mv.to));
      const size = (mv.serving ? 20 : 12) * k * rz;
      const tail = mv.serving ? 12 : 6;
      const shimmer = phase === 'freeze' ? 0.75 + 0.25 * Math.sin(s * 9 + mv.day) : 1;
      for (let i = tail; i >= 0; i--) {
        const tp = p - i * 0.018;
        if (tp < 0) continue;
        const [x, y] = qpt(A.x, A.y, cx, cy, B.x, B.y, tp);
        const f = 1 - i / (tail + 1);
        g.globalAlpha = f * f * dim * shimmer * (mv.serving ? 1 : 0.85);
        const sz = size * (0.35 + 0.65 * f);
        g.drawImage(spr, x - sz, y - sz, sz * 2, sz * 2);
      }
      if (mv.serving) {
        const [x, y] = qpt(A.x, A.y, cx, cy, B.x, B.y, p);
        g.globalAlpha = dim;
        g.fillStyle = '#fff6e0';
        g.beginPath(); g.arc(x, y, 2.2 * k * rz, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    } else if (dd < 0 && dd > -5) {
      const t = -dd / 5;
      g.strokeStyle = rgba(mv.serving ? C.ember : C.slate, (1 - t) * (mv.serving ? 0.9 : 0.35) * dimOf(mv.to));
      g.lineWidth = 1.5 * k;
      g.beginPath(); g.arc(B.x, B.y, B.r + t * 18 * k, 0, Math.PI * 2); g.stroke();
    }
  }

  // ---- shocks (provider events) ----
  for (const sh of m.shocks) {
    const t = s - sh.s;
    if (t < 0) continue;
    const n = N(sh.companyId);
    for (let i = 0; i < 3; i++) {
      const tt = (t - i * 0.18) / 1.2;
      if (tt < 0 || tt > 1) continue;
      g.strokeStyle = rgba(C.wound, (1 - tt) * 0.8);
      g.lineWidth = 2 * k;
      g.beginPath(); g.arc(n.x, n.y, n.r + tt * 70 * k, 0, Math.PI * 2); g.stroke();
    }
  }

  // ---- nodes ----
  const needOf = new Map(m.needs.map((n) => [n.companyId, n]));
  for (const c of m.companies) {
    const n = N(c.id);
    const dim = dimOf(c.id);
    const need = needOf.get(c.id);
    const river = m.rivers.find((r) => r.from === c.id && r.sForm < Infinity);
    const crackT = need?.crack && river ? s - river.sForm : -1;
    const cracked = crackT >= 0;
    const beat = cracked ? 1 + 0.045 * Math.sin(s * 6.5) : 1;
    const R = n.r * beat;
    const gcol = cracked ? C.wound : C.bone;
    g.globalAlpha = (cracked ? 0.75 : 0.42) * dim;
    const gs = R * (cracked ? 5.5 : 4.2);
    g.drawImage(glow(gcol), n.x - gs, n.y - gs, gs * 2, gs * 2);
    g.globalAlpha = 1;

    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = (0.35 + 0.65 * dim) * (focus && c.id !== focus.id ? 1 - ez * 0.95 : 1);
    const cg = g.createRadialGradient(n.x - R * 0.35, n.y - R * 0.35, R * 0.1, n.x, n.y, R);
    cg.addColorStop(0, '#fffaf0');
    cg.addColorStop(1, cracked ? '#e9b9c2' : '#cfc6b3');
    g.fillStyle = cg;
    g.beginPath(); g.arc(n.x, n.y, R, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;

    if (cracked) {
      let cr = crackCache.get(c.id);
      if (!cr) { cr = cracks(c.seed); crackCache.set(c.id, cr); }
      const grow = clamp(crackT / 0.35);
      const pulse = 0.65 + 0.35 * Math.sin(s * 6.5);
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const pass of [0, 1]) {
        g.globalCompositeOperation = pass ? 'lighter' : 'source-over';
        g.strokeStyle = pass ? rgba(C.wound, 0.55 * pulse * dim) : rgba('#5a0f26', 0.95 * dim);
        g.lineWidth = (pass ? 3.2 : 1.7) * k * rz;
        for (const line of cr) {
          g.beginPath();
          const upto = Math.max(1, Math.round((line.length - 1) * grow));
          for (let i = 0; i <= upto; i++) { const [px, py] = line[i]; const x = n.x + px * R * 1.05, y = n.y + py * R * 1.05; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
          g.stroke();
        }
      }
      g.globalCompositeOperation = 'lighter';
      if (crackT < 1.1) {
        const t = crackT / 1.1;
        g.strokeStyle = rgba(C.wound, (1 - t) * 0.95);
        g.lineWidth = 3 * k * (1 - t) + 0.5;
        g.beginPath(); g.arc(n.x, n.y, R + easeOut(t) * 90 * k, 0, Math.PI * 2); g.stroke();
      }
    }
    g.globalCompositeOperation = 'source-over';
    if (v.selId === c.id || v.hoverId === c.id) {
      g.strokeStyle = rgba(C.bone, v.selId === c.id ? 0.95 : 0.55);
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(n.x, n.y, R + 6 * k, 0, Math.PI * 2); g.stroke();
    }

    // labels
    const la = (0.35 + 0.65 * dim) * clamp(s / 0.8) * (focus && c.id !== focus.id ? 1 - ez : 1);
    const preds = m.predictions.filter((p) => p.companyId === c.id);
    const placeE = preds.reduce((mx, p) => Math.max(mx, easeOut(clamp((s - p.sPlace) / 0.65))), 0);
    const predR = n.r + (need ? 26 : 18) * k * rz + Math.max(0, preds.length - 1) * 9 * k;
    const needE = need ? clamp((s - need.sBloom) / 0.5) : 0;
    const outer = Math.max(R, needE * (n.r + 12 * k * rz), placeE * predR);
    const ly = n.y + outer + 13 * k * Math.max(1, rz * 0.8);
    g.globalAlpha = la;
    const fs = 13.5 * k * Math.min(1.5, Math.max(1, rz * 0.85));
    g.font = `650 ${fs}px ${FONT}`;
    const nw = g.measureText(c.name).width;
    g.font = `450 ${fs * 0.82}px ${FONT}`;
    const hw = v.compact ? 0 : g.measureText(` ${c.headcount}`).width;
    text(g, c.name, n.x - hw / 2, ly, `650 ${fs}px ${FONT}`, rgba(C.bone, 0.95));
    if (!v.compact) text(g, `${c.headcount}`, n.x + nw / 2 - hw / 2 + 5 * k, ly + 0.5, `450 ${fs * 0.82}px ${FONT}`, rgba(C.slate, 0.9), 'left');
    let line = ly + fs * 1.3;
    if (need) {
      const bt = clamp((s - need.sBloom) / 0.5);
      if (bt > 0) {
        g.globalAlpha = la * bt;
        text(g, need.weak ? `${need.need}?` : need.need, n.x, line, `700 ${fs * 0.9}px ${FONT}`, need.weak ? rgba(C.wound, 0.6) : C.wound);
        line += fs * 1.2;
        if (!v.compact || (focus && c.id === focus.id && ez > 0.5)) {
        const ev = need.weak ? `${need.dated} dated row, needs 2 to act` : `${need.dated} dated rows${need.confidence !== null ? `, ${Math.round(need.confidence * 100)}% confidence` : ''}`;
        text(g, ev, n.x, line, `450 ${fs * 0.8}px ${FONT}`, rgba(C.slate, 0.95));
        line += fs * 1.15;
        }
      }
    }
    if (v.filterView && m.filterIds.has(c.id)) {
      g.globalAlpha = 0.85;
      text(g, 'a hiring filter finds this one', n.x, line, `italic 450 ${fs * 0.8}px ${FONT}`, rgba(C.slate, 1));
    }
    g.globalAlpha = 1;
  }

  // ---- need rings ----
  g.globalCompositeOperation = 'lighter';
  for (const need of m.needs) {
    const t = (s - need.sBloom) / 0.75;
    if (t <= 0) continue;
    const n = N(need.companyId);
    const dim = dimOf(need.companyId);
    const e = easeBack(clamp(t));
    const R = n.r + 12 * k * rz;
    const rr = R * (0.6 + 0.4 * e);
    g.strokeStyle = rgba(C.wound, (need.weak ? 0.35 : 0.9) * dim * clamp(t * 2));
    g.lineWidth = (need.weak ? 1.2 : 2.2) * k * rz;
    if (need.weak) g.setLineDash([3 * k, 4 * k]);
    g.beginPath(); g.arc(n.x, n.y, rr, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    if (t < 1.4) {
      g.strokeStyle = rgba(C.wound, (1 - t / 1.4) * 0.6 * dim);
      g.lineWidth = 6 * k;
      g.beginPath(); g.arc(n.x, n.y, rr + (t / 1.4) * 40 * k, 0, Math.PI * 2); g.stroke();
    }
    const total = need.dated + need.undated;
    for (let i = 0; i < total; i++) {
      const a = -Math.PI / 2 + ((i - (total - 1) / 2) * 0.32);
      const at = clamp((s - need.sBloom - 0.25 - i * 0.12) / 0.3);
      if (at <= 0) continue;
      const x = n.x + Math.cos(a) * rr, y = n.y + Math.sin(a) * rr;
      if (i < need.dated) {
        g.globalAlpha = at * dim;
        const sz = 9 * k * rz;
        g.drawImage(glow(C.wound), x - sz, y - sz, sz * 2, sz * 2);
        g.fillStyle = '#ffe3ea';
        g.beginPath(); g.arc(x, y, 2.4 * k * rz, 0, Math.PI * 2); g.fill();
      } else {
        g.globalAlpha = at * dim * 0.8;
        g.strokeStyle = rgba(C.wound, 0.9); g.lineWidth = 1.2 * k;
        g.beginPath(); g.arc(x, y, 2.6 * k * rz, 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  // ---- predictions: dashed halos at the freeze, solid when the dated outcome lands ----
  const onNode = new Map<string, number>();
  for (const p of m.predictions) {
    const t = (s - p.sPlace) / 0.65;
    if (t <= 0) continue;
    const n = N(p.companyId);
    const dim = dimOf(p.companyId);
    const slot = onNode.get(p.companyId) ?? 0;
    onNode.set(p.companyId, slot + 1);
    const R = n.r + (needOf.has(p.companyId) ? 26 : 18) * k * rz + slot * 9 * k;
    const e = easeOut(clamp(t));
    const rr = R * (1 + (1 - e) * 1.8);
    const col = p.by === 'domino' ? C.tide : C.slate;
    const landed = p.sLand !== null && s >= p.sLand;
    const missed = !landed && s >= m.sEnd && m.mode === 'replay';
    // falling streak just before the outcome lands
    if (p.sLand !== null && s >= p.sLand - 0.45 && s < p.sLand + 0.1) {
      const ft = clamp((s - (p.sLand - 0.45)) / 0.45);
      const yHead = -20 + (n.y - R + 20) * (ft * ft);
      const gr = g.createLinearGradient(n.x, yHead - 140 * k, n.x, yHead);
      gr.addColorStop(0, rgba(col, 0)); gr.addColorStop(1, rgba(col, 0.95));
      g.strokeStyle = gr; g.lineWidth = 3 * k;
      g.beginPath(); g.moveTo(n.x, yHead - 140 * k); g.lineTo(n.x, yHead); g.stroke();
      const sz = 16 * k;
      g.drawImage(glow(col), n.x - sz, yHead - sz, sz * 2, sz * 2);
    }
    g.globalAlpha = e * dim * (missed ? 0.4 : 1);
    g.strokeStyle = rgba(col, landed ? 1 : 0.85);
    g.lineWidth = (landed ? 2.6 : 1.6) * k * rz;
    if (!landed) {
      g.setLineDash(p.by === 'domino' ? [7 * k, 6 * k] : [2 * k, 5 * k]);
      g.lineDashOffset = s * (p.by === 'domino' ? 10 : -8) * k;
    }
    g.beginPath(); g.arc(n.x, n.y, rr, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    if (landed) {
      const lt = (s - p.sLand!) / 0.9;
      if (lt < 1) {
        g.strokeStyle = rgba(col, (1 - lt) * 0.9);
        g.lineWidth = 8 * k * (1 - lt) + 1;
        g.beginPath(); g.arc(n.x, n.y, rr + easeOut(lt) * 60 * k, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = (1 - lt) * 0.8 * dim;
        const gs = rr * 2.4;
        g.drawImage(glow(col), n.x - gs, n.y - gs, gs * 2, gs * 2);
      }
    }
    g.globalAlpha = 1;
  }
  g.globalCompositeOperation = 'source-over';
  // outcome pills (after halos so they sit on top)
  const pillDone = new Set<string>();
  for (const p of m.predictions) {
    const n = N(p.companyId);
    const dim = dimOf(p.companyId);
    const R = n.r + (needOf.has(p.companyId) ? 26 : 18) * k * rz;
    if (p.sLand !== null && s >= p.sLand && !pillDone.has(p.companyId)) {
      pillDone.add(p.companyId);
      const a = clamp((s - p.sLand) / 0.35) * (focus && p.companyId !== focus.id ? dim : 0.4 + 0.6 * dim);
      const label = p.outcomeDay !== null ? fmtDay(p.outcomeDay) : '';
      const what = p.outcome.replace(/\s\d{1,2} [A-Z][a-z]{2}$/, '');
      const isFocus = focus && p.companyId === focus.id && ez > 0.5;
      pill(g, label, n.x + (isFocus ? -R * 0.55 : R * 0.55), n.y - R * 0.85 - 6 * k, k, p.by === 'domino' ? C.tide : C.slate, a, what, isFocus ? 'right' : 'left');
    } else if (p.sLand === null && s >= m.sEnd && m.mode === 'replay' && !pillDone.has(p.companyId)) {
      pillDone.add(p.companyId);
      pill(g, 'no dated sign yet', n.x + R * 0.55, n.y - R * 0.85 - 6 * k, k, C.slate, clamp((s - m.sEnd) / 0.5) * 0.85 * dim * (1 - ez), undefined, 'left');
    }
  }

  // ---- finale: evidence beads and the threads to the letter ----
  if (m.letter && focus && s >= m.sLetter) {
    const n = N(focus.id);
    const ids: string[] = [];
    for (const st of m.letter.sentences) for (const e of st.evidence) if (!ids.includes(e.id)) ids.push(e.id);
    const br = n.r + 118 * k;
    ids.forEach((id, i) => {
      const a = ids.length === 1 ? -0.4 : -1.05 + (i / (ids.length - 1)) * 1.15;
      frame.beads.set(id, { x: n.x + Math.cos(a) * br, y: n.y + Math.sin(a) * br });
    });
    g.globalCompositeOperation = 'lighter';
    m.letter.sentences.forEach((st, si) => {
      const slot = v.slots[si];
      if (!slot || st.status !== 'cited') return;
      for (const e of st.evidence) {
        const b = frame.beads.get(e.id)!;
        const bt = clamp((s - (st.sStart - 0.35)) / 0.35);
        if (bt <= 0) continue;
        const [cx, cy] = [(b.x + slot.x) / 2, Math.min(b.y, slot.y) - 40 * k];
        const ft = clamp((s - st.sStart) / (st.sLand - st.sStart));
        g.strokeStyle = rgba(C.tide, 0.38 * bt);
        g.lineWidth = 1.2 * k;
        g.beginPath();
        const steps = 36, upto = Math.round(steps * easeInOut(ft));
        for (let i = 0; i <= upto; i++) { const p = qpt(b.x, b.y, cx, cy, slot.x, slot.y, i / steps); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
        g.stroke();
        if (ft > 0 && ft < 1) {
          const [hx, hy] = qpt(b.x, b.y, cx, cy, slot.x, slot.y, easeInOut(ft));
          const sz = 22 * k;
          g.drawImage(glow(C.tide), hx - sz, hy - sz, sz * 2, sz * 2);
        }
      }
    });
    ids.forEach((id) => {
      const b = frame.beads.get(id)!;
      const first = m.letter!.sentences.find((st) => st.evidence.some((e) => e.id === id))!;
      const bt = clamp((s - (first.sStart - 0.45)) / 0.35);
      if (bt <= 0) return;
      const sz = 16 * k * easeBack(bt);
      g.globalAlpha = bt;
      g.drawImage(glow(C.tide), b.x - sz, b.y - sz, sz * 2, sz * 2);
      g.fillStyle = '#e6fbff';
      g.beginPath(); g.arc(b.x, b.y, 3.2 * k, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    });
    g.globalCompositeOperation = 'source-over';
    ids.forEach((id) => {
      const b = frame.beads.get(id)!;
      const first = m.letter!.sentences.find((st) => st.evidence.some((e) => e.id === id))!;
      const ev = first.evidence.find((e) => e.id === id)!;
      const bt = clamp((s - (first.sStart - 0.3)) / 0.35);
      if (bt <= 0 || !ev.observedAt) return;
      g.globalAlpha = bt;
      text(g, fmtDay(Math.round(Date.parse(`${ev.observedAt}T00:00:00Z`) / 86400000)), b.x, b.y - 16 * k, `700 ${13 * k}px ${FONT}`, C.tide);
      g.globalAlpha = 1;
    });
  }

  return frame;
}
