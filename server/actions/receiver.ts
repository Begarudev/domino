import type { DeliveryReceipt, OutboxAction } from '../../shared/types.ts';
import { now } from '../db.ts';
import type { Store } from '../db.ts';

type InboxPayload = Pick<OutboxAction, 'runId' | 'approvalId' | 'kind' | 'testMode'> & { message: string };

// Commit the receiver's decision independently of the sender's outbox acknowledgement.
export function receiveMessage(store: Store, idempotencyKey: string, payload: InboxPayload): DeliveryReceipt {
  return store.transaction(() => {
    const receivedAt = now();
    const serialized = JSON.stringify(payload);
    const result = store.sql.prepare(`INSERT INTO inbox_received (idempotency_key, received_at, payload_json)
      VALUES (?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).run(idempotencyKey, receivedAt, serialized);
    if (result.changes) return { idempotencyKey, status: 'delivered', receivedAt };

    const previous = store.sql.prepare('SELECT received_at, payload_json FROM inbox_received WHERE idempotency_key = ?')
      .get(idempotencyKey);
    if (!previous || previous.payload_json !== serialized) throw new Error('Inbox key belongs to another message');
    store.sql.prepare('UPDATE inbox_received SET attempts = attempts + 1 WHERE idempotency_key = ?').run(idempotencyKey);
    return { idempotencyKey, status: 'already_delivered', receivedAt: previous.received_at as string };
  });
}
