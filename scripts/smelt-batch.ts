import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Session} from '../packages/core/src/inprocess';
import {depositObserved} from '../packages/core/src/deposit';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath,goTo} from '../packages/core/src/walk';
import {accountOf,getWorld} from '../packages/core/src/bot';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {productionStopRequested} from './microbot-c-lifetime';
import {parseConfigs} from '../packages/knowledge/src/config';
import {productionBatch} from '../packages/planner/src/production-batch';
import {smeltEntryRoute} from '../packages/planner/src/travel';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {questFlags} from '../packages/core/src/quest-status';
import {knownBanks} from '../packages/core/src/trip';

// Adapted from rs2b2t/rs2b0t SmelterBotLogic.withdrawFor/canSmelt/smeltStalled,
// commit6e747f8bda494d9f75365b5533cf758d353dcc3b (MIT; quest-sustain.NOTICE.txt).
// Replace substring matching/fixed28/wall-clock waits with pinned IDs, actual slots,
// reserved stock, observed effects and the existing paired deposit receipts.
type Stock=readonly {id:number;count:number}[];
export type SmeltRecipe={product:number;level:number;ingredients:{id:number;units:number}[];iron:boolean;productUnits?:number;tools?:readonly number[];receiptTicks?:number;rawXp?:number};
export type SmeltBonusGear={kind:'goldsmith';xpRate:number}|{kind:'forging';xpRate:number;maximumRings:number;ringReserve:number};
type SmeltTile={x:number;z:number;level:number};
export type SmeltLocalRoute={bank:SmeltTile;stand:SmeltTile;furnace:SmeltTile&{id:number};access?:'shilo-furnace';maxEntries?:number;coinReserve?:number};
export type SmeltOrder={bar:string;cap:number;maximum:number;reserve:number;mode:'exact'|'best-effort';stop?:()=>boolean;bonusGear?:SmeltBonusGear;route?:SmeltLocalRoute;nearest?:boolean;xpRate?:number};
const furnaceCache=new Map<number,{name:string;fremennik:boolean;width:number;length:number}>();
export function nativeSmeltFurnace(id:number){
 const cached=furnaceCache.get(id);if(cached)return cached;
 const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/content'),name=readFileSync(resolve(root,'pack/loc.pack'),'utf8').split(/\r?\n/).find(l=>l.startsWith(id+'='))?.split('=')[1];
 if(!name||!['furnace1','viking_furnace','viking_furnace2'].includes(name))throw Error('declared furnace lacks the ordinary Native Smelt contract');
 const file=name.startsWith('viking_')?'scripts/quests/quest_viking/configs/viking.loc':'scripts/skill_smithing/configs/smelting/smelting.loc',block=parseConfigs(readFileSync(resolve(root,file),'utf8'),file).find(b=>b.name===name);
 if(block?.props.category?.[0]!=='smithing_furnace'||block.props.op2?.[0]!=='Smelt')throw Error('ordinary Native furnace metadata changed');
 if(block.props.forceapproach?.[0]!=='east')throw Error('ordinary Native furnace approach metadata changed');
 const value={name,fremennik:name.startsWith('viking_'),width:Number(block.props.width?.[0]??1),length:Number(block.props.length?.[0]??1)};furnaceCache.set(id,value);return value;
}
export function nativeSmeltStands(f:SmeltTile&{id:number}){
 const type=nativeSmeltFurnace(f.id),map=resolve(import.meta.dir,`../vendor/rs-sdk/server/content/maps/m${f.x>>6}_${f.z>>6}.jm2`),placement=readFileSync(map,'utf8').match(new RegExp(`^${f.level} ${f.x&63} ${f.z&63}: ${f.id} 10(?: ([0-3]))?\\r?$`,'m'));
 if(!placement)throw Error('declared ordinary furnace Native placement absent');
 const angle=Number(placement[1]??0),width=angle%2?type.length:type.width,length=angle%2?type.width:type.length,side=(1+angle)%4;
 return Array.from({length:side%2?length:width},(_,i)=>({level:f.level,x:side===1?f.x+width:side===3?f.x-1:f.x+i,z:side===0?f.z+length:side===2?f.z-1:f.z+i}));
}
export function validateSmeltRoute(route:SmeltLocalRoute){
 const point=(p:SmeltTile)=>!!p&&[p.x,p.z,p.level].every(Number.isSafeInteger)&&p.x>=0&&p.x<=16383&&p.z>=0&&p.z<=16383&&p.level>=0&&p.level<=3;
 if(!route||!point(route.bank)||!point(route.stand)||!point(route.furnace)||!Number.isSafeInteger(route.furnace.id)||route.bank.level!==route.stand.level||route.stand.level!==route.furnace.level||Math.max(Math.abs(route.bank.x-route.stand.x),Math.abs(route.bank.z-route.stand.z))>160||Math.max(Math.abs(route.furnace.x-route.stand.x),Math.abs(route.furnace.z-route.stand.z))>4)throw Error('invalid finite local furnace/bank/stand route');
 const f=route.furnace;if(!nativeSmeltStands(f).some(p=>p.x===route.stand.x&&p.z===route.stand.z))throw Error('declared stand differs from Native rotated furnace approach');
 const shilo=f.id===2781&&f.x===2856&&f.z===2966&&f.level===0;
 if(shilo||route.access!==undefined||route.maxEntries!==undefined||route.coinReserve!==undefined){
  if(!shilo||route.access!=='shilo-furnace'||route.bank.x!==2852||route.bank.z!==2955||!Number.isSafeInteger(route.maxEntries)||route.maxEntries!<1||route.maxEntries!>100||!Number.isSafeInteger(route.coinReserve)||route.coinReserve!<0)throw Error('Shilo furnace requires explicit finite entry and coin reserve policy');
 }
 return route;
}
const count=(rows:Stock,id:number)=>rows.filter(v=>v.id===id).reduce((n,v)=>n+v.count,0);
export function smeltRecipe(bar:string):SmeltRecipe{
 if(bar==='cannonballs')return{product:2,level:35,ingredients:[{id:2353,units:1}],iron:false,productUnits:4,tools:[4],receiptTicks:24,rawXp:375};
 if(!['bronze','iron','silver','steel','gold','mithril','adamantite','runite'].includes(bar))throw Error('unsupported smelt recipe: '+bar);
 const content=resolve(import.meta.dir,'../vendor/rs-sdk/server/content'),file='scripts/skill_smithing/configs/smelting/smelting.struct';
 const ids=new Map(readFileSync(resolve(content,'pack/obj.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(.+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
 const b=parseConfigs(readFileSync(resolve(content,file),'utf8'),file).find(b=>b.name==='smelting_'+bar+'_bar');
 if(!b)throw Error('pinned smelt recipe missing');
 const p=Object.fromEntries((b.props.param??[]).map(v=>{const at=v.indexOf(',');return[v.slice(0,at),v.slice(at+1)];}));
 const item=(name:string)=>{const id=ids.get(name);if(id===undefined)throw Error('unknown smelt item '+name);return id;};
 const ingredients=[{id:item(p.ingredient!),units:Number(p.bar_count)}];
 if(p.ingredient_secondary)ingredients.push({id:item(p.ingredient_secondary),units:Number(p.ingredient_secondary_count)});
 return{product:item(p.product!),level:Number(p.levelrequired),ingredients,iron:bar==='iron'};
}
export function planSmeltLoad(r:SmeltRecipe,bank:Stock,freeSlots:number,maximum:number,reserved:Readonly<Record<number,number>>){
 return productionBatch(r.ingredients.map(i=>({...i,available:count(bank,i.id),reserved:reserved[i.id]??0,stackable:false})),freeSlots,maximum,'best-effort');
}
export function smeltEffect(r:SmeltRecipe,before:Stock,after:Stock,xpBefore:number,xpAfter:number):{kind:'none'|'made'|'loss';made:number}{
 const debits=r.ingredients.map(i=>count(before,i.id)-count(after,i.id)),made=count(after,r.product)-count(before,r.product);
 if(made===0&&debits.every(v=>v===0)&&xpAfter===xpBefore)return{kind:'none',made:0};
 if(!debits.every((v,n)=>v===r.ingredients[n]!.units))throw Error('smelt ingredient debit mismatch');
 if(made===(r.productUnits??1)&&xpAfter>xpBefore)return{kind:'made',made:1};
 if(r.iron&&made===0&&xpAfter===xpBefore)return{kind:'loss',made:0};
 throw Error('smelt output/XP mismatch');
}
export function validateSmeltOrder(o:SmeltOrder){
 if(![o.cap,o.maximum,o.reserve].every(Number.isSafeInteger)||o.cap<1||o.maximum<1||o.reserve<0||!['exact','best-effort'].includes(o.mode))throw Error('invalid finite smelt order');
 if(o.route)validateSmeltRoute(o.route);
 if(o.nearest!==undefined&&typeof o.nearest!=='boolean'||o.nearest&&o.route)throw Error('nearest and explicit smelt routes are mutually exclusive');
 if(o.bar==='cannonballs'&&(!Number.isSafeInteger(o.xpRate)||o.xpRate!<1||o.xpRate!>1000||o.maximum>100000||o.cap>10000))throw Error('cannonballs require finite operations and explicit XP rate');
 const b=o.bonusGear;if(b){
  if(!Number.isSafeInteger(b.xpRate)||b.xpRate<1||b.xpRate>1000||!(b.kind==='goldsmith'&&o.bar==='gold'||b.kind==='forging'&&o.bar==='iron'))throw Error('invalid native smelt bonus policy');
  if(b.kind==='forging'&&(![b.maximumRings,b.ringReserve].every(Number.isSafeInteger)||b.maximumRings<1||b.maximumRings>100||b.ringReserve<0))throw Error('invalid finite forging ring budget');
  smeltBonusRawXp(b);
 }
 return smeltRecipe(o.bar);
}
// Native productexp is raw tenths; goldsmith uses integer scale(5,2,225).
const bonusXpCache=new Map<string,number>();
export function smeltBonusRawXp(b:SmeltBonusGear){
 let base=bonusXpCache.get(b.kind);if(base===undefined){const file=resolve(import.meta.dir,'../vendor/rs-sdk/server/content/scripts/skill_smithing/configs/smelting/smelting.struct'),block=parseConfigs(readFileSync(file,'utf8'),file).find(i=>i.name===`smelting_${b.kind==='goldsmith'?'gold':'iron'}_bar`);base=Number(block?.props.param?.find(i=>i.startsWith('productexp,'))?.split(',')[1]);if(!Number.isSafeInteger(base)||base<=0)throw Error('native smelt XP missing');bonusXpCache.set(b.kind,base);}
 return(b.kind==='goldsmith'?Math.floor(base*5/2):base)*b.xpRate;
}
export function smeltOwnedSession(raw:Session,stop:()=>boolean=()=>false,inputGuard:()=>void=()=>{}){
 const client=raw.client as {executeBotAction?:unknown;selfSlot?:number}|undefined,executor=client?.executeBotAction,sdk=raw.sdk,config=sdk.config,origin=JSON.stringify([config?.gatewayUrl,config?.host,config?.port]),p=sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0,self=client?.selfSlot;let ended=false,cleaning=false;void raw.ended.then(()=>{ended=true;});
 const own=()=>{const now=sdk.getState()?.player;return !ended&&!!p&&Number.isSafeInteger(life)&&Number.isSafeInteger(self)&&!!client&&typeof executor==='function'&&raw.client===client&&client.executeBotAction===executor&&client.selfSlot===self&&raw.sdk===sdk&&sdk.config===config&&JSON.stringify([config?.gatewayUrl,config?.host,config?.port])===origin&&!!now&&!now.isDead&&now.lifeId===life&&(now.respawnCount??0)===respawns;};
 const stopped=()=>!own()||productionStopRequested(raw.name,stop)||productionStopRequested('smelt-bars',()=>false),guard=()=>{if(!own()||!cleaning&&stopped())throw Error('smelt original session/input owner/life/stop unavailable');inputGuard();};
 const proxy=new Proxy(sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(String(key).startsWith('send'))guard();return v.apply(receiver,args);}:v;}}),s=Object.create(raw)as Session;
 const bot=raw.bot instanceof BotActions?new BotActions(proxy):new Proxy(raw.bot,{get(target,key,receiver){const v:unknown=Reflect.get(target as object,key,receiver);return typeof v==='function'?function(...args:unknown[]){guard();return v.apply(receiver,args);}:v;}});
 Object.defineProperties(s,{sdk:{value:proxy},bot:{value:bot},direct:{value:(a:Parameters<Session['direct']>[0])=>{guard();return raw.direct(a);}}});return{session:s,own,stopped,cleanup:()=>{if(!own())return false;cleaning=true;return true;}};
}
export async function deriveNearestSmeltRoute(raw:Session,cap:number,stop:()=>boolean=()=>false,io?:{banks?:readonly SmeltTile[];walker?:()=>Promise<Pick<Awaited<ReturnType<typeof sessionWalker>>,'plan'>>}):Promise<SmeltLocalRoute>{
 if(!Number.isSafeInteger(cap)||cap<1)throw Error('nearest furnace finite cap required');
 const owner=smeltOwnedSession(raw,stop),s=owner.session,start=s.tick(),p=s.sdk.getState()?.player;
 if(!p)throw Error('nearest furnace player unavailable');
 const from={x:p.worldX,z:p.worldZ,level:p.level},hp=s.sdk.getSkill('Hitpoints')?.level;
 const fingerprint=()=>JSON.stringify([s.sdk.getInventory(),s.sdk.getEquipment(),s.sdk.getState()?.skills]);
 const before=fingerprint(),check=()=>{const now=s.sdk.getState()?.player,age=s.sdk.getStateAge();if(owner.stopped()||!now||now.worldX!==from.x||now.worldZ!==from.z||now.level!==from.level||!Number.isFinite(hp)||hp!<7||s.sdk.getSkill('Hitpoints')?.level!==hp||!Number.isFinite(age)||age<0||age>5000||s.tick()-start>=cap||fingerprint()!==before)throw Error('nearest furnace original observation changed');};
 check();const walker=await(io?.walker?io.walker():sessionWalker(s));check();
 const distance=(a:SmeltTile,b:SmeltTile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
 const candidates=(s.sdk.getState()?.nearbyLocs??[]).filter(l=>l.level===from.level&&distance(l,from)<=20&&l.optionsWithIndex.some(o=>o.opIndex===2&&/^smelt$/i.test(o.text))).map(l=>({id:l.id,x:l.x,z:l.z,level:l.level})).sort((a,b)=>distance(a,from)-distance(b,from)||a.id-b.id||a.x-b.x||a.z-b.z);
 const complete=(a:SmeltTile,b:SmeltTile)=>{check();try{const path=walker.plan(a.level,a,b),end=path.at(-1)??a;check();return end.x===b.x&&end.z===b.z&&path.every(t=>Number.isFinite(t.x)&&Number.isFinite(t.z)&&distance(t as SmeltTile,a)<=160);}catch(error){check();return false;}};
 for(const f of candidates){
  check();if(f.id===2781&&f.x===2856&&f.z===2966)continue;
  let stands:SmeltTile[];try{const type=nativeSmeltFurnace(f.id);if(type.fremennik&&((s.client as {membersAccount?:number}).membersAccount!==1||!questFlags(s.client)?.some(q=>/^(The )?Fremennik Trials$/.test(q.name)&&q.state==='complete')))continue;stands=nativeSmeltStands(f);}catch{continue;}
  const banks=[...(io?.banks??knownBanks())].filter(b=>b.level===from.level&&distance(b,f)<=160).sort((a,b)=>distance(a,f)-distance(b,f)||a.x-b.x||a.z-b.z);
  stands.sort((a,b)=>distance(a,from)-distance(b,from)||a.x-b.x||a.z-b.z);
  for(const bank of banks){if(!complete(from,bank))continue;for(const stand of stands)if(complete(bank,stand)&&complete(stand,bank)){check();return structuredClone(validateSmeltRoute({bank:{...bank},stand:{...stand},furnace:{...f}}));}}
 }
 throw Error('no observed ordinary furnace with complete indexed-bank route within20');
}
export async function runSmeltBatch(raw:Session,o:SmeltOrder,io?:{walk:(x:number,z:number)=>Promise<boolean>;recover?:(x:number,z:number)=>Promise<boolean>;nearest?:Parameters<typeof deriveNearestSmeltRoute>[3]}){
 let bonusInputGuard=()=>{};const owner=smeltOwnedSession(raw,o.stop,()=>bonusInputGuard()),s=owner.session,nearestStart=o.nearest?s.tick():undefined;
 const r=validateSmeltOrder(o),state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),held=(id:number)=>count(inv(),id),xp=()=>s.sdk.getSkillXp('Smithing')??0;
 const cannon=o.bar==='cannonballs',productUnits=r.productUnits??1;
 const cannonAdmission=()=>{if(cannon&&((s.client as {membersAccount?:number}).membersAccount!==1||(s.sdk.getSkill('Smithing')?.level??0)<35))throw Error('cannonballs need observed member and current Smithing35');};cannonAdmission();
 const route=o.nearest?await deriveNearestSmeltRoute(raw,o.cap,o.stop,io?.nearest):o.route?structuredClone(o.route):undefined;if(o.nearest&&owner.stopped())throw Error('nearest furnace original owner lost');
 const bankSite=route?.bank??{x:3269,z:3167,level:0},furnaceStand=route?.stand??{x:3274,z:3186,level:0};
 const shilo=route?.access==='shilo-furnace';
 const localAdmission=()=>{if(route&&nativeSmeltFurnace(route.furnace.id).fremennik&&((s.client as {membersAccount?:number}).membersAccount!==1||!questFlags(s.client)?.some(q=>/^(The )?Fremennik Trials$/.test(q.name)&&q.state==='complete')))throw Error('local furnace requires observed completed Fremennik Trials');if(shilo&&((s.client as {membersAccount?:number}).membersAccount!==1||!questFlags(s.client)?.some(q=>q.name==='Shilo Village'&&q.state==='complete')))throw Error('Shilo furnace requires observed member and completed Shilo Village');};
 const bonus=o.bonusGear?{...o.bonusGear}:undefined,bonusId=bonus?.kind==='goldsmith'?776:2568,bonusSlot=bonus?.kind==='goldsmith'?9:12;
 const wear=()=>s.sdk.getEquipment().map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((a,b)=>a.slot-b.slot),originalWear=bonus||cannon?wear():[];
 const originalBonusSlot=originalWear.find(i=>i.slot===bonusSlot);
 const sameWear=(a:ReturnType<typeof wear>,b:ReturnType<typeof wear>)=>JSON.stringify(a)===JSON.stringify(b);
 if((bonus||cannon)&&((s.client as {membersAccount?:number}).membersAccount!==1||!equipmentObserved(s.client as object)))throw Error('smelt optional recipe needs observed member equipment');
 const ready=await waitUntil(s,()=>owner.stopped()||!!state()?.player&&(s.sdk.getSkill('Hitpoints')?.level??0)>0&&(s.sdk.getSkill('Smithing')?.baseLevel??0)>=r.level,{timeoutTicks:15});
 if(!ready||owner.stopped())throw Error('smelt entry level/state unobserved');
 localAdmission();
 // Keep arbitrary ordinary starts supported. Known bank starts use the audited corridor below.
 const at=state()!.player!,atBank=(x:number,z:number)=>at.level===0&&Math.max(Math.abs(at.worldX-x),Math.abs(at.worldZ-z))<=5;
 if(route&&!o.nearest&&(at.level!==bankSite.level||Math.min(Math.max(Math.abs(at.worldX-bankSite.x),Math.abs(at.worldZ-bankSite.z)),Math.max(Math.abs(at.worldX-furnaceStand.x),Math.abs(at.worldZ-furnaceStand.z)))>3))throw Error('local smelt starts at its declared bank or furnace stand');
 if(shilo&&Math.max(Math.abs(at.worldX-bankSite.x),Math.abs(at.worldZ-bankSite.z))>3)throw Error('Shilo access starts at its declared village bank');
 if(!route&&!io&&!atBank(3269,3167)&&!atBank(3253,3420)){
  const there=await goTo(s,await getWorld(),{x:3269,z:3167,level:0},accountOf(s),{legTimeoutTicks:100});
  if(!there.ok)throw Error(`smelt travel to Al Kharid bank failed: ${there.detail}`);
 }
 const p0={...state()!.player!},start=nearestStart??s.tick(),xp0=xp();
 const entryBank={x:p0.worldX,z:p0.worldZ};
 const entry=route?{name:'declared-local-furnace',fare:0,points:[]}:smeltEntryRoute(p0);
 // The pinned furnace auto-selects steel if iron is used while carrying2coal.
 // Preserve that stock rather than silently producing a different bar.
 if(r.iron&&held(453)>=2&&(s.sdk.getSkill('Smithing')?.baseLevel??0)>=30)throw Error('iron entry requires coal banked before recipe dispatch');
 const material=new Set([...r.ingredients.map(i=>i.id),r.product]),kit=new Map<number,number>();
 for(const i of inv())if(!material.has(i.id))kit.set(i.id,(kit.get(i.id)??0)+i.count);
 let ended=false,died=false,hpMin=s.sdk.getSkill('Hitpoints')!.level,made=0,consumedOre=0,losses=0,attempts=0,misses=0,failure='',stop='cap';
 let ringBreaks=0,ringsUsed=0,bonusRawXp=0,uncertainBonus=false,gearRestored=!bonus;
 let cannonRawXp=0;const cannonReceipts:{tick:number;terminal:number;rawXp:number;products:number}[]=[];
 let localPaid=false;
 let bonusDeadline=start+o.cap;
 const declaredFurnace=()=>route?state()?.nearbyLocs.find(l=>l.id===route.furnace.id&&l.x===route.furnace.x&&l.z===route.furnace.z&&l.level===route.furnace.level&&l.reachable!==false&&l.optionsWithIndex.some(op=>op.opIndex===2&&/^smelt$/i.test(op.text))):undefined;
 if(bonus||route||cannon)bonusInputGuard=()=>{const age=s.sdk.getStateAge();if((bonus||cannon)&&!equipmentObserved(s.client as object)||!Number.isFinite(age)||age<0||age>5000||(s.sdk.getSkill('Hitpoints')?.level??0)<7||s.tick()>=bonusDeadline)throw Error('smelt optional input health/freshness/deadline');if(localPaid){localAdmission();cannonAdmission();if(cannon&&(!held(4)||!sameWear(wear(),originalWear)))throw Error('cannonball mould/gear changed before input');const p=state()?.player;if(route&&(!declaredFurnace()||p?.level!==furnaceStand.level||p.worldX!==furnaceStand.x||p.worldZ!==furnaceStand.z))throw Error('local smelt changed at paid dispatch');}};
 void s.ended.then(()=>{ended=true;});
 const off=s.onTick(()=>{const p=state()?.player;hpMin=Math.min(hpMin,s.sdk.getSkill('Hitpoints')?.level??hpMin);died||=!owner.own()||hpMin<=0||!!p&&(p.isDead||(p.respawnCount??0)>(p0.respawnCount??0)||(p0.lifeId!==undefined&&p.lifeId!==p0.lifeId));});
 const over=()=>owner.stopped()||ended||died||hpMin<7||!!o.stop?.()||s.tick()-start>=o.cap;
 const near=(x:number,z:number,tol=3)=>{const p=state()?.player;return !!p&&p.level===bankSite.level&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
 let travel=false,travelTicks=0,coinsSpent=0,arrival=false,crossed=false;
 let shiloInside=false,shiloEntries=0;const accessReceipts:{kind:'entry'|'exit';tick:number;coins:number}[]=[];
 const passed:{x:number;z:number}[]=[];
 const recover=async(x:number,z:number,cleanup=false)=>{
  if(!owner.own()||ended||died||hpMin<7||(!cleanup&&over()))return false;
  if(io)return !!io.recover&&await io.recover(x,z)&&near(x,z);
  const ac=new AbortController(),began=s.tick(),budget=cleanup?160:Math.min(160,Math.max(1,o.cap-(s.tick()-start)));
  const off=s.onTick(()=>{if(ended||died||hpMin<7||s.tick()-began>=budget||(!cleanup&&over()))ac.abort('smelt recovery deadline/stop');});
  try{
   const r=await goTo(s,await getWorld(),{x,z,level:0},accountOf(s),{maxRetriesPerLeg:1,legTimeoutTicks:budget,signal:ac.signal});
   return r.ok&&near(x,z);
  }finally{off();}
 };
 const walk=async(x:number,z:number,cleanup=false)=>{
  if(!owner.own()||!cleanup&&over())return false;
  if(io)return await io.walk(x,z)&&near(x,z,route?0:3);
  const walker=await sessionWalker(s),plan=walker.plan;
  // A plan must end inside the walk tolerance. Blocked targets (furnace, counters) end on an adjacent tile,
  // and a bot already at the target gets an empty plan. A farther end is a partial plan, never a fallback.
  const tol=route?0:1,inside=(t:{x:number;z:number})=>Math.max(Math.abs(t.x-x),Math.abs(t.z-z))<=tol;
  walker.plan=(level,from,to)=>{const path=plan(level,from,to);if(!inside(path.at(-1)??from))throw Error('smelt incomplete corridor plan');return path;};
  // A hit stops travel; a cleanup walk to the near bank keeps moving rather than stand in a fight.
  const result=await walkPath(walker,[{x,z,tol}],{maxTicks:Math.min(160,cleanup?160:Math.max(1,o.cap-(s.tick()-start))),stop:()=>!owner.own()||ended||died||hpMin<7||(!cleanup&&(over()||travel&&((s.sdk.getSkill('Hitpoints')?.level??0)<hpStart)))});return result.ok&&near(x,z);
 };
 let lastBank:Stock|undefined;
 const bankRows=()=>{const observed=s.bankObservation?.();if(observed)lastBank=observed.items.map(i=>({id:i.id,count:i.count}));return lastBank??[];};
 const totals=()=>{const rows=[...inv(),...s.sdk.getEquipment(),...bankRows()],m=new Map<number,number>();for(const i of rows)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 let initial:Map<number,number>|undefined;
 const hpStart=hpMin;
 const observeBank=async()=>{
  const generation=s.bankObservation?.()?.generation??-1;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:10}))throw Error('smelt bank observation unready');
 };
 const reserved=Object.fromEntries(r.ingredients.map(i=>[i.id,o.reserve]));
 const packSame=(a:Stock,b:Stock)=>{const ids=new Set([...a,...b].map(i=>i.id));return [...ids].every(id=>count(a,id)===count(b,id));};
 const accessGuard=()=>{const age=s.sdk.getStateAge();if(!owner.own()||ended||died||hpMin<7||s.tick()>=bonusDeadline||!Number.isFinite(age)||age<0||age>5000)throw Error('Shilo access original owner/health/deadline lost');localAdmission();};
 const accessState=()=>({pack:inv().map(i=>({...i})),gear:wear(),xp:JSON.stringify((state()?.skills??[]).map(k=>[k.name,k.experience])),hp:s.sdk.getSkill('Hitpoints')?.level});
 const accessSame=(before:ReturnType<typeof accessState>,fee:number)=>{
  const expected=before.pack.map(i=>({...i}));let left=fee;for(const row of expected)if(row.id===995){const n=Math.min(left,row.count);row.count-=n;left-=n;}
  return left===0&&packSame(inv(),expected)&&sameWear(wear(),before.gear)&&JSON.stringify((state()?.skills??[]).map(k=>[k.name,k.experience]))===before.xp&&s.sdk.getSkill('Hitpoints')?.level===before.hp;
 };
 const shiloDoor=()=>state()?.nearbyLocs.find(l=>l.id===2266&&l.x===2856&&l.z===2963&&l.level===0&&l.optionsWithIndex.some(o=>o.opIndex===1&&/^open$/i.test(o.text)));
 const leaveShilo=async(cleanup:boolean)=>{
  if(!shiloInside)return;if(!await walk(2856,2964,cleanup))throw Error('Shilo inside door approach incomplete');
  const until=Math.min(bonusDeadline,s.tick()+8);while(!shiloDoor()&&s.tick()<until){accessGuard();await waitTicks(s,1);}accessGuard();
  if(!shiloDoor()||!near(2856,2964,0))throw Error('Shilo restored inside door unobserved');
  const before=accessState();uncertainBonus=true;
  try{await s.direct({type:'interactLoc',locId:2266,x:2856,z:2963,optionIndex:1,reason:'SDK'});}catch{/* Only the exact public crossing can reconcile a lost acknowledgement. */}
  while(s.tick()<until){accessGuard();if(!accessSame(before,0))throw Error('Shilo free exit assets changed');if(near(2856,2963,0)){shiloInside=false;uncertainBonus=false;accessReceipts.push({kind:'exit',tick:s.tick(),coins:0});return;}await waitTicks(s,1);}
  throw Error('Shilo free exit unknown');
 };
 const enterShilo=async()=>{
  if(shiloEntries>=route!.maxEntries!)throw Error('Shilo entry budget exhausted');
  if(!await walk(2856,2962))throw Error('Shilo outer door approach incomplete');accessGuard();
  if(!shiloDoor()||!near(2856,2962,0)||held(995)<20)throw Error('Shilo door or owned fare unavailable');
  const before=accessState(),cursor=Math.max(-1,...(state()?.recentDialogs??[]).map(d=>d.observationId??d.tick)),pages=new Set<string>();
  const until=Math.min(bonusDeadline,s.tick()+60);let selected=false,terminal=false;
  uncertainBonus=true;
  await s.direct({type:'interactLoc',locId:2266,x:2856,z:2963,optionIndex:1,reason:'SDK'});
  while(s.tick()<until){
   accessGuard();const d=s.sdk.getDialog(),fresh=(state()?.recentDialogs??[]).filter(v=>(v.observationId??v.tick)>cursor).flatMap(v=>v.text).join(' ');
   if(selected){
    if(!accessSame(before,0)&&!accessSame(before,20))throw Error('Shilo paid entry mixed assets');
    if(/Thanks Bwana! Enjoy the facilities!/i.test(fresh)&&accessSame(before,20))terminal=true;
    if(terminal&&near(2856,2964,0)&&!d?.isOpen){shiloInside=true;shiloEntries++;coinsSpent+=20;uncertainBonus=false;accessReceipts.push({kind:'entry',tick:s.tick(),coins:20});return;}
   }else if(over()){uncertainBonus=false;throw Error('Shilo entry stopped before payment');}
   if(d?.isOpen&&!d.isWaiting){
    const key=d.pageId??JSON.stringify([d.text,d.options,fresh]);
    if(!pages.has(key)){
     const pay=d.options.find(o=>o.text==='Use Furnace - 20 Gold');
     if(pay&&!selected){if(!accessSame(before,0))throw Error('Shilo entry pack changed before fare');pages.add(key);selected=true;try{await s.direct({type:'clickDialogOption',optionIndex:pay.index,reason:'SDK'});}catch{/* Never repeat payment; reconcile only its exact public effect. */}}
     else if((d.options.length===0||d.options.length===1&&/continue/i.test(d.options[0]!.text))&&(!selected||terminal)){
      pages.add(key);accessGuard();try{await raw.direct({type:'clickDialogOption',optionIndex:d.options[0]?.index??0,reason:'SDK'});}catch{if(!selected)throw Error('Shilo prepayment page acknowledgement unknown');}
     }else if(!selected||terminal)throw Error('Shilo unexpected entry page');
    }
   }
   await waitTicks(s,1);
  }
  throw Error('Shilo paid entry unknown');
 };
 const bonusGuard=()=>{if(!owner.own()||(s.client as {membersAccount?:number}).membersAccount!==1||!equipmentObserved(s.client as object)||s.sdk.getStateAge()>5000||hpMin<7)throw Error('smelt bonus original equipment/health/state unavailable');};
 const closeBank=async()=>{if(state()?.bank.isOpen&&(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5})))throw Error('smelt bonus bank close unknown');};
 // The existing guarded BotActions provide the Native equipment operations. Each
 // change requires its whole-pack and whole-equipment receipt before continuing.
 const changeSlot=async(id:number|undefined)=>{
  bonusGuard();const old=s.sdk.getEquipment().find(i=>i.slot===bonusSlot);
  if(old?.id===id)return;
  if(old){
   if(inv().length>=28)throw Error('smelt bonus needs an unequip slot');
   await closeBank();const before=inv().map(i=>({...i})),w=wear();uncertainBonus=true;
   await s.bot.unequipItem(old);
   if(!await waitUntil(s,()=>sameWear(wear(),w.filter(i=>i.slot!==bonusSlot))&&packSame(inv(),[...before,{id:old.id,count:old.count}]),{timeoutTicks:8}))throw Error('smelt bonus unequip unknown');
   uncertainBonus=false;bonusGuard();await observeBank();
  }
  if(id===undefined)return;
  if(!held(id)){
   if(inv().length>=28)throw Error('smelt bonus needs an equip slot');
   if(!state()?.bank.isOpen)await observeBank();const row=state()?.bank.items.find(i=>i.id===id),before=held(id),stock=count(bankRows(),id);
   if(!row||stock<1)throw Error('smelt original/bonus gear unavailable');
   uncertainBonus=true;await s.bot.withdrawItem(row,1,{asNote:false});
   if(!await waitUntil(s,()=>held(id)===before+1&&count(bankRows(),id)===stock-1,{timeoutTicks:8}))throw Error('smelt bonus withdrawal unknown');uncertainBonus=false;
  }
  await closeBank();bonusGuard();const item=inv().find(i=>i.id===id)!,before=inv().map(i=>({...i})),w=wear();
  const expected=before.map(i=>({...i})),at=expected.findIndex(i=>i.id===id);expected[at]!.count--;uncertainBonus=true;
  await s.bot.equipItem(item);
  if(!await waitUntil(s,()=>sameWear(wear(),[...w,{id,count:1,slot:bonusSlot}].sort((a,b)=>a.slot-b.slot))&&packSame(inv(),expected),{timeoutTicks:8}))throw Error('smelt bonus equip unknown');
  uncertainBonus=false;bonusGuard();await observeBank();
 };
 const stageBonus=async()=>{
  if(!bonus)return true;bonusGuard();
  if(bonus.kind==='forging'){
   const already=wear().some(i=>i.slot===12&&i.id===2568);
   if(!(already&&ringsUsed>0)){
   // Original worn rings need one protected replacement, because their hidden
   // remaining charge can be one. Never read or assume that private counter.
   const protectedRings=bonus.ringReserve+(originalBonusSlot?.id===2568?1:0)+(kit.get(2568)??0);
   if(ringsUsed>=bonus.maximumRings||(totals().get(2568)??0)<=protectedRings)return false;
   await changeSlot(2568);ringsUsed++;
   }
  }else await changeSlot(776);
  const now=totals(),ids=new Set([...initial!.keys(),...now.keys()]);
  if([...ids].some(id=>(now.get(id)??0)!==(initial!.get(id)??0)+(id===r.product?made:0)-(r.ingredients.find(i=>i.id===id)?.units??0)*consumedOre-(id===995?coinsSpent:0)-(id===2568?ringBreaks:0)))throw Error('smelt bonus bank whole assets changed');
  return true;
 };
 const restoreBonus=async()=>{
  if(!bonus)return;await changeSlot(originalBonusSlot?.id);
  for(const id of new Set([bonusId,originalBonusSlot?.id].filter((id):id is number=>id!==undefined))){
   const extra=held(id)-(kit.get(id)??0);if(extra>0){const row=inv().find(i=>i.id===id)!,before=held(id),stock=count(bankRows(),id);uncertainBonus=true;await s.bot.depositItem(row,extra);if(!await waitUntil(s,()=>held(id)===before-extra&&count(bankRows(),id)===stock+extra,{timeoutTicks:8}))throw Error('smelt bonus deposit unknown');uncertainBonus=false;}
  }
  const missing=(kit.get(bonusId)??0)-held(bonusId);if(missing>0){const row=state()?.bank.items.find(i=>i.id===bonusId),stock=count(bankRows(),bonusId),before=held(bonusId);if(!row||stock<missing||28-inv().length<missing)throw Error('smelt original pack gear unavailable');uncertainBonus=true;await s.bot.withdrawItem(row,missing,{asNote:false});if(!await waitUntil(s,()=>held(bonusId)===before+missing&&count(bankRows(),bonusId)===stock-missing,{timeoutTicks:8}))throw Error('smelt original pack gear withdrawal unknown');uncertainBonus=false;}
  gearRestored=sameWear(wear(),originalWear);if(!gearRestored)throw Error('smelt original equipment restoration unproved');
 };
 const bank=async(refill:boolean,cleanup=false)=>{
  if(shilo)await leaveShilo(cleanup);
  if(!await walk(bankSite.x,bankSite.z,cleanup))throw Error('smelt bank route incomplete');
  if(!state()?.bank.isOpen)await observeBank();
  if(!await waitUntil(s,()=>!!state()?.bank.isOpen&&!!s.bankObservation?.(),{timeoutTicks:10}))throw Error('smelt bank observation unready');
  initial??=totals();
  for(const id of material){const item=inv().find(i=>i.id===id);if(item)await depositObserved(s,item);}
  for(const id of r.tools??[]){
   if(refill&&!held(id)){const row=state()?.bank.items.find(i=>i.id===id),stock=count(bankRows(),id);if(!row||stock<1)throw Error('smelt owned reusable tool missing '+id);uncertainBonus=true;await s.bot.withdrawItem(row,1,{asNote:false});if(!await waitUntil(s,()=>held(id)===1&&count(bankRows(),id)===stock-1,{timeoutTicks:8}))throw Error('smelt reusable tool withdrawal unknown');uncertainBonus=false;}
   if(!refill&&(kit.get(id)??0)===0&&held(id)){uncertainBonus=true;await depositObserved(s,inv().find(i=>i.id===id)!);if(held(id)!==0)throw Error('smelt reusable tool return unknown');uncertainBonus=false;}
  }
  if(!refill){if(shilo){const extra=held(995)-(kit.get(995)??0);if(extra>0){const row=inv().find(i=>i.id===995)!,before=held(995),stock=count(bankRows(),995);uncertainBonus=true;await s.bot.depositItem(row,extra);if(!await waitUntil(s,()=>held(995)===before-extra&&count(bankRows(),995)===stock+extra,{timeoutTicks:8}))throw Error('Shilo unused fare return unknown');uncertainBonus=false;}}return 0;}
  if(shilo){
   if(shiloEntries>=route!.maxEntries!){stop='entry budget';return 0;}
   const remainingFees=20*(route!.maxEntries!-shiloEntries);
   if((totals().get(995)??0)<remainingFees+Math.max(route!.coinReserve!,kit.get(995)??0))throw Error('Shilo owned fare budget/reserve unavailable');
   const amount=Math.max(0,20+(kit.get(995)??0)-held(995));if(amount){const row=state()?.bank.items.find(i=>i.id===995),before=held(995),stock=count(bankRows(),995);if(!row)throw Error('Shilo fare unavailable');uncertainBonus=true;await s.bot.withdrawItem(row,amount,{asNote:false});if(!await waitUntil(s,()=>held(995)===before+amount&&count(bankRows(),995)===stock-amount,{timeoutTicks:8}))throw Error('Shilo fare withdrawal unknown');uncertainBonus=false;}
  }
  if(!await stageBonus()){stop='bonus gear depleted';return 0;}
  const batch=planSmeltLoad(r,bankRows(),28-inv().length,o.maximum-made,reserved).planned;
  if(!batch)return 0;
  for(const ingredient of r.ingredients){
   const item=state()?.bank.items.find(i=>i.id===ingredient.id),amount=batch*ingredient.units;
   if(!item||!(await s.bot.withdrawItem(item,amount,{asNote:false})).success||!await waitUntil(s,()=>held(ingredient.id)===amount,{timeoutTicks:8}))throw Error('smelt withdrawal unobserved '+ingredient.id);
  }
  if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5}))throw Error('smelt bank close unobserved');
  return batch;
 };
 try{
  if(entry.fare){
   travel=true;
   await observeBank();initial=totals();
   if(over()||hpMin<7)throw Error('smelt entry stopped/low health');
   if((initial.get(995)??0)<entry.fare)throw Error('smelt entry needs 10 coins for toll');
   // Keep pack kit/food; withdraw only the missing fare, with an observed delta.
   const needed=Math.max(0,entry.fare-held(995));
   if(needed){const coins=state()?.bank.items.find(i=>i.id===995),before=held(995);
    if(!coins||!(await s.bot.withdrawItem(coins,needed,{asNote:false})).success||!await waitUntil(s,()=>held(995)===before+needed,{timeoutTicks:8}))throw Error('smelt fare withdrawal unobserved');}
   if(!await waitUntil(s,()=>count(bankRows(),995)+held(995)===(initial!.get(995)??0),{timeoutTicks:8}))throw Error('smelt fare bank balance unobserved');
   if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5}))throw Error('smelt entry bank close unobserved');
   for(const point of entry.points){
    if(over())throw Error('smelt entry stopped');
    let reached=false,detail='';
    try{reached=await walk(point.x,point.z);}catch(error){detail=String(error);}
    if(!reached&&!await recover(point.x,point.z))throw Error(`smelt entry corridor incomplete at ${point.x},${point.z}${detail?': '+detail:''}`);
    passed.push(point);
   }
   const guard=s.sdk.getNearbyNpcs().filter(n=>n.id===925).sort((a,b)=>a.distance-b.distance)[0];
   if(!guard||!(await s.sdk.sendInteractNpc(guard.index,1)).success)throw Error('smelt west toll guard unavailable');
   const cash=held(995),deadline=s.tick()+45;let answered=false;
   try{
   while(!near(3268,3227,1)|| (state()?.player?.worldX??0)<3268){
    if(over()||s.tick()>=deadline)throw Error('smelt toll crossing deadline');
    const d=s.sdk.getDialog();
    if(d?.isOpen&&!d.isWaiting){
     if(d.options.some(v=>/yes, ok/i.test(v.text))){if(!answered){if(!(await s.sdk.clickDialogByText(/yes, ok/i)).success)throw Error('smelt toll choice refused');answered=true;}}
     else if(d.options.length===0||d.options.length===1&&/continue/i.test(d.options[0]!.text)){if(!(await s.sdk.sendClickDialog(d.options[0]?.index??0)).success)throw Error('smelt toll continue refused');}
     else throw Error('smelt unexpected toll dialog');
    }
    await waitTicks(s,1);
   }
   crossed=true;
   if(!await waitUntil(s,()=>cash-held(995)===(answered?entry.fare:0),{timeoutTicks:5}))throw Error('smelt toll debit unobserved');
   }finally{coinsSpent=cash-held(995);}
   if(coinsSpent!==(answered?entry.fare:0))throw Error('smelt toll debit mismatch');
   for(const [x,z] of [[3272,3227],[3275,3212],[3273,3194],[3269,3167]])if(over()||!await walk(x!,z!))throw Error('smelt destination corridor incomplete');
   travel=false;travelTicks=s.tick()-start;
  }
  arrival=true;
  while(made<o.maximum&&!over()){
   const batch=await bank(true);if(!batch){if(stop!=='bonus gear depleted')stop='depleted';break;}
   if(shilo){await enterShilo();if(over())break;}
   if(!await walk(furnaceStand.x,furnaceStand.z))throw Error('smelt furnace route incomplete');
   while(r.ingredients.every(i=>held(i.id)>=i.units)&&made<o.maximum&&!over()){
    const dialog=s.sdk.getDialog();if(dialog?.isOpen){
     if(dialog.isWaiting){await waitTicks(s,1);continue;}
     const option=dialog.options.find(v=>/continue/i.test(v.text));if(!option)throw Error('smelt unexpected dialog');
     const reply=await s.sdk.sendClickDialog(option.index);
     if(!reply.success)throw Error('smelt dialog click refused: '+JSON.stringify(reply));
     // Dispatch acknowledgement precedes the server's next UI packet. Yield as
     // quest-lib.converse/runBronze do; otherwise resolved promises can starve
     // the socket pump indefinitely on a retained level-up page.
     await waitTicks(s,1);continue;
    }
    localAdmission();cannonAdmission();
    const furnace=route?declaredFurnace():s.sdk.findNearbyLoc(/^furnace$/i,{withOption:/smelt/i}),ore=inv().find(i=>i.id===r.ingredients[0]!.id);if(!furnace||!ore||route&&!near(furnaceStand.x,furnaceStand.z,0))throw Error('smelt furnace/ore/declared stand missing');
    const before=inv().map(i=>({id:i.id,count:i.count})),beforeXp=xp();attempts++;
    const foreignXp=cannon?JSON.stringify(state()?.skills.filter(k=>k.name!=='Smithing').map(k=>[k.name,k.experience])):'';
    if(cannon&&(!held(4)||!sameWear(wear(),originalWear)))throw Error('cannonball mould/original gear missing');
    const beforeWear=bonus?wear():[];if(bonus){bonusGuard();if(!sameWear(beforeWear,[...originalWear.filter(i=>i.slot!==bonusSlot),{id:bonusId,count:1,slot:bonusSlot}].sort((a,b)=>a.slot-b.slot)))throw Error('smelt bonus gear absent/changed before Make1');}
    const cursor=Math.max(-1,...(state()?.gameMessages??[]).map(m=>m.observationId??m.tick));
    const ironLoss=()=>r.iron&&(state()?.gameMessages??[]).some(m=>(m.observationId??m.tick)>cursor&&/ore is too impure|fail to refine/i.test(m.text));
    const meltMessage=()=>bonus?.kind==='forging'&&(state()?.gameMessages??[]).some(m=>m.type===0&&(m.observationId??m.tick)>cursor&&m.text==='Your Ring of Forging has melted.');
    const cannonTerminal=()=>state()?.gameMessages.find(m=>m.type===0&&!m.sender&&!m.fromSelf&&(m.observationId??m.tick)>cursor&&m.text==='You remove the cannonballs from the mould.');
    const wearReceipt=()=>!bonus||sameWear(wear(),beforeWear)&&!meltMessage()||bonus.kind==='forging'&&meltMessage()&&sameWear(wear(),beforeWear.filter(i=>i.slot!==12));
    if(bonus||route||cannon)uncertainBonus=true;
    localPaid=!!route||cannon;let sent:Awaited<ReturnType<typeof s.sdk.sendUseItemOnLoc>>;try{sent=await s.sdk.sendUseItemOnLoc(ore.slot,furnace.x,furnace.z,furnace.id);}finally{localPaid=false;}
    await waitUntil(s,()=>ended||died||held(r.ingredients[0]!.id)<count(before,r.ingredients[0]!.id),{timeoutTicks:cannon?Math.min(r.receiptTicks!,Math.max(1,bonusDeadline-s.tick())):8});
    // Inventory and XP can be separate publications; settle both before judging success.
    await waitUntil(s,()=>ended||died||held(r.product)>count(before,r.product)&&xp()>beforeXp&&wearReceipt()&&(!cannon||!!cannonTerminal())||ironLoss(),{timeoutTicks:cannon?3:2});
    // Equipment, system messages and public XP are separate packets. Do not
    // initiate another Make1 while a just-consumed ring can still be publishing.
    if(bonus){await waitTicks(s,2);bonusGuard();}
    const effect=smeltEffect(r,before,inv(),beforeXp,xp());
    if(cannon){
     const delta=r.rawXp!*o.xpRate!,expected=before.map(i=>({...i}));let left=1;for(const row of expected)if(row.id===2353&&left){row.count--;left--;}
     expected.push({id:r.product,count:productUnits});const terminal=cannonTerminal();
     if(!owner.own()||ended||died||effect.kind!=='made'||!terminal||!packSame(inv(),expected)||!sameWear(wear(),originalWear)||JSON.stringify(state()?.skills.filter(k=>k.name!=='Smithing').map(k=>[k.name,k.experience]))!==foreignXp||xp()-beforeXp<Math.floor(delta/10)||xp()-beforeXp>Math.ceil(delta/10))throw Error('cannonball terminal/whole-pack/XP effect unknown');
     cannonRawXp+=delta;if(xp()-xp0<Math.floor(cannonRawXp/10)||xp()-xp0>Math.ceil(cannonRawXp/10))throw Error('cannonball cumulative XP mismatch');
     cannonReceipts.push({tick:s.tick(),terminal:terminal.observationId??terminal.tick,rawXp:delta,products:productUnits});uncertainBonus=false;
    }
    let melted=false;
    if(bonus){
     const delta=smeltBonusRawXp(bonus),expected=before.map(i=>({...i}));
     for(const ingredient of r.ingredients){let left=ingredient.units;for(const row of expected)if(row.id===ingredient.id){const n=Math.min(left,row.count);row.count-=n;left-=n;}}
     expected.push({id:r.product,count:1});
     // Native ore-on-loc enqueues exactly one bar, even when carrying a full
     // load. The ring can break on that successful bar, never on a later queue.
     if(effect.kind!=='made'||!packSame(inv(),expected)||xp()-beforeXp<Math.floor(delta/10)||xp()-beforeXp>Math.ceil(delta/10))throw Error('smelt bonus paid output/whole-pack/XP unknown');
     if(bonus.kind==='forging'&&!sameWear(wear(),beforeWear)){
      if(!await waitUntil(s,()=>meltMessage(),{timeoutTicks:2})||!sameWear(wear(),beforeWear.filter(i=>i.slot!==12)))throw Error('smelt ring debit without exact fresh melt receipt');
      melted=true;
     }else if(!sameWear(wear(),beforeWear)||meltMessage())throw Error('smelt bonus equipment receipt mismatch');
     bonusRawXp+=delta;if(xp()-xp0<Math.floor(bonusRawXp/10)||xp()-xp0>Math.ceil(bonusRawXp/10))throw Error('smelt cumulative bonus XP mismatch');
     if(melted)ringBreaks++;uncertainBonus=false;
    }
    if(effect.kind==='none'){if(route||!sent.success||++misses>=3)throw Error('no smelt progress: unchanged recipe after bounded attempts');}
    else{misses=0;consumedOre++;made+=effect.made;if(effect.kind==='loss'){losses++;if(!ironLoss())throw Error('iron impurity loss message unobserved');}}
    if(route)uncertainBonus=false;
    if(melted)break;
   }
  }
  if(made>=o.maximum)stop='target';
 }catch(error){failure='no smelt progress: '+String(error);}
 finally{try{if(!uncertainBonus&&!ended&&!died&&owner.cleanup()){
  if(bonus||route||cannon)bonusDeadline=s.tick()+160;
  if(s.sdk.getDialog()?.isOpen){await s.direct({type:'closeModal',reason:'SDK'});if(!await waitUntil(s,()=>!s.sdk.getDialog()?.isOpen,{timeoutTicks:5}))throw Error('smelt final dialog close unobserved');}
  // Never turn an interrupted entry into a blind cross-map cleanup walk. East of the gate the Al Kharid
  // bank is the near bank; a retreat west would pay the toll again.
  if(arrival||crossed){
   await bank(false,true);
   await restoreBonus();
  }
  else if(entry.fare){
   // Retrace only the observed entry corridor. Escape a stalled hostile leg
   // before the session owner attempts logout; never start a second logout.
   if(!near(3253,3420,5)){
    for(const point of [...passed].reverse())if(!await recover(point.x,point.z,true))throw Error('smelt entry retreat incomplete');
    if(!await recover(entryBank.x,entryBank.z,true))throw Error('smelt entry bank retreat incomplete');
   }
   if(!state()?.bank.isOpen)await observeBank();
  }
 }}catch(error){failure=failure?failure+'; final bank: '+String(error):'no smelt progress: final bank: '+String(error);}off();}
 if(travel)travelTicks=s.tick()-start;
 const finalObservation=s.bankObservation?.(),final=initial?totals():new Map<number,number>();
 const banked=initial&&finalObservation?(final.get(r.product)??0)-(initial.get(r.product)??0)-held(r.product):null;
 const preserved=[...kit].every(([id,n])=>id===995?true:held(id)===n);
 const allIds=new Set([...(initial?.keys()??[]),...final.keys()]);
 const conserved=initial&&lastBank?[...allIds].every(id=>{
  const ingredient=r.ingredients.find(i=>i.id===id),expected=(initial!.get(id)??0)+(id===r.product?made*productUnits:0)-(ingredient?consumedOre*ingredient.units:0)-(id===995?coinsSpent:0)-(id===2568?ringBreaks:0);
  return(final.get(id)??0)===expected;
 }):null;
 const reserveMet=finalObservation?r.ingredients.every(i=>count(finalObservation.items,i.id)>=(reserved[i.id]??0))&&(!shilo||(final.get(995)??0)>=route!.coinReserve!)&&(!bonus||bonus.kind!=='forging'||count(finalObservation.items,2568)>=bonus.ringReserve):null;
 if(!failure&&o.mode==='exact'&&made!==o.maximum)failure=`no smelt progress: exact target unmet ${made}/${o.maximum} (${stop})`;
 if(!failure&&made===0)failure=`no smelt progress: zero observed bars (${stop})`;
 if(cannon)gearRestored=sameWear(wear(),originalWear)&&(r.tools??[]).every(id=>held(id)===(kit.get(id)??0));
 if(!failure&&(banked!==made*productUnits||!conserved||!preserved||!reserveMet||!gearRestored))failure='no smelt progress: final bank/asset/reserve acceptance unproved';
 const ok=owner.own()&&!failure&&!ended&&!died&&!o.stop?.()&&hpMin>=7&&made>0&&xp()>xp0&&near(bankSite.x,bankSite.z)&&banked===made*productUnits&&preserved&&conserved===true&&reserveMet===true&&[...material].every(id=>held(id)===0)&&(o.mode==='best-effort'||made===o.maximum);
 return{ok:ok&&gearRestored&&!uncertainBonus,bar:o.bar,mode:o.mode,target:o.maximum,targetMet:made===o.maximum,ticks:s.tick()-start,entry:entry.name,travelTicks,coinsSpent,initialCoins:initial?.get(995)??0,finalCoins:final.get(995)??0,made,banked,consumedOre,losses,attempts,xpGain:xp()-xp0,preserved,conserved,reserveMet,hpMin,died,stop,failure,...(cannon?{products:made*productUnits,productUnits,cannonRawXp,cannonReceipts,gearRestored,deferred:uncertainBonus}:{}),...(bonus?{bonusGear:bonus,bonusRawXp,ringBreaks,ringsUsed,gearRestored,deferred:uncertainBonus}:{}),...(route?{route,deferred:uncertainBonus,...(shilo?{accessReceipts,shiloEntries}:{} )}:{}),nextConsumer:'Smithing progression; measure iron-tip/ammo conversion before more surplus mining'};
}
