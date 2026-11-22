// Rules registry: every rule with its statement, thresholds, guards, lock time and today's live fire counts. OWNER: lead.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RuleCard } from '../../shared/desk.ts';
import type { RunSnapshot } from '../../shared/types.ts';
import type { Store } from '../db.ts';
import { root } from '../env.ts';
import { snapshot } from '../snapshot.ts';
import { latestOpeningsRunId, openingsSnapshot } from './store.ts';

const guards = [
  'Acquisition / acqui-hire (dated news, acquirer = destination)', 'Shared parent / same group', 'More than 40% of headcount moving',
  'Ambiguous company id', 'Month-level date straddles the window', 'Unrecognised titles', 'Possible restructure (headcount down >10% / 90 days)',
];

function latestAnalysis(store: Store): RunSnapshot | null {
  const row = store.sql.prepare(`SELECT id FROM runs WHERE coalesce(pipeline, 'outbound') = 'outbound'
    AND status IN ('completed', 'awaiting_approval') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { id: string } | undefined;
  return row ? snapshot(store, row.id) : null;
}

export function rulesRegistry(store: Store): RuleCard[] {
  const scanId = latestOpeningsRunId(store);
  const scan = openingsSnapshot(store, scanId);
  const openings = scan?.openings ?? [];
  const count = (status: string, provisional?: boolean) => openings.filter(row => row.status === status &&
    (provisional === undefined || Boolean(row.provisional) === provisional)).length;
  const analysis = latestAnalysis(store);
  const targets = analysis?.targets ?? [];
  const edges = analysis?.graph.edges ?? [];
  const by = (mechanism: string) => targets.filter(target => target.mechanisms.includes(mechanism as never));
  const sellerFile = resolve(root, 'config/seller.json');
  const events = existsSync(sellerFile)
    ? ((JSON.parse(readFileSync(sellerFile, 'utf8')).displacementEvents ?? []) as { fixtureOnly?: boolean }[]).filter(event => !event.fixtureOnly).length : 0;
  return [
    { id: 'O1', name: 'Predicted opening', sourceRunId: scanId,
      statement: 'At a company with 20–5,000 staff: ≥ 2 conclusive dated departures in one role family within 90 days, and no dated replacement job post or hire for that family within 30 days of the last departure.',
      thresholds: ['≥ 2 departures in 90 days', 'no replacement post or hire within 30 days', '20–5,000 staff', 'month-level dates as intervals'],
      guards, lockedAt: '22 Nov 2026 14:08 IST, after seeing live departure counts and before any replay outcome; month intervals 14:14 IST',
      // Same split as the funnel: 'watch' counts groups with 2+ departures whose check couldn't be verified; the
      // watchlist is companies short of the threshold (1 departure so far, or a month on the window edge).
      counts: [{ label: 'open', value: count('open', false) }, { label: 'provisional', value: count('open', true) },
        { label: 'held', value: count('held') },
        { label: 'watch (check unverified)', value: openings.filter(row => row.status === 'watch' && (row.watch?.have ?? 0) >= 2).length },
        { label: 'watchlist (under 2 departures)', value: openings.filter(row => row.status === 'watch' && (row.watch?.have ?? 0) < 2).length }] },
    { id: 'R1', name: 'Talent drain (cross-company)', sourceRunId: analysis?.id ?? null,
      statement: 'Company A loses ≥ 3 conclusive dated infra/serving engineers in 90 days, the 3rd inside the last 30 days; A needs serving capacity it cannot rebuild in-house fast.',
      thresholds: ['≥ 3 departures in 90 days', '3rd within 30 days', 'A ≤ 5,000 staff', 'previous role infra/serving'],
      guards, lockedAt: '22 Nov 2026 13:40 IST, before any replay outcome; threshold kept at 3 after the live yield check',
      counts: [{ label: 'fired', value: by('TALENT_DRAIN').filter(target => !target.hold && !target.watch).length },
        { label: 'watchlist (2 of 3)', value: by('TALENT_DRAIN').filter(target => target.watch).length },
        { label: 'held', value: by('TALENT_DRAIN').filter(target => target.hold).length }] },
    { id: 'CONTAGION', name: 'Peer contagion', sourceRunId: analysis?.id ?? null,
      statement: 'A listed peer of B made a dated infrastructure move (≥ 2 dated rows); B has the same profile and no infra hiring yet.',
      thresholds: ['≥ 2 dated rows at the peer', 'at most 3 peers', 'giants and staffing firms excluded'], guards: [],
      lockedAt: '22 Nov 2026 13:40 IST', counts: [{ label: 'edges', value: edges.filter(edge => edge.mechanism === 'CONTAGION').length },
        { label: 'accounts', value: by('CONTAGION').length }] },
    { id: 'DISPLACEMENT', name: 'Provider displacement', sourceRunId: analysis?.id ?? null,
      statement: 'A provider was acquired, shut down or repriced (dated, sourced event); companies whose dated job posts name its product must migrate.',
      thresholds: ['dated provider event with a public source', 'dated job post naming the product'], guards: [],
      lockedAt: '22 Nov 2026 13:40 IST', counts: [{ label: 'configured events', value: events },
        { label: 'edges', value: edges.filter(edge => edge.mechanism === 'DISPLACEMENT').length }, { label: 'accounts', value: by('DISPLACEMENT').length }] },
    { id: 'DIRECT', name: 'First-order baseline (hiring filter)', sourceRunId: analysis?.id ?? null,
      statement: 'The company itself posts serving or infrastructure roles. Kept as the baseline every cross-company rule is compared with.',
      thresholds: ['≥ 2 dated relevant job posts'], guards: [], lockedAt: '22 Nov 2026 13:40 IST',
      counts: [{ label: 'accounts', value: by('DIRECT').length }] },
  ];
}
