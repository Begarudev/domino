// FEATURE: Predicted needs + verifier (dated source or "I can't verify"; Held cards such as the Poolside acqui-hire).
// Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Needs({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title="Predicted needs">What {desk.company.name} likely needs, every claim with its dated source.</Placeholder>;
}
