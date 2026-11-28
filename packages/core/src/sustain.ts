import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs} from '../../knowledge/src/config';
import {waitUntil,type TickSource} from './ticks';
import {unwrapGuarded} from './worker-execution';

// Policy/form selection adapted from rs2b2t/rs2b0t@6e747f8bda494d9f75365b5533cf758d353dcc3b,
// AIOQuesterLogic.selectSustainConsumable/resolveSustainPolicy and AIOQuester.eatOnce.
// MIT notice: scripts/quest-sustain.NOTICE.txt. Values come from our pinned content, not modern OSRS.
export type FoodDefinition={heal:number;next?:number};
export type FoodItem={id:number;slot:number;count:number;optionsWithIndex?:{text:string;opIndex:number}[]};
export type FoodPolicy={food:readonly number[];eatAt:number|((maxHp:number)=>number);reserved?:Readonly<Record<number,number>>};
export type ComboFoodPolicy=FoodPolicy&{comboFood?:readonly number[];comboAt?:number|((maxHp:number)=>number)};
export type SelectedFood={item:FoodItem;opIndex:number;definition:FoodDefinition;hp:number};
export type SelectedComboFood={primary:SelectedFood;combo:SelectedFood;totalHeal:number;hp:number};

// Server-verified zero-delay combo foods (consume.rs2:38-39 pass null eat_delay and null skill_delay, so they
// stack with normal food in the same tick and add 0 attack delay). IDs from pack/obj.pack.
export const COOKED_KARAMBWAN_ID=3144;
export const COOKED_KARAMBWANJI_ID=3151;
export const COMBO_FOOD_IDS:ReadonlySet<number>=new Set([COOKED_KARAMBWAN_ID,COOKED_KARAMBWANJI_ID]);
export const isComboFood=(id:number):boolean=>COMBO_FOOD_IDS.has(id);

// A quest or worker with no eat level of its own eats at 60% of its maximum, at most 40.
export const defaultEatAt=(maxHp:number)=>Math.min(40,Math.max(10,Math.floor(maxHp*0.6)));

let definitions:Map<number,FoodDefinition>|undefined;
let objIds:ReadonlyMap<string,number>|undefined;
const chainCache=new Map<string,ReadonlySet<number>>();
const contentDir=()=>resolve(import.meta.dir,'../../../vendor/rs-sdk/server/content');

// Item id of a content debug name (pack/obj.pack), e.g. 'shark' 385.
export function objIdByDebugName(name:string):number|undefined{
 if(!objIds){
  const text=readFileSync(resolve(contentDir(),'pack/obj.pack'),'utf8');
  const map=new Map<string,number>();
  let pos=0;
  while(pos<text.length){
   let end=text.indexOf('\n',pos);
   if(end<0)end=text.length;
   const lineEnd=end>pos&&text.charCodeAt(end-1)===13?end-1:end;
   const eq=text.indexOf('=',pos);
   if(eq>pos&&eq<lineEnd){
    const id=Number(text.slice(pos,eq));
    if(Number.isInteger(id)&&id>=0)map.set(text.slice(eq+1,lineEnd),id);
   }
   pos=end+1;
  }
  objIds=map;
 }
 return objIds.get(name);
}

// The ids of a food from this stage to its last bite: a cake is cake, partial cake, cake slice.
export function foodStages(id:number):number[]{
 const defs=questFoodDefinitions(),out:number[]=[];
 for(let c:number|undefined=id;c!==undefined&&defs.has(c)&&!out.includes(c);c=defs.get(c)!.next)out.push(c);
 return out;
}
// Hitpoints a food heals over all its bites from this stage on; undefined when the content has no such food.
export function foodTotalHeal(id:number):number|undefined{
 const defs=questFoodDefinitions();
 return defs.has(id)?foodStages(id).reduce((n,s)=>n+defs.get(s)!.heal,0):undefined;
}
// The cow farm's food: trout and the two cakes of the Ardougne bakery, each with its later stages.
export const COW_FOOD_ROOTS=['trout','cake','chocolate_cake'] as const;
export const cowFoodIds=():number[]=>COW_FOOD_ROOTS.flatMap(n=>foodStages(objIdByDebugName(n)!));

export function questFoodDefinitions():ReadonlyMap<number,FoodDefinition>{
 if(definitions)return definitions;
 const content=contentDir();
 objIdByDebugName('');
 const ids=objIds!;
 const foods=new Map<number,FoodDefinition>();
 const file='scripts/player/configs/consumption/consume_normal.dbrow';
 for(const block of parseConfigs(readFileSync(resolve(content,file),'utf8'),file)){
  const data=block.props.data??[],heal=data.find(v=>/^stat_heal,hitpoints,\d+,0$/.test(v));
  if(!heal||Number(heal.split(',')[2])<=0)continue;
  for(const row of data.filter(v=>v.startsWith('consumable,'))){const id=ids.get(row.slice('consumable,'.length));if(id!==undefined)foods.set(id,{heal:Number(heal.split(',')[2])});}
 }
 for(const file of ['pies/pies.obj','cakes/cakes.obj','pizza/pizza.obj']){
  const path='scripts/skill_cooking/configs/cooking_inv/configs/'+file;
  for(const b of parseConfigs(readFileSync(resolve(content,path),'utf8'),path)){
   const id=ids.get(b.name),food=id===undefined?undefined:foods.get(id);
   const next=b.props.param?.find(v=>v.startsWith('next_obj_stage,'))?.split(',')[1];
   if(food&&next&&ids.has(next))food.next=ids.get(next);
  }
 }
 definitions=foods;return foods;
}

// Cached multi-bite stage expansion (e.g. cake 1891 -> 1893 -> 1895) so per-tick sustain checks do zero graph traversals.
export function expandFoodStages(foodIds:readonly number[]):ReadonlySet<number>{
 const key=foodIds.join(',');
 const hit=chainCache.get(key);
 if(hit)return hit;
 const defs=questFoodDefinitions(),allowed=new Set<number>();
 for(const id of foodIds){
  let current:number|undefined=id;
  while(current!==undefined&&!allowed.has(current)&&defs.has(current)){
   allowed.add(current);
   current=defs.get(current)?.next;
  }
 }
 chainCache.set(key,allowed);
 return allowed;
}

let allEdibleFoodIds:ReadonlySet<number>|undefined;
export function allFoodIds():ReadonlySet<number>{
 return allEdibleFoodIds??=new Set(questFoodDefinitions().keys());
}

// Total effective HP healing available in an inventory/bank item list, accounting for multi-stage foods and reservations.
export function totalAvailableHeal(items:readonly {id:number;count:number}[],foodIds:readonly number[],reserved:Readonly<Record<number,number>>={}):number{
 const defs=questFoodDefinitions(),allowed=expandFoodStages(foodIds);
 const stageHeal=(id:number):number=>{
  let total=0,cur:number|undefined=id;const seen=new Set<number>();
  while(cur!==undefined&&!seen.has(cur)&&defs.has(cur)){
   seen.add(cur);
   total+=defs.get(cur)!.heal;
   cur=defs.get(cur)?.next;
  }
  return total;
 };
 const counts=new Map<number,number>();
 for(const i of items)if(allowed.has(i.id)&&i.count>0)counts.set(i.id,(counts.get(i.id)??0)+i.count);
 let hp=0;
 for(const [id,count] of counts){
  const usable=Math.max(0,count-Math.max(0,reserved[id]??0));
  if(usable>0)hp+=usable*stageHeal(id);
 }
 return hp;
}

const EAT_OR_DRINK_RE=/^(eat|drink)$/i;
function findHitpointsSkill(state:any):{hp:number;max:number}|null{
 const skills=state?.skills;
 if(!Array.isArray(skills))return null;
 for(let i=0;i<skills.length;i++){
  const s=skills[i];
  if(s?.name==='Hitpoints'){
   const hp=s.level,max=s.baseLevel;
   return Number.isFinite(hp)&&Number.isFinite(max)&&hp>0&&max>0?{hp,max}:null;
  }
 }
 return null;
}

export function selectQuestFood(state:any,policy:FoodPolicy):SelectedFood|null{
 const vitals=findHitpointsSkill(state);
 if(!vitals)return null;
 const {hp,max}=vitals;
 if(hp>=max||hp>(typeof policy.eatAt==='function'?policy.eatAt(max):policy.eatAt))return null;
 const defs=questFoodDefinitions(),allowed=expandFoodStages(policy.food);
 const inventory:FoodItem[]=state?.inventory??[];
 if(!inventory.length)return null;
 const reserved=policy.reserved;
 let counts:Map<number,number>|undefined;
 if(reserved){
  counts=new Map<number,number>();
  for(const i of inventory)counts.set(i.id,(counts.get(i.id)??0)+i.count);
 }
 let fallback:SelectedFood|null=null;
 const need=max-hp;
 for(let k=0;k<inventory.length;k++){
  const item=inventory[k]!;
  if(!allowed.has(item.id)||!Number.isSafeInteger(item.slot))continue;
  if(reserved){
   const reserve=reserved[item.id]??0;
   if(!Number.isSafeInteger(reserve)||reserve<0||(counts!.get(item.id)??0)<=reserve)continue;
  }
  const op=item.optionsWithIndex?.find(o=>EAT_OR_DRINK_RE.test(o.text));
  if(!op||!Number.isSafeInteger(op.opIndex))continue;
  const definition=defs.get(item.id)!;
  if(definition.heal<=need)return {item,opIndex:op.opIndex,definition,hp};
  fallback??={item,opIndex:op.opIndex,definition,hp};
 }
 return fallback;
}

// Selects a primary food + zero-delay combo food (e.g. shark 385 + cooked karambwan 3144) for same-tick combo eating.
export function selectComboFood(state:any,policy:ComboFoodPolicy):SelectedComboFood|null{
 const vitals=findHitpointsSkill(state);
 if(!vitals)return null;
 const {hp,max}=vitals;
 const comboLimit=policy.comboAt!==undefined?(typeof policy.comboAt==='function'?policy.comboAt(max):policy.comboAt):(typeof policy.eatAt==='function'?policy.eatAt(max):policy.eatAt);
 if(hp>=max||hp>comboLimit)return null;
 const comboIds=policy.comboFood??[COOKED_KARAMBWAN_ID];
 if(!comboIds.length)return null;
 const comboSet=new Set(comboIds.filter(isComboFood));
 if(!comboSet.size)return null;
 const primaryFoodIds=policy.food.filter(id=>!comboSet.has(id));
 const primary=primaryFoodIds.length?selectQuestFood(state,{...policy,food:primaryFoodIds,eatAt:comboLimit}):null;
 if(!primary)return null;
 const defs=questFoodDefinitions();
 const inventory:FoodItem[]=state?.inventory??[];
 const reserved=policy.reserved;
 let counts:Map<number,number>|undefined;
 if(reserved){
  counts=new Map<number,number>();
  for(const i of inventory)counts.set(i.id,(counts.get(i.id)??0)+i.count);
 }
 let combo:SelectedFood|null=null;
 const needAfterPrimary=Math.max(0,max-hp-primary.definition.heal);
 for(let k=0;k<inventory.length;k++){
  const item=inventory[k]!;
  if(item.slot===primary.item.slot||!comboSet.has(item.id)||!Number.isSafeInteger(item.slot))continue;
  if(reserved){
   const reserve=reserved[item.id]??0;
   if(!Number.isSafeInteger(reserve)||reserve<0||(counts!.get(item.id)??0)<=reserve)continue;
  }
  const op=item.optionsWithIndex?.find(o=>EAT_OR_DRINK_RE.test(o.text));
  if(!op||!Number.isSafeInteger(op.opIndex))continue;
  const definition=defs.get(item.id);
  if(!definition)continue;
  const candidate:SelectedFood={item,opIndex:op.opIndex,definition,hp};
  if(definition.heal<=needAfterPrimary){combo=candidate;break;}
  combo??=candidate;
 }
 if(!combo)return null;
 return {primary,combo,totalHeal:primary.definition.heal+combo.definition.heal,hp};
}

// Dispatches primary food + zero-delay combo food (plus optional attack resend) in a single tick with zero sleeps.
export async function comboEat(
 s:{direct(action:any):Promise<{success?:boolean;message?:string}>},
 state:any,
 policy:ComboFoodPolicy,
 attack?:{type:string;[k:string]:unknown},
):Promise<{dispatched:boolean;combo:boolean;items:number[];totalHeal:number}>{
 const pair=selectComboFood(state,policy);
 if(pair){
  const actions:any[]=[
   {type:'useInventoryItem',slot:pair.primary.item.slot,optionIndex:pair.primary.opIndex,reason:'SDK'},
   {type:'useInventoryItem',slot:pair.combo.item.slot,optionIndex:pair.combo.opIndex,reason:'SDK'},
   ...(attack?[{...attack}]:[]),
  ];
  await Promise.all(actions.map(a=>s.direct(a)));
  return {dispatched:true,combo:true,items:[pair.primary.item.id,pair.combo.item.id],totalHeal:pair.totalHeal};
 }
 const single=selectQuestFood(state,policy);
 if(!single)return {dispatched:false,combo:false,items:[],totalHeal:0};
 const actions:any[]=[
  {type:'useInventoryItem',slot:single.item.slot,optionIndex:single.opIndex,reason:'SDK'},
  ...(attack?[{...attack}]:[]),
 ];
 await Promise.all(actions.map(a=>s.direct(a)));
 return {dispatched:true,combo:false,items:[single.item.id],totalHeal:single.definition.heal};
}

// The eat guard of a session (eat-guard.ts) registers its hold here, by the session's SDK object. An eater with
// timing or checks of its own holds the guard from its start to its stop: a quest sustain, whose debit check accepts
// no second eater, and the PK fight loop (scripts/pk.ts). `ateAt` is the tick of the guard's last eat: the food delay
// of that eat ends 3 ticks later.
type EaterHold=()=>{ateAt:number;release():void};
const sessionEaters=new WeakMap<object,EaterHold>();
export const registerSessionEater=(sdk:object,hold:EaterHold):void=>{sessionEaters.set(unwrapGuarded(sdk),hold);};
export const holdSessionEater=(sdk:object):{ateAt:number;release():void}=>sessionEaters.get(unwrapGuarded(sdk))?.()??{ateAt:-Infinity,release(){}};

export function startQuestSustain(s:TickSource&{direct(action:any):Promise<{success:boolean;message?:string}>},options:Omit<ComboFoodPolicy,'reserved'>&{reserved?:Readonly<Record<number,number>>|(()=>Readonly<Record<number,number>>);timeoutTicks?:number;dropRetries?:number;onConsumed?:(effect:{id:number;hpBefore:number;hpAfter:number})=>void}){
 // `dropRetries`: how many times in a row an eat with no effect at all (the food count and the next item unchanged) is
 // sent again before the eater fails. The game drops an eat sent while the player is delayed or a window is open
 // (Underground Pass: a failed trap disarm hits inside its delay). Default 0: the first eat with no effect fails.
 const timeout=options.timeoutTicks??6,dropRetries=options.dropRetries??0;let dropped=0;
 if(!Number.isSafeInteger(timeout)||timeout<1)throw Error('invalid quest sustain deadline');
 const held=holdSessionEater(s.sdk);
 // An eat of the guard in the last ticks still holds the food delay: the first eat here waits for it.
 let stopped=false,draining=false,failure:string|null=null,off=()=>{},lastSent=held.ateAt;
 const ac=new AbortController();
 const initial=s.sdk.getState()?.player,lifeId=initial?.lifeId,respawns=initial?.respawnCount??0;
 const count=(st:any,id:number)=>{
  const inv=st?.inventory;
  if(!Array.isArray(inv))return 0;
  let total=0;
  for(let i=0;i<inv.length;i++)if(inv[i].id===id)total+=inv[i].count;
  return total;
 };
 type PendingEntry={selected:SelectedFood;before:number;nextBefore:number;accepted:boolean};
 type Pending={entries:PendingEntry[];at:number;setsDelay:boolean};
 let pending:Pending|undefined;
 const stop=()=>{stopped=true;off();held.release();};
 const fail=(why:string)=>{failure='quest sustain: '+why;ac.abort(failure);stop();};
 off=s.onTick(()=>{
  if(stopped)return;
  const state=s.sdk.getState();
  const player=state?.player;
  if(player&&(player.isDead||(player.respawnCount??0)>respawns||(lifeId!==undefined&&player.lifeId!==lifeId))){fail('account life changed');return;}
  if(pending){
   const p=pending;
   let allDone=true,anyChange=false,transformFail=false;
   for(let i=0;i<p.entries.length;i++){
    const e=p.entries[i]!;
    const debit=e.before-count(state,e.selected.item.id),next=e.selected.definition.next;
    const transformed=next===undefined||count(state,next)===e.nextBefore+1;
    if(debit!==0||(next!==undefined&&count(state,next)!==e.nextBefore))anyChange=true;
    if(!(e.accepted&&debit===1&&transformed)){
     allDone=false;
     if(next!==undefined&&!transformed)transformFail=true;
    }
   }
   if(allDone){
    pending=undefined;dropped=0;
    const hpAfter=findHitpointsSkill(state)?.hp;
    for(const e of p.entries)options.onConsumed?.({id:e.selected.item.id,hpBefore:e.selected.hp,hpAfter:hpAfter??e.selected.hp});
    // Avoid wasting a dead tick when a lagged normal eat or zero-delay combo eat already cleared the delay window.
    if(draining||(p.setsDelay&&s.tick()-lastSent<3))return;
   }else{
    if(s.tick()-p.at>=timeout){
     if(p.entries.every(e=>e.accepted)&&!anyChange&&dropped<dropRetries){dropped++;pending=undefined;return;}
     fail(transformFail?'food transform unobserved':'food debit unobserved');
    }
    return;
   }
  }
  if(draining)return;
  const reserved=typeof options.reserved==='function'?options.reserved():options.reserved;
  const policy:ComboFoodPolicy={...options,reserved};
  const delayReady=s.tick()-lastSent>=3;
  let picks:SelectedFood[]=[];
  let setsDelay=false;
  if(delayReady&&options.comboFood?.length){
   const combo=selectComboFood(state,policy);
   if(combo){picks=[combo.primary,combo.combo];setsDelay=true;}
  }
  if(!picks.length){
   const choice=delayReady
    ? selectQuestFood(state,policy)
    : (options.comboFood?.length?selectQuestFood(state,{...policy,food:options.comboFood.filter(isComboFood),eatAt:policy.comboAt??policy.eatAt}):null);
   if(!choice)return;
   picks=[choice];
   setsDelay=!isComboFood(choice.item.id);
  }
  const entries:PendingEntry[]=picks.map(choice=>{
   const selected={...choice,item:{...choice.item}};
   return {selected,before:count(state,selected.item.id),nextBefore:selected.definition.next===undefined?0:count(state,selected.definition.next),accepted:false};
  });
  const p:Pending={entries,at:s.tick(),setsDelay};
  pending=p;
  if(setsDelay)lastSent=s.tick();
  for(const e of entries){
   try{void s.direct({type:'useInventoryItem',slot:e.selected.item.slot,optionIndex:e.selected.opIndex,reason:'SDK'}).then(reply=>{
    if(stopped)return;if(reply.success!==true)fail('consume refused: '+(reply.message??'unknown'));else e.accepted=true;
   }).catch(error=>{if(!stopped)fail('consume failed: '+String(error));});}catch(error){fail('consume failed: '+String(error));}
  }
 });
 void s.ended?.then(stop);
 const settle=async()=>{
  draining=true;
  if(pending&&!stopped){await waitUntil(s,()=>!pending||!!failure,{timeoutTicks:timeout+1});if(pending&&!failure)fail('final consume effect unobserved');}
  stop();
 };
 return {stop,settle,failure:()=>failure,aborted:ac.signal};
}
