import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {swarmWroteStop} from '../../../../scripts/swarm';
import {MAX_SPECIALIST_RUN_MS} from '../../../core/src/specialist-launch';
import type {CoordTask} from '../coordinator';
import {projectRoot} from '../coordinator-store';

// A controller that wrote .practice/swarm-state.json under this pid and nonce within this window is the saved
// controller: no PowerShell command-line probe is needed while its pid is alive.
export const CONTROLLER_STATE_FRESH_MS=10_000;
export function readFreshControllerState(owner:{pid:number;nonce:string},base=projectRoot,now=Date.now()){
 try{const s=JSON.parse(readFileSync(join(base,'.practice/swarm-state.json'),'utf8'));
  return s.controllerPid===owner.pid&&s.coordinatorOwner===owner.nonce&&Number.isFinite(s.at)&&now-s.at>=0&&now-s.at<CONTROLLER_STATE_FRESH_MS?s:null;}
 catch{return null;}
}
export function controllerStateFresh(owner:{pid:number;nonce:string},base=projectRoot,now=Date.now()):boolean{
 return readFreshControllerState(owner,base,now)!==null;
}

export function liveRows(base=projectRoot){
 return readdirSync(join(base,'.practice/status')).filter(f=>f.endsWith('.json')).flatMap(f=>{try{return[JSON.parse(readFileSync(join(base,'.practice/status',f),'utf8'))]}catch{return[]}});
}
export function swarmProcesses():number[]{
 if(process.platform!=='win32')return [];
 const child=Bun.spawnSync(['powershell','-NoProfile','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'scripts[\\/]swarm\\.ts' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],{stdout:'pipe',stderr:'ignore',windowsHide:true});
 if(child.exitCode!==0)throw Error('controller process ownership unavailable');
 const value=child.stdout.toString().trim();if(!value)return[];const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:[parsed];
}

export function accountFor(task:CoordTask,dependencies:Record<string,any>):string{
 const account=task.account??dependencies[task.accountFrom??'']?.account;
 if(typeof account!=='string'||!/^[A-Za-z0-9_ -]{1,12}$/.test(account))throw Error('account binding unavailable');return account;
}

// The accounts that a swarm run holds, in lower case. null: the list of runs does not read, so no account is known as idle.
export function swarmRunAccounts(base:string):Set<string>|null{
 try{const runs=JSON.parse(readFileSync(join(base,'.practice/swarm-runs.json'),'utf8'));
  return Array.isArray(runs)?new Set(runs.flatMap((r:any)=>Array.isArray(r?.accounts)?r.accounts:[null]).map((n:unknown)=>String(n).toLowerCase())):null;}
 catch(e){return (e as NodeJS.ErrnoException).code==='ENOENT'?new Set():null;}
}

// `reserved`: swarm.json holds the account with a reservation row (disabled, no script), as for the gang squad's accounts.
export type LiveAccountWait={account:string;reason:'active-session'|'autopilot-assignment'|'fleet-order'|'reserved';attemptId:string|null;pid:number|null};
export type LiveWait=LiveAccountWait|{account:string;reason:'memory';capacity:{running:number;external:number;starting:number;startingReserve:number;pending:number;freeGB:number;minFreeGB:number;maxBots:number}};
export const ordinaryDeferrable=(task:Pick<CoordTask,'kind'|'sessionRecovery'|'repairs'|'launch'>)=>task.kind==='run'&&!task.sessionRecovery&&!task.repairs?.length&&(!task.launch||task.launch==='ordinary');
export const deferredLiveAccount=(wait:LiveWait)=>({ok:false,evidence:'live-deferred',installed:false,liveDeferred:wait});
export class LiveAccountWaitError extends Error{
 constructor(readonly wait:LiveWait){super(wait.reason==='memory'?'live admission waiting: memory':'live account ownership deferred: '+wait.account+' '+wait.reason);}
}

export const liveTaskWindowMs=(task:CoordTask)=>task.timeoutMs??Math.min(MAX_SPECIALIST_RUN_MS,Math.max(900_000,(task.estimatedMs??0)*1.5));
// A controller stop belongs to the retired job. Owner pauses and global stops still hold every replacement.
export function liveAccountStops(accounts:readonly string[],base=projectRoot):{account:string;file:string}[]{
 for(const flag of ['stop-coordinator','stop-swarm'])if(existsSync(join(base,'.practice',flag)))throw Error('live owner stopped: '+flag);
 return accounts.flatMap(account=>[...new Set([account,account.toLowerCase()])].flatMap(name=>{
  const file=join(base,'.practice','stop-'+name);let text:string;
  try{text=readFileSync(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
  if(!swarmWroteStop(text))throw Error('account has a stop file; preserve its owner: '+account);
  return[{account,file}];
 }));
}
