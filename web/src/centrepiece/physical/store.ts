// Tiny external store so the 3D director (useFrame) can drive the DOM HUD without re-rendering the scene.
import { useSyncExternalStore } from 'react';

export type Phase = 'idle' | 'predict' | 'replay' | 'score' | 'done';
export type TileStatus = 'standing' | 'predicted' | 'falling-hit' | 'hit' | 'miss' | 'fallen' | 'hypothesis';

export interface HudState {
  phase: Phase;
  day: number;                 // days after asOf shown on the clock (float)
  playing: boolean;
  status: Record<string, TileStatus>;   // tile key -> status
  arrived: Record<string, boolean>;     // edge id -> chain reached its target
  dominoHits: number;
  baselineHits: number;
  focusKey: string | null;
  scrubbable: boolean;
  runKey: number;
}

export function createHud(initial: HudState) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<HudState>) {
      state = { ...state, ...patch };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export type Hud = ReturnType<typeof createHud>;

export function useHud<T>(hud: Hud, sel: (s: HudState) => T): T {
  return useSyncExternalStore(hud.subscribe, () => sel(hud.get()), () => sel(hud.get()));
}
