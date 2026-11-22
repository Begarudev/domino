import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../db.ts';
import { root } from '../env.ts';
import { canonicalJson, hash, sanitize } from './tool.ts';

export const cacheSnapshotPath = join(root, 'data/cache-snapshot');
const rowSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/), provider: z.literal('crustdata'),
  endpoint: z.string().startsWith('/'), request_json: z.string(), response_json: z.string(),
  fetched_at: z.string().datetime({ offset: true }),
});

export function exportCache(store: Store, directory = cacheSnapshotPath) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rows = store.sql.prepare('SELECT * FROM tool_cache ORDER BY fetched_at, key').all();
  let exported = 0;
  for (const row of rows) {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) continue;
    const data = parsed.data;
    const endpoint = data.endpoint.replace(/^\/+/, '').replace(/[^a-z0-9_-]+/gi, '_');
    const filename = join(directory, `${endpoint}__${data.key.slice(0, 16)}.json`);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    data.request_json = canonicalJson(sanitize(JSON.parse(data.request_json)));
    data.response_json = JSON.stringify(sanitize(JSON.parse(data.response_json), true));
    try {
      writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, filename);
      exported++;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return exported;
}

export function importCache(store: Store, directory = cacheSnapshotPath) {
  if (!existsSync(directory)) return 0;
  const insert = store.sql.prepare(`INSERT INTO tool_cache (key, provider, endpoint, request_json, response_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`);
  let imported = 0;
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    try {
      const row = rowSchema.parse(JSON.parse(readFileSync(join(directory, file.name), 'utf8')));
      const request = canonicalJson(sanitize(JSON.parse(row.request_json)));
      if (hash(row.endpoint + request) !== row.key) continue;
      const response = JSON.stringify(sanitize(JSON.parse(row.response_json), true));
      imported += Number(insert.run(row.key, row.provider, row.endpoint, request, response, row.fetched_at).changes);
    } catch {
      // An invalid local snapshot must not prevent other cache rows from loading.
    }
  }
  return imported;
}

export function cacheStats(store: Store) {
  return store.sql.prepare('SELECT count(*) AS cacheRows, max(fetched_at) AS cacheFetchedAt FROM tool_cache').get() as {
    cacheRows: number; cacheFetchedAt: string | null;
  };
}
