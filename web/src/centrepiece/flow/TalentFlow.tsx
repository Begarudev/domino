import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { CentrepieceProps } from '../contract.ts';
import type { Evidence } from '../../../../shared/types.ts';
import { buildModel, chapterAt, dayAt, dayOf, fmtDay, sAtDay, type FlowModel } from './model.ts';
import { draw, type Frame, type View } from './render.ts';
import './flow.css';

export interface TalentFlowExtra {
  layoutHints?: Record<string, { x: number; y: number }>;
  /** finish with the drafted message (off by default: the v2 desk owns outreach) */
  withLetter?: boolean;
  /** start paused at this story second (screenshots) */
  initialS?: number;
  autoPlay?: boolean;
  speed?: number;
}

const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** The one plain sentence that explains each chapter of the story. */
function chapterText(m: FlowModel, n: number): string {
  const asOf = fmtDay(m.dFreeze).replace(' ', '\u00a0');
  const drain = m.rivers.find((r) => r.key === m.drainKey);
  const ch1 = "DOMINO predicts job openings before they're posted. Big lights are companies; each spark is one person changing jobs.";
  let ch2 = 'DOMINO marks companies that lost two or more people in one role family and have not posted a replacement.';
  if (drain) {
    const from = m.byId.get(drain.from)!.name, to = m.byId.get(drain.to)!.name;
    const n2 = drain.moves.filter((mv) => mv.day <= m.dFreeze).length;
    const fam = drain.family;
    ch2 = `${n2} of ${from}'s ${fam} engineers left for ${to}, and no replacement has been posted. ${from} will likely open ${/^[aeiou]/i.test(fam) ? 'an' : 'a'} ${fam} role.`;
  }
  const focus = m.focusId ? m.byId.get(m.focusId)?.name ?? '' : '';
  const ch5 = m.letter?.kind === 'draft' ? 'The intro: a sourced message matching an opted-in candidate to the predicted opening.' : `Why DOMINO predicted an opening at ${focus}: only records dated on or before ${asOf}.`;
  if (m.mode === 'live') return [ch1, ch2, ch5][n - 1];
  return [
    ch1,
    ch2,
    `${asOf}: predictions locked. Nothing dated after this is used.`,
    'Playing forward: a ring turns solid when the company really posts that job or hires for it.',
    ch5,
  ][n - 1];
}

type Mark = 'ember' | 'slate' | 'size' | 'river' | 'wound' | 'tide-d' | 'tide' | 'filter';
function legendFor(m: FlowModel, n: number): [Mark, string][] {
  if (n === 1) return [['size', 'company (size = headcount)'], ['slate', 'spark = one job move'], ['ember', 'amber = inference or ML platform role']];
  if (n === 2) return [['river', '2+ people in one role family leaving'], ['wound', 'predicted opening (dots = dated evidence)']];
  if (m.mode === 'live') return [];
  if (n === 3) return [['tide-d', 'predicted opening, locked 1 Sep'], ['filter', 'job-post filter pick']];
  if (n === 4) return [['tide', 'came true: the job was posted or filled'], ['tide-d', 'not yet']];
  return [];
}

/** "[1] 21 Jul 2026 · Crustdata funding record": readable source names; the raw endpoint stays in the tooltip. */
function sourceName(e: Evidence): string {
  const ep = e.source.endpoint, f = e.source.field ?? '';
  const who = e.source.provider === 'crustdata' ? 'Crustdata' : e.source.provider === 'web' ? 'Web' : 'DOMINO';
  let what = 'record';
  if (/job/.test(ep)) what = 'job posts';
  else if (/person/.test(ep)) what = 'work-history record';
  else if (/funding/.test(f)) what = 'funding record';
  else if (/headcount/.test(f)) what = 'headcount history';
  else if (/competitor/.test(f)) what = 'peer list';
  else if (/news/.test(f) || /news/.test(ep)) what = 'news item';
  else if (/company/.test(ep)) what = 'company record';
  else if (/search/.test(ep)) what = 'search result';
  return `${who} ${what}`;
}

function offsetTo(el: HTMLElement, root: HTMLElement) {
  let x = 0, y = 0, n: HTMLElement | null = el;
  while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
  return { x, y };
}

export function TalentFlow(props: CentrepieceProps & TalentFlowExtra): JSX.Element {
  const { snapshot, width, height, reducedMotion } = props;
  const model = useMemo(() => buildModel(snapshot, props.layoutHints, { letter: props.withLetter }), [snapshot, props.layoutHints, props.withLetter]);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const headDateRef = useRef<HTMLDivElement>(null);
  const thruRef = useRef<HTMLSpanElement>(null);
  const domRef = useRef<HTMLSpanElement>(null);
  const filRef = useRef<HTMLSpanElement>(null);
  const scoreRef = useRef<HTMLElement>(null);
  const letterRef = useRef<HTMLElement>(null);
  const sentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const ghostRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tailRef = useRef<HTMLDivElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const st = useRef({ s: props.initialS ?? 0, playing: props.initialS === undefined && props.autoPlay !== false && !reducedMotion, last: 0, frame: null as Frame | null, slots: [] as { x: number; y: number }[], hover: null as string | null, scrubbing: false, wasRunning: props.running });
  const propsRef = useRef(props);
  propsRef.current = props;
  const [, force] = useState(0);
  const [chapter, setChapter] = useState(() => chapterAt(model, st.current.s));

  const k = clamp(Math.min(width / 1280, height / 800), 0.78, 1.4);
  const compact = width < 1000 || height < 640;
  const short = height < 440;
  const scoreW = model.score ? (compact ? 200 : 250) * k : 0;
  const letterW = Math.min(580 * k, width * 0.5);
  const letterLeft = width - letterW - 28 * k;
  const top = (short ? 64 : compact ? 104 : 150) * k;
  const bottom = (short ? 86 : compact ? 92 : 120) * k;
  const rect = useMemo(() => ({ x: (compact ? 56 : 70) * k, y: top, w: width - (compact ? 100 : 140) * k - scoreW, h: height - top - bottom }), [k, width, height, scoreW, compact, top, bottom]);

  useEffect(() => {
    if (reducedMotion) { st.current.s = model.total; st.current.playing = false; }
  }, [reducedMotion, model]);
  useEffect(() => {
    if (props.replayToken) { st.current.s = 0; st.current.playing = true; force((x) => x + 1); }
  }, [props.replayToken]);

  // landing point (left-middle of each sentence) relative to the root
  useEffect(() => {
    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      st.current.slots = sentRefs.current.map((el) => {
        if (!el) return { x: 0, y: 0 };
        const o = offsetTo(el, root);
        return { x: o.x - 6 * k, y: o.y + Math.min(el.offsetHeight / 2, 18 * k) };
      });
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
    let lastCap = '';
    let lastDate = '';
    let lastD = -1, lastF = -1;
    let lastCh = '';
    const tick = (t: number) => {
      const S = st.current;
      const p = propsRef.current;
      const dt = S.last ? Math.min(0.05, (t - S.last) / 1000) : 0;
      S.last = t;
      // while the engine is still working, hold at the start; play the time-lapse once the run has finished
      if (p.running !== S.wasRunning) {
        if (S.wasRunning && !p.running && !p.reducedMotion) { S.s = 0; S.playing = true; if (playBtn.current) playBtn.current.textContent = 'Pause'; }
        S.wasRunning = p.running;
      }
      if (p.running) S.s = Math.min(S.s, model.sSee0 * 0.98);
      if (S.playing && !S.scrubbing) {
        S.s += dt * (p.speed ?? 1);
        if (S.s >= model.total) { S.s = model.total; S.playing = false; if (playBtn.current) playBtn.current.textContent = 'Replay'; }
      }
      const s = S.s;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) { cv.width = Math.round(width * dpr); cv.height = Math.round(height * dpr); }
      const view: View = { w: width, h: height, dpr, k, rect, compact, filterView: p.hiringFilterView, hoverId: S.hover, selId: p.selection?.kind === 'node' ? p.selection.id : null, reduced: p.reducedMotion, slots: S.slots, letterLeft };
      S.frame = draw(g, model, s, view);

      // narrative caption
      const ch = chapterAt(model, s);
      const chKey = `${ch.n}/${ch.of}`;
      if (chKey !== lastCh) { lastCh = chKey; setChapter(ch); }
      const cap = p.running ? 'DOMINO is pulling dated job moves. The replay plays when the run finishes.' : !model.companies.length ? 'No companies yet. Run a request to see the job moves between them.' : chapterText(model, ch.n);
      if (cap !== lastCap && capRef.current) { capRef.current.textContent = cap; lastCap = cap; }
      rootRef.current?.setAttribute('data-chapter', String(ch.n));
      rootRef.current?.setAttribute('data-phase', model.letter && s >= model.sZoom ? 'letter' : 'field');

      // date riding the playhead
      const dayNow = dayAt(model, s);
      const ds = fmtDay(Math.floor(dayNow), true);
      if (ds !== lastDate) {
        if (headDateRef.current) headDateRef.current.textContent = ds;
        if (thruRef.current) thruRef.current.textContent = fmtDay(Math.floor(dayNow));
        lastDate = ds;
      }
      const span = model.dEnd - model.d0 || 1;
      const x = `translateX(${(clamp((dayNow - model.d0) / span) * 100).toFixed(3)}cqw)`;
      if (headRef.current) headRef.current.style.transform = x;
      if (headDateRef.current) headDateRef.current.style.transform = x;
      if (endRef.current && trackRef.current) {
        const near = (1 - clamp((dayNow - model.d0) / span)) * trackRef.current.clientWidth < 40 * k + 70 * k;
        endRef.current.style.opacity = near ? '0' : '1';
      }

      // scoreboard: appears when predictions lock
      if (model.score && scoreRef.current) {
        const dh = s >= model.sEnd ? model.score.domino.hits : model.predictions.filter((q) => q.by === 'domino' && q.sLand !== null && s >= q.sLand).length;
        const fh = s >= model.sEnd ? model.score.filter.hits : model.predictions.filter((q) => q.by === 'filter' && q.sLand !== null && s >= q.sLand).length;
        if (dh !== lastD && domRef.current) { domRef.current.textContent = String(dh); if (lastD >= 0 && dh > lastD) bump(domRef.current); lastD = dh; }
        if (fh !== lastF && filRef.current) { filRef.current.textContent = String(fh); if (lastF >= 0 && fh > lastF) bump(filRef.current); lastF = fh; }
        const vis = clamp((s - model.sFreeze - 0.4) / 0.5) * (model.letter ? 1 - clamp((s - model.sZoom) / 0.6) : 1);
        scoreRef.current.style.opacity = String(vis);
        scoreRef.current.style.visibility = vis > 0 ? 'visible' : 'hidden';
        scoreRef.current.setAttribute('data-done', s >= model.sEnd ? '1' : '0');
      }
      // letter
      const L = model.letter;
      if (L && letterRef.current) {
        const a = clamp((s - model.sLetter + 0.2) / 0.4);
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
              const bx = u * u * b.x + 2 * u * e * cx + e * e * slot.x;
              const by = u * u * b.y + 2 * u * e * cy + e * e * slot.y;
              tr = `translate(${(bx - slot.x).toFixed(1)}px, ${(by - slot.y).toFixed(1)}px) scale(${(0.55 + 0.45 * e).toFixed(3)})`;
            }
          }
          el.style.transform = tr;
          el.style.opacity = String(s < sen.sStart ? 0 : sen.status === 'cited' ? clamp(ft * 2.5) : clamp((s - sen.sStart) / 0.35));
          el.style.setProperty('--land', String(clamp((s - sen.sLand + 0.1) / 0.35)));
          el.style.setProperty('--fly', String(sen.status === 'cited' && s >= sen.sStart ? 1 - clamp((s - sen.sLand + 0.15) / 0.5) : 0));
          el.style.setProperty('--strike', String(sen.status === 'removed' ? clamp((s - sen.sStart - 0.35) / 0.45) : 0));
          const gh = ghostRefs.current[i];
          if (gh) gh.style.opacity = String(1 - clamp((s - sen.sStart + 0.1) / 0.25));
        });
        if (tailRef.current) tailRef.current.style.opacity = String(clamp((s - (L.sentences.at(-1)?.sLand ?? model.sLetter) - 0.3) / 0.6));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [model, width, height, k, rect, letterLeft, compact]);

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
    if (dt.getUTCDate() === 1 && Math.abs(d - model.dFreeze) > 6) months.push({ day: d, label: fmtDay(d).split(' ')[1] });
  }
  const L = model.letter;
  const markerOf = new Map(snapshot.drafts.find((d) => d.companyId === L?.companyId)?.citations.map((c) => [c.evidenceId, c.marker]) ?? []);
  const renderSentence = (text: string) => text.split(/(\[\d+\])/).map((part, i) => /^\[\d+\]$/.test(part) ? <sup key={i} className="tf-mark">{part.slice(1, -1)}</sup> : <span key={i}>{part}</span>);
  const fixture = model.fixture || snapshot.evidence.some((e) => e.mode === 'fixture');
  const legend = legendFor(model, chapter.n);
  const sc = model.score;

  return (
    <div ref={rootRef} className={`tf-root${compact ? ' tf-compact' : ''}${short ? ' tf-short' : ''}`} tabIndex={0} aria-label="Talent-flow replay" style={{ width, height, ['--k' as string]: k, ['--letter-w' as string]: `${letterW}px`, ['--score-w' as string]: `${scoreW}px` }}>
      <canvas ref={canvasRef} style={{ width, height }} onPointerMove={onMove} onClick={onClick} />

      <header className="tf-story">
        <div className="tf-step">{chapter.n} of {chapter.of}</div>
        <div ref={capRef} className="tf-caption" aria-live="polite" />
        {legend.length > 0 && (
          <div className="tf-legend" key={chapter.n}>
            {legend.map(([mark, label]) => <span key={label}><i className={`lg-${mark}`} />{label}</span>)}
          </div>
        )}
      </header>

      {fixture && <div className="tf-badge">Sample data · fictional companies, not live results</div>}

      {sc && (
        <aside ref={scoreRef} className="tf-score" aria-label="Replay score" style={{ visibility: 'hidden' }}>
          <div className="tf-score-title">Which predicted openings were later posted or filled?</div>
          <div className="tf-row tf-row-domino">
            <span className="tf-who">DOMINO</span>
            <span className="tf-num"><span ref={domRef}>0</span><span className="tf-of"> of {sc.domino.predicted} {sc.domino.predicted === 1 ? 'pick' : 'picks'}</span></span>
          </div>
          <div className="tf-row tf-row-filter">
            <span className="tf-who">Job-post filter<small>any job post in the last 30 days</small></span>
            <span className="tf-num"><span ref={filRef}>0</span><span className="tf-of"> of {sc.filter.predicted} {sc.filter.predicted === 1 ? 'pick' : 'picks'}</span></span>
          </div>
          <div className="tf-checked">Predictions locked {fmtDay(model.dFreeze)} · checked through <span ref={thruRef} /></div>
          <div className="tf-result">{sc.netNewHits === 1 ? '1 predicted opening came true at a company the job-post filter never picked' : `${sc.netNewHits} predicted openings came true at companies the job-post filter never picked`}</div>
          <div className="tf-foot">
            {sc.leaks} facts dated after {fmtDay(model.dFreeze)} were used. Headcount +30% filter: {sc.headcount.hits} of {sc.headcount.predicted}.
            {snapshot.replay?.snapshotLabel ? ` ${snapshot.replay.snapshotLabel}` : ''}
          </div>
        </aside>
      )}

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
          {model.mode === 'replay' && <div className="tf-freeze" style={{ left: pct(model.dFreeze) }}><span>{fmtDay(model.dFreeze)}: predictions locked</span></div>}
          <div className="tf-headwrap"><div ref={headRef} className="tf-head" /><div ref={headDateRef} className="tf-headdate">{fmtDay(model.d0, true)}</div></div>
        </div>
        <div ref={endRef} className="tf-end">{fmtDay(model.dEnd)}</div>
      </footer>

      {L && (
        <section ref={letterRef} className="tf-letter" style={{ visibility: 'hidden' }} aria-label="Drafted first message">
          <div className="tf-l-meta">
            <span>{L.kind === 'draft' ? <>Draft for <b>{L.to}</b> at {model.byId.get(L.companyId)?.name}</> : <>Why DOMINO picked <b>{L.to}</b></>}</span>
            <span className="tf-l-when">{model.mode === 'replay' ? `records up to ${L.writtenOn}` : `written ${L.writtenOn}`}</span>
          </div>
          {L.kind === 'draft' && <div className="tf-l-subject">{L.subject}</div>}
          <div className="tf-l-body">
            {L.sentences.map((sen, i) => {
              const lines = Math.max(1, Math.ceil(sen.text.length / 58));
              return (
                <div key={i} className="tf-slotwrap">
                  <div ref={(el) => { ghostRefs.current[i] = el; }} className="tf-ghost" aria-hidden>
                    {Array.from({ length: lines }, (_, j) => <i key={j} style={{ width: j === lines - 1 ? '58%' : '96%' }} />)}
                  </div>
                  <div ref={(el) => { sentRefs.current[i] = el; }} className={`tf-sent tf-${sen.status}`}>
                    <div className="tf-sent-text">{renderSentence(sen.text)}</div>
                    {sen.status === 'cited' && (
                      <div className="tf-chips">
                        {sen.evidence.map((e) => (
                          <button key={e.id} className="tf-chip" title={`${e.source.endpoint}${e.source.field ? ` · ${e.source.field}` : ''} (${e.mode})`} onClick={() => props.onSelect({ kind: 'evidence', id: e.id })}>
                            {markerOf.get(e.id) !== undefined && <b>[{markerOf.get(e.id)}]</b>} {e.observedAt ? fmtDay(dayOf(e.observedAt), true) : 'undated'} · {sourceName(e)}
                          </button>
                        ))}
                      </div>
                    )}
                    {sen.status === 'removed' && <div className="tf-note">Removed before you see it: {sen.note ?? 'no evidence row supports it'}</div>}
                    {sen.status === 'no_claim' && <div className="tf-note tf-note-quiet">No fact claimed, so no source needed</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div ref={tailRef} className="tf-l-tail">
            {L.unverifiable.map((u, i) => <div key={i} className="tf-cant"><b>I can't verify</b> {u.claim}. {u.reason}</div>)}
          </div>
          <div className="tf-gate">Waiting for your approval. Nothing is sent from this view.</div>
        </section>
      )}
    </div>
  );
}
