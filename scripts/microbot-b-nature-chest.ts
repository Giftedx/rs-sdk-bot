// Finite, stationary nature chest job. Start beside the requested chest; no world hopping.
// Native contract: trapped_chest.dbrow nature chest; thieving.rs2 disarm_trapped_chest.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

export const NATURE_CHEST=2567,NATURE_RUNE=561,COINS=995;
export interface ChestOptions{x:number;z:number;level:number;maxLoots:number;cap:number;idleTicks:number}
export function chestOptions(env:Record<string,string|undefined>=process.env):ChestOptions{
 const read=(k:string,fallback:number|undefined,min:number,max:number)=>{const n=env[k]===undefined?fallback:Number(env[k]);if(n===undefined||!Number.isSafeInteger(n)||n<min||n>max)throw Error(`invalid ${k}`);return n;};
 return{x:read('CHEST_X',undefined,1,16383),z:read('CHEST_Z',undefined,1,16383),level:read('CHEST_LEVEL',undefined,0,3),maxLoots:read('MAX_LOOTS',10,1,10000),cap:read('CAP',1000,1,100000),idleTicks:read('IDLE_TICKS',100,1,1000)};
}
const total=(s:BotWorldState,id:number)=>s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const xp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Thieving')?.experience??0;
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
const kit=(s:BotWorldState)=>JSON.stringify([...s.inventory.filter(i=>i.id!==NATURE_RUNE&&i.id!==COINS).reduce((m,i)=>m.set(i.id,(m.get(i.id)??0)+i.count),new Map<number,number>())].sort((a,b)=>a[0]-b[0]));
export function chestEffect(before:BotWorldState,after:BotWorldState){
 const nature=total(after,NATURE_RUNE)-total(before,NATURE_RUNE),coins=total(after,COINS)-total(before,COINS);
 if(kit(before)!==kit(after)||hp(after)!==hp(before))throw Error('chest assets or health changed');
 if(nature===0&&coins===0&&xp(after)===xp(before))return false;
 if(nature!==1||coins!==3||xp(after)<=xp(before))throw Error('nature chest effect does not reconcile');
 return true;
}
export async function runNatureChest(d:{state:()=>BotWorldState|null;tick:()=>number;stopped:()=>boolean;act:(x:number,z:number,id:number,option:number)=>Promise<{success:boolean}>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>},o:ChestOptions){
 if(!Number.isSafeInteger(o.maxLoots)||o.maxLoots<1||!Number.isSafeInteger(o.cap)||o.cap<1||!Number.isSafeInteger(o.idleTicks)||o.idleTicks<1)throw Error('invalid chest bounds');
 const initial=d.state();if(!initial?.player||hp(initial)<1)throw Error('chest state unknown');
 if((initial.skills.find(k=>k.name==='Thieving')?.level??0)<28)throw Error('nature chest requires Thieving28');
 if(initial.inventory.length+Number(total(initial,NATURE_RUNE)===0)+Number(total(initial,COINS)===0)>28)throw Error('nature chest needs reward space');
 const start=d.tick();let progress=start,loots=0;
 const state=()=>{const s=d.state();if(!s?.player)throw Error('chest session ended');if(d.stopped())throw Error('chest stopped');if(d.tick()-start>=o.cap)throw Error('chest tick cap');if(s.player.level!==o.level||Math.max(Math.abs(s.player.worldX-o.x),Math.abs(s.player.worldZ-o.z))>2)throw Error('start beside chest on its floor');if(s.player.isDead||s.player.lifeId!==initial.player!.lifeId||hp(s)!==hp(initial))throw Error('chest health or life changed');return s;};
 while(loots<o.maxLoots){
  const s=state();if(d.tick()-progress>=o.idleTicks)throw Error('nature chest no progress');
  const chest=s.nearbyLocs.find(l=>l.id===NATURE_CHEST&&l.x===o.x&&l.z===o.z&&l.level===o.level&&l.reachable!==false);
  const option=chest?.optionsWithIndex.find(v=>/^Search for traps$/i.test(v.text));
  if(!chest||!option){await d.step();continue;}
  if(!(await d.act(chest.x,chest.z,chest.id,option.opIndex)).success)throw Error('nature chest action refused');
  const hit=await d.wait(()=>chestEffect(s,state()),Math.min(20,o.cap-(d.tick()-start)));
  if(!hit)throw Error('nature chest reward unobserved');
  loots++;progress=d.tick();
  if(loots<o.maxLoots)await d.step();
 }
 const final=state();if(total(final,NATURE_RUNE)-total(initial,NATURE_RUNE)!==loots||total(final,COINS)-total(initial,COINS)!==loots*3||kit(final)!==kit(initial))throw Error('nature chest total does not reconcile');
 return{loots,natureRunes:loots,coins:loots*3,ticks:d.tick()-start};
}
if(import.meta.main){
 const o=chestOptions(),name=process.argv[2];if(!name)throw Error('account required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));
 let ended=false;void s.ended.then(()=>{ended=true;});
 try{const r=await runNatureChest({state:()=>s.sdk.getState(),tick:()=>s.tick(),stopped:()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all'),act:(x,z,id,option)=>s.sdk.sendInteractLoc(x,z,id,option),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},o);await finish([s],true,JSON.stringify(r));}
 catch(e){await finish([s],false,String(e));}
}
