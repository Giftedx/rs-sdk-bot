// The fault a failed build left: its failing check, then the proof cases, failed tests or error inside that check.
// coordinator.ts holds the next build when two builds in a row leave one fault (repeatedBuildFault).
import {existsSync,readFileSync} from 'node:fs';

// These faults come from the host. They say nothing about the source under test.
const HOST_FAULT=/port \d+ in use|free memory below floor|insufficient (?:free memory: below the floor|practice (?:free memory floor|memory: need))/i;
const PROOF_TIMING=/^[A-Z0-9_]+_PROOF_TIMING \{/;

// A proof report lists cases (cases, results) or names its acceptance predicates (checks).
function failedCases(stdout:string){
 for(const line of stdout.split('\n').map(l=>l.trim()).reverse()){
  if(!line.startsWith('{'))continue;
  try{
   const report=JSON.parse(line),cases=report.cases??report.results;
   if(Array.isArray(cases))return cases.filter((c:any)=>c?.ok===false).map((c:any)=>String(c.id)).sort();
   if(report.checks&&typeof report.checks==='object')return Object.keys(report.checks).filter(k=>report.checks[k]===false).sort();
  }catch{/* a log line, not the proof report */}
 }
 return [];
}
const plain=(text:string)=>text.replace(/[0-9a-f]{8,}/gi,'#').replace(/\d+/g,'N').slice(0,240);
export function faultOf(check:string,stdout:string,stderr:string):string|null{
 const cases=failedCases(stdout);
 if(cases.length)return `${check}: ${cases.join(',')}`;
 const lines=stderr.split('\n').map(l=>l.trim()).filter(Boolean);
 // bun test prints each file name to stderr, even when its tests pass, and one (fail) line for each failed test.
 const tests=lines.flatMap(l=>/^\(fail\) (.+?)(?: \[[\d.]+ms\])?$/.exec(l)?.[1]??[]).sort();
 if(tests.length)return `${check}: ${plain(tests.join(','))}`;
 const error=lines.find(l=>!/\.test\.tsx?:$/.test(l)&&!PROOF_TIMING.test(l));
 if(!error||HOST_FAULT.test(error))return null;
 return `${check}: ${plain(error)}`;
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
