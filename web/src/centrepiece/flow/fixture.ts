// FIXTURE: synthetic replay run for the talent-flow centrepiece. FICTIONAL companies and people only.
// It is the same fictional world as the web mock (Kestrel Labs, Orbital Voice, Lumen Serve, Tessera Health AI,
// Nimbus Docs, Quill Legal AI) with replay dates, plus a few fictional bystander companies and their ordinary
// job moves so the field has the background traffic a real /person/search pull returns.
// Every row is marked mode 'fixture'; the centrepiece labels the whole view "Fixture · synthetic".
import type {
  Company, Evidence, GraphEdge, GraphNode, Intent, ReplayOutcome, ReplayScore, RunSnapshot, Target, Trigger,
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
  [CO.vireo]: { x: 0.46, y: 0.13 },
  [CO.corvid]: { x: 0.72, y: 0.9 },
  [CO.ibis]: { x: 0.05, y: 0.88 },
  [CO.marlin]: { x: 0.96, y: 0.09 },
  [CO.fennel]: { x: 0.7, y: 0.12 },
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
  // rule O1: 2+ dated departures in one role family within 90 days, no replacement posted -> predicted opening
  ['2026-08-04', CO.orbital, CO.kestrel, 'Senior Inference Engineer'],
  ['2026-08-13', CO.orbital, CO.kestrel, 'ML Serving Engineer'],
  ['2026-08-22', CO.orbital, CO.kestrel, 'Staff Engineer, Model Serving'],
  ['2026-07-30', CO.tessera, CO.halden, 'ML Platform Engineer'],
  ['2026-08-26', CO.tessera, CO.halden, 'MLOps Engineer'],
  ['2026-08-10', CO.nimbus, CO.vireo, 'Inference Engineer'],
  ['2026-08-28', CO.nimbus, CO.vireo, 'LLM Serving Engineer'],
  // one departure only: the rule needs two
  ['2026-08-15', CO.quill, CO.fennel, 'ML Platform Engineer'],
  // two departures, but a replacement was posted on 25 Aug: no prediction
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
  p1: ev('ev_p1', "Pallas Robotics posted 'GPU Platform Engineer' (a replacement)", '2026-08-25', '/job/search', 'metadata.date_added', 'GPU Platform Engineer'),
  o1: ev('ev_o1', 'Orbital Voice engineering headcount fell 6% in one month', '2026-08-25', '/company/enrich', 'headcount.by_function_timeseries', -6),
  o2: ev('ev_o2', 'Orbital Voice has 0 open inference or ML serving roles', '2026-08-30', '/job/search', 'job_details.title', 0),
  o3: { ...ev('ev_o3', 'Whether Orbital Voice will backfill or restructure the team, mentioned only in an undated forum post', null, '/web/search', 'results[0].snippet', null), verifiable: false, source: { provider: 'web' as const, endpoint: '/web/search', field: 'results[0].snippet' } },
  t3: ev('ev_t3', 'Tessera Health AI has 0 open ML platform roles', '2026-08-30', '/job/search', 'job_details.title', 0),
  n2: ev('ev_n2', 'Nimbus Docs has 0 open inference roles', '2026-08-31', '/job/search', 'job_details.title', 0),
  d1: ev('ev_d1', 'A. Rao is VP Engineering at Orbital Voice', '2025-03-01', '/person/search', 'experience.employment_details.current.title', 'VP Engineering'),
  r1: ev('ev_r1', "Kestrel Labs hired an 'ML Infrastructure Engineer'", '2026-09-14', '/person/search', 'experience.employment_details.current.start_date', 'ML Infrastructure Engineer'),
  r2: ev('ev_r2', "Orbital Voice posted 'Inference Platform Lead'", '2026-09-19', '/job/search', 'metadata.date_added', 'Inference Platform Lead'),
  r3: ev('ev_r3', "Tessera Health AI posted 'ML Platform Engineer'", '2026-10-03', '/job/search', 'metadata.date_added', 'ML Platform Engineer'),
};
evidence.push(...Object.values(E));
const servingIds = (to: string, from: string) => triggers.find((t) => t.companyId === to && t.relatedCompanyId === from)!.evidenceIds;
const drainIds = servingIds(CO.kestrel, CO.orbital);
const tesseraIds = servingIds(CO.halden, CO.tessera);
const nimbusIds = servingIds(CO.vireo, CO.nimbus);
const quillIds = servingIds(CO.fennel, CO.quill);

triggers.push(
  { id: 'tr_k2', companyId: CO.kestrel, kind: 'job_post', date: '2026-08-18', summary: "Posted 'Inference Platform Engineer'", evidenceIds: ['ev_k4'] },
  { id: 'tr_p1', companyId: CO.pallas, kind: 'job_post', date: '2026-08-25', summary: "Posted 'GPU Platform Engineer'", evidenceIds: ['ev_p1'] },
);

const companies: Company[] = COMPANIES.map(([id, n, headcount, domain]) => ({
  id, name: n, aliases: id === CO.kestrel ? ['Kestrel Labs', 'Kestrel Labs Pvt. Ltd.'] : [n], domain, headcount,
  evidenceIds: [],
}));

const node = (id: string, tier: number, need: string | null, confidence: number | null, mechanisms: GraphNode['mechanisms'], netNew: boolean, evidenceIds: string[], status: GraphNode['status'] = 'hypothesis'): GraphNode =>
  ({ id, name: name(id), tier, need, confidence, mechanisms, netNew, triggerIds: [], evidenceIds, status });

const nodes: GraphNode[] = [
  node(CO.kestrel, 0, null, null, ['DIRECT'], false, [...drainIds, 'ev_k4']),
  node(CO.orbital, 1, 'Inference engineer', 0.81, ['TALENT_DRAIN'], true, [...drainIds, 'ev_o2', 'ev_o1', 'ev_o3']),
  node(CO.tessera, 1, 'ML platform engineer', 0.74, ['TALENT_DRAIN'], true, [...tesseraIds, 'ev_t3']),
  node(CO.nimbus, 1, 'Inference engineer', 0.58, ['TALENT_DRAIN'], true, [...nimbusIds, 'ev_n2']),
  node(CO.quill, 2, 'ML platform engineer', 0.3, ['TALENT_DRAIN'], true, quillIds, 'unverifiable'),
];

const edges: GraphEdge[] = [
  { id: 'ed_drain', from: CO.kestrel, to: CO.orbital, mechanism: 'TALENT_DRAIN', label: '3 inference engineers left for Kestrel Labs, 4–22 Aug', rationale: 'Three dated departures in one role family within 90 days and no replacement posted: rule O1 predicts an opening.', confidence: 0.81, observedAt: '2026-08-22', evidenceIds: drainIds, order: 0, alternative: 'Orbital may restructure instead of backfilling.' },
  { id: 'ed_tessera', from: CO.halden, to: CO.tessera, mechanism: 'TALENT_DRAIN', label: '2 ML platform engineers left for Halden Speech', rationale: 'Two dated departures, no replacement posted.', confidence: 0.74, observedAt: '2026-08-26', evidenceIds: tesseraIds, order: 1, alternative: null },
  { id: 'ed_nimbus', from: CO.vireo, to: CO.nimbus, mechanism: 'TALENT_DRAIN', label: '2 inference engineers left for Vireo Search', rationale: 'Two dated departures, no replacement posted.', confidence: 0.58, observedAt: '2026-08-28', evidenceIds: nimbusIds, order: 2, alternative: null },
];

const outcomes: ReplayOutcome[] = [
  { companyId: CO.kestrel, predictedBy: 'baseline_first_order', hit: true, outcomeDate: '2026-09-14', outcome: "hired an 'ML Infrastructure Engineer' 14 Sep", evidenceIds: ['ev_r1'] },
  { companyId: CO.orbital, predictedBy: 'domino', hit: true, outcomeDate: '2026-09-19', outcome: "posted 'Inference Platform Lead' 19 Sep", evidenceIds: ['ev_r2'] },
  { companyId: CO.tessera, predictedBy: 'domino', hit: true, outcomeDate: '2026-10-03', outcome: "posted 'ML Platform Engineer' 3 Oct", evidenceIds: ['ev_r3'] },
  { companyId: CO.nimbus, predictedBy: 'domino', hit: false, outcomeDate: null, outcome: 'no dated post or hire yet', evidenceIds: [] },
  { companyId: CO.kestrel, predictedBy: 'baseline_headcount', hit: true, outcomeDate: '2026-09-14', outcome: "hired an 'ML Infrastructure Engineer' 14 Sep", evidenceIds: ['ev_r1'] },
  { companyId: CO.sable, predictedBy: 'baseline_headcount', hit: false, outcomeDate: null, outcome: 'no dated post or hire yet', evidenceIds: [] },
  { companyId: CO.fennel, predictedBy: 'baseline_headcount', hit: false, outcomeDate: null, outcome: 'no dated post or hire yet', evidenceIds: [] },
];

const replay: ReplayScore = {
  asOf: ASOF, horizonEnd: HORIZON, factsAfterAsOfUsed: 0,
  domino: { predicted: 3, hits: 2, precision: 0.67, medianLeadDays: 25 },
  baselineFirstOrder: { predicted: 1, hits: 1, precision: 1, medianLeadDays: 13 },
  baselineHeadcount: { predicted: 3, hits: 1, precision: 0.33, medianLeadDays: 13 },
  outcomes,
  note: 'Fixture. The job-post filter was right on its only pick, which was already posting. DOMINO predicted two openings at companies the filter never picked. Nimbus Docs has not posted yet.',
};

const targets: Target[] = [
  { companyId: CO.orbital, rank: 1, score: 0.84, confidence: 0.81, need: 'Inference engineer', mechanisms: ['TALENT_DRAIN'], netNew: true, whyNow: '3 inference engineers left in 18 days; no replacement posted', whyNowDate: '2026-08-22', decider: { personId: 'pe_rao', name: 'A. Rao', title: 'VP Engineering', tenureSince: '2025-03-01', reason: 'Owns the engineering hiring budget.', evidenceIds: ['ev_d1'] }, path: null, draftId: null },
  { companyId: CO.tessera, rank: 2, score: 0.77, confidence: 0.74, need: 'ML platform engineer', mechanisms: ['TALENT_DRAIN'], netNew: true, whyNow: '2 ML platform engineers left; no replacement posted', whyNowDate: '2026-08-26', decider: null, path: null, draftId: null },
  { companyId: CO.nimbus, rank: 3, score: 0.6, confidence: 0.58, need: 'Inference engineer', mechanisms: ['TALENT_DRAIN'], netNew: true, whyNow: '2 inference engineers left; no replacement posted', whyNowDate: '2026-08-28', decider: null, path: null, draftId: null },
];

const intent: Intent = {
  offering: null, buyerProfile: 'AI companies', geography: null, windowDays: 90, asOf: ASOF,
  deciderTitles: ['CTO', 'VP Engineering', 'Head of ML Platform'], signalKeywords: ['inference', 'ML platform', 'MLOps'],
  maxTargets: 5, parsedBy: 'rules', runKind: 'replay', horizonEnd: HORIZON, assumptions: [],
};

export const FIXTURE_SNAPSHOT: RunSnapshot = {
  id: 'run_fixture_flow', request: 'Replay as of 1 Sep 2026: which AI companies would open inference or ML platform roles, and were the predictions right by 22 Nov?',
  status: 'completed', dataMode: 'fixture', llm: 'template', createdAt: RETRIEVED, updatedAt: RETRIEVED, intent,
  steps: [], budget: { limits: { maxCredits: 800, maxModelUsd: 2, maxSeconds: 600 }, used: { credits: 0, modelUsd: 0, seconds: 0 }, exhausted: null },
  companies, people: [], triggers, merges: [], keptApart: [], graph: { nodes, edges }, targets, drafts: [], evidence,
  approvals: [], outbox: [], ledger: [], asks: [], baseline: { hiringFilterCompanyIds: [CO.kestrel] },
  engine: { pid: null, alive: false, crashes: 0, resumes: 0 }, replay,
};
