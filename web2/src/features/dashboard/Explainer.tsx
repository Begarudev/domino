// The candidate dashboard's self-explaining parts: the one-line value prop with the O1 domino chain, the
// "What DOMINO checked for you" strip (every count opens its records), and the never-empty fallbacks.
import { useState } from 'react';
import type { CandidateX, OpeningX } from '../onboarding/contract.ts';
import { ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import type { RoleFamily } from '../../data/desk.ts';
import { fmtInt } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { openEvidence } from '../../shell/ui.ts';
import { countWord, departureLine, scannedFamilies, stage, watchlist } from './scan.tsx';
import type { FunnelRow, Scan, WatchItem } from './scan.tsx';

const STEPS = ['Engineer leaves', 'A 2nd in the same role family leaves within 90 days', 'No replacement post or hire in 30 days', 'Predicted opening'];

export function HowItWorks() {
  return (
    <section className="how" aria-label="How DOMINO spots an opening">
      <p className="how-line">DOMINO spots openings before they’re posted, from dated job moves at each company.</p>
      <ol className="chain">
        {STEPS.map((s, i) => (
          <li key={s} className={`chain-step${i === STEPS.length - 1 ? ' last' : ''}`} style={{ ['--i' as string]: i }}>
            <svg className="tile" viewBox="0 0 14 24" aria-hidden="true">
              <rect x="0.75" y="0.75" width="12.5" height="22.5" rx="2" />
              <line x1="3" y1="12" x2="11" y2="12" />
              <circle cx="7" cy="6.5" r="1.4" />
              {i > 0 && <circle cx="7" cy="17.5" r="1.4" />}
            </svg>
            <span className="chain-text">{s}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type StripKey = 'moves' | 'companies' | 'rule' | 'time';

export function CheckedStrip({ scan }: { scan: Scan }) {
  const [open, setOpen] = useState<StripKey | null>(null);
  const f = scan.funnel;
  const profiles = stage(f, 'profiles');
  const departures = stage(f, 'departures');
  const groups = stage(f, 'groups');
  const prov = stage(f, 'provisional');
  const settled = stage(f, 'open');
  const held = stage(f, 'held');
  const openings = (settled?.count ?? 0) + (prov?.count ?? 0);
  const stamp = f?.served?.readFrom ?? (f?.lockedAt && !Number.isNaN(Date.parse(f.lockedAt)) ? f.lockedAt : null);
  const time = stamp ? scanTime(stamp, f?.served?.readFrom ? f.served.readTo : undefined) : null;
  if (scan.loading && !f) return <div className="checked ghost-row"><span className="ghost" style={{ width: '70%', height: 40 }} /></div>;
  if (!f) return <p className="dash-quiet">Today’s scan summary isn’t available ({scan.error ?? 'no funnel'}).</p>;
  const btn = (k: StripKey, num: string, label: string) => (
    <button type="button" className="chk" aria-expanded={open === k} onClick={() => setOpen((c) => (c === k ? null : k))}>
      <b>{num}</b><span>{label}</span><span className="clause-chev" aria-hidden="true" />
    </button>
  );
  return (
    <section className="checked-wrap" aria-labelledby="chk-h">
      <h2 id="chk-h" className="dash-h3">What DOMINO checked for you</h2>
      <div className="checked">
        {btn('moves', fmtInt(profiles?.count ?? 0), 'job moves read')}
        {btn('companies', fmtInt(scan.companies.length), 'companies with a dated move')}
        {btn('rule', fmtInt(openings), `${openings === 1 ? 'opening' : 'openings'} under rule O1 · ${countWord(groups?.count ?? 0, 'group')} at 2+ · ${fmtInt(held?.count ?? 0)} held`)}
        {time
          ? btn('time', time.split(', ')[1]?.replace(' IST', '') ?? '', `IST · scanned ${time.split(', ')[0]}`)
          : btn('time', 'Today', 'latest scan, run record')}
      </div>
      {open && (
        <div className="chk-records" key={open}>
          {open === 'moves' && (
            <>
              <p className="chk-note">{profiles?.label}: {fmtInt(profiles?.count ?? 0)}. Of these, {fmtInt(departures?.count ?? 0)} were direct moves out of an engineering role in a tracked family:</p>
              <Rows rows={departures?.rows ?? []} />
            </>
          )}
          {open === 'companies' && (
            <>
              <p className="chk-note">Every company in today’s scan, most departures first.</p>
              <div className="chk-grid-wrap">
                <table className="chk-grid">
                  <thead><tr><th scope="col">Company</th><th scope="col" className="n">Staff</th><th scope="col" className="n">Departures, 90 days</th><th scope="col" className="n">Openings</th></tr></thead>
                  <tbody>
                    {[...scan.companies].sort((a, b) => b.departures90d - a.departures90d).slice(0, 40).map((c) => (
                      <tr key={c.id}>
                        <td title={c.name}>{c.name}</td>
                        <td className="n">{c.headcount ? fmtInt(c.headcount) : <span className="mute">unknown</span>}</td>
                        <td className="n">{fmtInt(c.departures90d)}</td>
                        <td className="n">{c.openings ? fmtInt(c.openings) : <span className="mute">0</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {scan.companies.length > 40 && <p className="r-more">Showing 40 of {fmtInt(scan.companies.length)}. The other {fmtInt(scan.companies.length - 40)} have fewer departures.</p>}
            </>
          )}
          {open === 'rule' && (
            <>
              <p className="chk-note">Rule O1: 2+ conclusive dated departures in one role family within 90 days, at a company of 20–5,000 staff, and no dated replacement post or hire within 30 days.</p>
              <h4 className="chk-sub">{groups?.label} ({fmtInt(groups?.count ?? 0)})</h4>
              <Rows rows={groups?.rows ?? []} />
              {[prov, settled, held].filter((x) => x && x.count > 0).map((x) => (
                <div key={x!.id}><h4 className="chk-sub">{x!.label} ({fmtInt(x!.count)})</h4><Rows rows={x!.rows ?? []} /></div>
              ))}
            </>
          )}
          {open === 'time' && (
            <p className="chk-note">{f.served?.label ?? 'Scan source not recorded'}. Rule locked {f.lockedAt ?? 'before the read'}. Run <code>{f.runId.slice(0, 12)}</code>.</p>
          )}
        </div>
      )}
    </section>
  );
}

function Rows({ rows }: { rows: FunnelRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 8);
  if (!rows.length) return <p className="chk-note">This stage keeps counts only; its records are listed at the next stage.</p>;
  return (
    <ul className="chk-rows">
      {shown.map((r, i) => (
        <li key={`${r.evidenceId ?? r.label}-${i}`}>
          <button type="button" className="r-btn" disabled={!r.evidenceId} onClick={() => r.evidenceId && openEvidence(r.evidenceId)}>
            <span className="r-main">{r.label}</span>{r.detail && <span className="r-meta">{r.detail}</span>}
          </button>
        </li>
      ))}
      {rows.length > 8 && <li><button type="button" className="btn sm" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${fmtInt(rows.length)}`}</button></li>}
    </ul>
  );
}

function scanTime(from: string, to?: string) {
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const d = new Date(from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  return `${d}, ${t(from)}${to ? `–${t(to)}` : ''} IST`;
}

const famLabel = (f: RoleFamily) => ROLE_FAMILY_LABELS[f];
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Shown when no opening matches the candidate's family: who DOMINO is watching, and the closest openings elsewhere. */
export function NeverEmpty({ scan, cand, family, renderCard }: {
  scan: Scan; cand: CandidateX | null; family: RoleFamily | null;
  renderCard: (o: OpeningX, evidence: Scan['files'][number]['evidence']) => React.ReactNode;
}) {
  const fams = scannedFamilies(scan.files);
  const covered = family ? fams.includes(family) : false;
  const all = watchlist(scan.files);
  const mineW = family ? all.filter((w) => w.family === family) : [];
  const [showAll, setShowAll] = useState(false);
  const pool = mineW.length ? mineW : all;
  const watch = showAll ? pool : pool.slice(0, 3);
  const nearby = scan.files.flatMap((f) => f.openings.filter((o) => o.status === 'open' && o.roleFamily !== family).map((o) => ({ o, ev: f.evidence })));
  if (scan.loading && !scan.files.length) return <div className="op-ghost surface"><span className="ghost" style={{ width: '50%', height: 28 }} /><span className="ghost" style={{ width: '85%', height: 28 }} /></div>;
  return (
    <div className="never">
      <p className="scope-note">
        {family && !covered
          ? <><b>{famLabel(family)} wasn’t in today’s scan.</b> It covered {listJoin(fams.map(famLabel))}, so there’s nothing to predict for you yet. Below: what the scan is watching, and the closest openings in nearby roles.</>
          : <>No company meets rule O1 for {family ? famLabel(family) : 'your role family'} yet. These are the closest.</>}
      </p>

      <section aria-labelledby="watch-h" className="sub-sec">
        <h3 id="watch-h" className="dash-h3">Watching for you</h3>
        <p className="sub-lead">Companies part-way to a predicted opening. O1 needs 2 conclusive departures in one family within 90 days.{mineW.length ? '' : family ? ' Shown from the families the scan covered.' : ''}</p>
        {watch.length ? <ul className="wl">{watch.map((w) => <WatchRow key={w.key} w={w} showFamily={!mineW.length} />)}
          {pool.length > 3 && <li className="wl-row"><button type="button" className="btn sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${fmtInt(pool.length)}`}</button></li>}</ul>
          : <p className="dash-quiet">No company in today’s scan has a dated departure in a tracked family yet.</p>}
      </section>

      <section aria-labelledby="near-h" className="sub-sec">
        <h3 id="near-h" className="dash-h3">Closest openings in nearby roles</h3>
        {nearby.length ? nearby.map(({ o, ev }) => (
          <div key={o.id} className="near">
            <p className="near-tag"><span className="tag warn">Different role family: {famLabel(o.roleFamily)}</span></p>
            {renderCard(o, ev)}
          </div>
        )) : <p className="dash-quiet">No predicted opening in any family today.</p>}
      </section>
    </div>
  );
}

function WatchRow({ w, showFamily }: { w: WatchItem; showFamily: boolean }) {
  const ref = useEnterOnce<HTMLLIElement>(false, undefined, 200);
  const n = w.departures.length;
  const state = w.status === 'held' ? `Held${w.note ? `: ${w.note.split(':')[0]}` : ''}` : n >= 2 ? `${n} of 2 departures, a check is still open` : `${n} of 2 departures`;
  return (
    <li className={`wl-row st-${w.status}`} ref={ref}>
      <div className="wl-top">
        <b className="wl-co">{w.companyName}</b>
        {w.headcount > 0 && <span className="wl-meta">{fmtInt(w.headcount)} staff</span>}
        {showFamily && <span className="tag">{famLabel(w.family)}</span>}
        <span className={`wl-state st-${w.status}`}>
          <span className="pips" aria-hidden="true">{[0, 1].map((i) => <i key={i} className={i < Math.min(n, 2) ? 'on' : ''} />)}</span>
          {state}
        </span>
      </div>
      <ul className="wl-deps">
        {w.departures.slice(0, 3).map((d) => (
          <li key={d.id}>
            <button type="button" className="r-btn" onClick={() => openEvidence(d.evidenceId)}>
              <span className="r-main">{departureLine(d)}</span>
              {d.precision === 'month' && <span className="tag">month-level date</span>}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}
