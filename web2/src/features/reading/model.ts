// Reading log data: the O1 funnel (GET /api/openings/funnel) and the run's source.read items, both mapped to one
// decision-row shape. Pure functions only. Nothing here invents a fact: labels, dates and reasons come from the
// funnel rows, the rule's own stage definitions, or the engine's source.read signal.
import type { Sourced } from '../../data/desk.ts';
import type { SourceCard } from '../../data/derive.ts';

export interface FunnelRow { label: string; detail?: string; evidenceId?: string }
export interface FunnelStage { id: string; label: string; count: number; rows?: FunnelRow[] }
export interface OpeningsFunnel { runId: string; rule: string; lockedAt: string; snapshot?: string; stages: FunnelStage[] }

/** The funnel endpoint isn't on this server (404 or the SPA fallback answered). */
export class FunnelMissing extends Error {}

export async function loadFunnel(): Promise<Sourced<OpeningsFunnel>> {
  let res: Response;
  try { res = await fetch('/api/openings/funnel'); } catch { throw new Error('the DOMINO server isn’t answering on /api'); }
  if (res.status === 404 || !(res.headers.get('content-type') ?? '').includes('json')) throw new FunnelMissing('no funnel');
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const data = await res.json() as OpeningsFunnel;
  return { data, source: /fixture/i.test(data.snapshot ?? '') ? 'fixture' : 'live', evidence: [] };
}

// ---------------------------------------------------------------- stage vocabulary

/** Stages that are O1's decisions about companies; the rest are filters over people. */
export const DECISION_STAGES = new Set(['open', 'provisional', 'held', 'watch']);

const SHORT: Record<string, [one: string, many: string]> = {
  profiles: ['job move read', 'job moves read'],
  departures: ['left a tracked engineering role', 'left a tracked engineering role'],
  window: ['in or straddling the 90-day window', 'in or straddling the 90-day window'],
  conclusive: ['conclusive, dated', 'conclusive, dated'],
  icp: ['at a company of 20–5,000 staff', 'at a company of 20–5,000 staff'],
  groups: ['group of 2 or more', 'groups of 2 or more'],
  open: ['settled opening', 'settled openings'],
  provisional: ['provisional opening', 'provisional openings'],
  held: ['held by a guard', 'held by a guard'],
  watch: ['on watch: a check can’t be verified', 'on watch: a check can’t be verified'],
};
export const shortLabel = (s: FunnelStage) => (SHORT[s.id] ? SHORT[s.id][s.count === 1 ? 0 : 1] : s.label);

/** How each stage is computed: the O1 clause it applies and where its input comes from. All stages are served by
 *  GET /api/openings/funnel; source names match the engine's source.read endpoints (sourceName below). */
export const STAGE_HOW: Record<string, { clause: string; source: string }> = {
  profiles: { clause: 'Input: every dated job move the scan paged through', source: 'Crustdata person search' },
  departures: { clause: 'O1: a direct move out of a tracked engineering family', source: 'Crustdata person search' },
  window: { clause: 'O1: the move month falls in or straddles the 90-day window', source: 'Crustdata person search (month-level dates)' },
  conclusive: { clause: 'O1: the date is conclusive', source: 'Crustdata person search' },
  icp: { clause: 'O1: the company has 20–5,000 staff', source: 'Crustdata company enrich (headcount)' },
  groups: { clause: 'O1: 2 or more departures from the same company and family', source: 'computed from the rows above' },
  open: { clause: 'O1 decision: every clause met, opening settled', source: 'O1 rule over the groups' },
  provisional: { clause: 'O1 decision: clauses met, a check still open', source: 'O1 rule' },
  held: { clause: 'O1 decision: a guard holds it', source: 'O1 guard (news for acqui-hires)' },
  watch: { clause: 'O1 decision: a check can’t be verified yet', source: 'O1 rule' },
};

/** Why a person row present in the previous stage is absent from this one: the stage's own rule clause. */
const DROP_REASON: Record<string, string> = {
  departures: 'not a direct move out of a tracked family',
  window: 'month outside the 90-day window',
  icp: 'company size outside 20–5,000, or unknown',
  groups: 'only 1 departure in this company and family',
};
/** Why a person row passed: the same clause, met. */
const KEEP_REASON: Record<string, string> = {
  departures: 'direct move out of a tracked family',
  window: 'month inside the 90-day window',
  icp: 'company has 20–5,000 staff',
  groups: '2+ departures, same company and family',
};

/** "22 Nov 2026 14:08 IST (month-interval …), before …" -> "22 Nov 2026, 14:08 IST" */
export function lockedShort(lockedAt: string): string {
  const head = lockedAt.split(' (')[0].split(',')[0].trim();
  return head.replace(/^(\d{1,2} \w{3} \d{4}) (\d{1,2}:\d{2})/, '$1, $2');
}

// ---------------------------------------------------------------- rows

export type Decision = 'kept' | 'provisional' | 'discarded' | 'held' | 'inconclusive';

export interface LogRow {
  key: string;
  source: string;        // "person/search", "job/search", "news", "O1 rule"
  title: string;
  date: string;          // "Oct 2026" stays a month
  monthLevel: boolean;
  domain: string | null;
  decision: Decision;
  why: string[];         // one reason, or a decision's clauses one per line
  evidenceId?: string;
  /** a departure listed under the company decision it fed */
  sub?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_RE = new RegExp(`\\b(${MONTHS.join('|')}) (\\d{4})\\b`);

type DomainOf = (company: string) => string | null;

/** "P. ML Platform Engineer · Abacus.AI · left Oct 2026 → Arcfront (Oct 2026)" */
function personRow(r: FunnelRow, key: string, decision: Decision, why: string[], domainOf: DomainOf): LogRow {
  const parts = r.label.split(' · ');
  const leftIdx = parts.findIndex((p) => /^left /.test(p));
  if (leftIdx < 2) {
    return { key, source: 'person/search', title: r.label, date: r.label.match(MONTH_RE)?.[0] ?? 'undated', monthLevel: true, domain: null, decision, why, evidenceId: r.evidenceId };
  }
  const who = parts[0];
  const company = parts.slice(1, leftIdx).join(' · ');
  const left = parts.slice(leftIdx).join(' · ');
  const initial = who.match(/^(\S+\.)\s+(.*)$/);
  const person = initial ? `${initial[1]}, ${initial[2]}` : who;
  const dest = left.match(/→\s*(.*?)(\s*\((\w{3} \d{4})\))?$/)?.[1] ?? null;
  const date = left.match(MONTH_RE)?.[0] ?? 'undated';
  return {
    key, source: 'person/search', title: `${person} at ${company}${dest ? ` → ${dest}` : ''}`, date, monthLevel: true,
    domain: safeDomain(company, domainOf), decision, why, evidenceId: r.evidenceId,
  };
}

/** "Abacus.AI · ml platform" with its clauses, or "Poolside · inference" with its guard reasons. */
function companyRow(r: FunnelRow, key: string, stage: FunnelStage, domainOf: DomainOf): LogRow {
  const [company, family] = r.label.split(' · ');
  const detail = r.detail ?? '';
  const why = stage.id === 'held' ? detail.split(/;\s+/) : detail.split(/\s+·\s+/);
  const decision: Decision = stage.id === 'held' ? 'held' : stage.id === 'watch' ? 'inconclusive' : stage.id === 'provisional' ? 'provisional' : 'kept';
  const closes = detail.match(/closes by (\d{1,2} \w{3} \d{4})/)?.[1];
  const date = detail.match(/\((\d{1,2} \w{3} \d{4})\)/)?.[1] ?? (closes ? `closes ${closes}` : '');
  const cited = detail.match(/\(([a-z0-9-]+\.[a-z.]+)\)/i)?.[1] ?? null;
  return {
    key, source: stage.id === 'held' && /acqui-hire/i.test(detail) ? 'O1 rule, news' : 'O1 rule',
    title: family ? `${company}, ${family}` : r.label, date: date || '–', monthLevel: false,
    domain: domainOf(company) ?? cited, decision, why: why.filter(Boolean), evidenceId: r.evidenceId,
  };
}

const idOf = (r: FunnelRow) => r.evidenceId ?? r.label;

/** Placeholder employers aren't companies: never attach a company record's domain to them. */
const NOT_A_COMPANY = /^(freelance|self[- ]?employed|stealth|independent|confidential|consultant|various)\b/i;
export const safeDomain = (company: string, domainOf: DomainOf) => (NOT_A_COMPANY.test(company.trim()) ? null : domainOf(company));

function personDecision(r: FunnelRow, kept: boolean, stageId: string): [Decision, string[]] {
  if (!kept) return ['discarded', [DROP_REASON[stageId] ?? 'did not pass this step']];
  const d = r.detail?.replace(/^not conclusive:\s*/i, '');
  if (r.detail && /^not conclusive/i.test(r.detail)) return ['inconclusive', [d ?? r.detail]];
  return ['kept', [r.detail || KEEP_REASON[stageId] || 'passed this step']];
}

export interface StageView {
  rows: LogRow[];
  /** people the stage dropped that the scan doesn't itemise (the previous stage has a count but no rows) */
  unlisted: number;
}

/**
 * One stage's records. A filter stage lists the previous itemised stage's rows in order, each marked kept or
 * discarded with this stage's rule clause, so a discard sits beside the kept rows with the same weight.
 */
export function stageRows(stages: FunnelStage[], idx: number, domainOf: DomainOf): StageView {
  const s = stages[idx];
  const rows = s.rows ?? [];
  if (DECISION_STAGES.has(s.id)) {
    // Each company decision opens the departures behind it (from the "2 or more" groups stage).
    const groups = stages.find((x) => x.id === 'groups')?.rows ?? [];
    const out: LogRow[] = [];
    rows.forEach((r, i) => {
      out.push(companyRow(r, `${s.id}:${i}`, s, domainOf));
      const company = r.label.split(' · ')[0];
      groups.filter((g) => g.label.includes(` · ${company} · `)).forEach((g, j) => {
        out.push({ ...personRow(g, `${s.id}:${i}:${idOf(g)}:${j}`, ...personDecision(g, true, 'groups'), domainOf), sub: true });
      });
    });
    return { rows: out, unlisted: 0 };
  }
  const prev = idx > 0 ? stages[idx - 1] : null;
  if (!prev || DECISION_STAGES.has(prev.id) || !prev.rows?.length) {
    const unlisted = prev && !DECISION_STAGES.has(prev.id) ? Math.max(0, prev.count - s.count) : 0;
    return { rows: rows.map((r, i) => personRow(r, `${s.id}:${idOf(r)}:${i}`, ...personDecision(r, true, s.id), domainOf)), unlisted };
  }
  const here = new Set(rows.map(idOf));
  const seen = new Set<string>();
  const out: LogRow[] = [];
  prev.rows.forEach((r, i) => {
    const id = idOf(r);
    seen.add(id);
    const mine = here.has(id) ? rows.find((x) => idOf(x) === id) ?? r : r;
    out.push(personRow(mine, `${s.id}:${id}:${i}`, ...personDecision(mine, here.has(id), s.id), domainOf));
  });
  rows.forEach((r, i) => { if (!seen.has(idOf(r))) out.push(personRow(r, `${s.id}:${idOf(r)}:x${i}`, ...personDecision(r, true, s.id), domainOf)); });
  // Survivors first (kept, then not conclusive), then this step's discards, each in the scan's order.
  const rank: Record<Decision, number> = { kept: 0, provisional: 0, inconclusive: 1, held: 1, discarded: 2 };
  return { rows: out.map((r, i) => [r, i] as const).sort((a, b) => rank[a[0].decision] - rank[b[0].decision] || a[1] - b[1]).map(([r]) => r), unlisted: 0 };
}

// ---------------------------------------------------------------- the run's own reads

const SOURCE_NAME: Record<string, string> = {
  person_departures: 'person/search', person_replacements: 'person/search', person_recent_moves: 'person/search', person_search: 'person/search',
  job_replacements: 'job/search', job_search: 'job/search', company_headcount: 'company/enrich', company_enrich: 'company/enrich',
  company_growth: 'company/enrich', news_acquihire_search: 'news', news_acquihire_resolve: 'web/search', news_acquihire_fetch: 'web/fetch',
  web_search: 'web/search', company_posts: 'company/posts',
};
export const sourceName = (endpoint: string) => SOURCE_NAME[endpoint.replace(/^\//, '').replace(/\//g, '_')] ?? endpoint.replace(/^\//, '').replace(/_/, '/');

/** A source.read item as a decision row. The engine's "Kept: … / Discarded: …" signal decides; else `matched`. */
export function readRow(c: SourceCard): LogRow {
  const sig = (c.signal ?? '').trim();
  const m = sig.match(/^(kept|discarded|held)\s*:\s*(.*)$/i);
  const decision: Decision = m ? (m[1].toLowerCase() as Decision) : c.matched ? 'kept' : 'discarded';
  const why = m ? m[2] : sig || (c.matched ? 'fed a rule check' : 'not used by any rule');
  const monthLevel = /^[A-Z][a-z]{2} \d{4}$/.test(c.dateLabel);
  return {
    key: c.key, source: sourceName(c.endpoint), title: compactMove(c.title),
    date: c.date ? (monthLevel ? c.dateLabel : withYear(c.date)) : 'undated', monthLevel,
    domain: c.domain, decision, why: [why.charAt(0).toLowerCase() + why.slice(1)],
  };
}

/** "R. left a Founder role at LiquidRick in Oct 2026 and started at Stealth in Oct 2026 (month precision)." ->
 *  "R., Founder at LiquidRick → Stealth", the same shape the funnel rows use. Anything else passes through. */
const MOVE_RE = /^(\S+\.) left an? (.+) role at (.+?) in \w{3} \d{4} and started at (.+?) in \w{3} \d{4}(?: \(month precision\))?\.?$/;
export function compactMove(title: string): string {
  const m = title.trim().match(MOVE_RE);
  return m ? `${m[1]}, ${m[2]} at ${m[3]} → ${m[4]}` : title.replace(/\s*\(month precision\)\.?$/, '');
}

function withYear(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}

export function tally(rows: LogRow[]): Record<Decision | 'all', number> {
  const t = { all: rows.length, kept: 0, provisional: 0, discarded: 0, held: 0, inconclusive: 0 };
  for (const r of rows) t[r.decision]++;
  return t;
}
