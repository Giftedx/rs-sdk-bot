// Finite staged cooking from the pinned native table. Reports cooked and burnt products separately.
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import {componentId} from '../packages/core/src/logout';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
const pack=(kind:string)=>new Map(readFileSync(resolve(content,`pack/${kind}.pack`),'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const at=l.indexOf('=');return[l.slice(at+1),Number(l.slice(0,at))];}));
const obj=pack('obj'),loc=pack('loc');
const id=(name:string)=>{const n=obj.get(name);if(n===undefined)throw Error('unknown native cook item '+name);return n;};
export type Heat='range'|'fire';
export interface CookRecipe{name:string;raw:number;products:number[];burnt?:number;additional?:number;noAdditionalSuccess:boolean;level:number;xp:number;range:boolean;fire:boolean;karambwanChoice?:1|2;source:string}
export function cookingRecipes(){
 const file='scripts/skill_cooking/configs/cooking_source/cooking_generic.dbrow',text=readFileSync(resolve(content,file),'utf8'),recipes:CookRecipe[]=[],blocked:{name:string;reason:string}[]=[];
 for(const m of text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)){
  const name=m[1]!,body=m[2]!,field=(k:string)=>body.match(new RegExp('^data='+k+',(.+)$','m'))?.[1]?.trim();
  const raw=field('uncooked'),product=field('cooked');if(!raw||!product||product==='null'){blocked.push({name,reason:'Native table forbids this raw item on both heat sources; raw oomlie requires wrapping.'});continue;}
  if(raw===product){blocked.push({name,reason:'Native no-op reheats bones without XP or changed item; not a useful production conversion.'});continue;}
  let products=[id(product)];
  const dynamic:Record<string,[string,string]>={half_baked_batta:['gnome_battas.rs2','gnome_batta'],half_baked_bowl:['gnome_bowls.rs2','gnome_bowl'],half_baked_crunchy:['gnome_crunchies.rs2','gnome_crunchies']};
  if(dynamic[raw]){const [file,proc]=dynamic[raw]!,source=readFileSync(resolve(content,'scripts/skill_cooking/scripts/gnome_cooking',file),'utf8').split(`[proc,${proc}]`)[1]?.split('[proc,')[0]??'';products=[...new Set([...source.matchAll(/return\(([^)]+)\)/g)].map(m=>id(m[1]!.trim())))];if(!products.length)throw Error('native dynamic gnome products missing');}
  const optional=(v:string|undefined)=>v&&v!=='null'?id(v):undefined;
  recipes.push({name,raw:id(raw),products,burnt:field('successchance')==='1,1'?undefined:optional(field('burnt')),additional:optional(field('additional')),noAdditionalSuccess:['half_baked_batta','half_baked_bowl','half_baked_crunchy'].includes(product),level:Number(field('levelrequired')??0),xp:Number(field('experience')??0),range:!field('cantcookmessage_range'),fire:!field('cantcookmessage_fire'),...(raw==='tbwt_raw_karambwan'?{karambwanChoice:product==='tbwt_cooked_karambwan'?2 as const:1 as const}:{}),source:'vendor/rs-sdk/server/content/'+file});
 }
 return{recipes,blocked};
}
let heatSources:Map<number,Heat>|undefined;
export function nativeHeatSources():ReadonlyMap<number,Heat>{
 if(heatSources)return heatSources;heatSources=new Map();
 const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory()){if(entry.name!=='_unpack')walk(resolve(dir,entry.name));}else if(entry.name.endsWith('.loc')){
  const text=readFileSync(resolve(dir,entry.name),'utf8');for(const m of text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)){const category=m[2]!.match(/^category=(cooking_oven|cooking_fire)\r?$/m)?.[1],value=loc.get(m[1]!);if(category&&value!==undefined)heatSources!.set(value,category==='cooking_oven'?'range':'fire');}
 }}};walk(resolve(content,'scripts'));return heatSources;
}
export function cookSnapshot(s:BotWorldState){const items:Record<number,number>={};for(const i of s.inventory)items[i.id]=(items[i.id]??0)+i.count;return{items,xp:s.skills.find(k=>k.name==='Cooking')?.experience??0};}
export function cookingEffect(r:CookRecipe,b:ReturnType<typeof cookSnapshot>,a:ReturnType<typeof cookSnapshot>):{kind:'cooked'|'burnt';product:number}|null{
 const keys=new Set([...Object.keys(b.items),...Object.keys(a.items)].map(Number));
 if([...keys].every(id=>(a.items[id]??0)===(b.items[id]??0))&&a.xp===b.xp)return null;
 for(const [kind,products] of [['cooked',r.products],['burnt',r.burnt===undefined?[]:[r.burnt]]] as const){for(const product of products){
  const expected=new Map([[r.raw,-1]]);expected.set(product,(expected.get(product)??0)+1);
  if(r.additional!==undefined&&(kind==='burnt'||!r.noAdditionalSuccess))expected.set(r.additional,(expected.get(r.additional)??0)+1);
  if(![...new Set([...keys,...expected.keys()])].every(id=>(a.items[id]??0)-(b.items[id]??0)===(expected.get(id)??0)))continue;
  if(kind==='cooked'?(r.xp>0?a.xp<=b.xp:a.xp<b.xp):a.xp!==b.xp)continue;
  return{kind,product};
 }}throw Error('cooking raw, product, returned container or XP does not reconcile');
}
export interface CookingDriver{state:()=>BotWorldState|null;tick:()=>number;stop:()=>boolean;heat:(slot:number,source:Heat,r:CookRecipe)=>Promise<boolean>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>;close:()=>Promise<void>}
export async function runCookingBatch(d:CookingDriver,r:CookRecipe,o:{maximum:number;cap:number;heat:Heat;expectedProduct?:number}){
 if(!Number.isSafeInteger(o.maximum)||o.maximum<1||!Number.isSafeInteger(o.cap)||o.cap<1||!['range','fire'].includes(o.heat))throw Error('invalid cooking batch bounds');
 if(!r[o.heat])throw Error('native recipe forbids '+o.heat);
 if(o.expectedProduct!==undefined&&!r.products.includes(o.expectedProduct))throw Error('expected cooked product is not native recipe variant');
 const initial=d.state();if(!initial?.player)throw Error('cooking state unknown');const initialHp=initial.skills.find(k=>k.name==='Hitpoints')?.level??0;if(initialHp<1)throw Error('cooking health unknown');
 if((initial.skills.find(k=>k.name==='Cooking')?.level??0)<r.level)throw Error('Cooking level insufficient');
 const start=d.tick();let cooked=0,burnt=0;const products:Record<number,number>={};
 const state=()=>{const s=d.state();if(!s?.player)throw Error('cooking session ended');if(d.stop())throw Error('cooking stopped');if(d.tick()-start>=o.cap)throw Error('cooking cap');if(s.player.lifeId!==initial.player!.lifeId||s.player.level!==initial.player!.level||s.player.isDead||(s.skills.find(k=>k.name==='Hitpoints')?.level??0)!==initialHp)throw Error('cooking life, floor or health changed');return s;};
 try{while(cooked+burnt<o.maximum){
  const before=state(),raw=before.inventory.find(i=>i.id===r.raw);if(!raw)throw Error('staged cooking input exhausted');const snapshot=cookSnapshot(before);
  if(r.additional!==undefined&&before.inventory.length>=28)throw Error('cooking needs space for returned container');
  await d.close();if(!await d.heat(raw.slot,o.heat,r))throw Error('cooking heat action refused');
  let effect:ReturnType<typeof cookingEffect>=null;
  if(!await d.wait(()=>!!(effect=cookingEffect(r,snapshot,cookSnapshot(state()))),Math.min(12,o.cap-(d.tick()-start))))throw Error('cooking effect unobserved');
  const observed=effect as unknown as {kind:'cooked'|'burnt';product:number};if(observed.kind==='cooked'){cooked++;if(o.expectedProduct!==undefined&&observed.product!==o.expectedProduct)throw Error('cooking produced a different native staged variant');}else burnt++;
  products[observed.product]=(products[observed.product]??0)+1;if(cooked+burnt<o.maximum)await d.step();
 }
 return{processed:cooked+burnt,cooked,burnt,products,xp: cookSnapshot(state()).xp-cookSnapshot(initial).xp,ticks:d.tick()-start};
 }finally{await d.close();}
}
if(import.meta.main){
 const name=process.argv[2],recipeName=process.argv[3],heat=(process.argv[4]??'range') as Heat,maximum=Number(process.argv[5]??1),cap=Number(process.argv[6]??200),recipe=cookingRecipes().recipes.find(r=>r.name===recipeName);
 if(!name||!recipe)throw Error('account and native cooking table recipe name required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});const start=s.tick(),stop=()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all');
 try{const result=await runCookingBatch({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop,close:async()=>{await s.sdk.sendCloseModal();},heat:async(slot,kind,r)=>{
  if(stop()||s.tick()-start>=cap)return false;const before=s.sdk.getState()!,target=before.nearbyLocs.filter(l=>nativeHeatSources().get(l.id)===kind&&l.distance<=2&&l.reachable!==false).sort((a,b)=>a.distance-b.distance)[0];if(!target)throw Error('stage beside native '+kind);
  if(!(await s.sdk.sendUseItemOnLoc(slot,target.x,target.z,target.id)).success)return false;
  if(r.karambwanChoice){
   await waitUntil(s,st=>stop()||!!st.dialog?.isOpen||(st.inventory??[]).filter((i:{id:number})=>i.id===r.raw).length<before.inventory.filter(i=>i.id===r.raw).length,{timeoutTicks:Math.min(6,Math.max(1,cap-(s.tick()-start)))});
   const dialog=s.sdk.getState()?.dialog;if(dialog?.isOpen){if(stop())return false;return(await s.sdk.sendClickComponent(componentId(`multiobj2:objtext${r.karambwanChoice}`))).success;}
  }return true;
 },wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},recipe,{maximum,cap,heat,expectedProduct:process.env.EXPECTED_PRODUCT?Number(process.env.EXPECTED_PRODUCT):undefined});await finish([s],true,JSON.stringify(result));}catch(e){await finish([s],false,String(e));}
}
