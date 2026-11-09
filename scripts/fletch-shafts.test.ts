import {expect,test} from 'bun:test';
import {runShafts} from './fletch-shafts';

function fixture(mode='ok',logs=25){
 let tick=0,xp=0,open=false,generation=0,calls=0,stopped=false;
 const bank:any[]=[{id:1511,name:'Logs',count:logs,slot:0},{id:946,name:'Knife',count:1,slot:1}];
 let inventory:any[]=[{id:995,name:'Coins',count:20,slot:0}];const listeners=new Set<()=>void>();
 const add=(rows:any[],id:number,name:string,n:number)=>{const old=rows.find(i=>i.id===id);if(old)old.count+=n;else rows.push({id,name,count:n,slot:rows.length});};
 const timer=setInterval(()=>{tick++;for(const cb of listeners)cb();},1);
 const s:any={name:'test',tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  bankObservation:()=>open?{generation,items:bank}:undefined,
  sdk:{getInventory:()=>inventory,getEquipment:()=>[],getSkill:()=>({level:10,baseLevel:10}),getSkillXp:()=>xp,
   getState:()=>({player:{worldX:3092,worldZ:3243,level:0,lifeId:1,respawnCount:0},bank:{isOpen:open,items:open?bank:[]}})},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
   withdrawItem:async(i:any,n:number)=>{i.count-=n;add(inventory,i.id,i.name,n);return{success:true};},
   depositItem:async(i:any)=>{const n=i.count;add(bank,i.id,i.name,n);inventory=inventory.filter(row=>row.id!==i.id);return{success:true};},
   fletchLogs:async(product:string)=>{expect(open).toBe(false);expect(product).toBe('Arrow Shafts');calls++;
    if(mode==='stalled')return{success:false};
    inventory.find(i=>i.id===1511).count--;inventory=inventory.filter(i=>i.count>0);
    if(mode!=='debit-only'){add(inventory,52,'Arrow shaft',15);xp+=125;}
    if(mode==='stop')stopped=true;return{success:true};}}};
 return{s,bank,inv:()=>inventory,calls:()=>calls,stop:()=>stopped,close:()=>clearInterval(timer)};
}
test('25 owned normal logs become375 banked shafts through the crafting dialog; unrelated kit is conserved',async()=>{
 const f=fixture();try{const r=await runShafts(f.s,{cap:1000,maximum:25,reserve:0});
  expect(r.ok).toBe(true);expect(r.logsUsed).toBe(25);expect(r.banked).toBe(375);expect(r.preserved).toBe(true);expect(f.calls()).toBe(25);
  expect(f.inv().find(i=>i.id===995)?.count).toBe(20);expect(f.inv().some(i=>[52,1511].includes(i.id))).toBe(false);
 }finally{f.close();}
});
test('empty stock ends without craft retries, and unchanged crafting stops after three calls',async()=>{
 for(const [mode,logs,calls]of[['ok',0,0],['stalled',25,3]]as const){const f=fixture(mode,logs);try{
  const r=await runShafts(f.s,{cap:1000,maximum:25,reserve:0});expect(r.ok).toBe(false);expect(f.calls()).toBe(calls);expect(r.preserved).toBe(true);
 }finally{f.close();}}
});
test('a missing product never counts a consumed log as success; stop banks partial work without another craft',async()=>{
 for(const mode of ['debit-only','stop']){const f=fixture(mode);try{
  const r=await runShafts(f.s,{cap:1000,maximum:25,reserve:0,stop:f.stop});expect(r.ok).toBe(false);expect(f.calls()).toBe(1);
  if(mode==='debit-only')expect(r.failure).toContain('accounting');else{expect(r.banked).toBe(15);expect(r.preserved).toBe(true);expect(r.stop).toBe('stopped');}
 }finally{f.close();}}
});

test('a gathering cycle can request its knife banked so it regains all25 log slots next time',async()=>{
 const f=fixture();try{
  const r=await runShafts(f.s,{cap:1000,maximum:25,reserve:0,bankKnife:true});
  expect(r.ok).toBe(true);expect(r.knifeStored).toBe(true);expect(f.inv().some(i=>i.id===946)).toBe(false);
  expect(f.bank.find(i=>i.id===946)?.count).toBe(1);expect(r.preserved).toBe(true);
 }finally{f.close();}
});
test('an owner pause permits no further bank action: no withdrawal, and no cleanup deposit after crafting',async()=>{
 const before=fixture();try{
  const r=await runShafts(before.s,{cap:1000,maximum:25,reserve:0,pause:()=>true});expect(r.ok).toBe(false);expect(before.calls()).toBe(0);
  expect(before.inv().some(i=>[946,1511].includes(i.id))).toBe(false);expect(before.bank.find(i=>i.id===1511)?.count).toBe(25);
 }finally{before.close();}
 const during=fixture('stop');try{
  const r=await runShafts(during.s,{cap:1000,maximum:25,reserve:0,pause:during.stop});expect(r.ok).toBe(false);expect(r.stop).toBe('stopped');expect(during.calls()).toBe(1);
  expect(during.inv().find(i=>i.id===52)?.count).toBe(15);expect(during.bank.some(i=>i.id===52)).toBe(false);
 }finally{during.close();}
});
