// Pure helpers for Find buyers: which outbound run to show, one row per account, its status. No React, no fetches.
import type { Approval, Draft, RunSnapshot, Target, Trigger } from '../../../../shared/types.ts';

export type RunRow = { id: string; request: string; status: string; createdAt: string };

/** Outbound (seller) runs only: intro, candidate and openings-scan runs live on other tabs. */
export const isOutbound = (r: RunRow) => !/^(intro|candidate):/.test(r.request) && !/^Predict openings/i.test(r.request);

export type StatusKind = 'ready' | 'approved' | 'sent' | 'held' | 'watch' | 'not_drafted';
export type AccountStatus = { kind: StatusKind; label: string; cls: 'prov' | 'held' | 'verified' | 'plain'; why?: string };

export type Account = {
  target: Target;
  name: string;
  domain: string | null;
  trigger: Trigger | null;
  draft: Draft | null;
  send: Approval | null;
  status: AccountStatus;
};

/** Rule ids as the registry writes them: TALENT_DRAIN -> "Talent drain". */
export const RULE_WORDS: Record<string, string> = {
  TALENT_DRAIN: 'Talent drain', DISPLACEMENT: 'Displacement', CONTAGION: 'Contagion', DIRECT: 'Direct signal', FUNDING: 'Funding',
};
export const ruleWords = (m: string) => RULE_WORDS[m] ?? m.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** Why a run's drafting step stopped, in plain words ("Run reached its seconds ceiling"). */
export function draftStopReason(snap: RunSnapshot): string | null {
  const s = snap.steps.find((x) => x.step === 'draft_messages');
  if (s?.status === 'failed') return s.summary ?? 'The drafting step failed';
  if (snap.status === 'budget_exhausted') return `Run hit its ${snap.budget?.exhausted ?? 'budget'} cap before drafting`;
  return null;
}

/** Which trigger kinds a rule fires on, so the row cites the trigger that made the prediction. */
const TRIGGER_KINDS: Record<string, string[]> = { TALENT_DRAIN: ['departure'], DISPLACEMENT: ['post', 'news'], DIRECT: ['job_post'], FUNDING: ['funding'] };

export function accounts(snap: RunSnapshot): Account[] {
  const byId = new Map(snap.companies.map((c) => [c.id, c]));
  const stop = draftStopReason(snap);
  const delivered = new Set([
    ...snap.outbox.map((o) => o.approvalId),
  ]);
  const inboxKeys = new Set(snap.receipts.map((r) => r.idempotencyKey));
  return [...snap.targets].sort((a, b) => a.rank - b.rank).map((t) => {
    const co = byId.get(t.companyId);
    const kinds = t.mechanisms.flatMap((m) => TRIGGER_KINDS[m] ?? []);
    const score = (x: Trigger) => (kinds.includes(x.kind) ? 2 : 0) + (x.date === t.whyNowDate ? 1 : 0);
    const trig = snap.triggers.filter((x) => x.companyId === t.companyId).sort((a, b) => score(b) - score(a) || b.date.localeCompare(a.date));
    const draft = t.draftId ? snap.drafts.find((d) => d.id === t.draftId) ?? null : null;
    const send = snap.approvals.find((a) => a.companyId === t.companyId && a.kind === 'send_message' && (!draft || a.draftId === draft.id)) ?? null;
    const sent = !!send && (delivered.has(send.id) || inboxKeys.has(send.idempotencyKey));
    let status: AccountStatus;
    if (sent) status = { kind: 'sent', label: 'Delivered once', cls: 'verified' };
    else if (t.hold?.reasons?.length) status = { kind: 'held', label: `Held: ${t.hold.reasons[0]}`, cls: 'held', why: t.hold.reasons.join(' · ') };
    else if (t.watch) status = { kind: 'watch', label: 'Watch', cls: 'plain', why: t.watch.reason };
    else if (t.notDrafted) status = { kind: 'not_drafted', label: `Not drafted (${t.notDrafted.have} of ${t.notDrafted.need} verified facts)`, cls: 'held', why: t.notDrafted.reason };
    else if (!draft) status = { kind: 'not_drafted', label: 'Not drafted', cls: 'held', why: stop ?? 'No draft was written for this account' };
    else if (send?.status === 'approved') status = { kind: 'approved', label: 'Approved, not yet delivered', cls: 'prov' };
    else if (send?.status === 'rejected') status = { kind: 'held', label: 'Rejected by you', cls: 'held' };
    else status = { kind: 'ready', label: 'Draft ready', cls: 'prov' };
    return { target: t, name: co?.name ?? t.companyId, domain: co?.domain ?? null, trigger: trig[0] ?? null, draft, send, status };
  });
}

/** The draft's honest label: a model is named only when a model wrote it (drafts are templates today). */
export function draftLabel(d: Draft & { generatorLabel?: string | null }, verified: number): string {
  if (d.generatorLabel) return d.generatorLabel;
  const n = d.unverifiable.length;
  const tail = `${verified} verified claim${verified === 1 ? '' : 's'}${n ? ` · ${n} excluded` : ''}`;
  return String(d.generator ?? '').startsWith('llm') ? `Drafted by GPT-6 Luna from ${tail}` : `Template from ${tail}`;
}

/** "2026-11-10" inside a sentence reads "10 Nov 2026" (the draft keeps ISO dates; the screen doesn't). */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const readableDates = (s: string) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => `${Number(d)} ${MON[Number(m) - 1]} ${y}`);
