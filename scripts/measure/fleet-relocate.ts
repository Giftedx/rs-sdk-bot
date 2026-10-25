// Staged supplier relocation: protect all cash at Draynor before the measured free route.
import {openBot,finish} from '../../packages/core/src/bot';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../../packages/core/src/walk';
const s=await openBot(process.argv[2]!);
const total=(items:{id:number;count:number}[])=>{const m=new Map<number,number>();for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
try{
 await waitUntil(s,()=> (s.sdk.getSkill('Hitpoints')?.level??0)>0,{timeoutTicks:15});
 const t0=s.tick(),first=s.sdk.getState()!.player!;let hpMin=s.sdk.getSkill('Hitpoints')!.level,died=false;
 const off=s.onTick(()=>{const p=s.sdk.getState()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(p?.isDead||(p?.respawnCount??0)>(first.respawnCount??0)||(first.lifeId!==undefined&&p?.lifeId!==first.lifeId))died=true;});
 try{
  if(first.level!==0 || Math.max(Math.abs(first.worldX-3092),Math.abs(first.worldZ-3243))>4)throw new Error('requires Draynor bank ground-floor start');
  if(!(await s.bot.openBank()).success)throw new Error('initial bank failed');await waitTicks(s,2);
  const initial=total([...s.sdk.getInventory(),...(s.sdk.getState()?.bank?.items??[])]);
  const cash=s.sdk.getInventory().find(i=>i.id===995);if(cash)await s.bot.depositItem(cash,-1);await waitTicks(s,2);
  const secured=s.sdk.getState()?.bank?.items.find(i=>i.id===995)?.count??0;
  if(s.sdk.getInventory().some(i=>i.id===995)||secured!==(initial.get(995)??0))throw new Error('cash not fully secured before route');
  console.log(`RELOCATE_CASH bankCoins=${secured} heldCoins=0`);await s.bot.closeBank();
  const waypoints=[[3092,3250],[3089,3266],[3100,3270],[3140,3270],[3180,3258],[3218,3256],[3242,3248],[3255,3295],[3255,3330],[3285,3348],[3253,3420]].map(([x,z])=>({x:x!,z:z!,tol:2}));
  const r=await walkPath(await sessionWalker(s),waypoints,{maxTicks:700,stop:()=>died||hpMin<7});
  if(!r.ok)throw new Error(`relocation ${r.detail}`);
  if(!(await s.bot.openBank()).success)throw new Error('destination bank failed');await waitTicks(s,2);
  const bank=(s.sdk.getState()?.bank?.items??[]).map(i=>({id:i.id,count:i.count})),inventory=s.sdk.getInventory().map(i=>({id:i.id,count:i.count}));
  const final=total([...bank,...inventory]),preserved=[...initial].every(([id,n])=>final.get(id)===n)&&[...final].every(([id,n])=>initial.get(id)===n);
  const p=s.sdk.getState()!.player!,atBank=p.level===0&&Math.max(Math.abs(p.worldX-3253),Math.abs(p.worldZ-3420))<=4;
  const proof={ticks:s.tick()-t0,hpMin,died,preserved,atBank,secured,heldCoins:inventory.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0),bank,inventory,pos:[p.worldX,p.worldZ,p.level]};
  console.log('RELOCATION '+JSON.stringify(proof));await s.bot.closeBank();
  await finish([s],preserved&&atBank&&!died&&hpMin>=7,`relocation ticks=${s.tick()-t0} hpMin=${hpMin} preserved=${preserved} died=${died} bankCash=${secured}`);
 }finally{off();}
}catch(e){await finish([s],false,String(e));}
