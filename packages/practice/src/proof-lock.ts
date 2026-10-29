import {existsSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
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

// One native practice check at a time across the main checkout and every build workspace (they share .practice).
// A waiter polls until the turn file is free or its holder is dead; the proof inside still takes its own lock.
export async function withPracticeTurn<T>(file:string,run:()=>Promise<T>,deps={alive,sleep:(ms:number)=>Bun.sleep(ms),now:()=>Date.now(),waitMs:3_600_000}):Promise<T>{
    const deadline=deps.now()+deps.waitMs;
    for(;;){
        try{writeFileSync(file,JSON.stringify({pid:process.pid,at:deps.now()}),{flag:'wx'});break;}
        catch(error){
            if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
            let owner:any;try{owner=JSON.parse(readFileSync(file,'utf8'));}catch{owner=undefined;}
            if(owner&&Number.isSafeInteger(owner.pid)&&!deps.alive(owner.pid)){rmSync(file,{force:true});continue;}
            if(deps.now()>=deadline)throw Error('practice turn wait expired; holder '+JSON.stringify(owner));
            await deps.sleep(5000);
        }
    }
    try{return await run();}
    finally{try{if(JSON.parse(readFileSync(file,'utf8')).pid===process.pid)rmSync(file,{force:true});}catch{/* already gone */}}
}
