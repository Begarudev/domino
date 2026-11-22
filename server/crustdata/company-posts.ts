import { z } from 'zod';
import type { Intent } from '../../shared/types.ts';
import { containsPhrase, inWindow, isoDay, matchesSignal, normalizeDomain, shiftDays, stableId } from '../domain/facts.ts';
import type { TriggerBatch } from '../domain/types.ts';
import { companyNumber, condition, dates, emptyBatch, estimate, evidenceRow, group, int, publicUrl, sameCompany, str, validate } from './common.ts';
import type { CompanyInput, Filter } from './common.ts';
import type { EndpointSpec } from './spec.ts';

const POST_LIMIT = 12;
const POST_RATE = 0.5;
const sharedSignals = ['inference', 'GPU', 'GPUs', 'launch', 'launched', 'launching', 'serving', 'scale', 'scaling'];
type Input = { intent: Intent; companies: CompanyInput[] };

const responseSchema = z.object({ posts: z.array(z.object({
  share_url: str, date_posted: str, text: str,
  actor: z.object({ actor_type: str, name: str, crustdata_entity_id: int }).passthrough().nullish(),
  mentions: z.object({ company_ids: z.array(z.number().int()).nullish() }).passthrough().nullish(),
}).passthrough()) }).passthrough();

function signalWords(intent: Intent) {
  return [...new Set([...intent.signalKeywords, ...sharedSignals].map(keyword => keyword.trim()).filter(Boolean))];
}

export const companyPosts: EndpointSpec<Input, TriggerBatch> = {
  name: 'company_posts', path: '/social_post/search', method: 'POST',
  build({ intent, companies }) {
    const ids = [...new Set(companies.flatMap(company => companyNumber(company.crustdataId) ?? []))];
    const names = [...new Set(companies.map(company => company.name.trim()).filter(Boolean))];
    const references = [...new Set([...names, ...companies.flatMap(company => normalizeDomain(company.domain) ?? [])])];
    const authors: Filter[] = [];
    if (ids.length) authors.push(condition('actor.crustdata_entity_id', 'in', ids));
    if (names.length) authors.push(condition('actor.name', 'in', names));
    const linked: Filter[] = references.map(reference => condition('text', '[.]', reference));
    if (ids.length) linked.push(condition('mentions.company_id', 'in', ids));
    if (authors.length) linked.push(group('and', [condition('actor.actor_type', '=', 'company'), group('or', authors)]));

    return {
      filters: group('and', [
        ...dates('date_posted', shiftDays(intent.asOf, -intent.windowDays), intent.asOf),
        group('or', linked.length ? linked : [condition('actor.crustdata_entity_id', '=', -1)]),
        group('or', signalWords(intent).map(word => condition('text', '[.]', word))),
      ]),
      fields: ['share_url', 'date_posted', 'text', 'actor.actor_type', 'actor.name', 'actor.crustdata_entity_id', 'mentions'],
      sorts: [{ field: 'date_posted', order: 'desc' }],
      limit: POST_LIMIT,
    };
  },
  parse(raw, { intent, companies }, meta) {
    const batch = emptyBatch();
    const seen = new Set<string>();
    const after = shiftDays(intent.asOf, -intent.windowDays);
    const keywords = signalWords(intent);
    for (const post of validate(responseSchema, raw).posts) {
      const text = post.text?.trim();
      const date = isoDay(post.date_posted);
      if (!text || (date && !inWindow(date, after, intent.asOf))) continue;
      const actor = post.actor;
      const author = actor?.actor_type === 'company' ? companies.find(company => sameCompany(company, {
        name: actor.name ?? '', crustdataId: actor.crustdata_entity_id,
      })) : undefined;
      const targets = companies.filter(company => {
        const id = companyNumber(company.crustdataId);
        const domain = normalizeDomain(company.domain);
        return company === author || (id !== null && post.mentions?.company_ids?.includes(id))
          || containsPhrase(text, company.name) || (domain !== null && containsPhrase(text, domain));
      });
      if (!targets.length) continue;

      const url = publicUrl(post.share_url);
      const label = author?.name || actor?.name?.trim() || 'An author';
      const recordId = url ?? stableId('post_', label, date ?? '', text);
      if (seen.has(recordId)) continue;
      seen.add(recordId);
      const excerpt = Array.from(text).slice(0, 120).join('');
      const claim = `${label} posted${date ? ` on ${date}` : ''}: ${excerpt}`;
      const fact = evidenceRow(meta, recordId, '$.text', claim, date, excerpt, url);
      batch.evidence.push(fact);
      const signal = date && matchesSignal(text, keywords);
      for (const company of targets) {
        const key = stableId('co_post_', recordId, String(company.crustdataId ?? company.domain ?? company.name));
        batch.mentions.push({ ...company, key, evidenceIds: [fact.id] });
        if (signal) batch.triggers.push({ id: stableId('tr_', 'post', key), companyId: key, kind: 'post',
          date, summary: claim, evidenceIds: [fact.id] });
      }
    }
    return batch;
  },
  estimateCredits: raw => estimate(raw, 'posts', POST_LIMIT, POST_RATE),
};
