// Evidence drawer model: every source card is derived from the real stream (RunSnapshot.evidence plus the
// claim.unverifiable, source.read and tool.fallback events). Nothing here invents a field: when the stream does
// not carry something (a reason, a signal, a URL), the card simply leaves it out.
import type { DataMode, Evidence, RunSnapshot, SourceItem, StoredEvent } from '../../../../shared/types.ts';
import type { Selection } from '../../centrepiece/contract.ts';

export type CardState = 'verified' | 'cached' | 'unverifiable';

export interface SourceCard {
  key: string;
  ev: Evidence | null;          // null for a claim.unverifiable / draft-excluded claim with no evidence row
  state: CardState;
  claim: string;
  date: string | null;          // fact date (observedAt)
  reason: string | null;        // why it can't be verified (only for 'unverifiable')
  signal: string | null;        // what DOMINO took from it: source.read item signal, else the atomic value
  read: { query: string; endpoint: string; total: number | null; count: number } | null; // the source.read call it came from
  fallback: { from: DataMode; to: DataMode; reason: string } | null;                       // tool.fallback on that endpoint
  marker: number | null;        // citation marker in the draft, if cited
}

const PROVIDER: Record<Evidence['source']['provider'], string> = {
  crustdata: 'Crustdata', web: 'Web', seller_profile: 'Your seller profile', derived: 'Derived by DOMINO',
};
const ENDPOINT: Record<string, string> = {
  '/job/search': 'Job search', '/person/search': 'People search', '/person/enrich': 'Person enrich',
  '/company/search': 'Company search', '/company/enrich': 'Company enrich', '/company/posts': 'Company posts',
  '/web/search': 'Web search', 'config/seller.json': 'seller.json',
};

export function providerLabel(ev: Evidence) { return PROVIDER[ev.source.provider] ?? ev.source.provider; }
export function endpointLabel(endpoint: string) {
  if (ENDPOINT[endpoint]) return ENDPOINT[endpoint];
  const words = endpoint.replace(/^\/+/, '').replace(/[/_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : endpoint;
}
const norm = (endpoint: string) => endpoint.replace(/^\/+/, '').replace(/\//g, '_');

/** Reason text for an evidence row that is not verifiable, from its own fields only. */
function rowReason(ev: Evidence): string {
  if (!ev.observedAt) return 'The record carries no date for this fact, so it cannot count as a dated signal.';
  if (!ev.source.url && !ev.source.recordId) return 'No record or URL backs this fact.';
  return 'Marked unverifiable by the source check.';
}

export interface StreamIndex {
  itemsByUrl: Map<string, { item: SourceItem; read: SourceCard['read'] }>;
  unverifiableByCompany: Map<string, { claim: string; reason: string }[]>;
  fallbackByEndpoint: Map<string, SourceCard['fallback']>;
  sourceReads: number;
}

export function indexStream(events: StoredEvent[]): StreamIndex {
  const itemsByUrl: StreamIndex['itemsByUrl'] = new Map();
  const unverifiableByCompany: StreamIndex['unverifiableByCompany'] = new Map();
  const fallbackByEndpoint: StreamIndex['fallbackByEndpoint'] = new Map();
  let sourceReads = 0;
  for (const { event } of events) {
    if (event.type === 'source.read') {
      sourceReads += 1;
      const read = { query: event.query, endpoint: event.endpoint, total: event.totalAvailable, count: event.items.length };
      for (const item of event.items) if (item.url) itemsByUrl.set(item.url, { item, read });
    } else if (event.type === 'claim.unverifiable') {
      const list = unverifiableByCompany.get(event.companyId) ?? [];
      list.push({ claim: event.claim, reason: event.reason });
      unverifiableByCompany.set(event.companyId, list);
    } else if (event.type === 'tool.fallback') {
      fallbackByEndpoint.set(norm(event.endpoint), { from: event.from, to: event.to, reason: event.reason });
    }
  }
  return { itemsByUrl, unverifiableByCompany, fallbackByEndpoint, sourceReads };
}

function cardFor(ev: Evidence, idx: StreamIndex, markers: Map<string, number>, reasons: Map<string, string>): SourceCard {
  const hit = ev.source.url ? idx.itemsByUrl.get(ev.source.url) : undefined;
  const fallback = idx.fallbackByEndpoint.get(norm(ev.source.endpoint)) ?? null;
  const unverifiable = !ev.verifiable || !ev.observedAt;
  return {
    key: ev.id, ev, claim: ev.claim, date: ev.observedAt,
    state: unverifiable ? 'unverifiable' : ev.mode === 'cache' ? 'cached' : 'verified',
    reason: unverifiable ? reasons.get(ev.claim) ?? rowReason(ev) : null,
    signal: hit?.item.signal ?? (ev.value != null && ev.value !== '' ? String(ev.value) : null),
    read: hit?.read ?? null, fallback, marker: markers.get(ev.id) ?? null,
  };
}

// Cited sources lead (in marker order: what the draft rests on), then newest fact first.
// Order: sources the draft cites (marker order), then sources on the cascade line into this node, then newest first.
const order = (lead: Set<string>) => (a: SourceCard, b: SourceCard) =>
  (a.marker ?? Infinity) - (b.marker ?? Infinity)
  || Number(lead.has(b.key)) - Number(lead.has(a.key))
  || (b.date ?? '').localeCompare(a.date ?? '');

export interface DrawerModel {
  kept: SourceCard[];
  lead: Set<string>;            // evidence ids on the cascade line into the selected node
  excluded: SourceCard[];
  modes: Map<DataMode, number>;
}

export function buildCards(snap: RunSnapshot, idx: StreamIndex, selection: Selection | null): DrawerModel {
  const byId = new Map(snap.evidence.map((e) => [e.id, e]));
  let ids: string[] = [];
  let companyId: string | null = null;
  let markers = new Map<string, number>();
  let claims: { claim: string; reason: string }[] = [];
  const lead = new Set<string>();

  if (!selection) ids = snap.evidence.map((e) => e.id);
  else if (selection.kind === 'edge') ids = snap.graph.edges.find((e) => e.id === selection.id)?.evidenceIds ?? [];
  else if (selection.kind === 'evidence') ids = [selection.id];
  else {
    companyId = selection.id;
    const n = snap.graph.nodes.find((x) => x.id === selection.id);
    const t = snap.targets.find((x) => x.companyId === selection.id);
    const d = snap.drafts.find((x) => x.companyId === selection.id);
    ids = [...(n?.evidenceIds ?? []), ...(t?.decider?.evidenceIds ?? []), ...(d?.citations.map((c) => c.evidenceId) ?? [])];
    markers = new Map(d?.citations.map((c) => [c.evidenceId, c.marker]) ?? []);
    claims = [...(idx.unverifiableByCompany.get(selection.id) ?? []), ...(d?.unverifiable ?? [])];
    for (const e of snap.graph.edges) if (e.to === selection.id) for (const id of e.evidenceIds) lead.add(id);
  }
  if (!selection) for (const list of idx.unverifiableByCompany.values()) claims.push(...list);

  const reasons = new Map(claims.map((c) => [c.claim, c.reason]));
  const rows = [...new Set(ids)].map((id) => byId.get(id)).filter((e): e is Evidence => !!e);
  const cards = rows.map((ev) => cardFor(ev, idx, markers, reasons));
  const kept = cards.filter((c) => c.state !== 'unverifiable').sort(order(lead));
  const excluded = cards.filter((c) => c.state === 'unverifiable');

  // Excluded claims that have no evidence row of their own still get a card: never hidden.
  const seen = new Set(excluded.map((c) => c.claim));
  for (const c of claims) {
    if (seen.has(c.claim)) continue;
    seen.add(c.claim);
    excluded.push({ key: `claim-${companyId ?? 'all'}-${excluded.length}`, ev: null, state: 'unverifiable', claim: c.claim, date: null,
      reason: c.reason, signal: null, read: null, fallback: null, marker: null });
  }
  const modes = new Map<DataMode, number>();
  for (const r of rows) modes.set(r.mode, (modes.get(r.mode) ?? 0) + 1);
  return { kept, lead, excluded, modes };
}

/** One truthful sentence about where these rows came from. Shown once, never as a per-card "Live" badge. */
export function modeLine(modes: Map<DataMode, number>, cacheFetchedAt: string | null): { mode: DataMode | 'mixed' | 'none'; text: string } {
  const present = [...modes.keys()];
  if (!present.length) return { mode: 'none', text: 'No source rows yet.' };
  if (present.length > 1) {
    const parts = present.map((m) => `${modes.get(m)} ${m === 'live' ? 'live' : m === 'cache' ? 'cached' : 'fixture'}`);
    return { mode: 'mixed', text: `Mixed data: ${parts.join(', ')} rows.` };
  }
  const m = present[0];
  if (m === 'fixture') return { mode: m, text: 'Fixture data. Synthetic companies and records, not live Crustdata.' };
  if (m === 'cache') return { mode: m, text: `Cached Crustdata records${cacheFetchedAt ? `, fetched ${cacheFetchedAt.slice(0, 10)}` : ''}. Not re-fetched this run.` };
  return { mode: m, text: 'Live Crustdata records, fetched during this run.' };
}
