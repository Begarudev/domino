// People-data redaction at every boundary where data leaves the server (journal events, run snapshots, desk and
// dossier responses, logs). Full names stay only in step outputs and the local tool cache, where the engine needs
// them for entity resolution; everything emitted shows a person as an initial ("P.") next to their role.
import type { DatabaseSync } from 'node:sqlite';

const PROFILE_URL = /\b((?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/)[^\s"'?#)]+/gi;
const personEndpoints = ['/person/search', '/person/enrich', '/person/identify'];

export const initialOf = (name: string) => {
  const first = name.trim().match(/\p{L}/u)?.[0];
  return first ? `${first.toUpperCase()}.` : '';
};

// Collect every full person name in the local cache (the raw Crustdata person responses).
export function cachedPersonNames(sql: DatabaseSync): string[] {
  const rows = sql.prepare(`SELECT response_json FROM tool_cache WHERE endpoint IN (${personEndpoints.map(() => '?').join(',')})`)
    .all(...personEndpoints) as { response_json: string }[];
  const names = new Set<string>();
  // Only a profile's own name (basic_profile.name): employment entries also carry `name`, and those are companies.
  const visit = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const own = key === 'basic_profile' ? record.name : undefined;
    if (typeof own === 'string' && /^\p{Lu}[\p{L}'’.-]+(?:\s+[\p{L}'’.-]+){1,4}$/u.test(own.trim())) names.add(own.trim());
    for (const [k, v] of Object.entries(record)) visit(v, k);
  };
  for (const row of rows) {
    try { visit(JSON.parse(row.response_json)); } catch { /* unreadable cache row: skip */ }
  }
  return [...names];
}

// Person and Decider records: a name next to a title and a person/company link. An employment entry
// ({ name, companyId, title, from, to } in Person.pastEmployers) has the same keys, but its name is the employer's.
const isEmployment = (record: Record<string, unknown>) => ('from' in record || 'to' in record)
  && !('personId' in record || 'linkedinUrl' in record || 'startedAt' in record);
const isPerson = (record: Record<string, unknown>) => typeof record.name === 'string' && typeof record.title === 'string' &&
  ('personId' in record || 'companyId' in record || 'linkedinUrl' in record || 'startedAt' in record) && !isEmployment(record);

function personNames(input: unknown): string[] {
  const found: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) collect(item); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (isPerson(record)) found.push(record.name as string);
    for (const item of Object.values(record)) collect(item);
  };
  collect(input);
  return found;
}

// "Asha K." (first name + last initial with its full stop: the candidate's consented display name) is already minimal.
// "Asha Rao K." is not, and neither is "Kiran Q". A source profile already shortened to "Kiran Q." is a third party, so
// names from the profile cache are reduced to an initial whatever their form (see `cachedFullNames`).
const isFullName = (name: string) => name.trim().split(/\s+/).length >= 2 && !/^\S+\s+\p{L}\.$/u.test(name.trim());
const hasSurname = (name: string) => name.trim().split(/\s+/).length >= 2;

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A known person's first name is masked only right after a greeting ("Hi Dipak," → "Hi D.,"): on its own a first name
// is too often an ordinary word or part of a company name to replace everywhere.
const GREETING = String.raw`\b(?:Hi|Hello|Hey|Dear)[ \t]+`;
const firstNameOf = (name: string) => name.trim().split(/\s+/)[0];

export class PeopleRedactor {
  private pattern: RegExp | null = null;
  private greeting: RegExp | null = null;
  private names = new Set<string>();
  private count = -1;
  private sql: DatabaseSync;
  private extra: () => string[];
  constructor(sql: DatabaseSync, extra: () => string[] = () => []) {
    this.sql = sql;
    this.extra = extra;
  }

  private refresh() {
    const count = (this.sql.prepare('SELECT count(*) AS n FROM tool_cache').get() as { n: number }).n;
    if (count === this.count && this.pattern) return;
    this.count = count;
    this.names = new Set([...cachedPersonNames(this.sql).filter(hasSurname), ...[...this.extra(), ...this.names].filter(isFullName)]);
    this.rebuild();
  }

  private rebuild() {
    const sorted = [...this.names].sort((a, b) => b.length - a.length).map(escape);
    this.pattern = sorted.length ? new RegExp(`(?<![\\p{L}])(?:${sorted.join('|')})(?![\\p{L}])`, 'gu') : null;
    const firsts = [...new Set([...this.names].map(firstNameOf).filter(first => /^\p{Lu}\p{L}+$/u.test(first)))]
      .sort((a, b) => b.length - a.length).map(escape);
    this.greeting = firsts.length ? new RegExp(`(?<=${GREETING})(?:${firsts.join('|')})(?![\\p{L}])`, 'gu') : null;
  }

  text(value: string): string {
    this.refresh();
    return this.redact(value);
  }

  private redact(value: string): string {
    let out = value.replace(PROFILE_URL, '$1[redacted]');
    if (this.pattern) out = out.replace(this.pattern, name => initialOf(name));
    if (this.greeting) out = out.replace(this.greeting, name => initialOf(name));
    return out;
  }

  private learn(names: Iterable<string>) {
    let added = false;
    for (const name of names) if (isFullName(name) && !this.names.has(name.trim())) { this.names.add(name.trim()); added = true; }
    if (added) this.rebuild();
  }

  // Learn the people in a step output (kept server-side) so later events that mention them are redacted.
  observe(input: unknown): void {
    this.refresh();
    this.learn(personNames(input));
  }

  // Deep copy with every string redacted; `name` fields of person-shaped objects become initials.
  value<T>(input: T): T {
    this.observe(input);
    const walk = (value: unknown, parentKey = ''): unknown => {
      if (typeof value === 'string') return this.redact(value);
      if (Array.isArray(value)) return value.map(item => walk(item, parentKey));
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const personLike = isPerson(record);
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(record)) {
          if (personLike && key === 'name' && typeof item === 'string' && (isFullName(item) || this.names.has(item.trim()))) out[key] = initialOf(item);
          else if (key === 'linkedinUrl' && typeof item === 'string' && /linkedin\.com\/in\//i.test(item)) out[key] = null;
          else out[key] = walk(item, key);
        }
        return out;
      }
      return value;
    };
    return walk(input) as T;
  }
}
