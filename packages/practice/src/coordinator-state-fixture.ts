import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fleetStateFile} from '../../core/src/practice-paths';

// Scripts that hand accounts between sessions (scripts/handoff-inputs.ts, scripts/rune-carrier-stage.ts,
// scripts/transfer-admission.ts) read .practice/live/fleet-state.json to verify account ownership and pauses.
// A checkout without a controller (such as a hosted runner) has no such file, so a proof gives it an empty
// fleet state only when absent and only until the proof ends. A live state file is never overwritten or deleted.
export const EMPTY_COORDINATOR_STATE=JSON.stringify({schemaVersion:1,accounts:{}});
export function coordinatorStateFixture(base:string):()=>void{
 const file=fleetStateFile(base);
 if(existsSync(file))return()=>{};
 mkdirSync(dirname(file),{recursive:true});
 try{writeFileSync(file,EMPTY_COORDINATOR_STATE,{flag:'wx'});}catch{return()=>{};}
 return()=>{try{if(readFileSync(file,'utf8')===EMPTY_COORDINATOR_STATE)rmSync(file);}catch{/* a writer that changed it owns it */}};
}
