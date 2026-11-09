import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {goTo} from '../packages/core/src/walk';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';

// knowledge/npcs.json supplies the meat targets and bear spawns outside the fenced 2632,3277 pen.
export const MEATS=[
 {item:2132,npc:81,x:2660,z:3344,name:'raw beef'},
 {item:2134,npc:86,x:2517,z:3184,name:'raw rat meat'},
 {item:2136,npc:105,x:3159,z:3233,name:'raw bear meat'},
 {item:2138,npc:41,x:2691,z:3273,name:'raw chicken'},
] as const;
type Meat=Omit<typeof MEATS[number],'x'|'z'>&{x:number;z:number};
// Pinned knowledge/npcs.json ground-floor spawns. Draynor work stays on the mainland;
// goTo still checks actual collision, doors and arrival for each outbound and bank leg.
const DRAYNOR_MEATS:readonly Meat[]=MEATS.map(m=>({...m,...({
 2132:{x:3154,z:3325},2134:{x:3192,z:3207},2136:{x:3159,z:3233},2138:{x:3185,z:3277},
}[m.item])}));
type SpawnBox=readonly [number,number,number,number];
export const BEAR_SPAWNS=[[2691,3341],[2692,3333],[2484,3155],[2477,3143],[3159,3233],[3176,3223],[3230,3500]] as const;
const cheb=(a:{x:number;z:number},b:{x:number;z:number})=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
export const STALL_TICKS=20,HOP=150;
// A Yanille-to-Lumbridge goTo idled 1000 ticks without a step. Hops stay within the walked 148-tile rat leg.
export function waypointChain(from:{x:number;z:number},to:{x:number;z:number},hubs:readonly {x:number;z:number}[]=HUBS,hop=HOP){
 const nodes=[...hubs,to],dist=nodes.map(n=>cheb(from,n)<=hop?cheb(from,n):Infinity),prev=nodes.map(()=>-1),done=nodes.map(()=>false);
 for(;;){
  let i=-1;for(let k=0;k<nodes.length;k++)if(!done[k]&&dist[k]!<Infinity&&(i<0||dist[k]!<dist[i]!))i=k;
  if(i<0)return null;
  if(i===nodes.length-1){const chain=[];for(let k=i;k>=0;k=prev[k]!)chain.unshift(nodes[k]!);return chain;}
  done[i]=true;
  for(let k=0;k<nodes.length;k++){const d=cheb(nodes[i]!,nodes[k]!);if(!done[k]&&d<=hop&&dist[i]!+d<dist[k]!){dist[k]=dist[i]!+d;prev[k]=i;}}
 }
}
const boxDistance=(x:number,z:number,[x1,z1,x2,z2]:SpawnBox)=>Math.max(x1-x,0,x-x2,z1-z,0,z-z2);
function spawnApproaches(m:Meat,x:number,z:number){
 const boxes:readonly SpawnBox[]=[[m.x,m.z,m.x,m.z]];
 return [...boxes].sort((a,b)=>boxDistance(x,z,a)-boxDistance(x,z,b)).flatMap(box=>{
  const [x1,z1,x2,z2]=box,tiles:{x:number;z:number}[]=[];
  for(let tx=x1-1;tx<=x2+1;tx++)for(let tz=z1-1;tz<=z2+1;tz++)tiles.push({x:tx,z:tz});
  tiles.sort((a,b)=>Math.max(Math.abs(a.x-x),Math.abs(a.z-z))-Math.max(Math.abs(b.x-x),Math.abs(b.z-z)));
  // Keep the known anchor as the first choice within its box.
  const ordered=m.x>=x1&&m.x<=x2&&m.z>=z1&&m.z<=z2?[{x:m.x,z:m.z},...tiles.filter(t=>t.x!==m.x||t.z!==m.z)]:tiles;
  return ordered.map(tile=>({...tile,box}));
 });
}
type Item={id:number;count:number};
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export const missingMeats=(pack:readonly Item[],bank:readonly Item[])=>MEATS.filter(m=>count(pack,m.item)+count(bank,m.item)<1);
export function bearRefusal(hp:number,attack:number,strength:number,defence:number){
 return [hp,attack,strength,defence].every(Number.isFinite)&&hp>=60&&attack>=40&&strength>=40&&defence>=40?null:
  'too-weak-for-bear: requires current HP60, Attack40, Strength40, Defence40';
}
const BANKS=[{x:2619,z:3332},{x:2654,z:3283},{x:2612,z:3093},{x:3092,z:3243}] as const;
// Western hubs retain the practice route. Mainland hubs use the pinned Draynor bank and NPC spawns.
const HUBS=[...BANKS,...MEATS.filter(m=>m.npc!==105).map(({x,z})=>({x,z})),...DRAYNOR_MEATS.map(({x,z})=>({x,z}))];
type Floor={x:number;z:number;level:number};
type Transport={from:Floor;to:Floor};
type ExitLoc={id:number;x:number;z:number;optionsWithIndex:readonly {text:string;opIndex:number}[]};
let transportRows:Transport[]|undefined;
const transports=()=>transportRows ??= JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/transports.json'),'utf8')) as Transport[];
// Approach the observed loc within one tile; a reverse transport landing is not a required stand tile.
// Pinned stairs.loc gives stairstop a 2x2 footprint and op1 Climb-down. interactLoc dispatches its reach rule.
export function floorExit<L extends ExitLoc>(at:Floor,locs:readonly L[],rows:readonly Transport[]=transports()){
 const exits=locs.flatMap(loc=>{
  const op=loc.optionsWithIndex.find(o=>/^climb-down$/i.test(o.text));if(!op)return [];
  const known=rows.some(r=>r.from.level===at.level&&r.from.x===loc.x&&r.from.z===loc.z&&r.to.level<at.level);
  return [{loc,opIndex:op.opIndex,known,stand:{x:loc.x,z:loc.z}}];
 });
 return exits.sort((a,b)=>Number(b.known)-Number(a.known)||cheb(at,a.loc)-cheb(at,b.loc))[0]??null;
}
export const nearestMeatBank=(x:number,z:number)=>[...BANKS].sort((a,b)=>Math.max(Math.abs(a.x-x),Math.abs(a.z-z))-Math.max(Math.abs(b.x-x),Math.abs(b.z-z)))[0]!;
export async function runDruidMeats(s:Session,o:{cap?:number;stop?:()=>boolean;travel?:(x:number,z:number,signal:AbortSignal)=>Promise<void>}={}){
 const cap=o.cap??4000;
 if(!Number.isSafeInteger(cap)||cap<1)throw Error('invalid CAP: positive tick budget required');
 const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 if(!await waitUntil(s,()=>!!state()?.player&&hp()>0,{timeoutTicks:20}))throw Error('entry-state-timeout');
 const initial={...state()!.player!},start=s.tick(),ac=new AbortController();
 let ended=false,died=false,admitted=false,hpMin=hp(),failure='',kills=0,bankTrips=0;
 const acquired:number[]=[],skipped:number[]=[];
 void s.ended.then(()=>{ended=true;ac.abort('session-ended');});
 const observe=()=>{
  hpMin=Math.min(hpMin,hp());died ||= sessionDied(initial,state()?.player)||hp()<=0;
  failure ||= died?'life-lost':ended?'session-ended':o.stop?.()?'stop-requested':s.tick()-start>=cap?'tick-budget':admitted&&hp()<35?'low-hp-cutoff':'';
  if(failure&&!ac.signal.aborted)ac.abort(failure);
 };
 const off=s.onTick(observe);
 const check=()=>{observe();if(failure)throw Error(failure);};
 const near=(x:number,z:number)=>{const p=state()?.player;return !!p&&p.level===0&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=2;};
 // One goTo hop. A hop with no position change for STALL_TICKS is retried once from the current tile, then refused.
 const leg=async(x:number,z:number)=>{
  for(let attempt=0;;attempt++){
   check();const p=state()!.player!,from=`${p.worldX},${p.worldZ}`;
   console.log(`DRUID_MEATS_TRAVEL ${x},${z}`);
   const legAc=new AbortController(),abort=()=>legAc.abort(ac.signal.reason);
   ac.signal.addEventListener('abort',abort,{once:true});
   let mx=p.worldX,mz=p.worldZ,ml=p.level,moved=s.tick(),stalled=false,error:unknown;
   const watch=s.onTick(()=>{
    const q=state()?.player;if(!q||stalled)return;
    if(q.worldX!==mx||q.worldZ!==mz||q.level!==ml){mx=q.worldX;mz=q.worldZ;ml=q.level;moved=s.tick();}
    else if(s.tick()-moved>=STALL_TICKS){stalled=true;legAc.abort('stall');}
   });
   try{
    if(o.travel)await o.travel(x,z,legAc.signal);
    else{
     const r=await goTo(s,await getWorld(),{x,z,level:0},accountOf(s),{maxRetriesPerLeg:2,legTimeoutTicks:400,signal:legAc.signal});
     if(!r.ok)error=Error(`route-failed ${x},${z}: ${r.detail??r.reason}`);
    }
   }catch(e){error=e;}
   finally{watch();ac.signal.removeEventListener('abort',abort);}
   check();
   // A synchronous route search can return after the ticks it blocked.
   stalled ||= !near(x,z)&&s.tick()-moved>=STALL_TICKS;
   if(stalled){
    if(attempt===0){console.log(`DRUID_MEATS_STALL ${from}->${x},${z} retry`);continue;}
    throw Error(`travel-stalled leg ${from}->${x},${z}: no movement for ${STALL_TICKS} ticks after one retry`);
   }
   if(error)throw error;
   if(!near(x,z))throw Error(`arrival-unobserved ${x},${z}`);
   return;
  }
 };
 const travel=async(x:number,z:number)=>{
  check();if(near(x,z))return;
  const p=state()!.player!,chain=waypointChain({x:p.worldX,z:p.worldZ},{x,z});
  if(!chain)throw Error(`route-failed ${x},${z}: no route to ${x},${z},0 within ${HOP}-tile hops`);
  for(const hop of chain)if(!near(hop.x,hop.z))await leg(hop.x,hop.z);
 };
 const bankCount=(id:number)=>count(s.bankObservation?.()?.items??[],id);
 const open=async()=>{
  check();
  if(state()?.bank?.isOpen&&s.bankObservation?.())return;
  const gen=s.bankObservation?.()?.generation??0;
  await s.bot.openBank();
  if(!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>gen||!!failure,{timeoutTicks:25}))throw Error('bank-observation-timeout');
  check();if(!state()?.bank?.isOpen||!s.bankObservation?.())throw Error('bank-observation-unavailable');
 };
 const bank=async()=>{
  const p=state()!.player!,b=nearestMeatBank(p.worldX,p.worldZ);await travel(b.x,b.z);await open();bankTrips++;
  for(const m of MEATS){check();const item=inv().find(i=>i.id===m.item);if(item)await depositObserved(s,item);}
 };
 try{
  // The world walker plans from the ground floor. Each upper floor is left by its observed climb-down exit.
  for(let floors=0;state()!.player!.level>0;floors++){
   check();const p=state()!.player!,level=p.level,here={x:p.worldX,z:p.worldZ,level};
   const fail=(why:string)=>{check();console.log(`DRUID_MEATS_FLOOR_EXIT failed ${why}`);return Error(`upper-floor-exit-failed ${here.x},${here.z},${here.level}`);};
   const cur=()=>{const q=state()!.player!;return {x:q.worldX,z:q.worldZ,level:q.level};};
   if(floors>=3)throw fail('floor bound 3');
   await waitUntil(s,()=>!!floorExit(cur(),state()!.nearbyLocs)||!!failure,{timeoutTicks:15});check();
   const exit=floorExit(cur(),state()!.nearbyLocs);
   if(!exit)throw fail('no climb-down loc observed');
   console.log(`DRUID_MEATS_FLOOR_EXIT ${exit.loc.x},${exit.loc.z},${level} stand=${exit.stand?`${exit.stand.x},${exit.stand.z}`:'interact'}`);
   if(exit.stand){
    const stand=exit.stand,at=()=>{const q=cur();return q.level===level&&cheb(q,stand)<=1;};
    for(let attempt=0;attempt<2&&!at();attempt++){
     const r=await s.bot.walkTo(stand.x,stand.z,1,{timeout:60000});check();
     if(at())break;
     // walkTo opens doors on its path. A door on the start tile edge gets one explicit open, then one more walk.
     const door=state()!.nearbyLocs.filter(l=>l.reachable!==false&&l.optionsWithIndex.some(o=>/^open$/i.test(o.text))&&cheb(cur(),l)<=1).sort((a,b)=>cheb(cur(),a)-cheb(cur(),b))[0];
     if(!door||attempt>0)throw fail(`stand ${stand.x},${stand.z} unreached: ${r.message}`);
     await s.bot.openDoor(door);check();
    }
    if(!at())throw fail(`stand ${stand.x},${stand.z} unreached`);
   }
   const loc=state()!.nearbyLocs.find(l=>l.id===exit.loc.id&&l.x===exit.loc.x&&l.z===exit.loc.z);
   if(!loc)throw fail(`exit ${exit.loc.id} unobserved at stand`);
   const r=await s.bot.interactLoc(loc,exit.opIndex);
   await waitUntil(s,()=>(state()?.player?.level??level)<level||!!failure,{timeoutTicks:30});check();
   if(state()!.player!.level>=level)throw fail(`level ${level} unchanged after ${exit.loc.id} op${exit.opIndex}: ${r.message}`);
  }
  // Opening a bank is needed to distinguish unknown stock from missing stock.
  if(!state()?.bank?.isOpen){const p=state()!.player!,b=nearestMeatBank(p.worldX,p.worldZ);await travel(b.x,b.z);}
  await open();
  const missing=missingMeats(inv(),s.bankObservation!()!.items);
  if(!missing.length)throw Error('all-meats-owned');
  if(missing.some(m=>m.item===2136)){
   const reason=bearRefusal(hp(),...(['Attack','Strength','Defence'] as const).map(k=>s.sdk.getSkill(k)?.level??0) as [number,number,number]);
   if(reason)throw Error(reason);
  }
  skipped.push(...MEATS.filter(m=>!missing.includes(m)).map(m=>m.item));
  admitted=true;check();
  // Preserve unrelated pack contents. Secure any already-held quest meat first.
  for(const m of MEATS){const item=inv().find(i=>i.id===m.item);if(item)await depositObserved(s,item);}
  await s.bot.closeBank();
  const p=state()!.player!,sources=nearestMeatBank(p.worldX,p.worldZ).x===3092?DRAYNOR_MEATS:MEATS;
  const pending:Meat[]=missing.map(m=>sources.find(source=>source.item===m.item)!);
  while(pending.length){
   // Take the nearest remaining meat from the bank the account stands at. Ties keep MEATS order.
   const here=state()!.player!,at={x:here.worldX,z:here.worldZ};
   const reach=(m:Meat)=>m.npc===105?Math.min(...BEAR_SPAWNS.map(([x,z])=>cheb(at,{x,z}))):cheb(at,m);
   pending.sort((a,b)=>reach(a)-reach(b));
   const m=pending.shift()!;
   check();if(inv().length>=28)throw Error('pack-full: need one meat slot');
   let anchor:{x:number;z:number}=m;
   const target=()=>state()?.nearbyNpcs.find(n=>n.id===m.npc&&((m.npc!==105&&m.npc!==41)||n.reachable===true)&&!n.inCombat&&(n.hp==null||n.maxHp==null||n.hp>=n.maxHp)&&Math.max(Math.abs((n.tileX??n.x)-anchor.x),Math.abs((n.tileZ??n.z)-anchor.z))<=12);
   if(m.npc===105){
    let found=false;
    const untried=[...BEAR_SPAWNS];
    while(untried.length){
     // After a miss, the next spawn is the nearest untried one from the current tile.
     const p=state()!.player!,from={x:p.worldX,z:p.worldZ};
     untried.sort((a,b)=>cheb(from,{x:a[0],z:a[1]})-cheb(from,{x:b[0],z:b[1]}));
     const [x,z]=untried.shift()!;
     check();anchor={x,z};
     try{await travel(x,z);}
     catch(error){
      check();
      if(!(error instanceof Error)||!error.message.startsWith('route-failed '))throw error;
      continue;
     }
     const seen=await waitUntil(s,()=>!!target()||!!failure,{timeoutTicks:12});
     check();if(seen&&target()){found=true;break;}
    }
    if(!found)throw Error('target-unobserved 105: open bear boxes exhausted');
   }else if(m.npc===41){
    const p=state()!.player!,approaches=spawnApproaches(m,p.worldX,p.worldZ);
    let arrived=false;
    for(const tile of approaches){
     check();
     try{
      await travel(tile.x,tile.z);
      const after=state()!.player!;
      if(boxDistance(after.worldX,after.worldZ,tile.box)>1)continue;
      anchor=tile;arrived=true;break;
     }
     catch(error){
      check();
      if(!(error instanceof Error)||!/^route-failed \d+,\d+: no route to \d+,\d+,0( within \d+-tile hops)?$/.test(error.message))throw error;
     }
    }
    if(!arrived)throw Error(`route-failed spawn ${m.npc}: no routable approach`);
   }else await travel(m.x,m.z);
   if(!await waitUntil(s,()=>!!target()||!!failure,{timeoutTicks:40}))throw Error(`target-unobserved ${m.npc}`);
   check();const npc=target();if(!npc)throw Error(`target-unavailable ${m.npc}`);
   const beforeXp=['Attack','Strength','Defence','Hitpoints'].reduce((n,k)=>n+(s.sdk.getSkillXp(k)??0),0);
   const ground=new Map<string,number>();
   for(const i of state()?.groundItems??[])if(i.id===m.item){const key=`${i.x},${i.z}`;ground.set(key,(ground.get(key)??0)+i.count);}
   let lastX=npc.tileX??npc.x,lastZ=npc.tileZ??npc.z;
   const drop=()=>state()?.groundItems.find(i=>i.id===m.item&&i.count>(ground.get(`${i.x},${i.z}`)??0)&&Math.max(Math.abs(i.x-lastX),Math.abs(i.z-lastZ))<=3);
   if(!(await s.bot.attack(npc)).success)throw Error(`attack-failed ${m.npc}`);
   const killed=()=>{
    const current=state()?.nearbyNpcs.find(n=>n.index===npc.index);
    if(current){lastX=current.tileX??current.x;lastZ=current.tileZ??current.z;}
    const xp=['Attack','Strength','Defence','Hitpoints'].reduce((n,k)=>n+(s.sdk.getSkillXp(k)??0),0);
    return !current&&xp>beforeXp&&!!drop();
   };
   if(!await waitUntil(s,()=>killed()||!!failure,{timeoutTicks:180}))throw Error(`kill-drop-timeout ${m.npc}`);
   check();if(!killed())throw Error(`kill-uncredited ${m.npc}`);
   kills++;
   const item=drop()!,before=count(inv(),m.item);
   await s.bot.pickupItem(item);
   if(!await waitUntil(s,()=>count(inv(),m.item)===before+1||!!failure,{timeoutTicks:15}))throw Error(`meat-pickup-unobserved ${m.item}`);
   check();if(count(inv(),m.item)!==before+1)throw Error(`meat-pickup-mismatch ${m.item}`);
   acquired.push(m.item);await bank();await s.bot.closeBank();
  }
  await open();check();
  if(MEATS.some(m=>bankCount(m.item)<1))throw Error('final-bank-meats-missing');
  const result={ok:true,kills,acquired,skipped,bankTrips,hpMin,died,ticks:s.tick()-start,bank:Object.fromEntries(MEATS.map(m=>[m.item,bankCount(m.item)]))};
  await s.bot.closeBank();return result;
 }finally{off();}
}
if(import.meta.main){
 const name=process.argv[2];if(!name){console.error('Usage: bun scripts/druid-meats.ts <account>');process.exit(1);}
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));
 try{
  const r=await runDruidMeats(s,{cap:Number(process.env.CAP??4000),stop:()=>existsSync(resolve(import.meta.dir,'../.practice',`stop-${name}`))});
  console.log(`DRUID_MEATS_RESULT ${JSON.stringify(r)}`);await finish([s],true,'mode=druid-meats banked=2132,2134,2136,2138');
 }catch(e){await finish([s],false,`mode=druid-meats ${String(e)}`);}
}
