// Maps items with at most `limit` calls in flight and returns results in input order.
// After the first failure no new item starts; calls already running settle before the error is rethrown,
// so a budget stop still means no further spend and no ledger rows written after the step ends.
export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  async function lane() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index], index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed) throw firstError;
  return results;
}
