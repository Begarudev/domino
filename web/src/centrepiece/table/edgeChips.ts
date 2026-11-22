// Edge chips: one short mechanism chip per line ("Talent drain 68%"), laid out in screen pixels so the
// type never shrinks below 14px, and placed so no chip touches another chip or a tile.
// The full sentence (GraphEdge.label) lives in the evidence drawer and in the hover/focus card.

export interface Box { x: number; y: number; w: number; h: number }
export interface Curve { x1: number; y1: number; x2: number; y2: number }
export interface ChipIn { id: string; text: string; curve: Curve }
export interface ChipOut { id: string; text: string; box: Box; ax: number; ay: number; offset: boolean }

export const CHIP_H = 28;          // px
export const CLEAR = 12;           // px clearance between a chip and any chip or tile
const CHAR_W = 7.7;                // px per character at 15px Archivo, wdth 82 (measured ~7.2, kept generous)
const CHIP_PADX = 20;

export const chipWidth = (text: string) => Math.ceil(text.length * CHAR_W + CHIP_PADX);

/** Point on the same cubic edgeGeometry draws: control points (x1+dx, y1) and (x2-dx, y2). */
export function pointOn(c: Curve, t: number) {
  const dx = (c.x2 - c.x1) * 0.5;
  const u = 1 - t;
  const bx = u * u * u * c.x1 + 3 * u * u * t * (c.x1 + dx) + 3 * u * t * t * (c.x2 - dx) + t * t * t * c.x2;
  const by = u * u * u * c.y1 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y2;
  return { x: bx, y: by };
}

const hits = (a: Box, b: Box, pad: number) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

// Fine steps along the line, nearest the middle first, so a chip finds a narrow clear gap between tiles.
const T_STEPS = Array.from({ length: 37 }, (_, i) => 0.05 + i * 0.025).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));
const Y_STEPS = [0, -1, 1, -2, 2, -3, 3];

/**
 * Greedy placement in priority order. Chips are in px; `toPx` maps viewBox units to px.
 * A chip that cannot be placed without touching something is left out (its line stays selectable).
 */
export function placeChips(
  chips: ChipIn[], tiles: Box[], toPx: (x: number, y: number) => { x: number; y: number },
  bounds: { w: number; h: number },
): { placed: ChipOut[]; dropped: string[] } {
  const taken: Box[] = [];
  const placed: ChipOut[] = [];
  const dropped: string[] = [];
  for (const c of chips) {
    const w = chipWidth(c.text);
    let best: ChipOut | null = null;
    search: for (const dy of Y_STEPS) {
      for (const t of T_STEPS) {
        const v = pointOn(c.curve, t);
        const a = toPx(v.x, v.y);
        const box = { x: a.x - w / 2, y: a.y - CHIP_H / 2 + dy * (CHIP_H + CLEAR), w, h: CHIP_H };
        if (box.x < 4 || box.y < 4 || box.x + w > bounds.w - 4 || box.y + CHIP_H > bounds.h - 4) continue;
        if (tiles.some((b) => hits(box, b, CLEAR))) continue;
        if (taken.some((b) => hits(box, b, CLEAR))) continue;
        best = { id: c.id, text: c.text, box, ax: a.x, ay: a.y, offset: dy !== 0 };
        break search;
      }
    }
    if (best) { taken.push(best.box); placed.push(best); } else dropped.push(c.id);
  }
  return { placed, dropped };
}
