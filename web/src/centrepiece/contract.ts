import type { JSX } from 'react';
import type { RunSnapshot, StoredEvent } from '../../../shared/types.ts';

export type Selection =
  | { kind: 'node'; id: string }        // GraphNode.id (company id)
  | { kind: 'edge'; id: string }        // GraphEdge.id
  | { kind: 'target'; id: string }      // Target.companyId
  | { kind: 'evidence'; id: string };   // Evidence.id

export interface CentrepieceProps {
  snapshot: RunSnapshot;                // reduced live state (graph, targets, evidence, replay, ...)
  events: StoredEvent[];                // every event so far, in seq order (for time-lapse / animation)
  running: boolean;                     // engine is working right now
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;   // opens the evidence drawer
  hiringFilterView: boolean;            // dim everything a plain hiring filter would also find
  reducedMotion: boolean;
  width: number;                        // slot size in CSS px (about 780 x 540 at 1440 x 900)
  height: number;
  replayToken: number;                  // increments when the user presses "Replay cascade"
}

export interface CentrepieceModule {
  id: string;                           // 'table' | 'physical' | 'flow' | 'mission'
  label: string;
  Component: (props: CentrepieceProps) => JSX.Element;
}
