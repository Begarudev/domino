import { fmtDate, fmtInt } from './format.ts';

/**
 * Server strings sometimes carry raw ISO dates and ungrouped numbers ("had 57473 employees on 2026-11-02",
 * "-3.7735849056603774% headcount growth"). Make them readable without changing their meaning.
 */
export function prettyText(s: string): string {
  return s
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => fmtDate(m, true))
    .replace(/(-?\d+\.\d{3,})%/g, (_m, n: string) => `${Math.round(Number(n))}%`)
    .replace(/\b(\d{5,})\b/g, (_m, n: string) => fmtInt(Number(n)));
}
