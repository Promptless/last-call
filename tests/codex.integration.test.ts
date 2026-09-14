import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig } from '../src/files.js';
import { runWorker } from '../src/runner.js';
import { activityHealth, installHooks, recordActivity } from '../src/activity.js';
import { fixture, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
  const f = fixture(); fixtures.push(f);
  const binary = join(f.home, 'fake-codex');
  // Message shapes follow codex app-server generate-ts and the exec JSONL contract.
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const send = value => console.log(JSON.stringify(value));
if (args[0] === 'app-server') {
  require('node:readline').createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line); let result;
    if (request.method === 'initialized') return;
    if (request.method === 'initialize') result = {};
    else if (request.method === 'account/read') result = {account: {type: 'chatgpt', email: 'person@example.com'}};
    else {
      const health = JSON.parse(fs.readFileSync(path.join(__dirname, 'hook-health.json'), 'utf8'));
      if (request.method === 'experimentalFeature/list') result = {data: [{name: 'hooks', enabled: health.feature}], nextCursor: null};
      if (request.method === 'hooks/list') result = {data: request.params.cwds.map(cwd => ({cwd, errors: [], hooks: health.spec.events.map(event => ({eventName: event[0].toLowerCase() + event.slice(1), sourcePath: fs.realpathSync(health.spec.path), handlerType: 'command', command: health.spec.command, matcher: null, async: false, enabled: health.enabled, trustStatus: health.trust}))}))};
    }
    send({id: request.id, result});
  });
} else {
  let input = ''; process.stdin.on('data', data => input += data);
  process.stdin.on('end', () => {
    const mode = fs.readFileSync('behavior.txt', 'utf8');
    const resumed = args.includes('resume'); const session = resumed ? args[args.indexOf('resume') + 1] : 'codex-session';
    fs.appendFileSync('calls.jsonl', JSON.stringify({session, args, cwd: process.cwd()}) + '\\n');
    send({type: 'thread.started', thread_id: session}); send({type: 'turn.started'});
    if (mode === 'retry') send({type: 'error', message: 'Reconnecting... 1/5'});
    if (mode === 'quota') { send({type: 'turn.failed', error: {message: "You've hit your usage limit. Try again later."}}); process.exitCode = 1; return; }
    const status = mode === 'handoff' && !resumed ? 'needs_input' : 'completed';
    const outcome = {status, summary: 'One item handled', question: status === 'needs_input' ? 'Which account?' : null, workItem: 'account-1', artifacts: []};
    send({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(outcome)}});
    if (mode === 'failure') {send({type: 'turn.failed', error: {message: 'Native request failed'}}); process.exitCode = 1; return;}
    if (mode === 'no-terminal') return;
    if (mode === 'bad-final') send({type: 'item.completed', item: {type: 'agent_message', text: 'An incomplete final result'}});
    if (mode === 'empty-final') send({type: 'item.completed', item: {type: 'agent_message', text: ''}});
    send({type: 'turn.completed', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1}});
  });
}
`);
  chmodSync(binary, 0o700);
  f.config.providers.claude = undefined; f.config.providers.codex!.binary = binary;
  f.skill.providers = ['codex']; f.config.skills = [f.skill];
  saveConfig(f.home, f.config);
  return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });

describe('Codex native contracts', () => {
  it('accepts a successful native retry and retains its diagnostic', async () => {
    const f = setup(); writeFileSync(join(f.home, 'behavior.txt'), 'retry');
    f.store.put('run', 'run-1', run(f, { provider: 'codex', state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-1');
    expect(f.store.run('run-1').state).toBe('completed');
    expect(f.store.run('run-1').diagnostics).toEqual(['Reconnecting... 1/5']);
    expect(f.store.held()).toEqual([]);
  });
  it.each(['failure', 'no-terminal', 'bad-final', 'empty-final'])('holds %s even after a valid-looking message', async mode => {
    const f = setup(); writeFileSync(join(f.home, 'behavior.txt'), mode);
    f.store.put('run', 'run-1', run(f, { provider: 'codex', state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-1');
    expect(f.store.run('run-1').state).toBe('failed'); expect(f.store.held()).toHaveLength(1);
  });
  it.each(['quota', 'handoff'])('resumes the same session following %s', async mode => {
    const f = setup(); writeFileSync(join(f.home, 'behavior.txt'), mode);
    f.store.put('run', 'run-1', run(f, { provider: 'codex', state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-1');
    expect(f.store.run('run-1').state).toBe(mode === 'quota' ? 'quota_wait' : 'needs_input');
    expect(f.store.held()).toHaveLength(1);
    if (mode === 'quota') expect(f.store.run('run-1').retryAfter).toBeGreaterThan(Date.now());
    f.store.updateRun('run-1', { state: 'launching', attempt: 2, answer: mode === 'handoff' ? 'Use account 1' : undefined });
    writeFileSync(join(f.home, 'behavior.txt'), 'complete');
    await runWorker(f.home, 'run-1');
    expect(f.store.run('run-1').state).toBe('completed');
    const calls = readFileSync(join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.session)).toEqual(['codex-session', 'codex-session']);
    expect(calls[1].args).toContain('resume');
  });
  it('rechecks native hook flags and trust even after lifecycle events were observed', async () => {
    const f = setup();
    const installation = installHooks(f.home, '/tmp/lastcall.js', ['codex'], { claude: join(f.home, 'claude'), codex: join(f.home, 'codex') });
    recordActivity(f.store, 'codex', { session_id: 'foreground', hook_event_name: 'SessionStart' }, false, installation.installedAt + 1);
    const health = { feature: true, enabled: true, trust: 'trusted', spec: installation.providers.codex };
    const path = join(f.home, 'hook-health.json'); writeFileSync(path, JSON.stringify(health));
    expect((await activityHealth(f.config, f.store)).ready).toBe(true);
    for (const change of [{feature: false}, {enabled: false}, {trust: 'untrusted'}, {trust: 'modified'}]) {
      writeFileSync(path, JSON.stringify({...health, ...change}));
      expect((await activityHealth(f.config, f.store)).ready).toBe(false);
    }
  });
});
