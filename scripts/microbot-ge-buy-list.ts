import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {openBot,settle,serverFromEnv} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath} from '../packages/core/src/walk';
import {MarketClient,type MarketQuote} from '../vendor/rs-sdk/sdk/market';
import {runOwnedItem,orderPaths,orderAccounting,orderItemMatcher,validateRequest,type ItemRequest,type ItemOrder} from './buy-owned-ge-item';

type NativeItem={id:number;name:string;tradeable?:boolean;members?:boolean;cost?:number};
export type BuyListEntry={item:number;quantity:number;basePrice:number;unitCap:number;percent:5|10|50|99};
export type BuyListRequest={actor:string;server:string;goal:string;entries:BuyListEntry[];budget:number;reserve:number;createdAt:number;deadline:number;fillWait:number;cap:number};
type Outcome={acquired:number;spent:number};
export type BuyListJournal={version:1;request:BuyListRequest;initial:Record<number,number>;gear:unknown;children:ItemRequest[];outcomes:(Outcome|null)[];phase:'prepared'|'running'|'banked';aborted:boolean;failure?:string};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),BANK={x:3185,z:3436};
const nativeItems=():NativeItem[]=>JSON.parse(readFileSync(new URL('../knowledge/items.json',import.meta.url),'utf8'));
const positive=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=2147483647;

// Native GE +5% uses max(1,floor(current*0.05)) for each click, including low prices.
export function percentagePrice(base:number,percent:number){
 if(!positive(base)||![5,10,50,99].includes(percent))throw Error('unsupported native buy percentage/base');
 let price=base;if(percent===99)return Math.min(2147483647,base+Math.max(1,Number(BigInt(base)*99n/100n)));
 for(let i=0;i<percent/5;i++)price=Math.min(2147483647,price+Math.max(1,Math.floor(price/20)));
 return price;
}
// Donor map semantics: the last duplicate wins; the first occurrence fixes its position.
export function parseBuyList(text:string,catalogue:readonly NativeItem[]=nativeItems()){
 if(typeof text!=='string'||!text.trim())throw Error('explicit finite buy list required');
 const out=new Map<number,{item:number;quantity:number}>();
 for(const raw of text.split(',')){
  const m=raw.trim().match(/^([^\[\]]+?)(?:\[(\d+)\])?$/);if(!m)throw Error('invalid Name[quantity] buy list');
  const name=m[1]!.trim().toLowerCase(),matches=catalogue.filter(i=>i.name.toLowerCase()===name&&i.tradeable===true);
  if(matches.length!==1||matches[0]!.id===995)throw Error('buy name must resolve one exact native tradeable item: '+name);
  const quantity=Number(m[2]??1);if(!positive(quantity))throw Error('invalid finite buy quantity');
  out.set(matches[0]!.id,{item:matches[0]!.id,quantity});
 }
 if(out.size>32)throw Error('buy list exceeds 32 distinct native items');return [...out.values()];
}
export function validateBuyList(r:BuyListRequest,catalogue:readonly NativeItem[]=nativeItems()){
 if(!r||!Array.isArray(r.entries)||!r.entries.length||r.entries.length>32||new Set(r.entries.map(e=>e.item)).size!==r.entries.length||!positive(r.budget)||!Number.isSafeInteger(r.reserve)||r.reserve<0||!Number.isSafeInteger(r.cap)||r.cap<1000||r.cap>100000||!Number.isSafeInteger(r.fillWait)||r.fillWait<0||r.fillWait>200||!Number.isSafeInteger(r.createdAt)||!Number.isSafeInteger(r.deadline)||r.createdAt<=0||r.deadline<=r.createdAt)throw Error('invalid finite buy-list budget');
 let exposure=0;for(const e of r.entries){if(!positive(e.quantity)||!positive(e.unitCap)||percentagePrice(e.basePrice,e.percent)>e.unitCap||!catalogue.some(i=>i.id===e.item&&i.tradeable===true)||e.item===995)throw Error('native item/percentage exceeds explicit unit cap');exposure+=e.quantity*percentagePrice(e.basePrice,e.percent);}
 if(!Number.isSafeInteger(exposure)||exposure>r.budget||r.budget+r.reserve>2147483647)throw Error('buy list exceeds explicit owned budget');
 validateRequest({actor:r.actor,server:r.server,goal:r.goal,item:r.entries[0]!.item,quantity:1,limit:1,reserve:r.reserve,createdAt:r.createdAt,reviewAt:r.createdAt,deadline:r.deadline});
 if(r.goal.length>52)throw Error('buy-list key must leave room for child identity');
}
export function buyListPaths(r:BuyListRequest){const p=orderPaths(r.server,r.actor,r.goal);return{lock:p.lock,parent:p.journal+'.buy-list',children:r.entries.map((_e,i)=>orderPaths(r.server,r.actor,`${r.goal}-buy-${i}`).journal)};}
export function buyListStop(actor:string,stopped=false,exists:(p:string)=>boolean=existsSync){return stopped||[`.practice/stop-${actor}`,'.practice/stop-all','.practice/stop-microbot-ge-buy-list'].some(exists);}
export type BuyListDeps={buyer?:typeof runOwnedItem;catalogue?:readonly NativeItem[];paths?:ReturnType<typeof buyListPaths>;bankAudit?:(s:Session)=>Promise<Record<number,number>>};
export async function runBuyList(s:Session,r:BuyListRequest,requestStop:()=>boolean=()=>false,deps:BuyListDeps={}){
 const catalogue=deps.catalogue??nativeItems();validateBuyList(r,catalogue);if(s.name.toLowerCase()!==r.actor.toLowerCase())throw Error('buy-list actor mismatch');
 const paths=deps.paths??buyListPaths(r),buyer=deps.buyer??runOwnedItem;
 let parent:BuyListJournal|undefined=existsSync(paths.parent)?JSON.parse(readFileSync(paths.parent,'utf8')):undefined;
 const load=(i:number)=>{if(!existsSync(paths.children[i]!))return;const j=JSON.parse(readFileSync(paths.children[i]!,'utf8'))as ItemOrder;if(!parent||j.version!==1||!same(j.request,parent.children[i])||!['entry','placing','open','cancelling','collecting','settled'].includes(j.phase))throw Error('buy child missing parent/corrupt identity');return j;};
 if(!parent&&paths.children.some(existsSync))throw Error('buy child exists without parent intent');
 if(parent&&(parent.version!==1||!same(parent.request,r)||!['prepared','running','banked'].includes(parent.phase)||!parent.initial||Object.entries(parent.initial).some(([id,n])=>!/^\d+$/.test(id)||!Number.isSafeInteger(n)||n<0)||!Array.isArray(parent.children)||parent.children.length!==r.entries.length||!Array.isArray(parent.outcomes)||parent.outcomes.length!==r.entries.length||typeof parent.aborted!=='boolean'))throw Error('buy-list parent corrupt/config changed');
 const first=s.sdk.getState()?.player,life=first?.lifeId,respawns=first?.respawnCount??0,hp=s.sdk.getSkill('Hitpoints')?.level??0,start=s.tick();let ended=false;void s.ended.then(()=>{ended=true;});
 const fatal=()=>{const p=s.sdk.getState()?.player;return ended||!p||p.isDead||p.lifeId!==life||(p.respawnCount??0)!==respawns||(s.sdk.getSkill('Hitpoints')?.level??0)<hp||hp<=0||s.tick()-start>=r.cap;};
 const stop=()=>fatal()||requestStop()||Date.now()>=r.deadline||s.tick()-start>=r.cap-700;
 const gear=()=>s.sdk.getEquipment().map(i=>({id:i.id,slot:i.slot,count:i.count})).sort((a,b)=>a.slot-b.slot);
 const canonical=(rows:readonly {id:number;name?:string;count:number}[])=>{const result:Record<number,number>={};for(const row of rows){const e=r.entries.find(e=>orderItemMatcher(e.item,catalogue)(row)),id=e?.item??row.id;result[id]=(result[id]??0)+row.count;}return result;};
 const outputsBanked=()=>[...s.sdk.getInventory(),...s.sdk.getEquipment()].every(i=>i.id!==995&&!r.entries.some(e=>orderItemMatcher(e.item,catalogue)(i)));
 const audit=deps.bankAudit??(async()=>{
  if(fatal()||s.tick()-start>=r.cap-30)throw Error('buy-list original life/audit budget unavailable');
  const p=s.sdk.getState()?.player;if(!p||p.level!==0||p.worldX<3180||p.worldX>3188||p.worldZ<3433||p.worldZ>3447)throw Error('buy-list starts/returns in known Varrock bank/GE rectangle');
  if(Math.max(Math.abs(p.worldX-BANK.x),Math.abs(p.worldZ-BANK.z))>1&&!(await walkPath(await sessionWalker(s),[{...BANK,tol:1}],{maxTicks:100,stop:fatal})).ok)throw Error('buy-list bank route failed');
  const generation=s.bankObservation?.()?.generation??-1,closedAt=s.tick();await s.sdk.sendCloseModal();
  if(!await waitUntil(s,()=>fatal()||s.tick()>closedAt&&!s.sdk.getState()?.bank.isOpen&&!s.sdk.getGEState()&&!s.sdk.getState()?.interface.isOpen&&!s.sdk.getState()?.modalOpen,{timeoutTicks:12})||fatal())throw Error('buy-list observed modal closure absent');
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>fatal()||!!s.sdk.getState()?.bank.isOpen&&(s.bankObservation?.()?.generation??-1)>generation,{timeoutTicks:12})||fatal())throw Error('buy-list fresh bank unavailable');
  const observed=s.bankObservation?.();if(!observed||!s.sdk.getState()?.bank.isOpen)throw Error('buy-list bank observation unknown');
  const result=canonical([...observed.items,...s.sdk.getInventory(),...s.sdk.getEquipment()]);await s.bot.closeBank();return result;
 });
 const save=()=>{mkdirSync(dirname(paths.parent),{recursive:true});writeFileSync(paths.parent+'.tmp',JSON.stringify(parent,null,2));renameSync(paths.parent+'.tmp',paths.parent);};
 const outcome=(j:ItemOrder)=>{const a=orderAccounting(j);if(j.phase!=='settled'||a.outcomeUnresolved||a.escrow!==0)throw Error('buy child escrow not settled');return{acquired:a.acquired,spent:a.spent};};
 const balanced=(after:Record<number,number>)=>{const delta:Record<number,number>={};let spent=0;for(let i=0;i<r.entries.length;i++){const o=parent!.outcomes[i];if(o){delta[r.entries[i]!.item]=(delta[r.entries[i]!.item]??0)+o.acquired;spent+=o.spent;}}delta[995]=-spent;return spent<=r.budget&&(after[995]??0)>=r.reserve&&same(parent!.gear,gear())&&[...new Set([...Object.keys(parent!.initial),...Object.keys(after)])].every(k=>(after[Number(k)]??0)===(parent!.initial[Number(k)]??0)+(delta[Number(k)]??0));};
 let failure='',pending=false;const replay=parent?.phase==='banked';
 try{
  if(!parent){if(stop())throw Error('buy list stopped before intent');const initial=await audit(s);if((initial[995]??0)<r.budget+r.reserve)throw Error('buy list owned cash/reserve short');const children=r.entries.map((e,i)=>({actor:r.actor,server:r.server,goal:`${r.goal}-buy-${i}`,item:e.item,quantity:e.quantity,expectedOwned:initial[e.item]??0,limit:percentagePrice(e.basePrice,e.percent),reserve:r.reserve,createdAt:r.createdAt,reviewAt:r.createdAt,deadline:r.deadline}));parent={version:1,request:r,initial,gear:gear(),children,outcomes:r.entries.map(()=>null),phase:'prepared',aborted:false};save();}
  for(let i=0;i<r.entries.length;i++){
   const e=r.entries[i]!,q=parent.children[i]!;validateRequest(q);if(q.actor!==r.actor||q.server!==r.server||q.goal!==`${r.goal}-buy-${i}`||q.item!==e.item||q.quantity!==e.quantity||q.limit!==percentagePrice(e.basePrice,e.percent)||q.expectedOwned!==(parent.initial[e.item]??0)||q.reserve!==r.reserve||q.deadline!==r.deadline||q.createdAt!==r.createdAt||q.reviewAt!==r.createdAt)throw Error('buy-list persisted child request changed');
   const j=load(i);if(j&&i>0&&load(i-1)?.phase!=='settled')throw Error('buy-list child sequence ambiguous');
   if(parent.outcomes[i]&&(!j||!same(outcome(j),parent.outcomes[i])))throw Error('buy-list outcome disagrees with child');
  }
  for(let i=0;i<r.entries.length;i++){
   const e=r.entries[i]!,q=parent.children[i]!;
   const j=load(i),recorded=parent.outcomes[i];if(recorded){if(!j||!same(outcome(j),recorded))throw Error('buy-list outcome disagrees with child');continue;}
   if(replay){if(parent.aborted&&!j)break;throw Error('banked buy list has unresolved child');}
   // Recovery drains the existing offer before any next list entry. A stop never authorizes a new child.
   if(!j&&(stop()||parent.aborted)){parent.aborted=true;save();break;}
   if(!j&&!balanced(await audit(s)))throw Error('buy-list initial assets changed before next order');
   parent.phase='running';save();const result=await buyer(s,q,paths.children[i]!,j?fatal:stop,!!j,r.fillWait);
   const settled=load(i);if(!settled||settled.phase!=='settled'){pending=!!settled;throw Error('buy-list child outcome unresolved; no later item authorized');}
   // A terminal market journal proves escrow settlement, not the lower consumer's bank return.
   // Re-entering an existing settled child with cancel=true can finish banking but cannot fund another round.
   if(!result.banked||!result.conserved||!result.unrelated||!result.reserveKept||result.outcomeUnresolved||result.died||result.damaged||!outputsBanked())throw Error('buy-list settled child bank return unconfirmed; no later item authorized');
   parent.outcomes[i]=outcome(settled);if(parent.outcomes[i]!.acquired!==e.quantity){parent.aborted=true;failure='finite buy child partially filled';}save();
   if(parent.aborted)break;
  }
  if(paths.children.some((_p,i)=>{const j=load(i);return !!j&&j.phase!=='settled';})){pending=true;throw Error('buy-list active escrow remains');}
  const after=await audit(s);if(!balanced(after)||!outputsBanked())throw Error('buy-list final initial-assets/owned budget/banked outputs audit failed');
  parent.phase='banked';if(failure)parent.failure=failure;else delete parent.failure;save();const targetMet=parent.outcomes.every((o,i)=>o?.acquired===r.entries[i]!.quantity);
  return{ok:!fatal(),banked:true,targetMet,replay,pending:false,outcomes:parent.outcomes,spent:parent.outcomes.reduce((n,o)=>n+(o?.spent??0),0),failure:failure||'-'};
 }catch(error){failure=String(error);if(parent){parent.failure=failure;save();}return{ok:false,banked:false,targetMet:false,replay,pending,failure,outcomes:parent?.outcomes};}
}

if(import.meta.main){
 const [actor,path]=process.argv.slice(2);if(!actor||!path)throw Error('usage: microbot-ge-buy-list.ts actor plan.json');
 const input=JSON.parse(readFileSync(path,'utf8')),server=serverFromEnv(readFileSync(resolve('vendor/rs-sdk/bots',actor,'bot.env'),'utf8'));
 let r=input as BuyListRequest;if(r.actor!==actor||r.server!==server)throw Error('buy-list CLI actor/server mismatch');
 // Optional donor-format list resolves exact native names; prices are frozen once in the persisted intent.
 if(input.list){const path=buyListPaths({...r,entries:[]} as BuyListRequest).parent;if(existsSync(path)){const old=JSON.parse(readFileSync(path,'utf8')).request;const withoutEntries=(x:any)=>{const{entries,...rest}=x;return rest;};if(!same(withoutEntries(old),withoutEntries(input)))throw Error('persisted buy-list source/config changed');r=old;}else{const parsed=parseBuyList(input.list),market=new MarketClient(server.includes('://')?server:`http://${server}`);r.entries=[];for(const e of parsed){const q:MarketQuote=await market.item(e.item);r.entries.push({...e,basePrice:q.lastPrice??Math.max(1,q.basePrice),percent:input.percent,unitCap:input.unitCaps?.[e.item]});}}}
 validateBuyList(r);const paths=buyListPaths(r);mkdirSync(dirname(paths.lock),{recursive:true});
 if(existsSync(paths.lock)){const owner=JSON.parse(readFileSync(paths.lock,'utf8'));if(!positive(owner.pid))throw Error('buy-list lock owner unknown');let alive=true;try{process.kill(owner.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('market actor already owned');unlinkSync(paths.lock);}
 const fd=openSync(paths.lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,actor,goal:r.goal}));closeSync(fd);let s:Session|undefined,stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 try{s=await openBot(actor,{onStop:async()=>{stopped=true;},onSessionEnd:async()=>{stopped=true;}});const result=await runBuyList(s,r,()=>buyListStop(actor,stopped));console.log('GE_BUY_LIST '+JSON.stringify(result));process.exitCode=await settle([s],result.ok,JSON.stringify(result))?0:1;}catch(error){if(s)await settle([s],false,String(error));throw error;}finally{unlinkSync(paths.lock);}
}
