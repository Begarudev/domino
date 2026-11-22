// Incremental view-model derivations. Everything here is computed from real StoredEvents and the RunSnapshot;
// nothing is invented. Feeds are append-only so the Reading desk can render with stable keys and no re-sorting.
import type { RunEvent, RunSnapshot, SourceItem, StepName, StoredEvent } from '../../../shared/types.ts';
import { STEP_LABELS } from '../../../web/src/state.ts';
import { fmtDate, fmtInt, fmtSeconds } from '../lib/format.ts';

// ---------- the six plain-language steps ----------

export type StoryStepId = 'read' | 'link' | 'verify' | 'draft' | 'approve' | 'replay';
export type StoryStatus = 'pending' | 'running' | 'done' | 'failed' | 'waiting';

export interface StoryStep {
  id: StoryStepId;
  n: number;
  name: string;           // "Read"
  caption: string;        // "Reading 1,410 job moves since 24 Aug"
  status: StoryStatus;
}

export const STORY: { id: StoryStepId; name: string; engine: StepName[] }[] = [
  { id: 'read', name: 'Read', engine: ['parse_request', 'pull_triggers'] },
  { id: 'link', name: 'Link', engine: ['resolve_entities', 'enrich_companies', 'cascade'] },
  { id: 'verify', name: 'Verify', engine: ['rank_targets', 'find_deciders', 'warm_paths'] },
  { id: 'draft', name: 'Draft', engine: ['draft_messages'] },
  { id: 'approve', name: 'Approve', engine: ['approval_gate'] },
  { id: 'replay', name: 'Replay', engine: ['score_replay'] },
];

/** Plain-language description of each engine step, used by the narration line. */
export const STEP_PLAIN: Record<StepName, string> = {
  parse_request: 'Reading your request',
  pull_triggers: 'Reading dated changes from Crustdata: job moves, job posts, company news',
  resolve_entities: 'Matching names: deciding which records are the same company',
  enrich_companies: 'Checking each company: size, growth, funding',
  cascade: 'Looking for talent drain: who left, for where, and whether anyone replaced them',
  rank_targets: 'Ranking predicted openings and holding doubtful ones',
  find_deciders: 'Finding who hires for each opening',
  warm_paths: 'Looking for a warm introduction',
  draft_messages: 'Writing the intro; every fact must cite a dated source',
  approval_gate: 'Waiting for a person to approve before anything is sent',
  score_replay: 'Scoring the replay against what happened next',
};

// ---------- reading desk feed ----------

export type SourceKind = 'job_move' | 'company' | 'job_post' | 'news' | 'funding' | 'decider';

export interface SourceCard {
  key: string;            // stable: `${seq}:${index}`
  seq: number;
  kind: SourceKind;
  title: string;
  company: string | null;
  date: string | null;    // ISO
  dateLabel: string;      // "27 Oct" | "Nov 2026" | "undated"
  domain: string | null;
  signal: string | null;  // the extracted signal, highlighted
  matched: boolean;       // fed a trigger/edge; false = read and discarded (dimmed)
  url: string | null;
  callMode: string;       // 'live' | 'cache' | 'fixture'
  endpoint: string;
}

export interface ReadTotals {
  /** endpoint -> sum of totalAvailable (or item counts when the source gives no total) */
  byEndpoint: Record<string, number>;
  latestEndpoint: string | null;
  latestQuery: string | null;
  sourceReads: number;
}

const KIND_MAP: Record<SourceItem['kind'], SourceKind> = {
  job_post: 'job_post', person_move: 'job_move', company: 'company', funding: 'funding', headcount: 'company',
  post: 'news', news: 'news', decider: 'decider',
};

export const ENDPOINT_NOUN: Record<string, string> = {
  person_recent_moves: 'job moves', job_search: 'job posts', company_growth: 'company growth records',
  company_enrich: 'company profiles', company_posts: 'company posts', web_search: 'news articles', person_search: 'people records',
};

function hostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export interface Narration { seq: number; text: string; tone: 'info' | 'ok' | 'warn' | 'fail' }

export interface Feeds {
  sources: SourceCard[];
  reads: ReadTotals;
  narration: Narration | null;
  /** live retry/backoff status shown in slow states ("retrying 1/1", "rate-limited, waiting 12 s") */
  slow: { seq: number; text: string } | null;
}

export function emptyFeeds(): Feeds {
  return { sources: [], reads: { byEndpoint: {}, latestEndpoint: null, latestQuery: null, sourceReads: 0 }, narration: null, slow: null };
}

const TRIGGER_KIND: Record<string, SourceKind> = {
  job_post: 'job_post', hire: 'job_move', departure: 'job_move', headcount_jump: 'company', funding: 'funding', post: 'news',
};
const TRIGGER_SIGNAL: Record<string, string> = {
  job_post: 'serving role posted', hire: 'engineer hired', departure: 'engineer left', headcount_jump: 'headcount jump',
  funding: 'funding round', post: 'company post',
};

const RETRY_PLAIN: Record<string, string> = {
  timeout: 'timed out', http_5xx: 'returned a server error', rate_limit: 'rate-limited', nonsense: 'returned an invalid response', network: 'lost the network',
};

function endpointPlain(endpoint: string): string {
  if (/gpt|claude|haiku|sonnet|opus|model/i.test(endpoint)) return 'the language model';
  const noun = ENDPOINT_NOUN[endpoint.replace(/^\//, '').replace(/\//g, '_')];
  return noun ? `Crustdata ${noun}` : `Crustdata ${endpoint.replace(/^\//, '')}`;
}

/**
 * Fold a batch of events into the feeds. Returns the same object when nothing changed (so selectors stay stable),
 * otherwise a new object whose untouched arrays keep their identity.
 */
export function foldFeeds(prev: Feeds, events: StoredEvent[], snapAfter: RunSnapshot): Feeds {
  let sources = prev.sources;
  let reads = prev.reads;
  let narration = prev.narration;
  let slow = prev.slow;
  let appended: SourceCard[] | null = null;
  const name = (id: string | null | undefined) => {
    if (!id) return null;
    return snapAfter.companies.find((c) => c.id === id)?.name ?? snapAfter.graph.nodes.find((n) => n.id === id)?.name ?? null;
  };
  const domainOf = (company: string | null) =>
    company ? snapAfter.companies.find((c) => c.name === company)?.domain ?? null : null;

  for (const st of events) {
    const ev: RunEvent = st.event;
    const say = (text: string, tone: Narration['tone'] = 'info') => { narration = { seq: st.seq, text, tone }; };
    switch (ev.type) {
      case 'source.read': {
        appended ??= [];
        ev.items.forEach((it, i) => {
          appended!.push({
            key: `${st.seq}:${i}`, seq: st.seq, kind: KIND_MAP[it.kind] ?? 'news', title: it.title, company: it.company,
            date: it.date, dateLabel: it.precision === 'month' && it.date ? fmtDate(it.date.slice(0, 7)) : fmtDate(it.date),
            domain: hostname(it.url) ?? domainOf(it.company), signal: it.signal, matched: it.matched, url: it.url,
            callMode: ev.mode, endpoint: ev.endpoint,
          });
        });
        const add = ev.totalAvailable ?? ev.items.length;
        reads = {
          byEndpoint: { ...reads.byEndpoint, [ev.endpoint]: (reads.byEndpoint[ev.endpoint] ?? 0) + add },
          latestEndpoint: ev.endpoint, latestQuery: ev.query, sourceReads: reads.sourceReads + 1,
        };
        const noun = ENDPOINT_NOUN[ev.endpoint] ?? 'records';
        say(`Read ${fmtInt(add)} ${noun}: ${ev.query}`);
        slow = null;
        break;
      }
      case 'trigger.found': {
        // Older runs (and the sample) have no source.read events: show the dated triggers as the reading stream.
        if (reads.sourceReads > 0) break;
        const t = ev.trigger;
        const company = name(t.companyId);
        appended ??= [];
        appended.push({
          key: `${st.seq}:t`, seq: st.seq, kind: TRIGGER_KIND[t.kind] ?? 'news', title: t.summary, company,
          date: t.date, dateLabel: fmtDate(t.date), domain: domainOf(company), signal: TRIGGER_SIGNAL[t.kind] ?? null,
          matched: true, url: null, callMode: snapAfter.dataMode, endpoint: t.kind,
        });
        break;
      }
      case 'step.started':
        say(STEP_PLAIN[ev.step] ?? ev.label);
        slow = null;
        break;
      case 'step.skipped':
        say(`Reused ${STEP_LABELS[ev.step].toLowerCase()} from the checkpoint`, 'ok');
        break;
      case 'step.failed':
        say(`${STEP_LABELS[ev.step]} failed: ${ev.error}`, 'fail');
        break;
      case 'tool.retry': {
        const what = endpointPlain(ev.endpoint);
        const why = RETRY_PLAIN[ev.reason] ?? ev.reason;
        const text = ev.reason === 'rate_limit'
          ? `${what} rate-limited, waiting ${fmtSeconds(ev.backoffMs)}`
          : `${what} ${why}${ev.injected ? ' (injected test fault)' : ''}, retrying ${ev.attempt}/${ev.attempt}`;
        slow = { seq: st.seq, text };
        say(text, 'warn');
        break;
      }
      case 'tool.result':
        if (slow) slow = null;
        break;
      case 'tool.fallback':
        say(`${endpointPlain(ev.endpoint)} switched from ${ev.from} to ${ev.to === 'cache' ? 'a cached copy' : ev.to}: ${ev.reason}`, 'warn');
        break;
      case 'entity.merged':
        say(`Matched ${ev.merge.names.map((n) => `“${n}”`).join(' and ')} as one company`);
        break;
      case 'entity.kept_apart':
        say(`Kept ${ev.decision.names.map((n) => `“${n}”`).join(' and ')} apart: ${ev.decision.reason}`);
        break;
      case 'graph.edge': {
        const a = name(ev.edge.from) ?? 'a company';
        const b = name(ev.edge.to) ?? 'a company';
        say(`Linked ${a} to ${b} with dated evidence`, 'ok');
        break;
      }
      case 'targets.ranked': {
        const n = ev.targets.length;
        const held = ev.targets.filter((t) => t.hold).length;
        const watch = ev.targets.filter((t) => t.watch).length;
        say(`Ranked ${n} accounts${held ? `, ${held} on hold` : ''}${watch ? `, ${watch} on the watchlist` : ''}`);
        break;
      }
      case 'target.held':
        say(`Held ${name(ev.companyId) ?? 'an account'}: ${ev.reasons[0] ?? 'needs review'}`, 'warn');
        break;
      case 'decider.found':
        say(ev.decider ? `Found who decides at ${name(ev.companyId) ?? 'the account'}: ${roleOnly(ev.decider.title)}` : `No decider found at ${name(ev.companyId) ?? 'the account'}; marked “can't verify”`, ev.decider ? 'info' : 'warn');
        break;
      case 'draft.ready':
        say(`Drafted a first message to ${name(ev.draft.companyId) ?? 'an account'}; ${ev.draft.citations.length} facts cited`, 'ok');
        break;
      case 'claim.unverifiable':
        say(`Can't verify for ${name(ev.companyId) ?? 'an account'}: ${ev.claim}`, 'warn');
        break;
      case 'approval.requested': {
        const pending = snapAfter.approvals.filter((a) => a.status === 'pending').length;
        say(`Waiting for your approval: ${pending} ${pending === 1 ? 'message' : 'messages'} ready`, 'warn');
        break;
      }
      case 'approval.decided':
        say(ev.status === 'approved' ? 'Approved. Sending once to the team inbox' : 'Rejected. Nothing will be sent', ev.status === 'approved' ? 'ok' : 'info');
        break;
      case 'delivery.receipt':
        say(ev.receipt.status === 'already_delivered'
          ? 'Already delivered, skipped: same send key, the team inbox still has one message'
          : 'Delivered once to the team inbox', 'ok');
        break;
      case 'action.duplicate_blocked':
        say('Already delivered, skipped: the second send was blocked by its key', 'ok');
        break;
      case 'engine.crashed':
        say(`Engine stopped${ev.atStep ? ` during ${STEP_LABELS[ev.atStep].toLowerCase()}` : ''} (deliberate crash test)`, 'fail');
        break;
      case 'engine.resumed':
        say(`Resumed from checkpoint: ${ev.skipped.length} steps reused, no paid call repeated`, 'ok');
        break;
      case 'replay.scored':
        say(ev.score.note, 'info');
        break;
      case 'run.status':
        if (ev.status === 'completed') say(ev.note ?? 'Run finished', 'ok');
        else if (ev.status === 'budget_exhausted') say(`Budget cap reached${ev.note ? `: ${ev.note}` : ''}. Partial result kept`, 'warn');
        else if (ev.status === 'failed') say(ev.note ?? 'Run failed', 'fail');
        else if (ev.status === 'crashed') say('Engine stopped. Resume from the ledger drawer', 'fail');
        break;
      default:
        break;
    }
  }
  if (appended && appended.length) sources = sources.concat(appended);
  if (sources === prev.sources && reads === prev.reads && narration === prev.narration && slow === prev.slow) return prev;
  return { sources, reads, narration, slow };
}

/** "Head of ML Platform" stays; a person's name never reaches the UI from here. */
export function roleOnly(title: string): string {
  return title.trim();
}

/** Decider as role plus initial: "VP Engineering (A.)". No full names of real people. */
export function deciderLabel(d: { name: string; title: string } | null | undefined): string {
  if (!d) return 'No decider found';
  const initial = d.name?.trim()?.[0];
  return initial ? `${d.title} (${initial.toUpperCase()}.)` : d.title;
}

// ---------- step rail ----------

export function storySteps(snap: RunSnapshot, feeds: Feeds, asOfLabel: string | null): StoryStep[] {
  const st = (names: StepName[]): StoryStatus => {
    const rows = snap.steps.filter((s) => names.includes(s.step));
    if (rows.some((r) => r.status === 'failed')) return 'failed';
    if (rows.some((r) => r.status === 'running')) return 'running';
    if (rows.length && rows.every((r) => r.status === 'done' || r.status === 'skipped')) return 'done';
    if (rows.some((r) => r.status === 'done')) return 'running';
    return 'pending';
  };
  const companies = snap.graph.nodes.length;
  const edges = snap.graph.edges.length;
  const targets = snap.targets;
  const held = targets.filter((t) => t.hold).length;
  const watch = targets.filter((t) => t.watch).length;
  const drafts = snap.drafts;
  const cited = drafts.reduce((n, d) => n + d.checks.filter((c) => c.status === 'cited').length, 0);
  const sentences = drafts.reduce((n, d) => n + d.checks.filter((c) => c.status !== 'no_claim').length, 0);
  const pending = snap.approvals.filter((a) => a.status === 'pending').length;
  const delivered = snap.outbox.length;

  const readTotal = Object.values(feeds.reads.byEndpoint).reduce((a, b) => a + b, 0);
  const latest = feeds.reads.latestEndpoint;
  const since = asOfLabel ? ` since ${asOfLabel}` : '';
  const readCaption = latest
    ? `Reading ${fmtInt(feeds.reads.byEndpoint[latest] ?? 0)} ${ENDPOINT_NOUN[latest] ?? 'records'}${since}` + (Object.keys(feeds.reads.byEndpoint).length > 1 ? `, ${fmtInt(readTotal)} records in all` : '')
    : snap.triggers.length ? `Found ${fmtInt(snap.triggers.length)} dated changes${since}` : 'Waiting for the first read';

  const out: StoryStep[] = STORY.map((s, i) => ({ id: s.id, n: i + 1, name: s.name, caption: '', status: st(s.engine) }));
  const by = Object.fromEntries(out.map((s) => [s.id, s])) as Record<StoryStepId, StoryStep>;
  by.read.caption = readCaption;
  by.link.caption = edges ? `${fmtInt(edges)} ${edges === 1 ? 'chain' : 'chains'} across ${fmtInt(companies)} companies` : companies ? `${fmtInt(companies)} companies, linking next` : 'Who lost engineers to whom';
  by.verify.caption = targets.length ? `${targets.length} accounts checked${held ? `, ${held} held` : ''}${watch ? `, ${watch} watching` : ''}` : 'Every claim needs a dated source';
  by.draft.caption = drafts.length ? `${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'}, ${cited} of ${sentences} claims cited` : 'Sentence by sentence, with citations';
  by.approve.caption = delivered ? `${delivered} delivered once to the team inbox` : pending ? `${pending} waiting for you` : 'Nothing is sent without you';
  if (snap.status === 'awaiting_approval' && by.approve.status === 'running') by.approve.status = 'waiting';
  if (snap.approvals.length && pending === 0) by.approve.status = 'done';
  const r = snap.replay;
  by.replay.caption = r ? `DOMINO ${r.domino.hits} of ${r.domino.predicted} picks, baseline ${r.baselineHeadcount.hits} of ${r.baselineHeadcount.predicted}` : '1 Sep to 22 Nov, scored against a baseline';
  if (snap.intent?.runKind !== 'replay' && by.replay.status === 'pending') by.replay.status = 'pending';
  return out;
}

/** The step the rail highlights: the running one, else the last that finished, else Read. */
export function currentStory(steps: StoryStep[]): StoryStepId {
  const running = steps.find((s) => s.status === 'running' || s.status === 'waiting' || s.status === 'failed');
  if (running) return running.id;
  const done = steps.filter((s) => s.status === 'done' && s.id !== 'replay');
  return done.length ? done[done.length - 1].id : 'read';
}
