import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig } from '../src/files.js';
import { runWorker } from '../src/runner.js';
import { admit, eligibility } from '../src/scheduler.js';
import { fixture, NOW, quota, run } from './helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
  const f = fixture(); fixtures.push(f);
  const binary = join(f.home, 'fake-claude');
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='auth') { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'person@example.com'})); process.exit(0); }
let input=''; process.stdin.on('data',s=>input+=s); process.stdin.on('end',()=>{
  const session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
  const mode=fs.readFileSync('behavior.txt','utf8').trim();
  fs.appendFileSync('calls.jsonl',JSON.stringify({session,args,cwd:process.cwd(),inputBytes:Buffer.byteLength(input)})+'\\n');
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));
  if(mode==='malformed') { console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{status:'completed'}})); return; }
  if(mode==='rate-limit') { console.log(JSON.stringify({type:'error',error:{type:'rate_limit_error'}})); process.exitCode=1; return; }
  const resume=args.includes('--resume');
  const status=mode==='handoff'&&!resume?'needs_input':'completed';
  if(status==='completed') fs.writeFileSync('artifact.md','Reviewed the selected account.');
  console.log(JSON.stringify({type:'result',subtype:'success',session_id:session,structured_output:{status,summary:'One account processed',question:status==='needs_input'?'Which account?':null,workItem:'account-1',artifacts:status==='completed'?[process.cwd()+'/artifact.md']:[]}}));
});
`); chmodSync(binary, 0o700);
  f.config.providers.claude!.binary = binary;
  f.config.providers.codex = undefined;
  f.skill.providers = ['claude']; f.config.skills = [f.skill];
  saveConfig(f.home, f.config);
  return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.home, { recursive: true, force: true }); } });
describe('native worker integration', () => {
  it('runs a real child process and writes a useful artifact receipt', async () => {
    const f = setup(); writeFileSync(join(f.home, 'behavior.txt'), 'complete');
    f.store.put('run', 'run-1', run(f, { state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-1');
    const receipt = f.store.run('run-1'); expect(receipt.state).toBe('completed'); expect(receipt.sessionId).toBe('run-1');
    expect(readFileSync(receipt.outcome!.artifacts[0]!, 'utf8')).toBe('Reviewed the selected account.');
  });
  it('holds a handoff then resumes the same child session after the answer is admitted', async () => {
    const f = setup(); writeFileSync(join(f.home, 'behavior.txt'), 'handoff');
    f.store.put('run', 'run-1', run(f, { state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-1'); expect(f.store.run('run-1').state).toBe('needs_input'); expect(f.store.held()).toHaveLength(1);
    f.store.updateRun('run-1', { state: 'answer_queued', answer: 'Use account 1' });
    const candidates = eligibility(f.config, { claude: { quota: quota() } }, { ready: true }, f.store, NOW).candidates;
    admit(f.store, f.config, candidates, NOW);
    await runWorker(f.home, 'run-1'); expect(f.store.run('run-1').state).toBe('completed'); expect(f.store.held()).toHaveLength(0);
    const calls = readFileSync(join(f.home, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as {session:string});
    expect(calls.map(call => call.session)).toEqual(['run-1','run-1']);
  });
  it('retains failed slots when output is malformed and quota slots when resumption is possible', async () => {
    const f = setup(); writeFileSync(join(f.home, 'behavior.txt'), 'malformed');
    f.store.put('run', 'run-1', run(f, { state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-1'); expect(f.store.run('run-1').state).toBe('failed');
    writeFileSync(join(f.home, 'behavior.txt'), 'rate-limit');
    f.store.put('run', 'run-2', run(f, { id: 'run-2', state: 'launching', sessionId: undefined }));
    await runWorker(f.home, 'run-2'); expect(f.store.run('run-2').state).toBe('quota_wait'); expect(f.store.held()).toHaveLength(2);
  });
});
