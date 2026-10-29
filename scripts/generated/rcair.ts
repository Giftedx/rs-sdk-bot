// Air action shared by the inside-altar CLI and the self-supplied worker.
import {openBot,finish,countItems} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {waitUntil} from '../../packages/core/src/ticks';

export function insideAirAltar(p:{worldX:number;worldZ:number;level:number}|null|undefined):boolean {
 return !!p&&p.level===0&&p.worldX>=2830&&p.worldX<=2855&&p.worldZ>=4820&&p.worldZ<=4845;
}
export async function enterAirAltar(s:Session){
 if(insideAirAltar(s.sdk.getState()?.player))return;
 const ruins=s.sdk.getState()?.nearbyLocs.find(l=>/mysterious ruins/i.test(l.name)&&Math.max(Math.abs(l.x-2985),Math.abs(l.z-3292))<=3);
 const talisman=s.sdk.getInventory().find(i=>i.id===1438);
 if(!ruins||!talisman)throw Error('air entry requires earned air talisman1438 at ruins2985,3292');
 await s.bot.useItemOnLoc(talisman,ruins);
 if(!await waitUntil(s,()=>insideAirAltar(s.sdk.getState()?.player),{timeoutTicks:20}))throw Error('air altar entry unobserved');
}
// Pinned content/pack/loc.pack and maps/m44_75.jm2: 2465 at0_44_75_25_28.
// runecraft.dbrow air exit_coord has one square,0_46_51_39_24, offsets0,0,0.
export const outsideAirAltar=(p:{worldX:number;worldZ:number;level:number}|null|undefined)=>
 !!p&&p.level===0&&p.worldX===2983&&p.worldZ===3288;
export async function exitAirAltar(s:Session,stop:()=>boolean=()=>false){
 const check=()=>{if(stop())throw Error('air exit stopped');};
 check();if(!insideAirAltar(s.sdk.getState()?.player))return;
 const portal=s.sdk.findNearbyLoc(/^portal$/i,{withOption:/^use$/i});
 if(!portal)throw Error('air exit portal unobserved');
 if(portal.id!==2465||portal.x!==2841||portal.z!==4828||!portal.optionsWithIndex.some(o=>o.opIndex===1&&/^use$/i.test(o.text)))
  throw Error('air exit portal identity/option differs from pinned content');
 const messages=()=>s.sdk.getState()?.gameMessages??[];
 const cursor=()=>Math.max(0,...messages().map(m=>m.observationId??m.tick));
 let baseline=cursor();
 const record=(phase:string,reply?:unknown)=>console.log('AIR_EXIT '+JSON.stringify({phase,tick:s.tick(),portal,
  position:s.sdk.getState()?.player,opFeedback:s.sdk.getState()?.opFeedback,
  messages:messages().filter(m=>(m.observationId??m.tick)>baseline),reply}));
 record('selected');
 const off=s.onTick(()=>record('observe'));
 try{
  // SDK actions.ts _interactLocOnce uses walkTo(...,2), then treats any
  // animId as success. Neither proves reach or portal use after a craft.
  // Pinned shape10,1x1 portal uses reachedLoc, not travel tolerance. Finish
  // a complete local path to a cardinal edge before replacing its walk op.
  const edges=[{x:2841,z:4829},{x:2842,z:4828},{x:2841,z:4827},{x:2840,z:4828}];
  let edge:typeof edges[number]|undefined;
  for(const candidate of edges){
   check();const path=s.sdk.findPath(candidate.x,candidate.z);record('path',{candidate,path});
   if(path.success&&path.reachedDestination===true){edge=candidate;break;}
  }
  if(!edge)throw Error('air portal approach unavailable');
  check();record('approach',edge);
  const walk=await s.bot.walkTo(edge.x,edge.z,0,{timeout:10000});record('approached',walk);check();
  const p=s.sdk.getState()?.player;
  if(!walk.success||p?.level!==0||p.worldX!==edge.x||p.worldZ!==edge.z)throw Error('air portal approach unobserved');
  baseline=cursor();const rejected=s.sdk.getState()?.opFeedback?.opRejectedCount;
  // Dispatch exactly the pinned op. Observe its effect ourselves: a previous
  // crafting animation must never settle this action. No unchanged click loop.
  record('dispatch');const reply=await s.sdk.sendInteractLoc(portal.x,portal.z,portal.id,1);record('action',reply);check();
  if(!reply.success)throw Error('air portal action refused '+JSON.stringify(reply));
  const refusal=()=>messages().some(m=>(m.observationId??m.tick)>baseline&&/can(?:not|'t) reach/i.test(m.text))
   ||(rejected!==undefined&&(s.sdk.getState()?.opFeedback?.opRejectedCount??rejected)>rejected);
  const observed=await waitUntil(s,()=>stop()||outsideAirAltar(s.sdk.getState()?.player)||refusal(),{timeoutTicks:20});
  check();
  if(outsideAirAltar(s.sdk.getState()?.player)){record('outside');return;}
  if(refusal()){record('rejected');throw Error('air portal rejected after dispatch; no unchanged retry');}
  record('unobserved',{observed});throw Error('air portal exit unobserved');
 }finally{off();}
}
export function airCraftEffects(ess0:number,ess:number,runes0:number,runes:number,xp0:number,xp:number){
 return ess0>0&&ess===0&&runes-runes0>=ess0&&xp>xp0;
}
export async function craftAirRunes(s:Session,stop:()=>boolean=()=>false){
 if(!await waitUntil(s,()=>s.sdk.getInventory().length>0&&!!s.sdk.getSkill('Runecraft'),{timeoutTicks:30}))throw Error('air inventory/skills unobserved');
 if(!insideAirAltar(s.sdk.getState()?.player))throw Error('air craft requires observed inside-altar position');
 const ess=()=>countItems(s,/^rune essence$/i),runes=()=>countItems(s,/^air rune$/i),xp=()=>s.sdk.getSkillXp('Runecraft')??0;
 const ess0=ess(),runes0=runes(),xp0=xp(),start=s.tick();
 for(let attempt=0;attempt<3&&ess()>0&&!stop();attempt++){
  await s.bot.dismissBlockingUI();
  const altar=s.sdk.findNearbyLoc(/^altar$/i,{withOption:/craft/i});
  if(!altar)throw Error('air altar with craft option unobserved');
  await s.bot.interactLoc(altar,/craft/i);
  await waitUntil(s,()=>stop()||ess()===0,{timeoutTicks:12});
 }
 const result={ok:!stop()&&airCraftEffects(ess0,ess(),runes0,runes(),xp0,xp()),consumed:ess0-ess(),runes:runes()-runes0,xp:xp()-xp0,ticks:s.tick()-start};
 if(!result.ok)throw Error('air craft effects unobserved '+JSON.stringify(result));
 return result;
}
if(import.meta.main){
 const s=await openBot(process.argv[2]!);
 try{const r=await craftAirRunes(s);console.log(`RATE runecraft ${r.xp} ${r.ticks}`);await finish([s],r.ok,`airRunes=${countItems(s,/^air rune$/i)} essence=${countItems(s,/^rune essence$/i)} runecraftXp=${r.xp} ticks=${r.ticks}`);}
 catch(error){await finish([s],false,String(error));}
}
