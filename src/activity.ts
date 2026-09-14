import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { atomicJson, errorMessage, readJson, shellQuote } from './files.js';
import { type Activity, type Config, type Health, type Provider } from './model.js';
import { processIdentity } from './process.js';
import { Store } from './store.js';

const RecordSchema = z.record(z.string(), z.unknown());
export interface HookInstallation { installedAt: number; providers: Partial<Record<Provider, { path: string; command: string; events: string[] }>> }
const HookInputSchema = z.object({ session_id: z.string(), hook_event_name: z.string(), agent_id: z.string().optional() }).passthrough();

/** Remove only handlers owned by this installation; retain unrelated settings and matchers. */
export function editHooks(input: unknown, oldCommand: string | undefined, command: string | undefined, events: string[]): Record<string, unknown> {
  const document = RecordSchema.parse(input);
  const hooks = document.hooks === undefined ? {} : RecordSchema.parse(document.hooks);
  const updated: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const entries = z.array(RecordSchema).parse(groups);
    updated[event] = entries.flatMap(group => {
      const handlers = z.array(RecordSchema).parse(group.hooks);
      const remaining = oldCommand ? handlers.filter(handler => handler.command !== oldCommand) : handlers;
      if (!remaining.length && handlers.length) return [];
      return [{ ...group, hooks: remaining }];
    });
    if (Array.isArray(updated[event]) && updated[event].length === 0) delete updated[event];
  }
  if (command) for (const event of events) {
    const current = updated[event] === undefined ? [] : z.array(RecordSchema).parse(updated[event]);
    updated[event] = [...current, { hooks: [{ type: 'command', command, timeout: 3 }] }];
  }
  const result = { ...document, hooks: updated };
  if (!Object.keys(updated).length) delete (result as Record<string, unknown>).hooks;
  return result;
}

export function installHooks(home: string, entry: string, providers: Provider[], roots = { claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), codex: process.env.CODEX_HOME ?? join(homedir(), '.codex') }): HookInstallation {
  const store = new Store(home);
  try {
    const previous = store.get<HookInstallation>('setting', 'hooks');
    const installation: HookInstallation = previous ?? { installedAt: Date.now(), providers: {} };
    installation.installedAt = Date.now();
    for (const provider of providers) {
      const path = join(roots[provider], provider === 'claude' ? 'settings.json' : 'hooks.json');
      const document = existsSync(path) ? readJson(path) : {};
      const command = `${shellQuote(process.execPath)} ${shellQuote(entry)} --home ${shellQuote(home)} _activity ${provider}`;
      const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop', ...(provider === 'codex' ? ['Interrupt'] : ['StopFailure'])];
      atomicJson(path, editHooks(document, previous?.providers[provider]?.command, command, events));
      installation.providers[provider] = { path, command, events };
      store.delete('hookSeen', provider);
    }
    store.put('setting', 'hooks', installation);
    return installation;
  } finally { store.close(); }
}

export function uninstallHooks(home: string): void {
  const store = new Store(home);
  try {
    const installation = store.get<HookInstallation>('setting', 'hooks');
    for (const provider of ['claude', 'codex'] as const) {
      const spec = installation?.providers[provider];
      if (spec && existsSync(spec.path)) atomicJson(spec.path, editHooks(readJson(spec.path), spec.command, undefined, []));
    }
    store.delete('setting', 'hooks');
  } finally { store.close(); }
}

function nativeAncestor(): { pid?: number; processIdentity?: string } {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const line = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) break;
    if (/(?:^|\/)(?:codex|claude)(?:\s|$)/.test(match[2]!)) return { pid, processIdentity: processIdentity(pid) };
    pid = Number(match[1]);
  }
  return {};
}

/** Persist lifecycle metadata only; discard prompt, tool arguments, and transcript content. */
export function recordActivity(store: Store, provider: Provider, input: unknown, ownedEnvironment: boolean, now = Date.now(), ancestor: { pid?: number; processIdentity?: string } = {}): void {
  const event = HookInputSchema.parse(input);
  const key = `${provider}:${event.session_id}`;
  const previous = store.get<Activity>('activity', key);
  const manualTakeover = event.hook_event_name === 'UserPromptSubmit' && !ownedEnvironment &&
    store.runs().some(run => run.provider === provider && run.sessionId === event.session_id && !['launching', 'running'].includes(run.state));
  if (manualTakeover) store.delete('owned', key);
  const owned = !manualTakeover && (ownedEnvironment || store.get<boolean>('owned', key) === true || previous?.owned === true);
  if (owned) store.put('owned', key, true);
  if (event.hook_event_name === 'SubagentStart' && event.agent_id) {
    const childKey = `${provider}:${event.agent_id}`;
    if (owned) store.put('owned', childKey, true);
    store.put('activity', childKey, { provider, sessionId: event.agent_id, owned, busy: true, lastAt: now, ...ancestor });
  }
  if (event.hook_event_name === 'SubagentStop' && event.agent_id) {
    const childKey = `${provider}:${event.agent_id}`;
    const child = store.get<Activity>('activity', childKey);
    if (child) store.put('activity', childKey, { ...child, busy: false, lastAt: now });
  }
  const start = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event.hook_event_name);
  const stop = ['Stop', 'StopFailure', 'SessionEnd', 'Interrupt'].includes(event.hook_event_name);
  store.put('activity', key, { provider, sessionId: event.session_id, owned, busy: start || (!stop && (previous?.busy ?? false)), lastAt: now, ...ancestor });
  store.put('hookSeen', provider, now);
}

export function ingestHook(home: string, provider: Provider, input: unknown): void {
  const store = new Store(home);
  try { recordActivity(store, provider, input, !!process.env.LASTCALL_OWNED, Date.now(), nativeAncestor()); }
  finally { store.close(); }
}

export function activityHealth(config: Config, store: Store, now = Date.now()): Health {
  const installation = store.get<HookInstallation>('setting', 'hooks');
  if (!installation) return { ready: false, reason: 'Activity hooks are not installed. Run lastcall hooks install.' };
  for (const provider of ['claude', 'codex'] as const) {
    if (!config.providers[provider]) continue;
    const spec = installation.providers[provider];
    if (!spec) return { ready: false, reason: `${provider}: Activity hooks are missing` };
    try {
      const document = RecordSchema.parse(JSON.parse(readFileSync(spec.path, 'utf8')));
      // https://code.claude.com/docs/en/hooks#disable-or-remove-hooks
      if (provider === 'claude' && document.disableAllHooks === true) return { ready: false, reason: 'claude: Activity hooks are disabled by disableAllHooks' };
      const hooks = RecordSchema.parse(document.hooks);
      for (const event of spec.events) {
        const groups = z.array(RecordSchema).parse(hooks[event]);
        if (!groups.some(group => group.matcher === undefined && z.array(RecordSchema).parse(group.hooks).some(handler => handler.type === 'command' && handler.command === spec.command && handler.if === undefined && handler.async !== true))) return { ready: false, reason: `${provider}: Activity hooks were changed or removed` };
      }
    } catch (error) { return { ready: false, reason: `${provider}: Cannot verify hooks: ${errorMessage(error)}` }; }
    const seen = store.get<number>('hookSeen', provider);
    if (!seen || seen < installation.installedAt) return { ready: false, reason: `${provider}: Open a new native session and approve its hooks if prompted; no lifecycle event has been observed yet` };
  }
  for (const activity of store.activities()) {
    if (activity.owned || !activity.busy || !activity.pid) continue;
    const identity = processIdentity(activity.pid);
    if (!identity || identity !== activity.processIdentity) store.put('activity', `${activity.provider}:${activity.sessionId}`, { ...activity, busy: false, lastAt: now });
  }
  return { ready: true };
}
