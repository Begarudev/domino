// Registers mission control in the centrepiece slot: `?centre=mission`.
import type { CentrepieceModule } from '../contract.ts';
import { MissionControl } from './MissionControl.tsx';

export const missionModule: CentrepieceModule = {
  id: 'mission',
  label: 'Mission control',
  Component: MissionControl,
};

export { MissionControl };
export type { MissionControls } from './MissionControl.tsx';
