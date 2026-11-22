import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Evidence } from '../shared/types.ts';
import { withArticle } from './db.ts';

const row = (claim: string) => ({ id: 'ev', claim }) as unknown as Evidence;

test('stored departure rows read with the right article; other text is untouched', () => {
  assert.equal(withArticle(row('P. left a ML Platform Engineer role at Abacus.AI in Oct 2026')).claim,
    'P. left an ML Platform Engineer role at Abacus.AI in Oct 2026');
  assert.equal(withArticle(row('S. left a MLOps Engineer role')).claim, 'S. left an MLOps Engineer role');
  assert.equal(withArticle(row('A. left a Senior Inference Engineer role')).claim, 'A. left a Senior Inference Engineer role');
  assert.equal(withArticle(row('K. left a GPU Infrastructure Engineer role')).claim, 'K. left a GPU Infrastructure Engineer role');
});
