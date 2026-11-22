// Interface every Crustdata endpoint module implements. The engine's tool wrapper (server/runtime/tool.ts) owns
// transport (fetch, timeout, retry, cache, fixture, chaos, ledger); endpoint modules own request shape + parsing.
import type { ParseMeta } from '../domain/types.ts';

export interface EndpointSpec<I, O> {
  name: string;                               // stable id used for chaos/ledger, e.g. 'job_search'
  path: string;                               // REST path, e.g. '/job/search'
  method: 'POST' | 'GET';
  build(input: I): unknown;                   // JSON body (or query object for GET)
  parse(raw: unknown, input: I, meta: ParseMeta): O;   // zod-validate; throw NonsenseError on schema-invalid input
  estimateCredits(raw: unknown | null, input: I): number;  // used when X-Credits-Used header is absent
}
