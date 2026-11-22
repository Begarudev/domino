import { createHash } from 'node:crypto';
import type { IsoDate } from '../../shared/types.ts';

export function stableId(prefix: string, ...keys: (string | number)[]): string {
  return prefix + createHash('sha256').update(JSON.stringify(keys)).digest('hex').slice(0, 16);
}

export function isoDay(value?: string | null): IsoDate | null {
  const day = value?.match(/^\d{4}-\d{2}-\d{2}(?=$|T| )/)?.[0];
  if (!day) return null;
  const stamp = Date.parse(day);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day ? day : null;
}

const dayMs = 86_400_000;

export function shiftDays(day: IsoDate, n: number): IsoDate {
  return new Date(Date.parse(day) + n * dayMs).toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return (Date.parse(to) - Date.parse(from)) / dayMs;
}

export function inWindow(day: IsoDate | null, after: IsoDate, through: IsoDate): day is IsoDate {
  return day !== null && day > after && day <= through;
}

export function normalizeName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function companyNameKey(value: string): string {
  const name = normalizeName(value);
  const legal = name.replace(/(?:\s+(?:pvt(?: ltd)?|private limited|limited|ltd|inc(?:orporated)?|llc|corp(?:oration)?|gmbh|plc))+$/, '');
  return legal.replace(/(?:\s+(?:labs?|ai))+$/, '') || legal || name;
}

export function normalizeDomain(value?: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

export function normalizeLinkedIn(value?: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value.trim());
    const path = url.pathname.toLowerCase().replace(/\/+$/, '');
    return /(?:^|\.)linkedin\.com$/i.test(url.hostname) && /^\/(?:in|company)\/.+/.test(path)
      ? 'https://www.linkedin.com' + path : null;
  } catch {
    return null;
  }
}

export function containsPhrase(text: string, phrase: string): boolean {
  const cleaned = normalizeName(phrase);
  return cleaned !== '' && (' ' + normalizeName(text) + ' ').includes(' ' + cleaned + ' ');
}

export function matchesSignal(text: string, keywords: string[]): boolean {
  return keywords.some(keyword => containsPhrase(text, keyword)) ||
    (keywords.some(keyword => containsPhrase('GPU', keyword)) && /\bgpus\b/i.test(text));
}

export function deciderPhrases(requested: string[]): string[] {
  const equivalents = [
    ['CTO', 'Chief Technology Officer', 'Chief Technical Officer'],
    ['VP Engineering', 'VP of Engineering', 'Vice President Engineering', 'Vice President of Engineering'],
    ['Head of ML/AI', 'Head of ML', 'Head of AI', 'Head of Machine Learning', 'Head of Artificial Intelligence'],
    ['Head of Infrastructure', 'Head of Infra'],
    ['Head of ML Platform', 'Head of Machine Learning Platform'],
    ['Co-founder', 'Cofounder'],
  ];
  return [...new Set(requested.flatMap(title =>
    equivalents.find(group => group.some(phrase => normalizeName(phrase) === normalizeName(title))) ?? [title]))];
}

export function matchesDecider(title: string, requested: string[]): boolean {
  return deciderPhrases(requested).some(phrase => containsPhrase(title, phrase));
}

export function relatedDomains(a?: string | null, b?: string | null): boolean {
  const first = normalizeDomain(a);
  const second = normalizeDomain(b);
  if (!first || !second) return false;
  const root = (domain: string) => {
    const parts = domain.split('.');
    const multipartSuffix = parts.at(-1)?.length === 2 && /^(?:ac|co|com|edu|gov|net|org)$/.test(parts.at(-2) ?? '');
    return parts.slice(multipartSuffix ? -3 : -2).join('.');
  };
  return root(first) === root(second);
}


export const DRAIN_HISTORY_DAYS = 90;
export const DRAIN_WINDOW_DAYS = 30;
export const DRAIN_REPLAY_HISTORY_DAYS = 120;
export const DRAIN_REPLAY_WINDOW_DAYS = 60;
export const DRAIN_OUTCOME_DAYS = 60;
export const servingSignalKeywords = ['inference', 'ML platform', 'machine learning platform', 'ML infrastructure', 'machine learning infrastructure', 'ML infra',
  'serving', 'GPU software', 'GPU cluster', 'GPU', 'LLM serving', 'model serving', 'MLOps', 'LLMOps', 'ML systems',
  'machine learning systems', 'AI infrastructure', 'LLM infrastructure', 'LLM infra', 'distributed training',
  'distributed inference'];

export function servingTitleStatus(title?: string | null): 'serving' | 'unknown' | 'excluded' {
  if (!title || /\b(?:asic|rtl|physical design|gpu design|hardware design|chip design|semiconductor design|finance|program manager|account manager|account executive|sales|recruit(?:er|ing)|marketing)\b/i.test(title)) {
    return 'excluded';
  }
  if (servingSignalKeywords.some(keyword => keyword !== 'GPU' && containsPhrase(title, keyword)) ||
    /\bgpu\s+(?:engineer|reliability|performance|systems)\b/i.test(title)) return 'serving';
  return /\b(?:engineer(?:ing)?|developer|architect|scientist|technical|systems)\b/i.test(title) ? 'unknown' : 'excluded';
}

export const servingTitle = (title?: string | null) => servingTitleStatus(title) === 'serving';

export function formatMonth(day: IsoDate): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(day));
}

export function formatDay(day: IsoDate): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day));
}
