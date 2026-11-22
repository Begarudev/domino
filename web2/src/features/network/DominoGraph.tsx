// Domino graph: where one company's people went in the 90-day window, and whether rule O1 counts each move toward a
// predicted opening (server/domain/openings.ts detectOpenings). A move is judged per role family, never per company:
//   - company headcount outside 20–5,000 → O1 skips the company, so nothing is counted (MIN_STAFF / MAX_STAFF);
//   - no O1 opening for the move's role family → not counted;
//   - named "not conclusive" in that opening's o1.departures clause (month straddles the window start) → not counted;
//   - the family's opening is held by a guard → held; otherwise counted.
// Rendered as a destination table with flow bars: labels never sit on lines. Each row opens its dated source.
import type { CompanyDesk, CompanyDossier, Departure, Opening } from '../../data/desk.ts';
import { ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import { fmtDate } from '../../lib/format.ts';
import { openEvidence } from '../../shell/ui.ts';
import './network.css';

type Kind = 'counted' | 'held' | 'not';
interface Move { d: Departure; kind: Kind; reason: string; left: string; reasonEvidenceId: string | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (iso: string | null) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : 'undated');
const MIN_STAFF = 20, MAX_STAFF = 5_000;
const KIND_LABEL: Record<Kind, string> = { counted: 'Counted by O1', held: 'Held by a guard', not: 'Not counted' };

function judge(desk: CompanyDesk, dossier: CompanyDossier | null): { moves: Move[]; band: string | null } {
  const headcount = (desk.company as { headcount?: number | null }).headcount ?? null;
  const outOfBand = headcount != null && (headcount < MIN_STAFF || headcount > MAX_STAFF);
  const band = outOfBand ? `${headcount!.toLocaleString('en-US')} staff is outside O1's 20–5,000 band` : null;
  const evAll = [...desk.evidence, ...(dossier?.evidence ?? [])];
  const byFamily = new Map<string, Opening>();
  for (const o of desk.openings) if (o.rule === 'O1' && o.roleFamily) byFamily.set(o.roleFamily, o);

  const moves = desk.departures.filter((d) => d.toCompanyName).map((d): Move => {
    const ev = evAll.find((x) => x.id === d.evidenceId);
    const left = month(ev?.observedAt ?? d.date);
    if (band) return { d, kind: 'not', reason: band, left, reasonEvidenceId: null };
    const op = d.roleFamily ? byFamily.get(d.roleFamily) : undefined;
    const fam = d.roleFamily ? ROLE_FAMILY_LABELS[d.roleFamily] : 'unclassified';
    if (!op) return { d, kind: 'not', reason: `no O1 opening for ${fam} (needs 2 conclusive departures)`, left, reasonEvidenceId: null };
    const dep = op.clauses?.find((c) => c.id === 'o1.departures');
    if (dep?.detail?.includes(`${d.role}, `) && dep.detail.includes(`→ ${d.toCompanyName}: not conclusive`))
      return { d, kind: 'not', reason: 'month straddles the 90-day window start', left, reasonEvidenceId: null };
    if (op.status === 'held') {
      const guard = op.clauses?.find((c) => c.state === 'failed' && c.id.startsWith('guard.'));
      return { d, kind: 'held', reason: op.holdReasons?.[0] ?? guard?.text ?? 'a guard matched', left, reasonEvidenceId: guard?.evidenceIds[0] ?? null };
    }
    return { d, kind: 'counted', reason: `toward the ${fam} opening`, left, reasonEvidenceId: null };
  });
  return { moves, band };
}

export function DominoGraph({ desk, dossier, checkedAt }: { desk: CompanyDesk; dossier: CompanyDossier | null; checkedAt?: string | null }) {
  const name = desk.company.name;
  const asOf = checkedAt ?? dossier?.asOf ?? desk.checkedAt ?? null;
  const { moves, band } = judge(desk, dossier);
  const joined = (dossier?.talentFlows ?? []).filter((f) => f.direction === 'in' && f.otherCompanyName);

  const how = (
    <details className="dg-how">
      <summary>How this is computed</summary>
      <p>Reads <code>GET /api/companies/:id</code> (departures, O1 openings and their clauses) and <code>GET /api/companies/:id/dossier</code> (talent flows).
        Moves come from Crustdata person search, dated by the month the person left. Rule O1 runs per role family: it skips companies outside 20–5,000 staff,
        needs 2 conclusive departures inside the 90-day window (a month-only date counts only when the whole month is inside), then guards can hold the opening.
        {asOf ? ` Checked ${fmtDate(asOf, true)}.` : ''}</p>
    </details>
  );

  if (!moves.length) {
    return (
      <section className="panel dg" data-testid="domino-graph">
        <header className="dg-head"><h2>Domino graph</h2></header>
        <p className="dg-none">No dated move from {name} to another company in the 90-day window{asOf ? `, checked ${fmtDate(asOf, true)}` : ''}.
          {joined.length ? ` ${joined.length} ${joined.length === 1 ? 'person' : 'people'} joined ${name}.` : ''}</p>
        {how}
      </section>
    );
  }

  const count = (k: Kind) => moves.filter((m) => m.kind === k).length;
  const counted = count('counted'), held = count('held'), not = count('not');
  const dests = new Map<string, Move[]>();
  for (const m of moves) dests.set(m.d.toCompanyName!, [...(dests.get(m.d.toCompanyName!) ?? []), m]);
  const rows = [...dests.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const max = rows[0][1].length;

  const summary = band
    ? `${moves.length} of ${name}'s people moved to ${rows.length} ${rows.length === 1 ? 'company' : 'companies'}, but none count toward a predicted opening: ${band}.`
    : counted
      ? `${counted} of ${moves.length} moves from ${name} count toward a predicted O1 opening${held ? `, ${held} held by a guard` : ''}${not ? `, ${not} not counted` : ''}.`
      : `${moves.length} moves from ${name}; none count toward a predicted opening yet${held ? ` (${held} held by a guard)` : ''}.`;

  return (
    <section className="panel dg" data-testid="domino-graph">
      <header className="dg-head">
        <div>
          <h2>Domino graph</h2>
          <p className="dg-sum">{summary}</p>
        </div>
        <div className="dg-kpis">
          <span className="kpi counted"><b>{counted}</b>counted</span>
          <span className="kpi held"><b>{held}</b>held</span>
          <span className="kpi not"><b>{not}</b>not counted</span>
          {joined.length > 0 && <span className="kpi in"><b>{joined.length}</b>joined</span>}
        </div>
      </header>
      <p className="dg-legend">
        {(['counted', 'held', 'not'] as Kind[]).map((k) => <span key={k}><i className={`sw ${k}`} />{KIND_LABEL[k]}</span>)}
        <span className="dg-hint">Hover a move for its reason; click to open the dated source.</span>
      </p>
      <div className="dg-table" role="table" aria-label={`Where ${name}'s people went`}>
        <div className="dg-row dg-th" role="row">
          <span role="columnheader">Destination</span><span role="columnheader">Moves</span><span role="columnheader">Who and when, with the O1 verdict</span>
        </div>
        {rows.map(([to, ms], i) => (
          <div className="dg-row" role="row" key={to} style={{ ['--i' as string]: i }}>
            <span className="dg-to" role="cell">{to}</span>
            <span className="dg-bar" role="cell" aria-label={`${ms.length} moves`}>
              <span className="track" style={{ width: `${(ms.length / max) * 100}%` }}>
                {(['counted', 'held', 'not'] as Kind[]).map((k) => {
                  const n = ms.filter((m) => m.kind === k).length;
                  return n ? <i key={k} className={`seg ${k}`} style={{ flex: n }} /> : null;
                })}
              </span>
              <b>{ms.length}</b>
            </span>
            <span className="dg-moves" role="cell">
              {ms.map((m) => (
                <button key={m.d.id} type="button" className={`dg-mv ${m.kind}`} title={`${KIND_LABEL[m.kind]}: ${m.reason}`}
                  onClick={() => m.d.evidenceId && openEvidence(m.reasonEvidenceId ?? m.d.evidenceId)}>
                  <span className="who">{m.d.initial ? `${m.d.initial}, ` : ''}{m.d.role}</span>
                  <span className="when">left {m.left}</span>
                  <span className={`chip ${m.kind}`}><i />{m.kind === 'counted' ? 'Counted' : m.kind === 'held' ? 'Held' : 'Not counted'}</span>
                  <span className="why">{m.reason}</span>
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
      {joined.length > 0 && <p className="dg-in">Joined {name} in the window: {[...new Set(joined.map((f) => f.otherCompanyName))].join(', ')}.</p>}
      {how}
    </section>
  );
}
