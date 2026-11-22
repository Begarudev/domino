// FEATURE 5: Company analysis dossier (live news timeline from source.read, job posts, headcount and funding,
// talent flows in and out, cross-company chains incl. the watchlist, predicted needs with dated evidence and
// confidence, verified claims and "I can't verify"). Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Analysis({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title={`Company analysis: ${desk.company.name}`}>News, job posts, headcount and funding, talent flows, chains, predicted needs and verified claims.</Placeholder>;
}
