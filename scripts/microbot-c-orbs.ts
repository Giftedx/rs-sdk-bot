import {existsSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {installSpellLocBridge} from './microbot-c-spell-loc';
import {watchProductionLife} from './microbot-c-lifetime';
import {elementalRuneCost} from './microbot-magic-items';
// magic_spells.dbrow provides levels, rune costs and obelisk mappings.
export const orbRecipes={air:{level:66,rune:556,loc:2152,output:573,spell:1186},water:{level:56,rune:555,loc:2151,output:571,spell:1179},earth:{level:60,rune:557,loc:2150,output:575,spell:1182},fire:{level:63,rune:554,loc:2153,output:569,spell:1184}} as const;
export type OrbKind=keyof typeof orbRecipes;
type Assets={raw:number;product:number;cosmic:number;element:number;xp:number};
export function orbEffect(a:Assets,b:Assets,elementCost=30){return a.raw-b.raw===1&&b.product-a.product===1&&a.cosmic-b.cosmic===3&&a.element-b.element===elementCost&&b.xp>a.xp;}
// Staged consumer: stand at selected obelisk with unpowered orbs and runes.
// Native equipped elemental staves substitute their rune at slot 3.
export async function chargeInventory(s:Session,kind:OrbKind,maximum:number,cap:number,stop:()=>boolean=()=>false){
 if(!Object.hasOwn(orbRecipes,kind)||!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid orb order');
 const r=orbRecipes[kind],start=s.tick(),count=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const assets=():Assets=>({raw:count(567),product:count(r.output),cosmic:count(564),element:count(r.rune),xp:s.sdk.getSkillXp('Magic')??0});
 const initial=assets(),protectedItems=new Map<number,number>();
 const elementCost=()=>elementalRuneCost(r.rune,30,s.sdk.getEquipment(),true);
 for(const i of s.sdk.getInventory())if(![567,r.output,564,r.rune].includes(i.id))protectedItems.set(i.id,count(i.id));
 const life=watchProductionLife(s,stop),over=()=>life.stopped()||s.tick()-start>=cap;let made=0,detail='',restore:(()=>void)|undefined;
 try{
  if((s.sdk.getSkill('Magic')?.baseLevel??0)<r.level)throw Error('orb magic level short');
  if(initial.raw<maximum||initial.cosmic<maximum*3||initial.element<maximum*elementCost())throw Error('staged orb supplies short');
  restore=installSpellLocBridge(s.client);
  while(made<maximum&&!over()){
   const loc=s.sdk.getState()?.nearbyLocs.find(l=>l.id===r.loc);
   if(!loc)throw Error('required obelisk not nearby');
   const before=assets(),cost=elementCost();await s.direct({type:'spellOnLoc',x:loc.x,z:loc.z,locId:loc.id,spellComponent:r.spell,reason:'SDK'});
   await waitUntil(s,()=>orbEffect(before,assets(),cost)||over(),{timeoutTicks:Math.min(12,Math.max(1,cap-(s.tick()-start)))});
   if(!orbEffect(before,assets(),cost))throw Error('orb input/product/rune/XP reconciliation failed');made++;
   // charge_orb.rs2 ends with p_delay(2); do not dispatch the next cast in that window.
   if(made<maximum&&!over())await waitTicks(s,Math.min(3,Math.max(1,cap-(s.tick()-start))));
  }
  if(made!==maximum)throw Error('orb budget or stop');
 }catch(error){detail=String(error);}finally{restore?.();}
 const final=assets(),preserved=[...protectedItems].every(([id,n])=>count(id)===n);
 detail ||= life.reason();return{ok:!detail&&preserved&&made===maximum,made,preserved,ticks:s.tick()-start,detail,initial,final};
}
if(import.meta.main){
 const name=process.argv[2]??'',kind=process.argv[3] as OrbKind,maximum=Number(process.argv[4]??1),cap=Number(process.argv[5]??(process.env.ORB_TRIP==='1'?6000:80));
 if(!name||!Object.hasOwn(orbRecipes,kind)||!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage (members world): bun scripts/microbot-c-orbs.ts <account> <air|water|earth|fire> [quantity] [ticks]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const stop=()=>stopped||existsSync('.practice/stop-'+name)||existsSync('.practice/stop-microbot-orbs')||!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE);
 const s=await openBot(name);let ok=false;
 try{const result=process.env.ORB_TRIP==='1'?await (await import('./microbot-orb-trip')).runOrbTrips(s,kind,orbRecipes[kind],chargeInventory,{target:maximum,batch:Number(process.env.ORB_BATCH??1),cap,stop}):await chargeInventory(s,kind,maximum,cap,stop);console.log('ORB_RESULT '+JSON.stringify(result));ok=result.ok;}
 finally{ok=await settle([s],ok,'finite orb order');}process.exitCode=ok?0:1;
}
