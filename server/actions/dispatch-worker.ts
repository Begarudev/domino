import { Store } from '../db.ts';
import { dispatchAction } from './outbox.ts';

if (import.meta.main) {
  const key = process.env.DOMINO_DELIVERY_KEY;
  if (!key || !/^[a-f0-9]{16}$/.test(key)) process.exit(1);
  const store = new Store();
  try {
    dispatchAction(store, key);
  } catch {
    process.exitCode = 1;
  } finally {
    store.sql.close();
    if (process.connected) process.disconnect?.();
  }
}
