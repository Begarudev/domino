import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { RunSnapshot, StoredEvent } from '../../shared/types.ts';
import type { Backend, StartRequest } from './api.ts';
import { emptySnapshot, initialState, uiReducer } from './state.ts';

export function useRun(backend: Backend | null) {
  const [state, dispatch] = useReducer(uiReducer, undefined, () => initialState(emptySnapshot('', '')));
  const [runId, setRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const unsub = useRef<(() => void) | null>(null);
  const refetch = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attach = useCallback(async (id: string) => {
    if (!backend) return;
    unsub.current?.();
    setError(null);
    let snap: RunSnapshot;
    try {
      snap = await backend.loadRun(id);
    } catch (e) {
      setError(`Could not load run ${id}: ${(e as Error).message}`);
      return;
    }
    dispatch({ type: 'reset', snap });
    setRunId(id);
    const url = new URL(location.href);
    url.searchParams.set('run', id);
    if (backend.mock) url.searchParams.delete('run');
    history.replaceState(null, '', url);
    unsub.current = backend.subscribe(id, 0, (events: StoredEvent[]) => {
      dispatch({ type: 'events', events });
      // The server snapshot stays authoritative: re-fetch it whenever the run changes status.
      if (!backend.mock && events.some((e) => e.event.type === 'run.status' || e.event.type === 'step.completed')) {
        if (refetch.current) clearTimeout(refetch.current);
        refetch.current = setTimeout(() => {
          backend.loadRun(id).then((s) => dispatch({ type: 'snapshot', snap: s })).catch(() => {});
        }, 250);
      }
    }, setConnected);
  }, [backend]);

  useEffect(() => () => unsub.current?.(), []);

  const start = useCallback(async (req: StartRequest) => {
    if (!backend) return;
    try {
      const { id } = await backend.startRun(req);
      await attach(id);
    } catch (e) {
      setError(`Could not start the run: ${(e as Error).message}`);
    }
  }, [backend, attach]);

  return { state, dispatch, runId, connected, error, setError, start, attach };
}

export function useReducedMotion() {
  const [rm, setRm] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setRm(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return rm;
}

export function useSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
