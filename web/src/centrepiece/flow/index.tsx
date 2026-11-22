import type { CentrepieceModule, CentrepieceProps } from '../contract.ts';
import { TalentFlow } from './TalentFlow.tsx';

/** Talent-flow time-lapse: job moves fly between companies, drains crack the losing company, predictions snap solid. */
export const flowCentrepiece: CentrepieceModule = {
  id: 'flow',
  label: 'Talent flow',
  Component: (props: CentrepieceProps) => <TalentFlow {...props} />,
};

export { TalentFlow } from './TalentFlow.tsx';
export { buildModel } from './model.ts';
export { FIXTURE_SNAPSHOT, FIXTURE_LAYOUT } from './fixture.ts';
