import { z } from 'zod';

export const ProviderSchema = z.enum(['claude', 'codex']);
export type Provider = z.infer<typeof ProviderSchema>;
const positiveInt = z.number().int().positive();
export const SkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  path: z.string().min(1), cwd: z.string().min(1), prompt: z.string().default(''),
  providers: z.array(ProviderSchema).min(1).refine(v => new Set(v).size === v.length, 'Providers must be unique'),
  maxConcurrent: positiveInt, spacingSeconds: z.number().nonnegative(), enabled: z.boolean().default(true),
  claude: z.object({
    allowedTools: z.array(z.string()).default([]),
    permissionMode: z.enum(['dontAsk', 'acceptEdits', 'auto']).default('dontAsk'),
    model: z.string().optional(),
  }).optional(),
  codex: z.object({
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    profile: z.string().optional(), model: z.string().optional(),
    networkAccess: z.boolean().default(false),
  }).optional(),
}).strict().superRefine((skill, ctx) => {
  for (const provider of skill.providers) if (!skill[provider]) ctx.addIssue({ code: 'custom', message: `${provider} permissions must be explicit`, path: [provider] });
});
export type Skill = z.infer<typeof SkillSchema>;
export const AccountSchema = z.object({ email: z.string().email(), organization: z.string().optional() });
export type Account = z.infer<typeof AccountSchema>;
export const ConfigSchema = z.object({
  version: z.literal(1).default(1), slots: positiveInt,
  runwayHours: z.number().positive().max(168).default(12),
  reservePercent: z.number().min(0).max(100).default(5),
  idleSeconds: z.number().nonnegative().default(300),
  /** 'any' pauses every provider when either native agent is active; 'provider' pauses only the one in use. */
  foregroundScope: z.enum(['any', 'provider']).default('any'),
  pollSeconds: z.number().min(10).default(60),
  quotaMaxAgeSeconds: z.number().min(10).default(120),
  notifications: z.boolean().default(true), keepAwake: z.boolean().default(false),
  codexbar: z.string().default('codexbar'),
  providers: z.record(ProviderSchema, z.object({ binary: z.string(), account: AccountSchema }).optional()),
  skills: z.array(SkillSchema).default([]),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.skills.map(s => s.id)).size !== config.skills.length) ctx.addIssue({ code: 'custom', message: 'Skill IDs must be unique' });
  for (const skill of config.skills) for (const provider of skill.providers) if (!config.providers[provider]) ctx.addIssue({ code: 'custom', message: `${skill.id}: configure ${provider} account first` });
});
export type Config = z.infer<typeof ConfigSchema>;
export interface Window { usedPercent: number; resetsAt: number; windowMinutes: number }
export interface Quota { provider: Provider; account: Account; identityBasis?: 'snapshot' | 'verified-native-cli'; fetchedAt: number; updatedAt: number; weekly: Window; shortTerm?: Window; extra: Window[] }
export interface QuotaReading { quota?: Quota; error?: string }
export const OutcomeSchema = z.object({
  status: z.enum(['completed', 'no_work', 'needs_input', 'failed']),
  summary: z.string().min(1), question: z.string().nullable(),
  workItem: z.string().nullable(), artifacts: z.array(z.string()),
}).strict().refine(v => v.status !== 'needs_input' || !!v.question?.trim(), 'needs_input requires a question');
export type Outcome = z.infer<typeof OutcomeSchema>;
export type RunState = 'launching' | 'running' | 'needs_input' | 'answer_queued' | 'quota_wait' | 'failed' | 'uncertain' | 'completed' | 'no_work' | 'released';
export const HELD_STATES: RunState[] = ['launching', 'running', 'needs_input', 'answer_queued', 'quota_wait', 'failed', 'uncertain'];
export interface Run {
  id: string; skillId: string; provider: Provider; account: Account; skill: Skill; sprintId: string;
  state: RunState; createdAt: number; updatedAt: number; attempt: number;
  sessionId?: string; workerPid?: number; workerIdentity?: string; agentPid?: number; agentIdentity?: string; heartbeatAt?: number;
  outcome?: Outcome; error?: string; answer?: string; retryAfter?: number; reviewMinutes?: number; useful?: boolean;
}
export interface Sprint { id: string; provider: Provider; resetAt: number; deadline: number; openedAt: number; closedAt?: number; notifiedAt?: number }
export interface ManualSprint { id: string; deadline: number; providers: Provider[]; resets: Partial<Record<Provider, number>> }
export interface Activity { provider: Provider; sessionId: string; owned: boolean; busy: boolean; lastAt: number; pid?: number; processIdentity?: string }
export interface Health { ready: boolean; reason?: string }
