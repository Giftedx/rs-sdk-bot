import {openBot,settle,logoutSession} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
import {wildernessZones} from '../knowledge/teleports.json';
import {existsSync} from 'node:fs';
export function monitorStopRequested(name:string|undefined,stop:()=>boolean,fileExists:(path:string)=>boolean=existsSync,roleStop:string|undefined=process.env.STOP_FILE){
 return stop()||fileExists('.practice/stop-all')||!!name&&fileExists(`.practice/stop-${name}`)||!!roleStop&&fileExists(roleStop);
}
export type MonitorItemAction={id?:number;name?:string;option:string;expectedDelta:Record<number,number>};
export type MonitorPolicy={radius:number;ignore:readonly string[];onlyNew:boolean;action:'stop'|'logout'|'item';itemAction?:MonitorItemAction;wildernessOnly?:boolean};
// The knowledge generator parses the native wilderness_zones coord-pair table.
export function monitorWildernessLevel(p:{worldX:number;worldZ:number;level:number}|undefined){
 if(!p||![p.worldX,p.worldZ,p.level].every(Number.isSafeInteger)||p.worldX<0||p.worldZ<0||p.level<0||p.level>3)return undefined;
 for(const {from:a,to:b} of wildernessZones)if(p.worldX>=a.x&&p.worldX<=b.x&&p.worldZ>=a.z&&p.worldZ<=b.z&&p.level>=a.level&&p.level<=b.level)return Math.trunc((p.worldZ-a.z)/8)+1;
 return 0;
}
const inventoryStock=(s:Session)=>{const out:Record<number,number>={};for(const i of s.sdk.getState()?.inventory??[])out[i.id]=(out[i.id]??0)+i.count;return out;};
async function useMonitorItem(s:Session,a:MonitorItemAction,deadline:number,unsafe:()=>boolean){
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
// The monitor owns this finite session. It cannot hop worlds, restart jobs or
// transfer control. One item input requires an explicit inventory effect; it
// never guesses a follow-up dialogue or retries an uncertain paid action.
export async function monitorPlayers(s:Session,policy:MonitorPolicy,cap:number,stop:()=>boolean=()=>false,fileExists:(path:string)=>boolean=existsSync){
 if(!Number.isSafeInteger(cap)||cap<1||!Number.isFinite(policy.radius)||policy.radius<0||!['stop','logout','item'].includes(policy.action)||policy.wildernessOnly!==undefined&&typeof policy.wildernessOnly!=='boolean')throw Error('invalid player monitor');
 if(policy.action==='item'){const a=policy.itemAction;if(!a||(a.id===undefined&&a.name===undefined)||(a.id!==undefined&&(!Number.isSafeInteger(a.id)||a.id<0))||(a.name!==undefined&&!a.name.trim())||!a.option?.trim()||!a.expectedDelta||!Object.keys(a.expectedDelta).length||Object.entries(a.expectedDelta).some(([id,n])=>!/^\d+$/.test(id)||!Number.isSafeInteger(Number(id))||!Number.isSafeInteger(n)||n===0))throw Error('invalid monitor item order');}
 const life=watchProductionLife(s,()=>monitorStopRequested(s.name,stop,fileExists)),start=s.tick(),players=()=>s.sdk.getState()?.nearbyPlayers??[],baseline=new Set(players().map(p=>p.name.toLowerCase()));
 let trigger:Player|undefined,filterFailure='';
 const inScope=()=>{if(!policy.wildernessOnly)return true;const level=monitorWildernessLevel(s.sdk.getState()?.player??undefined);if(level===undefined)filterFailure='native wilderness position unknown';return level!==undefined&&level>0;};
 await waitUntil(s,()=>{trigger=inScope()?monitoredPlayer(players(),policy,baseline):undefined;return !!trigger||!!filterFailure||life.stopped()||s.tick()-start>=cap;},{timeoutTicks:cap});
 const reason=life.reason()||filterFailure||(trigger&&!inScope()?'wilderness trigger no longer in scope':'');let logout='';
 if(trigger&&policy.action==='logout'&&!reason)logout=await logoutSession(s);
 const item=trigger&&policy.action==='item'&&!reason?await useMonitorItem(s,policy.itemAction!,start+cap,()=>life.stopped()||!inScope()):undefined;
 const failedLogout=!!logout&&(logout==='timeout'||logout.startsWith('error '));
 return{ok:!reason&&!failedLogout&&(!item||item.confirmed),trigger:trigger?{name:trigger.name,index:trigger.index,distance:trigger.distance}:null,action:trigger?policy.action:'none',logout,item,ticks:s.tick()-start,detail:reason||item?.detail|| (failedLogout?'player policy logout unconfirmed':trigger?'player policy triggered':'finite monitor budget complete')};
}
if(import.meta.main){
 const name=process.argv[2]??'',cap=Number(process.argv[3]??100),radius=Number(process.argv[4]??12),action=process.argv[5]??'logout';
 if(!name||!Number.isSafeInteger(cap)||cap<1||!Number.isFinite(radius)||radius<0||!['stop','logout','item'].includes(action))throw Error('Usage: bun scripts/microbot-c-player-monitor.ts <account> [ticks] [radius] [stop|logout|item] [item-action JSON] [wilderness-only true|false]');
 const itemAction=action==='item'?JSON.parse(process.argv[6]??'null') as MonitorItemAction:undefined;
 const wilderness=process.argv[7]??'false';if(!['true','false'].includes(wilderness))throw Error('wilderness-only must be true or false');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const s=await openBot(name);let ok=false;
 try{const r=await monitorPlayers(s,{radius,ignore:[name],onlyNew:false,action:action as MonitorPolicy['action'],itemAction,wildernessOnly:wilderness==='true'},cap,()=>stopped);console.log('PLAYER_MONITOR_RESULT '+JSON.stringify(r));ok=r.ok;}
 finally{ok=await settle([s],ok,'finite player monitor');}process.exitCode=ok?0:1;
}
