import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

// Scripts that hand accounts between sessions (scripts/handoff-inputs.ts, scripts/rune-carrier-stage.ts,
// scripts/transfer-admission.ts) refuse to start when .practice/coordinator/state.json is missing: they check that no
// coordinator run owns their accounts. A checkout with no coordinator (a hosted runner) has no such file, so a proof
// that runs them gives it an empty state, only when the file is absent and only until the proof ends. A state that
// exists, the live coordinator's, is never written, replaced or removed.
export const EMPTY_COORDINATOR_STATE=JSON.stringify({version:1,tasks:[]});
export function coordinatorStateFixture(base:string):()=>void{
 const file=join(base,'.practice/coordinator/state.json');
 if(existsSync(file))return()=>{};
 mkdirSync(dirname(file),{recursive:true});
 try{writeFileSync(file,EMPTY_COORDINATOR_STATE,{flag:'wx'});}catch{return()=>{};}
 return()=>{try{if(readFileSync(file,'utf8')===EMPTY_COORDINATOR_STATE)rmSync(file);}catch{/* a writer that changed it owns it */}};
}
