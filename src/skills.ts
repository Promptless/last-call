import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { type Skill } from './model.js';
import { errorMessage } from './files.js';

export interface Finding { severity: 'error' | 'advisory'; code: string; message: string }
export interface SkillCheck { skillId: string; valid: boolean; findings: Finding[]; semanticReview: { required: true; skillPath: string; questions: string[] } }
export function checkSkill(skill: Skill): SkillCheck {
  const findings: Finding[] = [];
  for (const [label, path] of [['skill', skill.path], ['working directory', skill.cwd]]) {
    if (!isAbsolute(path!)) findings.push({ severity: 'error', code: 'relative-path', message: `${label} needs an absolute path` });
    if (!existsSync(path!)) findings.push({ severity: 'error', code: 'missing-path', message: `${label} does not exist: ${path}` });
  }
  if (existsSync(skill.cwd) && !statSync(skill.cwd).isDirectory()) findings.push({ severity: 'error', code: 'not-directory', message: 'Working directory is not a directory' });
  let content = '';
  try { accessSync(skill.path, constants.R_OK); content = readFileSync(skill.path, 'utf8'); }
  catch (error) { findings.push({ severity: 'error', code: 'unreadable-skill', message: errorMessage(error) }); }
  const checks: [RegExp, string, string][] = [
    [/\b(approv(?:e|al)|confirm|ask the user|human|operator present)\b/i, 'human-gate', 'Check how this skill preserves progress and returns a question at its human approval gates.'],
    [/\b(cron|launchd|scheduler|stop hook|mode=sweep|repeat forever)\b/i, 'nested-scheduler', 'Choose a single-item invocation; this skill mentions scheduling or repeated execution.'],
    [/\b(publish|deploy|send|delete|push|create.*repo)\b/i, 'external-effects', 'Confirm the configured permissions and existing approval requirements for external actions.'],
    [/\b(Claude.only|Codex.only|claude -p|codex exec)\b/i, 'provider-assumption', 'Check provider-specific assumptions against the allowed providers.'],
  ];
  for (const [pattern, code, message] of checks) if (pattern.test(content)) findings.push({ severity: 'advisory', code, message });
  if (skill.maxConcurrent > 1) findings.push({ severity: 'advisory', code: 'parallel-claims', message: 'Verify distinct work-item claims, awaiting-review exclusions, and isolated output paths. Launch spacing alone does not guarantee uniqueness.' });
  if (skill.providers.includes('claude') && !skill.claude?.allowedTools.length) findings.push({ severity: 'advisory', code: 'claude-tools', message: 'No tool allowlist supplied. Verify inherited native permissions provide exactly the unattended access you intend.' });
  return { skillId: skill.id, valid: !findings.some(f => f.severity === 'error'), findings, semanticReview: { required: true, skillPath: skill.path, questions: [
    'What selects and claims exactly one work item, and excludes items awaiting input?',
    'What marks completion, no work, or a human handoff in the external system?',
    'Which dependencies, tool permissions, and provider features are required?',
    'Can parallel runs share the working directory without conflicting edits?',
    'Does any instruction start another scheduler, bypass an approval gate, or repeat work with external effects?',
  ] } };
}
