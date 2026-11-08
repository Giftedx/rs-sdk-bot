import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {liveLogoutRef} from '../src/coordinator-session';
import {installJob} from '../src/coordinator-live';
import {sha} from '../../core/src/launch-evidence';
import {missionSignature} from '../../core/src/session-admission';
import {assertSpecialistLogin, specialistContext, specialistTokenPath} from '../../core/src/specialist-launch';
const server='rs-sdk-demo.fly.dev';
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'router-session-')),root=join(base,'.practice/session-lifecycle');
 mkdirSync(join(base,'.practice/status'),{recursive:true});mkdirSync(join(base,'.practice/coordinator/runs/test'),{recursive:true});
 const status=(name:string,value:any)=>writeFileSync(join(base,'.practice/status',name+'.json'),JSON.stringify({name,server,...value}));
 const attempt=(name:string)=>beginSessionAttempt({account:name,server},{root});
 return{base,root,status,attempt};
}
test('a producer outcome is required despite a successful RESULT; absent status cannot hide a partial attempt',()=>{
 const f=fixture();f.status('Rod',{result:'ok old work'});
 expect(()=>liveLogoutRef('Rod',f.base)).toThrow('legacy');
 const old=f.attempt('Rod');old.record('ended','logged-out');expect(liveLogoutRef('Rod',f.base)).toEqual({kind:'producer',attemptId:old.attemptId});
 const next=f.attempt('Rod');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not confirmed');
 old.record('closed');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not confirmed');
 next.record('ended','disconnected');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('disconnected');
 f.attempt('Partner');expect(()=>liveLogoutRef('Partner',f.base)).toThrow('not confirmed');
});
test('crossed status and practice evidence never authorize live admission',()=>{
 const f=fixture();beginSessionAttempt({account:'Rod',server:'localhost:8888'},{root:f.root}).record('ended','logged-out');
 f.status('Rod',{result:'ok',sessionAttemptId:'old'});expect(()=>liveLogoutRef('Rod',f.base)).toThrow('legacy');
 f.attempt('Rod').record('ended','logged-out');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not covered');
 f.status('Rod',{result:'ok',started:Date.now()+10000});expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not covered');
});
test('fresh identities can enter but recovery always requires a proof',()=>{
 const f=fixture();expect(liveLogoutRef('Fresh',f.base)).toBeNull();expect(()=>liveLogoutRef('Fresh',f.base,true)).toThrow('legacy');
});
test('a newer failed readiness attempt with observed logout can cover an older status',()=>{
 const f=fixture(),first=f.attempt('Rod');first.record('ended','logged-out');
 f.status('Rod',{result:'ok old',sessionAttemptId:first.attemptId,started:1});
 const next=f.attempt('Rod');next.record('ready-failed');next.record('ended','logged-out');
 expect(liveLogoutRef('Rod',f.base)).toEqual({kind:'producer',attemptId:next.attemptId});
});
test('hash-bound anonymous legacy bootstrap refuses; a new producer attempt still supersedes it',()=>{
 const f=fixture(),statusPath=join(f.base,'.practice/status/Rod.json'),logPath=join(f.base,'historical.log');
 f.status('Rod',{result:'ok old',at:10});writeFileSync(logPath,'START 1 2 0\nLOGOUT logged-out\nRESULT ok old\n');
 const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const claim={kind:'legacy-logout' as const,account:'Rod',server,statusPath,statusSha256:hash(statusPath),statusAt:10,logPath,logSha256:hash(logPath)};
 const dir=join(f.base,'.practice/coordinator/session-proofs');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'rod.json'),JSON.stringify(claim));
 expect(()=>liveLogoutRef('Rod',f.base,true)).toThrow('anonymous legacy log');
 writeFileSync(logPath,'START 1 2 0\nLOGOUT timeout\nRESULT fail old\n');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('hash changed');
 writeFileSync(logPath,'START 1 2 0\nLOGOUT logged-out\nRESULT ok old\n');
 f.attempt('Rod');expect(()=>liveLogoutRef('Rod',f.base)).toThrow('not confirmed');
});
test('installation checks every participant and the durable failed-script history without mutating the plan',()=>{
 const f=fixture(),plan={maxBots:17,minFreeGB:0,jobs:[]},path=join(f.base,'swarm.json');writeFileSync(path,JSON.stringify(plan));
 f.attempt('Rod').record('ended','logged-out');f.attempt('Partner');
 const task:any={id:'test',goal:'gear',participants:['Rod','Partner']};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{}, {base:f.base})).toThrow('not confirmed');
 expect(readFileSync(path,'utf8')).toBe(JSON.stringify(plan));
 const partner=f.attempt('Partner');partner.record('ended','logged-out');
 writeFileSync(join(f.base,'.practice/swarm-script-holds.json'),JSON.stringify([{account:'Rod',script:'old.ts',at:1,reason:'blocked',heldAt:2}]));
 expect(()=>installJob(task,'Rod','old.ts','test','source',{}, {base:f.base})).toThrow('failed script');
 expect(()=>installJob(task,'Rod','new.ts','test','source',{}, {base:f.base,preflight:true,freeGB:0})).toThrow('live admission waiting: memory');
 expect(()=>installJob(task,'Rod','new.ts','test','source',{}, {base:f.base,preflight:true,freeGB:64})).not.toThrow();
 expect(readFileSync(path,'utf8')).toBe(JSON.stringify(plan));
});

test('a disabled owner job with a confirmed logout and no persistent end admits a new mission',()=>{
 const f=fixture(),path=join(f.base,'swarm.json');
 writeFileSync(path,JSON.stringify({maxBots:17,minFreeGB:0,jobs:[{account:'Rod',script:'old.ts',enabled:false,repeat:false}]}));
 f.status('Rod',{result:'fail old work'});
 f.attempt('Rod').record('ended','logged-out');
 const task:any={id:'test',goal:'gear',account:'Rod'};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).not.toThrow();
});

test('a settled disabled helper can join a composed mission after its prior job failed',()=>{
 const f=fixture(),path=join(f.base,'swarm.json');
 const plan={maxBots:17,minFreeGB:0,jobs:[{account:'Partner',script:'old.ts',enabled:false,repeat:false}]};
 writeFileSync(path,JSON.stringify(plan));
 f.status('Partner',{result:'fail old work'});f.attempt('Partner').record('ended','logged-out');
 const task:any={id:'test',goal:'specialists',participants:['Rod','Partner']};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).not.toThrow();
 expect(readFileSync(path,'utf8')).toBe(JSON.stringify(plan));
});

for(const constraint of ['enabled','unspecified enabled','stop','persistent end','script hold','reservation','unfinished session','unconfirmed logout'])test('settled helper admission preserves '+constraint,()=>{
 const f=fixture(),path=join(f.base,'swarm.json');
 const job:any={account:'Partner',script:'old.ts',enabled:false,repeat:false};
 f.status('Partner',{result:'fail old work'});f.attempt('Partner').record('ended','logged-out');
 if(constraint==='enabled')job.enabled=true;
 if(constraint==='unspecified enabled')delete job.enabled;
 if(constraint==='stop')writeFileSync(join(f.base,'.practice/stop-Partner'),'owner');
 if(constraint==='persistent end')writeFileSync(join(f.base,'.practice/swarm-deaths.json'),JSON.stringify({Partner:{at:1,reason:'gave-up after 1 runs'}}));
 if(constraint==='script hold')writeFileSync(join(f.base,'.practice/swarm-script-holds.json'),JSON.stringify([{account:'Partner',script:'new.ts',at:1,reason:'blocked',heldAt:2}]));
 if(constraint==='reservation')job.goal='fresh clock specialist';
 if(constraint==='unfinished session')f.status('Partner',{result:'',at:Date.now()});
 if(constraint==='unconfirmed logout')f.attempt('Partner');
 const plan=JSON.stringify({maxBots:17,minFreeGB:0,jobs:[job]});writeFileSync(path,plan);
 const task:any={id:'test',goal:'specialists',participants:['Rod','Partner']};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).toThrow();
 expect(readFileSync(path,'utf8')).toBe(plan);
});

test('composed admission reserves one process while retaining every account slot and the memory floor',()=>{
 const f=fixture(),path=join(f.base,'swarm.json'),plan={maxBots:17,minFreeGB:4,jobs:[]};writeFileSync(path,JSON.stringify(plan));
 const task:any={id:'test',goal:'skills',participants:['Crafter',...Array.from({length:16},(_,i)=>'Carrier'+i)]};
 expect(()=>installJob(task,'Crafter','worker.ts','test','source',{}, {base:f.base,preflight:true,freeGB:6})).not.toThrow();
 expect(()=>installJob(task,'Crafter','worker.ts','test','source',{}, {base:f.base,preflight:true,freeGB:4.5})).toThrow('live admission waiting: memory');
 writeFileSync(path,JSON.stringify({...plan,maxBots:16}));
 expect(()=>installJob(task,'Crafter','worker.ts','test','source',{}, {base:f.base,preflight:true,freeGB:64})).toThrow('live admission waiting: maxBots');
 expect(JSON.parse(readFileSync(path,'utf8')).jobs).toEqual([]);
});

test('a persistent end or an enabled owner job still blocks that install',()=>{
 const f=fixture(),path=join(f.base,'swarm.json');
 writeFileSync(path,JSON.stringify({maxBots:17,minFreeGB:0,jobs:[{account:'Rod',script:'old.ts',enabled:false,repeat:false}]}));
 f.status('Rod',{result:'fail old work'});
 f.attempt('Rod').record('ended','logged-out');
 const task:any={id:'test',goal:'gear',account:'Rod'};
 writeFileSync(join(f.base,'.practice/swarm-deaths.json'),JSON.stringify({Rod:{at:1,reason:'gave-up after 1 runs'}}));
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).toThrow('account recovery needs a verified repair');
 writeFileSync(join(f.base,'.practice/swarm-deaths.json'),JSON.stringify({}));
 writeFileSync(path,JSON.stringify({maxBots:17,minFreeGB:0,jobs:[{account:'Rod',script:'old.ts',enabled:true,repeat:false}]}));
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).toThrow('existing assignment is not confirmed complete');
});

test('an account with no producer attempts may start once its live status is 15 minutes old; repairs still need producer proof',()=>{
 const f=fixture(),now=Date.now();
 f.status('Rod',{result:'ok old work',at:now-14*60_000});expect(()=>liveLogoutRef('Rod',f.base,false,now)).toThrow('legacy');
 f.status('Rod',{result:'ok old work',at:now-15*60_000});expect(liveLogoutRef('Rod',f.base,false,now)).toEqual({kind:'bootstrap',account:'Rod',statusAt:now-15*60_000});
 expect(()=>liveLogoutRef('Rod',f.base,true,now)).toThrow('legacy');
 f.attempt('Rod');expect(()=>liveLogoutRef('Rod',f.base,false,now)).toThrow('not confirmed');
});

test('a reserved specialist cannot launch on an unrelated live receipt',()=>{
 const f=fixture(),account='Shaftshooter';
 writeFileSync(join(f.base,'swarm.json'),JSON.stringify({maxBots:17,minFreeGB:4,jobs:[
  {account,role:'ranged',goal:'Fresh-clock Ranged specialist',script:'',enabled:false}
 ]}));
 const task:any={id:'ranged-launch',goal:'specialists',launch:'specialist',account,accept:{skills:{Ranged:99}}};
 expect(()=>installJob(task,account,'worker.ts','test','source',{other:{ok:true,evidence:'live'}},
  {base:f.base,preflight:true,freeGB:64})).toThrow('specialist launch evidence');
});


test('specialist preflight binds the reserved board, winning clock, staged stock, and exact worker',()=>{
 const f=fixture(),account='Shaftshooter',name=account.toLowerCase(),board='Ranged';
 const source='a'.repeat(64), runId='test', now=Date.now(), dir='.practice/specialist-launch';
 const env={COORDINATOR_RUN_ID:runId,WORKER_RELEASE:source,SWARM_MISSION_HASH:sha(missionSignature({script:'worker.ts',account,env:{CAP:'1600',COORDINATOR_RUN_ID:runId}}))};
 const script='worker.ts', task={id:'ranged-launch',goal:'specialists',launch:'specialist',account,accept:{skills:{Ranged:99}}} as const;
 const requirements=[{item:'Steel arrow',count:100,itemId:886}];
 const mission=missionSignature({script,account,env:{CAP:'1600',COORDINATOR_RUN_ID:''}});
 const context=specialistContext(account,source,mission,requirements);
 mkdirSync(join(f.base,dir),{recursive:true});
 mkdirSync(join(f.base,'fleet')); mkdirSync(join(f.base,'knowledge'));
 const file=(path:string,value:unknown)=>{
  const bytes=typeof value==='string'?value:JSON.stringify(value);
  writeFileSync(join(f.base,path),bytes);
  return{path,sha256:sha(bytes)};
 };
 file('swarm.json',{maxBots:17,minFreeGB:4,jobs:[{account,role:'ranged',goal:'Fresh-clock Ranged specialist',script:'',enabled:false}]});
 file('fleet/owners.json',{accounts:{Holder:{side:'local',server},Courier:{side:'local',server}}});
 file('knowledge/items.json',[{id:886,name:'Steel arrow'}]);
 const snapshot=(ticks=5000,at=now,category=5,extraRows:unknown[]=[],profileStatus=404)=>file(dir+'/hiscores.json',{
  base:'https://'+server,tickMs:400,takenAt:new Date(at).toISOString(),profiles:[{name,status:profileStatus,at}],
  boards:[{board,category,rows:[{rank:1,name:'Leader',level:99,ticks},...extraRows]}]
 });
 snapshot();
 const raw={context,runId:'practice-1',actor:'Practice1',server:'localhost:8888',at:now-10,
  startPlaytime:0,endPlaytime:4000,planTicks:4000,ok:true,died:false,logout:'logged-out',boardTicks:{[board]:4000},externalSupplies:requirements};
 const log=file(dir+'/practice.log','REHEARSAL '+JSON.stringify(raw)+'\nRESULT ok ranged 99\n');
 let rehearsal=file(dir+'/practice.json',{version:2,...raw,log});
 const items=[{id:886,count:100}];
 const delivery=file(dir+'/delivery.json',{ok:true,observed:true,server,to:'Holder',from:'Courier',at:now-50,before:[],after:items,items});
 const plan=(count=100)=>{
  const bank=file(dir+'/bank.json',{name:'Holder',server,bankAt:now-20,bank:[{id:886,count}]});
  const staging=file(dir+'/staging.json',{version:2,context,at:now-10,
   allocations:[{item:'Steel arrow',itemId:886,count:100,holder:'Holder',recipient:name,bank,delivery}]});
  file(dir+'/'+name+'.json',{version:1,account:name,board,context,planTicks:4000,requirements,rehearsal,staging});
 };
 plan();
 const check=(preflight=true,entry=script)=>installJob(task as any,account,entry,runId,source,{}, {base:f.base,preflight,freeGB:64});
 expect(()=>check()).not.toThrow();
 expect(()=>assertSpecialistLogin(f.base,account,now+100,env)).toThrow('Specialist login refused');
 expect(()=>check(true,'other-worker.ts')).toThrow('route or supply requirements changed');
 snapshot(4050);
 expect(()=>check()).toThrow('tick margin');
 snapshot(5000,now-3_600_001);
 expect(()=>check()).toThrow('under one hour');
 snapshot(5000,now,17);
 expect(()=>check()).toThrow('specialist record');
 snapshot(5000,now,5,[{rank:2,name:account,level:20,ticks:300}]);
 expect(()=>check()).toThrow('already appears on the board');
 snapshot(5000,now,5,[],200);
 expect(()=>check()).toThrow('404 from the exact specialist profile');
 snapshot();
 rehearsal=file(dir+'/practice.json',{version:2,...raw,externalSupplies:[],log});
 plan();
 expect(()=>check()).toThrow('external supplies differ');
 rehearsal=file(dir+'/practice.json',{version:2,...raw,log});
 plan(99);
 expect(()=>check()).toThrow('double-counted/short');
 plan();
 expect(()=>check(false)).not.toThrow();
 expect(()=>assertSpecialistLogin(f.base,account,Date.now(),env)).not.toThrow();
 expect(()=>assertSpecialistLogin(f.base,account,Date.now(),{...env,COORDINATOR_RUN_ID:'different'})).toThrow('mismatched authorization');
 expect(()=>assertSpecialistLogin(f.base,account,Date.now(),{...env,SWARM_MISSION_HASH:sha('different args')})).toThrow('mismatched authorization');
 const token=JSON.parse(readFileSync(join(f.base,specialistTokenPath(account)),'utf8'));
 expect(()=>assertSpecialistLogin(f.base,account,token.expiresAt,env)).toThrow('expired');
 snapshot(6000);
 expect(()=>assertSpecialistLogin(f.base,account,Date.now(),env)).toThrow('Evidence changed');
});
