import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, SkillSchema, type Provider, type Quota, type Run } from '../src/model.js';
import { Store } from '../src/store.js';

export const NOW = Date.parse('2026-09-14T08:00:00Z');
export function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'lastcall-test-'));
  const path = join(home, 'SKILL.md'); writeFileSync(path, '---\nname: research\ndescription: Research a company.\n---\nSelect one unclaimed company and produce a brief.');
  const skill = SkillSchema.parse({ id: 'research', path, cwd: home, providers: ['claude', 'codex'], maxConcurrent: 2, spacingSeconds: 60, claude: { allowedTools: ['Read'] }, codex: { sandbox: 'read-only' } });
  const account = { email: 'person@example.com' };
  const config = ConfigSchema.parse({ slots: 3, providers: { claude: { binary: '/bin/false', account }, codex: { binary: '/bin/false', account } }, skills: [skill] });
  return { home, skill, config, store: new Store(home) };
}
export function quota(provider: Provider = 'claude', resetAt = NOW + 8 * 3_600_000): Quota {
  return { provider, account: { email: 'person@example.com' }, fetchedAt: NOW, updatedAt: NOW,
    weekly: { usedPercent: 40, resetsAt: resetAt, windowMinutes: 10080 },
    shortTerm: { usedPercent: 20, resetsAt: NOW + 3_600_000, windowMinutes: 300 }, extra: [] };
}
export function run(f: ReturnType<typeof fixture>, changes: Partial<Run> = {}): Run {
  const provider = changes.provider ?? 'claude';
  const account = f.config.providers[provider]!.account;
  return { id: 'run-1', provider, account: { ...account }, skill: f.skill, skillId: f.skill.id, sprintId: `claude:${quota().weekly.resetsAt}`, createdAt: NOW, updatedAt: NOW, state: 'needs_input', sessionId: 'session-1', attempt: 1, ...changes };
}
