// Pieces the candidate onboarding and dashboard share: consent copy, the LinkedIn check, evidence source lines.
import type { Evidence } from '../../../../shared/types.ts';
import type { Consent } from '../../data/desk.ts';
import { fmtDate, fmtTime } from '../../lib/format.ts';

export type ConsentKey = 'shareHistory' | 'shareSkills' | 'shareSamples' | 'discoverable';

/** Each item says in plain words who sees what. */
export const CONSENT_ITEMS: { key: ConsentKey; label: string; who: string }[] = [
  { key: 'shareHistory', label: 'Work history', who: 'Companies with a matching opening see your past roles and their dates. Never your contact details.' },
  { key: 'shareSkills', label: 'Skills', who: 'Companies with a matching opening see your role and skills. Never your contact details.' },
  { key: 'shareSamples', label: 'Work samples', who: 'Companies with a matching opening see the links or notes you add here.' },
  { key: 'discoverable', label: 'Let matching companies find me', who: 'A company with a matching opening can see you in its matches and ask to meet. They see only what is ticked above.' },
];

export const DEFAULT_CONSENT: Consent = { shareHistory: true, shareSkills: true, shareSamples: false, discoverable: true };

/** What a company would see, for the intro confirm ("role family, skills, work history"). */
export function sharedFields(c: Consent): string[] {
  const out = ['role family'];
  if (c.shareSkills) out.push('skills');
  if (c.shareHistory) out.push('work history');
  if (c.shareSamples) out.push('work samples');
  return out;
}

export const joinList = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const LI = /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[^/\s?#]+\/?([?#].*)?$/i;
export function checkLinkedin(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Paste your LinkedIn profile link first.';
  if (!LI.test(v)) return 'That isn’t a LinkedIn profile link. It should look like linkedin.com/in/your-name.';
  return null;
}
export const normaliseLinkedin = (raw: string) => {
  const v = raw.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
};
export const shortLinkedin = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

const SOURCE_NAME: Record<string, string> = {
  person_enrich: 'Crustdata person record',
  person_recent_moves: 'Crustdata job moves',
  job_search: 'Crustdata job search',
  company_enrich: 'Crustdata company record',
  company_search: 'Crustdata company search',
};

/** "Crustdata job moves" or the news site's host ("thenextweb.com"). */
export function sourceName(e: Evidence): string {
  if (e.source.provider !== 'crustdata' && e.source.url) {
    try { return new URL(e.source.url).host.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  return SOURCE_NAME[e.source.endpoint] ?? (e.source.provider === 'crustdata' ? 'Crustdata' : e.source.endpoint);
}

/** "retrieved 22 Nov, 14:31" */
export function retrievedLine(e: Evidence): string {
  const t = fmtTime(e.retrievedAt);
  return `retrieved ${fmtDate(e.retrievedAt)}${t ? `, ${t}` : ''}`;
}

export const findEvidence = (rows: Evidence[], id: string | null | undefined) => (id ? rows.find((r) => r.id === id) ?? null : null);
