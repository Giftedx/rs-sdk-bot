import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {agentAlive,readAgentJobs,swarmBusy,syncResult,tradeEnvironment} from './fleet-agent';

test('agent refuses an unreadable custom plan instead of treating its accounts as idle',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-agent-plan-')),file=join(dir,'cloud.json');
 try{
  expect(()=>readAgentJobs(file)).toThrow();writeFileSync(file,'{"jobs":[{"account":"Cloud","enabled":true}]}');
  expect(swarmBusy(readAgentJobs(file)).has('cloud')).toBe(true);
  writeFileSync(file,'{}');expect(()=>readAgentJobs(file)).toThrow('invalid swarm plan');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('trade launch replaces a stale release pin while preserving fleet side and directory',()=>{
 const env=tradeEnvironment('/fleet',{FLEET_SIDE:'cloud',WORKER_RELEASE:'old'},'current');
 expect(env).toMatchObject({FLEET_SIDE:'cloud',FLEET_DIR:'/fleet',WORKER_RELEASE:'current'});
});

test('a sync child reports its own RESULT line, or its exit code when it printed none',()=>{
 expect(syncResult('pulling\nRESULT ok fleet-sync side=claude-cloud accounts=4 lease=none committed=false pushed=false\n',0)).toBe('RESULT ok fleet-sync side=claude-cloud accounts=4 lease=none committed=false pushed=false');
 expect(syncResult('error: cannot pull\n',1)).toBe('RESULT fail fleet-sync exit 1');
});

test('a lock PID counts as a running agent only while that PID still runs a fleet agent',()=>{
 expect(agentAlive(process.pid,()=>'bun\0scripts/fleet-agent.ts\0')).toBe(true);
 expect(agentAlive(process.pid,()=>'bun\0scripts/swarm.ts\0plan.json\0')).toBe(false);
 expect(agentAlive(process.pid,()=>undefined)).toBe(true);
 expect(agentAlive(2**22+12345,()=>'bun\0scripts/fleet-agent.ts\0')).toBe(false);
});
