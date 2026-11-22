import { companyCohort, companyEnrich, companySearchGrowth } from './company.ts';
import { companyPosts } from './company-posts.ts';
import { jobSearch } from './job-search.ts';
import { newsAcquihireFetch, newsAcquihireResolve, newsAcquihireSearch, newsFetch, newsSearch } from './news.ts';
import { outcomeCheck } from './outcome-check.ts';
import { personCohortDepartures, personSearchDeciders, personSearchRecentMoves } from './person-search.ts';

export const endpoints = {
  job_search: jobSearch,
  news_search: newsSearch,
  news_fetch: newsFetch,
  news_acquihire_search: newsAcquihireSearch,
  news_acquihire_resolve: newsAcquihireResolve,
  news_acquihire_fetch: newsAcquihireFetch,
  person_recent_moves: personSearchRecentMoves,
  company_growth: companySearchGrowth,
  company_cohort: companyCohort,
  company_posts: companyPosts,
  person_cohort_departures: personCohortDepartures,
  company_enrich: companyEnrich,
  person_deciders: personSearchDeciders,
  outcome_check: outcomeCheck,
};

export { companyCohort, companyEnrich, companyPosts, companySearchGrowth, jobSearch, outcomeCheck, personCohortDepartures, personSearchDeciders, personSearchRecentMoves };
export { outcomeHireCheck } from './outcome-check.ts';
export { fixtureFor } from './fixtures.ts';
export { acquihireCheck, activeNewsEvents, newsAcquihireFetch, newsAcquihireResolve, newsAcquihireSearch,
  newsFetch, newsFetchUrls, newsSearch } from './news.ts';
export type { AcquihireOptions, AcquihirePair, AcquihireReader, AcquihireResult } from './news.ts';
export { NonsenseError } from '../domain/types.ts';
export type { EndpointSpec } from './spec.ts';
