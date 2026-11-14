// Zero-resource practice bootstrap. Tutorial gifts are discarded before earning.
// Reuse: gather-ore Bob purchase, collect-wool north corridor, trainChickens.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {executionContext} from '../vendor/rs-sdk/sdk/execution-context';
import {trainChickens} from './train-chickens';

type Role='producer'|'courier'|'receiver';
type Phase='all'|'clean'|'earn';
type Checkpoint=(stage:'empty'|'trained'|'earned',evidence:unknown)=>void|Promise<void>;
const HOME={x:3092,z:3243};
const NORTH=[[3218,3256],[3180,3258],[3140,3270],[3100,3270],[3089,3266],[3092,3250],[3092,3243]].map(([x,z])=>({x:x!,z:z!,tol:0}));
const MEN=[{x:3222,z:3218,tol:2}];
function requireThat(v:unknown,m:string):asserts v{if(!v)throw Error('supply bootstrap: '+m);}

export async function bootstrapSupplyActor(s:Session,role:Role,checkpoint?:Checkpoint,phase:Phase='all'){
 requireThat(['producer','courier','receiver'].includes(role)&&['all','clean','earn'].includes(phase),'unknown role/phase');
 const env=readFileSync(resolve(import.meta.dir,'../vendor/rs-sdk/bots',s.name,'bot.env'),'utf8');
 requireThat(/^SERVER=localhost:8888\r?$/m.test(env),'isolated localhost practice actor required');
 const parent=executionContext.getStore(),ac=new AbortController(),start=s.tick();let ended=false;
 const signal=parent?.signal?AbortSignal.any([parent.signal,ac.signal]):ac.signal;
 const timer=setTimeout(()=>ac.abort(Error('bootstrap30minute wall deadline')),30*60*1000);timer.unref?.();
 void s.ended.then(()=>{ended=true;ac.abort(Error('bootstrap session ended'));});
 const initialLife=s.sdk.getState()?.player,off=s.onTick(()=>{
  const p=s.sdk.getState()?.player;
  if(s.tick()-start>=20000)ac.abort(Error('bootstrap20000tick deadline'));
  if(p?.isDead||(p?.respawnCount??0)>(initialLife?.respawnCount??0)||(initialLife?.lifeId !== undefined&&(p?.lifeId ?? initialLife.lifeId) !== initialLife.lifeId))ac.abort(Error('bootstrap actor died/respawned'));
 });
 const state=()=>s.sdk.getState(),pack=()=>s.sdk.getInventory(),worn=()=>s.sdk.getEquipment(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0,fullHp=()=>s.sdk.getSkill('Hitpoints')?.baseLevel??0;
 const count=(id:number)=>pack().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const check=()=>{signal.throwIfAborted();requireThat(!ended&&hp()>0,'session/death boundary');};
 const snapshot=()=>({account:s.name,role,phase,tick:s.tick(),pos:state()?.player,inventory:pack().map(i=>({id:i.id,count:i.count,slot:i.slot})),equipment:worn().map(i=>({id:i.id,count:i.count,slot:i.slot})),skills:state()?.skills});
 const mark=async(stage:'empty'|'trained'|'earned',evidence:unknown)=>{check();console.log('BOOTSTRAP_CHECKPOINT '+JSON.stringify({stage,...snapshot(),evidence}));await checkpoint?.(stage,evidence);check();};
 const walk=async(points:{x:number;z:number;tol:number}[])=>{check();const r=await walkPath(await sessionWalker(s),points,{maxTicks:700,stop:()=>signal.aborted||ended||hp()<3});requireThat(r.ok,'safe route '+r.detail);check();};
 const toBank=async()=>{const p=state()?.player;requireThat(p?.level===0,'ground-floor route required');if(p.worldX>3150)await walk(NORTH);else await walk(NORTH.slice(-2));};
 const toMen=async()=>{await walk([...NORTH.slice(0,-1)].reverse());await walk(MEN);};
 const openBank=async()=>{check();requireThat((await s.bot.openBank()).success,'bank open failed');requireThat(await waitUntil(s,()=>!!s.bankObservation?.(),{timeoutTicks:12}),'complete bank packet absent');check();return s.bankObservation!()!;};
 const freshSkills=()=>{const skills=state()?.skills;return skills?.length===21&&skills.every(k=>k.baseLevel===(k.name==='Hitpoints'?10:1));};
 const dropAll=async(label:string)=>{
  const before=pack().map(i=>({id:i.id,count:i.count,slot:i.slot})),debits=[];
  for(let i=0;pack().length&&i<28;i++){
   check();const item=pack()[0]!;const prior=count(item.id);await s.sdk.sendDropItem(item.slot);
   requireThat(await waitUntil(s,()=>count(item.id)<prior,{timeoutTicks:8}),'ordinary drop not observed');
   debits.push({id:item.id,slot:item.slot,before:prior,after:count(item.id)});
  }
  requireThat(pack().length===0,'gift inventory not empty');console.log('BOOTSTRAP_DISCARD '+JSON.stringify({account:s.name,label,before,debits,after:pack(),tick:s.tick()}));
 };
 const regen=async()=>{
  check();let progress=s.tick(),last=hp(),waited=0;
  while(hp()<fullHp()&&waited<2200){
   check();await waitTicks(s,1);waited++;
   if(hp()>last){last=hp();progress=s.tick();}
   requireThat(s.tick()-progress<=150,'natural HP regeneration stalled');
  }
  requireThat(hp()===fullHp(),'bounded natural regeneration incomplete');
  if(waited)console.log('BOOTSTRAP_REGEN '+JSON.stringify({account:s.name,ticks:waited,hp:hp(),tick:s.tick()}));
 };
 const earn=async(target:number,cap:number)=>{
  const t=s.tick(),before=count(995),xp=s.sdk.getSkillXp('Thieving')??0;let attempts=0,lastProgress=s.tick(),lastCoins=before;
  while(count(995)<target&&s.tick()-t<cap){
   check();if(hp()<=Math.max(4,Math.ceil(fullHp()*.35)))await regen();
   const man=state()?.nearbyNpcs.filter(n=>/^man$/i.test(n.name)&&n.x>=3210&&n.x<=3234&&n.z>=3205&&n.z<=3235).sort((a,b)=>a.distance-b.distance)[0];
   requireThat(man,'ordinary Lumbridge man unavailable');
   const held=count(995),h=hp();await s.bot.pickpocketNpc(man);attempts++;await waitTicks(s,2);check();
   const gain=count(995)-held;
   // A delayed queued op may settle beside this op. Reconcile all awards with
   // XP below, rather than assuming the SDK reply owns exactly one award.
   requireThat(gain>=0&&gain%3===0,`man coin gain differs from pinned3GP: ${gain}`);
   if(count(995)>lastCoins){lastCoins=count(995);lastProgress=s.tick();}
   if(hp()<h){await waitTicks(s,8);check();}
   requireThat(s.tick()-lastProgress<=1800,'no earned coins for1800ticks');
  }
  requireThat(count(995)>=target,'bounded ordinary earning target incomplete');
  const p=state()?.player;requireThat(p,'earning position absent');
  await s.sdk.sendWalk(p.worldX,p.worldZ);await waitTicks(s,4);check();
  const result={before,after:count(995),earned:count(995)-before,attempts,thievingXp:(s.sdk.getSkillXp('Thieving')??0)-xp,ticks:s.tick()-t,hp:hp()};
  requireThat(result.earned*200===result.thievingXp*3,'earned cash/XP reconciliation failed');
  console.log('BOOTSTRAP_EARN '+JSON.stringify({account:s.name,...result}));return result;
 };
 try{return await executionContext.run({...parent,signal},async()=>{
  await waitTicks(s,3);check();const client=s.client;
  requireThat(client&&typeof client==='object','native client required');
  requireThat(await waitUntil(s,()=>equipmentObserved(client),{timeoutTicks:20}),'known equipment packet required');
  if(phase!=='earn'){
   const p=state()?.player;requireThat(p&&p.worldX<3160&&p.worldZ<3130&&freshSkills(),'fresh registered tutorial actor with untrained skills required');
   let mainland=false;
   for(let i=0;i<3&&!mainland;i++){
    check();const r=await s.bot.skipTutorial();requireThat(r.success,'ordinary tutorial NPC skip failed');
    mainland=await waitUntil(s,()=>{const p=state()?.player;return !!p&&p.level===0&&p.worldX>=3180&&p.worldZ>=3180;},{timeoutTicks:30});
   }
   requireThat(mainland&&freshSkills(),'tutorial did not yield fresh mainland actor');
   for(const item of [...worn()]){requireThat((await s.bot.unequipItem(item)).success,'gift equipment removal failed');requireThat(await waitUntil(s,()=>!worn().some(i=>i.slot===item.slot),{timeoutTicks:8}),'gift equipment removal unobserved');}
   await dropAll('all tutorial inventory gifts');await toBank();
   const before=await openBank();requireThat(before.items.length===1&&before.items[0]!.id===995&&before.items[0]!.count===25,'tutorial bank must contain exactly25giftcoins');
   // Container observations have counts and names, but no SDK BankItem slot.
   await s.bot.withdrawItem(/^coins$/i,25);
   requireThat(await waitUntil(s,()=>{const after=s.bankObservation?.();return count(995)===25&&!!after&&after.generation>before.generation&&after.items.length===0;},{timeoutTicks:12}),'gift25coin withdrawal not paired');
   console.log('BOOTSTRAP_GIFT_BANK '+JSON.stringify({account:s.name,before,after:s.bankObservation?.(),held:count(995)}));await s.bot.closeBank();await dropAll('all25tutorial bank coins');
  }else await toBank();
  const empty=await openBank();requireThat(empty.items.length===0&&pack().length===0&&worn().length===0&&freshSkills()&&hp()===10,'empty untrained Draynor checkpoint failed');await s.bot.closeBank();
  await mark('empty',{bank:empty,starterGiftsUsed:false});if(phase==='clean')return{ok:true,role,phase,ticks:s.tick()-start};
  await toMen();const firstEarn=await earn(3,500);await walk([{x:3231,z:3203,tol:2}]);
  const beforeCoins=count(995);requireThat((await s.bot.openShop(/^bob$/i)).success,'Bob shop unavailable');await s.bot.buyFromShop(/^bronze pickaxe$/i,1);await s.bot.closeShop();
  requireThat(await waitUntil(s,()=>count(1265)===1&&count(995)===beforeCoins-1,{timeoutTicks:12}),'owned1GP bronze pick purchase not observed');console.log('BOOTSTRAP_PURCHASE '+JSON.stringify({account:s.name,itemId:1265,amount:1,coinsBefore:beforeCoins,coinsAfter:count(995),cost:1}));
  await toBank();await regen();const training=await trainChickens(s,9000,'draynor',29);requireThat(training.ok&&training.combat>=29,'natural chicken qualification failed');await mark('trained',{training,firstEarn,pickCost:1});
  // Producer: net/rod plus80 base-price feathers and a reserve. Courier:
  // three60GP crossings plus one60GP reserve. Receiver: fares plus bakery food.
  await toMen();const earned=await earn(role==='producer'?200:role==='courier'?240:120,12000);await toBank();
  requireThat(earned.earned*200===earned.thievingXp*3,'earned cash/XP reconciliation failed');
  const bank=await openBank(),pick=pack().find(i=>i.id===1265);requireThat(pick,'owned trained pick not returned');await depositObserved(s,pick);const afterBank=s.bankObservation!()!;requireThat(afterBank.items.filter(i=>i.id===1265).reduce((n,i)=>n+i.count,0)===1,'owned pick bank credit missing');await s.bot.closeBank();
  requireThat(pack().every(i=>i.id===995)&&worn().length===0&&hp()>=8&&(state()?.player?.combatLevel??0)>=29,'final cash/kit/HP checkpoint failed');
  requireThat((count(995)+1)*200===(s.sdk.getSkillXp('Thieving')??0)*3,'final cash plus1GP pick cost must equal all earned man XP');
  const result={ok:true,role,phase,training,firstEarn,earned,heldCoins:count(995),bankBefore:bank,bankAfter:afterBank,ticks:s.tick()-start,hp:hp()};await mark('earned',result);return result;
 });}finally{off();clearTimeout(timer);}
}

if(import.meta.main){
 const role=process.env.ROLE as Role,phase=process.env.PHASE as Phase;
 requireThat(['producer','courier','receiver'].includes(role)&&['clean','earn'].includes(phase),'CLI requires ROLE=producer|courier|receiver PHASE=clean|earn');
 const s=await openBot(process.argv[2]!);try{const r=await bootstrapSupplyActor(s,role,undefined,phase);console.log('SUPPLY_BOOTSTRAP '+JSON.stringify(r));await finish([s],true,'ordinary zero-resource supply bootstrap '+role+' '+phase);}catch(e){await finish([s],false,String(e));}
}
