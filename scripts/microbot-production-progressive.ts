import {readFileSync,existsSync} from 'node:fs';
import {openBot,settle} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {inventoryRecipes,runInventoryBank,type InventoryRecipe} from './microbot-production';
import {runShafts} from './fletch-shafts';
import {runBankJob,type Tile} from './microbot-bank-jobs';
import {cookingRecipes,type CookRecipe} from './microbot-b-cooking';
import {productionStopRequested} from './microbot-c-lifetime';

export type ProgressiveProduction={mode:'fletch'|'string'|'craft-staff'|'craft-glass'|'cooking-prepared'|'burn-bake';targetLevel:number;maximum:number;batch:number;reserve:number;cap:number;members:boolean;bank:Tile;site?:Tile};
type Snapshot={assets:Record<number,number>;gear:{id:number;slot:number;count:number}[]};
export type ProgressiveStage={name:string;skill:'Fletching'|'Crafting'|'Cooking';level:number;inputs:{id:number;units:number}[];tools:number[];recipe?:InventoryRecipe;cooking?:CookRecipe;shafts?:true};
export type ProgressiveDeps={recipes?:readonly InventoryRecipe[];cooks?:readonly CookRecipe[];audit?:()=>Promise<Snapshot>;inventory?:typeof runInventoryBank;shafts?:typeof runShafts;cook?:typeof runBankJob};
const equal=(a:Record<number,number>,b:Record<number,number>)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>(a[+k]??0)===(b[+k]??0));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const packed=new Map(readFileSync(new URL('../vendor/rs-sdk/server/content/pack/obj.pack',import.meta.url),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(\w+)$/);return m?[[m[2]!,Number(m[1])]as const]:[];}));
const certificates=new Map([...packed].flatMap(([name,id])=>name.startsWith('cert_')&&packed.has(name.slice(5))?[[id,packed.get(name.slice(5))!]as const]:[]));
export function validateProgressiveProduction(o:ProgressiveProduction){
 if(!o||!['fletch','string','craft-staff','craft-glass','cooking-prepared','burn-bake'].includes(o.mode)||!Number.isSafeInteger(o.targetLevel)||o.targetLevel<1||o.targetLevel>99||!Number.isSafeInteger(o.maximum)||o.maximum<1||o.maximum>10000||!Number.isSafeInteger(o.batch)||o.batch<1||o.batch>24||!Number.isSafeInteger(o.reserve)||o.reserve<0||!Number.isSafeInteger(o.cap)||o.cap<300||o.cap>100000||typeof o.members!=='boolean')throw Error('invalid finite progressive production');
 for(const t of [o.bank,...o.site?[o.site]:[]])if(!t||![t.x,t.z,t.level].every(Number.isSafeInteger)||t.x<0||t.x>16383||t.z<0||t.z>16383||t.level<0||t.level>3)throw Error('progressive bank/site unknown');
 if(['cooking-prepared','burn-bake'].includes(o.mode)&&!o.site)throw Error('cooking requires declared native oven site');
}
// Donor FletchingScript.calculateItemToFletch: highest configured legacy tier, no stock fallback.
export function progressiveStage(mode:ProgressiveProduction['mode'],level:number,recipes:readonly InventoryRecipe[]=inventoryRecipes(),cooks:readonly CookRecipe[]=cookingRecipes().recipes):ProgressiveStage{
 if(!Number.isSafeInteger(level)||level<1||level>99)throw Error('progressive base level unknown');
 if(mode==='craft-staff'||mode==='craft-glass'){
  const names=mode==='craft-staff'?['water-battlestaff','earth-battlestaff','fire-battlestaff','air-battlestaff']:['glass:beer_glass','glass:vial_empty','glass:stafforb'];
  const eligible=names.map(n=>{const r=recipes.find(r=>r.name===n);if(!r||r.skill!=='Crafting')throw Error('native progressive Crafting descriptor absent '+n);return r;}).filter(r=>r.level<=level).sort((a,b)=>b.level-a.level),recipe=eligible[0];
  if(!recipe)throw Error('progressive native staff requires Crafting54');return{name:recipe.name,skill:'Crafting',level:recipe.level,inputs:recipe.inputs,tools:recipe.tools,recipe};
 }
 if(mode==='cooking-prepared'||mode==='burn-bake'){
  const key=level<25?'bread':level<41?'stew':'cake',recipe=cooks.find(r=>r.name==='cooking_generic_'+key)||cooks.find(r=>r.name.endsWith('_'+key));
  if(!recipe||recipe.level>level||!recipe.range)throw Error('native progressive cooking recipe/oven contract absent');return{name:recipe.name,skill:'Cooking',level:recipe.level,inputs:[{id:recipe.raw,units:1}],tools:[],cooking:recipe};
 }
 if(level<5){if(mode==='string')throw Error('progressive stringing requires Fletching5');return{name:'shafts',skill:'Fletching',level:1,inputs:[{id:1511,units:1}],tools:[946],shafts:true};}
 const prefix=mode==='fletch'?'cut-bow:':'bow-string:',recipe=recipes.filter(r=>r.name.startsWith(prefix)&&r.level<=level).sort((a,b)=>b.level-a.level)[0];
 if(!recipe)throw Error('native progressive bow recipe absent');return{name:recipe.name,skill:'Fletching',level:recipe.level,inputs:recipe.inputs,tools:recipe.tools,recipe};
}
// Only the donor's three named preparation chains; all item effects stay in runInventoryBank.
export function burnBakePreparation(stage:ProgressiveStage,stock:Record<number,number>,floor:Record<number,number>,recipes:readonly InventoryRecipe[]=inventoryRecipes()){
 const get=(name:string)=>{const r=recipes.find(r=>r.name===name);if(!r)throw Error('native BurnBaking preparation absent '+name);return r;};
 const available=(id:number)=>(stock[id]??0)-(floor[id]??0);
 let steps:InventoryRecipe[];
 if(stage.name==='cooking_generic_bread')steps=[get('dough:bread:bucket_water')];
 else if(stage.name==='cooking_generic_cake')steps=[get('prepare:cake')];
 else if(stage.name==='cooking_generic_stew'){
  const finish=available(2142)>0?get('prepare:uncooked-stew'):available(2140)>0?get('prepare:uncooked-stew-chicken'):undefined;
  if(available(1997)>0&&finish)steps=[finish];
  else if(available(1999)>0&&available(1942)>0)steps=[get('prepare:uncooked-stew-potato')];
  else if(finish)steps=[get('prepare:potato-stew'),finish];
  else throw Error('owned cooked meat/chicken unavailable for BurnBaking stew');
 }else throw Error('unknown native BurnBaking stage');
 const produced=new Set<number>();let capacity=2147483647;
 for(const step of steps){for(const i of step.inputs)if(!produced.has(i.id))capacity=Math.min(capacity,Math.floor(available(i.id)/i.units));produced.add(step.product);}
 return{steps,capacity:Math.max(0,capacity)};
}
export async function runProgressiveProduction(original:Session,o:ProgressiveProduction,requested:()=>boolean=()=>false,deps:ProgressiveDeps={}){
 validateProgressiveProduction(o);const recipes=deps.recipes??inventoryRecipes(),cooks=deps.cooks??cookingRecipes().recipes,skill=o.mode==='fletch'||o.mode==='string'?'Fletching':o.mode==='craft-staff'||o.mode==='craft-glass'?'Crafting':'Cooking';
 const first=original.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,hp=original.sdk.getSkill('Hitpoints')?.level??0,client=original.client,executor=(client as any)?.executeBotAction,start=original.tick();let ended=false,lost=false;void original.ended.then(()=>{ended=true;});
 const fatal=()=>{const p=original.sdk.getState()?.player;if(original.client!==client||(client as any)?.executeBotAction!==executor)lost=true;return lost||typeof executor!=='function'||ended||!p||!first||life===undefined||p.lifeId!==life||(p.respawnCount??0)!==respawns||p.isDead||hp<1||(original.sdk.getSkill('Hitpoints')?.level??0)<hp;};
 const stop=()=>fatal()||productionStopRequested(original.name,requested,existsSync,process.env.STOP_FILE??'.practice/stop-microbot-production-progressive')||original.tick()-start>=o.cap-120;
 const sdk=new Proxy(original.sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(typeof key==='string'&&key.startsWith('send')&&(fatal()||original.tick()-start>=o.cap))throw Error('progressive original input owner/life unavailable');return v.apply(receiver,args);}:v;}}),s={...original,sdk,bot:new BotActions(sdk),direct:async(action:Parameters<Session['direct']>[0])=>{if(fatal()||original.tick()-start>=o.cap)throw Error('progressive direct original owner/life unavailable');return original.direct(action);}}as Session;
 const level=()=>s.sdk.getSkill(skill)?.baseLevel??0,initialLevel=level(),receipts:{stage:string;levelBefore:number;levelAfter:number;processed:number;products:Record<number,number>;result:unknown}[]=[],preparations:{stage:string;processed:number;result:unknown}[]=[];
 let initial:Snapshot|undefined,final:Snapshot|undefined,processed=0,failure='',reason='maximum',expected:Record<number,number>={},floors:Record<number,number>={},uncertain=false;
 const audit=deps.audit??(async()=>{
  if(fatal()||original.tick()-start>=o.cap-20)throw Error('progressive audit original life/budget unavailable');const at=s.sdk.getState()?.player;if(!at||at.level!==o.bank.level||Math.max(Math.abs(at.worldX-o.bank.x),Math.abs(at.worldZ-o.bank.z))>3)throw Error('progressive original bank position absent');
  const t=s.tick();await s.sdk.sendCloseModal();if(!await waitUntil(s,()=>fatal()||s.tick()>t&&!s.sdk.getState()?.bank.isOpen&&!s.sdk.getState()?.interface.isOpen&&!s.sdk.getState()?.dialog.isOpen,{timeoutTicks:12})||fatal())throw Error('progressive observed modal close absent');
  const g=s.bankObservation?.()?.generation??-1;if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>fatal()||!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>g,{timeoutTicks:12})||fatal())throw Error('progressive fresh bank unavailable');
  const view=()=>{const b=s.bankObservation?.();if(!b||!s.sdk.getState()?.bank.isOpen)throw Error('progressive bank unknown');const gear=s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot),assets:Record<number,number>={};for(const i of [...b.items,...s.sdk.getInventory(),...gear]){const id=certificates.get(i.id)??i.id;assets[id]=(assets[id]??0)+i.count;}return{assets,gear};};
  const before=view();for(const id of new Set(s.sdk.getInventory().map(i=>i.id))){if(fatal())throw Error('progressive deposit owner unavailable');const row=s.sdk.getInventory().find(i=>i.id===id);if(row)await depositObserved(s,row);}const after=view();if(!equal(before.assets,after.assets)||!same(before.gear,after.gear))throw Error('progressive stock deposit changed assets/gear');await s.bot.closeBank();return after;
 });
 try{
  if(fatal()||stop()||initialLevel<1)throw Error('progressive entry life/level/stop unavailable');if(o.members&&(client as any).membersAccount!==1)throw Error('progressive member account unknown');initial=await audit();expected={...initial.assets};floors=Object.fromEntries(Object.entries(initial.assets).map(([id,n])=>[id,Math.min(n,o.reserve)]));
  while(processed<o.maximum&&level()<o.targetLevel){
   if(stop()){reason='stopped';throw Error('progressive stopped before next batch');}const before=await audit();if(!equal(expected,before.assets)||!same(initial.gear,before.gear))throw Error('progressive all-assets/gear drift before batch');const stage=progressiveStage(o.mode,level(),recipes,cooks),base=level();
   if(stage.recipe?.members&&!o.members)throw Error('progressive recipe requires member account');if(stage.tools.some(id=>(before.assets[id]??0)<1))throw Error('selected progressive tool unavailable');
   let n=Math.min(o.batch,o.maximum-processed,...stage.inputs.map(i=>Math.floor(((before.assets[i.id]??0)-(floors[i.id]??0))/i.units)));
   if(n<1&&o.mode==='burn-bake'){
    const prep=burnBakePreparation(stage,before.assets,floors,recipes);n=Math.min(o.batch,o.maximum-processed,prep.capacity);if(n<1)throw Error('selected BurnBaking ingredients/reserve unavailable');
    for(const recipe of prep.steps){if(stop())throw Error('BurnBaking stopped before preparation');const known=await audit();if(!equal(expected,known.assets)||!same(initial.gear,known.gear))throw Error('BurnBaking preparation stock drift');const remaining=o.cap-(s.tick()-start)-60;if(remaining<180)throw Error('BurnBaking preparation/cleanup budget unavailable');uncertain=true;
     const r=await(deps.inventory??runInventoryBank)(s,recipe,{maximum:n,maxAttempts:n,cap:remaining,reserve:Math.min(...recipe.inputs.map(i=>floors[i.id]??0)),members:o.members,stop});if(!r.ok||r.attempts!==n||r.losses||r.made!==n||r.banked!==n)throw Error('BurnBaking preparation receipt incomplete');
     for(const i of recipe.inputs)expected[i.id]=(expected[i.id]??0)-n*i.units;expected[recipe.product]=(expected[recipe.product]??0)+n;for(const i of recipe.byproducts??[])expected[i.id]=(expected[i.id]??0)+n*i.units;preparations.push({stage:recipe.name,processed:n,result:r});final=await audit();if(!equal(expected,final.assets)||!same(initial.gear,final.gear))throw Error('BurnBaking exact preparation asset receipt invalid');uncertain=false;
    }
   }
   if(n<1)throw Error('selected progressive tier owned inputs/reserve unavailable');
   const remaining=o.cap-(s.tick()-start)-60;if(remaining<180)throw Error('progressive batch/cleanup budget unavailable');let result:any,products:Record<number,number>={};uncertain=true;
   const reserve=Math.min(...stage.inputs.map(i=>floors[i.id]??0));
   if(stage.shafts){result=await(deps.shafts??runShafts)(s,{cap:remaining,maximum:n,reserve,bankKnife:true,stop});if(!result.ok||result.logsUsed!==n||result.made!==n*15||result.banked!==result.made)throw Error('progressive shafts batch incomplete');products[52]=result.made;}
   else if(stage.recipe){result=await(deps.inventory??runInventoryBank)(s,stage.recipe,{maximum:n*(stage.recipe.productUnits??1),maxAttempts:n,cap:remaining,reserve,members:o.members,stop});if(!result.ok||result.attempts!==n||result.losses||result.made!==n*(stage.recipe.productUnits??1)||result.banked!==result.made)throw Error('progressive inventory batch incomplete');products[stage.recipe.product]=result.made;for(const p of stage.recipe.byproducts??[])products[p.id]=n*p.units;}
   else{const r=stage.cooking!;result=await(deps.cook??runBankJob)(s,{family:'cooking',recipe:r.name,target:n,batch:n,cap:remaining,returnTicks:120,members:o.members,reserve,bank:o.bank,site:o.site,heat:'range'},stop);if(!result.ok||!result.atBank||result.completed!==n)throw Error('progressive prepared cooking batch incomplete');products={...result.banked};const expectedProducts=[...r.products,...r.burnt===undefined?[]:[r.burnt]];if(expectedProducts.reduce((sum,id)=>sum+(products[id]??0),0)!==n||Object.keys(products).some(id=>!expectedProducts.includes(+id)&&+id!==r.additional)||r.additional!==undefined&&(products[r.additional]??0)!==n)throw Error('progressive cooking product/container receipt invalid');}
   for(const i of stage.inputs)expected[i.id]=(expected[i.id]??0)-n*i.units;for(const[id,count]of Object.entries(products))expected[+id]=(expected[+id]??0)+count;processed+=n;receipts.push({stage:stage.name,levelBefore:base,levelAfter:level(),processed:n,products,result});final=await audit();if(!equal(expected,final.assets)||!same(initial.gear,final.gear))throw Error('progressive exact batch asset/gear receipt invalid');uncertain=false;
  }
  reason=level()>=o.targetLevel?'target-level':'maximum';
 }catch(error){failure=String(error);}
 finally{if(initial&&!fatal()&&!uncertain)try{final=await audit();}catch(error){failure||=String(error);}}
 const preserved=!uncertain&&!fatal()&&!!initial&&!!final&&equal(expected,final.assets)&&same(initial.gear,final.gear),targetMet=level()>=o.targetLevel;
 return{ok:!failure&&!fatal()&&preserved&&!uncertain&&(targetMet||processed===o.maximum),mode:o.mode,skill,processed,initialLevel,finalLevel:level(),targetMet,stop:reason,receipts,preparations,preserved,banked:!!final&&!uncertain,uncertain,ticks:s.tick()-start,failure:failure||'-',scope:o.mode==='burn-bake'?'owned bank ingredient preparation or prepared raw food, bread/stew/cake level selection, native oven and bank return; no external ingredient acquisition':o.mode==='cooking-prepared'?'prepared bread/stew/cake level selection and native oven/bank route; no ingredient acquisition/preparation claim':o.mode==='craft-staff'||o.mode==='craft-glass'?'automatic native water/earth/fire/air battlestaff or beer-glass/vial/orb tiers; modern lamp, fishbowl, lens and light-orb glass not supplied; no lower-tier stock fallback':'automatic native legacy level selection; no lower-tier stock fallback'};
}
if(import.meta.main){const[actor,file]=process.argv.slice(2);if(!actor||!file)throw Error('usage: microbot-production-progressive.ts account finite-policy.json');const o=JSON.parse(readFileSync(file,'utf8'))as ProgressiveProduction;validateProgressiveProduction(o);inventoryRecipes();cookingRecipes();let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});const s=await openBot(actor);try{const result=await runProgressiveProduction(s,o,()=>stopped);console.log('PROGRESSIVE_PRODUCTION '+JSON.stringify(result));process.exitCode=await settle([s],result.ok,JSON.stringify(result))?0:1;}catch(error){await settle([s],false,String(error));throw error;}}
