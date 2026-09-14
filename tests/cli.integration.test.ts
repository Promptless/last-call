import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture } from '../src/process.js';
import { saveConfig } from '../src/files.js';
import { fixture, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); saveConfig(f.home, f.config); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
const cli = async (home: string, args: string[]) => capture(process.execPath, [resolve('dist/cli.js'), '--home', home, '--json', ...args]);
async function cliWithCompetingResume(home: string, args: string[]) {
  // Attempt a second database writer immediately after the CLI reads its run.
  // The competing receipt represents a resume already handed to a worker.
  const script = `
    import { Store } from ${JSON.stringify(pathToFileURL(resolve('dist/store.js')).href)};
    const competing = new Store(${JSON.stringify(home)});
    competing.db.exec('PRAGMA busy_timeout=0');
    const readRun = Store.prototype.run;
    let attempted = false;
    Store.prototype.run = function(id) {
      const run = readRun.call(this, id);
      if (!attempted) {
        attempted = true;
        try {
          competing.transaction(() => {
            competing.put('run', id, { ...run, state: 'running', attempt: run.attempt + 1, workerPid: process.pid });
            competing.put('setting', 'competingResume', { runId: id, attempt: run.attempt + 1 });
          });
        } catch (error) {
          if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 5) throw error;
        }
      }
      return run;
    };
    process.argv = [process.execPath, ${JSON.stringify(resolve('dist/cli.js'))}, '--home', ${JSON.stringify(home)}, '--json', ...${JSON.stringify(args)}];
    try { await import(${JSON.stringify(pathToFileURL(resolve('dist/cli.js')).href)}); }
    finally { competing.close(); }
  `;
  const path = join(home, 'competing-cli.mjs');
  writeFileSync(path, script);
  return capture(process.execPath, [path]);
}
describe('public CLI', () => {
  it('explains a disabled scheduler, changes preferences, and rejects invalid values', async () => {
    const f = setup();
    const result = await cli(f.home, ['status']); expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout) as {slots:{occupied:number};activity:{ready:boolean};reasons:string[]};
    expect(status.slots.occupied).toBe(0); expect(status.activity.ready).toBe(false); expect(status.reasons.length).toBeGreaterThan(0);
    expect((await cli(f.home, ['config','set','reservePercent','101'])).code).toBe(1);
    expect((await cli(f.home, ['config','set','runwayHours','12'])).code).toBe(0);
  });
  it('queues a user answer without losing its contents and explicitly releases a failed slot', async () => {
    const f = setup(); f.store.put('run', 'run-1', run(f));
    const answer = "Use the account named O'Reilly. Literal $() and `text` are part of this answer.\nSecond line.";
    const path = join(f.home, 'answer.txt'); writeFileSync(path, answer);
    expect((await cli(f.home, ['answer','run-1','--file',path])).code).toBe(0);
    expect(f.store.run('run-1').answer).toBe(answer); expect(f.store.run('run-1').state).toBe('answer_queued');
    f.store.updateRun('run-1', {state:'failed'});
    expect((await cli(f.home, ['release','run-1','--reason','Resolved manually'])).code).toBe(0);
    expect(f.store.run('run-1').state).toBe('released'); expect(f.store.held()).toHaveLength(0);
  });
  it('does not release an active run, and reports structural skill errors', async () => {
    const f = setup(); f.store.put('run', 'run-1', run(f,{state:'running'}));
    expect((await cli(f.home, ['release','run-1','--reason','Try it'])).code).toBe(1);
    const path = join(f.home,'bad-skill.json'); writeFileSync(path,JSON.stringify({...f.skill,id:'missing',path:join(f.home,'absent.md')}));
    expect((await cli(f.home,['skill','add','--file',path])).code).toBe(1);
  });
  it('requires an explicit inspection before an uncertain session can be resumed', async () => {
    const f = setup(); f.store.put('run','run-1',run(f,{state:'uncertain'}));
    expect((await cli(f.home,['answer','run-1','--text','Continue'])).code).toBe(1);
    expect(f.store.run('run-1').state).toBe('uncertain');
    expect((await cli(f.home,['answer','run-1','--text','Continue','--after-inspection'])).code).toBe(0);
    expect(f.store.run('run-1').state).toBe('answer_queued');
  });
  it('shows a resume failure when the previous attempt has a handoff summary', async () => {
    const f = setup(); f.store.put('run', 'run-1', run(f, {
      state: 'failed', error: 'Native runner exited with code 1',
      outcome: { status: 'needs_input', summary: 'Waiting for an account', question: 'Which account?', workItem: 'account-1', artifacts: [] },
    }));
    const result = await capture(process.execPath, [resolve('dist/cli.js'), '--home', f.home, 'runs', 'run-1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Native runner exited with code 1');
  });
  it('keeps a competing resume from starting while releasing its slot', async () => {
    const f = setup(); f.store.put('run', 'run-1', run(f, { state: 'answer_queued' }));
    const result = await cliWithCompetingResume(f.home, ['release', 'run-1', '--reason', 'Resolved manually']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(f.store.run('run-1').state).toBe('released');
    expect(f.store.get('setting', 'competingResume')).toBeUndefined();
    expect(f.store.held()).toHaveLength(0);
  });
  it('queues an answer without overwriting a competing session launch', async () => {
    const f = setup(); f.store.put('run', 'run-1', run(f));
    const result = await cliWithCompetingResume(f.home, ['answer', 'run-1', '--text', 'Use account 1']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(f.store.run('run-1').state).toBe('answer_queued');
    expect(f.store.run('run-1').answer).toBe('Use account 1');
    expect(f.store.get('setting', 'competingResume')).toBeUndefined();
    expect(f.store.held()).toHaveLength(1);
  });
});
