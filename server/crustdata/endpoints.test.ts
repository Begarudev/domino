import assert from 'node:assert/strict';
import test from 'node:test';
import type { Company, Intent } from '../../shared/types.ts';
import { parseIntentRules } from '../domain/index.ts';
import type { ParseMeta } from '../domain/types.ts';
import { endpoints, fixtureFor, NonsenseError } from './index.ts';
import type { EndpointSpec } from './spec.ts';

const today = '2026-11-22';
const intent = parseIntentRules('Find AI companies in India. We sell managed GPU inference.', today);
const replay = parseIntentRules('We sell managed inference, replay as of 1 Sep', today);
const orbital: Company = { id: 'co_orbital', name: 'Orbital Voice', aliases: [], domain: 'orbital-voice.ai', crustdataId: 801101, evidenceIds: [] };
const kestrel = { key: 'co_kestrel', name: 'Kestrel Labs', domain: 'kestrel-labs.ai', crustdataId: 801102 };
const nimbus = { key: 'co_nimbus', name: 'Nimbus Docs', domain: 'nimbus-docs.ai', crustdataId: 801103 };

function evaluate<I, O>(endpoint: EndpointSpec<I, O>, input: I, query: Intent = intent) {
  const body = endpoint.build(input);
  const raw = fixtureFor(endpoint.name, body);
  const meta: ParseMeta = {
    mode: 'fixture', retrievedAt: today + 'T15:00:00Z', asOf: query.asOf, windowDays: query.windowDays, endpoint: endpoint.path,
  };
  const parsed = endpoint.parse(raw, input, meta);
  assert.deepEqual(endpoint.parse(raw, input, meta), parsed);
  assert.ok(endpoint.estimateCredits(raw, input) <= endpoint.estimateCredits(null, input));
  return { body, raw, parsed, meta };
}

test('job_search reads original dates, URLs and descriptions using the documented envelope', () => {
  const { body, raw, parsed } = evaluate(endpoints.job_search, { intent });
  assert.ok('job_listings' in (raw as Record<string, unknown>));
  assert.match(JSON.stringify(body), /"field":"metadata.date_added","type":"=>","value":"2026-10-24"/);
  assert.match(JSON.stringify(body), /"field":"metadata.date_added","type":"<","value":"2026-11-23"/);
  assert.equal(parsed.triggers.filter(trigger => trigger.kind === 'job_post').length, 2);
  const job = parsed.evidence.find(row => row.observedAt === '2026-11-03');
  assert.equal(job?.source.field, '$.job_details.title');
  assert.equal(job?.source.recordId, '900001');
  assert.match(job!.source.url!, /^https:\/\/kestrel-labs.ai\/careers\//);
  assert.match(job!.id, /^ev_[\da-f]+$/);
  assert.equal(job!.retrievedAt, today + 'T15:00:00Z');
  assert.equal(job!.mode, 'fixture');
  assert.equal(parsed.triggers.filter(trigger => trigger.kind === 'post').length, 1);
});

test('person_recent_moves pairs current starts with the nearest prior end and keeps no contact fields', () => {
  const { body, parsed } = evaluate(endpoints.person_recent_moves, { intent });
  const newStart = parsed.triggers.find(trigger => trigger.kind === 'hire' && trigger.date === '2026-10-27')!;
  const former = parsed.mentions.find(company => company.key === newStart.relatedCompanyId)!;
  assert.equal(former.name, 'Orbital Voice');
  const departure = parsed.triggers.find(trigger => trigger.kind === 'departure' && trigger.personId === newStart.personId);
  assert.equal(departure?.relatedCompanyId, newStart.companyId);
  assert.ok(parsed.evidence.some(row => newStart.evidenceIds.includes(row.id) && row.observedAt === '2026-10-23' &&
    row.source.field?.endsWith('.end_date')));
  assert.equal(parsed.people.some(person => person.title === 'Marketing Lead'), false);
  assert.doesNotMatch(JSON.stringify(body), /email|phone|contact/i);
});

test('person search records month precision and looks back 120–30 days in replay', () => {
  const live = evaluate(endpoints.person_recent_moves, { intent });
  assert.ok(live.parsed.evidence.some(row => /at Morrow Stack in Nov 2026 \(month precision\)/.test(row.claim) &&
    row.observedAt === today));
  const historical = evaluate(endpoints.person_recent_moves, { intent: replay }, replay);
  assert.match(JSON.stringify(historical.body), /"field":"experience.employment_details.current.start_date","type":"=>","value":"2026-05-05"/);
  assert.match(JSON.stringify(historical.body), /"field":"experience.employment_details.current.start_date","type":"<","value":"2026-08-03"/);
  assert.deepEqual(historical.parsed.triggers.filter(row => row.kind === 'hire').map(row => row.date).sort(),
    ['2026-07-29', '2026-07-31', '2026-08-02']);
});

test('company_growth uses the provider snapshot date and preserves the legal alias', () => {
  const { parsed } = evaluate(endpoints.company_growth, { intent });
  assert.equal(parsed.mentions.find(company => company.crustdataId === kestrel.crustdataId)?.name, 'Kestrel Labs Pvt. Ltd.');
  assert.ok(parsed.triggers.some(trigger => trigger.kind === 'funding' && trigger.date === '2026-11-05'));
  assert.ok(parsed.triggers.some(trigger => trigger.kind === 'headcount_jump' && trigger.date === '2026-11-15'));
  assert.ok(parsed.evidence.some(row => row.source.field === '$.funding.last_round_type' && row.observedAt === null && !row.verifiable));
});

test('company_enrich reads a bare results array, competitors and actual dated headcount points', () => {
  const { raw, parsed } = evaluate(endpoints.company_enrich, { companies: [kestrel, orbital] });
  assert.ok(Array.isArray(raw));
  const kestrelProfile = parsed.mentions.find(mention => mention.crustdataId === kestrel.crustdataId)!;
  assert.deepEqual(kestrelProfile.competitorDomains, ['nimbus-docs.ai', 'quill-legal.ai']);
  assert.deepEqual(kestrelProfile.competitorNames, []);
  assert.equal(kestrelProfile.lastFunding?.round, 'Series B');
  const headcount = parsed.evidence.find(row => row.source.recordId === '801101' && row.value === 140);
  assert.match(headcount!.source.field!, /^\$\.headcount\.timeseries\[\d+\]\.employee_count$/);
  assert.equal(headcount!.observedAt, '2026-11-15');
  const frozen = evaluate(endpoints.company_enrich, { companies: [kestrel, orbital] }, replay).parsed;
  assert.equal(frozen.mentions.find(row => row.crustdataId === kestrel.crustdataId)?.headcount, 120);
  assert.ok(frozen.evidence.every(row => !row.observedAt || row.observedAt <= replay.asOf));
});

test('person_deciders returns only matching employee profiles and employment history', () => {
  const { parsed, body } = evaluate(endpoints.person_deciders, { intent, company: orbital });
  assert.deepEqual(parsed.people.map(person => person.title).sort(), ['CTO', 'VP of Engineering']);
  assert.ok(parsed.people.every(person => person.companyKey === orbital.id && person.linkedinUrl && person.startedAt && person.pastEmployers.length));
  assert.doesNotMatch(JSON.stringify([body, parsed]), /email|phone|contact/i);
});

test('outcome_check looks up both posting and hire outcomes across the requested companies', () => {
  const input = { intent: replay, companies: [kestrel, nimbus] };
  const jobs = evaluate(endpoints.outcome_check, input, replay);
  const hires = evaluate(endpoints.outcome_check.hires, input, replay);
  assert.ok(jobs.parsed.outcomes.some(row => row.kind === 'job_post' && row.companyKey === kestrel.key && row.date === '2026-09-09'));
  assert.ok(hires.parsed.outcomes.some(row => row.kind === 'hire' && row.companyKey === nimbus.key && row.date === '2026-09-12'));
  assert.ok([...jobs.parsed.outcomes, ...hires.parsed.outcomes].every(row => row.date > replay.asOf && row.date <= today && row.evidenceIds.length));
});

test('all endpoint parsers reject malformed envelopes and mistyped important fields', () => {
  const base = { intent };
  const outcomes = { intent: replay, companies: [kestrel] };
  const meta = { asOf: today, windowDays: 30, endpoint: 'test', mode: 'fixture', retrievedAt: today + 'T15:00:00Z' } as const;
  const badJob = { job_listings: [{ job_details: { title: [] } }] };
  const badPerson = { profiles: [{ experience: { employment_details: { current: [{ start_date: 5 }] } } }] };
  const badCompany = { crustdata_company_id: [] };
  const check = <I, O>(endpoint: EndpointSpec<I, O>, input: I, malformed: unknown) => {
    for (const junk of [null, 23, 'oops', {}, malformed]) {
      assert.throws(() => endpoint.parse(junk, input, meta), NonsenseError);
    }
  };
  check(endpoints.job_search, base, badJob);
  check(endpoints.person_recent_moves, base, badPerson);
  check(endpoints.company_growth, base, { companies: [badCompany] });
  check(endpoints.company_enrich, { companies: [kestrel] }, [{ matches: [{ company_data: badCompany }] }]);
  check(endpoints.person_deciders, { ...base, company: orbital }, badPerson);
  check(endpoints.outcome_check, outcomes, badJob);
  check(endpoints.outcome_check.hires, outcomes, badPerson);
});

test('permissive parsing retains an undated matching fact as unverifiable without making a trigger', () => {
  const { raw, meta } = evaluate(endpoints.job_search, { intent });
  const payload = raw as { job_listings: { metadata: unknown; crustdata_job_id: number }[] };
  const item = payload.job_listings.find(job => job.crustdata_job_id === 900001)!;
  const parsed = endpoints.job_search.parse({ job_listings: [{ ...item, metadata: {}, extra: 'allowed' }] }, { intent }, meta);
  assert.equal(parsed.triggers.length, 0);
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.evidence[0].observedAt, null);
  assert.equal(parsed.evidence[0].verifiable, false);
});
