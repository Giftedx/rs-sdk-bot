import { questDefinitions, QUEST_SOURCE } from '../core/src/quest-status';
import type { GoalRow } from './goals';

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

// These are explicit board-score targets, never a claim of best combat gear.
export function gearProgress(bots:any[],items:any[],now:number){
 const targets=GEAR_TARGETS.map(t=>{
  const acceptedIds=[t.id,...('equivalentIds' in t?t.equivalentIds??[]:[])];
  const item=items.find(i=>i?.id===t.id),holders=bots.flatMap(b=>{
   const locations=[['bank',b.bank,b.bankAt],['pack',b.inventory,b.at],['worn',b.equipment,b.at]] as const;
   return locations.flatMap(([place,list,at])=>dated(at,now)&&Array.isArray(list)&&list.some(i=>i&&acceptedIds.includes(i.baseId??i.id)&&Number.isSafeInteger(i.count)&&i.count>0)?[{name:b.name,place,at,recent:recent(at,now)}]:[]);
  });
  return {...t,item,holders,acceptedIds};
 });
 const held=targets.filter(t=>t.holders.some(h=>h.recent)).length;
 const value=targets.every(t=>Number.isFinite(t.item?.cost))?targets.reduce((n,t)=>n+t.item.cost,0):null;
 const source='research/boards-special.md; vendor/rs-sdk/server/content/scripts/levelrequire/scripts/tier60.rs2; vendor/rs-sdk/server/content/scripts/levelrequire/scripts/tier40.rs2; vendor/rs-sdk/server/content/scripts/skill_magic/configs/magic_spells.dbrow:54';
 return {held,total:targets.length,value,rows:[row('Equipment-board target',`${held}/${targets.length} recent owned pieces · ${value?.toLocaleString('en-US')??'?'} base value`,source),row('Target scope','One compatible scoring set; not best combat gear',source),...targets.map(t=>row(`${t.slot} · ${t.item?.name??'ID '+t.id}`,`${t.holders.some(h=>h.recent)?'held':t.holders.length?'old stock':'not observed'} · ${t.need}`,`${source}; ${t.source}; items ${t.acceptedIds.join(',')}; ${t.item?.src??'catalog missing'}; ${t.holders.map(h=>`${h.name} ${h.place} ${new Date(h.at).toISOString()}`).join(', ')}`,t.holders.length?Math.max(...t.holders.map(h=>h.at)):undefined)),row('Wear / staging','Account unlocks + one-account delivery still need proof',source),row('Combat target','Fire Giant: repeat kill credit, banked loot, food used, no death','research/combat-measure.md; .practice/joined-plan/combat-block-review.json')]};
}

export function questProgress(bots:any[],now:number){
 const definitions=questDefinitions(),ids=new Map(definitions.map(d=>[d.id,d.name]));
 const accounts=bots.map(b=>{
  const flags=new Map<number,string>();
  const at=Object.hasOwn(b,'questsAt')?b.questsAt:b.at;
  if(dated(at,now)&&Array.isArray(b.quests))for(const q of b.quests)if(q&&ids.get(q.id)===q.name&&['not started','started','complete'].includes(q.state))flags.set(q.id,q.state);
  return {b,at,flags,complete:[...flags.values()].filter(v=>v==='complete').length};
 });
 const observed=accounts.filter(a=>a.flags.size),completed=accounts.reduce((n,a)=>n+a.complete,0);
 return {observed:observed.length,completed,total:definitions.length,rows:[row('Journal flags mapped',`${definitions.length} quests · server colours, not default varps`,QUEST_SOURCE),row('Account flag coverage',`${observed.length}/${bots.length} owned accounts observed · ${completed} completions recorded`,'packages/core/src/quest-status.ts'),...accounts.flatMap(({b,at,flags,complete})=>[row(b.name,flags.size?`${complete} complete · ${flags.size}/${definitions.length} known${recent(at,now)?'':' · old'}`:'No journal observation; awaiting passive status capture',`.practice/status/${b.name}.json`,dated(at,now)?at:undefined),...([...flags].filter(([,s])=>s!=='not started').map(([id,s])=>row(`${b.name} · ${ids.get(id)}`,s,`.practice/status/${b.name}.json`,at)))]) ]};
}

export function batchCosts(counter:(key:string)=>number|null,accepted:boolean,at?:number){
 const gain=counter('coinsGained'),food=counter('eaten'),ticks=counter('ticks');
 const known=accepted&&Number.isSafeInteger(gain)&&Number.isSafeInteger(food)&&food!>=0&&Number.isSafeInteger(ticks)&&ticks!>0;
 const source='.practice/joined-plan/production-repeat-completed.json; scripts/goldfarm.ts';
 return {known,rows:[row('Net batch resources',known?`${gain!>=0?'+':''}${gain!.toLocaleString('en-US')} coins / −${food} food`:'No accepted resource ledger',source,known?at:undefined),row('Cash rate',known?`${(gain!/ticks!).toFixed(2)} coins/t · food not valued`:'unknown',source,known?at:undefined),row('Direct cash accounting','coinsGained = net bank deposits + end pack − start pack',source),row('Food valuation','Owned fish are consumed assets; not free, not a GE price','research/food-chain.md; research/supply-costs.md'),row('Break-even allowance',known&&food!>0?`${(gain!/food!).toFixed(2)} coins/food before other costs`:'unknown',source,known?at:undefined),row('Supply cost reference','Practice: 238 coins / 100 feathers + 120 boat fares','research/food-chain.md:127; measured practice 2026-10-23'),row('Reference scope','Separate trip; burns, live shop stock and labour differ','research/food-chain.md'),row('Unallocated costs','Food lot + courier fares + producer/support ticks; no matched chain receipt','research/food-chain.md; docs/plans/joined-plan.md'),row('Fleet accounting','Owned transfers cancel; count NPC spend and consumed stock once','research/supply-logistics.md')]};
}
