// A small keyed query cache for the desk API. Data keeps its identity until refetched, so panels don't re-render
// on unrelated changes; a refetch keeps showing the previous data (no empty-state flash).
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createDeskApi } from './desk.ts';
import type { Provenance, Sourced } from './desk.ts';
import { runStore } from './store.ts';

export const deskApi = createDeskApi({ fixtureOnly: runStore.get().mode !== 'live' });

export interface QueryState<T> {
  data: T | null;
  source: Provenance | null;
  error: string | null;
  loading: boolean;
  evidence: Sourced<T>['evidence'];
}

const cache = new Map<string, QueryState<unknown>>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const EMPTY: QueryState<never> = { data: null, source: null, error: null, loading: true, evidence: [] };

/** Everything every query has reported, for the top bar's data pill. */
export function allSources(): Provenance[] {
  return [...cache.values()].map((q) => q.source).filter((s): s is Provenance => !!s);
}

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) { const q = cache.get(k)!; cache.set(k, { ...q, loading: true }); }
  emit();
  for (const [k, load] of loaders) if (k.startsWith(prefix)) void run(k, load);
}

const loaders = new Map<string, () => Promise<Sourced<unknown>>>();

async function run(key: string, load: () => Promise<Sourced<unknown>>) {
  if (inflight.has(key)) return inflight.get(key);
  const p = load().then(
    (r) => { cache.set(key, { data: r.data, source: r.source, error: null, loading: false, evidence: r.evidence }); },
    (e: Error) => { const prev = cache.get(key) ?? EMPTY; cache.set(key, { ...prev, error: e.message, loading: false }); },
  ).finally(() => { inflight.delete(key); emit(); });
  inflight.set(key, p);
  return p;
}

export function useQuery<T>(key: string | null, load: () => Promise<Sourced<T>>): QueryState<T> & { refetch: () => void } {
  const state = useSyncExternalStore(
    (f) => { listeners.add(f); return () => { listeners.delete(f); }; },
    () => (key ? (cache.get(key) as QueryState<T> | undefined) ?? (EMPTY as QueryState<T>) : (EMPTY as QueryState<T>)),
  );
  useEffect(() => {
    if (!key) return;
    loaders.set(key, load as () => Promise<Sourced<unknown>>);
    if (!cache.has(key)) void run(key, load as () => Promise<Sourced<unknown>>);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const refetch = useCallback(() => { if (key) invalidate(key); }, [key]);
  return { ...state, refetch };
}

export function useSourcesVersion(): Provenance[] {
  return useSyncExternalStore(
    (f) => { listeners.add(f); return () => { listeners.delete(f); }; },
    () => sourcesSnapshot(),
  );
}
let lastSources: Provenance[] = [];
function sourcesSnapshot() {
  const next = allSources();
  if (next.length === lastSources.length && next.every((s, i) => s === lastSources[i])) return lastSources;
  lastSources = next;
  return next;
}
