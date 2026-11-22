import type { Company, Decider, Intent, Person, Trigger, WarmPath } from '../../shared/types.ts';
import { companyNameKey, matchesDecider } from './facts.ts';
import type { SellerProfile } from './types.ts';

function priority(title: string, requested: string[]) {
  const slot = requested.findIndex(candidate => matchesDecider(title, [candidate]));
  if (matchesDecider(title, ['Head of ML Platform', 'Head of Infrastructure'])) return 0;
  if (matchesDecider(title, ['VP Engineering'])) return 3;
  if (matchesDecider(title, ['CTO'])) return 4;
  if (matchesDecider(title, ['Co-founder'])) return 5;
  return slot < 0 ? 6 : 1 + slot / Math.max(requested.length, 1);
}

export function pickDecider(intent: Intent, company: Company, candidates: Person[]): Decider | null {
  const top = candidates.filter(candidate => candidate.companyId === company.id && matchesDecider(candidate.title, intent.deciderTitles)
    && (!candidate.startedAt || candidate.startedAt <= intent.asOf))
    .sort((a, b) => priority(a.title, intent.deciderTitles) - priority(b.title, intent.deciderTitles) ||
      (a.startedAt ?? '9999-12-31').localeCompare(b.startedAt ?? '9999-12-31') || a.name.localeCompare(b.name))[0];
  if (!top) return null;
  const evidenceIds = [...new Set(top.evidenceIds)];
  const basis = evidenceIds.length ? ` (profile evidence ${evidenceIds.join(', ')})` : '';
  return {
    personId: top.id, name: top.name, title: top.title, tenureSince: top.startedAt, evidenceIds,
    reason: `${top.title} at ${company.name} is the closest match among the current roles found${basis}.`,
  };
}

export function findWarmPath(decider: Decider, person: Person, company: Company, seller: SellerProfile,
  triggers: Trigger[], companies: Company[]): WarmPath | null {
  if (person.id !== decider.personId || person.companyId !== company.id) return null;
  for (const past of person.pastEmployers) {
    const former = companies.find(item => item.id === past.companyId);
    const names = [past.name, ...(former?.aliases ?? [])].map(companyNameKey);
    for (const teammate of seller.team) {
      const overlap = teammate.pastEmployers.find(role => names.includes(companyNameKey(role.name)) &&
        role.from && role.to && past.from && past.to && role.from <= past.to && past.from <= role.to);
      if (overlap) return {
        strength: 'warm', score: 0.9, evidenceIds: person.evidenceIds,
        hops: [{ label: seller.company, kind: 'you' }, { label: teammate.name, kind: 'teammate' },
          { label: past.name, kind: 'shared_employer' }, { label: decider.name, kind: 'decider' }],
        explanation: `${teammate.name} and ${decider.name} were at ${past.name} during overlapping dates.`,
      };
    }
    const customer = past.to && seller.customers.find(name => names.includes(companyNameKey(name)));
    if (customer) return {
      strength: 'warm', score: 0.75, evidenceIds: person.evidenceIds,
      hops: [{ label: seller.company, kind: 'you' }, { label: customer, kind: 'customer' },
        { label: decider.name, kind: 'decider' }],
      explanation: `${decider.name} previously worked at ${customer}, an existing customer.`,
    };
  }
  const trigger = triggers.filter(item => item.companyId === company.id).sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    strength: 'cold', score: 0.25, evidenceIds: [...new Set([...(trigger?.evidenceIds ?? []), ...person.evidenceIds])],
    hops: [{ label: seller.company, kind: 'you' }, { label: 'via trigger', kind: 'trigger' }, { label: decider.name, kind: 'decider' }],
    explanation: `Reach out to ${decider.name} via the trigger at ${company.name}.`,
  };
}
