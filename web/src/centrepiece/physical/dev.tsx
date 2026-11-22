// Standalone harness: the centrepiece full-screen (the video hero shot) or at slot size, with a sources drawer.
// URL: /wow-physical.html?mode=replay|live&size=full|slot&autoplay=1&filter=1&rm=1
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Selection } from '../contract.ts';
import type { RunSnapshot, Evidence } from '../../../../shared/types.ts';
import { PhysicalCentrepiece } from './index.tsx';
import { replayFixture, liveFixture } from './fixture.ts';
import { fmtFull } from './layout.ts';

const q = new URLSearchParams(location.search);

function useWindowSize() {
  const [s, set] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => { const f = () => set({ w: innerWidth, h: innerHeight }); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return s;
}

function Drawer({ snap, sel, onClose }: { snap: RunSnapshot; sel: Selection; onClose: () => void }) {
  const ev = useMemo(() => new Map(snap.evidence.map((e) => [e.id, e])), [snap]);
  let title = ''; let ids: string[] = []; let sub = '';
  if (sel.kind === 'node' || sel.kind === 'target') {
    const n = snap.graph.nodes.find((x) => x.id === sel.id); const c = snap.companies.find((x) => x.id === sel.id);
    title = n?.name ?? c?.name ?? sel.id;
    sub = n?.need ?? (snap.baseline.hiringFilterCompanyIds.includes(sel.id) ? 'Picked by the plain hiring filter' : '');
    const oc = snap.replay?.outcomes.filter((o) => o.companyId === sel.id) ?? [];
    ids = [...(n?.evidenceIds ?? c?.evidenceIds ?? []), ...oc.flatMap((o) => o.evidenceIds)];
  } else if (sel.kind === 'edge') {
    const e = snap.graph.edges.find((x) => x.id === sel.id);
    title = e ? `${e.label}` : sel.id; sub = e?.alternative ? `Could not rule out: ${e.alternative}` : '';
    ids = e?.evidenceIds ?? [];
  }
  const rows = [...new Set(ids)].map((i) => ev.get(i)).filter((x): x is Evidence => !!x);
  return (
    <aside style={{
      position: 'fixed', right: 16, top: 16, bottom: 16, width: 380, background: '#f1ebdc', color: '#262a2f', borderRadius: 10,
      padding: '18px 20px', overflow: 'auto', fontFamily: '"Schibsted Grotesk", sans-serif', boxShadow: '0 20px 60px rgba(0,0,0,.5)', zIndex: 50,
    }}>
      <button onClick={onClose} style={{ float: 'right', border: 0, background: 'transparent', fontSize: 15, cursor: 'pointer' }}>Close</button>
      <div style={{ fontFamily: '"Big Shoulders Display", sans-serif', fontWeight: 800, fontSize: 30, lineHeight: 1 }}>{title}</div>
      {sub && <div style={{ marginTop: 6, color: 'rgba(38,42,47,.7)' }}>{sub}</div>}
      <div style={{ marginTop: 14, fontWeight: 600 }}>Sources</div>
      {rows.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid rgba(38,42,47,.15)', padding: '10px 0', fontSize: 14, lineHeight: 1.35 }}>
          <div>{r.claim}</div>
          <div style={{ color: r.verifiable ? '#1f7f5b' : '#9a5f12', marginTop: 3 }}>{r.verifiable ? fmtFull(r.observedAt) : "I can't verify: no dated source"}</div>
          <div style={{ color: 'rgba(38,42,47,.6)', fontSize: 12.5, marginTop: 2 }}>
            Crustdata {r.source.endpoint}, field {r.source.field}. Retrieved {r.retrievedAt.slice(0, 16).replace('T', ' ')}. Mode: {r.mode}.
          </div>
        </div>
      ))}
    </aside>
  );
}

function App() {
  const { w, h } = useWindowSize();
  const snap = q.get('mode') === 'live' ? liveFixture : replayFixture;
  const slot = q.get('size') === 'slot';
  const [sel, setSel] = useState<Selection | null>(null);
  const [token, setToken] = useState(0);
  useEffect(() => { if (q.get('autoplay') === '1') setToken(1); }, []);
  const width = slot ? 780 : w; const height = slot ? 540 : h;
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <PhysicalCentrepiece
        snapshot={snap} events={[]} running={false} selection={sel} onSelect={setSel}
        hiringFilterView={q.get('filter') === '1'} reducedMotion={q.get('rm') === '1'}
        width={width} height={height} replayToken={token}
      />
      {sel && !q.get('nodrawer') && <Drawer snap={snap} sel={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
