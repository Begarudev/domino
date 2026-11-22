const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-27' -> '27 Oct' (adds the year when it differs from `yearOf`) */
export function fmtDate(iso: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!iso) return 'undated';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]}${opts.year ? ` ${y}` : ''}`;
}

/** '27 Oct-12 Nov' or a single date when both ends match */
export function fmtRange(dates: (string | null | undefined)[]): string {
  const ds = dates.filter((d): d is string => !!d).sort();
  if (!ds.length) return 'undated';
  const a = ds[0], b = ds[ds.length - 1];
  return a === b ? fmtDate(a) : `${fmtDate(a)}-${fmtDate(b)}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function addDays(iso: string, days: number): string {
  const t = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

export function pct(n: number | null | undefined): string {
  return n == null ? '' : `${Math.round(n * 100)}`;
}
