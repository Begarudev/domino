import type { Intent, IsoDate } from '../../shared/types.ts';
import { isoDay, servingSignalKeywords } from './facts.ts';

const inferenceKeywords = servingSignalKeywords;
const inferenceTitles = ['CTO', 'VP Engineering', 'Head of ML/AI', 'Head of Infrastructure', 'Head of ML Platform', 'Co-founder'];

const profiles = [
  { pattern: /\b(?:inference|infernce|inferenc|gpu|model serving|llm serving)\b/i,
    keywords: inferenceKeywords, titles: inferenceTitles },
  { pattern: /\b(?:data infra\w*|data platform|vector (?:db|database)|etl|data pipeline|data warehouse)\b/i,
    keywords: ['data platform', 'data engineering', 'vector database', 'vector search', 'ETL', 'data pipeline', 'data infrastructure'],
    titles: ['Head of Data Platform', 'Head of Data Engineering', 'VP Data', 'VP Engineering', 'CTO'] },
  { pattern: /\b(?:ai security|llm security|model security|ai safety|prompt injection|guardrails)\b/i,
    keywords: ['AI security', 'LLM security', 'model security', 'AI safety', 'prompt injection', 'AI governance'],
    titles: ['Head of AI Security', 'Head of Security', 'CISO', 'VP Engineering', 'CTO'] },
  { pattern: /\b(?:observability|llmops|evals?|evaluation|llm monitoring|model monitoring)\b/i,
    keywords: ['observability', 'LLMOps', 'LLM evaluation', 'model evaluation', 'LLM monitoring', 'MLOps'],
    titles: ['Head of LLMOps', 'Head of ML Platform', 'Head of AI', 'VP Engineering', 'CTO'] },
  { pattern: /\b(?:dev(?:eloper)? tools?|devtool\w*|coding agents?|developer experience|coding assistant|developer platform)\b/i,
    keywords: ['developer tooling', 'developer experience', 'developer productivity', 'coding agent', 'developer platform'],
    titles: ['Head of Developer Experience', 'Head of Developer Productivity', 'Head of Platform Engineering', 'VP Engineering', 'CTO'] },
  { pattern: /\b(?:ai recruit\w*|ai hiring|ai talent|talent intelligence|recruit\w* (?:ai|automation))\b/i,
    keywords: ['talent acquisition', 'technical recruiter', 'recruiting operations', 'AI hiring', 'recruiting automation'],
    titles: ['Head of Talent Acquisition', 'Head of Recruiting', 'VP People', 'Chief People Officer', 'Co-founder'] },
];

function parseOffering(text: string): string | null {
  const raw = text.match(/\b(?:we\s+(?:sell|sel|slel|offer|provide)|sell(?:ing|in['’]?)|for\s+our)\s+([^,;\n.!?]+)/i)?.[1];
  return raw?.split(/\s+(?:(?:and\s+)?(?:find|target|identify|show|book|get)\b|(?:in|across)\s+(?:india|the us|usa|europe)\b|(?:in|over)\s+the\s+(?:past|last)\b|from\s+the\s+(?:last|past)\b|as\s+of\b|(?:and\s+)?(?:replay|meetings?)\b)/i)[0]?.trim()
    .replace(/^["“']|["”']$/g, '') || null;
}

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function replayDate(text: string, today: IsoDate): { day: IsoDate | null; usedCurrentYear: boolean } {
  const fragment = text.match(/\bas\s+of\s+(.+)/i)?.[1] ?? text.match(/\breplay\s+(?:from\s+|on\s+)?(.+)/i)?.[1] ?? '';
  const numeric = fragment.match(/^\s*(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (numeric) return { day: isoDay(numeric), usedCurrentYear: false };
  const dayFirst = fragment.match(/^\s*(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:[ ,]+(\d{4}))?/i);
  const monthFirst = fragment.match(/^\s*([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[ ,]+(\d{4}))?/i);
  const monthName = (dayFirst?.[2] ?? monthFirst?.[1] ?? '').toLowerCase();
  const month = months.findIndex(value => value === monthName || (monthName.length >= 3 && value.startsWith(monthName))) + 1;
  if (!month) return { day: null, usedCurrentYear: false };
  const day = dayFirst?.[1] ?? monthFirst?.[2] ?? '';
  const year = dayFirst?.[3] ?? monthFirst?.[3];
  return { day: isoDay(`${year ?? today.slice(0, 4)}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`),
    usedCurrentYear: !year };
}

function geographyFrom(text: string): { value: string | null; explicit: boolean } {
  if (/\b(?:anywhere|worldwide|globally|global)\b/i.test(text)) return { value: null, explicit: true };
  if (/\b(?:india|indian|inda)\b/i.test(text)) return { value: 'India', explicit: true };
  if (/\b(?:europe|european|eu)\b/i.test(text)) return { value: 'Europe', explicit: true };
  if (/\b(?:united states|usa|american)\b|\bu\.s\.(?:a\.)?/i.test(text) || /\bUS\b|\b(?:in|across|the)\s+us\b/i.test(text) &&
    /\bUS\b|\b(?:in|across|the)\s+us\b/i.test(text.replace(/\b(?:for|book|get|tell|show) us\b/gi, ''))) {
    return { value: 'US', explicit: true };
  }
  if (/(?:^|[,;])\s*us\s*(?:$|[,;.!?])/i.test(text)) return { value: 'US', explicit: true };
  return { value: null, explicit: false };
}

export function parseIntentRules(text: string, today: IsoDate): Intent {
  const assumptions: string[] = [];
  const offering = parseOffering(text);
  const profile = offering && profiles.find(candidate => candidate.pattern.test(offering));
  if (!offering) assumptions.push('Used inference signals and buyer titles until an offering is supplied.');
  else if (!profile) assumptions.push('Used generic AI infrastructure signals and buyer titles for the unrecognized offering.');
  else assumptions.push('Inferred signal keywords and buyer titles from the offering.');
  const geography = geographyFrom(text);
  if (!geography.explicit) assumptions.push('Searched worldwide because no geography was specified.');
  const buyer = text.match(/\b(?:ai|artificial intelligence|ml|machine learning)\s+(?:companies|cos\.?|startups?|firms?|teams?)\b/i)?.[0];
  if (!buyer) assumptions.push('Assumed AI companies as the buyer profile.');
  const days = text.match(/\b(?:last|past|previous)\s+(\d+)\s*(?:days?|d)\b/i)?.[1];
  const month = /\b(?:last|past|previous)\s+month\b/i.test(text);
  const windowDays = days && +days > 0 && Number.isSafeInteger(+days) && +days <= 36500 ? +days : 30;
  if (!month && (!days || windowDays !== +days)) assumptions.push('Used a 30-day trigger window.');
  const count = text.match(/\b(\d+)\s*(?:companies|cos\.?|targets?|accounts?)\b/i)?.[1];
  const maxTargets = count && +count > 0 && Number.isSafeInteger(+count) ? +count : 5;
  if (!count || +count !== maxTargets) assumptions.push('Returned up to 5 targets.');
  const replay = /\b(?:replay|as\s+of)\b/i.test(text);
  let asOf = today;
  if (replay) {
    const parsed = replayDate(text, today);
    const demoCutoff = '2026-09-01';
    asOf = parsed.day ?? (today >= demoCutoff ? demoCutoff : today);
    if (!parsed.day) assumptions.push(`Used ${asOf} as the replay cutoff.`);
    if (parsed.usedCurrentYear) assumptions.push(`Used ${today.slice(0, 4)} for the replay date year.`);
    if (asOf > today) {
      asOf = today;
      assumptions.push(`Limited the replay cutoff to today (${today}).`);
    }
    assumptions.push(`Used today (${today}) as the replay horizon.`);
  } else {
    assumptions.push(`Used today (${today}) as the cutoff for a live run.`);
  }
  return {
    offering, buyerProfile: buyer ? (/startups?/i.test(buyer) ? 'AI startups' : /teams?/i.test(buyer) ? 'AI teams' : 'AI companies') : 'AI companies',
    geography: geography.value, windowDays, asOf,
    signalKeywords: [...(profile ? profile.keywords : inferenceKeywords)],
    deciderTitles: [...(profile ? profile.titles : inferenceTitles)],
    maxTargets, parsedBy: 'rules', runKind: replay ? 'replay' : 'live', horizonEnd: replay ? today : null, assumptions,
  };
}
