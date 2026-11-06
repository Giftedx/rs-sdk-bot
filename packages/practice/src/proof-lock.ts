import {existsSync,readFileSync,renameSync,rmSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {canBind} from './ports';

const alive=(pid:number)=>{
    try{process.kill(pid,0);return true;}
    catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
};
export const PRACTICE_TURN_WAIT_EXPIRED='practice turn wait expired';
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';

// A read-only sample of the ticket queue. PID presence does not prove process identity.
export function observePracticeTurn(file:string,observedAt=Date.now(),pidPresent=alive){
    let holder:'no-lock'|'pid-present'|'pid-gone'|'unknown'='unknown';
    try{
        const owner=JSON.parse(readFileSync(file,'utf8'));
        if(Number.isSafeInteger(owner?.pid)&&owner.pid>0&&Number.isSafeInteger(owner.at)&&owner.at>0&&owner.at<=observedAt){
            holder=pidPresent(owner.pid)?'pid-present':'pid-gone';
        }
    }catch(error){if(missing(error))holder='no-lock';}
    let liveWaiters=0,oldestWaitMs:number|null=null,unknownTickets=0,tickets:string[];
    try{tickets=readdirSync(file+'.queue');}
    catch(error){
        if(!missing(error))return{observedAt,holder,liveWaiters:null,oldestWaitMs,unknownTickets:null};
        tickets=[];
    }
    for(const ticket of tickets){
        const fields=/^(\d{15})-(\d+)-[a-z0-9]{0,6}$/.exec(ticket);
        const at=Number(fields?.[1]),pid=Number(fields?.[2]);
        if(!Number.isSafeInteger(at)||at<1||at>observedAt||!Number.isSafeInteger(pid)||pid<1){unknownTickets++;continue;}
        if(!pidPresent(pid))continue;
        liveWaiters++;
        oldestWaitMs=Math.max(oldestWaitMs??0,observedAt-at);
    }
    return{observedAt,holder,liveWaiters,oldestWaitMs,unknownTickets};
}

// Only the parent of this delivery may recover its dead proof's lock. The
// still-present lock excludes a new owner until it is moved to the run's evidence.
export function recoverProofLock(file:string,directory:string,evidence:string,deps={alive,portsFree:()=>canBind(8888)&&canBind(7780)}):boolean{
    if(!existsSync(file))return false;
    let owner:any;try{owner=JSON.parse(readFileSync(file,'utf8'));}catch{return false;}
    if(owner.directory!==directory||!Number.isSafeInteger(owner.pid)||owner.pid<1||deps.alive(owner.pid)||!deps.portsFree())return false;
    renameSync(file,evidence);return true;
}

// One native practice check at a time across the main checkout and every build workspace (they share .practice).
// Waiters take turns in arrival order (a ticket file each), so a long multi-check proof cannot take the turn back
// before checks that queued while it ran. A dead holder or ticket gives up its place; the proof inside still takes
// its own lock.
type PracticeTurnOptions={alive?:(pid:number)=>boolean;sleep?:(ms:number)=>Promise<void>;now?:()=>number;waitMs?:number;stopped?:()=>boolean};
export async function withPracticeTurn<T>(file:string,run:()=>Promise<T>,{
    alive:holderAlive=alive,sleep=ms=>Bun.sleep(ms),now=Date.now,waitMs=3_600_000,stopped=()=>false,
}:PracticeTurnOptions={}):Promise<T>{
    if(stopped())throw Error('practice turn owner stopped; no child started');
    const deadline=now()+waitMs,queue=file+'.queue';
    mkdirSync(queue,{recursive:true});
    const ticket=`${String(now()).padStart(15,'0')}-${process.pid}-${Math.random().toString(36).slice(2,8)}`;
    writeFileSync(join(queue,ticket),'');
    const ahead=()=>readdirSync(queue).filter(t=>{
        if(t>=ticket)return false;
        const pid=Number(t.split('-')[1]);
        if(Number.isSafeInteger(pid)&&!holderAlive(pid)){rmSync(join(queue,t),{force:true});return false;}
        return true;
    }).length;
    try{
        for(;;){
            if(stopped())throw Error('practice turn owner stopped; no child started');
            if(!ahead())try{writeFileSync(file,JSON.stringify({pid:process.pid,at:now()}),{flag:'wx'});break;}
            catch(error){
                if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
                let owner:any;try{owner=JSON.parse(readFileSync(file,'utf8'));}catch{owner=undefined;}
                if(owner&&Number.isSafeInteger(owner.pid)&&!holderAlive(owner.pid)){rmSync(file,{force:true});continue;}
            }
            const remaining=deadline-now();
            if(remaining<=0)throw Error(PRACTICE_TURN_WAIT_EXPIRED);
            await sleep(Math.min(5000,remaining));
        }
    }finally{rmSync(join(queue,ticket),{force:true});}
    try{return await run();}
    finally{try{if(JSON.parse(readFileSync(file,'utf8')).pid===process.pid)rmSync(file,{force:true});}catch{/* already gone */}}
}
