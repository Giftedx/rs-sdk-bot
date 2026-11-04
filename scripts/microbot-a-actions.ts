// Behaviour source: pinned Microbot-Hub; BSD notice: research/microbot-ports-LICENSE.txt.
// Finite JSON action graphs, never JavaScript evaluation: bun scripts/microbot-a-actions.ts <account> <plan.json>.
// Nodes resolve observed item/NPC/loc IDs; effects are relative inventory/XP or an observed destination.
import {readFileSync,existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
export type GraphEffect={kind:'inventory';id:number;delta:number}|{kind:'xp';skill:string;minimum:number}|{kind:'position';x:number;z:number;level:number;tolerance:number};
export type GraphAction={kind:'npc';id:number;option:string}|{kind:'loc';id:number;option:string}|{kind:'item';id:number;optionIndex:number}|{kind:'item-on-item';id:number;target:number}|{kind:'item-on-npc';id:number;target:number}|{kind:'item-on-loc';id:number;target:number}|{kind:'walk';x:number;z:number};
export interface ActionNode{id:string;action:GraphAction;effect:GraphEffect;timeout:number;next?:string;failure?:string}
export interface ActionGraph{start:string;maximum:number;cap:number;nodes:ActionNode[]}
export interface GraphObservation{inventory:Record<number,number>;skills:Record<string,number>;position:{x:number;z:number;level:number}|null}
export function validateActionGraph(plan:ActionGraph){
 if(!plan||!Number.isSafeInteger(plan.maximum)||plan.maximum<1||plan.maximum>1000||!Number.isSafeInteger(plan.cap)||plan.cap<1||plan.cap>100000||!Array.isArray(plan.nodes)||plan.nodes.length<1||plan.nodes.length>1000)throw Error('invalid finite action graph');
 const ids=new Set(plan.nodes.map(n=>n.id));if(ids.size!==plan.nodes.length||!ids.has(plan.start))throw Error('graph node IDs/start');
 const integer=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 for(const n of plan.nodes){
  if(!/^[a-z0-9_-]{1,64}$/i.test(n.id)||n.next&&!ids.has(n.next)||n.failure&&!ids.has(n.failure)||!Number.isSafeInteger(n.timeout)||n.timeout<1||n.timeout>100)throw Error('invalid graph edge/timeout');
  const a=n.action;if(!a||!['npc','loc','item','item-on-item','item-on-npc','item-on-loc','walk'].includes(a.kind))throw Error('unsupported graph action');
  if(a.kind==='walk'){if(!integer(a.x)||!integer(a.z))throw Error('invalid graph tile');}
  else{if(!integer(a.id))throw Error('invalid graph item/target ID');if('target'in a&&!integer(a.target))throw Error('invalid graph target ID');if('option'in a&&(!a.option||a.option.length>64))throw Error('invalid graph option');if('optionIndex'in a&&(!Number.isSafeInteger(a.optionIndex)||a.optionIndex<1||a.optionIndex>5))throw Error('invalid graph inventory option');}
  const e=n.effect;if(!e||!['inventory','xp','position'].includes(e.kind))throw Error('missing graph effect');
  if(e.kind==='inventory'&&(!integer(e.id)||!Number.isSafeInteger(e.delta)||e.delta===0))throw Error('invalid graph inventory effect');
  if(e.kind==='xp'&&(!/^[A-Za-z ]{1,24}$/.test(e.skill)||!Number.isFinite(e.minimum)||e.minimum<=0))throw Error('invalid graph XP effect');
  if(e.kind==='position'&&(![e.x,e.z,e.level,e.tolerance].every(integer)||e.level>3||e.tolerance>10))throw Error('invalid graph position effect');
 }
 return plan;
}
export function graphEffect(e:GraphEffect,b:GraphObservation,a:GraphObservation){
 if(e.kind==='inventory')return(a.inventory[e.id]??0)-(b.inventory[e.id]??0)===e.delta;
 if(e.kind==='xp')return(a.skills[e.skill]??0)-(b.skills[e.skill]??0)>=e.minimum;
 return !!a.position&&a.position.level===e.level&&Math.max(Math.abs(a.position.x-e.x),Math.abs(a.position.z-e.z))<=e.tolerance;
}
export async function runActionGraph(io:{tick():number;stopped():boolean;read():GraphObservation;dispatch(a:GraphAction):Promise<boolean>;wait(p:()=>boolean,ticks:number):Promise<boolean>},plan:ActionGraph){
 validateActionGraph(plan);const start=io.tick();let next:string|undefined=plan.start,steps=0,confirmed=0;const receipts:{node:string;effect:boolean;tick:number}[]=[];
 const over=()=>io.stopped()||io.tick()-start>=plan.cap;
 while(next&&steps<plan.maximum&&!over()){
  const node=plan.nodes.find(n=>n.id===next)!,before=io.read();steps++;
  const sent=await io.dispatch(node.action);let effect=false;
  if(sent&&!over()){await io.wait(()=>over()||graphEffect(node.effect,before,io.read()),Math.min(node.timeout,Math.max(1,plan.cap-(io.tick()-start))));effect=!over()&&graphEffect(node.effect,before,io.read());}
  if(effect)confirmed++;receipts.push({node:node.id,effect,tick:io.tick()});next=effect?node.next:node.failure;if(!effect&&!node.failure)return{ok:false,stop:'effect missing',steps,confirmed,receipts};
 }
 return{ok:!next&&!over()&&confirmed===steps,stop:next?'budget/stop':'end',steps,confirmed,receipts};
}
export function sessionGraphIO(s:Session,stop:()=>boolean){
 let ended=false;void s.ended.then(()=>{ended=true;});const p0=s.sdk.getState()?.player,hp0=s.sdk.getSkill('Hitpoints')?.level??0;
 const stopped=()=>{const p=s.sdk.getState()?.player;return ended||stop()||hp0<=0||!p0||!p||p.isDead||p.lifeId!==p0.lifeId||(s.sdk.getSkill('Hitpoints')?.level??0)<hp0;};
 return{tick:()=>s.tick(),stopped,read:():GraphObservation=>{const st=s.sdk.getState(),inventory:Record<number,number>={};for(const i of s.sdk.getInventory())inventory[i.id]=(inventory[i.id]??0)+i.count;return{inventory,skills:Object.fromEntries((st?.skills??[]).map(k=>[k.name,k.experience])),position:st?.player?{x:st.player.worldX,z:st.player.worldZ,level:st.player.level}:null};},wait:async(p:()=>boolean,ticks:number)=>await waitUntil(s,p,{timeoutTicks:ticks}),dispatch:async(a:GraphAction)=>{
  if(stopped())return false;const st=s.sdk.getState(),item='id'in a?s.sdk.getInventory().find(i=>i.id===a.id):undefined;
  if(a.kind==='walk'){const result=await s.direct({type:'walk',x:a.x,z:a.z,reason:'finite observed graph'});return(result as any)?.success!==false;}
  if(a.kind==='item')return item?((await s.direct({type:'useInventoryItem',slot:item.slot,optionIndex:a.optionIndex,reason:'finite graph'})) as any)?.success!==false:false;
  if(a.kind==='item-on-item'){const target=s.sdk.getInventory().find(i=>i.id===a.target&&i.slot!==item?.slot);return !!item&&!!target&&(await s.sdk.sendUseItemOnItem(item.slot,target.slot)).success;}
  if(a.kind==='npc'||a.kind==='item-on-npc'){
   const npc=st?.nearbyNpcs.filter(n=>n.id===(a.kind==='npc'?a.id:a.target)&&n.reachable!==false).sort((x,y)=>x.distance-y.distance)[0];if(!npc)return false;
   if(a.kind==='item-on-npc')return !!item&&(await s.sdk.sendUseItemOnNpc(item.slot,npc.index)).success;
   const option=npc.optionsWithIndex.find(o=>o.text.toLowerCase()===a.option.toLowerCase());return !!option&&(await s.sdk.sendInteractNpc(npc.index,option.opIndex)).success;
  }
  const loc=st?.nearbyLocs.filter(l=>l.id===(a.kind==='loc'?a.id:a.target)&&l.reachable!==false).sort((x,y)=>x.distance-y.distance)[0];if(!loc)return false;
  if(a.kind==='item-on-loc')return !!item&&(await s.sdk.sendUseItemOnLoc(item.slot,loc.x,loc.z,loc.id)).success;
  const option=loc.optionsWithIndex.find(o=>o.text.toLowerCase()===a.option.toLowerCase());return !!option&&(await s.sdk.sendInteractLoc(loc.x,loc.z,loc.id,option.opIndex)).success;
 }};
}
if(import.meta.main){let s:Session|undefined,stopped=false;try{const [account,path]=process.argv.slice(2);if(!account||!path)throw Error('account and JSON graph required');const plan=validateActionGraph(JSON.parse(readFileSync(path,'utf8')));s=await openBot(account,{onStop:async()=>{stopped=true;}});const r=await runActionGraph(sessionGraphIO(s,()=>stopped||existsSync('.practice/stop-microbot-actions')),plan);console.log('ACTION_GRAPH_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){await finish(s?[s]:[],false,String(e));}}
