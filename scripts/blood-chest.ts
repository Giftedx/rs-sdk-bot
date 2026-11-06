// Finite Ardougne blood chest job: bun scripts/blood-chest.ts <account> <tickCap>, env MAX_LOOTS, CAP, IDLE_TICKS, BANK_EVERY.
// Native contract: trapped_chest.dbrow chest_blood_runes, thieving.rs2 disarm_trapped_chest, locked_door.rs2.
// Only op2 touches a chest: op1 runs activate_trapped_chest, which damages the player.
import {existsSync} from 'node:fs';
import {openBot,finish,getWorld,accountOf} from '../packages/core/src/bot';
import {depositObserved} from '../packages/core/src/deposit';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {goTo,sessionWalker,walkPath,type PathDeps} from '../packages/core/src/walk';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

export const CHEST=2569,BLOOD_RUNE=565,COINS=995,THIEVING_LEVEL=59,RUNES_PER_LOOT=2,COINS_PER_LOOT=500;
export const CHESTS=[{x:2586,z:9734},{x:2586,z:9737}];
export const ARRIVAL={x:2584,z:3337},BANK={x:2615,z:3332},STAGE={x:2585,z:9736};
export const DOOR={id:2554,x:2565,z:3356},LADDER_DOWN={id:1754,x:2562,z:3356},LADDER_UP={id:1755,x:2562,z:9756},LADDER_FOOT={x:2563,z:9756};
// Native respawn is scale_by_playercount(400), so 400 is the longest wait. The loc change comes after the teleport.
export const RESPAWN_TICKS=406;
// The exit from the chests and the bank trip fit inside the last EXIT_TICKS of the cap.
export const EXIT_TICKS=400;
// stat_random(8,75) is 47/256 at Thieving59, so 80 tries fail about once in 10^7 entries.
export const PICK_LIMIT=80;
const WALK_FAILS=6;
// The ogres and bats beside the chests hit on each visit, and regeneration cannot repay a long run.
// A meal happens on the surface only. It raises Hitpoints to FED_SHARE of the base level.
export const BANK_FOOD=['Shark','Swordfish','Lobster','Tuna','Salmon','Trout','Cake'];
export const FED_SHARE=0.75,MEAL_LIMIT=40;
const EAT_DELAY_TICKS=3,PACK_SLOTS=28;

export interface BloodOptions{maxLoots:number;cap:number;idleTicks:number;bankEvery:number}
export type BloodStop='target'|'cap'|'hp'|'idle';
export interface BloodResult{ok:boolean;stop:BloodStop;targetMet:boolean;conserved:boolean;loots:number;runes:number;coins:number;bankedRunes:number;bankedCoins:number;startRunes:number;startCoins:number;bankTrips:number;picks:number;entries:number;meals:number;ticks:number;hpMin:number;died:false}
export interface BloodDeps{
 state():BotWorldState|null;tick():number;stopped():boolean;
 walkSurface(x:number,z:number):Promise<boolean>;walkDungeon(x:number,z:number,tolerance:number):Promise<boolean>;
 act(x:number,z:number,id:number,option:number):Promise<{success:boolean}>;
 wait(test:()=>boolean,ticks:number):Promise<boolean>;step():Promise<void>;
 bank(food:boolean):Promise<{runes:number;coins:number;food:number}>;eat(item:BotWorldState['inventory'][number]):Promise<{success:boolean}>;log(line:string):void;
}
export function bloodOptions(tickCap:string|undefined,env:Record<string,string|undefined>=process.env):BloodOptions{
 const read=(k:string,raw:string|undefined,fallback:number|undefined,min:number,max:number)=>{const n=raw===undefined?fallback:Number(raw);if(n===undefined||!Number.isSafeInteger(n)||n<min||n>max)throw Error(`invalid ${k}`);return n;};
 const argument=read('tickCap',tickCap,undefined,EXIT_TICKS,1000000),cap=Math.min(argument,read('CAP',env.CAP,argument,EXIT_TICKS,1000000));
 return{maxLoots:read('MAX_LOOTS',env.MAX_LOOTS,2,1,10000),cap,idleTicks:read('IDLE_TICKS',env.IDLE_TICKS,700,1,850),bankEvery:read('BANK_EVERY',env.BANK_EVERY,50,1,10000)};
}
const total=(s:BotWorldState,id:number)=>s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const skill=(s:BotWorldState,name:string)=>s.skills.find(k=>k.name===name);
const hp=(s:BotWorldState)=>skill(s,'Hitpoints')?.level??0;
const baseHp=(s:BotWorldState)=>skill(s,'Hitpoints')?.baseLevel??0;
const edible=(s:BotWorldState)=>s.inventory.find(i=>i.optionsWithIndex.some(v=>/^Eat$/i.test(v.text)));
const cheb=(s:BotWorldState,t:{x:number;z:number})=>Math.max(Math.abs(s.player!.worldX-t.x),Math.abs(s.player!.worldZ-t.z));
const kit=(s:BotWorldState)=>s.inventory.filter(i=>i.id!==BLOOD_RUNE&&i.id!==COINS).reduce((m,i)=>m.set(i.id,(m.get(i.id)??0)+i.count),new Map<number,number>());
// A random event may add an item. Only a loss of an entry item fails the check.
const kitKept=(before:BotWorldState,after:BotWorldState)=>{const now=kit(after);return[...kit(before)].every(([id,count])=>(now.get(id)??0)>=count);};
export type BloodZone='dungeon'|'tower'|'surface'|'other';
export function bloodZone(s:BotWorldState):BloodZone{
 const p=s.player;if(!p||p.level!==0)return'other';
 if(p.worldZ>=9700&&p.worldZ<=9770&&p.worldX>=2550&&p.worldX<=2600)return'dungeon';
 if(p.worldX>=2555&&p.worldX<DOOR.x&&p.worldZ>=3352&&p.worldZ<=3360)return'tower';
 return p.worldZ<6400?'surface':'other';
}
// False until the reward lands. True only after the second trap has also moved the player to the surface.
// The player can stand away from the arrival tile at the first observation there, so no exact tile is required.
export function chestEffect(before:BotWorldState,after:BotWorldState){
 const runes=total(after,BLOOD_RUNE)-total(before,BLOOD_RUNE),coins=total(after,COINS)-total(before,COINS);
 const gained=(skill(after,'Thieving')?.experience??0)>(skill(before,'Thieving')?.experience??0);
 if(runes===0&&coins===0&&!gained)return false;
 if(runes!==RUNES_PER_LOOT||coins!==COINS_PER_LOOT||!gained)throw Error('blood chest effect does not reconcile');
 if(!kitKept(before,after))throw Error('blood chest assets changed');
 return bloodZone(after)==='surface';
}
export function bloodRefusal(s:BotWorldState,o:BloodOptions){
 const thieving=skill(s,'Thieving')?.level??0;
 if(thieving<THIEVING_LEVEL)return`blood chest refused: Thieving ${thieving} is below level ${THIEVING_LEVEL}`;
 if(bloodZone(s)==='other')return'blood chest refused: start on the ground floor, or in the chest dungeon';
 if(hp(s)*2<baseHp(s)&&!edible(s))return'blood chest refused: Hitpoints are below half';
 if(s.inventory.length+Number(total(s,BLOOD_RUNE)===0)+Number(total(s,COINS)===0)>28)return'blood chest refused: the pack has no room for the reward';
 if(o.maxLoots*COINS_PER_LOOT+total(s,COINS)>2147483647)return'blood chest refused: the coin stack would overflow';
 return null;
}
class Halt extends Error{constructor(readonly stop:Exclude<BloodStop,'target'>){super(stop);}}
export async function runBloodChest(d:BloodDeps,o:BloodOptions):Promise<BloodResult>{
 const initial=d.state();if(!initial?.player||hp(initial)<1)throw Error('blood chest state unknown');
 const refused=bloodRefusal(initial,o);if(refused)throw Error(refused);
 const start=d.tick(),startRunes=total(initial,BLOOD_RUNE),startCoins=total(initial,COINS),ready=CHESTS.map(()=>0);
 let progress=start,loots=0,sinceBank=0,picks=0,entries=0,seen=bloodZone(initial),entryPicks=0,hpMin=hp(initial),trip=0,tripStart:number|null=null,walkFails=0,bankedRunes=0,bankedCoins=0,bankTrips=0,meals=0,stop:BloodStop='target';
 const eaten=new Map<number,number>();
 // Hard failures end the run at once. Their loot stays in the pack and the session owner logs out.
 const observe=()=>{
  const s=d.state();if(!s?.player)throw Error('blood chest session ended');
  if(d.stopped())throw Error('blood chest stopped');
  if(s.player.isDead||s.player.lifeId!==initial.player!.lifeId)throw Error('blood chest died');
  if(d.tick()-start>=o.cap)throw Error('blood chest tick cap');
  // Only the observed tile inside the door ends this entry's attempt bound. A ladder climb reaches the same tile, so only a move from the surface counts as an entry.
  const zone=bloodZone(s);
  if(zone==='tower'){entryPicks=0;if(seen==='surface')entries++;}
  seen=zone;hpMin=Math.min(hpMin,hp(s));return s;
 };
 // Soft limits leave the chests and bank the held loot.
 const checkpoint=()=>{
  const s=observe();
  if(hp(s)*2<baseHp(s))throw new Halt('hp');
  if(d.tick()-start>=o.cap-EXIT_TICKS)throw new Halt('cap');
  if(d.tick()-progress>=o.idleTicks)throw new Halt('idle');
  return s;
 };
 const moved=async(ok:boolean,what:string)=>{if(ok){walkFails=0;return;}if(++walkFails>=WALK_FAILS)throw Error(`blood chest walk failed: ${what}`);await d.step();};
 const bank=async(food=false)=>{
  const s=observe();if(!food&&total(s,BLOOD_RUNE)===0&&total(s,COINS)===0)return;
  for(let i=0;cheb(observe(),BANK)>2;i++){if(i>=WALK_FAILS)throw Error('blood chest walk failed: bank');await d.walkSurface(BANK.x,BANK.z);}
  const r=await d.bank(food),after=observe();
  if(total(after,BLOOD_RUNE)!==0||total(after,COINS)!==0)throw Error('blood chest bank left loot in the pack');
  bankedRunes+=r.runes;bankedCoins+=r.coins;bankTrips++;sinceBank=0;d.log(`BLOOD_BANK ${JSON.stringify({trip:bankTrips,runes:r.runes,coins:r.coins,food:r.food,tick:d.tick()-start})}`);
 };
 const enter=async(s:BotWorldState)=>{
  if(cheb(s,DOOR)>1){await moved(await d.walkSurface(DOOR.x,DOOR.z),'door');return;}
  if(!s.nearbyLocs.some(l=>l.id===DOOR.id&&l.x===DOOR.x&&l.z===DOOR.z)){await d.step();return;}
  if(entryPicks>=PICK_LIMIT)throw Error('blood chest door not picked');
  entryPicks++;picks++;
  const sent=d.tick();
  if(!(await d.act(DOOR.x,DOOR.z,DOOR.id,2)).success){await d.step();return;}
  await d.wait(()=>{const n=observe();return bloodZone(n)==='tower'||n.gameMessages.some(m=>m.tick>=sent&&/fail to pick|activated a trap/i.test(m.text));},6);
  await d.step();
 };
 const climb=async(at:{id:number;x:number;z:number},to:BloodZone)=>{
  if(!(await d.act(at.x,at.z,at.id,1)).success){await moved(false,`ladder ${at.id}`);return;}
  await moved(await d.wait(()=>bloodZone(observe())===to,30),`ladder ${at.id}`);
 };
 const loot=async(s:BotWorldState)=>{
  if(cheb(s,STAGE)>2){await moved(await d.walkDungeon(STAGE.x,STAGE.z,1),'chest stage');return;}
  if(tripStart!==null){trip=d.tick()-tripStart;tripStart=null;d.log(`BLOOD_TRIP ${JSON.stringify({ticks:trip,picks,hp:hp(s),npcs:s.nearbyNpcs.filter(n=>n.name!=='').map(n=>n.name)})}`);}
  const index=CHESTS.findIndex(c=>s.nearbyLocs.some(l=>l.id===CHEST&&l.x===c.x&&l.z===c.z&&l.level===0&&l.reachable!==false));
  if(index<0){await d.step();return;}
  const chest=CHESTS[index]!,option=s.nearbyLocs.find(l=>l.id===CHEST&&l.x===chest.x&&l.z===chest.z)?.optionsWithIndex.find(v=>/^Search for traps$/i.test(v.text));
  if(!option){await d.step();return;}
  if(!(await d.act(chest.x,chest.z,CHEST,option.opIndex)).success){await d.step();return;}
  // A rival can take the chest first. No reward then, and the idle limit bounds the retry.
  if(!(await d.wait(()=>chestEffect(s,observe()),30)))return;
  loots++;sinceBank++;progress=d.tick();ready[index]=d.tick()+RESPAWN_TICKS;
  d.log(`BLOOD_LOOT ${JSON.stringify({loot:loots,chest,tick:d.tick()-start,hp:hp(observe())})}`);
 };
 // True when the player can go back to the chests. One bank trip restocks an empty pack.
 const heal=async()=>{
  let stocked=false;
  for(let i=0;i<MEAL_LIMIT;i++){
   const s=observe(),food=edible(s);
   if(hp(s)>=baseHp(s)*FED_SHARE)return true;
   if(!food){if(stocked)break;stocked=true;await bank(true);continue;}
   const before=hp(s),held=total(s,food.id);
   if(!(await d.eat(food)).success)throw Error('blood chest food refused');
   if(!(await d.wait(()=>{const n=observe();return hp(n)>before&&total(n,food.id)<held;},8)))throw Error('blood chest food effect unobserved');
   meals++;eaten.set(food.id,(eaten.get(food.id)??0)+1);
   d.log(`BLOOD_MEAL ${JSON.stringify({meal:meals,id:food.id,before,hp:hp(observe()),tick:d.tick()-start})}`);
   const next=d.tick()+EAT_DELAY_TICKS;await d.wait(()=>d.tick()>=next,EAT_DELAY_TICKS+1);
  }
  const s=observe();return hp(s)*2>=baseHp(s);
 };
 // Each pass ends on the surface. Only a meal starts another pass, so food and the tick cap bound this loop.
 for(let again=true;again;){
  stop='target';
  try{
   while(loots<o.maxLoots){
    const s=checkpoint(),zone=bloodZone(s);
    if(zone==='surface'){
     if(sinceBank>=o.bankEvery){await bank();continue;}
     // Wait on the surface: ogres stand beside the chests.
     if(d.tick()<Math.min(...ready)-trip){await d.step();continue;}
     tripStart??=d.tick();await enter(s);
    }else if(zone==='tower'){tripStart??=d.tick();await climb(LADDER_DOWN,'dungeon');}
    else if(zone==='dungeon')await loot(s);
    else throw Error('blood chest left its route');
   }
  }catch(e){if(!(e instanceof Halt))throw e;stop=e.stop;}
  for(let i=0;i<WALK_FAILS*2&&bloodZone(observe())==='dungeon';i++){
   if(cheb(observe(),LADDER_FOOT)>2)await d.walkDungeon(LADDER_FOOT.x,LADDER_FOOT.z,1);
   else await climb(LADDER_UP,'tower');
  }
  for(let i=0;i<WALK_FAILS&&bloodZone(observe())==='tower';i++){
   if((await d.act(DOOR.x,DOOR.z,DOOR.id,1)).success)await d.wait(()=>bloodZone(observe())==='surface',12);
   else await d.step();
  }
  if(bloodZone(observe())!=='surface')throw Error('blood chest exit failed');
  again=stop==='hp'&&await heal();
 }
 await bank();
 const final=observe(),runes=loots*RUNES_PER_LOOT,coins=loots*COINS_PER_LOOT;
 const kept=kit(final),conserved=bankedRunes===startRunes+runes&&bankedCoins===startCoins+coins&&[...kit(initial)].every(([id,count])=>(kept.get(id)??0)+(eaten.get(id)??0)>=count);
 if(!conserved)throw Error('blood chest total does not reconcile');
 const targetMet=stop==='target'&&loots===o.maxLoots;
 return{ok:targetMet,stop,targetMet,conserved,loots,runes,coins,bankedRunes,bankedCoins,startRunes,startCoins,bankTrips,picks,entries,meals,ticks:d.tick()-start,hpMin,died:false};
}
export function failureResult(error:unknown){const failure=String(error);return{ok:false,stop:/refused/.test(failure)?'refused':'failed',failure};}
// SDK walkTo refuses an empty plan before dispatch. The shared walker lets the client route the click,
// checks the observed arrival and bounds a stalled dungeon leg without spending more worker retries.
export async function walkBloodDungeon(d:PathDeps,x:number,z:number,tolerance:number,stopped:()=>boolean){
 return(await walkPath(d,[{x,z,tol:tolerance}],{maxTicks:150,stop:stopped})).ok;
}
if(import.meta.main){
 const name=process.argv[2];if(!name)throw Error('account required');
 const o=bloodOptions(process.argv[3]);
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));
 let ended=false;void s.ended.then(()=>{ended=true;});
 const held=(id:number)=>s.sdk.getState()?.inventory.find(i=>i.id===id);
 const deposit=async(id:number)=>{const item=held(id);return item?depositObserved(s,{id,name:item.name}):0;};
 const pack=(id:number)=>(s.sdk.getState()?.inventory??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 // Two slots stay free for the runes and coins of the next loot.
 const restock=async()=>{
  await waitUntil(s,()=>(s.sdk.getState()?.bank?.items.length??0)>0,{timeoutTicks:10});
  let taken=0;
  for(const name of BANK_FOOD){
   const room=PACK_SLOTS-2-(s.sdk.getState()?.inventory.length??PACK_SLOTS),row=s.sdk.getState()?.bank?.items.find(i=>i.name===name),n=Math.min(room,row?.count??0);
   if(!row||n<=0)continue;
   const before=pack(row.id);await s.bot.withdrawItem(row,n);
   if(!await waitUntil(s,()=>pack(row.id)>=before+n,{timeoutTicks:8}))throw Error(`blood chest food withdraw unobserved: ${name}`);
   taken+=n;
  }
  return taken;
 };
 try{
  const r=await runBloodChest({state:()=>s.sdk.getState(),tick:()=>s.tick(),
   stopped:()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all'),
   walkSurface:async(x,z)=>(await goTo(s,await getWorld(),{x,z,level:0},accountOf(s),{legTimeoutTicks:150})).ok,
   walkDungeon:async(x,z,tolerance)=>{
    const life=s.sdk.getState()?.player?.lifeId;
    return walkBloodDungeon(await sessionWalker(s),x,z,tolerance,()=>{
     const p=s.sdk.getState()?.player;
     return ended||!p||p.isDead||p.lifeId!==life||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all');
    });
   },
   act:(x,z,id,option)=>s.sdk.sendInteractLoc(x,z,id,option),
   wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),
   bank:async food=>{
    const open=await s.bot.openBank();if(!open.success)throw Error(`blood chest bank: ${open.message}`);
    const runes=await deposit(BLOOD_RUNE),coins=await deposit(COINS),taken=food?await restock():0;
    await s.bot.closeBank();return{runes,coins,food:taken};
   },eat:item=>s.bot.eatFood(item),log:line=>console.log(line)},o);
  console.log('BLOOD_CHEST_RESULT '+JSON.stringify(r));
  await finish([s],r.ok,JSON.stringify(r));
 }catch(e){
  console.log('BLOOD_CHEST_RESULT '+JSON.stringify(failureResult(e)));
  await finish([s],false,String(e));
 }
}
