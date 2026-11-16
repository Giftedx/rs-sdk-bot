import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ObservedAccount,ProgressionMethod} from './progression';
import type {Gear} from '../../knowledge/src/gear';

export type RangedProgressionAccount=ObservedAccount;
const bows=[{id:841,level:1},{id:839,level:1},{id:843,level:5},{id:845,level:5},{id:849,level:20},{id:847,level:20},
 {id:853,level:30},{id:851,level:30},{id:857,level:40},{id:855,level:40},{id:861,level:50},{id:859,level:50}];
const arrows=[{id:882,level:1},{id:884,level:1},{id:886,level:5},{id:888,level:20},{id:890,level:30},{id:892,level:40}];
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
// Stop only at an owned unlock that actually changes the modeled usable kit.
export function rangedBandTarget(a:ObservedAccount,target:number){
 const current=rangedKit(a),level=ranged(a);if(!current)return target;
 const skill=Object.keys(a.skills).find(name=>name.toLowerCase()==='ranged')!;
 for(const boundary of [...new Set(bows.map(b=>b.level))].filter(n=>n>level&&n<target).sort((x,y)=>x-y)){
  const next=rangedKit({...a,skills:{...a.skills,[skill]:{...a.skills[skill]!,level:boundary}}});
  if(next&&(next.bow!==current.bow||next.arrow!==current.arrow))return boundary;
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
 const kit=rangedKit(a),owned=stock(a),level=ranged(a),at=a.position?.value;
 const physical=stock({...a,reservations:{}});
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
  model(kit?rangedModelRate(level,kit,3,1,8+210/8):null,'Model: HP3 chickens, native rapid attack roll; eight kills per210-tick bank journey; pickup and targeting8ticks/kill. Validate on the current state.'),travel(3253,3421));
 if(!chickenFood)chicken.costs.acquisitionTicks=650;
 methods.push(chicken);
 const trooper=base('ranged/troopers',{levels:{Hitpoints:40},items:{...required,...food?{[food]:3}:{2142:3}}},
  model(kit?rangedModelRate(level,kit,22,12):null,'Model: HP22, Defence12 Khazard troopers, native rapid attack roll; targeting and ammo pickup8ticks/kill. Bank and approach included separately. Validate on the current state.'),travel(2619,3332));
 trooper.costs.setupTicks=220;methods.push(trooper);
 const willow:Kit={bow:849,arrow:888,attack:20,strength:22,interval:3};
 const guild=base('ranged/guild-willow-mithril',{levels:{Ranged:40,Hitpoints:40},items:{849:1,888:500,...food?{[food]:3}:{2142:3}}},
  model(rangedModelRate(Math.max(1,level),willow,22,12),'Model of the owned willow/mithril trooper route. Missing kit is supplied by the existing Dargaud shop jobs; observe shelf, price and complete bank credit before training.'),travel(2619,3332));
 guild.costs={setupTicks:220,travelTicks:travel(2619,3332),acquisitionTicks:0,unlockTicks:0};methods.push(guild);
 const shop=(id:string,item:number,count:number,pattern:string,budget:number):ProgressionMethod=>({
  id,source:'scripts/shop-buyer.ts dargaud; vendor/rs-sdk/server/content/scripts/minigames/game_ranging/configs/ranging.inv',
  step:{script:'scripts/shop-buyer.ts',args:['dargaud','1600'],env:{ITEMS:pattern,STOCK_TARGET:String((physical[item]??0)+Math.max(0,count-(owned[item]??0))),MAX_ITEMS:String(Math.max(0,count-(owned[item]??0))),STOP_AT_TARGET:'1',BANK_PACK:'1',BANK_AT:'0',NO_BUY_TICKS:'25',MAX_SPEND:String(budget),FLOAT:String(budget+1000),COIN_RESERVE:'500'}},
  effects:{items:{[item]:Math.max(0,count-(owned[item]??0))}},inputs:{995:budget},requirements:{levels:{Ranged:40}},
  rate:model(1/600,'Model: one finite Dargaud shop order including banked credit; observe shelf/price and measure the actual approach.'),
  costs:{setupTicks:0,travelTicks:travel(2673,3434),acquisitionTicks:0,unlockTicks:0},maxUnits:1,repeatable:false,
 });
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
