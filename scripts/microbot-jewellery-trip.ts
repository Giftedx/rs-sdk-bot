// Adapted donor workflow: Microbot-Hub crafting/jewelry/JewelryScript BANKING/CUTTING.
// BSD notice: research/microbot-ports-LICENSE.txt. Reuses the native bank and production workers.
// bun scripts/microbot-jewellery-trip.ts <account> <finite-order.json>
import {readFileSync,existsSync} from 'node:fs';
import {openBot,settle,logoutSession} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {componentId} from '../packages/core/src/logout';
import {jewelleryRecipes,jewelleryMenu} from './microbot-b-jewellery';
import {inventoryRecipes,type InventoryRecipe} from './microbot-production';
import {runBankJob,type BankJob,type Tile} from './microbot-bank-jobs';
import {actionSessionOwner,finishActionSession} from './microbot-a-actions';
import {productionStopRequested} from './microbot-c-lifetime';

export interface JewelleryOrder{recipe:string;target:number;batch:number;cap:number;returnTicks:number;reserve:number;members:boolean;stringAmulet:boolean;bank:Tile;furnace:Tile}
export interface JewellerySnapshot{assets:Record<number,number>;bank:Record<number,number>;pack:Record<number,number>;gear:{id:number;slot:number;count:number}[];xp:Record<string,number>}
type Stage={family:'inventory'|'jewellery';recipe:string;target:number;product:number;delta:Record<number,number>};
type JobReceipt={ok:boolean;completed:number;atBank:boolean;banked:Record<number,number>;failure?:string};
type JewelleryClient={executeBotAction?:unknown;membersAccount?:number;selfSlot?:number};
export type JewelleryDeps={audit?:()=>Promise<JewellerySnapshot>;job?:(s:Session,j:BankJob,stop:()=>boolean)=>Promise<JobReceipt>};
export function jewelleryCleanup(raw:Session,finalize:typeof settle=settle,logout:(session:Session)=>Promise<string>=logoutSession){
 const owner=actionSessionOwner(raw);
 const sdk=raw.sdk,client=raw.client as JewelleryClient|undefined,direct=raw.direct,close=raw.close,ended=raw.ended,lifecycle=raw.lifecycle,name=raw.name,executor=client?.executeBotAction,slot=client?.selfSlot,config=sdk.config,origin=JSON.stringify([config?.gatewayUrl,config?.host,config?.port]),player=sdk.getState()?.player,life=player?.lifeId,respawns=player?.respawnCount??0;
 let lost=false,loggedOut=false;void ended.then(e=>{loggedOut=e.reason==='logged-out';});
 const owns=()=>{const p=sdk.getState()?.player;if(raw.sdk!==sdk||raw.client!==client||raw.direct!==direct||raw.close!==close||raw.ended!==ended||raw.lifecycle!==lifecycle||raw.name!==name||client?.executeBotAction!==executor||sdk.config!==config||JSON.stringify([config?.gatewayUrl,config?.host,config?.port])!==origin||client?.selfSlot!==slot||(!loggedOut||p!=null)&&(p?.lifeId!==life||(p?.respawnCount??0)!==respawns))lost=true;return !lost&&typeof executor==='function'&&Number.isSafeInteger(slot)&&Number.isSafeInteger(life);};
 const guard=()=>{if(!owns())throw Error('jewellery cleanup original session replaced');};
 const guarded=new Proxy(sdk,{get(t,k,r){const value=Reflect.get(t,k,r);return typeof value==='function'?function(...args:unknown[]){if(String(k).startsWith('send'))guard();return value.apply(r,args);}:value;}});
 const session=Object.create(raw) as Session;Object.defineProperties(session,{sdk:{value:guarded},client:{value:client},bot:{value:new BotActions(guarded)},direct:{value:(a:Parameters<Session['direct']>[0])=>{guard();return direct.call(raw,a);}},close:{value:()=>{guard();return close.call(raw);}},ended:{value:ended},lifecycle:{value:lifecycle},name:{value:name}});
 return{owns,finish:async(ok:boolean,detail:string)=>{if(!owns())return false;
  if(!owner.own()){const end=await Promise.race([ended,Promise.resolve({reason:''})]);return end.reason==='logged-out'&&owns()&&owner.identity()&&owner.sameLife()?finalize([raw],ok,detail):false;}
  return(await finishActionSession(owner,ok,detail,async(sessions,valid,message,options)=>owns()?finalize(sessions,valid,message,options):false,async()=>{guard();const outcome=await logout(session);guard();return outcome;}))===true;
 }};
}
const equal=(a:Record<number,number>,b:Record<number,number>)=>[...new Set([...Object.keys(a),...Object.keys(b)].map(Number))].every(id=>(a[id]??0)===(b[id]??0));
const add=(to:Record<number,number>,delta:Record<number,number>)=>{for(const [id,n]of Object.entries(delta))to[Number(id)]=(to[Number(id)]??0)+n;};
export function validateJewelleryOrder(o:JewelleryOrder){
 if(!o||!Number.isSafeInteger(o.target)||o.target<1||o.target>10000||!Number.isSafeInteger(o.batch)||o.batch<1||o.batch>27||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>100000||!Number.isSafeInteger(o.returnTicks)||o.returnTicks<40||o.returnTicks>=o.cap-100||!Number.isSafeInteger(o.reserve)||o.reserve<0||typeof o.members!=='boolean'||typeof o.stringAmulet!=='boolean')throw Error('invalid finite jewellery order');
 for(const tile of [o.bank,o.furnace])if(!tile||![tile.x,tile.z,tile.level].every(Number.isSafeInteger)||tile.x<0||tile.x>16383||tile.z<0||tile.z>16383||tile.level<0||tile.level>3)throw Error('jewellery bank/furnace unknown');
 const recipe=jewelleryRecipes().find(r=>r.name===o.recipe);if(!recipe)throw Error('unknown native jewellery recipe');
 if(o.stringAmulet&&(recipe.shape!=='amulet'||!inventoryRecipes().some(r=>r.name.startsWith('string-')&&r.inputs.some(i=>i.id===recipe.product))))throw Error('native amulet stringing unavailable');
 if(recipe.members&&!o.members)throw Error('jewellery member recipe unavailable');return recipe;
}
export function planJewelleryOrder(o:JewelleryOrder,stock:Record<number,number>,level:number){
 const recipe=validateJewelleryOrder(o),inventory=inventoryRecipes();
 if(!Number.isSafeInteger(level)||level<recipe.level||Object.values(stock).some(n=>!Number.isSafeInteger(n)||n<0))throw Error('jewellery base level/owned stock unknown');
 const simulated={...stock},floor=Object.fromEntries(Object.entries(stock).map(([id,n])=>[id,Math.min(n,o.reserve)])),stages:Stage[]=[];
 const available=(id:number)=>Math.max(0,(simulated[id]??0)-(floor[id]??0));
 const stage=(family:Stage['family'],r:Pick<InventoryRecipe,'name'|'inputs'|'tools'|'product'|'level'|'members'>,n:number)=>{
  if(level<r.level||r.members&&!o.members||r.tools.some(id=>(simulated[id]??0)<1))throw Error('jewellery stage level/tool/member unavailable '+r.name);
  const delta:Record<number,number>={};for(const input of r.inputs){const cost=input.units*n;if(available(input.id)<cost)throw Error('owned jewellery ingredient/reserve unavailable '+input.id);delta[input.id]=(delta[input.id]??0)-cost;}
  delta[r.product]=(delta[r.product]??0)+n;add(simulated,delta);stages.push({family,recipe:r.name,target:n,product:r.product,delta});
 };
 const gem=recipe.inputs.find(i=>i.id!==recipe.bar);
 if(gem&&available(gem.id)<o.target){
  const cut=inventory.find(r=>r.name.startsWith('cut-')&&r.product===gem.id&&!r.lossProduct&&(r.productUnits??1)===1);
  if(!cut)throw Error('native lossless gem preparation unavailable');stage('inventory',cut,o.target-available(gem.id));
 }
 stage('jewellery',recipe,o.target);let product=recipe.product;
 if(o.stringAmulet){
  const string=inventory.find(r=>r.name.startsWith('string-')&&r.inputs.some(i=>i.id===recipe.product)&&(r.productUnits??1)===1);
  if(!string||recipe.shape!=='amulet')throw Error('native amulet stringing unavailable');stage('inventory',string,o.target);product=string.product;
 }
 const delta:Record<number,number>={};for(const s of stages)add(delta,s.delta);
 return{stages,delta,product,floor};
}

export async function runJewelleryOrder(raw:Session,o:JewelleryOrder,requested:()=>boolean=()=>false,deps:JewelleryDeps={}){
 const recipe=validateJewelleryOrder(o);const originalSdk=raw.sdk,originalDirect=raw.direct,config=originalSdk.config,origin=JSON.stringify([config?.gatewayUrl,config?.host,config?.port]),initialPlayer=raw.sdk.getState()?.player,life=initialPlayer?.lifeId,respawns=initialPlayer?.respawnCount??0,hp=raw.sdk.getSkill('Hitpoints')?.level??0,client=raw.client as JewelleryClient|undefined,executor=client?.executeBotAction,slot=client?.selfSlot,start=raw.tick();
 let ended=false,lost=false,uncertain=false,failure='',made=0;void raw.ended.then(()=>{ended=true;});
 const fatal=()=>{const p=raw.sdk.getState()?.player,age=raw.sdk.getStateAge();if(raw.sdk!==originalSdk||raw.direct!==originalDirect||raw.client!==client||client?.executeBotAction!==executor||client?.selfSlot!==slot||originalSdk.config!==config||JSON.stringify([config?.gatewayUrl,config?.host,config?.port])!==origin)lost=true;return lost||typeof executor!=='function'||!Number.isSafeInteger(slot)||ended||!p||!Number.isSafeInteger(life)||p.lifeId!==life||(p.respawnCount??0)!==respawns||p.isDead||hp<1||(raw.sdk.getSkill('Hitpoints')?.level??0)!==hp||!Number.isFinite(age)||age<0||age>5000;};
 const stop=()=>fatal()||productionStopRequested(raw.name,requested,existsSync,process.env.STOP_FILE??'.practice/stop-microbot-jewellery')||raw.tick()-start>=o.cap-o.returnTicks;
 const guard=()=>{if(fatal()||raw.tick()-start>=o.cap)throw Error('jewellery original owner/life/budget unavailable');};
 const invRecipes=inventoryRecipes(),gem=recipe.inputs.find(i=>i.id!==recipe.bar),cut=gem&&invRecipes.find(r=>r.name.startsWith('cut-')&&r.product===gem.id&&!r.lossProduct),string=o.stringAmulet&&invRecipes.find(r=>r.name.startsWith('string-')&&r.inputs.some(i=>i.id===recipe.product)),productionItems=new Set([recipe,...cut?[cut]:[],...string?[string]:[]].flatMap(r=>[...r.inputs.map(i=>i.id),...r.tools])),sickle=jewelleryRecipes().find(r=>r.name==='silver_sickle')?.tools[0],tools=Object.fromEntries(recipe.tools.map(id=>[id,1]));
 const paidComponents=new Set([jewelleryMenu(recipe,tools,o.members),jewelleryMenu(recipe,{...tools,...sickle===undefined?{}:{[sickle]:1}},o.members)].map(m=>componentId(m.component)));for(const r of [cut,string])if(r&&r.menu)paidComponents.add(componentId(r.menu));
 const newProduction=(key:PropertyKey,args:unknown[]):boolean=>{if(key==='send'||key==='sendAction'){const envelope=args[0];if(!envelope||typeof envelope!=='object')return false;const value=key==='send'?(envelope as Record<string,unknown>).action:envelope;if(!value||typeof value!=='object')return false;const a=value as Record<string,unknown>;if(a.type==='clickComponent'||a.type==='clickComponentWithOption')return newProduction(a.type==='clickComponent'?'sendClickComponent':'sendClickComponentWithOption',[a.componentId]);if(a.type==='useInventoryItem')return newProduction('sendUseItem',[a.slot]);if(a.type==='useItemOnItem')return newProduction('sendUseItemOnItem',[a.sourceSlot,a.targetSlot]);if(a.type==='useItemOnLoc')return newProduction('sendUseItemOnLoc',[a.itemSlot]);return false;}const item=(slot:unknown)=>raw.sdk.getInventory().find(i=>i.slot===slot)?.id;if((key==='sendClickComponent'||key==='sendClickComponentWithOption')&&paidComponents.has(Number(args[0])))return true;if(key==='sendUseItemOnLoc')return item(args[0])===recipe.bar;if(key==='sendUseItem'||key==='sendUseItemOnItem')return [item(args[0]),...key==='sendUseItemOnItem'?[item(args[1])]:[]].some(id=>id!==undefined&&productionItems.has(id));return false;};
 const sdk=new Proxy(raw.sdk,{get(t,k,r){const value=Reflect.get(t,k,r);return typeof value==='function'?function(...args:unknown[]){if(String(k).startsWith('send')){guard();if(newProduction(k,args)&&stop())throw Error('jewellery stopped before new production input');}return value.apply(r,args);}:value;}});
 const s=Object.create(raw) as Session;Object.defineProperties(s,{sdk:{value:sdk},bot:{value:new BotActions(sdk)},direct:{value:(action:Parameters<Session['direct']>[0])=>{guard();if(newProduction('sendAction',[action])&&stop())throw Error('jewellery stopped before new production input');return raw.direct(action);}}});
 const audit=deps.audit??(async():Promise<JewellerySnapshot>=>{
  guard();const p=s.sdk.getState()?.player;if(!p||p.level!==o.bank.level||Math.max(Math.abs(p.worldX-o.bank.x),Math.abs(p.worldZ-o.bank.z))>3||o.cap-(s.tick()-start)<30)throw Error('jewellery fresh bank position/budget absent');
  const tick=s.tick();await s.sdk.sendCloseModal();if(!await waitUntil(s,()=>fatal()||s.tick()>tick&&!s.sdk.getState()?.bank.isOpen&&!s.sdk.getState()?.interface.isOpen&&!s.sdk.getState()?.dialog.isOpen,{timeoutTicks:10})||fatal())throw Error('jewellery modal closure unobserved');
  const generation=s.bankObservation?.()?.generation??-1;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>fatal()||!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10})||fatal())throw Error('jewellery fresh bank unavailable');
  const count=(rows:readonly{id:number;count:number}[])=>{const out:Record<number,number>={};for(const row of rows)out[row.id]=(out[row.id]??0)+row.count;return out;};
  const gear=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot),bank=count(s.bankObservation!()!.items),pack=count(s.sdk.getInventory()),assets={...bank};add(assets,pack);add(assets,count(gear));
  const snapshot={assets,bank,pack,gear,xp:Object.fromEntries((s.sdk.getState()?.skills??[]).map(k=>[k.name,k.experience]))};
  if(!Object.keys(snapshot.xp).length)throw Error('jewellery skill observation absent');
  if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>fatal()||!s.sdk.getState()?.bank.isOpen,{timeoutTicks:8})||fatal())throw Error('jewellery bank closure unobserved');return snapshot;
 });
 let initial:JewellerySnapshot|undefined,final:JewellerySnapshot|undefined,expected:Record<number,number>={},product=-1;const receipts:{stage:Stage;result:JobReceipt}[]=[];
 try{
  if(stop()||o.members&&client?.membersAccount!==1)throw Error('jewellery entry stop/member/life unavailable');
  initial=await audit();const plan=planJewelleryOrder(o,initial.assets,raw.sdk.getSkill('Crafting')?.baseLevel??0);product=plan.product;expected={...initial.assets};
  for(const stage of plan.stages){
   if(stop())throw Error('jewellery stopped before next stage');
   const before=await audit();if(!equal(before.assets,expected)||JSON.stringify(before.gear)!==JSON.stringify(initial.gear))throw Error('jewellery stock/gear drift before stage');
   const cap=o.cap-(raw.tick()-start)-40;if(cap<=o.returnTicks+40)throw Error('jewellery stage/return budget unavailable');
   uncertain=true;
   const result=await(deps.job??runBankJob)(s,{family:stage.family,recipe:stage.recipe,target:stage.target,batch:o.batch,cap,returnTicks:o.returnTicks,members:o.members,reserve:0,bank:o.bank,site:stage.family==='jewellery'?o.furnace:o.bank},stop);
   receipts.push({stage,result});if(!result.ok||!result.atBank||result.completed!==stage.target||result.banked[stage.product]!==stage.target)throw Error('jewellery child receipt incomplete');
   add(expected,stage.delta);final=await audit();
   if(!equal(final.assets,expected)||JSON.stringify(final.gear)!==JSON.stringify(initial.gear)||Object.keys(initial.xp).some(skill=>skill!=='Crafting'&&final!.xp[skill]!==initial!.xp[skill])||(final.xp.Crafting??0)<=(before.xp.Crafting??0))throw Error('jewellery stage asset/XP/gear reconciliation failed');
   uncertain=false;
  }
  made=o.target;
 }catch(error){failure=String(error);}
 const preserved=!!initial&&!!final&&equal(final.assets,expected)&&JSON.stringify(final.gear)===JSON.stringify(initial.gear),banked=initial&&final?(final.bank[product]??0)-(initial.bank[product]??0):0;
 const ok=!failure&&!stop()&&!uncertain&&preserved&&made===o.target&&banked>=made&&(final?.pack[product]??0)===0;
 return{ok,recipe:o.recipe,product,made,banked,preserved,uncertain,receipts,ticks:raw.tick()-start,failure:failure||'-'};
}
if(import.meta.main){
 const [actor,path]=process.argv.slice(2);if(!actor||!path)throw Error('account and finite jewellery order JSON required');const order=JSON.parse(readFileSync(path,'utf8')) as JewelleryOrder;validateJewelleryOrder(order);
 let stopped=false;const s=await openBot(actor,{onStop:async()=>{stopped=true;}});
 const cleanup=jewelleryCleanup(s);
 try{const result=await runJewelleryOrder(s,order,()=>stopped);if(!cleanup.owns()){result.ok=false;result.failure='jewellery original session replaced; cleanup refused';}console.log('JEWELLERY_ORDER '+JSON.stringify(result));process.exitCode=await cleanup.finish(result.ok,JSON.stringify(result))?0:1;}catch(error){await cleanup.finish(false,String(error));throw error;}
}
