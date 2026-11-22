// Recorded mock run. FICTIONAL companies and people only. Shapes conform exactly to shared/types.ts,
// so the same reducer handles mock and real runs. A scenario is a list of timed RunEvents grouped by step;
// the mock player (./player.ts) turns them into StoredEvents and simulates kill, resume, asks and approvals.
import type {
  Approval, BudgetState, Decider, Draft, Evidence, GraphEdge, GraphNode, Intent, LedgerEntry, Mechanism,
  ReplayOutcome, ReplayScore, RunEvent, StepName, Target, Trigger, WarmPath,
} from '../../../shared/types.ts';
import { fmtDate, fmtRange } from '../dates.ts';
import { STEP_LABELS } from '../state.ts';

export type ScenarioKind = 'live' | 'ask' | 'replay';

export interface ScriptItem {
  step: StepName | null;
  /** ms to wait before emitting (at speed 1) */
  delay: number;
  event?: RunEvent;
  /** player stops here until the user acts */
  pause?: 'ask';
}

export interface Scenario {
  kind: ScenarioKind;
  runId: string;
  request: string;
  dataMode: 'live';
  llm: string;
  script: ScriptItem[];
  limits: BudgetState['limits'];
}

export const MAIN_REQUEST =
  "We sell managed GPU inference. Find AI companies whose changes in the last 30 days mean they'll need it, and book me meetings with the people who decide.";
export const MESSY_REQUEST = 'pls find ai cos needing gpu infra, india, meetings w deciders';
export const REPLAY_REQUEST =
  'Replay as of 1 Sep 2026: we sell managed GPU inference. Which AI companies would have needed it, and were we right by 22 Nov?';

export function scenarioFor(request: string): ScenarioKind {
  const r = request.toLowerCase();
  if (r.startsWith('replay') || r.includes('as of 1 sep')) return 'replay';
  if (!/\bwe sell\b|\bour product\b|\bwe offer\b/.test(r)) return 'ask';
  return 'live';
}

// ---------- the world ----------

const CO = {
  kestrel: 'co_kestrel', orbital: 'co_orbital', nimbus: 'co_nimbus', lumen: 'co_lumen', tessera: 'co_tessera',
  quill: 'co_quill', quillwrite: 'co_quillwrite',
} as const;

interface WorldDates {
  moves: [string, string, string]; kestrelPost: string; orbitalFunding: string; orbitalHeadcount: string;
  orbitalNoRoles: string; lumenAcq: string; lumenSunset: string; tesseraPost: string; tesseraFunding: string;
  tesseraNoRoles: string; nimbusClosed: string; nimbusHeadcount: string; quillHeadcount: string;
  deciderOrbital: string; deciderTessera: string; deciderNimbus: string; deciderKestrel: string;
}

const LIVE_DATES: WorldDates = {
  moves: ['2026-10-27', '2026-11-04', '2026-11-12'], kestrelPost: '2026-11-06', orbitalFunding: '2026-10-09',
  orbitalHeadcount: '2026-11-15', orbitalNoRoles: '2026-11-20', lumenAcq: '2026-11-01', lumenSunset: '2026-11-03',
  tesseraPost: '2026-10-29', tesseraFunding: '2026-11-04', tesseraNoRoles: '2026-11-20', nimbusClosed: '2026-11-08',
  nimbusHeadcount: '2026-11-15', quillHeadcount: '2026-11-01',
  deciderOrbital: '2025-03-01', deciderTessera: '2024-08-01', deciderNimbus: '2025-11-01', deciderKestrel: '2024-02-01',
};

const REPLAY_DATES: WorldDates = {
  moves: ['2026-08-04', '2026-08-13', '2026-08-22'], kestrelPost: '2026-08-18', orbitalFunding: '2026-07-21',
  orbitalHeadcount: '2026-08-25', orbitalNoRoles: '2026-08-30', lumenAcq: '2026-08-12', lumenSunset: '2026-08-14',
  tesseraPost: '2026-08-07', tesseraFunding: '2026-08-19', tesseraNoRoles: '2026-08-30', nimbusClosed: '2026-08-20',
  nimbusHeadcount: '2026-08-27', quillHeadcount: '2026-08-10',
  deciderOrbital: '2025-03-01', deciderTessera: '2024-08-01', deciderNimbus: '2025-11-01', deciderKestrel: '2024-02-01',
};

function retrieved(offsetSec: number, base = '2026-11-22T07:31:00.000Z') {
  return new Date(Date.parse(base) + offsetSec * 1000).toISOString();
}

function world(kind: ScenarioKind) {
  const D = kind === 'replay' ? REPLAY_DATES : LIVE_DATES;
  const ev = (id: string, claim: string, observedAt: string | null, endpoint: string, field: string, value: Evidence['value'], extra: Partial<Evidence> = {}): Evidence => ({
    id, claim, value, observedAt, retrievedAt: retrieved(4), mode: 'live', verifiable: observedAt !== null,
    source: { provider: 'crustdata', endpoint, recordId: `${id.replace('ev_', 'rec_')}`, field },
    ...extra,
  });

  const evidence = {
    k1: ev('ev_k1', 'Kestrel Labs hired a Senior Inference Engineer whose previous employer was Orbital Voice', D.moves[0], '/person/search', 'current_employers[0].start_date', 'Orbital Voice'),
    k2: ev('ev_k2', 'Kestrel Labs hired an ML Serving Engineer whose previous employer was Orbital Voice', D.moves[1], '/person/search', 'current_employers[0].start_date', 'Orbital Voice'),
    k3: ev('ev_k3', 'Kestrel Labs hired a Staff Engineer, Model Serving whose previous employer was Orbital Voice', D.moves[2], '/person/search', 'current_employers[0].start_date', 'Orbital Voice'),
    k4: ev('ev_k4', "Kestrel Labs posted 'Inference Platform Engineer'", D.kestrelPost, '/job/search', 'job_listings[3].date_posted', 'Inference Platform Engineer', { source: { provider: 'crustdata', endpoint: '/job/search', recordId: 'job_88213', field: 'job_listings[3].title', url: 'https://jobs.example/kestrel-labs/inference-platform-engineer' } }),
    o1: ev('ev_o1', 'Orbital Voice engineering headcount fell 6% in one month', D.orbitalHeadcount, '/company/enrich', 'headcount.by_function.engineering.mom_pct', -6),
    o2: ev('ev_o2', 'Orbital Voice has 0 open inference or ML serving roles', D.orbitalNoRoles, '/job/search', 'job_listings.length', 0),
    o3: ev('ev_o3', "Orbital Voice's current GPU provider, named only in an undated forum post", null, '/web/search', 'results[0].snippet', null, { source: { provider: 'web', endpoint: '/web/search', field: 'results[0].snippet' }, verifiable: false }),
    o4: ev('ev_o4', 'Orbital Voice raised a $22M Series A', D.orbitalFunding, '/company/enrich', 'funding.last_round.date', '22000000'),
    l1: ev('ev_l1', 'Lumen Serve was acquired; the buyer announced it on its newsroom', D.lumenAcq, '/company/enrich', 'news[0].date', 'acquired', { source: { provider: 'web', endpoint: '/news', field: 'items[0].published_at', url: 'https://news.example/lumen-serve-acquired' } }),
    l2: ev('ev_l2', 'Lumen Serve stops taking new hosted workloads on 31 Jan 2027', D.lumenSunset, '/company/enrich', 'news[1].date', '2027-01-31'),
    t1: ev('ev_t1', "Tessera Health AI posted 'Clinical NLP Engineer'; the requirements name the Lumen Serve SDK", D.tesseraPost, '/job/search', 'job_listings[0].description', 'Lumen Serve SDK', { source: { provider: 'crustdata', endpoint: '/job/search', recordId: 'job_77104', field: 'job_listings[0].description', url: 'https://jobs.example/tessera-health-ai/clinical-nlp-engineer' } }),
    t2: ev('ev_t2', 'Tessera Health AI raised a $40M Series B', D.tesseraFunding, '/company/enrich', 'funding.last_round.date', '40000000'),
    t3: ev('ev_t3', 'Tessera Health AI has 0 open infrastructure roles', D.tesseraNoRoles, '/job/search', 'job_listings.length', 0),
    n1: ev('ev_n1', "Nimbus Docs closed its 'GPU Infrastructure Engineer' post", D.nimbusClosed, '/job/search', 'job_listings[2].date_closed', 'GPU Infrastructure Engineer'),
    n2: ev('ev_n2', 'Nimbus Docs headcount grew 4% in three months with no infrastructure hires', D.nimbusHeadcount, '/company/enrich', 'headcount.qoq_pct', 4),
    n3: ev('ev_n3', 'Nimbus Docs lists Orbital Voice as a peer (same lead investor, same model size)', D.orbitalHeadcount, '/company/enrich', 'competitors[1]', 'Orbital Voice', { mode: 'cache', retrievedAt: '2026-11-21T18:02:00.000Z' }),
    q1: ev('ev_q1', 'Quill Legal AI headcount grew 12% in three months', D.quillHeadcount, '/company/enrich', 'headcount.qoq_pct', 12),
    q2: ev('ev_q2', 'Quill Legal AI is listed as a Tessera Health AI peer on an undated profile page', null, '/company/enrich', 'competitors[0]', 'Tessera Health AI', { verifiable: false }),
    d1: ev('ev_d1', 'Anika Rao is VP Engineering at Orbital Voice', D.deciderOrbital, '/person/search', 'current_employers[0].title', 'VP Engineering'),
    d2: ev('ev_d2', 'Daniel Okafor is CTO at Tessera Health AI', D.deciderTessera, '/person/search', 'current_employers[0].title', 'CTO'),
    d3: ev('ev_d3', 'Meera Iyer is Head of ML Platform at Nimbus Docs', D.deciderNimbus, '/person/search', 'current_employers[0].title', 'Head of ML Platform'),
    d4: ev('ev_d4', 'Tomás Rivera is VP Infrastructure at Kestrel Labs', D.deciderKestrel, '/person/search', 'current_employers[0].title', 'VP Infrastructure'),
    m1: ev('ev_m1', '“Kestrel Labs” and “Kestrel Labs Pvt. Ltd.” share the domain kestrel-labs.ai and one Crustdata id', D.kestrelPost, '/company/enrich', 'company_website_domain', 'kestrel-labs.ai'),
  };

  const triggers: Trigger[] = [
    { id: 'tr_k1', companyId: CO.kestrel, kind: 'hire', date: D.moves[2], summary: `Hired 3 serving engineers from Orbital Voice`, relatedCompanyId: CO.orbital, evidenceIds: ['ev_k1', 'ev_k2', 'ev_k3'] },
    { id: 'tr_k2', companyId: CO.kestrel, kind: 'job_post', date: D.kestrelPost, summary: "Posted 'Inference Platform Engineer'", evidenceIds: ['ev_k4'] },
    { id: 'tr_o1', companyId: CO.orbital, kind: 'departure', date: D.moves[2], summary: 'Lost 3 serving engineers to Kestrel Labs', relatedCompanyId: CO.kestrel, evidenceIds: ['ev_k1', 'ev_k2', 'ev_k3', 'ev_o1'] },
    { id: 'tr_l1', companyId: CO.lumen, kind: 'post', date: D.lumenAcq, summary: 'Acquired; hosted API stops new workloads 31 Jan', evidenceIds: ['ev_l1', 'ev_l2'] },
    { id: 'tr_t1', companyId: CO.tessera, kind: 'job_post', date: D.tesseraPost, summary: 'Job post names the Lumen Serve SDK', relatedCompanyId: CO.lumen, evidenceIds: ['ev_t1'] },
    { id: 'tr_t2', companyId: CO.tessera, kind: 'funding', date: D.tesseraFunding, summary: 'Raised a $40M Series B', evidenceIds: ['ev_t2'] },
    { id: 'tr_n1', companyId: CO.nimbus, kind: 'job_post', date: D.nimbusClosed, summary: "Closed its 'GPU Infrastructure Engineer' post", evidenceIds: ['ev_n1'] },
    { id: 'tr_q1', companyId: CO.quill, kind: 'headcount_jump', date: D.quillHeadcount, summary: 'Headcount up 12% in three months', evidenceIds: ['ev_q1'] },
  ];

  const node = (id: string, name: string, tier: number, need: string | null, confidence: number | null, mechanisms: Mechanism[], netNew: boolean, triggerIds: string[], evidenceIds: string[], status: GraphNode['status'] = 'hypothesis'): GraphNode =>
    ({ id, name, tier, need, confidence, mechanisms, netNew, triggerIds, evidenceIds, status });

  const nodes: GraphNode[] = [
    node(CO.kestrel, 'Kestrel Labs', 0, 'Inference platform, already hiring for it', 0.55, ['DIRECT'], false, ['tr_k1', 'tr_k2'], ['ev_k1', 'ev_k2', 'ev_k3', 'ev_k4']),
    node(CO.lumen, 'Lumen Serve', 0, null, null, [], false, ['tr_l1'], ['ev_l1', 'ev_l2']),
    node(CO.orbital, 'Orbital Voice', 1, 'Managed inference: buy, since the serving team is gone', 0.81, ['TALENT_DRAIN', 'CAPITAL'], true, ['tr_o1'], ['ev_k1', 'ev_k2', 'ev_k3', 'ev_o1', 'ev_o2', 'ev_o4', 'ev_o3']),
    node(CO.tessera, 'Tessera Health AI', 1, 'Migrate off Lumen Serve before 31 Jan', 0.74, ['DISPLACEMENT', 'CAPITAL'], true, ['tr_t1', 'tr_t2'], ['ev_t1', 'ev_l1', 'ev_l2', 'ev_t2', 'ev_t3']),
    node(CO.nimbus, 'Nimbus Docs', 2, 'Managed inference instead of a GPU hire', 0.58, ['CONTAGION'], true, ['tr_n1'], ['ev_n1', 'ev_n2', 'ev_n3']),
    node(CO.quill, 'Quill Legal AI', 2, 'Possibly the same migration as its peer', 0.34, ['CONTAGION'], true, ['tr_q1'], ['ev_q1', 'ev_q2'], 'unverifiable'),
  ];

  const edges: GraphEdge[] = [
    {
      id: 'ed_1', from: CO.kestrel, to: CO.orbital, mechanism: 'TALENT_DRAIN', order: 0, confidence: 0.81, observedAt: D.moves[2],
      label: `3 serving engineers left for Kestrel Labs, ${fmtRange(D.moves)}`,
      rationale: `Kestrel Labs hired three of Orbital Voice's inference and serving engineers between ${fmtDate(D.moves[0])} and ${fmtDate(D.moves[2])}, and Orbital Voice has no open serving roles. A team that loses most of its serving staff in three weeks cannot rebuild in-house quickly, so buying managed inference is the likely move.`,
      evidenceIds: ['ev_k1', 'ev_k2', 'ev_k3', 'ev_o1', 'ev_o2'],
      alternative: 'The moves may be a planned wind-down of self-hosting that is already covered by a vendor.',
    },
    {
      id: 'ed_2', from: CO.lumen, to: CO.tessera, mechanism: 'DISPLACEMENT', order: 1, confidence: 0.74, observedAt: D.lumenSunset,
      label: `Lumen Serve acquired ${fmtDate(D.lumenAcq)}; Tessera's ${fmtDate(D.tesseraPost)} post names it`,
      rationale: `Tessera Health AI's ${fmtDate(D.tesseraPost)} job post names the Lumen Serve SDK. Lumen Serve was acquired on ${fmtDate(D.lumenAcq)} and stops taking new hosted workloads on 31 Jan 2027, so Tessera has to pick a new inference provider on a deadline.`,
      evidenceIds: ['ev_t1', 'ev_l1', 'ev_l2'],
      alternative: 'Tessera may self-host Lumen Serve’s open-source runtime and not need a vendor.',
    },
    {
      id: 'ed_3', from: CO.orbital, to: CO.nimbus, mechanism: 'CONTAGION', order: 2, confidence: 0.58, observedAt: D.nimbusClosed,
      label: `Peer of Orbital Voice; closed its GPU infra post ${fmtDate(D.nimbusClosed)}`,
      rationale: 'Nimbus Docs lists Orbital Voice as a peer with the same lead investor and model size. Its peer just lost its serving team; Nimbus closed its only GPU infrastructure post and has made no infrastructure hires, so it is likely to follow toward managed inference.',
      evidenceIds: ['ev_n1', 'ev_n2', 'ev_n3'],
      alternative: 'Nimbus may have paused GPU hiring for budget reasons and not plan any infrastructure change.',
    },
    {
      id: 'ed_4', from: CO.tessera, to: CO.quill, mechanism: 'CONTAGION', order: 3, confidence: 0.34, observedAt: D.quillHeadcount,
      label: 'Peer link is undated; only one dated row',
      rationale: 'Quill Legal AI looks like a Tessera Health AI peer, but the peer listing is undated and only one dated fact (headcount growth) supports it. A rule needs two dated rows to fire, so this stays a hypothesis that DOMINO will not act on.',
      evidenceIds: ['ev_q1', 'ev_q2'],
      alternative: 'The peer listing may be stale; Quill may use a different provider entirely.',
    },
  ];

  const deciders: Record<string, Decider> = {
    [CO.orbital]: { personId: 'pe_anika', name: 'Anika Rao', title: 'VP Engineering', tenureSince: D.deciderOrbital, reason: 'Owns the platform and infra budget; the serving team reported to her.', evidenceIds: ['ev_d1'] },
    [CO.tessera]: { personId: 'pe_daniel', name: 'Daniel Okafor', title: 'CTO', tenureSince: D.deciderTessera, reason: 'No ML platform lead on record; the CTO signs infrastructure vendors at this size.', evidenceIds: ['ev_d2'] },
    [CO.nimbus]: { personId: 'pe_meera', name: 'Meera Iyer', title: 'Head of ML Platform', tenureSince: D.deciderNimbus, reason: 'Hired a year ago to own model serving; the closed GPU post was on her team.', evidenceIds: ['ev_d3'] },
    [CO.kestrel]: { personId: 'pe_tomas', name: 'Tomás Rivera', title: 'VP Infrastructure', tenureSince: D.deciderKestrel, reason: 'Hiring manager on the inference platform post.', evidenceIds: ['ev_d4'] },
  };

  const paths: Record<string, WarmPath> = {
    [CO.orbital]: { strength: 'warm', score: 0.62, explanation: 'A teammate worked with Anika Rao at a previous employer (2021-2023).', evidenceIds: ['ev_d1'], hops: [{ label: 'You', kind: 'you' }, { label: 'Teammate, same employer 2021-2023', kind: 'shared_employer' }, { label: 'Anika Rao', kind: 'decider' }] },
    [CO.tessera]: { strength: 'cold', score: 0.12, explanation: 'No shared employer or customer link found.', evidenceIds: [], hops: [{ label: 'You', kind: 'you' }, { label: 'Daniel Okafor', kind: 'decider' }] },
    [CO.nimbus]: { strength: 'lukewarm', score: 0.35, explanation: 'One existing customer shares a lead investor with Nimbus Docs.', evidenceIds: ['ev_n3'], hops: [{ label: 'You', kind: 'you' }, { label: 'Customer, same lead investor', kind: 'customer' }, { label: 'Meera Iyer', kind: 'decider' }] },
  };

  const targets: Target[] = [
    { companyId: CO.orbital, rank: 1, score: 0.84, confidence: 0.81, need: 'Managed inference: buy, since the serving team is gone', mechanisms: ['TALENT_DRAIN', 'CAPITAL'], netNew: true, whyNow: '3 serving engineers left in three weeks; no open serving roles', whyNowDate: D.moves[2], decider: null, path: null, draftId: null },
    { companyId: CO.tessera, rank: 2, score: 0.77, confidence: 0.74, need: 'Migrate off Lumen Serve before 31 Jan', mechanisms: ['DISPLACEMENT', 'CAPITAL'], netNew: true, whyNow: 'Its provider was acquired and sunsets new workloads', whyNowDate: D.lumenAcq, decider: null, path: null, draftId: null },
    { companyId: CO.nimbus, rank: 3, score: 0.6, confidence: 0.58, need: 'Managed inference instead of a GPU hire', mechanisms: ['CONTAGION'], netNew: true, whyNow: 'Peer lost its serving team; closed its own GPU post', whyNowDate: D.nimbusClosed, decider: null, path: null, draftId: null },
    { companyId: CO.kestrel, rank: 4, score: 0.52, confidence: 0.55, need: 'Inference platform, already hiring for it', mechanisms: ['DIRECT'], netNew: false, whyNow: "Posted 'Inference Platform Engineer'", whyNowDate: D.kestrelPost, decider: null, path: null, draftId: null },
  ];

  const drafts: Draft[] = [
    {
      id: 'dr_orbital', companyId: CO.orbital, personId: 'pe_anika', generator: 'llm:claude-sonnet-5-5', verified: true,
      subject: 'Serving capacity after the Series A',
      body: `Hi Anika, congratulations on the $22M Series A in ${fmtDate(D.orbitalFunding, { year: false })} [1]. I noticed Orbital Voice has no open inference or serving roles right now [2], while engineering headcount moved 6% in a month [3]. We run managed GPU inference for voice models, so your team ships features instead of operating clusters. Worth 20 minutes next week?`,
      citations: [{ marker: 1, evidenceId: 'ev_o4' }, { marker: 2, evidenceId: 'ev_o2' }, { marker: 3, evidenceId: 'ev_o1' }],
      unverifiable: [{ claim: "Orbital Voice's current GPU provider", reason: 'Only an undated forum post names it; no dated source.' }],
      checks: [
        { sentence: 'Hi Anika, congratulations on the $22M Series A [1].', status: 'cited', evidenceIds: ['ev_o4'] },
        { sentence: 'I noticed Orbital Voice has no open inference or serving roles right now [2], while engineering headcount moved 6% in a month [3].', status: 'cited', evidenceIds: ['ev_o2', 'ev_o1'] },
        { sentence: 'Your current GPU provider has been raising prices this quarter.', status: 'removed', evidenceIds: [], note: 'No evidence row supports a price change or names the provider.' },
        { sentence: 'We run managed GPU inference for voice models, so your team ships features instead of operating clusters.', status: 'no_claim', evidenceIds: [] },
        { sentence: 'Worth 20 minutes next week?', status: 'no_claim', evidenceIds: [] },
      ],
      meeting: { title: 'Managed inference for Orbital Voice', durationMin: 20, proposedSlots: ['2026-11-25T05:30:00.000Z', '2026-11-26T09:00:00.000Z'] },
    },
    {
      id: 'dr_tessera', companyId: CO.tessera, personId: 'pe_daniel', generator: 'llm:claude-sonnet-5-5', verified: true,
      subject: 'Lumen Serve after 31 Jan',
      body: `Hi Daniel, your ${fmtDate(D.tesseraPost)} Clinical NLP Engineer post names the Lumen Serve SDK [1]. Lumen Serve was acquired on ${fmtDate(D.lumenAcq)} [2] and stops taking new hosted workloads on 31 Jan 2027 [3]. Congratulations on the Series B [4]. We serve the same model formats on managed GPUs, so moving is a configuration change rather than a rewrite. Could we find 20 minutes before your next release?`,
      citations: [{ marker: 1, evidenceId: 'ev_t1' }, { marker: 2, evidenceId: 'ev_l1' }, { marker: 3, evidenceId: 'ev_l2' }, { marker: 4, evidenceId: 'ev_t2' }],
      unverifiable: [{ claim: 'How much of Tessera’s traffic runs on Lumen Serve', reason: 'No source states volume or contract terms.' }],
      checks: [
        { sentence: `Hi Daniel, your ${fmtDate(D.tesseraPost)} Clinical NLP Engineer post names the Lumen Serve SDK [1].`, status: 'cited', evidenceIds: ['ev_t1'] },
        { sentence: `Lumen Serve was acquired on ${fmtDate(D.lumenAcq)} [2] and stops taking new hosted workloads on 31 Jan 2027 [3].`, status: 'cited', evidenceIds: ['ev_l1', 'ev_l2'] },
        { sentence: 'Most Lumen Serve customers have already started migrating.', status: 'removed', evidenceIds: [], note: 'No evidence row about other customers.' },
        { sentence: 'Congratulations on the Series B [4].', status: 'cited', evidenceIds: ['ev_t2'] },
        { sentence: 'We serve the same model formats on managed GPUs, so moving is a configuration change rather than a rewrite.', status: 'no_claim', evidenceIds: [] },
      ],
      meeting: { title: 'Lumen Serve migration, Tessera Health AI', durationMin: 20, proposedSlots: ['2026-11-25T08:00:00.000Z', '2026-11-27T06:30:00.000Z'] },
    },
    {
      id: 'dr_nimbus', companyId: CO.nimbus, personId: 'pe_meera', generator: 'llm:claude-sonnet-5-5', verified: true,
      subject: 'Your GPU infrastructure post',
      body: `Hi Meera, I saw Nimbus Docs closed its GPU Infrastructure Engineer post on ${fmtDate(D.nimbusClosed)} [1]. Headcount grew 4% over three months [2]. If the plan is to serve models without adding a cluster team, managed GPU inference covers that. Open to a short call?`,
      citations: [{ marker: 1, evidenceId: 'ev_n1' }, { marker: 2, evidenceId: 'ev_n2' }],
      unverifiable: [{ claim: 'Why the post was closed', reason: 'The listing shows a close date, not a reason.' }],
      checks: [
        { sentence: `Hi Meera, I saw Nimbus Docs closed its GPU Infrastructure Engineer post on ${fmtDate(D.nimbusClosed)} [1].`, status: 'cited', evidenceIds: ['ev_n1'] },
        { sentence: 'Headcount grew 4% over three months [2].', status: 'cited', evidenceIds: ['ev_n2'] },
        { sentence: 'The post was closed because the hire fell through.', status: 'removed', evidenceIds: [], note: 'The listing has no reason field.' },
        { sentence: 'If the plan is to serve models without adding a cluster team, managed GPU inference covers that.', status: 'no_claim', evidenceIds: [] },
      ],
      meeting: { title: 'Managed inference for Nimbus Docs', durationMin: 20, proposedSlots: ['2026-11-26T05:00:00.000Z'] },
    },
  ];

  return { D, evidence, triggers, nodes, edges, deciders, paths, targets, drafts };
}

// ---------- the script ----------

export function buildScenario(kind: ScenarioKind, request: string, runId: string): Scenario {
  const w = world(kind);
  const replay = kind === 'replay';
  const asOf = replay ? '2026-09-01' : '2026-11-22';
  const limits = { maxCredits: 800, maxModelUsd: 1, maxSeconds: 300 };
  const script: ScriptItem[] = [];
  let step: StepName | null = null;
  let simSeconds = 0;
  let ledgerId = 1;
  let callId = 1;
  const used = { credits: 0, modelUsd: 0, seconds: 0 };

  const push = (delay: number, event: RunEvent) => {
    simSeconds += delay / 1000 * 2.6;
    script.push({ step, delay, event });
  };
  const budget = (delay = 40) => {
    used.seconds = Math.round(simSeconds);
    push(delay, { type: 'budget.update', budget: { limits, used: { ...used }, exhausted: null } });
  };
  const begin = (s: StepName) => {
    step = s;
    push(260, { type: 'step.started', step: s, label: STEP_LABELS[s], attempt: 1 });
  };
  const end = (summary: string, durationMs: number) => {
    if (!step) return;
    push(220, { type: 'step.completed', step, summary, durationMs });
  };
  const tool = (endpoint: string, opts: { credits?: number; provider?: LedgerEntry['provider']; latency?: number; fail?: 'timeout' | 'nonsense'; tokens?: [number, number]; usd?: number; mode?: LedgerEntry['mode'] } = {}) => {
    const provider = opts.provider ?? 'crustdata';
    const mode = opts.mode ?? (provider === 'crustdata' ? 'live' : 'model');
    const id = `call_${callId++}`;
    const row = (attempt: number, status: LedgerEntry['status'], credits: number, latencyMs: number, injected: boolean): LedgerEntry => ({
      id: ledgerId++, runId, ts: retrieved(Math.round(simSeconds)), step: step ?? 'parse_request', provider, endpoint, mode, status, attempt, credits,
      inputTokens: opts.tokens?.[0] ?? 0, outputTokens: status === 'ok' ? opts.tokens?.[1] ?? 0 : 0, usd: status === 'ok' ? opts.usd ?? 0 : 0, latencyMs, injected,
    });
    push(80, { type: 'tool.call', callId: id, provider, endpoint, mode, attempt: 1 });
    let attempt = 1;
    if (opts.fail) {
      const latency = opts.fail === 'timeout' ? 12000 : 640;
      push(opts.fail === 'timeout' ? 900 : 380, { type: 'tool.result', callId: id, ok: false, latencyMs: latency, credits: 0, usd: 0, cached: false });
      push(30, { type: 'ledger.entry', entry: row(1, opts.fail, 0, latency, true) });
      push(40, { type: 'tool.retry', callId: id, endpoint: endpoint.replace(/^\//, '').replace('/', '_'), reason: opts.fail, attempt: 1, backoffMs: opts.fail === 'timeout' ? 800 : 400, injected: true });
      attempt = 2;
      push(500, { type: 'tool.call', callId: id, provider, endpoint, mode, attempt });
    }
    const credits = opts.credits ?? 0;
    const latency = opts.latency ?? 700;
    push(Math.min(latency, 700), { type: 'tool.result', callId: id, ok: true, latencyMs: latency, credits, usd: opts.usd ?? 0, cached: false });
    used.credits = +(used.credits + credits).toFixed(2);
    used.modelUsd = +(used.modelUsd + (opts.usd ?? 0)).toFixed(4);
    push(30, { type: 'ledger.entry', entry: row(attempt, 'ok', credits, latency, false) });
    budget();
  };
  const evid = (...rows: Evidence[]) => push(60, { type: 'evidence.added', evidence: rows });

  // ---- run start ----
  push(150, { type: 'run.status', status: 'running' });
  push(80, { type: 'engine.started', pid: 48211, resume: false });

  // ---- parse_request ----
  begin('parse_request');
  tool('claude-haiku-5-5', { provider: 'anthropic', tokens: [612, 188], usd: 0.0021, latency: 820 });
  if (kind === 'ask') {
    push(200, {
      type: 'ask.requested',
      ask: {
        id: 'ask_offering', question: 'What do you sell?',
        why: 'Who "needs GPU infra" depends on the offer: buyers of managed inference are different companies from buyers of raw GPU capacity.',
        options: ['Managed GPU inference', 'Raw GPU cloud capacity', 'MLOps tooling'], default: 'Managed GPU inference',
      },
    });
    push(60, { type: 'run.status', status: 'awaiting_input', note: 'Waiting for one answer' });
    script.push({ step, delay: 0, pause: 'ask' });
    push(200, { type: 'run.status', status: 'running' });
  }
  end(replay ? 'Replay as of 1 Sep 2026, scored to 22 Nov; 4 defaults assumed' : kind === 'ask' ? 'Managed GPU inference, India, last 30 days; 3 defaults assumed' : 'Managed GPU inference, AI companies, last 30 days; 3 defaults assumed', 1240);

  // ---- pull_triggers ----
  begin('pull_triggers');
  tool('/job/search', { credits: 1.2, fail: 'timeout', latency: 1180 });
  evid(w.evidence.k4, w.evidence.t1, w.evidence.n1, w.evidence.o2, w.evidence.t3);
  push(80, { type: 'trigger.found', trigger: w.triggers[1] });
  push(80, { type: 'trigger.found', trigger: w.triggers[4] });
  push(80, { type: 'trigger.found', trigger: w.triggers[6] });
  tool('/person/search', { credits: 40, latency: 1460 });
  evid(w.evidence.k1, w.evidence.k2, w.evidence.k3);
  push(80, { type: 'trigger.found', trigger: w.triggers[0] });
  push(80, { type: 'trigger.found', trigger: w.triggers[2] });
  tool('/company/search', { credits: 0.9, fail: 'nonsense', latency: 640 });
  evid(w.evidence.q1, w.evidence.l1, w.evidence.l2);
  push(80, { type: 'trigger.found', trigger: w.triggers[3] });
  push(80, { type: 'trigger.found', trigger: w.triggers[7] });
  end('8 dated triggers from 3 searches; 1 timeout and 1 bad response retried', 4120);

  // ---- resolve_entities ----
  begin('resolve_entities');
  evid(w.evidence.m1);
  push(300, { type: 'entity.merged', merge: { canonicalId: CO.kestrel, kind: 'company', names: ['Kestrel Labs', 'Kestrel Labs Pvt. Ltd.'], reason: 'Same domain kestrel-labs.ai and the same Crustdata company id', keys: ['domain', 'crustdata_id'] } });
  push(300, { type: 'entity.kept_apart', decision: { kind: 'company', ids: [CO.quill, CO.quillwrite], names: ['Quill Legal AI', 'Quill'], reason: 'Same first word, different domains (quill-legal.ai vs quillwrite.com) and industries' } });
  end('11 mentions became 7 companies; 1 merge, 1 kept apart', 380);

  // ---- enrich_companies ----
  begin('enrich_companies');
  tool('/company/enrich', { credits: 18, latency: 1320 });
  evid(w.evidence.o1, w.evidence.o4, w.evidence.t2, w.evidence.n2, w.evidence.n3, w.evidence.q2);
  push(60, { type: 'trigger.found', trigger: w.triggers[5] });
  push(80, { type: 'tool.fallback', callId: 'call_enrich_peers', endpoint: '/company/enrich', from: 'live', to: 'cache', reason: 'Peer list for Nimbus Docs returned 503 three times; used the cached response from 21 Nov' });
  push(40, { type: 'ledger.entry', entry: { id: ledgerId++, runId, ts: retrieved(Math.round(simSeconds)), step: 'enrich_companies', provider: 'crustdata', endpoint: '/company/enrich', mode: 'cache', status: 'cache_hit', attempt: 3, credits: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: 4, injected: false } });
  tool('/web/search', { provider: 'web', mode: 'live', latency: 900 });
  evid(w.evidence.o3);
  push(120, { type: 'claim.unverifiable', companyId: CO.orbital, claim: "Orbital Voice's current GPU provider", reason: 'Only an undated forum post names it' });
  end('6 companies enriched; 1 peer list from cache', 2260);

  // ---- cascade ----
  begin('cascade');
  const nodeOrder = [CO.kestrel, CO.lumen, CO.orbital, CO.tessera, CO.nimbus, CO.quill];
  for (const id of nodeOrder) push(180, { type: 'graph.node', node: w.nodes.find((n) => n.id === id)! });
  for (const e of w.edges) push(220, { type: 'graph.edge', edge: e });
  push(120, { type: 'claim.unverifiable', companyId: CO.quill, claim: 'Quill Legal AI is a Tessera Health AI peer', reason: 'Undated profile page; one dated row, rule needs two' });
  end('4 edges: talent drain, displacement, 2 contagion; 1 node can\'t be verified', 1710);

  // ---- rank_targets ----
  begin('rank_targets');
  push(300, { type: 'targets.ranked', targets: w.targets, baseline: { hiringFilterCompanyIds: [CO.kestrel] } });
  end('4 targets; 3 of them a hiring filter would miss', 210);

  // ---- find_deciders / warm_paths / drafts ----
  if (!replay) {
    begin('find_deciders');
    tool('/person/search', { credits: 12, latency: 1100 });
    evid(w.evidence.d1, w.evidence.d2, w.evidence.d3, w.evidence.d4);
    for (const t of w.targets) push(160, { type: 'decider.found', companyId: t.companyId, decider: w.deciders[t.companyId] ?? null });
    end('One decider per account, picked by title and tenure', 1490);

    begin('warm_paths');
    for (const t of w.targets.slice(0, 3)) push(140, { type: 'path.found', companyId: t.companyId, path: w.paths[t.companyId] ?? null });
    end('1 warm, 1 lukewarm, 1 cold', 120);

    begin('draft_messages');
    for (const d of w.drafts) {
      tool('claude-sonnet-5-5', { provider: 'anthropic', tokens: [1840, 260], usd: 0.0128, latency: 2100 });
      push(120, { type: 'draft.ready', draft: d });
    }
    end('3 drafts; verifier removed 3 unsupported sentences', 7210);

    begin('approval_gate');
    const keys = ['d1f3a9c07b2e4f18', '7c20e5b19a3d6f04', 'a94e0c7d2b18f356', '3fb6d80c1e9a2745', 'e05a7c3b9d214f68', '58c1f9e2a07b3d46'];
    let k = 0;
    for (const d of w.drafts) {
      for (const kind2 of ['send_message', 'book_meeting'] as const) {
        const approval: Approval = { id: `ap_${d.companyId.slice(3)}_${kind2 === 'send_message' ? 'msg' : 'mtg'}`, runId, companyId: d.companyId, draftId: d.id, kind: kind2, status: 'pending', idempotencyKey: keys[k++], createdAt: retrieved(Math.round(simSeconds)) };
        push(90, { type: 'approval.requested', approval });
      }
    }
    push(120, { type: 'run.status', status: 'awaiting_approval', note: '6 approvals waiting' });
  } else {
    begin('find_deciders');
    end('Replay run: no outreach for a past date', 10);
    begin('warm_paths');
    end('Replay run: skipped', 10);
    begin('draft_messages');
    end('Replay run: no drafts', 10);
    begin('approval_gate');
    end('Replay run: nothing to approve', 10);
    begin('score_replay');
    tool('/job/search', { credits: 2.4, latency: 1300 });
    tool('/person/search', { credits: 16, latency: 1500 });
    const outcomes = replayOutcomes();
    const outEv: Evidence[] = outcomes.filter((o) => o.outcomeDate).map((o) => ({
      id: o.evidenceIds[0], claim: `${nameOf(o.companyId)} ${o.outcome}`, value: o.outcome, observedAt: o.outcomeDate, retrievedAt: retrieved(40), mode: 'live', verifiable: true,
      source: { provider: 'crustdata', endpoint: o.outcome.startsWith('hired') ? '/person/search' : '/job/search', field: 'date_posted' },
    }));
    evid(...outEv);
    for (const o of outcomes) push(160, { type: 'replay.outcome', outcome: o });
    push(200, { type: 'replay.scored', score: replayScore(outcomes) });
    end('DOMINO 2 of 3, hiring filter 1 of 1, headcount filter 1 of 3', 2900);
    push(150, { type: 'run.status', status: 'completed', note: 'Replay scored' });
  }

  return { kind, runId, request, dataMode: 'live', llm: 'anthropic:claude-sonnet-5-5', script, limits };
}

const NAMES: Record<string, string> = {
  [CO.kestrel]: 'Kestrel Labs', [CO.orbital]: 'Orbital Voice', [CO.nimbus]: 'Nimbus Docs', [CO.lumen]: 'Lumen Serve',
  [CO.tessera]: 'Tessera Health AI', [CO.quill]: 'Quill Legal AI', [CO.quillwrite]: 'Quill',
};
const nameOf = (id: string) => NAMES[id] ?? id;

function replayOutcomes(): ReplayOutcome[] {
  return [
    { companyId: CO.kestrel, predictedBy: 'baseline_first_order', hit: true, outcomeDate: '2026-09-14', outcome: "hired an 'ML Infrastructure Engineer' 14 Sep", evidenceIds: ['ev_r1'] },
    { companyId: CO.orbital, predictedBy: 'domino', hit: true, outcomeDate: '2026-09-19', outcome: "posted 'Inference Platform Lead' 19 Sep", evidenceIds: ['ev_r2'] },
    { companyId: CO.tessera, predictedBy: 'domino', hit: true, outcomeDate: '2026-10-03', outcome: "posted 'Inference Migration Engineer' 3 Oct", evidenceIds: ['ev_r3'] },
    { companyId: CO.nimbus, predictedBy: 'domino', hit: false, outcomeDate: null, outcome: 'no dated sign yet', evidenceIds: [] },
    { companyId: CO.kestrel, predictedBy: 'baseline_headcount', hit: true, outcomeDate: '2026-09-14', outcome: "hired an 'ML Infrastructure Engineer' 14 Sep", evidenceIds: ['ev_r1'] },
    { companyId: CO.quill, predictedBy: 'baseline_headcount', hit: false, outcomeDate: null, outcome: 'no dated sign yet', evidenceIds: [] },
    { companyId: CO.lumen, predictedBy: 'baseline_headcount', hit: false, outcomeDate: null, outcome: 'acquired; no inference hiring after', evidenceIds: [] },
  ];
}

function replayScore(outcomes: ReplayOutcome[]): ReplayScore {
  return {
    asOf: '2026-09-01', horizonEnd: '2026-11-22', factsAfterAsOfUsed: 0,
    domino: { predicted: 3, hits: 2, precision: 0.67, medianLeadDays: 25 },
    baselineFirstOrder: { predicted: 1, hits: 1, precision: 1, medianLeadDays: 13 },
    baselineHeadcount: { predicted: 3, hits: 1, precision: 0.33, medianLeadDays: 13 },
    outcomes,
    note: 'The hiring filter was right on its only pick, which was already hiring. DOMINO found two accounts the filter never returned, a median 25 days before they posted. Nimbus Docs has not moved yet. Three predictions is a small sample.',
  };
}

export const MOCK_COMPANY_NAMES = NAMES;
