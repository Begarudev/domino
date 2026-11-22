import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { CentrepieceProps } from '../contract.ts';
import type { Evidence } from '../../../../shared/types.ts';
import { buildModel, dayAt, dayOf, fmtDay, phaseAt, sAtDay, type FlowModel, type Phase } from './model.ts';
import { draw, type Frame, type View } from './render.ts';
import './flow.css';

export interface TalentFlowExtra {
  layoutHints?: Record<string, { x: number; y: number }>;
  /** start paused at this story second (screenshots) */
  initialS?: number;
  autoPlay?: boolean;
  speed?: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function caption(m: FlowModel, ph: Phase, focusName: string): string {
  const asOf = fmtDay(m.dFreeze);
  if (m.mode === 'live') {
    if (ph === 'intro' || ph === 'see' || ph === 'forward' || ph === 'freeze') return 'Job moves between AI companies over the last 90 days';
    return `Drafting the first message to ${focusName}`;
  }
  switch (ph) {
    case 'intro':
    case 'see': return `Replay: the job moves DOMINO could see before ${asOf}`;
    case 'freeze': return `Clock frozen on ${asOf}. Predictions are locked in`;
    case 'forward': return `Playing forward to ${fmtDay(m.dEnd)}. A ring turns solid when a dated job post or hire lands`;
    case 'score': return `Scored on ${fmtDay(m.dEnd)} against dated job posts and hires`;
    default: return `The first message to ${focusName}, written from facts dated on or before ${asOf}`;
  }
}

function sourceLine(e: Evidence) {
  const field = e.source.field ? ` · ${e.source.field}` : '';
  const date = e.observedAt ? fmtDay(dayOf(e.observedAt), true) : 'undated';
  return { where: `${e.source.provider === 'crustdata' ? 'Crustdata ' : ''}${e.source.endpoint}${field}`, date, mode: e.mode };
}

export function TalentFlow(props: CentrepieceProps & TalentFlowExtra): JSX.Element {
  const { snapshot, width, height, reducedMotion } = props;
  const model = useMemo(() => buildModel(snapshot, props.layoutHints), [snapshot, props.layoutHints]);
  const focusName = model.focusId ? model.byId.get(model.focusId)?.name ?? '' : '';

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const domRef = useRef<HTMLSpanElement>(null);
  const filRef = useRef<HTMLSpanElement>(null);
  const domOfRef = useRef<HTMLSpanElement>(null);
  const filOfRef = useRef<HTMLSpanElement>(null);
  const scoreRef = useRef<HTMLElement>(null);
  const letterRef = useRef<HTMLElement>(null);
  const sentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tailRef = useRef<HTMLDivElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);

  const st = useRef({ s: props.initialS ?? 0, playing: props.initialS === undefined && props.autoPlay !== false && !reducedMotion, last: 0, frame: null as Frame | null, slots: [] as { x: number; y: number }[], hover: null as string | null, scrubbing: false });
  const propsRef = useRef(props);
  propsRef.current = props;
  const [, force] = useState(0);

  const k = clamp(Math.min(width / 1280, height / 800), 0.78, 1.4);
  const scoreW = model.score ? 236 * k : 0;
  const letterW = Math.min(560 * k, width * 0.5);
  const letterLeft = width - letterW - 28 * k;
  const rect = useMemo(() => ({
    x: 70 * k, y: 120 * k,
    w: width - 140 * k - scoreW, h: height - 120 * k - 150 * k,
  }), [k, width, height, scoreW]);

  useEffect(() => {
    if (reducedMotion) { st.current.s = model.total; st.current.playing = false; }
  }, [reducedMotion, model]);
  useEffect(() => {
    if (props.replayToken) { st.current.s = 0; st.current.playing = true; force((x) => x + 1); }
  }, [props.replayToken]);

  // measure letter slots (left-middle of each sentence) relative to the root
  useEffect(() => {
    const measure = () => {
      const panel = letterRef.current;
      if (!panel) return;
      st.current.slots = sentRefs.current.map((el) => el ? { x: panel.offsetLeft + el.offsetLeft - 6 * k, y: panel.offsetTop + el.offsetTop + Math.min(el.offsetHeight / 2, 18 * k) } : { x: 0, y: 0 });
    };
    measure();
    document.fonts?.ready.then(measure);
    const t = setTimeout(measure, 300);
    return () => clearTimeout(t);
  }, [model, width, height, k]);

  useEffect(() => {
    const cv = canvasRef.current!;
    const g = cv.getContext('2d')!;
    let raf = 0;
    let lastPhase: Phase | null = null;
    let lastDate = '';
    let lastD = -1, lastF = -1;
    const tick = (t: number) => {
      const S = st.current;
      const p = propsRef.current;
      const dt = S.last ? Math.min(0.05, (t - S.last) / 1000) : 0;
      S.last = t;
      if (S.playing && !S.scrubbing) {
        S.s += dt * (p.speed ?? 1);
        if (S.s >= model.total) { S.s = model.total; S.playing = false; if (playBtn.current) playBtn.current.textContent = 'Replay'; }
      }
      const s = S.s;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) { cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr); }
      const view: View = { w: width, h: height, dpr, k, rect, filterView: p.hiringFilterView, hoverId: S.hover, selId: p.selection?.kind === 'node' ? p.selection.id : null, reduced: p.reducedMotion, slots: S.slots, letterLeft };
      S.frame = draw(g, model, s, view);

      // HUD
      const ph = phaseAt(model, s);
      const day = Math.floor(dayAt(model, s));
      const ds = fmtDay(day, true);
      if (ds !== lastDate && dateRef.current) { dateRef.current.textContent = ds; lastDate = ds; }
      if (ph !== lastPhase) {
        if (capRef.current) capRef.current.textContent = caption(model, ph, focusName);
        rootRef.current?.setAttribute('data-phase', ph);
        lastPhase = ph;
      }
      if (headRef.current) {
        const span = model.dEnd - model.d0 || 1;
        headRef.current.style.transform = `translateX(${(clamp((dayAt(model, s) - model.d0) / span) * 100).toFixed(3)}cqw)`;
      }
      if (model.score) {
        const placed = s >= model.sFreeze + 0.6;
        const dh = s >= model.sEnd ? model.score.domino.hits : model.predictions.filter((x) => x.by === 'domino' && x.sLand !== null && s >= x.sLand).length;
        const fh = s >= model.sEnd ? model.score.filter.hits : model.predictions.filter((x) => x.by === 'filter' && x.sLand !== null && s >= x.sLand).length;
        if (dh !== lastD && domRef.current) { domRef.current.textContent = placed ? String(dh) : '0'; if (lastD >= 0 && dh > lastD) bump(domRef.current); lastD = dh; }
        if (fh !== lastF && filRef.current) { filRef.current.textContent = placed ? String(fh) : '0'; if (lastF >= 0 && fh > lastF) bump(filRef.current); lastF = fh; }
        if (domOfRef.current) domOfRef.current.style.opacity = placed ? '1' : '0';
        if (filOfRef.current) filOfRef.current.style.opacity = placed ? '1' : '0';
        if (scoreRef.current) scoreRef.current.style.opacity = String(1 - clamp((s - model.sZoom) / 0.8));
      }
      // letter
      const L = model.letter;
      if (L && letterRef.current) {
        const a = clamp((s - model.sLetter + 0.2) / 0.6);
        letterRef.current.style.opacity = String(a);
        letterRef.current.style.visibility = a > 0 ? 'visible' : 'hidden';
        L.sentences.forEach((sen, i) => {
          const el = sentRefs.current[i];
          if (!el) return;
          const slot = S.slots[i];
          const ft = clamp((s - sen.sStart) / (sen.sLand - sen.sStart));
          let tr = 'none';
          if (sen.status === 'cited' && ft < 1 && S.frame) {
            const b = S.frame.beads.get(sen.evidence[0]?.id ?? '');
            if (b && slot) {
              const e = easeInOut(ft);
              const cx = (b.x + slot.x) / 2, cy = Math.min(b.y, slot.y) - 40 * k;
              const u = 1 - e;
              const x = u * u * b.x + 2 * u * e * cx + e * e * slot.x;
              const y = u * u * b.y + 2 * u * e * cy + e * e * slot.y;
              tr = `translate(${(x - slot.x).toFixed(1)}px, ${(y - slot.y).toFixed(1)}px) scale(${(0.3 + 0.7 * e).toFixed(3)})`;
            }
          }
          el.style.transform = tr;
          el.style.opacity = String(s < sen.sStart ? 0 : sen.status === 'cited' ? clamp(ft * 2.5) : clamp((s - sen.sStart) / 0.35));
          el.style.setProperty('--land', String(clamp((s - sen.sLand) / 0.4)));
          el.style.setProperty('--strike', String(sen.status === 'removed' ? clamp((s - sen.sStart - 0.35) / 0.45) : 0));
        });
        if (tailRef.current) tailRef.current.style.opacity = String(clamp((s - (L.sentences.at(-1)?.sLand ?? model.sLetter) - 0.3) / 0.6));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [model, width, height, k, rect, letterLeft, focusName]);

  function bump(el: HTMLElement) {
    el.classList.remove('tf-bump');
    void el.offsetWidth;
    el.classList.add('tf-bump');
  }

  const togglePlay = () => {
    const S = st.current;
    if (S.s >= model.total) S.s = 0;
    S.playing = !S.playing;
    if (playBtn.current) playBtn.current.textContent = S.playing ? 'Pause' : 'Play';
  };

  // keyboard
  useEffect(() => {
    const el = rootRef.current!;
    const onKey = (e: KeyboardEvent) => {
      const S = st.current;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') S.s = Math.min(model.total, S.s + 1);
      else if (e.key === 'ArrowLeft') S.s = Math.max(0, S.s - 1);
      else if (e.key === 'r' || e.key === 'R') { S.s = 0; S.playing = true; }
      else if (e.key === 'f' || e.key === 'F') { S.s = model.sZoom; S.playing = true; }
      else return;
      if (playBtn.current) playBtn.current.textContent = S.playing ? 'Pause' : 'Play';
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [model]);

  // pointer: hover and select nodes / rivers
  const pick = (x: number, y: number): { kind: 'node' | 'edge'; id: string } | null => {
    const f = st.current.frame;
    if (!f) return null;
    for (const [id, n] of f.nodes) if (Math.hypot(n.x - x, n.y - y) < n.r + 10) return { kind: 'node', id };
    for (const r of f.rivers) {
      if (!r.edgeId) continue;
      if (r.pts.some(([px, py]) => Math.hypot(px - x, py - y) < 10)) return { kind: 'edge', id: r.edgeId };
    }
    return null;
  };
  const onMove = (e: React.PointerEvent) => {
    const b = canvasRef.current!.getBoundingClientRect();
    const hit = pick(e.clientX - b.left, e.clientY - b.top);
    st.current.hover = hit?.kind === 'node' ? hit.id : null;
    canvasRef.current!.style.cursor = hit ? 'pointer' : 'default';
  };
  const onClick = (e: React.MouseEvent) => {
    const b = canvasRef.current!.getBoundingClientRect();
    props.onSelect(pick(e.clientX - b.left, e.clientY - b.top));
  };

  // timeline scrub
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubTo = (clientX: number) => {
    const b = trackRef.current!.getBoundingClientRect();
    const day = model.d0 + clamp((clientX - b.left) / b.width) * (model.dEnd - model.d0);
    st.current.s = sAtDay(model, day);
  };

  const span = model.dEnd - model.d0 || 1;
  const pct = (day: number) => `${(((day - model.d0) / span) * 100).toFixed(3)}%`;
  const months: { day: number; label: string }[] = [];
  for (let d = model.d0; d <= model.dEnd; d++) {
    const dt = new Date(d * 86400000);
    if (dt.getUTCDate() === 1) months.push({ day: d, label: fmtDay(d).split(' ')[1] });
  }
  const L = model.letter;
  const markerOf = new Map(snapshot.drafts.find((d) => d.companyId === L?.companyId)?.citations.map((c) => [c.evidenceId, c.marker]) ?? []);
  const renderSentence = (text: string) => text.split(/(\[\d+\])/).map((part, i) => /^\[\d+\]$/.test(part) ? <sup key={i} className="tf-mark">{part.slice(1, -1)}</sup> : <span key={i}>{part}</span>);
  const fixture = model.fixture || snapshot.evidence.some((e) => e.mode === 'fixture');

  return (
    <div ref={rootRef} className="tf-root" tabIndex={0} aria-label="Talent-flow replay" style={{ width, height, ['--k' as string]: k, ['--letter-w' as string]: `${letterW}px` }}>
      <canvas ref={canvasRef} style={{ width, height }} onPointerMove={onMove} onClick={onClick} />

      <header className="tf-clock">
        <div ref={dateRef} className="tf-date">{fmtDay(model.d0, true)}</div>
        <div ref={capRef} className="tf-caption" />
      </header>

      {fixture && <div className="tf-badge">Fixture · synthetic companies and people</div>}

      {model.score && (
        <aside ref={scoreRef} className="tf-score" aria-label="Replay score">
          <div className="tf-score-title">Came true by {fmtDay(model.dEnd)}</div>
          <div className="tf-row tf-row-domino">
            <span className="tf-who">DOMINO</span>
            <span className="tf-num"><span ref={domRef}>0</span><span ref={domOfRef} className="tf-of"> of {model.score.domino.predicted}</span></span>
          </div>
          <div className="tf-row tf-row-filter">
            <span className="tf-who">Hiring filter</span>
            <span className="tf-num"><span ref={filRef}>0</span><span ref={filOfRef} className="tf-of"> of {model.score.filter.predicted}</span></span>
          </div>
          <div className="tf-minor">Headcount filter: {model.score.headcount.hits} of {model.score.headcount.predicted}</div>
          <div className="tf-leak">Facts dated after {fmtDay(model.dFreeze)} used: <b>{model.score.leaks}</b></div>
          <div className="tf-netnew">{model.score.netNewHits} of DOMINO's hits were accounts the hiring filter never returned</div>
        </aside>
      )}

      <div className="tf-legend" aria-hidden>
        <span><i className="lg-ember" />serving engineer moved</span>
        <span><i className="lg-slate" />other job move</span>
        {model.mode === 'replay' && <span><i className="lg-frost" />move after {fmtDay(model.dFreeze)}, not used</span>}
        <span><i className="lg-wound" />need DOMINO inferred</span>
        {model.mode === 'replay' && <><span><i className="lg-tide-d" />prediction on {fmtDay(model.dFreeze)}</span><span><i className="lg-tide" />came true</span><span><i className="lg-filter" />hiring filter pick</span></>}
      </div>

      <footer className="tf-timeline">
        <button ref={playBtn} className="tf-play" onClick={togglePlay}>{st.current.playing ? 'Pause' : 'Play'}</button>
        <div ref={trackRef} className="tf-track"
          onPointerDown={(e) => { st.current.scrubbing = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); scrubTo(e.clientX); }}
          onPointerMove={(e) => { if (st.current.scrubbing) scrubTo(e.clientX); }}
          onPointerUp={() => { st.current.scrubbing = false; }}>
          <div className="tf-rail" />
          {model.mode === 'replay' && <div className="tf-future" style={{ left: pct(model.dFreeze) }} />}
          {months.map((mo) => <div key={mo.day} className="tf-month" style={{ left: pct(mo.day) }}>{mo.label}</div>)}
          {model.moves.map((mv) => <div key={mv.id} className={mv.serving ? 'tf-tick tf-tick-s' : 'tf-tick'} style={{ left: pct(mv.day) }} />)}
          {model.predictions.filter((p) => p.outcomeDay !== null && p.hit).map((p) => <div key={`${p.companyId}${p.by}`} className={`tf-out tf-out-${p.by}`} style={{ left: pct(p.outcomeDay!) }} title={p.outcome} />)}
          {model.mode === 'replay' && <div className="tf-freeze" style={{ left: pct(model.dFreeze) }}><span>{fmtDay(model.dFreeze)}: clock frozen</span></div>}
          <div className="tf-headwrap"><div ref={headRef} className="tf-head" /></div>
        </div>
        <div className="tf-end">{fmtDay(model.dEnd)}</div>
      </footer>

      {L && (
        <section ref={letterRef} className="tf-letter" style={{ visibility: 'hidden' }} aria-label="Drafted first message">
          <div className="tf-l-meta">
            <span>{L.kind === 'draft' ? <>Draft for <b>{L.to}</b> at {model.byId.get(L.companyId)?.name}</> : <>Why DOMINO called <b>{L.to}</b></>}</span>
            <span className="tf-l-when">written {L.writtenOn}</span>
          </div>
          {L.kind === 'draft' && <div className="tf-l-subject">{L.subject}</div>}
          <div className="tf-l-body">
            {L.sentences.map((sen, i) => (
              <div key={i} ref={(el) => { sentRefs.current[i] = el; }} className={`tf-sent tf-${sen.status}`}>
                <div className="tf-sent-text">{renderSentence(sen.text)}</div>
                {sen.status === 'cited' && (
                  <div className="tf-chips">
                    {sen.evidence.map((e) => {
                      const sl = sourceLine(e);
                      return (
                        <button key={e.id} className="tf-chip" onClick={() => props.onSelect({ kind: 'evidence', id: e.id })}>
                          {markerOf.get(e.id) !== undefined && <b>[{markerOf.get(e.id)}]</b>} {sl.date} <span>{sl.where}</span> <em>{sl.mode}</em>
                        </button>
                      );
                    })}
                  </div>
                )}
                {sen.status === 'removed' && <div className="tf-note">Removed before you see it: {sen.note ?? 'no evidence row supports it'}</div>}
                {sen.status === 'no_claim' && <div className="tf-note tf-note-quiet">No fact claimed, so no source needed</div>}
              </div>
            ))}
          </div>
          <div ref={tailRef} className="tf-l-tail">
            {L.unverifiable.map((u, i) => <div key={i} className="tf-cant"><b>I can't verify</b> {u.claim}. {u.reason}</div>)}
            <div className="tf-gate">Waiting for your approval. Nothing is sent from this view.</div>
          </div>
        </section>
      )}
    </div>
  );
}
