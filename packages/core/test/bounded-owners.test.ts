import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {observeBoundedOwners,boundedProcessAlive} from '../src/bounded-owners';
import {prepareCoinProofRoot,removeCoinProofRoot} from '../../practice/src/coin-courier-proof';
import {killTree} from '../src/proc';
import {initialState} from '../../router/src/coordinator';
const source=resolve(import.meta.dir,'../../..');
test('a journaled successor, unknown owner or surviving child cannot prove bounded shutdown',()=>{
 const base=mkdtempSync(join(tmpdir(),'bounded-owners-')),dir=join(base,'.practice/coordinator');mkdirSync(dir,{recursive:true});
 const binding={watchId:randomUUID(),plan:join(base,'handoff.json'),side:'cloud'};
 writeFileSync(join(dir,'owner.json'),JSON.stringify({...binding,pid:11,nonce:'old',successor:{pid:22,nonce:'reload-new'}}));
 writeFileSync(join(dir,'state.json'),JSON.stringify({tasks:[]}));
 const deps={alive:(pid:number)=>pid===22,command:(pid:number)=>pid===22?`${join(base,'packages/router/src/coordinator-cli.ts')} --run reload-new`:null,groups:()=>[22]};
 expect(observeBoundedOwners(base,binding,[{pid:11,nonce:'old'}],deps)).toMatchObject({known:true,settled:false,active:[22]});
 expect(observeBoundedOwners(base,binding,[],{...deps,command:()=>null})).toMatchObject({known:false,settled:false});
 expect(observeBoundedOwners(base,binding,[],{...deps,alive:()=>false,groups:()=>[33]})).toMatchObject({known:true,settled:false,active:[33]});
 writeFileSync(join(dir,'swarm-owner.json'),JSON.stringify({pid:33,nonce:'prior-swarm',watchId:'prior-watch',plan:'prior-plan',side:'cloud'}));
 expect(observeBoundedOwners(base,binding,[],{...deps,groups:()=>[]})).toMatchObject({known:true,settled:false,active:[22]});
 expect(observeBoundedOwners(base,binding,[],{...deps,groups:ids=>ids.includes(33)?[44]:[]})).toMatchObject({known:false,settled:false});
 unlinkSync(join(dir,'swarm-owner.json'));
 expect(observeBoundedOwners(base,{...binding,plan:'wrong'},[],deps)).toMatchObject({known:false,settled:false});
 writeFileSync(join(dir,'owner.json'),'partial');
 expect(observeBoundedOwners(base,binding,[],deps)).toMatchObject({known:false,settled:false});
 rmSync(base,{recursive:true,force:true});
});
test.skipIf(process.platform!=='linux')('actual coordinator restart keeps the selected-plan stop fence through successor claim and exit',async()=>{
 const base=prepareCoinProofRoot(source,tmpdir()),dir=join(base,'.practice/coordinator'),plan=join(base,'handoff.json'),watchId=randomUUID(),nonce=randomUUID();
 const scope={targets:[{account:'Rod',attemptId:'1794807014059-0000010716-0000000001',endedAt:1794807014127}],taskIds:['qualify-rod','recover-rod']};
 const binding={watchId,plan,side:'cloud'},env={...process.env,FLEET_SIDE:'cloud',FLEET_DIR:join(base,'fleet'),SWARM_PLAN:plan,CLOUD_WATCH_ID:watchId};
 writeFileSync(plan,JSON.stringify({maxBots:4,minFreeGB:4,jobs:[],coordination:{enabled:true,boundedRecovery:scope,bootstrap:[]}}));
 writeFileSync(join(dir,'state.json'),JSON.stringify(initialState()));
 if(existsSync(join(base,'.git')))unlinkSync(join(base,'.git'));
 const cli=join(base,'packages/router/src/coordinator-cli.ts'),child=Bun.spawn([process.execPath,cli,'--run',nonce],{cwd:base,env,stdout:Bun.file(join(base,'initial.log')),stderr:Bun.file(join(base,'initial.err')),detached:true});
 let successor=0,passed=false;
 const wait=async(check:()=>boolean,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await Bun.sleep(10);}throw Error('bounded reload fixture timeout');};
 try{
  await wait(()=>{try{return JSON.parse(readFileSync(join(dir,'owner.json'),'utf8')).watchId===watchId;}catch{return false;}});
  expect(Bun.spawnSync([process.execPath,cli,'--restart'],{cwd:base,env,stdout:'pipe',stderr:'pipe'}).exitCode).toBe(0);
  await wait(()=>{try{const o=JSON.parse(readFileSync(join(dir,'owner.json'),'utf8'));successor=o.successor?.pid??(o.pid!==child.pid?o.pid:0);return successor>0&&!boundedProcessAlive(child.pid);}catch{return false;}});
  process.kill(successor,'SIGSTOP');
  const fence=join(base,'.practice/stop-swarm');writeFileSync(fence,'swarm stopped');
  const during=observeBoundedOwners(base,binding,[{pid:child.pid,nonce}]);
  expect(during.settled).toBe(false);expect(readFileSync(fence,'utf8')).toBe('swarm stopped');
  process.kill(successor,'SIGCONT');
  await wait(()=>observeBoundedOwners(base,binding,[{pid:child.pid,nonce}]).settled);
  expect(readFileSync(fence,'utf8')).toBe('swarm stopped');
  expect(existsSync(join(base,'.practice/swarm-runs.json'))).toBe(false);
  passed=true;
 }finally{
  if(boundedProcessAlive(child.pid))await killTree(child.pid);
  if(successor&&boundedProcessAlive(successor)){process.kill(successor,'SIGCONT');await killTree(successor);}
  await child.exited;
  if(passed)expect(removeCoinProofRoot(base)).toBe(true);else console.error('bounded reload retained fixture '+base);
 }
},30000);
