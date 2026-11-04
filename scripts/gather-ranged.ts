// Candidate permanent home: scripts/gather-ranged.ts. Bank-to-field finite batch.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {sessionWalker,walkPath,expandPath,type PathPoint} from '../packages/core/src/walk';
import{createCombatLoot,telegrabPolicy,type TelegrabPolicy}from'./microbot-telegrab';
import{combatPotionPolicy,createCombatPotions,combatPotionSession,type CombatPotionPolicy}from'./microbot-combat-potions';
import{combatAlchPolicy,type PreparedCombatAlch}from'./microbot-combat-alch';
import type {GroundItem,NearbyNpc} from '../vendor/rs-sdk/sdk/types';
type Item={id:number;count:number};
const BOW=841,AMMO=884,FOOD=333,BONES=526,CHICKEN=2138,FEATHER=314,BANK={x:3253,z:3421};
const OUT:PathPoint[]=[{x:3280,z:3429,tol:2},{x:3275,z:3380,tol:2},{x:3260,z:3335,tol:2},{x:3233,z:3297,tol:0}];
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function rangedAmmo(pack:readonly Item[]|undefined,equipment:readonly Item[]|undefined):number|null{
 if(!pack||!equipment||[...pack,...equipment].some(i=>!Number.isSafeInteger(i.id)||!Number.isSafeInteger(i.count)||i.count<0))return null;
 return count(pack,AMMO)+count(equipment,AMMO);
}
// Pinned chicken HP3, regen100ticks: <=180ticks permits at most2 healed HP.
// On the25x realm, own>=300XP is >=3damage out of <=5, hence loot-hero majority.
// Auto-retaliate is OFF while ranging; no unrelated automatic target can add XP.
export const rangedCredit=(gone:boolean,xp:number,bones:number,chicken:number,elapsed=0)=>gone&&Number.isFinite(xp)&&xp>=300&&xp<=500&&xp%100===0&&elapsed>=0&&elapsed<=180&&bones>=1&&chicken>=1;
export function selectRangedTarget(npcs:readonly NearbyNpc[],plane:number|undefined){
 if(plane!==0)return;
 return npcs.filter(n=>[41,1017].includes(n.id)&&n.x>=3220&&n.x<=3248&&n.z>=3280&&n.z<=3310&&n.reachable!==false&&!n.inCombat&&(n.hp==null||n.maxHp==null||n.hp>=n.maxHp)).sort((a,b)=>a.distance-b.distance)[0];
}
export function makeRangedHealer(s:Session,consumed:()=>void,foodId=333){
 if(![329,333].includes(foodId))throw Error("ranged prerequisite: unsupported food ID");
 const FOOD=foodId;
 let inFlight:Promise<void>|undefined;
 const hp=()=>s.sdk.getSkill("Hitpoints")?.level??0,held=()=>count(s.sdk.getInventory(),FOOD);
 return ():Promise<void>=>{
  if(inFlight)return inFlight;
  if(hp()>6)return Promise.resolve();
  inFlight=Promise.resolve().then(async()=>{
   const item=s.sdk.getInventory().find(i=>i.id===FOOD);
   if(!item){if(hp()<=3)throw Error("ranged food exhausted below retreat floor");return;}
   const before=held(),beforeHp=hp();await s.bot.eatFood(item);
   if(!await waitUntil(s,()=>held()===before-1&&hp()>beforeHp,{timeoutTicks:8}))throw Error("ranged food debit/health unobserved");
   consumed();console.log("RANGED_FOOD "+JSON.stringify({before,after:held(),beforeHp,afterHp:hp(),tick:s.tick()}));
  }).finally(()=>{inFlight=undefined;});
  return inFlight;
 };
}
export async function pickupRangedLoot(s:Session,loot:Pick<ReturnType<typeof createCombatLoot>,'pickup'>,item:GroundItem){const held=()=>count(s.sdk.getInventory(),item.id),before=held(),reply=await loot.pickup(item);if(reply.acquired!==undefined)return reply.acquired;if(reply.telegrab&&!reply.success)throw Error('ranged loot unavailable '+item.id);if(!await waitUntil(s,()=>held()>before,{timeoutTicks:8}))throw Error('ranged pickup effect missing '+item.id);return held()-before;}
export async function runRanged(s:Session,o:{cap:number;maximum:number;ammo:number;food:number;foodId?:number;telegrab?:TelegrabPolicy;alch?:PreparedCombatAlch;potions?:CombatPotionPolicy;stop?:()=>boolean}){
 const potionScope=o.potions?combatPotionSession(s,()=>!!o.stop?.(),o.cap):undefined;if(potionScope)s=potionScope;
 if(!Number.isSafeInteger(o.cap)||o.cap<800||!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>5||!Number.isSafeInteger(o.ammo)||o.ammo<15||o.ammo>200||!Number.isSafeInteger(o.food)||o.food<2||o.food>8)throw Error('ranged prerequisite: bounded cap>=800,kills1..5,ammo15..200,food2..8');
 if(o.alch?.ids.some(id=>[BOW,AMMO,o.foodId??333].includes(id)))throw Error('ranged alchemy cannot consume declared combat supplies');
 const FOOD=o.foodId??333;if(![329,333].includes(FOOD))throw Error("ranged prerequisite: unsupported food ID");
 const st=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),held=(id:number)=>count(inv(),id),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkillXp('Ranged')??0;
 if(!await waitUntil(s,()=>hp()>0&&(s.sdk.getSkill('Ranged')?.baseLevel??0)>0,{timeoutTicks:15}))throw Error('ranged prerequisite: skill observation unknown');
 const originalRetaliate=st()?.autoRetaliateEnabled;if(typeof originalRetaliate!=='boolean')throw Error('ranged prerequisite: auto-retaliate telemetry unknown');
 const p0=st()?.player,start=s.tick(),initialXp=xp(),initialHp=hp(),originalEquipment=eq().map(i=>i.id);
 if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-BANK.x),Math.abs(p0.worldZ-BANK.z))>4)throw Error('ranged prerequisite: Varrock Eastbank start required');
 if(held(BOW)||held(AMMO)||count(eq(),BOW)||count(eq(),AMMO))throw Error('ranged prerequisite: bow/ammo must start banked');
 let cleanup=false,armed=false,lastObservedAmmo=0,ammoUnknown=false;
 let ended=false,died=false,hpMin=hp(),kills=0,eaten=0,pickedAmmo=0,shotsObserved=0,bankTrips=0,failure='',stop='cap';
 void s.ended.then(()=>{ended=true;});
 const off=s.onTick(()=>{const p=st()?.player;hpMin=Math.min(hpMin,hp());if(armed){const amount=rangedAmmo(inv(),eq());if(amount===null)ammoUnknown=true;else{shotsObserved+=Math.max(0,lastObservedAmmo-amount);lastObservedAmmo=amount;}}if(hp()<=0||p?.isDead||(p?.respawnCount??0)>(p0.respawnCount??0)||(p0.lifeId!==undefined&&p?.lifeId!==p0.lifeId))died=true;});
 const over=()=>ended||died||(!cleanup&&!!o.stop?.())||s.tick()-start>=o.cap;
 let snapshot:Item[]|undefined,initial:Map<number,number>|undefined;
 const capture=()=>{const b=s.bankObservation?.();if(!b)throw Error('ranged bank observation unknown');snapshot=b.items.map(i=>({id:i.id,count:i.count}));};
 const stored=(id:number)=>count(snapshot??[],id);
 const totals=()=>{const m=new Map<number,number>();for(const i of [...(snapshot??[]),...inv(),...eq()])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const open=async()=>{const generation=s.bankObservation?.()?.generation??0;if(!st()?.bank?.isOpen){if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))throw Error('ranged fresh bank unavailable');bankTrips++;}capture();};
 const withdraw=async(id:number,amount:number)=>{if(amount<=0)return;const item=st()?.bank?.items.find(i=>i.id===id);if(!item||item.count<amount)throw Error('ranged prerequisite: owned stock short '+id);const before=held(id),bankBefore=stored(id),generation=s.bankObservation!()!.generation;await s.bot.withdrawItem(item,amount,{asNote:false});if(!await waitUntil(s,()=>held(id)===before+amount&&(s.bankObservation?.()?.generation??0)>generation&&count(s.bankObservation!()!.items,id)===bankBefore-amount,{timeoutTicks:10}))throw Error('ranged withdrawal effect unknown '+id);capture();};
 const equip=async(id:number)=>{const item=inv().find(i=>i.id===id);if(!item)throw Error('ranged equip input absent '+id);const before=rangedAmmo(inv(),eq());await s.bot.equipItem(item);if(!await waitUntil(s,()=>count(eq(),id)>0,{timeoutTicks:10})||(id===AMMO&&rangedAmmo(inv(),eq())!==before))throw Error('ranged equip effect unknown '+id);};
 const heal=makeRangedHealer(s,()=>{eaten++;},FOOD);
 const base=await sessionWalker(s);
 const guarded={...base,walk:async(x:number,z:number)=>{await heal();const p=base.pos();if(!p||p.level!==0)throw Error('ranged walk plane unknown');const path=base.plan(0,p,{x,z}),last=path.at(-1);if(Math.max(Math.abs(p.x-x),Math.abs(p.z-z))>1&&(!last||Math.max(Math.abs(last.x-x),Math.abs(last.z-z))>1))throw Error('ranged incomplete route refused');if(expandPath(p,path).some(t=>t.x<3250&&t.z>=3350&&t.z<=3390))throw Error('ranged dark-wizard corridor refused');return base.walk(x,z);}};
 const walk=async(points:PathPoint[])=>{const r=await walkPath(guarded,points,{look:4,maxTicks:500,stop:over});if(!r.ok)throw Error('ranged route failed '+r.detail);};
 const close=async()=>{await s.bot.closeBank();if(!await waitUntil(s,()=>!st()?.bank?.isOpen,{timeoutTicks:5}))throw Error('ranged bank close unobserved');};
 const ground=()=>st()?.groundItems??[];
 const potions=o.potions?createCombatPotions(s,o.potions,['Ranged','Hitpoints'],over,AMMO):undefined;
 const loot=createCombatLoot(s,o.telegrab?{...o.telegrab,stop:()=>over()||!!o.telegrab?.stop?.()}:undefined,o.alch?{...o.alch,stop:()=>over()||!!o.alch?.stop?.()}:undefined);
 const pickup=async(id:number,x:number,z:number)=>{const item=ground().find(i=>i.id===id&&i.x===x&&i.z===z);if(!item)throw Error('ranged fresh loot missing '+id);return pickupRangedLoot(s,loot,item);};
 try{
  await open();initial=totals();
  if((initial.get(BOW)??0)<1||(initial.get(AMMO)??0)<o.ammo||(initial.get(FOOD)??0)<o.food)throw Error('ranged prerequisite: stage owned bow,ammo and selected unnoted food');
  if(inv().length+2+Math.max(0,o.food-held(FOOD))>25)throw Error('ranged prerequisite: pack needs loot and unequipped-kit slots');
  await withdraw(BOW,1);await withdraw(AMMO,o.ammo);await withdraw(FOOD,Math.max(0,o.food-held(FOOD)));await close();
  if(st()?.autoRetaliateEnabled)await s.direct({type:'clickComponent',componentId:151,reason:'Ranged exact target XP: auto-retaliate OFF'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw Error('Ranged auto-retaliate OFF unobserved');
  await equip(BOW);await equip(AMMO);
  await s.sdk.sendSetCombatStyle(1);
  if(!await waitUntil(s,()=>{const c=st()?.combatStyle;return !!c?.known&&c.currentStyle===1&&c.weaponName==='Shortbow'&&c.styles.some(i=>i.index===1&&i.trainsSkills.length===1&&i.trainsSkills[0]==='Ranged');},{timeoutTicks:10}))throw Error('ranged rapid style unobserved');
  armed=true;lastObservedAmmo=rangedAmmo(inv(),eq())??0;await walk(OUT);if(st()?.player?.worldX!==3233||st()?.player?.worldZ!==3297)throw Error("ranged coop entry unobserved");console.log("RANGED_ENTRY "+JSON.stringify({x:st()?.player?.worldX,z:st()?.player?.worldZ,reachable:(st()?.nearbyNpcs??[]).filter(n=>[41,1017].includes(n.id)&&n.reachable).length,tick:s.tick()}));let lastProgress=s.tick();
  while(kills<o.maximum&&!over()&&s.tick()-start<o.cap-500){
   await heal();if(potions)await potions.poll();if((rangedAmmo(inv(),eq())??0)<3){stop='ammo-low';break;}
   if(held(AMMO)>0)await equip(AMMO);
   const target=selectRangedTarget(st()?.nearbyNpcs??[],st()?.player?.level);
   if(!target){if(s.tick()-lastProgress>120)throw Error('ranged no target progress');await waitTicks(s,1);continue;}

   if(target.distance>5)await walk([{x:target.tileX??target.x,z:target.tileZ??target.z,tol:3}]);
   const fresh=st()?.nearbyNpcs.find(n=>n.index===target.index&&n.id===target.id);if(!fresh||fresh.inCombat)continue;
   const beforeXp=xp(),beforeGround=new Map<string,number>();for(const i of ground())beforeGround.set(`${i.id}:${i.x}:${i.z}`,(beforeGround.get(`${i.id}:${i.x}:${i.z}`)??0)+i.count);
   const attackStarted=s.tick();let x=fresh.tileX??fresh.x,z=fresh.tileZ??fresh.z,seenXp=xp(),gone=false,goneAt:number|undefined;
   await s.bot.attack(fresh);lastProgress=s.tick();
   while(!over()&&s.tick()-start<o.cap-500){
    await heal();if(potions&&st()?.player?.combat.targetType==='npc'&&st()?.player?.combat.targetIndex===target.index)await potions.poll(target);const current=st()?.nearbyNpcs.find(n=>n.index===target.index&&n.id===target.id);if(current){x=current.tileX??current.x;z=current.tileZ??current.z;}else{gone=true;goneAt??=s.tick();}
    if(xp()>seenXp){seenXp=xp();lastProgress=s.tick();}
    const delta=(id:number)=>count(ground().filter(i=>i.x===x&&i.z===z),id)-(beforeGround.get(`${id}:${x}:${z}`)??0);
    if(gone&&(xp()-beforeXp<300||xp()-beforeXp>500||(xp()-beforeXp)%100!==0)&&s.tick()-(goneAt??s.tick())>8)throw Error('Ranged target ownership XP outside admitted range; no kill credit');
    if(s.tick()-attackStarted>180)throw Error('Ranged engagement exceeds admitted regen budget');
    if(rangedCredit(gone,xp()-beforeXp,delta(BONES),delta(CHICKEN),s.tick()-attackStarted))break;
    if(s.tick()-lastProgress>120)throw Error('ranged combat/credit stalled');await waitTicks(s,1);
   }
   if(over()||s.tick()-start>=o.cap-500)break;
   await pickup(BONES,x,z);await pickup(CHICKEN,x,z);kills++;lastProgress=s.tick();
   if(ground().some(i=>i.id===FEATHER&&i.x===x&&i.z===z))await pickup(FEATHER,x,z);
   for(const item of ground().filter(i=>i.id===AMMO&&i.distance<=7&&i.x>=3220&&i.x<=3248&&i.z>=3280&&i.z<=3310).slice(0,4))pickedAmmo+=await pickup(AMMO,item.x,item.z);
   console.log('RANGED_KILL '+JSON.stringify({kills,xp:xp()-initialXp,ammo:rangedAmmo(inv(),eq()),pickedAmmo,hp:hp(),tick:s.tick()}));
  }
  if(kills===o.maximum)stop='max-kills';else if(o.stop?.())stop='stop-file';
 }catch(e){failure=String(e);}
 finally{
  cleanup=true;
  const restore=async()=>{if(!ended&&!died)try{
   if(st()?.bank?.isOpen)await close();
   if((st()?.player?.worldZ??0)<3380)await walk([{x:3260,z:3335,tol:2},{x:3275,z:3380,tol:2},{x:3280,z:3429,tol:2},BANK]);else await walk([BANK]);
   armed=false;for(const id of [AMMO,BOW]){const item=eq().find(i=>i.id===id);if(item){await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!eq().some(i=>i.id===id),{timeoutTicks:10}))throw Error('ranged unequip unobserved '+id);}}
   for(const id of originalEquipment)if(!eq().some(i=>i.id===id))await equip(id);
   await open();for(const id of new Set(inv().filter(i=>[BOW,AMMO,FOOD,BONES,CHICKEN,FEATHER,...potions?.depositIds??[],...o.alch?[995,...o.alch.ids]:[]].includes(i.id)&&i.count>0).map(i=>i.id)))await depositObserved(s,inv().find(i=>i.id===id)!);
   capture();await close();if(st()?.autoRetaliateEnabled!==originalRetaliate){await s.direct({type:'clickComponent',componentId:originalRetaliate?150:151,reason:'restore original auto-retaliate'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===originalRetaliate,{timeoutTicks:8}))throw Error('Ranged auto-retaliate restore unobserved');}
  }catch(e){failure=[failure,'cleanup '+String(e)].filter(Boolean).join('; ');}};if(potionScope)await potionScope.withCombatPotionCleanup(restore);else await restore();off();
 }
 const final=totals(),consumedAmmo=(initial?.get(AMMO)??0)-(final.get(AMMO)??0),gained=(id:number)=>(final.get(id)??0)-(initial?.get(id)??0);
 const preserved=!!initial&&[...new Set([...initial.keys(),...final.keys()])].every(id=>[AMMO,FOOD,BONES,CHICKEN,FEATHER].includes(id)||(final.get(id)??0)===(initial!.get(id)??0)-(loot.runesUsed[id]??0)-(loot.alch?.runes[id]??0)-(loot.alch?.consumed[id]??0)+(id===995?loot.alch?.coins??0:0)+(potions?.delta[id]??0));
 const targetMet=kills===o.maximum&&xp()>initialXp&&gained(BONES)+(loot.alch?.consumed[BONES]??0)===kills&&gained(CHICKEN)+(loot.alch?.consumed[CHICKEN]??0)===kills;
 const accounting=!!initial&&!ammoUnknown&&gained(FOOD)===-eaten&&consumedAmmo>=0&&consumedAmmo<=shotsObserved&&stored(AMMO)===(final.get(AMMO)??0);
 return{...potions?{potions:{doses:potions.doses,delta:potions.delta,receipts:potions.receipts,blocked:potions.blocked,resumes:potions.resumes}}:{},...o.alch?{alchemy:{casts:loot.alch!.casts,coins:loot.alch!.coins,consumed:loot.alch!.consumed,runes:loot.alch!.runes,receipts:loot.alch!.receipts,blocked:loot.alch!.blocked}}:{},telegrabCasts:loot.casts,telegrabRunes:loot.runesUsed,ok:!failure&&!died&&!ended&&targetMet&&preserved&&accounting,ticks:s.tick()-start,kills,xpGain:xp()-initialXp,startHp:initialHp,hpMin,hp:hp(),eaten,pickedAmmo,shotsObserved,unrecoveredAmmo:consumedAmmo,ammoBank:stored(AMMO),bowBank:stored(BOW),foodBank:stored(FOOD),boneGain:gained(BONES),chickenGain:gained(CHICKEN),featherGain:gained(FEATHER),bankTrips,preserved,accounting,targetMet,died,stop,failure:failure||'-'};
}
if(import.meta.main){const alch=combatAlchPolicy(),potions=combatPotionPolicy();let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});try{const r=await runRanged(s,{cap:Number(process.env.CAP??1800),maximum:Number(process.env.MAX_KILLS??2),ammo:Number(process.env.AMMO??90),food:Number(process.env.FOOD??3),foodId:Number(process.env.FOOD_ID??333),telegrab:telegrabPolicy(),alch,potions,stop:()=>stopped});console.log('RANGED_BANK '+JSON.stringify(r));await finish([s],r.ok,(r.ok?'':r.stop==='stop-file'?'stop file ':'no Ranged progress: ')+JSON.stringify(r));}catch(e){await finish([s],false,'no Ranged progress: '+String(e));}}
