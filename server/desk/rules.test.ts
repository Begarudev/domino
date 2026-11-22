import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../db.ts';
import { rulesRegistry } from './rules.ts';

test('rules registry lists every rule with thresholds, lock time and counts, even before any run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-rules-'));
  const store = new Store(join(dir, 'r.db'));
  try {
    const cards = rulesRegistry(store);
    assert.deepEqual(cards.map(card => card.id), ['O1', 'R1', 'CONTAGION', 'DISPLACEMENT', 'DIRECT']);
    for (const card of cards) {
      assert.ok(card.statement && card.thresholds.length && card.lockedAt && card.counts.length, card.id);
      assert.ok(card.counts.every(item => Number.isInteger(item.value)));
    }
    assert.match(cards[0].lockedAt, /14:08 IST, after seeing live departure counts and before any replay outcome/);
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
