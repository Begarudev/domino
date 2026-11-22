import type { Intent } from '../../shared/types.ts';
import { acquihireCheck } from '../crustdata/news.ts';
import type { AcquihireOptions, AcquihirePair, AcquihireResult } from '../crustdata/news.ts';
import type { ToolContext } from '../runtime/tool.ts';
import { publishSource, readSource } from './sources.ts';

/** O1 may consume acquisitions to guard a drain; this helper does not run O1 or create triggers. */
export function readAcquihireNews(ctx: ToolContext, intent: Intent, pairs: AcquihirePair[], options: AcquihireOptions = {}): Promise<AcquihireResult> {
  return acquihireCheck(intent, pairs, async (spec, input) => {
    if (ctx.mode === 'live') await ctx.wait(3000);
    const batch = await readSource(ctx, spec, input, intent);
    ctx.store.transaction(() => publishSource(ctx, batch, batch.evidence,
      batch.evidence.filter(row => row.verifiable).map(row => row.id)));
    return batch;
  }, options);
}
