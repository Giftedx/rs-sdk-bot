// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite inventory batch: bun scripts/microbot-magic-items.ts <account> <low-alch|high-alch|superheat:metal|enchant:debugname> [target-debugname-or-dash] [count=1] [cap=200]
// Native recipes own IDs and conversion rules. Stage inputs and runes; this worker never buys or travels.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {componentId} from '../packages/core/src/logout';
import {watchProductionLife} from './microbot-c-lifetime';
import {objId} from './measure/floor-bands';
const content='vendor/rs-sdk/server/content/scripts/';
export interface Recipe {name:string;spell:string;level:number;smithing:number;target:number;product:number;inputs:Record<number,number>;output:number;members:boolean}
function blocks(text:string){return [...text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map(m=>({name:m[1]!,body:m[2]!}));}
export function itemMagicRecipe(mode:string,targetName?:string):Recipe{
 const spells=blocks(readFileSync(content+'skill_magic/configs/magic_spells.dbrow','utf8'));
 const field=(body:string,key:string)=>body.match(new RegExp('^data='+key+',(.+)$','m'))?.[1]?.trim();
 let row=spells.find(r=>r.name===`magic_spell_${mode==='low-alch'?'low_alch':mode==='high-alch'?'high_alch':'superheat'}`);
 let input='',product='coins',smithing=0,secondary:string|undefined,secondaryCount=0;
 if(mode.startsWith('enchant:')){
  input=mode.slice(8);if(!/^\w+$/.test(input))throw Error('invalid native item name');row=spells.find(r=>r.body.includes('data=convertobj,'+input+','));
  product=row?.body.match(new RegExp('^data=convertobj,'+input+',([^,]+)','m'))?.[1]??'';
 }else if(mode.startsWith('superheat:')){
  const metal=mode.slice(10);if(!/^(bronze|iron|silver|steel|gold|mithril|adamantite|runite)$/.test(metal))throw Error('unsupported metal');
  product=metal+'_bar';const b=blocks(readFileSync(content+'skill_smithing/configs/smelting/smelting.struct','utf8')).find(r=>r.name==='smelting_'+product)?.body;
  if(!b)throw Error('missing native smelting recipe');
  const p=(key:string)=>b.match(new RegExp('^param='+key+',(.+)$','m'))?.[1]?.trim();
  input=p('ingredient')!;smithing=Number(p('levelrequired'));secondary=p('ingredient_secondary');secondaryCount=Number(p('ingredient_secondary_count')??0);
 }else if(mode==='low-alch'||mode==='high-alch'){
  if(!targetName||!/^\w+$/.test(targetName)||['coins','naturerune','firerune'].includes(targetName))throw Error('explicit non-rune alchemy target required');input=targetName;
 }else throw Error('unsupported item magic mode');
 if(!row||!input||!product)throw Error('no native item conversion');
 const inputs:Record<number,number>={[objId(input)]:1};
 const runes=field(row.body,'runesrequired')!.split(',');
 for(let n=0;n<runes.length;n+=2)if(runes[n]!=='null')inputs[objId(runes[n]!)]=(inputs[objId(runes[n]!)]??0)+Number(runes[n+1]);
 if(secondary)inputs[objId(secondary)]=secondaryCount;
 let output=1;
 if(product==='coins'){
  const items=JSON.parse(readFileSync('knowledge/items.json','utf8')) as {debugname:string;cost:number}[];
  const cost=items.find(i=>i.debugname===input)?.cost;if(cost===undefined)throw Error('unknown native alchemy value');
  output=Math.max(1,Math.floor(cost*(mode==='high-alch'?6:4)/10));
 }
 return{name:mode,spell:'magic:'+field(row.body,'spell')!.replace('^',''),level:Number(field(row.body,'levelrequired')),smithing,target:objId(input),product:objId(product),inputs,output,members:field(row.body,'members')==='true'};
}
let staffRunes:Map<number,{runes:Set<number>;members:boolean}>|undefined;
function nativeStaffRunes(){
 if(staffRunes)return staffRunes;staffRunes=new Map();
 const definitions=new Map<string,string>();
 for(const file of ['staves.obj','battlestaves.obj','mysticstaves.obj'])for(const row of blocks(readFileSync(content+'skill_combat/configs/magic/'+file,'utf8')))definitions.set(row.name,row.body);
 for(const row of blocks(readFileSync(content+'skill_magic/configs/magic_staff.dbrow','utf8'))){
  const rune=row.body.match(/^data=rune,(\w+)/m)?.[1];if(!rune)continue;
  for(const match of row.body.matchAll(/^data=staff,(\w+)/gm)){
   const name=match[1]!,body=definitions.get(name);if(!body)throw Error('missing native staff object '+name);
   const id=objId(name),entry=staffRunes.get(id)??{runes:new Set<number>(),members:/^members=yes\s*$/m.test(body)};entry.runes.add(objId(rune));staffRunes.set(id,entry);
  }
 }
 return staffRunes;
}
export function elementalRuneCost(runeId:number,quantity:number,worn:readonly{id:number;slot:number}[],members=false){
 const id=worn.find(i=>i.slot===3)?.id,staff=id===undefined?undefined:nativeStaffRunes().get(id);
 return staff&&(!staff.members||members)&&staff.runes.has(runeId)?0:quantity;
}
// A staff replaces the spell's runes, never the conversion target: an alchemised air rune is still debited once.
export function itemSpellCosts(recipe:Recipe,worn:readonly{id:number;slot:number}[],members=false){
 return Object.fromEntries(Object.entries(recipe.inputs).map(([id,n])=>{const target=Number(id)===recipe.target?1:0;return [id,target+elementalRuneCost(Number(id),n-target,worn,members)];}).filter(([,n])=>Number(n)>0)) as Record<number,number>;
}
export function itemSpellEffect(recipe:Recipe,costs:Record<number,number>,before:Record<number,number>,after:Record<number,number>,xpBefore:number,xpAfter:number){
 const ids=new Set([...Object.keys(before),...Object.keys(after),...Object.keys(costs),String(recipe.product)]);
 if(xpAfter===xpBefore&&[...ids].every(key=>(after[Number(key)]??0)===(before[Number(key)]??0)))return 'none';
 for(const key of ids){const id=Number(key),delta=(after[id]??0)-(before[id]??0),expected=(id===recipe.product?recipe.output:0)-(costs[id]??0);if(delta!==expected)return 'invalid';}
 return xpAfter>xpBefore?'cast':'invalid';
}
export async function runItemMagic(s:Session,recipe:Recipe,o:{count:number;cap:number;members?:boolean;stop?:()=>boolean}){
 if(!Number.isSafeInteger(o.count)||o.count<1||o.count>10000||!Number.isSafeInteger(o.cap)||o.cap<1||o.cap>100000)throw Error('invalid finite magic limits');
 const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory();
 const counts=()=>{const r:Record<number,number>={};for(const i of inv())r[i.id]=(r[i.id]??0)+i.count;return r;};
 const xp=()=>s.sdk.getSkillXp('Magic')??0,start=s.tick(),xp0=xp();let casts=0,ended=false,stop='target';void s.ended.then(()=>{ended=true;});
 if(recipe.members&&!o.members)throw Error('member spell requires explicit member batch scope');
 const p0=state()?.player;if(!p0)throw Error('player state unknown');
 if((s.sdk.getSkill('Magic')?.level??0)<recipe.level||(s.sdk.getSkill('Smithing')?.level??0)<recipe.smithing)throw Error('spell skill requirement');
 const life=watchProductionLife(s,o.stop);
 const over=()=>ended||life.stopped()||s.tick()-start>=o.cap;
 while(casts<o.count){
  if(over()){stop=ended?'session ended':life.stopped()?'stopped':'cap';break;}
  const p=state()?.player;if(!p||p.worldX!==p0.worldX||p.worldZ!==p0.worldZ||p.lifeId!==p0.lifeId||p.isDead)throw Error('unsafe player change');
  await s.bot.dismissBlockingUI();if(over()){stop='stopped';break;}
  const before=counts(),x0=xp(),costs=itemSpellCosts(recipe,state()?.equipment??[],o.members??false);
  if(Object.entries(costs).some(([id,n])=>(before[Number(id)]??0)<n)){stop='supplies';break;}
  // Iron with spare coal becomes steel on this server; reject a staged ambiguous batch.
  if(recipe.name==='superheat:iron'&&(before[objId('coal')]??0)>1)throw Error('iron batch contains steel coal');
  const item=inv().find(i=>i.id===recipe.target);if(!item)throw Error('target missing');
  const result=await s.direct({type:'spellOnItem',slot:item.slot,spellComponent:componentId(recipe.spell),reason:'SDK'}) as {success?:boolean};
  if(result?.success===false)throw Error('item spell dispatch refused');
  await waitUntil(s,()=>over()||xp()!==x0||Object.keys(counts()).some(id=>counts()[Number(id)]!==before[Number(id)]),{timeoutTicks:Math.min(12,Math.max(1,o.cap-(s.tick()-start)))});
  await waitTicks(s,1);
  const effect=itemSpellEffect(recipe,costs,before,counts(),x0,xp());if(effect!=='cast')throw Error('item spell effect '+effect);
  casts++;console.log('ITEM_MAGIC_CAST '+JSON.stringify({cast:casts,tick:s.tick(),mode:recipe.name,inputs:costs,product:recipe.product,output:recipe.output}));
  if(casts<o.count&&!over())await waitTicks(s,Math.min(4,Math.max(1,o.cap-(s.tick()-start))));
 }
 return{ok:casts===o.count,stop,casts,ticks:s.tick()-start,magicXp:xp()-xp0,product:recipe.product,produced:casts*recipe.output};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{
 const [account,mode,target,count,cap]=process.argv.slice(2);if(!account||!mode)throw Error('account and mode required');
 const recipe=itemMagicRecipe(mode,target);s=await openBot(account,{onStop:async()=>{stopped=true;}});
 const result=await runItemMagic(s,recipe,{count:Number(count??1),cap:Number(cap??200),members:process.env.MEMBERS==='1',stop:()=>stopped||existsSync('.practice/stop-microbot-magic')});
 console.log('ITEM_MAGIC_RESULT '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));
 }catch(e){await finish(s?[s]:[],false,String(e));}}
