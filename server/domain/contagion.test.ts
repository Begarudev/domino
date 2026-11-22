import assert from 'node:assert/strict';
import test from 'node:test';
import type { Evidence, Trigger } from '../../shared/types.ts';
import { buildCascade, parseIntentRules, rankTargets, resolveEntities } from './index.ts';
import type { ResolvedCompany } from './types.ts';

const today = '2026-11-22';
const intent = parseIntentRules('We sell managed inference. Find 20 companies.', today);

function company(id: string, overrides: Partial<ResolvedCompany> = {}): ResolvedCompany {
  return { id, name: id, domain: id.toLowerCase() + '.example', aliases: [], industry: 'Speech AI',
    categories: ['Artificial Intelligence', 'Speech Recognition'], headcount: 100, evidenceIds: [], ...overrides };
}

function role(companyId: string, key: string, title: string, kind: 'job_post' | 'hire' = 'job_post', dated = true) {
  const date = '2026-11-10';
  const evidence: Evidence = {
    id: 'ev_' + key, claim: title, value: title, observedAt: dated ? date : null, verifiable: dated,
    source: { provider: 'crustdata', endpoint: kind === 'hire' ? '/person/search' : '/job/search',
      recordId: key, field: kind === 'hire' ? '$.experience.employment_details.current[0].start_date' : '$.job_details.title' },
    retrievedAt: today + 'T12:00:00Z', mode: 'fixture',
  };
  const trigger: Trigger = { companyId, id: 'tr_' + key, kind, date, summary: title, evidenceIds: [evidence.id],
    personId: kind === 'hire' ? 'pe_' + key : undefined };
  return { trigger, evidence };
}

function planned(companies: ResolvedCompany[], roles: ReturnType<typeof role>[]) {
  const triggers = roles.map(item => item.trigger);
  const graph = buildCascade(intent, triggers, companies, roles.map(item => item.evidence));
  return { graph, ...rankTargets(intent, graph, companies, triggers),
    contagion: graph.edges.filter(edge => edge.mechanism === 'CONTAGION') };
}

test('CONTAGION requires distinct dated technical signals, including a serving role or hire', () => {
  const source = company('source');
  const peer = company('peer');
  const serving = role(source.id, 'serving', 'Senior ML Platform Engineer', 'hire');
  const infra = role(source.id, 'infra', 'Cloud Infrastructure Engineer');
  const generic = role(source.id, 'generic', 'AI Engineer');
  const anotherInfra = role(source.id, 'another-infra', 'Infrastructure Architect', 'hire');
  const undatedInfra = role(source.id, 'undated', 'GPU Infrastructure Engineer', 'job_post', false);
  const duplicate = { ...serving, trigger: { ...serving.trigger, id: 'tr_duplicate' } };
  const companies = [source, peer];
  assert.equal(planned(companies, [serving, generic]).contagion.length, 0);
  assert.equal(planned(companies, [infra, anotherInfra, generic]).contagion.length, 0);
  assert.equal(planned(companies, [serving, undatedInfra]).contagion.length, 0);
  assert.equal(planned(companies, [serving, duplicate]).contagion.length, 0);
  const [edge] = planned(companies, [serving, infra, generic]).contagion;
  assert.equal(edge.to, peer.id);
  assert.deepEqual(edge.evidenceIds.sort(), [infra.evidence.id, serving.evidence.id].sort());
  assert.match(edge.label, /posted 1 serving or infrastructure role and made 1 serving or infrastructure hire/);
});

test('giants and non-AI companies cannot seed CONTAGION, and giants never enter the ranked or baseline targets', () => {
  const peer = company('peer');
  const excludes = [
    company('big', { headcount: 5_001 }),
    company('legacy-amd', { aliases: ['Advanced Micro Devices, Inc.'], headcount: undefined }),
    company('intel', { name: 'Intel Corporation', headcount: null }),
    company('google', { name: 'Google LLC', headcount: 0 }),
    company('meta', { name: 'Meta Platforms', headcount: 50_000 }),
  ];
  for (const source of excludes) {
    const result = planned([source, peer], [role(source.id, 'a', 'Inference Engineer'), role(source.id, 'b', 'MLOps Engineer')]);
    assert.equal(result.contagion.length, 0, source.name);
    assert.deepEqual(result.targets, [], source.name);
    assert.deepEqual(result.baseline.hiringFilterCompanyIds, [], source.name);
  }
  const ordinary = company('ledger', { industry: 'Financial Software', categories: [] });
  assert.equal(planned([ordinary, { ...peer, industry: ordinary.industry }], [
    role(ordinary.id, 'ledger-1', 'ML Platform Engineer'), role(ordinary.id, 'ledger-2', 'GPU Engineer'),
  ]).contagion.length, 0);
  const source = company('source');
  const giantPeer = company('outside', { name: 'Qualcomm', headcount: 10_000 });
  const boundary = company('upper', { headcount: 5_000 });
  const result = planned([{ ...source, competitorIds: [giantPeer.id, boundary.id] }, giantPeer, boundary],
    [role(source.id, 'source-1', 'ML Platform Engineer'), role(source.id, 'source-2', 'GPU Engineer')]);
  assert.deepEqual(result.contagion.map(edge => edge.to), [boundary.id]);
});

test('CONTAGION ranks up to three comparable peers and excludes staffing, services and thin matches', () => {
  const source = company('source');
  const same = company('same', { headcount: 98 });
  const next = company('next', { headcount: 130 });
  const category = company('category', { industry: 'Audio Software', headcount: 105 });
  const nearButFourth = company('fourth', { industry: 'Voice Applications', headcount: 180 });
  const small = company('small', { headcount: 45 });
  const tiny = company('tiny', { headcount: 19 });
  const consulting = company('consulting', { name: 'Helio Consulting', headcount: 100 });
  const talent = company('talent', { industry: 'Staffing and Recruiting', headcount: 100 });
  const services = company('services', { industry: 'IT-Services', headcount: 100 });
  const unrelated = company('unrelated', { industry: 'IT Security', categories: ['Artificial Intelligence'] });
  const roles = [role(source.id, 'a', 'Senior Inference Engineer'), role(source.id, 'b', 'ML Platform Engineer')];
  const result = planned([category, unrelated, consulting, next, small, source, tiny, same, nearButFourth, talent, services], roles);
  assert.deepEqual(result.contagion.map(edge => edge.to), [same.id, next.id, category.id]);
  assert.match(result.contagion[2].label, /shared category/);

  const atRatio = company('at-ratio', { headcount: 50 });
  const beyondRatio = company('beyond-ratio', { headcount: 201 });
  assert.deepEqual(planned([source, atRatio, beyondRatio, small], roles).contagion.map(edge => edge.to), [atRatio.id]);
});

test('resolved competitor domains outrank industry matches, with category fallback when the list has no eligible peer', () => {
  const { companies, idMap } = resolveEntities([
    { key: 'source', name: 'Canopy Voice AI', domain: 'canopy-voice.example', industry: 'Artificial Intelligence',
      categories: ['Speech Recognition'], headcount: 100, competitorDomains: ['https://www.plume-audio.example/', 'fonzi.example'], evidenceIds: [] },
    { key: 'listed', name: 'Plume Audio', domain: 'plume-audio.example', industry: 'Audio Platforms', headcount: 350, evidenceIds: [] },
    { key: 'recruiter', name: 'Fonzi AI', domain: 'fonzi.example', industry: 'Artificial Intelligence', headcount: 100, evidenceIds: [] },
    { key: 'fallback', name: 'Thicket Voice', domain: 'thicket.example', industry: 'Artificial Intelligence', headcount: 100, evidenceIds: [] },
  ], []);
  const roles = [role(idMap.source, 'a', 'ML Platform Engineer'), role(idMap.source, 'b', 'GPU Software Engineer')];
  assert.deepEqual(planned(companies, roles).contagion.map(edge => edge.to), [idMap.listed]);
  assert.deepEqual(planned(companies.filter(item => item.id !== idMap.listed), roles).contagion.map(edge => edge.to), [idMap.fallback]);
});

test('recruiter posts cannot enter DIRECT or seed CONTAGION after company enrichment', () => {
  const peer = company('peer');
  const suspects = [
    company('fonzi', { name: 'Fonzi AI' }),
    company('flexiple', { name: 'Flexiple' }),
    company('remotehunter', { name: 'RemoteHunter' }),
    company('toptal', { name: 'Toptal, LLC' }),
    company('staffing', { categories: ['Artificial Intelligence', 'Staffing and Recruiting'] }),
  ];
  for (const source of suspects) {
    const result = planned([source, peer], [role(source.id, 'a', 'Inference Engineer'), role(source.id, 'b', 'ML Platform Engineer')]);
    assert.equal(result.contagion.length, 0, source.name);
    assert.equal(result.graph.nodes.some(node => node.mechanisms.includes('DIRECT')), false, source.name);
    assert.deepEqual(result.baseline.hiringFilterCompanyIds, [], source.name);
  }
});
