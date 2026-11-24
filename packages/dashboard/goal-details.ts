import { questDefinitions, QUEST_SOURCE } from '../core/src/quest-status';
import type { GoalRow } from './goal-types';

const recent=(at:any,now:number)=>Number.isFinite(at)&&at>0&&at<=now&&now-at<300000;
const dated=(at:any,now:number)=>Number.isFinite(at)&&at>0&&at<=now;
const row=(label:string,value:string,source:string,at?:number):GoalRow=>({label,value,source,...(at?{at}:{})});
export const GEAR_TARGETS=[
 {id:1149,slot:'Hat',need:'Defence 60',source:'KBD / rare drop'},
 {id:1052,slot:'Cape',need:'Legends Quest',source:'Legends Guild shop'},
 {id:1664,slot:'Neck',need:'Crafting 72 to make',source:'Gold bar + dragonstone'},
 {id:1377,slot:'Weapon',need:"Attack 60 + Hero’s Quest",source:'Heroes Guild shop'},
 {id:3140,slot:'Body',need:'Defence 60',source:'Kalphite Queen drop'},
 {id:1187,slot:'Shield',need:'Defence 60 + Legends; Smithing 60 to make',source:'Rare left half + shop right half'},
 {id:4087,slot:'Legs',need:'Defence 60',source:'Metal dragon drops'},
 {id:3391,slot:'Hands',need:'Magic 40 + Defence 40',source:'Bark + fine cloth + 1,000 coins'},
 {id:3393,slot:'Feet',need:'Magic 40 + Defence 40',source:'Bark + fine cloth + 1,000 coins'},
 {id:1645,equivalentIds:[2572],slot:'Ring',need:'Crafting 55 to make',source:'Dragonstone ring; ring of wealth scores equally'},
];

const TARGET_ITEMS_CACHE=new WeakMap<any[],{len:number;first:any;last:any;byId:Map<number,any>}>();
function indexItemsById(items:any[]){
 const len=items.length,first=len?items[0]:undefined,last=len?items[len-1]:undefined;
 const hit=TARGET_ITEMS_CACHE.get(items);
 if(hit&&hit.len===len&&hit.first===first&&hit.last===last)return hit.byId;
 const byId=new Map<number,any>();
 for(let idx=0;idx<len;idx++){const i=items[idx];if(i&&i.id!==undefined&&!byId.has(i.id))byId.set(i.id,i);}
 TARGET_ITEMS_CACHE.set(items,{len,first,last,byId});
 return byId;
}
const GEAR_ACCEPTED_IDS=GEAR_TARGETS.map(t=>[t.id,...('equivalentIds' in t?t.equivalentIds??[]:[])]);
const GEAR_TARGETS_BY_ITEM_ID=(()=>{
 const map=new Map<number,number[]>();
 GEAR_ACCEPTED_IDS.forEach((ids,idx)=>{
  for(const id of ids){
   let list=map.get(id);
   if(!list){list=[];map.set(id,list);}
   list.push(idx);
  }
 });
 return map;
})();

// These are explicit board-score targets, never a claim of best combat gear.
export function gearProgress(bots:any[],items:any[],now:number){
 const itemsById=indexItemsById(items);
 const holdersByTarget:Array<{name:string;place:'bank'|'pack'|'worn';at:number;recent:boolean}[]>=GEAR_TARGETS.map(()=>[]);
 for(let bi=0;bi<bots.length;bi++){
  const b=bots[bi];
  const locations:[ 'bank'|'pack'|'worn', any, any ][]=[['bank',b.bank,b.bankAt],['pack',b.inventory,b.at],['worn',b.equipment,b.at]];
  for(let li=0;li<3;li++){
   const [place,list,at]=locations[li]!;
   if(!dated(at,now)||!Array.isArray(list))continue;
   let matchedMask=0;
   for(let ii=0;ii<list.length;ii++){
    const item=list[ii];
    if(!item||!Number.isSafeInteger(item.count)||item.count<=0)continue;
    const hitTargets=GEAR_TARGETS_BY_ITEM_ID.get(item.baseId??item.id);
    if(!hitTargets)continue;
    for(let ti=0;ti<hitTargets.length;ti++){
     const idx=hitTargets[ti]!;
     const bit=1<<idx;
     if((matchedMask&bit)!==0)continue;
     matchedMask|=bit;
     holdersByTarget[idx]!.push({name:b.name,place,at,recent:recent(at,now)});
    }
   }
  }
 }
 const targets=GEAR_TARGETS.map((t,idx)=>({...t,item:itemsById.get(t.id),holders:holdersByTarget[idx]!,acceptedIds:GEAR_ACCEPTED_IDS[idx]!}));
 const held=targets.filter(t=>t.holders.some(h=>h.recent)).length;
 const value=targets.every(t=>Number.isFinite(t.item?.cost))?targets.reduce((n,t)=>n+t.item.cost,0):null;
 const source='research/boards-special.md; vendor/rs-sdk/server/content/scripts/levelrequire/scripts/tier60.rs2; vendor/rs-sdk/server/content/scripts/levelrequire/scripts/tier40.rs2; vendor/rs-sdk/server/content/scripts/skill_magic/configs/magic_spells.dbrow:54';
 return {held,total:targets.length,value,rows:[row('Equipment-board target',`${held}/${targets.length} recent owned pieces · ${value?.toLocaleString('en-US')??'?'} base value`,source),row('Target scope','One compatible scoring set; not best combat gear',source),...targets.map(t=>row(`${t.slot} · ${t.item?.name??'ID '+t.id}`,`${t.holders.some(h=>h.recent)?'held':t.holders.length?'old stock':'not observed'} · ${t.need}`,`${source}; ${t.source}; items ${t.acceptedIds.join(',')}; ${t.item?.src??'catalog missing'}; ${t.holders.map(h=>`${h.name} ${h.place} ${new Date(h.at).toISOString()}`).join(', ')}`,t.holders.length?Math.max(...t.holders.map(h=>h.at)):undefined)),row('Wear / staging','Account unlocks + one-account delivery still need proof',source),row('Combat target','Fire Giant: repeat kill credit, banked loot, food used, no death','research/combat-measure.md; .practice/joined-plan/combat-block-review.json')]};
}

let cachedQuestDefs:ReturnType<typeof questDefinitions>|null=null;
let cachedQuestIdMap:Map<number,string>|null=null;
export function questProgress(bots:any[],now:number){
 const definitions=questDefinitions();
 if(cachedQuestDefs!==definitions||!cachedQuestIdMap){
  cachedQuestDefs=definitions;
  cachedQuestIdMap=new Map(definitions.map(d=>[d.id,d.name]));
 }
 const ids=cachedQuestIdMap;
 const accounts=bots.map(b=>{
  const flags=new Map<number,string>();
  const at=Object.hasOwn(b,'questsAt')?b.questsAt:b.at;
  let complete=0;
  if(dated(at,now)&&Array.isArray(b.quests)){
   for(let qi=0;qi<b.quests.length;qi++){
    const q=b.quests[qi];
    if(!q||ids.get(q.id)!==q.name)continue;
    const st=q.state;
    if(st==='not started'||st==='started'||st==='complete'){
     const prev=flags.get(q.id);
     if(prev==='complete')complete--;
     if(st==='complete')complete++;
     flags.set(q.id,st);
    }
   }
  }
  return {b,at,flags,complete};
 });
 let observed=0,completed=0;
 for(let i=0;i<accounts.length;i++){
  if(accounts[i]!.flags.size)observed++;
  completed+=accounts[i]!.complete;
 }
 return {observed,completed,total:definitions.length,rows:[row('Journal flags mapped',`${definitions.length} quests · server colours, not default varps`,QUEST_SOURCE),row('Account flag coverage',`${observed}/${bots.length} owned accounts observed · ${completed} completions recorded`,'packages/core/src/quest-status.ts'),...accounts.flatMap(({b,at,flags,complete})=>{
  const out:GoalRow[]=[row(b.name,flags.size?`${complete} complete · ${flags.size}/${definitions.length} known${recent(at,now)?'':' · old'}`:'No journal observation; awaiting passive status capture',`.practice/status/${b.name}.json`,dated(at,now)?at:undefined)];
  for(const [id,s] of flags)if(s!=='not started')out.push(row(`${b.name} · ${ids.get(id)}`,s,`.practice/status/${b.name}.json`,at));
  return out;
 })]};
}

export function batchCosts(counter:(key:string)=>number|null,accepted:boolean,at?:number){
 const gain=counter('coinsGained'),food=counter('eaten'),ticks=counter('ticks');
 const known=accepted&&Number.isSafeInteger(gain)&&Number.isSafeInteger(food)&&food!>=0&&Number.isSafeInteger(ticks)&&ticks!>0;
 const source='.practice/joined-plan/production-repeat-completed.json; scripts/goldfarm.ts';
 return {known,rows:[row('Net batch resources',known?`${gain!>=0?'+':''}${gain!.toLocaleString('en-US')} coins / −${food} food`:'No accepted resource ledger',source,known?at:undefined),row('Cash rate',known?`${(gain!/ticks!).toFixed(2)} coins/t · food not valued`:'unknown',source,known?at:undefined),row('Direct cash accounting','coinsGained = net bank deposits + end pack − start pack',source),row('Food valuation','Owned fish are consumed assets; not free, not a GE price','research/food-chain.md; research/supply-costs.md'),row('Break-even allowance',known&&food!>0?`${(gain!/food!).toFixed(2)} coins/food before other costs`:'unknown',source,known?at:undefined),row('Supply cost reference','Practice: 238 coins / 100 feathers + 120 boat fares','research/food-chain.md:127; measured practice 2026-10-23'),row('Reference scope','Separate trip; burns, live shop stock and labour differ','research/food-chain.md'),row('Unallocated costs','Food lot + courier fares + producer/support ticks; no matched chain receipt','research/food-chain.md; docs/plans/joined-plan.md'),row('Fleet accounting','Owned transfers cancel; count NPC spend and consumed stock once','research/supply-logistics.md')]};
}
