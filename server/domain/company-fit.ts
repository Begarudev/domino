import { companyNameKey, normalizeName } from './facts.ts';

type CompanyProfile = {
  name: string;
  aliases?: string[];
  industry?: string | null;
  categories?: string[];
  headcount?: number | null;
};

const giants = new Set([
  'alphabet', 'google', 'google cloud', 'google deepmind', 'deepmind', 'microsoft', 'github',
  'apple', 'amazon', 'amazon web services', 'amazon web services aws', 'aws', 'meta', 'meta platforms', 'facebook', 'instagram', 'whatsapp',
  'nvidia', 'amd', 'advanced micro devices', 'intel', 'qualcomm', 'qualcomm technologies', 'oracle', 'oracle cloud infrastructure', 'ibm',
  'international business machines', 'salesforce', 'adobe', 'sap', 'sap se', 'servicenow', 'cisco', 'cisco systems',
  'broadcom', 'dell', 'dell technologies', 'hp', 'hewlett packard', 'hpe', 'hewlett packard enterprise',
  'lenovo', 'samsung', 'samsung electronics', 'sony', 'sony group', 'tencent', 'tencent holdings', 'alibaba',
  'alibaba group', 'alibaba cloud', 'bytedance', 'byte dance', 'tiktok', 'baidu', 'huawei', 'uber', 'uber technologies',
  'netflix', 'openai', 'open ai', 'palantir', 'palantir technologies', 'workday', 'snowflake', 'databricks',
]);

const recruiters = new Set([
  'fonzi', 'flexiple', 'remotehunter', 'remote hunter', 'toptal', 'top tal', 'upwork', 'fiverr', 'mercor',
  'teksystems', 'adecco', 'randstad', 'manpowergroup', 'robert half', 'aquent', 'korn ferry',
]);

const recruiterPattern = /\b(?:staffing|recruit(?:ers?|ing|ment)?|talent)\b/;
const servicesPattern = /\b(?:consulting|consultancy|consultants?|outsourcing|it ?services)\b/;
const aiPattern = /\b(?:ai|ml|artificial intelligence|machine learning|deep learning|large language models?|computer vision|natural language processing)\b/;

function names(company: CompanyProfile) {
  return [company.name, ...(company.aliases ?? [])];
}

export function companySegments(company: CompanyProfile): string[] {
  return [company.industry ?? '', ...(company.categories ?? [])].map(normalizeName).filter(Boolean);
}

export function isGiant(company: CompanyProfile): boolean {
  if (company.headcount != null && company.headcount > 0) return company.headcount > 5_000;
  return names(company).some(name => giants.has(companyNameKey(name)));
}

export function isIcp(company: CompanyProfile): boolean {
  return company.headcount != null && company.headcount >= 20 && company.headcount <= 5_000;
}

export function isRecruiter(company: CompanyProfile): boolean {
  return names(company).some(name => recruiters.has(companyNameKey(name))) ||
    [...names(company).map(normalizeName), ...companySegments(company)].some(value => recruiterPattern.test(value));
}

export function isServicesCompany(company: CompanyProfile): boolean {
  return isRecruiter(company) ||
    [...names(company).map(normalizeName), ...companySegments(company)].some(value => servicesPattern.test(value));
}

export function looksLikeAiCompany(company: CompanyProfile): boolean {
  return [...companySegments(company), ...names(company).map(normalizeName)].some(value => aiPattern.test(value));
}
