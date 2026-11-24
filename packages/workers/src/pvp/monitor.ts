import {openBot,settle,logoutSession} from '../../../core/src/bot';
import type {Session} from '../../../core/src/inprocess';
import {waitUntil,waitTicks} from '../../../core/src/ticks';
import {loadActionSessionHelpers,type ActionSessionOwnerLike} from './runtime';
import {watchProductionLife} from '../../../core/src/production-life';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT} from './types';
type MonitorTeleportsDoc={wildernessZones:{from:{x:number;z:number;level:number};to:{x:number;z:number;level:number}}[];teleports:{id:string;wildernessMax:{level:number};charges:{id:number;next:string}[];to:{option:string;candidates:{x:number;z:number;level:number}[]}[]}[]};
let cachedTeleportsDoc:MonitorTeleportsDoc|undefined;
function teleportsDoc():MonitorTeleportsDoc{return cachedTeleportsDoc??=JSON.parse(readFileSync(join(REPO_ROOT,'knowledge/teleports.json'),'utf8')) as MonitorTeleportsDoc;}
let cachedNativeItemIds:Map<string,number>|undefined;
function nativeItemIds():Map<string,number>{
 if(cachedNativeItemIds)return cachedNativeItemIds;
 const text=readFileSync(join(REPO_ROOT,'vendor/rs-sdk/server/content/pack/obj.pack'),'utf8');
 const out=new Map<string,number>();
 let pos=0;
 while(pos<text.length){
  let end=text.indexOf('\n',pos);
  if(end<0)end=text.length;
  const lineEnd=end>pos&&text.charCodeAt(end-1)===13?end-1:end;
  const eq=text.indexOf('=',pos);
  if(eq>pos&&eq<lineEnd){const id=Number(text.slice(pos,eq));if(Number.isInteger(id)&&id>=0)out.set(text.slice(eq+1,lineEnd),id);}
  pos=end+1;
 }
 cachedNativeItemIds=out;
 return out;
}
export function monitorStopRequested(name:string|undefined,stop:()=>boolean,fileExists:(path:string)=>boolean=existsSync,roleStop:string|undefined=process.env.STOP_FILE){
 return stop()||fileExists('.practice/stop-all')||!!name&&fileExists(`.practice/stop-${name}`)||!!roleStop&&fileExists(roleStop);
}
export type MonitorItemAction={id?:number;name?:string;option:string;expectedDelta:Record<number,number>;teleport?:{destination:'Edgeville'|'Karamja'|'Draynor Village'|'Al Kharid'}};
export type MonitorPolicy={radius:number;ignore:readonly string[];onlyNew:boolean;action:'stop'|'logout'|'item';itemAction?:MonitorItemAction;wildernessOnly?:boolean};
// The knowledge generator parses the native wilderness_zones coord-pair table.
export function monitorWildernessLevel(p:{worldX:number;worldZ:number;level:number}|undefined){
 if(!p||![p.worldX,p.worldZ,p.level].every(Number.isSafeInteger)||p.worldX<0||p.worldZ<0||p.level<0||p.level>3)return undefined;
 for(const {from:a,to:b} of teleportsDoc().wildernessZones)if(p.worldX>=a.x&&p.worldX<=b.x&&p.worldZ>=a.z&&p.worldZ<=b.z&&p.level>=a.level&&p.level<=b.level)return Math.trunc((p.worldZ-a.z)/8)+1;
 return 0;
}
const inventoryStock=(s:Session)=>{const out:Record<number,number>={};for(const i of s.sdk.getState()?.inventory??[])out[i.id]=(out[i.id]??0)+i.count;return out;};
export function monitorGloryProfile(destination:string,id:number){
 const glory=teleportsDoc().teleports.find(t=>t.id==='jewellery:amulet_of_glory');
 const charge=glory?.charges.find(c=>c.id===id),landing=glory?.to.find(t=>t.option===destination),next=charge&&nativeItemIds().get(charge.next);
 if(!charge||next===undefined||!landing||landing.candidates.length!==1||glory?.wildernessMax.level!==30)throw Error('unsupported monitor Glory teleport');
 return{id,next,destination,to:landing.candidates[0]!,maximumWilderness:30};
}
async function useMonitorGlory(s:Session,a:MonitorItemAction,deadline:number,unsafe:()=>boolean){
 const result={attempted:false,confirmed:false,id:-1,slot:-1,opIndex:-1,openingAttempts:0,destinationAttempts:0,detail:''};
 try{
  const st=s.sdk.getState(),client=s.client as {membersAccount?:number;executeBotAction?:unknown}|undefined,executor=client?.executeBotAction;
  if(!st?.player||!Number.isSafeInteger(st.player.lifeId)||client?.membersAccount!==1||typeof executor!=='function'||deadline-s.tick()<12||st.dialog?.isOpen||st.interface?.isOpen||st.bank?.isOpen)throw Error('monitor teleport entry unavailable');
  const rows=st.inventory.filter(i=>(a.id===undefined||i.id===a.id)&&(a.name===undefined||i.name.toLowerCase()===a.name.toLowerCase())).sort((x,y)=>x.slot-y.slot);
  if(!rows.length||rows.some(i=>i.id!==rows[0]!.id||i.count!==1||!Number.isSafeInteger(i.slot)||i.slot<0||i.slot>27)||new Set(rows.map(i=>i.slot)).size!==rows.length||a.option.toLowerCase()!=='rub')throw Error('monitor teleport item missing or ambiguous');
  const row=rows[0]!,profile=monitorGloryProfile(a.teleport!.destination,row.id),wild=monitorWildernessLevel(st.player),rub=row.optionsWithIndex.filter(o=>o.text.toLowerCase()==='rub'&&o.opIndex===4);
  const delta:Record<number,number>={[profile.id]:-1,[profile.next]:1};
  if(wild===undefined||wild>profile.maximumWilderness||rub.length!==1||JSON.stringify(Object.entries(a.expectedDelta).sort())!==JSON.stringify(Object.entries(delta).sort()))throw Error('monitor teleport charge, wilderness or option mismatch');
  const before=inventoryStock(s),began=s.tick(),life=st.player.lifeId,respawns=st.player.respawnCount??0;
  const xp=()=>JSON.stringify(s.sdk.getState()?.skills.map(k=>({name:k.name,xp:k.experience}))),kit=()=>JSON.stringify(s.sdk.getState()?.equipment.map(i=>({id:i.id,count:i.count,slot:i.slot})).sort((x,y)=>x.slot-y.slot));
  if(!st.skills?.length||!Array.isArray(st.equipment))throw Error('monitor teleport XP/kit unobserved');
  const originalXp=xp(),originalKit=kit(),position={x:st.player.worldX,z:st.player.worldZ,level:st.player.level},pack=()=>JSON.stringify((s.sdk.getState()?.inventory??[]).map(i=>[i.slot,i.id,i.count]).sort((a,b)=>a[0]!-b[0]!)),originalPack=pack();
  const valid=()=>{const p=s.sdk.getState()?.player,age=s.sdk.getStateAge();return !unsafe()&&s.tick()<deadline&&s.client===client&&client.executeBotAction===executor&&Number.isFinite(age)&&age>=0&&age<=5000&&p?.lifeId===life&&(p.respawnCount??0)===respawns&&xp()===originalXp&&kit()===originalKit;};
  const paid=()=>{const after=inventoryStock(s),p=s.sdk.getState()?.player,ids=new Set([...Object.keys(before),...Object.keys(after),...Object.keys(delta)]);return s.tick()>began&&p?.level===profile.to.level&&p.worldX===profile.to.x&&p.worldZ===profile.to.z&&[...ids].every(id=>(after[Number(id)]??0)-(before[Number(id)]??0)===(delta[Number(id)]??0));};
  let chosen=false,ackPublicTick:number|undefined,missingTicks=new Set<number>();const pages=new Set<string>();
  const unspent=()=>{const now=s.sdk.getState(),p=now?.player;return valid()&&!!p&&pack()===originalPack&&p.worldX===position.x&&p.worldZ===position.z&&p.level===position.level&&now?.interface?.isOpen===false&&now.bank?.isOpen===false;};
  // Native amulet_of_glory.rs2 charges only after the destination branch, never on Rub.
  const open=async()=>{if(chosen||result.destinationAttempts||!unspent()||deadline-s.tick()<12||result.openingAttempts>=4)throw Error('monitor teleport safe Rub reopening unavailable');Object.assign(result,{attempted:true,id:row.id,slot:row.slot,opIndex:4});result.openingAttempts++;if(!(await s.sdk.sendUseItem(row.slot,4)).success)throw Error('monitor teleport Rub refused or unknown; no retry');const tick=s.sdk.getState()?.tick;ackPublicTick=Number.isSafeInteger(tick)?tick:undefined;missingTicks=new Set();pages.clear();};
  await open();
  while(valid()&&!paid()){
   await waitTicks(s,1);if(!valid())break;if(paid())break;
   if(!chosen){const p=s.sdk.getState()?.player;if(!p||pack()!==originalPack||p.worldX!==position.x||p.worldZ!==position.z||p.level!==position.level)throw Error('monitor teleport pre-choice whole pack/position changed');}const d=s.sdk.getDialog();if(!d?.isOpen){if(chosen||result.destinationAttempts)continue;const tick=s.sdk.getState()?.tick;if(typeof tick==='number'&&Number.isSafeInteger(tick)&&ackPublicTick!==undefined&&tick>ackPublicTick)missingTicks.add(tick);if(missingTicks.size>=2){if(!unspent()||d?.isWaiting===true)throw Error('monitor teleport no-menu opening is not known unspent');if(deadline-s.tick()<12)throw Error('monitor teleport no reopening time');if(result.openingAttempts>=4)throw Error('monitor teleport four safe Rub openings exhausted');await open();}continue;}missingTicks.clear();if(d.isWaiting)continue;
   const page=JSON.stringify(d);if(pages.has(page))continue;
   const normalize=(text:string)=>text.trim().toLowerCase().replace(/[.!?]+$/,'');
   const options=d.options.filter(o=>normalize(o.text)===normalize(profile.destination));
   const continuation=d.options.length===1&&/^(?:click here to )?continue[.!]?$/i.test(d.options[0]!.text.trim());
   if(chosen)continue;
   if(options.length!==1&&!continuation)throw Error('monitor teleport unknown dialogue; no guessed input');
   if(pages.size>=3)throw Error('monitor teleport dialogue budget');
   const option=options.length===1?options[0]!:d.options[0]!;if(!Number.isSafeInteger(option.index)||option.index<0)throw Error('monitor teleport dialogue index unknown');
   pages.add(page);
   if(!valid())break;if(options.length===1){chosen=true;result.destinationAttempts++;}if(!(await s.sdk.sendClickDialog(option.index)).success)throw Error('monitor teleport dialogue refused; no retry');
  }
  if(!valid()||!chosen||!paid())throw Error('monitor teleport charge/landing unconfirmed; no retry');
  result.confirmed=true;
 }catch(error){result.detail=String(error);}
 return result;
}
async function useMonitorItem(s:Session,a:MonitorItemAction,deadline:number,unsafe:()=>boolean){
 if(a.teleport)return useMonitorGlory(s,a,deadline,unsafe);
 const result={attempted:false,confirmed:false,id:-1,slot:-1,opIndex:-1,detail:''};
 try{
  const st=s.sdk.getState();if(unsafe()||s.tick()>=deadline||!st?.player||st.player.lifeId===undefined||!Number.isSafeInteger(st.player.level)||st.player.isDead||st.dialog?.isOpen||st.interface?.isOpen||st.bank?.isOpen)throw Error('monitor item state unsafe');
  const rows=st.inventory.filter(i=>(a.id===undefined||i.id===a.id)&&(a.name===undefined||i.name.toLowerCase()===a.name.toLowerCase()));
  if(rows.length!==1)throw Error('monitor item missing or ambiguous');const row=rows[0]!,options=row.optionsWithIndex.filter(o=>o.text.toLowerCase()===a.option.toLowerCase());
  if(options.length!==1||!Number.isSafeInteger(options[0]!.opIndex)||options[0]!.opIndex<1||options[0]!.opIndex>5)throw Error('monitor item option unknown or ambiguous');
  const before=inventoryStock(s),at=s.tick(),plane=st.player.level;
  if(!(a.expectedDelta[row.id]<0)||Object.entries(a.expectedDelta).some(([id,n])=>(before[Number(id)]??0)+n<0))throw Error('monitor item receipt must debit the selected owned item');
  Object.assign(result,{attempted:true,id:row.id,slot:row.slot,opIndex:options[0]!.opIndex});
  const sent=await s.sdk.sendUseItem(row.slot,options[0]!.opIndex);if(!sent.success)throw Error('monitor item input refused: '+sent.message);
  const confirmed=()=>{const after=inventoryStock(s),ids=new Set([...Object.keys(before),...Object.keys(after),...Object.keys(a.expectedDelta)]);return s.tick()>at&&[...ids].every(id=>(after[Number(id)]??0)-(before[Number(id)]??0)===(a.expectedDelta[Number(id)]??0));};
  const invalid=()=>unsafe()||s.sdk.getState()?.player?.level!==plane;
  if(!await waitUntil(s,()=>invalid()||confirmed(),{timeoutTicks:Math.max(1,Math.min(8,deadline-s.tick()))})||invalid()||!confirmed())throw Error('monitor item effect unconfirmed; input will not repeat');
  result.confirmed=true;
 }catch(error){result.detail=String(error);}
 return result;
}
type Player={name:string;distance:number;index:number};
export function monitoredPlayer(players:readonly Player[],policy:MonitorPolicy,baseline:ReadonlySet<string>):Player|undefined{
 const ignored=new Set(policy.ignore.map(n=>n.toLowerCase()));
 return players.find(p=>Number.isFinite(p.distance)&&p.distance<=policy.radius&&!ignored.has(p.name.toLowerCase())&&(!policy.onlyNew||!baseline.has(p.name.toLowerCase())));
}
export function validateMonitorPolicy(policy:MonitorPolicy,cap:number){
 if(!Number.isSafeInteger(cap)||cap<1||!Number.isFinite(policy.radius)||policy.radius<0||!['stop','logout','item'].includes(policy.action)||policy.wildernessOnly!==undefined&&typeof policy.wildernessOnly!=='boolean')throw Error('invalid player monitor');
 if(policy.action==='item'){const a=policy.itemAction;if(!a||(a.id===undefined&&a.name===undefined)||(a.id!==undefined&&(!Number.isSafeInteger(a.id)||a.id<0))||(a.name!==undefined&&!a.name.trim())||!a.option?.trim()||!a.expectedDelta||!Object.keys(a.expectedDelta).length||Object.entries(a.expectedDelta).some(([id,n])=>!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||!Number.isSafeInteger(n)||n===0))throw Error('invalid monitor item order');}
 const a=policy.itemAction;if(a?.teleport!==undefined){
  if(policy.action!=='item'||!a.teleport||!['Edgeville','Karamja','Draynor Village','Al Kharid'].includes(a.teleport.destination)||a.option.toLowerCase()!=='rub')throw Error('invalid monitor teleport profile');
  if(a.id!==undefined){const profile=monitorGloryProfile(a.teleport.destination,a.id),delta={[profile.id]:-1,[profile.next]:1};if(JSON.stringify(Object.entries(a.expectedDelta).sort())!==JSON.stringify(Object.entries(delta).sort()))throw Error('monitor teleport charge receipt mismatch');}
 }
}
// The monitor owns a finite session. Glory escape uses one Rub and checked menu
// choices; its charge and exact landing must both reconcile before acceptance.
export async function monitorPlayers(raw:Session,policy:MonitorPolicy,cap:number,stop:()=>boolean=()=>false,fileExists:(path:string)=>boolean=existsSync){
 validateMonitorPolicy(policy,cap);
 const {actionSessionOwner,finishActionSession}=await loadActionSessionHelpers();
 const start=raw.tick(),allowDamage=policy.action==='item'&&!!policy.itemAction?.teleport,owner=actionSessionOwner(raw,()=>monitorStopRequested(raw.name,stop,fileExists)||allowDamage&&(raw.tick()-start>=cap||!Number.isFinite(raw.sdk.getStateAge())||raw.sdk.getStateAge()<0||raw.sdk.getStateAge()>5000),path=>path!=='.practice/stop-microbot-actions'&&fileExists(path),{allowDamage}),s=owner.session;
 const life=watchProductionLife(s,()=>!owner.own()||monitorStopRequested(s.name,stop,fileExists),{allowDamage}),players=()=>s.sdk.getState()?.nearbyPlayers??[],baseline=new Set(players().map(p=>p.name.toLowerCase()));
 let trigger:Player|undefined,filterFailure='';
 const inScope=()=>{if(!policy.wildernessOnly)return true;const level=monitorWildernessLevel(s.sdk.getState()?.player??undefined);if(level===undefined)filterFailure='native wilderness position unknown';return level!==undefined&&level>0;};
 await waitUntil(s,()=>{trigger=inScope()?monitoredPlayer(players(),policy,baseline):undefined;return !!trigger||!!filterFailure||life.stopped()||s.tick()-start>=cap;},{timeoutTicks:cap});
 const reason=(!owner.own()?'original client/input owner/life changed':'')||life.reason()||filterFailure||(trigger&&!inScope()?'wilderness trigger no longer in scope':'');let logout='';
 if(trigger&&policy.action==='logout'&&!reason){let observed='';const settled=await finishActionSession(owner,true,'finite monitor policy logout',settle,async (cleanup:Session)=>{observed=await logoutSession(cleanup);return observed;});logout=settled===true&&observed==='logged-out'?'logged-out':'error guarded policy settlement unconfirmed';}
 const item=trigger&&policy.action==='item'&&!reason?await useMonitorItem(s,policy.itemAction!,start+cap,()=>life.stopped()||!policy.itemAction?.teleport&&!inScope()):undefined;
 const failedLogout=!!logout&&(logout==='timeout'||logout.startsWith('error '));
 return{ok:!reason&&!failedLogout&&(!item||item.confirmed),trigger:trigger?{name:trigger.name,index:trigger.index,distance:trigger.distance}:null,action:trigger?policy.action:'none',logout,item,ticks:s.tick()-start,detail:reason||item?.detail|| (failedLogout?'player policy logout unconfirmed':trigger?'player policy triggered':'finite monitor budget complete')};
}
export async function settleMonitorSession(owner:ActionSessionOwnerLike,ok:boolean,detail:string,settler:(sessions:Session[],ok:boolean,detail:string,opts?:{logout?:(raw:Session)=>Promise<string>})=>Promise<unknown>=settle,logout:(session:Session)=>Promise<string>=logoutSession){
 const {finishActionSession}=await loadActionSessionHelpers();
 if(owner.own())return finishActionSession(owner,ok,detail,settler,logout);
 const end=await Promise.race([owner.raw.ended,Promise.resolve({reason:''})]);if(end.reason==='logged-out'){owner.settled();if(owner.identity()&&owner.sameLife())return settler([owner.raw],ok,detail);}
 return finishActionSession(owner,false,detail,settler,logout);
}
export async function runMonitorCli(args: readonly string[], existingSession?: Session): Promise<number> {
 const name=args[0]??'',cap=Number(args[1]??100),radius=Number(args[2]??12),action=args[3]??'logout';
 if(!name||!Number.isSafeInteger(cap)||cap<1||!Number.isFinite(radius)||radius<0||!['stop','logout','item'].includes(action))throw Error('Usage: bun scripts/microbot-c-player-monitor.ts <account> [ticks] [radius] [stop|logout|item] [item-action JSON] [wilderness-only true|false]');
 const itemAction=action==='item'?JSON.parse(args[4]??'null') as MonitorItemAction:undefined;
 const wilderness=args[5]??'false';if(!['true','false'].includes(wilderness))throw Error('wilderness-only must be true or false');
 const policy:MonitorPolicy={radius,ignore:[name],onlyNew:false,action:action as MonitorPolicy['action'],itemAction,wildernessOnly:wilderness==='true'};validateMonitorPolicy(policy,cap);
 let stopped=false;
 if(existingSession){
  const r=await monitorPlayers(existingSession,policy,cap,()=>stopped);
  console.log('PLAYER_MONITOR_RESULT '+JSON.stringify(r));
  return r.ok?0:1;
 }
 process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const {actionSessionOwner}=await loadActionSessionHelpers();
 const s=await openBot(name,{onStop:async()=>{stopped=true;}}),owner=actionSessionOwner(s,()=>stopped,existsSync,{allowDamage:policy.action==='item'&&!!policy.itemAction?.teleport});let ok=false;
 try{const r=await monitorPlayers(s,policy,cap,()=>stopped);console.log('PLAYER_MONITOR_RESULT '+JSON.stringify(r));ok=r.ok;}
 finally{ok=(await settleMonitorSession(owner,ok,'finite player monitor'))===true;}
 return ok?0:1;
}
