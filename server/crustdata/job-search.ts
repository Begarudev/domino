import { z } from 'zod';
import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { Intent, IsoDate } from '../../shared/types.ts';
import { containsPhrase, inWindow, isoDay, matchesSignal, shiftDays, stableId } from '../domain/facts.ts';
import type { CompanyMention, ParseMeta, SellerProfile, TriggerBatch } from '../domain/types.ts';
import {
  condition, dates, emptyBatch, estimate, evidenceRow, geographyFilter, group, int, matchesGeography, publicUrl, str, strs, validate,
} from './common.ts';
import type { Filter } from './common.ts';
import type { EndpointSpec } from './spec.ts';

export const JOB_LIMIT = 80;
export const JOB_DATE = 'metadata.date_added';
export const jobCompanyFields = {
  id: 'company.basic_info.company_id', domain: 'company.basic_info.primary_domain', name: 'company.basic_info.name',
};
const displacementEvents = (sellerJson as SellerProfile).displacementEvents;
/** A provider event stays actionable for this many days; the naming job post must be dated on or after the event. */
export const DISPLACEMENT_EVENT_DAYS = 90;
export const DISPLACEMENT_LIMIT = 300;
// A product counts as the employer's own stack only when its sentence reads as usage. Sentences that name it as a
// background, a prospect, a partner, an investor or a sponsor do not, and neither do sales or recruiting postings.
const usageCue = /\b(?:we use|we run|our (?:stack|infrastructure|clusters?|platform|gpus?)|work(?:ing)? with|using|use of|deploy(?:ing|ment)?|run(?:ning)? (?:on|across)|across providers|hands-on|experience (?:with|in|using)|familiar(?:ity)? with|manag(?:e|ing)|maintain(?:ing)?|operat(?:e|ing)|integrat(?:e|ion|ing)|serving|inference engines?)\b|d[ée]ploi|inf[ée]rence/i;
const notUsage = /\b(?:background (?:at|in)|experience at|worked at|alumni|sell(?:ing)?|sales|customers?|clients? such as|partners?(?:hip)?|win(?:ning)?|invest(?:ed|ment|ors?)|led by|backed by|powered by|academy|on behalf of|acquired by)\b/i;
const nonTechnicalTitle = /\b(?:sales|account (?:executive|manager)|business development|partnerships?|recruit(?:er|ing)?|marketing|guard|security officer|accountant|accounting)\b/i;
const staffingIndustry = /\b(?:staffing|recruit|employment|human resources)/i;

const jobResponse = z.object({
  job_listings: z.array(z.object({
    crustdata_job_id: int,
    job_details: z.object({ job_id: int, title: str, url: str }).passthrough().nullish(),
    company: z.object({
      basic_info: z.object({
        crustdata_company_id: int, name: str, primary_domain: str, website: str, professional_network_id: str, industries: strs,
      }).passthrough().nullish(),
      locations: z.object({ country: str, city: str }).passthrough().nullish(),
      headcount: z.object({ total: int }).passthrough().nullish(),
    }).passthrough().nullish(),
    location: z.object({ country: str }).passthrough().nullish(),
    content: z.object({ description: str }).passthrough().nullish(),
    metadata: z.object({ date_added: str }).passthrough().nullish(),
  }).passthrough()),
}).passthrough();

type Job = z.infer<typeof jobResponse>['job_listings'][number];

export function activeEvents(asOf: IsoDate, fixture = false) {
  return displacementEvents.filter(event => inWindow(event.date, shiftDays(asOf, -DISPLACEMENT_EVENT_DAYS), asOf) &&
    (!event.fixtureOnly || fixture));
}

/** The sentence naming the product when it reads as the employer's own stack, or null. */
export function productMention(description: string, product: string, title = ''): string | null {
  if (nonTechnicalTitle.test(title)) return null;
  const lower = description.toLowerCase();
  const needle = product.toLowerCase();
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (!containsPhrase(description.slice(Math.max(0, at - 1), at + needle.length + 1), product)) continue;
    const before = description.slice(0, at);
    const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n'), before.lastIndexOf('•'), before.lastIndexOf(';'), at - 240) + 1;
    const tail = description.slice(at + needle.length);
    const stop = tail.search(/\.\s|\n|•|;/);
    const sentence = description.slice(start, at + needle.length + (stop < 0 ? Math.min(tail.length, 160) : Math.min(stop, 160)))
      .replace(/\s+/g, ' ').trim();
    if (notUsage.test(sentence) || !usageCue.test(sentence)) continue;
    return sentence.length > 220 ? sentence.slice(Math.max(0, sentence.toLowerCase().indexOf(needle) - 110)).slice(0, 220) : sentence;
  }
  return null;
}

export function buildJobs(intent: Intent, after: IsoDate, through: IsoDate, company?: Filter, displacement = false) {
  const fields = ['job_details.title', 'job_details.url', 'company.basic_info', 'company.locations',
    'company.headcount.total', 'location.country', 'content.description', JOB_DATE];
  const titleFields = ['job_details.title', 'content.description'];
  const keywords = [...new Set(intent.signalKeywords.filter(keyword => keyword.trim()))];
  if (keywords.some(keyword => containsPhrase('GPU', keyword))) keywords.push('GPUs');
  const signalFilters = titleFields.flatMap(field => keywords.map(keyword => condition(field, '[.]', keyword)));
  const productFilters = displacement ? [...new Set(activeEvents(through, true).map(event => event.product))]
    .map(product => condition('content.description', '[.]', product)) : [];
  // Product mentions get their own request so keyword-matched postings cannot crowd them out of the page.
  const signal = displacement ? productFilters : signalFilters;
  return {
    filters: group('and', [
      ...dates(JOB_DATE, after, through),
      ...(signal.length ? [group('or', signal)] : []),
      ...geographyFilter('location.country', company ? null : intent.geography),
      ...(company ? [company] : []),
    ]),
    sorts: [{ field: JOB_DATE, order: 'desc' }],
    fields,
    limit: displacement ? DISPLACEMENT_LIMIT : JOB_LIMIT,
  };
}

function jobCompany(row: Job, key: string, historical: boolean): CompanyMention | null {
  const basic = row.company?.basic_info;
  const name = basic?.name?.trim();
  if (!basic || !name) return null;
  return {
    key, name, domain: basic.primary_domain || basic.website,
    linkedinUrl: basic.professional_network_id ? 'https://www.linkedin.com/company/' + basic.professional_network_id : null,
    crustdataId: basic.crustdata_company_id, industry: historical ? undefined : basic.industries?.[0],
    headcount: historical ? undefined : row.company?.headcount?.total,
    hq: [row.company?.locations?.city, row.company?.locations?.country].filter(Boolean).join(', ') || null,
    evidenceIds: [],
  };
}

export function parseJobs(raw: unknown, intent: Intent, meta: ParseMeta, after: IsoDate, through: IsoDate,
  options: { displacement?: boolean; allowAnyGeography?: boolean } = {}): TriggerBatch {
  const batch = emptyBatch();
  const seen = new Set<string>();
  const events = options.displacement ? activeEvents(through, meta.mode === 'fixture') : [];
  for (const row of validate(jobResponse, raw).job_listings) {
    const title = row.job_details?.title?.trim();
    if (!title || (!options.allowAnyGeography && !matchesGeography(row.location?.country, intent.geography))) continue;
    const day = isoDay(row.metadata?.date_added);
    if (day && !inWindow(day, after, through)) continue;
    const description = row.content?.description ?? '';
    const infra = matchesSignal(title, intent.signalKeywords) || matchesSignal(description, intent.signalKeywords);
    const staffing = (row.company?.basic_info?.industries ?? []).some(industry => staffingIndustry.test(industry ?? ''));
    const products = staffing ? [] : events.flatMap(event => {
      const excerpt = day ? productMention(description, event.product, title) : null;
      return excerpt ? [{ event, excerpt }] : [];
    });
    if (!infra && !products.length) continue;
    const recordId = String(row.crustdata_job_id ?? row.job_details?.job_id ??
      stableId('job_', row.job_details?.url || '', row.company?.basic_info?.name || '', title, day || ''));
    const company = jobCompany(row, 'job_search:' + recordId + ':company', intent.runKind === 'replay');
    if (!company || seen.has(recordId)) continue;
    seen.add(recordId);

    const url = row.job_details?.url;
    const titleFact = evidenceRow(meta, recordId, '$.job_details.title',
      day ? `${company.name} posted “${title}” on ${day}.` : `${company.name} listed a role titled “${title}”.`, day, title, url);
    batch.evidence.push(titleFact);
    company.evidenceIds.push(titleFact.id);
    batch.mentions.push(company);
    if (day && infra) batch.triggers.push({
      id: stableId('tr_', 'job_post', recordId), companyId: company.key, kind: 'job_post', date: day,
      summary: `posted “${title}” on ${day}`, evidenceIds: [titleFact.id],
    });

    for (const { event, excerpt } of products) {
      const productFact = evidenceRow(meta, recordId, '$.content.description',
        `${company.name} named ${event.product} in the posting for “${title}” on ${day}: “…${excerpt}…”`, day, event.product, url);
      batch.evidence.push(productFact);
      company.evidenceIds.push(productFact.id);
      const sourceUrl = publicUrl(event.sourceUrl);
      if (!day || !sourceUrl) continue;
      const companyKey = 'displacement:' + event.provider;
      const eventId = stableId('ev_', 'seller_profile', event.provider, event.kind, event.date, sourceUrl);
      if (!batch.evidence.some(row => row.id === eventId)) {
        batch.evidence.push({
          id: eventId, claim: event.note, value: event.product,
          source: { provider: 'seller_profile', endpoint: 'config/seller.json', recordId: event.provider,
            field: '$.displacementEvents[?(@.sourceUrl == ' + JSON.stringify(sourceUrl) + ')].date', url: sourceUrl },
          observedAt: event.date, retrievedAt: meta.retrievedAt, mode: meta.mode, verifiable: true,
        });
        batch.mentions.push({ name: event.provider, key: companyKey, evidenceIds: [eventId] });
      }
      batch.triggers.push({
        id: stableId('tr_', 'product_post', recordId, event.product), companyId: company.key, relatedCompanyId: companyKey,
        kind: 'post', date: day, summary: `named ${event.product} in a job post`, evidenceIds: [productFact.id, eventId],
      });
    }
  }
  return batch;
}

export const jobSearch: EndpointSpec<{ intent: Intent }, TriggerBatch> = {
  name: 'job_search', path: '/job/search', method: 'POST',
  build: ({ intent }) => buildJobs(intent, shiftDays(intent.asOf, -intent.windowDays), intent.asOf),
  parse: (raw, { intent }, meta) => parseJobs(raw, intent, meta, shiftDays(intent.asOf, -intent.windowDays), intent.asOf),
  estimateCredits: raw => estimate(raw, 'job_listings', JOB_LIMIT, 0.03),
};

/** Postings that name a product whose provider was acquired, shut down or repriced (config/seller.json). */
export const jobSearchDisplacement: EndpointSpec<{ intent: Intent }, TriggerBatch> = {
  name: 'job_search_displacement', path: '/job/search', method: 'POST',
  build: ({ intent }) => buildJobs(intent, shiftDays(intent.asOf, -intent.windowDays), intent.asOf, undefined, true),
  parse: (raw, { intent }, meta) => parseJobs(raw, intent, meta, shiftDays(intent.asOf, -intent.windowDays), intent.asOf,
    { displacement: true }),
  estimateCredits: raw => estimate(raw, 'job_listings', DISPLACEMENT_LIMIT, 0.03),
};
