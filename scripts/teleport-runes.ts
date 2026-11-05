// Whether a teleport spell can be cast from what the pack holds and the staff worn: every rune the spell costs
// (knowledge/teleports.json, from magic_spells.dbrow), a worn elemental staff standing in for its rune
// (magic_staff.dbrow). quest-lib walks instead of casting when this says no, whatever the law rune count.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
type Tele={trigger?:string;runes?:{id:number;count:number;item:string}[]};
type Staff={rune:string;staffs:string[]};
let data:{teleports:Tele[];staffs:Staff[]}|undefined,names:Map<number,string>|undefined;
const load=()=>data??=JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/teleports.json'),'utf8'));
const debugname=(id:number)=>(names??=new Map((JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/items.json'),'utf8')) as {id:number;debugname:string}[]).map(i=>[i.id,i.debugname]))).get(id);
// The runes a spell component costs, by item id; null for a component no teleport spell has.
export function spellRunes(comp:string,teleports:readonly Tele[]=load().teleports):Record<number,number>|null{
 const t=teleports.find(t=>t.trigger===`[if_button,${comp}]`);
 if(!t)return null;
 const out:Record<number,number>={};
 for(const r of t.runes??[])out[r.id]=(out[r.id]??0)+r.count;
 return out;
}
// The rune debugnames a set of worn staffs stands in for.
export function staffRunes(worn:readonly string[],staffs:readonly Staff[]=load().staffs):Set<string>{
 return new Set(staffs.filter(s=>s.staffs.some(n=>worn.includes(n))).map(s=>s.rune));
}
const RUNE_NAMES:Record<number,string>={554:'firerune',555:'waterrune',556:'airrune',557:'earthrune',563:'lawrune'};
export function castable(comp:string,count:(id:number)=>number,wornIds:readonly number[]=[],teleports:readonly Tele[]=load().teleports,staffs:readonly Staff[]=load().staffs):boolean{
 const runes=spellRunes(comp,teleports);
 if(!runes)return false;
 const covered=staffRunes(wornIds.map(id=>debugname(id)??''),staffs);
 return Object.entries(runes).every(([id,n])=>covered.has(RUNE_NAMES[Number(id)]??'')||count(Number(id))>=n);
}
