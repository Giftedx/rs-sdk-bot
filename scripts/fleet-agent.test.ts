import {expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readAgentJobs,swarmBusy,tradeEnvironment} from './fleet-agent';

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
