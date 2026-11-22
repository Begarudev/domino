// FIXTURE · synthetic data. Every company here is fictional (the build lead's fixture world).
// Two snapshots in the shared RunSnapshot shape:
//   replayFixture: frozen at 1 Sep 2026, predictions scored against what "happened" up to 22 Nov.
//   liveFixture:   a live run as of 22 Nov 2026 (no replay block), for the plain cascade.
import type {
  RunSnapshot, Evidence, Company, GraphNode, GraphEdge, ReplayOutcome, Mechanism, Target,
} from '../../../../shared/types.ts';

const RETRIEVED = '2026-11-22T13:05:00+05:30';

function ev(id: string, claim: string, observedAt: string | null, endpoint: string, field: string, value?: string | number): Evidence {
  return {
    id, claim, value: value ?? null, observedAt, retrievedAt: RETRIEVED, mode: 'fixture',
    verifiable: observedAt !== null,
    source: { provider: 'crustdata', endpoint, field, recordId: `fx_${id}` },
  };
}

function co(id: string, name: string, domain: string, headcount: number, evidenceIds: string[], aliases: string[] = []): Company {
  return { id, name, aliases: [name, ...aliases], domain, headcount, industry: 'AI / ML', hq: 'Bengaluru', evidenceIds };
}

function node(id: string, name: string, tier: number, conf: number | null, mech: Mechanism[], netNew: boolean, evidenceIds: string[], need: string | null = null): GraphNode {
  return { id, name, tier, need, confidence: conf, mechanisms: mech, netNew, triggerIds: [], evidenceIds, status: 'hypothesis' };
}

function edge(id: string, from: string, to: string, mechanism: Mechanism, label: string, confidence: number, observedAt: string, evidenceIds: string[], order: number, alternative: string | null): GraphEdge {
  return { id, from, to, mechanism, label, rationale: label, confidence, observedAt, evidenceIds, order, alternative };
}

const evidence: Evidence[] = [
  // trigger: Kestrel Labs pulled serving engineers out of Orbital Voice (dated hires, 30-day lag respected)
  ev('ev_k1', "Kestrel Labs hired a Senior Inference Engineer whose previous employer was Orbital Voice", '2026-06-24', '/person/search', 'experience.employment_details.current.start_date'),
  ev('ev_k2', "Kestrel Labs hired an ML Serving Engineer from Orbital Voice", '2026-07-09', '/person/search', 'experience.employment_details.current.start_date'),
  ev('ev_k3', "Kestrel Labs hired a GPU Platform Engineer from Orbital Voice", '2026-07-30', '/person/search', 'experience.employment_details.current.start_date'),
  ev('ev_k4', 'Kestrel Labs headcount 212 → 248 in 90 days', '2026-08-15', '/company/enrich', 'headcount.timeseries', '+17%'),
  ev('ev_k5', 'Kestrel Labs raised a Series B', '2026-08-04', '/company/enrich', 'funding.milestones.funding_date', 'Series B'),
  ev('ev_s1', 'Kestrel Labs hired 2 inference engineers whose previous employer was Saffron Speech', '2026-07-21', '/person/search', 'experience.employment_details.past.end_date', 2),
  // trigger: Lumen Serve repriced hosted endpoints
  ev('ev_l1', 'Lumen Serve announced hosted-endpoint repricing, effective 1 Oct', '2026-08-19', '/social_post/search', 'date_posted'),
  ev('ev_l2', "Tessera Health AI job post names Lumen Serve endpoints in its stack", '2026-07-12', '/job/search', 'content.description'),
  ev('ev_l3', "Halcyon Retail AI job post names Lumen Serve in its stack", '2026-06-30', '/job/search', 'content.description'),
  // contagion peers
  ev('ev_n1', 'Nimbus Docs is a competitor of Kestrel Labs (SEO overlap and description similarity 0.81)', '2026-08-20', '/company/enrich', 'competitors.all_domains'),
  ev('ev_q1', 'Quill Legal AI is a competitor of Kestrel Labs (description similarity 0.74)', '2026-08-20', '/company/enrich', 'competitors.all_domains'),
  ev('ev_o0', 'Orbital Voice: 3 of its 7 serving engineers left in 90 days', '2026-07-30', '/person/search', 'experience.employment_details.past.end_date', '3 of 7'),
  // outcomes after 1 Sep (what actually happened, in the fixture)
  ev('ev_ot', "Tessera Health AI posted 'ML Engineer, model-serving migration'", '2026-09-23', '/job/search', 'metadata.date_added'),
  ev('ev_oh', "Halcyon Retail AI posted 'Inference Platform Engineer'", '2026-10-06', '/job/search', 'metadata.date_added'),
  ev('ev_oo', "Orbital Voice posted 'Head of Inference Platform'", '2026-10-14', '/job/search', 'metadata.date_added'),
  ev('ev_on', 'Nimbus Docs added 2 people with inference/serving titles', '2026-11-02', '/person/search', 'experience.employment_details.current.start_date', 2),
  ev('ev_bk', "Kestrel Labs posted 'Staff Inference Engineer'", '2026-09-19', '/job/search', 'metadata.date_added'),
  ev('ev_bp', "Pico Robotics posted 'ML Platform Engineer'", '2026-09-28', '/job/search', 'metadata.date_added'),
  ev('ev_bv', "Vela Analytics posted 'ML Engineer' (baseline pick)", '2026-08-12', '/job/search', 'metadata.date_added'),
  ev('ev_bm', "Marlow AI posted 'Applied ML Engineer' (baseline pick)", '2026-08-25', '/job/search', 'metadata.date_added'),
  ev('ev_bj', "Juniper Vision posted 'ML Engineer, CV' (baseline pick)", '2026-08-08', '/job/search', 'metadata.date_added'),
  ev('ev_bo', "Orchid Data posted 'ML Ops Engineer' (baseline pick)", '2026-08-29', '/job/search', 'metadata.date_added'),
  ev('ev_bpp', "Pico Robotics posted 'Robotics ML Engineer' (baseline pick)", '2026-08-18', '/job/search', 'metadata.date_added'),
  ev('ev_bkk', "Kestrel Labs posted 'ML Engineer' (baseline pick)", '2026-08-21', '/job/search', 'metadata.date_added'),
  // can't verify
  { ...ev('ev_x1', "Orbital Voice's current GPU provider", null, '/company/enrich', 'technographics.technologies'), verifiable: false },
];

const companies: Company[] = [
  co('co_kestrel', 'Kestrel Labs', 'kestrel.ai', 248, ['ev_k1', 'ev_k2', 'ev_k3', 'ev_k4', 'ev_k5', 'ev_s1'], ['Kestrel Labs Pvt. Ltd.']),
  co('co_lumen', 'Lumen Serve', 'lumenserve.io', 90, ['ev_l1']),
  co('co_orbital', 'Orbital Voice', 'orbitalvoice.ai', 140, ['ev_o0', 'ev_oo', 'ev_x1']),
  co('co_tessera', 'Tessera Health AI', 'tessera.health', 75, ['ev_l2', 'ev_ot']),
  co('co_halcyon', 'Halcyon Retail AI', 'halcyon.ai', 120, ['ev_l3', 'ev_oh']),
  co('co_nimbus', 'Nimbus Docs', 'nimbusdocs.ai', 60, ['ev_n1', 'ev_on']),
  co('co_quill', 'Quill Legal AI', 'quill.legal', 45, ['ev_q1']),
  co('co_saffron', 'Saffron Speech', 'saffronspeech.ai', 95, ['ev_s1']),
  co('co_pico', 'Pico Robotics', 'pico.dev', 180, ['ev_bpp', 'ev_bp']),
  co('co_vela', 'Vela Analytics', 'vela.ai', 210, ['ev_bv']),
  co('co_marlow', 'Marlow AI', 'marlow.ai', 65, ['ev_bm']),
  co('co_juniper', 'Juniper Vision', 'junipervision.ai', 130, ['ev_bj']),
  co('co_orchid', 'Orchid Data', 'orchiddata.io', 55, ['ev_bo']),
];

const replayNodes: GraphNode[] = [
  node('co_kestrel', 'Kestrel Labs', 0, null, ['DIRECT', 'CAPITAL'], false, ['ev_k1', 'ev_k2', 'ev_k3', 'ev_k5']),
  node('co_lumen', 'Lumen Serve', 0, null, ['DISPLACEMENT'], false, ['ev_l1']),
  node('co_orbital', 'Orbital Voice', 1, 0.71, ['TALENT_DRAIN'], true, ['ev_o0', 'ev_k1', 'ev_k2', 'ev_k3'], 'managed inference (buy vs rebuild)'),
  node('co_saffron', 'Saffron Speech', 1, 0.44, ['TALENT_DRAIN'], true, ['ev_s1'], 'managed inference (buy vs rebuild)'),
  node('co_nimbus', 'Nimbus Docs', 1, 0.46, ['CONTAGION'], true, ['ev_n1'], 'follow a competitor into inference spend'),
  node('co_quill', 'Quill Legal AI', 1, 0.38, ['CONTAGION'], true, ['ev_q1'], 'follow a competitor into inference spend'),
  node('co_tessera', 'Tessera Health AI', 1, 0.64, ['DISPLACEMENT'], true, ['ev_l1', 'ev_l2'], 'migrate off Lumen Serve endpoints'),
  node('co_halcyon', 'Halcyon Retail AI', 1, 0.52, ['DISPLACEMENT'], true, ['ev_l1', 'ev_l3'], 'migrate off Lumen Serve endpoints'),
];

const replayEdges: GraphEdge[] = [
  edge('ed_ko', 'co_kestrel', 'co_orbital', 'TALENT_DRAIN', '3 of 7 serving engineers to Kestrel · 24 Jun–30 Jul', 0.71, '2026-07-30', ['ev_k1', 'ev_k2', 'ev_k3', 'ev_o0'], 0, 'Orbital may backfill and rebuild in-house'),
  edge('ed_ks', 'co_kestrel', 'co_saffron', 'TALENT_DRAIN', '2 inference engineers to Kestrel · 21 Jul', 0.44, '2026-07-21', ['ev_s1'], 1, 'Two people may be ordinary churn'),
  edge('ed_kn', 'co_kestrel', 'co_nimbus', 'CONTAGION', 'Peer of Kestrel, which raised a Series B · 4 Aug', 0.46, '2026-08-20', ['ev_n1', 'ev_k5'], 2, 'Nimbus may wait a quarter'),
  edge('ed_kq', 'co_kestrel', 'co_quill', 'CONTAGION', 'Peer of Kestrel · similarity 0.74', 0.38, '2026-08-20', ['ev_q1', 'ev_k5'], 3, 'Different buyer (legal), weaker peer link'),
  edge('ed_lt', 'co_lumen', 'co_tessera', 'DISPLACEMENT', 'Its stack names Lumen Serve, repriced 19 Aug', 0.64, '2026-08-19', ['ev_l1', 'ev_l2'], 4, 'Tessera may absorb the new price'),
  edge('ed_lh', 'co_lumen', 'co_halcyon', 'DISPLACEMENT', 'Its stack names Lumen Serve, repriced 19 Aug', 0.52, '2026-08-19', ['ev_l1', 'ev_l3'], 5, 'Halcyon may self-host instead of switching'),
];

function outcome(companyId: string, predictedBy: ReplayOutcome['predictedBy'], hit: boolean, outcomeDate: string | null, text: string, evidenceIds: string[]): ReplayOutcome {
  return { companyId, predictedBy, hit, outcomeDate, outcome: text, evidenceIds };
}

const outcomes: ReplayOutcome[] = [
  outcome('co_tessera', 'domino', true, '2026-09-23', "posted 'ML Engineer, model-serving migration' 23 Sep", ['ev_ot']),
  outcome('co_halcyon', 'domino', true, '2026-10-06', "posted 'Inference Platform Engineer' 6 Oct", ['ev_oh']),
  outcome('co_orbital', 'domino', true, '2026-10-14', "posted 'Head of Inference Platform' 14 Oct", ['ev_oo']),
  outcome('co_nimbus', 'domino', true, '2026-11-02', 'added 2 inference engineers 2 Nov', ['ev_on']),
  outcome('co_quill', 'domino', false, null, 'no dated sign by 22 Nov', []),
  outcome('co_saffron', 'domino', false, null, 'no dated sign by 22 Nov', []),
  outcome('co_kestrel', 'baseline_first_order', true, '2026-09-19', "posted 'Staff Inference Engineer' 19 Sep", ['ev_bk']),
  outcome('co_pico', 'baseline_first_order', true, '2026-09-28', "posted 'ML Platform Engineer' 28 Sep", ['ev_bp']),
  outcome('co_vela', 'baseline_first_order', false, null, 'no dated sign by 22 Nov', []),
  outcome('co_marlow', 'baseline_first_order', false, null, 'no dated sign by 22 Nov', []),
  outcome('co_juniper', 'baseline_first_order', false, null, 'no dated sign by 22 Nov', []),
  outcome('co_orchid', 'baseline_first_order', false, null, 'no dated sign by 22 Nov', []),
];

function targetsFrom(nodes: GraphNode[]): Target[] {
  return nodes.filter((n) => n.tier > 0).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).map((n, i) => ({
    companyId: n.id, rank: i + 1, score: n.confidence ?? 0, confidence: n.confidence ?? 0, need: n.need ?? '',
    mechanisms: n.mechanisms, netNew: n.netNew, whyNow: n.need ?? '', whyNowDate: null, decider: null, path: null, draftId: null,
  }));
}

function base(id: string, request: string): RunSnapshot {
  return {
    id, request, status: 'completed', dataMode: 'fixture', llm: 'template',
    createdAt: '2026-11-22T13:05:00+05:30', updatedAt: '2026-11-22T13:06:10+05:30',
    intent: null, steps: [],
    budget: { limits: { maxCredits: 800, maxModelUsd: 2, maxSeconds: 300 }, used: { credits: 0, modelUsd: 0, seconds: 42 }, exhausted: null },
    companies, people: [], triggers: [], merges: [], keptApart: [], graph: { nodes: [], edges: [] }, targets: [], drafts: [],
    evidence, approvals: [], outbox: [], ledger: [], asks: [],
    baseline: { hiringFilterCompanyIds: [] },
    engine: { pid: null, alive: false, crashes: 0, resumes: 0 },
    replay: null,
  };
}

export const replayFixture: RunSnapshot = {
  ...base('run_fx_replay', 'We sell managed GPU inference. Find AI companies likely to need it, replayed from 1 Sep 2026.'),
  intent: {
    offering: 'managed GPU inference', buyerProfile: 'AI companies', geography: 'India', windowDays: 90, asOf: '2026-09-01',
    deciderTitles: ['CTO', 'VP Engineering', 'Head of ML Platform'], signalKeywords: ['inference', 'serving', 'GPU'],
    maxTargets: 6, parsedBy: 'rules', runKind: 'replay', horizonEnd: '2026-11-22', assumptions: [],
  },
  graph: { nodes: replayNodes, edges: replayEdges },
  targets: targetsFrom(replayNodes),
  baseline: { hiringFilterCompanyIds: ['co_kestrel', 'co_pico', 'co_vela', 'co_marlow', 'co_juniper', 'co_orchid'] },
  replay: {
    asOf: '2026-09-01', horizonEnd: '2026-11-22', factsAfterAsOfUsed: 0,
    domino: { predicted: 6, hits: 4, precision: 4 / 6, medianLeadDays: 39 },
    baselineFirstOrder: { predicted: 6, hits: 2, precision: 2 / 6, medianLeadDays: 23 },
    baselineHeadcount: { predicted: 6, hits: 1, precision: 1 / 6, medianLeadDays: null },
    outcomes,
    note: 'Fixture world: DOMINO 4 of 6, hiring filter 2 of 6. Saffron and Quill showed nothing by 22 Nov.',
  },
};

// Live run, as of 22 Nov: the lead's fixture story (Kestrel hired 3 of Orbital's serving engineers 27 Oct–12 Nov,
// Lumen Serve acquired 1 Nov).
const liveEvidence: Evidence[] = [
  ev('ev_lk1', 'Kestrel Labs hired 3 serving engineers whose previous employer was Orbital Voice', '2026-11-12', '/person/search', 'experience.employment_details.current.start_date', 3),
  ev('ev_ll1', 'Lumen Serve was acquired; hosted endpoints sunset in 90 days', '2026-11-01', '/social_post/search', 'date_posted'),
  ev('ev_ll2', 'Tessera Health AI job post names Lumen Serve endpoints', '2026-10-20', '/job/search', 'content.description'),
  ev('ev_ln1', 'Nimbus Docs is a competitor of Kestrel Labs', '2026-11-15', '/company/enrich', 'competitors.all_domains'),
  ev('ev_lq1', 'Quill Legal AI is a competitor of Kestrel Labs', '2026-11-15', '/company/enrich', 'competitors.all_domains'),
  ev('ev_lk2', "Kestrel Labs posted 'Staff Inference Engineer'", '2026-11-04', '/job/search', 'metadata.date_added'),
];
export const liveFixture: RunSnapshot = {
  ...base('run_fx_live', 'We sell managed GPU inference. Find AI companies whose changes in the last 30 days mean they need it.'),
  evidence: [...liveEvidence, evidence.find((e) => e.id === 'ev_x1')!],
  intent: {
    offering: 'managed GPU inference', buyerProfile: 'AI companies', geography: 'India', windowDays: 30, asOf: '2026-11-22',
    deciderTitles: ['CTO', 'VP Engineering'], signalKeywords: ['inference'], maxTargets: 5, parsedBy: 'rules', runKind: 'live',
    horizonEnd: null, assumptions: [],
  },
  graph: {
    nodes: [
      node('co_kestrel', 'Kestrel Labs', 0, 0.58, ['DIRECT'], false, ['ev_lk1', 'ev_lk2'], 'inference capacity (first-order)'),
      node('co_lumen', 'Lumen Serve', 0, null, ['DISPLACEMENT'], false, ['ev_ll1']),
      node('co_orbital', 'Orbital Voice', 1, 0.72, ['TALENT_DRAIN'], true, ['ev_lk1', 'ev_x1'], 'managed inference (buy vs rebuild)'),
      node('co_tessera', 'Tessera Health AI', 1, 0.66, ['DISPLACEMENT'], true, ['ev_ll1', 'ev_ll2'], 'migrate off Lumen Serve'),
      node('co_nimbus', 'Nimbus Docs', 1, 0.41, ['CONTAGION'], true, ['ev_ln1'], 'follow Kestrel into inference spend'),
      node('co_quill', 'Quill Legal AI', 1, 0.36, ['CONTAGION'], true, ['ev_lq1'], 'follow Kestrel into inference spend'),
    ],
    edges: [
      edge('ed_lko', 'co_kestrel', 'co_orbital', 'TALENT_DRAIN', '3 serving engineers to Kestrel · 27 Oct–12 Nov', 0.72, '2026-11-12', ['ev_lk1'], 0, 'Orbital may backfill'),
      edge('ed_lkn', 'co_kestrel', 'co_nimbus', 'CONTAGION', 'Peer of Kestrel · 15 Nov', 0.41, '2026-11-15', ['ev_ln1', 'ev_lk2'], 1, null),
      edge('ed_lkq', 'co_kestrel', 'co_quill', 'CONTAGION', 'Peer of Kestrel · 15 Nov', 0.36, '2026-11-15', ['ev_lq1', 'ev_lk2'], 2, null),
      edge('ed_llt', 'co_lumen', 'co_tessera', 'DISPLACEMENT', 'Lumen Serve acquired 1 Nov', 0.66, '2026-11-01', ['ev_ll1', 'ev_ll2'], 3, 'Tessera may self-host'),
    ],
  },
  baseline: { hiringFilterCompanyIds: ['co_kestrel'] },
};
liveFixture.targets = targetsFrom(liveFixture.graph.nodes);
