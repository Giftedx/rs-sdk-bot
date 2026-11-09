// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite JSON action graphs, never JavaScript evaluation: bun scripts/microbot-a-actions.ts <account> <plan.json>.
// Nodes resolve observed item/NPC/loc IDs; effects are relative inventory/XP or an observed destination.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,finish,logoutSession} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {productionStopRequested} from './microbot-c-lifetime';
import {lootCapacity} from './microbot-b-mining-loot';
export type GraphEffect={kind:'inventory';id:number;delta:number}|{kind:'xp';skill:string;minimum:number}|{kind:'position';x:number;z:number;level:number;tolerance:number};
export type GraphAction={kind:'npc';id:number;option:string}|{kind:'loc';id:number;option:string}|{kind:'item';id:number;optionIndex:number}|{kind:'item-on-item';id:number;target:number}|{kind:'item-on-npc';id:number;target:number}|{kind:'item-on-loc';id:number;target:number}|{kind:'ground-item';id:number;x:number;z:number;level:number;count:number}|{kind:'walk';x:number;z:number};
export type GraphCondition={kind:'stat';skill:'Hitpoints'|'Prayer';comparator:'above'|'below';threshold:number}|{kind:'inventory';id:number;minimum:number;present:boolean}|{kind:'npc'|'loc';id:number;radius:number;present:boolean};
export interface ActionNode{id:string;action:GraphAction;effect:GraphEffect;timeout:number;next?:string;failure?:string;delayTicksBefore?:number;condition?:GraphCondition}
export interface ActionGraph{start:string;maximum:number;cap:number;nodes:ActionNode[]}
export interface GraphObservation{inventory:Record<number,number>;skills:Record<string,number>;position:{x:number;z:number;level:number}|null;levels?:Record<string,number>;npcs?:{id:number;distance:number}[];locs?:{id:number;distance:number}[]}
export function validateGraphCondition(c:GraphCondition){
 const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 if(!c||!['stat','inventory','npc','loc'].includes(c.kind))throw Error('unsupported graph condition');
 if(c.kind==='stat'){if(!['Hitpoints','Prayer'].includes(c.skill)||!['above','below'].includes(c.comparator)||!integer(c.threshold))throw Error('invalid graph stat condition');}
 else if(!integer(c.id)||typeof c.present!=='boolean'||(c.kind==='inventory'?(!integer(c.minimum)||c.minimum<1):(!integer(c.radius)||c.radius<1||c.radius>20)))throw Error('invalid graph presence condition');
 return c;
}
export function validateActionGraph(plan:ActionGraph){
 if(!plan||!Number.isSafeInteger(plan.maximum)||plan.maximum<1||plan.maximum>1000||!Number.isSafeInteger(plan.cap)||plan.cap<1||plan.cap>100000||!Array.isArray(plan.nodes)||plan.nodes.length<1||plan.nodes.length>1000)throw Error('invalid finite action graph');
 const ids=new Set(plan.nodes.map(n=>n.id));if(ids.size!==plan.nodes.length||!ids.has(plan.start))throw Error('graph node IDs/start');
 const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 for(const n of plan.nodes){
  if(!/^[a-z0-9_-]{1,64}$/i.test(n.id)||n.next&&!ids.has(n.next)||n.failure&&!ids.has(n.failure)||!Number.isSafeInteger(n.timeout)||n.timeout<1||n.timeout>100)throw Error('invalid graph edge/timeout');
  if(n.delayTicksBefore!==undefined&&(!integer(n.delayTicksBefore)||n.delayTicksBefore>100000))throw Error('invalid graph tick delay');
  if(n.condition!==undefined)validateGraphCondition(n.condition);
  const a=n.action;if(!a||!['npc','loc','item','item-on-item','item-on-npc','item-on-loc','ground-item','walk'].includes(a.kind))throw Error('unsupported graph action');
  if(a.kind==='walk'){if(!integer(a.x)||!integer(a.z))throw Error('invalid graph tile');}
  else{
   if(!integer(a.id))throw Error('invalid graph item/target ID');
   if(['item-on-item','item-on-npc','item-on-loc'].includes(a.kind)&&(!('target'in a)||!integer(a.target)))throw Error('invalid graph target ID');
   if((a.kind==='npc'||a.kind==='loc')&&(typeof a.option!=='string'||!a.option.trim()||a.option.length>64))throw Error('invalid graph option');
   if(a.kind==='item'&&(!Number.isSafeInteger(a.optionIndex)||a.optionIndex<1||a.optionIndex>5))throw Error('invalid graph inventory option');
  }
  const e=n.effect;if(!e||!['inventory','xp','position'].includes(e.kind))throw Error('missing graph effect');
  if(e.kind==='inventory'&&(!integer(e.id)||!Number.isSafeInteger(e.delta)||e.delta===0))throw Error('invalid graph inventory effect');
  if(e.kind==='xp'&&(!/^[A-Za-z ]{1,24}$/.test(e.skill)||!Number.isFinite(e.minimum)||e.minimum<=0))throw Error('invalid graph XP effect');
  if(e.kind==='position'&&(![e.x,e.z,e.level,e.tolerance].every(integer)||e.level>3||e.tolerance>10))throw Error('invalid graph position effect');
  if(a.kind==='ground-item'&&(![a.x,a.z,a.level,a.count].every(integer)||a.level>3||a.count<1||a.count>2147483647||e.kind!=='inventory'||e.id!==a.id||e.delta!==a.count))throw Error('invalid graph ground pile/effect');
 }
 return plan;
}
export function graphEffect(e:GraphEffect,b:GraphObservation,a:GraphObservation){
 if(e.kind==='inventory')return(a.inventory[e.id]??0)-(b.inventory[e.id]??0)===e.delta;
 if(e.kind==='xp')return(a.skills[e.skill]??0)-(b.skills[e.skill]??0)>=e.minimum;
 return !!a.position&&a.position.level===e.level&&Math.max(Math.abs(a.position.x-e.x),Math.abs(a.position.z-e.z))<=e.tolerance;
}
export function graphCondition(c:GraphCondition,s:GraphObservation):boolean|undefined{
 if(c.kind==='stat'){
  const level=s.levels?.[c.skill];if(level===undefined||!Number.isFinite(level)||level<0)return undefined;
  return c.comparator==='above'?level>c.threshold:level<c.threshold;
 }
 if(c.kind==='inventory')return((s.inventory[c.id]??0)>=c.minimum)===c.present;
 const rows=c.kind==='npc'?s.npcs:s.locs;if(!rows)return undefined;
 const matches=rows.filter(row=>row.id===c.id);if(matches.some(row=>!Number.isFinite(row.distance)||row.distance<0))return undefined;
 return matches.some(row=>row.distance<=c.radius)===c.present;
}
export async function runActionGraph(io:{tick():number;stopped():boolean;read():GraphObservation;dispatch(a:GraphAction):Promise<boolean>;wait(p:()=>boolean,ticks:number):Promise<boolean>},plan:ActionGraph){
 validateActionGraph(plan);const start=io.tick();let next:string|undefined=plan.start,steps=0,confirmed=0,skipped=0;const receipts:{node:string;effect:boolean;tick:number;skipped?:boolean}[]=[];
 const result=(ok:boolean,stop:string)=>({ok,stop,steps,confirmed,skipped,receipts});
 const over=()=>io.stopped()||io.tick()-start>=plan.cap;
 while(next&&steps<plan.maximum&&!over()){
  const node=plan.nodes.find(n=>n.id===next)!;steps++;
  if(node.delayTicksBefore){
   const began=io.tick(),delay=node.delayTicksBefore;
   await io.wait(()=>over()||io.tick()-began>=delay,Math.min(delay,plan.cap-(io.tick()-start)));
   if(over()||io.tick()-began<delay)return result(false,'delay interrupted');
  }
  const before=io.read();if(over())return result(false,'budget/stop');
  if(node.condition){
   const eligible=graphCondition(node.condition,before);if(eligible===undefined)return result(false,'condition unknown');
   if(!eligible){skipped++;receipts.push({node:node.id,effect:false,tick:io.tick(),skipped:true});next=node.next;continue;}
  }
  // A false dispatch means no input was sent; a sent input needs an observed effect before any next edge.
  let sent:boolean;try{sent=await io.dispatch(node.action);}catch{receipts.push({node:node.id,effect:false,tick:io.tick()});return result(false,'dispatch uncertain');}
  let effect=false;
  const observed=()=>{
   const after=io.read(),action=node.action;if(!graphEffect(node.effect,before,after))return false;if(action.kind!=='ground-item')return true;
   const ids=new Set([...Object.keys(before.inventory),...Object.keys(after.inventory)].map(Number));
   return[...ids].every(id=>(after.inventory[id]??0)-(before.inventory[id]??0)===(id===action.id?action.count:0));
  };
  if(sent&&!over()){await io.wait(()=>over()||observed(),Math.min(node.timeout,Math.max(1,plan.cap-(io.tick()-start))));effect=!over()&&observed();}
  if(sent&&!effect){receipts.push({node:node.id,effect:false,tick:io.tick()});return result(false,'effect uncertain');}
  if(effect)confirmed++;receipts.push({node:node.id,effect,tick:io.tick()});next=effect?node.next:node.failure;if(!effect&&!node.failure)return result(false,'effect missing');
 }
 return result(!next&&!over()&&confirmed+skipped===steps,next?'budget/stop':'end');
}
export function actionSessionOwner(raw:Session,stop:()=>boolean=()=>false,exists:(path:string)=>boolean=existsSync,options:{allowDamage?:boolean}={}){
 const allowDamage=options.allowDamage===true;
 const client=raw.client as {executeBotAction?:unknown;selfSlot?:number}|undefined,executor=client?.executeBotAction,sdk=raw.sdk,config=sdk.config,origin=JSON.stringify([config?.gatewayUrl,config?.host,config?.port]),p=raw.sdk.getState()?.player,life=p?.lifeId,respawns=p?.respawnCount??0,self=(client as {selfSlot?:number})?.selfSlot,hp0=raw.sdk.getSkill('Hitpoints')?.level??0;let ended=false;void raw.ended.then(()=>{ended=true;});
 const identity=()=>!!client&&raw.client===client&&client.executeBotAction===executor&&client.selfSlot===self&&raw.sdk===sdk&&sdk.config===config&&JSON.stringify([config?.gatewayUrl,config?.host,config?.port])===origin;
 const own=()=>{const now=sdk.getState()?.player,hp=sdk.getSkill('Hitpoints')?.level??0;return(!allowDamage||Number.isFinite(hp0)&&hp0>0&&Number.isFinite(hp)&&hp>0)&&identity()&&!ended&&!!p&&Number.isSafeInteger(life)&&!!client&&typeof executor==='function'&&Number.isSafeInteger(self)&&raw.client===client&&client.executeBotAction===executor&&(client as {selfSlot?:number}).selfSlot===self&&raw.sdk===sdk&&sdk.config===config&&JSON.stringify([config?.gatewayUrl,config?.host,config?.port])===origin&&!!now&&!now.isDead&&now.lifeId===life&&(now.respawnCount??0)===respawns;};
 const stopped=()=>!own()||productionStopRequested(raw.name,stop,exists)||exists('.practice/stop-microbot-actions')||hp0<=0||(!allowDamage&&(sdk.getSkill('Hitpoints')?.level??0)<hp0);
 const view=(cleanup:boolean)=>{const guard=()=>{if(cleanup?!own():stopped())throw Error('action original session/input owner/life/stop unavailable');};const proxy=new Proxy(sdk,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);return typeof v==='function'?function(...args:unknown[]){if(String(key).startsWith('send'))guard();return v.apply(receiver,args);}:v;}}),s=Object.create(raw)as Session;Object.defineProperties(s,{sdk:{value:proxy},bot:{value:new BotActions(proxy)},direct:{value:(a:Parameters<Session['direct']>[0])=>{guard();return raw.direct(a);}}});return s;};
 return{raw,identity,own,stopped,session:view(false),cleanup:view(true),sameLife:()=>{const now=sdk.getState()?.player;return !now||now.lifeId===life&&(now.respawnCount??0)===respawns;}};
}
export async function finishActionSession(owner:ReturnType<typeof actionSessionOwner>|undefined,ok:boolean,detail:string,settle:(sessions:Session[],ok:boolean,detail:string,opts?:{logout?:(raw:Session)=>Promise<string>})=>Promise<unknown>=finish,logout:(session:Session)=>Promise<string>=logoutSession){
 const defer=()=>{console.log('ACTION_SETTLEMENT_DEFERRED '+detail);process.exitCode=1;return{ok:false,recoveryDeferred:true};};
 if(!owner)return settle([],ok,detail);if(!owner.own())return defer();
 try{return await settle([owner.raw],ok,detail,{logout:async raw=>{if(raw!==owner.raw||!owner.own())throw Error('action original settlement owner unavailable');const out=await logout(owner.cleanup);if(out!=='logged-out'||!owner.identity()||!owner.sameLife())throw Error('action owned logout unconfirmed');return out;}});}catch{return defer();}
}
export function sessionGraphIO(raw:Session,stop:()=>boolean){
 const owner=actionSessionOwner(raw,stop),s=owner.session,stopped=owner.stopped;
 const sent=async(promise:Promise<unknown>)=>{const result=await promise;if(!result||(result as {success?:boolean}).success!==true)throw Error('graph action dispatch outcome uncertain');return true;};
 return{tick:()=>s.tick(),stopped,read:():GraphObservation=>{
  const st=s.sdk.getState(),inventory:Record<number,number>={};for(const i of s.sdk.getInventory())inventory[i.id]=(inventory[i.id]??0)+i.count;
  const levels=Object.fromEntries((st?.skills??[]).map(k=>[k.name,k.level]));if(st?.prayers)levels.Prayer=st.prayers.prayerPoints;
  return{inventory,skills:Object.fromEntries((st?.skills??[]).map(k=>[k.name,k.experience])),levels,npcs:st?.nearbyNpcs?.map(n=>({id:n.id,distance:n.distance})),locs:st?.nearbyLocs?.map(l=>({id:l.id,distance:l.distance})),position:st?.player?{x:st.player.worldX,z:st.player.worldZ,level:st.player.level}:null};
 },wait:async(p:()=>boolean,ticks:number)=>await waitUntil(s,p,{timeoutTicks:ticks}),dispatch:async(a:GraphAction)=>{
  if(stopped())return false;const st=s.sdk.getState(),item='id'in a?s.sdk.getInventory().find(i=>i.id===a.id):undefined;
  if(a.kind==='ground-item'){
   if(!st?.player||st.player.level!==a.level)return false;
   const pile=st.groundItems.find(i=>i.id===a.id&&i.x===a.x&&i.z===a.z&&i.count===a.count&&i.reachable!==false&&Number.isFinite(i.distance)&&i.distance<=12);
   const definition=(s.client as {objType?:(id:number)=>{cost:number;stackable:boolean}|undefined}|undefined)?.objType?.(a.id);
   if(!pile||!definition||typeof definition.stackable!=='boolean'||!lootCapacity(st,pile,definition))return false;
   return sent(s.sdk.sendPickup(pile.x,pile.z,pile.id));
  }
  if(a.kind==='walk')return sent(s.direct({type:'walkTo',x:a.x,z:a.z,reason:'finite observed graph'}));
  if(a.kind==='item')return item?sent(s.direct({type:'useInventoryItem',slot:item.slot,optionIndex:a.optionIndex,reason:'finite graph'})):false;
  if(a.kind==='item-on-item'){const target=s.sdk.getInventory().find(i=>i.id===a.target&&i.slot!==item?.slot);return !!item&&!!target&&sent(s.sdk.sendUseItemOnItem(item.slot,target.slot));}
  if(a.kind==='npc'||a.kind==='item-on-npc'){
   const npc=st?.nearbyNpcs.filter(n=>n.id===(a.kind==='npc'?a.id:a.target)&&n.reachable!==false).sort((x,y)=>x.distance-y.distance)[0];if(!npc)return false;
   if(a.kind==='item-on-npc')return !!item&&sent(s.sdk.sendUseItemOnNpc(item.slot,npc.index));
   const option=npc.optionsWithIndex.find(o=>o.text.toLowerCase()===a.option.toLowerCase());return !!option&&sent(s.sdk.sendInteractNpc(npc.index,option.opIndex));
  }
  const loc=st?.nearbyLocs.filter(l=>l.id===(a.kind==='loc'?a.id:a.target)&&l.reachable!==false).sort((x,y)=>x.distance-y.distance)[0];if(!loc)return false;
  if(a.kind==='item-on-loc')return !!item&&sent(s.sdk.sendUseItemOnLoc(item.slot,loc.x,loc.z,loc.id));
  const option=loc.optionsWithIndex.find(o=>o.text.toLowerCase()===a.option.toLowerCase());return !!option&&sent(s.sdk.sendInteractLoc(loc.x,loc.z,loc.id,option.opIndex));
 }};
}
if(import.meta.main){let s:Session|undefined,owner:ReturnType<typeof actionSessionOwner>|undefined,stopped=false;try{const [account,path]=process.argv.slice(2);if(!account||!path)throw Error('account and JSON graph required');const plan=validateActionGraph(JSON.parse(readFileSync(path,'utf8')));s=await openBot(account,{onStop:async()=>{stopped=true;}});owner=actionSessionOwner(s,()=>stopped);const r=await runActionGraph(sessionGraphIO(s,()=>stopped||existsSync('.practice/stop-microbot-actions')),plan);console.log('ACTION_GRAPH_RESULT '+JSON.stringify(r));await finishActionSession(owner,r.ok,JSON.stringify(r));}catch(e){await finishActionSession(owner,false,String(e));}}
