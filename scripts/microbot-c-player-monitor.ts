import {openBot,settle,logoutSession} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {watchProductionLife} from './microbot-c-lifetime';
export type MonitorPolicy={radius:number;ignore:readonly string[];onlyNew:boolean;action:'stop'|'logout'};
type Player={name:string;distance:number;index:number};
export function monitoredPlayer(players:readonly Player[],policy:MonitorPolicy,baseline:ReadonlySet<string>):Player|undefined{
 const ignored=new Set(policy.ignore.map(n=>n.toLowerCase()));
 return players.find(p=>Number.isFinite(p.distance)&&p.distance<=policy.radius&&!ignored.has(p.name.toLowerCase())&&(!policy.onlyNew||!baseline.has(p.name.toLowerCase())));
}
// The monitor owns this finite session. It cannot hop worlds, restart jobs or
// transfer control. A trigger returns a stop result or requests native logout.
export async function monitorPlayers(s:Session,policy:MonitorPolicy,cap:number,stop:()=>boolean=()=>false){
 if(!Number.isSafeInteger(cap)||cap<1||!Number.isFinite(policy.radius)||policy.radius<0||!['stop','logout'].includes(policy.action))throw Error('invalid player monitor');
 const life=watchProductionLife(s,stop),start=s.tick(),players=()=>s.sdk.getState()?.nearbyPlayers??[],baseline=new Set(players().map(p=>p.name.toLowerCase()));
 let trigger:Player|undefined;
 await waitUntil(s,()=>{trigger=monitoredPlayer(players(),policy,baseline);return !!trigger||life.stopped()||s.tick()-start>=cap;},{timeoutTicks:cap});
 const reason=life.reason();let logout='';
 if(trigger&&policy.action==='logout'&&!reason)logout=await logoutSession(s);
 const failedLogout=!!logout&&(logout==='timeout'||logout.startsWith('error '));
 return{ok:!reason&&!failedLogout,trigger:trigger?{name:trigger.name,index:trigger.index,distance:trigger.distance}:null,action:trigger?policy.action:'none',logout,ticks:s.tick()-start,detail:reason|| (failedLogout?'player policy logout unconfirmed':trigger?'player policy triggered':'finite monitor budget complete')};
}
if(import.meta.main){
 const name=process.argv[2]??'',cap=Number(process.argv[3]??100),radius=Number(process.argv[4]??12),action=process.argv[5]??'logout';
 if(!name||!Number.isSafeInteger(cap)||cap<1||!Number.isFinite(radius)||radius<0||!['stop','logout'].includes(action))throw Error('Usage: bun scripts/microbot-c-player-monitor.ts <account> [ticks] [radius] [stop|logout]');
 let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
 const s=await openBot(name);let ok=false;
 try{const r=await monitorPlayers(s,{radius,ignore:[name],onlyNew:false,action:action as 'stop'|'logout'},cap,()=>stopped);console.log('PLAYER_MONITOR_RESULT '+JSON.stringify(r));ok=r.ok;}
 finally{ok=await settle([s],ok,'finite player monitor');}process.exitCode=ok?0:1;
}
