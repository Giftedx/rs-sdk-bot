import {listAttempts,type LogoutProof} from './session-lifecycle';
import {laterProcessHolds,processStartTimes} from '../../practice/src/proc';

// Servers proven to hand a re-login to the Player still in the world (rs-sdk 97725db3 and db0cc51e): the new client
// attaches, no save is reloaded, and a death, delay or combat lock carries on. Each entry names its evidence.
// The live server is absent: no read-only observation has shown its behaviour (research/community-and-upstream.md 8.6).
export const TAKEOVER_SERVERS:ReadonlyMap<string,string>=new Map();
export const serverTakesOver=(server:string)=>TAKEOVER_SERVERS.has(server);

export type TakeoverLogoutRef={kind:'takeover';attemptId:string;ownerPid:number};
export function pidAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}
// Whether the process that a record of `savedAt` names still runs. The system gives the id of an ended process to a
// later one, so a live id that a later process holds is not that process (laterProcessHolds). A start-time read that
// fails proves nothing, and the id then counts as alive. The read starts PowerShell, and it runs only for a live id.
export type ProcessStarts=(pids:readonly number[])=>ReadonlyMap<number,number>|null;
export function savedProcessAlive(pid:number,savedAt:number,starts:ProcessStarts=processStartTimes,alive:(pid:number)=>boolean=pidAlive):boolean{
    return alive(pid)&&!laterProcessHolds(pid,savedAt,starts([pid]));
}

// A held session whose client died ends with one re-login on a takeover server: the next producer session attaches to
// the Player and its own logout writes the proof later starts need. Refuse an unrecorded attempt and any attempt after
// the last confirmed logout whose owner process may still run, so two clients never drive one account.
export function takeoverRef(proof:LogoutProof,root:string,alive:(pid:number)=>boolean=pidAlive):TakeoverLogoutRef|null{
 if(proof.state!=='held'||proof.reason.startsWith('newer attempt'))return null;
 const attempts=listAttempts(proof.account,proof.server,{root});
 const latest=attempts.at(-1);
 if(!latest?.receipt||latest.attemptId!==proof.attemptId)return null;
 let confirmed=-1;
 attempts.forEach((a,i)=>{if(a.receipt?.events.some(e=>e.kind==='ended'&&e.detail==='logged-out'))confirmed=i;});
 for(const a of attempts.slice(confirmed+1)){
  const pid=a.receipt?.owner.pid;
  if(!Number.isSafeInteger(pid)||(pid as number)<=0||alive(pid as number))return null;
 }
 return {kind:'takeover',attemptId:proof.attemptId,ownerPid:latest.receipt.owner.pid};
}
