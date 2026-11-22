// Pure helpers for the Recruitment screen. Everything shown is read from the desk response: the rule's own clause
// text, its date math and its evidence rows. Nothing here invents a fact or a number.
import type { Evidence } from '../../../../shared/types.ts';
import type { CompanyDesk, Departure, Opening } from '../../data/desk.ts';
import { ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import { fmtDate, plural } from '../../lib/format.ts';

export type Clause = NonNullable<Opening['clauses']>[number];

/** 'ml_platform' -> 'ML platform' (the shared label, first segment only: "ML platform / ML infrastructure" is too long for a heading). */
export function familyLabel(f: string | null | undefined): string {
  if (!f) return 'all role families';
  const full = (ROLE_FAMILY_LABELS as Record<string, string>)[f] ?? f.replace(/_/g, ' ');
  return full.split(' / ')[0];
}

/** Evidence rows for a desk, by id. */
export function evidenceIndex(desk: CompanyDesk, extra: Evidence[] = []): Map<string, Evidence> {
  const m = new Map<string, Evidence>();
  for (const e of [...extra, ...(desk.evidence ?? [])]) m.set(e.id, e);
  return m;
}

/** A month-precision evidence row: the source flags it, or its claim says so. */
export function isMonthPrecision(e: Evidence | undefined | null): boolean {
  if (!e) return false;
  const p = (e as Evidence & { precision?: string }).precision;
  return p === 'month' || /month precision/i.test(e.claim);
}

/**
 * The month a person LEFT, as 'YYYY-MM'. The departure's own `date` is the start of the new role, so the leave month
 * comes from the cited row (its observedAt is the last day of the leave month at month precision). Falls back to the
 * departure date when the row isn't loaded.
 */
export function leaveMonth(d: Departure, ev: Map<string, Evidence>): string | null {
  const row = ev.get(d.evidenceId);
  const at = row?.observedAt ?? d.date;
  if (!at) return null;
  const monthly = d.precision === 'month' || isMonthPrecision(row);
  return monthly ? at.slice(0, 7) : at.slice(0, 10);
}

export interface DepartureRow { d: Departure; month: string | null; conclusive: boolean | null; reason: string | null }

/**
 * Departures for one opening's role family, each marked conclusive or struck. The verdict comes from the O1
 * departures clause: cited rows are in, and its detail names each row it struck ("Y. …, Aug 2026 → Patronus AI:
 * not conclusive, month straddles window start.").
 */
export function departureRows(desk: CompanyDesk, opening: Opening | null, ev: Map<string, Evidence>): DepartureRow[] {
  const list = opening ? desk.departures.filter((d) => d.roleFamily === opening.roleFamily) : desk.departures;
  const clause = opening?.clauses?.find((c) => c.id === 'o1.departures');
  const struck = new Map<string, string>(); // destination company -> reason
  for (const m of (clause?.detail ?? '').matchAll(/→\s*([^:.]+?):\s*not conclusive,\s*([^.]+)/g)) struck.set(m[1].trim(), m[2].trim());
  return list
    .map((d) => {
      const reason = d.toCompanyName ? struck.get(d.toCompanyName) ?? null : null;
      const conclusive = !clause ? null : reason ? false : clause.evidenceIds.includes(d.evidenceId) ? true : null;
      return { d, month: leaveMonth(d, ev), conclusive, reason };
    })
    .sort((a, b) => Number(b.conclusive === true) - Number(a.conclusive === true) || (b.month ?? '').localeCompare(a.month ?? ''));
}

/** "90-day window 25 Aug 2026–22 Nov 2026" from the departures clause, if it states one. */
export function windowText(opening: Opening | null): string | null {
  const m = opening?.clauses?.find((c) => c.id === 'o1.departures')?.detail?.match(/90-day window ([^;.]+)/);
  return m ? m[1].trim() : null;
}

/** The right-aligned count on a clause: when it ends, when it was checked, or how many records it cites. */
export function clauseCount(c: Clause, opening: Opening): { text: string; opens: boolean } {
  if (c.id.includes('window') && opening.windowClosesBy) return { text: `ends ${fmtDate(opening.windowClosesBy)}`, opens: true };
  const checked = c.detail?.match(/checked (\d{1,2} [A-Z][a-z]{2})/);
  if (checked) return { text: `checked ${checked[1]}`, opens: true };
  if (c.evidenceIds.length) return { text: plural(c.evidenceIds.length, 'record'), opens: true };
  return { text: 'no record found', opens: !!c.detail };
}

/** O1's own clauses first, then the false-drain guards. Engine order is kept inside each group. */
export function splitClauses(o: Opening): { rule: Clause[]; guards: Clause[] } {
  // An opening without clauses (an older snapshot) still shows its dated reasons, each opening its source.
  const all: Clause[] = o.clauses?.length ? o.clauses : o.reasons.map((r, i) => ({
    id: `reason.${i}`, text: r.label, state: 'met', detail: r.date ? `Dated ${fmtDate(r.date, true)}.` : undefined,
    evidenceIds: r.evidenceId ? [r.evidenceId] : [],
  }));
  return { rule: all.filter((c) => !c.id.startsWith('guard.')), guards: all.filter((c) => c.id.startsWith('guard.')) };
}

const GUARD_NAME: Record<string, string> = {
  'guard.acquihire': 'acqui-hire guard', 'guard.restructure': 'restructure guard', 'guard.size': 'size guard',
  'guard.parent': 'shared-parent guard', 'guard.ambiguous': 'ambiguous-company guard', 'guard.month': 'month-date guard',
  'guard.titles': 'unrecognised-title guard', 'guard.share': 'share-moving guard',
};
export const guardName = (id: string) => GUARD_NAME[id] ?? `${id.replace(/^guard\./, '').replace(/[_.]/g, ' ')} guard`;

/** The state chip in the opening header. */
export function stateChip(o: Opening): { cls: 'prov' | 'held' | 'verified' | 'plain'; text: string } {
  if (o.status === 'held') {
    const first = o.clauses?.find((c) => c.id.startsWith('guard.') && c.state === 'failed');
    return { cls: 'held', text: first ? heldChip(o) : 'Held' };
  }
  if (o.status === 'watch') return { cls: 'plain', text: o.watch ? `Watch · ${o.watch.have} of ${o.watch.need}` : 'Watch' };
  if (o.provisional || o.windowClosesBy) return { cls: 'prov', text: o.windowClosesBy ? `Provisional · window closes ${fmtDate(o.windowClosesBy)}` : 'Provisional' };
  return { cls: 'verified', text: 'Predicted opening' };
}

/** "ML Platform Engineer" -> "ML platform engineer" (sentence case for the serif title; acronyms kept). */
export function sentenceCase(s: string): string {
  return s.split(' ').map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) || /[()]/.test(w[0] ?? '') ? w : w.toLowerCase())).join(' ');
}

/** Rewrites ISO dates inside a server string ("as of 2026-11-22") into the screen's date format. */
export const prettyDates = (s: string) => s.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => fmtDate(iso, true));

export interface ProofStep { text: string; clauseId: string | null; tone: 'fact' | 'open' | 'held' }

/**
 * The decision as a dated timeline, read from its own clauses: left in Oct → no replacement through 22 Nov → window
 * closes 30 Nov. A held decision reads: left in Sep → acqui-hire report 21 Aug → held.
 */
export function proofSteps(o: Opening, rows: DepartureRow[]): ProofStep[] {
  const steps: ProofStep[] = [];
  const counted = rows.filter((r) => r.conclusive === true && r.month);
  if (counted.length) {
    const months = counted.map((r) => fmtDate(r.month!, false).split(' ')[0]);
    steps.push({ text: `${counted.length} left in ${[...new Set(months)].join(', ')}`, clauseId: 'o1.departures', tone: 'fact' });
  }
  if (o.status === 'held') {
    for (const c of (o.clauses ?? []).filter((x) => x.id.startsWith('guard.') && x.state === 'failed')) {
      const news = c.id === 'guard.acquihire' ? o.reasons.filter((r) => r.kind === 'news' && r.date).sort((a, b) => (a.date! < b.date! ? -1 : 1))[0] : null;
      steps.push({ text: news ? `Acqui-hire report ${fmtDate(news.date)}` : guardName(c.id).replace(/^./, (s) => s.toUpperCase()) + ' matched', clauseId: c.id, tone: 'held' });
    }
    steps.push({ text: 'Held, no opening predicted', clauseId: null, tone: 'held' });
    return steps;
  }
  const repl = (o.clauses ?? []).filter((c) => c.id.startsWith('o1.no_replacement'));
  if (repl.length && repl.every((c) => c.state === 'met')) {
    const checked = repl.map((c) => c.detail?.match(/checked (\d{1,2} [A-Z][a-z]{2})/)?.[1]).find(Boolean);
    steps.push({ text: `No post or hire${checked ? ` through ${checked}` : ''}`, clauseId: repl[0].id, tone: 'fact' });
  }
  if (o.windowClosesBy) steps.push({ text: `Window closes ${fmtDate(o.windowClosesBy)}`, clauseId: (o.clauses ?? []).find((c) => c.id.includes('window'))?.id ?? null, tone: 'open' });
  else if (o.status === 'open') steps.push({ text: 'Opening predicted', clauseId: null, tone: 'fact' });
  return steps;
}

/** "Held · acqui-hire and restructure guards" when more than one guard matched. */
export function heldChip(o: Opening): string {
  const names = (o.clauses ?? []).filter((c) => c.id.startsWith('guard.') && c.state === 'failed').map((c) => guardName(c.id).replace(/ guard$/, ''));
  if (!names.length) return 'Held';
  return names.length === 1 ? `Held · ${names[0]} guard` : `Held · ${names.slice(0, -1).join(', ')} and ${names.at(-1)} guards`;
}
