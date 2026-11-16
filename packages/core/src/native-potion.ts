import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfigs } from '../../knowledge/src/config';
import items from '../../../knowledge/items.json';

const skillNames:Record<string,string>={attack:'Attack',strength:'Strength',defence:'Defence',ranged:'Ranged',magic:'Magic',prayer:'Prayer',herblore:'Herblore',thieving:'Thieving',crafting:'Crafting',runecraft:'Runecraft',mining:'Mining',smithing:'Smithing',fishing:'Fishing',cooking:'Cooking',firemaking:'Firemaking',woodcutting:'Woodcutting',fletching:'Fletching',agility:'Agility'};
type StatEffect={skill:string;constant:number;percent:number;heal:boolean};
const content=resolve(import.meta.dir,'../../../vendor/rs-sdk/server/content');
const byId=new Map(items.map(item=>[item.id,item])),byName=new Map(items.map(item=>[item.debugname,item]));
const configCache=new Map<string,ReturnType<typeof parseConfigs>>();
const configs=(path:string)=>{if(!configCache.has(path))configCache.set(path,parseConfigs(readFileSync(path,'utf8'),path));return configCache.get(path)!;};
function parsePotionCareRecipe(id:number){
 const item=byId.get(id);if(!item)throw Error('native potion item absent');const path=content+'/'+item.src.replace(/:\d+$/,''),block=configs(path).find(b=>b.name===item.debugname),params=Object.fromEntries((block?.props.param??[]).map(v=>v.split(',',2))),next=byName.get(params.next_obj_stage??'')?.id,doses=Number(params.dose_count);
 if(next===undefined||!Number.isSafeInteger(doses)||doses<1||doses>4||!params.decant_potion_enum)throw Error('native dose/next stage absent');
 const nextItem=byId.get(next),nextBlock=nextItem&&configs(content+'/'+nextItem.src.replace(/:\d+$/,'')).find(b=>b.name===nextItem.debugname),nextParams=Object.fromEntries((nextBlock?.props.param??[]).map(v=>v.split(',',2)));
 if(doses===1?next!==229:nextParams.decant_potion_enum!==params.decant_potion_enum||Number(nextParams.dose_count)!==doses-1)throw Error('native dose chain mismatch');
 if(/antipoison/.test(item.debugname))return{id,next,doses,family:params.decant_potion_enum,kind:'antipoison',skill:undefined,constant:0,percent:0,heal:false,effects:Object.freeze([]) as readonly StatEffect[],cooldown:/2antipoison/.test(item.debugname)?558:108};
 if(/antidragon/.test(item.debugname))return{id,next,doses,family:params.decant_potion_enum,kind:'antifire',skill:undefined,constant:0,percent:0,heal:false,effects:Object.freeze([]) as readonly StatEffect[],cooldown:588};
 const effects=content+'/scripts/player/configs/consumption/consume_effects.dbrow',effect=configs(effects).find(b=>(b.props.data??[]).includes('consumable,'+item.debugname)),rows=(effect?.props.data??[]).filter(v=>/^stat_change,|^stat_heal,/.test(v));
 const vector=params.decant_potion_enum==='potion_2restore'?'superrestore':params.decant_potion_enum==='potion_1restore'?'restore':undefined;
 const parsed:StatEffect[]=rows.map(row=>{const[type,stat,c,p]=row.split(','),skill=skillNames[stat!];if(!skill||!['stat_heal','stat_change'].includes(type!)||!Number.isSafeInteger(Number(c))||!Number.isSafeInteger(Number(p))||Number(c)<0||Number(p)<0||!vector&&!['Attack','Defence','Strength','Ranged','Magic','Prayer'].includes(skill)||!vector&&(type==='stat_heal'&&stat!=='prayer'||type==='stat_change'&&stat==='prayer')||vector&&type!=='stat_heal')throw Error('unsupported donor potion effect');return Object.freeze({skill,constant:Number(c),percent:Number(p),heal:type==='stat_heal'});});
 if(vector){const expected=vector==='restore'?['Attack','Defence','Strength','Ranged','Magic']:Object.values(skillNames);if(parsed.length!==expected.length||new Set(parsed.map(e=>e.skill)).size!==expected.length||expected.some(skill=>!parsed.some(e=>e.skill===skill))||parsed.some(e=>e.constant!==(vector==='restore'?10:8)||e.percent!==(vector==='restore'?30:25)))throw Error('unsupported restorative vector');}
 else if(parsed.length!==1)throw Error('unsupported donor potion effect');
 const first=parsed[0]!;return{id,next,doses,family:params.decant_potion_enum,kind:vector??Object.entries(skillNames).find(([,name])=>name===first.skill)![0],skill:vector?undefined:first.skill,constant:first.constant,percent:first.percent,heal:first.heal,effects:Object.freeze(parsed),cooldown:0};
}
const recipeCache=new Map<number,ReturnType<typeof parsePotionCareRecipe>|null>();
export function potionCareRecipe(id:number){const known=recipeCache.get(id);if(known===null)throw Error('unsupported native potion metadata');if(known)return known;try{const r=Object.freeze(parsePotionCareRecipe(id));recipeCache.set(id,r);return r;}catch(error){recipeCache.set(id,null);throw error;}}
// Cache recipes before a caller opens a session. Live selection reads IDs.
for(const item of items){if(/\([1-4]\)$/.test(item.name)){try{potionCareRecipe(item.id);}catch{}}else recipeCache.set(item.id,null);}
