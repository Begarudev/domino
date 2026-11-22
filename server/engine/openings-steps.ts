// Openings pipeline (Search Desk, rule O1). OWNER: domino-livedata. Contract: shared/desk.ts + docs/CONTRACT.md "Search Desk".
// Every Crustdata read goes through readSource/publishSource, so each one is cached, ledgered and shown as a source.read.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Company, Evidence, IsoDate, ReplayScore } from '../../shared/types.ts';
import type { Departure, FunnelStage, Opening, OpeningsFunnel, RoleFamily } from '../../shared/desk.ts';
import { companyHeadcount, DEPARTURE_PAGES, hireOutcomes, jobOutcomes, jobReplacements, personDepartures, personReplacements } from '../crustdata/openings.ts';
import type { CohortCompany, HeadcountFact, OutcomeInput, OutcomeRow, ReplacementCheck, ScanWindow } from '../crustdata/openings.ts';
import { parseIntentRules } from '../domain/intent.ts';
import { detectOpenings, drainWindow, groupDepartures, MAX_STAFF, MIN_STAFF, OUTCOME_DAYS, scoreOpenings } from '../domain/openings.ts';
import { shiftDays } from '../domain/facts.ts';
import type { AcquisitionFact, Check, CompanyFacts, DepartureFact, ReplacementFact } from '../domain/openings.ts';
import { root } from '../env.ts';
import type { ToolContext } from '../runtime/tool.ts';
import { readAcquihireNews } from './acquihire.ts';
import { publishSource, readSource } from './sources.ts';
import type { Runner } from './steps.ts';

export interface SearchScope {
  roleFamilies: RoleFamily[];
  asOf: IsoDate;
  runKind: 'live' | 'replay';
  horizonEnd: IsoDate | null;
  cohort: string;                   // e.g. "AI/ML companies, 20-5,000 staff"
  assumptions: string[];
}
export interface Replacement { companyId: string; roleFamily: RoleFamily; kind: 'job_post' | 'hire'; date: IsoDate; evidenceId: string }
export interface OpeningsOutputs {
  scope_search: SearchScope;
  pull_departures: { departures: Departure[]; facts: DepartureFact[]; cohort: CohortCompany[]; totalCount: number | null; evidence: Evidence[] };
  resolve_departures: { companies: Company[]; departures: Departure[]; facts: DepartureFact[]; companyFacts: CompanyFacts[]; evidence: Evidence[] };
  check_replacements: {
    replacements: Replacement[]; replacementFacts: ReplacementFact[]; staleCompanyIds: string[];
    jobChecks: Record<string, Check>; hireChecks: Record<string, Check>; newsChecked: string[]; acquisitions: AcquisitionFact[]; evidence: Evidence[];
  };
  detect_openings: { openings: Opening[]; skipped: { companyId: string; roleFamily: RoleFamily; reason: string }[]; funnel: OpeningsFunnel };
  score_openings: ReplayScore;
}

const FAMILIES: RoleFamily[] = ['inference', 'ml_platform', 'mlops', 'gpu_llm_infra'];
// Person search answers about 4 requests a minute before it returns 429; pages are spaced to stay under that.
const PERSON_SPACING_MS = Number(process.env.DOMINO_OPENINGS_PERSON_SPACING_MS ?? 16_000);
const scanWindow = (scope: SearchScope): ScanWindow => ({ asOf: scope.asOf, runKind: scope.runKind });
const time = (scope: SearchScope) => ({ asOf: scope.asOf, windowDays: 90 });
const pace = async (ctx: ToolContext, ms = PERSON_SPACING_MS) => { if (ctx.mode === 'live') await ctx.wait(ms); };
const today = () => new Date().toISOString().slice(0, 10);
const lag = (scope: SearchScope) => scope.runKind === 'replay' ? 30 : undefined;

function toDeparture(fact: DepartureFact): Departure {
  return { id: fact.id, companyId: fact.companyId, role: fact.role, roleFamily: fact.roleFamily, initial: fact.initial,
    date: fact.started[0], precision: 'month', toCompanyId: fact.toCompanyId, toCompanyName: fact.toCompanyName, evidenceId: fact.evidenceId };
}

/** Groups worth spending on: >= 2 departures (settled or straddling) at a company that may be 20–5,000 staff. */
function candidateGroups(scope: SearchScope, facts: DepartureFact[], headcount: (id: string) => number | null) {
  return groupDepartures({ asOf: scope.asOf, departures: facts, profileLagDays: lag(scope) })
    .filter(group => group.conclusive.length + group.unsettled.length >= 2)
    .filter(group => { const size = headcount(group.companyId); return size == null || (size >= MIN_STAFF && size <= MAX_STAFF); });
}

/** Analyst-entered publisher URLs for headlines that live search returns only as redirects (config/seller.json). */
function analystHints(): { title: string; url: string }[] {
  try {
    const seller = JSON.parse(readFileSync(resolve(root, 'config/seller.json'), 'utf8')) as { publisherHints?: { title: string; url: string }[] };
    return seller.publisherHints ?? [];
  } catch {
    return [];
  }
}


/** Company enrich in batches; a batch that fails (Crustdata 500s on some ids) is split down to single ids. */
async function sizeCompanies(ctx: ToolContext, scope: SearchScope, ids: number[], matched: boolean) {
  const facts = new Map<number, HeadcountFact>();
  const evidence: Evidence[] = [];
  const read = async (chunk: number[]): Promise<boolean> => {
    try {
      const batch = await readSource(ctx, companyHeadcount, { asOf: scope.asOf, crustdataIds: chunk }, time(scope));
      if (!batch.parsed.facts) return false;                // the tool wrapper's "unavailable" fallback
      ctx.store.transaction(() => publishSource(ctx, batch, batch.evidence, matched ? batch.evidence.map(row => row.id) : []));
      evidence.push(...batch.evidence);
      for (const fact of batch.parsed.facts) facts.set(fact.crustdataId, { ...fact, evidenceId: fact.evidenceId && batch.remap(fact.evidenceId) });
      return true;
    } catch {
      return false;
    }
  };
  const visit = async (chunk: number[], size: number): Promise<void> => {
    for (let i = 0; i < chunk.length; i += size) {
      const part = chunk.slice(i, i + size);
      if (await read(part) || size === 1) continue;
      await pace(ctx, 4000);
      await visit(part, size > 5 ? 5 : 1);
    }
  };
  await visit(ids, 25);
  return { facts, evidence };
}

export const openingsSteps: { [K in keyof OpeningsOutputs]: Runner<K> } = {
  scope_search: ctx => {
    const run = ctx.store.requireRun(ctx.runId);
    const intent = parseIntentRules(run.request, today());
    const replay = intent.runKind === 'replay';
    const scope: SearchScope = {
      roleFamilies: FAMILIES, asOf: intent.asOf, runKind: replay ? 'replay' : 'live',
      horizonEnd: replay ? intent.horizonEnd ?? null : null, cohort: 'Companies with 20–5,000 staff that lost infra/serving engineers',
      assumptions: [
        'Role dates are month-level; each month is checked as the interval of its days.',
        replay ? 'Replay: a move counts only if its new start month ended 30 days before the cutoff.' : 'Live: departures in the last 90 days.',
      ],
    };
    return { output: scope, summary: `${replay ? 'Replay as of ' + scope.asOf : 'Live scan as of ' + scope.asOf}: inference, ML platform, MLOps and GPU/LLM infrastructure roles` };
  },

  pull_departures: async (ctx, c) => {
    const scope = c.scope_search!;
    const facts: DepartureFact[] = [];
    const cohort = new Map<string, CohortCompany>();
    const evidence: Evidence[] = [];
    let cursor: string | undefined;
    let totalCount: number | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < DEPARTURE_PAGES + 5; page++) {
      if (page) await pace(ctx);
      const batch = await readSource(ctx, personDepartures, { window: scanWindow(scope), ...(cursor ? { cursor } : {}) }, time(scope));
      const parsed = batch.parsed;
      ctx.store.transaction(() => publishSource(ctx, batch, batch.evidence, batch.evidence.map(row => row.id)));
      evidence.push(...batch.evidence);
      facts.push(...(parsed.departures ?? []).map(fact => ({ ...fact, evidenceId: batch.remap(fact.evidenceId) })));
      for (const company of parsed.companies ?? []) if (!cohort.has(company.id)) cohort.set(company.id, company);
      totalCount = parsed.totalCount ?? totalCount;
      const next = parsed.nextCursor;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return {
      output: { departures: facts.map(toDeparture), facts, cohort: [...cohort.values()], totalCount, evidence },
      summary: `${facts.length} departures from infra/serving roles at ${cohort.size} companies (${totalCount ?? '?'} profiles matched)`,
    };
  },

  resolve_departures: async (ctx, c) => {
    const scope = c.scope_search!;
    const { facts, cohort } = c.pull_departures!;
    const byId = new Map(cohort.map(company => [company.id, company]));
    // Live sizes come from the profiles' latest headcount; replay never trusts today's size and enriches as of the cutoff.
    const groups = candidateGroups(scope, facts, id => scope.runKind === 'replay' ? null : byId.get(id)?.headcount ?? null);
    const ids = [...new Set(groups.map(group => byId.get(group.companyId)?.crustdataId).filter((id): id is number => id != null))];
    const { facts: headcounts, evidence } = await sizeCompanies(ctx, scope, ids, true);
    const companyFacts: CompanyFacts[] = cohort.map(company => {
      const enriched = headcounts.get(company.crustdataId);
      return { id: company.id, name: company.name, headcount: enriched?.headcount ?? (scope.runKind === 'replay' ? null : company.headcount),
        headcountChange90d: enriched?.change90d ?? null, headcountEvidenceId: enriched?.evidenceId ?? null };
    });
    const size = new Map(companyFacts.map(row => [row.id, row.headcount]));
    const companies: Company[] = cohort.map(company => ({ id: company.id, name: company.name, aliases: [company.name], domain: company.domain,
      crustdataId: company.crustdataId, headcount: size.get(company.id) ?? null, evidenceIds: [] }));
    const inWindow = facts.filter(fact => drainWindow(fact.left, scope.asOf) !== 'outside');
    return {
      output: { companies, departures: inWindow.map(toDeparture), facts, companyFacts, evidence },
      summary: `${inWindow.length} departures inside or on the edge of the 90-day window; ${groups.length} company/role groups with 2 or more; ${headcounts.size} sized by company enrich`,
    };
  },

  check_replacements: async (ctx, c) => {
    const scope = c.scope_search!;
    const { facts, companyFacts } = c.resolve_departures!;
    const { cohort } = c.pull_departures!;
    const sizes = new Map(companyFacts.map(company => [company.id, company.headcount]));
    const crustId = new Map(cohort.map(company => [company.id, company.crustdataId]));
    const groups = candidateGroups(scope, facts, id => sizes.get(id) ?? null).filter(group => group.conclusive.length >= 2);
    const checks: ReplacementCheck[] = groups.flatMap(group => {
      const crustdataId = crustId.get(group.companyId);
      const since = group.conclusive.map(d => d.left[0]).sort().at(-1)!;
      return crustdataId == null ? [] : [{ companyId: group.companyId, crustdataId, roleFamily: group.roleFamily, since, companyName: group.conclusive[0].companyName }];
    });
    const replacementFacts: ReplacementFact[] = [];
    const evidence: Evidence[] = [];
    const jobChecks: Record<string, Check> = {};
    const hireChecks: Record<string, Check> = {};
    let newsChecked: string[] = [];
    let acquisitions: AcquisitionFact[] = [];
    const scopeOf = (kind: string, companyId: string) => {
      const check = checks.find(item => item.companyId === companyId)!;
      return `${kind} at company_id ${check.crustdataId}, ${check.roleFamily.replace('_', ' ')} title phrases, dated ${check.since} to ${scope.asOf}`;
    };
    if (checks.length) {
      try {
        const jobs = await readSource(ctx, jobReplacements, { asOf: scope.asOf, checks }, time(scope));
        ctx.store.transaction(() => publishSource(ctx, jobs, jobs.evidence, jobs.evidence.map(row => row.id)));
        evidence.push(...jobs.evidence);
        replacementFacts.push(...(jobs.parsed.replacements ?? []).map(r => ({ ...r, evidenceId: jobs.remap(r.evidenceId) })));
        for (const id of jobs.parsed.checked ?? []) jobChecks[id] = { checkedAt: scope.asOf, scope: scopeOf('Job search', id),
          evidenceId: jobs.parsed.checkEvidence?.[id] ? jobs.remap(jobs.parsed.checkEvidence[id]) : undefined,
          records: (jobs.parsed.replacements ?? []).filter(r => r.companyId === id).length };
      } catch {
        // A failed job search leaves the leg unverifiable: O1 puts the group on Watch ("I can't verify no replacement was posted").
        for (const check of checks) jobChecks[check.companyId] = { checkedAt: null, failed: true };
      }
      await pace(ctx);
      try {
        const hires = await readSource(ctx, personReplacements, { asOf: scope.asOf, checks, lagDays: lag(scope) ?? 0 }, time(scope));
        ctx.store.transaction(() => publishSource(ctx, hires, hires.evidence, hires.evidence.map(row => row.id)));
        evidence.push(...hires.evidence);
        const found = (hires.parsed.replacements ?? []).map(r => ({ ...r, evidenceId: hires.remap(r.evidenceId) }));
        replacementFacts.push(...found);
        for (const id of hires.parsed.checked ?? []) hireChecks[id] = { checkedAt: scope.asOf, scope: scopeOf('Person search (current role)', id),
          evidenceId: hires.parsed.checkEvidence?.[id] ? hires.remap(hires.parsed.checkEvidence[id]) : undefined,
          records: found.filter(r => r.companyId === id).length };
      } catch {
        // A timed-out or failed hire check is "I can't verify": O1 keeps the group on Watch, never open.
        for (const check of checks) hireChecks[check.companyId] = { checkedAt: null, failed: true, scope: scopeOf('Person search (current role)', check.companyId) };
      }

      // Acqui-hire guard from live news: is a departure destination reported as acquiring, licensing or hiring A's team?
      const pairs = groups.slice(0, 3).map(group => ({ loser: group.conclusive[0].companyName,
        hirers: [...new Set(group.conclusive.map(d => d.toCompanyName).filter((name): name is string => Boolean(name)))].slice(0, 3) }));
      const intent = { ...parseIntentRules(ctx.store.requireRun(ctx.runId).request, today()), asOf: scope.asOf, runKind: scope.runKind };
      const hints = analystHints();
      const news = await readAcquihireNews(ctx, intent, pairs, { publisherHints: hints });
      evidence.push(...news.evidence);
      if (!news.reason?.startsWith('Skipped')) newsChecked = groups.slice(0, 3).map(group => group.companyId);
      acquisitions = news.acquisitions.filter(event => event.date).map(event => {
        const row = news.evidence.find(item => item.source.url === event.sourceUrl && item.verifiable);
        const host = event.sourceUrl ? new URL(event.sourceUrl).hostname.replace(/^www\./, '') : 'source';
        return { acquirer: event.acquirer, acquired: event.acquired, date: event.date!, url: event.sourceUrl ?? null,
          label: `“${typeof row?.value === 'string' ? row.value : `${event.acquirer} and ${event.acquired}`}” (${host})`,
          evidenceId: row?.id ?? null, analystEntered: hints.some(hint => hint.url === event.sourceUrl) };
      });
    }
    const replacements: Replacement[] = replacementFacts.map(r => ({ companyId: r.companyId, roleFamily: r.roleFamily, kind: r.kind, date: r.date[0], evidenceId: r.evidenceId }));
    return {
      output: { replacements, replacementFacts, staleCompanyIds: Object.entries(jobChecks).filter(([, v]) => v.failed).map(([id]) => id),
        jobChecks, hireChecks, newsChecked, acquisitions, evidence },
      summary: `${checks.length} company/role groups checked: ${replacementFacts.length} replacement posts or hires, ${acquisitions.length} dated acquisition reports`,
    };
  },

  detect_openings: (ctx, c) => {
    const scope = c.scope_search!;
    const { facts, companyFacts } = c.resolve_departures!;
    const r = c.check_replacements!;
    const result = detectOpenings({
      asOf: scope.asOf, runId: ctx.runId, replay: scope.runKind === 'replay', profileLagDays: lag(scope),
      departures: facts, companies: companyFacts, replacements: r.replacementFacts, jobChecks: r.jobChecks, hireChecks: r.hireChecks,
      newsChecked: r.newsChecked, acquisitions: r.acquisitions,
    });
    const funnel = buildFunnel(ctx.runId, scope, c.pull_departures!.totalCount, facts, companyFacts, result.openings, ctx.mode);
    const count = (status: Opening['status']) => result.openings.filter(o => o.status === status).length;
    const provisional = result.openings.filter(o => o.provisional).length;
    return { output: { ...result, funnel }, summary: `${count('open')} predicted openings (${provisional} provisional), ${count('held')} held, ${count('watch')} on watch` };
  },

  score_openings: async (ctx, c) => {
    const scope = c.scope_search!;
    const { facts } = c.resolve_departures!;
    const { cohort } = c.pull_departures!;
    const byId = new Map(cohort.map(company => [company.id, company]));
    // Universe: every company with a family departure known by the cutoff, sized as of the cutoff (enrich timeseries).
    const groups = groupDepartures({ asOf: scope.asOf, departures: facts, profileLagDays: lag(scope) });
    const ids = [...new Set(groups.map(group => byId.get(group.companyId)?.crustdataId).filter((id): id is number => id != null))];
    const { facts: sized } = await sizeCompanies(ctx, scope, ids, false);
    const universe = cohort.filter(company => {
      const size = sized.get(company.crustdataId)?.headcount;
      return ids.includes(company.crustdataId) && size != null && size >= MIN_STAFF && size <= MAX_STAFF;
    });
    const universeIds = universe.map(company => company.crustdataId);
    const toCompany = new Map(universe.map(company => [company.crustdataId, company.id]));
    const read = async (spec: typeof jobOutcomes | typeof hireOutcomes, input: Omit<OutcomeInput, 'crustdataIds'>) => {
      const rows: OutcomeRow[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5 && universeIds.length; page++) {
        if (spec === hireOutcomes || page) await pace(ctx, spec === hireOutcomes ? PERSON_SPACING_MS : 3000);
        const batch = await readSource(ctx, spec, { ...input, crustdataIds: universeIds, ...(cursor ? { cursor } : {}) }, time(scope));
        ctx.store.transaction(() => publishSource(ctx, batch, batch.evidence, batch.evidence.map(row => row.id)));
        rows.push(...(batch.parsed.rows ?? []).map(row => ({ ...row, evidenceId: batch.remap(row.evidenceId) })));
        cursor = batch.parsed.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return rows;
    };
    const horizon = shiftDays(scope.asOf, OUTCOME_DAYS);
    const recentPosts = await read(jobOutcomes, { after: shiftDays(scope.asOf, -30), through: scope.asOf, familyOnly: false, label: 'any job post in the 30 days before the cutoff' });
    const posts = await read(jobOutcomes, { after: scope.asOf, through: horizon, familyOnly: true, label: 'outcome: role-family job posts' });
    const hires = await read(hireOutcomes, { after: scope.asOf, through: horizon, familyOnly: true, label: 'outcome: role-family hires' });
    const outcomes = [...posts, ...hires].flatMap(row => {
      const companyId = toCompany.get(row.crustdataId);
      return companyId ? [{ companyId, roleFamily: row.roleFamily, kind: row.kind, date: row.date, title: row.title, evidenceId: row.evidenceId }] : [];
    });
    const score = scoreOpenings({
      asOf: scope.asOf, openings: c.detect_openings!.openings,
      universe: universe.map(company => ({ id: company.id, name: company.name })), outcomes,
      anyPostIds: [...new Set(recentPosts.flatMap(row => toCompany.get(row.crustdataId) ?? []))],
      headcountIds: universe.filter(company => (sized.get(company.crustdataId)?.change30d ?? -1) >= 30).map(company => company.id),
      snapshotLabel: `${ctx.mode === 'live' ? 'Live' : ctx.mode === 'cache' ? 'Live-cached' : 'Fixture'} Crustdata read ${today()}, filtered to facts dated on or before ${scope.asOf}; not a point-in-time index`,
    });
    return { output: score, summary: score.note };
  },
};

const monthOf = (day: IsoDate) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const personRow = (d: DepartureFact, detail?: string) => ({
  label: `${d.initial} ${d.role} · ${d.companyName} · left ${monthOf(d.left[0])} → ${d.toCompanyName ?? '?'} (${monthOf(d.started[0])})`,
  ...(detail ? { detail } : {}), evidenceId: d.evidenceId,
});

/** O1 funnel with drill-down rows: people appear only as role + initial + month. */
export function buildFunnel(runId: string, scope: SearchScope, profiles: number | null, facts: DepartureFact[], companies: CompanyFacts[],
  openings: Opening[], mode: string): OpeningsFunnel {
  const size = new Map(companies.map(company => [company.id, company.headcount]));
  const known = facts.filter(d => scope.runKind !== 'replay' || d.started[1] <= shiftDays(scope.asOf, -30));
  const inWindow = known.filter(d => drainWindow(d.left, scope.asOf) !== 'outside');
  const icp = inWindow.filter(d => { const n = size.get(d.companyId); return n == null || (n >= MIN_STAFF && n <= MAX_STAFF); });
  const groups = groupDepartures({ asOf: scope.asOf, departures: icp, profileLagDays: lag(scope) })
    .filter(group => group.conclusive.length + group.unsettled.length >= 2);
  const decided = (status: Opening['status'], provisional?: boolean) => openings.filter(o => o.status === status && (provisional == null || Boolean(o.provisional) === provisional));
  const openingRows = (rows: Opening[]) => rows.map(o => ({ label: `${o.companyName} · ${o.roleFamily.replace('_', ' ')}`,
    detail: (o.holdReasons ?? []).join('; ') || o.clauses?.map(c => `${c.state === 'met' ? '✓' : c.state === 'open' ? '⏳' : c.state === 'cant_verify' ? '?' : '✗'} ${c.text}`).join(' · ') }));
  const multi = openings.filter(o => groups.some(g => g.companyId === o.companyId && g.roleFamily === o.roleFamily));
  const stages: FunnelStage[] = [
    { id: 'profiles', label: `People who left an infra/serving title and started a new role (${scope.runKind === 'replay' ? 'replay window' : 'last 90 days'})`, count: profiles ?? facts.length },
    { id: 'departures', label: 'Direct moves out of an engineering role in a tracked family', count: known.length, rows: known.map(d => personRow(d)) },
    { id: 'window', label: 'Departure month inside or straddling the 90-day window', count: inWindow.length,
      rows: inWindow.map(d => personRow(d, drainWindow(d.left, scope.asOf) === 'straddles' ? 'not conclusive: month straddles window start' : undefined)) },
    { id: 'icp', label: 'At a company with 20–5,000 staff', count: icp.length, rows: icp.map(d => personRow(d)) },
    { id: 'groups', label: 'Company and role family with 2 or more departures', count: groups.length,
      rows: groups.flatMap(g => [...g.conclusive.map(d => personRow(d)), ...g.unsettled.map(d => personRow(d, 'not conclusive: month straddles window start'))]) },
    { id: 'open', label: 'Predicted openings (settled)', count: decided('open', false).length, rows: openingRows(decided('open', false)) },
    { id: 'provisional', label: 'Predicted openings (provisional: replacement window still open)', count: decided('open', true).length, rows: openingRows(decided('open', true)) },
    { id: 'held', label: 'Held by a false-drain guard', count: decided('held').filter(o => multi.includes(o)).length, rows: openingRows(decided('held').filter(o => multi.includes(o))) },
    { id: 'watch', label: 'Watch (2+ departures but a check could not be verified)', count: decided('watch').filter(o => multi.includes(o)).length, rows: openingRows(decided('watch').filter(o => multi.includes(o))) },
  ];
  return { runId, rule: 'O1', lockedAt: '22 Nov 2026 14:08 IST (month-interval semantics 14:14 IST), before replay outcomes', stages,
    snapshot: `${mode === 'live' ? 'Live' : mode === 'cache' ? 'Live-cached' : 'Fixture'} Crustdata, as of ${scope.asOf}` };
}
