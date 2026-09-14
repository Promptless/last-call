import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activityHealth, editHooks, installHooks, recordActivity, uninstallHooks } from '../src/activity.js';
import { atomicJson } from '../src/files.js';
import { fixture, NOW, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
describe('activity hooks', () => {
  it('preserves unrelated matchers, hooks and settings during installation and removal', () => {
    const document = { theme: 'dark', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'existing-command', timeout: 10 }] }] } };
    const installed = editHooks(document, undefined, 'lastcall-owned', ['Stop', 'UserPromptSubmit']);
    const changed = { ...installed, theme: 'light' };
    const removed = editHooks(changed, 'lastcall-owned', undefined, []);
    expect(removed).toEqual({ ...document, theme: 'light' });
    expect(editHooks(installed, 'lastcall-owned', 'lastcall-owned', ['Stop', 'UserPromptSubmit'])).toEqual(installed);
    expect(() => editHooks({ hooks: { Stop: 'malformed' } }, undefined, 'new', ['Stop'])).toThrow();
  });
  it('requires observed native events and notices modified hooks', () => {
    const f = setup(); const roots = { claude: join(f.home, 'claude'), codex: join(f.home, 'codex') };
    const install = installHooks(f.home, '/tmp/lastcall/dist/cli.js', ['claude', 'codex'], roots);
    expect(activityHealth(f.config, f.store).ready).toBe(false);
    for (const provider of ['claude', 'codex'] as const) recordActivity(f.store, provider, { session_id: 'test', hook_event_name: 'SessionStart' }, false, install.installedAt + 1);
    expect(activityHealth(f.config, f.store).ready).toBe(true);
    atomicJson(install.providers.claude!.path, {});
    expect(activityHealth(f.config, f.store).ready).toBe(false);
    uninstallHooks(f.home);
    expect(JSON.parse(readFileSync(join(roots.codex, 'hooks.json'), 'utf8'))).toEqual({});
  });
  it('excludes owned sessions and descendants and discards prompt and tool content', () => {
    const f = setup();
    recordActivity(f.store, 'claude', { session_id: 'owned', hook_event_name: 'UserPromptSubmit', prompt: 'private prompt' }, true, NOW);
    recordActivity(f.store, 'claude', { session_id: 'owned', hook_event_name: 'SubagentStart', agent_id: 'child' }, false, NOW + 1);
    recordActivity(f.store, 'claude', { session_id: 'child', hook_event_name: 'PreToolUse', tool_input: { token: 'private' } }, false, NOW + 2);
    expect(f.store.activities().every(a => a.owned)).toBe(true);
    expect(f.store.activities().map(a => Object.keys(a))).toEqual([['provider', 'sessionId', 'owned', 'busy', 'lastAt'], ['provider', 'sessionId', 'owned', 'busy', 'lastAt']]);
    recordActivity(f.store, 'claude', { session_id: 'owned', hook_event_name: 'SubagentStop', agent_id: 'child' }, false, NOW + 3);
    expect(f.store.activities().find(a => a.sessionId === 'child')!.busy).toBe(false);
  });
  it('pauses when installed hooks are disabled or narrowed after a real event', () => {
    const f = setup(); const roots = { claude: join(f.home, 'claude'), codex: join(f.home, 'codex') };
    const install = installHooks(f.home, '/tmp/lastcall/dist/cli.js', ['claude', 'codex'], roots);
    for (const provider of ['claude', 'codex'] as const) recordActivity(f.store, provider, { session_id: 'test', hook_event_name: 'SessionStart' }, false, install.installedAt + 1);
    const path = install.providers.claude!.path;
    const document = JSON.parse(readFileSync(path, 'utf8'));
    atomicJson(path, { ...document, disableAllHooks: true });
    expect(activityHealth(f.config, f.store).ready).toBe(false);
    atomicJson(path, document);
    expect(activityHealth(f.config, f.store).ready).toBe(true);
    document.hooks.PreToolUse[0].matcher = 'Bash';
    atomicJson(path, document);
    expect(activityHealth(f.config, f.store).ready).toBe(false);
  });
  it('keeps foreground turns busy until stop, failure or interrupt', () => {
    const f = setup();
    recordActivity(f.store, 'codex', { session_id: 'foreground', hook_event_name: 'UserPromptSubmit' }, false, NOW);
    recordActivity(f.store, 'codex', { session_id: 'foreground', hook_event_name: 'PostToolUse' }, false, NOW + 1);
    expect(f.store.activities()[0]!.busy).toBe(true);
    recordActivity(f.store, 'codex', { session_id: 'foreground', hook_event_name: 'Interrupt' }, false, NOW + 2);
    expect(f.store.activities()[0]!.busy).toBe(false);
  });
  it('treats a human resuming a handed-off native session as foreground activity', () => {
    const f = setup(); f.store.put('run', 'run-1', run(f));
    recordActivity(f.store, 'claude', { session_id: 'session-1', hook_event_name: 'Stop' }, true, NOW);
    recordActivity(f.store, 'claude', { session_id: 'session-1', hook_event_name: 'UserPromptSubmit' }, false, NOW + 1);
    expect(f.store.activities()[0]!.owned).toBe(false); expect(f.store.activities()[0]!.busy).toBe(true);
  });
});
