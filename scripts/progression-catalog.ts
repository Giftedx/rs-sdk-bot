// Developer tool: derives progression metadata from the existing AIO routes and native recipe catalogs.
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {aioRoutes,CATALOG_FOLDERS,OUTSIDE_CATALOG} from './script-index';
import {resolveAioStep} from './aio';
import {PROGRESSIVE_TIERS,progressiveSkillerAlternatives,inventoryRecipes,cookingRecipes,jewelleryRecipes,miningProfiles,FISH_PROFILES,stallRecipes,smeltRecipe} from './aio-skiller';
import {QUEST_NAMES,QUEST_SKILLS} from './quest-chain';
import {listGeneratedQuestScripts,resolveQuestScript,assessQuestReadiness} from './aio-quester';
import {PROFILES as SHOP_PROFILES} from '../packages/workers/src/market';
import {KITS,kitSkills} from './pk-kits';
import {smithRecipe,HAMMER} from './smith-batch';
import {RUNE_ALTARS} from './rune-bank-craft';
import {BONE_XP} from './train-prayer';
import {itemMagicRecipe} from './microbot-magic-items';
import {nativeNpcSpell} from './microbot-magic-npc';
import {orbRecipes} from './microbot-c-orbs';
import {nativeTeleport} from './microbot-magic-teleport';
import {nativeArrowProfile} from './fletch-arrows';
import {pickpocketProfiles} from '../packages/workers/src/gather';
import {modelXpPerTickAt} from '../packages/knowledge/src/method-model';
import type {Method as Rung} from '../packages/knowledge/src/ladders';
import {PROGRESSION_SKILLS,catalogCoverage,type CatalogIntent,type CatalogRoute,type CatalogMethod,type CatalogQuest,type ProgressionCatalog} from '../packages/planner/src/progression-catalog';
import type {Step} from '../packages/core/src/chain-step';

const root=resolve(import.meta.dir,'..'),json=<T>(base:string,file:string):T=>JSON.parse(readFileSync(resolve(base,file),'utf8'));
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const unknownCosts=()=>({setupTicks:null,travelTicks:null,acquisitionTicks:null,unlockTicks:null});
const countItems=(rows:readonly {id:number|null;count?:number|null}[])=>Object.fromEntries(rows.flatMap(r=>r.id!==null&&Number.isSafeInteger(r.id)&&r.id>0&&typeof r.count==='number'&&r.count>0?[[r.id,r.count]]:[]));
function intents(category:string,name:string):CatalogIntent[]{
 if(category==='quester')return name==='items'?['acquire']:name==='seaslug-leave'?['service']:['quest'];
 if(category==='skiller')return name.startsWith('foraging:')?['acquire']:name.endsWith(':specialist')?['service']:['train','produce'];
 if(category==='fighter')return name==='attack-specialist'||name==='ranged-specialist'?['service']:/^(?:specialist-(?:hp|strength|defence))$/.test(name)?['train']:/^(?:chicken|cow|giant|trooper|ranged(?:-starter|-gather|-camp)?|cannon)$/.test(name)?['train','acquire']:['acquire'];
 if(category==='boss')return ['acquire'];
 if(category==='pvp')return name==='monitor'?['observe']:name==='stage-kit'?['acquire']:name==='standby'?['service']:['pvp'];
 if(category==='market')return name==='ge-plan'?['observe']:['acquire'];
 if (name === 'inspect') return ['observe'];
 return ['banker','supply-holder','specialist-supplier','gathering-supplier','wine-stock','food-chain','supply-chain','supply-bootstrap','bank-sort','loadout-import','restore-prayer','cure-poison','walk-to','walk-edge','relocate-bank','relocate-knight','arrive-draynor','loadout','recover-trapped'].includes(name)?['service']:['acquire'];
}
function knownStep(category:string,name:string,script:string):Step{
 try{return resolveAioStep(category,name.split(':'));}catch{return{script,args:[],env:{}};}
}
function methodBase(id:string,routeId:string,step:Step,source:string):CatalogMethod{
 return{id,routeId,ladderIds:[],sourceEntry:step.script,step,source,effects:{},rate:{unitsPerTick:null,basis:'unknown',evidence:'Whole-job rate requires a matching practice or live measurement'},costs:unknownCosts(),repeatable:true};
}
function fromRung(method:CatalogMethod,rung:Rung|undefined):CatalogMethod{
 if(!rung)return method;
 if(!method.ladderIds.includes(rung.id))method.ladderIds.push(rung.id);
 method.members=rung.members;
 const xp=rung.xpPerAction;
 if(xp!==null&&xp>0)method.effects.xp={[rung.skill]:xp*25};
 method.requirements={...method.requirements,levels:{...method.requirements?.levels,[rung.skill]:Math.max(1,rung.level)},
  ...(rung.quest?{quests:[rung.quest.name]}:{}),...(rung.members===true?{facts:{fact:'members'}}:{})};
 method.inputs??=countItems(rung.inputs);method.source=method.source+'; '+rung.src;
 if(xp!==null&&xp>0&&rung.timing){
  const perLevel=Array.from({length:99},(_,i)=>{const value=modelXpPerTickAt(xp,rung.timing,i+1);return value!==null?value/(xp*25):null;});
  method.modelRates={skill:rung.skill,perLevel};method.rate={unitsPerTick:perLevel[Math.max(0,rung.level-1)]??null,basis:'model',evidence:rung.timing.src.join('; ')};
 }
 return method;
}
function sameInputs(rung:Rung,inputs:readonly {id:number;units:number}[]){
 return rung.inputs.length===inputs.length&&inputs.every(i=>rung.inputs.some(r=>r.id===i.id&&r.count===i.units));
}
function nativeMethod(family:string,recipe:string,skill:string,level:number,product:number,inputs:{id:number;units:number}[],tools:readonly number[],members:boolean,rungs:Rung[],xp=true,productUnits=1):CatalogMethod{
 const routeId=family==='inventory'?`skiller:${skill.toLowerCase()}:inventory`:family==='magic'?'skiller:magic:items':`skiller:${skill.toLowerCase()}:${family}`;
 const job={family,recipe,target:productUnits,batch:13,cap:20000,returnTicks:300,members,reserve:0};
 const step={script:'scripts/aio-skiller.ts',args:['bank-job','--job='+encodeURIComponent(JSON.stringify(job))],env:{}};
 const method=methodBase(`recipe:${family}:${recipe}`,routeId,step,'scripts/microbot-bank-jobs.ts');
 method.effects.items={[product]:productUnits};method.inputs=Object.fromEntries(inputs.map(i=>[i.id,i.units]));
 method.requirements={levels:{[skill.toLowerCase()]:Math.max(1,level)},items:Object.fromEntries(tools.map(id=>[id,1])),...(members?{facts:{fact:'members'} as const}:{})};
 const bySkillOut=rungs.filter(r=>r.skill===skill.toLowerCase()&&r.outputs.some(o=>o.id===product));
 const exact=bySkillOut.filter(r=>Math.max(1,r.level)===Math.max(1,level)&&sameInputs(r,inputs));
 const relaxedInputs=exact.length===1?exact:bySkillOut.filter(r=>sameInputs(r,inputs));
 const bowString=relaxedInputs.length===1?relaxedInputs:family==='inventory'&&recipe.startsWith('bow-string:')?bySkillOut.filter(r=>Math.max(1,r.level)===Math.max(1,level)&&r.inputs.length>0&&r.inputs.every(ri=>inputs.some(i=>i.id===ri.id))):[];
 if(bowString.length===1)fromRung(method,bowString[0]);
 if(!xp)delete method.effects.xp;
 method.members=members;method.execution={bankJob:job,outputPerUnit:productUnits};method.maxBatch=1000;
 return method;
}
function questRows(base:string,generated:string[]):CatalogQuest[]{
 const native=json<{folder:string|null;xp:{skill:string;xp:number}[];src:string}[]>(base,'knowledge/quests.json');
 const all99=Object.fromEntries(PROGRESSION_SKILLS.map(s=>[s,99]));
 const names={...QUEST_NAMES,dwarfcannon:'Dwarf Cannon',waterfall:'Waterfall Quest'};
 return Object.entries(names).flatMap(([id,name])=>{
  let script:string;try{script=resolveQuestScript(id,base);}catch{return[];}
  if(!generated.includes(script))return[];
  const text=readFileSync(resolve(base,script),'utf8'),matches=native.filter(q=>q.folder&&text.includes(q.folder));
  const exact=matches.length===1?matches[0]:native.find(q=>q.folder==='quest_'+id);
  const xp:Record<string,number>={};for(const reward of exact?.xp??[])xp[reward.skill.toLowerCase()]=(xp[reward.skill.toLowerCase()]??0)+reward.xp*25;
  // Waterfall's rewards are absent from the generated quest table; reuse the pinned route reward facts.
  if(id==='waterfall'){xp.attack=13750*25;xp.strength=13750*25;}
  let items:Record<number,number>={};try{items=assessQuestReadiness(id,{},new Set(),all99).missingItems;}catch{/* An unsupported authored entry stays without an inferred kit. */}
  return[{id,name,script,xp,source:exact?.src??script,requirements:{levels:QUEST_SKILLS[id]??{},items,facts:{fact:'quest-entry:'+id}}}];
 });
}

export function buildProgressionCatalog(base=root):ProgressionCatalog{
 const ladders=json<{ladders:Record<string,Rung[]>}>(base,'knowledge/ladders.json'),rungs=Object.values(ladders.ladders).flat();
 const routes:CatalogRoute[]=aioRoutes().map(r=>{
  const step=knownStep(r.category,r.name,r.script),skills=r.category==='skiller'&&PROGRESSION_SKILLS.includes(r.name.split(':')[0] as typeof PROGRESSION_SKILLS[number])?[r.name.split(':')[0]!]:r.name==='specialist-hp'?['hitpoints']:r.name==='specialist-strength'?['strength']:r.name==='specialist-defence'?['defence']:r.category==='fighter'?['attack','strength','defence','hitpoints','ranged']:[];
  const discriminator=r.script==='scripts/gather-combat.ts'?{env:{TARGET:r.name}}:undefined;
  return{id:r.category==='quester'?`quester:mode:${r.name}`:`${r.category}:${r.name}`,category:r.category,name:r.name,script:r.script,args:step.args,env:step.env,intents:intents(r.category,r.name),skills,description:r.description,...(discriminator?{discriminator}:{})};
 });
 const generated=listGeneratedQuestScripts(base).filter(script=>!script.endsWith('-owned.ts'));
 const quests=questRows(base,generated),questByScript=new Map(quests.map(q=>[q.script,q]));
 const finiteServices:Record<string,string>={barcrawl:"Alfred Grimhand's Barcrawl",magearena:'The Mage Arena'};
 for(const script of generated){const q=questByScript.get(script),id=script.split('/').at(-1)!.replace(/^quest-/,'').replace(/\.ts$/,'');routes.push({id:`quester:quest:${id}`,category:'quester',name:id,script,args:[],env:{},intents:finiteServices[id]?['service']:['quest'],skills:[],description:q?.name??finiteServices[id]??'Authored native quest'});}
 const methods:CatalogMethod[]=[];
 for(const [skill,tiers]of Object.entries(PROGRESSIVE_TIERS)){
  const alternatives=progressiveSkillerAlternatives(skill,98,99);
  for(let i=0;i<tiers.length;i++){
   const tier=tiers[i]!,band=alternatives[i];if(!band)continue;
   const method=methodBase(`tier:${skill}:${tier.level}:${tier.method}`,`skiller:${skill}:${tier.method}`,band.step,'scripts/aio-skiller.ts');
   method.effects.xp={[skill]:tier.xp*25};method.requirements={levels:{[skill]:Math.max(1,tier.level)}};
   method.execution={targetEnv:['TARGET_LEVEL',...['woodcutting','fishing','thieving'].includes(skill)?['TARGET']:[]],
    ...tier.job?{bankJob:{...tier.job,target:1,batch:13,cap:20000,returnTicks:300,members:tier.job.members??false,reserve:0}}:{},
    ...skill==='agility'?{targetArg:1}:skill==='runecraft'||skill==='magic'&&tier.method==='alch-train'?{targetArg:0}:{},
    ...skill==='fletching'?{unitEnv:['MAX_MAKE']}:skill==='smithing'?{unitEnv:['MAX_MAKE']}:skill==='prayer'?{unitEnv:['MAX_BURY']}:{} };
   const matching=rungs.filter(r=>r.skill===skill&&Math.max(1,r.level)===tier.level&&r.xpPerAction!==null&&Math.abs(r.xpPerAction-tier.xp)<0.11);
   if(skill==='prayer'){
    const bone=tier.env?.BONE_ID==='536'?'prayer/bury-dragon_bones':tier.env?.BONE_ID==='532'?'prayer/bury-big_bones':'prayer/bury-bones';
    fromRung(method,rungs.find(r=>r.id===bone));
   }else if(matching.length===1&&!['woodcutting','fishing','thieving'].includes(skill))fromRung(method,matching[0]);
   if(tier.job?.members)method.requirements.facts={fact:'members'};
   methods.push(method);
  }
 }
 for(const r of inventoryRecipes())methods.push(nativeMethod('inventory',r.name,r.skill,r.level,r.product,r.inputs,[...r.tools,...r.optionalInputs??[]],r.members,rungs,r.xp,r.productUnits??1));
 for(const r of cookingRecipes().recipes){const method=nativeMethod('cooking',r.name,'cooking',r.level,r.products[0]!,[{id:r.raw,units:1}],[],false,rungs,r.xp>0);
  // Burns and dynamic gnome products need a measured success mix rather than guaranteed output.
  if(r.burnt!==undefined||r.products.length!==1){method.rate={unitsPerTick:null,basis:'unknown',evidence:r.source+'; measure success mix and exact output'};delete method.modelRates;}
  methods.push(method);
 }
 for(const r of jewelleryRecipes())methods.push(nativeMethod('jewellery',r.name,'crafting',r.level,r.product,r.inputs,r.tools,r.members,rungs,r.xp,r.productUnits??1));
 for(const r of miningProfiles().filter(r=>!r.essence)){
  const method=nativeMethod('mining',r.name,'mining',r.level,r.products[0]!,[],[1265],false,rungs);
  if(!method.ladderIds.length){const exactMining=rungs.find(m=>m.id==='mining/'+r.name);if(exactMining)fromRung(method,exactMining);}
  // The adapter needs an explicit site and bank before it is executable.
  method.requirements!.facts={fact:'site:'+r.name};method.rate={unitsPerTick:null,basis:'unknown',evidence:'Mining target/site/tool comparison requires an observed route'};delete method.modelRates;
  method.execution!.bankJob={...method.execution!.bankJob,bank:{x:3253,z:3420,level:0},site:{x:3286,z:3368,level:0}};
  methods.push(method);
 }
 {
  const ess=methodBase('mining/rune-essence','skiller:mining:essence',{script:'scripts/aio-skiller.ts',args:['gather','mining','essence','150','28'],env:{}},'packages/workers/src/gather/mining.ts');
  ess.effects.items={1436:1};ess.requirements={levels:{mining:1},items:{1265:1}};
  fromRung(ess,rungs.find(r=>r.id==='mining/rune_essence_table'));
  methods.push(ess);
 }
 for(const [name,r]of Object.entries(FISH_PROFILES)){
  const method=nativeMethod('fishing',name,'fishing',r.level,r.products[0],r.bait?[{id:r.bait,units:1}]:[],[r.tool],['karambwan','karambwanji','bigNet','lava'].includes(name),rungs);
  for(const extraRung of rungs.filter(m=>m.skill==='fishing'&&m.outputs.some(o=>o.id!==null&&(r.products as readonly number[]).includes(o.id)))){
   if(!method.ladderIds.includes(extraRung.id))method.ladderIds.push(extraRung.id);
  }
  method.requirements!.facts={all:[...method.members?[{fact:'members'}]:[],{fact:'site:fishing:'+name}]};
  method.rate={unitsPerTick:null,basis:'unknown',evidence:'Fishing mixed catches, tools and bank trips require a matched measurement'};delete method.modelRates;methods.push(method);
 }
 {
  const shark=methodBase('fishing/shark-supply','skiller:fishing:shark',{script:'scripts/aio-skiller.ts',args:['gather','fishing','shark','99','9000'],env:{}},'packages/workers/src/gather/fishing.ts');
  shark.effects.items={383:1};shark.requirements={levels:{fishing:76},items:{311:1},facts:{fact:'members'}};
  fromRung(shark,rungs.find(r=>r.id==='fishing/catch-shark'));methods.push(shark);
 }
 for(const r of stallRecipes()){
  const method=nativeMethod('stalls',r.name,'thieving',r.level,r.loot[0]!,[],[],r.questGate,rungs);
  method.requirements!.facts={fact:'site:'+r.name};method.rate={unitsPerTick:null,basis:'unknown',evidence:'Observed stall guards, competition and bank path are required'};delete method.modelRates;methods.push(method);
 }
 for(const bar of ['bronze','iron','silver','steel','gold','mithril','adamantite','runite','cannonballs']){
  const r=smeltRecipe(bar),step={script:'scripts/smelt-bars.ts',args:['20000',bar],env:{MAX_MAKE:'1',ORE_RESERVE:'0'}};
  const method=methodBase(`smithing/smelt-${bar}`,'skiller:smithing:smelt',step,'scripts/smelt-batch.ts');
  method.inputs=Object.fromEntries(r.ingredients.map(i=>[i.id,i.units]));method.effects.items={[r.product]:r.productUnits??1};method.requirements={levels:{smithing:r.level},items:Object.fromEntries((r.tools??[]).map(id=>[id,1]))};
  fromRung(method,rungs.find(m=>m.skill==='smithing'&&m.outputs.some(o=>o.id===r.product)&&sameInputs(m,r.ingredients)));
  method.execution={unitEnv:['MAX_MAKE']};methods.push(method);
 }
 for(const r of rungs.filter(m=>m.skill==='smithing'&&!m.id.startsWith('smithing/smelt')&&m.outputs[0]?.id!=null)){
  const sr=smithRecipe(r.outputs[0]!.id!);
  const method=methodBase(`smithing/anvil-${slug(r.id.split('/')[1]!)}`,'skiller:smithing:anvil',{script:'scripts/smelt-bars.ts',args:['20000'],env:{ORDER_ACTION:'smith',PRODUCT_ID:String(sr.product),MAX_MAKE:'1',BAR_RESERVE:'0'}},'scripts/smith-batch.ts');
  method.inputs={[sr.bar]:sr.bars};method.effects.items={[sr.product]:sr.amount};
  method.requirements={levels:{smithing:sr.level},items:{[HAMMER]:1},...(sr.quest?{quests:[sr.quest]}:{})};
  fromRung(method,r);method.execution={unitEnv:['MAX_MAKE']};methods.push(method);
 }
 for(const metal of ['bronze','iron','silver','steel','gold','mithril','adamantite','runite']){
  const rec=itemMagicRecipe('superheat:'+metal);
  const method=methodBase(`magic/superheat-${metal}`,'skiller:magic:items',{script:'scripts/microbot-magic-items.ts',args:['superheat:'+metal,'-','1','200'],env:rec.members?{MEMBERS:'1'}:{}},'scripts/microbot-magic-items.ts');
  method.inputs=rec.inputs;method.effects.items={[rec.product]:1};method.requirements={levels:{magic:rec.level,smithing:rec.smithing},...(rec.members?{facts:{fact:'members'}}:{})};
  if(metal==='bronze')fromRung(method,rungs.find(r=>r.id==='magic/magic_spell_superheat'));
  method.execution={unitArg:2};methods.push(method);
 }
 for(const [mode,rungId]of [['low-alch','magic/magic_spell_low_alch'],['high-alch','magic/magic_spell_high_alch']] as const){
  const rec=itemMagicRecipe(mode,'iron_dagger');
  const method=methodBase(`magic/${mode}`,'skiller:magic:items',{script:'scripts/microbot-magic-items.ts',args:[mode,'iron_dagger','1','200'],env:{}},'scripts/microbot-magic-items.ts');
  method.inputs=rec.inputs;method.effects.items={[rec.product]:rec.output};method.requirements={levels:{magic:rec.level}};
  fromRung(method,rungs.find(r=>r.id===rungId));method.execution={unitArg:2};methods.push(method);
 }
 for(const [item,lvl]of [['sapphire_ring',1],['emerald_ring',2],['ruby_ring',3],['diamond_ring',4],['dragonstone_ring',5]] as const){
  const rec=itemMagicRecipe('enchant:'+item);
  const method=methodBase(`magic/enchant-level${lvl}`,'skiller:magic:items',{script:'scripts/microbot-magic-items.ts',args:['enchant:'+item,'-','1','200'],env:rec.members?{MEMBERS:'1'}:{}},'scripts/microbot-magic-items.ts');
  method.inputs=rec.inputs;method.effects.items={[rec.product]:1};method.requirements={levels:{magic:rec.level},...(rec.members?{facts:{fact:'members'}}:{})};
  fromRung(method,rungs.find(r=>r.id===`magic/magic_spell_enchant_level${lvl}`));method.execution={unitArg:2};methods.push(method);
 }
 for(const [item,lvl]of [['sapphire_ring',1],['sapphire_necklace',1],['strung_sapphire_amulet',1],['emerald_ring',2],['strung_emerald_amulet',2],['ruby_ring',3],['strung_ruby_amulet',3],['diamond_ring',4],['strung_diamond_amulet',4],['dragonstone_ring',5],['strung_dragonstone_amulet',5]] as const){
  const recipe='enchant:'+item,rec=itemMagicRecipe(recipe),inputs=Object.entries(rec.inputs).map(([id,units])=>({id:Number(id),units}));
  const method=nativeMethod('magic',recipe,'magic',rec.level,rec.product,inputs,[],rec.members,rungs);
  fromRung(method,rungs.find(r=>r.id===`magic/magic_spell_enchant_level${lvl}`));
  method.members=rec.members;
  method.requirements={levels:{magic:rec.level},...(rec.members?{facts:{fact:'members'}}:{})};
  method.effects.items={[rec.product]:1};
  methods.push(method);
 }
 for(const spell of ['wind_strike','confuse','water_strike','earth_strike','weaken','fire_strike','wind_bolt','curse','bind','water_bolt','earth_bolt','fire_bolt','crumble_undead','wind_blast','water_blast','iban_blast','snare','earth_blast','fire_blast','claws_of_guthix','flames_of_zamorak','saradomin_strike','wind_wave','water_wave','vulnerability','earth_wave','enfeeble','fire_wave','entangle','stun']){
  const sp=nativeNpcSpell(spell);
  const method=methodBase(`magic/npc-${slug(spell)}`,'skiller:magic:npc',{script:'scripts/microbot-magic-npc.ts',args:[spell,'41','1','200'],env:sp.members?{MEMBERS:'1'}:{}},'scripts/microbot-magic-npc.ts');
  method.inputs=sp.runes;method.requirements={levels:{magic:sp.level},...(sp.requiredWorn?{items:{[sp.requiredWorn]:1}}:{}),...(sp.members?{facts:{fact:'members'}}:{})};
  fromRung(method,rungs.find(r=>r.id==='magic/magic_spell_'+spell));method.execution={unitArg:2};methods.push(method);
 }
 for(const kind of ['air','water','earth','fire'] as const){
  const orb=orbRecipes[kind];
  const method=methodBase(`magic/charge-${kind}-orb`,'skiller:magic:orbs-at-site',{script:'scripts/microbot-c-orbs.ts',args:[kind,'1','80'],env:{}},'scripts/microbot-c-orbs.ts');
  method.inputs={567:1,564:3,[orb.rune]:30};method.effects.items={[orb.output]:1};method.requirements={levels:{magic:orb.level},facts:{fact:'members'}};
  fromRung(method,rungs.find(r=>r.id===`magic/magic_spell_charge_${kind}_orb`));method.execution={unitArg:1};methods.push(method);
 }
 {
  const btb=methodBase('magic/bones-to-bananas','skiller:magic:bones',{script:'scripts/microbot-bones.ts',args:[],env:{MAX_MAKE:'1',CAP:'300'}},'scripts/microbot-bones.ts');
  btb.inputs={526:1,555:2,557:2,561:1};btb.effects.items={1963:1};btb.requirements={levels:{magic:15}};
  fromRung(btb,rungs.find(r=>r.id==='magic/magic_spell_bones_to_bananas'));btb.execution={unitEnv:['MAX_MAKE']};methods.push(btb);
 }
 for(const dest of ['varrock','lumbridge','falador','camelot','ardougne'] as const){
  const tp=nativeTeleport(dest);
  const method=methodBase(`magic/teleport-${dest}`,'skiller:magic:teleport',{script:'scripts/microbot-magic-teleport.ts',args:[dest,'1','100'],env:tp.members?{MEMBERS:'1'}:{}},'scripts/microbot-magic-teleport.ts');
  method.inputs=tp.runes;method.requirements={levels:{magic:tp.level},...(tp.members?{facts:{fact:'members'}}:{})};
  fromRung(method,rungs.find(r=>r.id==='magic/magic_spell_teleport_'+dest));method.execution={unitArg:1};methods.push(method);
 }
 for(const altar of RUNE_ALTARS){
  const method=methodBase(`runecraft/${altar.name}`,'skiller:runecraft:bank-craft',{script:'scripts/rune-bank-craft.ts',args:['99'],env:{RUNE_ALTAR:altar.name,TARGET_LEVEL:'99',CAP:'4000'}},'scripts/rune-bank-craft.ts');
  method.inputs={1436:27};method.effects.items={[altar.rune]:27};method.requirements={levels:{runecraft:altar.level},items:{[altar.talisman]:1}};
  fromRung(method,rungs.find(r=>r.id==='runecraft/runecraft_'+altar.name));method.execution={targetArg:0,targetEnv:['TARGET_LEVEL']};methods.push(method);
 }
 {
  const nat=methodBase('runecraft/nature','skiller:runecraft:nature',{script:'scripts/microbot-rune-trip.ts',args:[],env:{}},'scripts/microbot-rune-trip.ts');
  nat.inputs={1436:27};nat.effects.items={561:27};nat.requirements={levels:{runecraft:44},items:{1462:1},facts:{fact:'members'}};
  fromRung(nat,rungs.find(r=>r.id==='runecraft/runecraft_nature'));methods.push(nat);
 }
 {
  const shafts=methodBase('fletching/shafts','skiller:fletching:shafts',{script:'scripts/fletch-arrows.ts',args:['600','shafts'],env:{MAX_MAKE:'1',LOG_RESERVE:'0'}},'scripts/fletch-shafts.ts');
  shafts.inputs={1511:1};shafts.effects.items={52:15};shafts.requirements={levels:{fletching:1},items:{946:1}};
  fromRung(shafts,rungs.find(r=>r.id==='fletching/cut-arrow_shaft'));shafts.execution={unitEnv:['MAX_MAKE']};methods.push(shafts);
 }
 for(const metal of ['bronze','iron','steel','mithril','adamant','rune'] as const){
  const ap=nativeArrowProfile(metal);
  const method=methodBase(`fletching/arrows-${metal}`,'skiller:fletching:arrows',{script:'scripts/fletch-arrows.ts',args:['600','native-arrows',metal],env:{MAX_MAKE:'15'}},'scripts/fletch-arrows.ts');
  method.inputs={53:15,[ap.tip]:15};method.effects.items={[ap.product]:15};method.requirements={levels:{fletching:ap.level}};
  fromRung(method,rungs.find(r=>r.id===`fletching/fletching_${metal}_arrow`));method.execution={unitEnv:['MAX_MAKE']};methods.push(method);
 }
 for(const tree of ['normal','oak','willow','maple','yew','magic'] as const){
  const isYewRoute=tree==='yew'||['maple','magic'].includes(tree);
  const script=isYewRoute?'scripts/aio-skiller.ts':'scripts/generated/woodcutting.ts';
  const method=methodBase(`woodcutting/${tree}`,isYewRoute?'skiller:woodcutting:yews':'skiller:woodcutting:fresh45',{script,args:isYewRoute?['gather','woodcutting','yews','1000','27']:[],env:isYewRoute?{TREE:tree,...['maple','magic'].includes(tree)?{WOOD_GROVE:'native-processing'}:{}}:{TARGET:'99',CAP:'3000'}},isYewRoute?'packages/workers/src/gather/woodcutting.ts':script);
  method.requirements={levels:{woodcutting:{normal:1,oak:15,willow:30,maple:45,yew:60,magic:75}[tree]},items:{1351:1}};
  fromRung(method,rungs.find(r=>r.id===`woodcutting/${tree}_tree_table`));methods.push(method);
 }
 {
  const wool=methodBase('crafting/spin-wool','skiller:foraging:wool',{script:'scripts/aio-skiller.ts',args:['gather','foraging','wool'],env:{CAP:'2200'}},'packages/workers/src/gather/foraging.ts');
  wool.effects.items={1759:1};wool.requirements={levels:{crafting:1},items:{1735:1}};
  fromRung(wool,rungs.find(r=>r.id==='crafting/spin-wool'));methods.push(wool);
 }
 for(const p of pickpocketProfiles()){
  const method=methodBase(`thieving/pickpocket-${slug(p.name)}`,'skiller:thieving:pickpocket-at-site',{script:'scripts/aio-skiller.ts',args:['gather','thieving','pickpocket-at-site',p.name,'1','3','300'],env:{MEMBERS:'1'}},'packages/workers/src/gather/thieving.ts');
  method.requirements={levels:{thieving:p.level},facts:{fact:'members'}};
  fromRung(method,rungs.find(r=>r.id==='thieving/pickpocket_'+p.name));method.execution={unitArg:4};methods.push(method);
 }
 {
  const bc=methodBase('thieving/blood-chest','skiller:thieving:blood-chest',{script:'scripts/aio-skiller.ts',args:['gather','thieving','blood-chest','2500'],env:{MAX_LOOTS:'1',CAP:'2500'}},'packages/workers/src/gather/thieving.ts');
  bc.effects.items={565:2};bc.requirements={levels:{thieving:59},facts:{fact:'members'}};
  fromRung(bc,rungs.find(r=>r.id==='thieving/trapped_chest_chest_blood_runes'));methods.push(bc);
  const nc=methodBase('thieving/nature-chest','skiller:thieving:nature-chest',{script:'scripts/aio-skiller.ts',args:['gather','thieving','nature-chest'],env:{CHEST_X:'2671',CHEST_Z:'3301',CHEST_LEVEL:'1',MAX_LOOTS:'1',CAP:'200'}},'packages/workers/src/gather/thieving.ts');
  nc.effects.items={561:1};nc.requirements={levels:{thieving:28},facts:{fact:'members'}};
  fromRung(nc,rungs.find(r=>r.id==='thieving/trapped_chest_chest_nature_rune'));methods.push(nc);
 }
 for(const skill of ['attack','strength','defence','hitpoints']){
  const ch=methodBase(`${skill}/chicken`,'fighter:chicken',{script:'scripts/train-chickens.ts',args:['3000'],env:{TRAIN_SKILL:skill[0]!.toUpperCase()+skill.slice(1),TARGET_LEVEL:'99'}},'scripts/train-chickens.ts');
  ch.effects.xp={[skill]:1};ch.execution={targetEnv:['TARGET_LEVEL']};ch.requirements={facts:{fact:'combat-entry:chicken'}};
  const chr=rungs.find(r=>r.id===`${skill}/target-chicken`);if(chr){ch.ladderIds=[chr.id];ch.source+='; '+chr.src;}methods.push(ch);
 }
 for(const skill of ['attack','strength','defence','hitpoints','ranged'])for(const target of skill==='ranged'?['giant','druid']:['cow','trooper','giant','druid']){
  const method=methodBase(`${skill}/${target}`,`fighter:${target}`,{script:'scripts/gather-combat.ts',args:['3000',target],env:{TARGET:target,TRAIN_SKILL:skill[0]!.toUpperCase()+skill.slice(1),TARGET_LEVEL:'99',...target==='cow'?{COW_STAGE:'1'}:target==='trooper'?{TROOPER_COOK:'1',GIANT_FOOD:'20'}:{}}},'scripts/gather-combat.ts');
  method.effects.xp={[skill]:1};method.execution={targetEnv:['TARGET_LEVEL']};method.requirements={facts:{fact:'combat-entry:'+target}};
  const ladderTarget=target==='druid'?'chaos_druid':target;
  const rung=rungs.find(r=>r.skill===skill&&r.id.endsWith('/target-'+ladderTarget));if(rung){method.ladderIds=[rung.id];method.source+='; '+rung.src;}
  methods.push(method);
 }
 for(const target of ['chickens','troopers']){
  const method=methodBase('ranged/'+target,`fighter:${target==='chickens'?'ranged':'trooper'}`,{script:'scripts/ranged-train.ts',args:['99','20000'],env:{}},'scripts/ranged-train.ts');
  method.effects.xp={ranged:1};method.execution={targetArg:0};method.requirements={facts:{fact:'combat-entry:'+target}};
  if(target==='chickens'){const rr=rungs.find(r=>r.id==='ranged/target-chicken');if(rr){method.ladderIds=[rr.id];method.source+='; '+rr.src;}}
  methods.push(method);
 }
 const cannon=methodBase('ranged/cannon','fighter:cannon',{script:'scripts/cannon-fight.ts',args:[],env:{STOP_LEVEL:'99',CAP:'3200'}},'scripts/cannon-fight.ts');
 cannon.effects.xp={ranged:1};cannon.requirements={quests:['Dwarf Cannon'],items:{6:1,8:1,10:1,12:1,2:1},facts:{fact:'combat-entry:cannon'}};cannon.execution={targetEnv:['STOP_LEVEL']};methods.push(cannon);
 for(const q of quests){const method=methodBase('quest:'+q.id,'quester:quest:'+q.id,{script:'scripts/quest-sweep.ts',args:[q.id],env:{}},q.script);
  method.effects={xp:q.xp,quests:[q.name]};method.requirements=q.requirements;method.repeatable=false;methods.push(method);
 }
 // Shop adapters use the existing observed shop worker. Costs retain their content/model basis and missing travel proof.
 const sourceFile=resolve(base,'knowledge/item-sources.json');
 if(existsSync(sourceFile)){
  const sourceData=JSON.parse(readFileSync(sourceFile,'utf8')),rows=(Array.isArray(sourceData)?sourceData:sourceData.items??sourceData.rows??[]) as any[];
  const needed=new Set(methods.flatMap(m=>Object.keys({...m.inputs,...m.requirements?.items}).map(Number)));
  for(const row of rows)if(needed.has(row.id))for(const s of row.sources??[])if(s.kind==='shop'){
   const profile=Object.entries(SHOP_PROFILES).find(([,p])=>(s.owners??[]).some((owner:any)=>(owner.tiles??[]).some((t:any)=>(t.level??0)===(p.npcSpot.level??0)&&Math.max(Math.abs(t.x-p.npcSpot.x),Math.abs(t.z-p.npcSpot.z))<=3)));
   if(!profile||!(s.priceAtFullStock>0)||!row.name)continue;
   const [name,p]=profile,spend=Math.ceil(s.priceAtFullStock*1.5),pattern='^'+String(row.name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
   const method=methodBase(`shop:${name}:${row.id}`,'market:shop-buy',{script:'scripts/aio-market.ts',args:['shop-buy',name,'1200'],env:{ITEMS:pattern,STOCK_TARGET:'1',STOP_AT_TARGET:'1',BANK_PACK:'1',BANK_AT:'0',MAX_SPEND:String(spend),FLOAT:String(spend+1000),COIN_RESERVE:'500'}},s.src??'knowledge/item-sources.json');
   method.effects.items={[row.id]:1};method.inputs={995:spend};method.requirements={...p.need?{levels:{[p.need.skill.toLowerCase()]:p.need.level}}:{},facts:{fact:'shop-stock:'+name+':'+row.id}};
   method.execution={stockEnv:['STOCK_TARGET'],spendPerUnit:spend};method.maxBatch=1000;methods.push(method);
  }
 }
 const entries=new Map<string,ProgressionCatalog['entries'][number]>();
 for(const r of routes){const e=entries.get(r.script)??{script:r.script,intents:[],skills:[],routeIds:[]};e.intents=[...new Set([...e.intents,...r.intents])];e.skills=[...new Set([...e.skills,...r.skills])];e.routeIds.push(r.id);entries.set(r.script,e);}
 for(const category of ['skiller','fighter','boss','pvp','quester','market','logistics'])entries.set('scripts/aio-'+category+'.ts',{script:'scripts/aio-'+category+'.ts',intents:[...new Set(routes.filter(r=>r.category===category).flatMap(r=>r.intents))],skills:[...new Set(routes.filter(r=>r.category===category).flatMap(r=>r.skills))],routeIds:routes.filter(r=>r.category===category).map(r=>r.id)});
 entries.set('scripts/aio.ts',{script:'scripts/aio.ts',intents:['train','quest','produce','acquire','pvp','observe','service'],skills:[...PROGRESSION_SKILLS],routeIds:routes.map(r=>r.id)});
 for(const script of ['scripts/session-check.ts','scripts/where.ts','scripts/goal-readiness.ts','scripts/preparation-report.ts'])entries.set(script,{script,intents:['observe'],skills:[],routeIds:[]});
 for(const script of ['scripts/claim-account.ts','packages/core/src/session-recovery.ts'])entries.set(script,{script,intents:['service'],skills:[],routeIds:[]});
 entries.set('scripts/ranged-live-prep.ts',{script:'scripts/ranged-live-prep.ts',intents:['service'],skills:['herblore'],routeIds:[]});
 entries.set('scripts/pvp-relog-combat.ts',{script:'scripts/pvp-relog-combat.ts',intents:['service'],skills:['attack','strength','defence','ranged'],routeIds:[]});
 entries.set('scripts/handoff-inputs.ts',{script:'scripts/handoff-inputs.ts',intents:['acquire','produce','service'],skills:['fletching'],routeIds:[]});
 entries.set('packages/practice/src/ge-bulk-order-proof.ts',{script:'packages/practice/src/ge-bulk-order-proof.ts',intents:['service','observe'],skills:[],routeIds:[],practiceOnly:true});
 // The practice proofs log a seeded account in once to register it (3 ticks, no game action): an observe entry.
 entries.set('packages/practice/src/register-proof-account.ts',{script:'packages/practice/src/register-proof-account.ts',intents:['observe'],skills:[],routeIds:[],practiceOnly:true});
 // The quest order proof runs its own file as the runner of its fault-injection cases (--boundary): a practice service.
 entries.set('packages/practice/src/quest-order-proof.ts',{script:'packages/practice/src/quest-order-proof.ts',intents:['service'],skills:[],routeIds:[],practiceOnly:true});
 entries.set('packages/practice/src/wine-stock-order-proof.ts',{script:'packages/practice/src/wine-stock-order-proof.ts',intents:['service'],skills:[],routeIds:[],practiceOnly:true});
 const probes=resolve(base,'scripts/measure');if(existsSync(probes))for(const file of readdirSync(probes).filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts')))entries.set('scripts/measure/'+file,{script:'scripts/measure/'+file,intents:['observe'],skills:[],routeIds:[],practiceOnly:true});
 // Direct gameplay entry files must be classified; helper modules without a login remain libraries.
 for(const folder of CATALOG_FOLDERS)for(const file of readdirSync(resolve(base,folder)).filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts'))){const path=folder+'/'+file;if(entries.has(path))continue;
  const text=readFileSync(resolve(base,path),'utf8');if(!/\b(?:openBot|connectInProcess)\s*\(/.test(text))continue;
  if(path in OUTSIDE_CATALOG&&/practice|measurement/.test(OUTSIDE_CATALOG[path]!))entries.set(path,{script:path,intents:['observe'],skills:[],routeIds:[],practiceOnly:true});
 }
 const mapped=new Set(methods.flatMap(m=>m.ladderIds));
 return{version:1,generatedBy:'bun scripts/progression-catalog.ts',skills:[...PROGRESSION_SKILLS],buildLimits:Object.fromEntries(Object.keys(KITS).sort().map(name=>[name,kitSkills(name)])),routes:routes.sort((a,b)=>a.id.localeCompare(b.id)),methods:methods.sort((a,b)=>a.id.localeCompare(b.id)),quests,
  entries:[...entries.values()].sort((a,b)=>a.script.localeCompare(b.script)),unmapped:rungs.filter(r=>!mapped.has(r.id)).map(r=>({id:r.id,skill:r.skill,source:r.src,workers:r.workers})).sort((a,b)=>a.id.localeCompare(b.id))};
}
if(import.meta.main){
 const c=buildProgressionCatalog(),file=resolve(root,'packages/planner/data/progression-routes.json'),bytes=JSON.stringify(c,null,1)+'\n';
 if(process.argv.includes('--check')){if(!existsSync(file)||readFileSync(file,'utf8')!==bytes)throw Error('progression metadata differs; run bun scripts/progression-catalog.ts');}
 else{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}
 console.log('PROGRESSION_CATALOG '+JSON.stringify(catalogCoverage(c)));
}
