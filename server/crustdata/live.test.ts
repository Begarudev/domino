import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveProbe, liveIntent, probeIntent, replayIntent } from '../../scripts/probe-live.ts';

// Live calls cost credits and share a few-requests-per-minute limit, so they run only when asked for
// (Bun auto-loads .env, so the key alone is not consent): DOMINO_LIVE_TESTS=1 bun test server/crustdata/live.test.ts
const skip = process.env.DOMINO_LIVE_TESTS !== '1' ? 'set DOMINO_LIVE_TESTS=1 to run live Crustdata checks' : process.env.CRUSTDATA_API_KEY?.trim() ? false : 'CRUSTDATA_API_KEY is unset';
const endpoints = [
  'job_search', 'person_recent_moves', 'company_growth', 'company_enrich', 'person_deciders', 'outcome_check jobs', 'outcome_check hires',
];
let sample: Promise<LiveProbe> | undefined;

async function fetchSample() {
  const probe = new LiveProbe({ searchLimit: 3, maxCredits: 60 });
  // Check outcome adapters over an elapsed window so dated outcomes can exist.
  await probeIntent(probe, liveIntent, 3, replayIntent);
  console.info(`Crustdata live adapter sample used ${probe.creditsUsed.toFixed(2)} credits.`);
  return probe;
}

for (const [index, endpoint] of endpoints.entries()) {
  test(`${endpoint} parses a live response at limit 3`, { skip, timeout: 120_000 }, async () => {
    const { calls } = await (sample ??= fetchSample());
    assert.equal(calls.length, endpoints.length);
    const row = calls[index];
    assert.equal([row.endpoint, row.leg].filter(Boolean).join(' '), endpoint);
    assert.equal(row.error, undefined);
    assert.ok(row.status !== null && row.status >= 200 && row.status < 300);
    assert.ok(row.parsed, 'Adapter did not parse the response');
    assert.ok(row.returned !== null && row.returned <= 3, 'Expected at most three API rows');
    if (row.totalCount !== null && row.totalCount >= 3) assert.equal(row.returned, 3);
    if (row.returned > 0) assert.ok(row.parsed.evidence > 0, 'Adapter found no evidence in the returned rows');

    assert.equal(row.examples.length, Math.min(2, row.parsed.evidence));
    for (const { claim, observedAt } of row.examples) {
      assert.ok(claim.trim());
      if (observedAt !== null) assert.match(observedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  });
}
