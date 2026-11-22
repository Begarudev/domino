// Centrepiece modules. Pick one with ?centre=<id> (default 'table'). Rival modules register here.
import type { CentrepieceModule } from './contract.ts';
import { tableModule } from './table/TableCentrepiece.tsx';
import { missionModule } from './mission/index.ts';

export const CENTREPIECES: CentrepieceModule[] = [tableModule, missionModule];

export function pickCentrepiece(search: string = location.search): CentrepieceModule {
  const id = new URLSearchParams(search).get('centre') ?? 'table';
  return CENTREPIECES.find((m) => m.id === id) ?? CENTREPIECES[0];
}
