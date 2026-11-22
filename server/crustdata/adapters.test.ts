import assert from 'node:assert/strict';
import test from 'node:test';
import { liveIntent } from '../../scripts/probe-live.ts';
import { companyCohort, companyEnrich, companySearchGrowth } from './company.ts';
import { CURRENT, PAST, personCohortDepartures, personSearchDeciders } from './person-search.ts';

const meta = { asOf: liveIntent.asOf, windowDays: 30, retrievedAt: `${liveIntent.asOf}T12:00:00Z`, mode: 'live' as const };

test('growth discovery caps the default page at 20', () => {
  assert.equal((companySearchGrowth.build({ intent: liveIntent }) as { limit: number }).limit, 20);
  assert.equal(companySearchGrowth.estimateCredits(null, { intent: liveIntent }), 20.6);
});

test('enrichment keeps valid rows after an unmatched ID returns a null company record', () => {
  const companies = [{ name: 'Unknown', crustdataId: 101 }, { name: 'Northwind', crustdataId: 102 }];
  const raw = [
    { matched_on: '101', matches: [{ company_data: null }] },
    { matched_on: '102', matches: [{ company_data: { crustdata_company_id: 102, basic_info: { name: 'Northwind' } } }] },
  ];
  const result = companyEnrich.parse(raw, { companies }, { ...meta, endpoint: companyEnrich.path });
  assert.deepEqual(result.mentions.map(row => row.name), ['Northwind']);
});

test('deciders query by known ID and match roles by ID, domain or normalized name', () => {
  const company = { id: 'company', name: 'Northwind AI', crustdataId: 42, domain: 'northwind.ai', aliases: [], evidenceIds: [] };
  const input = { intent: liveIntent, company };
  const body = personSearchDeciders.build(input) as { filters: { conditions: unknown[] } };
  assert.deepEqual(body.filters.conditions[0], { field: CURRENT + '.company_id', type: 'in', value: [42] });

  const profiles = [
    { crustdata_company_id: 42 },
    { name: 'Other Name', company_website: 'https://links.northwind.ai/team' },
    { name: 'Northwind', company_website: 'https://elsewhere.example' },
    { name: 'Unrelated', company_website: 'https://elsewhere.example' },
  ].map((company, i) => ({
    crustdata_person_id: i, basic_profile: { name: `Person ${i}` },
    experience: { employment_details: { current: [{ ...company, position_id: i, title: 'CTO' }] } },
  }));
  const result = personSearchDeciders.parse({ profiles }, input, { ...meta, endpoint: personSearchDeciders.path });
  assert.equal(result.people.length, 3);
  assert.match(result.evidence[0].source.field!, /@\.position_id == 0\)\]/);
});

test('cohort discovery limits the sample to AI companies with 20 to 5,000 employees', () => {
  const input = { intent: liveIntent };
  const body = companyCohort.build(input) as { limit: number; filters: { conditions: unknown[] } };
  assert.equal(body.limit, 40);
  assert.ok(body.filters.conditions.some(value => JSON.stringify(value).includes('2025-05-23')));
  const companies = [19, 20, 5000, 5001].map(total => ({
    crustdata_company_id: total, basic_info: { name: `Company ${total}` }, headcount: { total },
  }));
  const result = companyCohort.parse({ companies }, input, { ...meta, endpoint: companyCohort.path });
  assert.deepEqual(result.mentions.map(company => company.crustdataId), [20, 5000]);
});

test('cohort moves require a recent exit from the serving role at the cohort employer', () => {
  const companies = [{ name: 'Origin', crustdataId: '42' }];
  const input = { intent: liveIntent, companies };
  const body = personCohortDepartures.build(input) as { limit: number; filters: { conditions: unknown[] } };
  assert.equal(body.limit, 200);
  assert.deepEqual(body.filters.conditions[0], { field: PAST + '.company_id', type: 'in', value: [42] });
  assert.deepEqual(body.filters.conditions[2], { field: CURRENT + '.start_date', type: '=>', value: '2026-08-24' });

  const previous = { name: 'Origin', crustdata_company_id: 42, position_id: 1, title: 'ML Infrastructure Engineer', end_date: '2026-11-01' };
  const current = { name: 'Hirer', crustdata_company_id: 43, position_id: 2, title: 'Engineering Lead', start_date: '2026-11-03' };
  const profile = (id: number, current: unknown[], past: unknown[]) => ({
    crustdata_person_id: id, basic_profile: { name: `Person ${id}` }, experience: { employment_details: { current, past } },
  });
  const qualified = profile(1, [current], [previous]);
  const raw = { profiles: [qualified, qualified,
    profile(2, [current], [{ ...previous, title: 'Engineer' }, { ...previous, crustdata_company_id: 44 }]),
    profile(3, [current], [{ ...previous, end_date: '2026-01-01' }]),
    profile(4, [{ ...current, crustdata_company_id: 42 }], [previous]),
  ] };
  const result = personCohortDepartures.parse(raw, input, { ...meta, endpoint: personCohortDepartures.path });
  assert.deepEqual(result.mentions.map(company => company.name), ['Origin', 'Hirer']);
  assert.deepEqual(result.triggers.map(trigger => [trigger.kind, trigger.date]), [['departure', '2026-11-01'], ['hire', '2026-11-03']]);
  assert.equal(result.people.length, 1);
  assert.equal(result.evidence[0].value, 'ML Infrastructure Engineer');

  const monthly = profile(5, [{ ...current, start_date: '2026-11-01T00:00:00' }],
    [{ ...previous, end_date: '2026-11-01T00:00:00' }]);
  const monthResult = personCohortDepartures.parse({ profiles: [monthly] }, input, { ...meta, endpoint: personCohortDepartures.path });
  assert.equal(monthResult.triggers[0].date.slice(0, 7), '2026-11');
  assert.match(monthResult.evidence[0].claim, /Nov 2026 \(month precision\)/);
});
