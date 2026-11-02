import{readFileSync,existsSync}from'node:fs';
import{openBot,finish}from'../packages/core/src/bot';
import type{Session}from'../packages/core/src/inprocess';
import{sessionWalker,walkPath}from'../packages/core/src/walk';
import{waitUntil,waitTicks}from'../packages/core/src/ticks';
import{miningProfiles}from'./microbot-b-mining';
import{runBankJob,validateBankRouteJob}from'./microbot-bank-jobs';
import{runDropMining}from'./microbot-mining-drop';
const tiers=['tin_rock_table','iron_rock_table','coal_rock_table','gold_rock_table','mithril_rock_table','adamantite_rock_table','runite_rock_table']as const;
type Tile={x:number;z:number;level:number};
export interface ProgressiveMiningJob{maximum:number;batch:number;cap:number;returnTicks:number;travelTicks:number;members:boolean;mode:'bank'|'drop';keep?:number[];routes:{profile:string;bank:Tile;site:Tile;tool:number}[]}
export function progressiveMiningProfile(level:number){if(!Number.isSafeInteger(level)||level<1||level>99)throw Error('observed native Mining level required');const profiles=miningProfiles();return tiers.map(n=>profiles.find(p=>p.name===n)!).filter(p=>p.level<=level).sort((a,b)=>b.level-a.level)[0]!;}
// Native routes are explicit input. Modern donor location tables cannot assert
// that a bank, quest entrance or rock exists on this server.
export async function runProgressiveMining(s:Session,j:ProgressiveMiningJob,stop:()=>boolean=()=>false){
 if(!['bank','drop'].includes(j.mode)||![j.maximum,j.batch,j.cap,j.returnTicks,j.travelTicks].every(n=>Number.isSafeInteger(n)&&n>0)||j.maximum>100000||j.cap>100000||j.travelTicks>j.cap||j.cap<=j.returnTicks||typeof j.members!=='boolean'||!j.routes.length||new Set(j.routes.map(r=>r.profile)).size!==j.routes.length)throw Error('invalid finite progressive mining plan');
 for(const r of j.routes){if(!tiers.includes(r.profile as any)||!Number.isSafeInteger(r.tool)||r.tool<0)throw Error('invalid progressive native profile/tool');validateBankRouteJob({family:'mining',recipe:r.profile,target:1,batch:1,cap:j.cap,returnTicks:j.returnTicks,members:j.members,bank:r.bank,site:r.site});}
 const first=s.sdk.getState()?.player,hp=s.sdk.getSkill('Hitpoints')?.level,start=s.tick();if(!first||!hp)throw Error('progressive mining life unknown');const life=first.lifeId,respawns=first.respawnCount;
 const halt=()=>{const p=s.sdk.getState()?.player;return stop()||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${s.name}`)||!p||p.isDead||p.lifeId!==life||p.respawnCount!==respawns||s.sdk.getSkill('Hitpoints')?.level!==hp||s.tick()-start>=j.cap;};
 const receipts:any[]=[];let made=0;
 while(made<j.maximum){
  if(halt())throw Error('progressive mining stopped or life/HP/budget changed');const profile=progressiveMiningProfile(s.sdk.getSkill('Mining')?.level??0),route=j.routes.find(r=>r.profile===profile.name);if(!route)throw Error('declare a native route for unlocked '+profile.name);
  const travelRoom=j.cap-(s.tick()-start)-j.returnTicks;if(travelRoom<1)throw Error('progressive mining return budget');
  const destination=j.mode==='bank'?route.bank:route.site;const travel=await walkPath(await sessionWalker(s),[{...destination,tol:j.mode==='bank'?2:0}],{maxTicks:Math.min(j.travelTicks,travelRoom),stop:halt});if(!travel.ok||halt())throw Error('progressive native route unavailable '+travel.detail);
  const n=Math.min(j.batch,j.maximum-made),cap=j.cap-(s.tick()-start);if(cap<=j.returnTicks)throw Error('progressive mining return budget');
  if(j.mode==='bank'){
   const r=await runBankJob(s,{family:'mining',recipe:profile.name,target:n,batch:n,cap,returnTicks:j.returnTicks,members:j.members,bank:route.bank,site:route.site,tool:route.tool},halt);receipts.push({profile:profile.name,...r});if(!r.ok)throw Error('progressive bank mining '+r.failure);made+=r.completed;
  }else{
   const r=await runDropMining({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:halt,mine:async l=>(await s.sdk.sendInteractLoc(l.x,l.z,l.id,1)).success,drop:async slot=>(await s.sdk.sendDropItem(slot)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},profile,{maximum:n,cap:cap-j.returnTicks,idleTicks:Math.min(300,cap-j.returnTicks),keep:j.keep??[]});receipts.push({profile:profile.name,...r});made+=r.made;
  }
 }
 return{ok:!halt()&&made===j.maximum,made,mode:j.mode,receipts,ticks:s.tick()-start,selection:'highest unlocked native donor tier; explicit native routes; reselect after each finite batch'};
}
if(import.meta.main){const[name,file]=process.argv.slice(2);if(!name||!file)throw Error('usage: microbot-mining-progressive.ts account job.json');const j=JSON.parse(readFileSync(file,'utf8'))as ProgressiveMiningJob,s=await openBot(name);let stopped=false;void s.ended.then(()=>{stopped=true;});try{const r=await runProgressiveMining(s,j,()=>stopped);console.log('PROGRESSIVE_MINING '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(error){await finish([s],false,String(error));}}
