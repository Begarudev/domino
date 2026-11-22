// FEATURE 5: outreach (sourced intro draft sentence by sentence -> human approval -> delivered ONCE to the team
// inbox; a retry shows "already delivered, skipped"; kill and resume). Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Outreach({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title="Outreach">Sourced intro draft for {desk.company.name}, approval and send-once.</Placeholder>;
}
