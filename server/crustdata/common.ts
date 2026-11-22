import { z } from 'zod';
import type { Evidence, IsoDate } from '../../shared/types.ts';
import { containsPhrase, companyNameKey, normalizeDomain, shiftDays, stableId } from '../domain/facts.ts';
import { NonsenseError } from '../domain/types.ts';
import type { CompanyMention, ParseMeta, TriggerBatch } from '../domain/types.ts';

export interface CompanyInput {
  name: string;
  domain?: string | null;
  crustdataId?: number | string | null;
}

export const str = z.string().nullish();
export const num = z.number().nullish();
export const int = z.number().int().nullish();
export const strs = z.array(z.string()).nullish();

export function validate<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new NonsenseError(`${issue.path.join('.') || 'response'}: ${issue.message}`);
}

export function publicUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

export function evidenceRow(meta: ParseMeta, recordId: string, field: string, claim: string,
  observedAt: IsoDate | null, value?: Evidence['value'], url?: string | null): Evidence {
  return {
    id: stableId('ev_', meta.endpoint, recordId, field),
    claim,
    value,
    source: { provider: 'crustdata', endpoint: meta.endpoint, recordId, field, url: publicUrl(url) },
    observedAt,
    retrievedAt: meta.retrievedAt,
    mode: meta.mode,
    verifiable: observedAt !== null,
  };
}

export function emptyBatch(): TriggerBatch {
  return { mentions: [], people: [], triggers: [], evidence: [] };
}

export type Filter = { field: string; type: string; value: string | number | boolean | string[] | number[] } |
  { op: 'and' | 'or'; conditions: Filter[] };

export function condition(field: string, type: string, value: string | number | boolean | string[] | number[]): Filter {
  return { field, type, value };
}

export function group(op: 'and' | 'or', conditions: Filter[]): Filter {
  return conditions.length === 1 ? conditions[0] : { op, conditions };
}

export function dates(field: string, after: IsoDate, through: IsoDate): Filter[] {
  // Crustdata treats a date-only value as UTC midnight, including for datetime fields.
  return [condition(field, '=>', shiftDays(after, 1)), condition(field, '<', shiftDays(through, 1))];
}

const europe = ['Albania', 'Andorra', 'Austria', 'Belarus', 'Belgium', 'Bosnia and Herzegovina', 'Bulgaria',
  'Croatia', 'Cyprus', 'Czechia', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary',
  'Iceland', 'Ireland', 'Italy', 'Kosovo', 'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malta', 'Moldova',
  'Monaco', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Russia',
  'San Marino', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Türkiye', 'Ukraine',
  'United Kingdom', 'Vatican City'];

// Model or user wording like "Worldwide", "global", "anywhere" means no geography filter at all.
const NO_GEOGRAPHY = /^(world ?wide|global(ly)?|anywhere|any|all|international|everywhere|remote|n\/?a|none)$/i;
const US_ALIASES = /^(us|usa|u\.s\.a?\.?|united states( of america)?|america)$/i;
const INDIA_ALIASES = /^(india|in|bharat)$/i;

export function normalizeGeography(geography: string | null | undefined): string | null {
  const value = geography?.trim();
  if (!value || NO_GEOGRAPHY.test(value)) return null;
  if (US_ALIASES.test(value)) return 'US';
  if (INDIA_ALIASES.test(value)) return 'India';
  if (/^europe(an union)?$|^eu$/i.test(value)) return 'Europe';
  return value;
}

export function geographyFilter(field: string, raw: string | null): Filter[] {
  const geography = normalizeGeography(raw);
  if (!geography) return [];
  return [geography === 'Europe' ? condition(field, 'in', europe) :
    condition(field, '=', geography === 'US' ? 'United States' : geography)];
}

export function matchesGeography(country: string | null | undefined, raw: string | null): boolean {
  const geography = normalizeGeography(raw);
  if (!country || !geography) return true;
  const normalized = ({ IND: 'India', USA: 'United States', US: 'United States', GBR: 'United Kingdom' } as Record<string, string>)[country] ?? country;
  const filter = geographyFilter('country', geography)[0];
  if (!('field' in filter)) return false;
  return Array.isArray(filter.value) ? filter.value.some(value => typeof value === 'string' && containsPhrase(normalized, value)) :
    normalized.toLowerCase() === String(filter.value).toLowerCase();
}

export function companyNumber(value: CompanyInput['crustdataId']): number | null {
  const id = typeof value === 'number' ? value : /^\d+$/.test(value ?? '') ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function companyFilter(companies: CompanyInput[], paths: { id: string; domain: string; name: string }): Filter {
  const ids: number[] = [];
  const domains: string[] = [];
  const names: string[] = [];
  for (const company of companies) {
    const id = companyNumber(company.crustdataId);
    const domain = normalizeDomain(company.domain);
    if (id !== null) ids.push(id);
    else if (domain) domains.push(domain);
    else if (company.name.trim()) names.push(company.name.trim());
  }
  const filters = [
    ...(ids.length ? [condition(paths.id, 'in', [...new Set(ids)])] : []),
    ...(domains.length ? [condition(paths.domain, 'in', [...new Set(domains)])] : []),
    ...(names.length ? [condition(paths.name, 'in', [...new Set(names)])] : []),
  ];
  return group('or', filters.length ? filters : [condition(paths.id, '=', -1)]);
}

export function sameCompany(a: CompanyInput, b: CompanyInput): boolean {
  if (a.crustdataId != null && b.crustdataId != null) return String(a.crustdataId) === String(b.crustdataId);
  const domainA = normalizeDomain(a.domain);
  const domainB = normalizeDomain(b.domain);
  if (domainA && domainB) return domainA === domainB;
  return Boolean(a.name && b.name && companyNameKey(a.name) === companyNameKey(b.name));
}

export function mentionFor(batch: TriggerBatch, key: string): CompanyMention | undefined {
  return batch.mentions.find(company => company.key === key);
}

export function estimate(raw: unknown, arrayKey: string, limit: number, rate: number): number {
  const rows = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[arrayKey] : null;
  return Math.round((Array.isArray(rows) ? rows.length : limit) * rate * 100) / 100;
}
