import {existsSync,readFileSync,renameSync} from 'node:fs';
import {canBind} from './ports';

const alive=(pid:number)=>{
    try{process.kill(pid,0);return true;}
    catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
};

// Only the parent of this delivery may recover its dead proof's lock. The
// still-present lock excludes a new owner until it is moved to the run's evidence.
export function recoverProofLock(file:string,directory:string,evidence:string,deps={alive,portsFree:()=>canBind(8888)&&canBind(7780)}):boolean{
    if(!existsSync(file))return false;
    let owner:any;try{owner=JSON.parse(readFileSync(file,'utf8'));}catch{return false;}
    if(owner.directory!==directory||!Number.isSafeInteger(owner.pid)||owner.pid<1||deps.alive(owner.pid)||!deps.portsFree())return false;
    renameSync(file,evidence);return true;
}
