import {test,expect} from 'bun:test';
import type {Session} from '../packages/core/src/inprocess';
import {runPreservedWine,wineStockChecks,type WineStock} from './make-wine-order';
import {intentForEntry,loadProgressionCatalog} from '../packages/planner/src/progression-catalog';
import {resultCounters} from '../packages/core/src/status';
import {preflightProgressionWork} from '../packages/core/src/progression-session';
import {resolveLogisticsStep} from './aio-logistics';

function fixture(mode='ok'){
 let tick=0,generation=0,open=false,stopped=false,unsafeCloses=0;
 const inventory=[{id:995,count:777,slot:0,name:'Coins'}];
 const bank=[{id:1987,count:4,slot:0,name:'Grapes'},{id:1937,count:4,slot:1,name:'Jug of water'},{id:2347,count:1,slot:2,name:'Hammer'}];
 const names:Record<number,string>={1987:'Grapes',1937:'Jug of water',1995:'Unfermented wine',1996:'Unfermented wine'};
 const add=(rows:typeof inventory,id:number,n:number)=>{const old=rows.find(i=>i.id===id);if(old)old.count+=n;else rows.push({id,count:n,slot:rows.length,name:names[id]??String(id)});};
 const remove=(rows:typeof inventory,id:number,n:number)=>{const i=rows.findIndex(i=>i.id===id);if(i<0||rows[i]!.count<n)throw Error('test stock missing');rows[i]!.count-=n;if(!rows[i]!.count)rows.splice(i,1);};
 const listeners=new Set<()=>void>(),timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
 const session={name:'fixture',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  bankObservation:()=>generation&&(mode!=='reading-ends-on-close'||open)?{generation,at:tick,items:bank}:undefined,
  sdk:{getState:()=>({player:{lifeId:1,isDead:false},bank:{isOpen:open,items:bank},inventory,interface:{isOpen:false},dialog:{isOpen:false}}),
   getInventory:()=>inventory,getEquipment:()=>[],getSkill:(skill:string)=>({baseLevel:skill==='Cooking'?82:99,level:99}),getSkillXp:()=>0,
   sendUseItemOnItem:async()=>{remove(inventory,1987,1);remove(inventory,1937,1);add(inventory,1995,1);tick++;return{success:true};}},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{if(inventory.some(i=>i.id===1995)||bank.some(i=>i.id===1995))unsafeCloses++;open=false;tick++;return{success:true};},
   withdrawItem:async(item:{id:number},n:number,o:{asNote:boolean})=>{if(o.asNote&&mode==='note-refused')return{success:false};remove(bank,item.id,n);add(inventory,o.asNote?1996:item.id,n);if(mode!=='stale-withdraw')generation++;if(mode==='stop-after-withdraw')stopped=true;return{success:true};},
   depositItem:async(item:{id:number})=>{const n=inventory.filter(i=>i.id===item.id).reduce((a,i)=>a+i.count,0);remove(inventory,item.id,n);add(bank,item.id,n);generation++;if(mode==='asset-loss')remove(inventory,995,1);return{success:true};}},
  direct:async()=>({success:true})}as unknown as Session;
 return {session,stop:()=>stopped,close:()=>clearInterval(timer),inventory,bank,unsafeCloses:()=>unsafeCloses};
}

test('each real pair is deposited and noted before the next bank close; reserves and assets remain',async()=>{
 const f=fixture();try{
  const result=await runPreservedWine(f.session,{maximum:2,cap:100,reserve:2});
  expect(result).toMatchObject({ok:true,made:2,noted:2,inputs:{grapes:2,water:2},assets:true});
  expect(f.inventory.filter(i=>i.id===1996).reduce((n,i)=>n+i.count,0)).toBe(2);
  expect(f.bank.filter(i=>i.id===1987||i.id===1937).map(i=>i.count)).toEqual([2,2]);
  expect(f.unsafeCloses()).toBe(0);
 }finally{f.close();}
});
test('the used inputs come from the stock read with the bank open, when the session holds no bank reading after the close',async()=>{
 const f=fixture('reading-ends-on-close');try{
  const result=await runPreservedWine(f.session,{maximum:2,cap:100,reserve:2});
  expect(result).toMatchObject({ok:true,made:2,noted:2,inputs:{grapes:2,water:2},assets:true});
  expect(f.session.bankObservation?.()).toBeUndefined();
 }finally{f.close();}
});
test('a refused note withdrawal leaves the raw bank modal open and cannot claim preserved stock',async()=>{
 const f=fixture('note-refused');try{
  expect((await runPreservedWine(f.session,{maximum:2,cap:100})).ok).toBe(false);
  expect(f.bank.find(i=>i.id===1995)?.count).toBe(1);expect(f.unsafeCloses()).toBe(0);
 }finally{f.close();}
});
test('an unpaired bank debit, a stop, and unrelated lost coins each reject the order',async()=>{
 for(const mode of ['stale-withdraw','stop-after-withdraw','asset-loss']){
  const f=fixture(mode);try{expect((await runPreservedWine(f.session,{maximum:2,cap:100},f.stop)).ok).toBe(false);}finally{f.close();}
 }
});
test('existing raw wine and short staged inputs refuse production without spending grapes',async()=>{
 for(const raw of [false,true]){
  const f=fixture();if(raw)f.bank.push({id:1995,count:1,slot:3,name:'Unfermented wine'});
  try{expect((await runPreservedWine(f.session,{maximum:raw?2:5,cap:100})).ok).toBe(false);expect(f.bank.find(i=>i.id===1987)?.count).toBe(4);}finally{f.close();}
 }
});
test('exact reconciliation rejects fermented substitution, a missing input debit and equipment loss',()=>{
 const before:WineStock={items:{1987:4,1937:4,995:777},equipment:[{id:1277,count:1,slot:3}],xp:0};
 const after:WineStock={items:{1987:2,1937:2,1996:2,995:777},equipment:before.equipment,xp:0};
 expect(Object.values(wineStockChecks(before,after,2)).every(Boolean)).toBe(true);
 expect(wineStockChecks(before,{...after,items:{1987:2,1937:2,1993:2,995:777}},2).output).toBe(false);
 expect(wineStockChecks(before,{...after,items:{...after.items,1987:3}},2).inputs).toBe(false);
 expect(wineStockChecks(before,{...after,equipment:[]},2).equipment).toBe(false);
});
test('invalid limits cannot dispatch any production action',async()=>{
 const f=fixture();try{for(const maximum of [0,1.5,NaN])await expect(runPreservedWine(f.session,{maximum,cap:100})).rejects.toThrow('invalid preserved wine order');}finally{f.close();}
});
test('the AIO route and live admission retain a finite new-notes counter rather than a bank target',()=>{
 const step=resolveLogisticsStep('wine-stock',['12','1000','2']);
 expect(step).toEqual({script:'scripts/make-wine-order.ts',args:['12','1000','2'],env:{}});
 const accept={counters:{preservedWine:12}},env={PROGRESSION_CONSUMER:JSON.stringify(accept)};
 expect(intentForEntry(step.script,step.args,{},accept)).toMatchObject({kind:'service',units:1});
 expect(()=>preflightProgressionWork({...step,env},'rs-sdk-demo.fly.dev',loadProgressionCatalog())).not.toThrow();
 expect(intentForEntry(step.script,step.args,{},{bank:{1995:12}})).toBeNull();
 expect(intentForEntry(step.script,step.args,{},{counters:{preservedWine:11}})).toBeNull();
 expect(intentForEntry(step.script,['0','1000'])).toBeNull();
 expect(intentForEntry(step.script,['12','1000','0','extra'])).toBeNull();
 expect(resultCounters('ok preservedWine=12 grapesUsed=12 waterUsed=12 assets=1')).toMatchObject({preservedWine:12,grapesUsed:12,waterUsed:12,assets:1});
});
