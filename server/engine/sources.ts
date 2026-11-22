import type { Evidence, Intent } from '../../shared/types.ts';
import type { EndpointSpec } from '../crustdata/spec.ts';
import type { EvidenceSource } from '../db.ts';
import type { ParseMeta, TriggerBatch } from '../domain/types.ts';
import { hash, ToolContext } from '../runtime/tool.ts';
import * as deps from './deps.ts';

export type SourceResult = Pick<TriggerBatch, 'evidence'> & Partial<Omit<TriggerBatch, 'evidence'>>;
type SourceTime = Pick<ParseMeta, 'asOf' | 'windowDays'>;
type SourceLocator = EvidenceSource & { time: SourceTime };

export const dateShift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

export function predictionEvidence(evidence: Evidence[], intent: Intent): Evidence[] {
  if (intent.runKind !== 'replay') return evidence;
  return deps.filterAsOf(evidence, intent.asOf).kept.filter(row => row.observedAt && row.observedAt <= intent.asOf);
}

const specs = [
  deps.jobSearch, deps.personSearchRecentMoves, deps.companySearchGrowth, deps.companyEnrich, deps.personSearchDeciders,
  deps.jobSearchOutcomes, deps.personSearchOutcomes,
];

export async function readSource<I>(ctx: ToolContext, spec: EndpointSpec<I, SourceResult>, input: I, time: SourceTime) {
  const raw = await ctx.crust(spec, input, time, deps.fixtureFor);
  const ids = new Map(raw.evidence.map(row => [row.id, `ev_${hash(`${ctx.runId}|${spec.name}|${row.mode}|${row.id}`).slice(0, 24)}`]));
  const sources = new Map<string, SourceLocator>();
  const evidence = raw.evidence.map(item => {
    const id = ids.get(item.id)!;
    sources.set(id, { endpoint: spec.name, input, rawId: item.id, time });
    return { ...item, id };
  });
  const withIds = <T extends { evidenceIds: string[] }>(rows: T[] = []): T[] =>
    rows.map(row => ({ ...row, evidenceIds: row.evidenceIds.flatMap(id => ids.has(id) ? [ids.get(id)!] : []) }));

  return {
    evidence, sources, mentions: withIds(raw.mentions), people: withIds(raw.people), triggers: withIds(raw.triggers),
  };
}

export function publishEvidence(ctx: ToolContext, evidence: Evidence[], sources: Map<string, SourceLocator>) {
  const fresh = evidence.filter(row => !ctx.store.findEvidence(row.id));
  if (!fresh.length) return;
  for (const row of fresh) {
    const source = sources.get(row.id);
    if (source) ctx.store.saveEvidenceSource(row.id, source);
  }
  ctx.store.recordEvent(ctx.runId, { type: 'evidence.added', evidence: fresh });
}

export async function recheckSource(ctx: ToolContext, old: Evidence, source: EvidenceSource): Promise<Evidence | undefined> {
  const spec = specs.find(candidate => candidate.name === source.endpoint);
  if (!spec) return;
  // An endpoint name and its original input are persisted together by readSource.
  const result = await ctx.crust(spec as EndpointSpec<unknown, SourceResult>, source.input, (source as SourceLocator).time,
    deps.fixtureFor);
  const fresh = result.evidence.find(row => row.id === source.rawId ||
    (row.source.recordId !== undefined && row.source.recordId === old.source.recordId && row.source.field === old.source.field));
  return fresh && { ...fresh, id: old.id };
}
