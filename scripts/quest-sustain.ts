import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseConfigs} from '../packages/knowledge/src/config';
import {waitUntil,type TickSource} from '../packages/core/src/ticks';

// Policy/form selection adapted from rs2b2t/rs2b0t@6e747f8bda494d9f75365b5533cf758d353dcc3b,
// AIOQuesterLogic.selectSustainConsumable/resolveSustainPolicy and AIOQuester.eatOnce.
// MIT notice: quest-sustain.NOTICE.txt. Values come from our pinned content, not modern OSRS.
type FoodDefinition={heal:number;next?:number};
type FoodItem={id:number;slot:number;count:number;optionsWithIndex?:{text:string;opIndex:number}[]};
type FoodPolicy={food:readonly number[];eatAt:number;reserved?:Readonly<Record<number,number>>};
let definitions:Map<number,FoodDefinition>|undefined;
export function questFoodDefinitions():ReadonlyMap<number,FoodDefinition>{
 if(definitions)return definitions;
 const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
 const ids=new Map(readFileSync(resolve(content,'pack/obj.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
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

export function selectQuestFood(state:any,policy:FoodPolicy){
 const skill=state?.skills?.find((s:any)=>s.name==='Hitpoints'),hp=skill?.level,max=skill?.baseLevel;
 if(!Number.isFinite(hp)||!Number.isFinite(max)||hp<=0||max<=0||hp>=max||hp>policy.eatAt)return null;
 const defs=questFoodDefinitions(),allowed=new Set<number>();
 for(const id of policy.food){let current:number|undefined=id;const seen=new Set<number>();while(current!==undefined&&!seen.has(current)&&defs.has(current)){seen.add(current);allowed.add(current);current=defs.get(current)?.next;}}
 const inventory:FoodItem[]=state?.inventory??[],counts=new Map<number,number>();
 for(const i of inventory)counts.set(i.id,(counts.get(i.id)??0)+i.count);
 const choices=inventory.flatMap(item=>{
  const reserve=policy.reserved?.[item.id]??0;
  if(!allowed.has(item.id)||!Number.isSafeInteger(reserve)||reserve<0||(counts.get(item.id)??0)<=reserve)return [];
  const op=item.optionsWithIndex?.find(o=>/^(eat|drink)$/i.test(o.text));
  return op&&Number.isSafeInteger(item.slot)&&Number.isSafeInteger(op.opIndex)?[{item,opIndex:op.opIndex,definition:defs.get(item.id)!,hp}]:[];
 });
 return choices.find(c=>c.definition.heal<=max-hp)??choices[0]??null;
}

export function startQuestSustain(s:TickSource&{direct(action:any):Promise<{success:boolean;message?:string}>},options:Omit<FoodPolicy,'reserved'>&{reserved?:Readonly<Record<number,number>>|(()=>Readonly<Record<number,number>>);timeoutTicks?:number;onConsumed?:(effect:{id:number;hpBefore:number;hpAfter:number})=>void}){
 const timeout=options.timeoutTicks??6;
 if(!Number.isSafeInteger(timeout)||timeout<1)throw Error('invalid quest sustain deadline');
 let stopped=false,draining=false,failure:string|null=null,off=()=>{},lastSent=-Infinity;
 const ac=new AbortController();
 const initial=s.sdk.getState()?.player,lifeId=initial?.lifeId,respawns=initial?.respawnCount??0;
 const count=(st:any,id:number)=>(st?.inventory??[]).filter((i:any)=>i.id===id).reduce((n:number,i:any)=>n+i.count,0);
 type Pending={selected:NonNullable<ReturnType<typeof selectQuestFood>>;before:number;nextBefore:number;at:number;accepted:boolean};
 let pending:Pending|undefined;
 const stop=()=>{stopped=true;off();};
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
    pending=undefined;options.onConsumed?.({id:p.selected.item.id,hpBefore:p.selected.hp,hpAfter:state?.skills?.find((v:any)=>v.name==='Hitpoints')?.level??p.selected.hp});return;
   }
   if(s.tick()-p.at>=timeout)fail(next!==undefined&&!transformed?'food transform unobserved':'food debit unobserved');
   return;
  }
  if(draining||s.tick()-lastSent<3)return;
  // Resolve current eligibility/slot at dispatch, rather than retaining a previous-tick selection.
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
