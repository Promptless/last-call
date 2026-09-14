import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigSchema, type Config } from './model.js';

export function homePath(): string { return resolve(process.env.LASTCALL_HOME ?? join(homedir(), '.lastcall')); }
export function ensureHome(home: string): void { mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700); }
export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, 'utf8')); }
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export function loadConfig(home: string): Config {
  const path = join(home, 'config.json');
  if (!existsSync(path)) throw new Error('Run lastcall init first, or supply --home for an existing installation.');
  return ConfigSchema.parse(readJson(path));
}
export function saveConfig(home: string, config: Config): void { ensureHome(home); atomicJson(join(home, 'config.json'), ConfigSchema.parse(config)); }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
