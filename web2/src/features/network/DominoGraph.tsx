// Domino graph: the companies around one focal company and the dated moves between them. Hand-built SVG, no library.
// Departures go out (right), arrivals come in (left). An edge is struck ("not counted") when the O1 departures clause
// names it as not conclusive, and held when the company's O1 opening is held. Every edge opens its evidence.
import type { CompanyDesk, CompanyDossier, Departure } from '../../data/desk.ts';
import type { TalentFlow } from '../../../../shared/desk.ts';
import { fmtDate } from '../../lib/format.ts';
import { openEvidence } from '../../shell/ui.ts';
import './network.css';

type Kind = 'counted' | 'struck' | 'held' | 'in';
interface Edge { key: string; other: string; side: 'out' | 'in'; kind: Kind; label: string; note: string | null; evidenceId: string | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (iso: string | null) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : 'undated');
const when = (iso: string | null, precision: 'day' | 'month') => (precision === 'month' ? month(iso) : iso ? fmtDate(iso, true) : 'undated');

function people(rows: { role: string; initial: string | null }[]): string {
  const roles = new Set(rows.map((r) => r.role));
  if (rows.length > 1 && roles.size === 1) return /[a-z]$/i.test(rows[0].role) ? `${rows.length} ${rows[0].role}s` : `${rows.length} people, ${rows[0].role}`;
  if (rows.length === 1) return `${rows[0].initial ? `${rows[0].initial}, ` : ''}${rows[0].role}`;
  return `${rows.length} people`;
}

function buildEdges(desk: CompanyDesk, dossier: CompanyDossier | null): Edge[] {
  const clauses = desk.openings.flatMap((o) => o.clauses ?? []);
  const depDetail = clauses.find((c) => c.id === 'o1.departures')?.detail ?? '';
  const held = desk.openings.find((o) => o.status === 'held') ?? null;
  const heldReason = held?.holdReasons?.[0]?.split(/[:(]/)[0].trim().toLowerCase() || null;
  const heldClause = held?.clauses?.find((c) => c.state === 'failed' && c.id.startsWith('guard.')) ?? null;
  const evAll = [...desk.evidence, ...(dossier?.evidence ?? [])];
  const report = heldClause?.evidenceIds.map((id) => evAll.find((e) => e.id === id)).find((e) => e?.observedAt) ?? null;

  // a departure is dated by the month the person LEFT (evidence end date), as in the O1 clause and Talent flows
  const leftWhen = (d: Departure) => { const e = evAll.find((x) => x.id === d.evidenceId); return e?.observedAt ? when(e.observedAt, e.precision ?? d.precision) : when(d.date, d.precision); };
  const groups = new Map<string, Departure[]>();
  for (const d of desk.departures) {
    if (!d.toCompanyName) continue;
    const k = `${d.toCompanyName}|${leftWhen(d)}`;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const out: Edge[] = [...groups.entries()].map(([k, ds]) => {
    const to = ds[0].toCompanyName as string;
    const struck = depDetail.includes(`→ ${to}: not conclusive`);
    const isHeld = !struck && !!held && ds.every((d) => d.roleFamily === held.roleFamily);
    const kind: Kind = struck ? 'struck' : isHeld ? 'held' : 'counted';
    const note = struck ? 'not counted' : isHeld
      ? `Held: ${heldReason ?? 'guard matched'}${report?.observedAt ? ` · report ${fmtDate(report.observedAt, true)}` : ''}`
      : null;
    return { key: `o:${k}`, other: to, side: 'out', kind, label: `${people(ds)}, ${leftWhen(ds[0])}`, note, evidenceId: (isHeld && report?.id) || ds[0].evidenceId };
  });

  const seen = new Set(out.map((e) => e.other));
  const ins = new Map<string, TalentFlow[]>();
  for (const f of dossier?.talentFlows ?? []) {
    if (f.direction !== 'in' || !f.otherCompanyName || seen.has(f.otherCompanyName)) continue;
    ins.set(f.otherCompanyName, [...(ins.get(f.otherCompanyName) ?? []), f]);
  }
  const inEdges: Edge[] = [...ins.entries()].slice(0, 4).map(([from, fs]) => ({
    key: `i:${from}`, other: from, side: 'in', kind: 'in', label: `${people(fs)}, ${when(fs[0].date, fs[0].precision)}`, note: 'joined', evidenceId: fs[0].evidenceIds[0] ?? null,
  }));
  return [...out, ...inEdges];
}

const W = 960, NODE_H = 36, ROW = 92;

export function DominoGraph({ desk, dossier, checkedAt }: { desk: CompanyDesk; dossier: CompanyDossier | null; checkedAt?: string | null }) {
  const edges = buildEdges(desk, dossier);
  const name = desk.company.name;
  const asOf = checkedAt ?? dossier?.asOf ?? desk.checkedAt ?? null;

  if (!edges.length) {
    return (
      <section className="panel dg" data-testid="domino-graph">
        <header><h2>Domino graph</h2></header>
        <p className="dg-none">No dated move from {name} to another company in the 90-day window{asOf ? ` · checked ${fmtDate(asOf, true)}` : ''}.</p>
      </section>
    );
  }

  const outs = edges.filter((e) => e.side === 'out');
  const ins = edges.filter((e) => e.side === 'in');
  const rows = Math.max(outs.length, ins.length, 1);
  const H = rows * ROW + 24;
  const cy = H / 2, cx = ins.length ? W / 2 : 200;
  const fw = Math.max(120, name.length * 9 + 32);
  const yAt = (i: number, n: number) => cy + (i - (n - 1) / 2) * ROW;
  const counted = outs.filter((e) => e.kind === 'counted').length;

  return (
    <section className="panel dg" data-testid="domino-graph">
      <header>
        <h2>Domino graph</h2>
        <span className="faint">{outs.length} out · {ins.length} in{asOf ? ` · checked ${fmtDate(asOf, true)}` : ''}</span>
      </header>
      <svg className="dg-svg" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Moves between ${name} and other companies`}>
        {[...outs.map((e, i) => ({ e, y: yAt(i, outs.length) })), ...ins.map((e, i) => ({ e, y: yAt(i, ins.length) }))].map(({ e, y }, i) => {
          const x0 = e.side === 'out' ? cx + fw / 2 : 150;
          const x1 = e.side === 'out' ? W - 150 : cx - fw / 2;
          const y0 = e.side === 'out' ? cy : y, y1 = e.side === 'out' ? y : cy;
          const span = x1 - x0, ca = e.side === 'out' ? x0 + span * 0.22 : x0 + span * 0.6, cb = e.side === 'out' ? x0 + span * 0.4 : x0 + span * 0.78;
          const d = `M${x0},${y0} C${ca},${y0} ${cb},${y1} ${x1},${y1}`; // fan out early, run flat under the label
          const lx = e.side === 'out' ? x1 - 14 : x0 + 14;
          const anchor = e.side === 'out' ? 'end' : 'start';
          const open = () => e.evidenceId && openEvidence(e.evidenceId);
          return (
            <g key={e.key} className={`dg-e ${e.kind}${e.evidenceId ? ' link' : ''}`} style={{ ['--i' as string]: i }}
              role={e.evidenceId ? 'button' : undefined} tabIndex={e.evidenceId ? 0 : undefined}
              aria-label={`${e.side === 'out' ? `${name} to ${e.other}` : `${e.other} to ${name}`}: ${e.label}${e.note ? `, ${e.note}` : ''}`}
              onClick={open} onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); open(); } }}>
              <path className="hit" d={d} />
              <path className="ln" d={d} pathLength={1} markerEnd={`url(#dg-arrow-${e.kind})`} />
              <text className="lbl" x={lx} y={y - 28} textAnchor={anchor}>{e.label}</text>
              {e.note && <text className="note" x={lx} y={y - 12} textAnchor={anchor}>{e.note}</text>}
            </g>
          );
        })}
        <defs>
          {(['counted', 'struck', 'held', 'in'] as Kind[]).map((k) => (
            <marker key={k} id={`dg-arrow-${k}`} className={`dg-m ${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" />
            </marker>
          ))}
        </defs>
        {outs.map((e, i) => <Node key={e.key} x={W - 150} y={yAt(i, outs.length)} label={e.other} side="out" kind={e.kind} />)}
        {ins.map((e, i) => <Node key={e.key} x={150} y={yAt(i, ins.length)} label={e.other} side="in" kind={e.kind} />)}
        <g className="dg-n focal">
          <rect x={cx - fw / 2} y={cy - NODE_H / 2} width={fw} height={NODE_H} rx={6} />
          <text x={cx} y={cy + 5} textAnchor="middle">{name}</text>
        </g>
      </svg>
      <p className="dg-legend">
        <span><i className="sw counted" />counted by O1 ({counted})</span>
        <span><i className="sw held" />held by a guard</span>
        <span><i className="sw struck" />not counted</span>
        {ins.length > 0 && <span><i className="sw in" />joined {name}</span>}
        <span className="faint">Click an edge for its dated source.</span>
      </p>
    </section>
  );
}

function Node({ x, y, label, side, kind }: { x: number; y: number; label: string; side: 'out' | 'in'; kind: Kind }) {
  const w = Math.max(96, label.length * 8 + 28);
  const left = side === 'out' ? x : x - w;
  return (
    <g className={`dg-n ${kind}`}>
      <rect x={left} y={y - NODE_H / 2} width={w} height={NODE_H} rx={6} />
      <text x={left + w / 2} y={y + 5} textAnchor="middle">{label}</text>
    </g>
  );
}
