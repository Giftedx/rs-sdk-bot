import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs} from '../packages/knowledge/src/config';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
export type StallRecipe={name:string;loc:number;level:number;respawn:number;loot:number[];questGate:boolean};
export function stallRecipes():StallRecipe[]{
 const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
 const pack=(file:string)=>new Map(readFileSync(resolve(root,'pack',file),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
 const locs=pack('loc.pack'),objs=pack('obj.pack');
 return parseConfigs(readFileSync(resolve(root,'scripts/skill_thieving/configs/stalls/stealing.dbrow'),'utf8'),'stealing.dbrow').map(b=>{
  const fields=b.props.data??[],one=(key:string)=>fields.find(v=>v.startsWith(key+','))?.slice(key.length+1),locName=one('loc')!;
  const r={name:b.name,loc:locs.get(locName)!,level:Number(one('level')),respawn:Number(one('respawn_ticks')),loot:fields.filter(v=>v.startsWith('loot,')).map(v=>objs.get(v.split(',')[1]!)!),questGate:locName==='viking_fish_market'||locName==='viking_fur_market'};
  if(!Number.isSafeInteger(r.loc)||!Number.isSafeInteger(r.level)||!Number.isSafeInteger(r.respawn)||!r.loot.length||!r.loot.every(Number.isSafeInteger))throw Error('native stall recipe unresolved: '+b.name);
  return r;
 });
}
type Stock=readonly {id:number;count:number}[];
const count=(items:Stock,id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function stallEffect(recipe:StallRecipe,before:Stock,after:Stock,xpBefore:number,xpAfter:number){
 const gains=recipe.loot.map(id=>({id,amount:count(after,id)-count(before,id)}));
 return gains.filter(x=>x.amount===1).length===1&&gains.every(x=>x.amount===0||x.amount===1)&&xpAfter>xpBefore;
}
// Finite inventory-output job. Start beside selected native stall. The worker
// retains all loot, never discards carried assets and stops on any damage.
export async function stealStall(s:Session,name:string,maximum:number,cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isSafeInteger(cap)||cap<1)throw Error('invalid stall order');
 const r=stallRecipes().find(r=>r.name===name);if(!r)throw Error('unknown native stall');
 const life=watchProductionLife(s,stop),start=s.tick(),over=()=>life.stopped()||s.tick()-start>=cap;
 const inv=()=>s.sdk.getInventory().map(i=>({id:i.id,count:i.count})),xp=()=>s.sdk.getSkillXp('Thieving')??0;
 const initial=inv(),xp0=xp();let made=0,detail='',attempts=0;const loot:Record<number,number>={};
 try{
  if((s.sdk.getSkill('Thieving')?.level??0)<r.level)throw Error('stall thieving level short');
  while(made<maximum&&!over()){
   if(s.sdk.getInventory().length>=28)throw Error('stall inventory full; bank retained outputs');
   const loc=()=>s.sdk.getState()?.nearbyLocs.find(l=>l.id===r.loc);
   if(!loc())await waitUntil(s,()=>!!loc()||over(),{timeoutTicks:Math.min(r.respawn+10,Math.max(1,cap-(s.tick()-start)))});
   if(over())break;const target=loc();if(!target)throw Error('native stall absent after respawn budget');
   const before=inv(),beforeXp=xp();attempts++;
   const sent=await s.sdk.sendInteractLoc(target.x,target.z,target.id,2);
   if(!sent.success)throw Error('native stall interaction rejected');
   await waitUntil(s,()=>stallEffect(r,before,inv(),beforeXp,xp())||over(),{timeoutTicks:Math.min(12,Math.max(1,cap-(s.tick()-start)))});
   if(!stallEffect(r,before,inv(),beforeXp,xp()))throw Error(r.questGate?'stall no progress; check Fremennik Trials gate/owner/guard visibility':'stall no progress; check owner/guard visibility');
   for(const id of r.loot){const n=count(inv(),id)-count(before,id);if(n)loot[id]=(loot[id]??0)+n;}
   made++;if(made<maximum&&!over())await waitTicks(s,Math.min(2,Math.max(1,cap-(s.tick()-start))));
  }
  if(made!==maximum)throw Error(life.reason()||'stall tick budget');
 }catch(error){detail=String(error);}
 const final=inv(),preserved=initial.every(i=>count(final,i.id)===count(initial,i.id)+(loot[i.id]??0));
 detail ||= life.reason();return{ok:!detail&&made===maximum&&preserved,made,attempts,loot,preserved,xpGain:xp()-xp0,ticks:s.tick()-start,detail};
}
if(import.meta.main){
 const name=process.argv[2]??'',stall=process.argv[3]??'',quantity=Number(process.argv[4]??1),cap=Number(process.argv[5]??120);
 if(!name||!stallRecipes().some(r=>r.name===stall)||!Number.isSafeInteger(quantity)||quantity<1||!Number.isSafeInteger(cap)||cap<1)throw Error('Usage: bun scripts/microbot-c-stalls.ts <account> <native stealing dbrow name> [quantity] [ticks]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const s=await openBot(name);let ok=false;try{const result=await stealStall(s,stall,quantity,cap,()=>stopped);console.log('STALL_RESULT '+JSON.stringify(result));ok=result.ok;}finally{ok=await settle([s],ok,'finite native stall order');}process.exitCode=ok?0:1;
}
