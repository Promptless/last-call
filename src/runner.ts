import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { OutcomeSchema, type Outcome, type Provider, type Run } from './model.js';
import { atomicJson, errorMessage, loadConfig } from './files.js';
import { findBinary, processIdentity, subscriptionEnv } from './process.js';
import { Store } from './store.js';
import { nativeAccount } from './providers.js';

export const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'no_work', 'needs_input', 'failed'] },
    summary: { type: 'string' }, question: { type: ['string', 'null'] },
    workItem: { type: ['string', 'null'] }, artifacts: { type: 'array', items: { type: 'string' } },
  }, required: ['status', 'summary', 'question', 'workItem', 'artifacts'],
};

export function invocation(run: Run): string {
  if (run.sessionId) return run.answer ? `The user supplied this answer to your outstanding question:\n${run.answer}\nContinue the same work item, following its instructions and permissions. Return the required result object.` : 'Continue the same work item after the quota interruption. Check prior progress before repeating any external action. Return the required result object.';
  return `Read and execute the skill at ${JSON.stringify(run.skill.path)}.\n${run.skill.prompt}\n\nLast Call invocation: handle one work item, then stop. The skill owns selection, claiming and external work state. Do not create a scheduler or consume quota for its own sake. Follow the skill and working-directory instructions, including approval gates. If no work remains, report no_work. If you need a human answer or permission, preserve progress, record the item as awaiting input when the skill supports it, and report needs_input with the question. Do not wait for interactive input. Report completed only for the requested work actually completed; include artifact links and the work-item reference. Return the required result object.`;
}

export function runnerArgs(run: Run, schemaPath: string): string[] {
  if (run.provider === 'claude') {
    const permission = run.skill.claude!;
    // https://code.claude.com/docs/en/headless — keep normal subscription auth; --bare is API-only.
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--json-schema', JSON.stringify(RESULT_SCHEMA), '--permission-mode', permission.permissionMode, '--permission-prompts', 'none', '--settings', JSON.stringify({ forceLoginMethod: 'claudeai' })];
    if (permission.allowedTools.length) args.push('--allowedTools', ...permission.allowedTools);
    if (permission.model) args.push('--model', permission.model);
    if (run.sessionId) args.push('--resume', run.sessionId);
    else args.push('--session-id', run.id);
    return args;
  }
  const permission = run.skill.codex!;
  // Configuration flags precede the resume subcommand, preserving the same permission profile.
  // https://learn.chatgpt.com/docs/non-interactive-mode
  const args = ['exec', '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', `sandbox_mode=${JSON.stringify(permission.sandbox)}`, '-c', `sandbox_workspace_write.network_access=${permission.networkAccess}`];
  if (permission.profile) args.push('--profile', permission.profile);
  if (run.sessionId) args.push('resume', run.sessionId);
  args.push('--json', '--output-schema', schemaPath, '--skip-git-repo-check');
  if (permission.model) args.push('--model', permission.model);
  args.push('-');
  return args;
}

const EventSchema = z.object({ type: z.string() }).passthrough();
export interface ParsedEvent { sessionId?: string; outcome?: Outcome; quotaLimited?: boolean; failure?: string }
export function parseEvent(provider: Provider, value: unknown): ParsedEvent {
  const event = EventSchema.parse(value);
  const result: ParsedEvent = {};
  if (provider === 'claude') {
    if (typeof event.session_id === 'string') result.sessionId = event.session_id;
    if (event.type === 'result') {
      if (event.is_error === true || event.subtype !== 'success') result.failure = `Claude result: ${String(event.subtype)}`;
      else result.outcome = OutcomeSchema.parse(event.structured_output ?? (typeof event.result === 'string' ? JSON.parse(event.result) : undefined));
    }
    const error = z.object({ type: z.string() }).safeParse(event.error);
    if (error.success && error.data.type === 'rate_limit_error') result.quotaLimited = true;
    const limit = z.object({ status: z.string() }).safeParse(event.rate_limit_info);
    if (event.type === 'rate_limit_event' && limit.success && limit.data.status === 'rejected') result.quotaLimited = true;
  } else {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') result.sessionId = event.thread_id;
    if (event.type === 'item.completed') {
      const item = z.object({ type: z.string(), text: z.string().optional() }).passthrough().parse(event.item);
      if (item.type === 'agent_message' && item.text) {
        const decoded = tryOutcome(item.text);
        if (decoded) result.outcome = decoded;
      }
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      const error = z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().safeParse(event.error);
      if (error.success && ['usage_limit_reached', 'rate_limit_exceeded'].includes(error.data.code ?? '')) result.quotaLimited = true;
      result.failure = error.success ? error.data.message ?? 'Codex turn failed' : 'Codex turn failed';
    }
  }
  return result;
}
function tryOutcome(text: string): Outcome | undefined {
  try { const parsed = OutcomeSchema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : undefined; }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

export function finishRun(store: Store, id: string, outcome: Outcome | undefined, quotaLimited: boolean, failure: string | undefined): void {
  const run = store.run(id);
  if (outcome && !failure) {
    store.updateRun(id, { state: outcome.status, outcome, error: undefined, answer: undefined, agentPid: undefined, workerPid: undefined });
    if (outcome.status === 'no_work') store.put('empty', `${run.skillId}:${run.sprintId}`, true);
  } else {
    store.updateRun(id, { state: quotaLimited && run.sessionId ? 'quota_wait' : 'failed', retryAfter: quotaLimited ? Date.now() + 5 * 60_000 : undefined, error: failure ?? 'Native session ended without a valid outcome. Inspect it before releasing or resuming this slot.', agentPid: undefined, workerPid: undefined });
  }
}

/** Detached workers survive scheduler restarts and write their own durable receipts. */
export async function runWorker(home: string, id: string): Promise<void> {
  const store = new Store(home);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const config = loadConfig(home);
    const run = store.transaction(() => {
      const current = store.run(id);
      if (current.state !== 'launching') throw new Error('Run already has an owner or is not launchable');
      const updated: Run = { ...current, state: 'running', workerPid: process.pid, workerIdentity: processIdentity(process.pid), heartbeatAt: Date.now(), updatedAt: Date.now() };
      store.put('run', id, updated); return updated;
    });
    heartbeat = setInterval(() => store.updateRun(id, { heartbeatAt: Date.now() }), 5_000);
    const selected = config.providers[run.provider]!;
    const binary = findBinary(selected.binary);
    const account = await nativeAccount(run.provider, binary, home);
    if (account.email.toLowerCase() !== selected.account.email.toLowerCase() || (selected.account.organization && account.organization !== selected.account.organization)) throw new Error('Native account changed before execution');
    const directory = join(home, 'runs', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const schema = join(directory, 'result.schema.json'); atomicJson(schema, RESULT_SCHEMA);
    const errorFd = openSync(join(directory, `attempt-${run.attempt}.stderr.log`), 'a', 0o600);
    const child = spawn(binary, runnerArgs(run, schema), { cwd: run.skill.cwd, env: subscriptionEnv(home, run.id), stdio: ['pipe', 'pipe', errorFd] });
    closeSync(errorFd);
    if (!child.stdin || !child.stdout) throw new Error('Native runner pipes were not created');
    if (child.pid) store.updateRun(id, { agentPid: child.pid, agentIdentity: processIdentity(child.pid) });
    let outcome: Outcome | undefined;
    let quotaLimited = false;
    let failure: string | undefined;
    child.stdin.on('error', error => { failure = `Could not deliver input to native runner: ${errorMessage(error)}`; });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = parseEvent(run.provider, JSON.parse(line));
        if (event.sessionId) {
          store.updateRun(id, { sessionId: event.sessionId });
          store.put('owned', `${run.provider}:${event.sessionId}`, true);
        }
        if (event.outcome) outcome = event.outcome;
        if (event.quotaLimited) quotaLimited = true;
        if (event.failure) failure = event.failure;
      } catch (error) { failure = `Invalid native event: ${errorMessage(error)}`; }
    });
    const completion = new Promise<void>(resolve => {
      child.once('error', error => { failure = errorMessage(error); });
      child.once('close', code => { if (code !== 0) failure ??= `Native runner exited with code ${code}`; resolve(); });
    });
    child.stdin.end(invocation(run));
    await completion;
    finishRun(store, id, outcome, quotaLimited, failure);
  } catch (error) {
    const run = store.get<Run>('run', id);
    if (run && ['running', 'launching'].includes(run.state) && (!run.workerPid || run.workerPid === process.pid)) store.updateRun(id, { state: 'failed', error: errorMessage(error), workerPid: undefined });
    else throw error;
  } finally { if (heartbeat) clearInterval(heartbeat); store.close(); }
}

export function launchWorker(home: string, run: Run, entry: string): void {
  const directory = join(home, 'runs', run.id); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, 'worker.log'), 'a', 0o600);
  const child = spawn(process.execPath, [entry, '--home', home, '_worker', run.id], { detached: true, stdio: ['ignore', fd, fd], env: subscriptionEnv(home, run.id) });
  closeSync(fd);
  child.on('error', error => { const store = new Store(home); store.updateRun(run.id, { state: 'failed', error: errorMessage(error) }); store.close(); });
  child.unref();
}

export function reconcileRuns(store: Store, now = Date.now()): void {
  for (const run of store.held()) {
    if (!['running', 'launching'].includes(run.state)) continue;
    if (now - (run.heartbeatAt ?? run.updatedAt) < 30_000) continue;
    const identity = run.workerPid ? processIdentity(run.workerPid) : undefined;
    if (!identity || identity !== run.workerIdentity || now - (run.heartbeatAt ?? 0) > 120_000) store.updateRun(run.id, { state: 'uncertain', error: 'Runner ownership or heartbeat could not be confirmed. The slot remains held; inspect the native session.' }, now);
  }
}
