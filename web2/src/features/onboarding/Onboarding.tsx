// Candidate onboarding: one screen. Paste a LinkedIn link, optionally add work samples, tick what to share, press
// "Read my profile". DOMINO runs a live Crustdata person enrich; the model parses the profile; the candidate
// confirms it ("Is this you?") and lands on the dashboard. The model is used only to read the profile.
import { useEffect, useRef, useState } from 'react';
import type { Evidence } from '../../../../shared/types.ts';
import { createDeskApi, isMonthLevel, ROLE_FAMILY_LABELS } from '../../data/desk.ts';
import type { Candidate, Consent, DeskApi, Provenance } from '../../data/desk.ts';
import { deskApi } from '../../data/query.ts';
import { navigate } from '../../data/router.ts';
import { runStore, useRunSel } from '../../data/store.ts';
import { fmtDate } from '../../lib/format.ts';
import { useEnterOnce } from '../../lib/motion.ts';
import { setCandidate } from '../../shell/ui.ts';
import { SourceNote } from '../../shell/SourceNote.tsx';
import {
  checkLinkedin, CONSENT_ITEMS, DEFAULT_CONSENT, findEvidence, normaliseLinkedin, retrievedLine, shortLinkedin, sourceName,
} from './shared.ts';
import type { ConsentKey } from './shared.ts';
import './onboarding.css';

type Phase = 'form' | 'enriching' | 'confirm' | 'failed';
const POLL_MS = 1500;
const MIN_READING_MS = 900;
/** "Continue with the demo candidate": the labelled fictional fixture, whatever the live server says. */
const demoApi = createDeskApi({ fixtureOnly: true });

export function Onboarding() {
  const [phase, setPhase] = useState<Phase>('form');
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [samples, setSamples] = useState(['', '', '']);
  const [consent, setConsent] = useState<Consent>(DEFAULT_CONSENT);
  const samplesTouched = useRef(false);
  const [cand, setCand] = useState<Candidate | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [source, setSource] = useState<Provenance | null>(null);
  const [failReason, setFailReason] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const api = useRef<DeskApi>(deskApi);
  const alive = useRef(true);
  const startedAt = useRef(0);
  const urlInput = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<number | null>(null);
  const slow = useRunSel((v) => v.feeds.slow);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, []);

  const filledSamples = samples.map((s) => s.trim()).filter(Boolean);
  // Samples are off by default and switch on when the first sample is added, unless the candidate set it themselves.
  useEffect(() => {
    if (samplesTouched.current) return;
    const want = filledSamples.length > 0;
    setConsent((c) => (c.shareSamples === want ? c : { ...c, shareSamples: want }));
  }, [filledSamples.length]);

  const toggle = (key: ConsentKey) => {
    if (key === 'shareSamples') samplesTouched.current = true;
    setConsent((c) => ({ ...c, [key]: !c[key] }));
  };

  function fail(reason: string | null) {
    if (!alive.current) return;
    setFailReason(reason);
    setPhase('failed');
  }

  async function poll(id: string) {
    if (!alive.current) return;
    try {
      const r = await api.current.candidate(id);
      if (!alive.current) return;
      setCand(r.data);
      setEvidence(r.evidence);
      setSource(r.source);
      if (r.data.status === 'ready') {
        // A fixture enrich answers in ~300 ms: hold the reading state briefly so it resolves instead of flashing.
        const wait = Math.max(0, startedAt.current + MIN_READING_MS - performance.now());
        pollTimer.current = window.setTimeout(() => { if (alive.current) setPhase('confirm'); }, wait);
        return;
      }
      if (r.data.status === 'failed') { fail((r.data as Candidate & { error?: string }).error ?? null); return; }
      pollTimer.current = window.setTimeout(() => void poll(id), POLL_MS);
    } catch (e) {
      fail((e as Error).message);
    }
  }

  async function start(linkedinUrl: string, using: DeskApi) {
    api.current = using;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setPhase('enriching');
    setCand(null);
    setFailReason(null);
    startedAt.current = performance.now();
    try {
      const r = await using.createCandidate({ linkedinUrl, samples: filledSamples, consent });
      if (!alive.current) return;
      setSource(r.source);
      if (r.data.runId) void runStore.attach(r.data.runId);
      void poll(r.data.candidateId);
    } catch (e) {
      // The server rejects a bad link up front (400): say so under the field, where the fix is.
      if (!alive.current) return;
      setPhase('form');
      setUrlError(`${(e as Error).message.replace(/\.$/, '')}. Check it’s a public linkedin.com/in/ link.`);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const err = checkLinkedin(url);
    setUrlError(err);
    if (!err) void start(normaliseLinkedin(url), deskApi);
  }

  async function confirm() {
    if (!cand) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const r = await api.current.confirmCandidate(cand.id, consent);
      setCandidate(r.data.id);
      navigate({ page: 'candidate', sub: 'dashboard' });
    } catch (e) {
      setConfirmError((e as Error).message);
      setConfirming(false);
    }
  }

  function startOver() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setPhase('form');
    setCand(null);
    setFailReason(null);
    setConfirmError(null);
    // Back to the form with the link kept: put the cursor on it, where the fix is.
    window.setTimeout(() => urlInput.current?.focus(), 0);
  }

  const demo = api.current !== deskApi;
  const folded = phase !== 'form';
  const sharing = CONSENT_ITEMS.filter((c) => consent[c.key] && c.key !== 'discoverable').map((c) => c.label.toLowerCase());

  return (
    <div className={`page onb ${folded ? 'is-folded' : ''}`}>
      {!folded && (
        <header className="onb-hero">
          <h1 className="onb-title">
            <span className="onb-title-wide">Find the job</span>
            <span className="onb-title-narrow">before it’s posted</span>
          </h1>
          <p className="onb-how">DOMINO watches for companies where two people in your role just left and nobody has been hired or posted to replace them.</p>
          <p className="onb-rule">
            The model reads your profile and drafts intros, nothing more. The prediction is rule O1 over dated Crustdata
            records: at a company of 20–5,000 staff, two or more people in one role family leave within 90 days, and no
            replacement is hired or posted within 30 days of the last one.
          </p>
        </header>
      )}

      {phase === 'form' && (
        <form className="onb-form" onSubmit={submit} noValidate>
          <div className="onb-col">
            <label className="onb-field">
              <span className="onb-label">Your LinkedIn profile</span>
              <input
                ref={urlInput} data-testid="linkedin-input" className={`onb-input ${urlError ? 'has-error' : ''}`} type="url" inputMode="url"
                autoComplete="url" placeholder="linkedin.com/in/your-name" value={url} aria-invalid={!!urlError}
                aria-describedby={urlError ? 'li-err' : undefined}
                onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(null); }}
                onBlur={() => { if (url.trim()) setUrlError(checkLinkedin(url)); }}
              />
              {urlError && <span id="li-err" className="onb-error" role="alert">{urlError}</span>}
            </label>

            <div className="onb-field">
              <span className="onb-label">Work samples <span className="onb-opt">optional, up to 3</span></span>
              {samples.map((s, i) => (i === 0 || samples[i - 1].trim()) ? (
                <input
                  key={i} data-testid={`sample-input-${i}`} className="onb-input small"
                  placeholder={i === 0 ? 'A link, or a short note on something you built' : 'Another link or note'}
                  value={s} onChange={(e) => setSamples((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
                />
              ) : null)}
            </div>

            <div className="onb-actions">
              <button data-testid="onboard-submit" className="btn primary onb-go" type="submit">Read my profile</button>
              <span className="onb-after">Reads your public profile once from Crustdata, then shows it back to you to confirm.</span>
            </div>
          </div>

          <fieldset className="onb-col onb-consent">
            <legend className="onb-label">What you agree to share</legend>
            <ConsentList consent={consent} onToggle={toggle} />
            <p className="onb-keep">DOMINO keeps only what the match needs. You can withdraw any time.</p>
          </fieldset>
        </form>
      )}

      {folded && (
        <div className="onb-summary">
          <div className="onb-summary-text">
            <b>{shortLinkedin(cand?.linkedinUrl || normaliseLinkedin(url || 'linkedin.com/in/'))}</b>
            <span>
              {filledSamples.length ? `${filledSamples.length} work sample${filledSamples.length > 1 ? 's' : ''}` : 'No work samples'}
              {`, sharing ${sharing.join(', ') || 'nothing'}`}
            </span>
          </div>
          <button className="btn small" type="button" onClick={startOver}>Start over</button>
        </div>
      )}

      {(phase === 'enriching' || phase === 'confirm') && (
        <section className="onb-confirm">
          <div className="onb-card-col">
            <h2 className="onb-h2">{phase === 'confirm' ? 'Is this you?' : demo ? 'Loading the demo profile' : 'Reading your profile'}</h2>
            <ProfileCard cand={cand} evidence={evidence} reading={phase === 'enriching'} slow={slow?.text ?? null} demo={demo} />
            <SourceNote source={source} error={null} />
          </div>
          <aside className="onb-side">
            <span className="onb-label">What you agree to share</span>
            <ConsentList consent={consent} onToggle={toggle} compact />
            <p className="onb-keep">Companies never see your contact details. You can withdraw any time.</p>
            {confirmError && <div className="banner bad" role="alert">Couldn’t save that: {confirmError}. Press the button again.</div>}
            <button data-testid="profile-confirm" className="btn primary" type="button" disabled={phase !== 'confirm' || confirming} onClick={() => void confirm()}>
              {confirming ? 'Saving' : 'Looks right, show my matches'}
            </button>
          </aside>
        </section>
      )}

      {phase === 'failed' && (
        <section className="onb-failed surface" role="alert">
          <h2 className="onb-h2">Couldn’t read that profile{failReason ? `: ${failReason}` : ''}.</h2>
          <p>Check it’s a public linkedin.com/in/ link, then try again.</p>
          <div className="onb-fail-actions">
            <button data-testid="onboard-retry" className="btn primary" type="button" onClick={startOver}>Try again</button>
            <button className="btn" type="button" onClick={() => void start('', demoApi)}>Continue with the demo candidate</button>
          </div>
        </section>
      )}
    </div>
  );
}

function ConsentList({ consent, onToggle, compact }: { consent: Consent; onToggle: (k: ConsentKey) => void; compact?: boolean }) {
  return (
    <ul className={`consent ${compact ? 'compact' : ''}`}>
      {CONSENT_ITEMS.map((c) => (
        <li key={c.key}>
          <label className="consent-item">
            <input data-testid={`consent-${c.key}`} type="checkbox" checked={consent[c.key]} onChange={() => onToggle(c.key)} />
            <span className="consent-box" aria-hidden="true" />
            <span className="consent-text">
              <b>{c.label}</b>
              {!compact && <span>{c.who}</span>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Ghost lines until each field arrives; each real field fades in once, on its own. */
function ProfileCard({ cand, evidence, reading, slow, demo }: { cand: Candidate | null; evidence: Evidence[]; reading: boolean; slow: string | null; demo: boolean }) {
  const by = cand?.parsedBy === 'llm' ? 'Read by the model' : 'Read by rules';
  const ev = findEvidence(evidence, cand?.evidenceIds[0]);
  return (
    <article className="pcard surface" data-testid="profile-card" aria-busy={reading}>
      <div className="pcard-top">
        {cand?.displayName ? <Reveal className="pcard-name">{cand.displayName}</Reveal> : <Ghost w="40%" h={36} />}
        {cand?.fixture && <span className="tag warn">Fictional demo candidate</span>}
      </div>
      {cand?.headline ? <Reveal className="pcard-headline">{cand.headline}</Reveal> : <Ghost w="58%" />}

      <dl className="pcard-fields">
        <div>
          <dt>Role family {cand?.roleFamily && <span className="by">{by}</span>}</dt>
          <dd>{cand?.roleFamily ? <Reveal>{ROLE_FAMILY_LABELS[cand.roleFamily]}</Reveal> : <Ghost w="46%" />}</dd>
        </div>
        <div>
          <dt>Skills {cand?.skills.length ? <span className="by">{by}</span> : null}</dt>
          <dd>
            {cand?.skills.length
              ? <Reveal className="pcard-chips">{cand.skills.map((s) => <span key={s} className="chip">{s}</span>)}</Reveal>
              : <div className="pcard-chips">{[96, 52, 180, 112, 70, 44].map((w, i) => <Ghost key={i} w={`${w}px`} h={30} pill />)}</div>}
          </dd>
        </div>
        <div>
          <dt>Work history {cand?.history.length ? <span className="by">{by}</span> : null}</dt>
          <dd>
            {cand?.history.length ? (
              <Reveal as="ol" className="pcard-history">
                {cand.history.map((h) => (
                  <li key={`${h.company}-${h.from}`}>
                    <span className="h-role"><b>{h.title}</b>, {h.company}</span>
                    <span className="h-dates" data-num>
                      {fmtDate(h.from, true)} to {h.to ? fmtDate(h.to, true) : 'now'}
                      {(isMonthLevel(h.from) || isMonthLevel(h.to)) && <span className="tag">month-level date</span>}
                    </span>
                  </li>
                ))}
              </Reveal>
            ) : cand && !reading && !cand.consent.shareHistory ? (
              <span className="pcard-muted">Not shared</span>
            ) : (
              <div className="pcard-ghost-rows"><Ghost w="68%" /><Ghost w="40%" /><Ghost w="60%" /><Ghost w="38%" /></div>
            )}
          </dd>
        </div>
      </dl>

      <footer className="pcard-source">
        {reading ? (
          <span className={`pcard-reading ${slow ? 'is-slow' : ''}`}>
            <span className="pulse" aria-hidden="true" />
            {slow ?? (demo ? 'Loading the fictional demo candidate. No live call is made.' : 'Reading the public profile from Crustdata. Each call shows in the activity rail.')}
          </span>
        ) : (
          <span>
            {ev && ev.mode !== 'fixture' ? `${sourceName(ev)}, ${retrievedLine(ev)}`
              : ev || cand?.fixture ? 'Fictional fixture shaped like a Crustdata person record, not a live call'
              : 'Crustdata person record'}
          </span>
        )}
      </footer>
    </article>
  );
}

function Ghost({ w, h = 22, pill }: { w: string; h?: number; pill?: boolean }) {
  return <span className={`ghost ${pill ? 'pill' : ''}`} style={{ width: w, height: h }} aria-hidden="true" />;
}

function Reveal({ children, className, as = 'div' }: { children: React.ReactNode; className?: string; as?: 'div' | 'ol' }) {
  const ref = useEnterOnce<HTMLDivElement>(false, undefined, 420);
  if (as === 'ol') return <ol ref={ref as unknown as React.RefObject<HTMLOListElement>} className={className}>{children}</ol>;
  return <div ref={ref} className={className}>{children}</div>;
}
