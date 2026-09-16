import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { admit, closeSprints, eligibility, quotaReason, selectProvider } from '../src/scheduler.js';
import { finishRun } from '../src/runner.js';
import { fixture, NOW, quota, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });

describe('closing windows and quota gates', () => {
  it('opens at exactly 12h, independently of a 5h reset', () => {
    const f = setup(); const q = quota('claude', NOW + 12 * 3_600_000);
    expect(eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, NOW - 1).candidates).toHaveLength(0);
    expect(eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, NOW).candidates).toHaveLength(1);
    q.weekly.resetsAt = NOW + 24 * 3_600_000; q.shortTerm!.resetsAt = NOW + 1;
    expect(eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, NOW).candidates).toHaveLength(0);
  });
  it('enforces reserve, stale, account, short-term and unknown reset gates', () => {
    const f = setup(); const q = quota();
    q.weekly.usedPercent = 95; expect(quotaReason(q, f.config, NOW)).toMatch(/reserve/);
    q.weekly.usedPercent = 94.9; expect(quotaReason(q, f.config, NOW)).toBeUndefined();
    q.shortTerm!.usedPercent = 100; expect(quotaReason(q, f.config, NOW)).toMatch(/exhausted/);
    q.shortTerm!.usedPercent = 0; q.updatedAt = NOW - 121_000; expect(quotaReason(q, f.config, NOW)).toMatch(/stale/);
    q.updatedAt = NOW; q.account.email = 'other@example.com'; expect(quotaReason(q, f.config, NOW)).toMatch(/Account/);
    q.account.email = 'person@example.com'; q.shortTerm!.resetsAt = NOW - 1; expect(quotaReason(q, f.config, NOW)).toMatch(/refreshed/);
    q.weekly.resetsAt = NOW; expect(quotaReason(q, f.config, NOW)).toMatch(/fresh weekly/);
  });
  it('opens a manual sprint outside the normal window and closes permanently at its deadline', () => {
    const f = setup(); const q = quota('claude', NOW + 20 * 3_600_000);
    f.store.put('setting', 'manual:claude', { id: 'manual', deadline: NOW + 1000, providers: ['claude'], resets: { claude: q.weekly.resetsAt } });
    const decision = eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, NOW);
    expect(decision.candidates).toHaveLength(1);
    const admitted = admit(f.store, f.config, decision.candidates, NOW)!;
    expect(admitted.sprintId).toBe('claude:manual:manual');
    closeSprints(f.store, { claude: { quota: q } }, NOW + 1001);
    expect(f.store.run(admitted.id).state).toBe('launching');
    const later = NOW + 10 * 3_600_000;
    q.updatedAt = later; q.fetchedAt = later; q.shortTerm!.resetsAt = later + 3_600_000;
    expect(eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, later).candidates).toHaveLength(0);
  });
  it('preserves another provider’s manual cutoff when a new sprint selects one provider', () => {
    const f = setup(); const claude = quota(); const codex = quota('codex');
    const original = { id: 'original', deadline: NOW - 1000, providers: ['claude', 'codex'], resets: { claude: claude.weekly.resetsAt, codex: codex.weekly.resetsAt } };
    f.store.put('setting', 'manual:claude', original);
    f.store.put('setting', 'manual:codex', { id: 'replacement', deadline: NOW + 1000, providers: ['codex'], resets: { codex: codex.weekly.resetsAt } });

    const decision = eligibility(f.config, { claude: { quota: claude }, codex: { quota: codex } }, { ready: true }, f.store, NOW);

    expect(decision.candidates.map(candidate => candidate.provider)).toEqual(['codex']);
    expect(decision.reasons).toContain('claude: Manual sprint deadline passed');
    expect(admit(f.store, f.config, decision.candidates, NOW)?.provider).toBe('codex');
  });
  it('closes at reset without changing an active run', () => {
    const f = setup(); const q = quota();
    const decision = eligibility(f.config, { claude: { quota: q } }, { ready: true }, f.store, NOW);
    const admitted = admit(f.store, f.config, decision.candidates, NOW)!;
    f.store.updateRun(admitted.id, { state: 'running' }, NOW);
    const fresh = quota('claude', q.weekly.resetsAt + 7 * 86400_000);
    expect(closeSprints(f.store, { claude: { quota: fresh } }, NOW)).toHaveLength(1);
    expect(f.store.run(admitted.id).state).toBe('running');
  });
  it('does not reopen no-work skills or close sprints when a CLI reset rounds by a minute', () => {
    const f = setup(); const q = quota();
    const first = eligibility(f.config, {claude:{quota:q}}, {ready:true}, f.store, NOW);
    const admitted = admit(f.store,f.config,first.candidates,NOW)!;
    finishRun(f.store,admitted.id,{status:'no_work',summary:'Empty',question:null,workItem:null,artifacts:[]},false,undefined);
    q.weekly.resetsAt += 60_000;
    expect(closeSprints(f.store,{claude:{quota:q}},NOW)).toHaveLength(0);
    const next = eligibility(f.config,{claude:{quota:q}},{ready:true},f.store,NOW+60_000);
    expect(next.candidates[0]!.sprint.id).toBe(admitted.sprintId);
    expect(admit(f.store,f.config,next.candidates,NOW+60_000)).toBeUndefined();
  });
  it('rechecks deadline and foreground state at the admission transaction', () => {
    const f = setup(); const q = quota('claude',NOW+1000);
    const candidates = eligibility(f.config,{claude:{quota:q}},{ready:true},f.store,NOW).candidates;
    expect(admit(f.store,f.config,candidates,NOW+1000)).toBeUndefined();
    f.store.put('activity','new-foreground',{provider:'claude',sessionId:'new-foreground',owned:false,busy:true,lastAt:NOW});
    expect(admit(f.store,f.config,candidates,NOW)).toBeUndefined();
  });
});

describe('slots, activity, fairness, and handoffs', () => {
  it('pauses new admissions for foreground activity but excludes owned descendants', () => {
    const f = setup(); const reading = { claude: { quota: quota() } };
    f.store.put('activity', 'foreground', { provider: 'claude', sessionId: 'foreground', owned: false, busy: true, lastAt: NOW });
    expect(eligibility(f.config, reading, { ready: true }, f.store, NOW).candidates).toHaveLength(0);
    f.store.put('activity', 'foreground', { provider: 'claude', sessionId: 'foreground', owned: false, busy: false, lastAt: NOW - 300_000 });
    f.store.put('activity', 'owned', { provider: 'claude', sessionId: 'owned', owned: true, busy: true, lastAt: NOW });
    expect(eligibility(f.config, reading, { ready: true }, f.store, NOW).candidates).toHaveLength(1);
    expect(eligibility(f.config, reading, { ready: false, reason: 'hooks missing' }, f.store, NOW).candidates).toHaveLength(0);
  });
  it('pauses only the busy provider under foregroundScope provider, leaving the other free to launch', () => {
    const f = setup(); f.config.foregroundScope = 'provider';
    const reading = { claude: { quota: quota('claude') }, codex: { quota: quota('codex') } };
    f.store.put('activity', 'claude-foreground', { provider: 'claude', sessionId: 'claude-foreground', owned: false, busy: true, lastAt: NOW });
    const decision = eligibility(f.config, reading, { ready: true }, f.store, NOW);
    expect(decision.candidates.map(c => c.provider)).toEqual(['codex']);
    expect(decision.reasons).toContain('claude: Foreground agent is active');
    expect(admit(f.store, f.config, decision.candidates, NOW)?.provider).toBe('codex');
  });
  it('applies the idle delay per provider under foregroundScope provider', () => {
    const f = setup(); f.config.foregroundScope = 'provider';
    const reading = { claude: { quota: quota('claude') }, codex: { quota: quota('codex') } };
    f.store.put('activity', 'codex-recent', { provider: 'codex', sessionId: 'codex-recent', owned: false, busy: false, lastAt: NOW - 60_000 });
    const decision = eligibility(f.config, reading, { ready: true }, f.store, NOW);
    expect(decision.candidates.map(c => c.provider)).toEqual(['claude']);
    expect(decision.reasons).toContain('codex: Waiting for the foreground idle delay');
  });
  it('defaults to foregroundScope any, pausing both providers and reporting it once', () => {
    const f = setup(); const reading = { claude: { quota: quota('claude') }, codex: { quota: quota('codex') } };
    expect(f.config.foregroundScope).toBe('any');
    f.store.put('activity', 'claude-foreground', { provider: 'claude', sessionId: 'claude-foreground', owned: false, busy: true, lastAt: NOW });
    const decision = eligibility(f.config, reading, { ready: true }, f.store, NOW);
    expect(decision.candidates).toHaveLength(0);
    expect(decision.reasons.filter(r => r === 'Foreground agent is active')).toHaveLength(1);
    expect(admit(f.store, f.config, decision.candidates, NOW)).toBeUndefined();
  });
  it('holds input-blocked slots, permits peers, and stops when repeated problems fill capacity', () => {
    const f = setup(); f.config.slots = 2;
    f.store.put('run', 'run-1', run(f));
    const candidates = eligibility(f.config, { claude: { quota: quota() } }, { ready: true }, f.store, NOW).candidates;
    expect(admit(f.store, f.config, candidates, NOW)).toBeDefined();
    expect(admit(f.store, f.config, candidates, NOW + 120_000)).toBeUndefined();
    expect(f.store.run('run-1').state).toBe('needs_input');
  });
  it('staggering and round-robin apply across skills', () => {
    const f = setup(); f.config.skills.push({ ...f.skill, id: 'preview' });
    const candidates = eligibility(f.config, { claude: { quota: quota() } }, { ready: true }, f.store, NOW).candidates;
    expect(admit(f.store, f.config, candidates, NOW)?.skillId).toBe('research');
    expect(admit(f.store, f.config, candidates, NOW + 1)?.skillId).toBe('preview');
    expect(admit(f.store, f.config, candidates, NOW + 2)).toBeUndefined();
    expect(admit(f.store, f.config, candidates, NOW + 60_000)?.skillId).toBe('research');
  });
  it('prefers the earlier reset, then more remaining quota, then configured order', () => {
    const f = setup(); const claude = quota(); const codex = quota('codex', claude.weekly.resetsAt - 1000);
    const decision = eligibility(f.config, { claude: { quota: claude }, codex: { quota: codex } }, { ready: true }, f.store, NOW);
    expect(selectProvider(f.skill, decision.candidates)?.provider).toBe('codex');
    codex.weekly.resetsAt = claude.weekly.resetsAt; codex.weekly.usedPercent = 10;
    expect(selectProvider(f.skill, decision.candidates)?.provider).toBe('codex');
    codex.weekly.usedPercent = claude.weekly.usedPercent;
    expect(selectProvider(f.skill, decision.candidates)?.provider).toBe('claude');
  });
  it('resumes answers in the original session and provider without allocating another slot', () => {
    const f = setup(); f.config.slots = 1;
    f.store.put('run', 'run-1', run(f, { state: 'answer_queued', answer: 'Proceed with the draft.' }));
    const codexOnly = eligibility(f.config, { codex: { quota: quota('codex') } }, { ready: true }, f.store, NOW).candidates;
    expect(admit(f.store, f.config, codexOnly, NOW)).toBeUndefined();
    const candidates = eligibility(f.config, { claude: { quota: quota() } }, { ready: true }, f.store, NOW).candidates;
    const resumed = admit(f.store, f.config, candidates, NOW)!;
    expect(resumed.sessionId).toBe('session-1'); expect(resumed.id).toBe('run-1'); expect(resumed.attempt).toBe(2); expect(f.store.held()).toHaveLength(1);
  });
  it('holds a queued answer when the provider is rebound to another native account', () => {
    const f = setup(); f.config.slots = 1;
    f.store.put('run', 'run-1', run(f, { state: 'answer_queued', answer: 'Continue this item.' }));
    f.config.providers.claude!.account = { email: 'other@example.com' };
    const reading = quota(); reading.account = f.config.providers.claude!.account;
    const candidates = eligibility(f.config, { claude: { quota: reading } }, { ready: true }, f.store, NOW).candidates;

    expect(candidates).toHaveLength(1);
    expect(admit(f.store, f.config, candidates, NOW)).toBeUndefined();
    expect(f.store.run('run-1').state).toBe('answer_queued');
    expect(f.store.run('run-1').account.email).toBe('person@example.com');
  });
  it('no-work suspends repeat invocation, while malformed outcomes hold their slots', () => {
    const f = setup(); const candidates = eligibility(f.config, { claude: { quota: quota() } }, { ready: true }, f.store, NOW).candidates;
    const admitted = admit(f.store, f.config, candidates, NOW)!;
    finishRun(f.store, admitted.id, { status: 'no_work', summary: 'No unclaimed accounts.', question: null, workItem: null, artifacts: [] }, false, undefined);
    expect(admit(f.store, f.config, candidates, NOW + 120_000)).toBeUndefined();
    f.store.put('run', 'run-1', run(f, { state: 'running' })); finishRun(f.store, 'run-1', undefined, false, undefined);
    expect(f.store.run('run-1').state).toBe('failed'); expect(f.store.held()).toHaveLength(1);
  });
});
