// Pure helpers for Outreach: which intro to show, the footnote map, the delivery steps. No React, no fetches.
import type { Evidence } from '../../../../shared/types.ts';
import type { IntroRequest } from '../../data/desk.ts';

/** Fields the intro may carry once the server exposes the draft (citations map, excluded claims, the honest label). */
export type IntroView = IntroRequest & {
  citations?: { marker: number; evidenceId: string }[];
  unverifiable?: { claim: string; reason: string }[];
  generatorLabel?: string | null;
  generator?: string | null;
};

/** One row per candidate (test runs can duplicate a fixture candidate), newest intro first. */
export function dedupeIntros(intros: IntroView[]): IntroView[] {
  const sorted = [...intros].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  const seen = new Set<string>();
  return sorted.filter((r) => (seen.has(r.candidateId) ? false : (seen.add(r.candidateId), true)));
}

/** Markers in the order they first appear in the message: "[1] … [3]" -> [1, 3]. */
export function markersIn(message: string): number[] {
  const out: number[] = [];
  for (const m of message.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * marker -> evidence ids. Uses the draft's own citations when the server sends them. Otherwise `evidenceIds` is the
 * flattened citation list in marker order, and only the first claim (the opening, cited by every drain row) can cite
 * more than one row (server/engine/candidate-steps.ts introClaims): marker 1 takes the surplus, later markers one each.
 */
export function citationMap(intro: IntroView): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (intro.citations?.length) {
    for (const c of intro.citations) map.set(c.marker, [...(map.get(c.marker) ?? []), c.evidenceId]);
    return map;
  }
  const markers = markersIn(intro.message);
  const ids = intro.evidenceIds ?? [];
  if (!markers.length || !ids.length) return map;
  const surplus = Math.max(1, ids.length - (markers.length - 1));
  map.set(markers[0], ids.slice(0, surplus));
  markers.slice(1).forEach((m, i) => { const id = ids[surplus + i]; if (id) map.set(m, [id]); });
  return map;
}

/** Split a paragraph into text and footnote markers. */
export type Piece = { text: string } | { marker: number };
export function pieces(paragraph: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of paragraph.matchAll(/\s?\[(\d+)\]/g)) {
    if (m.index! > last) out.push({ text: paragraph.slice(last, m.index) });
    out.push({ marker: Number(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < paragraph.length) out.push({ text: paragraph.slice(last) });
  return out;
}

/**
 * The header label. The server's own label wins. Without it we say what generated the text: intros are built from a
 * template today (draftIntro: generator 'template'), so we don't claim a model wrote them.
 */
export function draftLabel(intro: IntroView, verified: number): string {
  if (intro.generatorLabel) return intro.generatorLabel;
  const excluded = intro.unverifiable?.length ?? 0;
  const tail = `${verified} verified claim${verified === 1 ? '' : 's'}${excluded ? ` · ${excluded} excluded (can't verify)` : ''}`;
  return intro.generator?.startsWith('llm') ? `Drafted by GPT-6 Luna from ${tail}` : `Template from ${tail}`;
}

/** Month-precision rows show a month, never a day. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function isMonthly(ev: Evidence): boolean {
  if (ev.observedAt?.length === 7 || (ev as { precision?: string }).precision === 'month' || /month precision/i.test(ev.claim)) return true;
  // A profile row dated the 1st whose claim states only the month ("from Mar 2023") is month-level too.
  const m = ev.observedAt?.match(/^(\d{4})-(\d{2})-01/);
  return !!m && new RegExp(`\\b${MON[Number(m[2]) - 1]}\\w* ${m[1]}\\b`).test(ev.claim) && !new RegExp(`\\b0?1 ${MON[Number(m[2]) - 1]}`).test(ev.claim);
}

/** The chip says "month-level date"; the claim needn't repeat it. */
export const tidyClaim = (claim: string) => claim.replace(/\s*\(month precision\)/i, '');

export type StepKey = 'draft' | 'verified' | 'approved' | 'delivered';
export type StepState = 'done' | 'cur' | 'todo' | 'blocked';
export const STEP_LABEL: Record<StepKey, string> = { draft: 'Draft', verified: 'Verified', approved: 'Approved', delivered: 'Delivered once' };
export const STEP_CUR: Record<StepKey, string> = { draft: 'Drafting', verified: 'Checking sources', approved: 'Awaiting your approval', delivered: 'Delivering' };
