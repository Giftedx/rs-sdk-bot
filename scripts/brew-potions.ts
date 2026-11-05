// bun scripts/brew-potions.ts <account> [CAP=15000] [RECIPE=auto]
// TARGET_LEVEL defaults to 50. VIAL_BUDGET and SECONDARY_BUDGET are run-wide coin limits.
import {openBot,finish,getWorld,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {goTo} from '../packages/core/src/walk';
import {nearestBank} from './quest-sweep';
import {sellersByDistance} from '../packages/core/src/shop-index';
import type {Tile} from '../packages/core/src/world';
import {abortable,executionContext} from '../vendor/rs-sdk/sdk/execution-context';

// Cancel the whole attempt, including route planning, before another seller owns movement.
export async function boundedHerbloreMove(s:Session,move:(signal:AbortSignal)=>ReturnType<typeof goTo>,timeoutTicks:number):ReturnType<typeof goTo>{
 const start=s.tick(),controller=new AbortController(),deadline=Error(`travel exceeded ${timeoutTicks} ticks`);
 const parent=executionContext.getStore();
 const signal=parent?AbortSignal.any([parent.signal,controller.signal]):controller.signal;
 const timer=waitUntil(s,()=>false,{timeoutTicks,signal:controller.signal}).then(()=>{
  if(!controller.signal.aborted)controller.abort(deadline);
 });
 // A frozen tick stream must also stop the attempt and release its listener.
 void timer.catch(error=>controller.abort(error));
 try{return await executionContext.run({...parent,signal},()=>abortable(move(signal)));}
 catch(error){if(error===deadline)return {ok:false,reason:'timeout',detail:deadline.message,ticks:s.tick()-start};throw error;}
 finally{controller.abort('travel settled');await timer.catch(()=>{});}
}

// Counts game actions inside one goTo. A failed move with no action never got a route to walk.
export function tracedWalker<T extends Pick<Session,'direct'|'bot'>>(s:T){
 let sent=0;
 const walker=Object.create(s) as T;
 walker.direct=action=>{sent++;return s.direct(action);};
 walker.bot=new Proxy(s.bot,{get(target,key){
  const value=Reflect.get(target,key);
  return typeof value==='function'?(...args:unknown[])=>{sent++;return value.apply(target,args);}:value;
 }});
 return {walker,sent:()=>sent};
}

export async function observeHerbloreStep<T>(step:string,s:Pick<Session,'tick'|'sdk'>,action:()=>Promise<T>,log:(line:string)=>void=console.log):Promise<T>{
 const report=(phase:string,error?:string)=>{
  const state=s.sdk.getState(),p=state?.player;
  log(`HERBLORE_STEP ${JSON.stringify({step,phase,tick:s.tick(),position:p?{x:p.worldX,z:p.worldZ,level:p.level}:null,
   bank:state?.bank?.isOpen,interface:state?.interface?.isOpen,coins:s.sdk.getInventory().filter(i=>i.id===995).reduce((n,i)=>n+i.count,0),error})}`);
 };
 report('enter');
 try{const result=await action();report('return');return result;}
 catch(error){report('throw',String(error));throw error;}
}

export async function reachSeller(item:string,at:Tile,reach:(tile:Tile)=>Promise<{ok:boolean;reason?:string;detail?:string}>){
 const sellers=sellersByDistance(item,at);let detail='no stocked sellers on this level';
 for(const seller of sellers){
  const result=await reach(seller.tile);
  if(result.ok)return seller;
  detail=`${seller.npc} at ${seller.tile.x},${seller.tile.z},${seller.tile.level}: ${result.reason} ${result.detail}`;
 }
 throw Error(`no reachable seller for ${item} (${sellers.length} tried): ${detail}`);
}

type Stock=Record<number,number>;
type Recipe={key:string;level:number;dirty:number;clean:number;unf:number;sec:number;pot:number};
export const RECIPES:Record<string,Recipe>=Object.fromEntries([
 ['attack',3,199,249,91,221,121],['antipoison',5,201,251,93,235,175],
 ['strength',12,203,253,95,225,115],['fishing',50,211,261,103,231,151],
 ['magic',76,2485,2481,2483,3138,3042],['ranging',72,217,267,109,245,169],['energy',26,205,255,97,1975,3010],
 ['prayer',38,207,257,99,231,139],['super_attack',45,209,259,101,221,145],
 ['super_str',55,213,263,105,225,157],['super_def',66,215,265,107,239,163],
].map(([key,level,dirty,clean,unf,sec,pot])=>[key,{key,level,dirty,clean,unf,sec,pot}])) as Record<string,Recipe>;
export function selectRecipe(level:number,stock:Stock,key='auto'):Recipe{
 const candidates=Object.values(RECIPES).filter(r=>r.level<=level&&(!['auto','unf'].includes(key)?r.key===key:true)
  &&[r.dirty,r.clean,r.unf].some(id=>(stock[id]??0)>0)).sort((a,b)=>b.level-a.level);
 if(!candidates[0])throw Error(`herbs missing: no usable owned herbs or unfinished potions for ${key} at level ${level}`);
 return candidates[0];
}
export function supplyPlan(herbs:number,vials:number,eyes:number,coins:number,vialBudget:number,eyeBudget:number){
 const v=Math.max(0,herbs-vials),e=Math.max(0,herbs-eyes);
 if(v*4>vialBudget)throw Error('vial budget cannot cover shortfall');
 if(e*3>eyeBudget)throw Error('secondary budget cannot cover shortfall');
 const reserve=v*4+e*3;if(reserve>coins)throw Error('owned coins cannot cover supply shortfall');
 return {vials:v,eyes:e,reserve};
}
// Eyes come first: the run starts near Betty, and the vial trip ends at Ardougne South bank,
// where no eye seller leg moved. A trip starts only when the next potion lacks a supply.
// The loop brews one potion at a time, so the owned secondaries limit the batch: buying vials past them strands coins.
export const workingBatch=(herbs:number,unf:number,secondaries:number)=>Math.min(27,herbs+unf,secondaries);
export function supplyPurchases(o:{batch:number;make:number;vials:number;eyes:number;buyEyes:boolean}):[227|221,number][]{
 if(!(o.make>0&&o.vials<1)&&!(o.buyEyes&&o.eyes<1))return [];
 return ([[221,o.buyEyes?Math.max(0,o.batch-o.eyes):0],[227,Math.max(0,o.make-o.vials)]] as [227|221,number][]).filter(([,n])=>n>0);
}
export function reconcile(before:Stock,after:Stock,delta:Stock){
 return [...new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)])].every(k=>
  (after[+k]??0)===(before[+k]??0)+(delta[+k]??0));
}
export function options(args:string[],env:Record<string,string|undefined>=process.env){
 const [name,capArg,recipeArg]=args,cap=Number(capArg??env.CAP??15000),target=Number(env.TARGET_LEVEL??50);
 const vialBudget=Number(env.VIAL_BUDGET??1000),secondaryBudget=Number(env.SECONDARY_BUDGET??1000),recipe=(recipeArg??env.RECIPE??'auto').toLowerCase();
 if(!name||!Number.isSafeInteger(cap)||cap<=0||!Number.isInteger(target)||target<1||target>99
  ||![vialBudget,secondaryBudget].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1000)
  ||!['auto','unf',...Object.keys(RECIPES)].includes(recipe))throw Error('invalid account, CAP, TARGET_LEVEL, recipe or budgets (0..1000 coins)');
 return {name,cap,target,recipe,vialBudget,secondaryBudget};
}
const stock=(rows:{id:number;count:number}[])=>rows.reduce<Stock>((out,i)=>{out[i.id]=(out[i.id]??0)+i.count;return out;},{});
export async function brew(s:Session,o:ReturnType<typeof options>){
 const start=s.tick(),world=await getWorld(),delta:Stock={},spent:Stock={227:0,221:0};let brewed=0;
 const inv=()=>s.sdk.getInventory(),held=(id:number)=>stock(inv())[id]??0;
 const bankRows=()=>s.sdk.getBankItems();
 const totals=()=>stock([...inv(),...bankRows()]);
 const here=()=>{const p=s.sdk.getState()!.player!;return{x:p.worldX,z:p.worldZ,level:p.level};};
 const level=()=>s.sdk.getSkill('Herblore')!.baseLevel;
 const check=()=>{if(s.tick()-start>=o.cap)throw Error(`CAP ${o.cap} reached`);};
 const observed=async(pred:()=>boolean,detail:string)=>{
  check();if(!await waitUntil(s,pred,{timeoutTicks:Math.min(15,Math.max(1,o.cap-(s.tick()-start)))}))throw Error(`${detail} unobserved`);check();
 };
 const attemptMove=async(to:Tile)=>{
  check();const coins=totals()[995]??0,from=here(),trace=tracedWalker(s);let r:Awaited<ReturnType<typeof goTo>>|undefined;
  try{
   r=await boundedHerbloreMove(s,signal=>goTo(trace.walker,world,to,accountOf(s),{legTimeoutTicks:100,signal}),Math.min(300,o.cap-(s.tick()-start)));
   check();return r;
  }finally{
   const change=(totals()[995]??0)-coins;add(995,change);
   const doors=(s.sdk.getState()?.nearbyLocs??[]).filter(l=>(l.options??[]).some(x=>/^open$/i.test(x))).slice(0,8).map(l=>`${l.name} ${l.x},${l.z}`);
   console.log(`HERBLORE_TRAVEL ${JSON.stringify({to,coins:change,from,at:here(),result:r,sent:trace.sent(),doors})}`);
  }
 };
 const move=async(to:Tile)=>{const r=await attemptMove(to);if(!r.ok)throw Error(`travel failed: ${r.reason} ${r.detail}`);};
 const openBank=async()=>{
  check();if(!(await s.bot.openBank()).success){await move(nearestBank(here()));if(!(await s.bot.openBank()).success)throw Error('bank unavailable');}
  await observed(()=>s.sdk.isBankOpen(),'bank');
 };
 const deposit=async()=>{
  for(const id of new Set(inv().map(i=>i.id))){check();const row=inv().find(i=>i.id===id)!,n=held(id),b=stock(bankRows())[id]??0;
   await s.bot.depositItem(row,-1);await observed(()=>held(id)===0&&(stock(bankRows())[id]??0)===b+n,`deposit ${id}`);
  }
 };
 const withdraw=async(id:number,n:number)=>{
  const row=bankRows().find(i=>i.id===id);if(!row||row.count<n)throw Error(`bank missing ${id}:${n}`);
  const b=held(id);await s.bot.withdrawItem(row,n);await observed(()=>held(id)===b+n,`withdraw ${id}`);
 };
 const add=(id:number,n:number)=>{delta[id]=(delta[id]??0)+n;};
 const combine=async(a:number,b:number,c:number)=>{
  const aa=held(a),bb=held(b),cc=held(c);check();
  await s.sdk.sendUseItemOnItem(inv().find(i=>i.id===a)!.slot,inv().find(i=>i.id===b)!.slot);
  await observed(()=>held(a)===aa-1&&held(b)===bb-1&&held(c)===cc+1,`mix ${a}+${b}->${c}`);
  add(a,-1);add(b,-1);add(c,1);
 };
 const buy=async(id:227|221,n:number)=>{
  if(n<=0)return;
  const startingSpend=spent[id]??0;
  const budget=(id===227?o.vialBudget:o.secondaryBudget)-startingSpend;
  if(n*(id===227?4:3)>budget)throw Error(`${id===227?'vial':'secondary'} budget cannot cover shortfall`);
  const step=<T>(name:string,action:()=>Promise<T>)=>observeHerbloreStep(`buy ${id}: ${name}`,s,action);
  await step('withdraw coins',()=>withdraw(995,Math.min(totals()[995]??0,budget)));
  await step('close bank',()=>s.bot.closeBank());
  const seller=await step('reach seller',()=>reachSeller(id===227?'vial_water':'eye_of_newt',here(),
   tile=>step(`goTo ${tile.x},${tile.z},${tile.level}`,()=>attemptMove(tile))));
  const npc=s.sdk.getState()?.nearbyNpcs.find(x=>x.id===seller.npcId);
  if(!npc||!(await s.bot.openShop(npc)).success)throw Error(`shop unavailable: ${seller.npc}`);
  await observed(()=>!!s.sdk.getState()?.shop?.isOpen,'shop');
  for(let bought=0;bought<n;bought++){
   check();const row=s.sdk.getState()?.shop?.shopItems.find(i=>i.id===id);
   const coins=held(995),before=held(id),left=budget-((spent[id]??0)-startingSpend);
   if(!row||row.count<1)throw Error(`shop ${seller.npc} out of stock ${id}`);
   if(!Number.isSafeInteger(row.buyPrice)||row.buyPrice<0||row.buyPrice>left||row.buyPrice>coins)throw Error(`${id===227?'vial':'secondary'} budget or coins exhausted`);
   // One item per observed price bounds dynamic shop pricing.
   await s.bot.buyFromShop(row,1);
   await observed(()=>held(id)===before+1&&held(995)<=coins,'purchase');
   const cost=coins-held(995);if(cost>left)throw Error('shop exceeded quoted budget');
   spent[id]=(spent[id]??0)+cost;add(id,1);add(995,-cost);
   console.log(`HERBLORE_BUY ${JSON.stringify({id,count:1,cost,seller:seller.npc,shop:seller.shop})}`);
  }
  await step('close shop',()=>s.bot.closeShop());
  await step('open bank',openBank);await step('deposit',deposit);
 };
 await observed(()=>!!s.sdk.getState()?.player&&!!s.sdk.getSkill('Herblore'),'entry');
 await openBank();const before=totals(),xp=s.sdk.getSkillXp('Herblore')!,worn=JSON.stringify(s.sdk.getState()?.equipment??[]);
 await deposit();
 try{
  if(level()>=o.target)throw Error(`target already met: ${level()} >= ${o.target}`);
  while(level()<o.target){
   check();const r=selectRecipe(level(),totals(),o.recipe),all=totals();
   const herbs=(all[r.dirty]??0)+(all[r.clean]??0),unf=all[r.unf]??0;
   const secondaries=r.sec===221||o.recipe==='unf'?27:all[r.sec]??0,batch=workingBatch(herbs,unf,secondaries),make=Math.max(0,batch-Math.min(batch,unf));
   const purchases=supplyPurchases({batch,make,vials:all[227]??0,eyes:all[221]??0,buyEyes:r.sec===221&&o.recipe!=='unf'});
   // The whole shortfall is priced before the first purchase, so a refusal leaves assets unchanged.
   if(purchases.length)supplyPlan(make,all[227]??0,r.sec===221?Math.max(0,(all[221]??0)-Math.min(unf,batch)):make,all[995]??0,o.vialBudget-(spent[227]??0),o.secondaryBudget-(spent[221]??0));
   if(secondaries<1)throw Error(`secondary missing ${r.sec}`);
   for(const [id,n] of purchases)await buy(id,n);
   // Each completed potion is banked before checking the next recipe and target.
   const current=totals();let input=r.unf;
   if(!(current[r.unf]??0))input=(current[r.clean]??0)?r.clean:r.dirty;
   await withdraw(input,1);
   if(input!==r.unf)await withdraw(227,1);
   if(o.recipe!=='unf')await withdraw(r.sec,1);
   await s.bot.closeBank();
   if(input===r.dirty){const c=held(r.clean);await s.sdk.sendUseItem(inv().find(i=>i.id===r.dirty)!.slot,1);
    await observed(()=>held(r.dirty)===0&&held(r.clean)===c+1,`clean ${r.dirty}`);add(r.dirty,-1);add(r.clean,1);}
   if(input!==r.unf)await combine(r.clean,227,r.unf);
   if(o.recipe!=='unf'){await combine(r.unf,r.sec,r.pot);brewed++;}
   await openBank();await deposit();
   if(o.recipe==='unf')throw Error('unfinished-only output does not meet a Herblore target');
  }
  const after=totals(),assets=reconcile(before,after,delta),gained=s.sdk.getSkillXp('Herblore')!-xp;
  const equipment=worn===JSON.stringify(s.sdk.getState()?.equipment??[]);
  const result={ok:level()>=o.target&&brewed>0&&gained>0&&assets&&equipment,target:o.target,level:level(),brewed,xp:gained,ticks:s.tick()-start,before,after,delta,spent,assets,equipment};
  console.log(`HERBLORE_RESULT ${JSON.stringify(result)}`);
  if(!result.ok)throw Error('target, XP or asset reconciliation failed');
  return result;
 }catch(e){
  // Return all held assets when the bank remains available. finish owns logout.
  if(s.sdk.isBankOpen())await deposit();
  console.log(`HERBLORE_REFUSAL ${JSON.stringify({reason:String(e),assets:reconcile(before,totals(),delta),delta,spent})}`);throw e;
 }
}
if(import.meta.main){
 let s:Session|undefined;
 try{const o=options(process.argv.slice(2));s=await openBot(o.name);const r=await brew(s,o);await finish([s],true,`Herblore ${r.level} target ${r.target} brewed=${r.brewed} assets=${r.assets}`);}
 catch(e){await finish(s?[s]:[],false,`herblore ${String(e)}`);}
}
