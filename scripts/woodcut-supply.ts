import {existsSync} from 'node:fs';
import {openBot, getWorld, accountOf, countItems} from '../packages/core/src/bot';
import {goTo} from '../packages/core/src/walk';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {runShafts} from './fletch-shafts';
import {runHeadless} from './fletch-arrows';
type Session=Awaited<ReturnType<typeof openBot>>;
const BANK={x:3092,z:3243,level:0},KNIFE={x:3224,z:3202,level:0},TREES={x:3226,z:3237,level:0};
export function supplyPlan(logs:number,headless:number,cap:number){
 if(!Number.isSafeInteger(logs)||logs<1||logs>25||!Number.isSafeInteger(headless)||headless<0||headless%15||headless>Math.floor(Math.max(0,logs*15-200)/15)*15||!Number.isSafeInteger(cap)||cap<100||cap>10000)throw Error('supply requires LOGS1..25, HEADLESS multiple15 within shaft reserve200, CAP100..10000');
 return {logs,headless,shafts:logs*15};
}
export async function runWoodSupply(s:Session,logs:number,headless:number,cap:number){
 const plan=supplyPlan(logs,headless,cap),start=s.tick(),hp=s.sdk.getSkill('Hitpoints')?.level??0;
 let hpMin=hp;const damage:any[]=[];const off=s.onTick(()=>{const now=s.sdk.getSkill('Hitpoints')?.level??0;if(now<hpMin){const p=s.sdk.getState()?.player;damage.push({tick:s.tick()-start,hp:now,pos:p&&{x:p.worldX,z:p.worldZ,level:p.level},combat:p?.combat,npcs:s.sdk.getState()?.nearbyNpcs.map(n=>({name:n.name,x:n.x,z:n.z,distance:n.distance}))});console.log('WOOD_SUPPLY_DAMAGE '+JSON.stringify(damage.at(-1)));hpMin=now;}});
 const stop=()=>existsSync('.practice/stop-'+s.name),held=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const check=()=>{if(stop()||s.tick()-start>=cap||(s.sdk.getSkill('Hitpoints')?.level??0)<hp||s.sdk.getState()?.player?.isDead)throw Error('supply stopped, capped or damaged');};
 const walk=async(t:typeof BANK)=>{check();const r=await goTo(s,await getWorld(),t,accountOf(s),{legTimeoutTicks:100});if(!r.ok)throw Error('supply route '+r.reason+' '+r.detail);check();};
 const travel=async(t:typeof BANK)=>{
  const p=s.sdk.getState()?.player;if(p&&p.level===t.level&&Math.max(Math.abs(p.worldX-t.x),Math.abs(p.worldZ-t.z))<=2)return;
  // The courier's north-bank lane avoids the jail/road approach. Keep the supply route north of the Lumbridge spiders.
  if(t===BANK){await walk({x:3226,z:3266,level:0});await walk({x:3092,z:3266,level:0});}
  else if(t===TREES){await walk({x:3092,z:3266,level:0});await walk({x:3226,z:3266,level:0});}
  await walk(t);
 };
 const bank=async()=>{await travel(BANK);if(!(await s.bot.openBank()).success)throw Error('supply bank unavailable');};
 const deposit=async()=>{for(const id of [1511,946]){const item=s.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(s,item);}await s.bot.closeBank();};
 let gathered=0,shafts:any,arrows:any;
 try{
  if(!s.sdk.getInventory().some(i=>/axe$/i.test(i.name)))throw Error('supply owned axe required');
  // Feather holders can carry a full starter kit. Only logs and the knife move into the bank; trees stay inside the existing Lumbridge safe box.
  if(!held(946)){
   await travel(KNIFE);
   for(let n=0;n<8&&!held(946);n++){check();const k=s.sdk.findGroundItem(/^knife$/i);if(k)await s.bot.pickupItem(k);await waitTicks(s,2);}
   if(!held(946))throw Error('supply knife spawn unavailable');
  }
  await bank();await deposit();
  let lastGain=s.tick();
  while(gathered<plan.logs){
   await travel(TREES);
   while(gathered<plan.logs&&s.sdk.getInventory().length<27){
    check();const old=held(1511),tree=s.sdk.getState()?.nearbyLocs.filter(l=>l.x>=3214&&l.x<=3239&&l.z>=3226&&l.z<=3250&&/^tree$/i.test(l.name)&&l.optionsWithIndex.some(o=>/chop/i.test(o.text))&&l.reachable!==false).sort((a,b)=>a.distance-b.distance)[0];
    if(!tree)throw Error('supply normal tree unavailable');
    await s.bot.interactLoc(tree,'Chop down');await waitUntil(s,()=>held(1511)>old||stop(),{timeoutTicks:12});
    const gain=held(1511)-old;if(gain>0){gathered+=gain;lastGain=s.tick();}
    if(s.tick()-lastGain>80)throw Error('supply no log progress');
   }
   await bank();await deposit();
  }
  check();shafts=await runShafts(s,{cap:Math.max(1,cap-(s.tick()-start)),maximum:logs,reserve:0,bankKnife:true,stop});
  if(!shafts.ok)throw Error('supply shafts '+JSON.stringify(shafts));
  if(headless){check();arrows=await runHeadless(s,{cap:Math.max(1,cap-(s.tick()-start)),maximum:headless,shaftReserve:200,featherReserve:100,stop});if(!arrows.ok||!arrows.targetMet)throw Error('supply headless '+JSON.stringify(arrows));}
  return {ok:true,gathered,shafts,arrows,ticks:s.tick()-start,hpMin,damage};
 }catch(error){return {ok:false,gathered,shafts,arrows,ticks:s.tick()-start,error:String(error),hpMin,damage};}finally{off();}
}
