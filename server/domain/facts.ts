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

export function matchesDecider(title: string, requested: string[]): boolean {
  const equivalents = [
    ['CTO', 'Chief Technology Officer', 'Chief Technical Officer'],
    ['VP Engineering', 'VP of Engineering', 'Vice President Engineering', 'Vice President of Engineering'],
    ['Head of ML/AI', 'Head of ML', 'Head of AI', 'Head of Machine Learning', 'Head of Artificial Intelligence'],
    ['Head of Infrastructure', 'Head of Infra'],
    ['Head of ML Platform', 'Head of Machine Learning Platform'],
    ['Co-founder', 'Cofounder'],
  ];
  return deciderPhrases(requested).some(phrase => containsPhrase(title, phrase));

  function deciderPhrases(titles: string[]): string[] {
    return titles.flatMap(requestedTitle =>
      equivalents.find(group => group.some(phrase => normalizeName(phrase) === normalizeName(requestedTitle))) ?? [requestedTitle]);
  }
}
