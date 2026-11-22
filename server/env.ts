import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataMode, RunLimits } from '../shared/types.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
function findEnvFile() {
  const local = resolve(root, '.env');
  if (existsSync(local)) return local;
  try {
    const worktree = /^gitdir:\s*(.+)$/.exec(readFileSync(resolve(root, '.git'), 'utf8').trim());
    if (!worktree) return;
    const gitDir = resolve(root, worktree[1]);
    const commonDir = resolve(gitDir, readFileSync(resolve(gitDir, 'commondir'), 'utf8').trim());
    const main = resolve(dirname(commonDir), '.env');
    if (existsSync(main)) return main;
  } catch {
    // A regular checkout or a source archive may have no linked-worktree metadata.
  }
}
const envFile = findEnvFile();
if (envFile) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].trim();
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
    process.env[match[1]] = quoted ? quoted[2] : value.replace(/(?:^|\s+)#.*$/, '');
  }
}

const { DOMINO_DATA, DOMINO_PORT, DOMINO_DB, DOMINO_OUTBOX } = process.env;
const crustdataKey = Boolean(process.env.CRUSTDATA_API_KEY);
const anthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const openaiKey = Boolean(process.env.OPENAI_API_KEY);
const llm: 'anthropic' | 'openai' | 'template' = openaiKey ? 'openai' : anthropicKey ? 'anthropic' : 'template';
export const ANTHROPIC_MODEL = redactSecrets(process.env.ANTHROPIC_MODEL || 'claude-opus-5-5');
const openaiModel = redactSecrets(process.env.OPENAI_MODEL || 'gpt-5-mini');
const dataMode: DataMode = DOMINO_DATA === 'live' || DOMINO_DATA === 'cache' || DOMINO_DATA === 'fixture'
  ? DOMINO_DATA : crustdataKey ? 'live' : 'fixture';

export const config = {
  port: Number(DOMINO_PORT ?? 4321),
  dataMode, llm, crustdataKey, anthropicKey, openaiKey, openaiModel,
  llmLabel: llm === 'anthropic' ? `anthropic:${ANTHROPIC_MODEL}` : llm === 'openai' ? `openai:${openaiModel}` : 'template',
  dbPath: DOMINO_DB === ':memory:' ? DOMINO_DB : resolve(root, DOMINO_DB || 'data/domino.db'),
  outboxPath: resolve(root, DOMINO_OUTBOX || 'data/outbox'),
};

export const defaultLimits: RunLimits = { maxCredits: 100, maxModelUsd: 0.5, maxSeconds: 300 };

export function redactSecrets(value: string): string {
  for (const key of [process.env.CRUSTDATA_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY]) {
    if (key) value = value.replaceAll(key, '[redacted]');
  }
  return value;
}
