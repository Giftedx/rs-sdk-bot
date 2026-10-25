// Owned bucket preparation and Varrock east-bank -> west-bank city entry.
// Usage: bun scripts/measure/fleet-clay-entry.ts <account>; no purchases or trades.
import {openBot,finish} from '../../packages/core/src/bot';
import type {Session} from '../../packages/core/src/inprocess';
import {waitTicks} from '../../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../../packages/core/src/walk';

const EAST={x:3253,z:3420},WEST={x:3185,z:3436},BUCKET=1925;
export const clayEntryStart=(p:{worldX:number;worldZ:number;level:number}|null|undefined)=>!!p&&p.level===0&&Math.max(Math.abs(p.worldX-EAST.x),Math.abs(p.worldZ-EAST.z))<=4;
export const clayEntryRoute=()=>[EAST,{x:3245,z:3429},{x:3210,z:3428},WEST].map(p=>({...p,tol:1}));
export function clayEntryAssets(s:Session) {
 const out=new Map<number,number>();
 for(const i of [...s.sdk.getInventory(),...s.sdk.getEquipment(),...(s.sdk.getState()?.bank?.items??[])])out.set(i.id,(out.get(i.id)??0)+i.count);
 return out;
}
export function clayEntryPreserved(before:ReadonlyMap<number,number>,after:ReadonlyMap<number,number>) {
 return [...before].every(([id,n])=>(after.get(id)??0)===n)&&[...after].every(([id,n])=>(before.get(id)??0)===n);
}
export async function prepareClayEntry(s:Session) {
 if(!clayEntryStart(s.sdk.getState()?.player))throw new Error('no clay entry progress: requires Varrock east bank ground-floor start');
 if(!(await s.bot.openBank()).success)throw new Error('no clay entry progress: initial bank failed');
 try {
  await waitTicks(s,2);
  if(!s.sdk.getState()?.bank?.items)throw new Error('no clay entry progress: bank stock unknown');
  const initial=clayEntryAssets(s),held=()=>s.sdk.getInventory().filter(i=>i.id===BUCKET).reduce((n,i)=>n+i.count,0);
  if(!held()) {
   if(s.sdk.getInventory().length>=28)throw new Error('no clay entry progress: no slot for own bucket');
   const bucket=s.sdk.getState()?.bank?.items.find(i=>i.id===BUCKET&&i.count>=1);
   if(!bucket)throw new Error('no clay entry progress: owned empty bucket missing');
   await s.bot.withdrawItem(bucket,1,{asNote:false});await waitTicks(s,2);
   if(held()!==1)throw new Error('no clay entry progress: actual bucket withdrawal incomplete');
  }
  if(!clayEntryPreserved(initial,clayEntryAssets(s)))throw new Error('no clay entry progress: bucket preparation changed total assets');
  return initial;
 } finally {await s.bot.closeBank();}
}
async function main() {
 const name=process.argv[2];if(!name||/^(main|haggis)$/i.test(name))throw new Error('explicit non-reserved clay entry account required');
 const s=await openBot(name);
 const start=s.tick(),first=s.sdk.getState()!.player!,hp0=s.sdk.getSkill('Hitpoints')!.level;
 let hpMin=hp0,died=false,ended=false;
 void s.ended.then(()=>{ended=true;});
 const off=s.onTick(()=>{const p=s.sdk.getState()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(p?.isDead||(p?.respawnCount??0)>(first.respawnCount??0)||(p&&first.lifeId!==undefined&&p.lifeId!==first.lifeId))died=true;});
 try {
  const initial=await prepareClayEntry(s);
  const route=await walkPath(await sessionWalker(s),clayEntryRoute(),{maxTicks:200,stop:()=>died||ended||hpMin<7});
  if(!route.ok)throw new Error(`no clay entry progress: route ${route.detail}`);
  if(!(await s.bot.openBank()).success)throw new Error('no clay entry progress: destination bank failed');await waitTicks(s,2);
  const p=s.sdk.getState()!.player!,atBank=p.level===0&&Math.max(Math.abs(p.worldX-WEST.x),Math.abs(p.worldZ-WEST.z))<=4;
  const preserved=clayEntryPreserved(initial,clayEntryAssets(s)),bucketHeld=s.sdk.getInventory().filter(i=>i.id===BUCKET).reduce((n,i)=>n+i.count,0);
  const ok=atBank&&preserved&&bucketHeld>=1&&!died&&!ended&&hpMin===hp0;
  console.log('CLAY_ENTRY '+JSON.stringify({ok,ticks:s.tick()-start,hpMin,hpStart:hp0,died,preserved,atBank,bucketHeld,pos:[p.worldX,p.worldZ,p.level],inventory:s.sdk.getInventory(),equipment:s.sdk.getEquipment(),bank:s.sdk.getState()?.bank?.items}));
  await s.bot.closeBank();off();await finish([s],ok,`${ok?'ready':'no clay entry progress: final gate failed'} ticks=${s.tick()-start} preserved=${preserved} hpMin=${hpMin} died=${died} bucketHeld=${bucketHeld}`);
 } catch(e) {off();await finish([s],false,String(e));}
}
if(import.meta.main)main();
