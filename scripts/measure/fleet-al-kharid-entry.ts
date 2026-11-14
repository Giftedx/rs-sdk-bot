// Actual supplier entry: secure cash, pay the source-defined toll, stay south of the mine.
import {openBot,finish} from '../../packages/core/src/bot';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../../packages/core/src/walk';
const s=await openBot(process.argv[2]!);
const totals=(items:{id:number;count:number}[])=>{const m=new Map<number,number>();for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
try{
 await waitUntil(s,()=> (s.sdk.getSkill('Hitpoints')?.level??0)>0,{timeoutTicks:15});
 const t0=s.tick(),first=s.sdk.getState()!.player!;let hpMin=s.sdk.getSkill('Hitpoints')!.level,died=false;
 const off=s.onTick(()=>{const p=s.sdk.getState()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);if(p?.isDead||(p?.respawnCount??0)>(first.respawnCount??0)||(first.lifeId!==undefined&&(p?.lifeId ?? first.lifeId) !== first.lifeId))died=true;});
 try{
  if(first.level!==0||Math.max(Math.abs(first.worldX-3092),Math.abs(first.worldZ-3243))>4)throw new Error('requires Draynor bank');
  if(!(await s.bot.openBank()).success)throw new Error('initial bank failed');await waitTicks(s,2);
  const initial=totals([...s.sdk.getInventory(),...(s.sdk.getState()?.bank?.items??[])]);
  const cash=s.sdk.getInventory().find(i=>i.id===995);if(cash)await s.bot.depositItem(cash,-1);await waitTicks(s,2);
  const secured=s.sdk.getState()?.bank?.items.find(i=>i.id===995)?.count??0;
  if(s.sdk.getInventory().some(i=>i.id===995)||secured!==(initial.get(995)??0))throw new Error('cash not secured');
  await s.bot.withdrawItem(/^coins$/i,10);await waitTicks(s,2);
  if(s.sdk.getInventory().find(i=>i.id===995)?.count!==10)throw new Error('fee withdrawal failed');
  console.log(`TOLL_CASH secured=${secured} travelCoins=10`);await s.bot.closeBank();
  const walk=async(points:number[][])=>{const r=await walkPath(await sessionWalker(s),points.map(([x,z])=>({x:x!,z:z!,tol:1})),{maxTicks:550,stop:()=>died||hpMin<7});if(!r.ok)throw new Error(`entry walk ${r.detail}`);};
  await walk([[3092,3250],[3089,3266],[3100,3270],[3140,3270],[3180,3258],[3218,3256],[3242,3248],[3256,3228],[3266,3227]]);
  const guard=s.sdk.getNearbyNpcs().filter(n=>n.id===925).sort((a,b)=>a.distance-b.distance)[0];
  if(!guard)throw new Error('west border guard unavailable');await s.sdk.sendInteractNpc(guard.index,1);
  let answered=false;
  for(let n=0;n<35;n++){
   const p=s.sdk.getState()!.player!;if(p.worldX>=3268)break;
   const d=s.sdk.getDialog();
   if(d?.isOpen){
    console.log('TOLL_DIALOG '+JSON.stringify(d.options));
    if(d.options.some(o=>/yes, ok/i.test(o.text))){if(answered)throw new Error('duplicate toll choice');await s.sdk.clickDialogByText(/yes, ok/i);answered=true;}
    else if(d.options.length===1)await s.sdk.sendClickDialog(d.options[0]!.index);
    else throw new Error('unexpected toll options');
   }
   await waitTicks(s,2);
  }
  const crossing=s.sdk.getState()!.player!;
  if(!answered||crossing.worldX<3268||s.sdk.getInventory().some(i=>i.id===995))throw new Error('crossing or exact10GP payment missing');
  console.log(`TOLL_PAID x=${crossing.worldX} z=${crossing.worldZ} fee=10`);
  await walk([[3272,3227],[3275,3212],[3273,3194],[3269,3167]]);
  if(!(await s.bot.openBank()).success)throw new Error('destination bank failed');await waitTicks(s,2);
  const bank=(s.sdk.getState()?.bank?.items??[]).map(i=>({id:i.id,count:i.count})),inventory=s.sdk.getInventory().map(i=>({id:i.id,count:i.count}));
  const final=totals([...bank,...inventory]);initial.set(995,(initial.get(995)??0)-10);
  const preserved=[...initial].every(([id,n])=>(final.get(id)??0)===n)&&[...final].every(([id,n])=>(initial.get(id)??0)===n);
  const p=s.sdk.getState()!.player!,atBank=p.level===0&&Math.max(Math.abs(p.worldX-3269),Math.abs(p.worldZ-3167))<=4;
  const proof={ticks:s.tick()-t0,hpMin,died,preserved,atBank,fee:10,secured,bank,inventory,pos:[p.worldX,p.worldZ,p.level]};console.log('TOLL_ENTRY '+JSON.stringify(proof));await s.bot.closeBank();
  await finish([s],preserved&&atBank&&!died&&hpMin>=7,`tollEntry ticks=${s.tick()-t0} hpMin=${hpMin} preserved=${preserved} died=${died} fee=10`);
 }finally{off();}
}catch(e){await finish([s],false,String(e));}
