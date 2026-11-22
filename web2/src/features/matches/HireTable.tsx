// "People you can hire": opted-in candidates whose consented fields meet the opening, fit shown field by field.
// No score. A claim the desk can't check is struck and says "I can't verify". People appear as an initial.
import type { Evidence } from '../../../../shared/types.ts';
import type { CompanyDesk, IntroRequest, Match, Opening, Provenance } from '../../data/desk.ts';
import { navigate } from '../../data/router.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { fmtDate, fmtTime } from '../../lib/format.ts';
import { openEvidence } from '../../shell/ui.ts';

const FIELD: Record<string, string> = { history: 'work history', skills: 'skills', samples: 'work samples', headline: 'headline' };
const initialOf = (label: string) => (label.trim()[0] ?? '?').toUpperCase() + '.';

export function HireTable({ desk, opening, routeId, source, ev }: {
  desk: CompanyDesk; opening: Opening | null; routeId: string; source: Provenance | null; ev: Map<string, Evidence>;
}) {
  const introOf = (m: Match) => desk.intros.find((r) => r.candidateId === m.candidateId && r.openingId === m.openingId);
  // One row per person: test runs can leave several fixture copies of the same candidate. Keep the one with an intro.
  const all = opening ? desk.matches.filter((m) => m.openingId === opening.id) : [];
  const rows = [...all].sort((a, b) => Number(!!introOf(b)) - Number(!!introOf(a)))
    .filter((m, i, xs) => xs.findIndex((x) => x.candidateLabel === m.candidateLabel) === i);
  const sample = source === 'fixture' || source === 'sample';
  return (
    <div className="panel rec-full" data-testid="hire-panel">
      <header>
        <h2>People you can hire</h2>
        <span className="faint">opted-in candidates only{sample && <> <span className="sample-tag">Sample</span></>}</span>
      </header>
      {opening?.status === 'held' ? (
        <p className="rec-empty">No candidate is matched to a held decision. DOMINO matches only when O1 predicts an opening.</p>
      ) : !rows.length ? (
        <p className="rec-empty" data-testid="hire-empty">
          <b>No opted-in candidate fits this opening yet.</b>
          <span className="muted">A candidate appears here once they opt in and their confirmed fields meet the {opening ? 'role family' : 'opening'}.</span>
        </p>
      ) : (
        <table className="t rec-hire">
          <thead><tr><th style={{ width: '16%' }}>Candidate</th><th>Fit, field by field</th><th style={{ width: '17%' }}>Source</th><th style={{ width: 260 }} aria-label="Action" /></tr></thead>
          <tbody>
            {rows.map((m) => (
              <HireRow key={m.candidateId} m={m} ev={ev} intro={introOf(m)}
                onAsk={() => navigate({ page: 'company', id: routeId, tab: 'outreach' })} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HireRow({ m, ev, intro, onAsk }: { m: Match; ev: Map<string, Evidence>; intro?: IntroRequest; onAsk: () => void }) {
  const ref = useEnterOnce<HTMLTableRowElement>();
  const cited = m.fit.map((f) => (f.evidenceId ? ev.get(f.evidenceId) : undefined)).find(Boolean);
  const fields = [...new Set(m.fit.filter((f) => f.status === 'verified' && f.profileField).map((f) => FIELD[f.profileField!] ?? f.profileField!))];
  const requested = intro && intro.direction === 'candidate_to_company' && intro.status !== 'delivered';
  return (
    <tr ref={ref} data-testid={`match-${m.candidateId}`}>
      <td>
        <b>{initialOf(m.candidateLabel)}</b>
        {requested && <div className="rec-gap"><span className="st prov">Requested an intro{intro?.status === 'awaiting_approval' ? ' · awaiting your approval' : ''}</span></div>}
      </td>
      <td>
        <ul className="rec-fit">
          {m.fit.filter((f) => f.profileField || f.status !== 'verified').map((f, i) => (
            <li key={i}>
              {f.status === 'verified' ? (
                <>
                  <span className="tick" aria-label="verified">✓</span>{' '}
                  <span>{f.text}</span>
                  {f.profileField && (f.evidenceId
                    ? <button type="button" className="srclink rec-field" onClick={() => openEvidence(f.evidenceId!)}>{FIELD[f.profileField] ?? f.profileField}</button>
                    : <span className="faint rec-field">{FIELD[f.profileField] ?? f.profileField}</span>)}
                </>
              ) : (
                <><span className="struck">{f.text}</span><span className="cant">I can’t verify</span></>
              )}
            </li>
          ))}
          {m.fit.some((f) => f.status === 'verified' && !f.profileField) && (
            <li className="faint">+ {m.fit.filter((f) => f.status === 'verified' && !f.profileField).length} verified opening facts, cited above</li>
          )}
        </ul>
      </td>
      <td className="muted">
        {cited ? <>{cited.source.endpoint.replace(/^\//, '')}, {fmtDate(cited.observedAt)}</> : 'candidate profile'}
        {fields.length > 0 && <div className="faint">consented: {fields.join(', ')}</div>}
      </td>
      <td>
        {intro?.status === 'delivered' ? (
          <div className="receipt" data-testid="intro-receipt">
            <span className="st verified">Delivered once</span>
            <span className="mono">{intro.id}{fmtTime(intro.receivedAt) ? ` · ${fmtTime(intro.receivedAt)}` : ''}</span>
          </div>
        ) : intro ? (
          <button type="button" className="btn pri" onClick={onAsk} data-testid="review-intro">Review the intro</button>
        ) : (
          <button type="button" className="btn" onClick={onAsk} data-testid="ask-intro">Ask for intro</button>
        )}
      </td>
    </tr>
  );
}
