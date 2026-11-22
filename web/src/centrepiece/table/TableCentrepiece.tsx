// The default centrepiece: the cascade drawn as a domino run on a walnut table.
// Each GraphNode is a bone tile (top half: the dated change; bottom half: the predicted need + confidence).
// When the cascade is built, tiles tip in edge `order`, each edge drawing toward the next tile.
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Evidence, GraphEdge, GraphNode, Mechanism, RunSnapshot } from '../../../../shared/types.ts';
import type { CentrepieceModule, CentrepieceProps } from '../contract.ts';
import { fmtRange } from '../../dates.ts';
import './table.css';

const W = 156;            // tile width (viewBox units)
const H = 296;            // tile height (a real domino is 1:2)
const HALF = H / 2;
const COL_GAP = 210;      // room for the edge label between columns
const ROW_GAP = 40;
const LABEL = 30;         // mechanism label under each tile
const PAD = 18;
const TIP_DEG = 14;
const STAGGER = 720;      // ms between edges

export const MECH_LABEL: Record<Mechanism, string> = {
  TALENT_DRAIN: 'Talent drain',
  DISPLACEMENT: 'Displacement',
  CONTAGION: 'Contagion',
  CAPITAL: 'Capital',
  DIRECT: 'Direct',
};

function mechanismText(n: GraphNode) {
  if (!n.mechanisms.length) return n.confidence == null ? 'Trigger' : '';
  const main = n.mechanisms.filter((m) => m !== 'CAPITAL');
  const parts = (main.length ? main : n.mechanisms).map((m) => MECH_LABEL[m]);
  if (n.mechanisms.includes('CAPITAL') && main.length) parts.push('capital');
  const text = parts.join(', ').replace(/, capital$/, ' + capital');
  return n.mechanisms.includes('DIRECT') ? `${text}, the baseline pick` : text;
}

interface Placed { node: GraphNode; x: number; y: number; col: number; row: number }

const SUB_GAP = 44;       // gap between tiles of the same tier when a tier wraps into several columns

/** Columns by tier; rows ordered by parents. Tries every row count and keeps the one with the biggest tiles. */
function layout(nodes: GraphNode[], edges: GraphEdge[], slotW: number, slotH: number) {
  const tiers = [...new Set(nodes.map((n) => n.tier))].sort((a, b) => a - b);
  const cols: GraphNode[][] = tiers.map((t) => nodes.filter((n) => n.tier === t));
  const maxN = Math.max(1, ...cols.map((c) => c.length));
  let best: { placed: Map<string, Placed>; vw: number; vh: number; scale: number } | null = null;
  for (let rows = 1; rows <= maxN; rows++) {
    const rowOf = new Map<string, number>();
    const placed = new Map<string, Placed>();
    let x = PAD;
    cols.forEach((col, ci) => {
      const want = (n: GraphNode) => {
        const parents = edges.filter((e) => e.to === n.id).map((e) => rowOf.get(e.from)).filter((r): r is number => r !== undefined);
        return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : col.indexOf(n);
      };
      const ordered = [...col].sort((a, b) => want(a) - want(b));
      const sub = Math.ceil(ordered.length / rows);
      // Single-column tiers keep their parents' rows; wrapped tiers fill column by column.
      const taken = new Set<number>();
      ordered.forEach((n, i) => {
        let r: number, j: number;
        if (sub === 1) {
          r = Math.min(rows - 1, Math.max(0, Math.round(want(n))));
          while (taken.has(r)) r = (r + 1) % rows;
          taken.add(r);
          j = 0;
        } else {
          j = Math.floor(i / rows);
          r = i % rows;
        }
        rowOf.set(n.id, r);
        placed.set(n.id, { node: n, col: ci, row: r, x: x + j * (W + SUB_GAP), y: PAD + r * (H + LABEL + ROW_GAP) });
      });
      x += sub * W + (sub - 1) * SUB_GAP + (ci < cols.length - 1 ? COL_GAP : 0);
    });
    const vw = x + PAD + 70;
    const vh = PAD * 2 + rows * (H + LABEL) + (rows - 1) * ROW_GAP;
    const scale = Math.min(slotW / vw, slotH / vh);
    if (!best || scale > best.scale + 0.001) best = { placed, vw, vh, scale };
  }
  return best!;
}

/** Fire time (ms) per node and per edge, from the edges' animation order. */
function schedule(nodes: GraphNode[], edges: GraphEdge[]) {
  const node = new Map<string, number>();
  const edge = new Map<string, number>();
  const sorted = [...edges].sort((a, b) => a.order - b.order);
  sorted.forEach((e, i) => {
    const t0 = 300 + i * STAGGER;
    if (!node.has(e.from)) node.set(e.from, t0);
    const start = Math.max(t0, node.get(e.from)!) + 380;
    edge.set(e.id, start);
    if (!node.has(e.to)) node.set(e.to, start + 420);
  });
  nodes.forEach((n) => { if (!node.has(n.id)) node.set(n.id, 300); });
  return { node, edge };
}

function pips(count: number, cy: number) {
  const n = Math.max(0, Math.min(6, count));
  const gap = 17;
  const x0 = W / 2 - ((n - 1) * gap) / 2;
  return Array.from({ length: n }, (_, i) => <circle key={i} className="pip" cx={x0 + i * gap} cy={cy} r={4.4} />);
}

function nodeChange(n: GraphNode, snap: RunSnapshot, evById: Map<string, Evidence>) {
  // The primary change is the trigger with the most evidence (a talent move spans several dated hires).
  const trigs = snap.triggers.filter((t) => n.triggerIds.includes(t.id))
    .sort((a, b) => b.evidenceIds.length - a.evidenceIds.length || a.date.localeCompare(b.date));
  const dated = n.evidenceIds.map((id) => evById.get(id)).filter((e): e is Evidence => !!e && !!e.observedAt && e.verifiable);
  const primary = trigs[0];
  const text = primary?.summary ?? dated[0]?.claim ?? 'Change recorded';
  const primaryDates = primary ? primary.evidenceIds.map((id) => evById.get(id)?.observedAt).filter(Boolean) : [];
  const date = fmtRange(primaryDates.length ? primaryDates : primary ? [primary.date] : dated.map((e) => e.observedAt));
  return { text, date, datedCount: dated.length };
}

function Tile(props: {
  p: Placed; snap: RunSnapshot; evById: Map<string, Evidence>; fireAt: number | null; selected: boolean;
  dimmed: boolean; stamp: boolean; onSelect: () => void; reducedMotion: boolean;
}) {
  const { p, snap, evById, fireAt, selected, dimmed, stamp, onSelect, reducedMotion } = props;
  const n = p.node;
  const unverifiable = n.status === 'unverifiable';
  const change = nodeChange(n, snap, evById);
  const conf = n.confidence;
  const confPips = conf == null ? 0 : Math.round(conf * 6);
  const fired = fireAt !== null;
  const style = {
    '--fire-delay': `${fireAt ?? 0}ms`,
    '--tip': `${unverifiable ? 0 : TIP_DEG}deg`,
    transformOrigin: `${p.x + W}px ${p.y + H}px`,
  } as CSSProperties;
  const cls = ['tile', fired ? 'is-fired' : 'is-standing', unverifiable ? 'is-hollow' : '', selected ? 'is-selected' : '', dimmed ? 'is-dimmed' : '', reducedMotion ? 'no-motion' : ''].join(' ');
  const label = `${n.name}. ${change.text}, ${change.date}. ${n.need ?? 'Trigger company'}${conf != null ? `, confidence ${Math.round(conf * 100)}%` : ''}${unverifiable ? ", can't verify" : ''}`;
  return (
    <g className={cls}>
      <text className="tile-mech" x={p.x + 2} y={p.y + H + 24}>{mechanismText(n)}</text>
      <g
        className="tile-body" style={style} tabIndex={0} role="button" aria-pressed={selected} aria-label={label}
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      >
        <rect className="tile-shadow" x={p.x} y={p.y} width={W} height={H} rx={14} />
        <rect className="tile-face" x={p.x} y={p.y} width={W} height={H} rx={14} />
        <rect className="tile-bevel" x={p.x + 3} y={p.y + 3} width={W - 6} height={H - 6} rx={11} />
        <rect className="tile-ring" x={p.x - 5} y={p.y - 5} width={W + 10} height={H + 10} rx={18} />
        <g transform={`translate(${p.x} ${p.y})`}>
          <foreignObject x={12} y={14} width={W - 24} height={HALF - 38}>
            <div className="tile-top">
              <div className="tile-name">{n.name}</div>
              <div className="tile-change">{change.text}</div>
              <div className="tile-date">{change.date}</div>
            </div>
          </foreignObject>
          {pips(change.datedCount, HALF - 15)}
          <rect className="tile-divider" x={14} y={HALF - 2} width={W - 28} height={4} rx={2} />
          <circle className="tile-spinner" cx={W / 2} cy={HALF} r={4.5} />
          {pips(confPips, HALF + 15)}
          <foreignObject x={12} y={HALF + 30} width={W - 24} height={HALF - 42}>
            <div className="tile-bottom">
              {conf == null ? (
                <div className="tile-need tile-blank">Trigger only, not a target</div>
              ) : (
                <div className="tile-need">{n.need}</div>
              )}
              {unverifiable ? (
                <div className="tile-cant">Can't verify<span>needs 2 dated rows</span></div>
              ) : conf != null ? (
                <div className="tile-conf"><span className="num">{Math.round(conf * 100)}</span><span className="unit">%</span></div>
              ) : null}
            </div>
          </foreignObject>
        </g>
      </g>
      {stamp && (
        <g className="tile-stamp" transform={`rotate(-9 ${p.x + W / 2} ${p.y + H / 2})`}>
          <rect x={p.x - 6} y={p.y + H / 2 - 22} width={W + 12} height={44} rx={4} />
          <text x={p.x + W / 2} y={p.y + H / 2 - 3} textAnchor="middle">Missed by a</text>
          <text x={p.x + W / 2} y={p.y + H / 2 + 14} textAnchor="middle">hiring filter</text>
        </g>
      )}
    </g>
  );
}

function edgeGeometry(a: Placed, b: Placed, tipped: boolean) {
  const th = (TIP_DEG * Math.PI) / 180;
  // Mid-point of the from-tile's right edge, after it tips about its bottom-right corner.
  const x1 = a.x + W + (tipped ? (HALF) * Math.sin(th) : 0) + 6;
  const y1 = a.y + H - HALF * (tipped ? Math.cos(th) : 1);
  const x2 = b.x - 8;
  const y2 = b.y + HALF;
  const dx = (x2 - x1) * 0.5;
  const d = Math.abs(y2 - y1) < 2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  return { d, x1, y1, x2, y2 };
}

function TableCentrepiece(props: CentrepieceProps) {
  const { snapshot: snap, selection, onSelect, hiringFilterView, reducedMotion, width, height, replayToken } = props;
  // The table shows the cascade itself: nodes on a cross-company edge, plus ranked targets.
  // Companies that were scanned but never linked stay off the table (counted in a footnote).
  // A self-loop (DIRECT: the company itself is hiring) is a property of the tile, not a line.
  const { nodes, edges, offTable } = useMemo(() => {
    const all = snap.graph;
    const lines = all.edges.filter((e) => e.from !== e.to);
    const linked = new Set(lines.flatMap((e) => [e.from, e.to]));
    const targets = new Set(snap.targets.map((t) => t.companyId));
    const keep = all.nodes.filter((n) => linked.has(n.id) || targets.has(n.id) || (lines.length === 0 && n.status === 'hypothesis'));
    return { nodes: keep, edges: lines, offTable: all.nodes.length - keep.length };
  }, [snap.graph, snap.targets]);
  const cascadeDone = snap.steps.find((s) => s.step === 'cascade')?.status === 'done';
  const { placed, vw, vh } = useMemo(() => layout(nodes, edges, width || 800, height || 500), [nodes, edges, width, height]);
  const showLabels = edges.length <= 6;
  const times = useMemo(() => schedule(nodes, edges), [nodes, edges]);
  const evById = useMemo(() => new Map(snap.evidence.map((e) => [e.id, e])), [snap.evidence]);
  const baseline = new Set(snap.baseline.hiringFilterCompanyIds);
  const animate = cascadeDone && (edges.length > 0 || nodes.length > 0);

  if (!nodes.length) {
    return (
      <div className="table-empty" style={{ width, height }}>
        <EmptyRun snap={snap} running={props.running} />
      </div>
    );
  }

  return (
    <div className="table-wrap" style={{ width, height }} onClick={() => onSelect(null)}>
      <svg
        key={`${replayToken}-${animate ? 1 : 0}`}
        className={`table-svg${animate ? ' is-playing' : ''}${hiringFilterView ? ' hf-view' : ''}`}
        viewBox={`0 0 ${vw} ${vh}`} width={width} height={height} preserveAspectRatio="xMidYMid meet"
        role="group" aria-label="Cascade: each tile is a company, each line a dated change that creates a need downstream"
      >
        <defs>
          <linearGradient id="bone" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#F7F1E4" />
            <stop offset="1" stopColor="#E4D9C3" />
          </linearGradient>
          <filter id="tile-shadow" x="-30%" y="-20%" width="180%" height="160%">
            <feDropShadow dx="7" dy="12" stdDeviation="8" floodColor="#0B0806" floodOpacity="0.62" />
          </filter>
        </defs>
        {edges.map((e) => {
          const a = placed.get(e.from), b = placed.get(e.to);
          if (!a || !b) return null;
          const g = edgeGeometry(a, b, animate && a.node.status !== 'unverifiable');
          const sel = selection?.kind === 'edge' && selection.id === e.id;
          const weak = b.node.status === 'unverifiable';
          const midX = (g.x1 + g.x2) / 2;
          const labelW = Math.max(120, g.x2 - g.x1 - 30);
          const style = { '--draw-delay': `${times.edge.get(e.id) ?? 0}ms` } as CSSProperties;
          return (
            <g key={e.id} className={`edge${weak ? ' is-weak' : ''}${sel ? ' is-selected' : ''}${reducedMotion ? ' no-motion' : ''}`} style={style}>
              <path className="edge-track" d={g.d} />
              <path className="edge-line" d={g.d} pathLength={1} />
              <circle className="edge-head" cx={g.x2} cy={g.y2} r={4.5} />
              <path
                className="edge-hit" d={g.d} tabIndex={0} role="button" aria-pressed={sel}
                aria-label={`${e.label}. ${MECH_LABEL[e.mechanism]}, confidence ${Math.round(e.confidence * 100)}%`}
                onClick={(ev) => { ev.stopPropagation(); onSelect({ kind: 'edge', id: e.id }); }}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect({ kind: 'edge', id: e.id }); } }}
              />
              {(showLabels || sel) && <foreignObject x={midX - labelW / 2} y={Math.min(g.y1, g.y2) - 92} width={labelW} height={86} className="edge-fo">
                <div className="edge-label" onClick={(ev) => { ev.stopPropagation(); onSelect({ kind: 'edge', id: e.id }); }}>
                  <span>{e.label}</span>
                  <span className="edge-meta">{MECH_LABEL[e.mechanism]} {Math.round(e.confidence * 100)}%</span>
                </div>
              </foreignObject>}
            </g>
          );
        })}
        {[...placed.values()].map((p) => {
          const n = p.node;
          const isTargetish = n.confidence != null;
          const inBaseline = baseline.has(n.id);
          return (
            <Tile
              key={n.id} p={p} snap={snap} evById={evById} reducedMotion={reducedMotion}
              fireAt={animate ? times.node.get(n.id) ?? 0 : null}
              selected={(selection?.kind === 'node' || selection?.kind === 'target') && selection.id === n.id}
              dimmed={hiringFilterView && !inBaseline}
              stamp={hiringFilterView && !inBaseline && isTargetish}
              onSelect={() => onSelect({ kind: 'node', id: n.id })}
            />
          );
        })}
      </svg>
      {!showLabels && <p className="table-foot table-foot-right">{edges.length} lines: select one to read its dated evidence</p>}
      {offTable > 0 && <p className="table-foot">{offTable} more scanned {offTable === 1 ? 'company has' : 'companies have'} no dated link in the cascade and stay off the table.</p>}
    </div>
  );
}

function EmptyRun({ snap, running }: { snap: RunSnapshot; running: boolean }) {
  const step = snap.steps.find((s) => s.status === 'running');
  return (
    <div className="table-empty-inner">
      <svg viewBox="0 0 420 140" width={420} height={140} aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} x={30 + i * 78} y={20} width={46} height={92} rx={6} className={`ghost-tile${running ? ' is-waiting' : ''}`} style={{ animationDelay: `${i * 160}ms` }} />
        ))}
      </svg>
      <p>{running ? `${step?.label ?? 'Working'}. Tiles stand up here as the cascade is built.` : 'Run a request. Each company DOMINO finds stands here as a tile, and dated changes knock the next one over.'}</p>
    </div>
  );
}

export const tableModule: CentrepieceModule = {
  id: 'table',
  label: 'Domino table',
  Component: TableCentrepiece,
};
