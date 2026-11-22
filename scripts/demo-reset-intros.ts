// Demo reset before a recording: archive the fictional fixture candidate's intros so the next "Request intro" drafts a
// fresh one awaiting approval. Nothing is deleted: archived intros keep their runs, approvals, outbox rows and receipts.
// Uses the same database as the server (DOMINO_DB, default data/domino.db). Real candidates are never touched.
//
//   bun run demo:reset-intros             archive only (request the intro again on camera)
//   bun run demo:reset-intros --reopen    archive, then ask the running server (DOMINO_URL, default
//                                         http://127.0.0.1:4321) to re-request each candidate → company intro, so a fresh
//                                         draft is waiting for approval
//   ... --reopen --crash-after-deliver    the same, and the new intro's engine crashes right after the test inbox accepts
//                                         the approved message: Resume then shows "Already delivered · skipped",
//                                         Deliveries: 1 (the kill-and-resume beat)
import { Store } from '../server/db.ts';
import { archiveFixtureIntros, deskTables } from '../server/desk/store.ts';

const reopen = process.argv.includes('--reopen');
const crashAfterDeliver = process.argv.includes('--crash-after-deliver');
const base = process.env.DOMINO_URL ?? `http://127.0.0.1:${process.env.DOMINO_PORT ?? 4321}`;
const store = new Store();
let pairs: { candidateId: string; openingId: string }[] = [];
try {
  deskTables(store);   // adds archived_at on a database the upgraded server hasn't touched yet
  // The candidate-requested intros about to be archived, newest per candidate and opening.
  pairs = (store.sql.prepare(`SELECT DISTINCT candidate_id AS candidateId, opening_id AS openingId FROM desk_intros
    WHERE archived_at IS NULL AND direction = 'candidate_to_company'`).all() as { candidateId: string; openingId: string }[]);
  const archived = archiveFixtureIntros(store);
  const still = new Set((store.sql.prepare('SELECT candidate_id AS id FROM desk_intros WHERE archived_at IS NULL').all() as { id: string }[])
    .map(row => row.id));
  pairs = pairs.filter(pair => !still.has(pair.candidateId));   // only fixture candidates were archived
  console.log(`Archived ${archived} intro${archived === 1 ? '' : 's'} of fixture candidates.`);
} finally {
  store.sql.close();
}
if (!reopen) {
  console.log('The next "Request intro" starts a fresh draft. Add --reopen to have the server draft them now.');
} else {
  for (const { candidateId, openingId } of pairs) {
    const response = await fetch(`${base}/api/candidates/${candidateId}/intros`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openingId, ...crashAfterDeliver && { chaos: { crashAfterDeliver: true } } }),
    }).catch(error => ({ status: 0, json: async () => ({ error: String(error) }) }) as unknown as Response);
    const body = await response.json().catch(() => ({})) as { id?: string; status?: string; error?: string };
    console.log(response.status === 201 ? `Re-requested ${candidateId} → ${openingId}: new intro ${body.id} (drafting; awaiting approval in a few seconds)`
      : `Could not re-request ${candidateId} → ${openingId}: HTTP ${response.status} ${body.error ?? ''}`);
  }
}
