import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DataMode, Evidence, GraphEdge, GraphNode, RunSnapshot } from '../../../shared/types.ts';
import type { Selection } from '../centrepiece/contract.ts';
import { MECH_LABEL } from '../centrepiece/table/TableCentrepiece.tsx';
import { fmtDate, fmtTime } from '../dates.ts';

const MODE_TEXT: Record<DataMode, string> = { live: 'Live', cache: 'Cached', fixture: 'Fixture' };

export function EvidenceRow(props: { ev: Evidence; highlight: boolean; marker?: number; onRecheck: (ev: Evidence) => Promise<void> }) {
  const { ev, highlight } = props;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const undated = !ev.verifiable || !ev.observedAt;
  return (
    <li id={`ev-${ev.id}`} className={`ev${highlight ? ' is-hl' : ''}${undated ? ' is-undated' : ''}`}>
      <div className="ev-date">
        {undated ? <span className="ev-cant">Undated, can't verify</span> : <span className="ev-observed">{fmtDate(ev.observedAt, { year: true })}</span>}
        <span className={`mode mode-${ev.mode}`}>{MODE_TEXT[ev.mode]}</span>
        {props.marker != null && <span className="cite-chip static">{props.marker}</span>}
      </div>
      <p className="ev-claim">{ev.claim}</p>
      {ev.value != null && ev.value !== '' && <p className="ev-value">Value <b>{String(ev.value)}</b></p>}
      <p className="ev-source">
        <span className="ev-endpoint">{ev.source.provider === 'crustdata' ? 'Crustdata ' : ev.source.provider === 'web' ? 'Web ' : ''}{ev.source.endpoint}</span>
        {ev.source.field && <span className="ev-field">{ev.source.field}</span>}
      </p>
      <div className="ev-foot">
        <span className={`ev-retrieved${checked ? ' is-fresh' : ''}`}>Retrieved {fmtDate(ev.retrievedAt.slice(0, 10))} {fmtTime(ev.retrievedAt)}</span>
        {ev.source.url && <a href={ev.source.url} target="_blank" rel="noreferrer noopener">Source</a>}
        <button
          type="button" className="btn btn-quiet btn-xs" disabled={checking}
          onClick={async () => { setChecking(true); await props.onRecheck(ev).finally(() => setChecking(false)); setChecked(true); }}
        >{checking ? 'Checking' : checked ? 'Checked' : 'Re-check'}</button>
      </div>
    </li>
  );
}

function conclusionNode(n: GraphNode, snap: RunSnapshot) {
  const t = snap.targets.find((x) => x.companyId === n.id);
  return { title: n.name, need: n.need, conf: n.confidence, mechanisms: n.mechanisms, netNew: n.netNew, status: n.status, target: t };
}

function edgeEvidenceText(e: GraphEdge, rows: Evidence[]) {
  const dated = rows.filter((r) => r.verifiable && r.observedAt);
  const undated = rows.length - dated.length;
  const latest = dated.map((r) => r.observedAt!).sort().at(-1);
  return `Confidence ${Math.round(e.confidence * 100)}% rests on ${dated.length} dated row${dated.length === 1 ? '' : 's'}${undated ? ` and ${undated} undated (not counted)` : ''}${latest ? `, latest ${fmtDate(latest)}` : ''}. A rule fires only on two or more dated rows.`;
}

export function EvidenceDrawer(props: {
  snap: RunSnapshot; selection: Selection | null; hoverEvidence: string | null; onRecheck: (ev: Evidence) => Promise<void>; onSelect: (s: Selection | null) => void;
}) {
  const { snap, selection } = props;
  const byId = new Map(snap.evidence.map((e) => [e.id, e]));
  const rowsFor = (ids: string[]) => [...new Set(ids)].map((id) => byId.get(id)).filter((e): e is Evidence => !!e)
    .sort((a, b) => (a.observedAt ? 0 : 1) - (b.observedAt ? 0 : 1) || (b.observedAt ?? '').localeCompare(a.observedAt ?? ''));
  const name = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? snap.graph.nodes.find((n) => n.id === id)?.name ?? id;

  let head: ReactNode = null;
  let rows: Evidence[] = [];
  let markers = new Map<string, number>();

  if (selection?.kind === 'edge') {
    const e = snap.graph.edges.find((x) => x.id === selection.id);
    if (e) {
      rows = rowsFor(e.evidenceIds);
      head = (
        <div className="drawer-head">
          <p className="drawer-kind">{MECH_LABEL[e.mechanism]}, {name(e.from)} to {name(e.to)}</p>
          <h3>{e.label}</h3>
          <p className="drawer-text">{e.rationale}</p>
          {e.alternative && (
            <div className="drawer-alt"><span>Could also mean</span><p>{e.alternative}</p></div>
          )}
          <p className="drawer-formula">{edgeEvidenceText(e, rows)}</p>
        </div>
      );
    }
  } else if (selection?.kind === 'node' || selection?.kind === 'target') {
    const n = snap.graph.nodes.find((x) => x.id === selection.id);
    const t = snap.targets.find((x) => x.companyId === selection.id);
    const draft = snap.drafts.find((d) => d.companyId === selection.id);
    const company = snap.companies.find((c) => c.id === selection.id);
    const ids = [...(n?.evidenceIds ?? []), ...(t?.decider?.evidenceIds ?? []), ...(draft?.citations.map((c) => c.evidenceId) ?? [])];
    rows = rowsFor(ids);
    markers = new Map(draft?.citations.map((c) => [c.evidenceId, c.marker]) ?? []);
    const c = n ? conclusionNode(n, snap) : null;
    const incoming = snap.graph.edges.filter((e) => e.to === selection.id);
    head = (
      <div className="drawer-head">
        <p className="drawer-kind">
          {c?.status === 'unverifiable' ? "Hypothesis, can't verify" : t ? `Target ${t.rank}` : c?.conf == null ? 'Trigger company' : 'Hypothesis'}
          {company && company.aliases.length > 1 ? `, also seen as ${company.aliases.filter((a) => a !== company.name).join(', ')}` : ''}
        </p>
        <h3>{c?.title ?? name(selection.id)}</h3>
        {(t?.need ?? c?.need) && <p className="drawer-text">{t?.need ?? c?.need}{c?.conf != null && <>, <b className="num">{Math.round((t?.confidence ?? c.conf) * 100)}%</b> confidence</>}</p>}
        {t?.whyNow && <p className="drawer-text">Why now: {t.whyNow}{t.whyNowDate ? `, ${fmtDate(t.whyNowDate)}` : ''}</p>}
        {incoming.map((e) => (
          <button key={e.id} type="button" className="drawer-link" onClick={() => props.onSelect({ kind: 'edge', id: e.id })}>
            {MECH_LABEL[e.mechanism]} from {name(e.from)}: {e.label}
          </button>
        ))}
        {t?.decider === null && <p className="drawer-warn">No decider found. I can't verify who decides here.</p>}
      </div>
    );
  } else if (selection?.kind === 'evidence') {
    rows = rowsFor([selection.id]);
    head = <div className="drawer-head"><p className="drawer-kind">Cited evidence</p></div>;
  } else {
    rows = rowsFor(snap.evidence.map((e) => e.id));
  }

  const undated = rows.filter((r) => !r.verifiable || !r.observedAt).length;

  return (
    <section className="panel drawer" aria-label="Evidence">
      <header className="panel-head">
        <h2>Evidence</h2>
        {selection && <button type="button" className="btn btn-quiet btn-xs" onClick={() => props.onSelect(null)}>Show all</button>}
      </header>
      <div className="panel-scroll">
        {head}
        {!selection && snap.evidence.length > 0 && <p className="drawer-hint">Select a tile, a line or a citation to see what it rests on.</p>}
        {rows.length > 0 && (
          <p className="drawer-count"><b>{rows.length - undated}</b> dated{undated ? <>, <span className="amber"><b>{undated}</b> can't verify</span></> : null}</p>
        )}
        {rows.length === 0 && !head && <p className="empty">Every claim DOMINO makes lands here with its date, source endpoint and field.</p>}
        <ul className="ev-list">
          {rows.map((ev) => (
            <EvidenceRow key={ev.id} ev={ev} highlight={props.hoverEvidence === ev.id} marker={markers.get(ev.id)} onRecheck={props.onRecheck} />
          ))}
        </ul>
      </div>
    </section>
  );
}
