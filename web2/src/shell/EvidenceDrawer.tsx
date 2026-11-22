// One way to open a source anywhere in v2: call openEvidence(evidenceId). The drawer leads with the fact date and
// the claim, then a readable source line, then the technical detail (endpoint, record, retrieved time, call mode).
import { useEffect } from 'react';
import { findEvidence } from '../data/query.ts';
import { useRunSel } from '../data/store.ts';
import { fmtDate, fmtTime } from '../lib/format.ts';
import { closeEvidence, useShell } from './ui.ts';
import { isMonthLevel } from '../data/desk.ts';

const ENDPOINT_PLAIN: Record<string, string> = {
  person_recent_moves: 'Crustdata job moves', job_search: 'Crustdata job search', company_enrich: 'Crustdata company record',
  company_growth: 'Crustdata growth record', person_enrich: 'Crustdata person record', web_search: 'News search',
  company_posts: 'Company posts', person_search: 'Crustdata people search',
};

export function sourceName(endpoint: string, provider?: string): string {
  const k = endpoint.replace(/^\//, '').replace(/\//g, '_');
  return ENDPOINT_PLAIN[k] ?? (provider === 'web' ? 'Web source' : `Crustdata ${k.replace(/_/g, ' ')}`);
}

export function EvidenceDrawer() {
  const id = useShell((s) => s.evidenceId);
  const runEvidence = useRunSel((v) => v.ui.snap.evidence);
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeEvidence(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);
  if (!id) return null;
  const ev = findEvidence(id, runEvidence);
  // A month-precision row (flagged by the source or its claim) shows its month, never a day ("Oct 2026", not "31 Oct").
  const monthly = !!ev && (isMonthLevel(ev.observedAt) || (ev as { precision?: string }).precision === 'month' || /month precision/i.test(ev.claim));
  return (
    <div className="ev-scrim" onClick={closeEvidence}>
      <aside className="ev-drawer" role="dialog" aria-label="Source" data-testid="evidence-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="btn small ev-close" onClick={closeEvidence} aria-label="Close source">Close</button>
        {!ev ? (
          <p className="ev-claim">This source isn’t loaded on this screen. It’s in the run’s evidence list (id {id}).</p>
        ) : (
          <>
            <div className="ev-date">
              {ev.observedAt ? fmtDate(monthly ? ev.observedAt.slice(0, 7) : ev.observedAt, true) : 'Undated'}
              {monthly && <span className="tag">month-level date</span>}
              {!ev.verifiable && <span className="tag warn">I can’t verify</span>}
            </div>
            <p className="ev-claim">{ev.claim}</p>
            <p className="ev-source">{sourceName(ev.source.endpoint, ev.source.provider)}{ev.value != null && ev.value !== '' ? `, value ${String(ev.value)}` : ''}</p>
            <dl className="ev-meta">
              <dt>Retrieved</dt><dd>{fmtDate(ev.retrievedAt, true)}, {fmtTime(ev.retrievedAt)}</dd>
              <dt>Call</dt><dd>{ev.mode === 'cache' ? 'cached live response' : ev.mode === 'fixture' ? 'fixture (labelled)' : 'live'}</dd>
              <dt>Endpoint</dt><dd>{ev.source.endpoint}{ev.source.recordId ? `, record ${ev.source.recordId}` : ''}</dd>
              {ev.source.url && <><dt>Link</dt><dd><a href={ev.source.url} target="_blank" rel="noreferrer">{ev.source.url.replace(/^https?:\/\//, '')}</a></dd></>}
            </dl>
          </>
        )}
      </aside>
    </div>
  );
}
