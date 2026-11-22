// Company dossier: the full company analysis for one company, shaped from a run snapshot. OWNER: lead.
import { ROLE_FAMILY_LABELS } from '../../shared/desk.ts';
import type { CompanyDossier, Departure, DossierRule, Opening, TalentFlow, WhyThisTarget } from '../../shared/desk.ts';
import type { Company, Evidence } from '../../shared/types.ts';
import type { CompanyFacts } from '../domain/openings.ts';
// companySummaries is the exact row set and order of GET /api/companies, so the placement quoted matches the list on screen.
import { companySummaries, openingsSnapshot } from './store.ts';
import { compareOpenings, whyThisTarget } from './why.ts';
import type { RunSnapshot } from '../../shared/types.ts';
import type { Store } from '../db.ts';
import { snapshot } from '../snapshot.ts';

const initialOf = (name: string | undefined) => {
  const first = name?.trim().split(/\s+/)[0]?.[0];
  return first ? `${first.toUpperCase()}.` : null;
};

export function dossier(snap: RunSnapshot, companyId: string, openings: Opening[] = []): CompanyDossier | null {
  const company = snap.companies.find(row => row.id === companyId || row.aliases.includes(companyId));
  if (!company) return null;
  const id = company.id;
  const nameOf = (other: string | null | undefined) => snap.companies.find(row => row.id === other)?.name ?? null;
  const people = new Map(snap.people.map(person => [person.id, person]));
  const triggers = snap.triggers.filter(row => row.companyId === id || row.relatedCompanyId === id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const event = (row: typeof triggers[number]) => ({ id: row.id, date: row.date, kind: row.kind, summary: row.summary, evidenceIds: row.evidenceIds });
  // One move appears twice (a hire at the new employer and a departure at the old one); keep it once.
  const seenMove = new Set<string>();
  const moves = triggers.filter(row => row.kind === 'hire' || row.kind === 'departure').filter(row => {
    const key = `${row.personId ?? row.id}|${row.date}`;
    if (seenMove.has(key)) return false;
    seenMove.add(key);
    return true;
  });
  const monthIds = new Set(snap.evidence.filter(row => row.precision === 'month').map(row => row.id));
  const talentFlows: TalentFlow[] = moves.map(row => {
    const person = row.personId ? people.get(row.personId) : undefined;
    // A hire trigger sits on the hiring company; a departure trigger on the company that lost the person.
    const joinedHere = row.kind === 'hire' ? row.companyId === id : row.relatedCompanyId === id;
    return {
      direction: joinedHere ? 'in' : 'out', role: person?.title ?? row.summary, initial: initialOf(person?.name), date: row.date,
      precision: row.precision ?? (row.evidenceIds.some(id => monthIds.has(id)) ? 'month' : 'day'),
      otherCompanyId: (row.companyId === id ? row.relatedCompanyId : row.companyId) ?? null,
      otherCompanyName: nameOf(row.companyId === id ? row.relatedCompanyId : row.companyId), evidenceIds: row.evidenceIds,
    };
  });
  const chains = snap.graph.edges.filter(edge => edge.from === id || edge.to === id).map(edge => ({
    edge, fromName: nameOf(edge.from) ?? edge.from, toName: nameOf(edge.to) ?? edge.to, side: edge.from === id ? 'cause' as const : 'effect' as const,
  }));
  const predictedNeeds = snap.targets.filter(target => target.companyId === id).map(target => ({
    need: target.need, mechanisms: target.mechanisms, confidence: target.confidence, netNew: target.netNew,
    whyNow: target.whyNow, whyNowDate: target.whyNowDate, rank: target.rank,
    status: target.hold ? 'held' as const : target.watch ? 'watch' as const : 'target' as const,
    holdReasons: target.hold?.reasons ?? [], watchReason: target.watch?.reason ?? null,
    evidenceIds: [...new Set([...(snap.graph.nodes.find(node => node.id === id)?.evidenceIds ?? []), ...target.decider?.evidenceIds ?? []])],
  }));
  const outreach = snap.drafts.filter(draft => draft.companyId === id).map(draft => {
    const approvals = snap.approvals.filter(approval => approval.draftId === draft.id);
    return {
      decider: snap.targets.find(target => target.draftId === draft.id)?.decider ?? null, draft, approvals,
      outbox: snap.outbox.filter(action => approvals.some(approval => approval.id === action.approvalId)),
      verifier: { verified: draft.verified, removed: draft.checks.filter(check => check.status === 'removed').map(check => check.sentence),
        cantVerify: draft.unverifiable },
    };
  });
  const cited = new Set([
    ...company.evidenceIds, ...triggers.flatMap(row => row.evidenceIds), ...chains.flatMap(chain => chain.edge.evidenceIds),
    ...predictedNeeds.flatMap(need => need.evidenceIds), ...outreach.flatMap(item => item.draft.citations.map(cite => cite.evidenceId)),
    ...openings.flatMap(opening => opening.evidenceIds),
  ]);
  const companyOpenings = openings.filter(opening => opening.companyId === id || opening.companyName === company.name);
  const mechanismRule = (mechanism: 'TALENT_DRAIN' | 'CONTAGION' | 'DISPLACEMENT', ruleId: DossierRule['id'], name: string): DossierRule => {
    const edgesIn = chains.filter(chain => chain.side === 'effect' && chain.edge.mechanism === mechanism);
    const need = predictedNeeds.find(row => row.mechanisms.includes(mechanism));
    const state: DossierRule['state'] = need?.status === 'held' ? 'held' : need?.status === 'watch' ? 'open' : edgesIn.length ? 'met' : 'not_met';
    return { id: ruleId, name, state,
      summary: need?.status === 'held' ? `Held: ${need.holdReasons.join('; ')}` : need?.status === 'watch' ? need.watchReason ?? 'Watchlist'
        : edgesIn.length ? edgesIn.map(chain => chain.edge.label).join('; ') : `Not met in run ${snap.id.slice(0, 12)}`,
      clauses: edgesIn.map(chain => ({ id: `${ruleId.toLowerCase()}.edge`, text: chain.edge.label, state: 'met' as const,
        detail: chain.edge.alternative ? `Competing explanation: ${chain.edge.alternative}` : undefined, evidenceIds: chain.edge.evidenceIds })) };
  };
  const rules: DossierRule[] = [o1Rule(companyOpenings), mechanismRule('TALENT_DRAIN', 'R1', 'Talent drain'),
    mechanismRule('CONTAGION', 'CONTAGION', 'Peer contagion'), mechanismRule('DISPLACEMENT', 'DISPLACEMENT', 'Provider displacement')];
  return {
    runId: snap.id, asOf: snap.intent?.asOf ?? null, dataMode: snap.dataMode, company, source: 'analysis_run', rules,
    whyTarget: null, headcountSeries: [],
    timeline: triggers.map(event), jobPosts: triggers.filter(row => row.kind === 'job_post' && row.companyId === id).map(event),
    talentFlows, chains, predictedNeeds, openings: companyOpenings, outreach,
    evidence: snap.evidence.filter(row => cited.has(row.id)),
  };
}

function o1Rule(openings: Opening[], headcount?: number | null, departures = 0): DossierRule {
  const opening = openings[0];
  // O1 only counts companies of 20–5,000 staff; a larger or smaller company's moves are read but never counted.
  const outside = typeof headcount === 'number' && (headcount < 20 || headcount > 5000);
  if (!opening) return { id: 'O1', name: 'Predicted opening', state: 'not_evaluated', clauses: [], summary: outside
    ? `Not counted by O1: ${headcount.toLocaleString('en-US')} staff is outside its 20–5,000 band${departures ? ` (${departures} dated move${departures === 1 ? '' : 's'} read, none counted)` : ''}`
    : 'No O1 group for this company in the latest openings scan' };
  const state: DossierRule['state'] = opening.status === 'held' ? 'held' : opening.status === 'watch' ? 'not_met'
    : opening.provisional ? 'open' : 'met';
  const label = ROLE_FAMILY_LABELS[opening.roleFamily];
  const summary = opening.status === 'held' ? `Held: ${(opening.holdReasons ?? []).join('; ')}`
    : opening.status === 'watch' ? `Watch: ${opening.watch?.reason ?? `${opening.watch?.have ?? 0} of ${opening.watch?.need ?? 2}`}`
      : opening.provisional ? `Predicted opening (provisional), ${label}: window closes by ${longDay(opening.windowClosesBy)}` : `Predicted opening, ${label}`;
  return { id: 'O1', name: 'Predicted opening', state, summary, clauses: opening.clauses ?? [] };
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const longDay = (date: string | null | undefined) => date ? dayFormat.format(new Date(date)) : 'an open date';
function eventKind(row: Evidence): CompanyDossier['timeline'][number]['kind'] {
  if (/^Crustdata (?:job|person) search for/.test(row.claim)) return 'check';
  if (row.source.provider === 'web' || /news|web\//.test(row.source.endpoint)) return 'news';
  if (/headcount/.test(row.source.field ?? '')) return 'headcount_jump';
  if (/job/.test(row.source.endpoint)) return 'job_post';
  return 'post';
}

const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sameCompany = (company: Company, key: string) => company.id === key || company.aliases?.includes(key) || slug(company.name) === slug(key);

// When no analysis run has the company: the file comes from the latest openings scan (real dated rows, labelled).
export function scanDossier(store: Store, key: string): CompanyDossier | null {
  const scan = openingsSnapshot(store);
  const company = scan?.companies.find(row => sameCompany(row, key));
  if (!scan || !company) return null;
  const departures = scan.departures.filter(row => row.companyId === company.id);
  const openings = scan.openings.filter(row => row.companyId === company.id);
  const replacements = (store.getOutput<{ replacements: { companyId: string; kind: 'job_post' | 'hire'; date: string | { start: string }; label?: string; evidenceId: string }[] }>(
    scan.runId, 'check_replacements')?.replacements ?? []).filter(row => row.companyId === company.id);
  const ids = new Set([...company.evidenceIds, ...departures.map(row => row.evidenceId), ...openings.flatMap(row => row.evidenceIds),
    ...openings.flatMap(row => (row.clauses ?? []).flatMap(clause => clause.evidenceIds)), ...replacements.map(row => row.evidenceId)]);
  const evidence: Evidence[] = scan.evidence.filter(row => ids.has(row.id));
  const flowOut = (row: Departure): TalentFlow => ({ direction: 'out', role: row.role, initial: row.initial, date: row.date ?? '',
    precision: row.precision, otherCompanyId: row.toCompanyId, otherCompanyName: row.toCompanyName, evidenceIds: [row.evidenceId] });
  const dayOf = (date: string | { start: string }) => typeof date === 'string' ? date : date.start;
  const timeline = [
    ...departures.filter(row => row.date).map(row => ({ id: row.id, date: row.date!, kind: 'departure' as const,
      summary: `${row.initial} ${row.role} left${row.toCompanyName ? ` for ${row.toCompanyName}` : ''}`, evidenceIds: [row.evidenceId] })),
    ...evidence.filter(row => row.observedAt && !departures.some(dep => dep.evidenceId === row.id)).map(row => ({
      id: row.id, date: row.observedAt!, kind: eventKind(row), summary: row.claim, evidenceIds: [row.id] })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const conclusive = openings.flatMap(row => (row.clauses ?? []).filter(clause => clause.id === 'o1.departures'));
  // R1 counts conclusive departures only (a month that straddles the window edge is unsettled).
  const settled = Math.max(0, ...conclusive.map(clause => Number(/^(\d+) conclusive/.exec(clause.text)?.[1] ?? 0)));
  const unsettled = Math.max(0, departures.length - settled);
  const rules: DossierRule[] = [o1Rule(openings, company.headcount, departures.length),
    { id: 'R1', name: 'Talent drain', state: 'not_met',
      summary: `${settled} conclusive dated serving/infra departure${settled === 1 ? '' : 's'}${unsettled ? ` (${unsettled} unsettled)` : ''}; R1 needs 3 in 90 days, the 3rd in the last 30`,
      clauses: conclusive.map(clause => ({ ...clause, id: 'r1.departures', state: settled >= 3 ? 'met' as const : 'failed' as const,
        text: `${settled} of 3 conclusive departures` })) },
    { id: 'CONTAGION', name: 'Peer contagion', state: 'not_evaluated', summary: 'Not evaluated: needs a company analysis run (peers and their dated moves)', clauses: [] },
    { id: 'DISPLACEMENT', name: 'Provider displacement', state: 'not_evaluated', summary: 'Not evaluated: needs a company analysis run (job posts naming a displaced provider)', clauses: [] }];
  const run = store.requireRun(scan.runId);
  return {
    runId: scan.runId, asOf: run.created_at.slice(0, 10), dataMode: run.data_mode, company, source: 'openings_scan', rules,
    whyTarget: null, headcountSeries: [],
    timeline, jobPosts: replacements.filter(row => row.kind === 'job_post').map(row => ({ id: row.evidenceId, date: dayOf(row.date), kind: 'job_post' as const,
      summary: row.label ?? 'Replacement job post', evidenceIds: [row.evidenceId] })),
    talentFlows: [...departures.map(flowOut), ...replacements.filter(row => row.kind === 'hire').map(row => ({ direction: 'in' as const,
      role: row.label ?? 'Replacement hire', initial: null, date: dayOf(row.date), precision: 'month' as const, otherCompanyId: null,
      otherCompanyName: null, evidenceIds: [row.evidenceId] }))],
    chains: [], predictedNeeds: openings.map(row => ({ need: ROLE_FAMILY_LABELS[row.roleFamily], mechanisms: [], confidence: 0, netNew: true,
      whyNow: (row.clauses ?? []).map(clause => clause.text).join(' · '), whyNowDate: row.predictedAt, rank: 0,
      status: row.status === 'open' ? 'target' as const : row.status === 'held' ? 'held' as const : 'watch' as const,
      holdReasons: row.holdReasons ?? [], watchReason: row.watch?.reason ?? null, evidenceIds: row.evidenceIds })),
    openings, outreach: [], evidence,
  };
}

// Latest analysis run that knows this company (or the run asked for), plus the latest openings scan's openings.
export function companyDossier(store: Store, companyId: string, runId?: string): CompanyDossier | null {
  const runs = store.sql.prepare(`SELECT id FROM runs WHERE coalesce(pipeline, 'outbound') = 'outbound'
    AND status IN ('completed', 'awaiting_approval') ${runId ? 'AND id = ?' : ''} ORDER BY created_at DESC LIMIT 20`)
    .all(...(runId ? [runId] : [])) as { id: string }[];
  const scan = store.sql.prepare(`SELECT id FROM runs WHERE pipeline = 'openings' AND status = 'completed'
    ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined;
  const openings = scan ? store.getOutput<{ openings: Opening[] }>(scan.id, 'detect_openings')?.openings ?? [] : [];
  let result: CompanyDossier | null = null;
  for (const { id } of runs) {
    const snap = snapshot(store, id);
    const match = snap.companies.find(row => sameCompany(row, companyId));
    result = match ? dossier(snap, match.id, openings) : null;
    if (result) break;
  }
  result ??= runId ? null : scanDossier(store, companyId);
  return result && withScanFacts(store, result);
}

// "Why this target?" (the company's top O1 opening: its clauses and the ranking rule) and the headcount series, both from
// the latest openings scan. They're attached to either kind of file.
function withScanFacts(store: Store, file: CompanyDossier): CompanyDossier {
  const scan = openingsSnapshot(store);
  if (!scan) return file;
  const company = scan.companies.find(row => row.id === file.company.id || row.name === file.company.name);
  const mine = scan.openings.filter(row => row.companyId === company?.id || row.companyName === file.company.name).sort(compareOpenings);
  const whyTarget: WhyThisTarget | null = mine[0] ? whyThisTarget(mine[0], scan.openings, companySummaries(scan)) : null;
  const facts = store.getOutput<{ companyFacts?: CompanyFacts[] }>(scan.runId, 'resolve_departures')?.companyFacts ?? [];
  const headcountSeries = facts.find(row => row.id === company?.id)?.headcountSeries ?? [];
  return { ...file, whyTarget, headcountSeries };
}
