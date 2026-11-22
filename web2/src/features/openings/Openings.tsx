// FEATURE 3a: predicted openings for one company (role, why, dated evidence, status open/provisional/watch/held,
// the "how we got here" funnel). Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Openings({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title={`${desk.openings.length} predicted openings`}>Opening cards with dated reason chips and the funnel.</Placeholder>;
}
