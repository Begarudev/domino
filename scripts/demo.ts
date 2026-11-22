import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../server/env.ts';

function runNpm(...args: string[]) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

function latestChange(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((latest, file) => Math.max(latest, latestChange(join(path, file))), stat.mtimeMs);
}

if (!existsSync(join(root, 'node_modules'))) runNpm('install');
const web = join(root, 'web');
const html = join(web, 'dist/index.html');
const webConfig = join(web, 'vite.config.ts');
if (existsSync(webConfig) && latestChange(html) < Math.max(
  latestChange(join(web, 'src')), latestChange(webConfig), latestChange(join(web, 'index.html')),
)) {
  runNpm('run', 'build:web');
}

const { startServer } = await import('../server/index.ts');
startServer().on('error', () => {
  console.error('DOMINO could not bind the server port.');
  process.exit(1);
});
