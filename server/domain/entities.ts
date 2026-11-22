import type { Company, KeptApartDecision, MergeDecision, Person } from '../../shared/types.ts';
import { companyNameKey, normalizeDomain, normalizeLinkedIn, normalizeName, relatedDomains, stableId } from './facts.ts';
import type { CompanyMention, PersonMention, ResolvedCompany } from './types.ts';

class Groups<T extends { key: string }> {
  parents = new Map<string, string>();
  members = new Map<string, T[]>();
  reasons = new Map<string, Set<string>>();

  constructor(items: T[]) {
    for (const item of items) {
      this.parents.set(item.key, item.key);
      const records = this.members.get(item.key) ?? [];
      records.push(item);
      this.members.set(item.key, records);
    }
  }

  root(key: string): string {
    const parent = this.parents.get(key) ?? key;
    if (parent === key) return key;
    const root = this.root(parent);
    this.parents.set(key, root);
    return root;
  }

  join(a: string, b: string, reason: string) {
    const [left, right] = [this.root(a), this.root(b)].sort();
    if (left === right) {
      if (a !== b) this.reasons.get(left)?.add(reason);
      return;
    }
    this.parents.set(right, left);
    this.members.set(left, [...this.members.get(left)!, ...this.members.get(right)!]);
    this.members.delete(right);
    this.reasons.set(left, new Set([...(this.reasons.get(left) ?? []), ...(this.reasons.get(right) ?? []), reason]));
    this.reasons.delete(right);
  }
}

function buckets<T>(items: T[], keyOf: (item: T) => string | null) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

const lexical = (a: string, b: string) => a.localeCompare(b);

export function resolveEntities(mentions: CompanyMention[], people: PersonMention[]): {
  companies: Company[]; people: Person[]; merges: MergeDecision[]; keptApart: KeptApartDecision[]; idMap: Record<string, string>;
} {
  const companyMentions = [...mentions].sort((a, b) => lexical(a.key, b.key));
  const groups = new Groups(companyMentions);
  const idMap: Record<string, string> = Object.create(null);
  const merges: MergeDecision[] = [];
  const keptApart: KeptApartDecision[] = [];
  const domainOf = (mention: CompanyMention) => normalizeDomain(mention.domain);
  const idOf = (mention: CompanyMention) => mention.crustdataId != null && String(mention.crustdataId).trim() ? String(mention.crustdataId) : null;
  const linkedinOf = (mention: CompanyMention) => normalizeLinkedIn(mention.linkedinUrl);
  for (const [name, keyOf] of [
    ['Crustdata id', idOf], ['domain', domainOf], ['LinkedIn company URL', linkedinOf],
  ] as const) {
    for (const [key, records] of buckets(companyMentions, keyOf)) {
      for (const record of records.slice(1)) groups.join(records[0].key, record.key, 'same ' + name + ' ' + key);
    }
  }

  const ambiguities = new Set<string>();
  const conflicts: { a: string; b: string; reason: string }[] = [];
  for (const [name, records] of buckets(companyMentions, mention => companyNameKey(mention.name))) {
    const anchors = new Set(records.filter(record => idOf(record) || domainOf(record) || linkedinOf(record))
      .map(record => groups.root(record.key)));
    if (anchors.size > 1) for (const record of records) {
      if (!anchors.has(groups.root(record.key))) ambiguities.add(record.key);
    }
    for (const [i, first] of records.entries()) for (const second of records.slice(i + 1)) {
      const a = groups.root(first.key);
      const b = groups.root(second.key);
      if (a === b || ambiguities.has(first.key) !== ambiguities.has(second.key)) continue;
      const conflict = (keyOf: (mention: CompanyMention) => string | null) => {
        const left = [...buckets(groups.members.get(a)!, keyOf).keys()];
        const right = [...buckets(groups.members.get(b)!, keyOf).keys()];
        return left.length && right.length && !left.some(key => right.includes(key)) ? [...left, ...right].join(' vs ') : null;
      };
      const domain = conflict(domainOf);
      const id = conflict(idOf);
      if (domain || id) {
        conflicts.push({ a, b, reason: `Similar name “${name}” with ${domain ? 'different domains (' + domain + ')' : 'different Crustdata IDs (' + id + ')'}.` });
      } else {
        groups.join(a, b, 'same normalized name ' + name + ' with compatible identifiers');
      }
    }
  }

  const companies: Company[] = [];
  const companyMembers = new Map<string, CompanyMention[]>();
  for (const [root, records] of groups.members) {
    const aliases = [...new Set(records.map(record => record.name))].sort((a, b) => a.length - b.length || lexical(a, b));
    const preference = [...records].sort((a, b) => (b.firmographicsAsOf ?? '').localeCompare(a.firmographicsAsOf ?? '') ||
      Number(b.key.startsWith('company_enrich:')) - Number(a.key.startsWith('company_enrich:')) || lexical(a.key, b.key));
    const first = <K extends keyof CompanyMention>(field: K) => preference.find(record => record[field] != null && record[field] !== '')?.[field];
    const ids = [...buckets(records, idOf).keys()].sort(lexical);
    const domains = [...buckets(records, domainOf).keys()].sort(lexical);
    const urls = [...buckets(records, linkedinOf).keys()].sort(lexical);
    const nameKey = companyNameKey(aliases[0]);
    const identity = ids[0] ? 'id:' + ids[0] : domains[0] ? 'domain:' + domains[0] : urls[0] ? 'linkedin:' + urls[0] : 'name:' + (nameKey || root);
    const id = stableId('co_', identity);
    const funding = preference.flatMap(record => record.lastFunding ?? []).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
    const company: ResolvedCompany = {
      id, name: aliases[0], aliases, domain: normalizeDomain(first('domain')), linkedinUrl: normalizeLinkedIn(first('linkedinUrl')),
      crustdataId: first('crustdataId'), industry: first('industry'), headcount: first('headcount'), headcountGrowthPct: first('headcountGrowthPct'),
      ambiguousIdentity: ids.length > 1 || records.some(record => ambiguities.has(record.key) || record.ambiguousIdentity),
      acquisitions: records.flatMap(record => record.acquisitions ?? []),
      hq: first('hq'), foundedYear: first('foundedYear'), lastFunding: funding, evidenceIds: [...new Set(records.flatMap(record => record.evidenceIds))],
    };
    companies.push(company);
    companyMembers.set(id, records);
    for (const record of records) idMap[record.key] = id;
    const sourceKeys = [...new Set(records.map(record => record.key))];
    if (sourceKeys.length > 1) merges.push({ canonicalId: id, kind: 'company', names: aliases, keys: sourceKeys,
      reason: `Merged ${sourceKeys.length} source records (${sourceKeys.join(', ')}) using ${[...(groups.reasons.get(root) ?? [])].join(' and ')}.` });
  }
  companies.sort((a, b) => lexical(a.name, b.name) || lexical(a.id, b.id));

  const companyById = new Map(companies.map(company => [company.id, company]));
  const seenNotes = new Set<string>();
  function companyNote(aId: string, bId: string, reason: string, kind: string) {
    const keys = [aId, bId].sort();
    const key = kind + keys.join('|');
    const names = keys.map(id => companyById.get(id)?.name ?? id);
    if (seenNotes.has(key)) return;
    seenNotes.add(key);
    keptApart.push({ kind: 'company', ids: [...new Set(keys)], names: [...new Set(names)], reason });
  }
  for (const { a, b, reason } of conflicts) {
    if (idMap[a] !== idMap[b]) companyNote(idMap[a], idMap[b], reason, 'namesake');
  }
  for (const [i, a] of companies.entries()) for (const b of companies.slice(i + 1)) {
    if (!a.domain || !b.domain || a.domain === b.domain) continue;
    const first = companyNameKey(a.name);
    const second = companyNameKey(b.name);
    if (first.includes(' ') && (first.startsWith(second + ' ') || second.startsWith(first + ' ')) &&
      !relatedDomains(a.domain, b.domain)) {
      companyNote(a.id, b.id, `Similar names with different domains (${a.domain} vs ${b.domain}).`, 'namesake');
    }
  }
  const byDomain = buckets(companies, company => normalizeDomain(company.domain));
  const byName = buckets(companies.flatMap(company => company.aliases.map(name => ({ name, company }))), item => companyNameKey(item.name));
  for (const company of companies) {
    const records = companyMembers.get(company.id)!;
    const peers = records.flatMap(record => [
      ...(record.competitorDomains ?? []).flatMap(domain => byDomain.get(normalizeDomain(domain) ?? '') ?? []),
      ...(record.competitorNames ?? []).flatMap(name => {
        const matches = [...new Set((byName.get(companyNameKey(name)) ?? []).map(item => item.company))];
        return matches.length === 1 ? matches : [];
      }),
    ]);
    company.competitorIds = [...new Set(peers.map(peer => peer.id).filter(id => id !== company.id))].sort(lexical);
  }

  const personMentions = [...people].sort((a, b) => lexical(a.key, b.key));
  const peopleGroups = new Groups(personMentions);
  const mappedCompany = (key?: string | null) => key ? idMap[key] ?? (key.startsWith('co_') ? key : null) : null;
  const nameAtCompany = (person: PersonMention) => {
    const company = mappedCompany(person.companyKey) ?? person.companyKey;
    return company ? normalizeName(person.name) + '@' + company : null;
  };
  for (const [url, records] of buckets(personMentions, person => normalizeLinkedIn(person.linkedinUrl))) {
    for (const record of records.slice(1)) peopleGroups.join(records[0].key, record.key, 'same LinkedIn profile ' + url);
  }
  for (const [key, records] of buckets(personMentions, nameAtCompany)) {
    for (const [i, a] of records.entries()) for (const b of records.slice(i + 1)) {
      const rootA = peopleGroups.root(a.key);
      const rootB = peopleGroups.root(b.key);
      if (rootA === rootB) continue;
      const links = (root: string) => [...buckets(peopleGroups.members.get(root)!, person => normalizeLinkedIn(person.linkedinUrl)).keys()];
      if (links(rootA).length && links(rootB).length) continue;
      peopleGroups.join(a.key, b.key, 'same name and employer ' + key);
    }
  }
  const resolvedPeople: Person[] = [];
  for (const [root, records] of peopleGroups.members) {
    const preferred = [...records].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || lexical(a.key, b.key))[0];
    const url = records.map(person => normalizeLinkedIn(person.linkedinUrl)).find(Boolean);
    const id = stableId('pe_', url ?? nameAtCompany(preferred) ?? root);
    const pastEmployers = new Map<string, Person['pastEmployers'][number]>();
    for (const record of records) {
      idMap[record.key] = id;
      for (const past of record.pastEmployers) {
        const currentId = mappedCompany(record.companyKey);
        const previousId = mappedCompany(past.companyId);
        const current = currentId && companyById.get(currentId);
        const previous = previousId && companyById.get(previousId);
        if (current && previous && (current.id === previous.id || relatedDomains(current.domain, previous.domain))) {
          companyNote(current.id, previous.id, `Employment history links ${previous.name} and ${current.name} within the same company or domain family. Treated as an internal transfer.`, 'internal');
        }
        const key = JSON.stringify([normalizeName(past.name), past.from, past.to, past.title]);
        const existing = pastEmployers.get(key);
        if (!existing || previousId) pastEmployers.set(key, { ...past, companyId: previousId });
      }
    }
    resolvedPeople.push({
      id, name: preferred.name, title: preferred.title, companyId: mappedCompany(preferred.companyKey),
      linkedinUrl: url, startedAt: preferred.startedAt, pastEmployers: [...pastEmployers.values()],
      evidenceIds: [...new Set(records.flatMap(record => record.evidenceIds))],
    });
    const sourceKeys = [...new Set(records.map(record => record.key))];
    if (sourceKeys.length > 1) merges.push({ canonicalId: id, kind: 'person', names: [...new Set(records.map(record => record.name))],
      keys: sourceKeys,
      reason: `Merged ${sourceKeys.length} source records (${sourceKeys.join(', ')}) using ${[...(peopleGroups.reasons.get(root) ?? [])].join(' and ')}.` });
  }
  return { companies, people: resolvedPeople, merges, keptApart, idMap };
}
