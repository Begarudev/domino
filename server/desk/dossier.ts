// Company dossier: the full company analysis for one company, shaped from a run snapshot. OWNER: lead.
import type { CompanyDossier, Opening, TalentFlow } from '../../shared/desk.ts';
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
  const talentFlows: TalentFlow[] = moves.map(row => {
    const person = row.personId ? people.get(row.personId) : undefined;
    // A hire trigger sits on the hiring company; a departure trigger on the company that lost the person.
    const joinedHere = row.kind === 'hire' ? row.companyId === id : row.relatedCompanyId === id;
    return {
      direction: joinedHere ? 'in' : 'out', role: person?.title ?? row.summary, initial: initialOf(person?.name), date: row.date,
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
  return {
    runId: snap.id, asOf: snap.intent?.asOf ?? null, dataMode: snap.dataMode, company,
    timeline: triggers.map(event), jobPosts: triggers.filter(row => row.kind === 'job_post' && row.companyId === id).map(event),
    talentFlows, chains, predictedNeeds, openings: openings.filter(opening => opening.companyId === id), outreach,
    evidence: snap.evidence.filter(row => cited.has(row.id)),
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
  for (const { id } of runs) {
    const result = dossier(snapshot(store, id), companyId, openings);
    if (result) return result;
  }
  return null;
}
