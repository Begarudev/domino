import assert from 'node:assert/strict';
import test from 'node:test';
import type { Company, Intent } from '../../shared/types.ts';
import { Store } from '../db.ts';
import { parseIntentRules } from '../domain/index.ts';
import { canonicalJson, hash, ToolContext } from '../runtime/tool.ts';
import type { ParseMeta } from '../domain/types.ts';
import { endpoints, fixtureFor, movesPageLimit, NonsenseError, readMovesPages } from './index.ts';
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
  assert.equal(parsed.triggers.filter(trigger => trigger.kind === 'post').length, 0);
});

test('job_search_displacement asks only for products of recent provider events and cites the naming excerpt', () => {
  const { body, parsed } = evaluate(endpoints.job_search_displacement, { intent });
  const text = JSON.stringify(body);
  assert.match(text, /"field":"content.description","type":"\[\.\]","value":"Lumen Serve"/);
  assert.doesNotMatch(text, /"value":"inference"/);
  const post = parsed.triggers.find(trigger => trigger.kind === 'post');
  assert.ok(post?.relatedCompanyId?.startsWith('displacement:'));
  const fact = parsed.evidence.find(row => post!.evidenceIds.includes(row.id) && row.source.field === '$.content.description');
  assert.match(fact!.claim, /named Lumen Serve in the posting for .* on 2026-10-29: “….*Lumen Serve integration/);
});

test('a product named only as employer background or an investor is not an integration', async () => {
  const { productMention } = await import('./job-search.ts');
  assert.equal(productMention('Background at a neocloud such as CoreWeave or Nebius is a plus.', 'Nebius'), null);
  assert.equal(productMention('We secured strategic investment led by Nebius Group.', 'Nebius'), null);
  assert.match(productMention('You will work with cloud compute clusters (Lambda, Nebius, AWS).', 'Nebius')!, /Nebius/);
  assert.equal(productMention('Chromatic aberration', 'Chroma'), null);
  assert.equal(productMention('Nebius Academy (powered by TripleTen) provides assessments.', 'Nebius'), null);
  assert.equal(productMention('Track record selling to neoclouds (e.g., Vultr, Nebius, Crusoe).', 'Nebius', 'Senior NeoCloud Sales Director'), null);
  assert.equal(productMention('360talent werft een Office Guard voor Nebius in Amsterdam.', 'Nebius', 'Office Guard Nebius'), null);
  assert.match(productMention('Experience with vLLM, Text Generation Inference (TGI) or SGLang.', 'Text Generation Inference')!, /TGI/);
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

test('live moves search on the past role and keep both sides of a departure even when the new job is non-infra', () => {
  const input = { intent };
  const { body, meta } = evaluate(endpoints.person_recent_moves, input);
  assert.match(JSON.stringify(body), /"field":"experience.employment_details.past.title","type":"\[\.\]","value":"inference"/);
  assert.match(JSON.stringify(body), /"field":"experience.employment_details.current.start_date","type":"=>","value":"2026-08-24"/);
  assert.doesNotMatch(JSON.stringify(body), /"sorts"|"field":"experience.employment_details.current.title"/);
  assert.equal((body as { limit: number }).limit, 200);
  assert.equal(endpoints.person_recent_moves.estimateCredits(null, input), 46);
  const raw = {
    profiles: [{
      crustdata_person_id: 100, basic_profile: { name: 'Navi Ember' },
      experience: { employment_details: {
        current: [{ name: 'Slate Grid', title: 'Developer Advocate', start_date: '2026-08-24', company_headquarters_country: 'United States' }],
        past: [{ name: 'Reed Signals', title: 'Inference Engineer', start_date: '2021-01-01', end_date: '2026-08-22',
          company_headquarters_country: 'India' }],
      } },
    }],
    next_cursor: 'opaque+/=',
  };
  const page = endpoints.person_recent_moves.parse(raw, input, meta);
  assert.equal(page.nextCursor, 'opaque+/=');
  assert.deepEqual(page.triggers.map(trigger => trigger.kind), ['hire', 'departure']);
  assert.match(page.triggers[0].summary, /Developer Advocate/);
  assert.ok(page.triggers[1].evidenceIds.some(id => page.evidence.find(row => row.id === id)?.value === 'Inference Engineer'));
  assert.equal(page.mentions.find(company => company.key === page.triggers[1].companyId)?.name, 'Reed Signals');
});

test('moves pagination sends opaque cursors unchanged and stops at the budgeted page count or a repeated cursor', async () => {
  assert.equal(movesPageLimit(''), 2);
  assert.equal(movesPageLimit('invalid'), 2);
  assert.equal(movesPageLimit('3'), 3);
  const spec = endpoints.person_recent_moves;
  const bodies: { cursor?: string; limit: number }[] = [];
  const pages = readMovesPages(intent, async input => {
    const body = spec.build(input) as { cursor?: string; limit: number };
    bodies.push(body);
    return { nextCursor: 'opaque+/=' };
  }, 4);
  for await (const _ of pages) { /* Read all available pages. */ }
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], { ...bodies[0], cursor: 'opaque+/=' });

  const fixtureBodies: unknown[] = [];
  for await (const page of readMovesPages(intent, async input => {
    const body = spec.build(input) as Record<string, unknown>;
    fixtureBodies.push(body);
    const raw = fixtureFor(spec.name, { ...body, limit: 1 });
    return spec.parse(raw, input, { mode: 'fixture', asOf: today, windowDays: 30, endpoint: spec.path, retrievedAt: today + 'T12:00:00Z' });
  }, 1)) {
    assert.equal(page.people.length, 1);
    assert.equal(page.nextCursor, 'fixture_profiles:1');
  }
  assert.equal(fixtureBodies.length, 1);
});

test('each cursor page is served from its own cache entry without spending credits', async () => {
  const store = new Store(':memory:');
  const spec = endpoints.person_recent_moves;
  const runId = 'cached-departure-pages';
  try {
    store.createRun(runId, 'Cached move search', 'cache', 'template', {
      maxCredits: 0, maxSeconds: 10, maxModelUsd: 0,
    }, {});
    for (const [cursor, next] of [[undefined, 'opaque+/='], ['opaque+/=', null]] as const) {
      const request = canonicalJson(spec.build({ intent, cursor }));
      store.writeCache(hash(spec.path + request), 'crustdata', spec.path, request, { profiles: [], next_cursor: next });
    }
    const ctx = new ToolContext(store, runId, 'pull_triggers');
    const cursors: (string | null)[] = [];
    for await (const page of readMovesPages(intent, input => ctx.crust(spec, input, intent, fixtureFor,
      () => ({ evidence: [], mentions: [], people: [], triggers: [], nextCursor: null })), 2)) {
      cursors.push(page.nextCursor);
    }
    assert.deepEqual(cursors, ['opaque+/=', null]);
    assert.deepEqual(store.getLedger(runId).map(row => [row.status, row.credits]), [['cache_hit', 0], ['cache_hit', 0]]);
  } finally {
    store.sql.close();
  }
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
  assert.ok(parsed.evidence.some(row => row.source.field === '$.job_details.title'));
  assert.ok(parsed.evidence.every(row => row.observedAt === null && row.verifiable === false));
});

test('job triggers are title-only and omit client postings from recruiter accounts', () => {
  const { body, meta } = evaluate(endpoints.job_search, { intent });
  assert.match(JSON.stringify(body), /"field":"job_details.title","type":"\[\.\]","value":"inference"/);
  assert.doesNotMatch(JSON.stringify(body), /"field":"content.description","type":"\[\.\]","value":"inference"/);
  const posting = (id: number, title: string, name: string, industry: string, description = 'Build GPU infrastructure and inference.') => ({
    crustdata_job_id: id,
    job_details: { title, url: 'https://sample.example/jobs/' + id },
    company: { basic_info: { name, industries: [industry] } },
    content: { description },
    metadata: { date_added: '2026-11-14' },
  });
  const raw = { job_listings: [
    posting(1, 'Technical Product Manager', 'Juniper Lattice', 'Artificial Intelligence'),
    posting(2, 'AI Engineer', 'Juniper Lattice', 'Artificial Intelligence'),
    posting(3, 'LLM Infra Engineer', 'Juniper Lattice', 'Artificial Intelligence', ''),
    posting(4, 'Inference Engineer', 'Fonzi AI', 'Artificial Intelligence'),
    posting(5, 'ML Platform Engineer', 'Flexiple', 'Software Development'),
    posting(6, 'Serving Engineer', 'RemoteHunter', 'Software Development'),
    posting(7, 'GPU Software Engineer', 'Toptal', 'Software Development'),
    posting(8, 'MLOps Engineer', 'Spruce Match', 'Staffing and Recruiting'),
  ] };
  const parsed = endpoints.job_search.parse(raw, { intent }, meta);
  assert.equal(parsed.triggers.filter(trigger => trigger.kind === 'job_post').length, 1);
  assert.match(parsed.triggers[0].summary, /LLM Infra Engineer/);
  assert.deepEqual(parsed.evidence.filter(row => row.source.field === '$.content.description').map(row => row.source.recordId), ['1', '2']);
  assert.ok(parsed.mentions.every(mention => mention.name === 'Juniper Lattice'));
});
