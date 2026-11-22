import type { Evidence, Intent } from '../../shared/types.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import type { EvidenceSource } from '../db.ts';
import type { ParseMeta, TriggerBatch } from '../domain/types.ts';
import { hash, ToolContext } from '../runtime/tool.ts';
import type { CrustReadMeta } from '../runtime/tool.ts';
import { describeRead } from './source-theatre.ts';
import * as deps from './deps.ts';

export type SourceResult = Pick<TriggerBatch, 'evidence'> & Partial<Omit<TriggerBatch, 'evidence'>> & {
  nextCursor?: string | null;
};
type SourceTime = Pick<ParseMeta, 'asOf' | 'windowDays'>;

export const dateShift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

export function predictionEvidence(evidence: Evidence[], intent: Intent): Evidence[] {
  if (intent.runKind !== 'replay') return evidence;
  return deps.filterAsOf(evidence, intent.asOf).kept.filter(row => row.observedAt && row.observedAt <= intent.asOf);
}

const specs = [
  deps.jobSearch, deps.personSearchRecentMoves, deps.companySearchGrowth, deps.companyEnrich, deps.personSearchDeciders,
  deps.jobSearchOutcomes, deps.personSearchOutcomes,
  deps.newsSearch, deps.newsFetch,
  deps.newsAcquihireSearch, deps.newsAcquihireResolve, deps.newsAcquihireFetch,
];

export async function readSource<I, O extends SourceResult = SourceResult>(ctx: ToolContext, spec: EndpointSpec<I, O>, input: I, time: SourceTime) {
  let observation: CrustReadMeta | undefined;
  const raw = await ctx.crust(spec, input, time, deps.fixtureFor, () => ({ evidence: [] }) as unknown as O,
    read => { observation = read; });
  const previous = ctx.store.sql.prepare(`SELECT evidence.id, json_extract(evidence.json, '$.mode') AS mode,
    json_extract(evidence_sources.json, '$.rawId') AS rawId FROM evidence JOIN evidence_sources USING (id)
    WHERE evidence.run_id = ? AND json_extract(evidence_sources.json, '$.endpoint') = ?
      AND coalesce(json_extract(evidence_sources.json, '$.path'), ?) = ?`)
    .all(ctx.runId, spec.name, spec.path, spec.path);
  const existing = new Map(previous.map(row => [`${row.mode}|${row.rawId}`, row.id as string]));
  const suffix = hash(ctx.runId).slice(0, 16);
  const ids = new Map(raw.evidence.map(row => {
    const identity = `${row.mode}|${row.id}`;
    // Keep ordering stable across runs for domain tie-breaks while scoping each row to one run.
    return [row.id, existing.get(identity) ?? `ev_${hash(`${spec.name}|${spec.path}|${identity}`).slice(0, 16)}${suffix}`];
  }));
  const sources = new Map<string, EvidenceSource>();
  const evidence = raw.evidence.map(item => {
    const id = ids.get(item.id)!;
    sources.set(id, { endpoint: spec.name, path: spec.path, input, rawId: item.id, time });
    return { ...item, id };
  });
  const withIds = <T extends { evidenceIds: string[] }>(rows: T[] = []): T[] =>
    rows.map(row => ({ ...row, evidenceIds: row.evidenceIds.flatMap(id => ids.has(id) ? [ids.get(id)!] : []) }));

  return {
    evidence, sources, mentions: withIds(raw.mentions), people: withIds(raw.people), triggers: withIds(raw.triggers),
    observation, endpoint: spec.name, path: spec.path, input, time, nextCursor: raw.nextCursor, readSummary: raw.readSummary,
    acquisitionLeads: withIds(raw.acquisitionLeads), acquisitions: raw.acquisitions ?? [],
    // Typed outputs that cite evidence ids (e.g. openings departures) map them through `remap` to run-scoped ids.
    parsed: raw, remap: (id: string) => ids.get(id) ?? id,
  };
}

type ReadBatch = Awaited<ReturnType<typeof readSource>>;
export function publishSource(ctx: ToolContext, batch: ReadBatch, evidence: Evidence[], matchedIds: string[]) {
  if (batch.observation) {
    ctx.store.recordEvent(ctx.runId, describeRead(batch.observation, ctx.step, batch.endpoint, batch.path,
      batch.input, batch.time, batch, new Set(matchedIds)));
  }
  const fresh = evidence.filter(row => !ctx.store.findEvidence(row.id));
  if (!fresh.length) return;
  for (const row of fresh) {
    const source = batch.sources.get(row.id);
    if (source) ctx.store.saveEvidenceSource(row.id, source);
  }
  ctx.store.recordEvent(ctx.runId, { type: 'evidence.added', evidence: fresh });
}

export async function recheckSource(ctx: ToolContext, old: Evidence, source: EvidenceSource): Promise<Evidence | undefined> {
  const candidates = specs.filter(candidate => candidate.name === source.endpoint);
  const spec = candidates.find(candidate => candidate.path === (source.path ?? old.source.endpoint)) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!spec) return;
  // An endpoint name and its original input are persisted together by readSource.
  const result = await readSource(ctx, spec as EndpointSpec<unknown, SourceResult>, source.input, source.time);
  const fresh = result.evidence.find(row => result.sources.get(row.id)?.rawId === source.rawId ||
    (row.source.recordId !== undefined && row.source.recordId === old.source.recordId && row.source.field === old.source.field));
  ctx.store.transaction(() => publishSource(ctx, result, [], fresh ? [fresh.id] : []));
  return fresh && { ...fresh, id: old.id, retrievedAt: fresh.retrievedAt > old.retrievedAt ? fresh.retrievedAt
    : new Date(Date.parse(old.retrievedAt) + 1).toISOString() };
}
