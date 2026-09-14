import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { AccountSchema, type Account, type Config, type Provider, type Quota, type QuotaReading, type Window } from './model.js';
import { capture, findBinary, subscriptionEnv } from './process.js';
import { errorMessage } from './files.js';

const object = z.record(z.string(), z.unknown());
const nativeClaudeAccount = z.object({ loggedIn: z.literal(true), authMethod: z.literal('claude.ai'), apiProvider: z.literal('firstParty'), email: z.string().email(), orgName: z.string().optional() });

/** Query the native account without reading or copying its credentials. */
export async function nativeAccount(provider: Provider, binary: string, home?: string): Promise<Account> {
  if (provider === 'claude') {
    const result = await capture(binary, ['auth', 'status', '--json'], { env: subscriptionEnv(home) });
    if (result.code) throw new Error('Claude authentication check failed; run claude auth login.');
    const account = nativeClaudeAccount.parse(JSON.parse(result.stdout));
    return { email: account.email, organization: account.orgName };
  }
  // Stable account/read handshake: https://learn.chatgpt.com/docs/app-server#authentication
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], { env: subscriptionEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false;
    const finish = (error?: Error, account?: Account): void => {
      if (done) return; done = true; clearTimeout(timer); lines.close(); child.kill('SIGTERM');
      if (error) reject(error); else resolve(account!);
    };
    const timer = setTimeout(() => finish(new Error('Codex account/read timed out')), 20_000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.on('error', error => finish(error));
    child.on('exit', () => { if (!done) finish(new Error('Codex exited before returning its account')); });
    child.stdin.on('error', error => finish(error));
    lines.on('line', line => {
      try {
        const message = object.parse(JSON.parse(line));
        if (message.error) { finish(new Error('Codex account request was rejected')); return; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          child.stdin.write(JSON.stringify({ method: 'account/read', id: 2, params: { refreshToken: false } }) + '\n');
        }
        if (message.id === 2) {
          const result = z.object({ account: z.object({ type: z.literal('chatgpt'), email: z.string().email() }) }).parse(message.result);
          finish(undefined, { email: result.account.email });
        }
      } catch (error) { finish(new Error(`Invalid Codex subscription account: ${errorMessage(error)}`)); }
    });
    child.stdin.write(JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'lastcall', title: 'Last Call', version: '0.1.0' } } }) + '\n');
  });
}

const timestamp = z.string().refine(v => Number.isFinite(Date.parse(v)));
const WindowSchema = z.object({ usedPercent: z.number().min(0).max(100), windowMinutes: z.number().positive(), resetsAt: timestamp });
const OptionalWindowSchema = WindowSchema.extend({ resetsAt: timestamp.nullish() }).refine(v => !!v.resetsAt || v.usedPercent === 0, 'A used allowance window requires a reset timestamp');
const IdentitySchema = z.object({ accountEmail: z.string().email().optional(), accountOrganization: z.string().nullish() });
const PayloadSchema = z.object({ provider: z.enum(['claude', 'codex']), source: z.string(), usage: z.object({
  primary: OptionalWindowSchema.nullish(), secondary: WindowSchema,
  tertiary: OptionalWindowSchema.nullish(), updatedAt: timestamp,
  identity: IdentitySchema.optional(), accountEmail: z.string().optional(), accountOrganization: z.string().nullish(),
}) });

/** Normalize CodexBar's measured allowances, never its local cost estimates. */
export function normalizeQuota(input: unknown, provider: Provider, expected: Account, now: number, verifiedNative?: Account): Quota {
  const rows: unknown[] = Array.isArray(input) ? input : [input];
  const parsed = rows.map(row => PayloadSchema.safeParse(row)).filter(result => result.success).map(result => result.data);
  const identityFor = (row: z.infer<typeof PayloadSchema>): string | undefined => row.usage.identity?.accountEmail ?? row.usage.accountEmail ?? (row.source === provider ? verifiedNative?.email : undefined);
  const matches = parsed.filter(row => row.provider === provider && identityFor(row)?.toLowerCase() === expected.email.toLowerCase());
  if (matches.length !== 1) throw new Error('CodexBar did not return exactly one valid snapshot for the native account');
  const row = matches[0]!;
  // Pin CLI transport to the native login: https://github.com/steipete/CodexBar/blob/main/docs/cli.md
  if (!['cli', 'codex-cli', 'claude-cli', 'local', provider].includes(row.source)) throw new Error(`Unexpected quota source: ${row.source}`);
  const identity = row.usage.identity ?? { accountEmail: row.usage.accountEmail, accountOrganization: row.usage.accountOrganization };
  const account = AccountSchema.parse({ email: identityFor(row), organization: identity.accountOrganization ?? verifiedNative?.organization });
  if (expected.organization && account.organization !== expected.organization) throw new Error('Quota organization does not match native account');
  const convert = (w: z.infer<typeof WindowSchema>): Window => ({ ...w, resetsAt: Date.parse(w.resetsAt) });
  if (row.usage.secondary.windowMinutes !== 10080) throw new Error('Weekly window missing or unsupported');
  const optionalWindow = (w: z.infer<typeof OptionalWindowSchema> | null | undefined): Window | undefined => w?.resetsAt ? convert({ ...w, resetsAt: w.resetsAt }) : undefined;
  const extra = optionalWindow(row.usage.tertiary);
  return { provider, account, identityBasis: identity.accountEmail ? 'snapshot' : 'verified-native-cli', fetchedAt: now, updatedAt: Date.parse(row.usage.updatedAt), weekly: convert(row.usage.secondary), shortTerm: optionalWindow(row.usage.primary), extra: extra ? [extra] : [] };
}

export async function readQuota(config: Config, provider: Provider, home: string): Promise<QuotaReading> {
  const selected = config.providers[provider];
  if (!selected) return { error: 'Provider is not configured' };
  try {
    const binary = findBinary(selected.binary);
    const account = await nativeAccount(provider, binary, home);
    if (account.email.toLowerCase() !== selected.account.email.toLowerCase() || (selected.account.organization && account.organization !== selected.account.organization)) throw new Error('Native login changed; update the configured account');
    // Pin the helper to the exact executable whose native login is checked on both sides.
    // https://github.com/steipete/CodexBar/blob/v0.60.1/Sources/CodexBarCore/PathEnvironment.swift
    const env = { ...subscriptionEnv(home), [provider === 'claude' ? 'CLAUDE_CLI_PATH' : 'CODEX_CLI_PATH']: binary };
    const result = await capture(config.codexbar, ['usage', '--provider', provider, '--source', 'cli', '--format', 'json', '--json-only'], { env, timeout: 75_000 });
    if (result.code) throw new Error(`CodexBar could not fetch ${provider} quota (exit ${result.code}); run lastcall doctor`);
    const after = await nativeAccount(provider, binary, home);
    if (after.email !== account.email || after.organization !== account.organization) throw new Error('Native login changed during quota measurement');
    return { quota: normalizeQuota(JSON.parse(result.stdout), provider, selected.account, Date.now(), after) };
  } catch (error) { return { error: errorMessage(error) }; }
}

export async function readQuotas(config: Config, home: string): Promise<Partial<Record<Provider, QuotaReading>>> {
  const readings: Partial<Record<Provider, QuotaReading>> = {};
  await Promise.all((['claude', 'codex'] as const).filter(p => config.providers[p]).map(async p => { readings[p] = await readQuota(config, p, home); }));
  return readings;
}
