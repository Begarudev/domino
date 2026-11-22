// Motion helpers shared by every v2 feature (adapted from theatre-smooth 27ce8d2, where they were measured).
// Transform/opacity only. Nothing here re-renders React per frame.
import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const FLIP_MS = 320;
const FLIP_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/matrix\(([^)]+)\)/);
  return m ? Number(m[1].split(',')[5]) || 0 : 0;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * FLIP the direct children of `ref` that carry `data-flip="<stable key>"`: when a commit moves them, each glides
 * from where it was to where it is, using transform only. A glide in flight is picked up from its current offset.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, enabled = true) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const next = new Map<string, number>();
    const moves: [HTMLElement, number][] = [];
    for (const el of Array.from(box.children) as HTMLElement[]) {
      const k = el.dataset.flip;
      if (!k) continue;
      const top = el.offsetTop;
      next.set(k, top);
      const prev = tops.current.get(k);
      if (enabled && prev !== undefined && Math.abs(prev - top) > 0.5) moves.push([el, prev - top]);
    }
    tops.current = next;
    if (!moves.length || reducedMotion()) return;
    const starts = moves.map(([el, d]) => {
      const flying = el.getAnimations().filter((a) => a.id === 'flip');
      const cur = flying.length ? translateY(el) : 0;
      return { el, flying, from: d + cur };
    });
    for (const { el, flying, from } of starts) {
      for (const a of flying) a.cancel();
      if (Math.abs(from) < 0.5) continue;
      const a = el.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], { duration: FLIP_MS, easing: FLIP_EASE });
      a.id = 'flip';
    }
  });
}

/**
 * Run an entrance exactly once for an element, on its first mount (never again on re-render or reorder).
 * Pass `settled` during catch-up bursts so a backlog lands without animating.
 */
export function useEnterOnce<T extends HTMLElement>(settled = false, keyframes: Keyframe[] = ENTER, ms = 340) {
  const ref = useRef<T>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    if (done.current) return;
    done.current = true;
    if (settled || reducedMotion() || !ref.current) return;
    ref.current.animate(keyframes, { duration: ms, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}
export const ENTER: Keyframe[] = [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }];

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** A number that eases to its new value. Writes textContent directly, so there's no React re-render per frame. */
export function Count({ value, format = (v) => String(Math.round(v)), ms = 600, className }: {
  value: number; format?: (v: number) => string; ms?: number; className?: string;
}) {
  const el = useRef<HTMLElement>(null);
  const shown = useRef(value);
  const fmt = useRef(format);
  fmt.current = format;
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const from = shown.current;
    if (from === value || reducedMotion()) { shown.current = value; node.textContent = fmt.current(value); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      shown.current = from + (value - from) * ease(t);
      node.textContent = fmt.current(shown.current);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return createElement('span', { ref: el, className, 'data-num': '' }, fmt.current(shown.current));
}

/** Hold each value for at least `ms` before showing the next; the newest wins when the hold ends. */
export function useDwell<T>(value: T, same: (a: T, b: T) => boolean, ms = 900): T {
  const [shown, setShown] = useState(value);
  const since = useRef(0);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (same(shown, value)) return;
    const wait = Math.max(0, since.current + ms - performance.now());
    const t = setTimeout(() => { since.current = performance.now(); setShown(latest.current); }, wait);
    return () => clearTimeout(t);
  }, [value, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

/** Once true, stays true: keeps a panel mounted between events instead of flashing its empty state. */
export function useSticky(on: boolean): boolean {
  const [stuck, setStuck] = useState(on);
  if (on && !stuck) setStuck(true);
  return stuck || on;
}
