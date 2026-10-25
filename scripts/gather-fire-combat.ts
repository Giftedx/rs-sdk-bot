// ONE Fire giant pilot. Actual owned inputs and actual Waterfall access; never an endless camp.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,expandPath} from '../packages/core/src/walk';
import {waterfallDialogue} from './generated/waterfall';
import {withdrawFireOwned} from './gather-fire-giants';
const BANK={x:2619,z:3332},BONES=532,FOOD=329;
export const fireMaxHit=Math.floor(((65+9)*(31+64)+320)/640); // exact110 config:11
export const fireFightSafe=(hp:number,food:number,ticks:number)=>hp>30&&food>=8&&ticks<250;
export const fireDeathCredit=(ownXp:number,witness:boolean,bones:number)=>ownXp>=11100&&witness&&bones===1;
export async function runFireCombat(s:Session,o:{cap:number;stop?:()=>boolean}){
 const start=s.tick(),st=()=>s.sdk.getState(),p=()=>st()?.player,inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,xp=()=>s.sdk.getSkillXp('Attack')??0,points=()=>st()?.prayers?.prayerPoints??0;
 const n=(a:readonly {id:number;count:number}[],id:number)=>a.filter(i=>i.id===id).reduce((v,i)=>v+i.count,0),held=(id:number)=>n(inv(),id),p0=p();
 let ended=false,died=false,hpMin=hp(),eaten=0,eating:Promise<void>|undefined,healFailure='',failure='',creditedKills=0,banked=false,weapon=0,baseline:Map<number,number>|undefined,phase='prepare',fightTicks=0,entryPrayer=0,initialPrayer=points(),recharged=false,death: {x:number;z:number;hp0:boolean;anim:boolean}|undefined,targetIndex:number|undefined;
 if(!p0||p0.level!==0)throw new Error('no Fire progress: stage at North bank');
 if(Math.max(Math.abs(p0.worldX-BANK.x),Math.abs(p0.worldZ-BANK.z))>4){
  await waitTicks(s, 2);
  if(Math.max(Math.abs((p()?.worldX??0)-2511),Math.abs((p()?.worldZ??0)-3463))<=5){
   await s.direct({type:'interactLoc',x:2512,z:3463,locId:2022,optionIndex:1,reason:'barrel return'} as any);
   await waitUntil(s,()=>Math.max(Math.abs((p()?.worldX??0)-2527),Math.abs((p()?.worldZ??0)-3413))<=6,{timeoutTicks:25});
  }
  await walkPath(await sessionWalker(s),[{...BANK,tol:1}],{maxTicks:250,stop:()=>ended||died});
  const q0=p();if(!q0||Math.max(Math.abs(q0.worldX-BANK.x),Math.abs(q0.worldZ-BANK.z))>4)throw new Error('no Fire progress: stage at North bank');
 }
 const loot:Record<number,number>={},trace:unknown[]=[],attack0=xp(),life=p0.lifeId,respawns=p0.respawnCount??0;void s.ended.then(()=>{ended=true;});
 const over=()=>ended||died||!!o.stop?.()||s.tick()-start>=o.cap;
 const capture=(event:string)=>{const q=p();trace.push({event,tick:s.tick()-start,phase,pos:q?[q.worldX,q.worldZ,q.level]:null,hp:hp(),food:held(FOOD),prayer:points(),spiders:st()?.nearbyNpcs.filter(n=>n.id===58&&n.distance<=15).map(n=>({index:n.index,x:n.tileX??n.x,z:n.tileZ??n.z,distance:n.distance,inCombat:n.inCombat})),target:targetIndex});if(trace.length>80)trace.splice(1,1);};
 const totals=()=>{const m=new Map<number,number>();for(const i of [...inv(),...eq(),...(s.bankObservation?.()?.items??[])])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const eat=async()=>{const item=inv().find(i=>i.id===FOOD),before=held(FOOD),h=hp();if(!item||before<=8)throw new Error('food retreat reserve reached');await s.bot.eatFood(item);await waitUntil(s,()=>held(FOOD)<before&&hp()>h||died||ended,{timeoutTicks:6});eaten+=Math.max(0,before-held(FOOD));if(held(FOOD)!==before-1||hp()<=h)throw new Error('actual Salmon debit/heal not observed');capture('eat');};
 const off=s.onTick(()=>{const q=p();if(hp()>0)hpMin=Math.min(hpMin,hp());if(hp()<=0||q?.isDead||q?.lifeId!==life||(q?.respawnCount??0)>respawns)died=true;
  if(targetIndex!==undefined){const n=st()?.nearbyNpcs.find(n=>n.id===110&&n.index===targetIndex);if(n&&(n.hp===0||n.animId===131))death={x:n.tileX??n.x,z:n.tileZ??n.z,hp0:n.hp===0,anim:n.animId===131};}
  if(hp()>0&&hp()<=40&&held(FOOD)>8&&!eating&&!over()){eating=eat().catch(e=>{healFailure=String(e);}).finally(()=>{eating=undefined;});}
  if(s.tick()%5===0&&phase==='dungeon')capture('entry-observation');
 });
 const guard=async()=>{if(eating)await eating;if(over()||hp()<=30||healFailure)throw new Error(`no Fire progress: ${healFailure||'HP/stop/cap/life guard'}`);};
 const walk=async(x:number,z:number,tol=1,cleanup=false)=>{if(!cleanup)await guard();const r=await walkPath(await sessionWalker(s),[{x,z,tol}],{look:4,maxTicks:180,stop:()=>ended||died||!!o.stop?.()||s.tick()-start>=o.cap||(!cleanup&&(hp()<=30||!!healFailure))});if(!r.ok)throw new Error(`no Fire progress: route ${r.detail}`);};
 const open=async()=>{await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??0;if(!st()?.bank.isOpen){if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!st()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>gen,{timeoutTicks:15}))throw new Error('fresh bank unavailable');}if(!s.bankObservation?.())throw new Error('bank unknown');};
 const deposit=async()=>{await open();for(const id of new Set(inv().map(i=>i.id))){const item=inv().find(i=>i.id===id);if(!item)continue;const before=n(s.bankObservation!()!.items,id),amount=held(id);if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(id)===0&&n(s.bankObservation!()!.items,id)===before+amount,{timeoutTicks:10}))throw new Error(`deposit mismatch ${id}`);}};
 const withdraw=async(id:number,amount:number)=>{await open();await withdrawFireOwned(s,id,amount);},close=async()=>{await s.bot.closeBank();await waitUntil(s,()=>!st()?.bank.isOpen,{timeoutTicks:5});};
 const prayer=async(active:boolean)=>{if(active&&points()<=0)return;if(st()?.prayers?.activePrayers[14]!==active)await s.direct({type:'togglePrayer',prayerIndex:14,reason:'one Fire pilot protection'});if(!await waitUntil(s,()=>st()?.prayers?.activePrayers[14]===active,{timeoutTicks:8}))throw new Error('Prayer effect unknown');};
 const loc=(id:number,x:number,z:number)=>st()?.nearbyLocs.find(l=>l.id===id&&l.x===x&&l.z===z);
 const op=async(id:number,x:number,z:number,re=/./)=>{const l=loc(id,x,z),option=l?.optionsWithIndex.find(o=>re.test(o.text));if(!l||!option)throw new Error(`observed loc/op absent ${id}`);return s.sdk.sendInteractLoc(x,z,id,option.opIndex);};
 const step=async(label:string,act:()=>Promise<unknown>,arrived:()=>boolean,ticks=20)=>{for(let i=0;i<2;i++){await guard();if(arrived())return;await act();if(await waitUntil(s,()=>arrived()||over(),{timeoutTicks:ticks})&&arrived())return;await waitTicks(s,1);}throw new Error(`no Fire progress: ${label} effect absent`);};
 const near=(x:number,z:number,r=2)=>!!p()&&Math.max(Math.abs(p()!.worldX-x),Math.abs(p()!.worldZ-z))<=r;
 const useRope=async(id:number,x:number,z:number)=>{const rope=inv().find(i=>i.id===954);if(!rope)throw new Error('owned rope absent');return s.sdk.sendUseItemOnLoc(rope.slot,x,z,id);};
 const returnBank=async()=>{
  phase='return';const q=p();if(q&&q.worldZ>9800&&q.worldZ<9950){
   const door=st()?.nearbyLocs.find(l=>[1516,1519].includes(l.id)&&l.z===9881);if(door){await walk(2564,9882,1,true);await op(door.id,door.x,door.z,/open/i);await waitTicks(s,1);}
   await walk(2564,9880,1,true);await walk(2584,9876,1,true);await walk(2575,9863,1,true);await op(2000,2575,9861);if(!await waitUntil(s,()=>near(2511,3463,3),{timeoutTicks:20}))throw new Error('falls exit not observed');
  }
  if(near(2511,3463,5)){await s.direct({type:'interactLoc',x:2512,z:3463,locId:2022,optionIndex:1,reason:'barrel return'} as any);if(!await waitUntil(s,()=>near(2527,3413,4),{timeoutTicks:25}))throw new Error('barrel return not observed');}
  if(p()&&p()!.worldZ<4000){await prayer(false);await walk(BANK.x,BANK.z,1,true);await deposit();banked=true;}else throw new Error('not on safe surface return');
 };
 try{
  await open();baseline=totals();
  const foodFrom = process.env.FOOD_FROM?.trim() || '';
  if ((baseline.get(FOOD) ?? 0) < 16 && foodFrom) {
      console.log(`MILESTONE waiting for food trade from ${foodFrom}`);
      await close();
      const re = new RegExp(`^${foodFrom.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
      const r = await s.bot.serveTrades({ from: re, maxTrades: 1, timeout: 180_000 });
      console.log(`TRADE ${r.reason} ${r.message}`);
      await open();
      for (const item of inv().filter(i => [330, 334, 380, 329, 333, 379].includes(i.id))) {
          await s.bot.depositItem(item, -1);
      }
      baseline = totals();
  }
  if((baseline.get(295)??0)<1||(baseline.get(954)??0)<1||(baseline.get(FOOD)??0)<16)throw new Error('OWN amulet/rope/16Salmon required');weapon=(baseline.get(1287)??0)>0?1287:(baseline.get(1277)??0)>0?1277:0;if(!weapon||(baseline.get(1171)??0)<1)throw new Error('owned sword/shield absent');
  await deposit();await close();for(const item of [...eq()])await s.bot.unequipItem(item);await deposit();for(const [id,amount] of [[295,1],[954,1],[FOOD,16],[weapon,1],[1171,1]])await withdraw(id,amount);await close();
  for(const id of [weapon,1171]){const item=inv().find(i=>i.id===id);if(!item)throw new Error('equip item absent');await s.bot.equipItem(item);if(!await waitUntil(s,()=>eq().some(i=>i.id===id),{timeoutTicks:8}))throw new Error('equipment effect absent');}
  if(st()?.autoRetaliateEnabled===true)await s.direct({type:'clickComponent',componentId:151,reason:'Fire pilot OFF'});if(!await waitUntil(s,()=>st()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw new Error('auto-retaliate OFF absent');
  await s.sdk.sendSetCombatStyle(0);if(!await waitUntil(s,()=>st()?.combatStyle?.known===true&&st()?.combatStyle?.currentStyle===0,{timeoutTicks:8}))throw new Error('accurate style unknown');
  await walk(2617,3309,1);initialPrayer=points();await op(409,2617,3309,/pray/i);if(!await waitUntil(s,()=>points()>=43,{timeoutTicks:10}))throw new Error('altar full43 not observed');recharged=initialPrayer<43&&points()>=43;capture('altar');
  await walk(2522,3494,2);await s.bot.talkTo(/^Almera$/i);const dialogue=await waterfallDialogue(s,{proof:/you are kind|small raft out back|too careful these days|tourist centre|need to use the raft|Thanks Almera|Good for all/i,choices:[/How can I help/i],maxTicks:60,stop:over});if(!dialogue.ok)throw new Error('Almera legitimate entry dialogue unproved');
  await walk(2511,3494,1);await step('raft',()=>op(1987,2509,3493),()=>near(2512,3481,4),25);await waitTicks(s,5);
  if(s.sdk.getDialog()?.isOpen){const hudon=await waterfallDialogue(s,{proof:/fine alone|leave me alone|do I know you/i,maxTicks:60,stop:over});if(!hudon.ok)throw new Error('forced Hudon page not settled');}
  await walk(2512,3477,0);await step('rope rock',()=>useRope(1996,2512,3468),()=>near(2513,3468,0),25);await waitTicks(s,1);await step('rope tree',()=>useRope(2020,2512,3465),()=>near(2511,3463,2),20);await step('ledge door',()=>op(2010,2511,3464),()=>near(2575,9861,2),20);
  phase='dungeon';capture('dungeon-entry');await walk(2584,9876,1);await waitTicks(s,2);await walk(2564,9880,0);const shut=st()?.nearbyLocs.find(l=>[1516,1519].includes(l.id)&&l.z===9881);if(shut)await step('double door',()=>op(shut.id,shut.x,shut.z,/open/i),()=>!st()?.nearbyLocs.some(l=>[1516,1519].includes(l.id)&&l.z===9881),12);await walk(2564,9883,0);
  for(let i=0;i<20&&hp()<60&&held(FOOD)>8&&!over();i++){await eat();await waitTicks(s,1);}
  if(hp()<60||held(FOOD)<9)throw new Error('refuse fight: HP<60 or food<9');entryPrayer=points();if(points()>0)await prayer(true);capture('fight-ready');
  const target=st()?.nearbyNpcs.find(n=>n.id===110&&!n.inCombat&&n.reachable!==false&&(n.hp===null||n.maxHp===null||n.hp>=n.maxHp)&&n.x>=2560&&n.x<=2582&&n.z>=9883&&n.z<=9899);if(!target)throw new Error('no fresh Fire giant in room');targetIndex=target.index;
  if(st()!.nearbyPlayers.some(v=>Math.max(Math.abs(v.x-target.x),Math.abs(v.z-target.z))<=12))throw new Error('another player near target');await walk((target.tileX??target.x)-1,target.tileZ??target.z,0);
  const fresh=st()?.nearbyNpcs.find(n=>n.index===targetIndex&&n.id===110),q=p();if(!fresh||!q||Math.max(Math.abs((fresh.tileX??fresh.x)-q.worldX),Math.abs((fresh.tileZ??fresh.z)-q.worldZ))>1)throw new Error('direct attack range unproved');
  const ground=()=>{const m=new Map<string,number>();for(const i of st()?.groundItems??[])m.set(`${i.id}:${i.x}:${i.z}`,(m.get(`${i.id}:${i.x}:${i.z}`)??0)+i.count);return m;},old=ground(),fightStart=s.tick(),ownXp=xp(),option=fresh.optionsWithIndex.find(o=>/^attack$/i.test(o.text));if(!option||!(await s.sdk.sendInteractNpc(fresh.index,option.opIndex)).success)throw new Error('attack dispatch failed');phase='fight';
  while(!over()){
   fightTicks=s.tick()-fightStart;await guard();if(!fireFightSafe(hp(),held(FOOD),fightTicks))throw new Error('fight time/food/HP retreat');const current=st()?.nearbyNpcs.find(n=>n.id===110&&n.index===targetIndex);
   if(st()!.nearbyPlayers.some(v=>Math.max(Math.abs(v.x-(current?.x??fresh.x)),Math.abs(v.z-(current?.z??fresh.z)))<=12))throw new Error('public hero ambiguity');
   if(!death&&current){for(const i of st()?.groundItems??[]){if(i.x===(current.tileX??current.x)&&i.z===(current.tileZ??current.z))old.set(`${i.id}:${i.x}:${i.z}`,i.count);}}
   if(death){const d=death,counts=ground(),newBone=(counts.get(`${BONES}:${d.x}:${d.z}`)??0)-(old.get(`${BONES}:${d.x}:${d.z}`)??0);if(fireDeathCredit(xp()-ownXp,true,newBone)){
     const drops=(st()?.groundItems??[]).filter(i=>i.x===d.x&&i.z===d.z&&i.count>(old.get(`${i.id}:${i.x}:${i.z}`)??0));if(new Set(drops.map(i=>i.id)).size>2)throw new Error('unattributed corpse extras');
     await walk(d.x,d.z,0);for(const item of drops){const amount=item.count-(old.get(`${item.id}:${item.x}:${item.z}`)??0);let got=0;while(got<amount){const before=held(item.id);await s.sdk.sendPickup(d.x,d.z,item.id);if(!await waitUntil(s,()=>held(item.id)>before,{timeoutTicks:6}))throw new Error('actual corpse pickup not observed');const delta=held(item.id)-before;if(delta>amount-got)throw new Error('corpse attribution excess');got+=delta;loot[item.id]=(loot[item.id]??0)+delta;}}
     creditedKills=1;capture('credited-corpse');break;
   }}
   if(current&&((current.tileX??current.x)<2560||(current.tileX??current.x)>2582||(current.tileZ??current.z)<9883||(current.tileZ??current.z)>9899))throw new Error('target left bounded room');
   await s.bot.dismissBlockingUI();await waitTicks(s,1);
  }
  if(creditedKills!==1)throw new Error('no complete hero corpse');
 }catch(e){failure=String(e);}
 finally{if(eating)await eating;if(!ended&&!died&&!o.stop?.())try{await returnBank();}catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}off();}
 const final=totals(),preserved=!!baseline&&[...new Set([...baseline.keys(),...final.keys()])].every(id=>(final.get(id)??0)===(baseline!.get(id)??0)+(loot[id]??0)-(id===FOOD?eaten:0));
 const outputsBanked=banked&&Object.entries(loot).every(([id,amount])=>held(Number(id))===0&&n(s.bankObservation?.()?.items??[],Number(id))>=(baseline?.get(Number(id))??0)+amount);
 const ok=creditedKills===1&&!failure&&banked&&outputsBanked&&preserved&&!died&&!ended;
 return{ok,creditedKills,loot,banked,outputsBanked,preserved,eaten,hpMin,finalHp:hp(),weapon,entryPrayer,initialPrayer,recharged,finalPrayer:points(),fightTicks,attackXp:xp()-attack0,death,ticks:s.tick()-start,died,failure:failure||'-',trace,qualification:'ONE finite pilot, observed food tank and Prayer; no Spider immunity or perpetual farming claim'};
}
if(import.meta.main){let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}});try{const r=await runFireCombat(s,{cap:Number(process.env.CAP??1600),stop:()=>stopped});console.log('FIRE_COMBAT_BANK '+JSON.stringify(r));await finish([s],r.ok,`Fire-pilot ${JSON.stringify(r)}`);}catch(e){await finish([s],false,String(e));}}
