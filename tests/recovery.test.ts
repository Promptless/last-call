import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { acquireLease, assertServiceHome, servicePlist } from '../src/macos.js';
import { reconcileRuns, finishRun } from '../src/runner.js';
import { hasOpenWork, statusSnapshot } from '../src/daemon.js';
import { eligibility } from '../src/scheduler.js';
import { fixture, NOW, quota, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
describe('durable recovery', () => {
  it.each(['weekly', 'manual'])('keeps a new %s sprint awake before capacity first becomes available', kind => {
    const f = setup(); const q = quota('claude', NOW + (kind === 'manual' ? 48 : 8) * 3_600_000);
    q.shortTerm!.usedPercent = 100;
    if (kind === 'manual') f.store.put('setting', 'manual:claude', { id: 'manual', deadline: NOW + 3600_000, providers: ['claude'], resets: { claude: q.weekly.resetsAt } });
    const readings = { claude: { quota: q } };
    expect(f.store.sprints()).toEqual([]);
    expect(eligibility(f.config, readings, { ready: true }, f.store, NOW).candidates).toEqual([]);
    expect(hasOpenWork(f.store, f.config, readings, NOW)).toBe(true);
    expect(hasOpenWork(f.store, f.config, readings, NOW + 49 * 3_600_000)).toBe(false);
    q.updatedAt = NOW - 600_000;
    expect(hasOpenWork(f.store, f.config, readings, NOW)).toBe(false);
  });
  it('keeps an open sprint awake while quota admission is exhausted', () => {
    const f = setup(); const q = quota(); q.shortTerm!.usedPercent = 100;
    const current = run(f, { state: 'quota_wait' });
    f.store.put('run', current.id, current);
    f.store.put('sprint', current.sprintId, { id: current.sprintId, provider: 'claude', resetAt: q.weekly.resetsAt, deadline: q.weekly.resetsAt, openedAt: NOW });
    expect(eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, NOW).candidates).toEqual([]);
    expect(hasOpenWork(f.store, f.config, {}, NOW)).toBe(true);
    expect(hasOpenWork(f.store, f.config, {}, q.weekly.resetsAt)).toBe(false);
    f.store.updateRun(current.id, { state: 'running' });
    expect(hasOpenWork(f.store, f.config, {}, q.weekly.resetsAt)).toBe(true);
  });
  it('preserves native roots and checks exact service ownership', () => {
    const f = setup(); const home = join(f.home, 'review-main'); const path = join(f.home, 'service.plist');
    const env = { CODEX_HOME: '/tmp/codex & account', CLAUDE_CONFIG_DIR: '/tmp/claude account', SECRET: 'must-not-copy' };
    writeFileSync(path, servicePlist(home, '/tmp/entry.js', '/usr/bin', env));
    const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));
    expect(parsed.EnvironmentVariables).toEqual({ PATH: '/usr/bin', CODEX_HOME: env.CODEX_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR });
    expect(() => assertServiceHome(path, home)).not.toThrow();
    expect(() => assertServiceHome(path, join(f.home, 'review'))).toThrow(/another Last Call home/);
  });
  it('does not suggest rechecking the backlog when no providers are eligible', async () => {
    const f = setup();
    const status = await statusSnapshot(f.store, f.config, { claude: { quota: quota('claude', NOW + 48 * 3_600_000) } }, NOW);
    expect((status.reasons as string[]).some(reason => reason.includes('skill recheck'))).toBe(false);
  });
  it('explains a failed scheduler tick in the readable status reasons', async () => {
    const f = setup();
    f.store.put('setting', 'schedulerError', 'Configuration file is invalid');
    const status = await statusSnapshot(f.store, f.config, {}, NOW);
    expect(status.reasons).toContain('Scheduler error: Configuration file is invalid');
  });
  it('rejects duplicate schedulers and recovers a dead lease', () => {
    const f = setup(); const lease = acquireLease(f.store); expect(lease.pid).toBe(process.pid);
    const other = new Store(f.home);
    try { expect(() => acquireLease(other)).toThrow(/already running/); } finally { other.close(); }
    f.store.put('setting', 'lease', { pid: 2147483647, identity: 'dead' }); expect(acquireLease(f.store).pid).toBe(process.pid);
  });
  it('holds an ambiguous launch across restarts instead of launching it again', () => {
    const f = setup(); f.store.put('run', 'run-1', run(f, { state: 'launching' }));
    reconcileRuns(f.store, NOW + 60_000);
    const reopened = new Store(f.home);
    try { expect(reopened.held()).toHaveLength(1); expect(reopened.run('run-1').state).toBe('uncertain'); } finally { reopened.close(); }
  });
  it('preserves live worker ownership and its heartbeat', () => {
    const f = setup(); const lease = acquireLease(f.store);
    f.store.put('run', 'run-1', run(f, { state: 'running', workerPid: lease.pid, workerIdentity: lease.identity, heartbeatAt: NOW }));
    reconcileRuns(f.store, NOW + 45_000); expect(f.store.run('run-1').state).toBe('running');
    reconcileRuns(f.store, NOW + 121_000); expect(f.store.run('run-1').state).toBe('uncertain');
  });
  it('only retries explicit quota failures when a native session can be resumed', () => {
    const f = setup(); f.store.put('run', 'run-1', run(f, { state: 'running' }));
    finishRun(f.store, 'run-1', undefined, true, 'Rate limited'); expect(f.store.run('run-1').state).toBe('quota_wait');
    f.store.updateRun('run-1', { sessionId: undefined });
    finishRun(f.store, 'run-1', undefined, true, 'Rate limited'); expect(f.store.run('run-1').state).toBe('failed');
  });
  it('writes launchd arguments as escaped individual values', () => {
    const plist = servicePlist('/tmp/space & name', '/tmp/script with spaces.js', '/a:/b');
    expect(plist).toContain('<string>/tmp/space &amp; name</string>');
    expect(plist).toContain('<string>/tmp/script with spaces.js</string>');
    expect(plist).not.toContain('/bin/sh');
  });
});
