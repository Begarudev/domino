// Theme: Auto (system preference) by default, Light or Dark as an override, persisted in localStorage "domino-theme".
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'auto' | 'light' | 'dark';
const KEY = 'domino-theme';
let choice: ThemeChoice = (localStorage.getItem(KEY) as ThemeChoice | null) ?? 'auto';
const listeners = new Set<() => void>();

export function applyTheme(c: ThemeChoice = choice) {
  const root = document.documentElement;
  if (c === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', c);
}

export function setTheme(c: ThemeChoice) {
  choice = c;
  if (c === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, c);
  applyTheme(c);
  listeners.forEach((f) => f());
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f); }; }, () => choice);
}
