// FEATURE 4: matched candidates (platform opt-ins only; fit reasons cite consented profile fields + opening
// evidence; "I can't verify" items struck through). Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Matches({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title={`${desk.matches.length} matched candidates`}>Opt-in candidates with sourced fit reasons.</Placeholder>;
}
