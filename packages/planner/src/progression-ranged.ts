import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ObservedAccount,ProgressionMethod} from './progression';
import {ORDER_COIN_MARGIN} from '../../core/src/order-refusal';
const GE_CASH_RESERVE=500;
import type {Gear} from '../../knowledge/src/gear';
import type {Step} from '../../core/src/chain-step';
import {standardBowTiers,standardArrowTiers} from './gear-progression';

export type RangedProgressionAccount=ObservedAccount;
// The standard bows and arrows by Ranged wear level, from knowledge/gear.json (gear-progression.ts). A level lists its
// shortbow first, as the kit ranking breaks ties by that order.
const bows=standardBowTiers().slice().reverse().flatMap(t=>t.ids.map(id=>({id,level:t.level})));
const arrows=standardArrowTiers().sort((x,y)=>x.id-y.id).map(({id,level})=>({id,level}));
const foods=[385,373,379,333,2142,2309,1901,1895,1893,1891];
let gear:Map<number,Gear>|undefined;
const items=()=>gear??=new Map((JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/gear.json'),'utf8')) as Gear[]).map(g=>[g.id,g]));
const stock=(a:ObservedAccount)=>{
 const out:Record<number,number>={};
 for(const observation of [a.inventory,a.equipment,a.bank])for(const [id,n] of Object.entries(observation?.value??{}))out[Number(id)]=(out[Number(id)]??0)+n;
 for(const [id,n] of Object.entries(a.reservations??{}))out[Number(id)]=Math.max(0,(out[Number(id)]??0)-n);
 return out;
};
const ranged=(a:ObservedAccount)=>Object.entries(a.skills).find(([name])=>name.toLowerCase()==='ranged')?.[1].level??0;
export function rangedKit(a:ObservedAccount){
 if(!a.bank||!a.inventory||!a.equipment)return null;
 const owned=stock(a),level=ranged(a),all=items();
 const armour=Object.keys(a.equipment.value).map(Number).map(id=>all.get(id)).filter((g):g is Gear=>!!g&&!['righthand','lefthand','quiver'].includes(g.slot));
 const attack=armour.reduce((n,g)=>n+g.bonuses.rangeAttack,0),strength=armour.reduce((n,g)=>n+g.bonuses.rangeStrength,0);
 const options=bows.filter(b=>b.level<=level&&(owned[b.id]??0)>0).flatMap(b=>arrows.filter(q=>q.level<=b.level&&q.level<=level&&(owned[q.id]??0)>=3).map(q=>({
  bow:b.id,arrow:q.id,bowLevel:b.level,arrows:owned[q.id]!,attack:attack+(all.get(b.id)?.bonuses.rangeAttack??0),
  strength:strength+(all.get(q.id)?.bonuses.rangeStrength??0),interval:Math.max(1,(all.get(b.id)?.attackRate??4)-1),
 })));
 return options.sort((x,y)=>rangedModelRate(level,y,22,12)-rangedModelRate(level,x,22,12)||y.strength-x.strength||x.bow-y.bow||x.arrow-y.arrow)[0]??null;
}
// Stop at the next owned or acquirable Ranged tier unlock before target. A tier is acquirable only when its bow and its
// arrows each have a source: owned (three arrows, as rangedKit counts), or a method of rangedProgressionMethods that
// acquires the item at that level. A stop with no source ends the band with nothing to gain there (no method buys a
// yew shortbow or rune arrows).
const tierUpgrades:Record<number,{bow:number;arrow:number;minCoins:number}>={
 5:{bow:843,arrow:886,minCoins:100},
 20:{bow:849,arrow:888,minCoins:2500},
 30:{bow:853,arrow:888,minCoins:5000},
 40:{bow:857,arrow:892,minCoins:3000},
};
export function rangedBandTarget(a:ObservedAccount,target:number){
 const current=rangedKit(a),level=ranged(a);
 const skill=Object.keys(a.skills).find(name=>name.toLowerCase()==='ranged')!;
 const heldCoins=Math.max(0,[a.inventory,a.bank,a.equipment].reduce((n,b)=>n+(b?.value[995]??0),0)-(a.reservations?.[995]??0));
 const owned=stock(a),methods=rangedProgressionMethods(a,target);
 const sourced=(id:number,need:number,boundary:number)=>(owned[id]??0)>=need||methods.some(m=>(m.effects.items?.[id]??0)>0&&(m.requirements?.levels?.Ranged??1)<=boundary);
 for(const boundary of [...new Set(bows.map(b=>b.level))].filter(n=>n>level&&n<target).sort((x,y)=>x-y)){
  if(current){
   const next=rangedKit({...a,skills:{...a.skills,[skill]:{...a.skills[skill]!,level:boundary}}});
   if(next&&(next.bow!==current.bow||next.arrow!==current.arrow))return boundary;
  }
  const upgrade=tierUpgrades[boundary];
  if(upgrade&&heldCoins>=upgrade.minCoins&&sourced(upgrade.bow,1,boundary)&&sourced(upgrade.arrow,3,boundary)&&(!current||current.bowLevel<boundary||(boundary===5&&current.arrow===882)))return boundary;
 }
 return target;
}
type Kit={bow:number;arrow:number;attack:number;strength:number;interval:number};
// Native ranged max-hit and hit roll, then an exact expectation over uniform damage rolls.
// This is a model of steady combat. Its movement/pickup costs below remain explicit estimates.
export function rangedModelRate(level:number,kit:Kit,hp:number,defence:number,extraTicks=8){
 const max=Math.max(1,Math.floor(.5+(level+8)*(kit.strength+64)/640));
 const attack=(level+8)*(kit.attack+64),def=(defence+9)*64;
 const chance=attack>def?1-(def+2)/(2*(attack+1)):attack/(2*(def+1));
 const hit=chance/(max+1),zero=1-chance+hit,shots=[0];
 for(let h=1;h<=hp;h++)shots[h]=(1+Array.from({length:max},(_,i)=>hit*shots[Math.max(0,h-i-1)]!).reduce((n,v)=>n+v,0))/(1-zero);
 return hp*100/(shots[hp]!*kit.interval+extraTicks);
}
export function rangedProgressionMethods(a:RangedProgressionAccount,targetLevel:number,goalItems?:Record<number,number>):ProgressionMethod[]{
 const kit=rangedKit(a),owned=stock(a),level=ranged(a),at=a.position?.value,observed=!!(a.bank&&a.inventory&&a.equipment);
 const physical=stock({...a,reservations:{}});
 const gearMap=items();
 const kitStats=(bow:number,arrow:number):Kit=>({bow,arrow,attack:gearMap.get(bow)?.bonuses.rangeAttack??8,
  strength:gearMap.get(arrow)?.bonuses.rangeStrength??7,interval:Math.max(1,(gearMap.get(bow)?.attackRate??4)-1)});
 const activeKit=kit??(observed?kitStats(841,882):null);
 const step={script:'scripts/ranged-train.ts',args:[String(targetLevel)],env:{TARGET_LEVEL:String(targetLevel)}};
 const travel=(x:number,z:number)=>!at?null:Math.max(Math.abs(at.x-x),Math.abs(at.z-z))<=6?0:
  // Cross-region transport is deliberately priced above its geometric lower bound.
  Math.abs(at.x-x)>400?1200:Math.ceil(Math.max(Math.abs(at.x-x),Math.abs(at.z-z))/.8);
 const source='scripts/ranged-train.ts + scripts/gather-combat.ts; vendor/rs-sdk/server/content/scripts/skill_combat/scripts/{combat.rs2,player/player_combat_stat.rs2,player/player_ranged.rs2}; knowledge/gear.json';
 const model=(xpPerTick:number|null,evidence:string)=>({unitsPerTick:xpPerTick,basis:xpPerTick===null?'unknown' as const:'model' as const,evidence});
 const base=(id:string,requirements:ProgressionMethod['requirements'],rate:ProgressionMethod['rate'],travelTicks:number|null):ProgressionMethod&{execution:{targetArg:number;targetEnv:string[]}}=>({
  id,step,execution:{targetArg:0,targetEnv:['TARGET_LEVEL']},effects:{xp:{Ranged:1}},requirements,rate,costs:{setupTicks:20,travelTicks,acquisitionTicks:0,unlockTicks:0},source,
 });
 const methods:ProgressionMethod[]=[];
 const required:Record<number,number>=kit?{[kit.bow]:1,[kit.arrow]:3}:{841:1,882:3};
 const food=foods.find(id=>(owned[id]??0)>=3);
 const chickenFood=[329,333,1985].find(id=>(owned[id]??0)>=3);
 const chicken=base('ranged/chickens',{levels:{Ranged:1},items:{...required,...chickenFood?{[chickenFood]:3}:{995:20}}},
  model(activeKit?rangedModelRate(Math.max(1,level),activeKit,3,1,8+210/8):null,'Model: HP3 chickens, native rapid attack roll; eight kills per210-tick bank journey; pickup and targeting8ticks/kill. Validate on the current state.'),travel(3253,3421));
 if(!chickenFood)chicken.costs.acquisitionTicks=650;
 methods.push(chicken);
 // The plain trooper trainer does the same work as the method's own worker: the army runs it for the Ranged band.
 const plainTrooper=(target:number):Step=>({script:'scripts/gather-combat.ts',args:['1500','trooper'],env:{TARGET:'trooper',TRAIN_SKILL:'Ranged',TARGET_LEVEL:String(target)}});
 const onTroopers=<M extends ProgressionMethod>(m:M):M=>{m.step={...m.step,alsoRuns:[plainTrooper(targetLevel)]};return m;};
 const trooper=base('ranged/troopers',{levels:{Hitpoints:40},items:{...required,...food?{[food]:3}:{2142:3}}},
  model(activeKit?rangedModelRate(Math.max(1,level),activeKit,22,12):null,'Model: HP22, Defence12 Khazard troopers, native rapid attack roll; targeting and ammo pickup8ticks/kill. Bank and approach included separately. Validate on the current state.'),travel(2619,3332));
 trooper.costs.setupTicks=220;methods.push(onTroopers(trooper));
 const willow=kitStats(849,888);
 const guild=base('ranged/guild-willow-mithril',{levels:{Ranged:40,Hitpoints:40},items:{849:1,888:500,...food?{[food]:3}:{2142:3}}},
  model(rangedModelRate(Math.max(1,level),willow,22,12),'Model of the owned willow/mithril trooper route. Missing kit is supplied by the existing Dargaud shop jobs; observe shelf, price and complete bank credit before training.'),travel(2619,3332));
 guild.costs={setupTicks:220,travelTicks:travel(2619,3332),acquisitionTicks:0,unlockTicks:0};methods.push(onTroopers(guild));
 const shop=(id:string,item:number,count:number,pattern:string,budget:number):ProgressionMethod=>({
  id,source:'scripts/aio-market.ts dargaud; vendor/rs-sdk/server/content/scripts/minigames/game_ranging/configs/ranging.inv',
  step:{script:'scripts/aio-market.ts',args:['shop-buy','dargaud','1600'],env:{ITEMS:pattern,STOCK_TARGET:String((physical[item]??0)+Math.max(0,count-(owned[item]??0))),MAX_ITEMS:String(Math.max(0,count-(owned[item]??0))),STOP_AT_TARGET:'1',BANK_PACK:'1',BANK_AT:'0',NO_BUY_TICKS:'25',MAX_SPEND:String(budget),FLOAT:String(budget+1000),COIN_RESERVE:'500'}},
  effects:{items:{[item]:Math.max(0,count-(owned[item]??0))}},inputs:{995:budget},requirements:{levels:{Ranged:40}},
  rate:model(1/600,'Model: one finite Dargaud shop order including banked credit; observe shelf/price and measure the actual approach.'),
  costs:{setupTicks:0,travelTicks:travel(2673,3434),acquisitionTicks:0,unlockTicks:0},maxUnits:1,repeatable:false,
 });
 const loweBow=(id:string,item:number,reqLevel:number,budget:number):ProgressionMethod=>({
  id,source:'scripts/ranged-train.ts; vendor/rs-sdk/server/content/scripts/areas/area_varrock/configs/varrock.inv archeryshop; vendor/rs-sdk/server/content/scripts/areas/area_catherby/configs/catherby.inv archeryshop2',
  step:{script:'scripts/ranged-train.ts',args:[String(Math.min(targetLevel,reqLevel===1?5:20)),'1500'],env:{TARGET_LEVEL:String(Math.min(targetLevel,reqLevel===1?5:20)),BUY_BOW_ID:String(item),BUY_ARROW_ID:'882'}},
  effects:{items:{[item]:Math.max(0,1-(owned[item]??0))}},inputs:{995:budget},requirements:{levels:{Ranged:reqLevel}},
  rate:model(1/80,'Model: one Lowe Archery Emporium (archeryshop) or Hickton (archeryshop2) starter bow purchase within budget; rev-289 Rimmington has no archery shop.'),
  costs:{setupTicks:0,travelTicks:travel(3232,3423),acquisitionTicks:0,unlockTicks:0},maxUnits:1,repeatable:false,
 });
 const loweArrow=(id:string,item:number,count:number,pattern:string,reqLevel:number,budget:number):ProgressionMethod=>({
  id,source:'scripts/aio-market.ts lowe; vendor/rs-sdk/server/content/scripts/areas/area_varrock/configs/varrock.inv archeryshop',
  step:{script:'scripts/aio-market.ts',args:['shop-buy','lowe','1200'],env:{ITEMS:pattern,STOCK_TARGET:String((physical[item]??0)+Math.max(0,count-(owned[item]??0))),MAX_ITEMS:String(Math.max(0,count-(owned[item]??0))),STOP_AT_TARGET:'1',BANK_PACK:'1',BANK_AT:'0',NO_BUY_TICKS:'25',MAX_SPEND:String(budget),FLOAT:String(budget+1000),COIN_RESERVE:'500'}},
  effects:{items:{[item]:Math.max(0,count-(owned[item]??0))}},inputs:{995:budget},requirements:{levels:{Ranged:reqLevel}},
  rate:model(Math.max(1,count)/180,'Model: one Lowe Archery Emporium (archeryshop) arrow purchase.'),
  costs:{setupTicks:0,travelTicks:travel(3232,3423),acquisitionTicks:0,unlockTicks:0},maxUnits:1,repeatable:false,
 });
 const geAcquire=(id:string,item:number,count:number,limitPrice:number,reqLevel:number,note:string):ProgressionMethod=>{
  const missing=Math.max(0,count-(owned[item]??0)),ownedQty=physical[item]??0;
  return{
   id,source:'scripts/aio-market.ts; knowledge/gear.json',
   step:{script:'scripts/aio-market.ts',args:['ge-buy'],env:{ITEM_ID:String(item),QUANTITY:String(missing),...(ownedQty>0?{EXPECTED_OWNED:String(ownedQty)}:{}),LIMIT_PRICE:String(limitPrice),CASH_RESERVE:String(GE_CASH_RESERVE),ORDER_MS:'900000',FILL_WAIT_TICKS:'200'}},
   // The buy script refuses a round whose escrow and reserve pass the coins it finds (order-refusal.ts), and the holdings are minutes old.
   effects:{items:{[item]:missing}},inputs:{995:limitPrice*missing+GE_CASH_RESERVE+ORDER_COIN_MARGIN},requirements:{levels:{Ranged:reqLevel}},
   rate:model(Math.max(1,missing)/180,note),
   costs:{setupTicks:0,travelTicks:travel(3164,3487),acquisitionTicks:0,unlockTicks:0},maxUnits:1,repeatable:false,
  };
 };
 // Progressive 1-39 acquisition routes verified against rev-289 shops.json (archeryshop, archeryshop2, ranging_guild_bowshop).
 // Maple shortbow (853) is absent from all rev-289 NPC shops and Willow (849) shop access at Dargaud requires Ranged 40.
 if((!goalItems||goalItems[841]!==undefined)&&(owned[841]??0)<(goalItems?.[841]??1))
  methods.push(loweBow('ranged/lowe-buy-shortbow',841,1,100));
 const bronzeTarget=goalItems?.[882]??100,ironTarget=goalItems?.[884]??250,steelTarget=goalItems?.[886]??250;
 if((!goalItems||goalItems[882]!==undefined)&&(owned[882]??0)<bronzeTarget)
  methods.push(loweArrow('ranged/lowe-buy-bronze',882,bronzeTarget,'^bronze arrow$',1,goalItems?3*(bronzeTarget-(owned[882]??0)):300));
 if((!goalItems||goalItems[884]!==undefined)&&(owned[884]??0)<ironTarget)
  methods.push(loweArrow('ranged/lowe-buy-iron',884,ironTarget,'^iron arrow$',1,goalItems?8*(ironTarget-(owned[884]??0)):2000));
 if((!goalItems||goalItems[843]!==undefined)&&(owned[843]??0)<(goalItems?.[843]??1))
  methods.push(loweBow('ranged/lowe-buy-oak',843,5,200));
 if((!goalItems||goalItems[886]!==undefined)&&(owned[886]??0)<steelTarget)
  methods.push(loweArrow('ranged/lowe-buy-steel',886,steelTarget,'^steel arrow$',5,goalItems?24*(steelTarget-(owned[886]??0)):6000));
 const earlyWillowTarget=goalItems?.[849]??1,earlyMithrilTarget=goalItems?.[888]??250,mapleTarget=goalItems?.[853]??1;
 if(((!goalItems&&level<40)||goalItems?.[849]!==undefined)&&(owned[849]??0)<earlyWillowTarget)
  methods.push(geAcquire('ranged/ge-buy-willow',849,earlyWillowTarget,2500,20,'Model: GE purchase of Willow shortbow before Ranging Guild entry at Ranged 40.'));
 if(((!goalItems&&level<40)||goalItems?.[888]!==undefined)&&(owned[888]??0)<earlyMithrilTarget)
  methods.push(geAcquire('ranged/ge-buy-mithril',888,earlyMithrilTarget,120,20,'Model: GE purchase of Mithril arrows before Ranging Guild entry at Ranged 40.'));
 if((!goalItems||goalItems[853]!==undefined)&&(owned[853]??0)<mapleTarget)
  methods.push(geAcquire('ranged/ge-buy-maple',853,mapleTarget,4000,30,'Model: GE purchase of Maple shortbow (no rev-289 NPC shop sells Maple shortbow).'));
 if(!goalItems&&level<40){
  const oak=kitStats(843,886);
  if((!kit||kit.bowLevel<5)&&targetLevel>=5){
   const mChick=base('ranged/chickens-oak',{levels:{Ranged:5},items:{843:1,886:50}},model(rangedModelRate(Math.max(5,level),oak,3,0),'Model: HP 3 chickens with Oak shortbow and Steel arrows.'),travel(3253,3421));
   mChick.costs={setupTicks:20,travelTicks:travel(3253,3421),acquisitionTicks:0,unlockTicks:0};methods.push(mChick);
   const mTroop=base('ranged/troopers-oak',{levels:{Ranged:5,Hitpoints:40},items:{843:1,886:250,...food?{[food]:3}:{2142:3}}},model(rangedModelRate(Math.max(5,level),oak,22,12),'Model: troopers with Oak shortbow and Steel arrows.'),travel(2619,3332));
   mTroop.costs={setupTicks:220,travelTicks:travel(2619,3332),acquisitionTicks:0,unlockTicks:0};methods.push(onTroopers(mTroop));
  }
  if((!kit||kit.bowLevel<20)&&targetLevel>=20){
   const mWillow=base('ranged/troopers-willow',{levels:{Ranged:20,Hitpoints:40},items:{849:1,888:250,...food?{[food]:3}:{2142:3}}},model(rangedModelRate(Math.max(20,level),willow,22,12),'Model: troopers with Willow shortbow and Mithril arrows before Ranging Guild.'),travel(2619,3332));
   mWillow.costs={setupTicks:220,travelTicks:travel(2619,3332),acquisitionTicks:0,unlockTicks:0};methods.push(onTroopers(mWillow));
  }
  const maple=kitStats(853,888);
  if((!kit||kit.bowLevel<30)&&targetLevel>=30){
   const mMaple=base('ranged/troopers-maple',{levels:{Ranged:30,Hitpoints:40},items:{853:1,888:250,...food?{[food]:3}:{2142:3}}},model(rangedModelRate(Math.max(30,level),maple,22,12),'Model: troopers with Maple shortbow and Mithril arrows.'),travel(2619,3332));
   mMaple.costs={setupTicks:220,travelTicks:travel(2619,3332),acquisitionTicks:0,unlockTicks:0};methods.push(onTroopers(mMaple));
  }
 }
 const bowTarget=goalItems?.[849]??1,arrowTarget=goalItems?.[888]??500;
 if((!goalItems||goalItems[849]!==undefined)&&(owned[849]??0)<bowTarget)
  methods.push(shop('ranged/guild-buy-willow',849,bowTarget,'willow shortbow',goalItems?1200*(bowTarget-(owned[849]??0)):3000));
 if((!goalItems||goalItems[888]!==undefined)&&(owned[888]??0)<arrowTarget)
  methods.push(shop('ranged/guild-buy-mithril',888,arrowTarget,'mithril arrow',goalItems?192*(arrowTarget-(owned[888]??0)):60000));
 const cannon:ProgressionMethod&{execution:{targetEnv:string[]}}={
  ...base('ranged/cannon',{levels:{Hitpoints:40},quests:['Dwarf Cannon'],items:{6:1,8:1,10:1,12:1,2:1500}},
   model(null,'Existing cannon-fight worker and fighter:cannon bench. Current-state whole-job rate, unlock and procurement time are unknown; retain as measurement/acquisition work.'),null),
  source:'scripts/cannon-fight.ts; fighter:cannon bench; vendor/rs-sdk/server/content/scripts/quests/quest_mcannon/scripts/cannon_fire.rs2',
  step:{script:'scripts/cannon-fight.ts',args:[],env:{SPOT:'battlefield',CAP:'3000',STOP_SKILL:'Ranged',STOP_LEVEL:String(targetLevel)}},execution:{targetEnv:['STOP_LEVEL']},
 };methods.push(cannon);
 return methods;
}
