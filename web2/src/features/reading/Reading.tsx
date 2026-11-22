// FEATURE: Reading desk (live news, job posts and company pages as dated cards with the extracted signal, from
// source.read events). Replace this placeholder.
import type { CompanyDesk } from '../../data/desk.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function Reading({ desk }: { desk: CompanyDesk }) {
  return <Placeholder title="Reading desk">Dated cards for what the agent read about {desk.company.name} and its peers.</Placeholder>;
}
