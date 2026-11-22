import { useEffect, useRef, useState } from 'react';
import type { ChaosConfig, RunLimits, RunSnapshot, RunStatus } from '../../../shared/types.ts';
import type { StartRequest } from '../api.ts';
import { fmtClock, fmtDate } from '../dates.ts';
import { MAIN_REQUEST, MESSY_REQUEST, REPLAY_REQUEST } from '../mock/events.ts';

const EXAMPLES = [
  { label: 'Main request', text: MAIN_REQUEST },
  { label: 'Messy request', text: MESSY_REQUEST },
  { label: 'Replay as of 1 Sep', text: REPLAY_REQUEST },
];

export function RequestBar(props: { initial: string; busy: boolean; onRun: (req: StartRequest) => void }) {
  const [text, setText] = useState(props.initial);
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState<RunLimits>({ maxCredits: 800, maxModelUsd: 1, maxSeconds: 300 });
  const [chaos, setChaos] = useState({ timeout: true, nonsense: true });
  const pop = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (props.initial) setText(props.initial); }, [props.initial]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (pop.current && !pop.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const run = () => {
    if (!text.trim()) return;
    const c: ChaosConfig = {};
    if (chaos.timeout) c.timeoutOnce = ['job_search'];
    if (chaos.nonsense) c.nonsenseOnce = ['company_growth'];
    props.onRun({ request: text.trim(), limits, chaos: c });
  };

  return (
    <div className="request">
      <div className="request-field">
        <label htmlFor="req" className="sr-only">Request</label>
        <textarea
          id="req" rows={2} value={text} spellCheck={false}
          placeholder="What do you sell, and who should DOMINO find meetings with?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }}
        />
        <div className="chips" role="group" aria-label="Example requests">
          {EXAMPLES.map((ex) => (
            <button key={ex.label} type="button" className={`chip${text === ex.text ? ' is-on' : ''}`} onClick={() => setText(ex.text)}>{ex.label}</button>
          ))}
        </div>
      </div>
      <div className="request-actions" ref={pop}>
        <button type="button" className="btn btn-quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Options</button>
        <button type="button" className="btn btn-primary" onClick={run} disabled={props.busy || !text.trim()}>Run</button>
        {open && (
          <div className="popover" role="dialog" aria-label="Run options">
            <fieldset>
              <legend>Limits for this run</legend>
              <label>Crustdata credits<input type="number" min={0} value={limits.maxCredits} onChange={(e) => setLimits({ ...limits, maxCredits: +e.target.value })} /></label>
              <label>Model spend, USD<input type="number" min={0} step={0.05} value={limits.maxModelUsd} onChange={(e) => setLimits({ ...limits, maxModelUsd: +e.target.value })} /></label>
              <label>Time, seconds<input type="number" min={10} value={limits.maxSeconds} onChange={(e) => setLimits({ ...limits, maxSeconds: +e.target.value })} /></label>
            </fieldset>
            <fieldset>
              <legend>Inject faults (labelled as injected)</legend>
              <label className="check"><input type="checkbox" checked={chaos.timeout} onChange={(e) => setChaos({ ...chaos, timeout: e.target.checked })} />One timeout on job_search</label>
              <label className="check"><input type="checkbox" checked={chaos.nonsense} onChange={(e) => setChaos({ ...chaos, nonsense: e.target.checked })} />One nonsense response on company_growth</label>
            </fieldset>
          </div>
        )}
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: 'Queued', running: 'Running', awaiting_input: 'Needs one answer', awaiting_approval: 'Waiting for approval',
  completed: 'Finished', failed: 'Failed', crashed: 'Engine crashed', budget_exhausted: 'Budget ceiling reached',
};

export function StatusPill({ status, pending }: { status: RunStatus; pending: number }) {
  const text = status === 'awaiting_approval' && pending ? `${STATUS_TEXT[status]} (${pending})` : STATUS_TEXT[status];
  return <span className={`pill pill-${status}`} role="status">{text}</span>;
}

function dataModeText(snap: RunSnapshot) {
  if (snap.dataMode === 'live') return 'Live Crustdata';
  if (snap.dataMode === 'cache') {
    const cached = snap.evidence.filter((e) => e.mode === 'cache').map((e) => e.retrievedAt).sort();
    return `Cached live responses from ${cached.length ? fmtDate(cached[0].slice(0, 10), { year: true }) : 'an earlier run'}`;
  }
  return 'Fixture, synthetic companies';
}

function llmText(llm: string) {
  if (!llm || llm === 'template') return 'Template drafting, no model';
  const [provider, model] = llm.includes(':') ? llm.split(':') : ['', llm];
  const p = provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : provider;
  return `Model ${model}${p ? ` (${p})` : ''}`;
}

function Meter(props: { label: string; used: string; limit: string; frac: number; exhausted: boolean }) {
  const f = Math.max(0, Math.min(1, props.frac));
  return (
    <div className={`meter${props.exhausted ? ' is-exhausted' : f > 0.85 ? ' is-near' : ''}`}>
      <span className="meter-label">{props.label}</span>
      <span className="meter-num"><b>{props.used}</b> of {props.limit}</span>
      <span className="meter-bar" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={f}><span style={{ width: `${f * 100}%` }} /></span>
    </div>
  );
}

export function StatusLine(props: {
  snap: RunSnapshot; mock: boolean; connected: boolean; hasRun: boolean; fallbacks: number; health: { dataMode: string; llm: string } | null; onLower: (l: Partial<RunLimits>) => void;
}) {
  const { snap, mock } = props;
  const b = snap.budget;
  const [open, setOpen] = useState(false);
  const [credits, setCredits] = useState(b.limits.maxCredits);
  useEffect(() => { setCredits(Math.max(0, Math.floor(b.used.credits + (b.limits.maxCredits - b.used.credits) / 2))); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = snap.approvals.filter((a) => a.status === 'pending').length;
  return (
    <div className="status">
      {mock && <span className="badge badge-mock" title="Recorded mock stream; the server is not connected">Mock data</span>}
      {props.hasRun ? (
        <span className={`badge badge-${snap.dataMode}`}>{dataModeText(snap)}</span>
      ) : props.health && ['live', 'cache', 'fixture'].includes(props.health.dataMode) ? (
        // Before any run, show the server's configured source, not a placeholder.
        <span className={`badge badge-${props.health.dataMode}`}>{dataModeText({ ...snap, dataMode: props.health.dataMode as RunSnapshot['dataMode'] })}</span>
      ) : null}
      {snap.dataMode === 'live' && props.fallbacks > 0 && (
        <span className="badge badge-cache" title="Live calls that failed after retries were answered from the response cache">
          Cached live responses for {props.fallbacks} call{props.fallbacks > 1 ? 's' : ''}
        </span>
      )}
      {(props.hasRun || props.health) && <span className="status-llm">{llmText(props.hasRun ? snap.llm : props.health!.llm)}</span>}
      {!props.connected && <span className="badge badge-warn">Reconnecting to the event stream</span>}
      <div className="meters">
        <Meter label="Credits" used={fmtNum(b.used.credits)} limit={fmtNum(b.limits.maxCredits)} frac={b.used.credits / (b.limits.maxCredits || 1)} exhausted={b.exhausted === 'credits'} />
        <Meter label="Model" used={`$${b.used.modelUsd.toFixed(2)}`} limit={`$${b.limits.maxModelUsd.toFixed(2)}`} frac={b.used.modelUsd / (b.limits.maxModelUsd || 1)} exhausted={b.exhausted === 'model_usd'} />
        <Meter label="Time" used={fmtClock(b.used.seconds)} limit={fmtClock(b.limits.maxSeconds)} frac={b.used.seconds / (b.limits.maxSeconds || 1)} exhausted={b.exhausted === 'seconds'} />
        <div className="lower">
          <button type="button" className="btn btn-quiet btn-sm" disabled={!props.hasRun} aria-expanded={open} onClick={() => setOpen((o) => !o)}>Lower limit</button>
          {open && (
            <form className="popover popover-right" onSubmit={(e) => { e.preventDefault(); props.onLower({ maxCredits: credits }); setOpen(false); }}>
              <label>New credit ceiling<input type="number" min={0} value={credits} onChange={(e) => setCredits(+e.target.value)} autoFocus /></label>
              <p className="hint">The engine re-reads limits before every paid call. Below {fmtNum(b.used.credits)} used, the next call is blocked and the partial result is kept.</p>
              <button type="submit" className="btn btn-primary btn-sm">Apply limit</button>
            </form>
          )}
        </div>
      </div>
      {props.hasRun && <StatusPill status={snap.status} pending={pending} />}
    </div>
  );
}

export function fmtNum(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
