// bun scripts/rune-supply.ts <account> [target=20]. One session; finite, observed stages.
// Reuse decision 2026-10-28: local train-chickens, quest-runemysteries,
// gather-essence and rcair -> this worker. Adapt their session ownership and
// finite limits. Acceptance belongs to fresh-rune-supply-proof, never a preset.
import {existsSync} from 'node:fs';
import {openBot,finish,getWorld,accountOf,sessionDied} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {walkPath,sessionWalker,goTo,type PathPoint} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {questFlags} from '../packages/core/src/quest-status';
import {trainChickens,chickenTrainingProfile} from './train-chickens';
import {cookStarterChickens,cookStarterChicken,starterCookingStock,StarterCookingUnresolved} from './fishcook';
import {runRuneMysteries} from './generated/quest-runemysteries';
import {runEssenceGatherer} from './gather-essence';
import {craftAirRunes,enterAirAltar,exitAirAltar,insideAirAltar} from './generated/rcair';
import {startQuestSustain} from './quest-sustain';
import {LUMBRIDGE_TO_DRAYNOR} from './courier-route';

export function runeSupplyTarget(value=20){
 if(!Number.isSafeInteger(value)||value<2||value>99)throw Error('Runecraft target must be2..99');
 return value;
}
const FOOD=[315,2309,2140];
const DRAYNOR={x:3092,z:3243,tol:2},BANK={x:3253,z:3420,tol:2};
const WEST:PathPoint[]=[{x:3092,z:3250,tol:1},{x:3089,z:3266,tol:1},{x:3070,z:3290,tol:1},{x:3020,z:3300,tol:1},{x:2986,z:3294,tol:1}];
const training=chickenTrainingProfile('draynor').route.map(p=>p.x===3088&&p.z===3320?{x:3089,z:3320,tol:1}:p);
const east=chickenTrainingProfile('varrock').route;
const VARROCK_TO_DRAYNOR=[...east,...training.slice(0,-1).reverse()];
const DRAYNOR_TO_VARROCK=[...training,...east.slice(0,-1).reverse()];
export function runeSupplyAssets(items:readonly {id:number;count:number}[]){
 const totals:Record<number,number>={};for(const i of items)totals[i.id]=(totals[i.id]??0)+i.count;return totals;
}
export function runeSupplyPreserved(before:Record<number,number>,after:Record<number,number>){
 // Food and quest objects have real consumption/conversion paths. Essence is craft input.
 const converted=new Set([...FOOD,2138,2144,290,291,1436]);
 return Object.entries(before).every(([id,n])=>converted.has(Number(id))||(after[Number(id)]??0)>=n);
}

export async function leaveRuneStarter(s:Session,stop:()=>boolean){
 const pos=()=>s.sdk.getState()?.player;
 if(!await waitUntil(s,()=>stop()||!!pos(),{timeoutTicks:30}))throw Error('starter position unobserved');
 if(stop())throw Error('stopped during starter exit');
 const p=pos()!;
 if(p.worldX>=3080&&p.worldX<=3105&&p.worldZ>=3080&&p.worldZ<=3125){
  // Pinned rs-sdk b565f2d: actions.ts skipTutorial handles late design, but
  // chooses options[0] on unknown choices and has an unbounded isWaiting loop.
  // Adapt only its observed-modal handling here. Keep exact guide choices and
  // tick cancellation. Client.ts exposes narration as BUTTON_CONTINUE (6).
  const start=s.tick(),deadline=start+100;
  let ended=false,designSent=false,talks=0,last='';
  void s.ended?.then(()=>{ended=true;});
  const observation=()=>{
   const state=s.sdk.getState(),p=pos();
   return {position:p?{worldX:p.worldX,worldZ:p.worldZ,level:p.level}:null,
    modalOpen:state?.modalOpen,modalInterface:state?.modalInterface,dialog:s.sdk.getDialog(),
    inventory:s.sdk.getInventory(),quest:questFlags(s.client)?.find(q=>q.name==='Rune Mysteries Quest')?.state??'unknown',
    messages:state?.gameMessages?.slice(-3)};
  };
  const record=()=>{const value=JSON.stringify(observation());if(value!==last){last=value;console.log('RUNE_SUPPLY_STARTER '+JSON.stringify({tick:s.tick(),...observation()}));}return value;};
  const check=()=>{if(stop())throw Error('stopped during starter exit');if(ended)throw Error('starter session ended');
   if(s.tick()>deadline)throw Error('starter entry deadline: action exceeded tick budget; '+last);};
  // tutorial_complete clears the pack, grants this exact kit and sends the
  // mainland quest list. %tutorial is server-only, so native saved-state proof
  // additionally requires its actual1000 flag. Neither SDK success nor Z alone
  // establishes this exit. Banked25 coins are checked by the native accountant.
  const grant=[[1351,1],[590,1],[303,1],[315,1],[1925,1],[1931,1],[2309,1],[1265,1],
   [1205,1],[1277,1],[1171,1],[841,1],[882,25],[556,25],[558,15],[555,6],[557,4],[559,2]] as const;
  const arrived=()=>{const p=pos();return !!p&&p.level===0&&p.worldX>=3200&&p.worldX<=3235&&p.worldZ>=3200&&p.worldZ<=3250;};
  const ready=()=>arrived()&&grant.every(([id,n])=>s.sdk.getInventory().filter(i=>i.id===id).reduce((a,i)=>a+i.count,0)===n)
   &&questFlags(s.client)?.some(q=>q.name==='Rune Mysteries Quest'&&q.state!=='unknown');
  while(true){
   const page=record();check();
   if(ready())break;
   if(s.tick()>=deadline)throw Error('starter entry deadline: mainland, tutorial grant or dialogue unobserved; '+last);
   const state=s.sdk.getState(),dialog=s.sdk.getDialog();
   let action:Awaited<ReturnType<typeof s.sdk.sendClickDialog>>|undefined;
   if(state?.modalOpen){
    if(state.modalInterface!==3559)throw Error('unsupported tutorial modal; '+last);
    if(!designSent){designSent=true;action=await s.sdk.sendAcceptCharacterDesign();}
   }else if(!arrived()&&dialog?.isOpen){
    if(!dialog.isWaiting){
     const yes=dialog.options.find(o=>/^yes please[.]?$/i.test(o.text));
     if(yes&&dialog.options.every(o=>/^(yes please|no, thank you)[.]?$/i.test(o.text)))action=await s.sdk.clickDialogByText(/^yes please[.]?$/i);
     else if(dialog.options.length===0||dialog.options.length===1&&dialog.options[0]!.buttonType===6)
      action=await s.sdk.sendClickDialog(0);
     else throw Error('unsupported tutorial choice; '+last);
    }
   }else if(!arrived()&&(designSent||s.tick()-start>=15)&&talks<3){
    const guide=state?.nearbyNpcs.find(n=>/^runescape guide$/i.test(n.name));
    const op=guide?.optionsWithIndex.find(o=>/^talk-to$/i.test(o.text));
    if(guide&&op){talks++;action=await s.sdk.sendInteractNpc(guide.index,op.opIndex);}
   }
   check();
   if(action&&!action.success){record();throw Error('starter action refused: '+JSON.stringify(action)+'; '+last);}
   await waitUntil(s,()=>stop()||ended||s.tick()>=deadline||JSON.stringify(observation())!==page,{timeoutTicks:Math.min(8,deadline-s.tick())});
  }
 }
 const current=pos()!;
 if(current.level!==0&&current.worldX>=3200&&current.worldX<=3225&&current.worldZ>=3200&&current.worldZ<=3235){
  const r=await goTo(s,await getWorld(),{x:3226,z:3250,level:0},accountOf(s),{legTimeoutTicks:100});
  if(!r.ok)throw Error('starter floor exit: '+JSON.stringify(r));
 }
 if(stop())throw Error('stopped during starter exit');
}

export async function runRuneSupply(s:Session,target=20,options:{cap?:number;stop?:()=>boolean}={}){
 runeSupplyTarget(target);
 const cap=options.cap??30000;if(!Number.isSafeInteger(cap)||cap<1)throw Error('invalid rune supply tick cap');
 const start=s.tick(),state=()=>s.sdk.getState(),pos=()=>state()?.player,initialLife=pos();
 let ended=false,stage='entry';void s.ended.then(()=>{ended=true;});
 let stoppedFor:string|undefined;
 const stopReason=()=>stoppedFor ??= sessionDied(initialLife,pos())?'died':ended?'session-ended':options.stop?.()?'operator':existsSync(`.practice/stop-${s.name}`)?'stop-file':s.tick()-start>=cap?'tick-cap':undefined;
 const stop=()=>stopReason()!==undefined;
 const inv=()=>s.sdk.getInventory(),count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const bankCount=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const xp=(name:string)=>s.sdk.getSkillXp(name)??0;
 const level=()=>s.sdk.getSkill('Runecraft')?.baseLevel??0;
 const quest=()=>questFlags(s.client)?.find(f=>f.name==='Rune Mysteries Quest')?.state??'unknown';
 const stages:Record<string,unknown>={},xp0={mining:xp('Mining'),runecraft:xp('Runecraft')};
 let before:Record<number,number>|undefined,mined=0,consumed=0,crafted=0,banked=0,inheritedBanked=0,newBanked=0,travelFoodEaten=0;
 // Only runes already carried on entry are inherited delivery. Starter grant
 // banking keeps its existing meaning. Production is still craft-observed.
 let inheritedRemaining=count(556),unbankedCrafted=0;
 const snapshot=()=>({position:pos(),skills:state()?.skills,inventory:inv(),equipment:s.sdk.getEquipment(),bank:s.bankObservation?.()?.items,quest:quest()});
 // Each pending action has one start, bounded tick observations and an end/error.
 // Wall time locates a child deadline. Game ticks still own action budgets.
 const action=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>{
  const began=s.tick();
  const record=(phase:string)=>console.log('RUNE_SUPPLY_ACTION '+JSON.stringify({at:Date.now(),tick:s.tick(),stage,action:name,phase,elapsedTicks:s.tick()-began,
   position:pos()?{x:pos()!.worldX,z:pos()!.worldZ,level:pos()!.level}:null,hp:s.sdk.getSkill('Hitpoints')?.level,
   lifeId:pos()?.lifeId,respawnCount:pos()?.respawnCount,quest:quest(),essence:count(1436),air:count(556),
   bankEssence:bankCount(1436),bankAir:bankCount(556),generation:s.bankObservation?.()?.generation,runecraftXp:xp('Runecraft'),miningXp:xp('Mining')}));
  record('start');let last=began;
  const off=s.onTick(()=>{if(s.tick()-last>=25){last=s.tick();record('pending');}});
  try{const result=await work();record('end');return result;}catch(error){record('error');throw error;}finally{off();}
 };
 const check=()=>{if(stop())throw Error(`rune supply stopped at ${stage}; preserve observed state and resume after the stop cause changes`);if((s.sdk.getSkill('Hitpoints')?.level??0)<1)throw Error('rune supply life unavailable');};
 const walk=async(points:PathPoint[])=>{check();const sustain=startQuestSustain({sdk:s.sdk,tick:()=>s.tick(),onTick:cb=>s.onTick(cb),ended:s.ended,direct:async action=>{const reply=await s.direct(action) as {success:boolean;message?:string};return reply;}},{food:FOOD,eatAt:8,onConsumed:()=>{travelFoodEaten++;}});let r;try{r=await action('walk:'+points.map(p=>p.x+','+p.z).join('>'),async()=>walkPath(await sessionWalker(s),points,{maxTicks:Math.min(1000,cap-(s.tick()-start)),stop:()=>stop()||!!sustain.failure()||(s.sdk.getSkill('Hitpoints')?.level??0)<5}));}finally{await sustain.settle();}if(!r.ok||sustain.failure())throw Error(`route refusal ${stage}: ${r.detail}`);check();};
 const open=async()=>{check();const generation=s.bankObservation?.()?.generation??0;
  if(!(await action('open-bank',()=>s.bot.openBank())).success||!await action('bank-observation',()=>waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:15})))throw Error(`bank observation unavailable at ${stage}`);
 };
 const withdraw=async(id:number,n:number)=>{const need=n-count(id);if(need<=0)return;
  const item=state()?.bank.items.find(i=>i.id===id),stored=bankCount(id),held=count(id),generation=s.bankObservation?.()?.generation??0;
  if(!item||stored<need)throw Error(`next acquisition: owned item${id} needs${need}, bank has${stored}`);
  await action('withdraw:'+id+':'+need,()=>s.bot.withdrawItem(item,need));
  if(!await action('withdraw-observation:'+id,()=>waitUntil(s,()=>count(id)===held+need&&bankCount(id)===stored-need&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:10})))throw Error(`withdraw debit/credit unobserved item${id}`);
 };
 const deposit=async(item:ReturnType<typeof inv>[number])=>{
  const n=await action('deposit:'+item.id,()=>depositObserved(s,item));
  if(item.id===556){
   const inherited=Math.min(inheritedRemaining,n),produced=Math.min(unbankedCrafted,n-inherited);
   inheritedRemaining-=inherited;unbankedCrafted-=produced;inheritedBanked+=inherited;newBanked+=produced;banked+=inherited+produced;
  }
  return n;
 };
 const secure=async(keep:readonly number[]=[])=>{for(const item of [...inv()])if(!keep.includes(item.id)&&count(item.id))await deposit(item);};
 const total=()=>runeSupplyAssets([...inv(),...s.sdk.getEquipment(),...(s.bankObservation?.()?.items??[])]);
 const draynor=async()=>{const p=pos();if(!p||p.level!==0)throw Error('next acquisition: observed surface route to Draynor required');
  if(p.worldZ>=3330)await walk(VARROCK_TO_DRAYNOR);
  else if(p.worldX>=3110)await walk(LUMBRIDGE_TO_DRAYNOR.map(([x,z,tol])=>({x,z,tol})));
  else await walk([DRAYNOR]);
 };
 try{
  await leaveRuneStarter(s,stop);check();
  if(!await waitUntil(s,()=>quest()!=='unknown'&&level()>0&&Array.isArray(state()?.inventory),{timeoutTicks:30}))throw Error('entry inventory, skills or Rune Mysteries journal unobserved');
  console.log('RUNE_SUPPLY_ENTRY '+JSON.stringify(snapshot()));
  if(quest()!=='complete'){
   if((pos()?.combatLevel??0)<13||(quest()==='not started'&&FOOD.reduce((n,id)=>n+count(id),0)<3)){
    stage='starter-training';await draynor();await open();before=total();
    // Store starter stock intact so raw food has room. Withdraw only the owned kit.
    // trainChickens already treats carried and worn kit as owned. Keep that
    // rule here without letting equipment satisfy consumable pack quantities.
    await secure([1277,1171]);
    for(const id of [1277,1171])if(![...inv(),...s.sdk.getEquipment()].some(i=>i.id===id&&i.count>0))await withdraw(id,1);
    if(bankCount(2138)>0)await withdraw(2138,Math.min(10,bankCount(2138)));
    for(const id of FOOD)if(bankCount(id)>0)await withdraw(id,Math.min(4,bankCount(id)));
    await action('close-bank',()=>s.bot.closeBank());
    const r=(pos()?.combatLevel??0)>=13&&(count(2138)>=10||FOOD.reduce((n,id)=>n+count(id),0)>=3)?{ok:true,resumed:true}:await trainChickens(s,Math.min(6000,cap-(s.tick()-start)),'draynor',13,{rawChicken:10,stop});stages.training=r;
    if(!r.ok)throw Error('starter training failed '+JSON.stringify(r));
    await open();await withdraw(2138,Math.min(10,count(2138)+bankCount(2138)));await action('close-bank',()=>s.bot.closeBank());
    stage='bootstrap-food';
    if(count(2138)>0){
     const initial=starterCookingStock(s);let cooked=false,cookingFailure:unknown;
     try{stages.food=await cookStarterChickens(s,stop,{requiredFood:Math.max(0,3-count(315)-count(2309))});cooked=true;}
     catch(error){cookingFailure=error;throw error;}
     finally{if(!cooked){const after=starterCookingStock(s);stages.food={ok:false,raw:initial.raw,consumed:initial.raw-after.raw,
      cooked:after.cooked-initial.cooked,burnt:after.burnt-initial.burnt,xp:after.xp-initial.xp,remainingRaw:after.raw,
      ...(cookingFailure instanceof StarterCookingUnresolved?{settlement:'unresolved'}:{}),
      acquisition:{itemId:2138,minimum:Math.max(0,3-FOOD.reduce((n,id)=>n+count(id),0))}};}}
    }
    if(FOOD.reduce((n,id)=>n+count(id),0)<3)throw Error('next acquisition: at least3 cooked starter foods for Rune Mysteries route');
   }
   stage='quest';const child=await runRuneMysteries(s,{cap:Math.min(6000,cap-(s.tick()-start)),stop,food:FOOD,eatAt:8});stages.quest=child;
   if(!child.ok||quest()!=='complete')throw Error('quest stage incomplete '+JSON.stringify(child));
  }
  if(quest()==='complete'&&(pos()?.worldZ??0)>9500&&(pos()?.worldX??0)>=3090&&(pos()?.worldX??0)<=3120){
   stage='quest-exit-resume';const child=await runRuneMysteries(s,{cap:1000,stop,food:FOOD,eatAt:8});stages.questExit=child;
   if(!child.ok)throw Error('completed quest exit failed '+JSON.stringify(child));
  }
  // Resume an interrupted altar or mine batch from its observed position.
  if(insideAirAltar(pos())){
   stage='altar-resume';if(count(1436)>0){const r=await action('craft-air',()=>craftAirRunes(s,stop));stages.resumedCraft=r;consumed+=r.consumed;crafted+=r.runes;unbankedCrafted+=r.runes;}
   await action('exit-air',()=>exitAirAltar(s,stop));await walk([...WEST].reverse());await walk(DRAYNOR_TO_VARROCK);
  }else if((pos()?.worldZ??0)<4000){
   if(pos()?.level!==0)throw Error('next acquisition: leave current floor for Varrock East bank');
   if((pos()?.worldZ??0)<3330){await draynor();await walk(DRAYNOR_TO_VARROCK);}else await walk([BANK]);
  }
  stage='bank-entry';
  if((pos()?.worldZ??0)>4000){const r=await action('gather-resume',()=>runEssenceGatherer(s,{cap:1000,bankAt:28,maxTrips:1,stop}));stages.mineResume=r;mined+=r.totalMined;if(!r.ok)throw Error(r.failure);}
  await open();before??=total();const startBankAir=bankCount(556);await secure();await action('close-bank',()=>s.bot.closeBank());
  let batches=0;
  while(level()<target){
   check();stage='mine';await open();const storedEssence=bankCount(1436);await action('close-bank',()=>s.bot.closeBank());
   if(storedEssence===0){
    const r=await action('gather-one-trip',()=>runEssenceGatherer(s,{cap:Math.min(1800,cap-(s.tick()-start)),bankAt:28,maxTrips:1,stop}));stages.mine=r;mined+=r.totalMined;
    if(!r.ok||r.totalMined<=0||r.totalBanked<=0)throw Error('next acquisition: Aubury essence batch failed '+JSON.stringify(r));
   }
   stage='load';await open();await secure();await withdraw(1438,1);
   // A bronze pickaxe remains owned. It does not consume crafting slots when worn.
   const food=FOOD.find(id=>bankCount(id)>0);if(food!==undefined)await withdraw(food,Math.min(2,bankCount(food)));
   const available=Math.min(bankCount(1436),28-inv().length);if(available<1)throw Error('next acquisition: free pack slots and mined rune essence1436');
   await withdraw(1436,available);await action('close-bank',()=>s.bot.closeBank());
   stage='altar-outbound';await walk(VARROCK_TO_DRAYNOR);await walk(WEST);await action('enter-air',()=>enterAirAltar(s));
   stage='craft';const r=await action('craft-air',()=>craftAirRunes(s,stop));stages.craft=r;consumed+=r.consumed;crafted+=r.runes;unbankedCrafted+=r.runes;
   stage='bank-output';await action('exit-air',()=>exitAirAltar(s,stop));await walk([...WEST].reverse());await walk(DRAYNOR_TO_VARROCK);await open();
   const air=inv().find(i=>i.id===556);if(!air)throw Error('crafted air runes missing before deposit');await action('deposit-air',()=>deposit(air));
   await secure();batches++;stages.batches=batches;
   console.log('RUNE_SUPPLY_PROGRESS '+JSON.stringify({at:new Date().toISOString(),target,level:level(),mined,consumed,crafted,banked,assets:total()}));
   await action('close-bank',()=>s.bot.closeBank());
  }
  stage='final';await open();await secure();const after=total(),preserved=runeSupplyPreserved(before,after);
  const productive=consumed>0&&crafted>=consumed&&newBanked===crafted&&bankCount(556)>startBankAir;
  const ok=level()>=target&&quest()==='complete'&&preserved&&!stop()&&(productive||xp('Runecraft')===xp0.runecraft);
  const final=snapshot();await action('close-bank',()=>s.bot.closeBank());
  return {ok,target,stage,stages,mined,consumed,crafted,banked,inheritedBanked,newBanked,preserved,before,after,travelFoodEaten,xp:{mining:xp('Mining')-xp0.mining,runecraft:xp('Runecraft')-xp0.runecraft},ticks:s.tick()-start,final};
 }catch(error){return {ok:false,target,stage,stages,mined,consumed,crafted,banked,inheritedBanked,newBanked,before,travelFoodEaten,stopReason:stopReason(),failure:String(error),ticks:s.tick()-start,final:snapshot()};}
}
if(import.meta.main){
 const target=runeSupplyTarget(Number(process.argv[3]??20));
 if(!process.argv[2])throw Error('account argument required');
 let stopped=false;const s=await openBot(process.argv[2],{onStop:async()=>{stopped=true;}});
 try{
  if(process.env.RUNE_AIR_EXIT_DIAGNOSTIC){
   if(stopped||existsSync(`.practice/stop-${s.name}`))throw Error('air diagnostic stopped');
   const mode=process.env.RUNE_AIR_EXIT_DIAGNOSTIC;
   if(!insideAirAltar(s.sdk.getState()?.player))throw Error('air diagnostic requires observed altar entry');
   if(mode==='refused'){
    const portal=s.sdk.findNearbyLoc(/^portal$/i,{withOption:/^use$/i});if(!portal)throw Error('air diagnostic portal absent');
    const reply=await s.bot.interactLoc(portal,/^unsupported-air-recovery-option$/);
    const ok=!stopped&&!existsSync(`.practice/stop-${s.name}`)&&!reply.success&&reply.reason==='no_matching_option'&&insideAirAltar(s.sdk.getState()?.player);
    console.log('AIR_EXIT_REJECTION '+JSON.stringify({ok,reply,position:s.sdk.getState()?.player}));await finish([s],ok,'air rejected-option diagnostic');
   }else if(mode==='exit'){
    await exitAirAltar(s,()=>stopped||existsSync(`.practice/stop-${s.name}`));await finish([s],true,'air exit observation diagnostic');
   }else throw Error('unknown air exit diagnostic');
  }else if(process.env.RUNE_COOK_DIAGNOSTIC==='1'){
   // Harness-only retained-state diagnostic. No tutorial, kit staging, training, quest or full-delivery metadata.
   const r=await cookStarterChicken(s,()=>stopped||existsSync(`.practice/stop-${s.name}`));
   console.log('RUNE_COOK_DIAGNOSTIC_RESULT '+JSON.stringify(r));await finish([s],true,JSON.stringify(r));
  }else{const r=await runRuneSupply(s,target,{cap:Number(process.env.CAP??30000),stop:()=>stopped});console.log('RUNE_SUPPLY_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}
 }
 catch(error){await finish([s],false,String(error));}
}
