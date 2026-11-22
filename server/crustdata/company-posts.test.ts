import assert from 'node:assert/strict';
import test from 'node:test';
import { liveIntent } from '../../scripts/probe-live.ts';
import { companyPosts } from './company-posts.ts';

test('company posts preserve author attribution and require dated signal text for triggers', () => {
  const company = { name: 'Northwind AI', crustdataId: 42, domain: 'northwind.ai' };
  const input = { intent: liveIntent, companies: [company] };
  const actor = { name: 'Northwind', actor_type: 'company', crustdata_entity_id: 42 };
  const url = 'https://example.test/posts/';
  const response = { posts: [
    { actor, share_url: url + '1', date_posted: '2026-11-13T08:00:00Z', text: `Launching inference ${'a'.repeat(120)}` },
    { actor: { name: 'Cloud Report', actor_type: 'company' }, share_url: url + '2', date_posted: '2026-11-10',
      text: 'Northwind AI scales GPU capacity', mentions: { company_ids: [42] } },
    { actor, share_url: url + '3', date_posted: '2026-11-09', text: 'Office photos' },
    { actor, share_url: url + '4', date_posted: null, text: 'Model serving update' },
    { actor, share_url: url + '5', date_posted: '2026-10-01', text: 'New GPU clusters' },
    { actor: { name: 'Someone Else', actor_type: 'person', crustdata_entity_id: 42 }, share_url: url + '6',
      date_posted: '2026-11-13', text: 'Model serving update' },
  ] };
  const meta = { asOf: liveIntent.asOf, windowDays: 30, retrievedAt: `${liveIntent.asOf}T12:00:00Z`, mode: 'live' as const, endpoint: companyPosts.path };
  const result = companyPosts.parse(response, input, meta);
  assert.equal(result.evidence.length, 4);
  assert.deepEqual(result.triggers.map(trigger => trigger.kind), ['post', 'post']);
  assert.match(result.evidence[0].claim, /^Northwind AI posted on 2026-11-13:/);
  assert.match(result.evidence[1].claim, /^Cloud Report posted on 2026-11-10:/);
  assert.equal(result.evidence[0].source.url, url + '1');
  assert.equal(String(result.evidence[0].value).length, 120);
  assert.equal(result.evidence[0].verifiable, true);
  assert.equal(result.evidence[3].verifiable, false);
});
