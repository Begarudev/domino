import type { Intent, ReplayOutcome, ReplayScore, Target } from '../../shared/types.ts';
import { daysBetween, inWindow } from './facts.ts';
import { PROFILE_LAG_DAYS } from './replay-guard.ts';
import type { OutcomeFact } from './types.ts';

export function scoreReplay(intent: Intent, targets: Target[], baseline: { firstOrder: string[]; headcount: string[] },
  outcomes: OutcomeFact[]): ReplayScore {
  const horizonEnd = intent.horizonEnd ?? intent.asOf;
  const earliest = new Map<string, OutcomeFact>();
  for (const outcome of outcomes) {
    if (!inWindow(outcome.date, intent.asOf, horizonEnd) || !outcome.evidenceIds.length) continue;
    const previous = earliest.get(outcome.companyKey);
    if (!previous || outcome.date < previous.date || (outcome.date === previous.date && outcome.kind === 'job_post')) {
      earliest.set(outcome.companyKey, outcome);
    }
  }
  const late = targets.filter(target => target.whyNowDate && target.whyNowDate > intent.asOf);
  const dominoIds = new Set(targets.filter(target => !late.includes(target)).map(target => target.companyId));
  const firstIds = new Set(baseline.firstOrder);
  const headcountIds = new Set(baseline.headcount);
  const score = (companies: Set<string>) => {
    const leads = [...companies].flatMap(id => {
      const hit = earliest.get(id);
      return hit ? [daysBetween(intent.asOf, hit.date)] : [];
    }).sort((a, b) => a - b);
    const middle = Math.floor(leads.length / 2);
    const medianLeadDays = !leads.length ? null : leads.length % 2 ? leads[middle] : (leads[middle - 1] + leads[middle]) / 2;
    return { predicted: companies.size, hits: leads.length, precision: companies.size ? leads.length / companies.size : 0, medianLeadDays };
  };
  const rows: ReplayOutcome[] = [...new Set([...dominoIds, ...firstIds, ...headcountIds])].flatMap(companyId => {
    const outcome = earliest.get(companyId);
    const viaDomino = dominoIds.has(companyId);
    const viaFirst = firstIds.has(companyId);
    const viaHeadcount = headcountIds.has(companyId);
    const labels: ReplayOutcome['predictedBy'][] = viaDomino
      ? [viaFirst || viaHeadcount ? 'both' : 'domino'] : [
        ...(viaFirst ? ['baseline_first_order' as const] : []),
        ...(viaHeadcount ? ['baseline_headcount' as const] : []),
      ];
    return labels.map(predictedBy => ({
      companyId, predictedBy, hit: Boolean(outcome), outcomeDate: outcome?.date ?? null,
      outcome: outcome?.summary ?? 'No dated job post or hire was found in the horizon.',
      evidenceIds: outcome?.evidenceIds ?? [],
    }));
  });
  const domino = score(dominoIds);
  const baselineFirstOrder = score(firstIds);
  const baselineHeadcount = score(headcountIds);
  const result = (label: string, metric: typeof domino) => `${label} ${metric.hits}/${metric.predicted}`;
  const note = [
    `Dated job posts or hires through ${horizonEnd} validated ${result('DOMINO', domino)}, ${result('first-order', baselineFirstOrder)}, and ${result('headcount +30%', baselineHeadcount)} predictions.`,
    `Prediction inputs apply a ${PROFILE_LAG_DAYS}-day lag to profile-based hires and departures.`,
    ...(late.length ? [`Excluded ${late.length} supplied predictions with dates after the cutoff.`] : []),
  ].join(' ');
  return { asOf: intent.asOf, horizonEnd, factsAfterAsOfUsed: 0, domino, baselineFirstOrder, baselineHeadcount, outcomes: rows, note };
}
