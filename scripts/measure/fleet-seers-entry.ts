// Western Ardougne-Seers route. RETURN_ARDY=1 adds the tested northern bear detour.
// CARRY_COINS=60 withdraws owned boat fares at the destination; default carries no cash.
import {openBot,finish} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../../packages/core/src/walk';
export function seersEntryConfig(env:Record<string,string|undefined>) {
 if(env.RETURN_ARDY!==undefined&&!['0','1'].includes(env.RETURN_ARDY))throw new Error('RETURN_ARDY must be0or1');
 const carry=Number(env.CARRY_COINS??0);
 if(![0,60].includes(carry))throw new Error('CARRY_COINS must be0or60');
 return {reverse:env.RETURN_ARDY==='1',carry};
}
export function seersEntryRoute(reverse=false) {
 const points=[[2654,3283],[2809,3441],[2800,3457],[2763,3472],[2727,3492]];
 // Direct Catherby->Ardy crossed the bear spawns at2713,3334 (native10->8HP).
 // The existing cow route's north-west/north-east legs avoid those spawns.
 if(reverse){points.splice(1,0,[2648,3358],[2677,3358]);points.reverse();}
 return points.map(([x,z])=>({x:x!,z:z!,tol:2}));
}
const total=(items:{id:number;count:number}[])=>{const m=new Map<number,number>();for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
export function seersAssetsPreserved(initial:ReadonlyMap<number,number>,final:ReadonlyMap<number,number>) {
 return [...initial].every(([id,n])=>(final.get(id)??0)===n)&&[...final].every(([id,n])=>(initial.get(id)??0)===n);
}
// Caller has the destination bank open and no held coins after initial preparation.
export async function seersCarryFares(s:Session,count:number) {
 if(![0,60].includes(count))throw new Error('CARRY_COINS must be0or60');
 if(!count)return;
 const held=()=>s.sdk.getInventory().filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
 if(held()!==0)throw new Error('no relocation progress: unexpected held coins before fare withdrawal');
 const cash=s.sdk.getState()?.bank?.items.find(i=>i.id===995);
 if(!cash||cash.count<count)throw new Error('no relocation progress: owned fare shortfall');
 await s.bot.withdrawItem(cash,count,{asNote:false});await waitTicks(s,2);
 if(held()!==count) {
  const item=s.sdk.getInventory().find(i=>i.id===995);
  if(item)await s.bot.depositItem(item,-1);
  await waitTicks(s,2);
  if(held()!==0)throw new Error('no relocation progress: partial fare cleanup failed');
  throw new Error('no relocation progress: exact fare withdrawal incomplete; actual coins returned to bank');
 }
}
async function main() {
const config=seersEntryConfig(process.env),name=process.argv[2];
if(!name||/^(main|haggis)$/i.test(name))throw new Error('explicit non-reserved route account required');
const s=await openBot(name);
try{
 await waitUntil(s,()=> (s.sdk.getSkill('Hitpoints')?.level??0)>0,{timeoutTicks:15});
 const t0=s.tick(),first=s.sdk.getState()!.player!;let hpMin=s.sdk.getSkill('Hitpoints')!.level,died=false;
 const off=s.onTick(()=>{const p=s.sdk.getState()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(p?.isDead||(p?.respawnCount??0)>(first.respawnCount??0)||(first.lifeId!==undefined&&(p?.lifeId ?? first.lifeId) !== first.lifeId))died=true;});
 try{
  const waypoints=seersEntryRoute(config.reverse),start=waypoints[0]!,destination=waypoints[waypoints.length-1]!;
  if(first.level!==0 || Math.max(Math.abs(first.worldX-start.x),Math.abs(first.worldZ-start.z))>4)throw new Error(`requires ${config.reverse?'Seers':'Ardougne'} bank ground-floor start`);
  if(!(await s.bot.openBank()).success)throw new Error('initial bank failed');await waitTicks(s,2);
  const assets=()=>total([...s.sdk.getInventory(),...s.sdk.getEquipment(),...(s.sdk.getState()?.bank?.items??[])]);
  const initial=assets();
  if((initial.get(995)??0)<config.carry)throw new Error('no relocation progress: owned60GP fares required before route');
  const cash=s.sdk.getInventory().find(i=>i.id===995);if(cash)await s.bot.depositItem(cash,-1);await waitTicks(s,2);
  const secured=s.sdk.getState()?.bank?.items.find(i=>i.id===995)?.count??0;
  if(s.sdk.getInventory().some(i=>i.id===995)||secured!==(initial.get(995)??0))throw new Error('cash not fully secured before route');
  console.log(`RELOCATE_CASH bankCoins=${secured} heldCoins=0`);await s.bot.closeBank();
  const r=await walkPath(await sessionWalker(s),waypoints,{maxTicks:700,stop:()=>died||hpMin<7});
  if(!r.ok)throw new Error(`no relocation progress: ${r.detail}`);
  if(!(await s.bot.openBank()).success)throw new Error('destination bank failed');await waitTicks(s,2);
  await seersCarryFares(s,config.carry);
  const bank=(s.sdk.getState()?.bank?.items??[]).map(i=>({id:i.id,count:i.count})),inventory=s.sdk.getInventory().map(i=>({id:i.id,count:i.count}));
  const preserved=seersAssetsPreserved(initial,assets());
  const p=s.sdk.getState()!.player!,atBank=p.level===0&&Math.max(Math.abs(p.worldX-destination.x),Math.abs(p.worldZ-destination.z))<=4;
  const heldCoins=inventory.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0),bankCoins=bank.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
  const proof={direction:config.reverse?'return-ardy':'forward-seers',ticks:s.tick()-t0,hpMin,died,preserved,atBank,secured,heldCoins,bankCoins,carryCoins:config.carry,bank,inventory,pos:[p.worldX,p.worldZ,p.level]};
  console.log('RELOCATION '+JSON.stringify(proof));await s.bot.closeBank();
  await finish([s],preserved&&atBank&&!died&&hpMin>=7&&heldCoins===config.carry,`relocation ticks=${s.tick()-t0} hpMin=${hpMin} preserved=${preserved} died=${died} bankCash=${bankCoins} heldCoins=${heldCoins}`);
 }finally{off();}
}catch(e){await finish([s],false,String(e));}
}
if(import.meta.main)main();
