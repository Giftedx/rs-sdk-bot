import {expect,test} from 'bun:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ownedLogisticsEntry,ownedRegistrationProgram,assertFreshOwnedActors,noteCourierSaveReceipt,qualifyOwnedLogistics,runOwnedChild} from '../src/owned-logistics-entry';
import {fleetStateFile,simBotsDir} from '../../core/src/practice-paths';
import {accountDir} from '../../core/src/session-lifecycle';

const names=['aiobfixture','aiobfixtureb','aiobfixturec'],server='127.0.0.1:21000';
const env=(endpoint=server)=>`SERVER=${endpoint}\nPASSWORD=fixture-never-authenticate\n`;
const auth=(actors=names)=>actors.map(name=>'OWNED_LOGISTICS_AUTH '+JSON.stringify({name,server,loggedOut:true})).join('\n')+'\n';

function fixture(){
 const source=mkdtempSync(join(tmpdir(),'owned-entry-')),parent=join(source,'.practice','fixture-roots'),roots:string[]=[];
 const originalPlan={maxBots:1,jobs:[{account:'KeptOwner',enabled:true}]},originalState={schemaVersion:1,accounts:{keptowner:{paused:true}}};
 mkdirSync(join(source,'.practice/live'),{recursive:true});
 writeFileSync(join(source,'swarm.json'),JSON.stringify(originalPlan));
 writeFileSync(fleetStateFile(source),JSON.stringify(originalState));
 for(const name of names){mkdirSync(join(source,'vendor/rs-sdk/bots',name),{recursive:true});writeFileSync(join(source,'vendor/rs-sdk/bots',name,'bot.env'),env());}
 const prepare=(_source:string,directory=tmpdir())=>{
  const scratch=mkdtempSync(join(directory,'replay-root-'));roots.push(scratch);
  mkdirSync(join(scratch,'.practice'));writeFileSync(join(scratch,'swarm.json'),JSON.stringify(originalPlan));return scratch;
 };
 const remove=(root:string)=>{rmSync(root,{recursive:true,force:true});return true;};
 const unchanged=()=>{
  expect(JSON.parse(readFileSync(join(source,'swarm.json'),'utf8'))).toEqual(originalPlan);
  expect(JSON.parse(readFileSync(fleetStateFile(source),'utf8'))).toEqual(originalState);
  expect(roots.every(root=>!existsSync(root))).toBe(true);
 };
 return{sourceRoot:source,parent,prepare,remove,roots,unchanged,cleanup:()=>rmSync(source,{recursive:true,force:true})};
}

test('the adapter binds exact finite AIO arguments and refuses unrelated or duplicate account names before credentials',()=>{
 const primary=names[0]!,b=names[1]!,c=names[2]!;
 expect(ownedLogisticsEntry([primary,'coin-courier',b],()=>env()).workerArgs).toEqual(['coin-courier',b,'100']);
 expect(ownedLogisticsEntry([primary,'coin-fanout',b,c],()=>env()).workerArgs).toEqual(['coin-fanout',b,c,'50']);
 expect(ownedLogisticsEntry([primary,'item-fanin',b,c],()=>env()).workerArgs).toEqual(['item-fanin',b,c,'Feather']);
 expect(ownedLogisticsEntry([primary,'note-courier',b],()=>env()).workerArgs).toEqual(['note-courier',b,'MAX_DELIVERIES=1','CAP=1000']);
 for(const args of [['Haggis','coin-courier',b],[primary,'coin-courier',primary],[primary,'coin-courier','aiobother'],[primary,'coin-fanout',b],[primary,'unknown',b],[primary,'item-fanin','../other',c]]){
  let reads=0;expect(()=>ownedLogisticsEntry(args,()=>{reads++;return env();})).toThrow();expect(reads).toBe(0);
 }
});

test('every actor must have credentials for the same strict loopback endpoint before any authentication',()=>{
 for(const endpoint of ['rs-sdk-demo.fly.dev','localhost.evil.test:21000','127.0.0.1.evil.test:21000'])
  expect(()=>ownedLogisticsEntry([names[0]!,'coin-courier',names[1]!],()=>env(endpoint))).toThrow('loopback credentials');
 expect(()=>ownedLogisticsEntry([names[0]!,'coin-courier',names[1]!],name=>env(name===names[0]?server:'127.0.0.1:21010'))).toThrow('one exact');
 expect(()=>ownedLogisticsEntry([names[0]!,'coin-courier',names[1]!],()=>`SERVER=${server}\n`)).toThrow('loopback credentials');
 const program=ownedRegistrationProgram(ownedLogisticsEntry([names[0]!,'coin-courier',names[1]!],()=>env()));
 expect(program).toContain('readLogoutProof(name,server).state');expect(program).toContain("!=='confirmed'");expect(program).toContain('ownedAccounts(server).has');
});

test('actual registration precedes copied AIO execution with private ownership state, and cleanup preserves source metadata',async()=>{
 const f=fixture(),commands:string[][]=[];let calls=0;
 try{
  const result=await qualifyOwnedLogistics([names[0]!,'coin-fanout',names[1]!,names[2]!],{...f,run:async(args,options)=>{
   commands.push([...args]);calls++;
   expect(options.cwd).toBe(f.roots[0]);expect(options.env.DEMO_OK).toBe('');expect(options.env.FLEET_DIR).toBe(join(options.cwd,'fleet'));expect(options.env.SWARM_PLAN).toBe(join(options.cwd,'swarm.json'));
   expect(JSON.parse(readFileSync(join(options.cwd,'swarm.json'),'utf8')).jobs).toEqual([]);
   expect(JSON.parse(readFileSync(fleetStateFile(options.cwd),'utf8'))).toEqual({schemaVersion:1,accounts:{}});
   return calls===1?{code:0,stdout:auth()}:{code:0,stdout:'RESULT ok aggregate transfer\n'};
  }});
  expect(commands[0]![0]).toBe('--eval');expect(commands[1]).toEqual(['scripts/aio.ts','logistics',names[0],'coin-fanout',names[1],names[2],'50']);
  expect(result).toMatchObject({ok:true,authenticated:3,mode:'coin-fanout',server});f.unchanged();
 }finally{f.cleanup();}
});

test('failed authentication or missing confirmed logout never launches the transfer and still removes its scratch root',async()=>{
 for(const response of [{code:1,stdout:auth()},{code:0,stdout:auth([names[0]!,names[1]!])}]){
  const f=fixture();let calls=0;
  try{await expect(qualifyOwnedLogistics([names[0]!,'item-fanin',names[1]!,names[2]!],{...f,run:async()=>{calls++;return response;}})).rejects.toThrow('authentication/logout');expect(calls).toBe(1);f.unchanged();}
  finally{f.cleanup();}
 }
});

test('a positive child log cannot hide a nonzero transfer exit or a final failure',async()=>{
 for(const response of [{code:1,stdout:'RESULT ok one pair\n'},{code:0,stdout:'RESULT ok one pair\nRESULT fail aggregate\n'}]){
  const f=fixture();let calls=0;
  try{const result=await qualifyOwnedLogistics([names[0]!,'item-fanin',names[1]!,names[2]!],{...f,run:async()=>++calls===1?{code:0,stdout:auth()}:response});expect(result.ok).toBe(false);f.unchanged();}
  finally{f.cleanup();}
 }
});

test('source owner pauses and cancellation refuse a transfer without changing the source state',async()=>{
 const f=fixture();let calls=0;
 try{
  writeFileSync(join(f.sourceRoot,'.practice','stop-'+names[0]),'owner pause');
  await expect(qualifyOwnedLogistics([names[0]!,'coin-courier',names[1]!],{...f,run:async()=>{calls++;return{code:0,stdout:''};}})).rejects.toThrow('source stop files');
  expect(calls).toBe(0);expect(f.roots).toEqual([]);f.unchanged();
  rmSync(join(f.sourceRoot,'.practice','stop-'+names[0]));
  const controller=new AbortController();
  await expect(qualifyOwnedLogistics([names[0]!,'coin-courier',names[1]!],{...f,signal:controller.signal,run:async()=>{calls++;controller.abort();return{code:0,stdout:auth(names.slice(0,2))};}})).rejects.toThrow();
  expect(calls).toBe(1);f.unchanged();
 }finally{f.cleanup();}
});

test('source lifecycle, status, lease and scheduled assignments cannot be hidden by empty scratch state',async()=>{
 for(const kind of ['status','lifecycle','lease','plan','paused','activeJob'] as const){
  const f=fixture();let calls=0;
  try{
   const entry={names:names.slice(0,2),server},name=names[0]!;
   if(kind==='status'){mkdirSync(join(f.sourceRoot,'.practice/status'));writeFileSync(join(f.sourceRoot,'.practice/status',name+'.json'),JSON.stringify({name,server,result:'RESULT ok earlier'}));}
   if(kind==='lifecycle')mkdirSync(accountDir(name,server,join(f.sourceRoot,'.practice/session-lifecycle')),{recursive:true});
   if(kind==='lease'){mkdirSync(join(f.sourceRoot,'.practice/account-leases'));writeFileSync(join(f.sourceRoot,'.practice/account-leases',name+'.lock'),'{}');}
   if(kind==='plan')writeFileSync(join(f.sourceRoot,'swarm.json'),JSON.stringify({maxBots:1,jobs:[{account:name,enabled:true}]}));
   if(kind==='paused')writeFileSync(fleetStateFile(f.sourceRoot),JSON.stringify({schemaVersion:1,accounts:{[name]:{paused:true}}}));
   if(kind==='activeJob')writeFileSync(fleetStateFile(f.sourceRoot),JSON.stringify({schemaVersion:1,accounts:{[name]:{activeJob:{activityId:'x'}}}}));
   expect(()=>assertFreshOwnedActors(f.sourceRoot,entry)).toThrow();
   await expect(qualifyOwnedLogistics([name,'coin-courier',names[1]!],{...f,run:async()=>{calls++;return{code:0,stdout:''};}})).rejects.toThrow();
   expect(calls).toBe(0);expect(f.roots).toEqual([]);
  }finally{f.cleanup();}
 }
});

test('malformed source fleet state fails closed before scratch authentication',()=>{
 for(const bad of [{schemaVersion:1,accounts:null},{schemaVersion:2,accounts:{}},{schemaVersion:1,accounts:{[names[0]!]:'invalid'}}]){
  const f=fixture();
  try{
   writeFileSync(fleetStateFile(f.sourceRoot),JSON.stringify(bad));
   expect(()=>assertFreshOwnedActors(f.sourceRoot,{names:names.slice(0,2),server})).toThrow('ownership');expect(f.roots).toEqual([]);
  }finally{f.cleanup();}
 }
});

function noteSave(notes=28){
 return{version:9,position:{x:2654,z:3283,level:0},vars:{},skills:Array.from({length:21},(_,index)=>({index,rawExperience:index*100,xp:index*10,level:50})),
  inventories:{93:[{slot:0,id:1780,count:notes},{slot:1,id:333,count:1},{slot:2,id:333,count:1}].filter(item=>item.count>0),
   94:[{slot:3,id:1277,count:1}],95:[{slot:0,id:995,count:123}]}};
}

test('note delivery saves require exact notes spent, both working meals, all other assets, gear and XP',()=>{
 const before=noteSave(),after=noteSave(0);
 expect(noteCourierSaveReceipt(before,after)).toMatchObject({ok:true,notesDelivered:28,troutRetained:2});
 const changedFood=noteSave(0);changedFood.inventories[93].pop();expect(noteCourierSaveReceipt(before,changedFood).ok).toBe(false);
 const changedCash=noteSave(0);changedCash.inventories[95][0]!.count++;expect(noteCourierSaveReceipt(before,changedCash).ok).toBe(false);
 const changedXp=noteSave(0);changedXp.skills[0]!.rawExperience++;expect(noteCourierSaveReceipt(before,changedXp).ok).toBe(false);
 expect(noteCourierSaveReceipt(before,noteSave(1)).ok).toBe(false);
});

test('note mode primes only its banker, waits for readiness and requires both the actual worker and bank receipt',async()=>{
 for(const bankerCode of [0,1]){
  const f=fixture(),before=noteSave(),after=noteSave(0);let calls=0,receiverReady=false,complete:(result:{code:number;stdout:string})=>void=()=>{};
  try{
   const result=await qualifyOwnedLogistics([names[0]!,'note-courier',names[1]!],{...f,readSave:()=>before,
    waitSave:async(_path,predicate)=>({matched:predicate(after),save:after,first:before,reads:1,lastError:''}),
    run:async(args,options)=>{
     calls++;
     if(calls===1){expect(args[1]).not.toContain(JSON.stringify(names[0]));return{code:0,stdout:auth([names[1]!])};}
     if(calls===2){
      receiverReady=true;options.observe?.('NOTE_BANKER_READY '+JSON.stringify({name:names[1],server})+'\n');
      return new Promise(done=>{complete=done;});
     }
     expect(receiverReady).toBe(true);expect(args).toEqual(['scripts/aio.ts','logistics',names[0],'note-courier',names[1],'MAX_DELIVERIES=1','CAP=1000']);
     complete({code:bankerCode,stdout:'RESULT ok banker\nNOTE_BANKER_RECEIPT '+JSON.stringify({ok:true,banked:28,bankBefore:7,bankAfter:35,preserved:true,loggedOut:true})+'\n'});
     return{code:0,stdout:'RESULT ok deliveries=1\n'};
    }});
   expect(result.ok).toBe(bankerCode===0);expect(result.authenticated).toBe(1);expect(calls).toBe(3);f.unchanged();
  }finally{f.cleanup();}
 }
});

test('a banker failing before readiness never launches the fresh courier',async()=>{
 const f=fixture();let calls=0;
 try{
  await expect(qualifyOwnedLogistics([names[0]!,'note-courier',names[1]!],{...f,readSave:()=>noteSave(),run:async()=>{
   calls++;return calls===1?{code:0,stdout:auth([names[1]!])}:{code:1,stdout:'RESULT fail banker setup\n'};
  }})).rejects.toThrow('before readiness');
  expect(calls).toBe(2);f.unchanged();
 }finally{f.cleanup();}
});

test('the child runner retains nonzero exits even beside a positive result',async()=>{
 const result=await runOwnedChild(['--eval',"console.log('RESULT ok partial');process.exit(7)"],{cwd:process.cwd(),env:process.env,timeoutMs:5000,graceMs:20});
 expect(result.code).toBe(7);expect(result.stdout).toContain('RESULT ok partial');
});

test('a timed-out AIO-like process group and its inherited-output child cannot outlive the bounded runner',async()=>{
 const code=`import {spawn} from 'node:child_process';
spawn(process.execPath,['--eval',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
process.on('SIGTERM',()=>{});console.log('RESULT ok stale');setInterval(()=>{},1000);`;
 const started=performance.now(),result=await runOwnedChild(['--eval',code],{cwd:process.cwd(),env:process.env,timeoutMs:250,graceMs:50});
 expect(result.code).toBe(1);expect(result.failure).toBe('practice child deadline');expect(performance.now()-started).toBeLessThan(5000);
},10000);

test('simBotsDir credentials resolve on source and copy into scratch .practice/sim/bots',async()=>{
 const f=fixture();
 try{
  rmSync(join(f.sourceRoot,'vendor'),{recursive:true,force:true});
  for(const name of names){mkdirSync(join(simBotsDir(f.sourceRoot),name),{recursive:true});writeFileSync(join(simBotsDir(f.sourceRoot),name,'bot.env'),env());}
  let calls=0;
  const result=await qualifyOwnedLogistics([names[0]!,'coin-courier',names[1]!],{...f,run:async(_args,options)=>{
   calls++;
   for(const name of names.slice(0,2))expect(existsSync(join(simBotsDir(options.cwd),name,'bot.env'))).toBe(true);
   return calls===1?{code:0,stdout:auth(names.slice(0,2))}:{code:0,stdout:'RESULT ok transferred 100 coins\n'};
  }});
  expect(result).toMatchObject({ok:true,authenticated:2,mode:'coin-courier',server});f.unchanged();
 }finally{f.cleanup();}
});
