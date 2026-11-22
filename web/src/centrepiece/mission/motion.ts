// Motion helpers that keep the theatre smooth when events arrive in bursts: transform-only FLIP for lists that
// reflow, an eased number that never re-renders React, and a dwell so a fast-changing line stays readable.
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

/**
 * FLIP the direct children of `ref` that carry `data-flip="<stable key>"`: when a commit moves them (a row added
 * above, a bottom-anchored list growing), each one glides from where it was to where it is, using transform only.
 * A glide already in flight is picked up from its current offset, so back-to-back events never snap.
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
    if (!moves.length) return;
    // Read every in-flight offset before writing anything, so the browser lays out once.
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

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** A number that eases to its new value instead of jumping. Writes textContent directly: no React re-render per frame. */
export function Count({ value, decimals = 0, ms = 600, className }: { value: number; decimals?: number; ms?: number; className?: string }) {
  const el = useRef<HTMLElement>(null);
  const shown = useRef(value);
  const fmt = (v: number) => (decimals ? String(+v.toFixed(decimals)) : String(Math.round(v)));
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const from = shown.current;
    if (from === value) { node.textContent = fmt(value); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { shown.current = value; node.textContent = fmt(value); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      shown.current = from + (value - from) * ease(t);
      node.textContent = fmt(shown.current);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return createElement('b', { ref: el, className }, fmt(shown.current));
}

/**
 * Hold each value on screen for at least `ms` before showing the next one; the newest value always wins when the
 * hold ends. Turns forty narration changes a second into one calm sentence at a time.
 */
export function useDwell<T>(value: T, same: (a: T, b: T) => boolean, ms: number): T {
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
