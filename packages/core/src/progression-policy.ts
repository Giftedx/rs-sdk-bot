import type {Step} from './chain-step';
import {readFileSync} from 'node:fs';
import type {BankObservation} from './session-types';
import {getProgressionAdapter,requireProgressionAdapter,type ObservedAccount,type ProgressionAdapter,type ProgressionDecision,type ProgressionMethod,type WorkIntent} from './progression-adapter';

export interface WorkDescriptor{script:string;args:string[];env:Record<string,string|undefined>}
export interface PolicyEvaluation{supported:boolean;intent:WorkIntent|null;decision:ProgressionDecision|null;reason?:string;methods?:ProgressionMethod[];account?:ObservedAccount}
export interface BoundaryObservation{tick:number;inCombat:boolean;combatTargetIndex?:number;bankGeneration:number;stateKey:string}
const entry=(file:string)=>file.replace(/\\/g,'/').replace(/^.*?\/(scripts|packages)\//,'$1/');
const discriminator=/^(TARGET|TRAIN_SKILL|RECIPE|BAR_TYPE|FOOD_TYPE|TIP_TYPE|TIER|SPOT|MODE|FAMILY|PRODUCT_ID|ITEM_ID|BONE_ID|ITEMS)$/;
const setting=(work:WorkDescriptor,key:string)=>work.env[key]??work.args.find(a=>a.startsWith(key+'='))?.slice(key.length+1);
function bankJobIdentity(args:readonly string[]):string|null{
 if(args[0]!=='bank-job')return null;
 if(args.length!==2)return 'invalid';
 try{const raw=args[1]??'',job=JSON.parse(raw.startsWith('--job=')?decodeURIComponent(raw.slice(6)):readFileSync(raw,'utf8'));
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
  return JSON.stringify([job.family,job.recipe,job.site?.x,job.site?.z,job.site?.level,job.bank?.x,job.bank?.z,job.bank?.level,job.heat,job.tool,job.alchemyTarget,job.members??false,job.xpRate??25,canonical(job.fishingProtection??null)]);
 }catch{return 'invalid';}
}
export function methodSupportsWork(step:Step,work:WorkDescriptor,adapter:ProgressionAdapter|undefined=getProgressionAdapter()):boolean{
 if(entry(step.script)!==entry(work.script))return !!step.alsoRuns?.some(alt=>methodSupportsWork({script:alt.script,args:alt.args,env:alt.env},work,adapter));
 if(entry(step.script)==='scripts/cannon-fight.ts'){
  const p=requireProgressionAdapter(adapter);
  const expected=p.intentForEntry(step.script,step.args,step.env),actual=p.intentForEntry(work.script,work.args,work.env);
  if(expected?.kind==='train-all'||actual?.kind==='train-all'){
   if(expected?.kind!=='train-all'||actual?.kind!=='train-all')return false;
   const targets=(intent:WorkIntent)=>JSON.stringify(Object.entries(p.trainingTargets(intent)??{}).sort());
   if(targets(expected)!==targets(actual))return false;
  }
 }
 for(const [key,value]of Object.entries(step.env))if(discriminator.test(key)&&setting(work,key)!==value)return false;
 if(entry(step.script)==='scripts/aio-skiller.ts'&&(step.args[0]==='bank-job'||work.args[0]==='bank-job')){const expected=bankJobIdentity(step.args);if(expected===null||expected==='invalid'||expected!==bankJobIdentity(work.args))return false;}
 // Numeric positional arguments are targets and budgets. Named positional
 // arguments identify the recipe/site and must agree when both entries name one.
 const names=(args:readonly string[])=>args.filter(a=>!/^-?\d+(?:\.\d+)?$/.test(a)&&!a.includes('=')&&!a.startsWith('--'));
 const wanted=names(step.args),actual=names(work.args);
 return !wanted.length||JSON.stringify(wanted)===JSON.stringify(actual);
}
export function snapshotForProgression(prior:any,state:any,bank:BankObservation|null,now:number):any{
 const p=state?.player;
 return {...prior,at:now,
  skills:(state?.skills??[]).map((k:any)=>({name:k.name,level:k.baseLevel,currentLevel:k.level,xp:k.experience})),
  inventory:Array.isArray(state?.inventory)?state.inventory:null,equipment:Array.isArray(state?.equipment)?state.equipment:null,
  equipmentObserved:Array.isArray(state?.equipment)&&state.equipmentObserved!==false,
  ...(p?{pos:{x:p.worldX,z:p.worldZ,level:p.level},hp:{now:(state.skills??[]).find((k:any)=>k.name==='Hitpoints')?.level}}:{}),
  ...(bank?{bank:bank.items,bankAt:bank.at}:{}),
 };
}
export function createProgressionMonitor(options:{evaluate:()=>PolicyEvaluation;onHandoff:(evaluation:PolicyEvaluation)=>void}){
 let current:PolicyEvaluation|null=null,lastKey='',generation=-1,dirty=true,inCombat=false,target:number|undefined,handedOff='';
 const productive=(a:any)=>{
  if(!a||typeof a.type!=='string')return false;
  if(a.type==='interactNpc')return a.progressionOption==='Attack'||/attack|pickpocket/i.test(String(a.option??''))
   ||a.option===undefined&&a.progressionOption===undefined&&(a.optionIndex===undefined||a.optionIndex===1);
  if(a.type==='useInventoryItem')return !!a.progressionOption&&!/^(eat|drink|drop|wear|wield|rub|teleport|empty)$/i.test(a.progressionOption);
  // A bank use, a cannon pick-up and a portal exit end a stay and start no new work: a finished goal must not trap a
  // player inside an altar with the runes that it just crafted.
  if(a.type==='interactLoc')return !a.progressionBankCleanup&&!a.progressionCannonCleanup&&!a.progressionPortalExit&&!!a.progressionOption&&!/^(bank|open|close|climb(?:-up|-down)?|enter|exit|pass|travel|search)$/i.test(a.progressionOption);
  return ['useItemOnLoc','useItemOnNpc','useItemOnItem','spellOnNpc','spellOnPlayer','spellOnItem','spellOnGroundItem','spellOnLoc','castSpellOnNpc','castSpellOnLoc','castSpellOnItem'].includes(a.type);
 };
 return{
  observe(o:BoundaryObservation){
   inCombat=o.inCombat;target=o.combatTargetIndex;
   if(o.stateKey!==lastKey||o.bankGeneration!==generation){dirty=true;lastKey=o.stateKey;generation=o.bankGeneration;}
   if(dirty){current=options.evaluate();dirty=false;}
   if(inCombat||!current)return;
   if(!current.supported&&current.decision?.state!=='complete'){const key=current.decision?.stateFingerprint??current.reason??'unmapped';if(handedOff!==key){handedOff=key;options.onHandoff(current);}}
   else handedOff='';
  },
  refusal(action:any):string|null{
   if(!current||current.supported||!productive(action))return null;
   if(inCombat&&(action.type==='interactNpc'||action.type==='spellOnNpc')&&(target!==undefined&&action.npcIndex===target||action.type==='interactNpc'&&target===undefined&&action.npcIndex===undefined))return null;
   return 'progression handoff: '+(current.reason??current.decision?.reason??'unmapped progression entry');
  },
  current:()=>current,
 };
}
