// Size cap for a log that a supervisor appends to across runs (.practice/swarm-logs/<account>.log).
// The swarm calls rotateLog before it opens the log for a new run. A log over the cap moves to <log>.1 and replaces the
// earlier .1, so one account keeps at most two parts, the newest part is the .log file and a run starts on a file it owns.
// A rotated log is smaller than an offset that a reader took on the old file: readers that detect an empty start test
// for an equal size, and readJobResultLines starts at 0 for an offset past the end.
import {existsSync,renameSync,rmSync,statSync} from 'node:fs';

export const SWARM_LOG_MAX_BYTES=8*1024*1024;

export function rotateLog(path:string,maxBytes=SWARM_LOG_MAX_BYTES):boolean{
 try{
  if(!existsSync(path)||statSync(path).size<=maxBytes)return false;
  // The log moves to a temp name first, so a failed move keeps both the log and the earlier .1.
  const old=path+'.1',temp=path+'.rotating';
  rmSync(temp,{force:true});
  renameSync(path,temp);
  try{rmSync(old,{force:true});renameSync(temp,old);}
  catch(error){try{renameSync(temp,path);}catch{/* the .rotating file holds the log */}throw error;}
  return true;
 }catch{return false;/* a reader holds the file open (Windows): keep appending and try at the next start */}
}
