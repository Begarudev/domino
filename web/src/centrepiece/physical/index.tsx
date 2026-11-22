// wow-physical: the cascade as a literal domino table with real rigid-body physics (Rapier).
import '@fontsource/big-shoulders-display/700';
import '@fontsource/big-shoulders-display/800';
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import './physical.css';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Canvas } from '@react-three/fiber';
import type { CentrepieceModule, CentrepieceProps } from '../contract.ts';
import { buildLayout, fmtFull, addDays, fmtDay, type TableLayout } from './layout.ts';
import { TableScene } from './Scene.tsx';
import { createHud, useHud, type Hud } from './store.ts';

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) { setReady(true); return; }
    Promise.all([
      fonts.load('800 120px "Big Shoulders Display"'),
      fonts.load('600 60px "Schibsted Grotesk"'),
      fonts.load('500 30px "Schibsted Grotesk"'),
    ]).catch(() => null).finally(() => { if (live) setReady(true); });
    const t = setTimeout(() => live && setReady(true), 1500);
    return () => { live = false; clearTimeout(t); };
  }, []);
  return ready;
}

function graphKey(p: CentrepieceProps): string {
  const g = p.snapshot.graph;
  return [
    g.nodes.map((n) => n.id + ':' + (n.confidence ?? '')).join(','),
    g.edges.map((e) => e.id).join(','),
    p.snapshot.replay ? p.snapshot.replay.outcomes.map((o) => o.companyId + (o.hit ? '1' : '0')).join(',') : 'live',
    p.snapshot.baseline.hiringFilterCompanyIds.join(','),
  ].join('|');
}

export function PhysicalCentrepiece(props: CentrepieceProps): JSX.Element {
  const { snapshot, width, height, reducedMotion, hiringFilterView, selection, onSelect, replayToken, running } = props;
  const fontsReady = useFontsReady();
  const key = graphKey(props);
  const layout = useMemo<TableLayout>(() => buildLayout(snapshot), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [runKey, setRunKey] = useState(0);
  const autoplayRef = useRef(false);
  const hud = useMemo(() => createHud({
    phase: 'idle', day: 0, playing: false, status: {}, arrived: {}, dominoHits: 0, baselineHits: 0, focusKey: null, scrubbable: false, runKey,
  }), [runKey, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Replay cascade" from the app: reset the table and play.
  const lastToken = useRef(replayToken);
  useEffect(() => {
    if (replayToken !== lastToken.current) { lastToken.current = replayToken; autoplayRef.current = true; setRunKey((k) => k + 1); }
  }, [replayToken]);

  const selectedCompany = selection && (selection.kind === 'node' || selection.kind === 'target') ? selection.id : null;
  const empty = layout.tiles.length === 0;
  const fullscreen = width >= 1100;

  return (
    <div className={`dp-root${fullscreen ? ' dp-full' : ''}`} style={{ width, height }} data-centrepiece="physical">
      {!empty && fontsReady && (
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
          camera={{ fov: 34, near: 0.1, far: 120, position: [-14, 4, 9] }}
          onPointerMissed={() => onSelect(null)}
          style={{ position: 'absolute', inset: 0, zIndex: 0 }}
        >
          <TableScene
            key={runKey + ':' + key}
            layout={layout} hud={hud} snap={snapshot} reducedMotion={reducedMotion} hiringFilterView={hiringFilterView}
            selectedCompany={selectedCompany} onSelect={onSelect} autoplay={autoplayRef.current} paused={false}
          />
        </Canvas>
      )}
      {empty && (
        <div className="dp-empty">
          <div className="dp-empty-title">{running ? 'Looking for the first domino' : 'No cascade yet'}</div>
          <div className="dp-empty-sub">{running ? 'Tiles stand up here as the cascade step finds companies.' : 'Run a request to set the table.'}</div>
        </div>
      )}
      {!empty && <Hud hud={hud} layout={layout} snapshot={snapshot} onReplay={() => { autoplayRef.current = true; setRunKey((k) => k + 1); }} />}
    </div>
  );
}

function modeBadge(mode: string): { text: string; cls: string } {
  if (mode === 'fixture') return { text: 'Fixture data, fictional companies', cls: 'dp-badge-fixture' };
  if (mode === 'cache') return { text: 'Cached Crustdata responses', cls: 'dp-badge-cache' };
  return { text: 'Live Crustdata', cls: 'dp-badge-live' };
}

function Hud({ hud, layout, snapshot, onReplay }: { hud: Hud; layout: TableLayout; snapshot: CentrepieceProps['snapshot']; onReplay: () => void }) {
  const phase = useHud(hud, (s) => s.phase);
  const day = useHud(hud, (s) => Math.floor(s.day));
  const exactDay = useHud(hud, (s) => s.day);
  const playing = useHud(hud, (s) => s.playing);
  const dHits = useHud(hud, (s) => s.dominoHits);
  const bHits = useHud(hud, (s) => s.baselineHits);
  const status = useHud(hud, (s) => s.status);
  const replay = snapshot.replay;
  const badge = modeBadge(snapshot.dataMode);
  const dateNow = layout.isReplay ? addDays(layout.asOf, day) : layout.asOf;
  // denominators come from the engine's score so the live tally ends on the same numbers as the score card
  const predictedCount = replay?.domino.predicted ?? layout.tiles.filter((t) => t.role === 'target').length;
  const baseCount = replay?.baselineFirstOrder.predicted ?? layout.tiles.filter((t) => t.role === 'baseline').length;
  const frac = layout.horizonDays ? exactDay / layout.horizonDays : 0;

  const caption = !layout.isReplay
    ? (phase === 'idle' ? 'Live run. Press play to tip the trigger.' : phase === 'predict' ? 'The change runs downstream.' : 'Each amber tile is a hypothesis resting on dated evidence. Click one for its sources.')
    : phase === 'idle' ? `Forecast from facts available on ${fmtDay(layout.asOf)} (${replay?.factsAfterAsOfUsed ?? 0} dated after it), then checked against dated signals through ${fmtDay(layout.horizonEnd)}.`
      : phase === 'predict' ? `DOMINO predicts on ${fmtDay(layout.asOf)}. The chain leans on every company it expects to move.`
        : phase === 'replay' ? 'Now the real record: a tile falls only on a dated event.'
          : `Scored on what happened by ${fmtDay(layout.horizonEnd)}.`;

  const offering = snapshot.intent?.offering;
  const question = offering ? `Who will need ${offering}?` : null;
  const hint = !layout.isReplay
    ? (phase === 'idle' ? 'Each tile is a company. Each chain is a dated reason one company\'s change creates another\'s need.' : '')
    : phase === 'idle' ? 'Each tile is a company. Each chain is a dated reason one company\'s change creates another\'s need.'
      : phase === 'replay' ? 'Green: it happened, with the date and the source. Grey: nothing dated yet.'
        : '';

  const baseIds = new Set(snapshot.baseline.hiringFilterCompanyIds);
  const netNewHits = (replay?.outcomes ?? []).filter((o) => o.hit && (o.predictedBy === 'domino') && !baseIds.has(o.companyId)).length;

  const ticks = layout.tiles.filter((t) => t.outcomeDay != null && (t.role === 'target' || t.role === 'baseline'));

  return (
    <div className="dp-hud" aria-live="polite">
      <div className="dp-clock">
        <div className="dp-clock-date">{fmtFull(dateNow)}</div>
        {question && <div className="dp-question">{question}</div>}
        <div className="dp-clock-cap">{caption}</div>
        {hint && <div className="dp-clock-hint">{hint}</div>}
      </div>
      <div className={`dp-badge ${badge.cls}`}>{badge.text}</div>

      {layout.isReplay && phase !== 'idle' && phase !== 'score' && phase !== 'done' && (
        <div className="dp-tally">
          <div><b>{Math.min(dHits, predictedCount)}</b><span>of {predictedCount}</span><i>DOMINO</i></div>
          <div className="dp-tally-base"><b>{Math.min(bHits, baseCount)}</b><span>of {baseCount}</span><i>hiring filter</i></div>
        </div>
      )}

      {phase === 'idle' && (
        <button className="dp-play" onClick={() => hud.set({ playing: true })} autoFocus>
          <span className="dp-play-tri" aria-hidden /> {layout.isReplay ? `Play ${fmtDay(layout.asOf)} to ${fmtDay(layout.horizonEnd)}` : 'Tip the trigger'}
        </button>
      )}
      {(phase === 'score' || phase === 'done') && (
        <div className="dp-score">
          {layout.isReplay && replay ? (
            <>
              {netNewHits > 0 && <div className="dp-score-lead">{netNewHits} {netNewHits === 1 ? 'company' : 'companies'} with dated signals that the hiring filter missed</div>}
              <div className="dp-score-col dp-score-domino">
                <div className="dp-score-num">{replay.domino.hits}<small> of {replay.domino.predicted}</small></div>
                <div className="dp-score-lab">DOMINO picks with a dated signal by {fmtDay(layout.horizonEnd)}</div>
              </div>
              <div className="dp-score-col dp-score-base">
                <div className="dp-score-num">{replay.baselineFirstOrder.hits}<small> of {replay.baselineFirstOrder.predicted}</small></div>
                <div className="dp-score-lab">hiring-filter picks with a dated signal</div>
              </div>
              <div className="dp-score-note">{replay.note}</div>
            </>
          ) : (
            <div className="dp-score-note">
              {layout.tiles.filter((t) => t.role === 'target').length} downstream companies,{' '}
              {layout.tiles.filter((t) => t.role === 'target' && t.netNew).length} a hiring filter would miss. Click a tile for its sources.
            </div>
          )}
          <button className="dp-again" onClick={onReplay}>Replay</button>
        </div>
      )}
      {phase !== 'idle' && phase !== 'score' && phase !== 'done' && (
        <button className="dp-pause" onClick={() => hud.set({ playing: !playing })}>{playing ? 'Pause' : 'Resume'}</button>
      )}

      {layout.isReplay && (
        <div className="dp-timeline">
          <span className="dp-tl-end">{fmtDay(layout.asOf)}</span>
          <div className="dp-tl-track">
            <div className="dp-tl-fill" style={{ width: `${frac * 100}%` }} />
            {ticks.map((t) => {
              const st = status[t.key];
              const done = st === 'hit' || st === 'falling-hit';
              return (
                <div
                  key={t.key}
                  className={`dp-tl-tick ${t.role === 'baseline' ? 'dp-tl-base' : 'dp-tl-dom'}${done ? ' dp-tl-done' : ''}`}
                  style={{ left: `${(t.outcomeDay! / layout.horizonDays) * 100}%` }}
                  title={`${t.name}: ${t.outcome?.outcome ?? ''}`}
                />
              );
            })}
            <div className="dp-tl-head" style={{ left: `${frac * 100}%` }} />
          </div>
          <span className="dp-tl-end">{fmtDay(layout.horizonEnd)}</span>
        </div>
      )}
      <div className="dp-legend">
        <span className="dp-lg dp-lg-amber">predicted</span>
        {layout.isReplay && <span className="dp-lg dp-lg-jade">fell on a dated event</span>}
        {layout.isReplay && <span className="dp-lg dp-lg-ash">still standing</span>}
      </div>
    </div>
  );
}

export const physicalModule: CentrepieceModule = {
  id: 'physical',
  label: 'Domino table (3D physics)',
  Component: PhysicalCentrepiece,
};

export default physicalModule;
