import {test,expect,spyOn} from 'bun:test';
import {bulkOrderChecks,ORDER,NORTH_CASE,northEntryCheck,duplicateRefusalCheck,MAGIC_CASE,magicOrderChecks,stageWithStoppedStack,syncPracticeCheckpoint,geProofEndpoints,geProofAccountEnv,assertGeProofAccount,startGeProofStack,selectGeProofEndpoints} from '../src/ge-bulk-order-proof';
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
import type {ItemOrder} from '../../../scripts/buy-owned-ge-item';
import {verifyCase} from '../src/ge-bulk-order-proof';
import {capabilityRevision} from '../../core/src/worker-release';
import {geProofRuntime} from '../src/ge-bulk-order-proof';
test('native GE proof binds the acquired worker closure',()=>{expect(geProofRuntime()).toBe(capabilityRevision(['scripts/buy-owned-ge-item.ts']));});

const save=(bank:{id:number;count:number}[],pack:{id:number;count:number}[]=[])=>({version:9,position:{x:3185,z:3436,level:0},vars:{},
 skills:Array.from({length:21},(_,i)=>({index:i,level:i===3?10:1,xp:0,rawExperience:0})),
 inventories:{93:pack.map((item,slot)=>({...item,slot})),94:[],95:bank.map((item,slot)=>({...item,slot}))}});
const request={actor:'gebuyx1',server:'localhost:8888',goal:'native-1',item:ORDER.item,quantity:ORDER.quantity,limit:ORDER.limit,reserve:ORDER.reserve,createdAt:1,reviewAt:2,deadline:3};
const journal:ItemOrder={version:1,request,phase:'settled',coinsBefore:2000,itemsBefore:0,previousIds:[],at:4,offerId:7,acquired:300,refund:600};
const line=(r:object)=>'OWNED_GE_ITEM '+JSON.stringify(r)+'\nLOGOUT logged-out\n';
const input={before:save([{id:995,count:2000}]),after:save([{id:995,count:1100},{id:1987,count:300}]),repeat:save([{id:995,count:1100},{id:1987,count:300}]),journal,
 sell:{code:0,log:'GE_SELL_RESULT {"ok":true,"detail":"x"}\nLOGOUT logged-out\n'},
 buy:{code:0,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,acquired:300,spent:900,phase:'settled',offerId:7})},
 again:{code:0,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,phase:'settled',offerId:7,newItemsThisSession:0,cashDeltaThisSession:0})}};

test('elapsed verification delay alone does not invalidate same-source saved GE effects',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ge-saved-age-')),at=1793520000000;
 const p=geProofEndpoints({engine:28888,gateway:27780,management:28898,tcp:28899},'ge-saved-age');
 const meta={at,source:geProofRuntime(),server:p.server,endpoints:{ports:p.ports,instance:p.instance},buyer:request.actor,orderKey:request.goal,sellCode:0,buyCode:0,againCode:0};
 const clock=spyOn(Date,'now').mockReturnValue(at);
 try{
  for(const label of ['before','after','repeat'] as const){const s=input[label];writeFileSync(join(dir,label+'.sav'),saveBytes(s.position,s.inventories));}
  for(const label of ['sell','buy','again'] as const){writeFileSync(join(dir,label+'.log'),input[label].log);writeFileSync(join(dir,label+'.err'),'');}
  writeFileSync(join(dir,'journal.json'),JSON.stringify({...journal,request:{...request,server:p.server}}));
  const metadata=(changes:object={})=>writeFileSync(join(dir,'native.json'),JSON.stringify({...meta,...changes}));
  metadata();
  const immediate=verifyCase(dir);
  expect(immediate.ok).toBe(true);
  clock.mockReturnValue(at+86400000);
  const delayed=verifyCase(dir);
  expect(delayed.ok).toBe(true);
  expect(delayed.checks).toEqual(immediate.checks);
  expect(delayed.ageMs).toBe(86400000);
  for(const invalid of [null,'1793520000000',at+86400001]){metadata({at:invalid});expect(verifyCase(dir).ok).toBe(false);}
  metadata({source:'different-source'});expect(verifyCase(dir).checks.source).toBe(false);
  metadata();writeFileSync(join(dir,'buy.log'),input.buy.log.replace('LOGOUT logged-out','LOGOUT timeout'));
  expect(verifyCase(dir).checks.logout).toBe(false);
 }finally{clock.mockRestore();rmSync(dir,{recursive:true,force:true});}
});

test('owned GE endpoints propagate through starts, account config and child guards; non-practice endpoints refuse',async()=>{
 const p=geProofEndpoints({engine:28888,gateway:27780,management:28898,tcp:28899},'ge-test');
 const configured=geProofAccountEnv('SERVER=localhost:8888\nGATEWAY_URL=ws://localhost:7780\nPASSWORD=fixture\n',p);
 expect(configured).toContain('PASSWORD=fixture\n');
 expect(configured).toContain('SERVER=127.0.0.1:28888\n');
 expect(configured).toContain('GATEWAY_URL=ws://127.0.0.1:27780\n');
 expect(assertGeProofAccount(configured,p.env)).toBe(p.server);
 const starts:unknown[]=[];
 const start=async(opts:any)=>{starts.push({opts,env:{AGENT_PORT:process.env.AGENT_PORT,GATEWAY_URL:process.env.GATEWAY_URL,GE_DATABASE:process.env.GE_DATABASE}});return{logs:{engine:'',gateway:''},stop:async()=>{}};};
 const old=process.env.GE_DATABASE;
 await startGeProofStack(p,start);await startGeProofStack(p,start);
 expect(starts).toEqual(Array.from({length:2},()=>({opts:{ports:p.ports,instance:'ge-test',tickMs:150,readyTimeoutMs:60000},env:{AGENT_PORT:'27780',GATEWAY_URL:'http://127.0.0.1:27780',GE_DATABASE:p.env.GE_DATABASE}})));
 expect(process.env.GE_DATABASE).toBe(old);
 expect(()=>assertGeProofAccount(configured.replace(p.server,'rs-sdk-demo.fly.dev'),p.env)).toThrow('owned practice');
 expect(()=>assertGeProofAccount(configured.replace(p.server,'localhost:8888'),p.env)).toThrow('owned practice');
 expect(()=>assertGeProofAccount(configured,{...p.env,GE_PROOF_ENGINE:'https://example.com'})).toThrow();
 expect(()=>geProofEndpoints({engine:8888,gateway:27780,management:28898,tcp:28899},'ge-test')).toThrow();
});

test('owned management port propagates on initial start and stopped-stack restart, then restores the parent environment',async()=>{
 const p=geProofEndpoints({engine:28888,gateway:27780,management:28898,tcp:28899},'ge-management');
 const previous=process.env.WEB_MANAGEMENT_PORT,events:string[]=[];
 process.env.WEB_MANAGEMENT_PORT='8898';
 const start=async()=>{
  events.push(`start:${process.env.WEB_MANAGEMENT_PORT}`);
  return{logs:{engine:'',gateway:''},stop:async()=>{events.push('stop');}};
 };
 try{
  expect(p.env.WEB_MANAGEMENT_PORT).toBe('28898');
  const stack=await startGeProofStack(p,start);
  expect(process.env.WEB_MANAGEMENT_PORT).toBe('8898');
  await stageWithStoppedStack('management.sav',()=>stack.stop(),async()=>{events.push('stage');return 'management.sav';},MAGIC_CASE.position,
   ()=>startGeProofStack(p,start),()=>({...input.before,position:MAGIC_CASE.position}));
  expect(events).toEqual(['start:28898','stop','stage','start:28898']);
  expect(process.env.WEB_MANAGEMENT_PORT).toBe('8898');
  for(const management of [8898,p.ports.engine,p.ports.gateway,NaN,1023,65536])
   expect(()=>geProofEndpoints({...p.ports,management},p.instance)).toThrow('owned practice endpoints required');
 }finally{if(previous===undefined)delete process.env.WEB_MANAGEMENT_PORT;else process.env.WEB_MANAGEMENT_PORT=previous;}
});

test('owned TCP selection rejects an occupied fourth port and propagates NODE_PORT through both starts',async()=>{
 const checked:number[]=[],samples=[0,0.01];
 const p=selectGeProofEndpoints(port=>{checked.push(port);return port!==20003;},()=>samples.shift()!);
 expect(checked).toEqual([20000,20001,20002,20003,20200,20201,20202,20203]);
 expect(p.ports).toEqual({engine:20200,gateway:20201,management:20202,tcp:20203});
 const previous=process.env.NODE_PORT,events:string[]=[];
 process.env.NODE_PORT='43594';
 const start=async()=>{
  events.push(`start:${process.env.NODE_PORT}`);
  return{logs:{engine:'',gateway:''},stop:async()=>{events.push('stop');}};
 };
 try{
  expect(p.env.NODE_PORT).toBe('20203');
  const stack=await startGeProofStack(p,start);
  expect(process.env.NODE_PORT).toBe('43594');
  await stageWithStoppedStack('tcp.sav',()=>stack.stop(),async()=>{events.push('stage');return 'tcp.sav';},MAGIC_CASE.position,
   ()=>startGeProofStack(p,start),()=>({...input.before,position:MAGIC_CASE.position}));
  expect(events).toEqual(['start:20203','stop','stage','start:20203']);
  expect(process.env.NODE_PORT).toBe('43594');
  const configured=geProofAccountEnv('SERVER=localhost:8888\nGATEWAY_URL=ws://localhost:7780\n',p);
  expect(assertGeProofAccount(configured,p.env)).toBe(p.server);
  for(const tcp of [43594,8888,7780,8898,p.ports.engine,p.ports.gateway,p.ports.management,NaN,1023,65536,undefined])
   expect(()=>geProofEndpoints({...p.ports,tcp:tcp as number},p.instance)).toThrow('owned practice endpoints required');
  let attempts=0;
  expect(()=>selectGeProofEndpoints(()=>{attempts++;return false;},()=>0)).toThrow('owned practice ports unavailable');
  expect(attempts).toBe(100);
 }finally{if(previous===undefined)delete process.env.NODE_PORT;else process.env.NODE_PORT=previous;}
});

function magicInput(){
 const before={...save(MAGIC_CASE.bank,MAGIC_CASE.pack),position:MAGIC_CASE.position};
 const bank=(earth:number,coins:number)=>MAGIC_CASE.bank.map(i=>({...i,count:i.id===557?earth:i.id===995?coins:i.count})).concat({id:563,count:5});
 const law=save(bank(4,14911),MAGIC_CASE.pack),earth=save(bank(5,14891),MAGIC_CASE.pack);
 const lawJournal:ItemOrder={...journal,request:{...request,item:563,quantity:5,limit:1000,reserve:10000,rescueMode:'npc-respawn-once'},coinsBefore:19911,acquired:5,refund:0,
  rescue:{phase:'bank-reconciled',lifeId:1,respawnCount:0,targetIndex:7,bank:MAGIC_CASE.bank,bankAt:1}};
 const earthJournal:ItemOrder={...journal,request:{...request,item:557,quantity:1,expectedOwned:4,limit:20,reserve:10000},coinsBefore:14911,itemsBefore:4,acquired:1,refund:0};
 const effect=(n:number)=>({ok:true,acquired:n,targetMet:true,conserved:true,unrelated:true,banked:true,reserveKept:true,died:false,damaged:false});
 const traces='START 2853 3452 0\n'+['rescue-intent','rescue-respawned','rescue-bank-reconciled'].map(stage=>'GE_MARKET_ENTRY '+JSON.stringify({stage,hp:10,position:{x:3221,z:3218,level:0}})+'\n').join('');
 const refuseBefore={...before,inventories:{...before.inventories,93:[{id:590,count:1,slot:0},{id:995,count:1,slot:1}]}};
 return{before,law,earth,repeat:law,refuseBefore,refused:refuseBefore,lawJournal,earthJournal,
  buy:{code:0,log:traces+line(effect(5))},topup:{code:0,log:line(effect(1))},again:{code:0,log:line({ok:true,newItemsThisSession:0,cashDeltaThisSession:0,offerId:7})},
  refuse:{code:1,log:'RESULT false rescue refused: sole tinderbox590 required\nLOGOUT logged-out\n'}};
}
test('pocket staging waits for stack stop completion and the buyer waits for verified staging and restart',async()=>{
 const bankSave=save(MAGIC_CASE.bank,MAGIC_CASE.pack),pocketSave={...bankSave,position:MAGIC_CASE.position};
 const stopped=Promise.withResolvers<void>(),starting=Promise.withResolvers<void>(),ready=Promise.withResolvers<void>();
 const events:string[]=[];let disk=bankSave;
 const pending=stageWithStoppedStack('x.sav',async()=>{
  events.push('stop');await stopped.promise;
  disk=bankSave;events.push('stopped');
 },async()=>{events.push('stage');disk=pocketSave;return 'x.sav';},MAGIC_CASE.position,
 async()=>{events.push('restart');starting.resolve();await ready.promise;events.push('ready');return 'owned-stack';},
 ()=>{events.push('verify');return disk;}).then(stack=>{events.push('buyer');return stack;});
 expect(events).toEqual(['stop']);
 stopped.resolve();await starting.promise;
 expect(events).toEqual(['stop','stopped','stage','verify','restart']);
 expect(disk.position).toEqual(MAGIC_CASE.position);
 ready.resolve();expect(await pending).toBe('owned-stack');
 expect(events).toEqual(['stop','stopped','stage','verify','restart','ready','buyer']);
 const refused:string[]=[];
 const stage=async()=>{refused.push('stage');return 'x.sav';},restart=async()=>{refused.push('restart');};
 await expect(stageWithStoppedStack('x.sav',async()=>{throw Error('stop failed');},stage,MAGIC_CASE.position,restart,()=>pocketSave)).rejects.toThrow('stop failed');
 expect(refused).toEqual([]);
 await expect(stageWithStoppedStack('x.sav',async()=>{},stage,MAGIC_CASE.position,restart,()=>bankSave)).rejects.toThrow('unconfirmed at 3185,3436,0');
 expect(refused).toEqual(['stage']);
});
// Minimal v9 save bytes in the layout readPracticeSave decodes.
function saveBytes(position:{x:number;z:number;level:number},inventories:Record<number,{id:number;count:number}[]>){
 const b=Buffer.alloc(1024);b.writeUInt16BE(0x2004,0);b.writeUInt16BE(9,2);b.writeUInt16BE(position.x,4);b.writeUInt16BE(position.z,6);b.writeUInt8(position.level,8);
 for(let i=0;i<21;i++)b.writeUInt8(i===3?10:1,32+i*5);
 let at=133;b.writeUInt16BE(0,at);at+=2;const types=Object.keys(inventories);b.writeUInt8(types.length,at++);
 for(const type of types){const items=inventories[Number(type)]!;b.writeUInt16BE(Number(type),at);b.writeUInt16BE(items.length,at+2);at+=4;
  for(const i of items){b.writeUInt16BE(i.id+1,at);at+=2;if(i.count<255)b.writeUInt8(i.count,at++);else{b.writeUInt8(255,at++);b.writeInt32BE(i.count,at);at+=4;}}}
 const out=b.subarray(0,at+4);out.writeUInt32BE(Bun.hash.crc32(out.subarray(0,at))>>>0,at);return out;
}
test('pocket staging replaces only the buyer bank checkpoint that PlayerLoading prefers over the .sav',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ge-checkpoint-')),pocketPath=join(dir,'pocket.sav'),evidence=join(dir,'before-checkpoint.sav');
 const kit={93:MAGIC_CASE.pack,94:[],95:MAGIC_CASE.bank},pocket=saveBytes(MAGIC_CASE.position,kit),bank=saveBytes({x:3185,z:3436,level:0},kit);
 writeFileSync(pocketPath,pocket);
 const db=new Database(':memory:');
 db.exec("CREATE TABLE accounts(owner TEXT PRIMARY KEY, save BLOB NOT NULL);CREATE TABLE offers(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open')");
 const other=saveBytes({x:3200,z:3200,level:0},{95:[{id:995,count:7}]});
 db.query('INSERT INTO accounts VALUES (?,?),(?,?)').run('flgemag1',bank,'other',other);
 db.query("INSERT INTO offers(owner,slot,state) VALUES ('flgemag1',-1,'done'),('other',0,'open')").run();
 const row=(owner:string)=>Buffer.from(db.query<{save:Uint8Array},[string]>('SELECT save FROM accounts WHERE owner=?').get(owner)!.save);
 try{
  expect(syncPracticeCheckpoint(db,'FlGeMag1',pocketPath,MAGIC_CASE.position,evidence)).toEqual({x:3185,z:3436,level:0});
  expect(readPracticeSave(evidence).position).toEqual({x:3185,z:3436,level:0});
  expect(Buffer.compare(row('flgemag1'),pocket)).toBe(0);
  expect(Buffer.compare(row('other'),other)).toBe(0);
  // Refusals leave the checkpoint unchanged: open buyer offer, changed assets, wrong pocket position.
  db.query('UPDATE accounts SET save=? WHERE owner=?').run(bank,'flgemag1');
  db.query("INSERT INTO offers(owner,slot,state) VALUES ('flgemag1',2,'open')").run();
  expect(()=>syncPracticeCheckpoint(db,'flgemag1',pocketPath,MAGIC_CASE.position,evidence)).toThrow('1 outstanding GE offers');
  db.query("DELETE FROM offers WHERE owner='flgemag1' AND slot=2").run();
  db.query('UPDATE accounts SET save=? WHERE owner=?').run(saveBytes({x:3185,z:3436,level:0},{...kit,95:MAGIC_CASE.bank.slice(1)}),'flgemag1');
  expect(()=>syncPracticeCheckpoint(db,'flgemag1',pocketPath,MAGIC_CASE.position,evidence)).toThrow('checkpoint assets differ');
  db.query('UPDATE accounts SET save=? WHERE owner=?').run(bank,'flgemag1');
  expect(()=>syncPracticeCheckpoint(db,'flgemag1',pocketPath,{x:3185,z:3436,level:0},evidence)).toThrow('pocket save position unconfirmed');
  expect(Buffer.compare(row('flgemag1'),bank)).toBe(0);
  expect(syncPracticeCheckpoint(db,'absent',pocketPath,MAGIC_CASE.position,evidence)).toBeNull();
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('saved exact pocket rescue, law five and authorized earth four-plus-one reconcile the full kit,5020 cap and10000 reserve',()=>{
 expect(Object.values(magicOrderChecks(magicInput())).every(Boolean)).toBe(true);
});
test('magic consumer rejects missing rescue, repeated intent, missing law, excess earth, lost bank assets and absent logout',()=>{
 const p=magicInput();
 expect(magicOrderChecks({...p,buy:{...p.buy,log:line({ok:true})}}).rescue).toBe(false);
 expect(magicOrderChecks({...p,buy:{...p.buy,log:'GE_MARKET_ENTRY {"stage":"rescue-intent"}\n'+p.buy.log}}).rescue).toBe(false);
 expect(magicOrderChecks({...p,law:save([{id:995,count:14911}],MAGIC_CASE.pack)}).laws).toBe(false);
 expect(magicOrderChecks({...p,earth:save([{id:557,count:6},{id:995,count:14891}],MAGIC_CASE.pack)}).topup).toBe(false);
 expect(magicOrderChecks({...p,law:{...p.law,inventories:{...p.law.inventories,95:p.law.inventories[95].filter(i=>i.id!==1351)}}}).assets).toBe(false);
 expect(magicOrderChecks({...p,topup:{...p.topup,log:p.topup.log.replace('LOGOUT logged-out','LOGOUT timeout')}}).logout).toBe(false);
});
test('magic consumer rejects an unproved top-up baseline, changed refusal assets, repeat mutation and extra spend',()=>{
 const p=magicInput();
 expect(magicOrderChecks({...p,earthJournal:{...p.earthJournal,request:{...p.earthJournal.request,expectedOwned:undefined}}}).topup).toBe(false);
 expect(magicOrderChecks({...p,refused:p.law}).refusal).toBe(false);
 expect(magicOrderChecks({...p,repeat:p.earth}).restart).toBe(false);
 const costly={...p.earth,inventories:{...p.earth.inventories,95:p.earth.inventories[95].map(i=>i.id===995?{...i,count:i.count-1}:i)}};
 expect(magicOrderChecks({...p,earth:costly}).costs).toBe(false);
 expect(magicOrderChecks({...p,lawJournal:{...p.lawJournal,rescue:undefined}}).rescue).toBe(false);
});

test('exact banked quantity, bounded spend, kept reserve and resumed rerun pass',()=>{
 expect(bulkOrderChecks(input)).toEqual({entry:true,seller:true,bank:true,assets:true,pack:true,coins:true,journal:true,result:true,logout:true,restart:true,healthy:true});
});
test('north Varrock case requires the saved north start, carried food and coins, the north approach and the exact bank order',()=>{
 const o=NORTH_CASE.order,carry=NORTH_CASE.carried,salmon=carry.filter(i=>i.id===329);
 const before={...save([{id:995,count:o.coins},{id:329,count:2}],carry),position:NORTH_CASE.position};before.skills[3]!.level=NORTH_CASE.hitpoints;
 const total=o.coins+60,spent=o.quantity*o.ask;
 const after=save([{id:995,count:total-spent},{id:o.item,count:o.quantity},{id:329,count:2}],salmon);after.skills[3]!.level=NORTH_CASE.hitpoints;
 const j:ItemOrder={...journal,request:{...request,quantity:o.quantity},coinsBefore:total,acquired:o.quantity,refund:o.quantity*(o.limit-o.ask)};
 const p={...input,before,after,repeat:after,journal:j,order:o,buy:{code:0,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,
  acquired:o.quantity,spent,phase:'settled',offerId:7})}};
 expect(Object.values(bulkOrderChecks(p)).every(Boolean)).toBe(true);
 const trace='START 3165 3487 0\nGE_MARKET_ENTRY {"stage":"north-approach"}\n';
 expect(northEntryCheck(before,trace)).toBe(true);
 expect(northEntryCheck(input.before,trace)).toBe(false);
 expect(northEntryCheck(before,'START 3165 3487 0\n')).toBe(false);
 expect(northEntryCheck(before,'START 3185 3436 0\nGE_MARKET_ENTRY {"stage":"north-approach"}\n')).toBe(false);
 expect(bulkOrderChecks({...p,after:save([{id:995,count:total-spent},{id:o.item,count:o.quantity}],carry)}).pack).toBe(false);
 expect(bulkOrderChecks({...p,after:save([{id:995,count:total-spent+3},{id:o.item,count:o.quantity-1},{id:329,count:2}],salmon)}).bank).toBe(false);
 expect(bulkOrderChecks({...p,repeat:save([{id:995,count:total-2*spent},{id:o.item,count:o.quantity*2},{id:329,count:2}],salmon)}).restart).toBe(false);
});
test('a duplicate order key refuses without GE mutation, keeps assets and logs out',()=>{
 const owned=save([{id:995,count:1100},{id:1987,count:300}]);
 const refused=(r:object,code=1)=>({code,log:line(r)});
 const ok={ok:false,phase:'unplaced',failure:'Error: owned item already present;allocate it instead of buying duplicate stock',newItemsThisSession:0,cashDeltaThisSession:0};
 expect(duplicateRefusalCheck(owned,owned,refused(ok),1987)).toBe(true);
 expect(duplicateRefusalCheck(owned,owned,refused(ok,0),1987)).toBe(false);
 expect(duplicateRefusalCheck(owned,owned,refused({...ok,phase:'settled'}),1987)).toBe(false);
 expect(duplicateRefusalCheck(owned,owned,refused({...ok,failure:'Error: GE interface unavailable'}),1987)).toBe(false);
 expect(duplicateRefusalCheck(owned,save([{id:995,count:1000},{id:1987,count:300}]),refused(ok),1987)).toBe(false);
 expect(duplicateRefusalCheck(owned,owned,{code:1,log:'OWNED_GE_ITEM '+JSON.stringify(ok)+'\n'},1987)).toBe(false);
});
test('a short fill, an overspend or a lost reserve fails the consumer',()=>{
 expect(bulkOrderChecks({...input,after:save([{id:995,count:1100},{id:1987,count:299}])}).bank).toBe(false);
 expect(bulkOrderChecks({...input,after:save([{id:995,count:499},{id:1987,count:300}])}).coins).toBe(false);
 expect(bulkOrderChecks({...input,order:{...ORDER,reserve:1200}}).coins).toBe(false);
});
test('banknotes left in the pack are not banked stock',()=>{
 expect(bulkOrderChecks({...input,after:save([{id:995,count:1100}],[{id:1988,count:300}])}).bank).toBe(false);
 expect(bulkOrderChecks({...input,after:save([{id:995,count:1100},{id:1987,count:300}],[{id:1988,count:1}])}).pack).toBe(false);
});
test('a rerun that places, buys or changes cash again is not a resume',()=>{
 expect(bulkOrderChecks({...input,again:{code:0,log:line({ok:true,phase:'settled',offerId:8,newItemsThisSession:0,cashDeltaThisSession:0})}}).restart).toBe(false);
 expect(bulkOrderChecks({...input,again:{code:0,log:line({ok:true,phase:'settled',offerId:7,newItemsThisSession:300,cashDeltaThisSession:-900})}}).restart).toBe(false);
 expect(bulkOrderChecks({...input,repeat:save([{id:995,count:200},{id:1987,count:600}])}).restart).toBe(false);
});
test('journal must agree with the saved coin delta and the exact quantity',()=>{
 expect(bulkOrderChecks({...input,journal:{...journal,refund:601}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...journal,acquired:299}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:null}).journal).toBe(false);
 expect(bulkOrderChecks({...input,buy:{code:0,log:'LOGOUT logged-out\n'}}).result).toBe(false);
});

test('the receipt must bind the banked result to the journal offer and reserve',()=>{
 expect(bulkOrderChecks({...input,journal:{...journal,coinsBefore:1999}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...journal,request:{...request,reserve:99}}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,buy:{code:0,log:line({ok:true,targetMet:true,conserved:true,acquired:300,spent:900,phase:'open',offerId:7})}}).result).toBe(false);
});

test('rerun must preserve carried assets, health and the observed bank area',()=>{
 expect(bulkOrderChecks({...input,repeat:save([{id:995,count:1100},{id:1987,count:300}],[{id:1,count:1}])}).restart).toBe(false);
 const hurt=save([{id:995,count:1100},{id:1987,count:300}]);hurt.skills[3]!.level=9;
 expect(bulkOrderChecks({...input,repeat:hurt}).healthy).toBe(false);
 const moved={...input.repeat,position:{x:3200,z:3436,level:0}};
 expect(bulkOrderChecks({...input,repeat:moved}).healthy).toBe(false);
});

test('logout text must be a complete confirmation line for each participant',()=>{
 expect(bulkOrderChecks({...input,buy:{...input.buy,log:input.buy.log.replace('LOGOUT logged-out','WARN LOGOUT logged-out failed')}}).logout).toBe(false);
 expect(bulkOrderChecks({...input,sell:{...input.sell,log:'GE_SELL_RESULT {"ok":true}\n'}}).seller).toBe(false);
});

test('saved low HP entry must account for exactly one owned salmon and observed healing',()=>{
 const before=save([{id:995,count:2000},{id:329,count:2}]);before.skills[3]!.level=3;
 const after=save([{id:995,count:1100},{id:1987,count:300},{id:329,count:1}]);
 const p={...input,before,after,repeat:after,buy:{...input.buy,log:line({ok:true,targetMet:true,conserved:true,banked:true,reserveKept:true,acquired:300,spent:900,phase:'settled',offerId:7,foodUsed:[{id:329,count:1}]})}};
 expect(Object.values(bulkOrderChecks(p)).every(Boolean)).toBe(true);
 expect(bulkOrderChecks({...p,after:save([{id:995,count:1100},{id:1987,count:300}])}).assets).toBe(false);
 const hurt={...after,skills:after.skills.map(s=>({...s}))};hurt.skills[3]!.level=3;
 expect(bulkOrderChecks({...p,after:hurt}).healthy).toBe(false);
});

test('the consumer rejects a lost unrelated bank item on either purchase or rerun',()=>{
 const before=save([{id:995,count:2000},{id:1351,count:1}]);
 expect(bulkOrderChecks({...input,before}).assets).toBe(false);
 const after=save([{id:995,count:1100},{id:1987,count:300},{id:1351,count:1}]);
 expect(bulkOrderChecks({...input,before,after}).assets).toBe(false);
});


test('saved exact output accepts cumulative recovery receipts and rejects a reused offer',()=>{
 const recovered:ItemOrder={...journal,rounds:[{offerId:6,quantity:300,acquired:120,refund:1140}],
  progress:{actor:request.actor,server:request.server,offerId:7,itemId:1987,side:'buy',quantity:180,limit:5,filled:180,gross:540,tax:0,at:4}};
 expect(Object.values(bulkOrderChecks({...input,journal:recovered})).every(Boolean)).toBe(true);
 expect(bulkOrderChecks({...input,journal:{...recovered,rounds:[{...recovered.rounds![0]!,offerId:7}]}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...recovered,progress:{...recovered.progress!,quantity:300}}}).journal).toBe(false);
 expect(bulkOrderChecks({...input,journal:{...recovered,progress:{...recovered.progress!,gross:539}}}).journal).toBe(false);
});
import './shop-supply-order-proof.test';
