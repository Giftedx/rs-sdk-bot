import { test, expect } from 'bun:test';
import { buildBrief, claudeArgs, parseClaudeJson, authorLoop, type AuthorDeps } from '../src/author';
import type {DeliveryTask} from '../src/delivery';

const task = { id: 'copper5', goal: 'Mine copper ore until 5 are in the pack.', preset: 'measure_mine', spot: 'SE Varrock mine (3285, 3365), vendor/rs-sdk/learnings/mining.md' };

test('the brief carries the task, the output contract, the file to write, and the example to copy', () => {
    const b = buildBrief(task, 'scripts/generated/copper5.ts');
    expect(b).toContain('<task>');
    expect(b).toContain(task.goal);
    expect(b).toContain('scripts/generated/copper5.ts');
    expect(b).toContain('START');
    expect(b).toContain('RESULT ok');
    expect(b).toContain('scripts/proven/gather.ts');
    expect(b).toContain('docs/script-contract.md');
    expect(b).toContain('docs/plans/joined-plan.md');
    expect(b).toContain('preset pass proves only that scenario');
});

test('the CLI is run headless with only read, write and bun tools allowed', () => {
    const a = claudeArgs('do it');
    expect(a.slice(0, 2)).toEqual(['-p', 'do it']);
    expect(a).toContain('--output-format');
    expect(a.join(' ')).toContain('Bash(bun:*)');
    expect(a.join(' ')).not.toContain('dangerously');
});

test('parseClaudeJson reads the result text and cost, and reports errors', () => {
    expect(parseClaudeJson('{"type":"result","is_error":false,"result":"done","total_cost_usd":0.12}')).toEqual({ ok: true, text: 'done', costUsd: 0.12 });
    expect(parseClaudeJson('not json').ok).toBe(false);
});

test('authorLoop writes, proves, feeds the failure back once, and stops on the first full pass', async () => {
    const prompts: string[] = [];
    let proofs = 0;
    const deps: AuthorDeps = {
        runModel: async p => { prompts.push(p); return { ok: true, text: 'wrote it', costUsd: 0.1 }; },
        prove: async () => { proofs++; return proofs === 1 ? { passes: 1, runs: 3, tail: 'RESULT fail no rock found' } : { passes: 3, runs: 3, tail: 'RESULT ok' }; },
        exists: () => true,
    };
    const r = await authorLoop(task, { maxFixes: 2, proveRuns: 3 }, deps);
    expect(r).toMatchObject({ ok: true, attempts: 2, passes: 3 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('RESULT fail no rock found');
});

test('authorLoop gives up after maxFixes and reports the last failure', async () => {
    const deps: AuthorDeps = {
        runModel: async () => ({ ok: true, text: '', costUsd: 0 }),
        prove: async () => ({ passes: 0, runs: 3, tail: 'RESULT fail stuck' }),
        exists: () => true,
    };
    const r = await authorLoop(task, { maxFixes: 1, proveRuns: 3 }, deps);
    expect(r).toMatchObject({ ok: false, attempts: 2 });
});

test('on Windows the model gets the PowerShell form of the bun and tsc tools too', () => {
    // A live run reported: "The type check did not run, because PowerShell asked for approval".
    const a = claudeArgs('x').join(' ');
    expect(a).toContain('PowerShell(bun:*)');
    expect(a).toContain('PowerShell(bunx tsc:*)');
});

test('a proof where no run printed START is an infrastructure failure: not sent to the model, loop stops', async () => {
    const prompts: string[] = [];
    const deps: AuthorDeps = {
        runModel: async p => { prompts.push(p); return { ok: true, text: '', costUsd: 0 }; },
        prove: async () => ({ passes: 0, runs: 3, tail: 'run 1 FAIL: preset not loaded: no START line | \nrun 2 FAIL: preset not loaded: no START line | \nrun 3 FAIL: preset not loaded: no START line | ' }),
        exists: () => true,
    };
    const r = await authorLoop(task, { maxFixes: 2, proveRuns: 3 }, deps);
    expect(r).toMatchObject({ ok: false, infra: true, attempts: 1 });
    expect(prompts).toHaveLength(1); // the model was never asked to "fix" a server outage
});

test('a preset pass is practice-only and cannot claim a delivered capability',async()=>{
    const r=await authorLoop(task,{maxFixes:0,proveRuns:1},{runModel:async()=>({ok:true,text:'',costUsd:0}),exists:()=>true,prove:async()=>({passes:1,runs:1,tail:'RESULT ok'})});
    expect(r).toMatchObject({ok:true,complete:false,stage:'practice-only'});
});

test('a failed model cannot prove an old file or report delivery',async()=>{
    let proved=false;
    const r=await authorLoop(task,{maxFixes:0,proveRuns:1},{runModel:async()=>({ok:false,text:'usage exhausted',costUsd:0}),exists:()=>true,prove:async()=>{proved=true;return{passes:1,runs:1,tail:'RESULT ok'};}});
    expect(r.ok).toBe(false);expect(proved).toBe(false);
});

test('an empty proof cannot pass by comparing zero with zero',async()=>{
    const r=await authorLoop(task,{maxFixes:0,proveRuns:1},{runModel:async()=>({ok:true,text:'',costUsd:0}),exists:()=>true,prove:async()=>({passes:0,runs:0,tail:''})});
    expect(r.ok).toBe(false);
});

const delivery:DeliveryTask={id:'copper',goal:task.goal,entry:'scripts/gather-ore.ts',files:['scripts/gather-ore.ts','packages/core/src/deposit.ts'],consumer:'smithing',checks:[]};
test('a declared diagnostic returns evidence to the author before full acceptance',async()=>{
 const order:string[]=[],prompts:string[]=[];let calls=0;
 const r=await authorLoop({...task,delivery:{...delivery,checks:[{id:'observe',phase:'practice',command:['bun','observe.ts'],timeoutMs:1000}]}},{maxFixes:2,proveRuns:1},{exists:()=>true,
  runModel:async p=>{prompts.push(p);order.push('author');return{ok:true,costUsd:0,text:JSON.stringify(++calls===1?{status:'diagnostic',checkId:'observe',summary:'observer ready'}:{status:'ready',summary:'trace-derived repair'})};},
  prove:async()=>{throw Error('wrong path');},
  diagnose:async(_t,id)=>{order.push(id);return{ok:false,stage:'failed',evidence:'native',consumer:'smithing',reason:'diagnostic complete; acceptance not run',diagnostic:{checkId:id,complete:true},checks:[{id,phase:'practice',exitCode:0,detail:'retained-trace.json'}]};},
  deliver:async()=>{order.push('full');return{ok:true,stage:'delivered',evidence:'native',consumer:'smithing',reason:'verified',checks:[]};}});
 expect(order).toEqual(['author','observe','author','full']);expect(prompts[1]).toContain('retained-trace.json');expect(r.ok).toBe(true);
});
test('a blocked or unclassified capability author cannot launch delivery or replay old files',async()=>{
 for(const text of [JSON.stringify({status:'blocked',reason:'Retained fishing state cannot distinguish the cause',requiredChange:'Declare an isolated diagnostic with server queue and roll observations'}),
  'Repair and live delivery remain incomplete. All 13 owned files remain unchanged. The missing boundary is a separately declared harness diagnostic.',
  '',JSON.stringify({status:'blocked',reason:''}),JSON.stringify({status:'unknown'})]){
  let models=0,deliveries=0,proofs=0;
  const r=await authorLoop({...task,delivery},{maxFixes:2,proveRuns:1,repairRegressions:true},{exists:()=>true,
   runModel:async()=>{models++;return{ok:true,text,costUsd:0};},
   prove:async()=>{proofs++;return{passes:1,runs:1,tail:''};},
   deliver:async()=>{deliveries++;return{ok:true,stage:'delivered',evidence:'native',consumer:'smithing',reason:'must never launch',checks:[]};}});
  expect(r.ok).toBe(false);expect(r.complete).toBe(false);expect(r.delivery).toBeUndefined();
  expect(models).toBe(1);expect(deliveries).toBe(0);expect(proofs).toBe(0);
  if(text.includes('requiredChange'))expect(r).toMatchObject({blocked:{requiredChange:'Declare an isolated diagnostic with server queue and roll observations'}});
 }
});

test('diagnostic failures, invalid selection, missing runner, repeated requests and final-turn requests stop acceptance',async()=>{
 for(const mode of ['failure','invalid','missing','repeat','final']){
  let calls=0,diagnostics=0,deliveries=0;
  const result=await authorLoop({...task,delivery:{...delivery,checks:[{id:'observe',phase:'practice',command:['bun','observe.ts'],timeoutMs:1}]}},{maxFixes:mode==='final'?0:2,proveRuns:1},{exists:()=>true,
   runModel:async()=>{calls++;return{ok:true,costUsd:0,text:JSON.stringify({status:'diagnostic',checkId:mode==='invalid'?'unknown':'observe',summary:'observe'})};},prove:async()=>{throw Error('wrong path');},
   diagnose:mode==='missing'?undefined:async(_t,id)=>{diagnostics++;return{ok:false,stage:'failed',evidence:'native',consumer:'smithing',reason:'raw retained',diagnostic:{checkId:id,complete:mode!=='failure'},checks:[]};},
   deliver:async()=>{deliveries++;throw Error('must not run');}});
  expect(result.ok).toBe(false);expect(deliveries).toBe(0);expect(diagnostics).toBe(mode==='repeat'||mode==='failure'?1:0);expect(calls).toBe(mode==='repeat'?2:1);
  if(mode==='repeat'||mode==='failure')expect(result.diagnostic).toBeDefined();
 }
});
test('capability author owns explicit shared files and needs consumer delivery',async()=>{
    const capability={...task,delivery},brief=buildBrief(capability,delivery.entry);
    expect(brief).toContain('packages/core/src/deposit.ts');expect(brief).not.toContain('Write exactly one file');
    expect(brief).toContain('Preserve existing command arguments');expect(brief).not.toContain('Call openBot first');
    let proved=false,delivered=0;
    const r=await authorLoop(capability,{maxFixes:2,proveRuns:3},{exists:()=>true,runModel:async()=>({ok:true,text:JSON.stringify({status:'ready',summary:'implemented owned change'}),costUsd:0}),prove:async()=>{proved=true;return{passes:3,runs:3,tail:''};},deliver:async()=>{delivered++;return{ok:false,stage:'failed',evidence:'native',consumer:'smithing',reason:'consumer missing stock',checks:[]};}});
    expect(r).toMatchObject({ok:false,complete:false,stage:'failed',attempts:1});expect(proved).toBe(false);expect(delivered).toBe(1);
});
test('capability delivery cannot silently fall back to preset success',async()=>{
    const r=await authorLoop({...task,delivery},{maxFixes:0,proveRuns:1},{exists:()=>true,runModel:async()=>({ok:true,text:JSON.stringify({status:'ready',summary:'implemented owned change'}),costUsd:0}),prove:async()=>({passes:1,runs:1,tail:''})});
    expect(r).toMatchObject({ok:false,complete:false});expect(r.lastTail).toContain('runner missing');
});
test('an owned build repairs a concrete regression without another numbered queue job',async()=>{
 let calls=0,checks=0;const prompts:string[]=[];
 const r=await authorLoop({...task,delivery},{maxFixes:2,proveRuns:1,repairRegressions:true},{exists:()=>true,
  runModel:async p=>{calls++;prompts.push(p);return{ok:true,text:JSON.stringify({status:'ready',summary:'fixed regression'}),costUsd:0};},prove:async()=>{throw Error('wrong proof path');},
  deliver:async()=>{checks++;return checks===1?{ok:false,stage:'failed',evidence:'native',consumer:'smithing',reason:'check failed',failedCheck:'regression',checks:[{id:'regression',phase:'regression',exitCode:1,detail:'retained-error.log'}]}:{ok:true,stage:'delivered',evidence:'native',consumer:'smithing',reason:'verified',checks:[]};}});
 expect(r.ok).toBe(true);expect(calls).toBe(2);expect(prompts[1]).toContain('retained-error.log');
});
test('native capacity failures never trigger automatic source rewrites',async()=>{
 let calls=0;const r=await authorLoop({...task,delivery},{maxFixes:2,proveRuns:1,repairRegressions:true},{exists:()=>true,runModel:async()=>{calls++;return{ok:true,text:JSON.stringify({status:'ready',summary:'implemented owned change'}),costUsd:0};},prove:async()=>{throw Error('wrong path');},
  deliver:async()=>({ok:false,stage:'failed',evidence:'native',consumer:'smithing',reason:'insufficient reserve',failedCheck:'native',checks:[{id:'native',phase:'practice',exitCode:1,detail:'reserve.log'}]})});
 expect(r.ok).toBe(false);expect(calls).toBe(1);
});
test('source changes after a passing regression do not request a speculative rewrite',async()=>{
 let calls=0;await authorLoop({...task,delivery},{maxFixes:2,proveRuns:1,repairRegressions:true},{exists:()=>true,runModel:async()=>{calls++;return{ok:true,text:JSON.stringify({status:'ready',summary:'implemented owned change'}),costUsd:0};},prove:async()=>{throw Error('wrong path');},
  deliver:async()=>({ok:false,stage:'failed',evidence:'native',consumer:'smithing',reason:'source changed',failedCheck:'regression',checks:[{id:'regression',phase:'regression',exitCode:0,detail:'passed'}]})});expect(calls).toBe(1);
});
