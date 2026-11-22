// FEATURE: Cross-company chains (R1 talent drain, CONTAGION, DISPLACEMENT, the watchlist "2 of 3"). Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Chains({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title="Cross-company chains">How a move at one company creates a need at {desk.company.name}, edge by edge.</Placeholder>;
}
