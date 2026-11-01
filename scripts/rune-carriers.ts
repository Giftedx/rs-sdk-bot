import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openBot,settle,serverFromEnv,getWorld} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {assertSideOwns} from '../packages/core/src/fleet';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {xpForLevel} from '../packages/planner/src/curve';
import {transfer,ownedSwap,ess,state} from './rune-carrier-trade';
import {restock,inside,stopCarriers} from './rune-carrier-bank';
import {freshBodyStart} from './rune-carrier-start';
import {runeCarrierRoster,assertFreshRuneSkills,assertRuneDonor} from './rune-carrier-roster';

// One composed swarm job owns the complete roster; openBot retains fleet-side,
// worker-release and server admission for each session.
export async function runRuneCarriers(roster:readonly string[],cap=2800){
 const names=runeCarrierRoster([...roster,'--carriers']),root=resolve(import.meta.dir,'..');
 if(!Number.isSafeInteger(cap)||cap<1||cap>10000)throw Error('carrier tick budget must be1..10000');
 const servers=names.map(n=>{assertSideOwns(n);return serverFromEnv(readFileSync(join(root,'vendor/rs-sdk/bots',n,'bot.env'),'utf8'));});
 if(new Set(servers.map(s=>s.toLowerCase())).size!==1)throw Error('carrier participants must share one server');
 type Carrier={s:Session;ready:boolean;deliveries:number;refills:number[];flight?:Promise<void>};
 const opened:Session[]=[],crew:Carrier[]=[],rows:unknown[]=[];let done=false,failure:unknown;
 const stop=()=>done||!!failure||opened.some(s=>s.tick()>cap)||names.some(n=>existsSync(join(root,'.practice/stop-'+n)));
 const fail=(s:Session,detail:string)=>{failure=Error(s.name+': '+detail);stopCarriers();};
 const open=async(name:string)=>{const s=await openBot(name,{onStop:async(s,d)=>fail(s,d),onSessionEnd:async(s,d)=>fail(s,d)});opened.push(s);return s;};
 const launchRefill=(d:Carrier)=>{d.flight=restock(d.s).then(t=>{d.refills.push(t);d.ready=true;}).catch(e=>{if(!done){failure=e;stopCarriers();}});};
 try{
  await getWorld();const donor=await open(names[1]!);await waitTicks(donor,3);assertRuneDonor(state(donor).player,donor.sdk.getInventory());
  const s=await open(names[0]!);if(!await waitUntil(s,()=>!!state(s)?.player&&!!s.sdk.getSkill('Runecraft'),{timeoutTicks:10}))throw Error('fresh player state unavailable');
  assertFreshRuneSkills(state(s).skills);
  const prefix=await freshBodyStart(s,donor,stop,async()=>{
   for(const n of names.slice(2)){if(stop())throw Error('carrier setup stopped');const h=await open(n);await waitTicks(h,3);if(!inside(h)||ess(h)!==27)throw Error('staged carrier not observed');crew.push({s:h,ready:true,deliveries:0,refills:[]});}
  });
  const initial:Carrier={s:donor,ready:false,deliveries:1,refills:[]};crew.push(initial);launchRefill(initial);
  const xp=()=>s.sdk.getSkillXp('Runecraft')??0,start=s.tick();let batches=1,waiting=0;
  while(xp()<xpForLevel(99)){
   if(stop())throw failure??Error('carrier route stopped or over budget');
   let d=crew.filter(h=>h.ready).sort((a,b)=>a.deliveries-b.deliveries)[0];
   if(!d){const at=s.tick();if(!await waitUntil(s,()=>stop()||crew.some(h=>h.ready),{timeoutTicks:190}))throw Error('no carrier returned');waiting+=s.tick()-at;if(stop())throw failure??Error('carrier route stopped');d=crew.filter(h=>h.ready).sort((a,b)=>a.deliveries-b.deliveries)[0];}
   if(!d)throw Error('no owned ready carrier');d.ready=false;const before=xp(),at=s.tick();
   const tal=s.sdk.getInventory().filter(i=>i.id===1446).reduce((n,i)=>n+i.count,0);
   const tradeTicks=tal===1?(await ownedSwap(s,d.s,{1446:1},{1436:27},stop)).ticks:await transfer(s,d.s,stop);
   if(stop())throw failure??Error('carrier route stopped');d.deliveries++;launchRefill(d);
   const altar=state(s).nearbyLocs.find(l=>l.id===2483);if(!altar)throw Error('body altar unobserved');
   await s.direct({type:'interactLoc',x:altar.x,z:altar.z,locId:altar.id,optionIndex:1,reason:'SDK'});
   if(!await waitUntil(s,()=>stop()||ess(s)===0&&xp()>before,{timeoutTicks:15})||stop())throw Error('body craft effect unobserved or stopped');
   batches++;const row={batch:batches,helper:d.s.name,tick:s.tick(),ticks:s.tick()-at,tradeTicks,xp:xp(),level:s.sdk.getSkill('Runecraft')?.baseLevel,waiting};rows.push(row);console.log('RUNE_CARRIER_BATCH '+JSON.stringify(row));
  }
  const levelTick=s.tick();done=true;stopCarriers();await Promise.allSettled(crew.map(h=>h.flight));
  const result={prefix,batches,xp:xp(),level:s.sdk.getSkill('Runecraft')?.baseLevel,levelTick,masterTicks:s.tick(),bodyLoopTicks:levelTick-start,waiting,rows,crew:crew.map(h=>({name:h.s.name,deliveries:h.deliveries,refills:h.refills}))};
  const logout=await settle(opened,true,'fresh Runecraft99 with carrier banks');return {ok:logout,...result,logout};
 }catch(error){done=true;stopCarriers();await Promise.allSettled(crew.map(h=>h.flight));const logout=await settle(opened,false,String(error));return {ok:false,failure:String(error),logout};}
}
