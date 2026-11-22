import type { RunSnapshot } from '../../../shared/types.ts';
import type { Selection } from '../centrepiece/contract.ts';
import { MECH_LABEL } from '../centrepiece/table/TableCentrepiece.tsx';

export function TargetsStrip(props: { snap: RunSnapshot; selection: Selection | null; onSelect: (s: Selection) => void; hiringFilterView: boolean }) {
  const { snap } = props;
  const baseline = new Set(snap.baseline.hiringFilterCompanyIds);
  const name = (id: string) => snap.companies.find((c) => c.id === id)?.name ?? snap.graph.nodes.find((n) => n.id === id)?.name ?? id;
  const missed = snap.targets.filter((t) => !baseline.has(t.companyId)).length;
  const held = snap.targets.filter((t) => t.hold).length;
  return (
    <section className="targets" aria-label="Ranked targets">
      <div className="targets-head">
        <h2>Ranked targets</h2>
        {snap.targets.length > 0 && (
          <p><b>{missed}</b> of {snap.targets.length} would be missed by a hiring filter{held ? <>, <span className="amber"><b>{held}</b> on hold</span></> : null}</p>
        )}
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
                  type="button" aria-pressed={sel}
                  className={`target${t.hold ? ' is-held' : ''}${sel ? ' is-selected' : ''}${dim ? ' is-dimmed' : ''}`}
                  onClick={() => props.onSelect({ kind: 'target', id: t.companyId })}
                >
                  <span className="target-rank">{t.rank}</span>
                  <span className="target-name">{name(t.companyId)}</span>
                  <span className="target-need">{t.need}</span>
                  <span className="target-mech">{t.mechanisms.filter((m) => m !== 'CAPITAL').map((m) => MECH_LABEL[m]).join(', ') || 'Capital'}</span>
                  <span className="target-conf"><b>{Math.round(t.confidence * 100)}</b>%</span>
                  <span className="target-decider">{t.hold ? 'Not drafted' : t.decider ? t.decider.title : t.decider === null ? 'No decider found' : 'Finding decider'}</span>
                  {t.hold ? (
                    <span className="target-hold" title={t.hold.reasons.join('\n')}>On hold: {t.hold.reasons[0]}</span>
                  ) : inBase ? (
                    <span className="target-base">Hiring filter finds it too</span>
                  ) : (
                    <span className="target-missed">Missed by a hiring filter</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
