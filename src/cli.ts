#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { ConfigSchema, ProviderSchema, SkillSchema, HELD_STATES, type Config, type Provider, type QuotaReading, type ManualSprint, type Run } from './model.js';
import { errorMessage, homePath, loadConfig, readJson, saveConfig } from './files.js';
import { findBinary, capture, processIdentity } from './process.js';
import { nativeAccount, readQuotas } from './providers.js';
import { Store } from './store.js';
import { checkSkill } from './skills.js';
import { installHooks, uninstallHooks, ingestHook } from './activity.js';
import { disableService, enableService, installCodexBar, requireMac } from './macos.js';
import { daemon, statusSnapshot } from './daemon.js';
import { runWorker } from './runner.js';

const entry = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(entry), '..');
const program = new Command().name('lastcall').description('Your AI quota is expiring. Put it to work.').version('0.1.0')
  .option('--home <path>', 'private configuration and runtime directory', homePath()).option('--json', 'machine-readable JSON output');
const home = (): string => resolve(String(program.opts().home));
function output(value: unknown, human?: string): void { process.stdout.write((program.opts().json || !human ? JSON.stringify(value, null, 2) : human) + '\n'); }
function withStore<T>(fn: (store: Store) => T): T { const store = new Store(home()); try { return fn(store); } finally { store.close(); } }
function providerList(value: string): Provider[] { return z.array(ProviderSchema).min(1).parse(value.split(',').map(s => s.trim())); }
function occupiedLine(run: Run): string { return `${run.id}  ${run.provider.padEnd(6)}  ${run.state.padEnd(13)}  ${run.skillId}\n  ${run.error ?? run.outcome?.summary ?? ''}${run.sessionId ? `\n  Native session: ${run.sessionId}` : ''}${run.outcome?.question ? `\n  Question: ${run.outcome.question}` : ''}${run.outcome?.artifacts.length ? `\n  ${run.outcome.artifacts.join('\n  ')}` : ''}`; }

async function questions<T>(fn: (ask: (question: string, defaultValue?: string) => Promise<string>) => Promise<T>): Promise<T> {
  if (!process.stdin.isTTY) throw new Error('Interactive input unavailable. Use --config/--file or ask the Last Call companion skill to configure the CLI.');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (question: string, defaultValue = ''): Promise<string> => (await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim() || defaultValue;
  try { return await fn(ask); } finally { rl.close(); }
}

async function addSkillInteractive(config: Config, suppliedId?: string): Promise<Config> {
  const skill = await questions(async ask => {
    const id = suppliedId ?? await ask('Skill ID (lowercase-with-hyphens)');
    const path = resolve(await ask('Absolute path to SKILL.md'));
    const cwd = resolve(await ask('Working directory', process.cwd()));
    const providers = providerList(await ask('Allowed providers, comma-separated', Object.keys(config.providers).filter(p => config.providers[p as Provider]).join(',')));
    const maxConcurrent = Number(await ask('Maximum slots this skill may occupy'));
    const spacingSeconds = Number(await ask('Seconds between launches', '60'));
    const prompt = await ask('Invocation arguments or additional instructions (optional)');
    const claude = providers.includes('claude') ? { permissionMode: await ask('Claude permission mode: dontAsk, acceptEdits, auto', 'dontAsk'), allowedTools: (await ask('Claude allowed tools, separated by commas (optional)')).split(',').map(s => s.trim()).filter(Boolean) } : undefined;
    const codex = providers.includes('codex') ? { sandbox: await ask('Codex sandbox: read-only, workspace-write, danger-full-access', 'read-only'), networkAccess: (await ask('Enable network access for Codex workspace-write? yes/no', 'no')) === 'yes' } : undefined;
    return SkillSchema.parse({ id, path, cwd, providers, maxConcurrent, spacingSeconds, prompt, claude, codex });
  });
  if (config.skills.some(s => s.id === skill.id)) throw new Error(`Skill ${skill.id} already exists; edit config.json to update it`);
  const check = checkSkill(skill);
  if (!check.valid) throw new Error(check.findings.filter(f => f.severity === 'error').map(f => f.message).join('\n'));
  const updated = ConfigSchema.parse({ ...config, skills: [...config.skills, skill] }); saveConfig(home(), updated); output(check);
  return updated;
}

function installCompanion(): void {
  const source = join(packageRoot, 'skills', 'lastcall');
  const hash = createHash('sha256').update(readFileSync(join(source, 'SKILL.md'))).digest('hex');
  withStore(store => {
    const installed = store.get<{ path: string; hash: string }[]>('setting', 'companions') ?? [];
    const paths = [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills', 'lastcall'), join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills', 'lastcall')];
    for (const path of paths) {
      if (existsSync(join(path, 'SKILL.md'))) {
        const previous = installed.find(s => s.path === path);
        const current = createHash('sha256').update(readFileSync(join(path, 'SKILL.md'))).digest('hex');
        if (current !== hash && current !== previous?.hash) throw new Error(`Existing skill at ${path} was not installed by Last Call or was edited; preserving it.`);
      }
      mkdirSync(dirname(path), { recursive: true }); cpSync(source, path, { recursive: true });
    }
    store.put('setting', 'companions', paths.map(path => ({ path, hash })));
  });
}

program.command('init').description('Configure accounts, skills, and closing-time preferences; service stays off')
  .option('--config <path>', 'import a complete configuration JSON file')
  .option('--install-deps', 'install the pinned standalone CodexBar helper')
  .option('--install-hooks', 'install native activity hooks')
  .option('--install-skills', 'install the companion skill for both agents')
  .action(async options => {
    requireMac();
    if (existsSync(join(home(), 'config.json'))) throw new Error('This installation is already configured. Use config set, provider add, or skill add.');
    let config: Config;
    if (options.config) config = ConfigSchema.parse(readJson(resolve(String(options.config))));
    else config = await questions(async ask => {
      const available = (['claude', 'codex'] as const).filter(p => { try { findBinary(p); return true; } catch { return false; } });
      const selected = providerList(await ask('Providers to configure', available.join(',')));
      const providers: Config['providers'] = { claude: undefined, codex: undefined };
      for (const provider of selected) { const binary = findBinary(provider); providers[provider] = { binary, account: await nativeAccount(provider, binary, home()) }; }
      let codexbar: string;
      try { codexbar = findBinary('codexbar'); }
      catch { codexbar = (await ask('Install the standalone CodexBar quota helper? yes/no', 'yes')) === 'yes' ? await installCodexBar(home()) : 'codexbar'; }
      return ConfigSchema.parse({ slots: Number(await ask('Total agent slots')), providers, codexbar,
        runwayHours: Number(await ask('Hours before weekly reset to start', '12')), reservePercent: Number(await ask('Weekly reserve percentage', '5')),
        idleSeconds: Number(await ask('Seconds of foreground agent inactivity before launching', '300')),
        keepAwake: (await ask('Keep Mac awake on AC power during sprints? yes/no', 'no')) === 'yes',
        notifications: (await ask('Desktop summaries and attention notifications? yes/no', 'yes')) === 'yes' });
    });
    if (options.installDeps) config.codexbar = await installCodexBar(home());
    saveConfig(home(), config);
    if (!options.config) {
      const add = await questions(ask => ask('Register a skill now? yes/no', 'yes'));
      if (add === 'yes') config = await addSkillInteractive(config);
      options.installHooks = (await questions(ask => ask('Install activity hooks? yes/no', 'yes'))) === 'yes';
      options.installSkills = (await questions(ask => ask('Install the Last Call companion skill? yes/no', 'yes'))) === 'yes';
    }
    if (options.installHooks) installHooks(home(), entry, (['claude', 'codex'] as const).filter(p => config.providers[p]));
    if (options.installSkills) installCompanion();
    output({ home: home(), service: 'disabled', config }, `Configured Last Call at ${home()}.\nRun lastcall doctor, then lastcall service enable when ready.`);
  });

const configCommand = program.command('config').description('Inspect or edit scheduling preferences');
configCommand.command('show').action(() => output(loadConfig(home())));
configCommand.command('set <key> <value>').description('Set slots, runwayHours, reservePercent, idleSeconds, foregroundScope, pollSeconds, notifications, or keepAwake').action((key: string, value: string) => {
  const allowed = ['slots', 'runwayHours', 'reservePercent', 'idleSeconds', 'pollSeconds', 'quotaMaxAgeSeconds', 'notifications', 'keepAwake', 'codexbar', 'foregroundScope'];
  if (!allowed.includes(key)) throw new Error(`Editable preferences: ${allowed.join(', ')}`);
  const parsed = ['codexbar', 'foregroundScope'].includes(key) ? value : JSON.parse(value) as unknown;
  const config = ConfigSchema.parse({ ...loadConfig(home()), [key]: parsed }); saveConfig(home(), config); output(config);
});

program.command('doctor').description('Check native authentication, measured quota, and activity hooks').action(async () => {
  const config = loadConfig(home());
  const readings = await readQuotas(config, home());
  const versions: Record<string, string> = {};
  for (const [name, binary] of [['codexbar', config.codexbar], ...Object.entries(config.providers).filter(([, v]) => v).map(([p, v]) => [p, v!.binary])]) {
    try { const result = await capture(binary!, ['--version']); versions[name!] = result.code === 0 ? result.stdout.trim() : `exit ${result.code}`; }
    catch (error) { versions[name!] = errorMessage(error); }
  }
  withStore(store => { store.put('setting', 'readings', readings); output({ versions, ...statusSnapshot(store, config, readings) }); });
});

const provider = program.command('provider').description('Bind native subscription accounts');
provider.command('add <provider>').option('--binary <path>', 'native executable path').action(async (name: string, options) => {
  const selected = ProviderSchema.parse(name); const binary = findBinary(String(options.binary ?? selected));
  const config = loadConfig(home()); config.providers[selected] = { binary, account: await nativeAccount(selected, binary, home()) }; saveConfig(home(), config); output(config.providers[selected]);
});

const skill = program.command('skill').description('Register and inspect repeatable skills');
skill.command('add [id]').option('--file <path>', 'skill configuration JSON').action(async (id: string | undefined, options) => {
  const config = loadConfig(home());
  if (!options.file) { await addSkillInteractive(config, id); return; }
  const selected = SkillSchema.parse(readJson(resolve(String(options.file))));
  if (config.skills.some(s => s.id === selected.id)) throw new Error(`Skill ${selected.id} already exists`);
  const check = checkSkill(selected); if (!check.valid) { output(check); process.exitCode = 1; return; }
  saveConfig(home(), ConfigSchema.parse({ ...config, skills: [...config.skills, selected] })); output(check);
});
skill.command('check [id]').action((id?: string) => {
  const selected = loadConfig(home()).skills.filter(s => !id || s.id === id);
  if (!selected.length) throw new Error('No matching skills');
  const results = selected.map(checkSkill); output(results); if (results.some(r => !r.valid)) process.exitCode = 1;
});
for (const enabled of [true, false]) skill.command(`${enabled ? 'enable' : 'disable'} <id>`).action((id: string) => {
  const config = loadConfig(home()); const selected = config.skills.find(s => s.id === id); if (!selected) throw new Error(`Unknown skill: ${id}`);
  selected.enabled = enabled; saveConfig(home(), config); output(selected);
});
skill.command('recheck <id>').description('Allow an empty skill to look for work again during this sprint').action((id: string) => {
  if (!loadConfig(home()).skills.some(s => s.id === id)) throw new Error(`Unknown skill: ${id}`);
  withStore(store => { for (const sprint of store.sprints()) store.delete('empty', `${id}:${sprint.id}`); }); output({ skill: id, recheck: true });
});

program.command('status').option('--refresh', 'fetch fresh native quota snapshots').action(async options => {
  const config = loadConfig(home());
  const readings = options.refresh ? await readQuotas(config, home()) : withStore(store => store.get<Partial<Record<Provider, QuotaReading>>>('setting', 'readings') ?? {});
  withStore(store => {
    if (options.refresh) store.put('setting', 'readings', readings);
    const status = statusSnapshot(store, config, readings);
    const reasons = z.array(z.string()).parse(status.reasons);
    const quotas = Object.entries(readings).map(([p, reading]) => reading.quota ? `${p}: ${100 - reading.quota.weekly.usedPercent}% weekly left; resets ${new Date(reading.quota.weekly.resetsAt).toLocaleString()}` : `${p}: ${reading.error}`).join('\n');
    output(status, `Last Call · ${store.held().length}/${config.slots} slots occupied\n${quotas}\n${reasons.length ? reasons.map(r => `• ${r}`).join('\n') : 'Ready to admit work when the service polls.'}\n\n${store.held().map(occupiedLine).join('\n')}`);
  });
});

program.command('sprint').description('Start a one-off sprint with an explicit deadline')
  .requiredOption('--until <ISO-time>', 'deadline with timezone offset, e.g. 2026-09-14T21:00:00-07:00')
  .option('--providers <list>', 'comma-separated providers; defaults to configured providers')
  .action(async options => {
    const text = String(options.until); const deadline = Date.parse(text);
    if (!/(Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('Supply a future ISO timestamp with a timezone offset');
    const config = loadConfig(home()); const providers = options.providers ? providerList(String(options.providers)) : (['claude', 'codex'] as const).filter(p => config.providers[p]);
    const readings = await readQuotas(config, home());
    const sprint: ManualSprint = { id: randomUUID(), deadline, providers, resets: {} };
    for (const p of providers) { const q = readings[p]?.quota; if (!q) throw new Error(`${p}: Cannot bind manual sprint without a measured weekly period: ${readings[p]?.error}`); sprint.resets[p] = q.weekly.resetsAt; }
    withStore(store => store.transaction(() => {
      for (const provider of providers) store.put('setting', `manual:${provider}`, sprint);
      store.put('setting', 'readings', readings);
    }));
    output(sprint, `Manual sprint scheduled until ${new Date(deadline).toLocaleString()}. The enabled service will apply normal quota and activity gates.`);
  });

program.command('runs [id]').description('Show run receipts, questions, artifact links, and session IDs').action((id?: string) => withStore(store => {
  const runs = id ? [store.run(id)] : store.runs(); output(id ? runs[0] : runs, runs.length ? runs.map(occupiedLine).join('\n\n') : 'No runs yet.');
}));
program.command('answer <id>').option('--text <answer>', 'user-authored response').option('--file <path>', 'read the user response from a UTF-8 file').option('--after-inspection', 'confirm an uncertain run was inspected and has no surviving execution').action((id: string, options) => {
  if (!!options.text === !!options.file) throw new Error('Supply exactly one of --text or --file');
  const answer = options.file ? readFileSync(resolve(String(options.file)), 'utf8') : String(options.text);
  if (!answer.trim()) throw new Error('Answer cannot be empty');
  withStore(store => {
    const updated = store.transaction(() => {
      const run = store.run(id);
      if (!['needs_input', 'failed', 'uncertain'].includes(run.state) || !run.sessionId) throw new Error('This run has no resumable handoff; inspect its receipt');
      if (run.state === 'uncertain' && !options.afterInspection) throw new Error('Runner ownership is uncertain. Inspect the native session for surviving work before using --after-inspection.');
      if (run.workerPid && processIdentity(run.workerPid) === run.workerIdentity) throw new Error('The original worker is still alive. Inspect its native session before resuming.');
      if (run.agentPid && processIdentity(run.agentPid) === run.agentIdentity) throw new Error('The native agent may still be executing. Inspect its session before resuming.');
      const result: Run = { ...run, state: 'answer_queued', answer, error: undefined, updatedAt: Date.now() };
      store.put('run', id, result);
      return result;
    });
    output(updated, 'Answer queued. The same session will resume when scheduling gates permit.');
  });
});
program.command('release <id>').requiredOption('--reason <reason>', 'why this slot may be relinquished').action((id: string, options) => withStore(store => {
  const updated = store.transaction(() => {
    const run = store.run(id);
    if (!HELD_STATES.includes(run.state)) throw new Error('This run does not occupy a slot');
    if (['launching', 'running'].includes(run.state) || (run.workerPid && processIdentity(run.workerPid) === run.workerIdentity)) throw new Error('This run may still be executing. Let it finish or stop its native session before releasing its slot.');
    if (run.agentPid && processIdentity(run.agentPid) === run.agentIdentity) throw new Error('The native agent may still be executing. Inspect its session before releasing the slot.');
    const result: Run = { ...run, state: 'released', error: `Released by user: ${String(options.reason)}`, updatedAt: Date.now() };
    store.put('run', id, result);
    return result;
  });
  output(updated, 'Slot released. This does not mark the external work item complete.');
}));
program.command('review <id>').requiredOption('--minutes <number>', 'human review time').requiredOption('--useful <yes|no>', 'whether the output was useful').action((id: string, options) => {
  const minutes = z.number().nonnegative().parse(Number(options.minutes)); const useful = z.enum(['yes', 'no']).parse(options.useful) === 'yes';
  withStore(store => output(store.updateRun(id, { reviewMinutes: minutes, useful })));
});

const hooks = program.command('hooks').description('Manage activity detection hooks');
hooks.command('install').action(() => { const config = loadConfig(home()); output(installHooks(home(), entry, (['claude', 'codex'] as const).filter(p => config.providers[p])), 'Hooks installed. Open fresh native sessions and review Codex hook trust if prompted. Then run lastcall doctor.'); });
hooks.command('uninstall').action(() => { uninstallHooks(home()); output({ removed: true }); });
const service = program.command('service').description('Manage the macOS background scheduler');
service.command('enable').action(async () => { loadConfig(home()); await enableService(home(), entry); output({ enabled: true }); });
service.command('disable').action(async () => { await disableService(home()); output({ enabled: false, activeRuns: 'continue to completion' }); });
const deps = program.command('deps').description('Manage the standalone quota helper');
deps.command('install').action(async () => { const config = loadConfig(home()); config.codexbar = await installCodexBar(home()); saveConfig(home(), config); output({ codexbar: config.codexbar }); });
program.command('install-skill').action(() => { installCompanion(); output({ installed: true }); });
program.command('uninstall').description('Remove service, hooks and unchanged companion skills; preserve receipts and configuration').action(async () => {
  await disableService(home()); uninstallHooks(home());
  const preserved: string[] = [];
  withStore(store => {
    for (const item of store.get<{ path: string; hash: string }[]>('setting', 'companions') ?? []) {
      if (!existsSync(item.path)) continue;
      const hash = createHash('sha256').update(readFileSync(join(item.path, 'SKILL.md'))).digest('hex');
      if (hash === item.hash) rmSync(join(item.path, 'SKILL.md')); else preserved.push(item.path);
    }
    store.delete('setting', 'companions');
  }); output({ removed: true, preserved, runtimeHome: home(), activeRuns: 'continue to completion' });
});

program.command('_daemon', { hidden: true }).option('--once').action(async options => daemon(home(), entry, Boolean(options.once)));
program.command('_worker <id>', { hidden: true }).action(async (id: string) => runWorker(home(), id));
program.command('_activity <provider>', { hidden: true }).action(async (name: string) => {
  let input = ''; for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 2 * 1024 * 1024) throw new Error('Hook input exceeds 2 MiB'); }
  ingestHook(home(), ProviderSchema.parse(name), JSON.parse(input));
  process.stdout.write('{}\n');
});

try { await program.parseAsync(); }
catch (error) {
  const message = errorMessage(error);
  if (program.opts().json) process.stdout.write(JSON.stringify({ error: message }) + '\n');
  else process.stderr.write(`Last Call: ${message}\n`);
  process.exitCode = 1;
}
