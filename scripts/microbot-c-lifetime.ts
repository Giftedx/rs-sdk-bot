import type {Session} from '../packages/core/src/inprocess';
import {existsSync} from 'node:fs';
// A stopped or replaced life must never resume a production loop.
export function watchProductionLife(s:Session,stop:()=>boolean=()=>false){
 const initial=s.sdk.getState()?.player,initialHp=s.sdk.getSkill('Hitpoints')?.level??0;
 if(!initial||initialHp<=0)throw Error('production life unobserved');
 const initialRespawns=initial.respawnCount??0,initialLife=initial.lifeId;
 let ended=false,why='';void s.ended?.then(()=>{ended=true;});
 const reason=()=>{
  const p=s.sdk.getState()?.player,hp=s.sdk.getSkill('Hitpoints')?.level??0;
  if(why)return why;
  if(ended)why='session ended';else if(stop()||(!!process.env.STOP_FILE&&existsSync(process.env.STOP_FILE)))why='stop requested';
  else if(!p||hp<=0||p.isDead)why='dead or player unavailable';
  else if((p.respawnCount??0)>initialRespawns||(initialLife!==undefined&&p.lifeId!==initialLife))why='life changed';
  else if(hp<initialHp)why='damage observed';
  return why;
 };
 return{reason,stopped:()=>!!reason()};
}
