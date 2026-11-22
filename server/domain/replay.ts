import type { Intent, ReplayOutcome, ReplayScore, Target } from '../../shared/types.ts';
import { daysBetween, DRAIN_OUTCOME_DAYS, formatDay, inWindow, servingTitle, shiftDays } from './facts.ts';
import { PROFILE_LAG_DAYS } from './replay-guard.ts';
import type { OutcomeFact } from './types.ts';

function outcomeTitle(outcome: OutcomeFact): string {
  return outcome.title ?? outcome.summary.match(/[“"]([^”"]+)[”"]/)?.[1] ??
    outcome.summary.replace(/^(?:posted|filled|hired)(?:\s+(?:a|an|as))?\s+/i, '').split(/\s+(?:on|role on)\s+/i)[0];
}

export function scoreReplay(intent: Intent, targets: Target[], baseline: { firstOrder: string[]; headcount: string[] },
  outcomes: OutcomeFact[]): ReplayScore {
  const horizonEnd = intent.horizonEnd ?? intent.asOf;
  const sixtyDays = shiftDays(intent.asOf, DRAIN_OUTCOME_DAYS);
  const drainEnd = sixtyDays <= horizonEnd ? sixtyDays : horizonEnd;
  const earliest = new Map<string, OutcomeFact>();
  const drainOutcomes = new Map<string, OutcomeFact>();
  const keepEarliest = (byCompany: Map<string, OutcomeFact>, outcome: OutcomeFact) => {
    const previous = byCompany.get(outcome.companyKey);
    if (!previous || outcome.date < previous.date || (outcome.date === previous.date && outcome.kind === 'job_post')) {
      byCompany.set(outcome.companyKey, outcome);
    }
  };
  for (const outcome of outcomes) {
    if (!inWindow(outcome.date, intent.asOf, horizonEnd) || !outcome.evidenceIds.length) continue;
    keepEarliest(earliest, outcome);
    if (outcome.date <= drainEnd && servingTitle(outcomeTitle(outcome))) keepEarliest(drainOutcomes, outcome);
  }

  const late = targets.filter(target => target.whyNowDate && target.whyNowDate > intent.asOf);
  const actionable = targets.filter(target => !target.hold && !target.watch && !late.includes(target));
  // Pre-registered protocol (README "Replay protocol"): the DOMINO arm is the accounts flagged by a CROSS-COMPANY rule;
  // first-order DIRECT picks belong to the hiring-filter baseline. Every arm uses the same outcome: a dated
  // serving/infra/ML-platform job post or hire within 60 days of the as-of date (capped at today).
  const crossCompany = (target: Target) => target.mechanisms.some(m => m === 'TALENT_DRAIN' || m === 'CONTAGION' || m === 'DISPLACEMENT');
  const dominoIds = new Set(actionable.filter(crossCompany).map(target => target.companyId));
  const firstIds = new Set(baseline.firstOrder);
  const headcountIds = new Set(baseline.headcount);
  const dominoOutcome = (id: string) => drainOutcomes.get(id);
  const standardOutcome = (id: string) => drainOutcomes.get(id);
  const score = (companies: Set<string>, findOutcome: (id: string) => OutcomeFact | undefined) => {
    const leads = [...companies].flatMap(id => {
      const hit = findOutcome(id);
      return hit ? [daysBetween(intent.asOf, hit.date)] : [];
    }).sort((a, b) => a - b);
    const middle = Math.floor(leads.length / 2);
    const medianLeadDays = !leads.length ? null : leads.length % 2 ? leads[middle] : (leads[middle - 1] + leads[middle]) / 2;
    return { predicted: companies.size, hits: leads.length, precision: companies.size ? leads.length / companies.size : 0, medianLeadDays };
  };
  const rows: ReplayOutcome[] = [...new Set([...dominoIds, ...firstIds, ...headcountIds])].flatMap(companyId => {
    const viaDomino = dominoIds.has(companyId);
    const viaFirst = firstIds.has(companyId);
    const viaHeadcount = headcountIds.has(companyId);
    const dominoFact = dominoOutcome(companyId);
    const baselineFact = standardOutcome(companyId);
    const comparable = dominoFact === baselineFact;
    const entries: { predictedBy: ReplayOutcome['predictedBy']; outcome?: OutcomeFact }[] = [];
    if (viaDomino) entries.push({ predictedBy: comparable && (viaFirst || viaHeadcount) ? 'both' : 'domino', outcome: dominoFact });
    if (!viaDomino || !comparable) {
      if (viaFirst) entries.push({ predictedBy: 'baseline_first_order', outcome: baselineFact });
      if (viaHeadcount) entries.push({ predictedBy: 'baseline_headcount', outcome: baselineFact });
    }
    return entries.map(({ predictedBy, outcome }) => ({
      companyId, predictedBy, hit: Boolean(outcome), outcomeDate: outcome?.date ?? null,
      outcome: outcome?.summary ?? 'No qualifying dated job post or hire was found in the horizon.',
      evidenceIds: outcome?.evidenceIds ?? [],
    }));
  });
  const domino = score(dominoIds, dominoOutcome);
  const baselineFirstOrder = score(firstIds, standardOutcome);
  const baselineHeadcount = score(headcountIds, standardOutcome);
  const result = (label: string, metric: typeof domino) => `${label} ${metric.hits}/${metric.predicted}`;
  const note = [
    `Qualifying outcomes for ${result('DOMINO', domino)}, ${result('first-order', baselineFirstOrder)}, and ${result('headcount +30%', baselineHeadcount)} picks.`,
    `Profile-based hires and departures enter predictions after a ${PROFILE_LAG_DAYS}-day lag.`,
    ...(late.length ? [`Excluded ${late.length} supplied predictions with dates after the cutoff.`] : []),
  ].join(' ');
  const snapshotLabel = `Not point-in-time: today's Crustdata index, filtered to facts dated on or before ${formatDay(intent.asOf)}`;
  const outcomeDefinition = `Every arm: a dated serving, infrastructure or ML-platform job post or hire at the account within ${DRAIN_OUTCOME_DAYS} days after ${formatDay(intent.asOf)} (by ${formatDay(drainEnd)}). DOMINO = accounts flagged by a cross-company rule; first-order DIRECT picks count in the hiring-filter baseline.`;
  return { asOf: intent.asOf, horizonEnd, factsAfterAsOfUsed: 0, domino, baselineFirstOrder, baselineHeadcount, outcomes: rows,
    note, snapshotLabel, outcomeDefinition };
}
