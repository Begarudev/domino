import assert from 'node:assert/strict';
import test from 'node:test';
import { liveIntent } from '../../scripts/probe-live.ts';
import { companyEnrich, companySearchGrowth } from './company.ts';
import { CURRENT, personSearchDeciders } from './person-search.ts';

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
