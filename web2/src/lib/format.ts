// Every number on screen goes through here: rounded, grouped, never a raw float.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '–' : int.format(Math.round(n));
}

/** Credits: whole numbers; below 10 keep one decimal so 0.4 doesn't read as 0. */
export function fmtCredits(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n > 0 && n < 10) return (Math.round(n * 10) / 10).toString();
  return int.format(Math.round(n));
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${int.format(Math.round(n))}`;
}

export function fmtPct(fraction: number | null | undefined): string {
  return fraction == null || !Number.isFinite(fraction) ? '–' : `${Math.round(fraction * 100)}%`;
}

/** Signed percent from a percent value (not a fraction): -3.77 -> "−4%" */
export function fmtSignedPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '–';
  const r = Math.round(pct);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}%`;
}

export function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  return s < 1 ? 'under 1 s' : `${Math.round(s)} s`;
}

/** 204 -> "3:24" */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** '2026-10-27' -> '27 Oct'; '2026-11' -> 'Nov 2026'; withYear adds the year. */
export function fmtDate(iso: string | null | undefined, withYear = false): string {
  if (!iso) return 'undated';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (y && m && !d) return `${MONTHS[m - 1]} ${y}`;
  if (!y || !m) return iso;
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}
