import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { activityHealth, editHooks, installHooks, recordActivity, uninstallHooks, codexHookReason } from '../src/activity.js';
import { atomicJson } from '../src/files.js';
import { fixture, NOW, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
describe('activity hooks', () => {
  it('keeps background child tool activity separate after the parent stops', () => {
    const f = setup();
    for (const input of [
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'SubagentStart', agent_id: 'child' },
      { hook_event_name: 'Stop' },
      { hook_event_name: 'PostToolUse', agent_id: 'child' },
    ]) recordActivity(f.store, 'claude', { session_id: 'parent', ...input }, false, NOW);
    expect(f.store.activities().find(a => a.sessionId === 'parent')!.busy).toBe(false);
    expect(f.store.activities().find(a => a.sessionId === 'child')!.busy).toBe(true);
    recordActivity(f.store, 'claude', { session_id: 'parent', hook_event_name: 'SubagentStop', agent_id: 'child' }, false, NOW + 1);
    expect(f.store.activities().every(a => !a.busy)).toBe(true);
  });
  it('requires effective Codex enablement and trusted, enabled hooks in every checked directory', () => {
    const spec = { command: 'lastcall-owned', path: '/tmp/codex/hooks.json', events: ['UserPromptSubmit', 'Stop'], cwds: ['/tmp/work'] };
    const features = { data: [{ name: 'hooks', enabled: true }], nextCursor: null };
    const hooks = { data: [{ cwd: '/tmp/work', errors: [], hooks: ['userPromptSubmit', 'stop'].map(eventName => ({ eventName, sourcePath: spec.path, handlerType: 'command', command: spec.command, matcher: null, async: false, enabled: true, trustStatus: 'trusted' })) }] };
    expect(codexHookReason(features, hooks, spec)).toBeUndefined();
    expect(codexHookReason({ ...features, data: [{ name: 'hooks', enabled: false }] }, hooks, spec)).toMatch(/disabled/);
    for (const trustStatus of ['untrusted', 'modified']) {
      const changed = structuredClone(hooks); changed.data[0]!.hooks[0]!.trustStatus = trustStatus;
      expect(codexHookReason(features, changed, spec)).toMatch(/untrusted/);
    }
    const disabled = structuredClone(hooks); disabled.data[0]!.hooks[0]!.enabled = false;
    expect(codexHookReason(features, disabled, spec)).toMatch(/disabled/);
    expect(codexHookReason(features, hooks, { ...spec, cwds: ['/tmp/another'] })).toMatch(/Cannot resolve/);
  });
  it('preserves unrelated matchers, hooks and settings during installation and removal', () => {
    const document = { theme: 'dark', hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'existing-command', timeout: 10 }] }] } };
    const installed = editHooks(document, undefined, 'lastcall-owned', ['Stop', 'UserPromptSubmit']);
    const changed = { ...installed, theme: 'light' };
    const removed = editHooks(changed, 'lastcall-owned', undefined, []);
    expect(removed).toEqual({ ...document, theme: 'light' });
    expect(editHooks(installed, 'lastcall-owned', 'lastcall-owned', ['Stop', 'UserPromptSubmit'])).toEqual(installed);
    expect(() => editHooks({ hooks: { Stop: 'malformed' } }, undefined, 'new', ['Stop'])).toThrow();
  });
  it('requires observed native events and notices modified hooks', async () => {
    const f = setup(); f.config.providers.codex = undefined; const roots = { claude: join(f.home, 'claude'), codex: join(f.home, 'codex') };
    const install = installHooks(f.home, '/tmp/lastcall/dist/cli.js', ['claude', 'codex'], roots);
    expect((await activityHealth(f.config, f.store)).ready).toBe(false);
    for (const provider of ['claude', 'codex'] as const) recordActivity(f.store, provider, { session_id: 'test', hook_event_name: 'SessionStart' }, false, install.installedAt + 1);
    expect((await activityHealth(f.config, f.store)).ready).toBe(true);
    atomicJson(install.providers.claude!.path, {});
    expect((await activityHealth(f.config, f.store)).ready).toBe(false);
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
  it('pauses when installed hooks are disabled or narrowed after a real event', async () => {
    const f = setup(); f.config.providers.codex = undefined; const roots = { claude: join(f.home, 'claude'), codex: join(f.home, 'codex') };
    const install = installHooks(f.home, '/tmp/lastcall/dist/cli.js', ['claude', 'codex'], roots);
    for (const provider of ['claude', 'codex'] as const) recordActivity(f.store, provider, { session_id: 'test', hook_event_name: 'SessionStart' }, false, install.installedAt + 1);
    const path = install.providers.claude!.path;
    const document = JSON.parse(readFileSync(path, 'utf8'));
    atomicJson(path, { ...document, disableAllHooks: true });
    expect((await activityHealth(f.config, f.store)).ready).toBe(false);
    atomicJson(path, document);
    expect((await activityHealth(f.config, f.store)).ready).toBe(true);
    document.hooks.PreToolUse[0].matcher = 'Bash';
    atomicJson(path, document);
    expect((await activityHealth(f.config, f.store)).ready).toBe(false);
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
