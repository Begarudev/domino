// "Why this target?" for a predicted opening: the O1 clauses that made it eligible, and the exact ranking rules that
// placed it. Ranking never uses a score (anti-wrapper rule 4); these are the same orders the API and the scan apply.
import type { CompanySummary, Opening, RankPlacement, RuleClause, WhyThisTarget } from '../../shared/desk.ts';

export const O1_STATEMENT = 'At company A (20–5,000 staff): at least 2 conclusive dated departures in role family F within 90 days, ' +
  'and no dated replacement hire or job post for F at A within 30 days of the last departure, predicts an opening for F at A. ' +
  'Guards (acqui-hire, shared parent, >40% of staff moving, ambiguous company, unsettled month dates, unrecognised titles, ' +
  'possible restructure) put it on Hold.';
export const OPENING_ORDER_RULE = 'Openings are ordered by status (open, then watch, then held), then company name A–Z. No score is used.';
export const COMPANY_ORDER_RULE = 'Companies are ordered by open predicted openings (most first), then departures in the 90-day window ' +
  '(most first), then name A–Z.';

const STATUS_ORDER = { open: 0, watch: 1, held: 2 } as const;
export const compareOpenings = (a: Opening, b: Opening) =>
  STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.companyName.localeCompare(b.companyName);
export const compareCompanies = (a: CompanySummary, b: CompanySummary) =>
  b.openings - a.openings || b.departures90d - a.departures90d || a.name.localeCompare(b.name);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function verdict(opening: Opening): string {
  if (opening.status === 'held') return `Held: not an opening (${(opening.holdReasons ?? []).join('; ') || 'a false-drain guard fired'})`;
  if (opening.status === 'watch') {
    return `Watch: ${opening.watch ? `${opening.watch.have} of ${opening.watch.need} conclusive departures` : 'not yet an O1 opening'}` +
      (opening.watch?.reason ? `; ${opening.watch.reason}` : '');
  }
  return opening.provisional ? `Open, provisional: the replacement window closes by ${opening.windowClosesBy ?? 'a later date'}`
    : 'Open: every O1 clause met';
}

// Older scans carry reasons but no clauses: one clause per reason, sourced if it cites a row.
function clausesOf(opening: Opening): RuleClause[] {
  if (opening.clauses?.length) return opening.clauses;
  return opening.reasons.map((reason, index) => ({
    id: `reason.${index}`, text: reason.label, state: reason.evidenceId ? 'met' : 'cant_verify', evidenceIds: reason.evidenceId ? [reason.evidenceId] : [],
  }));
}

export function whyThisTarget(opening: Opening, allOpenings: Opening[], companies: CompanySummary[]): WhyThisTarget {
  const ordered = [...allOpenings].sort(compareOpenings);
  const position = ordered.findIndex(item => item.id === opening.id) + 1;
  const sameStatusAhead = ordered.slice(0, position - 1).filter(item => item.status === opening.status).length;
  const aheadByStatus = ordered.slice(0, position - 1).length - sameStatusAhead;
  const ranking: RankPlacement = {
    position, of: ordered.length, rule: OPENING_ORDER_RULE,
    because: [
      `Status ${opening.status}` + (aheadByStatus ? `: ${plural(aheadByStatus, 'opening')} with a stronger status rank above it` : ': no opening has a stronger status'),
      sameStatusAhead ? `${plural(sameStatusAhead, opening.status + ' opening')} at companies earlier in A–Z order` : `First ${opening.status} opening in A–Z order`,
    ],
  };
  const sortedCompanies = [...companies].sort(compareCompanies);
  const index = sortedCompanies.findIndex(row => row.id === opening.companyId);
  const row = sortedCompanies[index];
  const companyRanking: RankPlacement = {
    position: index + 1, of: sortedCompanies.length, rule: COMPANY_ORDER_RULE,
    because: row ? [plural(row.openings, 'open predicted opening'), plural(row.departures90d, 'departure') + ' in the 90-day window'] : [],
  };
  return { rule: 'O1', statement: O1_STATEMENT, verdict: verdict(opening), eligibility: clausesOf(opening), ranking, companyRanking };
}
