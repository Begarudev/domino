import assert from 'node:assert/strict';
import test from 'node:test';
import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { Intent } from '../../shared/types.ts';
import { endpoints, fixtureFor } from '../crustdata/index.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import {
  buildCascade, buildClaims, filterAsOf, findWarmPath, parseIntentRules, pickDecider, rankTargets,
  resolveEntities, scoreReplay, templateDraft, verifyDraft,
} from './index.ts';
import type { SellerProfile, TriggerBatch } from './types.ts';

const today = '2026-11-22';
const seller = sellerJson as SellerProfile;

function fetchFixture<I, O>(endpoint: EndpointSpec<I, O>, input: I, intent: Intent): O {
  const body = endpoint.build(input);
  return endpoint.parse(fixtureFor(endpoint.name, body), input, {
    mode: 'fixture', retrievedAt: today + 'T07:30:00Z', asOf: intent.asOf, windowDays: intent.windowDays, endpoint: endpoint.path,
  });
}

function fixturePipeline(intent: Intent) {
  const input = { intent };
  const batches: TriggerBatch[] = [
    fetchFixture(endpoints.job_search, input, intent),
    fetchFixture(endpoints.person_recent_moves, input, intent),
    fetchFixture(endpoints.company_growth, input, intent),
  ];
  const mentions = batches.flatMap(batch => batch.mentions);
  const people = batches.flatMap(batch => batch.people);
  const initial = resolveEntities(mentions, people);
  const enrich = fetchFixture(endpoints.company_enrich, { companies: initial.companies }, intent);
  const resolved = resolveEntities([...mentions, ...enrich.mentions], people);
  const evidenceMap = new Map([...batches.flatMap(batch => batch.evidence), ...enrich.evidence].map(row => [row.id, row]));
  const allEvidence = [...evidenceMap.values()];
  const evidence = intent.runKind === 'replay' ? filterAsOf(allEvidence, intent.asOf).kept : allEvidence;
  const keptIds = new Set(evidence.map(row => row.id));
  const allTriggers = new Map([...batches.flatMap(batch => batch.triggers), ...enrich.triggers].map(trigger => [trigger.id, trigger]));
  const triggers = [...allTriggers.values()].map(trigger => ({
    ...trigger, companyId: resolved.idMap[trigger.companyId],
    relatedCompanyId: trigger.relatedCompanyId ? resolved.idMap[trigger.relatedCompanyId] : null,
    personId: trigger.personId ? resolved.idMap[trigger.personId] : null,
    evidenceIds: trigger.evidenceIds.filter(id => keptIds.has(id)),
  }));
  const graph = buildCascade(intent, triggers, resolved.companies, evidence);
  const ranked = rankTargets(intent, graph, resolved.companies, triggers);
  return { ...ranked, resolved, graph, triggers, evidence, allEvidence };
}

test('fixture demo runs the full data and outreach pipeline', () => {
  const intent = parseIntentRules('We sell managed GPU inference. Find 5 AI companies in India from the last 30 days.', today);
  const { targets, baseline, resolved, graph, triggers, evidence } = fixturePipeline(intent);
  const byName = (name: string) => resolved.companies.find(company => company.name === name)!;
  const byId = new Map(resolved.companies.map(company => [company.id, company]));
  const orbital = byName('Orbital Voice');
  const kestrel = byName('Kestrel Labs');
  assert.ok(kestrel.aliases.includes('Kestrel Labs Pvt. Ltd.'));
  assert.notEqual(orbital.id, byName('Orbital Voice Coaching').id);
  assert.ok(resolved.keptApart.some(note => note.names.includes('Orbital Voice Coaching')));
  assert.ok(resolved.keptApart.some(note => note.names.includes('Kestrel Research') && note.reason.includes('internal transfer')));
  assert.ok(!graph.edges.some(edge => edge.mechanism === 'TALENT_DRAIN' && edge.to === byName('Kestrel Research').id));
  assert.ok(!graph.edges.some(edge => edge.to === byName('Orbital Voice Coaching').id));
  assert.deepEqual(baseline.hiringFilterCompanyIds, [kestrel.id]);

  const target = targets.find(item => item.companyId === orbital.id)!;
  assert.ok(target.netNew);
  const drain = graph.edges.find(edge => edge.to === orbital.id && edge.mechanism === 'TALENT_DRAIN')!;
  assert.equal(drain.from, kestrel.id);
  assert.match(drain.label, /^3 engineering employees left/);
  assert.ok(drain.evidenceIds.length >= 2 && drain.evidenceIds.every(id => {
    const row = evidence.find(row => row.id === id);
    return row?.verifiable && row.observedAt;
  }));
  assert.ok(graph.edges.some(edge => edge.mechanism === 'DISPLACEMENT' && edge.to === byName('Tessera Health AI').id));
  assert.ok(graph.edges.some(edge => edge.mechanism === 'CONTAGION' && edge.to === byName('Nimbus Docs').id));
  assert.ok(graph.edges.some(edge => edge.mechanism === 'CONTAGION' && edge.to === byName('Quill Legal AI').id));
  assert.ok(graph.edges.every((edge, index) => edge.order === index && edge.alternative));

  const result = fetchFixture(endpoints.person_deciders, { intent, company: orbital }, intent);
  const candidates = resolveEntities([], result.people).people;
  const decider = pickDecider(intent, orbital, candidates)!;
  assert.equal(decider.title, 'VP of Engineering');
  const warm = findWarmPath(decider, candidates.find(person => person.id === decider.personId)!, orbital, seller, triggers, resolved.companies);
  assert.equal(warm?.strength, 'warm');

  const claims = buildClaims(target, orbital, triggers, evidence, graph);
  const draft = templateDraft(target, decider, claims, seller);
  const verified = verifyDraft(draft, claims, evidence);
  assert.ok(verified.verified);
  assert.ok(verified.checks.every(check => check.status !== 'removed'));
  assert.ok(verified.unverifiable.some(item => /seed/i.test(item.claim)));
  assert.match(verified.body, /Orbital Voice had 140 employees/);
  assert.doesNotMatch(verified.body, /Kestrel|departures?|engineers left|Veena|Rian|Neya|seed/i);
  assert.ok(verified.body.trim().split(/\s+/).length <= 110);
  assert.equal(draft.meeting.durationMin, 20);
  assert.deepEqual(draft.meeting.proposedSlots, seller.meeting.slots);

  console.table(targets.map(row => ({
    rank: row.rank, company: byId.get(row.companyId)?.name, score: row.score, mechanism: row.mechanisms.join(', '), netNew: row.netNew,
  })));
  console.log(draft.subject + '\n\n' + verified.body);
});

test('fixture replay uses a frozen evidence set and computes both baselines against actual future outcomes', () => {
  const intent = parseIntentRules('Replay as of 1 Sep for 5 AI companies anywhere. We sell managed GPU inference.', today);
  const { targets, baseline, resolved, graph, triggers, evidence, allEvidence } = fixturePipeline(intent);
  assert.ok(filterAsOf(allEvidence, intent.asOf).dropped > 0);
  assert.ok(evidence.every(row => row.observedAt && row.observedAt <= intent.asOf));
  assert.ok(!triggers.some(trigger => trigger.kind === 'hire' || trigger.kind === 'departure'));
  assert.ok(graph.edges.every(edge => edge.observedAt && edge.observedAt <= intent.asOf));
  const headcount = [...new Set(triggers.filter(row => row.kind === 'headcount_jump').map(row => row.companyId))]
    .filter(id => (resolved.companies.find(company => company.id === id)?.headcountGrowthPct?.pct ?? 0) >= 30);
  const ids = new Set([...targets.map(target => target.companyId), ...baseline.hiringFilterCompanyIds, ...headcount]);
  const companies = resolved.companies.filter(company => ids.has(company.id)).map(company => ({ ...company, key: company.id }));
  const outcomeInput = { intent, companies };
  const posts = fetchFixture(endpoints.outcome_check, outcomeInput, intent);
  const hires = fetchFixture(endpoints.outcome_check.hires, outcomeInput, intent);
  const replay = scoreReplay(intent, targets, { firstOrder: baseline.hiringFilterCompanyIds, headcount }, [...posts.outcomes, ...hires.outcomes]);
  assert.equal(replay.factsAfterAsOfUsed, 0);
  assert.equal(replay.domino.predicted, 3);
  assert.equal(replay.domino.hits, 2);
  assert.deepEqual(replay.baselineFirstOrder, { predicted: 2, hits: 1, precision: 0.5, medianLeadDays: 8 });
  assert.deepEqual(replay.baselineHeadcount, { predicted: 2, hits: 1, precision: 0.5, medianLeadDays: 11 });
  assert.ok(replay.outcomes.some(row => !row.hit));
  assert.match(replay.note, /30-day lag/);
  console.log(replay.note);
});

test('a longer replay lookback can use profiles that have cleared the 30-day lag', () => {
  const intent = parseIntentRules('Replay as of 1 Sep with last 45 days. We sell managed inference.', today);
  const { graph, triggers } = fixturePipeline(intent);
  const hireDates = triggers.filter(trigger => trigger.kind === 'hire').map(trigger => trigger.date).sort();
  assert.deepEqual(hireDates, ['2026-07-29', '2026-07-31']);
  assert.ok(graph.edges.some(edge => edge.mechanism === 'TALENT_DRAIN'));
});
