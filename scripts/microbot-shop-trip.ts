import{readFileSync,existsSync}from'node:fs';
import{openBot,finish}from'../packages/core/src/bot';
import type{Session}from'../packages/core/src/inprocess';
import{waitUntil}from'../packages/core/src/ticks';
import{runBankProfile,validateBankRouteJob,type BankRouteJob,type BankProfile}from'./microbot-bank-jobs';
import{runShopSale}from'./microbot-a-shop-sell';
import{listConfigFiles,parseConfigs,type ConfigBlock}from'../packages/knowledge/src/config';
import{contentRoot}from'../packages/knowledge/src/paths';
import{join}from'node:path';

export type ShopContract={title:string;inventory:string};
export type ShopTripJob=Omit<BankRouteJob,'family'|'recipe'>&{merchant:string;item:number;minimumUnit:number;shop?:ShopContract};
function nativeData(){
 const configs=(ext:string)=>listConfigFiles(ext).flatMap(file=>parseConfigs(readFileSync(join(contentRoot(),file),'utf8'),file));
 const blocks=(ext:string)=>new Map(configs(ext).map(v=>[v.name,v]));
 const pack=(kind:string)=>new Map(readFileSync(join(contentRoot(),'pack',kind+'.pack'),'utf8').split(/\r?\n/).flatMap(v=>{const m=v.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])]as const]:[];}));
 return{npcs:blocks('.npc'),invs:blocks('.inv'),npcPack:pack('npc'),objPack:pack('obj'),spawns:JSON.parse(readFileSync('knowledge/npcs.json','utf8'))as{id:number;debugname:string;spawns:{x:number;z:number;level:number}[]}[],scripts:listConfigFiles('.rs2').map(file=>readFileSync(join(contentRoot(),file),'utf8')).join('\n')};
}
let data:ReturnType<typeof nativeData>|undefined;const native=()=>data??=nativeData();
const param=(b:ConfigBlock,key:string)=>b.props.param?.find(v=>v.startsWith(key+','))?.slice(key.length+1);
export function nativeMerchant(key:string,bank?:BankRouteJob['bank'],site?:BankRouteJob['site'],declared?:ShopContract,members?:boolean){
 if(typeof key!=='string'||!/^[a-z][a-z0-9_-]*$/.test(key))throw Error('invalid native merchant name');
 const d=native(),name=key==='alkharid-general'?'generalshopkeeper3':key,b=d.npcs.get(name),npc=d.npcPack.get(name);let inventory=b&&param(b,'owned_shop'),title=b&&param(b,'shop_title'),contractSource='native-params';
 if(!b||npc===undefined||!Object.entries(b.props).some(([k,v])=>/^op[1-5]$/.test(k)&&v[0]==='Trade'))throw Error('merchant lacks native Trade option');
 const handler=d.scripts.match(new RegExp('\\[opnpc3,\\s*'+name+'\\s*\\]([^]*?)(?=\\n\\[|$)'))?.[1];
 if(declared){
  if(!bank||!site||typeof members!=='boolean'||typeof declared.title!=='string'||!declared.title.trim()||declared.title.length>100||!declared.inventory||!d.invs.has(declared.inventory))throw Error('custom merchant needs explicit native shop, route and member scope');
  const calls=[...(handler??'').matchAll(/~openshop\(\s*(\w+)\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*"([^"]+)"\s*\)/g)].map(m=>({inventory:m[1]!,title:m[2]!}));
  if(calls.length){const candidates=/if\s*\(\s*map_members\s*=\s*\^true\s*\)/.test(handler!)&&calls.length===2?[calls[members?0:1]!]:calls;if(!candidates.some(v=>v.inventory===declared.inventory&&v.title===declared.title))throw Error('declared shop conflicts with native handler/member branch');contractSource='native-handler';}
  else if(inventory&&title){if(inventory!==declared.inventory||title!==declared.title)throw Error('declared shop conflicts with native NPC params');}
  else contractSource='caller-declared';
  inventory=declared.inventory;title=declared.title;
 }else{
  if(!b.props.category?.includes('shop_keeper')||b.props.op3?.[0]!=='Trade'||handler||!d.scripts.includes('[opnpc3,_shop_keeper] ~openshop_activenpc;'))throw Error('custom native merchant requires a declared shop contract');
  for(const key of ['shop_buy_multiplier','shop_sell_multiplier','shop_delta'])if(!/^\d+$/.test(param(b,key)??''))throw Error('native merchant price contract missing');
 }
 if(!inventory||!title||!d.invs.has(inventory))throw Error('native shop contract absent');
 const convenience=name==='generalshopkeeper3';bank??=convenience?{x:3269,z:3167,level:0}:undefined;site??=convenience?{x:3314,z:3180,level:0}:undefined;
 if(!bank||!site)throw Error('merchant requires explicit bank and site');
 const spawn=d.spawns.find(n=>n.id===npc&&n.debugname===name)?.spawns.some(p=>p.level===site!.level&&Math.max(Math.abs(p.x-site!.x),Math.abs(p.z-site!.z))<=8);
 if(!spawn)throw Error('merchant site has no matching native spawn within eight tiles');
 return{npc,title,inventory,bank,site,contractSource,inventoryObserved:false,alkharidSilkBan:['generalshopkeeper3','generalassistant3'].includes(name)};
}
export function validateShopTrip(j:ShopTripJob){
 const merchant=nativeMerchant(j.merchant,j.bank,j.site,j.shop,j.members);validateBankRouteJob({...j,family:'merchant',recipe:String(j.item),...merchant});
 if(!Number.isSafeInteger(j.item)||j.item<1)throw Error('invalid native merchant item');
 const d=native(),name=[...d.objPack].find(([,id])=>id===j.item)?.[0],inv=d.invs.get(merchant.inventory)!;
 if(j.item===995||!name||name.startsWith('cert_')||merchant.alkharidSilkBan&&name==='silk'||!Number.isSafeInteger(j.minimumUnit)||j.minimumUnit<1||j.minimumUnit>2147483647||j.batch>1000)throw Error('invalid native merchant surplus');
 if(inv.props.allstock?.[0]!=='yes'&&!Object.entries(inv.props).some(([k,values])=>/^stock\d+$/.test(k)&&values.some(v=>v.split(',')[0]===name)))throw Error('native merchant does not accept this item');
 return merchant;
}
export function shopTripProfile(s:Session,j:ShopTripJob):BankProfile{
 const merchant=validateShopTrip(j);
 if(j.shop&&(s.client as any)?.membersAccount!==(j.members?1:0))throw Error('custom merchant member connection disagrees with declared scope');
 return{bank:merchant.bank,site:merchant.site,inputs:{[j.item]:1},outputs:[995],capacityOutputs:{995:1},tools:[],run:async(n,cap,stop)=>{
  const start=s.tick();if(stop())throw Error('merchant stopped before shop entry');
  await s.sdk.sendCloseModal();
  const npc=s.sdk.getState()?.nearbyNpcs.find(v=>v.id===merchant.npc&&v.reachable!==false);
  if(!npc)throw Error('exact native merchant unobserved');
  const opened=await s.bot.openShop(npc);
  if(!opened.success||!await waitUntil(s,()=>stop()||!!s.sdk.getState()?.shop.isOpen,{timeoutTicks:Math.min(12,cap)}))throw Error('native merchant shop unavailable');
  if(stop())throw Error('merchant stopped after shop entry');
  if(s.sdk.getState()?.shop.title!==merchant.title)throw Error('native merchant title mismatch');
  const remaining=cap-(s.tick()-start);if(remaining<1)throw Error('merchant entry budget exhausted');
  const result=await runShopSale(s,{item:j.item,quantity:n,minimumUnit:j.minimumUnit,reserve:0,shopTitle:merchant.title,cap:remaining,stop});
  if(!result.ok)throw Error('merchant sale '+JSON.stringify(result));return result.sold;
 }};
}
export async function runShopTrip(s:Session,j:ShopTripJob,stop:()=>boolean=()=>false){const p=shopTripProfile(s,j),merchant=validateShopTrip(j),result=await runBankProfile(s,{...j,family:'merchant',recipe:String(j.item)},p,stop);return{...result,merchant:{npc:merchant.npc,title:merchant.title,inventory:merchant.inventory,contractSource:merchant.contractSource,inventoryObserved:false}};}
export function shopTripStop(account:string,stopped=false,exists:(p:string)=>boolean=existsSync){return stopped||[`.practice/stop-${account}`,'.practice/stop-all','.practice/stop-microbot-shop-trip'].some(exists);}
if(import.meta.main){let s:Session|undefined;try{const[account,path]=process.argv.slice(2);if(!account||!path)throw Error('usage: microbot-shop-trip.ts account job.json');const j=JSON.parse(readFileSync(path,'utf8'))as ShopTripJob;validateShopTrip(j);let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});s=await openBot(account,{onStop:async()=>{stopped=true;}});const result=await runShopTrip(s,j,()=>shopTripStop(account,stopped));console.log('SHOP_TRIP '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));}catch(error){await finish(s?[s]:[],false,String(error));}}
