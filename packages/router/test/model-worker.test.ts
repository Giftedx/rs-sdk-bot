import {test,expect} from 'bun:test';
import {codexArgs,assignedWorker,rejectedReview,modelFailure} from '../src/model-worker';
import {reviewDependencies,reviewVerdict} from '../src/model-worker';
import {initialState,addTasks,validateTask} from '../src/coordinator';
import {waitForWork} from '../src/coordinator-cli';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('a completed job wakes dispatch without waiting for the fallback timer',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'queue-event-'));let deadlineElapsed=false;
 const marker=setTimeout(()=>{deadlineElapsed=true;},1500);
 const waiting=waitForWork(5000,directory);setTimeout(()=>writeFileSync(join(directory,'receipt.json'),'{}'),50);
 await waiting;clearTimeout(marker);expect(deadlineElapsed).toBe(false);
},6000);
test('headless Codex uses stdin, captured results and ChatGPT auth without an API key',()=>{
 const args=codexArgs('result.txt',true);
 expect(args).toContain('forced_login_method="chatgpt"');expect(args).toContain('read-only');expect(args.at(-1)).toBe('-');expect(args).toContain('--output-last-message');
 expect(codexArgs('result.txt',false)).toContain('danger-full-access');
 expect(args).toContain('mcp_servers.blender={command="cmd.exe",enabled=false}');expect(args).toContain('mcp_servers.node_repl={command="cmd.exe",enabled=false}');
 expect(args).toContain('plugins."unified-computer-use@openai-bundled".enabled=false');
 expect(args).toContain('mcp_servers.cua_repl={command="cmd.exe",enabled=false}');
});
test('failed model turns report their real structured cause instead of unrelated MCP shutdown warnings',()=>{
 const events=JSON.stringify({type:'turn.failed',error:{message:'Incomplete response returned, reason: max_output_tokens'}});
 expect(modelFailure(events,'MCP Auth required during shutdown',false)).toContain('max_output_tokens');expect(modelFailure(events,'other',true)).toBe('model deadline exceeded');
});
test('both agents take builds from one queue and explicit ownership wins',()=>{
 expect(assignedWorker('build',[])).toBe('codex');
 expect(assignedWorker('build',[{spec:{kind:'build'},agent:'codex'}])).toBe('claude');
 expect(assignedWorker('build',[{spec:{kind:'build'}}])).toBe('codex');
 expect(assignedWorker('build',[],'claude')).toBe('claude');expect(assignedWorker('qualify',[])).toBe('codex');
 const s=initialState(),task={id:'shared',goal:'quests' as const,kind:'build' as const,capability:'quest-order',agent:'codex' as const,priority:2,estimatedMs:1,dependsOn:[],why:'reusable quest consumer'};
 addTasks(s,[task]);expect(s.tasks[0]!.spec.agent).toBe('codex');expect(()=>validateTask({...task,agent:'other' as any})).toThrow('agent');
});
test('a failed independent review blocks that source until repaired or superseded by fresh approval',()=>{
 const bad={evidence:'source-review',source:'same',_task:{capability:'ge',at:1},review:{approved:false,reason:'unfilled escrow'}};
 expect(rejectedReview({bad},'ge','same')).toBe('unfilled escrow');expect(rejectedReview({bad},'ge','repaired')).toBeNull();
 expect(rejectedReview({bad,good:{...bad,_task:{capability:'ge',at:2},review:{approved:true}}},'ge','same')).toBeNull();
});

test('a review carries only its capability history and dependencies, newest first, within the input cap',()=>{
 const deps:Record<string,any>={
  'qualify-x-1':{ok:true,delivery:{id:'x'},_task:{capability:'x',at:1}},
  'review-x-2':{ok:false,review:{approved:false,reason:'r'},_task:{capability:'x',at:2}},
  'build-y-1':{ok:true,delivery:{id:'y'},_task:{capability:'y',at:3}},
  'dep-z':{ok:true,_task:{capability:'z',at:4}},
 };
 const picked=reviewDependencies(deps,'x',['dep-z']);
 expect(Object.keys(picked)).toEqual(['dep-z','review-x-2','qualify-x-1']);
 expect(Object.keys(reviewDependencies(deps,'x',['dep-z'],60))).toEqual(['dep-z']);
});
test('historical review receipts keep the source, check results and full receipt path without large snapshots',()=>{
 const files=Array.from({length:20},(_,i)=>`packages/old-source-${i}.ts`);
 const direct={_task:{capability:'x',at:4,evidence:'/runs/direct'},delivery:{id:'x',files:['direct.ts']}};
 const prior={_task:{capability:'x',at:3,evidence:'/runs/prior'},delivery:{id:'x',source:'pinned',files,
  checks:[{id:'native',exitCode:1,detail:'stderr.log'}]},status:{at:3,result:'fail blocked',inventory:files}};
 const newerWithoutPath={_task:{capability:'x',at:5},status:{inventory:files}};
 const selected=reviewDependencies({direct,newerWithoutPath,prior},'x',['direct'],440);
 expect(Object.keys(selected)).toEqual(['direct','prior']);
 expect(selected.direct).toEqual(direct);
 expect(selected.prior).toEqual({_task:prior._task,
  delivery:{id:'x',source:'pinned',checks:prior.delivery.checks},status:{at:3,result:'fail blocked'}});
 expect(JSON.stringify(selected).length).toBeLessThanOrEqual(440);
 expect(prior.delivery.files).toEqual(files);
});
test('a failed or malformed model answer is a failed review, not a rejection',()=>{
 expect(()=>reviewVerdict({ok:false,text:'turn/start failed: Input exceeds the maximum length'},JSON.parse)).toThrow('review model unavailable');
 expect(()=>reviewVerdict({ok:true,text:'I rejected it.'},t=>({text:t}))).toThrow('malformed');
 expect(reviewVerdict({ok:true,text:'{"approved":false,"reason":"defect at a.ts:1"}'},JSON.parse)).toEqual({approved:false,reason:'defect at a.ts:1'});
 expect(reviewVerdict({ok:true,text:'{"approved":true}'},JSON.parse)).toEqual({approved:true,reason:''});
});
