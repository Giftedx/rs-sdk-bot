import { expect, test } from 'bun:test';
import { handoffCommands, parseHandoff, runHandoff, assertHandoffOwnership, assertAccountOwnership, acquireAccountLeases, assertRecoverableStatus, type HandoffChild, type HandoffDeps } from './handoff-inputs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {parseHeadlessOrder,runOwnedHeadless,ammoOrderRecord} from './handoff-inputs';
import {loadProgressionCatalog} from '../packages/planner/src/progression-catalog';
import {evaluateProgressionWork,preflightProgressionWork,parentProgressionAccept} from '../packages/core/src/progression-session';
import {ammoChildConfiguration,selectAmmoProofEndpoints} from '../packages/practice/src/ammo-order-proof';
import {tickRecorder} from '../packages/core/src/tick-record';
import {botWork} from '../packages/core/src/bot';

test('headless CLI validates exact arguments before login and preserves two-account parsing',()=>{
 expect(parseHeadlessOrder(['Bigchopper','--headless-order','135','14'],'1600')).toEqual({account:'Bigchopper',maximum:135,logsToCut:14,cap:1600});
 for(const args of [['Haggis','--headless-order','135','14'],['Bigchopper','--headless-order','129','14'],['Bigchopper','--headless-order','135','26'],['Bigchopper','--headless-order','135','14','extra'],['Bigchopper','--headless-order','NaN','14']])expect(()=>parseHeadlessOrder(args)).toThrow();
 expect(()=>parseHeadlessOrder(['Bigchopper','--headless-order','135','14'],'0')).toThrow();
 expect(parseHandoff(['Donor','Receiver','90:Iron arrowtips']).items).toEqual([{name:'Iron arrowtips',count:90}]);
});

test('both handoff roles record the complete CLI once while retaining their progression arguments',()=>{
 const args=['Donor','Receiver','90:Iron arrowtips','--bank-x=3253','--bank-z=3421'];
 for(const account of ['Donor','Receiver']){
  const descriptor=ammoOrderRecord(account,args,{HANDOFF_ORDER:'record-cli-order'},'.');
  const lines:any[]=[];
  const recorder=tickRecorder({account,server:'localhost:8888',script:descriptor.script,argv:descriptor.argv,startedAt:1},
   {write:line=>lines.push(JSON.parse(line)),close:()=>{}});
  recorder.end(0,'logged-out');
  expect(lines[0].argv).toEqual(args);
  expect(parseHandoff(lines[0].argv)).toEqual(parseHandoff(args));
  expect(botWork(account,descriptor).args).toEqual(args);
  expect(descriptor.argv).not.toBe(args);
 }
});

test('a headless CLI record retains its single account while progression receives only its arguments',()=>{
 const args=['Bigchopper','--headless-order','135','14'],descriptor=ammoOrderRecord('Bigchopper',args,{CAP:'1600'},'.');
 const lines:any[]=[];
 tickRecorder({account:'Bigchopper',server:'localhost:8888',script:descriptor.script,argv:descriptor.argv,startedAt:1},
  {write:line=>lines.push(JSON.parse(line)),close:()=>{}}).end(0,'logged-out');
 expect(lines[0].argv).toEqual(args);
 expect(parseHeadlessOrder(lines[0].argv,'1600')).toMatchObject({account:'Bigchopper',maximum:135,logsToCut:14});
 expect(botWork('Bigchopper',descriptor).args).toEqual(['--headless-order','135','14']);
});

function headlessFixture(feathers=5705){
 let tick=0,xp=100,opened=false,generation=0,cuts=0;
 const listeners=new Set<()=>void>();
 const names=new Map([[1511,'Logs'],[52,'Arrow shaft'],[53,'Headless arrow'],[314,'Feather'],[946,'Knife'],[995,'Coins']]);
 const bank=new Map([[1511,15],[52,35],[53,300],[314,feathers],[946,1],[995,331135]]),pack=new Map<number,number>([[1985,3]]);
 const rows=(m:Map<number,number>)=>[...m].filter(([,count])=>count>0).map(([id,count],slot)=>({id,count,slot,name:names.get(id)??'Cheese'}));
 const timer=setInterval(()=>{tick++;for(const cb of [...listeners])cb();},1);
 const s:any={name:'Bigchopper',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),direct:async()=>{},
 bankObservation:()=>opened?{generation,items:rows(bank)}:undefined,
 sdk:{getInventory:()=>rows(pack),getEquipment:()=>[],getSkill:()=>({level:69,baseLevel:69}),getSkillXp:()=>xp,getDialog:()=>({isOpen:false}),
 getState:()=>({player:{worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0},bank:{isOpen:opened,items:rows(bank)},interface:{isOpen:opened}}),
 sendUseItemOnItem:async()=>{pack.set(52,pack.get(52)!-15);pack.set(314,pack.get(314)!-15);pack.set(53,(pack.get(53)??0)+15);xp+=15;}},
 bot:{openBank:async()=>{opened=true;generation++;return{success:true};},closeBank:async()=>{opened=false;return{success:true};},
 withdrawItem:async(i:any,n:number)=>{bank.set(i.id,bank.get(i.id)!-n);pack.set(i.id,(pack.get(i.id)??0)+n);return{success:true};},
 depositItem:async(i:any)=>{bank.set(i.id,(bank.get(i.id)??0)+pack.get(i.id)!);pack.delete(i.id);generation++;return{success:true};},
 fletchLogs:async()=>{cuts++;pack.set(1511,pack.get(1511)!-1);pack.set(52,(pack.get(52)??0)+15);xp+=125;return{success:true};}}};
 return{s,bank,pack,cuts:()=>cuts,close:()=>clearInterval(timer)};
}
test('owned composition makes135 new headless and conserves exact stock and unrelated assets',async()=>{
 const f=headlessFixture();try{
  const r=await runOwnedHeadless(f.s,parseHeadlessOrder(['Bigchopper','--headless-order','135','14'],'1600'),()=>{});
  expect(r.ok).toBe(true);expect(r.shafts.logsUsed).toBe(14);expect(r.headless.made).toBe(135);expect(r.preserved).toBe(true);
  for(const [id,n]of [[53,435],[52,110],[314,5570],[1511,1],[946,1],[995,331135]])expect(f.bank.get(id!)).toBe(n);
  expect(f.pack.get(1985)).toBe(3);
 }finally{f.close();}
});
test('missing feathers refuses before cutting owned logs',async()=>{
 const f=headlessFixture(100);try{
  await expect(runOwnedHeadless(f.s,parseHeadlessOrder(['Bigchopper','--headless-order','135','14']),()=>{})).rejects.toThrow('missing owned inputs');
  expect(f.cuts()).toBe(0);expect(f.bank.get(1511)).toBe(15);
 }finally{f.close();}
});
test('one CAP covers both production stages',async()=>{
 const f=headlessFixture();try{
  await expect(runOwnedHeadless(f.s,parseHeadlessOrder(['Bigchopper','--headless-order','135','14'],'2'),()=>{})).rejects.toThrow('CAP exhausted');
 }finally{f.close();}
});

test('shared account lease API excludes overlapping orders and unwinds partial acquisition',()=>{
 const base=mkdtempSync(join(tmpdir(),'account-leases-'));
 try{
  const release=acquireAccountLeases(['Receiver'],'first',base);
  expect(()=>acquireAccountLeases(['Donor','receiver'],'second',base)).toThrow('lease conflict');
  expect(existsSync(join(base,'donor.lock'))).toBe(false);
  release();release();
  acquireAccountLeases(['RECEIVER'],'next',base)();
  expect(()=>assertAccountOwnership(['Receiver'],{version:1,tasks:[]},[],()=>false,'mine')).not.toThrow();
 }finally{rmSync(base,{recursive:true,force:true});}
});

// These subprocesses enter main(), using disk-backed fake sessions only. No
// game server, credentials, production state or real openBot is used.
const entryFixture=String.raw`
import {main} from ENTRY;
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {evaluateProgressionWork,preflightProgressionWork} from CORE_PROGRESSION;
import {botWork} from CORE_BOT;
const root=process.env.FIXTURE_ROOT,stage=process.env.FIXTURE_STAGE;
const [bankX,bankZ]=(process.env.FIXTURE_BANK??'3253,3421').split(',').map(Number);
process.argv=['bun','handoff-inputs.ts','Donor','Receiver','90:Iron arrowtips','--bank-x='+bankX,'--bank-z='+bankZ,...(process.env.FIXTURE_ARGS??'').split(' ').filter(Boolean)];
const file=join(root,'holdings.json');
const load=()=>JSON.parse(readFileSync(file,'utf8'));
const save=x=>writeFileSync(file,JSON.stringify(x));
const hold=async point=>{if(stage===point){console.log('HOLD '+point);await new Promise(()=>{});}};
// Keep a blocked login alive until the parent kills it, with a hard deadline.
const deadline=setTimeout(()=>process.exit(9),8000);
await main({root,ownedAccounts:()=>new Set(['donor','receiver']),
 approach:{ground:async(s,to)=>{
  if(stage!=='mainland')throw Error('ground approach used');
  console.log('GROUND '+s.name+' '+to.x+','+to.z+','+to.level);s.at=to.x;s.az=to.z;return {ok:true};
 },planned:async(s,to)=>{
  console.log('PLANNED '+s.name+' '+to.x+','+to.z+','+to.level);
  if(stage==='mainland'&&to.x===3185&&to.z===3436)return {ok:false,reason:'precondition',detail:'no route to 3185,3436,0'};
  if(stage==='approach-refused')return {ok:false,reason:'precondition',detail:'no route'};
  await hold('approach');
  if(stage==='approach-slow'){await new Promise(yes=>setTimeout(yes,1500));console.log('IDLE RESET '+s.name+' '+(s.client.idleTimer>0));}
  s.at=to.x;s.az=to.z;return {ok:true};
 }},
 openBot:async (name,options)=>{
  if(process.env.FIXTURE_PROGRESSION==='1'){
   const work=botWork(name,options?.record);
   preflightProgressionWork(work,'rs-sdk-demo.fly.dev',undefined,name);
   const evaluation=evaluateProgressionWork(work,{name,at:Date.now()},{base:root,requireQualification:true});
   if(!evaluation.supported)throw Error('finite entry refused: '+evaluation.reason);
   console.log('WORK '+JSON.stringify({name,script:work.script,args:work.args,intent:evaluation.intent}));
  }
  console.log('LOGIN '+name);
  const status=join(root,'.practice/status',name+'.json');
  writeFileSync(status,JSON.stringify({name,goal:process.env.BOT_GOAL,at:Date.now()}));
  await hold('login');
  let opened=false,generation=0;
  const role=name==='Donor'?'donor':'receiver';
  const items=(n,noted=0)=>[...(n?[{id:40,name:'Iron arrowtips',count:n,slot:0}]:[]),...(noted?[{id:41,name:'Iron arrowtips',count:noted,slot:1}]:[])];
  const pack=()=>items(load()[role].pack,load()[role].noted);
  const start=name==='Receiver'&&process.env.FIXTURE_RECEIVER_START?process.env.FIXTURE_RECEIVER_START.split(',').map(Number):[(process.env.FIXTURE_FAR??'').split(',').includes(name)?3092:bankX,bankZ];
  const s={name,client:{idleTimer:0},at:start[0],az:start[1],tick:()=>0,onTick:()=>()=>{},
   bankObservation:()=>opened?{generation,at:Date.now(),items:items(load()[role].bank)}:null,
   sdk:{getInventory:pack,getSkill:()=>({level:10}),getState:()=>({player:{worldX:s.at,worldZ:s.az,level:0},bank:{isOpen:opened},inventory:pack()})},
   bot:{walkTo:async x=>{console.log('LOCAL '+name);await hold('bank-entry');s.at=x;return {success:true};},
    openBank:async()=>{opened=true;generation++;return {success:true};},closeBank:async()=>{opened=false;return {success:true};},
    withdrawItem:async(_,count,options)=>{const x=load();x[role].bank-=count;if(options?.asNote)x[role].noted=(x[role].noted??0)+count;else x[role].pack+=count;save(x);generation++;return {success:true};},
    serveTrades:async()=>{const x=load();
     // The real offer takes the first row of a name, so a plain row hides the notes.
     if(x.donor.pack&&x.donor.noted)return {success:false};
     const form=x.donor.noted?'noted':'pack';x.donor[form]-=90;x.receiver[form]=(x.receiver[form]??0)+90;x.sends++;save(x);await hold('after-send');return {success:true};},
    trade:async()=>({success:true}),
    depositItem:async target=>{const x=load(),form=target.id===41?'noted':'pack';x[role].bank+=x[role][form];x[role][form]=0;save(x);generation++;return {success:true};}}
  };return s;
 },settle:async(sessions,ok)=>{for(const s of sessions){writeFileSync(join(root,'.practice/status',s.name+'.json'),JSON.stringify({name:s.name,result:'ended'}));console.log('LOGOUT '+s.name);}return ok;}
});
clearTimeout(deadline);
`.replace('ENTRY',JSON.stringify(resolve(import.meta.dir,'handoff-inputs.ts')))
 .replace('CORE_PROGRESSION',JSON.stringify(resolve(import.meta.dir,'../packages/core/src/progression-session.ts')))
 .replace('CORE_BOT',JSON.stringify(resolve(import.meta.dir,'../packages/core/src/bot.ts')));

function cliFixture(){
 const root=mkdtempSync(join(tmpdir(),'handoff-main-'));
 for(const name of ['Donor','Receiver']){const dir=join(root,'vendor/rs-sdk/bots',name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'bot.env'),'SERVER=localhost:8888\n');}
 mkdirSync(join(root,'.practice/status'),{recursive:true});mkdirSync(join(root,'.practice/coordinator'),{recursive:true});
 writeFileSync(join(root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[]}));
 writeFileSync(join(root,'swarm.json'),JSON.stringify({jobs:[]}));
 writeFileSync(join(root,'holdings.json'),JSON.stringify({donor:{bank:90,pack:0},receiver:{bank:0,pack:0},sends:0}));
 const children:{p:ReturnType<typeof spawn>;done:Promise<number|null>}[]=[];
 const start=(stage='',env:Record<string,string>={})=>{
  const p=spawn(process.execPath,['--eval',entryFixture],{windowsHide:true,env:{...process.env,HANDOFF_ORDER:'cli-order',BOT_GOAL:'fixture',FIXTURE_ROOT:root,FIXTURE_STAGE:stage,...env},stdio:['ignore','pipe','pipe']});
  let output='';p.stdout!.on('data',b=>{output+=b;});p.stderr!.on('data',b=>{output+=b;});
  const done=new Promise<number|null>((yes,no)=>{p.once('error',no);p.once('close',yes);});
  children.push({p,done});
  return {p,done,output:()=>output,hold:()=>new Promise<void>((yes,no)=>{
   const timeout=setTimeout(()=>no(Error('child did not reach hold: '+output)),4000);
   const check=()=>{if(output.includes('HOLD ')){clearTimeout(timeout);yes();}};
   p.stdout!.on('data',check);check();
  })};
 };
 return {root,start,async cleanup(){for(const {p} of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');await Promise.all(children.map(c=>c.done));rmSync(root,{recursive:true,force:true});}};
}

test('productive catalog admits finite composed participants and standalone CLI orders without claiming old output',async()=>{
 const catalog=loadProgressionCatalog();
 expect(catalog.entries.find(e=>e.script==='scripts/handoff-inputs.ts')?.intents).toEqual(['acquire','produce','service']);
 const f=cliFixture(),args=['Donor','Receiver','90:Iron arrowtips','--bank-x=3253','--bank-z=3421'];
 const workFor=(name:string,argv:string[],env:Record<string,string>)=>{
  const record=ammoOrderRecord(name,argv,env,f.root);
  return botWork(name,record);
 };
 try{
  const runId='task-ammo-finite',accept={bank:{40:90}};
  writeFileSync(join(f.root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[{status:'running',runId,spec:{id:'ammo',participants:['Donor','Receiver'],acceptIndex:1,accept}}]}));
  const env={COORDINATOR_RUN_ID:runId,HANDOFF_ORDER:'cli-order',PROGRESSION_CONSUMER:JSON.stringify({bank:{40:1}})};
  const donor=workFor('Donor',args,env),receiver=workFor('Receiver',args,env);
  expect(donor.args).toEqual(args);expect(receiver.args).toEqual(args);
  expect(parentProgressionAccept(donor,'Donor',f.root)).toBeUndefined();
  expect(parentProgressionAccept(receiver,'Receiver',f.root)).toEqual(accept);
  expect(env.PROGRESSION_CONSUMER).toBe(JSON.stringify({bank:{40:1}}));
  for(const [name,work]of [['Donor',donor],['Receiver',receiver]] as const){
   expect(()=>preflightProgressionWork(work,'rs-sdk-demo.fly.dev',catalog,name)).not.toThrow();
   const result=evaluateProgressionWork(work,{name,at:Date.now()},{base:f.root,catalog,requireQualification:true});
   expect(result.supported).toBe(true);
   if(name==='Receiver')expect(result.intent).toMatchObject({kind:'acquire',items:{40:90}});
   else{expect(result.intent).toMatchObject({kind:'service',units:1});expect(JSON.stringify(result.intent)).toContain('cli-order');}
  }
  const composed=f.start('',{...env,FIXTURE_PROGRESSION:'1'});
  expect(await composed.done).toBe(0);
  const works=composed.output().split(/\r?\n/).filter(l=>l.startsWith('WORK ')).map(l=>JSON.parse(l.slice(5)));
  expect(works.map(w=>[w.name,w.intent.kind])).toEqual([['Donor','service'],['Receiver','acquire']]);
  expect(composed.output().match(/LOGOUT /g)).toHaveLength(2);
  writeFileSync(join(f.root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[]}));
  writeFileSync(join(f.root,'holdings.json'),JSON.stringify({donor:{bank:90,pack:0},receiver:{bank:0,pack:0},sends:0}));
  const standalone=f.start('',{COORDINATOR_RUN_ID:'',HANDOFF_ORDER:'standalone-order',PROGRESSION_CONSUMER:'',FIXTURE_PROGRESSION:'1'});
  expect(await standalone.done).toBe(0);
  expect(standalone.output().split(/\r?\n/).filter(l=>l.startsWith('WORK ')).map(l=>JSON.parse(l.slice(5)).intent.kind)).toEqual(['service','service']);
  expect(standalone.output().match(/LOGOUT /g)).toHaveLength(2);
  const headless=workFor('Bigchopper',['Bigchopper','--headless-order','135','14'],{CAP:'1600'});
  const at=Date.now(),stocked={name:'Bigchopper',at,bankAt:at,inventory:[],equipment:[],bank:[{id:53,count:435}]};
  const production=evaluateProgressionWork(headless,stocked,{base:f.root,catalog,requireQualification:true});
  expect(()=>preflightProgressionWork(headless,'rs-sdk-demo.fly.dev',catalog,'Bigchopper')).not.toThrow();
  expect(production.supported).toBe(true);expect(production.intent).toMatchObject({kind:'service',units:1});
  expect(JSON.stringify(production.intent)).toContain('135');expect(JSON.stringify(production.intent)).toContain('53');
  const p=selectAmmoProofEndpoints(()=>true,()=>0),craft=ammoChildConfiguration(['scripts/fletch-arrows.ts','Receiver','400','iron'],{MAX_MAKE:'90',PROGRESSION_CONSUMER:JSON.stringify({bank:{884:90}})},p,{PROGRESSION_CONSUMER:'{"skills":{"Prayer":99}}'});
  const craftWork={script:craft.cmd[1]!,args:craft.cmd.slice(3),env:craft.env};
  expect(evaluateProgressionWork(craftWork,{name:'Receiver',at:Date.now()},{base:f.root,catalog,requireQualification:true}).intent).toMatchObject({kind:'acquire',items:{884:90}});
  expect(ammoChildConfiguration(['scripts/handoff-inputs.ts','Bigchopper','--headless-order','135','14'],{CAP:'1600'},p,{PROGRESSION_CONSUMER:'{"bank":{"53":435}}'}).env.PROGRESSION_CONSUMER).toBeUndefined();
 }finally{await f.cleanup();}
},15000);

for(const prior of ['fresh','dead-owner'])test('main concurrent '+prior+' starts elect one login owner and refuse the loser before login',async()=>{
 const f=cliFixture();try{
  if(prior==='dead-owner'){const old=f.start('login');await old.hold();old.p.kill('SIGKILL');await old.done;}
  const a=f.start('login'),b=f.start('login');
  const first=await Promise.race([a.done.then(code=>({loser:a,code,winner:b})),b.done.then(code=>({loser:b,code,winner:a}))]);
  expect(first.code).toBe(1);expect(first.loser.output()).not.toContain('LOGIN ');
  await first.winner.hold();expect(first.winner.output().match(/LOGIN /g)?.length).toBe(1);
 }finally{await f.cleanup();}
},10000);

for(const stage of ['login','bank-entry','after-send'])test('main kill during '+stage+' resumes and sends exactly once',async()=>{
 const f=cliFixture();try{
  const a=f.start(stage);await a.hold();
  const journal=join(f.root,'.practice/item-handoffs/cli-order/donor-receiver.json');
  expect(JSON.parse(readFileSync(journal,'utf8')).owner.pid).toBe(a.p.pid);
  a.p.kill('SIGKILL');await a.done;
  const b=f.start();expect(await b.done).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root,'holdings.json'),'utf8'))).toEqual({donor:{bank:0,pack:0},receiver:{bank:90,pack:0},sends:1});
  expect(b.output().match(/LOGOUT /g)?.length).toBe(2);
  expect(existsSync(join(f.root,'.practice/account-leases/donor.lock'))).toBe(false);
  expect(existsSync(join(f.root,'.practice/account-leases/receiver.lock'))).toBe(false);
  const duplicate=f.start();expect(await duplicate.done).toBe(1);expect(duplicate.output()).not.toContain('LOGIN ');
 }finally{await f.cleanup();}
},10000);

for(const conflict of ['coordinator','swarm','stop'])test('main refuses '+conflict+' account conflict before login',async()=>{
 const f=cliFixture();try{
  if(conflict==='coordinator')writeFileSync(join(f.root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[{status:'running',runId:'other',spec:{id:'other',participants:['Receiver']}}]}));
  if(conflict==='swarm')writeFileSync(join(f.root,'swarm.json'),JSON.stringify({jobs:[{enabled:true,account:'Receiver',id:'other'}]}));
  if(conflict==='stop')writeFileSync(join(f.root,'.practice/stop-Receiver'),'');
  const p=f.start();expect(await p.done).toBe(1);expect(p.output()).not.toContain('LOGIN ');
 }finally{await f.cleanup();}
},10000);

// The coordinator installs its assignment only in .practice/coordinator/jobs.json. The raw swarm.json
// still names both accounts in enabled owner jobs, which the merged plan shadows.
for(const overlayRun of ['task-ammo-own','task-ammo-other'])test('main reads the merged plan: overlay '+(overlayRun==='task-ammo-own'?'owns the transfer':'of another run refuses'),async()=>{
 const f=cliFixture();try{
  const runId='task-ammo-own';
  writeFileSync(join(f.root,'swarm.json'),JSON.stringify({maxBots:4,jobs:[{id:'owner-donor',enabled:true,account:'Donor',goal:'bank'},{id:'owner-receiver',enabled:true,account:'Receiver',goal:'fish'}]}));
  writeFileSync(join(f.root,'.practice/coordinator/state.json'),JSON.stringify({version:1,tasks:[{status:'running',runId,spec:{id:'ammo',participants:['Donor','Receiver']}}]}));
  writeFileSync(join(f.root,'.practice/coordinator/jobs.json'),JSON.stringify({coordination:{},jobs:[{coordinatorOwner:'coordinator',coordinatorTask:'ammo',enabled:true,accounts:['Donor','Receiver'],orchestrate:true,goal:'handoff ['+overlayRun+']'}]}));
  const p=f.start('',{COORDINATOR_RUN_ID:runId});
  const holdings=()=>JSON.parse(readFileSync(join(f.root,'holdings.json'),'utf8'));
  if(overlayRun==='task-ammo-own'){
   expect(await p.done).toBe(0);
   expect(holdings()).toEqual({donor:{bank:0,pack:0},receiver:{bank:90,pack:0},sends:1});
   expect(p.output()).toContain('HANDOFF_RESULT {"ok":true');
   expect(p.output().match(/LOGOUT /g)?.length).toBe(2);
   for(const n of ['Donor','Receiver'])expect(JSON.parse(readFileSync(join(f.root,'.practice/status',n+'.json'),'utf8')).result).toBe('ended');
  }else{
   expect(await p.done).toBe(1);
   expect(p.output()).toContain('account lease conflict: Donor; swarm ammo');
   expect(p.output()).not.toContain('LOGIN ');
   expect(holdings()).toEqual({donor:{bank:90,pack:0},receiver:{bank:0,pack:0},sends:0});
  }
  expect(existsSync(join(f.root,'.practice/account-leases/donor.lock'))).toBe(false);
 }finally{await f.cleanup();}
},10000);

test('planned distant entry transfers exactly after travel; refusal, deadline and pause move nothing and log out',async()=>{
 const untouched={donor:{bank:90,pack:0},receiver:{bank:0,pack:0},sends:0};
 const holdings=(root:string)=>JSON.parse(readFileSync(join(root,'holdings.json'),'utf8'));
 const f=cliFixture();try{
  // Travel outlasts the transfer deadline, which starts only after arrival.
  const a=f.start('approach-slow',{FIXTURE_FAR:'Donor',FIXTURE_ARGS:'--approach-ms=5000 --request-ms=1000 --timeout-ms=1000'});
  expect(await a.done).toBe(0);
  expect(a.output()).toContain('PLANNED Donor 3253,3421,0');expect(a.output()).not.toContain('PLANNED Receiver');expect(a.output()).toContain('IDLE RESET Donor true');
  expect(a.output()).toContain('LOCAL Receiver');expect(a.output().match(/LOGOUT /g)?.length).toBe(2);
  expect(holdings(f.root)).toEqual({donor:{bank:0,pack:0},receiver:{bank:90,pack:0},sends:1});
 }finally{await f.cleanup();}
 for(const stage of ['approach-refused','approach','pause']){
  const g=cliFixture();try{
   const p=g.start(stage==='pause'?'approach':stage,{FIXTURE_FAR:'Donor,Receiver',FIXTURE_ARGS:'--approach-ms='+(stage==='pause'?5000:1000)});
   if(stage==='pause'){await p.hold();writeFileSync(join(g.root,'.practice/stop-Receiver'),'');}
   expect(await p.done).toBe(1);
   expect(p.output()).toContain({'approach-refused':'handoff planned approach failed: Donor',approach:'handoff approach deadline',pause:'existing stop-Receiver'}[stage]!);
   expect(p.output()).toContain('PLANNED Receiver');expect(p.output()).not.toContain('LOCAL ');
   expect(p.output().match(/LOGOUT /g)?.length).toBe(2);expect(holdings(g.root)).toEqual(untouched);
   expect(existsSync(join(g.root,'.practice/account-leases/donor.lock'))).toBe(false);
  }finally{await g.cleanup();}
 }
 // Without the option a distant participant keeps the local approach.
 const h=cliFixture();try{
  const p=h.start('',{FIXTURE_FAR:'Donor'});expect(await p.done).toBe(0);
  expect(p.output()).toContain('LOCAL Donor');expect(p.output()).not.toContain('PLANNED ');
 }finally{await h.cleanup();}
},20000);

test('Varrock West approach decomposes the failed Port Sarim final leg before the exact transfer',async()=>{
 for(const start of ['3029,3217','2727,3493']){
  const f=cliFixture();try{
   const p=f.start('mainland',{FIXTURE_BANK:'3185,3436',FIXTURE_RECEIVER_START:start,FIXTURE_ARGS:'--approach-ms=5000'});
   expect(await p.done).toBe(0);
   expect(p.output()).not.toContain('PLANNED Receiver 3185,3436,0');
   expect(p.output().includes('PLANNED Receiver 3029,3217,0')).toBe(start==='2727,3493');
   expect(p.output().split(/\r?\n/).filter(l=>l.startsWith('GROUND '))).toEqual(
    ['3047,3237','3060,3265','3100,3285','3180,3258','3225,3240','3235,3300','3210,3380','3185,3436'].map(tile=>'GROUND Receiver '+tile+',0'));
   expect(p.output().indexOf('LOCAL Donor')).toBeGreaterThan(p.output().indexOf('GROUND Receiver 3185,3436,0'));
   expect(JSON.parse(readFileSync(join(f.root,'holdings.json'),'utf8'))).toEqual({donor:{bank:0,pack:0},receiver:{bank:90,pack:0},sends:1});
   expect(p.output().match(/LOGOUT /g)).toHaveLength(2);
  }finally{await f.cleanup();}
 }
},15000);

test('noted transfer leaves the donor pre-held plain stack in its pack',async()=>{
 const f=cliFixture();try{
  writeFileSync(join(f.root,'holdings.json'),JSON.stringify({donor:{bank:90,pack:2},receiver:{bank:0,pack:0},sends:0}));
  const p=f.start('',{FIXTURE_ARGS:'--notes'});expect(await p.done).toBe(0);
  expect(JSON.parse(readFileSync(join(f.root,'holdings.json'),'utf8'))).toEqual({donor:{bank:0,pack:2,noted:0},receiver:{bank:90,pack:0,noted:0},sends:1});
 }finally{await f.cleanup();}
},10000);

test('main refuses a live recorded order owner even with no account locks',async()=>{
 const f=cliFixture();try{
  const a=f.start('login');await a.hold();
  // Isolate the journal owner check from the account lease check.
  rmSync(join(f.root,'.practice/account-leases'),{recursive:true,force:true});
  const b=f.start();expect(await b.done).toBe(1);expect(b.output()).toContain('order owner still alive');expect(b.output()).not.toContain('LOGIN ');
 }finally{await f.cleanup();}
},10000);

test('crash resume permits only the matching dead order owner; stale or live foreign owners still refuse',()=>{
 const status={name:'Donor',goal:'exact attempt one',at:1},owner={pid:123,goal:status.goal};
 expect(()=>assertRecoverableStatus(status,owner,()=>false)).not.toThrow();
 expect(()=>assertRecoverableStatus(status,owner,()=>true)).toThrow('unsettled');
 expect(()=>assertRecoverableStatus(status,{...owner,goal:'different'},()=>false)).toThrow('unsettled');
 expect(()=>assertRecoverableStatus(status,undefined,()=>false)).toThrow('unsettled');
});

test('both account leases and global stops refuse before opening either session',()=>{
 const c=parseHandoff(['Donor','Receiver','90:Iron arrowtips']);
 const state={version:1,tasks:[{status:'running',runId:'other',spec:{id:'other-job',participants:['Receiver']}}]};
 expect(()=>assertHandoffOwnership(c,state,[],()=>false,'mine')).toThrow('Receiver');
 state.tasks[0]!.spec.participants=['Donor'];
 expect(()=>assertHandoffOwnership(c,state,[],()=>false,'mine')).toThrow('Donor');
 expect(()=>assertHandoffOwnership(c,{version:1,tasks:[]},[{account:'Receiver',enabled:true,id:'worker'}],()=>false,'mine')).toThrow('Receiver');
 expect(()=>assertHandoffOwnership(c,{version:1,tasks:[]},[],n=>n==='swarm','mine')).toThrow('stop-swarm');
 expect(()=>assertHandoffOwnership(c,{version:1,tasks:[]},[],()=>false,'mine')).not.toThrow();
});

function fixture(mode='ok') {
    const c=parseHandoff(['Pocketrocket','Ballspinner','153:Flax','--notes','--keep=knife|trout|salmon','--bank-x=2725','--bank-z=3493','--request-ms=1000','--timeout-ms=2000','--grace-ms=1000']);
    let now=1000, request:any=mode==='stale'?{at:100,items:c.items}:undefined;
    const events:string[]=[], stops:string[]=[], children=new Map<string,{code:number|null;text:string}>();
    let started=0, transferAt=0;
    const d:HandoffDeps={server:'localhost:8888',owned:new Set(['pocketrocket','ballspinner']),now:()=>now,
        pause:async ms=>{
            now+=ms;
            if(children.has('receiver')&&!request&&mode!=='missing'&&mode!=='early') request={at:now,items:mode==='wrong'?[{name:'Flax',count:152}]:c.items};
            if(mode==='early'&&children.has('receiver'))children.get('receiver')!.code=1;
            if(transferAt&&now-transferAt>=400&&mode!=='timeout') {
                children.set('receiver',{code:0,text:`START 2725 3493 0\nRESULT ok got ${mode==='zero'?'0':'153'} Flax`});
                children.set('donor',{code:0,text:'START 2725 3493 0\nMILESTONE paid Ballspinner 153 Flax\nRESULT ok waiting offline for owned cargo trades=0'});
            }
            for(const name of stops) {const role=name==='Ballspinner'?'receiver':'donor';const p=children.get(role);if(p)p.code=1;}
        },
        status:name=>({name,server:'localhost:8888',at:now,started:mode==='old-session'?1:started,
            result:!children.has('receiver')||name==='Pocketrocket'?(mode==='active'?'':'ok old'):'',pos:{x:2725,z:3493,level:0}}),
        request:()=>request,otherRequests:()=>mode==='other'?['Other.json']:[],stopped:()=>false,
        spawn:role=>{events.push(role);if(role==='receiver')started=now;else{expect(request?.items).toEqual(c.items);expect(request.at).toBeGreaterThanOrEqual(started);transferAt=now;}
            const p={code:role==='donor'&&mode==='early-donor'?0:null,text:role==='donor'&&mode==='early-donor'?'RESULT ok waiting offline for owned cargo':'START 2725 3493 0'} as {code:number|null;text:string};children.set(role,p);
            return {code:()=>children.get(role)!.code,output:()=>children.get(role)!.text} satisfies HandoffChild;},
        stop:name=>{stops.push(name);events.push('stop:'+name);}
    };
    return{c,d,events,stops};
}
test('one receiver starts, fresh authenticated exact request then starts donor; exact receipt and payout required',async()=>{
    const f=fixture();const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(true);expect(r.phase).toBe('done');expect(f.events).toEqual(['receiver','donor']);expect(f.stops).toEqual([]);
});
test('unowned, fresh active and preexisting stop accounts never launch or stop a child',async()=>{
    const f=fixture();f.d.owned=new Set(['ballspinner']);expect((await runHandoff(f.c,f.d)).reason).toContain('not authenticated');expect(f.events).toEqual([]);
    const g=fixture('active');expect((await runHandoff(g.c,g.d)).reason).toContain('account active');expect(g.events).toEqual([]);
    const h=fixture();h.d.stopped=()=>true;expect((await runHandoff(h.c,h.d)).reason).toContain('existing stop');expect(h.events).toEqual([]);
});
test('stale or wrong requests cannot start donor, and cleanup only stops this receiver',async()=>{
    for(const mode of ['stale','wrong','missing','old-session']){const f=fixture(mode);const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(f.events.filter(e=>e==='donor')).toEqual([]);expect(f.stops).toEqual(['Ballspinner']);expect(r.cleanupPending).toEqual([]);}
});
test('early receiver exit and malformed request terminate without donor or login retries',async()=>{
    const f=fixture('early');expect((await runHandoff(f.c,f.d)).reason).toContain('receiver exited before donor');expect(f.events).toEqual(['receiver']);
    const g=fixture();let read=0;g.d.request=()=>{if(++read>1)throw new Error('malformed JSON');return undefined;};
    expect((await runHandoff(g.c,g.d)).reason).toContain('malformed');expect(g.events).toEqual(['receiver','stop:Ballspinner']);
});
test('bounded transfer timeout gracefully stops both own children once; no retry',async()=>{
    const f=fixture('timeout');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('handoff timeout');expect(f.events.slice(0,2)).toEqual(['receiver','donor']);expect(f.stops).toEqual(['Ballspinner','Pocketrocket']);expect(r.cleanupPending).toEqual([]);
});
test('successful exits alone cannot claim actual exact transfer',async()=>{
    const f=fixture('zero');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('exact receipt not proved');
});
test('another pending payout never launches children; donor becoming active during receiver startup is preserved',async()=>{
    const f=fixture('other');expect((await runHandoff(f.c,f.d)).reason).toContain('other payout');expect(f.events).toEqual([]);
    const g=fixture();const status=g.d.status;g.d.status=n=>{const s=status(n);if(g.events.length&&n==='Pocketrocket')s.result='';return s;};
    expect((await runHandoff(g.c,g.d)).reason).toContain('became active');expect(g.events).toEqual(['receiver','stop:Ballspinner']);
});
test('CLI validates bounds, protected overlap and structured arguments without shell expansion',()=>{
    const c=parseHandoff(['Pocketrocket','Ballspinner','153:Flax','--notes','--keep=knife|bread','--bank-x=2725','--bank-z=3493']);
    const cmd=handoffCommands(c,'F:/repo');expect(cmd.receiver.slice(-4)).toEqual(['Ballspinner','take-from-banker','153:Flax','--banker=Pocketrocket']);expect(cmd.env).toMatchObject({PAYOUT_NOTES:'1',ON_DEMAND:'1',COURIERS:'',KEEP:'knife|bread',BANK_X:'2725'});
    for(const args of [['Main','Ballspinner','1:Flax'],['Pocketrocket','Pocketrocket','1:Flax'],['../x','Ballspinner','1:Flax'],['Pocketrocket','Ballspinner','0:Flax'],['Pocketrocket','Ballspinner','1:Flax','--keep=flax'],['Pocketrocket','Ballspinner','1:Flax','--bank-x=NaN'],['Pocketrocket','Ballspinner','1:Flax','--whatever=1']])expect(()=>parseHandoff(args)).toThrow();
    const live=['Masterbaiter','MineYourBiz','100:Lobster','--notes','--bank-x=2615','--bank-z=3332'];
    expect(parseHandoff([...live,'--approach-ms=1800000','--request-ms=60000','--timeout-ms=600000','--grace-ms=45000'])).toMatchObject({approachMs:1800000,requestMs:60000,timeoutMs:600000});
    expect(parseHandoff(live).approachMs).toBeUndefined();
    for(const bound of ['--approach-ms=999','--approach-ms=1800001','--approach-ms=','--request-ms=180000','--timeout-ms=1200000'])expect(()=>parseHandoff([...live,bound])).toThrow();
});
test('fresh file cannot authenticate an unrelated session or future timestamp',async()=>{
    const f=fixture();const spawn=f.d.spawn;f.d.spawn=role=>({...spawn(role),goal:'my child'});
    expect((await runHandoff(f.c,f.d)).ok).toBe(false);expect(f.events.includes('donor')).toBe(false);
    const g=fixture();g.d.request=()=>({at:999_999,items:g.c.items});
    expect((await runHandoff(g.c,g.d)).ok).toBe(false);expect(g.events.includes('donor')).toBe(false);
});
test('failed graceful cleanup remains an explicit failure, and never retries or deletes state',async()=>{
    const f=fixture('missing');f.d.stop=()=>{throw new Error('different job active; refuse stop');};
    const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('stop failed');expect(r.cleanupPending).toEqual(['Ballspinner']);expect(f.events).toEqual(['receiver']);
});
test('donor exiting cleanly without payout stops the receiver at once instead of burning its wait',async()=>{
    const f=fixture('early-donor');const r=await runHandoff(f.c,f.d);expect(r.ok).toBe(false);expect(r.reason).toContain('donor exited without exact payout');expect(f.stops).toEqual(['Ballspinner']);expect(r.elapsedMs).toBeLessThan(f.c.timeoutMs);
});
