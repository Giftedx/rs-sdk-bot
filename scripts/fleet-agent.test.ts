import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {agentAlive,readAgentJobs,swarmBusy,syncResult,tradeEnvironment,tradeStop} from './fleet-agent';
import {SWARM_STOP} from './swarm';

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
test('a trade runs with the idle guard off, whatever the agent inherited: its order window bounds the wait for its partner',()=>{
 expect(tradeEnvironment('/fleet',{STALL_TICKS:'900'},'current').STALL_TICKS).toBe('0');
 expect(tradeEnvironment('/fleet',{},'current').STALL_TICKS).toBe('0');
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

test('before a trade the agent removes the swarm\'s own stop file once the account is offline; an owner\'s file and a live run hold the trade',()=>{
 const base=mkdtempSync(join(tmpdir(),'fleet-agent-stop-')),prac=join(base,'.practice'),stop=(a:string)=>join(prac,'stop-'+a),now=1_000_000;
 const status=(a:string,row:object)=>writeFileSync(join(prac,'status',a+'.json'),JSON.stringify(row));
 try{
  mkdirSync(join(prac,'status'),{recursive:true});
  // No stop file: nothing to do.
  expect(tradeStop(base,'Fatstack',now)).toEqual({cleared:false});
  // The planner took Quickhandjob off its job for an order; its run has ended with a RESULT.
  writeFileSync(stop('Quickhandjob'),SWARM_STOP.removed);status('Quickhandjob',{at:now-5_000,result:'RESULT ok'});
  expect(tradeStop(base,'Quickhandjob',now)).toEqual({cleared:true});expect(existsSync(stop('Quickhandjob'))).toBe(false);
  // No status row at all counts as offline.
  writeFileSync(stop('Deeppockets'),SWARM_STOP.removed);
  expect(tradeStop(base,'Deeppockets',now)).toEqual({cleared:true});
  // A run that is still ending keeps the file, and the trade waits.
  writeFileSync(stop('Fingersmith'),SWARM_STOP.removed);status('Fingersmith',{at:now-5_000});
  expect(tradeStop(base,'Fingersmith',now)).toEqual({held:'its last run is still ending',cleared:false});expect(existsSync(stop('Fingersmith'))).toBe(true);
  // Once its status is 30 s old with no result the session is gone.
  expect(tradeStop(base,'Fingersmith',now+30_000)).toEqual({cleared:true});
  // An owner's stop file is never removed.
  writeFileSync(stop('TheFullMonty'),'hold offline until the GE pilot');
  expect(tradeStop(base,'TheFullMonty',now)).toEqual({held:'owner stop file',cleared:false});expect(readFileSync(stop('TheFullMonty'),'utf8')).toBe('hold offline until the GE pilot');
 }finally{rmSync(base,{recursive:true,force:true});}
});
