import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../server/env.ts';

function runBun(...args: string[]) {
  const result = spawnSync(process.versions.bun ? process.execPath : 'bun', args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

function latestChange(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((latest, file) => Math.max(latest, latestChange(join(path, file))), stat.mtimeMs);
}

if (!existsSync(join(root, 'node_modules'))) runBun('install');
// Build the UI that will be served (DOMINO_UI=web2 for the Search Desk app) when its sources are newer than its build.
// web2 imports state and API code from web/src and types from shared/, so those count as its sources too.
const ui = process.env.DOMINO_UI === 'web2' ? 'web2' : 'web';
const dir = join(root, ui);
const sources = [join(dir, 'src'), join(dir, 'vite.config.ts'), join(dir, 'index.html'), join(root, 'shared'),
  ...ui === 'web2' ? [join(root, 'web/src')] : []];
if (existsSync(join(dir, 'vite.config.ts')) && latestChange(join(dir, 'dist/index.html')) < Math.max(...sources.map(latestChange))) {
  runBun('run', ui === 'web2' ? 'build:web2' : 'build:web');
}

const { portError, startServer } = await import('../server/index.ts');
startServer().on('error', portError);
