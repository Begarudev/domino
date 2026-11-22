import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { CascadeGraph, Company, Evidence, GraphEdge, GraphNode, Intent, Mechanism, Target, Trigger } from '../../shared/types.ts';
import { companyNameKey, daysBetween, inWindow, relatedDomains, shiftDays, stableId } from './facts.ts';
import { evidenceKnownAt, PROFILE_LAG_DAYS } from './replay-guard.ts';
import type { SellerProfile } from './types.ts';

const seller = sellerJson as SellerProfile;
const mechanisms = {
  TALENT_DRAIN: {
    base: 0.98, need: 'Help maintaining platform capacity after engineering turnover',
    rationale: 'Several role changes can leave fewer engineers to operate the recipient’s platform.',
    alternative: 'The moves may reflect a reorganized or deliberately smaller team with coverage already in place.',
  },
  DISPLACEMENT: {
    base: 0.95, need: 'A contingency plan for the existing inference integration',
    rationale: 'The employer named the product in a dated posting and a subsequent service change may affect the integration.',
    alternative: 'The integration may continue under the new terms or already have a migration plan.',
  },
  CONTAGION: {
    base: 0.86, need: 'Help scaling a comparable technical workload',
    rationale: 'A peer’s investment can expose infrastructure constraints at a similar company.',
    alternative: 'The peer may have a different roadmap, workload, or appetite for building in-house.',
  },
  DIRECT: {
    base: 0.74, need: 'Support for the work described in its job postings',
    rationale: 'Several dated technical postings point to investment in the corresponding workload.',
    alternative: 'The postings may be replacements for existing roles or reflect an in-house build decision.',
  },
} satisfies Record<Exclude<Mechanism, 'CAPITAL'>, { base: number; need: string; rationale: string; alternative: string }>;

type Rule = keyof typeof mechanisms;
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const round = (n: number) => Math.round(n * 100) / 100;
const currentTriggers = (intent: Intent, triggers: Trigger[]) => {
  const after = shiftDays(intent.asOf, -intent.windowDays);
  const profileCutoff = shiftDays(intent.asOf, -PROFILE_LAG_DAYS);
  return triggers.filter(trigger => inWindow(trigger.date, after, intent.asOf) &&
    (intent.runKind !== 'replay' || !['hire', 'departure'].includes(trigger.kind) || trigger.date <= profileCutoff));
};

function displayDay(date: string) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date));
}

function sameIndustry(a: Company, b: Company) {
  if (!a.industry || !b.industry || !a.headcount || !b.headcount) return false;
  return companyNameKey(a.industry) === companyNameKey(b.industry) &&
    Math.max(a.headcount, b.headcount) <= 3 * Math.min(a.headcount, b.headcount);
}

export function buildCascade(intent: Intent, triggers: Trigger[], companies: Company[], evidence: Evidence[]): CascadeGraph {
  const byId = new Map(companies.map(company => [company.id, company]));
  const rowById = new Map(evidence.filter(row => row.verifiable && row.observedAt && row.observedAt <= intent.asOf &&
    (intent.runKind !== 'replay' || evidenceKnownAt(row, intent.asOf))).map(row => [row.id, row]));
  const valid = currentTriggers(intent, triggers).filter(trigger => byId.has(trigger.companyId));
  const dateOf = (id: string) => rowById.get(id)?.observedAt ?? '';
  const datedIds = (ids: string[]) => unique(ids.filter(id => rowById.has(id)));
  const hasDatedFact = (trigger: Trigger) => trigger.evidenceIds.some(id => rowById.has(id));
  const jobCompanies = new Set(valid.filter(trigger => trigger.kind === 'job_post' && hasDatedFact(trigger)).map(trigger => trigger.companyId));
  const triggered = new Map<string, Trigger[]>();
  for (const trigger of valid) {
    const group = triggered.get(trigger.companyId) ?? [];
    group.push(trigger);
    triggered.set(trigger.companyId, group);
  }
  const edges: GraphEdge[] = [];
  const roots = new Set<string>();
  const funded = new Set<string>();
  const primary = new Map<string, string[]>();

  function add(rule: Rule, from: string, to: string, label: string, signals: Trigger[], key = '') {
    const ids = datedIds(signals.flatMap(trigger => trigger.evidenceIds));
    if (ids.length < 2) return;
    const { base, rationale, alternative } = mechanisms[rule];
    const capital = (triggered.get(to) ?? []).find(trigger => trigger.kind === 'funding' && hasDatedFact(trigger));
    const capitalIds = capital ? datedIds(capital.evidenceIds) : [];
    const adjustedBase = base + (capitalIds.length ? 0.05 : 0);
    if (capitalIds.length) funded.add(to);
    const observedAt = ids.map(dateOf).sort().at(-1)!;
    const age = daysBetween(observedAt, intent.asOf);
    // Confidence = mechanism base (+0.05 on dated capital) × (1−0.5^n) × 2^(−age/30).
    // n counts distinct dated supporting rows. Clamp to [0.05, 0.95] and round to two decimals.
    const saturation = 1 - 0.5 ** ids.length;
    const recency = 2 ** (-age / 30);
    const confidence = round(Math.max(0.05, Math.min(0.95, adjustedBase * saturation * recency)));
    edges.push({
      id: stableId('ed_', rule, from, to, key), from, to, mechanism: rule, label,
      rationale: rationale + (capitalIds.length ? ' Dated funding adds 0.05 to the mechanism base.' : '') +
        ` Confidence = ${adjustedBase.toFixed(2)} × (1 − 0.5^${ids.length}) × 2^(−${age}/30) = ${confidence.toFixed(2)}, clamped to 0.05–0.95.`,
      alternative, confidence, observedAt, evidenceIds: unique([...ids, ...capitalIds]), order: 0,
    });
    primary.set(to, unique([...(primary.get(to) ?? []), ...signals.map(trigger => trigger.id)]));
    roots.add(from);
  }

  for (const [companyId, group] of triggered) {
    const posts = group.filter(trigger => trigger.kind === 'job_post' && hasDatedFact(trigger));
    if (posts.length) roots.add(companyId);
    const hires = group.filter(trigger => trigger.kind === 'hire' && hasDatedFact(trigger) &&
      (!trigger.relatedCompanyId || (companyId !== trigger.relatedCompanyId &&
      !relatedDomains(byId.get(companyId)?.domain, byId.get(trigger.relatedCompanyId)?.domain))));
    if (hires.length) roots.add(companyId);
    add('DIRECT', companyId, companyId, `${posts.length} relevant job posting${posts.length === 1 ? '' : 's'}`, posts);

    const departures = new Map<string, Trigger>();
    for (const trigger of group) {
      const hirer = trigger.relatedCompanyId && byId.get(trigger.relatedCompanyId);
      const loser = byId.get(companyId);
      if (trigger.kind !== 'departure' || !hirer || !loser || hirer.id === companyId ||
        relatedDomains(hirer.domain, loser.domain) || !hasDatedFact(trigger)) continue;
      const identity = trigger.personId || trigger.evidenceIds.join('|');
      if (!departures.has(identity)) departures.set(identity, trigger);
    }
    if (departures.size >= 2) {
      const moves = [...departures.values()].sort((a, b) => a.date.localeCompare(b.date));
      const byHirer = new Map<string, number>();
      for (const move of moves) byHirer.set(move.relatedCompanyId!, (byHirer.get(move.relatedCompanyId!) ?? 0) + 1);
      const [hirer, count] = [...byHirer].sort(([a, first], [b, second]) => second - first || a.localeCompare(b))[0];
      const first = displayDay(moves[0].date);
      const last = displayDay(moves.at(-1)!.date);
      const when = first === last ? first : first + '–' + last;
      const destination = byId.get(hirer)!.name;
      const movement = count === moves.length ? ' for ' + destination : ', including ' + count + ' to ' + destination;
      add('TALENT_DRAIN', hirer, companyId, `${moves.length} engineering employees left${movement}, ${when}`, moves);
    }

    for (const post of group.filter(trigger => trigger.kind === 'post' && trigger.relatedCompanyId)) {
      const provider = post.relatedCompanyId!;
      const sellerEvidence = post.evidenceIds.some(id => rowById.get(id)?.source.provider === 'seller_profile');
      const publicMention = post.evidenceIds.some(id => rowById.get(id)?.source.field === '$.content.description');
      if (provider !== companyId && byId.has(provider) && sellerEvidence && publicMention) {
        add('DISPLACEMENT', provider, companyId, post.summary, [post], post.id);
      }
    }

    const technical = [...posts, ...hires];
    if (technical.length < 2) continue;
    const source = byId.get(companyId)!;
    for (const peer of companies) {
      if (peer.id === companyId || jobCompanies.has(peer.id) || relatedDomains(source.domain, peer.domain)) continue;
      if (source.competitorIds?.includes(peer.id) || peer.competitorIds?.includes(source.id) || sameIndustry(source, peer)) {
        add('CONTAGION', companyId, peer.id, `${source.name} showed ${technical.length} relevant hiring signals`, technical);
      }
    }
  }

  const bySource = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const outbound = bySource.get(edge.from) ?? [];
    outbound.push(edge);
    bySource.set(edge.from, outbound);
  }
  const distances = new Map<string, number>();
  const queue = [...roots].sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name));
  for (const id of queue) distances.set(id, 0);
  const ordered: GraphEdge[] = [];
  for (const id of queue) {
    const outbound = (bySource.get(id) ?? []).sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
    for (const edge of outbound) {
      ordered.push({ ...edge, order: ordered.length });
      if (distances.has(edge.to)) continue;
      distances.set(edge.to, distances.get(id)! + 1);
      queue.push(edge.to);
    }
  }

  const nodes: GraphNode[] = [];
  for (const company of companies) {
    const group = triggered.get(company.id) ?? [];
    const incoming = edges.filter(edge => edge.to === company.id).sort((a, b) => b.confidence - a.confidence);
    if (!group.length && !distances.has(company.id)) continue;
    const top = incoming[0];
    nodes.push({
      id: company.id, name: company.name, tier: distances.get(company.id) ?? 0,
      need: top ? intent.offering ? `Explore ${intent.offering}` : mechanisms[top.mechanism as Rule].need : null,
      confidence: top?.confidence ?? null,
      mechanisms: unique([...incoming.map(edge => edge.mechanism), ...(funded.has(company.id) ? ['CAPITAL' as const] : [])]),
      netNew: !jobCompanies.has(company.id),
      triggerIds: unique([...group.map(trigger => trigger.id), ...(primary.get(company.id) ?? [])]),
      evidenceIds: unique([...company.evidenceIds, ...group.flatMap(trigger => trigger.evidenceIds), ...incoming.flatMap(edge => edge.evidenceIds)])
        .filter(id => intent.runKind !== 'replay' || rowById.has(id)),
      status: top ? 'hypothesis' : 'unverifiable',
    });
  }
  nodes.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  return { nodes, edges: ordered };
}

export function rankTargets(intent: Intent, graph: CascadeGraph, companies: Company[], triggers: Trigger[]): {
  targets: Target[]; baseline: { hiringFilterCompanyIds: string[] };
} {
  const excludedNames = new Set([seller.company, ...seller.displacementEvents.map(event => event.provider)].map(companyNameKey));
  const excluded = new Set(graph.edges.filter(edge => edge.mechanism === 'DISPLACEMENT').map(edge => edge.from));
  for (const company of companies) {
    if ([company.name, ...company.aliases].some(name => excludedNames.has(companyNameKey(name)))) excluded.add(company.id);
  }
  const byCompany = new Map(companies.filter(company => !excluded.has(company.id)).map(company => [company.id, company]));
  const hiringFilterCompanyIds = unique(currentTriggers(intent, triggers).filter(trigger => trigger.kind === 'job_post' &&
    trigger.evidenceIds.length && byCompany.has(trigger.companyId)).map(trigger => trigger.companyId)).sort();
  const baseline = new Set(hiringFilterCompanyIds);
  const ranked = graph.nodes.flatMap(node => {
    const company = byCompany.get(node.id);
    if (!company || node.confidence == null || !node.need || node.status !== 'hypothesis') return [];
    const edge = graph.edges.filter(edge => edge.to === node.id).sort((a, b) => b.confidence - a.confidence || a.order - b.order)[0];
    if (!edge) return [];
    const age = edge.observedAt ? Math.max(0, daysBetween(edge.observedAt, intent.asOf)) : 90;
    const knownAI = /\b(?:ai|ml|artificial intelligence|machine learning|voice technology|data infrastructure)\b/i.test(company.industry ?? '');
    const industryFit = knownAI ? 1 : company.industry ? 0.5 : 0.7;
    const sizeFit = company.headcount != null ? company.headcount >= 20 && company.headcount <= 2000 ? 1 : 0.4 : 0.75;
    const score = node.confidence * industryFit * sizeFit * 2 ** (-age / 45);
    return [{ score, node, edge }];
  }).sort((a, b) => b.score - a.score || a.edge.order - b.edge.order || a.node.id.localeCompare(b.node.id));

  const targets = ranked.slice(0, intent.maxTargets).map(({ score, node, edge }, index): Target => ({
    companyId: node.id, rank: index + 1, score: round(score), confidence: node.confidence!,
    need: node.need!, mechanisms: node.mechanisms, netNew: !baseline.has(node.id),
    whyNow: edge.label, whyNowDate: edge.observedAt, decider: null, path: null, draftId: null,
  }));
  return { targets, baseline: { hiringFilterCompanyIds } };
}
