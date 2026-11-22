import type { RunSnapshot } from '../../../shared/types.ts';
import type { Selection } from '../centrepiece/contract.ts';
import { MECH_LABEL } from '../centrepiece/table/TableCentrepiece.tsx';

export function TargetsStrip(props: { snap: RunSnapshot; selection: Selection | null; onSelect: (s: Selection) => void; hiringFilterView: boolean }) {
  const { snap } = props;
  const baseline = new Set(snap.baseline.hiringFilterCompanyIds);
  const name = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? snap.graph.nodes.find((n) => n.id === id)?.name ?? id;
  const missed = snap.targets.filter((t) => !baseline.has(t.companyId)).length;
  return (
    <section className="targets" aria-label="Ranked targets">
      <div className="targets-head">
        <h2>Ranked targets</h2>
        {snap.targets.length > 0 && <p><b>{missed}</b> of {snap.targets.length} would be missed by a hiring filter</p>}
      </div>
      {snap.targets.length === 0 ? (
        <p className="empty">Targets are ranked once the cascade is built.</p>
      ) : (
        <ol className="target-list">
          {snap.targets.map((t) => {
            const sel = (props.selection?.kind === 'target' || props.selection?.kind === 'node') && props.selection.id === t.companyId;
            const inBase = baseline.has(t.companyId);
            const dim = props.hiringFilterView && !inBase;
            return (
              <li key={t.companyId}>
                <button
                  type="button" className={`target${sel ? ' is-selected' : ''}${dim ? ' is-dimmed' : ''}`} aria-pressed={sel}
                  onClick={() => props.onSelect({ kind: 'target', id: t.companyId })}
                >
                  <span className="target-rank">{t.rank}</span>
                  <span className="target-name">{name(t.companyId)}</span>
                  <span className="target-body">
                    <span className="target-need">{t.need}</span>
                    <span className="target-meta">
                      <span>{t.mechanisms.filter((m) => m !== 'CAPITAL').map((m) => MECH_LABEL[m]).join(', ') || 'Capital'}</span>
                      <span className="target-decider">{t.decider ? t.decider.title : t.decider === null ? 'No decider found' : 'Finding decider'}</span>
                    </span>
                    {!inBase && <span className="target-missed">Missed by a hiring filter</span>}
                    {inBase && <span className="target-base">Hiring filter finds this one too</span>}
                  </span>
                  <span className="target-conf"><span className="num">{Math.round(t.confidence * 100)}</span>%</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
