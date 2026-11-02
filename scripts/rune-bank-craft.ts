// bun scripts/rune-bank-craft.ts <account> [target=99]. Craft banked essence at the best accessible altar.
// Session cleanup stays with the CLI owner. Rev289 runecraft.rs2 accepts talismans, not tiaras.
import {existsSync} from 'node:fs';
import {openBot,finish,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo,walkPath,sessionWalker} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {craftAirRunes,enterAirAltar,exitAirAltar,insideAirAltar} from './generated/rcair';
import {interactionApproach,type Tile} from '../packages/core/src/world';
import type {InteractionTarget} from '../packages/knowledge/src/transports';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

// Read only the entry window. Keep publication IDs so a reply cannot turn old messages into new evidence.
export function runeEntrySnapshot(state:BotWorldState|null,revision:number,tick:number){
 return {tick:state?.tick??null,revision:state?.revision??null,player:state?.player??null,
  inventory:state?.inventory??null,dialog:state?.dialog??null,recentDialogs:state?.recentDialogs??null,
  interface:state?.interface??null,modalOpen:state?.modalOpen??null,modalInterface:state?.modalInterface??null,
  bankOpen:state?.bank.isOpen??null,shopOpen:state?.shop.isOpen??null,tradeOpen:state?.trade?.isOpen??null,
  opFeedback:state?.opFeedback??null,
  messages:state?.gameMessages.filter(m=>m.observationId!==undefined?m.observationId>revision:m.tick>tick)??[]};
}

export async function settleRuneEntryModal(s:Session,stop:()=>boolean):Promise<boolean>{
 const closed=()=>{const st=s.sdk.getState();return !!st&&st.modalOpen===false&&!st.interface.isOpen&&!st.dialog.isOpen;};
 if(stop())return false;
 if(closed())return true;
 if(!(await s.sdk.sendCloseModal()).success||stop())return false;
 return await waitUntil(s,()=>stop()||closed(),{timeoutTicks:10})&&!stop()&&closed();
}

// Pinned wilderness_warning.rs2 queues the warning on zone entry, calls p_stopaction and then opens it.
// It shows once per login, so a warning seen after dispatch is closed and the canceled action is sent again.
export const WILDERNESS_WARNING=1908;
export const runeEntryWarning=(st:Pick<BotWorldState,'modalOpen'|'modalInterface'|'interface'>|null|undefined)=>
 !!st&&st.modalOpen===true&&(st.modalInterface===WILDERNESS_WARNING||st.interface?.interfaceId===WILDERNESS_WARNING);
export type RuneEntryResult={entered:boolean;dispatches:number;warnings:number;failure?:string};
export async function dispatchRuneEntry(s:Session,p:{dispatch:(attempt:number)=>Promise<{success:boolean}>;entered:()=>boolean;
 stop:()=>boolean;attempts?:number;timeoutTicks?:number}):Promise<RuneEntryResult>{
 const attempts=p.attempts??3,timeoutTicks=p.timeoutTicks??20;let dispatches=0,warnings=0;
 const result=(failure?:string):RuneEntryResult=>({entered:!failure&&p.entered(),dispatches,warnings,...failure?{failure}:{}});
 while(dispatches<attempts){
  if(p.stop())return result('stopped');
  dispatches++;
  if(!(await p.dispatch(dispatches)).success)return result('ruins action refused');
  await waitUntil(s,()=>p.stop()||p.entered()||runeEntryWarning(s.sdk.getState()),{timeoutTicks});
  if(p.entered())return result();
  if(p.stop())return result('stopped');
  if(!runeEntryWarning(s.sdk.getState()))return result('altar entry unobserved');
  warnings++;
  if(!await settleRuneEntryModal(s,p.stop))return result('entry warning closure unobserved');
 }
 return result('entry warning retries exhausted');
}

export const ESSENCE=1436,AIR=556,TALISMAN=1438;
export const BANK={x:3013,z:3355,level:0},RUINS={x:2986,z:3294,level:0};
type RuneAltar={name:string;level:number;xp:number;rune:number;talisman:number;ruins:Tile;inside:Tile;outside:Tile;portal:number};
const tile=(x:number,z:number,level=0):Tile=>({x,z,level});
// Pinned skill_runecraft/configs/runecraft.dbrow and content/pack/{obj,loc}.pack.
export const RUNE_ALTARS:readonly RuneAltar[]=[
 {name:'air',level:1,xp:5,rune:556,talisman:1438,ruins:tile(2985,3292),inside:tile(2841,4830),outside:tile(2983,3288),portal:2465},
 {name:'mind',level:2,xp:5.5,rune:558,talisman:1448,ruins:tile(2982,3514),inside:tile(2793,4829),outside:tile(2980,3511),portal:2466},
 {name:'water',level:5,xp:6,rune:555,talisman:1444,ruins:tile(3185,3165),inside:tile(2725,4832),outside:tile(3182,3162),portal:2467},
 {name:'earth',level:9,xp:6.5,rune:557,talisman:1440,ruins:tile(3306,3474),inside:tile(2657,4830),outside:tile(3303,3477),portal:2468},
 {name:'fire',level:14,xp:7,rune:554,talisman:1442,ruins:tile(3313,3255),inside:tile(2576,4848),outside:tile(3310,3252),portal:2469},
 {name:'body',level:20,xp:7.5,rune:559,talisman:1446,ruins:tile(3053,3445),inside:tile(2523,4838),outside:tile(3050,3442),portal:2470},
];
export function chooseRuneAltar(level:number,owned:ReadonlySet<number>){
 const usable=RUNE_ALTARS.filter(a=>a.level<=level).sort((a,b)=>b.xp-a.xp);
 const altar=usable.find(a=>owned.has(a.talisman));
 return {altar,wanted:usable.filter(a=>(!altar||a.xp>altar.xp)&&!owned.has(a.talisman)).map(a=>a.name)};
}
// Pinned maps/*.jm2 place each ruin (runecraft.loc 3x3, no forceapproach) as shape10 angle0, origin one tile
// south-west of its altar_coord centre. The centre is blocked, so travel stages at exit_coord outside the footprint.
export function ruinTarget(a:RuneAltar):{at:Tile;q:InteractionTarget}{
 const at=tile(a.ruins.x-1,a.ruins.z-1,a.ruins.level),id=2452+RUNE_ALTARS.indexOf(a);
 return {at,q:{id,shape:10,angle:0,width:3,height:3,blockAccessFlags:0,
  src:`maps/m${Math.floor(at.x/64)}_${Math.floor(at.z/64)}.jm2`,configSrc:'scripts/skill_runecraft/configs/runecraft.loc'}};
}
export const inRuinFootprint=(a:RuneAltar,t:Tile)=>{const {at,q}=ruinTarget(a);
 return t.level===at.level&&t.x>=at.x&&t.x<at.x+q.width&&t.z>=at.z&&t.z<at.z+q.height;};
export const runeAltarStaging=(a:RuneAltar):Tile=>a.name==='air'?RUINS:a.outside;
const insideRuneAltar=(a:RuneAltar,p:{worldX:number;worldZ:number;level:number}|null|undefined)=>
 a.name==='air'?insideAirAltar(p):!!p&&p.level===a.inside.level&&Math.floor(p.worldX/64)===Math.floor(a.inside.x/64)&&Math.floor(p.worldZ/64)===75;
export function runeBankTarget(value=99){
 if(!Number.isSafeInteger(value)||value<2||value>99)throw Error('Runecraft target must be2..99');
 return value;
}
// Pack plus bank totals at entry and at the final bank. The final pack holds no essence or runes.
export type RuneBankLedger={essence0:number;essence:number;air0:number;air:number;consumed:number;crafted:number;
 runes?:Record<number,{before:number;after:number;crafted:number}>};
export function runeBankBalanced(l:RuneBankLedger){
 const products=l.runes?Object.values(l.runes).every(r=>r.after-r.before===r.crafted)
  &&Object.values(l.runes).reduce((n,r)=>n+r.crafted,0)===l.crafted:l.air-l.air0===l.crafted;
 return l.essence0-l.essence===l.consumed&&products&&l.crafted>=l.consumed;
}
export const runeBankDone=(level:number,target:number,bankEssence:number)=>level>=target||bankEssence===0;
export function runeBankOk(p:{ledger:RuneBankLedger|undefined;level0:number;level:number;target:number;bankEssence:number;held:{essence:number;air:number;runes?:number};stopped:boolean}){
 return !p.stopped&&!!p.ledger&&runeBankBalanced(p.ledger)&&p.held.essence===0&&p.held.air===0
  &&(p.held.runes??0)===0&&runeBankDone(p.level,p.target,p.bankEssence)&&(p.ledger.consumed>0||p.level0>=p.target);
}

export async function runRuneBankCraft(s:Session,target=99,options:{cap?:number;stop?:()=>boolean}={}){
 runeBankTarget(target);
 const cap=options.cap??20000;if(!Number.isSafeInteger(cap)||cap<1)throw Error('invalid rune bank craft tick cap');
 const start=s.tick(),state=()=>s.sdk.getState(),pos=()=>state()?.player,initialLife=pos();
 let ended=false,stage='entry';void s.ended.then(()=>{ended=true;});
 let stoppedFor:string|undefined;
 const stopReason=()=>stoppedFor ??= sessionDied(initialLife,pos())?'died':ended?'session-ended':options.stop?.()?'operator':existsSync(`.practice/stop-${s.name}`)?'stop-file':s.tick()-start>=cap?'tick-cap':undefined;
 const stop=()=>stopReason()!==undefined;
 const check=()=>{if(stop())throw Error(`rune bank craft stopped at ${stage}: ${stopReason()}`);};
 const inv=()=>s.sdk.getInventory(),count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const bankCount=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const level=()=>s.sdk.getSkill('Runecraft')?.baseLevel??0,xp=()=>s.sdk.getSkillXp('Runecraft')??0;
 let ledger:RuneBankLedger|undefined,consumed=0,crafted=0,trips=0,level0=0,xp0=0;
 const tripResults:{altar:string;level:number;consumed:number;crafted:number;xp:number}[]=[];
 let chosen:RuneAltar|undefined;
 const runeCount=()=>RUNE_ALTARS.reduce((n,a)=>n+count(a.rune),0);
 const action=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
  const record=(phase:string)=>console.log('RUNE_BANK_ACTION '+JSON.stringify({tick:s.tick(),stage,action:name,phase,
   position:pos()?{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}:null,essence:count(ESSENCE),air:count(AIR),
   bankEssence:bankCount(ESSENCE),bankAir:bankCount(AIR),runecraftXp:xp()}));
  record('start');try{const r=await work();record('end');return r;}catch(error){record('error');throw error;}
 };
 const travel=async(to:typeof BANK)=>{check();
  const r=await action(`walk:${to.x},${to.z}`,async()=>goTo(s,await getWorld(),to,accountOf(s)));
  if(!r.ok)throw Error(`route refusal ${stage}: ${JSON.stringify(r)}`);check();
 };
 const open=async()=>{check();const generation=s.bankObservation?.()?.generation??0;
  if(!(await action('open-bank',()=>s.bot.openBank())).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15}))
   throw Error(`bank observation unavailable at ${stage}`);
 };
 const close=()=>action('close-bank',()=>s.bot.closeBank());
 const withdraw=async(id:number,n:number)=>{
  const item=state()?.bank.items.find(i=>i.id===id),stored=bankCount(id),held=count(id),generation=s.bankObservation?.()?.generation??0;
  if(!item||stored<n)throw Error(`next acquisition: item${id} needs${n}, bank has${stored}`);
  await action(`withdraw:${id}:${n}`,()=>s.bot.withdrawItem(item,n));
  if(!await waitUntil(s,()=>count(id)===held+n&&bankCount(id)===stored-n&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:10}))
   throw Error(`withdraw debit/credit unobserved item${id}`);
 };
 // Selection reads pack and bank first. Only the selected access item stays in the pack.
 const secure=async()=>{for(const id of new Set(inv().map(i=>i.id))){
  check();const item=inv().find(i=>i.id===id);if(id!==chosen?.talisman&&item)await action(`deposit:${id}`,()=>depositObserved(s,item));
 }};
 const craft=async(a:RuneAltar)=>{
  check();const before={essence:count(ESSENCE),runes:count(a.rune),xp:xp(),level:level()};
  if(!insideRuneAltar(a,pos())||before.essence<1)throw Error(`${a.name} craft entry unobserved`);
  if(a.name==='air')await action('craft-air',()=>craftAirRunes(s,stop));
  else{
   await s.bot.dismissBlockingUI();check();
   const altar=s.sdk.findNearbyLoc(/^altar$/i,{withOption:/craft/i});
   if(!altar)throw Error(`${a.name} craft altar unobserved`);
   await action(`craft-${a.name}`,()=>s.bot.interactLoc(altar,/craft/i));
   if(!await waitUntil(s,()=>stop()||count(ESSENCE)===0&&count(a.rune)>before.runes&&xp()>before.xp,{timeoutTicks:15}))
    throw Error(`${a.name} craft effects unobserved`);
  }
  check();const used=before.essence-count(ESSENCE),made=count(a.rune)-before.runes;
  if(count(ESSENCE)!==0||used!==before.essence||made<used||xp()<=before.xp)throw Error(`${a.name} craft debit/credit/XP mismatch`);
  consumed+=used;crafted+=made;
  if(ledger?.runes)ledger.runes[a.rune]!.crafted+=made;
  tripResults.push({altar:a.name,level:before.level,consumed:used,crafted:made,xp:xp()-before.xp});
 };
 const enter=async(a:RuneAltar)=>{
  check();if(a.name==='air'){await action('enter-air',()=>enterAirAltar(s));return;}
  const {at,q}=ruinTarget(a);
  const observed=()=>state()?.nearbyLocs.find(l=>l.id===q.id&&l.x===at.x&&l.z===at.z&&l.level===at.level);
  if(!observed()||count(a.talisman)<1)throw Error(`${a.name} ruins/talisman unobserved`);
  const face=await interactionApproach(s.sdk,at,q);check();
  if(!face)throw Error(`${a.name} ruins approach unavailable`);
  const atFace=()=>pos()?.worldX===face.x&&pos()?.worldZ===face.z&&pos()?.level===face.level;
  if(!atFace()){
   const walked=await action(`approach-${a.name}-ruins`,async()=>walkPath(await sessionWalker(s),[{x:face.x,z:face.z,tol:0}],{maxTicks:60,stop}));check();
   if(!walked.ok||!atFace())throw Error(`${a.name} ruins approach unobserved: ${walked.detail??'off face'}`);
  }
  // The wilderness warning at the mind ruins blocks the low-level item action.
  const settled=await action(`close-${a.name}-entry-modal`,()=>settleRuneEntryModal(s,stop));check();
  if(!settled)throw Error(`${a.name} entry modal closure unobserved`);
  const baseline=state(),revision=baseline?.revision??0,entryTick=baseline?.tick??s.tick();
  let request:object|null=null;
  const observe=(phase:string,extra:object={})=>console.log('RUNE_ENTRY_OBSERVATION '+JSON.stringify({phase,altar:a.name,request,
   state:runeEntrySnapshot(state(),revision,entryTick),...extra}));
  observe('before');
  const off=s.onTick(()=>observe('tick'));
  let entry:RuneEntryResult;
  try{
   entry=await dispatchRuneEntry(s,{stop,entered:()=>insideRuneAltar(a,pos()),dispatch:async attempt=>{
    // BotActions pre-walks toward a distant anchor, so dispatch from the confirmed operable face.
    const fresh=await interactionApproach(s.sdk,at,q),item=inv().find(i=>i.id===a.talisman);check();
    if(!fresh||fresh.x!==face.x||fresh.z!==face.z||!atFace()||!observed()||!item)throw Error(`${a.name} ruins approach or talisman changed`);
    request={attempt,itemSlot:item.slot,itemId:item.id,itemCount:item.count,x:at.x,z:at.z,level:at.level,locId:q.id,inventoryComponent:3214};
    const reply=await action(`enter-${a.name}`,()=>s.sdk.sendUseItemOnLoc(item.slot,at.x,at.z,q.id));
    observe('reply',{reply});return reply;
   }});
  }finally{off();observe('end');}
  check();if(!entry.entered||!insideRuneAltar(a,pos()))throw Error(`${a.name} ${entry.failure??'altar entry stopped'} after ${entry.dispatches} dispatches, ${entry.warnings} warnings`);
 };
 const exit=async(a:RuneAltar)=>{
  check();if(a.name==='air'){await action('exit-air',()=>exitAirAltar(s,stop));return;}
  const portal=state()?.nearbyLocs.find(l=>l.id===a.portal&&l.optionsWithIndex.some(o=>o.opIndex===1&&/^use$/i.test(o.text)));
  if(!portal)throw Error(`${a.name} exit portal unobserved`);
  const edges=[tile(portal.x,portal.z+1,a.inside.level),tile(portal.x+1,portal.z,a.inside.level),tile(portal.x,portal.z-1,a.inside.level),tile(portal.x-1,portal.z,a.inside.level)];
  const edge=edges.find(e=>{const p=s.sdk.findPath(e.x,e.z);return p.success&&p.reachedDestination===true;});
  if(!edge)throw Error(`${a.name} exit approach unavailable`);
  const walked=await action(`approach-${a.name}-portal`,()=>s.bot.walkTo(edge.x,edge.z,0,{timeout:10000}));check();
  if(!walked.success||pos()?.worldX!==edge.x||pos()?.worldZ!==edge.z||pos()?.level!==edge.level)throw Error(`${a.name} exit approach unobserved`);
  const reply=await action(`exit-${a.name}`,()=>s.sdk.sendInteractLoc(portal.x,portal.z,portal.id,1));
  if(!reply.success)throw Error(`${a.name} exit action refused`);
  const outside=()=>!!pos()&&pos()!.level===a.outside.level&&Math.max(Math.abs(pos()!.worldX-a.outside.x),Math.abs(pos()!.worldZ-a.outside.z))<=2;
  if(!await waitUntil(s,()=>stop()||outside(),{timeoutTicks:20}))throw Error(`${a.name} exit unobserved`);
  check();if(!outside())throw Error(`${a.name} exit stopped`);
 };
 const summary=()=>({target,stage,trips,consumed,crafted,ledger,tripResults,altar:chosen?.name,level0,level:level(),xp:xp()-xp0,
  held:{essence:count(ESSENCE),air:count(AIR),runes:runeCount()},ticks:s.tick()-start,position:pos()});
 try{
  if(!await waitUntil(s,()=>!!pos()&&level()>0&&Array.isArray(state()?.inventory),{timeoutTicks:30}))throw Error('entry position, skills or pack unobserved');
  level0=level();xp0=xp();
  const held0={essence:count(ESSENCE),air:count(AIR)};
  const initialRunes=Object.fromEntries(RUNE_ALTARS.map(a=>[a.rune,count(a.rune)]));
  // Resume an interrupted trip from its observed position. The bank is unchanged by crafting.
  const resumed=RUNE_ALTARS.find(a=>insideRuneAltar(a,pos()));
  if(resumed){
   stage='altar-resume';chosen=resumed;if(count(ESSENCE)>0)await craft(resumed);
   await exit(resumed);
  }
  let bankEssence=NaN;
  while(true){
   check();stage='bank';await travel(BANK);await open();
   ledger??={essence0:held0.essence+bankCount(ESSENCE),essence:0,air0:held0.air+bankCount(AIR),air:0,consumed:0,crafted:0,
    runes:Object.fromEntries(RUNE_ALTARS.map(a=>[a.rune,{before:initialRunes[a.rune]!+bankCount(a.rune),after:0,
     crafted:tripResults.filter(t=>t.altar===a.name).reduce((n,t)=>n+t.crafted,0)}]))};
   const owned=new Set([...inv(),...(s.bankObservation?.()?.items??[])].filter(i=>i.count>0).map(i=>i.id));
   const selection=chooseRuneAltar(level(),owned);
   chosen=selection.altar;
   for(const name of selection.wanted)console.log(`TALISMAN_WANTED ${name}`);
   await secure();bankEssence=bankCount(ESSENCE);
   if(runeBankDone(level(),target,bankEssence)){
    if(level()<target&&consumed===0)throw Error('next acquisition: rune essence1436 exhausted before any crafting');
    break;
   }
   if(!chosen)throw Error('next acquisition: no accessible altar talisman in pack or bank');
   console.log('RUNE_BANK_ALTAR '+JSON.stringify({trip:trips+1,altar:chosen.name,level:level(),xpPerEssence:chosen.xp}));
   if(count(chosen.talisman)<1)await withdraw(chosen.talisman,1);
   const n=Math.min(bankEssence,28-inv().length);if(n<1)throw Error('next acquisition: free pack slots for rune essence');
   await withdraw(ESSENCE,n);await close();
   stage='altar';await travel(runeAltarStaging(chosen));await enter(chosen);
   check();await craft(chosen);await exit(chosen);trips++;
   console.log('RUNE_BANK_PROGRESS '+JSON.stringify({at:new Date().toISOString(),target,trips,altar:chosen.name,level:level(),consumed,crafted}));
  }
  stage='final';
  Object.assign(ledger,{essence:bankCount(ESSENCE)+count(ESSENCE),air:bankCount(AIR)+count(AIR),consumed,crafted});
  for(const a of RUNE_ALTARS)if(ledger?.runes)ledger.runes[a.rune]!.after=bankCount(a.rune)+count(a.rune);
  const result=summary();await close();
  const ok=runeBankOk({ledger,level0,level:result.level,target,bankEssence,held:result.held,stopped:stop()});
  return {ok,...result,bankEssence};
 }catch(error){return {ok:false,...summary(),stopReason:stopReason(),failure:String(error)};}
}

async function runeBankCli(){
 if(['--rune-carriers','--rune-opening'].includes(process.argv.at(-1)??'')){
  const {mainRuneStage}=await import('./rune-carrier-stage');await mainRuneStage(process.argv.slice(2));return;
 }
 if(process.argv.includes('--carriers')||process.argv.includes('--body-continuation')){
  try{
   const {runeCarrierRoster}=await import('./rune-carrier-roster');
   const {runRuneCarriers}=await import('./rune-carriers');
   const roster=runeCarrierRoster(process.argv.slice(2)),r=await runRuneCarriers(roster,Number(process.env.CAP??2800),{bodyContinuation:process.argv.includes('--body-continuation')});
   console.log('RUNE_CARRIERS_RESULT '+JSON.stringify(r));
   await finish([],r.ok,'failure' in r?r.failure??'carrier route failed':`runecraft=${r.level} batches=${r.batches}`);return;
  }catch(error){await finish([],false,String(error));}
 }
 const target=runeBankTarget(Number(process.argv[3]??99));
 if(!process.argv[2])throw Error('account argument required');
 let stopped=false;const s=await openBot(process.argv[2],{onStop:async()=>{stopped=true;}});
 try{
  const r=await runRuneBankCraft(s,target,{cap:Number(process.env.CAP??20000),stop:()=>stopped});
  console.log('RUNE_BANK_CRAFT_RESULT '+JSON.stringify(r));
  await finish([s],r.ok,`runecraft=${r.level} trips=${r.trips} consumed=${r.consumed} crafted=${r.crafted}${'failure' in r?' '+r.failure:''}`);
 }catch(error){await finish([s],false,String(error));}
}
if(import.meta.main)void runeBankCli().catch(error=>finish([],false,String(error)));
