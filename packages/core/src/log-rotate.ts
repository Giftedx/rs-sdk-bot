// Size cap for a log that a supervisor appends to across runs (.practice/swarm-logs/<account>.log).
// The swarm calls rotateLog before it opens the log for a new run. A log over the cap moves to <log>.1 and replaces the
// earlier .1, so one account keeps at most two parts, the newest part is the .log file and a run starts on a file it owns.
// A reader that holds an offset past the new end starts at 0 (readJobResultLines in scripts/autopilot.ts).
import {existsSync,renameSync,rmSync,statSync} from 'node:fs';

export const SWARM_LOG_MAX_BYTES=8*1024*1024;

export function rotateLog(path:string,maxBytes=SWARM_LOG_MAX_BYTES):boolean{
 try{
  if(!existsSync(path)||statSync(path).size<=maxBytes)return false;
  const old=path+'.1';
  rmSync(old,{force:true});
  renameSync(path,old);
  return true;
 }catch{return false;/* a reader holds the file open (Windows): keep appending and try at the next start */}
}
