import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../server/env.ts';

const children = [spawn(process.execPath, ['--watch', 'server/index.ts'], { cwd: root, stdio: 'inherit' })];
if (existsSync(join(root, 'web/vite.config.ts'))) {
  children.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'],
    { cwd: root, stdio: 'inherit' }));
}

function stop(code: number) {
  for (const child of children) child.kill();
  process.exitCode = code;
}

for (const child of children) {
  child.once('exit', code => stop(code ?? 0));
  child.once('error', () => stop(1));
}
process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));
