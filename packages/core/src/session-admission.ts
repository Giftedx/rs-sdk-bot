import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readLogoutProof,verifyLegacyLogout,listAttempts,type LegacyLogoutClaim} from './session-lifecycle';
import {assertNoRecoveryLease} from './session-recovery-permit';
const LIVE_SERVER='rs-sdk-demo.fly.dev';
export type ProducerProofRef={kind:'producer';attemptId:string};

// Shared with the controller and cleanup authority. Preserve existing stored revisions.
export function missionSignature(job:{script:string;host?:boolean;orchestrate?:boolean;accounts?:string[];account?:string;args?:string[];env?:Record<string,string>}):string{
 const fields:unknown[]=[job.script,!!job.host,(job.host||job.orchestrate?job.accounts??[]:[job.account??'']).map(a=>a.toLowerCase()),
  Object.entries(job.env??{}).sort(([a],[b])=>a<b?-1:a>b?1:0)];
 if(job.orchestrate||job.args?.length)fields.push(!!job.orchestrate,job.args??[]);
 return JSON.stringify(fields);
}
export function successfulEnd(reason:string):boolean{return /^done(?: after \d+ runs)?$/.test(reason);}

export type BootstrapLogoutRef={kind:'bootstrap';account:string;statusAt:number};
export type LiveLogoutRef=ProducerProofRef|LegacyLogoutClaim|BootstrapLogoutRef;
// First start for an account with no producer attempts. verifyLegacyLogout refuses every legacy claim, so without
// this path an account that predates the session producer can never start. A live session rewrites its status every
// few seconds and the server drops a disconnected session after 500 ticks (200 s), so a status unchanged for 15 min
// means no session is open; a second login would also be refused by the server. The first producer session then
// writes the logout receipt that every later start uses. Repairs (required) still need producer proof.
export const BOOTSTRAP_STATUS_AGE_MS=15*60*1000;
// No log reconstruction: the producer owns every new connection attempt. Historical sessions need an
// explicitly sealed legacy claim; a missing status or a RESULT string never proves their logout.
export function liveLogoutRef(account:string,base:string,required=false,now=Date.now()):LiveLogoutRef|null{
 assertNoRecoveryLease(account,base);
 const root=join(base,'.practice/session-lifecycle'),proof=readLogoutProof(account,LIVE_SERVER,{root});
 const statusPath=join(base,'.practice/status',account+'.json');
 let status:any=null;
 if(existsSync(statusPath))status=JSON.parse(readFileSync(statusPath,'utf8'));
 if(proof.state==='confirmed'){
  const latest=listAttempts(account,LIVE_SERVER,{root}).find(a=>a.attemptId===proof.attemptId)?.receipt;
  if(!latest)throw Error('producer logout receipt changed: '+account);
  if(status?.server===LIVE_SERVER&&Number.isFinite(status.at)&&status.at>proof.loggedOutAt&&!Number.isFinite(status.started)&&!status.sessionAttemptId)throw Error('latest status is not covered by the producer logout: '+account);
  if(status?.server===LIVE_SERVER&&((Number.isFinite(status.started)&&status.started>proof.loggedOutAt)
   ||(status.sessionAttemptId&&status.sessionAttemptId!==proof.attemptId&&(!Number.isFinite(status.started)||status.started>=latest.createdAt))))throw Error('latest status is not covered by the producer logout: '+account);
  return{kind:'producer',attemptId:proof.attemptId};
 }
 if(proof.state!=='none')throw Error('account logout is not confirmed: '+account+' '+proof.reason);
 const claimPath=join(base,'.practice/coordinator/session-proofs',account.toLowerCase()+'.json');
 if(existsSync(claimPath)){
  const claim=JSON.parse(readFileSync(claimPath,'utf8'));
  if(claim.account?.toLowerCase()!==account.toLowerCase()||claim.server!==LIVE_SERVER||claim.statusPath!==statusPath)throw Error('legacy logout claim identity mismatch: '+account);
  const checked=verifyLegacyLogout(claim,{root});
  if(checked.state!=='legacy-confirmed')throw Error('legacy logout claim refused: '+account+' '+checked.reason);
  return claim;
 }
 if(!required&&status?.server===LIVE_SERVER&&Number.isFinite(status.at)&&status.at>0&&now-status.at>=BOOTSTRAP_STATUS_AGE_MS)return{kind:'bootstrap',account,statusAt:status.at};
 if(required||status?.server===LIVE_SERVER)throw Error('account needs an explicit legacy logout claim: '+account);
 return null;
}

// Re-read every selected participant in the same synchronous turn as the launch.
// This blocks stale router admission and partial hosted/orchestrated connection attempts.
export function withSessionAdmission<T>(accounts:readonly string[],base:string,launch:()=>T):T {
 for(const account of accounts)liveLogoutRef(account,base);
 return launch();
}
