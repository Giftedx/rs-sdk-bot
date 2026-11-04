// Furnace Bar Smelter: smelts all eight ordinary native metals and banks locally.
// Default location: Al Kharid furnace (3274, 3186) and bank (3269, 3167).
// Usage: bun scripts/smelt-bars.ts <bot> [CAP ticks, default 15000] [BAR_TYPE: iron | bronze | steel | gold | mithril | silver | adamantite | runite]
// Nonbronze: MAX_MAKE=28, ORE_RESERVE=1, ORDER_MODE=best-effort|exact. Al Kharid or Varrock East bank entry (10gp toll).
// ORDER_ACTION=smith: anvil order on owned bars. PRODUCT_ID, MAX_MAKE (exact count) and BAR_RESERVE are required;
// BAR_TYPE is unused. Stages from Al Kharid (10gp toll), Varrock East or Varrock West bank to the Varrock West anvils.
// Environment: DEMO_OK=1 for live server.
import { openBot, finish } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { productionBatch } from '../packages/planner/src/production-batch';
import {actionSessionOwner,finishActionSession} from './microbot-a-actions';
import {runSmeltBatch,smeltOwnedSession,validateSmeltOrder,validateSmeltRoute,type SmeltOrder,type SmeltBonusGear,type SmeltLocalRoute} from './smelt-batch';
import {runSmithBatch,smithRecipe} from './smith-batch';

const FURNACE_SPOT = { x: 3274, z: 3186 }; // Al Kharid Furnace
const BANK_SPOT = { x: 3269, z: 3167 };    // Al Kharid Bank

// Explicit owned gear only. No purchase or private remaining-charge inference.
export function smeltBonusFromEnv(env:Record<string,string|undefined>):SmeltBonusGear|undefined{
 const kind=env.SMELT_BONUS_GEAR;if(kind===undefined)return undefined;
 const xpRate=Number(env.SMELT_XP_RATE??25);
 if(kind==='goldsmith')return{kind,xpRate};
 if(kind==='forging')return{kind,xpRate,maximumRings:Number(env.MAX_RINGS),ringReserve:Number(env.RING_RESERVE)};
 throw Error('SMELT_BONUS_GEAR must be goldsmith or forging');
}
export function smeltRouteFromEnv(env:Record<string,string|undefined>):SmeltLocalRoute|undefined{
 if(env.SMELT_NEAREST!==undefined&&!['0','1'].includes(env.SMELT_NEAREST))throw Error('SMELT_NEAREST must be0or1');
 if(env.SMELT_NEAREST==='1'&&env.SMELT_ROUTE_JSON!==undefined)throw Error('nearest and explicit smelt routes are mutually exclusive');
 const text=env.SMELT_ROUTE_JSON;if(text===undefined)return undefined;if(text.length>4096)throw Error('local smelt route JSON too large');return validateSmeltRoute(JSON.parse(text));
}

type BronzeState={copper:number;tin:number;bars:number;xp:number};
export function planBronze(copper:number,tin:number,freeSlots:number,maximum:number,reserve:number){
 for(const n of [copper,tin,freeSlots,maximum,reserve])if(!Number.isSafeInteger(n)||n<0)throw new Error('invalid bronze bound');
 return productionBatch([
  {id:436,available:copper,reserved:reserve,units:1,stackable:false},
  {id:438,available:tin,reserved:reserve,units:1,stackable:false},
 ],freeSlots,maximum,'best-effort').planned;
}
export function bronzeProgress(before:BronzeState,after:BronzeState){
 const n=after.bars-before.bars;
 return n>0&&before.copper-after.copper===n&&before.tin-after.tin===n&&after.xp>before.xp?n:0;
}
export async function runBronze(raw:import('../packages/core/src/inprocess').Session,options:{maximum:number;reserve:number;cap:number;stop?:()=>boolean},io?:{walk:(x:number,z:number)=>Promise<boolean>}){
 const owner=smeltOwnedSession(raw,options.stop),s=owner.session;
 for(const n of [options.maximum,options.reserve,options.cap])if(!Number.isSafeInteger(n)||n<0)throw new Error('invalid bronze options');
 if(options.maximum<1||options.cap<1)throw new Error('positive MAX_MAKE and CAP required');
 const ready=await waitUntil(s,()=>owner.stopped()|| (s.sdk.getSkill('Hitpoints')?.level??0)>0&&(s.sdk.getSkill('Smithing')?.baseLevel??0)>0,{timeoutTicks:15});
 if(!ready||owner.stopped())throw new Error('bronze initial skills not ready');
 const inv=()=>s.sdk.getInventory(),bankItems=()=>s.sdk.getState()?.bank?.items??[];
 const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const state=():BronzeState=>({copper:count(inv(),436),tin:count(inv(),438),bars:count(inv(),2349),xp:s.sdk.getSkillXp('Smithing')??0});
 const p0={...s.sdk.getState()!.player!},t0=s.tick(),xp0=state().xp;
 if(p0.level!==0||Math.max(Math.abs(p0.worldX-BANK_SPOT.x),Math.abs(p0.worldZ-BANK_SPOT.z))>5)throw new Error('bronze requires staged Al Kharid bank entry');
 let died=false,ended=false,hpMin=s.sdk.getSkill('Hitpoints')!.level,made=0,attempts=0,failed=0,failure='';
 void s.ended.then(()=>{ended=true;});
 const off=s.onTick(()=>{const p=s.sdk.getState()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(!owner.own()||p?.isDead||hpMin<=0||(p?.respawnCount??0)>(p0.respawnCount??0)||(p0.lifeId!==undefined&&p?.lifeId!==p0.lifeId))died=true;});
 const keep=new RegExp(process.env.KEEP??'^(knife|shrimps|bread|shears|.*pickaxe|coins)$','i');
 const protectedKit=new Map<number,number>();for(const i of inv())if(keep.test(i.name))protectedKit.set(i.id,(protectedKit.get(i.id)??0)+i.count);
 const over=()=>owner.stopped()||ended||died||hpMin<7||s.tick()-t0>=options.cap;
 const walk=async(x:number,z:number,cleanup=false)=>{if(!owner.own()||!cleanup&&over())throw Error('bronze original walk stopped');if(io){if(!await io.walk(x,z)||!owner.own()||s.sdk.getState()?.player?.level!==0||Math.max(Math.abs((s.sdk.getState()?.player?.worldX??NaN)-x),Math.abs((s.sdk.getState()?.player?.worldZ??NaN)-z))>2)throw Error('bronze test/declared walk unconfirmed');return;}const r=await walkPath(await sessionWalker(s),[{x,z,tol:2}],{maxTicks:80,stop:()=>!owner.own()||ended||died||(!cleanup&&over())});if(!r.ok)throw new Error(`bronze walk ${r.detail}`);};
 const open=async()=>{if(!(await s.bot.openBank()).success)throw new Error('bronze bank open failed');await waitTicks(s,2);};
 const deposit=async(ids:number[])=>{for(const id of new Set(ids)){const item=inv().find(i=>i.id===id);if(item){const r=await s.bot.depositItem(item,-1);if(!r.success)throw new Error(`bronze deposit failed id=${id}`);}}await waitTicks(s,1);};
 let initialCopper=0,initialTin=0,initialBars=0,planned=0,finalCopper=0,finalTin=0,finalBars=0,banked=0;
 try{
  await open();await deposit(inv().filter(i=>!keep.test(i.name)).map(i=>i.id));
  initialCopper=count(bankItems(),436);initialTin=count(bankItems(),438);initialBars=count(bankItems(),2349);
  planned=planBronze(initialCopper,initialTin,28-inv().length,options.maximum,options.reserve);
  if(planned<options.maximum)throw new Error(`bronze input insufficient planned=${planned} target=${options.maximum}`);
  for(const [id,name] of [[436,'Copper ore'],[438,'Tin ore']] as const){await s.bot.withdrawItem(new RegExp(`^${name}$`,'i'),planned);if(count(inv(),id)!==planned)throw new Error(`bronze partial withdrawal id=${id}`);}
  await s.bot.closeBank();
  await walk(FURNACE_SPOT.x,FURNACE_SPOT.z);
  while(made<planned&&!over()){
   const d=s.sdk.getDialog();if(d?.isOpen){if(d.options.length===1&&/continue/i.test(d.options[0]!.text)){await s.sdk.sendClickDialog(d.options[0]!.index);await waitTicks(s,1);continue;}throw new Error('unexpected bronze dialog');}
   const furnace=s.sdk.findNearbyLoc(/^furnace$/i),ore=inv().find(i=>i.id===436);
   if(!furnace||!ore)throw new Error('bronze furnace/copper unavailable');
   const before=state();attempts++;await s.sdk.sendUseItemOnLoc(ore.slot,furnace.x,furnace.z,furnace.id);
   await waitUntil(s,()=>bronzeProgress(before,state())>0||over(),{timeoutTicks:8});
   const gained=bronzeProgress(before,state());
   if(gained){made+=gained;failed=0;}else{console.log(`WARN bronze no-progress attempt=${attempts} state=${JSON.stringify(state())}`);if(++failed>=3)throw new Error('no smelting progress: three attempts');await waitTicks(s,1);}
  }
  if(made!==options.maximum)failure='bronze stopped before target';
 }catch(e){failure=String(e);}
 finally{
  try{if(!ended&&!died&&owner.cleanup()){
   const d=s.sdk.getDialog();if(d?.isOpen)await s.direct({type:'closeModal',reason:'SDK'});
   await walk(BANK_SPOT.x,BANK_SPOT.z,true);await open();await deposit([436,438,2349]);
   finalCopper=count(bankItems(),436);finalTin=count(bankItems(),438);finalBars=count(bankItems(),2349);banked=finalBars-initialBars;
   console.log('BRONZE_BANK '+JSON.stringify({bank:bankItems(),inventory:inv()}));await s.bot.closeBank();
  }}catch(e){failure ||= `bronze final bank failed: ${String(e)}`;}off();
 }
 const preserved=[...protectedKit].every(([id,n])=>count(inv(),id)===n);
 const xpGain=state().xp-xp0,reserveMet=finalCopper>=options.reserve&&finalTin>=options.reserve;
 const conserved=initialCopper-finalCopper===made&&initialTin-finalTin===made;
 const ok=owner.own()&&!owner.stopped()&&!failure&&!died&&!ended&&hpMin>=7&&made===options.maximum&&banked===made&&xpGain>0&&preserved&&reserveMet&&conserved&&[436,438,2349].every(id=>count(inv(),id)===0);
 const result={ok,ticks:s.tick()-t0,made,banked,planned,attempts,xpGain,initialCopper,initialTin,initialBars,finalCopper,finalTin,finalBars,preserved,reserveMet,conserved,hpMin,died,failure};console.log('BRONZE_RESULT '+JSON.stringify(result));return result;
}
async function main(){
const botName = process.argv[2];
const BAR_TYPE = (process.argv[4] ?? process.env.BAR_TYPE ?? 'iron').toLowerCase();
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);

const ACTION=(process.env.ORDER_ACTION??'smelt').toLowerCase();

if (!botName) {
    console.error('Usage: bun scripts/smelt-bars.ts <botName> [CAP] [BAR_TYPE]');
    process.exit(1);
}
let smith:{product:number;maximum:number;reserve:number}|undefined;
let smelt:SmeltOrder|undefined;
if(ACTION==='smith'){
    // Refuse a malformed or unsupported order before login.
    const env=(k:string)=>process.env[k]===undefined||process.env[k]===''?NaN:Number(process.env[k]);
    smith={product:env('PRODUCT_ID'),maximum:env('MAX_MAKE'),reserve:env('BAR_RESERVE')};
    try{
        if(![CAP,smith.product,smith.maximum,smith.reserve].every(Number.isSafeInteger)||CAP<1||smith.maximum<1||smith.reserve<0)throw Error('smith refused: integer CAP>=1, PRODUCT_ID, MAX_MAKE>=1 and BAR_RESERVE>=0 required');
        smithRecipe(smith.product);
    }catch(e){console.error(String(e));process.exit(1);}
}else if(ACTION!=='smelt'){console.error('ORDER_ACTION must be smelt or smith');process.exit(1);}
else{
    smelt={bar:BAR_TYPE,cap:CAP,maximum:Number(process.env.MAX_MAKE??(BAR_TYPE==='bronze'?8:28)),reserve:Number(process.env.ORE_RESERVE??1),mode:(BAR_TYPE==='bronze'?'exact':process.env.ORDER_MODE??'best-effort') as SmeltOrder['mode']};
    try{smelt.bonusGear=smeltBonusFromEnv(process.env);smelt.route=smeltRouteFromEnv(process.env);smelt.nearest=process.env.SMELT_NEAREST==='1';validateSmeltOrder(smelt);}catch(error){console.error(String(error));process.exit(1);}
}

let stopped=false;
const s = await openBot(botName,{onStop:async()=>{stopped=true;}}).catch(e => finish([], false, `login: ${String(e)}`));
const owner=actionSessionOwner(s,()=>stopped);
try {
    if(smith){
        const result=await runSmithBatch(s,{...smith,cap:CAP,stop:()=>stopped});
        console.log('SMITH_RESULT '+JSON.stringify(result));
        await finishActionSession(owner,result.ok,`mode=smith ${JSON.stringify(result)}`);return;
    }
    if(BAR_TYPE==='bronze'&&!smelt?.route&&!smelt?.nearest){const result=await runBronze(s,{maximum:Number(process.env.MAX_MAKE??8),reserve:Number(process.env.ORE_RESERVE??1),cap:CAP,stop:()=>stopped});await finishActionSession(owner,result.ok,`mode=bronze ${JSON.stringify(result)}`);return;}
    if(!smelt)throw Error('smelt order missing');
    const result=await runSmeltBatch(s,{...smelt,stop:()=>stopped});
    console.log('SMELT_RESULT '+JSON.stringify(result));
    await finishActionSession(owner,result.ok,`mode=${BAR_TYPE} ${JSON.stringify(result)}`);
} catch (e) {
    await finishActionSession(owner, false, String(e));
}

}
if(import.meta.main)await main();
