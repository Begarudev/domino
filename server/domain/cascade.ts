import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { CascadeGraph, Company, Evidence, GraphEdge, Intent, Mechanism, Target, Trigger } from '../../shared/types.ts';
import { companySegments, isGiant, isIcp, isRecruiter, isServicesCompany, looksLikeAiCompany } from './company-fit.ts';
import {
  companyNameKey, daysBetween, DRAIN_HISTORY_DAYS, DRAIN_REPLAY_HISTORY_DAYS, DRAIN_REPLAY_WINDOW_DAYS,
  DRAIN_WINDOW_DAYS, formatDay, formatMonth, inWindow, normalizeDomain, normalizeName, relatedDomains,
  servingTitleStatus, shiftDays, stableId,
} from './facts.ts';
import { evidenceKnownAt, PROFILE_LAG_DAYS } from './replay-guard.ts';
import type { MoveTrigger, ReasonedNode, ResolvedCompany, SellerProfile } from './types.ts';

const seller = sellerJson as SellerProfile;
const mechanisms = {
  TALENT_DRAIN: {
    base: 0.98, need: 'Serving staffing and capacity',
    rationale: 'Several employees previously held serving or ML infrastructure roles at the losing company.',
    alternative: 'The moves may reflect a reorganized or deliberately smaller team with coverage already in place.',
  },
  DISPLACEMENT: {
    base: 0.95, need: 'A contingency plan for the existing inference integration',
    rationale: 'The employer named the product in a dated posting and a service change may affect the integration.',
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
};

type Rule = keyof typeof mechanisms;
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const round = (n: number) => Math.round(n * 100) / 100;
const isMove = (trigger: Trigger) => trigger.kind === 'hire' || trigger.kind === 'departure';
const broadSegments = new Set(['ai', 'ml', 'artificial intelligence', 'machine learning', 'software development',
  'technology information and internet', 'information technology', 'information technology and services', 'technology']);

function currentTriggers(intent: Intent, triggers: Trigger[]) {
  const after = shiftDays(intent.asOf, -intent.windowDays);
  const profileCutoff = shiftDays(intent.asOf, -PROFILE_LAG_DAYS);
  return triggers.filter(trigger => inWindow(trigger.date, after, intent.asOf) &&
    (intent.runKind !== 'replay' || !isMove(trigger) || trigger.date <= profileCutoff));
}

function peerMatch(source: Company, peer: Company) {
  const listed = Number(Boolean(source.competitorIds?.includes(peer.id))) * 2 +
    Number(Boolean(peer.competitorIds?.includes(source.id)));
  const sameIndustry = Boolean(source.industry && peer.industry && normalizeName(source.industry) === normalizeName(peer.industry));
  const segments = new Set(companySegments(source));
  // A broad taxonomy tag alone cannot bridge otherwise different industries.
  const sharedSegments = [...new Set(companySegments(peer))].filter(segment => segments.has(segment) && !broadSegments.has(segment)).length;
  const min = Math.min(source.headcount ?? 0, peer.headcount ?? 0);
  const max = Math.max(source.headcount ?? 0, peer.headcount ?? 0);
  const sizeRatio = min > 0 ? max / min : Infinity;
  if (!listed && ((!sameIndustry && !sharedSegments) || sizeRatio > 2)) return null;
  const step = min < 100 ? 25 : 100;
  const lower = Math.floor(min / step) * step;
  const upper = Math.max(lower + step, Math.ceil(max / step) * step);
  const reason = listed ? 'listed competitor'
    : `${sameIndustry ? 'same segment' : 'shared category'}, ${lower}–${upper} staff`;
  return { listed, sameIndustry: Number(sameIndustry), sharedSegments, sizeRatio, reason };
}

function technicalRole(title: string): 'serving' | 'infra' | null {
  const status = servingTitleStatus(title);
  if (status === 'serving' || (status === 'unknown' && /\bgpus?\b/i.test(title))) return 'serving';
  if ((status === 'unknown' && /\b(?:infrastructure|infra|site reliability|platform engineer(?:ing)?)\b/i.test(title)) ||
    /^(?:senior |staff |principal )?sre$/i.test(title.trim())) return 'infra';
  return null;
}

function identifies(company: Company, ref: string, id?: number | string | null) {
  if (id != null && company.crustdataId != null) return String(company.crustdataId) === String(id);
  const domain = normalizeDomain(ref);
  if (domain && company.domain) return normalizeDomain(company.domain) === domain;
  return [company.name, ...company.aliases].some(name => companyNameKey(name) === companyNameKey(ref));
}

function sameCompanyIdentity(a: Company, b: Company) {
  return a.id === b.id || (a.crustdataId != null && b.crustdataId != null && String(a.crustdataId) === String(b.crustdataId));
}

function relationshipReasons(hirer: ResolvedCompany, loser: ResolvedCompany, date: string, asOf: string, fixture: boolean) {
  const reasons: string[] = [];
  const family = seller.companyFamilies?.some(group => {
    const entries = [group.parent, ...group.members];
    return entries.some(ref => identifies(hirer, ref)) && entries.some(ref => identifies(loser, ref));
  });
  if (sameCompanyIdentity(hirer, loser) || relatedDomains(hirer.domain, loser.domain) || family) reasons.push('Shared parent or related domains.');
  const acquisition = [...(seller.acquisitionEvents ?? []), ...(hirer.acquisitions ?? []), ...(loser.acquisitions ?? [])].find(event =>
    (!event.fixtureOnly || fixture) && (!event.date || event.date <= asOf) &&
    (!event.date || event.date <= shiftDays(date, DRAIN_WINDOW_DAYS)) &&
    identifies(hirer, event.acquirer, event.acquirerId) && identifies(loser, event.acquired, event.acquiredId));
  if (acquisition) reasons.push(`Acquisition or acqui-hire indicated for ${loser.name} and ${hirer.name}${acquisition.date ? ' on ' + formatDay(acquisition.date) : ''}.`);
  if (hirer.ambiguousIdentity || loser.ambiguousIdentity) reasons.push('Ambiguous company identity matched multiple candidate records.');
  return reasons;
}

type Supporting = {
  label: string; evidenceIds: string[]; confidence: number; observedAt: string; rationale: string; alternative: string;
};
type Candidate = {
  trigger: Trigger; person: string; hirer: Company; loser: Company; month: boolean; ambiguousDate: boolean;
  unknownTitle: boolean; conclusive: boolean; firstStart: string; lastStart: string;
  departedAt: string | null;
};

export function buildCascade(intent: Intent, triggers: Trigger[], companies: Company[], evidence: Evidence[]): CascadeGraph {
  const byId = new Map(companies.map(company => [company.id, company]));
  const rowById = new Map(evidence.filter(row => row.verifiable && row.observedAt && row.observedAt <= intent.asOf &&
    (intent.runKind !== 'replay' || evidenceKnownAt(row, intent.asOf))).map(row => [row.id, row]));
  const valid = currentTriggers(intent, triggers).filter(trigger => {
    const company = byId.get(trigger.companyId);
    return company && (trigger.kind !== 'job_post' || !isRecruiter(company));
  });
  const datedIds = (ids: string[]) => unique(ids.filter(id => rowById.has(id)));
  const hasDatedFact = (trigger: Trigger) => trigger.evidenceIds.some(id => rowById.has(id));
  const jobCompanies = new Set(valid.filter(trigger => trigger.kind === 'job_post' && hasDatedFact(trigger)).map(trigger => trigger.companyId));
  function technicalSignal(trigger: Trigger) {
    if (trigger.kind !== 'job_post' && trigger.kind !== 'hire') return null;
    const row = trigger.evidenceIds.map(id => rowById.get(id)).find(item =>
      item?.observedAt === trigger.date && (trigger.kind === 'job_post'
        ? item.source.field === '$.job_details.title' : item.source.field?.endsWith('.start_date')));
    if (!row) return null;
    const move = (trigger as MoveTrigger).move;
    const title = trigger.kind === 'hire' ? move?.currentTitle ?? row.value : row.value;
    if (typeof title !== 'string') return null;
    const kind = technicalRole(title);
    if (!kind) return null;
    const key = trigger.kind === 'hire' && trigger.personId ? 'hire:' + trigger.personId : row.id;
    return { trigger, kind, key };
  }

  const infrastructureJobCompanies = new Set(valid.filter(trigger => trigger.kind === 'job_post' && technicalSignal(trigger))
    .map(trigger => trigger.companyId));
  const triggered = new Map<string, Trigger[]>();
  for (const trigger of valid) {
    const group = triggered.get(trigger.companyId) ?? [];
    group.push(trigger);
    triggered.set(trigger.companyId, group);
  }
  const edges: GraphEdge[] = [];
  const roots = new Set<string>();
  const fundingByCompany = new Map(valid.filter(trigger => trigger.kind === 'funding' && hasDatedFact(trigger))
    .sort((a, b) => a.date.localeCompare(b.date)).map(trigger => [trigger.companyId, trigger]));
  const direct = new Map<string, Supporting>();
  const held = new Map<string, { reasons: string[]; triggers: Trigger[]; label: string }>();

  function qualify(rule: Rule, to: string, label: string, signals: Trigger[], context: Trigger[] = []): Supporting | null {
    const ids = datedIds(signals.flatMap(trigger => trigger.evidenceIds));
    if (ids.length < 2) return null;
    const { base, rationale, alternative } = mechanisms[rule];
    const capital = fundingByCompany.get(to);
    const adjustedBase = base + (capital ? 0.05 : 0);
    const observedAt = ids.map(id => rowById.get(id)!.observedAt!).sort().at(-1)!;
    const age = daysBetween(observedAt, intent.asOf);
    // Confidence = mechanism base (+0.05 on dated capital) × (1−0.5^n) × 2^(−age/30).
    // n counts distinct dated supporting rows. Clamp to [0.05, 0.95] and round to two decimals.
    const confidence = round(Math.max(0.05, Math.min(0.95, adjustedBase * (1 - 0.5 ** ids.length) * 2 ** (-age / 30))));
    return {
      label, confidence, observedAt, alternative,
      evidenceIds: unique([...ids, ...datedIds([...context, ...(capital ? [capital] : [])].flatMap(trigger => trigger.evidenceIds))]),
      rationale: rationale + (capital ? ' Dated funding adds 0.05 to the mechanism base.' : '') +
        ` Confidence = ${adjustedBase.toFixed(2)} × (1 − 0.5^${ids.length}) × 2^(−${age}/30) = ${confidence.toFixed(2)}, clamped to 0.05–0.95.`,
    };
  }

  function add(rule: Exclude<Rule, 'DIRECT'>, from: string, to: string, label: string, signals: Trigger[], context: Trigger[] = [], key = '') {
    if (from === to) return;
    const supported = qualify(rule, to, label, signals, context);
    if (!supported) return;
    edges.push({ id: stableId('ed_', rule, from, to, key), from, to, mechanism: rule, order: 0, ...supported });
    roots.add(from);
  }

  const replay = intent.runKind === 'replay';
  const windowStart = shiftDays(intent.asOf, -(replay ? DRAIN_REPLAY_WINDOW_DAYS : DRAIN_WINDOW_DAYS));
  const profileCutoff = shiftDays(intent.asOf, -PROFILE_LAG_DAYS);
  const historyStart = shiftDays(intent.asOf, -(replay ? DRAIN_REPLAY_HISTORY_DAYS : DRAIN_HISTORY_DAYS));
  const afterHistory = replay ? historyStart : shiftDays(historyStart, -1);
  const movesByPair = new Map<string, Map<string, Candidate>>();
  for (const trigger of triggers) {
    if (!isMove(trigger) || !trigger.relatedCompanyId || !inWindow(trigger.date, afterHistory, intent.asOf) ||
      (intent.runKind === 'replay' && trigger.date > profileCutoff)) continue;
    const hirer = byId.get(trigger.kind === 'hire' ? trigger.companyId : trigger.relatedCompanyId);
    const loser = byId.get(trigger.kind === 'hire' ? trigger.relatedCompanyId : trigger.companyId);
    if (!hirer || !loser || isGiant(loser)) continue;
    const rows = trigger.evidenceIds.flatMap(id => rowById.get(id) ?? []);
    const currentRole = rows.find(row => row.source.field?.endsWith('.start_date'));
    const previousRole = rows.find(row => row.source.field?.endsWith('.end_date'));
    const detail = (trigger as MoveTrigger).move;
    const currentTitle = detail?.currentTitle ?? String(currentRole?.value ?? '');
    const previousTitle = detail?.previousTitle ?? String(previousRole?.value ?? '');
    const month = detail?.datePrecision === 'month';
    const [firstStart, lastStart] = detail?.startInterval ?? [trigger.date, trigger.date];
    const oldTitle = servingTitleStatus(previousTitle);
    const newTitle = servingTitleStatus(currentTitle);
    if (oldTitle === 'excluded' || newTitle === 'excluded') continue;
    const unknownTitle = oldTitle === 'unknown' || newTitle === 'unknown';
    const ambiguousDate = month && (!detail?.startInterval || (firstStart <= windowStart && lastStart > windowStart) ||
      (firstStart <= historyStart && lastStart > historyStart));
    const earliestEnd = detail?.previousEndInterval?.[0] ?? previousRole?.observedAt;
    // Month-granular evidence records the latest plausible day. Window eligibility uses the interval.
    const datedMove = currentRole?.observedAt === lastStart && Boolean(earliestEnd && previousRole?.observedAt &&
      earliestEnd <= lastStart && daysBetween(earliestEnd, lastStart) <= 60);
    const qualifyingRole = datedMove && !unknownTitle;
    const conclusive = qualifyingRole && !ambiguousDate;
    const departedAt = qualifyingRole && firstStart >= historyStart && earliestEnd && earliestEnd >= historyStart
      ? previousRole?.observedAt ?? null : null;

    const person = trigger.personId || currentRole?.source.recordId || trigger.evidenceIds.join('|');
    if (!person) continue;
    const key = hirer.id + '|' + loser.id;
    const pair = movesByPair.get(key) ?? new Map<string, Candidate>();
    if (!pair.has(person) || trigger.kind === 'hire') {
      pair.set(person, { hirer, loser, person, trigger, month, ambiguousDate, unknownTitle, conclusive, firstStart, lastStart, departedAt });
    }
    movesByPair.set(key, pair);
  }

  const lostPeople = new Map<string, Set<string>>();
  for (const pair of movesByPair.values()) for (const move of pair.values()) {
    if (!move.conclusive || move.trigger.date <= historyStart || sameCompanyIdentity(move.hirer, move.loser) || relatedDomains(move.hirer.domain, move.loser.domain)) continue;
    const people = lostPeople.get(move.loser.id) ?? new Set<string>();
    people.add(move.person);
    lostPeople.set(move.loser.id, people);
  }

  for (const pair of movesByPair.values()) {
    const moves = [...pair.values()].filter(move => move.trigger.date > historyStart).sort((a, b) => a.trigger.date.localeCompare(b.trigger.date));
    if (moves.length < 3) continue;
    const { hirer, loser } = moves[0];
    const confirmed = moves.filter(move => move.conclusive);
    const threshold = confirmed[2]?.lastStart;
    const possible = moves.filter(move => move.conclusive || move.ambiguousDate || move.unknownTitle);
    const recent = threshold ? threshold > windowStart : possible.length >= 3 && possible[2].lastStart > windowStart;
    if (!recent) continue;
    const fixture = moves.some(move => move.trigger.evidenceIds.some(id => rowById.get(id)?.mode === 'fixture'));
    const reasons = relationshipReasons(hirer, loser, threshold ?? moves[2].trigger.date, intent.asOf, fixture);
    const count = lostPeople.get(loser.id)?.size ?? 0;
    if (loser.headcount && count / loser.headcount > 0.4) reasons.push(`Confirmed movers would account for more than 40% of ${loser.name}’s headcount.`);
    if (confirmed.length < 3 && possible.some(move => move.ambiguousDate)) reasons.push('month-only dates cannot settle the 30-day window');
    if (confirmed.length < 3 && possible.some(move => move.unknownTitle)) reasons.push('unrecognised titles');
    if (confirmed.length < 3 && !reasons.length) continue;
    if (reasons.length) {
      const previous = held.get(loser.id);
      held.set(loser.id, { label: `Review the role changes reported at ${hirer.name}`,
        reasons: unique([...(previous?.reasons ?? []), ...reasons]),
        triggers: [...(previous?.triggers ?? []), ...moves.map(move => move.trigger)],
      });
      continue;
    }
    if (loser.headcount == null) continue;
    const moveDate = (move: Candidate) => move.month ? formatMonth(move.firstStart) : formatDay(move.lastStart);
    const first = moveDate(confirmed[0]);
    const last = moveDate(confirmed.at(-1)!);
    const when = first === last ? first : first + '–' + last;
    add('TALENT_DRAIN', hirer.id, loser.id, `${confirmed.length} serving engineers left for ${hirer.name}, ${when}`, confirmed.map(move => move.trigger));
  }

  const watchByCompany = new Map<string, { reason: string; date: string; triggers: Trigger[] }>();
  if (!replay) {
    const confirmedDrains = new Set(edges.filter(edge => edge.mechanism === 'TALENT_DRAIN').map(edge => edge.to));
    const byLoser = new Map<string, Map<string, { date: string; trigger: Trigger }>>();
    for (const pair of movesByPair.values()) for (const move of pair.values()) {
      if (!move.departedAt || !isIcp(move.loser) || held.has(move.loser.id) || confirmedDrains.has(move.loser.id)) continue;
      const fixture = move.trigger.evidenceIds.some(id => rowById.get(id)?.mode === 'fixture');
      if (relationshipReasons(move.hirer, move.loser, move.lastStart, intent.asOf, fixture).length) continue;
      const people = byLoser.get(move.loser.id) ?? new Map<string, { date: string; trigger: Trigger }>();
      const prior = people.get(move.person);
      if (!prior || move.departedAt > prior.date) people.set(move.person, { date: move.departedAt, trigger: move.trigger });
      byLoser.set(move.loser.id, people);
    }
    for (const [id, people] of byLoser) {
      if (people.size !== 2) continue;
      const departures = [...people.values()].sort((a, b) => a.date.localeCompare(b.date));
      const months = unique(departures.map(move => formatMonth(move.date))).join(', ');
      watchByCompany.set(id, {
        reason: `2 of 3 serving departures seen (${months}); the card fires on the 3rd`,
        date: departures[1].date, triggers: departures.map(move => move.trigger),
      });
    }
  }

  for (const [companyId, group] of triggered) {
    const posts = group.filter(trigger => trigger.kind === 'job_post' && hasDatedFact(trigger));
    if (posts.length) roots.add(companyId);
    const source = byId.get(companyId)!;
    const hires = group.filter(trigger => {
      if (trigger.kind !== 'hire' || !hasDatedFact(trigger)) return false;
      const previous = trigger.relatedCompanyId && byId.get(trigger.relatedCompanyId);
      return !previous || !relationshipReasons(source, previous, trigger.date, intent.asOf,
        trigger.evidenceIds.some(id => rowById.get(id)?.mode === 'fixture')).length;
    });
    if (hires.length) roots.add(companyId);
    const directSignal = qualify('DIRECT', companyId, `${posts.length} relevant job postings`, posts);
    if (directSignal) direct.set(companyId, directSignal);
    for (const post of group.filter(trigger => trigger.kind === 'post' && trigger.relatedCompanyId)) {
      const provider = byId.get(post.relatedCompanyId!);
      const product = post.evidenceIds.map(id => rowById.get(id)).find(row => row?.source.field === '$.content.description');
      const event = post.evidenceIds.map(id => rowById.get(id)).find(row => row?.source.provider === 'seller_profile' &&
        seller.displacementEvents.some(configured => provider && identifies(provider, configured.provider) &&
          (!configured.fixtureOnly || row.mode === 'fixture') && row.source.url === configured.sourceUrl &&
          row.observedAt === configured.date && product?.value === configured.product));
      if (provider && product && event && !held.has(companyId)) add('DISPLACEMENT', provider.id, companyId, post.summary, [post], [], post.id);
    }
    if (isGiant(source) || isServicesCompany(source) || !looksLikeAiCompany(source)) continue;
    const technical = [...new Map([...posts, ...hires].flatMap(trigger => {
      const signal = technicalSignal(trigger);
      return signal ? [[signal.key, signal] as const] : [];
    })).values()];
    if (technical.length < 2 || !technical.some(signal => signal.kind === 'serving')) continue;
    const candidates = companies.flatMap(peer => {
      if (peer.id === companyId || held.has(peer.id) || infrastructureJobCompanies.has(peer.id) ||
        !isIcp(peer) || isServicesCompany(peer) || relatedDomains(source.domain, peer.domain)) return [];
      const similarity = peerMatch(source, peer);
      return similarity ? [{ peer, ...similarity }] : [];
    });
    const listedPeers = candidates.filter(match => match.listed);
    const peers = (listedPeers.length ? listedPeers : candidates).sort((a, b) => b.listed - a.listed ||
      b.sameIndustry - a.sameIndustry || b.sharedSegments - a.sharedSegments || a.sizeRatio - b.sizeRatio ||
      a.peer.name.localeCompare(b.peer.name) || a.peer.id.localeCompare(b.peer.id)).slice(0, 3);
    const funding = fundingByCompany.get(companyId);
    const fundingLabel = funding && source.lastFunding?.round
      ? ` and raised a ${source.lastFunding.round} on ${formatDay(funding.date)}` : '';
    const postCount = technical.filter(signal => signal.trigger.kind === 'job_post').length;
    const roleCount = technical.length - postCount;
    const activities = [
      ...(postCount ? [`posted ${postCount} serving or infrastructure ${postCount === 1 ? 'role' : 'roles'}`] : []),
      ...(roleCount ? [`made ${roleCount} serving or infrastructure ${roleCount === 1 ? 'hire' : 'hires'}`] : []),
    ];
    const activity = activities.join(' and ');
    for (const { peer, reason } of peers) {
      add('CONTAGION', companyId, peer.id,
        `Peer of ${source.name} (${reason}): ${source.name} ${activity}${fundingLabel}; no serving or infrastructure posts found for ${peer.name}`,
        technical.map(signal => signal.trigger), fundingLabel && funding ? [funding] : []);
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
    const outbound = bySource.get(id) ?? [];
    for (const edge of outbound) {
      ordered.push({ ...edge, order: ordered.length });
      if (distances.has(edge.to)) continue;
      distances.set(edge.to, distances.get(id)! + 1);
      queue.push(edge.to);
    }
  }

  const nodes: ReasonedNode[] = [];
  for (const company of companies) {
    const group = triggered.get(company.id) ?? [];
    const incoming = edges.filter(edge => edge.to === company.id);
    const directSignal = direct.get(company.id);
    const hold = held.get(company.id);
    const watch = watchByCompany.get(company.id);
    if (!group.length && !distances.has(company.id) && !hold && !watch) continue;
    const top = [...incoming, ...(directSignal ? [{ ...directSignal, mechanism: 'DIRECT' as const }] : [])]
      .sort((a, b) => b.confidence - a.confidence)[0];
    const nodeMechanisms: Mechanism[] = [
      ...incoming.map(edge => edge.mechanism),
      ...(jobCompanies.has(company.id) ? ['DIRECT' as const] : []),
      ...(fundingByCompany.has(company.id) ? ['CAPITAL' as const] : []),
      ...(hold || watch ? ['TALENT_DRAIN' as const] : []),
    ];
    nodes.push({
      id: company.id, name: company.name, tier: distances.get(company.id) ?? 0,
      need: watch ? 'Watchlist for serving staffing changes'
        : top ? mechanisms[top.mechanism as Rule].need : hold ? mechanisms.TALENT_DRAIN.need : null,
      confidence: hold ? null : watch ? round(0.35 * 2 ** (-daysBetween(watch.date, intent.asOf) / 30)) : top?.confidence ?? null,
      whyNow: hold?.label ?? watch?.reason ?? top?.label,
      whyNowDate: hold ? hold.triggers.filter(trigger => (trigger as MoveTrigger).move?.datePrecision !== 'month' && hasDatedFact(trigger))
        .map(trigger => trigger.date).sort().at(-1) ?? null : watch?.date ?? top?.observedAt,
      hold: hold ? { reasons: hold.reasons } : undefined,
      watch: watch ? { reason: watch.reason } : undefined,
      mechanisms: unique(nodeMechanisms), netNew: !jobCompanies.has(company.id),
      triggerIds: unique([...group, ...(hold?.triggers ?? []), ...(watch?.triggers ?? [])].map(trigger => trigger.id)),
      evidenceIds: unique([...company.evidenceIds, ...group.flatMap(trigger => trigger.evidenceIds), ...incoming.flatMap(edge => edge.evidenceIds),
        ...[...(hold?.triggers ?? []), ...(watch?.triggers ?? [])].flatMap(trigger => trigger.evidenceIds), ...(directSignal?.evidenceIds ?? [])])
        .filter(id => intent.runKind !== 'replay' || rowById.has(id)),
      status: (top || watch) && !hold ? 'hypothesis' : 'unverifiable',
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
  const byCompany = new Map(companies.filter(company => !excluded.has(company.id) && isIcp(company)).map(company => [company.id, company]));
  const hiringFilterCompanyIds = unique(currentTriggers(intent, triggers).flatMap(trigger => {
    const company = byCompany.get(trigger.companyId);
    return trigger.kind === 'job_post' && trigger.evidenceIds.length && company && !isRecruiter(company) ? [company.id] : [];
  })).sort();
  const baseline = new Set(hiringFilterCompanyIds);
  const ranked = (graph.nodes as ReasonedNode[]).flatMap(node => {
    const company = byCompany.get(node.id);
    if (!company || !node.need || (!node.hold && (node.confidence == null || node.status !== 'hypothesis'))) return [];
    const edge = graph.edges.filter(edge => edge.to === node.id).sort((a, b) => b.confidence - a.confidence || a.order - b.order)[0];
    const date = node.whyNowDate ?? edge?.observedAt ?? null;
    const age = date ? Math.max(0, daysBetween(date, intent.asOf)) : 90;
    const industryFit = looksLikeAiCompany(company) ? 1 : company.industry ? 0.5 : 0.7;
    const score = (node.confidence ?? 0) * industryFit * 2 ** (-age / 45);
    return [{ score, node, company, date, label: node.whyNow ?? edge?.label ?? node.need }];
  }).sort((a, b) => b.score - a.score || a.company.name.localeCompare(b.company.name));

  const actionable = ranked.filter(item => !item.node.hold && !item.node.watch).slice(0, intent.maxTargets);
  const watchlist = ranked.filter(item => item.node.watch).slice(0, intent.maxTargets);
  const holds = ranked.filter(item => item.node.hold).slice(0, intent.maxTargets);
  const targets = [...actionable, ...watchlist, ...holds].map(({ score, node, company, date, label }, index): Target => ({
    companyId: node.id, rank: index + 1, score: round(score), confidence: node.confidence ?? 0,
    need: node.need!, mechanisms: node.mechanisms, netNew: !baseline.has(node.id), hold: node.hold, watch: node.watch,
    testedClaim: node.mechanisms.includes('TALENT_DRAIN') && !node.hold && !node.watch
      ? `serving staffing activity at ${company.name} within 60 days (a dated hire or job post)` : undefined,
    whyNow: label, whyNowDate: date, decider: null, path: null, draftId: null,
  }));
  return { targets, baseline: { hiringFilterCompanyIds } };
}
