// The table: each cross-company edge is a row of domino tiles, A -> B -> need, stamped with its dated source.
// An edge that cannot carry two dated rows cracks and drops out as "I can't verify".
import type { CSSProperties } from 'react';
import type { Selection } from '../contract.ts';
import type { ChainRow, ChainTile } from './model.ts';
import { MECHANISM_LABEL } from './model.ts';

// Domino pip layouts on a 3x3 grid (cells 0..8), 0 to 6 pips.
const PIPS: number[][] = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];

export function Pips({ n, tone = 'ink' }: { n: number; tone?: 'ink' | 'brass' }) {
  const cells = PIPS[Math.max(0, Math.min(6, n))];
  return (
    <span className={`mc-pips mc-pips--${tone}`} aria-label={`${n} dated source${n === 1 ? '' : 's'}`}>
      {Array.from({ length: 9 }, (_, i) => <i key={i} className={cells.includes(i) ? 'on' : ''} />)}
    </span>
  );
}

// Perimeter points (percent) the crack fans out to; consecutive pairs plus the crack centre form shards.
const RIM: [number, number][] = [[0, 0], [34, 0], [71, 0], [100, 0], [100, 42], [100, 100], [62, 100], [27, 100], [0, 100], [0, 52]];
const CRACK: [number, number] = [54, 46];

function shardStyle(i: number): CSSProperties {
  const a = RIM[i];
  const b = RIM[(i + 1) % RIM.length];
  const mx = (a[0] + b[0] + CRACK[0]) / 3 - CRACK[0];
  const my = (a[1] + b[1] + CRACK[1]) / 3 - CRACK[1];
  return {
    clipPath: `polygon(${CRACK[0]}% ${CRACK[1]}%, ${a[0]}% ${a[1]}%, ${b[0]}% ${b[1]}%)`,
    ['--tx' as string]: `${mx * 2.2}px`,
    ['--ty' as string]: `${140 + Math.abs(my) * 2 + (i % 3) * 30}px`,
    ['--rot' as string]: `${(i % 2 ? 1 : -1) * (18 + i * 7)}deg`,
    ['--sd' as string]: `${(i % 4) * 40}ms`,
  };
}

function Stamp({ endpoint, dates, onClick, tone = 'ink' }: { endpoint: string; dates: string; onClick?: () => void; tone?: 'ink' | 'alarm' }) {
  return (
    <button type="button" className={`mc-stamp mc-stamp--${tone}`} onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
      <span className="mc-stamp__src">{endpoint}</span>
      <span className="mc-stamp__date">{dates}</span>
    </button>
  );
}

function Tile({ tile, role, delay, selected, dimmed, onSelect }: {
  tile: ChainTile; role: 'from' | 'to'; delay: number; selected: boolean; dimmed: boolean; onSelect: (s: Selection) => void;
}) {
  return (
    <div
      className={`mc-tile mc-tile--${role}${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
      style={{ ['--d' as string]: `${delay}ms` }}
      role="button"
      tabIndex={0}
      onClick={() => onSelect({ kind: 'node', id: tile.nodeId })}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ kind: 'node', id: tile.nodeId }); }}
    >
      <div className="mc-tile__face">
        <span className="mc-tile__name">{tile.name}</span>
        <span className="mc-tile__fact">{tile.fact}</span>
      </div>
      <div className="mc-tile__groove" />
      <div className="mc-tile__pips"><Pips n={tile.pips} /></div>
      {tile.stampEndpoint && (
        <Stamp endpoint={tile.stampEndpoint} dates={tile.dates} onClick={() => tile.stampEvidenceId && onSelect({ kind: 'evidence', id: tile.stampEvidenceId })} />
      )}
      {dimmed && <span className="mc-tile__filter">A hiring filter sees this one</span>}
    </div>
  );
}

function NeedFace({ row }: { row: ChainRow }) {
  const pct = Math.round(row.need.confidence * 100);
  return (
    <>
      <div className="mc-need__top">
        <span className="mc-need__mech">{MECHANISM_LABEL[row.need.mechanism]}</span>
        <span className="mc-need__conf">{pct}<small>%</small></span>
      </div>
      <span className="mc-need__text">{row.need.text}</span>
      <span className="mc-need__bar"><i style={{ width: `${pct}%` }} /></span>
    </>
  );
}

function Need({ row, delay, selected, onSelect }: { row: ChainRow; delay: number; selected: boolean; onSelect: (s: Selection) => void }) {
  const companyId = row.edge.to;
  if (row.unverifiable) {
    return (
      <div className="mc-need mc-need--broken" style={{ ['--d' as string]: `${delay}ms` }}>
        <div className="mc-need__ghost">
          <strong>I can't verify this</strong>
          <span>{row.unverifiable.reason}</span>
          <em>Kept out of every message</em>
        </div>
        <div className="mc-need__intact"><NeedFace row={row} /></div>
        <svg className="mc-crack" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {RIM.map(([x, y], i) => <line key={i} x1={CRACK[0]} y1={CRACK[1]} x2={x} y2={y} pathLength={1} />)}
        </svg>
        <div className="mc-shards" aria-hidden="true">
          {RIM.map((_, i) => <div key={i} className="mc-shard" style={shardStyle(i)}><NeedFace row={row} /></div>)}
        </div>
        <span className="mc-need__reject">1 dated row · needs 2</span>
      </div>
    );
  }
  return (
    <div
      className={`mc-need${row.need.netNew ? ' is-netnew' : ''}${selected ? ' is-selected' : ''}`}
      style={{ ['--d' as string]: `${delay}ms` }}
      role="button"
      tabIndex={0}
      onClick={() => onSelect({ kind: 'target', id: companyId })}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ kind: 'target', id: companyId }); }}
    >
      <NeedFace row={row} />
      <div className="mc-need__foot">
        <Pips n={row.need.datedRows} tone="brass" />
        <span>Rule fired on {row.need.datedRows} dated rows</span>
      </div>
      {row.need.netNew && <span className="mc-need__netnew">A hiring filter misses this</span>}
    </div>
  );
}

function Link({ row, delay, selected, onSelect, label }: { row: ChainRow; delay: number; selected: boolean; onSelect: (s: Selection) => void; label: string }) {
  return (
    <button
      type="button"
      className={`mc-link${selected ? ' is-selected' : ''}`}
      style={{ ['--d' as string]: `${delay}ms` }}
      onClick={() => onSelect({ kind: 'edge', id: row.edge.id })}
    >
      <span className="mc-link__label">{label}</span>
      <span className="mc-link__line"><i /></span>
    </button>
  );
}

export function ChainStage({ rows, settledSeq, selection, onSelect, hiringFilterView, reducedMotion, maxRows }: {
  rows: ChainRow[]; settledSeq: number; selection: Selection | null; onSelect: (s: Selection | null) => void;
  hiringFilterView: boolean; reducedMotion: boolean; maxRows: number;
}) {
  const shown = rows.slice(0, maxRows);
  let animIndex = 0;
  const isSel = (kind: Selection['kind'], id: string) => selection?.kind === kind && selection.id === id;
  return (
    <div className="mc-chains" data-count={shown.length}>
      {shown.map((row, i) => {
        const animate = !reducedMotion && row.seq > settledSeq;
        const base = animate ? animIndex++ * 900 : 0;
        const step = 320;
        return (
          <div key={row.edge.id} className={`mc-row${animate ? ' is-live' : ' is-settled'}${i === 0 ? ' is-lead' : ''}${row.unverifiable ? ' is-broken' : ''}`}>
            <Tile tile={row.from} role="from" delay={base} selected={isSel('node', row.from.nodeId)} dimmed={hiringFilterView && !row.from.netNew} onSelect={onSelect} />
            <Link row={row} delay={base + step} selected={isSel('edge', row.edge.id)} onSelect={onSelect} label={MECHANISM_LABEL[row.edge.mechanism]} />
            <Tile tile={row.to} role="to" delay={base + step * 2} selected={isSel('node', row.to.nodeId)} dimmed={hiringFilterView && !row.to.netNew} onSelect={onSelect} />
            <Link row={row} delay={base + step * 3} selected={false} onSelect={onSelect} label="so it needs" />
            <Need row={row} delay={base + step * 4} selected={isSel('target', row.edge.to)} onSelect={onSelect} />
          </div>
        );
      })}
      {rows.length > shown.length && <div className="mc-chains__more">{rows.length - shown.length} more edges in the graph</div>}
    </div>
  );
}

/** A claim with no dated source, shown once in the middle of the table, then broken and filed in the tray. */
export function LooseClaim({ claim, reason, animate }: { claim: string; reason: string; animate: boolean }) {
  return (
    <div className={`mc-loose${animate ? ' is-live' : ' is-settled'}`}>
      <div className="mc-loose__ghost"><strong>I can't verify</strong> {claim}. <span>{reason}.</span></div>
      <div className="mc-loose__card">
        <span className="mc-loose__claim">{claim}</span>
        <span className="mc-loose__why">{reason}</span>
      </div>
      <div className="mc-shards" aria-hidden="true">
        {RIM.map((_, i) => (
          <div key={i} className="mc-shard mc-shard--loose" style={shardStyle(i)}>
            <span className="mc-loose__claim">{claim}</span>
            <span className="mc-loose__why">{reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
