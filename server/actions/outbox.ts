import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Approval, Company, Draft, OutboxAction, Target } from '../../shared/types.ts';
import { decode, now, Store } from '../db.ts';
import type { Outputs } from '../engine/steps.ts';
import { config, root } from '../env.ts';

export class ApprovalError extends Error {}

const cleanHeader = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const encodeHeader = (value: string) => `=?UTF-8?B?${Buffer.from(cleanHeader(value)).toString('base64')}?=`;
const crlf = (value: string) => value.replace(/\r\n|\r|\n/g, '\r\n');
const escapeCalendar = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[;,]/g, '\\$&');
const calendarDate = (date: number) => new Date(date).toISOString().replace(/[-:]|\.\d{3}/g, '');
const quoteHeader = (value: string) => '"' + cleanHeader(value).replace(/["\\]/g, '\\$&') + '"';
const header = (value: string, phrase = false) => /^[\x20-\x7e]*$/.test(cleanHeader(value))
  ? phrase ? quoteHeader(value) : cleanHeader(value) : encodeHeader(value);

function context(store: Store, approval: Approval) {
  const draftStep = store.getOutput<Outputs['draft_messages']>(approval.runId, 'draft_messages');
  const company = store.getOutput<Outputs['enrich_companies']>(approval.runId, 'enrich_companies')?.companies
    .find(company => company.id === approval.companyId);
  const draft = draftStep?.drafts.find(row => row.id === approval.draftId);
  const target = draftStep?.targets.find(row => row.companyId === approval.companyId);
  if (!draft || !company || !target) throw new ApprovalError('Draft details are unavailable');
  return { draft, company, target };
}

function messageFile(action: OutboxAction, draft: Draft, company: Company, target: Target) {
  if (!draft.verified || !draft.body.trim()) throw new ApprovalError('This draft needs a verified message body');
  if (!target.decider) throw new ApprovalError('This draft needs a decision-maker');
  const recipient = header(`${target.decider.name} at ${company.name}`, true);
  return [
    `To: ${recipient} <test-inbox+${action.idempotencyKey}@domino.invalid>`,
    `Subject: ${header(draft.subject)}`,
    `Date: ${new Date(action.executedAt).toUTCString()}`,
    'X-Domino-Test-Mode: true', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit', '', crlf(draft.body), '',
  ].join('\r\n');
}

function meetingFile(action: OutboxAction, draft: Draft, company: Company) {
  const start = draft.meeting.proposedSlots.map(Date.parse).find(time => Number.isFinite(time));
  if (start === undefined) throw new ApprovalError('This hold needs a proposed meeting time');
  const end = start + draft.meeting.durationMin * 60_000;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DOMINO//Local Meeting Hold//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${action.idempotencyKey}@domino.invalid`, `DTSTAMP:${calendarDate(Date.parse(action.executedAt))}`,
    `DTSTART:${calendarDate(start)}`, `DTEND:${calendarDate(end)}`, 'STATUS:TENTATIVE',
    `SUMMARY:${escapeCalendar(`${draft.meeting.title} - ${company.name}`)}`,
    'DESCRIPTION:DOMINO test-mode hold', 'X-DOMINO-TEST-MODE:TRUE', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function finishRun(store: Store, runId: string) {
  const run = store.requireRun(runId);
  if (run.status === 'awaiting_approval' && run.engine_pid === null &&
      store.getApprovals(runId).every(row => row.status !== 'pending')) {
    store.recordEvent(runId, { type: 'run.status', status: 'completed' });
  }
}

type Decision = 'approve' | 'reject';
export function decideApproval(store: Store, id: string, decision: Decision) {
  const work = store.transaction(() => {
    const approval = store.getApproval(id);
    if (!approval) return;
    const run = store.requireRun(approval.runId);
    const row = store.sql.prepare('SELECT json, executed_at FROM outbox WHERE idempotency_key = ?').get(approval.idempotencyKey);
    if (decision === 'approve' && row) return { approval, action: decode<OutboxAction>(row.json as string), duplicate: true };
    if (approval.status !== 'pending' || row) throw new ApprovalError('This approval already has a decision');
    if (run.status !== 'awaiting_approval' && run.status !== 'budget_exhausted') throw new ApprovalError('This run is not ready for a decision');
    if (decision === 'reject') {
      store.recordEvent(run.id, { type: 'approval.decided', approvalId: id, status: 'rejected' });
      finishRun(store, run.id);
      return { approval: store.getApproval(id)!, duplicate: false };
    }

    const { draft, company, target } = context(store, approval);
    const extension = approval.kind === 'send_message' ? 'eml' : 'ics';
    const filename = join(config.outboxPath, `${approval.idempotencyKey}.${extension}`);
    const relativePath = relative(root, filename);
    const action: OutboxAction = {
      idempotencyKey: approval.idempotencyKey, runId: run.id, approvalId: id, kind: approval.kind,
      testMode: true, sink: relativePath.startsWith('..') ? filename : relativePath, executedAt: now(),
      summary: approval.kind === 'send_message' ? `Saved local message for ${company.name}` : `Saved tentative hold for ${company.name}`,
    };
    // Validate before reserving the key. The execution transaction handles file recovery.
    fileContents(action, draft, company, target);
    store.sql.prepare('INSERT INTO outbox (idempotency_key, run_id, approval_id, json) VALUES (?, ?, ?, ?)')
      .run(action.idempotencyKey, action.runId, id, JSON.stringify(action));
    return { approval, action, duplicate: false };
  });
  if (!work) return;
  if (!work.action) return { approval: work.approval };
  const alreadyExecuted = executeReservation(store, work.action);
  if (work.duplicate || alreadyExecuted) {
    store.appendEvent(work.approval.runId, { type: 'action.duplicate_blocked', approvalId: id,
      idempotencyKey: work.approval.idempotencyKey, note: 'The idempotency key already exists' });
    return { duplicate: true as const };
  }
  return { approval: store.getApproval(id)!, action: work.action };
}

function fileContents(action: OutboxAction, draft: Draft, company: Company, target: Target) {
  return action.kind === 'send_message' ? messageFile(action, draft, company, target) : meetingFile(action, draft, company);
}

function executeReservation(store: Store, action: OutboxAction): boolean {
  return store.transaction(() => {
    const row = store.sql.prepare('SELECT executed_at FROM outbox WHERE idempotency_key = ?').get(action.idempotencyKey);
    if (row?.executed_at) return true;

    const approval = store.getApproval(action.approvalId)!;
    const { draft, company, target } = context(store, approval);
    const content = fileContents(action, draft, company, target);
    const filename = isAbsolute(action.sink) ? action.sink : join(root, action.sink);
    let existing: string | undefined;
    try {
      existing = readFileSync(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing !== content) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, content, { mode: 0o600, flag: 'wx', flush: true });
        renameSync(temp, filename);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    store.sql.prepare('UPDATE outbox SET executed_at = ? WHERE idempotency_key = ?').run(action.executedAt, action.idempotencyKey);
    store.recordEvent(action.runId, { type: 'approval.decided', approvalId: action.approvalId, status: 'approved' });
    store.recordEvent(action.runId, { type: 'action.executed', action });
    finishRun(store, action.runId);
    return false;
  });
}

export function recoverOutbox(store: Store) {
  for (const row of store.sql.prepare('SELECT json FROM outbox WHERE executed_at IS NULL').all()) {
    try {
      executeReservation(store, decode<OutboxAction>(row.json as string));
    } catch {
      // Leave the reservation for a retry when the local filesystem becomes writable.
    }
  }
}
