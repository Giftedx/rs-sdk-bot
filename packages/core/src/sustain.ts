import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs} from '../../knowledge/src/config';
import {waitUntil,type TickSource} from './ticks';

// Policy/form selection adapted from rs2b2t/rs2b0t@6e747f8bda494d9f75365b5533cf758d353dcc3b,
// AIOQuesterLogic.selectSustainConsumable/resolveSustainPolicy and AIOQuester.eatOnce.
// MIT notice: scripts/quest-sustain.NOTICE.txt. Values come from our pinned content, not modern OSRS.
export type FoodDefinition={heal:number;next?:number};
export type FoodItem={id:number;slot:number;count:number;optionsWithIndex?:{text:string;opIndex:number}[]};
export type FoodPolicy={food:readonly number[];eatAt:number|((maxHp:number)=>number);reserved?:Readonly<Record<number,number>>};

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
export function selectQuestFood(state:any,policy:FoodPolicy){
 const skill=state?.skills?.find((s:any)=>s.name==='Hitpoints'),hp=skill?.level,max=skill?.baseLevel;
 if(!Number.isFinite(hp)||!Number.isFinite(max)||hp<=0||max<=0||hp>=max||hp>(typeof policy.eatAt==='function'?policy.eatAt(max):policy.eatAt))return null;
 const defs=questFoodDefinitions(),allowed=expandFoodStages(policy.food);
 const inventory:FoodItem[]=state?.inventory??[];
 if(!inventory.length)return null;
 const reserved=policy.reserved;
 let counts:Map<number,number>|undefined;
 if(reserved){
  counts=new Map<number,number>();
  for(const i of inventory)counts.set(i.id,(counts.get(i.id)??0)+i.count);
 }
 let fallback:{item:FoodItem;opIndex:number;definition:FoodDefinition;hp:number}|null=null;
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

// The eat guard of a session (eat-guard.ts) registers its hold here, by the session's SDK object. An eater with
// timing or checks of its own holds the guard from its start to its stop: a quest sustain, whose debit check accepts
// no second eater, and the PK fight loop (scripts/pk.ts). `ateAt` is the tick of the guard's last eat: the food delay
// of that eat ends 3 ticks later.
type EaterHold=()=>{ateAt:number;release():void};
const sessionEaters=new WeakMap<object,EaterHold>();
export const registerSessionEater=(sdk:object,hold:EaterHold):void=>{sessionEaters.set(sdk,hold);};
export const holdSessionEater=(sdk:object):{ateAt:number;release():void}=>sessionEaters.get(sdk)?.()??{ateAt:-Infinity,release(){}};

export function startQuestSustain(s:TickSource&{direct(action:any):Promise<{success:boolean;message?:string}>},options:Omit<FoodPolicy,'reserved'>&{reserved?:Readonly<Record<number,number>>|(()=>Readonly<Record<number,number>>);timeoutTicks?:number;dropRetries?:number;onConsumed?:(effect:{id:number;hpBefore:number;hpAfter:number})=>void}){
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
 const count=(st:any,id:number)=>(st?.inventory??[]).filter((i:any)=>i.id===id).reduce((n:number,i:any)=>n+i.count,0);
 type Pending={selected:NonNullable<ReturnType<typeof selectQuestFood>>;before:number;nextBefore:number;at:number;accepted:boolean};
 let pending:Pending|undefined;
 const stop=()=>{stopped=true;off();held.release();};
 const fail=(why:string)=>{failure='quest sustain: '+why;ac.abort(failure);stop();};
 off=s.onTick(()=>{
  if(stopped)return;
  const state=s.sdk.getState();
  const player=state?.player;
  if(player&&(player.isDead||(player.respawnCount??0)>respawns||(lifeId!==undefined&&player.lifeId!==lifeId))){fail('account life changed');return;}
  if(pending){
   const p=pending,debit=p.before-count(state,p.selected.item.id),next=p.selected.definition.next;
   const transformed=next===undefined||count(state,next)===p.nextBefore+1;
   if(p.accepted&&debit===1&&transformed){
    pending=undefined;dropped=0;options.onConsumed?.({id:p.selected.item.id,hpBefore:p.selected.hp,hpAfter:state?.skills?.find((v:any)=>v.name==='Hitpoints')?.level??p.selected.hp});return;
   }
   if(s.tick()-p.at>=timeout){
    if(p.accepted&&debit===0&&(next===undefined||count(state,next)===p.nextBefore)&&dropped<dropRetries){dropped++;pending=undefined;return;}
    fail(next!==undefined&&!transformed?'food transform unobserved':'food debit unobserved');
   }
   return;
  }
  if(draining||s.tick()-lastSent<3)return;
  const reserved=typeof options.reserved==='function'?options.reserved():options.reserved;
  const choice=selectQuestFood(state,{...options,reserved});if(!choice)return;
  const selected={...choice,item:{...choice.item}};
  const p:Pending={selected,before:count(state,selected.item.id),nextBefore:selected.definition.next===undefined?0:count(state,selected.definition.next),at:s.tick(),accepted:false};pending=p;lastSent=s.tick();
  try{void s.direct({type:'useInventoryItem',slot:selected.item.slot,optionIndex:selected.opIndex,reason:'SDK'}).then(reply=>{
   if(stopped)return;if(reply.success!==true)fail('consume refused: '+(reply.message??'unknown'));else p.accepted=true;
  }).catch(error=>{if(!stopped)fail('consume failed: '+String(error));});}catch(error){fail('consume failed: '+String(error));}
 });
 void s.ended?.then(stop);
 const settle=async()=>{
  draining=true;
  if(pending&&!stopped){await waitUntil(s,()=>!pending||!!failure,{timeoutTicks:timeout+1});if(pending&&!failure)fail('final consume effect unobserved');}
  stop();
 };
 return {stop,settle,failure:()=>failure,aborted:ac.signal};
}
