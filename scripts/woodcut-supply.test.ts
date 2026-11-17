import {test,expect} from 'bun:test';
import {existsSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {fakeSession,at} from '../packages/core/test/fake';
import {supplyPlan,runWoodSupply,takeOwnedSupplyKnife,selectWoodSupplyAxe,reconcileWoodSupplyAxe} from './woodcut-supply';
test('retained log supply admits only a finite accounting-compatible headless batch',()=>{
 expect(supplyPlan(25,165,3000)).toEqual({logs:25,headless:165,shafts:375});
 for(const args of [[0,0,3000],[26,0,3000],[25,180,3000],[25,164,3000],[25,165,0],[NaN,0,3000]])expect(()=>supplyPlan(...args as [number,number,number])).toThrow();
});

test('a stop at the current bank permits no bank or inventory action',async()=>{
 const file='.practice/stop-Supplystop';mkdirSync('.practice',{recursive:true});writeFileSync(file,'unit-owned stop',{flag:'wx'});
 let calls=0,released=false;
 const session:any={name:'Supplystop',tick:()=>0,onTick:()=>()=>{released=true;},sdk:{getSkill:()=>({level:54}),getInventory:()=>[],getState:()=>({player:{worldX:3092,worldZ:3243,level:0,isDead:false}})},bot:{openBank:async()=>{calls++;throw Error('unexpected bank action');}}};
 try{const r=await runWoodSupply(session,1,0,3000);expect(r.ok).toBe(false);expect(r).toHaveProperty('error','Error: supply stopped, capped or damaged');expect(calls).toBe(0);expect(released).toBe(true);}
 finally{unlinkSync(file);}
});

function knifeBank(stock=1,mode='observed'){
 let generation=3;const ticks=fakeSession([at(3092,3243)]);
 const pack:{id:number;name:string;count:number}[]=[{id:1351,name:'Bronze axe',count:1}],bank:{id:number;name:string;count:number}[]=stock?[{id:946,name:'Knife',count:stock}]:[];
 const calls:{id:number;amount:number;notes:boolean}[]=[];
 const s:any={...ticks,name:'Supplyknife',bankObservation:()=>({generation,items:bank}),
  sdk:{getInventory:()=>pack,getState:()=>({player:{worldX:3092,worldZ:3243,level:0,isDead:false},bank:{isOpen:true,items:bank}})},
  bot:{withdrawItem:async(item:any,amount:number,o:any)=>{calls.push({id:item.id,amount,notes:o.asNote});if(mode==='refused')return{success:false};
   if(mode!=='no-debit')bank[0]!.count-=amount;
   if(mode!=='no-credit')pack.push({id:946,name:'Knife',count:amount});
   if(mode!=='no-generation')generation++;return{success:true};}}};
 return{s,pack,bank,calls,advance:(n:number)=>ticks.run(n)};
}

test('an owned bank knife is reused once with unnoted debit and pack credit',async()=>{
 const f=knifeBank(2);expect(await takeOwnedSupplyKnife(f.s,()=>{})).toBe('withdrawn');
 expect(f.calls).toEqual([{id:946,amount:1,notes:false}]);expect(f.bank[0]!.count).toBe(1);
 expect(f.pack.filter(i=>i.id===946).reduce((n,i)=>n+i.count,0)).toBe(1);
 expect(f.pack.filter(i=>i.id===946).reduce((n,i)=>n+i.count,0)+f.bank[0]!.count).toBe(2);
});

test('only observed absence selects the spawn fallback; a held knife needs no bank action',async()=>{
 const f=knifeBank(0);expect(await takeOwnedSupplyKnife(f.s,()=>{})).toBe('missing');expect(f.calls).toEqual([]);
 f.pack.push({id:946,name:'Knife',count:1});f.s.bankObservation=()=>null;
 expect(await takeOwnedSupplyKnife(f.s,()=>{})).toBe('held');expect(f.calls).toEqual([]);
 const unknown=knifeBank(0);unknown.s.bankObservation=()=>null;
 await expect(takeOwnedSupplyKnife(unknown.s,()=>{})).rejects.toThrow('bank unobserved');expect(unknown.calls).toEqual([]);
});

test('an owner stop before withdrawal prevents inventory actions',async()=>{
 for(const when of [1,2]){
  const f=knifeBank();let checks=0;
  await expect(takeOwnedSupplyKnife(f.s,()=>{if(++checks===when)throw Error('owner stopped');})).rejects.toThrow('owner stopped');
  expect(f.calls).toEqual([]);expect(f.bank[0]!.count).toBe(1);expect(f.pack.some(i=>i.id===946)).toBe(false);
 }
});

test('refused and unobserved withdrawals stop instead of acquiring a duplicate knife',async()=>{
 const refused=knifeBank(1,'refused');await expect(takeOwnedSupplyKnife(refused.s,()=>{})).rejects.toThrow('withdrawal refused');
 expect(refused.calls).toHaveLength(1);expect(refused.bank[0]!.count).toBe(1);expect(refused.pack.some(i=>i.id===946)).toBe(false);
 for(const mode of ['no-credit','no-debit','no-generation']){
  const f=knifeBank(1,mode),pending=takeOwnedSupplyKnife(f.s,()=>{});
  const failure=pending.catch(error=>error);await f.advance(6);const error=await failure;expect(error).toBeInstanceOf(Error);expect(error.message).toContain('withdrawal unobserved');
  expect(f.calls).toHaveLength(1);
 }
});

test('a stop received while the initial bank opens prevents knife withdrawal and spawn acquisition',async()=>{
 const file='.practice/stop-Supplymid';mkdirSync('.practice',{recursive:true});if(existsSync(file))throw Error('test stop already exists');
 const f=knifeBank();f.s.name='Supplymid';f.s.sdk.getSkill=()=>({level:54});let opens=0;
 f.s.bot.openBank=async()=>{opens++;writeFileSync(file,'unit-owned bank-open stop',{flag:'wx'});return{success:true};};
 try{
  const r=await runWoodSupply(f.s,1,0,3000);expect(r.ok).toBe(false);expect(r).toHaveProperty('error','Error: supply stopped, capped or damaged');
  expect(opens).toBe(1);expect(f.calls).toEqual([]);expect(f.bank[0]!.count).toBe(1);expect(f.pack.some(i=>i.id===946)).toBe(false);
 }finally{if(existsSync(file))unlinkSync(file);}
});
test('a stop that lands while the bank opens permits no deposit',async()=>{
 const file='.practice/stop-Supplybank';mkdirSync('.practice',{recursive:true});if(existsSync(file))unlinkSync(file);
 let deposits=0;
 const inventory=[{id:1351,name:'Bronze axe',count:1,slot:0},{id:946,name:'Knife',count:1,slot:1}];
 const session:any={name:'Supplybank',tick:()=>0,onTick:()=>()=>{},sdk:{getSkill:()=>({level:54}),getInventory:()=>inventory,getState:()=>({player:{worldX:3092,worldZ:3243,level:0,isDead:false},bank:{isOpen:true,items:[]}})},
  bot:{openBank:async()=>{writeFileSync(file,'unit-owned stop',{flag:'wx'});return {success:true};},depositItem:async()=>{deposits++;return {success:true};},closeBank:async()=>({success:true})}};
 try{const r=await runWoodSupply(session,1,0,3000);expect(r.ok).toBe(false);expect(r).toHaveProperty('error','Error: supply stopped, capped or damaged');expect(deposits).toBe(0);}
 finally{if(existsSync(file))unlinkSync(file);}
});

test('reconcileWoodSupplyAxe swaps starter Bronze for higher owned/Bob axe and equips when Attack permits',async()=>{
 let open=true,shopOpen=false,gen=1;const ticks=fakeSession([at(3092,3243)]);
 const pack:any[]=[{id:1351,name:'Bronze axe',count:1}],eq:any[]=[];
 const bank:any[]=[{id:1359,name:'Rune axe',count:1},{id:995,name:'Coins',count:500}];
 const shopItems=[{id:1353,name:'Steel axe',count:3,buyPrice:200}];
 let attack=1;
 const s:any={...ticks,name:'Supplyaxe',bankObservation:()=>open?{generation:gen,items:bank}:null,
  sdk:{getInventory:()=>pack,getEquipment:()=>eq,getSkill:(n:string)=>({level:n==='Attack'?attack:15,baseLevel:n==='Attack'?attack:15}),getState:()=>({player:{worldX:3092,worldZ:3243,level:0,isDead:false},bank:{isOpen:open,items:bank},shop:{isOpen:shopOpen,shopItems}})},
  bot:{openBank:async()=>{open=true;gen++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
   withdrawItem:async(item:any,n:number)=>{const r=bank.find(v=>v.id===item.id);r.count-=n;if(r.count<=0)bank.splice(bank.indexOf(r),1);pack.push({id:item.id,name:item.name,count:n});gen++;return{success:true};},
   depositItem:async(item:any)=>{const idx=pack.findIndex(v=>v.id===item.id);const[rm]=pack.splice(idx,1);const r=bank.find(v=>v.id===rm.id);if(r)r.count+=rm.count;else bank.push({...rm});gen++;return{success:true};},
   equipItem:async(item:any)=>{open=false;const idx=pack.findIndex(v=>v.id===item.id);const[rm]=pack.splice(idx,1);eq.push({...rm,slot:3});return{success:true};},
   openShop:async()=>{shopOpen=true;return{success:true};},buyFromShop:async()=>({success:true}),closeShop:async()=>{shopOpen=false;return{success:true};}}};

 expect(selectWoodSupplyAxe(bank,{Woodcutting:1,Attack:1}).current?.item.id).toBe(1359);
 const lowId=await reconcileWoodSupplyAxe(s,{check:()=>{},allowShop:false});
 expect(lowId).toBe(1359);expect(pack.map(i=>i.id)).toEqual([1359]);expect(eq).toHaveLength(0);expect(bank.find(i=>i.id===1351)?.count).toBe(1);

 attack=40;
 const highId=await reconcileWoodSupplyAxe(s,{check:()=>{},allowShop:false});
 expect(highId).toBe(1359);expect(eq[0]?.id).toBe(1359);expect(pack).toHaveLength(0);
});
