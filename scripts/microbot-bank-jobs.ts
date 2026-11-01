import{readFileSync,existsSync}from'node:fs';
import{openBot,finish,getWorld,accountOf}from'../packages/core/src/bot';
import type{Session}from'../packages/core/src/inprocess';
import{goTo,walkPath,sessionWalker}from'../packages/core/src/walk';
import{waitUntil,waitTicks}from'../packages/core/src/ticks';
import{depositObserved}from'../packages/core/src/deposit';
import{componentId}from'../packages/core/src/logout';
import{jewelleryRecipes,runJewellery}from'./microbot-b-jewellery';
import{cookingRecipes,runCookingBatch,nativeHeatSources,type Heat}from'./microbot-b-cooking';
import{tanningRecipes,tanInventory,type TanKind}from'./microbot-c-tanner';
import{furnaceGlassRecipe,runFurnaceGlass}from'./microbot-glass';
import{itemMagicRecipe,itemSpellCosts,runItemMagic}from'./microbot-magic-items';
import{inventoryRecipes,runInventoryBank}from'./microbot-production';
import{runMixedWine}from'./microbot-wine';
import{runBonesBank}from'./microbot-bones';
import{miningProfiles,runAtSiteMining,incidentalMiningGems}from'./microbot-b-mining';
import{FISH_PROFILES,runStagedFishing,type FishMethod}from'./microbot-b-fishing';
import{stallRecipes,stealStall}from'./microbot-c-stalls';

type Tile={x:number;z:number;level:number};
// Harvest targets are minimum useful output; manufacturing batches remain exact.
export type BankJob={family:'jewellery'|'cooking'|'tanning'|'glass'|'magic'|'inventory'|'wine'|'bones'|'mining'|'fishing'|'stalls';recipe:string;target:number;batch:number;cap:number;returnTicks:number;members:boolean;reserve?:number;bank?:Tile;site?:Tile;heat?:Heat;alchemyTarget?:string;tool?:number};
type Profile={inputs:Record<number,number>;tools:number[];outputs:number[];capacityOutputs?:Record<number,number>;bank:Tile;site:Tile;run:(n:number,cap:number,stop:()=>boolean)=>Promise<void|number>};
const AK={x:3269,z:3167,level:0},FURNACE={x:3275,z:3186,level:0};
const nativeItems=new Set(readFileSync('vendor/rs-sdk/server/content/pack/obj.pack','utf8').split(/\r?\n/).flatMap(row=>{const m=row.match(/^(\d+)=/);return m?[Number(m[1])]:[];}));
export function validateBankJob(j:BankJob){
 if(!['jewellery','cooking','tanning','glass','magic','inventory','wine','bones','mining','fishing','stalls'].includes(j.family)||!j.recipe||typeof j.members!=='boolean'||![j.target,j.batch,j.cap,j.returnTicks].every(v=>Number.isSafeInteger(v)&&v>0)||j.cap<=j.returnTicks||!Number.isSafeInteger(j.reserve??0)||(j.reserve??0)<0)throw Error('invalid finite bank job');
 if(j.target>2147483647||j.batch>2147483647||j.cap>100000)throw Error('bank job exceeds native count or tick limits');
 for(const p of [j.bank,j.site])if(p&&(![p.x,p.z,p.level].every(Number.isSafeInteger)||p.level<0||p.level>3||p.x<0||p.x>16383||p.z<0||p.z>16383))throw Error('invalid bank/site tile');
 if(j.family==='jewellery'&&!jewelleryRecipes().some(r=>r.name===j.recipe))throw Error('unknown jewellery recipe');
 if(j.family==='cooking'&&!cookingRecipes().recipes.some(r=>r.name===j.recipe))throw Error('unknown cooking recipe');
 if(j.family==='tanning'&&!Object.hasOwn(tanningRecipes,j.recipe))throw Error('unknown tanning recipe');
 if(j.family==='inventory'&&!inventoryRecipes().some(r=>r.name===j.recipe))throw Error('unknown inventory recipe');
 if(j.family==='magic')itemMagicRecipe(j.recipe,j.alchemyTarget);
 if(j.family==='mining'&&!miningProfiles().some(p=>p.name===j.recipe&&!p.essence))throw Error('unknown depleting mining profile; continuous essence uses gather-essence.ts');
 if(j.family==='fishing'&&!Object.hasOwn(FISH_PROFILES,j.recipe))throw Error('unknown fishing profile; shark uses gather-fish.ts');
 if(j.family==='stalls'&&!stallRecipes().some(r=>r.name===j.recipe))throw Error('unknown stall recipe');
 if(j.tool!==undefined&&(!Number.isSafeInteger(j.tool)||!nativeItems.has(j.tool)))throw Error('invalid native tool');
 if(['mining','stalls'].includes(j.family)&&(!j.bank||!j.site))throw Error('mining/stall job needs exact bank and site tiles');
}
export function fittingBankBatch(inputs:Record<number,number>,tools:number[],maximum:number,freeSlots:number,stackable:(id:number)=>boolean,outputs:Record<number,number>={}){
 const slots=(items:Record<number,number>,n:number)=>{const ids=new Set([...Object.keys(items).map(Number),...tools]);let count=0;for(const id of ids){const units=(items[id]??0)*n+(tools.includes(id)?1:0);count+=stackable(id)?1:units;}return count;};
 let lower=0,upper=maximum;while(lower<upper){const n=Math.ceil((lower+upper)/2);if(Math.max(slots(inputs,n),slots(outputs,n))<=freeSlots)lower=n;else upper=n-1;}return lower;
}
async function profile(s:Session,j:BankJob):Promise<Profile>{
 const state=()=>s.sdk.getState(),base={bank:j.bank??AK,site:j.site??AK};
 const pairs=(r:{inputs:{id:number;units:number}[]})=>Object.fromEntries(r.inputs.map(i=>[i.id,i.units]));
 const checked=(r:{ok:boolean;detail?:string;failure?:string})=>{if(!r.ok)throw Error(r.detail??r.failure??'staged worker failed');};
 if(j.family==='jewellery'){
  const r=jewelleryRecipes().find(r=>r.name===j.recipe);if(!r)throw Error('unknown jewellery recipe');
  return{...base,site:j.site??FURNACE,inputs:pairs(r),tools:r.tools,outputs:[r.product],run:async(n,cap,stop)=>{
   const start=s.tick();await runJewellery({state,tick:()=>s.tick(),stop,close:async()=>{await s.sdk.sendCloseModal();},open:async slot=>{const f=state()?.nearbyLocs.find(l=>/^furnace$/i.test(l.name)&&l.distance<=3&&l.reachable!==false);if(!f)throw Error('furnace site unobserved');if(!(await s.sdk.sendUseItemOnLoc(slot,f.x,f.z,f.id)).success)return false;return waitUntil(s,()=>stop()||!!state()?.interface?.isOpen||!!state()?.dialog?.isOpen,{timeoutTicks:Math.min(8,Math.max(1,cap-(s.tick()-start)))});},choose:async menu=>(menu.option===undefined?await s.sdk.sendClickComponent(componentId(menu.component)):await s.sdk.sendClickComponentWithOption(componentId(menu.component),menu.option,menu.slot)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},r,{maximum:n,cap,members:j.members});}};
 }
 if(j.family==='cooking'){
  const r=cookingRecipes().recipes.find(r=>r.name===j.recipe);if(!r)throw Error('unknown cooking recipe');const heat=j.heat??'range';
  return{bank:j.bank??{x:2809,z:3441,level:0},site:j.site??{x:2816,z:3443,level:0},inputs:{[r.raw]:1},tools:[],outputs:[...r.products,...r.burnt===undefined?[]:[r.burnt],...r.additional===undefined?[]:[r.additional]],capacityOutputs:{[r.products[0]!]:1,...r.additional===undefined?{}:{[r.additional]:1}},run:async(n,cap,stop)=>{
   await runCookingBatch({state,tick:()=>s.tick(),stop,close:async()=>{await s.sdk.sendCloseModal();},heat:async(slot,kind,row)=>{const before=state()!,l=before.nearbyLocs.find(l=>nativeHeatSources().get(l.id)===kind&&l.distance<=2&&l.reachable!==false);if(!l)throw Error('heat site unobserved');if(!(await s.sdk.sendUseItemOnLoc(slot,l.x,l.z,l.id)).success)return false;if(row.karambwanChoice){await waitUntil(s,()=>stop()||!!state()?.dialog?.isOpen||!state()?.inventory.some(i=>i.id===row.raw),{timeoutTicks:6});if(state()?.dialog?.isOpen)return(await s.sdk.sendClickComponent(componentId(`multiobj2:objtext${row.karambwanChoice}`))).success;}return true;},wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},r,{maximum:n,cap,heat});}};
 }
 if(j.family==='tanning'){
  if(!Object.hasOwn(tanningRecipes,j.recipe))throw Error('unknown tanning recipe');const kind=j.recipe as TanKind,r=tanningRecipes[kind];
  return{...base,site:j.site??{x:3276,z:3192,level:0},inputs:{[r.input]:1,995:r.cost},tools:[],outputs:[r.output],run:async(n,cap,stop)=>checked(await tanInventory(s,kind,n,cap,stop))};
 }
 if(j.family==='glass')return{...base,site:j.site??FURNACE,inputs:pairs(furnaceGlassRecipe),tools:[],outputs:[1775,1925],run:async(n,cap,stop)=>checked(await runFurnaceGlass(s,n,cap,stop))};
 if(j.family==='magic'){
  const r=itemMagicRecipe(j.recipe,j.alchemyTarget);return{...base,inputs:itemSpellCosts(r,s.sdk.getEquipment(),j.members),tools:[],outputs:[r.product],run:async(n,cap,stop)=>checked(await runItemMagic(s,r,{count:n,cap,members:j.members,stop}))};
 }
 if(j.family==='mining'){
  const r=miningProfiles().find(p=>p.name===j.recipe)!;return{...base,inputs:{},tools:[j.tool??1265],outputs:[...new Set([...r.products,...incidentalMiningGems])],capacityOutputs:{[r.products[0]!]:2},run:async(n,cap,stop)=>{const result=await runAtSiteMining({state,tick:()=>s.tick(),stop,mine:async l=>(await s.sdk.sendInteractLoc(l.x,l.z,l.id,1)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},r,{maximum:n,cap,idleTicks:Math.min(300,cap)});return result.made;}};
 }
 if(j.family==='fishing'){
  const method=j.recipe as FishMethod,r=FISH_PROFILES[method];return{bank:j.bank??{x:2809,z:3441,level:0},site:j.site??{x:2840,z:3432,level:0},inputs:r.bait?{[r.bait]:method==='karambwan'?3:1}:{},tools:[r.tool],outputs:[...r.products,...method==='karambwan'?[3159]:[]],capacityOutputs:{[r.products[0]!]:1},run:async(n,cap,stop)=>{const before=new Map(r.products.map(id=>[id,s.sdk.getInventory().filter(i=>i.id===id).reduce((a,i)=>a+i.count,0)]));await runStagedFishing({state,tick:()=>s.tick(),stopped:stop,interact:(i,op)=>s.sdk.sendInteractNpc(i,op),combine:(a,b)=>s.sdk.sendUseItemOnItem(a,b),wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},{method,amount:n,cap,maxAttempts:Math.max(10,n*3),progressTicks:Math.min(300,cap)});const at=state()!.player!;await s.sdk.sendWalk(at.worldX,at.worldZ);await waitTicks(s,1);return r.products.reduce((a,id)=>a+s.sdk.getInventory().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)-(before.get(id)??0),0);}};
 }
 if(j.family==='stalls'){
  const r=stallRecipes().find(r=>r.name===j.recipe)!;return{...base,inputs:{},tools:[],outputs:r.loot,capacityOutputs:{[r.loot[0]!]:1},run:async(n,cap,stop)=>{const result=await stealStall(s,j.recipe,n,cap,stop);checked(result);return result.made;}};
 }
 // These workers already own their exact bank refill and output receipts.
 if(j.family==='inventory'){
  const r=inventoryRecipes().find(r=>r.name===j.recipe);if(!r)throw Error('unknown inventory recipe');if(j.target%(r.productUnits??1))throw Error('target must be a native output multiple');
  return{...base,inputs:pairs(r),tools:[...r.tools,...r.optionalInputs??[]],outputs:[r.product,...r.lossProduct===undefined?[]:[r.lossProduct],...(r.byproducts??[]).map(i=>i.id)],run:async(n,cap,stop)=>checked(await runInventoryBank(s,r,{maximum:n,cap,maxAttempts:Math.max(n,5*n),reserve:j.reserve,members:j.members,stop}))};
 }
 if(j.family==='wine')return{...base,inputs:{1987:1,1937:1},tools:[],outputs:[1993,1991,1995],run:async(n,cap,stop)=>checked(await runMixedWine(s,n,cap,stop,j.reserve))};
 return{...base,inputs:{526:1,557:2,555:2,561:1},tools:[],outputs:[1963],run:async(n,cap,stop)=>checked(await runBonesBank(s,{maximum:n,cap,members:j.members,reserve:j.reserve,stop}))};
}

export async function runBankJob(s:Session,j:BankJob,requestStop:()=>boolean=()=>false){
 validateBankJob(j);const p=await profile(s,j),start=s.tick(),first=s.sdk.getState()?.player,hp0=s.sdk.getSkill('Hitpoints')?.level??0;let ended=false;void s.ended.then(()=>{ended=true;});
 const inv=()=>s.sdk.getInventory(),count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),bankCount=(id:number)=>(s.bankObservation?.()?.items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const related=new Set([...Object.keys(p.inputs).map(Number),...p.tools,...p.outputs]);
 const protectedPack=new Map(inv().filter(i=>!related.has(i.id)).map(i=>[i.id,count(i.id)]));
 const dead=()=>{const st=s.sdk.getState()?.player;return ended||!first||!st||st.isDead||st.lifeId!==first.lifeId||(s.sdk.getSkill('Hitpoints')?.level??0)<=0;};
 const stop=()=>dead()||requestStop()||existsSync(`.practice/stop-${s.name}`)||existsSync('.practice/stop-all')||s.tick()-start>=j.cap-j.returnTicks||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0;
 const returningStop=()=>dead()||s.tick()-start>=j.cap;
 let completed=0,trips=0,banked:Record<number,number>={},failure='',atBank=false;
 const travel=async(to:Tile,returning=false)=>{const check=returning?returningStop:stop;if(check())throw Error('bank job stopped before travel');const controller=new AbortController(),off=s.onTick(()=>{if(check())controller.abort('bank job travel bound');});try{const from=s.sdk.getState()?.player,remaining=Math.max(1,j.cap-(s.tick()-start));const result=from&&from.level===to.level&&Math.max(Math.abs(from.worldX-to.x),Math.abs(from.worldZ-to.z))<=128?await walkPath(await sessionWalker(s),[{...to,tol:to===p.site&&j.family==="cooking"?0:2}],{stop:check}):await goTo(s,await getWorld(),to,accountOf(s),{signal:controller.signal,legTimeoutTicks:Math.min(120,remaining),maxRetriesPerLeg:1});if(!result.ok)throw Error('bank job route '+result.detail);const at=s.sdk.getState()?.player;atBank=!!at&&at.level===p.bank.level&&Math.max(Math.abs(at.worldX-p.bank.x),Math.abs(at.worldZ-p.bank.z))<=3;}finally{off();}};
 const open=async()=>{if(returningStop())throw Error('bank job bank budget exhausted');if(s.sdk.getState()?.bank.isOpen&&s.bankObservation?.())return;await s.sdk.sendCloseModal();await waitUntil(s,()=>!s.sdk.getState()?.interface.isOpen&&!s.sdk.getState()?.dialog.isOpen,{timeoutTicks:8});const g=s.bankObservation?.()?.generation??-1;const result=await s.bot.openBank();if(!result.success||!await waitUntil(s,()=>!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>g,{timeoutTicks:12}))throw Error('bank job fresh bank unavailable');};
 const secure=async(credit:boolean)=>{await open();for(const id of related){const item=inv().find(i=>i.id===id);if(item){const n=await depositObserved(s,item);if(credit&&p.outputs.includes(id))banked[id]=(banked[id]??0)+n;}}};
 try{
  if(!first||hp0<1)throw Error('bank job initial state missing');await travel(p.bank);await secure(false);
  const selfBanked=['inventory','wine','bones'].includes(j.family);
  if(selfBanked){const initial=Object.fromEntries(p.outputs.map(id=>[id,bankCount(id)]));await s.bot.closeBank();await p.run(j.target,j.cap-j.returnTicks-(s.tick()-start),stop);completed=j.target;await travel(p.bank,true);await secure(false);for(const id of p.outputs)banked[id]=bankCount(id)-initial[id]!;}
  else while(completed<j.target){
   if(stop())throw Error('bank job stopped before refill');await open();
   const type=s.client as {objType:(id:number)=>{stackable:boolean}};
   const amount=fittingBankBatch(p.inputs,p.tools,Math.min(j.batch,j.target-completed),28-inv().length,id=>{const value=type.objType(id)?.stackable;if(typeof value!=='boolean')throw Error('native item stackability unknown '+id);return value;},p.capacityOutputs);
   if(amount<1)throw Error('bank job pack cannot fit a batch');
   for(const [id,n]of [...p.tools.map(id=>[id,count(id)?0:1]),...Object.entries(p.inputs).map(([id,n])=>[Number(id),n*amount])]){
    if(!n)continue;if(stop())throw Error('bank job stopped before withdrawal');const row=s.sdk.getState()?.bank.items.find(i=>i.id===id);if(!row||bankCount(id)-n<(Object.hasOwn(p.inputs,id)?j.reserve??0:0))throw Error('bank job stock short '+id);const before=count(id),stored=bankCount(id),g=s.bankObservation!()!.generation;await s.bot.withdrawItem(row,n,{asNote:false});if(!await waitUntil(s,()=>count(id)===before+n&&bankCount(id)===stored-n&&(s.bankObservation?.()?.generation??-1)>g,{timeoutTicks:10}))throw Error('bank job withdrawal does not reconcile '+id);
   }
   await s.bot.closeBank();if(!await waitUntil(s,()=>!s.sdk.getState()?.bank.isOpen,{timeoutTicks:8}))throw Error('bank job bank remains open');
   await travel(p.site);console.log("BANK_JOB_PHASE "+JSON.stringify({phase:"produce",family:j.family,amount,tick:s.tick()-start,position:s.sdk.getState()?.player&&[s.sdk.getState()!.player!.worldX,s.sdk.getState()!.player!.worldZ]}));const actual=await p.run(amount,j.cap-j.returnTicks-(s.tick()-start),stop);completed+=actual??amount;trips++;
   // Native spell/production handlers can retain a delay after publishing output.
   await waitTicks(s,3);await travel(p.bank,true);await secure(true);
  }
 }catch(error){failure=String(error);try{if(!dead()){for(const item of inv())if(!protectedPack.has(item.id))related.add(item.id);await s.sdk.sendCloseModal();await travel(p.bank,true);await secure(true);}}catch(recovery){failure+='; return '+String(recovery);}}
 finally{if(!dead())await s.bot.closeBank();}
 if([...protectedPack].some(([id,n])=>count(id)!==n))failure+='; protected stock changed';
 if((s.sdk.getSkill('Hitpoints')?.level??0)<hp0)failure+='; health changed';
 const ok=!failure&&completed>=j.target&&atBank&&!dead()&&!requestStop()&&s.tick()-start<j.cap;
 return{ok,family:j.family,recipe:j.recipe,completed,trips,banked,atBank,ticks:s.tick()-start,failure:failure||'-'};
}
if(import.meta.main){const account=process.argv[2],path=process.argv[3];if(!account||!path)throw Error('usage: microbot-bank-jobs.ts account job.json');const job=JSON.parse(readFileSync(path,'utf8')) as BankJob;validateBankJob(job);let stopped=false;const s=await openBot(account,{onStop:async()=>{stopped=true;}});try{const result=await runBankJob(s,job,()=>stopped);console.log('BANK_JOB '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));}catch(error){await finish([s],false,String(error));}}
