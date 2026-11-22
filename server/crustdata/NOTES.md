# Crustdata integration

Base URL is `https://api.crustdata.com`. Use `Authorization: Bearer <key>`, `x-api-version: 2025-11-01` and `Content-Type: application/json`. All requests here are POST. Prefer the `X-Credits-Used` header to the estimates below. Pricing and field permissions are account-specific. Implementation was checked against the [published OpenAPI spec](https://raw.githubusercontent.com/crustdata/openAPI-specifications/main/crustdata-openapi-spec.json), [documentation index](https://docs.crustdata.com/llms.txt), and reference pages. No API requests were sent.

A filter leaf is `{ "field": "<dot path>", "type": "<operator>", "value": ... }`. Combine leaves or groups with `{ "op": "and" | "or", "conditions": [...] }`. For a day window `(after, through]`, use two leaves on the same date field:

```json
{
  "op": "and",
  "conditions": [
    {"field": "metadata.date_added", "type": "=>", "value": "2026-10-24"},
    {"field": "metadata.date_added", "type": "<", "value": "2026-11-23"}
  ]
}
```

Crustdata spells the inclusive operators `=>` and `=<`. Date-only request values start at midnight UTC on date-time fields. Using an exclusive next-day upper bound includes postings throughout the last day. Matching uses `[.]` for a phrase, `=` for a scalar, and `in` for an array. Indexed searches accept `limit`, `fields`, `sorts: [{field,order}]`, and the opaque `cursor` from `next_cursor`. Filter-only searches support pages up to 1,000. DOMINO uses one bounded page per leg and keeps the query stable if a caller adds a cursor.

## job_search

`POST /job/search` with an AND of date conditions on `metadata.date_added`, an OR of keyword phrases in `job_details.title` and `content.description`, and optional `location.country` country filter. The OR also includes product mentions for displacement events in the requested window. Sort by `metadata.date_added` descending and set `limit: 80`. If geography is Europe, the condition is an `in` list of country names.

Response is `{job_listings: Job[], next_cursor, total_count}`. For each `$.job_listings[i]` read `crustdata_job_id` (fallback `job_details.job_id`), `job_details.title`, `job_details.url`, `metadata.date_added` (posting date), `content.description` (phrase matches only), `location.country`, `company.basic_info.{crustdata_company_id,name,primary_domain,website,professional_network_id,industries}`, `company.locations.{country,city}`, and `company.headcount.total`. Provenance paths are relative to the identified job record. A configured displacement event has its own separate, seller-profile evidence row. Fixture-only events cannot become live or cached evidence. [Job Search reference](https://docs.crustdata.com/job-docs/search/reference.md)

**List cost:** 0.03 credit/result. An 80-result page costs 2.40.

## person_recent_moves and person_deciders

`POST /person/search`. Recent moves AND together start date bounds and a title phrase OR on `experience.employment_details.current` with an optional `company_headquarters_country` condition on the same role. Live looks back 90 days. Replay checks both `current` and `past` in `(asOf − 120 days, asOf − 30 days]`. Deciders combine employer and title filters on the same role. Employer leaves prefer `company_id`, then `company_website_domain`, then `company_name`. Prefer an exact company ID or domain. Sort on `experience.employment_details.start_date`. Limits are 50 for moves and 12 for deciders. Employer HQ values accept full countries or ISO alpha-3 codes.

Response is `{profiles: Person[], next_cursor, total_count, remarks}`. For each `$.profiles[i]` read `crustdata_person_id`, `basic_profile.name`, `social_handles.professional_network_identifier.profile_url`, and `experience.employment_details.{current,past}[]`. Role fields selected for moves are `position_id`, `name`, `title`, `start_date`, `end_date`, `is_default`, `crustdata_company_id`, `company_website`, `company_professional_network_profile_url`, `company_industries`, `company_professional_network_industry`, `company_headcount_latest`, and `company_headquarters_country`. Deciders select only role identifiers, title, employer and dates. The two returned lists represent current and past roles. A departure uses the most recent prior role that ended at most 60 days before the new start. The source evidence retains the end date, and the profile-lag guard uses the new start date. A month-only value (including `2026-10-01T00:00:00`) carries an interval and a visible precision note. Its evidence date is the latest possible day. For a current live role the day is capped at `asOf`, since the profile already lists the role. A month that crosses the cutoff cannot establish a qualifying hire. The profile URL is response-only. Requests select individual fields and omit contact data. [Person Search reference](https://docs.crustdata.com/person-docs/search/reference.md)

**List cost:** 0.03 base + 0.10 experience filter + up to 0.10 experience response per result. Estimates use 0.23/result. Person Enrich is unused and lists at 1–9 credits/profile. [Person Enrich reference](https://docs.crustdata.com/person-docs/enrichment/reference.md)

## company_growth

`POST /company/search` with an AI/ML category or industry phrase filter, optional `locations.country`, and an OR of in-window funding (`funding.last_fundraise_date`) and headcount growth (in-window `metadata.growth_calculation_date` and `headcount.growth_percent.1m` `=> 15`). Sort by `funding.last_fundraise_date` descending then `crustdata_company_id` ascending and set `limit: 40`.

Response is `{companies: Company[], next_cursor, total_count}`. For each `$.companies[i]` read `crustdata_company_id`, `basic_info.{name,primary_domain,website,professional_network_url,year_founded}`, taxonomy `professional_network_industry`, `professional_network_industries`, `categories`, `locations.{country,headquarters}`, `metadata.growth_calculation_date`, `headcount.total`, `headcount.growth_percent.1m`, and `funding.{last_fundraise_date,last_round_type,last_round_amount_usd}`. Indexed search provides a monthly growth calculation date. The actual employee-count timeseries is available on company enrich. Undated growth does not produce a trigger. No historical index snapshot is available via this request. In live replay, a subsequent funding round can hide the prior round from this search, and current company classifications are excluded from replay input. [Company Search reference](https://docs.crustdata.com/company-docs/search/reference.md)

**List cost:** 0.03 base + 0.10 taxonomy, 0.20 headcount, and 0.20 funding for each of the filter and response sides where applicable. Maximum estimated cost is 1.03/result (41.20 for a full 40-result page).

## company_enrich

`POST /company/enrich`. The body accepts exactly one identifier array. DOMINO submits `crustdata_company_ids: integer[]` if every company has an ID, otherwise `domains: string[]` with `exact_match: true` if every company has a domain, otherwise `names: string[]`. It rejects contradictory matches and takes the highest-confidence eligible match. Request `fields: ["basic_info","taxonomy","locations","headcount","funding","competitors"]`. No cursor.

Response is a **bare array** of `{matched_on, match_type, matches: [{confidence_score, company_data}]}`. At `$[i].matches[j].company_data`, read the company fields above and `headcount.timeseries[].{date,employee_count}`, period aliases `headcount.growth_percent.{mom,qoq,six_months,yoy}`, `competitors.all_domains[]`, historical `funding.milestones[].{funding_date,date,round_type,amount_usd}`, and `funding.acquisitions` / `funding.acquired_by` for relationship checks. The parser uses the latest dated timeseries point at or before the cutoff and computes monthly growth when it has a point 28–35 days earlier. A jump from timeseries cites the actual series and uses the latest point as its date. The numeric value on the growth trigger’s evidence is the growth percentage, so the +30% baseline reads the percentage directly. Competitors are returned as domains alongside separate SEO lists. DOMINO maps the aggregated domains to resolved companies and leaves `competitorNames` empty. Undated enrichment values lack dated corroboration and cannot support a draft fact. [Company Enrich reference](https://docs.crustdata.com/company-docs/enrichment/reference.md)

**List cost:** 2 credits per matched company for these fields. Technographics adds 2 if returned and is unused.

## outcome_check

This logical endpoint uses two separate requests. Run `endpoints.outcome_check` for job posts and `endpoints.outcome_check.hires` for person records, then concatenate `outcomes` and `evidence`. Each spec parses a real response envelope and has its own estimate. The job leg uses the same shape as job search, adding target-company filters on `company.basic_info.company_id`, `primary_domain`, or `name`. The person leg uses the same shape as recent moves, with employer filters on both current and past roles. Neither leg applies geography again. The date range is `(asOf, horizonEnd]`. Outcome dates measure when hires started or jobs were posted. The 30-day profile lag applies to prediction inputs. Talent-drain validation additionally requires a serving or infrastructure title at the losing company within 60 days of the cutoff, capped at the horizon end.

**List cost:** up to 0.03/job result plus 0.23/person result. [Published pricing](https://docs.crustdata.com/general/pricing.md)
