import {expect,test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AGENT_LOG_DIRECT,agentAlive,agentDaemonEnv,agentLog,readAgentJobs,swarmBusy,syncResult,tradeEnvironment,tradeStop} from './fleet-agent';
import {SWARM_STOP} from './swarm';
import {leanBunEnv} from '../packages/core/src/lean-bun-env';
import {serviceWanted} from '../packages/core/src/route-query';

test('a daemon agent writes each line to its log file and not also to the console; a foreground agent prints it',()=>{
 const calls:string[]=[];
 const io={append:(f:string,t:string)=>{calls.push(`append ${f} ${JSON.stringify(t)}`);},out:(l:string)=>{calls.push(`out ${l}`);},err:(t:string)=>{calls.push(`err ${JSON.stringify(t)}`);}};
 const daemon=agentLog('/p/fleet-agent.log',true,io);
 daemon('FLEET_AGENT sync RESULT ok');daemon('trade stderr','err');
 expect(calls).toEqual(['append /p/fleet-agent.log "FLEET_AGENT sync RESULT ok\\n"','append /p/fleet-agent.log "trade stderr\\n"']);
 calls.length=0;
 const foreground=agentLog('/p/fleet-agent.log',false,io);
 foreground('FLEET_AGENT start Fatstack order o1');foreground('trade stderr','err');
 expect(calls).toEqual(['out FLEET_AGENT start Fatstack order o1','err "trade stderr\\n"']);
 calls.length=0;
 const refused=agentLog('/p/fleet-agent.log',true,{...io,append:()=>{throw new Error('EBUSY');}});
 refused('FLEET_AGENT kept');
 expect(calls).toEqual(['out FLEET_AGENT kept']);
});

test('the daemon child and its reload successors get the direct-log flag; the parent environment stays as it was',()=>{
 const parent={FLEET_SIDE:'local'};
 expect(agentDaemonEnv(parent)).toEqual({FLEET_SIDE:'local',[AGENT_LOG_DIRECT]:'1'});
 expect(parent).toEqual({FLEET_SIDE:'local'});
});

test('a child whose stdout and stderr are the log file writes each line there once, with the flag and without it',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-agent-log-')),file=join(dir,'fleet-agent.log');
 const code=`const {agentLog,AGENT_LOG_DIRECT}=await import(${JSON.stringify(join(import.meta.dir,'..','packages','fleet','src','fleet-agent.ts'))});
const log=agentLog(${JSON.stringify(file)},process.env[AGENT_LOG_DIRECT]==='1');log('FLEET_AGENT one');log('FLEET_AGENT two','err');`;
 const run=(env:NodeJS.ProcessEnv)=>{const fd=openSync(file,'a');try{return spawnSync(process.execPath,['-e',code],{stdio:['ignore',fd,fd],env,windowsHide:true,timeout:30_000});}finally{closeSync(fd);}};
 try{
  const without={...process.env};delete without[AGENT_LOG_DIRECT];
  for(const env of [agentDaemonEnv(process.env),without]){
   writeFileSync(file,'');
   expect(run(env).status).toBe(0);
   expect(readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean)).toEqual(['FLEET_AGENT one','FLEET_AGENT two']);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

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

test('a transfer keeps unrelated loot and random events off even when the agent inherited them enabled',()=>{
 for(const inherited of [{},{LOOT_WATCH:'1',RANDOM_EVENTS:'1'}]){
  expect(tradeEnvironment('/fleet',inherited,'current')).toMatchObject({LOOT_WATCH:'0',RANDOM_EVENTS:'0'});
 }
});

test('trade workers delegate routing to route-service by default and honor explicit ROUTE_SERVICE=0 overrides',()=>{
 const defaultEnv=leanBunEnv(tradeEnvironment('/fleet',{},'current'));
 expect(defaultEnv.ROUTE_SERVICE).toBe('1');
 expect(serviceWanted(defaultEnv)).toBe(true);
 const emptyEnv=tradeEnvironment('/fleet',{ROUTE_SERVICE:''},'current');
 expect(emptyEnv.ROUTE_SERVICE).toBe('1');
 expect(serviceWanted(emptyEnv)).toBe(true);
 const disabledEnv=leanBunEnv(tradeEnvironment('/fleet',{ROUTE_SERVICE:'0'},'current'));
 expect(disabledEnv.ROUTE_SERVICE).toBe('0');
 expect(serviceWanted(disabledEnv)).toBe(false);
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
  // Case-insensitive status file lookup in .practice/live/status holds trade while run is ending.
  mkdirSync(join(prac,'live','status'),{recursive:true});
  writeFileSync(join(prac,'live','stop-MixedBot'),SWARM_STOP.removed);
  writeFileSync(join(prac,'live','status','mixedbot.json'),JSON.stringify({at:now-5_000}));
  expect(tradeStop(base,'MixedBot',now)).toEqual({held:'its last run is still ending',cleared:false});
 }finally{rmSync(base,{recursive:true,force:true});}
});
