import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import { acquireLease, servicePlist } from '../src/macos.js';
import { reconcileRuns, finishRun } from '../src/runner.js';
import { statusSnapshot } from '../src/daemon.js';
import { fixture, NOW, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
describe('durable recovery', () => {
  it('explains a failed scheduler tick in the readable status reasons', () => {
    const f = setup();
    f.store.put('setting', 'schedulerError', 'Configuration file is invalid');
    const status = statusSnapshot(f.store, f.config, {}, NOW);
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
