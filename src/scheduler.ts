import { randomUUID } from 'node:crypto';
import { type Config, type Health, type ManualSprint, type Provider, type Quota, type QuotaReading, type Run, type Skill, type Sprint } from './model.js';
import { Store } from './store.js';
import { accountsMatch } from './providers.js';

export interface Candidate { provider: Provider; quota: Quota; sprint: Sprint }
export interface Decision { candidates: Candidate[]; reasons: string[] }
// Claude's terminal countdown can round the same reset to adjacent minutes.
export function samePeriod(left: number, right: number): boolean { return Math.abs(left - right) <= 5 * 60_000; }

export function quotaReason(quota: Quota, config: Config, now: number): string | undefined {
  const expected = config.providers[quota.provider]?.account;
  if (!expected || !accountsMatch(expected, quota.account)) return 'Account does not match the configured native account';
  if (now - quota.updatedAt > config.quotaMaxAgeSeconds * 1000 || quota.updatedAt > now + 30_000 || now - quota.fetchedAt > config.quotaMaxAgeSeconds * 1000) return 'Quota snapshot is stale';
  if (quota.weekly.resetsAt <= now) return 'Waiting for a fresh weekly period';
  if (100 - quota.weekly.usedPercent <= config.reservePercent) return 'Weekly reserve reached';
  const windows = [quota.shortTerm, ...quota.extra].filter(w => w !== undefined);
  if (windows.some(w => w.resetsAt <= now)) return 'Waiting for refreshed short-term or model limits';
  if (windows.some(w => w.usedPercent >= 100)) return 'Short-term or model allowance exhausted';
  return undefined;
}

/** Compute eligibility without launching a process or spending quota. */
export function eligibility(config: Config, readings: Partial<Record<Provider, QuotaReading>>, health: Health, store: Store, now: number): Decision {
  const reasons: string[] = [];
  const candidates: Candidate[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    if (!config.providers[provider]) continue;
    const manual = store.get<ManualSprint>('setting', `manual:${provider}`);
    const reading = readings[provider];
    const quota = reading?.quota;
    if (!quota) { reasons.push(`${provider}: ${reading?.error ?? 'Quota unavailable'}`); continue; }
    const reason = quotaReason(quota, config, now);
    if (reason) { reasons.push(`${provider}: ${reason}`); continue; }
    const manualReset = manual?.resets[provider];
    const manualApplies = manual && manual.providers.includes(provider) && manualReset !== undefined && samePeriod(manualReset, quota.weekly.resetsAt);
    if (manualApplies && manual.deadline <= now) { reasons.push(`${provider}: Manual sprint deadline passed`); continue; }
    const deadline = manualApplies ? Math.min(manual.deadline, quota.weekly.resetsAt) : quota.weekly.resetsAt;
    if (!manualApplies && now < deadline - config.runwayHours * 3_600_000) { reasons.push(`${provider}: Outside the ${config.runwayHours}-hour closing window`); continue; }
    const previousPeriod = store.sprints().find(s => s.provider === provider && !s.id.includes(':manual:') && samePeriod(s.resetAt, quota.weekly.resetsAt));
    const id = manualApplies ? `${provider}:manual:${manual.id}` : previousPeriod?.id ?? `${provider}:${quota.weekly.resetsAt}`;
    const existing = store.get<Sprint>('sprint', id);
    if (existing?.closedAt !== undefined) { reasons.push(`${provider}: Sprint closed`); continue; }
    const sprint: Sprint = existing ? { ...existing, deadline: Math.min(existing.deadline, deadline) } : { id, provider, resetAt: quota.weekly.resetsAt, deadline, openedAt: now };
    candidates.push({ provider, quota, sprint });
  }
  if (!health.ready) return { candidates: [], reasons: [...reasons, health.reason ?? 'Activity detection is not ready'] };
  const activity = store.activities().filter(a => !a.owned);
  if (activity.some(a => a.busy)) return { candidates: [], reasons: [...reasons, 'Foreground agent is active'] };
  const lastAt = Math.max(0, ...activity.map(a => a.lastAt));
  if (lastAt && now - lastAt < config.idleSeconds * 1000) return { candidates: [], reasons: [...reasons, 'Waiting for the foreground idle delay'] };
  if (!config.skills.some(s => s.enabled)) reasons.push('No enabled skills');
  return { candidates, reasons };
}

export function selectProvider(skill: Skill, candidates: Candidate[]): Candidate | undefined {
  return candidates.filter(c => skill.providers.includes(c.provider)).sort((a, b) =>
    a.quota.weekly.resetsAt - b.quota.weekly.resetsAt ||
    a.quota.weekly.usedPercent - b.quota.weekly.usedPercent ||
    skill.providers.indexOf(a.provider) - skill.providers.indexOf(b.provider))[0];
}

/** Admit at most one invocation per poll, making spacing and quota rechecks effective. */
export function admit(store: Store, config: Config, candidates: Candidate[], now: number): Run | undefined {
  return store.transaction(() => {
    const activity = store.activities().filter(a => !a.owned);
    if (activity.some(a => a.busy || now - a.lastAt < config.idleSeconds * 1000)) return undefined;
    const eligible = candidates.filter(c => c.sprint.deadline > now && !quotaReason(c.quota, config, now) && store.get<Sprint>('sprint', c.sprint.id)?.closedAt === undefined);
    const held = store.held();
    for (const run of held) {
      if (!['answer_queued', 'quota_wait'].includes(run.state) || !run.sessionId) continue;
      if (run.retryAfter !== undefined && now < run.retryAfter) continue;
      const candidate = eligible.find(c => c.provider === run.provider && accountsMatch(run.account, c.quota.account));
      if (!candidate || !config.skills.some(s => s.id === run.skillId && s.enabled)) continue;
      const resumed: Run = { ...run, state: 'launching', attempt: run.attempt + 1, updatedAt: now, retryAfter: undefined, workerPid: undefined, workerIdentity: undefined, agentPid: undefined, agentIdentity: undefined, heartbeatAt: undefined };
      store.put('run', run.id, resumed); return resumed;
    }
    if (held.length >= config.slots) return undefined;
    const skills = config.skills.filter(s => s.enabled);
    const last = store.get<string>('setting', 'lastSkill');
    const start = (skills.findIndex(s => s.id === last) + 1) % Math.max(skills.length, 1);
    for (let i = 0; i < skills.length; i++) {
      const skill = skills[(start + i) % skills.length]!;
      if (held.filter(r => r.skillId === skill.id).length >= skill.maxConcurrent) continue;
      const lastLaunch = store.get<number>('launch', skill.id);
      if (lastLaunch !== undefined && now - lastLaunch < skill.spacingSeconds * 1000) continue;
      const available = eligible.filter(c => !store.get<boolean>('empty', `${skill.id}:${c.sprint.id}`));
      const selected = selectProvider(skill, available);
      if (!selected) continue;
      const run: Run = { id: randomUUID(), skillId: skill.id, skill, provider: selected.provider, account: selected.quota.account, sprintId: selected.sprint.id, state: 'launching', createdAt: now, updatedAt: now, attempt: 1 };
      store.put('sprint', selected.sprint.id, selected.sprint);
      store.put('run', run.id, run);
      store.put('launch', skill.id, now);
      store.put('setting', 'lastSkill', skill.id);
      return run;
    }
    return undefined;
  });
}

export function closeSprints(store: Store, readings: Partial<Record<Provider, QuotaReading>>, now: number): Sprint[] {
  const closed: Sprint[] = [];
  for (const sprint of store.sprints()) {
    if (sprint.closedAt !== undefined) continue;
    const quota = readings[sprint.provider]?.quota;
    if (now >= sprint.deadline || (quota && quota.updatedAt <= now + 30_000 && now - quota.updatedAt < 120_000 && !samePeriod(quota.weekly.resetsAt, sprint.resetAt))) {
      const result = { ...sprint, closedAt: now };
      store.put('sprint', sprint.id, result); closed.push(result);
    }
  }
  return closed;
}
