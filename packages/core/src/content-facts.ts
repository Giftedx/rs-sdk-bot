import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseConfigs,type ConfigBlock} from '../../knowledge/src/config';
import {parsePack} from '../../knowledge/src/pack';
import {contentRoot,knowledgeDir} from '../../knowledge/src/paths';
import {XP_RATE} from '../../knowledge/src/method-model';
import {objIdByDebugName} from './sustain';

// Game facts of the pinned revision-289 content, read once and cached: item and NPC ids, wear and use levels, spell
// costs, prayer levels, bone XP and special attack numbers. A planner or a worker names a fact here by the name of the
// content, so no second hand list can drift from the game. Item names are the display names that the planner writes
// ('adamant scimitar'): the content name with spaces for underscores.
export {XP_RATE};

const content=()=>contentRoot();
const text=(file:string)=>readFileSync(join(content(),file),'utf8');
const lazy=<T>(make:()=>T)=>{let v:T|undefined;return()=>(v??=make());};
const blocks=(file:string):ConfigBlock[]=>parseConfigs(text(file),file);
const debugName=(name:string)=>name.replace(/ /g,'_');

const objPack=lazy(()=>parsePack(text('pack/obj.pack')));
const npcPack=lazy(()=>parsePack(text('pack/npc.pack')));
const idsOf=(pack:Map<number,string>)=>new Map([...pack].map(([id,name])=>[name,id] as const));
const npcIds=lazy(()=>idsOf(npcPack()));

// One item-id source: sustain.ts reads the same pack for the food tables.
export function objId(name:string):number{
 const id=objIdByDebugName(debugName(name));
 if(id===undefined)throw new Error(`content: no item "${name}"`);
 return id;
}
export function npcId(name:string):number{
 const id=npcIds().get(debugName(name));
 if(id===undefined)throw new Error(`content: no npc "${name}"`);
 return id;
}
export const objDebugName=(id:number)=>objPack().get(id);

type GearRecord={id:number;debugname:string;tier?:number;special?:{energy:number};requires:{skills:Record<string,number>;quest?:string}};
const gear=lazy(()=>new Map((JSON.parse(readFileSync(join(knowledgeDir(),'gear.json'),'utf8')) as GearRecord[]).map(g=>[g.debugname,g] as const)));
const gearOf=(item:string)=>{
 const g=gear().get(debugName(item));
 if(!g)throw new Error(`content: no wearable "${item}"`);
 return g;
};

// The level of a skill that an item asks to wear (knowledge/gear.json requires, from levelrequire/scripts/tier*.rs2).
export function wearLevel(item:string,skill:'attack'|'strength'|'defence'|'ranged'|'magic'):number{
 return gearOf(item).requires.skills[skill]??1;
}
// The tier of a bow or an arrow: a bow fires arrows of its tier or lower (player_ranged.rs2).
export function ammoTier(item:string):number{
 const tier=gearOf(item).tier;
 if(tier===undefined)throw new Error(`content: no ammo tier for "${item}"`);
 return tier;
}
export const specialEnergy=(item:string):number|undefined=>gearOf(item).special?.energy;

type ToolRecord={item:string;miningLevel?:number|null;paramLevelrequire?:number|null};
const tools=lazy(()=>{
 const t=JSON.parse(readFileSync(join(knowledgeDir(),'skill-tools.json'),'utf8')) as {axes:ToolRecord[];pickaxes:ToolRecord[]};
 return new Map<string,{level:number}>([...t.axes.map(a=>[a.item,{level:a.paramLevelrequire??0}] as const),
  ...t.pickaxes.map(p=>[p.item,{level:p.miningLevel??0}] as const)]);
});
// The Mining or Woodcutting level that an axe or a pickaxe asks to use (a content level of 0 is level 1, the floor).
export function toolLevel(item:string):number{
 const t=tools().get(debugName(item));
 if(!t)throw new Error(`content: no axe or pickaxe "${item}"`);
 return Math.max(1,t.level);
}

export type SpellFact={level:number;runes:Readonly<Record<string,number>>;xp:number};
const spells=lazy(()=>{
 const out=new Map<string,SpellFact>();
 for(const file of ['scripts/skill_magic/configs/magic_spells.dbrow','scripts/skill_combat/configs/magic/magic_combat_spells.dbrow']){
  for(const b of blocks(file)){
   const field=(key:string)=>b.props.data?.find(v=>v.startsWith(key+','))?.slice(key.length+1);
   const spell=field('spell')?.replace(/^\^/,''),level=field('levelrequired'),runes=field('runesrequired'),xp=field('experience');
   if(!spell||level===undefined||runes===undefined||xp===undefined)continue;
   const parts=runes.split(','),cost:Record<string,number>={};
   for(let i=0;i+1<parts.length;i+=2)if(parts[i]!=='null'){const rune=parts[i]!.replace(/rune$/,' rune');cost[rune]=(cost[rune]??0)+Number(parts[i+1]);}
   // experience is in tenths of an XP, and the node's xpRate multiplies it (Player.ts addXp).
   out.set(spell,{level:Number(level),runes:cost,xp:Number(xp)/10*XP_RATE});
  }
 }
 return out;
});
export function spellFact(spell:string):SpellFact{
 const s=spells().get(spell);
 if(!s)throw new Error(`content: no spell "${spell}"`);
 return s;
}
// The runes of a list of casts: {falador_teleport: 6} gives six times its cost.
export function castRunes(casts:Readonly<Record<string,number>>):Record<string,number>{
 const out:Record<string,number>={};
 for(const [spell,times] of Object.entries(casts))for(const [rune,n] of Object.entries(spellFact(spell).runes))out[rune]=(out[rune]??0)+n*times;
 return out;
}

const prayers=lazy(()=>new Map(blocks('scripts/skill_prayer/configs/prayers.dbrow').map(b=>{
 const field=(key:string)=>b.props.data?.find(v=>v.startsWith(key+','))?.slice(key.length+1);
 return [field('name')??'',Number(field('level'))] as const;
})));

// The Prayer level of a prayer by its name in the content ('Protect from Melee').
export function prayerLevel(name:string):number{
 const level=prayers().get(name);
 if(level===undefined||!Number.isFinite(level))throw new Error(`content: no prayer "${name}"`);
 return level;
}

const boneExp=lazy(()=>new Map(blocks('scripts/skill_prayer/configs/bones.obj').map(b=>[b.name,Number(b.props.param?.find(v=>v.startsWith('bone_exp,'))?.split(',')[1])] as const)));
// The Prayer XP of one burial at the server's rate (bone_exp in tenths, times xpRate).
export function boneXp(bone:string):number{
 const exp=boneExp().get(debugName(bone));
 if(exp===undefined||!Number.isFinite(exp))throw new Error(`content: no bone "${bone}"`);
 return exp/10*XP_RATE;
}

const constants=lazy(()=>new Map(text('scripts/skill_combat/configs/combat.constant').split(/\r?\n/).flatMap(l=>{const m=l.match(/^\^(\w+)\s*=\s*(-?\d+)/);return m?[[m[1]!,Number(m[2])] as const]:[];})));
// The special attack bar: its size, what it gains and how often (combat.constant).
export function specialBar(){
 const c=constants(),get=(k:string)=>{const v=c.get(k);if(v===undefined)throw new Error(`content: no constant ${k}`);return v;};
 return {max:get('sa_max_energy'),regenAmount:get('sa_regen_amount'),regenInterval:get('sa_regen_interval')};
}
