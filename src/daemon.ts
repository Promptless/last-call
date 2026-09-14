import { errorMessage, loadConfig } from './files.js';
import { Store } from './store.js';
import { readQuotas } from './providers.js';
import { admit, closeSprints, eligibility } from './scheduler.js';
import { activityHealth } from './activity.js';
import { launchWorker, reconcileRuns } from './runner.js';
import { acquireLease, KeepAwake, notify, requireMac } from './macos.js';
import { checkSkill } from './skills.js';
import { type Config, type QuotaReading, type Provider, type Run } from './model.js';
import { processIdentity } from './process.js';

export function receiptSummary(runs: Run[]): Record<string, number> {
  return {
    completed: runs.filter(r => r.state === 'completed').length,
    waitingForInput: runs.filter(r => r.state === 'needs_input' || r.state === 'answer_queued').length,
    failures: runs.filter(r => r.state === 'failed' || r.state === 'uncertain').length,
    stillRunning: runs.filter(r => ['running', 'launching', 'quota_wait'].includes(r.state)).length,
    reviewed: runs.filter(r => r.useful !== undefined).length,
    useful: runs.filter(r => r.useful).length,
    reviewMinutes: runs.reduce((sum, r) => sum + (r.reviewMinutes ?? 0), 0),
  };
}

export function statusSnapshot(store: Store, config: Config, readings: Partial<Record<Provider, QuotaReading>>, now = Date.now()): Record<string, unknown> {
  const health = activityHealth(config, store, now);
  const decision = eligibility(config, readings, health, store, now);
  const held = store.held();
  const reasons = [...decision.reasons];
  const schedulerError = store.get<string>('setting', 'schedulerError');
  if (schedulerError) reasons.unshift(`Scheduler error: ${schedulerError}`);
  const lease = store.get<{pid: number; identity: string}>('setting', 'lease');
  const running = !!lease && processIdentity(lease.pid) === lease.identity;
  if (!running) reasons.unshift('Scheduler is not running. Enable it with lastcall service enable.');
  if (held.length >= config.slots) reasons.push(`All ${config.slots} slots are occupied`);
  for (const skill of config.skills.filter(s => s.enabled)) {
    if (held.filter(r => r.skillId === skill.id).length >= skill.maxConcurrent) reasons.push(`${skill.id}: Concurrency limit reached`);
    const last = store.get<number>('launch', skill.id);
    if (last !== undefined && now - last < skill.spacingSeconds * 1000) reasons.push(`${skill.id}: Waiting for launch spacing`);
    if (decision.candidates.filter(c => skill.providers.includes(c.provider)).every(c => store.get<boolean>('empty', `${skill.id}:${c.sprint.id}`))) reasons.push(`${skill.id}: No eligible work/provider; use skill recheck after adding work`);
    const check = checkSkill(skill);
    if (!check.valid) reasons.push(`${skill.id}: ${check.findings.filter(f => f.severity === 'error').map(f => f.message).join('; ')}`);
  }
  return { at: new Date(now).toISOString(), scheduler: { running, pid: running ? lease?.pid : undefined, lastTick: store.get<number>('setting','schedulerTick') }, slots: { total: config.slots, occupied: held.length }, eligibleProviders: decision.candidates.map(c => c.provider), activity: health, reasons, quotas: readings, sprints: store.sprints(), runs: store.runs(), summary: receiptSummary(store.runs()), schedulerError: store.get('setting', 'schedulerError') ?? null };
}

async function sendNotifications(store: Store, config: Config): Promise<void> {
  if (!config.notifications) return;
  const attention = store.held().filter(r => ['needs_input', 'failed', 'uncertain'].includes(r.state) && !store.get<boolean>('notifiedRun', `${r.id}:${r.attempt}:${r.state}`));
  if (attention.length) {
    await notify('Last Call needs attention', `${attention.length} run(s) need input or inspection. Ask your agent to show Last Call runs.`);
    for (const run of attention) store.put('notifiedRun', `${run.id}:${run.attempt}:${run.state}`, true);
  }
  for (const sprint of store.sprints().filter(s => s.closedAt !== undefined && s.notifiedAt === undefined)) {
    const summary = receiptSummary(store.runs().filter(r => r.sprintId === sprint.id));
    await notify('Last Call sprint closed', `${sprint.provider}: ${summary.completed} completed, ${summary.waitingForInput} awaiting input, ${summary.stillRunning} still running.`);
    store.put('sprint', sprint.id, { ...sprint, notifiedAt: Date.now() });
  }
}

export async function daemon(home: string, entry: string, once = false): Promise<void> {
  requireMac();
  const store = new Store(home);
  const lease = acquireLease(store);
  const awake = new KeepAwake();
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => { stopping = true; wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    do {
      let delay = 60_000;
      try {
        const config = loadConfig(home); delay = config.pollSeconds * 1000;
        const readings = await readQuotas(config, home);
        store.put('setting', 'readings', readings);
        reconcileRuns(store);
        closeSprints(store, readings, Date.now());
        const decision = eligibility(config, readings, activityHealth(config, store), store, Date.now());
        const validConfig = { ...config, skills: config.skills.filter(skill => checkSkill(skill).valid) };
        if (!stopping) {
          const run = admit(store, validConfig, decision.candidates, Date.now());
          if (run) launchWorker(home, run, entry);
        }
        const sprintActive = decision.candidates.length > 0 || store.held().some(r => r.state === 'running');
        await awake.update(config.keepAwake, sprintActive);
        await sendNotifications(store, config);
        store.delete('setting', 'schedulerError');
        store.put('setting', 'schedulerTick', Date.now());
      } catch (error) {
        const message = errorMessage(error); store.put('setting', 'schedulerError', message);
        process.stderr.write(`${new Date().toISOString()} ${message}\n`);
        awake.stop();
      }
      if (!once && !stopping) await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); wake = () => { clearTimeout(timer); resolve(); }; });
    } while (!once && !stopping);
  } finally {
    awake.stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    store.transaction(() => { if (store.get<{ pid: number }>('setting', 'lease')?.pid === lease.pid) store.delete('setting', 'lease'); });
    store.close();
  }
}
