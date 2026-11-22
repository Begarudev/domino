import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveProbe, liveIntent, probeIntent, replayIntent } from '../../scripts/probe-live.ts';

const skip = process.env.CRUSTDATA_API_KEY?.trim() ? false : 'CRUSTDATA_API_KEY is unset';

test('Crustdata adapters parse live responses at limit 3', { skip }, async t => {
  const probe = new LiveProbe({ searchLimit: 3, maxCredits: 60 });
  // Check outcome adapters over an elapsed window so dated outcomes can exist.
  await probeIntent(probe, liveIntent, 3, replayIntent);

  assert.equal(probe.calls.length, 7);
  for (const row of probe.calls) {
    await t.test([row.endpoint, row.leg].filter(Boolean).join(' '), subtest => {
      assert.equal(row.error, undefined);
      assert.ok(row.status !== null && row.status >= 200 && row.status < 300);
      assert.ok(row.parsed, 'Adapter did not parse the response');
      assert.ok(row.returned !== null && row.returned <= 3, 'Expected at most three API rows');
      if (row.totalCount !== null && row.totalCount >= 3) assert.equal(row.returned, 3);
      if (row.returned < 3) subtest.diagnostic(`Crustdata returned ${row.returned} rows for the three-result sample`);
      if (row.returned > 0) assert.ok(row.parsed.evidence > 0, 'Adapter found no evidence in the returned rows');

      assert.equal(row.examples.length, Math.min(2, row.parsed.evidence));
      for (const { claim, observedAt } of row.examples) {
        assert.ok(claim.trim());
        if (observedAt !== null) assert.match(observedAt, /^\d{4}-\d{2}-\d{2}$/);
      }
    });
  }
});
