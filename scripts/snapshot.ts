import { Store } from '../server/db.ts';
import { exportCache } from '../server/runtime/cache-snapshot.ts';

const store = new Store();
try {
  console.log(`Exported ${exportCache(store)} cached responses to data/cache-snapshot.`);
} finally {
  store.sql.close();
}
