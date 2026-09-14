import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { capture } from '../src/process.js';
import { installHooks, recordActivity } from '../src/activity.js';
import { saveConfig } from '../src/files.js';
import { runWorker } from '../src/runner.js';
import { fixture, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
  const f = fixture(); fixtures.push(f);
  const binary = join(f.home, 'fake-claude');
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('auth')) {
  const finish = () => console.log(JSON.stringify({loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty', email:'person@example.com'}));
  if (fs.existsSync(path.join(__dirname,'block-auth'))) {
    fs.writeFileSync(path.join(__dirname,'auth-started'),'');
    const timer = setInterval(() => { if (fs.existsSync(path.join(__dirname,'continue-auth'))) {clearInterval(timer);finish();} }, 10);
  } else finish();
} else {fs.writeFileSync(path.join(__dirname,'invoked'),'');}
`);
  chmodSync(binary, 0o700);
  const helper = join(f.home, 'fake-codexbar');
  writeFileSync(helper, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(path.join(__dirname,'quota-started'),'');
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(__dirname,'continue-quota'))) return;
  clearInterval(timer); const now = Date.now();
  console.log(JSON.stringify({provider:'claude', source:'claude', usage:{identity:{accountEmail:'person@example.com'}, updatedAt:new Date(now).toISOString(), primary:{usedPercent:10,windowMinutes:300,resetsAt:new Date(now+3600000).toISOString()}, secondary:{usedPercent:20,windowMinutes:10080,resetsAt:new Date(now+3600000*8).toISOString()}}}));
},10);
`);
  chmodSync(helper, 0o700);
  f.config.providers.codex = undefined; f.config.providers.claude!.binary = binary;
  f.skill.providers = ['claude']; f.config.skills = [f.skill]; f.config.codexbar = helper;
  f.config.idleSeconds = 0; f.config.notifications = false;
  saveConfig(f.home, f.config);
  const install = installHooks(f.home, resolve('dist/cli.js'), ['claude'], {claude:join(f.home,'claude'),codex:join(f.home,'codex')});
  recordActivity(f.store, 'claude', {session_id:'foreground',hook_event_name:'SessionStart'},false,install.installedAt);
  return f;
}
async function waitFor(path: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, {recursive:true,force:true}); } });
describe('configuration changes during native probes', () => {
  it('does not admit a skill disabled while quota is being fetched', async () => {
    const f = setup();
    const completion = capture(process.execPath, [resolve('dist/cli.js'),'--home',f.home,'_daemon','--once'],{timeout:10000});
    try {
      await waitFor(join(f.home,'quota-started'));
      const disabled = await capture(process.execPath,[resolve('dist/cli.js'),'--home',f.home,'skill','disable',f.skill.id]);
      expect(disabled.code).toBe(0);
    } finally { writeFileSync(join(f.home,'continue-quota'),''); await completion; }
    expect((await completion).code).toBe(0);
    expect(f.store.runs()).toEqual([]); expect(existsSync(join(f.home,'invoked'))).toBe(false);
  });
  it('does not execute an admitted skill disabled during its authentication check', async () => {
    const f = setup(); writeFileSync(join(f.home,'block-auth'),'');
    f.store.put('run','run-1',run(f,{state:'launching',sessionId:undefined}));
    const completion = runWorker(f.home,'run-1');
    try {
      await waitFor(join(f.home,'auth-started'));
      f.config.skills[0]!.enabled = false; saveConfig(f.home,f.config);
    } finally {writeFileSync(join(f.home,'continue-auth'),''); await completion;}
    expect(f.store.run('run-1').state).toBe('failed');
    expect(f.store.run('run-1').error).toMatch(/disabled/);
    expect(existsSync(join(f.home,'invoked'))).toBe(false);
  });
});
