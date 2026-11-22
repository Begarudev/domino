import { containsPhrase, isoDay, normalizeDomain, normalizeName, shiftDays } from '../domain/facts.ts';
import type { Filter } from './common.ts';
import { companyRow, firms, jobs, profiles, TODAY } from './fixtures/world.ts';
import { newsFetchFixture, newsSearchFixture } from './fixtures/news.ts';

type Request = { filters?: Filter; limit?: number; crustdata_company_ids?: number[]; domains?: string[]; names?: string[] };

function indexedValues(value: unknown, path: string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap(item => indexedValues(item, path));
  if (!path.length) return [value];
  if (!value || typeof value !== 'object') return [];
  return indexedValues((value as Record<string, unknown>)[path[0]], path.slice(1));
}

function applyFilter(row: unknown, filter?: Filter): boolean {
  if (!filter) return true;
  if ('op' in filter) return filter.op === 'and' ? filter.conditions.every(child => applyFilter(row, child))
    : filter.conditions.some(child => applyFilter(row, child));

  const { field, value } = filter;
  const aliases = field.replace(/\.company_id$/, '.crustdata_company_id').replace(/\.company_name$/, '.name')
    .replace(/\.company_website_domain$/, '.company_website');
  const path = aliases === 'basic_info.industries' ? 'taxonomy.professional_network_industries' : aliases;
  return indexedValues(row, path.split('.')).some(actual => {
    if (field.endsWith('.company_website_domain') && typeof actual === 'string') actual = normalizeDomain(actual);
    if (actual == null) return false;
    switch (filter.type) {
      case '=': return typeof actual === 'string' && typeof value === 'string' ? normalizeName(actual) === normalizeName(value) : actual === value;
      case '[.]': return typeof actual === 'string' && typeof value === 'string' && containsPhrase(actual, value);
      case 'in': return Array.isArray(value) && value.some(v => typeof actual === 'string' && typeof v === 'string'
        ? actual.toLowerCase() === v.toLowerCase() : v === actual);
      case '<':
      case '=<':
      case '=>':
      case '>': {
        const left = typeof actual === 'string' ? isoDay(actual) ?? actual : actual;
        const comparable = (typeof left === 'number' && typeof value === 'number') ||
          (typeof left === 'string' && typeof value === 'string');
        if (!comparable) return false;
        const comparison = typeof left === 'number' ? left - Number(value) : String(left).localeCompare(String(value));
        return filter.type === '<' ? comparison < 0 : filter.type === '=<' ? comparison <= 0 :
          filter.type === '=>' ? comparison >= 0 : comparison > 0;
      }
      default: return false;
    }
  });
}

function filterLeaves(filter?: Filter): Exclude<Filter, { op: string }>[] {
  if (!filter) return [];
  return 'op' in filter ? filter.conditions.flatMap(filterLeaves) : [filter];
}

function companyCutoff(body: Request) {
  const bound = filterLeaves(body.filters).find(leaf => leaf.field === 'metadata.growth_calculation_date' && leaf.type === '<');
  const nextDay = typeof bound?.value === 'string' ? isoDay(bound.value) : null;
  return nextDay ? shiftDays(nextDay, -1) : TODAY;
}

export function fixtureFor(name: string, body: unknown): unknown {
  const request: Request = body && typeof body === 'object' ? body as Request : {};
  const limit = request.limit ?? 100;
  const leaves = filterLeaves(request.filters);
  const outcomePeople = leaves.some(leaf => leaf.field.startsWith('experience.employment_details.'));
  switch (name) {
    case 'news_search':
    case '/web/search/live':
      return newsSearchFixture(body as Parameters<typeof newsSearchFixture>[0]);
    case 'news_fetch':
    case '/web/enrich/live':
      return newsFetchFixture(body as Parameters<typeof newsFetchFixture>[0]);
    case 'company_posts':
    case '/social_post/search':
      return { posts: [], total_count: 0, next_cursor: null };
    case 'outcome_check':
      return fixtureFor(outcomePeople ? '/person/search' : '/job/search', body);
    case 'job_search':
    case '/job/search': {
      const rows = jobs.filter(row => applyFilter(row, request.filters)).sort((a, b) => b.metadata.date_added.localeCompare(a.metadata.date_added));
      return { job_listings: rows.slice(0, limit), next_cursor: null, total_count: rows.length };
    }
    case 'person_recent_moves':
    case 'person_cohort_departures':
    case 'person_deciders':
    case '/person/search': {
      const rows = profiles.filter(row => applyFilter(row, request.filters));
      return { profiles: rows.slice(0, limit), next_cursor: null, total_count: rows.length, remarks: [] };
    }
    case 'company_growth':
    case 'company_cohort':
    case '/company/search': {
      const asOf = companyCutoff(request);
      const rows = firms.map(firm => companyRow(firm, asOf, false)).filter(row => applyFilter(row, request.filters));
      return { companies: rows.slice(0, limit), next_cursor: null, total_count: rows.length };
    }
    case 'company_enrich':
    case '/company/enrich': {
      const matchType = request.crustdata_company_ids ? 'crustdata_company_id' : request.domains ? 'domain' : 'name';
      const values = request.crustdata_company_ids ?? request.domains ?? request.names ?? [];
      return values.map(value => ({
        matched_on: String(value), match_type: matchType,
        matches: firms.filter(firm => matchType === 'crustdata_company_id' ? firm.id === value
          : matchType === 'domain' ? firm.domain === normalizeDomain(String(value))
            : [firm.name, firm.legalName].some(name => name && normalizeName(name) === normalizeName(String(value))))
          .map(firm => ({ company_data: companyRow(firm, TODAY, true), confidence_score: 1 })),
      }));
    }
    default:
      throw new RangeError('Unknown Crustdata fixture: ' + name);
  }
}
