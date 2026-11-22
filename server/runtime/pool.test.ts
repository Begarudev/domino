import { describe, expect, test } from 'bun:test';
import { mapLimit } from './pool.ts';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('mapLimit', () => {
  test('keeps input order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10], 3, async (ms, index) => {
      peak = Math.max(peak, ++active);
      await tick(ms);
      active--;
      return index * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(3);
  });

  test('stops starting work after a failure and lets in-flight calls settle first', async () => {
    const started: number[] = [];
    const settled: number[] = [];
    const run = mapLimit([0, 1, 2, 3, 4, 5], 2, async index => {
      started.push(index);
      if (index === 1) throw new Error('budget');
      await tick(15);
      settled.push(index);
      return index;
    });
    await expect(run).rejects.toThrow('budget');
    expect(started).toEqual([0, 1]);
    expect(settled).toEqual([0]);
  });

  test('handles an empty list', async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});
