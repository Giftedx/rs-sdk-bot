// Shared with the controller and cleanup authority. Preserve existing stored revisions.
export function missionSignature(job:{script:string;host?:boolean;orchestrate?:boolean;accounts?:string[];account?:string;args?:string[];env?:Record<string,string>;envByAccount?:Record<string,Record<string,string>>}):string{
 const sorted=<T,>(e:Record<string,T>)=>Object.entries(e).sort(([a],[b])=>a<b?-1:a>b?1:0);
 const fields:unknown[]=[job.script,!!job.host,(job.host||job.orchestrate?job.accounts??[]:[job.account??'']).map(a=>a.toLowerCase()),sorted(job.env??{})];
 if(job.orchestrate||job.args?.length)fields.push(!!job.orchestrate,job.args??[]);
 // Only a job with per-account env carries it, so stored revisions of every other job keep their text.
 if(job.envByAccount&&Object.keys(job.envByAccount).length)fields.push(sorted(job.envByAccount).map(([a,e])=>[a.toLowerCase(),sorted(e)]));
 return JSON.stringify(fields);
}
export function successfulEnd(reason:string):boolean{return /^done(?: after \d+ runs)?$/.test(reason);}
// The ends after which a held session is recovered. The recovery only logs in, observes and logs out, so the end of the
// latest run matters only to keep a death for diagnosis. A release-paused, released (a swarm stop, swarm.ts
// brainStopEnd) or refused run stopped before or at login, and the held session is then an earlier run's. The
// controller (fleet session-recovery.ts) and the permit (session-recovery-permit/authority.ts) both read this list.
export const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped|release-paused|released|refused)(?:\b| |:)/;
