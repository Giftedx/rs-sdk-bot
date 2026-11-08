import {test,expect} from 'bun:test';
import {furnaceGlassRecipe,runFurnaceGlass,glassSupplyOptions,planGlassSupply,glassSupplyLedger,runGlassSupply,runBankedGlass,type GlassSupplyIO,type GlassStock} from './microbot-glass';
import {productionEffect} from './microbot-production';
test('native furnace glass requires sand, ash, glass, empty bucket and XP',()=>{
 const b={items:{1783:1,1781:1},xp:100},a={items:{1775:1,1925:1},xp:120};
 expect(productionEffect(furnaceGlassRecipe,b,a)).toBe('made');
 expect(productionEffect(furnaceGlassRecipe,b,{items:{1775:1},xp:120})).toBe('invalid');
});
const options=()=>glassSupplyOptions({MEMBERS:'1',MAX_MAKE:'1'});
function supplyFixture(initial:GlassStock){
 let tick=0;const bank={...initial},pack:GlassStock={},calls:string[]=[];
 const change=(stock:GlassStock,id:number,n:number)=>{stock[id]=(stock[id]??0)+n;if(stock[id]!<0)throw Error('fixture missing '+id);};
 const io:GlassSupplyIO={tick:()=>tick,check:()=>{},bank:async()=>{calls.push('bank');for(const [id,n] of Object.entries(pack)){change(bank,+id,n);pack[+id]=0;}return{...bank};},
  take:async(id,n)=>{if(!n)return;calls.push('take:'+id+':'+n);change(bank,id,-n);change(pack,id,n);},close:async()=>{},
  gather:async(id,n)=>{calls.push('gather:'+id+':'+n);change(pack,id,n);tick++;},island:async()=>{calls.push('island');tick++;},returnBank:async()=>{calls.push('return');tick++;},
  fill:async()=>{change(pack,1925,-1);change(pack,1783,1);tick++;},cook:async n=>{change(pack,401,-n);change(pack,1781,n);tick++;},smelt:async n=>{change(pack,1783,-n);change(pack,1781,-n);change(pack,1775,n);change(pack,1925,n);tick++;return n;}};
 return{io,bank,pack,calls};
}
test('supply mode validates finite limits and keeps staged defaults separate',()=>{
 expect(options()).toEqual({maximum:1,cap:4000,maxSpend:0,cashReserve:0,members:true});
 for(const env of [{MAX_MAKE:'0'},{MAX_MAKE:'11'},{CAP:'NaN'},{MAX_SPEND:'-1'},{CASH_RESERVE:'1.5'}])expect(()=>glassSupplyOptions(env)).toThrow('invalid glass supply bounds');
});
test('fresh holdings reuse glass, ash, seaweed and returned buckets',()=>{
 expect(planGlassSupply({1775:2},1).make).toBe(0);
 expect(planGlassSupply({1783:1,1781:1},2)).toMatchObject({make:2,sand:1,ash:1,fill:1,cook:1,gatherBucket:0});
 expect(planGlassSupply({401:1,1925:1},1)).toMatchObject({gatherSeaweed:0,gatherBucket:0,cook:1});
});
test('ordinary acquisition makes one useful bank credit and declares the free bucket',async()=>{
 const f=supplyFixture({995:100,314:17});const result=await runGlassSupply(f.io,options());
 expect(result).toMatchObject({ok:true,made:1,filled:1,cooked:1,seaweed:1,buckets:1,spent:0,banked:1,conserved:true});
 expect(f.bank).toMatchObject({995:100,314:17,1775:1,1925:1});expect(f.calls.filter(c=>c.startsWith('gather'))).toEqual(['gather:1925:1','gather:401:1']);
});
test('owned glass is banked without a trip or duplicate production',async()=>{
 const f=supplyFixture({1775:3,995:100});expect(await runGlassSupply(f.io,options())).toMatchObject({ok:true,made:0,banked:3});expect(f.calls).toEqual(['bank','bank']);
});
test('staged bank ingredients produce returned bucket without gathering',async()=>{
 const f=supplyFixture({1783:1,1781:1,995:10});expect(await runGlassSupply(f.io,options())).toMatchObject({ok:true,made:1,filled:0,cooked:0,buckets:0});expect(f.calls.some(c=>c.startsWith('gather'))).toBe(false);expect(f.bank[1925]).toBe(1);
});
test('multiple glass reuses a bucket returned from owned sand',async()=>{
 const f=supplyFixture({1783:1,1781:3});expect(await runGlassSupply(f.io,{...options(),maximum:3})).toMatchObject({ok:true,made:3,filled:2,buckets:0});expect(f.calls.some(c=>c==='gather:1925:1')).toBe(false);expect(f.bank[1925]).toBe(1);
});
test('refusal, acquisition failure, travel failure and cap propagate to owner',async()=>{
 const f=supplyFixture({});expect(await runGlassSupply(f.io,{...options(),members:false})).toMatchObject({ok:false,failure:expect.stringContaining('MEMBERS=1')});expect(f.calls).toEqual([]);
 for(const method of ['gather','island','returnBank'] as const){const g=supplyFixture({});g.io[method]=async()=>{throw Error(method+' failed');};expect(await runGlassSupply(g.io,options())).toMatchObject({ok:false,failure:expect.stringContaining(method+' failed')});}
 const c=supplyFixture({});expect(await runGlassSupply(c.io,{...options(),cap:1})).toMatchObject({ok:false,failure:expect.stringContaining('CAP')});
});
test('SDK smelt with no credit and unrelated asset loss cannot pass',async()=>{
 const f=supplyFixture({});f.io.smelt=async()=>0;expect(await runGlassSupply(f.io,options())).toMatchObject({ok:false,failure:expect.stringContaining('furnace shortfall')});
 const before={995:100,314:17},after={995:100,314:16,1775:1,1925:1},r={made:1,filled:1,cooked:1,seaweed:1,buckets:1,spent:0};
 expect(glassSupplyLedger(before,after,r,options())).toBe(false);expect(glassSupplyLedger(before,{...after,314:17},r,options())).toBe(true);
 expect(glassSupplyLedger(before,{...after,314:17,995:99},{...r,spent:1},options())).toBe(false);
});
test('session adapter reopens bank after unequipping and reads a fresh observation',async()=>{
 let open=false,opens=0,observations=0;const pack:GlassStock={1775:1,995:17},bank:GlassStock={995:2000},equipment=[{id:1205,count:1,name:'Bronze dagger',slot:3}];
 const inventory=()=>Object.entries(pack).filter(([,n])=>n>0).map(([id,count],slot)=>({id:+id,count,slot,name:String(id)}));
 const rows=()=>Object.entries(bank).filter(([,n])=>n>0).map(([id,count],slot)=>({id:+id,count,slot,name:String(id)}));
 const s:any={name:'fixture',tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),bankObservation:()=>{observations++;return open?{generation:opens,at:1,items:rows()}:null;},
  sdk:{getInventory:inventory,getEquipment:()=>[...equipment],getBankItems:rows,isBankOpen:()=>open,getSkill:()=>({level:39}),getDialog:()=>({isOpen:false}),getState:()=>({player:{lifeId:1,level:0},bank:{isOpen:open,items:rows()},interface:{isOpen:open}}),sendCloseModal:async()=>{open=false;return{success:true};}},
  bot:{openBank:async()=>{opens++;open=true;return{success:true};},depositItem:async(item:{id:number})=>{if(!open)throw Error('deposit requires open bank');bank[item.id]=(bank[item.id]??0)+(pack[item.id]??0);pack[item.id]=0;return{success:true};},unequipItem:async()=>{open=false;const item=equipment.shift()!;pack[item.id]=item.count;return{success:true};}}};
 expect(await runBankedGlass(s,options())).toMatchObject({ok:true,made:0,banked:1,conserved:true});expect(opens).toBe(3);expect(observations).toBeGreaterThanOrEqual(2);expect(bank).toMatchObject({995:2017,1775:1,1205:1});expect(open).toBe(false);
});
test('finite staged furnace runner stops after requested output',async()=>{
 let tick=0,xp=100,casts=0;const items:Record<number,number>={1783:2,1781:2,995:50};
 const inventory=()=>Object.entries(items).filter(([,count])=>count>0).map(([id,count],slot)=>({id:Number(id),count,slot,name:String(id)}));
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),sdk:{getInventory:inventory,getSkill:()=>({level:10}),getSkillXp:()=>xp,getDialog:()=>({isOpen:false}),getState:()=>({player:{lifeId:1,level:0},interface:{isOpen:false},nearbyLocs:[{id:2781,name:'Furnace',x:3275,z:3186,level:0,distance:1}]}),sendUseItemOnLoc:async(slot:number)=>{expect(inventory().find(i=>i.slot===slot)?.id).toBe(1783);casts++;tick++;items[1783]!--;items[1781]!--;items[1775]=(items[1775]??0)+1;items[1925]=(items[1925]??0)+1;xp+=20;return{success:true};}}};
 expect(await runFurnaceGlass(s,1,20)).toMatchObject({ok:true,made:1});
 expect(casts).toBe(1);expect(items[995]).toBe(50);expect(items[1783]).toBe(1);
});
