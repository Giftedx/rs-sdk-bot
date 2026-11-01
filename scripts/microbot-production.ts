// Inventory production behaviours adapted from Microbot-Hub. BSD notice: research/microbot-ports-LICENSE.txt.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export type InventoryRecipe={name:string;inputs:{id:number;units:number}[];tools:number[];product:number;productUnits?:number;lossProduct?:number;byproducts?:{id:number;units:number}[];optionalInputs?:number[];menu?:string;extraSlot?:boolean;itemOption?:number;skill:'Crafting'|'Cooking'|'Fletching'|'Herblore';level:number;xp:boolean;members:boolean;source:string};
export type ProductionSnapshot={items:Record<number,number>;xp:number};
export interface ProductionIO {
 tick():number;stopped():boolean;level():number;read():ProductionSnapshot;
 prepare():Promise<boolean>;use():Promise<unknown>;wait(done:()=>boolean):Promise<unknown>;
 deposit(id:number):Promise<number>;close():Promise<void>;
}
export function inventoryRecipes():InventoryRecipe[]{
 const root=resolve(import.meta.dir,'..'),content='vendor/rs-sdk/server/content/';
 const names=new Map(readFileSync(resolve(root,content,'pack/obj.pack'),'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const at=l.indexOf('=');return[l.slice(at+1),Number(l.slice(0,at))];}));
 const id=(name:string)=>{const value=names.get(name);if(value===undefined)throw Error('unknown production item '+name);return value;};
 const recipes:InventoryRecipe[]=[];
 const add=(name:string,inputs:string[],product:string,skill:InventoryRecipe['skill'],level:number,xp:boolean,source:string,tools:string[]=[],members=false,loss?:string)=>
  recipes.push({name,inputs:inputs.map(n=>({id:id(n),units:1})),product:id(product),skill,level,xp,source:content+source,tools:tools.map(id),members,...(loss?{lossProduct:id(loss)}:{})});
 const pie='scripts/skill_cooking/scripts/cooking_inv/scripts/pies/pies.rs2';
 add('pie-shell',['pastry_dough','piedish'],'pie_shell','Cooking',1,false,pie);
 for(const [name,ingredient,level] of [['apple','cooking_apple',30],['meat','cooked_meat',20],['redberry','redberries',10]] as const)
  add('raw-'+name+'-pie',['pie_shell',ingredient],'uncooked_'+name+'_pie','Cooking',level,false,pie);
 add('wine-unfermented',['grapes','jug_water'],'jug_unfermented_wine','Cooking',35,false,'scripts/skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2');
 const gem='scripts/skill_crafting/scripts/gem/uncut_gem.rs2';
 for(const [name,level,fragile,members] of [['sapphire',20,false,false],['emerald',27,false,false],['ruby',34,false,false],['diamond',43,false,false],['dragonstone',55,false,true],['opal',1,true,true],['jade',13,true,true],['red_topaz',16,true,true]] as const)
  add('cut-'+name,['uncut_'+name],name,'Crafting',level,true,gem,['chisel'],members,fragile?'crushed_gemstone':undefined);
 for(const [name,level] of [['water',54],['earth',58],['fire',62],['air',66]] as const)
  add(name+'-battlestaff',['battlestaff',name+'_orb'],name+'_battlestaff','Crafting',level,true,'scripts/skill_crafting/scripts/battlestaves/battlestaves.rs2',[],true);
 for(const name of ['gold','sapphire','emerald','ruby','diamond','dragonstone'])
  add('string-'+name+'-amulet',['ball_of_wool','unstrung_'+name+'_amulet'],'strung_'+name+'_amulet','Crafting',1,true,'scripts/skill_crafting/scripts/jewellery/stringing.rs2',[],name==='dragonstone');
 const blocks=(file:string)=>[...readFileSync(resolve(root,content,file),'utf8').matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m=>({name:m[1]!,body:m[2]!}));
 const field=(body:string,key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim();
 const softMenus:Record<string,string>={leather_armour:'113',leather_gloves:'116',leather_boots:'119',leather_vambraces:'122',leather_chaps:'125',coif:'128',leather_cowl:'131'};
 for(const row of blocks('scripts/skill_crafting/configs/leather/leather.dbrow').filter(r=>r.body.includes('table=craft_leather_table'))){
  const product=field(row.body,'product')!,[leather,units]=field(row.body,'leather')!.split(',');
  add('leather:'+product,[leather!],product,'Crafting',Number(field(row.body,'levelrequired')),true,'scripts/skill_crafting/scripts/leather/leather.rs2',['needle'],field(row.body,'members')==='true');
  const recipe=recipes.at(-1)!;recipe.inputs[0]!.units=Number(units);recipe.optionalInputs=[id('thread')];
  if(softMenus[product])recipe.menu='leather_crafting:com_'+softMenus[product];
  else if(product!=='hardleather_body')recipe.menu='skill_multi3:make1_'+(product.includes('vambraces')?'b':product.includes('chaps')?'c':'a');
 }
 for(const [product,level,letter] of [['beer_glass',1,'a'],['vial_empty',33,'b'],['stafforb',46,'c']] as const){
  add('glass:'+product,['molten_glass'],product,'Crafting',level,true,'scripts/skill_crafting/scripts/glass/glass.rs2',['glassblowingpipe'],true);
  recipes.at(-1)!.menu='skill_multi3:make1_'+letter;
 }
 for(const row of blocks('scripts/skill_fletching/configs/stringing/bows.dbrow')){
  const input=field(row.body,'item'),value=field(row.body,'product');if(!input||!value)continue;
  const product=value.split(',')[0]!;
  add('bow-string:'+product,[input,'bow_string'],product,'Fletching',Number(field(row.body,'level')),true,'scripts/skill_fletching/scripts/bows.rs2',[],true);
 }
 for(const row of blocks('scripts/skill_fletching/configs/cut_logs/cut_logs.dbrow')){
  const log=field(row.body,'log');if(!log)continue;const three=Number(field(row.body,'shafts')??0)>0;
  for(const shape of ['shortbow','longbow'] as const){const value=field(row.body,shape);if(!value)continue;const [product,level]=value.split(',');
   add('cut-bow:'+product,[log],product!,'Fletching',Number(level),true,'scripts/skill_fletching/scripts/cut_logs.rs2',['knife'],true);
   recipes.at(-1)!.menu=`skill_multi${three?'3':'2'}:make1_${shape==='shortbow'?(three?'b':'a'):(three?'c':'b')}`;
  }
 }
 for(const row of blocks('scripts/skill_fletching/configs/darts/darts.dbrow')){
  const input=field(row.body,'item'),value=field(row.body,'product');if(!input||!value)continue;
  const [product,units]=value.split(',');
  add('darts:'+product,[input,'feather'],product!,'Fletching',Number(field(row.body,'level')),true,'scripts/skill_fletching/scripts/darts.rs2',[],true);
  const recipe=recipes.at(-1)!;recipe.productUnits=Number(units);for(const ingredient of recipe.inputs)ingredient.units=Number(units);
 }
 for(const row of blocks('scripts/skill_fletching/configs/bolts/bolts.dbrow')){
  const input=field(row.body,'item'),value=field(row.body,'product');if(!input||!value)continue;
  const [product,units]=value.split(','),tips=product!.endsWith('bolttips');
  add((tips?'bolt-tips:':'tip-bolts:')+product,[input,...(tips?[]:['bolt'])],product!,'Fletching',Number(field(row.body,'level')),true,'scripts/skill_fletching/scripts/bolts.rs2',tips?['chisel']:[],true);
  const recipe=recipes.at(-1)!;recipe.productUnits=Number(units);if(!tips)for(const ingredient of recipe.inputs)ingredient.units=Number(units);
 }
 const param=(body:string,key:string)=>body.match(new RegExp('^param='+key+',(.+)$','m'))?.[1]?.trim();
 const herbFiles=['scripts/skill_herblore/configs/herbs.obj'];
 const herbs=herbFiles.flatMap(blocks);
 const identify='scripts/skill_herblore/scripts/identifying/identify.rs2';
 const identifyText=readFileSync(resolve(root,content,identify),'utf8');
 for(const m of identifyText.matchAll(/\[opheld1,([^\]]+)\]\s*~attempt_identify_herb\((\w+),/g)){
  const herb=herbs.find(r=>r.name===m[2]),level=Number(param(herb?.body??'','identified_herb_level')??3),xp=Number(param(herb?.body??'','identified_herb_exp')??0);
  add('identify:'+m[2],[m[1]!],m[2]!,'Herblore',level,xp>0,identify,[],true);recipes.at(-1)!.itemOption=1;
 }
 for(const row of blocks('scripts/skill_herblore/configs/brewing/brew_potion.struct').filter(r=>/^(unf_|3dose)/.test(r.name))){
  const ingredient=param(row.body,'brew_potion_ingredient'),solvent=param(row.body,'brew_potion_solvent'),product=param(row.body,'brew_potion_mixture');
  if(!ingredient||!solvent||!product)continue;
  add('brew:'+row.name,[ingredient,solvent],product,'Herblore',Number(param(row.body,'brew_potion_level')??3),Number(param(row.body,'brew_potion_exp')??0)>0,'scripts/skill_herblore/scripts/brewing/brew_potion.rs2',[],true);
 }
 for(const row of blocks('scripts/skill_herblore/configs/grinding/grindables.obj').filter(r=>['unicorn_horn','blue_dragon_scale','bat_bones'].includes(r.name))){
  add('grind:'+row.name,[row.name],param(row.body,'grindable_ingredient_refined')!,'Herblore',1,false,'scripts/skill_herblore/scripts/grinding/grind_ingredient.rs2',['pestle_and_mortar'],true);
 }
 const cooking='scripts/skill_cooking/scripts/cooking_inv/scripts/';
 for(const water of blocks('scripts/general_use/configs/water_sources.obj').filter(r=>param(r.body,'is_water_source')==='^true')){
  for(const [kind,product,option] of [['bread','bread_dough',1],['pastry','pastry_dough',2],['pizza','pizza_base',3],['pitta','uncooked_pitta_bread',4]] as const){
   add('dough:'+kind+':'+water.name,['pot_flour',water.name],product,'Cooking',1,false,cooking+'dough/dough.rs2',[],kind==='pitta'||/^members=yes$/m.test(water.body));
   const recipe=recipes.at(-1)!;recipe.menu='multi4:com_'+option;recipe.extraSlot=true;
   recipe.byproducts=[{id:id('pot_empty'),units:1},{id:id(param(water.body,'next_obj_stage')!),units:1}];
  }
 }
 add('prepare:cake',['cake_tin','pot_flour','egg','bucket_milk'],'uncooked_cake','Cooking',1,false,cooking+'cakes/cakes.rs2');
 recipes.at(-1)!.byproducts=[{id:id('pot_empty'),units:1},{id:id('bucket_empty'),units:1}];
 add('prepare:chocolate-cake',['cake','chocolate_bar'],'chocolate_cake','Cooking',50,true,cooking+'cakes/cakes.rs2');
 const stew=cooking+'stew/stew.rs2';
 add('prepare:potato-stew',['potato','bowl_water'],'stew1','Cooking',25,false,stew);
 add('prepare:meat-stew',['cooked_meat','bowl_water'],'stew2','Cooking',25,false,stew);
 add('prepare:uncooked-stew',['stew1','cooked_meat'],'uncooked_stew','Cooking',25,false,stew);
 add('prepare:uncooked-stew-potato',['stew2','potato'],'uncooked_stew','Cooking',25,false,stew);
 add('prepare:curry',['uncooked_stew','spicespot'],'uncooked_curry','Cooking',25,false,stew,[],true);
 const pizza=cooking+'pizza/pizza.rs2';
 add('prepare:tomato-pizza',['pizza_base','tomato'],'incomplete_pizza','Cooking',35,false,pizza);
 add('prepare:uncooked-pizza',['incomplete_pizza','cheese'],'uncooked_pizza','Cooking',35,false,pizza);
 for(const [topping,product,level,members] of [['cooked_meat','meat_pizza',45,false],['cooked_chicken','meat_pizza',45,false],['anchovies','anchovie_pizza',55,false],['pineapple_ring','pineapple_pizza',65,true],['pineapple_chunks','pineapple_pizza',65,true]] as const)
  add('top-pizza:'+topping,['plain_pizza',topping],product,'Cooking',level,true,pizza,[],members);
 return recipes;
}
export function productionEffect(r:InventoryRecipe,b:ProductionSnapshot,a:ProductionSnapshot):'none'|'made'|'loss'|'invalid'{
 const keys=new Set([...Object.keys(b.items),...Object.keys(a.items)].map(Number));
 if([...keys].every(id=>(a.items[id]??0)===(b.items[id]??0))&&a.xp===b.xp)return 'none';
 if(r.xp&&a.xp<=b.xp)return 'invalid';
 for(const [product,kind] of [[r.product,'made'],[r.lossProduct,'loss']] as const){
  if(product===undefined)continue;
  const expected=new Map<number,number>();
  for(const i of r.inputs)expected.set(i.id,(expected.get(i.id)??0)-i.units);
  expected.set(product,(expected.get(product)??0)+(kind==='made'?(r.productUnits??1):1));
  if(kind==='made')for(const i of r.byproducts??[])expected.set(i.id,(expected.get(i.id)??0)+i.units);
  const all=new Set([...keys,...expected.keys()]);
  if([...all].every(id=>r.optionalInputs?.includes(id)?[0,-1].includes((a.items[id]??0)-(b.items[id]??0)):
   (a.items[id]??0)-(b.items[id]??0)===(expected.get(id)??0)))return kind;
 }
 return 'invalid';
}
export async function runInventoryProduction(io:ProductionIO,r:InventoryRecipe,o:{maximum:number;cap:number;maxAttempts:number}){
 const units=r.productUnits??1;
 if(![o.maximum,o.cap,o.maxAttempts].every(n=>Number.isSafeInteger(n)&&n>0)||o.maximum%units||o.maxAttempts<o.maximum/units)throw Error('invalid production limits or output batch multiple');
 const start=io.tick(),over=()=>io.stopped()||io.tick()-start>=o.cap;
 let made=0,banked=0,losses=0,attempts=0,failure='';
 try{
  if(io.level()<r.level)throw Error('production level missing');
  while(made<o.maximum&&attempts<o.maxAttempts&&!over()){
   if(!await io.prepare())throw Error('production inputs unavailable');
   if(over())break;
   const before=io.read();
   if(r.inputs.some(i=>(before.items[i.id]??0)<i.units)||[...r.tools,...r.optionalInputs??[]].some(id=>(before.items[id]??0)<1))throw Error('production input observation missing');
   attempts++;await io.use();
   await io.wait(()=>over()||productionEffect(r,before,io.read())!=='none');
   const effect=productionEffect(r,before,io.read());
   if(effect==='made'){made+=units;const n=await io.deposit(r.product);if(n!==units)throw Error('production bank credit mismatch');banked+=n;
    for(const byproduct of r.byproducts??[])if(await io.deposit(byproduct.id)!==byproduct.units)throw Error('production container bank credit mismatch');}
   else if(effect==='loss'){losses++;if(await io.deposit(r.lossProduct!)!==1)throw Error('production loss bank credit mismatch');}
   else throw Error('production action receipt '+effect);
  }
  if(made!==o.maximum||banked!==made||over())throw Error('production target incomplete');
 }catch(e){failure=String(e);}
 finally{try{await io.close();}catch(e){failure||=String(e);}}
 return{ok:!failure,recipe:r.name,made,banked,losses,attempts,ticks:io.tick()-start,failure:failure||'-'};
}
export async function runInventoryBank(s:import('../packages/core/src/inprocess').Session,r:InventoryRecipe,o:{maximum:number;cap:number;maxAttempts:number;reserve?:number;members?:boolean;stop?:()=>boolean}){
 const {waitUntil}=await import('../packages/core/src/ticks');
 const {depositObserved}=await import('../packages/core/src/deposit');
 const {componentId}=await import('../packages/core/src/logout');
 if(r.members&&!o.members)throw Error('production recipe requires confirmed members world');
 const reserve=o.reserve??0;if(!Number.isSafeInteger(reserve)||reserve<0)throw Error('invalid production reserve');
 if(!await waitUntil(s,()=>!!s.sdk.getState()?.player&&!!s.sdk.getSkill(r.skill),{timeoutTicks:10}))throw Error('production state unavailable');
 const inv=()=>s.sdk.getInventory(),count=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const initial=s.sdk.getState()!.player!;let ended=false;void s.ended.then(()=>{ended=true;});
 const stopped=()=>{const p=s.sdk.getState()?.player;return ended||!!o.stop?.()||!p||p.isDead||(s.sdk.getSkill('Hitpoints')?.level??0)<=0||
  (p.respawnCount??0)>(initial.respawnCount??0)||initial.lifeId!==undefined&&p.lifeId!==initial.lifeId;};
 if([r.product,...r.lossProduct!==undefined?[r.lossProduct]:[],...(r.byproducts??[]).map(i=>i.id)].some(id=>count(id)))throw Error('bank existing production outputs and returned containers before entry');
 const read=():ProductionSnapshot=>{const items:Record<number,number>={};for(const i of inv())items[i.id]=(items[i.id]??0)+i.count;return{items,xp:s.sdk.getSkillXp(r.skill)??0};};
 const open=async()=>{
  if(stopped())throw Error('production session stopped');
  const state=()=>s.sdk.getState(),ready=()=>!!state()?.bank?.isOpen&&!!s.bankObservation?.();
  if(ready())return;
  if(state()?.dialog?.isOpen||state()?.interface?.isOpen){
   await s.direct({type:'closeModal',reason:'production bank access'});
   if(!await waitUntil(s,()=>!state()?.dialog?.isOpen&&!state()?.interface?.isOpen,{timeoutTicks:8}))throw Error('production blocking interface remains');
  }
  const generation=s.bankObservation?.()?.generation??-1;
  if(stopped()||!(await s.bot.openBank()).success)throw Error('production bank unavailable');
  if(!await waitUntil(s,()=>ready()&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('production fresh bank unknown');
 };
 const result=await runInventoryProduction({tick:()=>s.tick(),stopped,level:()=>s.sdk.getSkill(r.skill)?.level??0,read,
  prepare:async()=>{
   await open();
   for(const need of [...[...r.tools,...r.optionalInputs??[]].map(id=>({id,units:1})),...r.inputs]){
    const missing=Math.max(0,need.units-count(need.id));if(!missing)continue;
    const item=s.bankObservation?.()?.items.find(i=>i.id===need.id);
    if(!item||item.count-missing<(r.inputs.some(i=>i.id===need.id)?reserve:0))return false;
    const target=s.sdk.getState()?.bank?.items.find(i=>i.id===need.id);
    if(!target||!Number.isSafeInteger(target.slot))return false;
    const before=count(need.id);const response=await s.bot.withdrawItem(target,missing,{asNote:false});
    if(!response.success||!await waitUntil(s,()=>count(need.id)===before+missing,{timeoutTicks:8}))return false;
   }
   if(r.extraSlot&&inv().length>=28)return false;
   await s.bot.closeBank();if(!await waitUntil(s,()=>!s.sdk.getState()?.bank?.isOpen,{timeoutTicks:8}))return false;return !stopped();
  },
  use:async()=>{
   if(s.sdk.getDialog()?.isOpen||s.sdk.getState()?.interface?.isOpen)await s.direct({type:'closeModal',reason:'SDK'});
   const source=inv().find(i=>i.id===(r.tools[0]??r.inputs[0]!.id));
   if(r.itemOption!==undefined){if(!source)throw Error('production item action missing');return s.sdk.sendUseItem(source.slot,r.itemOption);}
   const target=inv().find(i=>i.id===(r.tools.length?r.inputs[0]!.id:r.inputs[1]!.id));
   if(!source||!target)throw Error('production dispatch inventory missing');
   const response=await s.sdk.sendUseItemOnItem(source.slot,target.slot);
   if(r.menu){
    if(!await waitUntil(s,()=>stopped()||!!s.sdk.getState()?.interface?.isOpen||!!s.sdk.getDialog()?.isOpen,{timeoutTicks:8}))throw Error('production selection interface absent');
    if(stopped())throw Error('production stopped before selection');
    await s.sdk.sendClickComponent(componentId(r.menu));
   }
   return response;
  },
  wait:done=>waitUntil(s,done,{timeoutTicks:10}),
  deposit:async id=>{await open();const item=inv().find(i=>i.id===id);return item?depositObserved(s,item):0;},
  close:async()=>{if(!stopped())await s.bot.closeBank();}
 },r,o);
 if(stopped()){result.ok=false;result.failure='production session stopped';}
 console.log('MICROBOT_PRODUCTION '+JSON.stringify(result));return result;
}
if(import.meta.main){
 const r=inventoryRecipes().find(r=>r.name===process.argv[3]);if(!r)throw Error('unknown inventory recipe');
 const maximum=Number(process.env.MAX_MAKE??1),cap=Number(process.env.CAP??500),maxAttempts=Number(process.env.MAX_ATTEMPTS??maximum);
 if(![maximum,cap,maxAttempts].every(n=>Number.isSafeInteger(n)&&n>0)||maximum%(r.productUnits??1)||maxAttempts<maximum/(r.productUnits??1))throw Error('invalid production limits');
 const {openBot,finish}=await import('../packages/core/src/bot');let stop=false;
 const s=await openBot(process.argv[2]!,{onStop:async()=>{stop=true;}});
 try{const result=await runInventoryBank(s,r,{maximum,cap,maxAttempts,reserve:Number(process.env.RAW_RESERVE??0),members:process.env.MEMBERS==='1',stop:()=>stop});await finish([s],result.ok,JSON.stringify(result));}
 catch(e){await finish([s],false,String(e));}
}
