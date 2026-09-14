import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { capture } from '../src/process.js';
import { saveConfig } from '../src/files.js';
import { fixture, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() { const f = fixture(); fixtures.push(f); saveConfig(f.home, f.config); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
const cli = async (home: string, args: string[]) => capture(process.execPath, [resolve('dist/cli.js'), '--home', home, '--json', ...args]);
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
});
