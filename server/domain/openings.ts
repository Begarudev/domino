// Rule O1 (Search Desk), pure and deterministic. Spec: docs/CONTRACT.md "Search Desk" (fixed 14:08 IST, month-interval
// semantics refined 14:14 IST before any replay outcome was read).
//
// At company A (20–5,000 staff): >= 2 conclusive dated departures in role family F within 90 days, AND no dated
// replacement hire or job post for F at A within 30 days of the last departure -> predicted opening for F at A.
// Crustdata role dates are month-level, so every date is an interval [first, last] and a condition holds only when it
// holds for every day in the interval.
import type { IsoDate, ReplayOutcome, ReplayScore } from '../../shared/types.ts';
import type { Opening, OpeningReason, RoleFamily } from '../../shared/desk.ts';
import { ROLE_FAMILY_LABELS } from '../../shared/desk.ts';
import { companyNameKey, daysBetween, relatedDomains, shiftDays, stableId } from './facts.ts';

export const DRAIN_DAYS = 90;
export const REPLACEMENT_DAYS = 30;
export const OUTCOME_DAYS = 60;
export const ACQUIHIRE_DAYS = 120;
export const STALE_JOB_DAYS = 14;
export const MIN_STAFF = 20;
export const MAX_STAFF = 5_000;

export type Interval = [IsoDate, IsoDate];

const FAMILIES: [RoleFamily, RegExp][] = [
  ['inference', /\binference\b|\bserving\b/i],
  ['mlops', /\bml ?ops\b/i],
  ['ml_platform', /\b(?:ml|machine learning|ai) (?:platform|infrastructure|infra)\b|\bml systems\b|\bmodel deployment\b/i],
  ['gpu_llm_infra', /\bgpu\b|\bcuda\b|\bllm (?:infra(?:structure)?|platform|ops)\b|\bdistributed (?:training|inference)\b/i],
];
// Chip design and non-engineering roles share keywords ("GPU Logic Design", "Business Development – AI Infrastructure").
const HARDWARE = /\b(?:asic|rtl|physical design|gpu design|logic design|verification|silicon|hardware|layout|analog|chip|soc|timing|power)\b/i;
const NON_ENGINEERING = /\b(?:business development|marketing|sales|recruit\w*|account (?:executive|manager)|talent|ambassador|intern|sourcing|demand planner|partnerships?|go[- ]to[- ]market|gtm|strategy|supply chain|contractor)\b/i;

/** Role family of a title, or null when the title is not a recognised infra/serving engineering role. */
export function roleFamily(title: string | null | undefined): RoleFamily | null {
  if (!title || HARDWARE.test(title) || NON_ENGINEERING.test(title)) return null;
  return FAMILIES.find(([, pattern]) => pattern.test(title))?.[0] ?? null;
}

/** Title phrases a job search or person search should OR for a family. */
export const FAMILY_PHRASES: Record<RoleFamily, string[]> = {
  inference: ['inference', 'serving'],
  mlops: ['MLOps', 'ML Ops'],
  ml_platform: ['ML platform', 'machine learning platform', 'ML infrastructure', 'machine learning infrastructure', 'AI infrastructure', 'AI platform', 'ML systems'],
  gpu_llm_infra: ['GPU', 'CUDA', 'LLM infrastructure', 'LLM platform', 'distributed training'],
  backend_payments: ['payments engineer', 'backend engineer'],
};

/** A Crustdata month value ("2026-10-01T00:00:00") as the interval of days it can mean. */
export function monthInterval(value: string): Interval {
  const first = value.slice(0, 7) + '-01';
  const [y, m] = [Number(value.slice(0, 4)), Number(value.slice(5, 7))];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [first, last];
}

export interface DepartureFact {
  id: string;
  personKey: string;                 // stable per person, never shown
  companyId: string;                 // A
  companyName: string;
  role: string;
  roleFamily: RoleFamily | null;
  initial: string;
  left: Interval;                    // end of the role at A
  started: Interval;                 // start at the new employer
  toCompanyId: string | null;
  toCompanyName: string | null;
  toDomain?: string | null;
  fromDomain?: string | null;
  evidenceId: string;
}

export interface CompanyFacts {
  id: string;
  name: string;
  headcount: number | null;
  headcountChange90d?: number | null; // percent, from a dated timeseries
  headcountEvidenceId?: string | null;
  ambiguous?: boolean;
}

export interface ReplacementFact { companyId: string; roleFamily: RoleFamily; kind: 'job_post' | 'hire'; date: Interval; label: string; evidenceId: string }

export interface AcquisitionFact {
  acquirer: string; acquired: string; date: IsoDate; label: string; url: string | null; evidenceId: string | null;
  analystEntered?: boolean;
}

export interface RestructureFact { companyId: string; date: IsoDate; label: string; evidenceId: string }

export interface O1Input {
  asOf: IsoDate;
  runId: string;
  replay?: boolean;
  profileLagDays?: number;           // replay: a move is known only if its new start month ended this many days before asOf
  departures: DepartureFact[];
  companies: CompanyFacts[];
  replacements: ReplacementFact[];
  jobChecks: Record<string, { checkedAt: IsoDate | null; failed?: boolean }>; // per company id
  acquisitions: AcquisitionFact[];
  restructures?: RestructureFact[];
}

export interface O1Group {
  companyId: string; roleFamily: RoleFamily; conclusive: DepartureFact[]; unsettled: DepartureFact[];
}

const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && companyNameKey(a) === companyNameKey(b));
const monthLabel = (day: IsoDate) =>
  new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: IsoDate) =>
  new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Where an interval sits against the drain window (asOf − 90, asOf]. */
export function drainWindow(left: Interval, asOf: IsoDate): 'inside' | 'straddles' | 'outside' {
  const start = shiftDays(asOf, -DRAIN_DAYS);
  if (left[1] <= start || left[0] > asOf) return 'outside';
  return left[0] > start && left[1] <= asOf ? 'inside' : 'straddles';
}

/** Departures that count for O1, grouped by company and family. Departures whose move is not yet known are dropped. */
export function groupDepartures(input: Pick<O1Input, 'asOf' | 'departures' | 'profileLagDays'>): O1Group[] {
  // Live: a profile that lists the new role already proves the move. Replay: the new start month must have ended
  // profileLagDays before the cutoff, so a later profile update cannot leak in.
  const known = input.profileLagDays != null ? shiftDays(input.asOf, -input.profileLagDays) : input.asOf;
  const lagged = input.profileLagDays != null;
  const groups = new Map<string, O1Group>();
  const seen = new Set<string>();
  for (const departure of input.departures) {
    if (!departure.roleFamily || departure.left[0] > known || (lagged ? departure.started[1] > known : departure.started[0] > known)) continue;
    if (departure.toCompanyId && departure.toCompanyId === departure.companyId) continue;
    if (relatedDomains(departure.fromDomain, departure.toDomain)) continue;        // internal move between related domains
    const key = `${departure.companyId}|${departure.roleFamily}`;
    if (seen.has(key + '|' + departure.personKey)) continue;
    const where = drainWindow(departure.left, input.asOf);
    if (where === 'outside') continue;
    seen.add(key + '|' + departure.personKey);
    const group = groups.get(key) ?? { companyId: departure.companyId, roleFamily: departure.roleFamily, conclusive: [], unsettled: [] };
    (where === 'inside' ? group.conclusive : group.unsettled).push(departure);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function confidence(conclusive: number, provisional: boolean) {
  // 2 conclusive departures -> 0.62, 3 -> 0.74, 4+ -> 0.80; a still-open replacement window costs 0.1.
  const base = Math.min(0.8, 0.5 + 0.12 * (conclusive - 1));
  return Math.round((provisional ? base - 0.1 : base) * 100) / 100;
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

export interface O1Result { openings: Opening[]; skipped: { companyId: string; roleFamily: RoleFamily; reason: string }[] }

export function detectOpenings(input: O1Input): O1Result {
  const companies = new Map(input.companies.map(company => [company.id, company]));
  const openings: Opening[] = [];
  const skipped: O1Result['skipped'] = [];
  for (const group of groupDepartures(input)) {
    const company = companies.get(group.companyId);
    const all = [...group.conclusive, ...group.unsettled].sort((a, b) => a.left[0].localeCompare(b.left[0]));
    const headcount = company?.headcount ?? null;
    if (headcount != null && (headcount < MIN_STAFF || headcount > MAX_STAFF)) {
      skipped.push({ companyId: group.companyId, roleFamily: group.roleFamily, reason: `${headcount} staff is outside 20–5,000` });
      continue;
    }
    const name = company?.name ?? all[0].companyName;
    const family = group.roleFamily;
    const familyLabel = ROLE_FAMILY_LABELS[family];
    const lastLeft = group.conclusive.map(d => d.left[1]).sort().at(-1) ?? all.map(d => d.left[1]).sort().at(-1)!;
    const lastLeftStart = (group.conclusive.length ? group.conclusive : all).map(d => d.left[0]).sort().at(-1)!;
    const destinations = [...new Set(all.map(d => d.toCompanyName).filter((n): n is string => Boolean(n)))];
    const settledTo = [...new Set(group.conclusive.map(d => d.toCompanyName).filter((n): n is string => Boolean(n)))];
    const drainLabel = !group.conclusive.length ? `${group.unsettled.length} ${familyLabel} departures, each in a month that straddles the 90-day edge` :
      `${group.conclusive.length} ${familyLabel} ${group.conclusive.length === 1 ? 'person' : 'people'} left ` +
      `${[...new Set(group.conclusive.map(d => monthLabel(d.left[0])))].join(' and ') || '—'}` +
      `${settledTo.length ? ` (to ${settledTo.join(', ')})` : ''}` +
      (group.unsettled.length ? `; ${group.unsettled.length} more with a month that straddles the 90-day edge` : '');
    const reasons: OpeningReason[] = [{ kind: 'talent_drain', label: drainLabel, evidenceId: (group.conclusive.at(-1) ?? all.at(-1)!).evidenceId,
      date: lastLeft > input.asOf ? input.asOf : lastLeft }, ...all.map(d => ({
      kind: 'talent_drain', date: d.left[1] > input.asOf ? input.asOf : d.left[1], evidenceId: d.evidenceId,
      label: `${d.initial} ${d.role} left ${monthLabel(d.left[0])} (month precision)${d.toCompanyName ? ` → ${d.toCompanyName}, from ${monthLabel(d.started[0])}` : ''}`,
    } satisfies OpeningReason))];
    const evidenceIds = new Set(all.map(d => d.evidenceId));
    const base = {
      id: stableId('op_', input.runId, group.companyId, family), companyId: group.companyId, companyName: name,
      roleFamily: family, roleTitle: mostCommon(all.map(d => d.role)), predictedAt: input.asOf, rule: 'O1' as const, runId: input.runId,
    };
    const finish = (opening: Omit<Opening, keyof typeof base | 'evidenceIds'>) =>
      openings.push({ ...base, ...opening, evidenceIds: [...evidenceIds] });

    if (group.conclusive.length < 2) {
      if (all.length >= 2) {
        finish({ status: 'held', confidence: 0, reasons, holdReasons: ['Month-only dates cannot settle the 90-day window'] });
      } else {
        finish({ status: 'watch', confidence: 0, reasons, watch: { have: group.conclusive.length, need: 2,
          reason: group.unsettled.length ? 'Its one departure month straddles the 90-day edge' : 'One departure so far' } });
      }
      continue;
    }

    // False-drain guards -> Hold.
    const hold: string[] = [];
    const firstLeft = all[0].left[0];
    for (const acquisition of input.acquisitions) {
      const closeInTime = Math.abs(daysBetween(acquisition.date, firstLeft)) <= ACQUIHIRE_DAYS ||
        Math.abs(daysBetween(acquisition.date, lastLeft)) <= ACQUIHIRE_DAYS;
      if (!closeInTime || !sameName(acquisition.acquired, name) ||
        !destinations.some(destination => sameName(destination, acquisition.acquirer))) continue;
      hold.push(`Acqui-hire: ${acquisition.label} (${dayLabel(acquisition.date)}${acquisition.analystEntered ? ', analyst-entered, with source' : ''})`);
      if (acquisition.evidenceId) {
        evidenceIds.add(acquisition.evidenceId);
        reasons.push({ kind: 'news', label: acquisition.label, date: acquisition.date, evidenceId: acquisition.evidenceId });
      }
    }
    if (company?.ambiguous) hold.push('Ambiguous company identity');
    if (headcount == null) hold.push('Company size unknown, so the 20–5,000 staff filter cannot be checked');
    if (headcount && all.length / headcount > 0.4) hold.push('Movers would be more than 40% of headcount');
    if (company?.headcountChange90d != null && company.headcountChange90d < -10) {
      hold.push(`Possible restructure: headcount down ${Math.abs(company.headcountChange90d).toFixed(1)}% over 90 days`);
      if (company.headcountEvidenceId) evidenceIds.add(company.headcountEvidenceId);
    }
    for (const restructure of input.restructures ?? []) {
      if (restructure.companyId !== group.companyId || Math.abs(daysBetween(restructure.date, lastLeft)) > DRAIN_DAYS) continue;
      hold.push(`Possible restructure: ${restructure.label} (${dayLabel(restructure.date)})`);
      evidenceIds.add(restructure.evidenceId);
    }
    if (hold.length) {
      finish({ status: 'held', confidence: 0, reasons, holdReasons: hold });
      continue;
    }

    // No-replacement leg: replacements dated in [first day of the last departure month, asOf].
    const replaced = input.replacements.filter(r => r.companyId === group.companyId && r.roleFamily === family &&
      r.date[1] >= lastLeftStart && r.date[0] <= input.asOf);
    if (replaced.length) {
      skipped.push({ companyId: group.companyId, roleFamily: family, reason: `Replacement found: ${replaced[0].label}` });
      continue;
    }
    const check = input.jobChecks[group.companyId];
    if (!check || check.failed || !check.checkedAt || daysBetween(check.checkedAt, input.asOf) > STALE_JOB_DAYS) {
      finish({ status: 'watch', confidence: 0, reasons, watch: { have: group.conclusive.length, need: group.conclusive.length,
        reason: "I can't verify no replacement was posted: the job search for this company failed or is more than 14 days old" } });
      continue;
    }
    const closes = shiftDays(lastLeft, REPLACEMENT_DAYS);
    const provisional = closes > input.asOf;
    reasons.push({
      kind: 'no_replacement', date: check.checkedAt, evidenceId: null,
      label: `No ${familyLabel} job post or hire at ${name} since ${dayLabel(lastLeftStart)} (checked ${dayLabel(check.checkedAt)})` +
        (provisional ? `; replacement window closes by ${dayLabel(closes)}` : ''),
    });
    finish({ status: 'open', confidence: confidence(group.conclusive.length, provisional), reasons,
      provisional, windowClosesBy: provisional ? closes : null });
  }
  const order = { open: 0, watch: 1, held: 2 };
  openings.sort((a, b) => order[a.status] - order[b.status] || b.confidence - a.confidence || a.companyName.localeCompare(b.companyName));
  return { openings, skipped };
}

/** A predicted opening is provisional while its no-replacement window is still open. */
export const isProvisional = (opening: Opening) => Boolean(opening.provisional);

export interface ScoreInput {
  asOf: IsoDate;
  openings: Opening[];
  universe: { id: string; name: string }[];           // companies 20–5,000 staff on asOf with a family departure
  outcomes: { companyId: string; roleFamily: RoleFamily | null; kind: 'job_post' | 'hire'; date: IsoDate; title: string; evidenceId: string }[];
  anyPostIds: string[];                                 // baseline: any job post in (asOf − 30, asOf]
  headcountIds: string[];                               // baseline: monthly headcount growth >= 30% as of asOf
  snapshotLabel: string;
}

/** Raw-count replay: outcome = a dated post or hire for the family at the company within 60 days after asOf. */
export function scoreOpenings(input: ScoreInput): ReplayScore {
  const horizonEnd = shiftDays(input.asOf, OUTCOME_DAYS);
  const inHorizon = input.outcomes.filter(o => o.date > input.asOf && o.date <= horizonEnd);
  const first = (companyId: string, family?: RoleFamily) => inHorizon
    .filter(o => o.companyId === companyId && o.roleFamily && (!family || o.roleFamily === family))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const lead = (date: IsoDate) => daysBetween(input.asOf, date);
  const median = (values: number[]) => values.length ? values.sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] : null;
  const arm = (hits: ({ date: IsoDate } | undefined)[], predicted: number) => {
    const found = hits.filter((hit): hit is { date: IsoDate } => Boolean(hit));
    return { predicted, hits: found.length, precision: predicted ? Math.round((found.length / predicted) * 100) / 100 : 0,
      medianLeadDays: median(found.map(hit => lead(hit.date))) };
  };
  const open = input.openings.filter(o => o.status === 'open');
  const settled = open.filter(o => !o.provisional);
  const dominoHits = open.map(o => first(o.companyId, o.roleFamily));
  const outcomes: ReplayOutcome[] = [];
  const byCompany = new Map<string, Set<ReplayOutcome['predictedBy']>>();
  const tag = (id: string, by: ReplayOutcome['predictedBy']) => byCompany.set(id, (byCompany.get(id) ?? new Set()).add(by));
  for (const o of open) tag(o.companyId, 'domino');
  for (const id of input.anyPostIds) tag(id, 'baseline_first_order');
  for (const id of input.headcountIds) tag(id, 'baseline_headcount');
  for (const [companyId, arms] of byCompany) {
    const opening = open.find(o => o.companyId === companyId);
    const hit = first(companyId, opening?.roleFamily) ?? (opening ? undefined : first(companyId));
    outcomes.push({ companyId, predictedBy: arms.size > 1 ? 'both' : [...arms][0], hit: Boolean(hit), outcomeDate: hit?.date ?? null,
      outcome: hit ? `${hit.kind === 'hire' ? 'hired' : 'posted'} “${hit.title}” ${hit.kind === 'hire' ? 'starting' : 'on'} ${dayLabel(hit.date)}` : 'no dated post or hire for the role family by ' + dayLabel(horizonEnd),
      evidenceIds: hit ? [hit.evidenceId] : [] });
  }
  const held = input.openings.filter(o => o.status === 'held').length;
  const base = input.universe.filter(company => first(company.id)).length;
  const domino = arm(dominoHits, open.length);
  return {
    asOf: input.asOf, horizonEnd, factsAfterAsOfUsed: 0,
    domino, baselineFirstOrder: arm(input.anyPostIds.map(id => first(id)), input.anyPostIds.length),
    baselineHeadcount: arm(input.headcountIds.map(id => first(id)), input.headcountIds.length),
    outcomes,
    note: `O1 predicted ${open.length} openings (${settled.length} settled, ${open.length - settled.length} provisional; ${held} held) and ${domino.hits} had a dated post or hire for the role family by ${dayLabel(horizonEnd)}. ` +
      `"Any job post in the last 30 days": ${input.anyPostIds.length} picks, ${input.anyPostIds.filter(id => first(id)).length} hits. ` +
      `"Headcount +30%": ${input.headcountIds.length} picks, ${input.headcountIds.filter(id => first(id)).length} hits. ` +
      `Base rate: ${base} of ${input.universe.length} cohort companies.` + (open.length === 0 ? ' O1 made no prediction at this cutoff, so it cannot beat a baseline here.' : ''),
    snapshotLabel: input.snapshotLabel,
    outcomeDefinition: 'A dated job post or hire whose title is in the predicted role family at the company within 60 days after the cutoff (baselines: any infra/serving family). Fixed 14:14 IST before outcomes were read.',
  };
}
