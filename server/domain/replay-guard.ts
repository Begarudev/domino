import type { Evidence, IsoDate } from '../../shared/types.ts';
import { shiftDays } from './facts.ts';

export const PROFILE_LAG_DAYS = 30;

export interface ProfileEvidence extends Evidence {
  profileRoleStartedAt?: IsoDate;
}

export function evidenceKnownAt(row: ProfileEvidence, asOf: IsoDate): boolean {
  if (!row.observedAt || row.observedAt > asOf) return false;
  const start = row.profileRoleStartedAt ?? (
    row.source.provider === 'crustdata' && /(?:person\/search|person_recent_moves|person_deciders)/.test(row.source.endpoint)
    && /\.start_date\b/.test(row.source.field ?? '') ? row.observedAt : undefined
  );
  return !start || start <= shiftDays(asOf, -PROFILE_LAG_DAYS);
}

export function filterAsOf(evidence: Evidence[], asOf: IsoDate): { kept: Evidence[]; dropped: number } {
  const kept = evidence.filter(row => evidenceKnownAt(row, asOf));
  return { kept, dropped: evidence.length - kept.length };
}
