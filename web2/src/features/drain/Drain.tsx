// FEATURE 3b: talent-drain monitor (who left, for where, when: role + initial + date, never a full name).
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Drain({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title={`${desk.departures.length} departures in 90 days`}>Who left, for where, and when.</Placeholder>;
}
