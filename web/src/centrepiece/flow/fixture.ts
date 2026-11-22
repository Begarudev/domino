// FIXTURE: synthetic replay run for the talent-flow centrepiece. FICTIONAL companies and people only.
// It is the same fictional world as the web mock (Kestrel Labs, Orbital Voice, Lumen Serve, Tessera Health AI,
// Nimbus Docs, Quill Legal AI) with replay dates, plus a few fictional bystander companies and their ordinary
// job moves so the field has the background traffic a real /person/search pull returns.
// Every row is marked mode 'fixture'; the centrepiece labels the whole view "Fixture · synthetic".
import type {
  Company, Draft, Evidence, GraphEdge, GraphNode, Intent, ReplayOutcome, ReplayScore, RunSnapshot, Target, Trigger,
} from '../../../../shared/types.ts';

const RETRIEVED = '2026-11-22T07:31:00.000Z';
const ASOF = '2026-09-01';
const HORIZON = '2026-11-22';

const CO = {
  kestrel: 'co_kestrel', orbital: 'co_orbital', nimbus: 'co_nimbus', lumen: 'co_lumen', tessera: 'co_tessera',
  quill: 'co_quill', sable: 'co_sable', pallas: 'co_pallas', vireo: 'co_vireo', corvid: 'co_corvid',
  ibis: 'co_ibis', marlin: 'co_marlin', fennel: 'co_fennel', halden: 'co_halden',
} as const;

const COMPANIES: [string, string, number, string][] = [
  [CO.kestrel, 'Kestrel Labs', 420, 'kestrel-labs.ai'],
  [CO.orbital, 'Orbital Voice', 140, 'orbitalvoice.ai'],
  [CO.tessera, 'Tessera Health AI', 210, 'tessera.health'],
  [CO.nimbus, 'Nimbus Docs', 64, 'nimbusdocs.ai'],
  [CO.lumen, 'Lumen Serve', 90, 'lumenserve.dev'],
  [CO.quill, 'Quill Legal AI', 48, 'quill-legal.ai'],
  [CO.sable, 'Sable Agents', 300, 'sableagents.ai'],
  [CO.pallas, 'Pallas Robotics', 180, 'pallas.bot'],
  [CO.vireo, 'Vireo Search', 96, 'vireo.search'],
  [CO.corvid, 'Corvid Translate', 72, 'corvid.ai'],
  [CO.ibis, 'Ibis Finance AI', 55, 'ibis.finance'],
  [CO.marlin, 'Marlin Bio', 40, 'marlin.bio'],
  [CO.fennel, 'Fennel Retail AI', 120, 'fennel.shop'],
  [CO.halden, 'Halden Speech', 78, 'halden.ai'],
];

// Where each company sits in the field (0..1). Optional: without hints the centrepiece runs a force layout.
export const FIXTURE_LAYOUT: Record<string, { x: number; y: number }> = {
  [CO.kestrel]: { x: 0.6, y: 0.44 },
  [CO.orbital]: { x: 0.31, y: 0.36 },
  [CO.tessera]: { x: 0.3, y: 0.78 },
  [CO.lumen]: { x: 0.58, y: 0.88 },
  [CO.nimbus]: { x: 0.1, y: 0.18 },
  [CO.quill]: { x: 0.08, y: 0.62 },
  [CO.sable]: { x: 0.85, y: 0.26 },
  [CO.pallas]: { x: 0.9, y: 0.7 },
  [CO.vireo]: { x: 0.46, y: 0.08 },
  [CO.corvid]: { x: 0.72, y: 0.9 },
  [CO.ibis]: { x: 0.05, y: 0.88 },
  [CO.marlin]: { x: 0.96, y: 0.04 },
  [CO.fennel]: { x: 0.7, y: 0.07 },
  [CO.halden]: { x: 0.45, y: 0.62 },
};

const name = (id: string) => COMPANIES.find((c) => c[0] === id)?.[1] ?? id;

function ev(id: string, claim: string, observedAt: string | null, endpoint: string, field: string, value: Evidence['value'], url?: string): Evidence {
  return {
    id, claim, value, observedAt, retrievedAt: RETRIEVED, mode: 'fixture', verifiable: observedAt !== null,
    source: { provider: 'crustdata', endpoint, recordId: id.replace('ev_', 'rec_'), field, ...(url ? { url } : {}) },
  };
}

// ---- job moves: [date, from (old employer), to (new employer), title] ----
type Move = [string, string, string, string];
const SERVING_MOVES: Move[] = [
  ['2026-08-04', CO.orbital, CO.kestrel, 'Senior Inference Engineer'],
  ['2026-08-13', CO.orbital, CO.kestrel, 'ML Serving Engineer'],
  ['2026-08-22', CO.orbital, CO.kestrel, 'Staff Engineer, Model Serving'],
  // a pair that stays under the rule: two moves is not a drain
  ['2026-07-09', CO.pallas, CO.sable, 'GPU Platform Engineer'],
  ['2026-08-18', CO.pallas, CO.sable, 'Inference Engineer'],
];

const ROLES = ['Product Engineer', 'Research Scientist', 'Applied ML Engineer', 'Data Engineer', 'Designer', 'Account Executive', 'Frontend Engineer', 'Recruiter', 'Product Manager', 'Data Scientist'];
const BYSTANDERS = [CO.sable, CO.pallas, CO.vireo, CO.corvid, CO.ibis, CO.marlin, CO.fennel, CO.halden, CO.kestrel, CO.orbital, CO.tessera, CO.nimbus, CO.quill];

// deterministic background traffic (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function addDays(iso: string, d: number) {
  const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10);
}
const AMBIENT_MOVES: Move[] = (() => {
  const r = rng(905);
  const out: Move[] = [];
  for (let i = 0; i < 168; i++) {
    const from = BYSTANDERS[Math.floor(r() * BYSTANDERS.length)];
    let to = BYSTANDERS[Math.floor(r() * BYSTANDERS.length)];
    if (to === from) to = BYSTANDERS[(BYSTANDERS.indexOf(from) + 3) % BYSTANDERS.length];
    out.push([addDays('2026-06-03', Math.floor(r() * 172)), from, to, ROLES[Math.floor(r() * ROLES.length)]]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
})();

const evidence: Evidence[] = [];
const triggers: Trigger[] = [];
{
  const groups = new Map<string, string[]>();
  [...SERVING_MOVES, ...AMBIENT_MOVES].forEach(([date, from, to, title], i) => {
    const id = `ev_mv${String(i).padStart(3, '0')}`;
    evidence.push(ev(id, `${name(to)} hired a ${title} whose previous employer was ${name(from)}`, date, '/person/search',
      'experience.employment_details.current.start_date', name(from)));
    const key = `${to}|${from}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  });
  let n = 0;
  for (const [key, ids] of groups) {
    const [to, from] = key.split('|');
    const dates = ids.map((id) => evidence.find((e) => e.id === id)!.observedAt!).sort();
    triggers.push({ id: `tr_h${n++}`, companyId: to, kind: 'hire', date: dates[dates.length - 1], summary: `Hired ${ids.length} from ${name(from)}`, relatedCompanyId: from, evidenceIds: ids });
  }
}

const E = {
  k4: ev('ev_k4', "Kestrel Labs posted 'Inference Platform Engineer'", '2026-08-18', '/job/search', 'metadata.date_added', 'Inference Platform Engineer', 'https://jobs.example/kestrel-labs/inference-platform-engineer'),
  o1: ev('ev_o1', 'Orbital Voice engineering headcount fell 6% in one month', '2026-08-25', '/company/enrich', 'headcount.by_function_timeseries', -6),
  o2: ev('ev_o2', 'Orbital Voice has 0 open inference or ML serving roles', '2026-08-30', '/job/search', 'job_details.title', 0),
  o3: { ...ev('ev_o3', "Orbital Voice's current GPU provider, named only in an undated forum post", null, '/web/search', 'results[0].snippet', null), verifiable: false, source: { provider: 'web' as const, endpoint: '/web/search', field: 'results[0].snippet' } },
  o4: ev('ev_o4', 'Orbital Voice raised a $22M Series A', '2026-07-21', '/company/enrich', 'funding.milestones.funding_date', '22000000'),
  l1: ev('ev_l1', 'Lumen Serve was acquired; the buyer announced it on its newsroom', '2026-08-12', '/company/enrich', 'news[0].date', 'acquired', 'https://news.example/lumen-serve-acquired'),
  l2: ev('ev_l2', 'Lumen Serve stops taking new hosted workloads on 31 Jan 2027', '2026-08-14', '/company/enrich', 'news[1].date', '2027-01-31'),
  t1: ev('ev_t1', "Tessera Health AI posted 'Clinical NLP Engineer'; the requirements name the Lumen Serve SDK", '2026-08-07', '/job/search', 'content.description', 'Lumen Serve SDK', 'https://jobs.example/tessera-health-ai/clinical-nlp-engineer'),
  t2: ev('ev_t2', 'Tessera Health AI raised a $40M Series B', '2026-08-19', '/company/enrich', 'funding.milestones.funding_date', '40000000'),
  n1: ev('ev_n1', "Nimbus Docs closed its 'GPU Infrastructure Engineer' post", '2026-08-20', '/job/search', 'metadata.date_closed', 'GPU Infrastructure Engineer'),
  n3: ev('ev_n3', 'Nimbus Docs lists Orbital Voice as a peer (same lead investor, same model size)', '2026-08-25', '/company/enrich', 'competitors.all_domains', 'Orbital Voice'),
  q1: ev('ev_q1', 'Quill Legal AI headcount grew 12% in three months', '2026-08-10', '/company/enrich', 'headcount.timeseries', 12),
  d1: ev('ev_d1', 'Anika Rao is VP Engineering at Orbital Voice', '2025-03-01', '/person/search', 'experience.employment_details.current.title', 'VP Engineering'),
  r1: ev('ev_r1', "Kestrel Labs hired an 'ML Infrastructure Engineer'", '2026-09-14', '/person/search', 'experience.employment_details.current.start_date', 'ML Infrastructure Engineer'),
  r2: ev('ev_r2', "Orbital Voice posted 'Inference Platform Lead'", '2026-09-19', '/job/search', 'metadata.date_added', 'Inference Platform Lead'),
  r3: ev('ev_r3', "Tessera Health AI posted 'Inference Migration Engineer'", '2026-10-03', '/job/search', 'metadata.date_added', 'Inference Migration Engineer'),
};
evidence.push(...Object.values(E));
const servingIds = (to: string, from: string) => triggers.find((t) => t.companyId === to && t.relatedCompanyId === from)!.evidenceIds;
const drainIds = servingIds(CO.kestrel, CO.orbital);

triggers.push(
  { id: 'tr_k2', companyId: CO.kestrel, kind: 'job_post', date: '2026-08-18', summary: "Posted 'Inference Platform Engineer'", evidenceIds: ['ev_k4'] },
  { id: 'tr_l1', companyId: CO.lumen, kind: 'post', date: '2026-08-12', summary: 'Acquired; hosted API stops new workloads 31 Jan', evidenceIds: ['ev_l1', 'ev_l2'] },
  { id: 'tr_t1', companyId: CO.tessera, kind: 'job_post', date: '2026-08-07', summary: 'Job post names the Lumen Serve SDK', relatedCompanyId: CO.lumen, evidenceIds: ['ev_t1'] },
  { id: 'tr_t2', companyId: CO.tessera, kind: 'funding', date: '2026-08-19', summary: 'Raised a $40M Series B', evidenceIds: ['ev_t2'] },
  { id: 'tr_n1', companyId: CO.nimbus, kind: 'job_post', date: '2026-08-20', summary: "Closed its 'GPU Infrastructure Engineer' post", evidenceIds: ['ev_n1'] },
  { id: 'tr_q1', companyId: CO.quill, kind: 'headcount_jump', date: '2026-08-10', summary: 'Headcount up 12% in three months', evidenceIds: ['ev_q1'] },
);

const companies: Company[] = COMPANIES.map(([id, n, headcount, domain]) => ({
  id, name: n, aliases: id === CO.kestrel ? ['Kestrel Labs', 'Kestrel Labs Pvt. Ltd.'] : [n], domain, headcount,
  evidenceIds: [],
}));

const node = (id: string, tier: number, need: string | null, confidence: number | null, mechanisms: GraphNode['mechanisms'], netNew: boolean, evidenceIds: string[], status: GraphNode['status'] = 'hypothesis'): GraphNode =>
  ({ id, name: name(id), tier, need, confidence, mechanisms, netNew, triggerIds: [], evidenceIds, status });

const nodes: GraphNode[] = [
  node(CO.kestrel, 0, 'Inference platform, already hiring for it', 0.55, ['DIRECT'], false, [...drainIds, 'ev_k4']),
  node(CO.lumen, 0, null, null, [], false, ['ev_l1', 'ev_l2']),
  node(CO.orbital, 1, 'Managed inference: buy, since the serving team is gone', 0.81, ['TALENT_DRAIN', 'CAPITAL'], true, [...drainIds, 'ev_o1', 'ev_o2', 'ev_o4', 'ev_o3']),
  node(CO.tessera, 1, 'Migrate off Lumen Serve by 31 Jan', 0.74, ['DISPLACEMENT', 'CAPITAL'], true, ['ev_t1', 'ev_l1', 'ev_l2', 'ev_t2']),
  node(CO.nimbus, 2, 'Managed inference, not a GPU hire', 0.58, ['CONTAGION'], true, ['ev_n1', 'ev_n3']),
  node(CO.quill, 2, 'The same migration as its peer', 0.34, ['CONTAGION'], true, ['ev_q1'], 'unverifiable'),
];

const edges: GraphEdge[] = [
  { id: 'ed_drain', from: CO.kestrel, to: CO.orbital, mechanism: 'TALENT_DRAIN', label: '3 serving engineers moved to Kestrel Labs, 4–22 Aug', rationale: 'Orbital Voice lost three of its serving engineers to Kestrel Labs in 18 days and has no open serving roles, so rebuilding in-house is slow; buying managed inference is the fast path.', confidence: 0.81, observedAt: '2026-08-22', evidenceIds: drainIds, order: 0, alternative: 'Orbital may backfill instead of buying.' },
  { id: 'ed_displace', from: CO.lumen, to: CO.tessera, mechanism: 'DISPLACEMENT', label: 'Provider acquired 12 Aug; Tessera job post names its SDK', rationale: 'Tessera Health AI builds on the Lumen Serve SDK, which stops taking new workloads on 31 Jan 2027.', confidence: 0.74, observedAt: '2026-08-14', evidenceIds: ['ev_l1', 'ev_l2', 'ev_t1'], order: 1, alternative: 'The acquirer may keep the API running.' },
  { id: 'ed_peer', from: CO.orbital, to: CO.nimbus, mechanism: 'CONTAGION', label: 'Peer of Orbital Voice; closed its GPU post 20 Aug', rationale: 'Nimbus Docs shares an investor and model size with Orbital Voice and closed its own GPU hire.', confidence: 0.58, observedAt: '2026-08-25', evidenceIds: ['ev_n1', 'ev_n3'], order: 2, alternative: 'The post may have closed because it was filled.' },
  { id: 'ed_quill', from: CO.tessera, to: CO.quill, mechanism: 'CONTAGION', label: 'Peer link undated: one dated row only', rationale: 'Only one dated fact supports it; the rule needs two, so DOMINO does not act on it.', confidence: 0.34, observedAt: '2026-08-10', evidenceIds: ['ev_q1'], order: 3, alternative: null },
];

const outcomes: ReplayOutcome[] = [
  { companyId: CO.kestrel, predictedBy: 'baseline_first_order', hit: true, outcomeDate: '2026-09-14', outcome: "hired an 'ML Infrastructure Engineer' 14 Sep", evidenceIds: ['ev_r1'] },
  { companyId: CO.orbital, predictedBy: 'domino', hit: true, outcomeDate: '2026-09-19', outcome: "posted 'Inference Platform Lead' 19 Sep", evidenceIds: ['ev_r2'] },
  { companyId: CO.tessera, predictedBy: 'domino', hit: true, outcomeDate: '2026-10-03', outcome: "posted 'Inference Migration Engineer' 3 Oct", evidenceIds: ['ev_r3'] },
  { companyId: CO.nimbus, predictedBy: 'domino', hit: false, outcomeDate: null, outcome: 'no dated sign yet', evidenceIds: [] },
  { companyId: CO.kestrel, predictedBy: 'baseline_headcount', hit: true, outcomeDate: '2026-09-14', outcome: "hired an 'ML Infrastructure Engineer' 14 Sep", evidenceIds: ['ev_r1'] },
  { companyId: CO.quill, predictedBy: 'baseline_headcount', hit: false, outcomeDate: null, outcome: 'no dated sign yet', evidenceIds: [] },
  { companyId: CO.lumen, predictedBy: 'baseline_headcount', hit: false, outcomeDate: null, outcome: 'acquired; no inference hiring after', evidenceIds: [] },
];

const replay: ReplayScore = {
  asOf: ASOF, horizonEnd: HORIZON, factsAfterAsOfUsed: 0,
  domino: { predicted: 3, hits: 2, precision: 0.67, medianLeadDays: 25 },
  baselineFirstOrder: { predicted: 1, hits: 1, precision: 1, medianLeadDays: 13 },
  baselineHeadcount: { predicted: 3, hits: 1, precision: 0.33, medianLeadDays: 13 },
  outcomes,
  note: 'The hiring filter was right on its only pick, which was already hiring. DOMINO found two accounts the filter never returned, a median 25 days before they posted. Nimbus Docs has not moved yet. Three predictions is a small sample.',
};

const draft: Draft = {
  id: 'dr_orbital', companyId: CO.orbital, personId: 'pe_anika', generator: 'template', verified: true,
  subject: 'Serving capacity after the Series A',
  body: 'Hi Anika, congratulations on the $22M Series A in July [1]. Orbital Voice has no open inference or serving roles right now [2], while engineering headcount fell 6% in a month [3]. We run managed GPU inference for voice models, so your team ships features instead of operating clusters. Worth 20 minutes next week?',
  citations: [{ marker: 1, evidenceId: 'ev_o4' }, { marker: 2, evidenceId: 'ev_o2' }, { marker: 3, evidenceId: 'ev_o1' }],
  unverifiable: [{ claim: "Orbital Voice's current GPU provider", reason: 'Only an undated forum post names it, so the message does not.' }],
  checks: [
    { sentence: 'Hi Anika, congratulations on the $22M Series A in July [1].', status: 'cited', evidenceIds: ['ev_o4'] },
    { sentence: 'Orbital Voice has no open inference or serving roles right now [2], while engineering headcount fell 6% in a month [3].', status: 'cited', evidenceIds: ['ev_o2', 'ev_o1'] },
    { sentence: 'Your current GPU provider has been raising prices this quarter.', status: 'removed', evidenceIds: [], note: 'No evidence row supports it' },
    { sentence: 'We run managed GPU inference for voice models, so your team ships features instead of operating clusters.', status: 'no_claim', evidenceIds: [] },
    { sentence: 'Worth 20 minutes next week?', status: 'no_claim', evidenceIds: [] },
  ],
  meeting: { title: 'Managed inference for Orbital Voice', durationMin: 20, proposedSlots: ['2026-09-03T05:30:00.000Z'] },
};

const targets: Target[] = [
  { companyId: CO.orbital, rank: 1, score: 0.84, confidence: 0.81, need: 'Managed inference: buy, since the serving team is gone', mechanisms: ['TALENT_DRAIN', 'CAPITAL'], netNew: true, whyNow: '3 serving engineers left in 18 days; no open serving roles', whyNowDate: '2026-08-22', decider: { personId: 'pe_anika', name: 'Anika Rao', title: 'VP Engineering', tenureSince: '2025-03-01', reason: 'Owns the platform and infra budget; the serving team reported to her.', evidenceIds: ['ev_d1'] }, path: null, draftId: 'dr_orbital' },
  { companyId: CO.tessera, rank: 2, score: 0.77, confidence: 0.74, need: 'Migrate off Lumen Serve by 31 Jan', mechanisms: ['DISPLACEMENT', 'CAPITAL'], netNew: true, whyNow: 'Its provider was acquired and sunsets new workloads', whyNowDate: '2026-08-12', decider: null, path: null, draftId: null },
  { companyId: CO.nimbus, rank: 3, score: 0.6, confidence: 0.58, need: 'Managed inference, not a GPU hire', mechanisms: ['CONTAGION'], netNew: true, whyNow: 'Peer lost its serving team; closed its own GPU post', whyNowDate: '2026-08-20', decider: null, path: null, draftId: null },
  { companyId: CO.kestrel, rank: 4, score: 0.52, confidence: 0.55, need: 'Inference platform, already hiring for it', mechanisms: ['DIRECT'], netNew: false, whyNow: "Posted 'Inference Platform Engineer'", whyNowDate: '2026-08-18', decider: null, path: null, draftId: null },
];

const intent: Intent = {
  offering: 'managed GPU inference', buyerProfile: 'AI companies', geography: null, windowDays: 90, asOf: ASOF,
  deciderTitles: ['CTO', 'VP Engineering', 'Head of ML Platform'], signalKeywords: ['inference', 'serving', 'GPU'],
  maxTargets: 5, parsedBy: 'rules', runKind: 'replay', horizonEnd: HORIZON, assumptions: [],
};

export const FIXTURE_SNAPSHOT: RunSnapshot = {
  id: 'run_fixture_flow', request: 'Replay as of 1 Sep 2026: we sell managed GPU inference. Which AI companies would have needed it, and were we right by 22 Nov?',
  status: 'completed', dataMode: 'fixture', llm: 'template', createdAt: RETRIEVED, updatedAt: RETRIEVED, intent,
  steps: [], budget: { limits: { maxCredits: 800, maxModelUsd: 2, maxSeconds: 600 }, used: { credits: 0, modelUsd: 0, seconds: 0 }, exhausted: null },
  companies, people: [], triggers, merges: [], keptApart: [], graph: { nodes, edges }, targets, drafts: [draft], evidence,
  approvals: [], outbox: [], ledger: [], asks: [], baseline: { hiringFilterCompanyIds: [CO.kestrel] },
  engine: { pid: null, alive: false, crashes: 0, resumes: 0 }, replay,
};
