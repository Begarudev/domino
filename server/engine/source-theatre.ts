import { ALL_STEPS } from '../../shared/types.ts';
import type { Evidence, Intent, SourceItem, SourceReadEvent, StepName } from '../../shared/types.ts';
import type { MoveTrigger, ParseMeta, TriggerBatch } from '../domain/types.ts';
import type { CrustReadMeta } from '../runtime/tool.ts';

type SourceTime = Pick<ParseMeta, 'asOf' | 'windowDays'>;
const dateShift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const formatDate = (date: string) => dateFormat.format(new Date(date));

function publicUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return value;
  } catch {
    // A source without a valid public URL still has a readable title.
  }
  return null;
}

function requestRange(request: unknown, time: SourceTime) {
  const starts: string[] = [];
  const ends: string[] = [];
  function inspect(filter: unknown) {
    if (!filter || typeof filter !== 'object') return;
    if (Array.isArray(filter)) {
      for (const child of filter) inspect(child);
      return;
    }
    const { field, type, value, conditions } = filter as Record<string, unknown>;
    if (typeof field === 'string' && /date/i.test(field) && typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))) {
      if (type === '=>' || type === '>') starts.push(type === '>' ? dateShift(value, 1) : value);
      if (type === '=<' || type === '<') ends.push(type === '<' ? dateShift(value, -1) : value);
    }
    inspect(conditions);
  }
  if (request && typeof request === 'object' && 'filters' in request) inspect(request.filters);
  const first = starts.sort()[0] ?? dateShift(time.asOf, 1 - time.windowDays);
  const last = ends.sort().at(-1) ?? time.asOf;
  return first < last ? `${formatDate(first)}–${formatDate(last)}` : formatDate(last);
}

function querySummary(endpoint: string, path: string, request: unknown, input: unknown, time: SourceTime) {
  const query = input as { intent?: Intent; company?: { name: string }; companies?: { name: string }[] };
  const terms = query.intent?.signalKeywords.slice(0, 2).join('/') || 'Serving and infrastructure';
  const market = query.intent?.geography ? ` in ${query.intent.geography}` : '';
  const range = () => requestRange(request, time);
  switch (endpoint) {
    case 'news_search': return 'Reading news — Crustdata Web Search (news)';
    case 'news_fetch': return 'Reading articles — Crustdata Web Fetch (publication dates)';
    case 'news_acquihire_search': return 'Checking acqui-hire guard — Crustdata News Search';
    case 'news_acquihire_resolve': return 'Finding publisher URL — Crustdata Web Search';
    case 'news_acquihire_fetch': return 'Verifying acqui-hire report — Crustdata Web Fetch';
    case 'job_search': return `${terms} job posts${market}, ${range()}`;
    case 'person_recent_moves': return `${terms} hiring and employer moves${market}, ${range()}`;
    case 'company_growth': return `Company growth and funding${market}, ${range()}`;
    case 'company_enrich': {
      const companies = query.companies ?? [];
      const names = companies.slice(0, 3).map(company => company.name).join(', ');
      const others = companies.length - 3;
      return `Company profiles${names ? ' for ' + names : ''}${others > 0 ? ` and ${others} more` : ''}`;
    }
    case 'person_deciders': return `Decision-maker roles at ${query.company?.name ?? 'the target company'}`;
    case 'person_departures': return `Talent drain: people who left inference, ML platform, MLOps or GPU/LLM infrastructure roles, ${range()}`;
    case 'job_replacements': return `Replacement check: ${(input as { checks?: unknown[] }).checks?.length ?? 0} company job searches for the same role family`;
    case 'person_replacements': return `Replacement check: hires into the same role family`;
    case 'company_headcount': return `Company size and 90-day headcount change`;
    case 'outcome_check': return `Replay ${path === '/job/search' ? 'job posts' : 'hires'}, ${range()}`;
    default: return `${endpoint.replaceAll('_', ' ')}, ${range()}`;
  }
}

function eventStep(step: string, endpoint: string): StepName {
  const normal = ALL_STEPS.find(name => name === step);
  if (normal) return normal;
  if (endpoint === 'company_enrich') return 'enrich_companies';
  if (endpoint === 'person_deciders') return 'find_deciders';
  if (endpoint === 'outcome_check') return 'score_replay';
  if (endpoint === 'person_departures') return 'pull_departures';
  if (endpoint === 'job_replacements' || endpoint === 'person_replacements') return 'check_replacements';
  return 'pull_triggers';
}

function timing(row?: Evidence, date?: string | null, month?: boolean): Pick<SourceItem, 'date' | 'precision'> {
  const observed = date ?? row?.observedAt ?? null;
  if (!observed) return { date: null, precision: null };
  const monthly = month || /month.precision/i.test(row?.claim ?? '');
  return { date: monthly ? observed.slice(0, 7) + '-01' : observed, precision: monthly ? 'month' : 'day' };
}

export function describeRead(
  observation: CrustReadMeta, step: string, endpoint: string, path: string, input: unknown, time: SourceTime,
  batch: TriggerBatch, matchedIds: Set<string>,
): SourceReadEvent {
  const evidence = new Map(batch.evidence.map(row => [row.id, row]));
  const companies = new Map(batch.mentions.map(row => [row.key, row]));
  const rowsFor = (ids: string[]) => ids.flatMap(id => { const row = evidence.get(id); return row ? [row] : []; });
  const matched = (ids: string[]) => ids.some(id => matchedIds.has(id));
  const items: SourceItem[] = [];

  if (endpoint.startsWith('news_')) {
    for (const row of batch.evidence) {
      const company = batch.mentions.find(mention => mention.evidenceIds.includes(row.id));
      items.push({ kind: 'news', title: typeof row.value === 'string' ? row.value : row.claim,
        company: company?.name ?? null, url: publicUrl(row.source.url), ...timing(row),
        signal: row.observedAt ? 'Publication date verified' : 'Undated search lead', matched: matched([row.id]) });
    }
  } else if (endpoint === 'person_deciders') {
    const company = (input as { company?: { name: string } }).company?.name ?? null;
    for (const person of batch.people) {
      const row = rowsFor(person.evidenceIds).find(row => /\.title$|decider/.test(row.source.field ?? ''));
      items.push({
        kind: 'decider', title: person.title, company, url: publicUrl(row?.source.url),
        ...timing(row, person.startedAt), signal: matched(person.evidenceIds) ? 'Selected decision-maker role' : null,
        matched: matched(person.evidenceIds),
      });
    }
  } else if (['person_departures', 'person_replacements', 'job_replacements', 'company_headcount'].includes(endpoint)) {
    const kind = endpoint === 'job_replacements' ? 'job_post' : endpoint === 'company_headcount' ? 'headcount' : 'person_move';
    const signal = endpoint === 'person_departures' ? 'Left an infra/serving role' : endpoint === 'company_headcount'
      ? 'Size and 90-day change' : 'Possible replacement';
    for (const row of batch.evidence) {
      items.push({ kind, title: row.claim, company: null, url: publicUrl(row.source.url), ...timing(row), signal, matched: matched([row.id]) });
    }
  } else if (path === '/person/search') {
    const hires: MoveTrigger[] = batch.triggers.filter(trigger => trigger.kind === 'hire');
    const covered = new Set<string>();
    for (const hire of hires) {
      const next = companies.get(hire.companyId)?.name;
      const previous = companies.get(hire.relatedCompanyId ?? '')?.name;
      const rows = rowsFor(hire.evidenceIds);
      const row = rows.find(row => /start_date/.test(row.source.field ?? '')) ?? rows[0];
      for (const record of rows) covered.add(record.source.recordId ?? record.id);
      items.push({
        kind: 'person_move', title: previous && next ? `Infra engineer moved ${previous} → ${next}`
          : next ? `Infrastructure hire at ${next}` : 'Infrastructure hire',
        company: next ?? null, url: null, ...timing(row, hire.date, hire.move?.datePrecision === 'month'),
        signal: previous ? 'Employer change' : 'Infrastructure hire', matched: matched(hire.evidenceIds),
      });
    }
    for (const person of batch.people) {
      const row = rowsFor(person.evidenceIds).find(row => /start_date/.test(row.source.field ?? ''));
      if (!row || covered.has(row.source.recordId ?? row.id)) continue;
      covered.add(row.source.recordId ?? row.id);
      const company = companies.get(person.companyKey ?? '')?.name ?? null;
      items.push({ kind: 'person_move', title: company ? `Infrastructure role at ${company}` : 'Infrastructure role',
        company, url: null, ...timing(row, person.startedAt), signal: null, matched: false });
    }
  } else if (path === '/job/search') {
    for (const row of batch.evidence) {
      if (row.source.provider === 'seller_profile') {
        items.push({ kind: 'news', title: row.claim, company: null, url: publicUrl(row.source.url), ...timing(row),
          signal: matched([row.id]) ? 'Provider change' : null, matched: matched([row.id]) });
        continue;
      }
      if (!/job_details\.title/.test(row.source.field ?? '')) continue;
      const related = batch.evidence.filter(item => item.source.recordId === row.source.recordId &&
        item.source.provider === row.source.provider);
      const ids = related.map(item => item.id);
      const trigger = batch.triggers.find(trigger => trigger.evidenceIds.some(id => ids.includes(id)));
      const company = (trigger && companies.get(trigger.companyId)) ??
        batch.mentions.find(company => company.evidenceIds.includes(row.id));
      items.push({ kind: 'job_post', title: typeof row.value === 'string' ? row.value : row.claim,
        company: company?.name ?? null, url: publicUrl(row.source.url), ...timing(row),
        signal: trigger?.kind === 'post' ? trigger.summary : trigger ? 'Relevant job posting' : null, matched: matched(ids) });
    }
  } else {
    for (const company of batch.mentions) {
      const triggers = batch.triggers.filter(trigger => trigger.companyId === company.key);
      const companyRows = rowsFor(company.evidenceIds);
      const signals = triggers.length ? triggers : [undefined];
      for (const trigger of signals) {
        const row = trigger ? rowsFor(trigger.evidenceIds).find(row => row.observedAt === trigger.date)
          : companyRows.find(row => row.observedAt) ?? companyRows[0];
        items.push({
          kind: trigger?.kind === 'funding' ? 'funding' : trigger?.kind === 'headcount_jump' ? 'headcount' : 'company',
          title: company.name, company: company.name, url: publicUrl(row?.source.url),
          ...timing(row, trigger?.date), signal: trigger?.summary ?? row?.claim ?? null,
          matched: matched(trigger?.evidenceIds ?? company.evidenceIds),
        });
      }
    }
  }

  return {
    type: 'source.read', callId: observation.callId, step: eventStep(step, endpoint), endpoint, mode: observation.mode,
    query: querySummary(endpoint, path, observation.request, input, time) + (batch.readSummary ? ` — ${batch.readSummary}` : ''),
    totalAvailable: observation.totalAvailable,
    items: items.slice(0, 12),
  };
}
