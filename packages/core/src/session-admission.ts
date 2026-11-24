import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {statusReadDirs} from './practice-paths';
import {readAttemptReceiptById,readLogoutProof,resolveLifecycleRoot,scanAttemptsNewestFirst,verifyLegacyLogout,type LegacyLogoutClaim} from './session-lifecycle';
import {assertNoRecoveryLease} from './session-recovery-permit';
import {serverTakesOver,takeoverRef,pidAlive,type TakeoverLogoutRef} from './session-takeover';
const LIVE_SERVER='rs-sdk-demo.fly.dev';
export type ProducerProofRef={kind:'producer';attemptId:string};

export { missionSignature, successfulEnd } from './session-mission';

export type BootstrapLogoutRef={kind:'bootstrap';account:string;statusAt:number};
export type LiveLogoutRef=ProducerProofRef|LegacyLogoutClaim|BootstrapLogoutRef|TakeoverLogoutRef;
// First start for an account with no producer attempts. verifyLegacyLogout refuses every legacy claim, so without
// this path an account that predates the session producer can never start. A live session rewrites its status every
// few seconds and the server drops a disconnected session after 500 ticks (200 s), so a status unchanged for 15 min
// means no session is open; a second login would also be refused by the server. The first producer session then
// writes the logout receipt that every later start uses. Repairs (required) still need producer proof.
export const BOOTSTRAP_STATUS_AGE_MS=15*60*1000;
// No log reconstruction: the producer owns every new connection attempt. Historical sessions need an
// explicitly sealed legacy claim; a missing status or a RESULT string never proves their logout.
// A repair (required) keeps the authenticated recovery path: it needs producer proof, never a takeover start.
function assertStatusCovered(status:any,account:string,attemptId:string,createdAt:number,loggedOutAt:number){
 if(status?.server!==LIVE_SERVER)return;
 if(Number.isFinite(status.at)&&status.at>loggedOutAt&&!Number.isFinite(status.started)&&!status.sessionAttemptId)throw Error('latest status is not covered by the producer logout: '+account);
 if((Number.isFinite(status.started)&&status.started>loggedOutAt)
  ||(status.sessionAttemptId&&status.sessionAttemptId!==attemptId&&(!Number.isFinite(status.started)||status.started>=createdAt)))throw Error('latest status is not covered by the producer logout: '+account);
}

// The server drops a disconnected session after 500 ticks.
export const SERVER_SESSION_DROP_MS=200_000;
// The connect-failed details (inprocess.ts connectFailedDetail) of an attempt that ended before its game socket opened:
// ClientStream.openSocket rejects with the WebSocket, and cache.ts throws on an error status of a cache request. A
// second try inside one attempt follows only the server's reply 6, which refuses the client. A login reply
// ("Account already logged in" names an open session), a timeout and a missing packet observer come after the login
// block was sent and prove nothing about the session, so those attempts stay held (session-lifecycle.ts attemptOutcome).
const NO_GAME_SOCKET=/^(?:\[object WebSocket\]|Error: lite: GET \S+ failed with \d+)/;
function isDeadPreConnectFailure(receipt:ReturnType<typeof readAttemptReceiptById> extends infer T ? T extends {receipt:infer R} ? R : never : never,account:string,alive:(pid:number)=>boolean,now:number):boolean{
 if(!receipt||receipt.account.toLowerCase()!==account.toLowerCase()||receipt.server!==LIVE_SERVER)return false;
 if(!Number.isFinite(receipt.owner?.pid)||receipt.owner.pid<=0||alive(receipt.owner.pid))return false;
 if(!receipt.events.every(e=>e.kind==='connecting'||e.kind==='connect-failed'||e.kind==='closed'))return false;
 const failed=receipt.events.filter(e=>e.kind==='connect-failed');
 return failed.length===1&&NO_GAME_SOCKET.test(failed[0]!.detail??'')&&now-receipt.updatedAt>=SERVER_SESSION_DROP_MS;
}

// Start admission only. The newest attempts opened no game socket, their owners are dead and the newest is older than
// the server's session drop, so the account is as offline as the confirmed logout before them left it. The controller
// accepts only the latest attempt as a repair proof (swarm.ts currentLogout), so a repair never takes this path.
function priorConfirmedAfterDeadPreConnects(account:string,root:string,status:any,alive:(pid:number)=>boolean,now:number):ProducerProofRef|null{
 let skipped=0,result:ProducerProofRef|null=null;
 scanAttemptsNewestFirst(account,LIVE_SERVER,entry=>{
  const r=entry.receipt;
  if(!r)return false;
  if(isDeadPreConnectFailure(r,account,alive,now)){skipped++;return true;}
  if(skipped===0||r.account.toLowerCase()!==account.toLowerCase()||r.server!==LIVE_SERVER)return false;
  const end=r.events.find(e=>e.kind==='ended');
  if(end?.detail!=='logged-out')return false;
  assertStatusCovered(status,account,r.attemptId,r.createdAt,end.at);
  result={kind:'producer',attemptId:r.attemptId};
  return false;
 },{root});
 return result;
}

export function liveLogoutRef(account:string,base:string,required=false,now=Date.now(),
 takeover=serverTakesOver(LIVE_SERVER),alive:(pid:number)=>boolean=pidAlive):LiveLogoutRef|null{
 assertNoRecoveryLease(account,base);
 const root=resolveLifecycleRoot(account,LIVE_SERVER,base),proof=readLogoutProof(account,LIVE_SERVER,{root});
 const statusDirs=statusReadDirs(base);
 const statusPath=statusDirs.map(dir=>join(dir,account+'.json')).find(p=>existsSync(p))??join(base,'.practice/status',account+'.json');
 let status:any=null;
 if(existsSync(statusPath))status=JSON.parse(readFileSync(statusPath,'utf8'));
 if(proof.state==='confirmed'){
  const latest=readAttemptReceiptById(account,LIVE_SERVER,proof.attemptId,{root})?.receipt;
  if(!latest)throw Error('producer logout receipt changed: '+account);
  assertStatusCovered(status,account,proof.attemptId,latest.createdAt,proof.loggedOutAt);
  return{kind:'producer',attemptId:proof.attemptId};
 }
 if(proof.state==='held'){
  const fallback=required?null:priorConfirmedAfterDeadPreConnects(account,root,status,alive,now);
  if(fallback)return fallback;
  if(takeover&&!required){
   const ref=takeoverRef(proof,root,alive);
   if(ref&&!(status?.server===LIVE_SERVER&&status.sessionAttemptId&&status.sessionAttemptId>ref.attemptId))return ref;
  }
 }
 if(proof.state!=='none')throw Error('account logout is not confirmed: '+account+' '+proof.reason);
 const liveClaim=join(base,'.practice/live/session-proofs',account.toLowerCase()+'.json');
 const legacyClaim=join(base,'.practice/coordinator/session-proofs',account.toLowerCase()+'.json');
 const claimPath=existsSync(liveClaim)?liveClaim:legacyClaim;
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
// This blocks stale controller admission and partial hosted/orchestrated connection attempts.
export function withSessionAdmission<T>(accounts:readonly string[],base:string,launch:()=>T):T {
 for(const account of accounts)liveLogoutRef(account,base);
 return launch();
}
