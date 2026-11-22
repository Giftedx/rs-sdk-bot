import {resolve} from 'node:path';

export type AttributedAuthReply={at:number;requestAt:number;connection:number;replyTo:string|number;type:'player_login'|'player_logout';account:string;response:number};

export function observeAuth(log:string,requireSealed=false){
 const requests=new Map<string,any>(),replied=new Set<string>(),connections=new Set<number>(),replies:AttributedAuthReply[]=[];
 let ready=false,sealed=false,last=-Infinity,count=0;
 const fail=():never=>{throw Error('auth attribution missing, malformed, duplicate or ambiguous');};
 const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
 for(const line of log.split(/\r?\n/)){
  if(!line.startsWith('AUTH_'))continue;
  if(++count>8193||line.length>1024)fail();
  if(sealed)fail();
  const space=line.indexOf(' '),kind=line.slice(0,space);let r:any;
  try{r=JSON.parse(line.slice(space+1));}catch{fail();}
  if(!r||typeof r!=='object'||Array.isArray(r)||!Number.isSafeInteger(r.at)||r.at<0||r.at<last)fail();last=r.at;
  const keys=kind==='AUTH_READY'?['at','schema']:kind==='AUTH_CONNECTION'?['at','connection']:kind==='AUTH_REQUEST'?['at','connection','replyTo','type','account']:kind==='AUTH_REPLY'?['at','connection','replyTo','response']:kind==='AUTH_SEALED'?['at','records','healthy']:[];
  if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))fail();
  if(kind==='AUTH_READY'){if(ready||r.schema!==1)fail();ready=true;continue;}
  if(kind==='AUTH_SEALED'){if(!ready||r.healthy!==true||r.records!==count-1)fail();sealed=true;continue;}
  if(!ready||!Number.isSafeInteger(r.connection)||r.connection<1)fail();
  if(kind==='AUTH_CONNECTION'){if(connections.has(r.connection))fail();connections.add(r.connection);continue;}
  if(!connections.has(r.connection)||!id(r.replyTo))fail();
  const key=JSON.stringify([r.connection,r.replyTo]);
  if(kind==='AUTH_REQUEST'){
   if(requests.has(key)||!['player_login','player_logout'].includes(r.type)||typeof r.account!=='string'||!(/^[a-z0-9]{1,12}$/).test(r.account))fail();
   requests.set(key,r);
  }else if(kind==='AUTH_REPLY'){
   const request=requests.get(key);if(!request||replied.has(key)||!Number.isInteger(r.response))fail();
   replied.add(key);replies.push({...r,requestAt:request.at,type:request.type,account:request.account});
  }else fail();
 }
 if(!ready||requireSealed&&!sealed||replied.size!==requests.size)fail();
 return {requests:[...requests.values()] as {at:number;connection:number;replyTo:string|number;type:string;account:string}[],replies};
}

export function authReplies(log:string,since:number,account?:string,type?:AttributedAuthReply['type']){
 if(!Number.isSafeInteger(since))throw Error('auth attribution invalid interval');
 return observeAuth(log).replies.filter(r=>r.requestAt>=since&&(!account||r.account===account.toLowerCase())&&(!type||r.type===type));
}

export function noRecoveryLogin(log:string,since:number,account:string){
 // Inspect requests, including attempts with delayed/missing replies. Unknown evidence refuses.
 try{return !observeAuth(log).requests.some(r=>r.at>=since&&r.account===account.toLowerCase()&&r.type==='player_login');}catch{return false;}
}

// Pinned LoginServer.ts:300/:578 refuses a takeover with response 3 while Date.now()-lastTakeover < LOGIN_TAKEOVER_MIN_MS.
// The proof binds that value for its private login server only. Gateway and worker environments are unchanged.
export const TAKEOVER_WINDOW_MS=60000;
// lastTakeover is set before the takeover reply, and the recovery is handled after its request is observed, so the
// observed request-minus-reply gap never exceeds the server's elapsed time. A gap at or above the window is expired.
export function classifyCooldownWindow(log:string,account:string,w:{signalAt:number;warmAt:number;since:number;windowMs:number}){
 const a=account.toLowerCase(),fail=(reason:string,more:Record<string,unknown>={})=>({ok:false,reason,windowMs:w.windowMs,...more});
 if(!Number.isSafeInteger(w.windowMs)||w.windowMs<=0)return fail('takeover window unbound');
 let auth:ReturnType<typeof observeAuth>;try{auth=observeAuth(log);}catch{return fail('auth attribution unknown');}
 const mine=auth.replies.filter(r=>r.account===a);
 const warm=mine.filter(r=>r.type==='player_login'&&r.response===0&&r.requestAt>=w.signalAt&&r.at<=w.warmAt);
 if(warm.length!==1)return fail('warm takeover reply missing or ambiguous');
 const takeover=warm[0]!,prior=mine.filter(r=>r.response===0&&r.at<takeover.requestAt).at(-1);
 if(prior?.type!=='player_login')return fail('warm login did not take over a live session',{takeoverReplyAt:takeover.at});
 const requests=auth.requests.filter(r=>r.account===a&&r.type==='player_login'&&r.at>=w.since
  &&!(r.connection===takeover.connection&&r.replyTo===takeover.replyTo));
 if(requests.length!==1)return fail('recovery login request missing or ambiguous',{takeoverReplyAt:takeover.at});
 const req=requests[0]!,timing={takeoverReplyAt:takeover.at,recoveryRequestAt:req.at,gapMs:req.at-takeover.at};
 if(timing.gapMs<0)return fail('recovery login preceded the warm takeover',timing);
 if(timing.gapMs>=w.windowMs)return fail('window expired before recovery',timing);
 const answers=auth.replies.filter(r=>r.connection===req.connection&&r.replyTo===req.replyTo);
 if(answers.length!==1||answers[0]!.response!==3)return fail('recovery login inside the window was not refused with response 3',{...timing,response:answers[0]?.response??null});
 return {ok:true,reason:'recovery login refused with response 3 inside the open takeover window',windowMs:w.windowMs,...timing,response:3};
}

// The actual CLI emits this row after its source and permit checks, before it connects.
export async function waitRecoveryRuntime(readLog:()=>string,expected:{pid:number;runner:string;root:string;since:number},
 observation:{timeoutMs:number;now?:()=>number;pause?:(ms:number)=>Promise<unknown>}={timeoutMs:60000}){
 if(!Number.isSafeInteger(observation.timeoutMs)||observation.timeoutMs<=0)throw Error('recovery runtime observation deadline invalid');
 const now=observation.now??Date.now,pause=observation.pause??(ms=>Bun.sleep(ms)),until=now()+observation.timeoutMs;
 for(;;){
  const log=readLog();
  for(const line of log.slice(0,log.lastIndexOf('\n')+1).split(/\r?\n/)){
   if(!line.startsWith('RECOVERY_RUNTIME '))continue;
   let row:any;try{row=JSON.parse(line.slice('RECOVERY_RUNTIME '.length));}catch{continue;}
   if(row?.pid!==expected.pid||!Number.isSafeInteger(row.at)||row.at<expected.since)continue;
   if(typeof row.runner!=='string'||typeof row.cwd!=='string'||typeof row.repoRoot!=='string'
    ||resolve(row.runner)!==resolve(expected.runner)||resolve(row.cwd)!==resolve(expected.root)||resolve(row.repoRoot)!==resolve(expected.root))
    throw Error('recovery runtime identity mismatch');
   return row as {at:number;pid:number;runner:string;cwd:string;repoRoot:string};
  }
  const left=until-now();if(left<=0)throw Error('recovery runtime observation timeout: matching child not observed');
  await pause(Math.min(50,left));
 }
}

// The owner process can exit before the world receives its LoginServer logout acknowledgement.
// Observe that reply without changing the session owner's cleanup or its deadline.
export async function waitOwnerAuthLogout(readLog:()=>string,account:string,o:{releaseAt:number;ownerLoginReplyAt:number|undefined},
 observation:{timeoutMs:number;now?:()=>number;pause?:(ms:number)=>Promise<unknown>}={timeoutMs:5000}){
 if(!Number.isSafeInteger(observation.timeoutMs)||observation.timeoutMs<=0)throw Error('owner auth observation deadline invalid');
 const now=observation.now??Date.now,pause=observation.pause??(ms=>Bun.sleep(ms)),until=now()+observation.timeoutMs;
 for(;;){
  const log=readLog();let auth:ReturnType<typeof observeAuth>|undefined;
  // A request without its reply is incomplete evidence, including while a reply is in flight.
  try{auth=observeAuth(log);}catch{}
  if(auth&&o.ownerLoginReplyAt!==undefined){
   const logouts=auth.replies.filter(r=>r.account===account.toLowerCase()&&r.type==='player_logout'&&r.requestAt>=o.ownerLoginReplyAt!);
   if(logouts.some(r=>r.response!==0))throw Error('owner auth logout acknowledgement failed');
   if(logouts.some(r=>r.requestAt>=o.releaseAt))return log;
  }
  const left=until-now();
  if(left<=0)throw Error('owner auth logout acknowledgement timeout: matching successful reply not observed');
  await pause(Math.min(50,left));
 }
}

// Owner preservation from server-side records only. A client getState() view can outlive a server takeover.
export function ownerSessionEvidence(log:string,account:string,o:{since:number;releaseAt:number;ownerLoginReplyAt:number|undefined;ownerAttempt:string|undefined;latestAttemptBeforeRelease:string|undefined}){
 const a=account.toLowerCase();let mine:AttributedAuthReply[];
 try{mine=observeAuth(log).replies.filter(r=>r.account===a&&r.response===0);}
 catch{return {ok:false,noRecoveryLoginSuccess:false,ownerLoginLatest:false,ownerAttemptLatest:false,ownerLogoutAfterRelease:false};}
 const noRecoveryLoginSuccess=!mine.some(r=>r.type==='player_login'&&r.requestAt>=o.since);
 const lastLogin=mine.filter(r=>r.type==='player_login'&&r.at<o.releaseAt).at(-1);
 const ownerLoginLatest=o.ownerLoginReplyAt!==undefined&&lastLogin?.at===o.ownerLoginReplyAt;
 const ownerAttemptLatest=!!o.ownerAttempt&&o.latestAttemptBeforeRelease===o.ownerAttempt;
 // Exactly one logout ends the owner's session, and only after release. An earlier logout means it ended before release.
 const logouts=o.ownerLoginReplyAt===undefined?[]:mine.filter(r=>r.type==='player_logout'&&r.requestAt>=o.ownerLoginReplyAt!);
 const ownerLogoutAfterRelease=logouts.length===1&&logouts[0]!.requestAt>=o.releaseAt;
 return {ok:noRecoveryLoginSuccess&&ownerLoginLatest&&ownerAttemptLatest&&ownerLogoutAfterRelease,noRecoveryLoginSuccess,ownerLoginLatest,ownerAttemptLatest,ownerLogoutAfterRelease};
}

// The recovery session is its single acknowledged login; its final logout is the single logout requested on that
// login's connection after the login reply, and it must succeed. A cleanup logout before that login (an orphan's
// server-side end) belongs to an earlier session and never satisfies the final logout.
export function recoverySessionAuth(replies:AttributedAuthReply[],account:string){
 const a=account.toLowerCase(),mine=replies.filter(r=>r.account===a);
 const logins=mine.filter(r=>r.type==='player_login'&&r.response===0),login=logins.length===1?logins[0]!:undefined;
 const later=login?mine.filter(r=>r.requestAt>=login.at):[];
 const logouts=later.filter(r=>r.type==='player_logout');
 const logoutAcknowledged=!!login&&logouts.length===1&&logouts[0]!.response===0&&logouts[0]!.connection===login.connection&&!later.some(r=>r.type==='player_login');
 return {loginAcknowledged:!!login,logoutAcknowledged};
}

// The latest login success before `since` and the single recovery login after it, measured against the bound window.
export function loginAfterTakeoverWindow(log:string,account:string,since:number,windowMs:number){
 try{
  const logins=observeAuth(log).replies.filter(r=>r.account===account.toLowerCase()&&r.type==='player_login'&&r.response===0);
  const prior=logins.filter(r=>r.at<since).at(-1),next=logins.filter(r=>r.requestAt>=since);
  if(!prior||next.length!==1)return {ok:false,gapMs:null};
  const gapMs=next[0]!.requestAt-prior.at;return {ok:gapMs>=windowMs,gapMs};
 }catch{return {ok:false,gapMs:null};}
}

export function orphanRecoveryReadyAt(serverEndAt:number,windowMs:number){
 if(!Number.isSafeInteger(serverEndAt)||serverEndAt<0||!Number.isSafeInteger(windowMs)||windowMs<=0)throw Error('orphan recovery boundary invalid');
 return serverEndAt+windowMs+1000;
}

// Pinned World.ts:2635 answers a login with 5 ('Account already logged in') while the killed owner's player sits in
// logoutRequests, from its idle removal until the login server acknowledges that logout. The orphan's server-side end
// is the single acknowledged logout requested after the kill.
export function orphanServerEnd(log:string,account:string,killedAt:number){
 try{
  const ends=observeAuth(log).replies.filter(r=>r.account===account.toLowerCase()&&r.requestAt>=killedAt);
  const logouts=ends.filter(r=>r.type==='player_logout');
  if(logouts.length!==1||logouts[0]!.response!==0||ends.some(r=>r.type==='player_login'))return {ok:false,at:null};
  return {ok:true,at:logouts[0]!.at};
 }catch{return {ok:false,at:null};}
}

export function latestOwnerLoginBefore(log:string,account:string,before:number){
 try{return observeAuth(log).replies.filter(r=>r.account===account.toLowerCase()&&r.type==='player_login'&&r.response===0&&r.at<before).at(-1)?.at;}catch{return undefined;}
}
