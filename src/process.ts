import { spawn, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export function findBinary(binary: string): string {
  const paths = binary.includes('/') ? [resolve(binary)] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, binary));
  for (const path of paths) {
    try { accessSync(path, constants.X_OK); return path; }
    catch (error) { if (!isSystemError(error, ['ENOENT', 'EACCES'])) throw error; }
  }
  throw new Error(`${binary} executable not found. Install it or configure its absolute path.`);
}
export function isSystemError(error: unknown, codes: string[]): boolean { return error instanceof Error && 'code' in error && codes.includes(String(error.code)); }
export function processIdentity(pid: number): string | undefined {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || undefined; }
  catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) return undefined;
    throw error;
  }
}
export function subscriptionEnv(home?: string, runId = 'probe'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LASTCALL_OWNED: runId, ...(home ? { LASTCALL_HOME: home } : {}) };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_PROFILE|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDECODE$|CODEX_API_KEY)/.test(key)) delete env[key];
  }
  return env;
}

// Settings can restore environment overrides after spawn. Apply the same guard
// to auth checks and execution without changing the user's settings files.
// https://code.claude.com/docs/en/authentication#authentication-precedence
export const CLAUDE_SUBSCRIPTION_SETTINGS = {
  forceLoginMethod: 'claudeai', apiKeyHelper: '',
  env: {
    ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_PROFILE: '',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
  },
};
export interface Capture { stdout: string; stderr: string; code: number }
export function capture(binary: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Promise<Capture> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env: options.env, cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let failure: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (!isSystemError(error, ['ESRCH'])) throw error; }
    };
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop(new Error(`${binary} timed out after ${options.timeout ?? 30_000}ms`)), options.timeout ?? 30_000);
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); if (stdout.length > 4 * 1024 * 1024) stop(new Error('Command output exceeded 4 MiB')); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); if (stderr.length > 4 * 1024 * 1024) stop(new Error('Command diagnostics exceeded 4 MiB')); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      if (failure) reject(failure); else resolveResult({ stdout, stderr, code: code ?? 1 });
    });
  });
}
