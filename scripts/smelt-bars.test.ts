import {expect,test} from 'bun:test';
import {planBronze,bronzeProgress,runBronze,smeltBonusFromEnv,smeltRouteFromEnv} from './smelt-bars';
import {smeltEntryRoute} from '../packages/planner/src/travel';
import {validateSmeltOrder} from './smelt-batch';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

test('bonus CLI is opt-in and validates owned finite ring policy before login',()=>{
 expect(smeltBonusFromEnv({})).toBeUndefined();expect(smeltBonusFromEnv({SMELT_BONUS_GEAR:'goldsmith'})).toEqual({kind:'goldsmith',xpRate:25});
 const order={bar:'iron',cap:100,maximum:1,reserve:0,mode:'exact' as const};
 expect(()=>validateSmeltOrder({...order,bonusGear:smeltBonusFromEnv({SMELT_BONUS_GEAR:'forging'})})).toThrow();
 expect(validateSmeltOrder({...order,bonusGear:smeltBonusFromEnv({SMELT_BONUS_GEAR:'forging',MAX_RINGS:'2',RING_RESERVE:'1'})}).product).toBe(2351);
 expect(()=>validateSmeltOrder({...order,bar:'bronze',bonusGear:{kind:'goldsmith',xpRate:25}})).toThrow();
 expect(()=>smeltBonusFromEnv({SMELT_BONUS_GEAR:'unknown'})).toThrow();
});
test('local smelt CLI accepts explicit source-bound route JSON and rejects malformed input before login',()=>{const route={bank:{x:2945,z:3369,level:0},stand:{x:2974,z:3369,level:0},furnace:{id:2781,x:2975,z:3368,level:0}};expect(smeltRouteFromEnv({})).toBeUndefined();expect(smeltRouteFromEnv({SMELT_ROUTE_JSON:JSON.stringify(route)})).toEqual(route);expect(()=>smeltRouteFromEnv({SMELT_ROUTE_JSON:'{'})).toThrow();expect(()=>smeltRouteFromEnv({SMELT_ROUTE_JSON:JSON.stringify({...route,stand:{...route.stand,x:3000}})})).toThrow();});
test('nearest CLI opt-in rejects mixed explicit routes and malformed selection',()=>{expect(smeltRouteFromEnv({SMELT_NEAREST:'1'})).toBeUndefined();expect(()=>smeltRouteFromEnv({SMELT_NEAREST:'true'})).toThrow();expect(()=>smeltRouteFromEnv({SMELT_NEAREST:'1',SMELT_ROUTE_JSON:'{}'})).toThrow();expect(()=>validateSmeltOrder({bar:'silver',cap:100,maximum:1,reserve:1,mode:'exact',nearest:'yes' as any})).toThrow();});

test('entry route accepts the ordinary bank starts and rejects unknown floors/locations',()=>{
 expect(smeltEntryRoute({worldX:3252,worldZ:3420,level:0})).toMatchObject({fare:10,name:'varrock-east-toll'});
 expect(smeltEntryRoute({worldX:3269,worldZ:3167,level:0}).points).toEqual([]);
 expect(()=>smeltEntryRoute({worldX:3252,worldZ:3420,level:1})).toThrow();
 expect(()=>smeltEntryRoute({worldX:3222,worldZ:3218,level:0})).toThrow();
});
test('bronze plans equal pairs within free slots and both reserves',()=>{
 expect(planBronze(10,9,25,8,1)).toBe(8);
 expect(planBronze(10,9,5,8,1)).toBe(2);
 expect(planBronze(10,1,25,8,1)).toBe(0);
});
test('bronze progress needs actual output, both debits, and XP',()=>{
 expect(bronzeProgress({copper:8,tin:8,bars:0,xp:0},{copper:7,tin:7,bars:1,xp:155})).toBe(1);
 expect(bronzeProgress({copper:8,tin:8,bars:0,xp:0},{copper:8,tin:8,bars:1,xp:155})).toBe(0);
 expect(bronzeProgress({copper:8,tin:8,bars:0,xp:0},{copper:7,tin:7,bars:1,xp:0})).toBe(0);
});
test('bronze rejects invalid planning bounds',()=>{
 expect(()=>planBronze(10,9,25,8,-1)).toThrow();
 expect(()=>planBronze(10,9,25,1.5,1)).toThrow();
});

test('CLI refuses unsupported bars and invalid order limits before opening an account',()=>{
 expect(validateSmeltOrder({bar:'runite',cap:100,maximum:1,reserve:0,mode:'exact'}).product).toBe(2363);
 for(const [bar,maximum,message] of [['blurite','1','unsupported smelt recipe: blurite'],['silver','0','invalid finite smelt order'],['runite','NaN','invalid finite smelt order']]){
  const r=spawnSync(process.execPath,[join(import.meta.dir,'smelt-bars.ts'),'unusedSmelt','100',bar!],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,ORDER_ACTION:'smelt',MAX_MAKE:maximum!,ORE_RESERVE:'0',ORDER_MODE:'exact'}});
  expect(r.status).toBe(1);expect(r.stderr).toContain(message!);expect(r.stdout).not.toContain('login:');
 }
});


test('legacy bronze pins mutable life before first await and sends no cleanup after first paid bar changes it',async()=>{
 for(const field of ['lifeId','respawnCount']as const){let tick=0,xp=0,open=false,banks=0,withdrawals=0,furnaces=0;const player={worldX:3269,worldZ:3167,level:0,lifeId:1,respawnCount:0},inventory:any[]=[],bank:any[]=[{id:436,name:'Copper ore',count:3},{id:438,name:'Tin ore',count:3}],listeners=new Set<()=>void>();const s:any={name:'BronzeOwned',client:{selfSlot:1,executeBotAction:()=>({success:true})},ended:new Promise(()=>{}),tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},sdk:{getState:()=>({player,inventory,bank:{isOpen:open,items:bank}}),getInventory:()=>inventory,getEquipment:()=>[],getDialog:()=>null,getSkill:(k:string)=>({level:k==='Hitpoints'?30:99,baseLevel:k==='Hitpoints'?30:99}),getSkillXp:()=>xp,findNearbyLoc:()=>({id:2781,x:3274,z:3186}),sendUseItemOnLoc:async()=>{furnaces++;for(const id of [436,438])inventory.splice(inventory.findIndex(i=>i.id===id),1);inventory.push({id:2349,name:'Bronze bar',slot:inventory.length,count:1});xp+=62.5;player[field]++;return{success:true};}},bot:{openBank:async()=>{banks++;open=true;return{success:true};},closeBank:async()=>{open=false;return{success:true};},withdrawItem:async(name:RegExp,n:number)=>{withdrawals++;const row=bank.find(i=>name.test(i.name));row.count-=n;for(let i=0;i<n;i++)inventory.push({...row,count:1,slot:inventory.length});return{success:true};},depositItem:async()=>({success:true})},direct:async()=>{throw Error('unexpected direct input');}};const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);try{const r=await runBronze(s,{maximum:2,reserve:0,cap:100},{walk:async(x,z)=>{player.worldX=x;player.worldZ=z;return true;}});expect(r.ok).toBe(false);expect(furnaces).toBe(1);expect(withdrawals).toBe(2);expect(banks).toBe(1);}finally{clearInterval(timer);}}
});
