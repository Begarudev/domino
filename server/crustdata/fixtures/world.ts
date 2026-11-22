// All organizations, people, records, and evidence in this dataset are fictional.
import type { IsoDate } from '../../../shared/types.ts';
import { daysBetween } from '../../domain/facts.ts';

type Round = [IsoDate, string, number];
type Point = [IsoDate, number];
type Firm = {
  id: number; name: string; domain: string; country: string; city: string; sector: string; staff: Point[];
  legalName?: string; competitors?: string[]; rounds?: Round[]; undatedRound?: string; coaching?: boolean;
};

const orbital: Firm = {
  id: 801101, name: 'Orbital Voice', domain: 'orbital-voice.ai', country: 'India', city: 'Bengaluru', sector: 'Speech AI',
  staff: [['2026-07-13', 112], ['2026-08-12', 114], ['2026-10-16', 120], ['2026-11-15', 140]],
  undatedRound: 'seed',
};
const kestrel: Firm = {
  id: 801102, name: 'Kestrel Labs', legalName: 'Kestrel Labs Pvt. Ltd.', domain: 'kestrel-labs.ai', country: 'India',
  city: 'Bengaluru', sector: 'Artificial Intelligence', competitors: ['nimbus-docs.ai', 'quill-legal.ai'],
  staff: [['2026-07-18', 100], ['2026-08-17', 120], ['2026-10-16', 160], ['2026-11-15', 205]],
  rounds: [['2026-08-13', 'series_a', 9_000_000], ['2026-11-05', 'series_b', 24_000_000]],
};
const nimbus: Firm = {
  id: 801103, name: 'Nimbus Docs', domain: 'nimbus-docs.ai', country: 'India', city: 'Pune', sector: 'Artificial Intelligence',
  staff: [['2026-07-19', 78], ['2026-08-18', 106], ['2026-10-16', 102], ['2026-11-15', 125]],
};
const quill: Firm = {
  id: 801104, name: 'Quill Legal AI', domain: 'quill-legal.ai', country: 'India', city: 'Hyderabad',
  sector: 'Artificial Intelligence', staff: [['2026-07-19', 72], ['2026-08-18', 85], ['2026-10-16', 96], ['2026-11-15', 116]],
};
const tessera: Firm = {
  id: 801105, name: 'Tessera Health AI', domain: 'tessera-health.ai', country: 'India', city: 'Chennai', sector: 'Healthcare AI',
  staff: [['2026-07-15', 136], ['2026-08-14', 144], ['2026-10-16', 170], ['2026-11-15', 178]],
};
const coaching: Firm = {
  id: 801106, name: 'Orbital Voice Coaching', domain: 'orbitalvoice.coach', country: 'India', city: 'Mumbai',
  sector: 'Professional Training and Coaching', staff: [['2026-10-16', 5], ['2026-11-15', 6]], coaching: true,
};
const research: Firm = {
  id: 801107, name: 'Kestrel Research', domain: 'research.kestrel-labs.ai', country: 'India', city: 'Bengaluru',
  sector: 'Machine Learning Research', staff: [['2026-10-16', 55], ['2026-11-15', 53]],
};
const mica: Firm = {
  id: 801108, name: 'Mica Query', domain: 'mica-query.ai', country: 'United States', city: 'Austin', sector: 'Machine Learning',
  staff: [['2026-07-19', 50], ['2026-08-18', 63], ['2026-10-16', 65], ['2026-11-15', 70]],
};
const dhow: Firm = {
  id: 801109, name: 'Dhow Forecast', domain: 'dhow-forecast.ai', country: 'United Kingdom', city: 'Edinburgh',
  sector: 'Predictive Analytics', staff: [['2026-07-19', 30], ['2026-08-18', 41], ['2026-10-16', 44], ['2026-11-15', 46]],
};
const marigold: Firm = {
  id: 801110, name: 'Marigold Compute', domain: 'marigold-compute.ai', country: 'India', city: 'Bengaluru',
  sector: 'Cloud Infrastructure', staff: [['2026-10-16', 76], ['2026-11-15', 80]],
};
const peregrine: Firm = {
  id: 801111, name: 'Peregrine Systems', domain: 'peregrine-systems.example', country: 'India', city: 'Bengaluru',
  sector: 'Enterprise Software', staff: [['2026-10-16', 480], ['2026-11-15', 485]],
};
const ironbark: Firm = {
  id: 801112, name: 'Ironbark Parcel', domain: 'ironbark-parcel.example', country: 'India', city: 'Pune',
  sector: 'Parcel Delivery', staff: [['2026-10-16', 41], ['2026-11-15', 45]],
};
const lumen: Firm = {
  id: 801113, name: 'Lumen Serve', domain: 'lumen-serve.ai', country: 'United States', city: 'Portland', sector: 'Inference APIs',
  staff: [['2026-10-16', 74], ['2026-11-15', 77]],
};

export const firms = [orbital, kestrel, nimbus, quill, tessera, coaching, research, mica, dhow, marigold, peregrine, ironbark, lumen];
export const TODAY = '2026-11-22';

const companyUrl = (firm: Firm) => 'https://www.linkedin.com/company/domino-fiction-' + firm.id;
const headquarters = (firm: Firm) => firm.city + ', ' + firm.country;

function countAt(firm: Firm, day: IsoDate) {
  return firm.staff.findLast(([date]) => date <= day)?.[1] ?? null;
}

export function companyRow(firm: Firm, asOf: IsoDate, enrich: boolean) {
  const snapshot = firm.staff.findLast(([date]) => date <= asOf);
  const previous = snapshot && firm.staff.findLast(([date]) => daysBetween(date, snapshot[0]) >= 28 &&
    daysBetween(date, snapshot[0]) <= 35);
  const growth = snapshot && previous ? Math.round((snapshot[1] / previous[1] - 1) * 1000) / 10 : null;
  const round = firm.rounds?.findLast(([date]) => date <= asOf);
  return {
    crustdata_company_id: firm.id,
    basic_info: {
      name: !enrich ? firm.legalName ?? firm.name : firm.name,
      primary_domain: firm.domain, website: 'https://' + firm.domain, professional_network_url: companyUrl(firm), year_founded: 2020,
    },
    taxonomy: {
      professional_network_industry: firm.sector,
      professional_network_industries: [firm.sector],
      categories: firm.coaching || /(?:\bAI\b|intelligence|learning|predictive)/i.test(firm.sector) ? ['Artificial Intelligence'] : [firm.sector],
    },
    metadata: { growth_calculation_date: snapshot?.[0] ?? null },
    headcount: {
      total: snapshot?.[1] ?? null, growth_percent: { [enrich ? 'mom' : '1m']: growth },
      ...(enrich ? { timeseries: firm.staff.map(([date, employee_count]) => ({ date, employee_count })) } : {}),
    },
    locations: { country: firm.country, headquarters: headquarters(firm) },
    funding: { last_fundraise_date: round?.[0] ?? null, last_round_type: round?.[1] ?? firm.undatedRound ?? null,
      last_round_amount_usd: round?.[2] ?? null },
    ...(enrich ? { competitors: { all_domains: firm.competitors ?? [], paid_seo: [], organic_seo: [] } } : {}),
  };
}

function job(id: number, firm: Firm, date: IsoDate, title: string, description: string) {
  return {
    crustdata_job_id: id,
    job_details: { job_id: id, title, url: `https://${firm.domain}/careers/${id}` },
    company: {
      basic_info: {
        crustdata_company_id: firm.id, name: firm.name, primary_domain: firm.domain, website: 'https://' + firm.domain,
        professional_network_id: 'domino-fiction-' + firm.id, industries: [firm.sector],
      },
      locations: { country: firm.country, city: firm.city }, headcount: { total: countAt(firm, date) },
    },
    location: { country: firm.country, city: firm.city },
    content: { description },
    metadata: { date_added: date + 'T14:00:00' },
  };
}

export const jobs = [
  job(900001, kestrel, '2026-11-03', 'Senior Inference Engineer', 'Run inference for live customers on the ML platform.'),
  job(900002, kestrel, '2026-11-10', 'ML Platform Engineer', 'Own GPU capacity and deployment tooling.'),
  job(900003, tessera, '2026-10-29', 'Clinical Applications Engineer', 'Maintain our Lumen Serve integration for triage and scheduling.'),
  job(900004, nimbus, '2026-11-06', 'Applied Machine Learning Scientist', 'Improve document classification quality.'),
  job(900005, quill, '2026-11-11', 'Applied Machine Learning Researcher', 'Work on legal document extraction and annotation quality.'),
  job(900006, ironbark, '2026-11-07', 'Payroll Operations Lead', 'Prepare payroll and coordinate courier expense reports.'),
  job(900007, kestrel, '2026-08-08', 'ML Platform Engineer', 'Own GPU deployment tooling.'),
  job(900008, kestrel, '2026-08-18', 'Inference Reliability Engineer', 'Maintain service reliability for inference.'),
  job(900009, mica, '2026-08-12', 'GPU Performance Engineer', 'Benchmark statistical models.'),
  job(900010, kestrel, '2026-09-09', 'LLM Serving Engineer', 'Scale model serving for the enterprise product.'),
  job(900011, nimbus, '2026-09-25', 'Inference Systems Engineer', 'Design production inference tooling for document workloads.'),
  job(900012, orbital, '2026-09-18', 'Speech ML Scientist', 'Improve speech recognition on noisy recordings.'),
  job(900013, marigold, '2026-08-24', 'Platform Support Engineer', 'Maintain the production support queue.'),
];

function role(firm: Firm, title: string, start: IsoDate, end?: IsoDate) {
  return {
    position_id: `${firm.id}-${start}-${title.toLowerCase().replaceAll(' ', '-')}`,
    name: firm.name, title, start_date: start, end_date: end ?? null, is_default: !end,
    crustdata_company_id: firm.id, company_website: 'https://' + firm.domain,
    company_professional_network_profile_url: companyUrl(firm), company_professional_network_industry: firm.sector,
    company_industries: [firm.sector], company_headquarters_country: firm.country, company_headcount_latest: countAt(firm, TODAY),
  };
}

function profile(id: number, name: string, current: ReturnType<typeof role>, ...past: ReturnType<typeof role>[]) {
  return {
    crustdata_person_id: id,
    basic_profile: { name },
    social_handles: { professional_network_identifier: { profile_url: 'https://www.linkedin.com/in/domino-fiction-' + id } },
    experience: { employment_details: { current: [current], past } },
  };
}

export const profiles = [
  profile(901001, 'Veena Tamar', role(kestrel, 'Senior Inference Engineer', '2026-10-27'),
    role(orbital, 'Inference Engineer', '2024-08-08', '2026-10-23'),
    role(marigold, 'Software Engineer', '2021-07-01', '2024-08-01')),
  profile(901002, 'Rian Kairav', role(kestrel, 'GPU Serving Engineer', '2026-11-04'),
    role(orbital, 'ML Infrastructure Engineer', '2023-06-15', '2026-10-31')),
  profile(901003, 'Neya Vardis', role(kestrel, 'Inference Platform Engineer', '2026-11-12'),
    role(orbital, 'LLM Serving Engineer', '2024-09-08', '2026-11-08')),
  profile(901004, 'Omi Daivar', role(kestrel, 'ML Platform Engineer', '2026-11-08'),
    role(research, 'ML Platform Engineer', '2023-11-25', '2026-11-07')),
  profile(901005, 'Levi Irik', role(kestrel, 'Inference Engineer', '2026-11-09'),
    role(research, 'GPU Engineer', '2024-04-15', '2026-11-08')),
  profile(901006, 'Tara Ovran', role(coaching, 'Marketing Lead', '2026-11-03'),
    role(ironbark, 'Marketing Specialist', '2022-04-09', '2026-10-31')),
  profile(901007, 'Saira Kenir', role(orbital, 'CTO', '2024-02-01'),
    role(marigold, 'Engineering Director', '2020-10-01', '2023-12-20')),
  profile(901008, 'Kavi Rennar', role(orbital, 'VP of Engineering', '2025-03-01'),
    role(peregrine, 'Director of Engineering', '2022-02-01', '2024-12-15')),
  profile(901009, 'Niko Vedral', role(kestrel, 'Head of ML Platform', '2024-06-01')),
  profile(901010, 'Mira Jandek', role(nimbus, 'Head of AI', '2024-02-15')),
  profile(901011, 'Dora Samren', role(quill, 'Co-founder', '2023-01-01')),
  profile(901012, 'Arik Tavrel', role(tessera, 'Head of Infrastructure', '2024-11-15')),
  profile(901013, 'Jaya Vayun', role(kestrel, 'ML Infrastructure Engineer', '2026-07-29'),
    role(orbital, 'Inference Engineer', '2024-12-06', '2026-07-24')),
  profile(901014, 'Dev Orenak', role(kestrel, 'Model Serving Engineer', '2026-07-31'),
    role(orbital, 'ML Platform Engineer', '2023-02-07', '2026-07-28')),
  profile(901015, 'Ravi Pipren', role(nimbus, 'Inference Platform Engineer', '2026-09-12'),
    role(marigold, 'ML Infrastructure Engineer', '2023-01-07', '2026-09-04')),
  profile(901016, 'Ani Kelvar', role(kestrel, 'GPU Reliability Engineer', '2026-08-24'),
    role(orbital, 'ML Infrastructure Engineer', '2023-10-07', '2026-08-22')),
];
