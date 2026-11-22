import type { RunSnapshot } from '../../../shared/types.ts';
import { fmtTime } from '../dates.ts';
import { fmtNum } from './Header.tsx';

const STATUS: Record<string, string> = {
  ok: 'ok', timeout: 'timeout', error: 'error', nonsense: 'bad response', cache_hit: 'cache hit', budget_blocked: 'blocked by budget',
};

export function LedgerTab({ snap }: { snap: RunSnapshot }) {
  const rows = [...snap.ledger].sort((a, b) => a.id - b.id);
  if (!rows.length) return <p className="empty tab-empty">Every external call lands here, one row per attempt, including retries, cache hits and blocked calls.</p>;
  const sum = rows.reduce((a, r) => ({ credits: a.credits + r.credits, inT: a.inT + r.inputTokens, outT: a.outT + r.outputTokens, usd: a.usd + r.usd, ms: a.ms + r.latencyMs }), { credits: 0, inT: 0, outT: 0, usd: 0, ms: 0 });
  const failed = rows.filter((r) => r.status !== 'ok' && r.status !== 'cache_hit').length;
  return (
    <div className="ledger">
      <table>
        <thead>
          <tr>
            <th scope="col">Time</th><th scope="col">Step</th><th scope="col">Provider</th><th scope="col">Endpoint</th><th scope="col">Mode</th>
            <th scope="col">Status</th><th scope="col" className="r">Attempt</th><th scope="col" className="r">Credits</th><th scope="col" className="r">Tokens in, out</th>
            <th scope="col" className="r">USD</th><th scope="col" className="r">Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`${r.status !== 'ok' && r.status !== 'cache_hit' ? 'is-fail' : ''}${r.injected ? ' is-injected' : ''}`}>
              <td className="num">{fmtTime(r.ts)}</td>
              <td>{r.step.replace(/_/g, ' ')}</td>
              <td>{r.provider}</td>
              <td className="mono-ish">{r.endpoint}</td>
              <td>{r.mode}</td>
              <td>{STATUS[r.status] ?? r.status}{r.injected && <span className="tag-injected">injected</span>}</td>
              <td className="num r">{r.attempt}</td>
              <td className="num r">{fmtNum(r.credits)}</td>
              <td className="num r">{r.inputTokens || r.outputTokens ? `${r.inputTokens}, ${r.outputTokens}` : ''}</td>
              <td className="num r">{r.usd ? `$${r.usd.toFixed(4)}` : ''}</td>
              <td className="num r">{r.latencyMs >= 1000 ? `${(r.latencyMs / 1000).toFixed(1)} s` : `${r.latencyMs} ms`}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={5}>{rows.length} attempts, {failed} failed or blocked</th>
            <td /><td />
            <td className="num r">{fmtNum(+sum.credits.toFixed(2))}</td>
            <td className="num r">{sum.inT}, {sum.outT}</td>
            <td className="num r">${sum.usd.toFixed(4)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function EntitiesTab({ snap }: { snap: RunSnapshot }) {
  if (!snap.merges.length && !snap.keptApart.length) {
    return <p className="empty tab-empty">When one company shows up under two names, DOMINO keeps one record and says why. Look-alikes it keeps apart are listed too.</p>;
  }
  return (
    <div className="entities">
      <section>
        <h3>Merged into one record ({snap.merges.length})</h3>
        <ul>
          {snap.merges.map((m, i) => (
            <li key={i} className="ent ent-merge">
              <p className="ent-names">{m.names.map((n, j) => <span key={j}>{n}</span>)}</p>
              <p className="ent-reason">{m.reason}</p>
              <p className="ent-keys">Matched on {m.keys.join(', ').replace(/_/g, ' ')}</p>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Kept apart ({snap.keptApart.length})</h3>
        <ul>
          {snap.keptApart.map((k, i) => (
            <li key={i} className="ent ent-apart">
              <p className="ent-names">{k.names.map((n, j) => <span key={j}>{n}</span>)}</p>
              <p className="ent-reason">{k.reason}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
