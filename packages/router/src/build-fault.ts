// The fault a failed build left: its failing check, then the proof cases or the error inside that check.
// coordinator.ts holds the next build when two builds in a row leave one fault (repeatedBuildFault).
import {existsSync,readFileSync} from 'node:fs';

// These faults come from the host. They say nothing about the source under test.
const HOST_FAULT=/port \d+ in use|free memory below floor/i;

function failedCases(stdout:string){
 for(const line of stdout.split('\n').map(l=>l.trim()).reverse()){
  if(!line.startsWith('{'))continue;
  try{
   const report=JSON.parse(line),cases=report.cases??report.results;
   if(Array.isArray(cases))return cases.filter((c:any)=>c?.ok===false).map((c:any)=>String(c.id)).sort();
  }catch{/* a log line, not the proof report */}
 }
 return [];
}
export function faultOf(check:string,stdout:string,stderr:string):string|null{
 const cases=failedCases(stdout);
 if(cases.length)return `${check}: ${cases.join(',')}`;
 const error=stderr.split('\n').map(l=>l.trim()).find(Boolean);
 if(!error||HOST_FAULT.test(error))return null;
 return `${check}: ${error.replace(/[0-9a-f]{8,}/gi,'#').replace(/\d+/g,'N').slice(0,160)}`;
}
const log=(path:unknown)=>typeof path==='string'&&existsSync(path)?readFileSync(path,'utf8'):'';
/** Null when the build passed, a check timed out, the host failed it, or no check ran. */
export function buildFault(output:any):string|null{
 if(output?.ok===true)return null;
 const checks=[output?.delivery,output?.diagnostic].flatMap(d=>Array.isArray(d?.checks)?d.checks:[]);
 const failed=checks.find((c:any)=>c.timedOut||c.exitCode!==0);
 if(!failed||failed.timedOut)return null;
 try{const {stdout,stderr}=JSON.parse(failed.detail);return faultOf(failed.id,log(stdout),log(stderr));}
 catch{return null;}
}
