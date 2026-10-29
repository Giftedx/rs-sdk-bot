import {test,expect} from 'bun:test';
import {codexArgs,assignedWorker,rejectedReview,modelFailure} from '../src/model-worker';
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
