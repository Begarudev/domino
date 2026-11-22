// Theme: light only (Garud 17:17). The system dark preference and any saved choice are ignored; the dark tokens stay
// in tokens.css, scoped to data-theme="dark", which nothing sets. The API is kept so existing imports still compile.
import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'auto' | 'light' | 'dark';
const choice: ThemeChoice = 'light';

export function applyTheme() {
  document.documentElement.setAttribute('data-theme', 'light');
  try { localStorage.removeItem('domino-theme'); } catch { /* storage may be unavailable */ }
}

/** No-op: the theme is fixed to light. */
export function setTheme(_c: ThemeChoice) { applyTheme(); }

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(() => () => {}, () => choice);
}
