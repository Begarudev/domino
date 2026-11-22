import type { CentrepieceModule, CentrepieceProps } from '../contract.ts';
import { TalentFlow } from './TalentFlow.tsx';
import { FIXTURE_LAYOUT } from './fixture.ts';

/** Talent-flow time-lapse: job moves fly between companies, drains crack the losing company, predictions snap solid. */
export const flowCentrepiece: CentrepieceModule = {
  id: 'flow',
  label: 'Talent flow',
  // Composed positions for the fictional demo world (fixture and web mock share ids); any other company gets the force layout.
  Component: (props: CentrepieceProps) => <TalentFlow {...props} layoutHints={FIXTURE_LAYOUT} />,
};

export { TalentFlow } from './TalentFlow.tsx';
export { buildModel } from './model.ts';
export { FIXTURE_SNAPSHOT, FIXTURE_LAYOUT } from './fixture.ts';
