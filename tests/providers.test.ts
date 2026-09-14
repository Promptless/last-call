import { describe, expect, it } from 'vitest';
import { accountsMatch, normalizeQuota } from '../src/providers.js';
import { parseEvent, runnerArgs } from '../src/runner.js';
import { subscriptionEnv } from '../src/process.js';
import { NOW, fixture, run } from './helpers.js';
import { rmSync } from 'node:fs';

function payload() { return { provider: 'claude', source: 'cli', usage: { primary: { usedPercent: 50, windowMinutes: 300, resetsAt: '2026-09-14T09:00:00Z' }, secondary: { usedPercent: 20, windowMinutes: 10080, resetsAt: '2026-09-15T08:00:00Z' }, tertiary: null, updatedAt: '2026-09-14T08:00:00Z', identity: { accountEmail: 'person@example.com', accountOrganization: null } } }; }
describe('provider contracts', () => {
  it('pins both email and organization while treating email case consistently', () => {
    const account = { email: 'person@example.com', organization: 'Team' };
    expect(accountsMatch(account, { ...account, email: 'Person@Example.com' })).toBe(true);
    expect(accountsMatch(account, { ...account, email: 'other@example.com' })).toBe(false);
    expect(accountsMatch(account, { ...account, organization: 'Other team' })).toBe(false);
    expect(accountsMatch(account, { email: account.email })).toBe(false);
    expect(accountsMatch({ email: account.email }, account)).toBe(false);
  });
  it('normalizes exact-account snapshots and rejects missing or ambiguous identity', () => {
    const row = payload(); const account = { email: 'person@example.com' };
    expect(normalizeQuota([row], 'claude', account, NOW).weekly.usedPercent).toBe(20);
    expect(() => normalizeQuota([row, row], 'claude', account, NOW)).toThrow(/exactly one/);
    expect(() => normalizeQuota(row, 'claude', { email: 'other@example.com' }, NOW)).toThrow();
    row.usage.secondary.windowMinutes = 300; expect(() => normalizeQuota(row, 'claude', account, NOW)).toThrow(/Weekly/);
  });
  it('rejects unknown percentages, absent weekly reset, wrong organization, and paid data sources', () => {
    const row = payload(); const account = { email: 'person@example.com' };
    expect(() => normalizeQuota(row, 'claude', { ...account, organization: 'different' }, NOW)).toThrow(/organization/);
    row.source = 'api'; expect(() => normalizeQuota(row, 'claude', account, NOW)).toThrow(/source/);
    row.source = 'cli'; row.usage.secondary.usedPercent = Number.NaN; expect(() => normalizeQuota(row, 'claude', account, NOW)).toThrow();
    row.usage.secondary.usedPercent = 1; row.usage.secondary.resetsAt = ''; expect(() => normalizeQuota(row, 'claude', account, NOW)).toThrow();
  });
  it('accepts identity-free native CLI data only with bracketed identity verification', () => {
    const row = { ...payload(), source: 'claude', usage: { ...payload().usage, identity: { providerID: 'claude' }, primary: { usedPercent: 0, windowMinutes: 300 } } };
    const account = { email: 'person@example.com', organization: 'Team' };
    expect(() => normalizeQuota(row, 'claude', account, NOW)).toThrow();
    const q = normalizeQuota(row, 'claude', account, NOW, account);
    expect(q.identityBasis).toBe('verified-native-cli'); expect(q.account).toEqual(account); expect(q.shortTerm).toBeUndefined();
    row.usage.primary.usedPercent = 10;
    expect(() => normalizeQuota(row, 'claude', account, NOW, account)).toThrow();
  });
  it('rejects native and snapshot organization changes even when the account had no organization', () => {
    const account = { email: 'person@example.com' };
    const row = payload();
    expect(() => normalizeQuota(row, 'claude', account, NOW, { ...account, organization: 'Team' })).toThrow(/native account/);
    const organizationSnapshot = { ...row, usage: { ...row.usage, identity: { ...row.usage.identity, accountOrganization: 'Team' } } };
    expect(() => normalizeQuota(organizationSnapshot, 'claude', account, NOW, account)).toThrow(/organization/);
    expect(() => normalizeQuota(row, 'claude', account, NOW, { email: 'other@example.com' })).toThrow(/native account/);
  });
  it('recognizes native sessions and structured outcomes without treating prose as a quota retry', () => {
    const outcome = { status: 'needs_input', summary: 'Prepared a preview', question: 'Approve publishing?', workItem: 'account:example', artifacts: ['/tmp/preview.html'] };
    expect(parseEvent('claude', { type: 'result', subtype: 'success', session_id: 'abc', structured_output: outcome })).toEqual({ sessionId: 'abc', outcome });
    expect(parseEvent('codex', { type: 'thread.started', thread_id: 'def' }).sessionId).toBe('def');
    expect(parseEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(outcome) } }).outcome).toEqual(outcome);
    expect(parseEvent('codex', { type: 'turn.failed', error: { message: 'Someone wrote rate_limit_exceeded in a document' } }).quotaLimited).toBeUndefined();
    expect(parseEvent('codex', { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }).quotaLimited).toBe(true);
    expect(parseEvent('codex', { type: 'error', message: 'Reconnecting... 1/5' })).toEqual({ diagnostic: 'Reconnecting... 1/5' });
    expect(parseEvent('codex', { type: 'turn.completed' })).toEqual({ completed: true });
  });
  it('preserves saved-session resumption and explicit native permissions', () => {
    const f = fixture();
    try {
      const current = run(f, { provider: 'codex' });
      const args = runnerArgs(current, '/tmp/schema.json');
      expect(args.slice(args.indexOf('resume'), args.indexOf('resume') + 2)).toEqual(['resume', 'session-1']);
      expect(args).toContain('approval_policy="never"'); expect(args).toContain('sandbox_mode="read-only"');
      const claude = runnerArgs(run(f), '/tmp/schema.json');
      expect(claude).toContain('--permission-prompts'); expect(claude).toContain('none'); expect(claude).not.toContain('--bare');
    } finally { f.store.close(); rmSync(f.home, { recursive: true, force: true }); }
  });
  it('removes billing overrides while preserving skill integrations', () => {
    process.env.ANTHROPIC_API_KEY = 'test-only'; process.env.OPENAI_API_KEY = 'test-only'; process.env.LASTCALL_TEST_INTEGRATION = 'kept';
    try { const env = subscriptionEnv('/tmp/test-home'); expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.LASTCALL_TEST_INTEGRATION).toBe('kept'); }
    finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.LASTCALL_TEST_INTEGRATION; }
  });
});
