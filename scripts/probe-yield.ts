import { mkdir, writeFile } from 'node:fs/promises';
import { companyCohort, personCohortDepartures } from '../server/crustdata/index.ts';
import { shiftDays } from '../server/domain/facts.ts';
import { LiveProbe, liveIntent } from './probe-live.ts';

if (!process.env.CRUSTDATA_API_KEY?.trim()) {
  console.error('CRUSTDATA_API_KEY is missing. Pass the main checkout .env with --env-file.');
  process.exit(2);
}

const intent = {
  ...liveIntent,
  signalKeywords: [...liveIntent.signalKeywords, 'AI infrastructure', 'machine learning infrastructure',
    'machine learning platform', 'serving infrastructure'],
};
const args = process.argv.slice(2);
const maxCredits = args[0] === '--max-credits' && args[1]?.trim() ? Number(args[1]) : 150;
if ((args.length && (args.length !== 2 || args[0] !== '--max-credits' || !args[1]?.trim()))
  || !Number.isFinite(maxCredits) || maxCredits < 0 || maxCredits > 150) {
  console.error('Usage: bun scripts/probe-yield.ts [--max-credits N] with N between 0 and 150');
  process.exit(1);
}
const month = intent.asOf.slice(0, 7);
const previousMonth = shiftDays(`${month}-01`, -1).slice(0, 7);
const timestamp = new Date().toISOString().replaceAll(':', '-');
const cacheDir = `data/yield-raw-${timestamp}`;
await mkdir(cacheDir, { recursive: true, mode: 0o700 });
const probe = new LiveProbe({ maxCredits, cacheDir });
const cohort = await probe.call(companyCohort, { intent }, intent).catch(() => null);
const companies = [...new Map(cohort?.mentions.map(company => [company.crustdataId, company])).values()];
const moves = companies.length ? await probe.call(personCohortDepartures, { intent, companies }, intent).catch(() => null) : null;

type Departure = { date: string; hirer: string; previousTitle: string };
const mentions = new Map(moves?.mentions.map(company => [company.key, company]));
const evidence = new Map(moves?.evidence.map(fact => [fact.id, fact]));
const byOrigin = new Map(companies.map(company => [company.crustdataId, { company: company.name, departures: [] as Departure[] }]));
for (const trigger of moves?.triggers ?? []) {
  if (trigger.kind !== 'departure') continue;
  const origin = mentions.get(trigger.companyId);
  const hirer = mentions.get(trigger.relatedCompanyId ?? '');
  const previous = trigger.evidenceIds.map(id => evidence.get(id)).find(fact => fact?.source.field?.endsWith('.end_date'));
  if (origin && hirer && typeof previous?.value === 'string') {
    byOrigin.get(origin.crustdataId)?.departures.push({ date: trigger.date, hirer: hirer.name, previousTitle: previous.value });
  }
}

const rows = [...byOrigin.values()].map(({ company, departures }) => {
  departures.sort((a, b) => b.date.localeCompare(a.date));
  const months = departures.map(departure => departure.date.slice(0, 7));
  return {
    company, departureCount: departures.length, thirdMostRecentMonth: months[2] ?? null,
    departures: departures.map(({ date, ...rest }) => ({ month: date.slice(0, 7), ...rest })),
  };
}).sort((a, b) => b.departureCount - a.departureCount || a.company.localeCompare(b.company));
const summary = {
  asOf: intent.asOf, targetMonth: month, keywords: intent.signalKeywords, cohort: companies.length,
  companiesWithDepartures: rows.filter(row => row.departureCount > 0).length,
  departures: rows.reduce((sum, row) => sum + row.departureCount, 0),
  companiesWithAtLeastThreeDepartures: rows.filter(row => row.departureCount >= 3).length,
  companiesWithThirdMostRecentInTargetMonth: rows.filter(row => row.thirdMostRecentMonth === month).length,
  companiesWithThirdMostRecentInPreviousMonth: rows.filter(row => row.thirdMostRecentMonth === previousMonth).length,
  maxCredits,
  creditsUsed: Number(probe.creditsUsed.toFixed(6)),
  calls: probe.calls.map(({ examples: _examples, ...row }) => row),
  companies: rows,
};
const file = `data/yield-${timestamp}.json`;
await writeFile(file, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
console.table(rows.map(row => ({
  company: row.company, departures: row.departureCount,
  months: row.departures.map(departure => departure.month).join(', '),
  hirers: row.departures.map(departure => departure.hirer).join(', '),
  previousTitles: row.departures.map(departure => departure.previousTitle).join(', '),
})));
const { companies: _companies, ...totals } = summary;
console.log(JSON.stringify({ ...totals, summaryFile: file }, null, 2));
if (!cohort || !moves) process.exitCode = 1;
