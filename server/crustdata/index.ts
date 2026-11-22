import { companyCohort, companyEnrich, companySearchGrowth } from './company.ts';
import { jobSearch } from './job-search.ts';
import { outcomeCheck } from './outcome-check.ts';
import { personCohortDepartures, personSearchDeciders, personSearchRecentMoves } from './person-search.ts';

export const endpoints = {
  job_search: jobSearch,
  person_recent_moves: personSearchRecentMoves,
  company_growth: companySearchGrowth,
  company_cohort: companyCohort,
  person_cohort_departures: personCohortDepartures,
  company_enrich: companyEnrich,
  person_deciders: personSearchDeciders,
  outcome_check: outcomeCheck,
};

export { companyCohort, companyEnrich, companySearchGrowth, jobSearch, outcomeCheck, personCohortDepartures, personSearchDeciders, personSearchRecentMoves };
export { outcomeHireCheck } from './outcome-check.ts';
export { fixtureFor } from './fixtures.ts';
export { NonsenseError } from '../domain/types.ts';
export type { EndpointSpec } from './spec.ts';
