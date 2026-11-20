import {test,expect,mock} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {beginSessionAttempt} from '../../core/src/session-lifecycle';
import {liveLogoutRef} from '../src/coordinator-session';
import {installJob,liveAccountWait} from '../src/coordinator-live';
import {addTasks,chooseTask,initialState} from '../src/coordinator';
import {sha} from '../../core/src/launch-evidence';
import {missionSignature} from '../../core/src/session-admission';
import {assertSpecialistLogin, evaluateSpecialist, specialistContext, specialistTokenPath} from '../../core/src/specialist-launch';
import {readCoordinatorJobs,writeCoordinatorJobs} from '../../core/src/coordinator-jobs';
import type {Order,TradeReceipt} from '../../../scripts/fleet-trade-settlement';
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

function settledAutopilotFixture(){
 const f=fixture(),source='a'.repeat(64),job={account:'Rod',script:'old.ts',args:['20'],env:{TARGET:'60'},goal:'finite useful work',standing:true,enabled:true,repeat:true,autopilot:'local'};
 writeFileSync(join(f.base,'swarm.json'),JSON.stringify({maxBots:17,minFreeGB:4,jobs:[job]}));
 const at=Date.now()-1000;let clock=at;
 const attempt=beginSessionAttempt({account:'Rod',server},{root:f.root,now:()=>clock,
  owner:{pid:999999,coordinatorRunId:null,workerRelease:source,script:job.script,role:'combat',participants:null}});
 const created=Number(attempt.attemptId.split('-')[0]);
 clock=created+2;attempt.record('ready');clock=created+10;attempt.record('ended','logged-out');attempt.record('closed');
 f.status('Rod',{goal:job.goal,result:'ok useful effect',at:created+20,started:created+1,sessionAttemptId:attempt.attemptId,workRevision:source,workEntry:job.script});
 writeFileSync(join(f.base,'.practice/swarm-runs.json'),'[]');
 writeFileSync(join(f.base,'.practice/swarm-deaths.json'),JSON.stringify({Rod:{at:created+30,reason:'done after 1 runs',revision:missionSignature(job)}}));
 return{...f,job,source,prior:attempt};
}
test('a current live producer holds dispatch until its owner settles, without treating an enabled row or status as a live session',()=>{
 const f=fixture(),job={account:'Rod',script:'old.ts',standing:true,enabled:true,repeat:true};
 writeFileSync(join(f.base,'swarm.json'),JSON.stringify({jobs:[job]}));
 f.status('Rod',{result:'',at:Date.now()});
 const task:any={id:'live',kind:'run',goal:'quests',capability:'quest-sweep',account:'Rod',dependsOn:[],priority:1,estimatedMs:1,why:'finite quest',accept:{quests:['Scorpion Catcher']}};
 expect(liveAccountWait(task,['Rod'],f.base,()=>true)).toBeNull();
 const attempt=beginSessionAttempt({account:'Rod',server},{root:f.root,owner:{pid:123,coordinatorRunId:null,workerRelease:'a'.repeat(64),script:'old.ts',role:'combat',participants:null}});
 attempt.record('ready');f.status('Rod',{result:'ok stale result',at:1});
 const state=initialState();addTasks(state,[task]);
 const held=(candidate:any)=>liveAccountWait(candidate,['Rod'],f.base,pid=>pid===123)!==null;
 expect(liveAccountWait(task,['Rod'],f.base,pid=>pid===123)).toEqual({account:'Rod',reason:'active-session',attemptId:attempt.attemptId,pid:123});
 expect(chooseTask(state,Date.now(),{runHeld:held})).toBeNull();
 expect(liveAccountWait(task,['Rod'],f.base,()=>false)).toBeNull();
 expect(liveAccountWait(task,['Other'],f.base,()=>true)).toBeNull();
 expect(liveAccountWait({...task,sessionRecovery:{account:'Rod',endedAt:1}},['Rod'],f.base,()=>true)).toBeNull();
 expect(liveAccountWait({...task,repairs:[{account:'Rod',endedAt:1}]},['Rod'],f.base,()=>true)).toBeNull();
 attempt.record('ended','logged-out');attempt.record('closed');
 expect(held(task)).toBe(false);expect(chooseTask(state,Date.now(),{runHeld:held})?.id).toBe('live');
});
test('a closed failed producer is a repair fact, not a known active owner',()=>{
 const f=fixture(),attempt=beginSessionAttempt({account:'Rod',server},{root:f.root,owner:{pid:123,coordinatorRunId:null,workerRelease:'a'.repeat(64),script:'old.ts',role:'combat',participants:null}});
 attempt.record('connect-failed');attempt.record('closed');
 writeFileSync(join(f.base,'swarm.json'),JSON.stringify({jobs:[]}));
 expect(liveAccountWait({kind:'run'},['Rod'],f.base,()=>true)).toBeNull();
});

function fleetOrderFixture(){
 const f=fixture(),now=Date.now();
 writeFileSync(join(f.base,'swarm.json'),JSON.stringify({maxBots:17,minFreeGB:4,jobs:[]}));
 const dir=join(f.base,'fleet');for(const sub of ['orders','receipts'])mkdirSync(join(dir,sub),{recursive:true});
 const order:Order={id:'owned-gold-bars',server,from:'Unsheathed',to:'BowBeforeMe',item:'Gold bar',count:2,start:now+15*60000,end:now+30*60000};
 const putOrder=(value:any)=>writeFileSync(join(dir,'orders',order.id+'.json'),JSON.stringify(value));
 const putReceipt=(value:any)=>writeFileSync(join(dir,'receipts',order.id+'.'+value.role+'.json'),JSON.stringify(value));
 return{...f,now,order,putOrder,putReceipt};
}

test('a future fleet order holds both idle participants through dispatch and installation before any login claim',()=>{
 const f=fleetOrderFixture();f.putOrder(f.order);
 const task:any={id:'bow-consumer',kind:'run',goal:'main24',capability:'owned-bank-observation',account:'BowBeforeMe',launch:'ordinary',dependsOn:[],priority:49,estimatedMs:60000,why:'finite consumer',accept:{counters:{bankObserved:1}}};
 expect(liveAccountWait(task,['BowBeforeMe'],f.base,()=>false)).toEqual({account:'BowBeforeMe',reason:'fleet-order',attemptId:null,pid:null});
 expect(liveAccountWait(task,['Unsheathed'],f.base,()=>false)?.reason).toBe('fleet-order');
 expect(liveAccountWait(task,['Other'],f.base,()=>false)).toBeNull();
 const state=initialState();addTasks(state,[task]);
 expect(chooseTask(state,Date.now(),{runHeld:t=>liveAccountWait(t,[t.account!],f.base,()=>false)!==null})).toBeNull();
 expect(()=>installJob(task,'BowBeforeMe','scripts/fleet-inspect.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).toThrow('fleet-order');
 expect(readCoordinatorJobs(f.base).jobs).toEqual([]);
});

test('expired empty, invalid and other-server fleet orders do not hold a new local mission',()=>{
 const f=fleetOrderFixture(),task:any={kind:'run'};
 for(const order of [{...f.order,start:f.now-60000,end:f.now-1},{...f.order,count:0},{...f.order,server:'localhost:8888'}]){
  f.putOrder(order);expect(liveAccountWait(task,['BowBeforeMe'],f.base,()=>false)).toBeNull();
 }
 writeFileSync(join(f.base,'fleet/orders',f.order.id+'.json'),'{');
 expect(liveAccountWait(task,['BowBeforeMe'],f.base,()=>false)).toBeNull();
});

function terminalFleetReceipt(order:Order,role:'from'|'to',state:'settled'|'failed',now:number):TradeReceipt{
 const settled=state==='settled';
 return{version:2,state,id:order.id,role,account:order[role],partner:order[role==='from'?'to':'from'],side:role==='from'?'cloud':'local',server:order.server,item:order.item,requested:order.count,claim:role==='from'?'12345678-1234-1234-1234-123456789012':'87654321-1234-1234-1234-123456789012',at:now-1,ok:settled,detail:'',count:settled?order.count:0,inventory:settled?(role==='from'?{before:order.count,after:0}:{before:0,after:order.count}):{before:0,after:0},...(settled&&role==='to'?{bank:{count:order.count,at:now-3}}:{}),logout:{attemptId:'0000000002400-1-1',at:now-2,sha256:'a'.repeat(64)}};
}

for(const outcome of ['settled','failed'] as const)test('matched '+outcome+' fleet receipts release both parties before the window expires',()=>{
 const f=fleetOrderFixture(),order={...f.order,start:f.now-60000};f.putOrder(order);
 f.putReceipt(terminalFleetReceipt(order,'from',outcome,f.now));
 expect(liveAccountWait({kind:'run'},['BowBeforeMe'],f.base,()=>false)?.reason).toBe('fleet-order');
 f.putReceipt(terminalFleetReceipt(order,'to',outcome,f.now));
 expect(liveAccountWait({kind:'run'},['BowBeforeMe','Unsheathed'],f.base,()=>false)).toBeNull();
});

test('an expired fleet order with an unmatched completed transfer still waits for reconciliation',()=>{
 const f=fleetOrderFixture(),order={...f.order,start:f.now-60000,end:f.now-10};f.putOrder(order);
 f.putReceipt(terminalFleetReceipt(order,'from','settled',f.now));
 expect(liveAccountWait({kind:'run'},['BowBeforeMe'],f.base,()=>false)?.reason).toBe('fleet-order');
});

function historicalFleetOrderFixture(){
 const f=fleetOrderFixture(),dir=join(f.base,'fleet');
 mkdirSync(join(f.base,'.git'));writeFileSync(join(f.base,'.git/config'),'[remote "origin"]\nurl = test-authority\n');
 const order:Order={id:'1794503734080-nabtheknob-mmsmk1232-bones',server,from:'NabTheKnob',to:'mmsmk1232',item:'Bones',count:86,start:1794503734080,end:1794506134080};
 const putOrder=(value:Order)=>writeFileSync(join(dir,'orders',order.id+'.json'),JSON.stringify(value));
 const receipt=(role:'from'|'to'):TradeReceipt=>({...terminalFleetReceipt(order,role,'failed',order.start+210000),state:'reconcile',detail:'transfer requires reconciliation',screen:true,inventory:role==='from'?{before:86,after:86}:{before:0,after:0}});
 const putReceipt=(value:any)=>writeFileSync(join(dir,'receipts',order.id+'.'+value.role+'.json'),JSON.stringify(value));
 putOrder(order);for(const role of ['from','to'] as const)putReceipt(receipt(role));
 return{...f,order,putOrder,putReceipt,receipt};
}

test('released receipt nonces close the historical Nab and mmsmk order and reuse exact authority proof',()=>{
 const f=historicalFleetOrderFixture(),readHeld=mock((_base:string,accounts:readonly string[])=>{expect(new Set(accounts)).toEqual(new Set(['NabTheKnob','mmsmk1232']));return [];});
 const authority={readHeld,now:()=>f.now};
 expect(liveAccountWait({kind:'run'},['NabTheKnob','mmsmk1232'],f.base,()=>false,authority)).toBeNull();
 expect(readHeld).toHaveBeenCalledTimes(1);
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)).toBeNull();
 expect(liveAccountWait({kind:'run'},['mmsmk1232'],f.base,()=>false,authority)).toBeNull();
 expect(readHeld).toHaveBeenCalledTimes(1);
});

test('JSON null receipt rows do not hide authoritative closure of a coherent expired order',()=>{
 const f=historicalFleetOrderFixture(),readHeld=mock(()=>[]);
 writeFileSync(join(f.base,'fleet/receipts/null.json'),'null');
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,{readHeld,now:()=>f.now})).toBeNull();
 expect(readHeld).toHaveBeenCalledTimes(1);
});

test('receipt item names retain the settlement protocol case equivalence',()=>{
 const f=historicalFleetOrderFixture(),readHeld=mock(()=>[]);
 f.putReceipt({...f.receipt('from'),item:'bones'});f.putReceipt({...f.receipt('to'),item:'BONES'});
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,{readHeld,now:()=>f.now})).toBeNull();
 expect(readHeld).toHaveBeenCalledTimes(1);
});

test('held and unavailable trade authority keep the order held, retry after cooldown, then observe release',()=>{
 const f=historicalFleetOrderFixture();let now=f.now,unavailable=false,held=true;
 const readHeld=mock(()=>{if(unavailable)throw Error('authority unavailable');return held?[{nonce:f.receipt('from').claim} as any]:[];}),authority={readHeld,now:()=>now};
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(readHeld).toHaveBeenCalledTimes(1);
 now+=60000;unavailable=true;
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 held=false;now+=59999;
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(readHeld).toHaveBeenCalledTimes(2);
 now++;unavailable=false;
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)).toBeNull();
 expect(readHeld).toHaveBeenCalledTimes(3);
});

test('a failed authority read cannot resolve any absent receipt nonce',()=>{
 const f=historicalFleetOrderFixture(),readHeld=mock(()=>{throw Error('authority unavailable');}),authority={readHeld,now:()=>f.now};
 for(let n=0;n<3;n++)expect(liveAccountWait({kind:'run'},['NabTheKnob','mmsmk1232'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(readHeld).toHaveBeenCalledTimes(1);
});

test('a changed nonce or Git authority cannot inherit old released-nonce proof',()=>{
 const f=historicalFleetOrderFixture();let held:string|null=null;
 const readHeld=mock(()=>held?[{nonce:held} as any]:[]),authority={readHeld,now:()=>f.now};
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)).toBeNull();
 held='11111111-1111-4111-8111-111111111111';f.putReceipt({...f.receipt('from'),claim:held});
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(readHeld).toHaveBeenCalledTimes(2);
 held=f.receipt('from').claim;f.putReceipt(f.receipt('from'));
 writeFileSync(join(f.base,'.git/config'),'[remote "origin"]\nurl = different-authority\n');
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(readHeld).toHaveBeenCalledTimes(3);
});

test('authority resolution preserves future windows, malformed receipts and unmatched completed movement',()=>{
 const f=historicalFleetOrderFixture(),readHeld=mock(()=>[]),authority={readHeld,now:()=>f.now};
 f.putOrder({...f.order,start:f.now+15*60000,end:f.now+30*60000});
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 expect(readHeld).toHaveBeenCalledTimes(0);
 f.putOrder(f.order);f.putReceipt({...f.receipt('from'),account:'Other'});
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
 f.putReceipt(terminalFleetReceipt(f.order,'from','settled',f.order.start+210000));
 expect(liveAccountWait({kind:'run'},['NabTheKnob'],f.base,()=>false,authority)?.reason).toBe('fleet-order');
});
test('a new unstarted autopilot mission waits for its own result and cannot inherit prior success',()=>{
 const f=settledAutopilotFixture(),task:any={kind:'run'};
 expect(liveAccountWait(task,['Rod'],f.base,()=>false)).toBeNull();
 f.job.args=['40'];writeFileSync(join(f.base,'swarm.json'),JSON.stringify({jobs:[f.job]}));
 expect(liveAccountWait(task,['Rod'],f.base,()=>false)).toEqual({account:'Rod',reason:'autopilot-assignment',attemptId:f.prior.attemptId,pid:999999});
});
test('a finite overlay takes a settled successful autopilot standing job without changing the owner assignment',()=>{
 const f=settledAutopilotFixture(),path=join(f.base,'swarm.json'),before=readFileSync(path,'utf8');
 const task:any={id:'test',kind:'run',goal:'quests',account:'Rod'};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,freeGB:64})).not.toThrow();
 expect(readFileSync(path,'utf8')).toBe(before);
 expect(readCoordinatorJobs(f.base).jobs).toEqual([expect.objectContaining({account:'Rod',script:'new.ts',enabled:true,repeat:false,coordinatorTask:'test'})]);
 expect(existsSync(join(f.base,'.practice/stop-Rod'))).toBe(false);
});
for(const mismatch of ['hand job','new mission','wrong attempt','wrong source','wrong entry','active run','new session','failed result'])test('idle autopilot handoff preserves '+mismatch,()=>{
 const f=settledAutopilotFixture(),path=join(f.base,'swarm.json');
 if(mismatch==='hand job')delete (f.job as any).autopilot;
 if(mismatch==='new mission')f.job.args=['40'];
 writeFileSync(path,JSON.stringify({maxBots:17,minFreeGB:4,jobs:[f.job]}));
 const status=JSON.parse(readFileSync(join(f.base,'.practice/status/Rod.json'),'utf8'));
 if(mismatch==='wrong attempt')status.sessionAttemptId='older';
 if(mismatch==='wrong source')status.workRevision='b'.repeat(64);
 if(mismatch==='wrong entry')status.workEntry='other.ts';
 if(mismatch==='failed result')status.result='fail no progress';
 f.status('Rod',status);
 if(mismatch==='active run')writeFileSync(join(f.base,'.practice/swarm-runs.json'),JSON.stringify([{accounts:['Rod'],pid:999999}]));
 if(mismatch==='new session')f.attempt('Rod');
 const before=readFileSync(path,'utf8'),task:any={id:'test',kind:'run',goal:'quests',account:'Rod'};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,freeGB:64})).toThrow();
 expect(readFileSync(path,'utf8')).toBe(before);expect(readCoordinatorJobs(f.base).jobs).toEqual([]);
});

for(const [participants,formerJob] of [[['Rod'],true],[['Rod','Partner'],true],[['Rod'],false]] as const)test('controller handoff installs a settled '+(participants.length===1?'single':'composed')+' mission '+(formerJob?'from its old job':'with no former job')+' before clearing its stops',()=>{
 const f=fixture(),path=join(f.base,'swarm.json'),stop='swarm plan removed or stopped';
 const plan=JSON.stringify({maxBots:17,minFreeGB:4,jobs:formerJob?participants.map(account=>({account,script:'old.ts',enabled:false,repeat:false})):[]});
 writeFileSync(path,plan);
 const stops=participants.flatMap(name=>[name,name.toLowerCase()]).map(name=>join(f.base,'.practice/stop-'+name));
 for(const name of participants){f.status(name,{result:'fail prior work',at:Date.now()-1000});f.attempt(name).record('ended','logged-out');}
 for(const file of stops)writeFileSync(file,stop);
 const task:any={id:'test',goal:'quests',...(participants.length===1?{account:'Rod'}:{participants})};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,preflight:true,freeGB:64})).not.toThrow();
 expect(readCoordinatorJobs(f.base).jobs).toEqual([]);
 for(const file of stops)expect(readFileSync(file,'utf8')).toBe(stop);
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,freeGB:64})).not.toThrow();
 expect(readCoordinatorJobs(f.base).jobs).toEqual([expect.objectContaining({script:'new.ts',enabled:true,repeat:false,coordinatorTask:'test',
  ...(participants.length===1?{account:'Rod'}:{accounts:participants,orchestrate:true})})]);
 for(const file of stops)expect(existsSync(file)).toBe(false);
 expect(readFileSync(path,'utf8')).toBe(plan);
});

test('controller handoff with no former job requires producer logout instead of legacy bootstrap',()=>{
 const f=fixture(),path=join(f.base,'swarm.json'),stop=join(f.base,'.practice/stop-Rod');
 const plan=JSON.stringify({maxBots:17,minFreeGB:4,jobs:[]});writeFileSync(path,plan);
 f.status('Rod',{result:'ok old work',at:Date.now()-15*60_000});
 writeFileSync(stop,'swarm plan removed or stopped');
 const task:any={id:'test',goal:'quests',account:'Rod'};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,freeGB:64})).toThrow();
 expect(readCoordinatorJobs(f.base).jobs).toEqual([]);
 expect(readFileSync(stop,'utf8')).toBe('swarm plan removed or stopped');
 expect(readFileSync(path,'utf8')).toBe(plan);
});

for(const constraint of ['owner stop','owner lowercase stop','owner text with controller prefix','live predecessor','unconfirmed logout','enabled job','memory','participant owner stop','global coordinator stop','global swarm stop'])test('controller handoff preserves stops and assignments on '+constraint,()=>{
 const f=fixture(),path=join(f.base,'swarm.json'),stop='swarm plan removed or stopped';
 const participants=constraint==='participant owner stop'?['Rod','Partner']:['Rod'];
 const plan=JSON.stringify({maxBots:17,minFreeGB:4,jobs:participants.map(account=>({account,script:'old.ts',enabled:constraint==='enabled job',repeat:false}))});
 writeFileSync(path,plan);
 const stops=new Map<string,string>();
 for(const name of participants){
  f.status(name,{result:constraint==='live predecessor'?'':'fail prior work',at:Date.now()-1000});
  const attempt=f.attempt(name);if(constraint!=='unconfirmed logout')attempt.record('ended','logged-out');
  stops.set(join(f.base,'.practice/stop-'+name),name==='Partner'?'owner paused':stop);
 }
 if(constraint==='owner stop')stops.set(join(f.base,'.practice/stop-Rod'),'owner paused');
 if(constraint==='owner lowercase stop')stops.set(join(f.base,'.practice/stop-rod'),'owner paused');
 if(constraint==='owner text with controller prefix')stops.set(join(f.base,'.practice/stop-Rod'),stop+'; keep offline for owner');
 if(constraint==='global coordinator stop')stops.set(join(f.base,'.practice/stop-coordinator'),'owner paused');
 if(constraint==='global swarm stop')stops.set(join(f.base,'.practice/stop-swarm'),'owner paused');
 for(const [file,text] of stops)writeFileSync(file,text);
 const beforeStops=new Map([...stops.keys()].map(file=>[file,readFileSync(file,'utf8')]));
 const task:any={id:'test',goal:'quests',...(participants.length===1?{account:'Rod'}:{participants})};
 expect(()=>installJob(task,'Rod','new.ts','test','source',{},{base:f.base,freeGB:constraint==='memory'?4:64})).toThrow();
 expect(readCoordinatorJobs(f.base).jobs).toEqual([]);
 for(const [file,text] of beforeStops)expect(readFileSync(file,'utf8')).toBe(text);
 expect(readFileSync(path,'utf8')).toBe(plan);
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
 const artifacts={
  finalSave:file(dir+'/practice.final.sav','engine save fixture'),
  tradeLedger:file(dir+'/practice.trades.jsonl','engine trade ledger fixture'),
  tickRecord:file(dir+'/practice.ticks.ndjson.gz','engine tick record fixture'),
 };
 const raw={context,runId:'practice-1',actor:'Practice1',server:'localhost:8888',at:now-10,
  startPlaytime:0,endPlaytime:4000,planTicks:4000,ok:true,died:false,logout:'logged-out',boardTicks:{[board]:4000},externalSupplies:requirements,artifacts};
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
 rehearsal=file(dir+'/practice.json',{version:2,...raw,artifacts:undefined,log});
 plan();
 expect(()=>check()).toThrow('raw rehearsal artifacts');
 rehearsal=file(dir+'/practice.json',{version:2,...raw,log});
 plan(99);
 expect(()=>check()).toThrow('double-counted/short');
 plan();
 expect(()=>check(false)).not.toThrow();
 file('.practice/coordinator/runs/'+runId+'/owner.json',{runId,pid:process.pid});
 const login=(envOverride=env,at=Date.now())=>assertSpecialistLogin(f.base,account,at,envOverride,server,(pid,id)=>pid===process.pid&&id===runId);
 expect(()=>login()).not.toThrow();
 expect(()=>login({...env,COORDINATOR_RUN_ID:'different'})).toThrow('mismatched authorization');
 expect(()=>login({...env,SWARM_MISSION_HASH:sha('different args')})).toThrow('mismatched authorization');
 file(artifacts.finalSave.path,'changed save bytes');
 expect(()=>login()).toThrow('Evidence changed');
 file(artifacts.finalSave.path,'engine save fixture');
 const token=JSON.parse(readFileSync(join(f.base,specialistTokenPath(account)),'utf8'));
 expect(()=>login(env,token.expiresAt)).toThrow('expired');
 snapshot(6000);
 expect(()=>login()).toThrow('Evidence changed');
});

test('an ordinary run waits for an account that the owner plan holds with a reservation row, and only for that', () => {
 const f=fixture(),plan=(jobs:object[])=>writeFileSync(join(f.base,'swarm.json'),JSON.stringify({maxBots:25,minFreeGB:4,jobs}));
 // The gang squad's row: disabled, no script, role pvp, trades allowed.
 plan([{account:'SquadOne',role:'pvp',script:'',enabled:false,trades:true},{account:'Finished',script:'scripts/old.ts',enabled:false},{account:'NoScript',enabled:false,role:'helper'},{account:'Busy',script:'',enabled:true,role:'pvp'}]);
 const run:any={kind:'run'};
 expect(liveAccountWait(run,['SquadOne'],f.base,()=>false)).toEqual({account:'SquadOne',reason:'reserved',attemptId:null,pid:null});
 expect(liveAccountWait(run,['squadone'],f.base,()=>false)?.reason).toBe('reserved');
 // A row with no script field at all is a reservation too.
 expect(liveAccountWait(run,['NoScript'],f.base,()=>false)?.reason).toBe('reserved');
 // A finished hand job names its script, an enabled row is a job, and an account with no row is free.
 expect(liveAccountWait(run,['Finished'],f.base,()=>false)).toBeNull();
 expect(liveAccountWait(run,['Busy'],f.base,()=>false)).toBeNull();
 expect(liveAccountWait(run,['Nobody'],f.base,()=>false)).toBeNull();
 // A composed run waits when any participant is reserved.
 expect(liveAccountWait(run,['Finished','SquadOne'],f.base,()=>false)?.account).toBe('SquadOne');
 // The main account launch, a repair and a session recovery are not ordinary runs.
 expect(liveAccountWait({kind:'run',launch:'main'} as any,['SquadOne'],f.base,()=>false)).toBeNull();
 expect(liveAccountWait({kind:'run',repairs:[{account:'SquadOne',endedAt:1}]} as any,['SquadOne'],f.base,()=>false)).toBeNull();
 expect(liveAccountWait({kind:'run',sessionRecovery:{account:'SquadOne'}} as any,['SquadOne'],f.base,()=>false)).toBeNull();
});

test('a parked coordinator job for the account does not hide the reservation row of the owner plan', () => {
 const f=fixture();
 writeFileSync(join(f.base,'swarm.json'),JSON.stringify({maxBots:25,minFreeGB:4,jobs:[{account:'SquadOne',role:'pvp',script:'',enabled:false,trades:true}]}));
 const parked={account:'SquadOne',script:'scripts/old.ts',args:[],role:'pvp',goal:'t [x]',enabled:false,repeat:false,coordinatorOwner:'coordinator',coordinatorTask:'t',env:{COORDINATOR_RUN_ID:'task-t'}};
 writeCoordinatorJobs(f.base,{...readCoordinatorJobs(f.base),jobs:[parked]});
 expect(liveAccountWait({kind:'run'} as any,['SquadOne'],f.base,()=>false)?.reason).toBe('reserved');
});

test('supply-exhausted autopilot jobs yield cleanly while non-supply blocked and persistent deaths stay held', () => {
 const supplyState=(account:string,job:any,endReason:string,result:string)=>{
  const f=fixture(),source='a'.repeat(64);
  writeFileSync(join(f.base,'swarm.json'),JSON.stringify({maxBots:25,minFreeGB:4,jobs:[job]}));
  const at=Date.now()-1000;let clock=at;
  const attempt=beginSessionAttempt({account,server},{root:f.root,now:()=>clock,
   owner:{pid:999999,coordinatorRunId:null,workerRelease:source,script:job.script,role:'combat',participants:null}});
  const created=Number(attempt.attemptId.split('-')[0]);
  clock=created+2;attempt.record('ready');clock=created+10;attempt.record('ended','logged-out');attempt.record('closed');
  f.status(account,{goal:job.goal,result,at:created+20,started:created+1,sessionAttemptId:attempt.attemptId,workRevision:source,workEntry:job.script});
  writeFileSync(join(f.base,'.practice/swarm-runs.json'),'[]');
  writeFileSync(join(f.base,'.practice/swarm-deaths.json'),JSON.stringify({[account]:{at:created+30,reason:endReason,revision:missionSignature(job)}}));
  return f;
 };

 const fingerJob={account:'Fingerblastr',script:'scripts/alch-train.ts',args:['99','5000'],env:{ALCH_ITEM:'airrune'},goal:'train Magic to 99 with alchemy',standing:true,enabled:true,repeat:false,autopilot:'local'};
 const fAlch=supplyState('Fingerblastr',fingerJob,'blocked after 1 runs','fail alch level=98 stop=supplies failure=no alch progress');
 const courierTask:any={id:'courier-test',kind:'run',goal:'skills',account:'Fingerblastr'};
 expect(liveAccountWait(courierTask,['Fingerblastr'],fAlch.base,()=>false)).toBeNull();
 expect(()=>installJob(courierTask,'Fingerblastr','scripts/coin-courier.ts','task-courier','source',{},{base:fAlch.base,preflight:true,freeGB:64})).not.toThrow();

 const hocusJob={account:'Hocuspokeus',script:'scripts/train-prayer.ts',args:['99'],env:{BURY_HELD:'1',BONE_ID:'536',BONE_RESERVE:'6'},goal:'train Prayer to 99',standing:true,enabled:true,repeat:false,autopilot:'local'};
 const truncatedPrayer='fail mode=prayer ok=false gained=0 targetMet=false target=99 buried=0 attempts=0 initialBones=6 boneBank=6 heldBones=0 consumed=0 xpGain=0 initialXp=988950 finalXp=988950 finalLevel=98 firstBoneXp=0 rateVerified=false toggledOn=false toggledOff=true prayerPointsOn=0 prayerPointsFinal=9 bankOb';
 const fPray=supplyState('Hocuspokeus',hocusJob,'stopped after 1 runs',truncatedPrayer);
 const buyTask:any={id:'buy-test',kind:'run',goal:'skills',account:'Hocuspokeus'};
 expect(liveAccountWait(buyTask,['Hocuspokeus'],fPray.base,()=>false)).toBeNull();
 expect(()=>installJob(buyTask,'Hocuspokeus','scripts/buy-owned-ge-item.ts','task-buy','source',{},{base:fPray.base,preflight:true,freeGB:64})).not.toThrow();

 // A supply-exhausted second participant also yields for a composed ordinary run.
 fAlch.attempt('Partner').record('ended','logged-out');
 const composedTask:any={id:'composed-test',kind:'run',goal:'skills',participants:['Partner','Fingerblastr']};
 expect(liveAccountWait(composedTask,['Partner','Fingerblastr'],fAlch.base,()=>false)).toBeNull();
 expect(()=>installJob(composedTask,'Partner','scripts/coin-courier.ts','task-composed','source',{},{base:fAlch.base,preflight:true,freeGB:64})).not.toThrow();

 // Non-supply blocked, died and gave-up ends still defer and refuse preflight install.
 for(const [reason,result] of [['blocked after 1 runs','fail unknown stall'],['died after 1 runs','fail died stop=supplies'],['gave-up after 1 runs','fail stop=supplies']] as const){
  const fBad=supplyState('Fingerblastr',fingerJob,reason,result);
  expect(liveAccountWait(courierTask,['Fingerblastr'],fBad.base,()=>false)?.reason).toBe('autopilot-assignment');
  expect(()=>installJob(courierTask,'Fingerblastr','scripts/coin-courier.ts','task-bad','source',{},{base:fBad.base,preflight:true,freeGB:64})).toThrow();
 }
});

test('specialist preflight admits fast 1-99 routes whose boardTick beats #1 while draining engineQueue',()=>{
 const f=fixture(),account='JustTheTip',name=account.toLowerCase(),board='Fletching';
 const source='a'.repeat(64),runId='test-fast',now=Date.now(),dir='.practice/specialist-launch';
 const script='fletching.ts',mission=missionSignature({script,account,env:{CAP:'200',COORDINATOR_RUN_ID:''}});
 const requirements=[{item:'Headless arrow',count:100,itemId:53}];
 const context=specialistContext(account,source,mission,requirements);
 mkdirSync(join(f.base,dir),{recursive:true});mkdirSync(join(f.base,'fleet'));mkdirSync(join(f.base,'knowledge'));
 const file=(path:string,value:unknown)=>{
  const bytes=typeof value==='string'?value:JSON.stringify(value);
  writeFileSync(join(f.base,path),bytes);
  return{path,sha256:sha(bytes)};
 };
 file('swarm.json',{maxBots:17,minFreeGB:4,jobs:[{account,role:'fletching',goal:'Fresh-clock Fletching specialist',script:'',enabled:false}]});
 file('fleet/owners.json',{accounts:{Holder:{side:'local',server},Courier:{side:'local',server}}});
 file('knowledge/items.json',[{id:53,name:'Headless arrow'}]);
 file(dir+'/hiscores.json',{base:'https://'+server,tickMs:400,takenAt:new Date(now).toISOString(),profiles:[{name,status:404,at:now}],
  boards:[{board,category:10,rows:[{rank:1,name:'Leader',level:99,ticks:56}]}]});
 const artifacts={
  finalSave:file(dir+'/fast.final.sav','engine save fixture'),
  tradeLedger:file(dir+'/fast.trades.jsonl','engine trade ledger fixture'),
  tickRecord:file(dir+'/fast.ticks.ndjson.gz','engine tick record fixture'),
 };
 const items=[{id:53,count:100}];
 const delivery=file(dir+'/delivery.json',{ok:true,observed:true,server,to:'Holder',from:'Courier',at:now-50,before:[],after:items,items});
 const bank=file(dir+'/bank.json',{name:'Holder',server,bankAt:now-20,bank:[{id:53,count:100}]});
 const staging=file(dir+'/staging.json',{version:2,context,at:now-10,allocations:[{item:'Headless arrow',itemId:53,count:100,holder:'Holder',recipient:name,bank,delivery}]});
 const writePlan=(boardTick:number,endPlaytime:number)=>{
  const raw={context,runId:'fast-1',actor:'PracticeFast',server:'localhost:8888',at:now-10,
   startPlaytime:0,endPlaytime,planTicks:54,ok:true,died:false,logout:'logged-out',boardTicks:{[board]:boardTick},externalSupplies:requirements,artifacts};
  const log=file(dir+'/fast.log','REHEARSAL '+JSON.stringify(raw)+'\nRESULT ok fletch 99\n');
  const rehearsal=file(dir+'/fast.json',{version:2,...raw,log});
  file(dir+'/'+name+'.json',{version:1,account:name,board,context,planTicks:54,requirements,rehearsal,staging});
 };
 writePlan(54,77);
 expect(()=>evaluateSpecialist(f.base,account,runId,source,mission,['Holder','Courier'],now)).not.toThrow();
 writePlan(55,77);
 expect(()=>evaluateSpecialist(f.base,account,runId,source,mission,['Holder','Courier'],now)).toThrow();
 writePlan(54,200);
 expect(()=>evaluateSpecialist(f.base,account,runId,source,mission,['Holder','Courier'],now)).toThrow('Rehearsal clock mismatch');
});
