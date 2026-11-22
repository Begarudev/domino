import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ALL_STEPS, PIPELINES } from '../shared/types.ts';
import { PeopleRedactor } from './runtime/redact.ts';
import type { Pipeline } from '../shared/types.ts';
import type {
  Approval, Ask, BudgetState, ChaosConfig, DataMode, Evidence, Intent, LedgerEntry, OutboxAction, RunEvent,
  RunLimits, RunStatus, StepName, StepState, StoredEvent,
} from '../shared/types.ts';
import { config } from './env.ts';

export const stepLabels: Record<StepName, string> = {
  parse_request: 'Parse request', pull_triggers: 'Pull triggers', resolve_entities: 'Resolve entities',
  enrich_companies: 'Enrich companies', cascade: 'Build cascade', rank_targets: 'Rank targets',
  find_deciders: 'Find decision-makers', warm_paths: 'Find warm paths', draft_messages: 'Draft and verify messages',
  approval_gate: 'Request approvals', score_replay: 'Score replay',
  scope_search: 'Scope the search', pull_departures: 'Pull departures', resolve_departures: 'Resolve companies',
  check_replacements: 'Check for replacements', detect_openings: 'Predict openings', score_openings: 'Score replay',
  fetch_profile: 'Fetch profile', parse_profile: 'Read profile', match_openings: 'Match openings',
  draft_intro: 'Draft intro', intro_gate: 'Request approval',
};

export const now = () => new Date().toISOString();
const encode = JSON.stringify;
export type RunChaos = ChaosConfig & { crashAfterDeliver?: boolean };
export type ToolLedgerEntry = LedgerEntry & { error?: string };
type JournalEvent = RunEvent & { error?: string };
type JournalRecord = Omit<StoredEvent, 'event'> & { event: JournalEvent };
export function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}

export interface RunRow {
  id: string;
  request: string;
  status: RunStatus;
  data_mode: DataMode;
  llm: string;
  intent_json: string | null;
  pipeline?: Pipeline;
  limits_json: string;
  chaos_json: string;
  created_at: string;
  updated_at: string;
  engine_pid: number | null;
  crashes: number;
  resumes: number;
}
type StepRow = StepState & { output_json: string | null };
type LedgerInput = Omit<ToolLedgerEntry, 'id' | 'ts'>;
type EventRow = { seq: number; run_id: string; ts: string; payload_json: string };
export type EvidenceSource = { endpoint: string; path?: string; input: unknown; rawId: string; time: Pick<Intent, 'asOf' | 'windowDays'> };

export class Store {
  readonly sql: DatabaseSync;
  // Lazily built from the tool cache; redacts people at every boundary data leaves the server.
  private redactorInstance?: PeopleRedactor;
  get redactor(): PeopleRedactor { return this.redactorInstance ??= new PeopleRedactor(this.sql); }

  constructor(path = config.dbPath) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, request TEXT, status TEXT, data_mode TEXT, llm TEXT, intent_json TEXT, limits_json TEXT,
        chaos_json TEXT, created_at TEXT, updated_at TEXT, engine_pid INTEGER, crashes INTEGER DEFAULT 0, resumes INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT, step TEXT, status TEXT, attempt INTEGER, started_at TEXT, finished_at TEXT, summary TEXT,
        output_json TEXT, resumed INTEGER DEFAULT 0, PRIMARY KEY(run_id, step)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, type TEXT, payload_json TEXT
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, step TEXT, provider TEXT, endpoint TEXT, mode TEXT,
        status TEXT, attempt INTEGER, credits REAL, input_tokens INTEGER, output_tokens INTEGER, usd REAL, latency_ms INTEGER,
        injected INTEGER, request_hash TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_slots (
        endpoint TEXT PRIMARY KEY, next_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_cache (
        key TEXT PRIMARY KEY, provider TEXT, endpoint TEXT, request_json TEXT, response_json TEXT, fetched_at TEXT
      );
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, run_id TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS evidence_sources (id TEXT PRIMARY KEY, json TEXT);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, run_id TEXT, json TEXT, status TEXT, idempotency_key TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS outbox (
        idempotency_key TEXT PRIMARY KEY, run_id TEXT, approval_id TEXT, json TEXT, executed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS inbox_received (idempotency_key TEXT PRIMARY KEY, received_at TEXT, payload_json TEXT);
      CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, run_id TEXT, json TEXT, answer TEXT);
      CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS events_run_type_seq ON events(run_id, type, seq);
      CREATE INDEX IF NOT EXISTS ledger_run ON ledger(run_id);
      CREATE INDEX IF NOT EXISTS evidence_run ON evidence(run_id);
      CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id);
      CREATE INDEX IF NOT EXISTS outbox_run ON outbox(run_id);
      CREATE INDEX IF NOT EXISTS asks_run ON asks(run_id);
    `);
    this.ensureColumn('outbox', 'status', "TEXT NOT NULL DEFAULT 'pending'",
      "UPDATE outbox SET status = 'delivered' WHERE executed_at IS NOT NULL");
    this.ensureColumn('ledger', 'error', 'TEXT');
    this.ensureColumn('runs', 'pipeline', "TEXT NOT NULL DEFAULT 'outbound'");
  }

  private ensureColumn(table: 'ledger' | 'outbox' | 'runs', name: string, definition: string, backfill?: string) {
    const exists = () => this.sql.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name);
    if (exists()) return;
    this.transaction(() => {
      if (exists()) return;
      this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      if (backfill) this.sql.exec(backfill);
    });
  }

  transaction<T>(fn: () => T, mode: 'read' | 'write' = 'write'): T {
    this.sql.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }

  createRun(id: string, request: string, mode: DataMode, llm: string, limits: RunLimits, chaos: RunChaos,
    pipeline: Pipeline = 'outbound') {
    this.transaction(() => {
      const ts = now();
      this.sql.prepare(`INSERT INTO runs (id, request, status, data_mode, llm, limits_json, chaos_json, created_at, updated_at, pipeline)
        VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`).run(id, request, mode, llm, encode(limits), encode(chaos), ts, ts, pipeline);
      const insert = this.sql.prepare("INSERT INTO steps (run_id, step, status, attempt) VALUES (?, ?, 'pending', 0)");
      for (const step of PIPELINES[pipeline]) insert.run(id, step);
      this.recordEvent(id, { type: 'run.status', status: 'queued' });
    });
  }

  getRun(id: string) {
    return this.sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  requireRun(id: string): RunRow {
    const row = this.getRun(id);
    if (!row) throw new Error('Run does not exist');
    return row;
  }

  listRuns() {
    return this.sql.prepare('SELECT id, request, status, created_at AS createdAt FROM runs ORDER BY created_at DESC, rowid DESC').all();
  }

  getSteps(id: string): StepRow[] {
    const rows = this.sql.prepare(`SELECT step, status, attempt, started_at AS startedAt, finished_at AS finishedAt,
      summary, resumed AS resumedFromCheckpoint, output_json FROM steps WHERE run_id = ?`).all(id) as unknown as StepRow[];
    return ALL_STEPS.flatMap(step => {
      const row = rows.find(row => row.step === step);
      return row ? [{ ...row, label: stepLabels[step], resumedFromCheckpoint: Boolean(row.resumedFromCheckpoint) }] : [];
    });
  }

  getOutput<T>(id: string, step: StepName): T | undefined {
    const row = this.sql.prepare("SELECT output_json FROM steps WHERE run_id = ? AND step = ? AND status = 'done'").get(id, step);
    const output = typeof row?.output_json === 'string' ? decode<T>(row.output_json) : undefined;
    if (output !== undefined) this.redactor.observe(output);
    return output;
  }

  setOutput(id: string, step: StepName, output: unknown) {
    this.redactor.observe(output);
    this.sql.prepare('UPDATE steps SET output_json = ? WHERE run_id = ? AND step = ?').run(encode(output), id, step);
    if (step === 'parse_request') {
      this.sql.prepare('UPDATE runs SET intent_json = ? WHERE id = ?').run(encode(output as Intent), id);
    }
  }

  appendEvent(runId: string, event: JournalEvent): JournalRecord {
    return this.transaction(() => this.recordEvent(runId, event));
  }

  // This variant participates in the caller's transaction.
  recordEvent(runId: string, input: JournalEvent): JournalRecord {
    // Privacy boundary: the journal never stores a person's full name or profile URL (role + initial only).
    const event = this.redactor.value(input);
    const ts = now();
    const { lastInsertRowid } = this.sql.prepare('INSERT INTO events (run_id, ts, type, payload_json) VALUES (?, ?, ?, ?)')
      .run(runId, ts, event.type, encode(event));

    switch (event.type) {
      case 'run.status':
        this.sql.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run(event.status, ts, runId);
        break;
      case 'step.started':
        this.sql.prepare(`UPDATE steps SET status = 'running', attempt = ?, started_at = ?, finished_at = NULL, summary = NULL
          WHERE run_id = ? AND step = ?`).run(event.attempt, ts, runId, event.step);
        break;
      case 'step.completed':
        this.sql.prepare("UPDATE steps SET status = 'done', finished_at = ?, summary = ? WHERE run_id = ? AND step = ?")
          .run(ts, event.summary, runId, event.step);
        break;
      case 'step.skipped':
        this.sql.prepare('UPDATE steps SET resumed = 1 WHERE run_id = ? AND step = ?').run(runId, event.step);
        break;
      case 'step.failed':
        this.sql.prepare("UPDATE steps SET status = 'failed', finished_at = ?, summary = ? WHERE run_id = ? AND step = ?")
          .run(ts, event.error, runId, event.step);
        break;
      case 'evidence.added': {
        const insert = this.sql.prepare('INSERT INTO evidence (id, run_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
        for (const evidence of event.evidence) insert.run(evidence.id, runId, encode(evidence));
        break;
      }
      case 'ask.requested':
        this.sql.prepare('INSERT INTO asks (id, run_id, json) VALUES (?, ?, ?)').run(event.ask.id, runId, encode(event.ask));
        break;
      case 'ask.answered':
        this.sql.prepare('UPDATE asks SET answer = ? WHERE id = ? AND run_id = ?').run(event.answer, event.askId, runId);
        break;
      case 'approval.requested': {
        const a = event.approval;
        this.sql.prepare('INSERT INTO approvals (id, run_id, json, status, idempotency_key) VALUES (?, ?, ?, ?, ?)')
          .run(a.id, runId, encode(a), a.status, a.idempotencyKey);
        break;
      }
      case 'approval.decided':
        this.sql.prepare(`UPDATE approvals SET status = ?, json = json_set(json, '$.status', ?, '$.decidedAt', ?, '$.decidedBy', 'human')
          WHERE id = ? AND run_id = ?`).run(event.status, event.status, ts, event.approvalId, runId);
        break;
    }
    return { seq: Number(lastInsertRowid), runId, ts, event };
  }

  getEvents(runId: string, after: number, limit = 256): JournalRecord[] {
    const rows = this.sql.prepare('SELECT seq, run_id, ts, payload_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, after, limit) as unknown as EventRow[];
    return rows.map(row => ({ seq: row.seq, runId: row.run_id, ts: row.ts, event: decode(row.payload_json) }));
  }

  getAsk(runId: string, id: string): Ask | undefined {
    const row = this.sql.prepare('SELECT json, answer FROM asks WHERE run_id = ? AND id = ?').get(runId, id);
    return row && { ...decode<Ask>(row.json as string), answer: row.answer as string | null };
  }

  getAsks(runId: string): Ask[] {
    return this.sql.prepare('SELECT json, answer FROM asks WHERE run_id = ? ORDER BY rowid').all(runId)
      .map(row => ({ ...decode<Ask>(row.json as string), answer: row.answer as string | null }));
  }

  getEvidence(runId: string): Evidence[] {
    return this.sql.prepare('SELECT json FROM evidence WHERE run_id = ? ORDER BY rowid').all(runId).map(row => decode(row.json as string));
  }

  findEvidence(id: string) {
    const row = this.sql.prepare(`SELECT evidence.run_id, evidence.json, evidence_sources.json AS source
      FROM evidence LEFT JOIN evidence_sources USING(id) WHERE id = ?`).get(id);
    return row && {
      runId: row.run_id as string, evidence: decode<Evidence>(row.json as string),
      source: typeof row.source === 'string' ? decode<EvidenceSource>(row.source) : undefined,
    };
  }

  saveEvidenceSource(id: string, source: EvidenceSource) {
    this.sql.prepare('INSERT INTO evidence_sources (id, json) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(id, encode(source));
  }

  getApproval(id: string): Approval | undefined {
    const row = this.sql.prepare('SELECT json FROM approvals WHERE id = ?').get(id);
    return row && decode(row.json as string);
  }

  getApprovals(runId: string): Approval[] {
    return this.sql.prepare('SELECT json FROM approvals WHERE run_id = ? ORDER BY rowid').all(runId).map(row => decode(row.json as string));
  }

  getOutbox(runId: string): OutboxAction[] {
    return this.sql.prepare("SELECT json FROM outbox WHERE run_id = ? AND status = 'delivered' ORDER BY rowid").all(runId)
      .map(row => decode(row.json as string));
  }

  readCache(key: string): unknown {
    const row = this.sql.prepare('SELECT response_json FROM tool_cache WHERE key = ?').get(key);
    return row && decode(row.response_json as string);
  }

  writeCache(key: string, provider: string, endpoint: string, request: string, response: unknown) {
    this.sql.prepare(`INSERT INTO tool_cache (key, provider, endpoint, request_json, response_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET response_json = excluded.response_json, fetched_at = excluded.fetched_at`)
      .run(key, provider, endpoint, request, encode(response), now());
  }

  beginLedger(input: LedgerInput, hash: string): ToolLedgerEntry {
    const ts = now();
    const { lastInsertRowid } = this.sql.prepare(`INSERT INTO ledger
      (run_id, ts, step, provider, endpoint, mode, status, attempt, credits, input_tokens, output_tokens, usd, latency_ms, injected, request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.runId, ts, input.step, input.provider, input.endpoint, input.mode, input.status, input.attempt, input.credits,
        input.inputTokens, input.outputTokens, input.usd, input.latencyMs, Number(input.injected), hash);
    return { ...input, ts, id: Number(lastInsertRowid) };
  }

  finishLedger(entry: ToolLedgerEntry) {
    this.sql.prepare(`UPDATE ledger SET status = ?, credits = ?, input_tokens = ?, output_tokens = ?, usd = ?,
      latency_ms = ?, error = ? WHERE id = ?`).run(entry.status, entry.credits, entry.inputTokens, entry.outputTokens,
      entry.usd, entry.latencyMs, entry.error ?? null, entry.id);
    this.recordEvent(entry.runId, { type: 'ledger.entry', entry });
  }

  getLedger(runId: string): ToolLedgerEntry[] {
    const rows = this.sql.prepare(`SELECT id, run_id AS runId, ts, step, provider, endpoint, mode, status, attempt, credits,
      input_tokens AS inputTokens, output_tokens AS outputTokens, usd, latency_ms AS latencyMs, injected, error FROM ledger
      WHERE run_id = ? ORDER BY id`).all(runId) as unknown as (ToolLedgerEntry & { error: string | null })[];
    return rows.map(({ error, ...row }) => ({ ...row, injected: Boolean(row.injected), ...(error ? { error } : {}) }));
  }

  budget(runId: string): BudgetState {
    const run = this.requireRun(runId);
    const costs = this.sql.prepare('SELECT coalesce(sum(credits), 0) AS credits, coalesce(sum(usd), 0) AS modelUsd FROM ledger WHERE run_id = ?')
      .get(runId) as { credits: number; modelUsd: number };
    let exhausted: BudgetState['exhausted'] = null;
    if (run.status === 'budget_exhausted') {
      const event = this.sql.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'budget.update' ORDER BY seq DESC LIMIT 1").get(runId);
      if (event) exhausted = decode<{ budget: BudgetState }>(event.payload_json as string).budget.exhausted;
    }
    const endTime = ['completed', 'failed', 'budget_exhausted'].includes(run.status)
      || (run.status === 'awaiting_approval' && run.engine_pid === null) ? Date.parse(run.updated_at) : Date.now();
    return {
      limits: decode(run.limits_json), used: { ...costs, seconds: Math.max(0, endTime - Date.parse(run.created_at)) / 1000 }, exhausted,
    };
  }
}
