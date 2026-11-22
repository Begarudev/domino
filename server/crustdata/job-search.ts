import { z } from 'zod';
import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { Intent, IsoDate } from '../../shared/types.ts';
import { isRecruiter } from '../domain/company-fit.ts';
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

function activeEvents(after: IsoDate, through: IsoDate) {
  return displacementEvents.filter(event => inWindow(event.date, after, through));
}

export function buildJobs(intent: Intent, after: IsoDate, through: IsoDate, company?: Filter, displacement = false) {
  const fields = ['job_details.title', 'job_details.url', 'company.basic_info', 'company.locations',
    'company.headcount.total', 'location.country', 'content.description', JOB_DATE];
  const keywords = [...new Set(intent.signalKeywords.filter(keyword => keyword.trim()))];
  if (keywords.some(keyword => containsPhrase('GPU', keyword))) keywords.push('GPUs');
  const signalFilters = keywords.map(keyword => condition('job_details.title', '[.]', keyword));
  const productFilters = displacement ? activeEvents(after, through)
    .map(event => condition('content.description', '[.]', event.product)) : [];
  const signal = [...signalFilters, ...productFilters];
  return {
    filters: group('and', [
      ...dates(JOB_DATE, after, through),
      ...(signal.length ? [group('or', signal)] : []),
      ...geographyFilter('location.country', company ? null : intent.geography),
      ...(company ? [company] : []),
    ]),
    sorts: [{ field: JOB_DATE, order: 'desc' }],
    fields,
    limit: JOB_LIMIT,
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
    categories: historical ? undefined : basic.industries ?? undefined,
    headcount: historical ? undefined : row.company?.headcount?.total,
    hq: [row.company?.locations?.city, row.company?.locations?.country].filter(Boolean).join(', ') || null,
    evidenceIds: [],
  };
}

export function parseJobs(raw: unknown, intent: Intent, meta: ParseMeta, after: IsoDate, through: IsoDate,
  options: { displacement?: boolean; allowAnyGeography?: boolean } = {}): TriggerBatch {
  const batch = emptyBatch();
  const seen = new Set<string>();
  const events = options.displacement ? activeEvents(after, through).filter(event => !event.fixtureOnly || meta.mode === 'fixture') : [];
  for (const row of validate(jobResponse, raw).job_listings) {
    const title = row.job_details?.title?.trim();
    if (!title || (!options.allowAnyGeography && !matchesGeography(row.location?.country, intent.geography))) continue;
    const day = isoDay(row.metadata?.date_added);
    if (day && !inWindow(day, after, through)) continue;
    const description = row.content?.description ?? '';
    const titleMatches = matchesSignal(title, intent.signalKeywords);
    const descriptionMatches = [...new Set(intent.signalKeywords.filter(keyword => matchesSignal(description, [keyword])))];
    const products = events.filter(event => containsPhrase(description, event.product));
    if (!titleMatches && !descriptionMatches.length && !products.length) continue;
    const recordId = String(row.crustdata_job_id ?? row.job_details?.job_id ??
      stableId('job_', row.job_details?.url || '', row.company?.basic_info?.name || '', title, day || ''));
    const company = jobCompany(row, 'job_search:' + recordId + ':company', intent.runKind === 'replay');
    if (!company || seen.has(recordId) || isRecruiter({ name: company.name, categories: row.company?.basic_info?.industries ?? [] })) continue;
    seen.add(recordId);

    const url = row.job_details?.url;
    const titleFact = evidenceRow(meta, recordId, '$.job_details.title',
      day ? `${company.name} posted “${title}” on ${day}.` : `${company.name} listed a role titled “${title}”.`, day, title, url);
    batch.evidence.push(titleFact);
    company.evidenceIds.push(titleFact.id);
    batch.mentions.push(company);
    if (day && titleMatches) batch.triggers.push({
      id: stableId('tr_', 'job_post', recordId), companyId: company.key, kind: 'job_post', date: day,
      summary: `posted “${title}” on ${day}`, evidenceIds: [titleFact.id],
    });

    if (descriptionMatches.length && !products.length) {
      const matchText = descriptionMatches.join(', ');
      const descriptionFact = evidenceRow(meta, recordId, '$.content.description',
        `${company.name} mentioned ${matchText} in the posting for “${title}”.`, day, matchText, url);
      batch.evidence.push(descriptionFact);
      company.evidenceIds.push(descriptionFact.id);
    }

    for (const event of products) {
      const productFact = evidenceRow(meta, recordId, '$.content.description',
        `${company.name} mentioned ${event.product} in the posting for “${title}”.`, day, event.product, url);
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
  build: ({ intent }) => buildJobs(intent, shiftDays(intent.asOf, -intent.windowDays), intent.asOf, undefined, true),
  parse: (raw, { intent }, meta) => parseJobs(raw, intent, meta, shiftDays(intent.asOf, -intent.windowDays), intent.asOf, { displacement: true }),
  estimateCredits: raw => estimate(raw, 'job_listings', JOB_LIMIT, 0.03),
};
