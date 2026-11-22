import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, LazyMotion, domAnimation, m } from 'motion/react';
import type { Evidence, GraphEdge, RunSnapshot, StoredEvent } from '../../../../shared/types.ts';
import type { Selection } from '../../centrepiece/contract.ts';
import { MECH_LABEL } from '../../centrepiece/table/TableCentrepiece.tsx';
import { fmtDate } from '../../dates.ts';
import { buildCards, endpointLabel, indexStream, modeLine, providerLabel } from './model.ts';
import type { SourceCard } from './model.ts';
import './evidence.css';

// One clock everywhere: the viewer's local time with its zone name (IST on the demo machine).
const clock = (iso: string, seconds: boolean) => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const day = `${t.getDate()} ${t.toLocaleString('en-GB', { month: 'short' })}`;
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), timeZoneName: 'short' });
  return `${day}${seconds ? ` ${t.getFullYear()}` : ''} ${time.replace('GMT+5:30', 'IST')}`;
};
const retrieved = (iso: string) => `retrieved ${clock(iso, false)}`;
const host = (url: string) => { try { const u = new URL(url); return `${u.host}${u.pathname}`.replace(/\/$/, ''); } catch { return url; } };
const STATE_TEXT = { verified: 'Verified', cached: 'Cached', unverifiable: "I can't verify" } as const;

function Card(props: {
  card: SourceCard; index: number; open: boolean; onLine?: boolean; highlight: boolean; reducedMotion: boolean;
  onToggle: () => void; onRecheck: (ev: Evidence) => Promise<void>;
}) {
  const { card, open, reducedMotion } = props;
  const ev = card.ev;
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const out = card.state === 'unverifiable';
  const bodyId = `evc-${card.key}`;
  return (
    <m.li
      id={ev ? `ev-${ev.id}` : undefined}
      className={`evc is-${card.state}${open ? ' is-open' : ''}${props.highlight ? ' is-hl' : ''}`}
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.34, ease: [0.2, 0.7, 0.2, 1], delay: reducedMotion ? 0 : Math.min(props.index, 10) * 0.04 }}
    >
      <button type="button" className="evc-hit" aria-expanded={open} aria-controls={bodyId} onClick={props.onToggle}>
        <span className="evc-top">
          <span className="evc-date">{card.date ? fmtDate(card.date, { year: true }) : 'Undated'}</span>
          {card.marker != null && <span className="evc-cite" title={`Cited as [${card.marker}] in the draft`}>Cited [{card.marker}]</span>}
          {props.onLine && <span className="evc-line" title="Backs the cascade line into this company">Cascade link</span>}
          <span className="evc-state">{STATE_TEXT[card.state]}</span>
        </span>
        <span className="evc-claim">{card.claim}</span>
        {out && card.reason && <span className="evc-reason">{card.reason}</span>}
        {ev && (
          <span className="evc-source">
            {providerLabel(ev)} · {endpointLabel(ev.source.endpoint)} · <span className="evc-when">{retrieved(ev.retrievedAt)}</span>
          </span>
        )}
        {!ev && <span className="evc-source">Left out of the draft by the claim check</span>}
        {ev && (
          <span className="evc-path">
            <span>{ev.source.endpoint}</span>
            {ev.source.field && <span>{ev.source.field}</span>}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && ev && (
          <m.div
            id={bodyId} className="evc-more"
            initial={reducedMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.16, 0.84, 0.24, 1] }}
          >
            <dl className="evc-facts">
              {card.signal && <><dt>DOMINO took</dt><dd className="evc-signal">{card.signal}</dd></>}
              {ev.source.url && <><dt>Source</dt><dd><a href={ev.source.url} target="_blank" rel="noreferrer noopener">{host(ev.source.url)}</a></dd></>}
              {ev.source.field && <><dt>Field</dt><dd className="evc-mono">{ev.source.endpoint} {ev.source.field}</dd></>}
              {ev.source.recordId && <><dt>Record</dt><dd className="evc-mono">{ev.source.recordId}</dd></>}
              <dt>Retrieved</dt><dd className="evc-mono">{clock(ev.retrievedAt, true)}</dd>
              {card.read && <><dt>From the read</dt><dd>{card.read.query}{card.read.total != null ? `, ${card.read.count} of ${card.read.total} shown` : ''}</dd></>}
              {card.fallback && <><dt>Fallback</dt><dd>{card.fallback.from} to {card.fallback.to}: {card.fallback.reason}</dd></>}
            </dl>
            <div className="evc-actions">
              <button type="button" className="btn btn-quiet btn-sm" disabled={checking}
                onClick={async () => { setChecking(true); await props.onRecheck(ev).finally(() => setChecking(false)); setChecked(true); }}>
                {checking ? 'Checking' : checked ? 'Checked again' : 'Check again'}
              </button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.li>
  );
}

function edgeFormula(e: GraphEdge, dated: number, undated: number) {
  return `${Math.round(e.confidence * 100)}% rests on ${dated} dated source${dated === 1 ? '' : 's'}${undated ? `; ${undated} undated, not counted` : ''}. A rule fires only on two or more dated sources.`;
}

export function EvidenceDrawer(props: {
  snap: RunSnapshot; events: StoredEvent[]; selection: Selection | null; hoverEvidence: string | null;
  cacheFetchedAt: string | null; reducedMotion: boolean;
  onRecheck: (ev: Evidence) => Promise<void>; onSelect: (s: Selection | null) => void; onClose: () => void;
}) {
  const { snap, selection } = props;
  const idx = useMemo(() => indexStream(props.events), [props.events]);
  const model = useMemo(() => buildCards(snap, idx, selection), [snap, idx, selection]);
  const [openKey, setOpenKey] = useState<string | null>(selection?.kind === 'evidence' ? selection.id : null);
  const name = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? snap.graph.nodes.find((n) => n.id === id)?.name ?? id;
  const mode = modeLine(model.modes, props.cacheFetchedAt);
  const total = model.kept.length + model.excluded.length;

  let kind: string | null = null;
  let title: ReactNode = 'Run evidence';
  let barName: string | null = null;
  let detail: ReactNode = null;

  if (selection?.kind === 'edge') {
    const e = snap.graph.edges.find((x) => x.id === selection.id);
    if (e) {
      kind = `${MECH_LABEL[e.mechanism]}, ${name(e.from)} to ${name(e.to)}`;
      title = e.label;
      barName = `${name(e.from)} to ${name(e.to)}`;
      detail = (
        <>
          <p className="evd-text">{e.rationale}</p>
          {e.alternative && <p className="evd-alt"><span>Could also mean</span> {e.alternative}</p>}
          <p className="evd-formula">{edgeFormula(e, model.kept.length, model.excluded.filter((c) => c.ev).length)}</p>
        </>
      );
    }
  } else if (selection?.kind === 'node' || selection?.kind === 'target') {
    const n = snap.graph.nodes.find((x) => x.id === selection.id);
    const t = snap.targets.find((x) => x.companyId === selection.id);
    const conf = t?.confidence ?? n?.confidence ?? null;
    const incoming = snap.graph.edges.filter((e) => e.to === selection.id);
    kind = n?.status === 'unverifiable' ? "Hypothesis I can't verify" : t ? `Target ${t.rank} of ${snap.targets.length}` : conf == null ? 'Trigger company' : 'Hypothesis';
    title = n?.name ?? name(selection.id);
    barName = n?.name ?? name(selection.id);
    detail = (
      <>
        {(t?.need ?? n?.need) && (
          <p className="evd-text">{t?.need ?? n?.need}{conf != null && <>, <b>{Math.round(conf * 100)}%</b> confidence</>}</p>
        )}
        {t?.whyNow && <p className="evd-text evd-quiet">Why now: {t.whyNow}{t.whyNowDate ? `, ${fmtDate(t.whyNowDate)}` : ''}</p>}
        {t?.hold && <div className="evd-hold"><span>On hold, never drafted or sent</span><ul>{t.hold.reasons.map((r) => <li key={r}>{r}</li>)}</ul></div>}
        {t?.decider === null && <p className="evd-alt"><span>No decider found.</span> I can't verify who decides here.</p>}
        {incoming.length > 0 && (
          <div className="evd-links">
            {incoming.map((e) => (
              <button key={e.id} type="button" className="evd-link" onClick={() => props.onSelect({ kind: 'edge', id: e.id })}>
                {MECH_LABEL[e.mechanism]} from {name(e.from)}: {e.label}
              </button>
            ))}
          </div>
        )}
      </>
    );
  } else if (selection?.kind === 'evidence') {
    kind = 'Cited source';
    title = 'What this citation rests on';
  }

  const onLine = (c: SourceCard) => c.marker == null && model.lead.has(c.key);
  const toggle = (k: string) => setOpenKey((cur) => (cur === k ? null : k));

  return (
    <LazyMotion features={domAnimation} strict>
      <section className="evd" aria-label="Evidence">
        <div className="evd-bar">
          <h2 className="evd-label">Evidence{barName && <span>, {barName}</span>}</h2>
          {mode.mode !== 'none' && <span className={`evd-chip is-${mode.mode}`} title={mode.text}>{mode.mode === 'fixture' ? 'Fixture data' : mode.mode === 'cache' ? 'Cached data' : mode.mode === 'live' ? 'Live data' : 'Mixed data'}</span>}
          {selection && <button type="button" className="btn btn-quiet btn-xs" onClick={() => props.onSelect(null)}>All sources</button>}
          <button type="button" className="btn btn-quiet btn-xs" onClick={props.onClose}>Close</button>
        </div>
        <div className="evd-scroll">
        <header className="evd-head">
          {kind && <p className="evd-kind">{kind}</p>}
          <h3 className="evd-title">{title}</h3>
          {detail}
          {total > 0 && (
            <p className="evd-tally">
              <span className="evd-n is-ok">{model.kept.length}</span> dated and sourced
              {model.excluded.length > 0 && (
                <a className="evd-jump" href="#evd-out"
                  onClick={(e) => { e.preventDefault(); document.getElementById('evd-out')?.scrollIntoView({ block: 'start', behavior: props.reducedMotion ? 'auto' : 'smooth' }); }}>
                  <span className="evd-n is-warn">{model.excluded.length}</span> left out, can't verify
                </a>
              )}
            </p>
          )}
          <p className={`evd-mode is-${mode.mode}`}>{mode.text}</p>
        </header>
        <div className="evd-body">
          {!selection && total > 0 && <p className="evd-hint">Pick a target, a line or a citation to see only what it rests on.</p>}
          {total === 0 && (
            <div className="evd-empty">
              <p className="evd-empty-title">{selection ? 'Nothing backs this yet.' : 'No sources read yet.'}</p>
              <p>{selection
                ? 'DOMINO has not attached a dated source to this. It will not be drafted on until one lands here.'
                : 'Every fact DOMINO uses lands here with its date, where it came from and when it was fetched.'}</p>
            </div>
          )}
          {model.kept.length > 0 && (
            <ul className="evc-list">
              {model.kept.map((c, i) => (
                <Card key={c.key} card={c} index={i} open={openKey === c.key} onLine={onLine(c)} highlight={props.hoverEvidence === c.key}
                  reducedMotion={props.reducedMotion} onToggle={() => toggle(c.key)} onRecheck={props.onRecheck} />
              ))}
            </ul>
          )}
          {model.excluded.length > 0 && (
            <>
              <h4 className="evd-out" id="evd-out">Left out: I can't verify {model.excluded.length === 1 ? 'this' : `these ${model.excluded.length}`}</h4>
              <ul className="evc-list">
                {model.excluded.map((c, i) => (
                  <Card key={c.key} card={c} index={model.kept.length + i} open={openKey === c.key} highlight={props.hoverEvidence === c.key}
                    reducedMotion={props.reducedMotion} onToggle={() => toggle(c.key)} onRecheck={props.onRecheck} />
                ))}
              </ul>
            </>
          )}
        </div>
        </div>
      </section>
    </LazyMotion>
  );
}
