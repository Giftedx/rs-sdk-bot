// Native gold/perfect-gold and silver furnace jewellery. Stage bars, gems and moulds.
// A finite held-input batch; bank/travel ownership remains with its caller.
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import {componentId} from '../packages/core/src/logout';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {productionEffect,type InventoryRecipe,type ProductionSnapshot} from './microbot-production';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content');
const itemIds=new Map(readFileSync(resolve(content,'pack/obj.pack'),'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const at=l.indexOf('=');return[l.slice(at+1),Number(l.slice(0,at))];}));
const id=(name:string)=>{const n=itemIds.get(name);if(n===undefined)throw Error('unknown native jewellery item '+name);return n;};
export interface JewelleryRecipe extends InventoryRecipe{bar:number;shape:'ring'|'necklace'|'amulet'|'silver';slot:number;silverLetter?:'a'|'b'|'c'}
export function jewelleryRecipes():JewelleryRecipe[]{
 const path='scripts/skill_crafting/configs/jewellery/jewellery.struct',text=readFileSync(resolve(content,path),'utf8');
 return [...text.matchAll(/^\[([^\]]+)\]\r?\n([^\[]*)/gm)].map((match):JewelleryRecipe=>{
  const name=match[1]!,body=match[2]!,param=(key:string)=>body.match(new RegExp('^param='+key+',(.+)$','m'))?.[1]?.trim();
  const product=param('product')!,silver=['unstrung_symbol','unstrung_emblem','silver_sickle'].includes(name),perfect=name.startsWith('perfect_');
  const shape=silver?'silver':name.includes('ring')?'ring':name.includes('necklace')?'necklace':'amulet';
  const gem=param('gem'),bar=id(silver?'silver_bar':perfect?'perfect_gold_bar':'gold_bar'),mould=param('mould')??shape+'_mould';
  const slot=silver?0:gem?['gold','sapphire','emerald','ruby','diamond','dragonstone'].indexOf(gem):0;
  if(slot<0)throw Error('unknown native jewellery gem');
  return{name,product:id(product),inputs:[{id:bar,units:1},...(gem?[{id:id(gem),units:1}]:[])],tools:[id(mould)],skill:'Crafting',level:Number(param('levelrequired')),xp:true,members:gem==='dragonstone'||name==='unstrung_emblem'||name==='silver_sickle',source:'vendor/rs-sdk/server/content/'+path,bar,shape,slot,...silver?{silverLetter:name==='unstrung_emblem'?'a' as const:name==='unstrung_symbol'?'b' as const:'c' as const}:{}};
 });
}
export function jewelleryMenu(r:JewelleryRecipe,items:Record<number,number>,members:boolean){
 if(r.shape!=='silver')return{component:`crafting_jewelry:${r.shape==='ring'?'rings':r.shape==='necklace'?'necklaces':'amulets'}_inv`,slot:r.slot,option:1};
 const count=members&&(items[id('sickle_mould')]??0)>0?3:2;
 if(r.silverLetter==='c'&&count!==3)throw Error('silver sickle needs members and sickle mould');
 return{component:`skill_multi${count}:make1_${r.silverLetter}`,slot:undefined,option:undefined};
}
export const jewellerySnapshot=(s:BotWorldState):ProductionSnapshot=>({items:Object.fromEntries([...s.inventory.reduce((m,i)=>m.set(i.id,(m.get(i.id)??0)+i.count),new Map<number,number>())]),xp:s.skills.find(k=>k.name==='Crafting')?.experience??0});
export interface JewelleryDriver{state:()=>BotWorldState|null;tick:()=>number;stop:()=>boolean;open:(barSlot:number)=>Promise<boolean>;choose:(menu:ReturnType<typeof jewelleryMenu>)=>Promise<boolean>;close:()=>Promise<void>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>}
export async function runJewellery(d:JewelleryDriver,r:JewelleryRecipe,o:{maximum:number;cap:number;members:boolean}){
 if(!Number.isSafeInteger(o.maximum)||o.maximum<1||!Number.isSafeInteger(o.cap)||o.cap<1)throw Error('invalid jewellery bounds');
 const initial=d.state();if(!initial?.player)throw Error('jewellery state unknown');
 const initialHp=initial.skills.find(k=>k.name==='Hitpoints')?.level??0;if(initialHp<1)throw Error('jewellery health unknown');
 if((initial.skills.find(k=>k.name==='Crafting')?.level??0)<r.level)throw Error('jewellery Crafting level insufficient');
 if(r.members&&!o.members)throw Error('jewellery needs confirmed members world');
 const first=jewellerySnapshot(initial),start=d.tick();let made=0;
 if(r.bar!==id('perfect_gold_bar')&&(first.items[id('perfect_gold_bar')]??0)>0)throw Error('remove perfect gold bars before ordinary jewellery; native precedence');
 const state=()=>{const s=d.state();if(!s?.player)throw Error('jewellery session ended');if(d.stop())throw Error('jewellery stopped');if(d.tick()-start>=o.cap)throw Error('jewellery tick cap');if(s.player.lifeId!==initial.player!.lifeId||s.player.level!==initial.player!.level||s.player.isDead||(s.skills.find(k=>k.name==='Hitpoints')?.level??0)!==initialHp)throw Error('jewellery health or floor changed');return s;};
 try{while(made<o.maximum){
  const before=state(),snapshot=jewellerySnapshot(before);
  if(r.tools.some(tool=>(snapshot.items[tool]??0)<1)||r.inputs.some(input=>(snapshot.items[input.id]??0)<input.units))throw Error('jewellery staged inputs or mould exhausted');
  const bar=before.inventory.find(i=>i.id===r.bar)!;
  await d.close();if(!await d.open(bar.slot))throw Error('jewellery furnace interface unobserved');
  const menu=jewelleryMenu(r,snapshot.items,o.members);if(!await d.choose(menu))throw Error('jewellery menu refused');
  if(!await d.wait(()=>{const effect=productionEffect(r,snapshot,jewellerySnapshot(state()));if(effect==='invalid'||effect==='loss')throw Error('jewellery assets do not reconcile');return effect==='made';},Math.min(12,o.cap-(d.tick()-start))))throw Error('jewellery product unobserved');
  made++;if(made<o.maximum)await d.step();
 }
 const final=jewellerySnapshot(state());if((final.items[r.product]??0)-(first.items[r.product]??0)!==made)throw Error('jewellery total output mismatch');
 return{made,ticks:d.tick()-start,product:r.product};
 }finally{await d.close();}
}
if(import.meta.main){
 const name=process.argv[2],recipeName=process.argv[3],maximum=Number(process.argv[4]??1),cap=Number(process.argv[5]??200),r=jewelleryRecipes().find(r=>r.name===recipeName);
 if(!name||!r)throw Error('account and native jewellery recipe name required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});
 const start=s.tick(),stop=()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all');
 try{const result=await runJewellery({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop,close:async()=>{await s.sdk.sendCloseModal();},open:async(slot)=>{
  if(stop()||s.tick()-start>=cap)return false;
  const furnace=s.sdk.getState()?.nearbyLocs.find(l=>/^furnace$/i.test(l.name)&&l.distance<=2&&l.reachable!==false);if(!furnace)throw Error('stage beside observed furnace');
  if(!(await s.sdk.sendUseItemOnLoc(slot,furnace.x,furnace.z,furnace.id)).success)return false;
  return waitUntil(s,st=>stop()||!!st.interface?.isOpen||!!st.dialog?.isOpen,{timeoutTicks:Math.min(8,Math.max(1,cap-(s.tick()-start)))});
 },choose:async menu=>{if(stop())return false;return(menu.option===undefined?await s.sdk.sendClickComponent(componentId(menu.component)):await s.sdk.sendClickComponentWithOption(componentId(menu.component),menu.option,menu.slot)).success;},wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},r,{maximum,cap,members:process.env.MEMBERS==='1'});await finish([s],true,JSON.stringify(result));}
 catch(e){await finish([s],false,String(e));}
}
