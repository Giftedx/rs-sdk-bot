import type {Session} from '../packages/core/src/inprocess';
import {existsSync} from 'node:fs';
export function productionStopRequested(actor:string|undefined,stop:()=>boolean=()=>false,exists:(path:string)=>boolean=existsSync,role:string|undefined=process.env.STOP_FILE){return stop()||exists('.practice/stop-all')||!!actor&&exists(`.practice/stop-${actor}`)||!!role&&exists(role);}
// A stopped or replaced life must never resume a production loop.
export function watchProductionLife(s:Session,stop:()=>boolean=()=>false,options:{allowDamage?:boolean}={}){
 const allowDamage=options.allowDamage===true;
 const initial=s.sdk.getState()?.player,initialHp=s.sdk.getSkill('Hitpoints')?.level??0;
 if(!initial||initialHp<=0||allowDamage&&!Number.isFinite(initialHp))throw Error('production life unobserved');
 const initialRespawns=initial.respawnCount??0,initialLife=initial.lifeId;
 let ended=false,why='';void s.ended?.then(()=>{ended=true;});
 const reason=()=>{
  const p=s.sdk.getState()?.player,hp=s.sdk.getSkill('Hitpoints')?.level??0;
  if(why)return why;
  if(ended)why='session ended';else if(productionStopRequested(s.name,stop))why='stop requested';
  else if(!p||hp<=0||p.isDead||allowDamage&&!Number.isFinite(hp))why='dead or player unavailable';
  else if((allowDamage?(p.respawnCount??0)!==initialRespawns:(p.respawnCount??0)>initialRespawns)||(initialLife!==undefined&&p.lifeId!==initialLife))why='life changed';
  else if(!allowDamage&&hp<initialHp)why='damage observed';
  return why;
 };
 return{reason,stopped:()=>!!reason()};
}
