import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export const SKULL_WAIT_TICKS=120;
export function validateSkullResume(prior:any,log:string,logout:any,current:{name:string,x:number,z:number,level:number,inventory:any[],equipment:any[]}){
 const item=(items:any[],id:number)=>items.filter(i=>(i.baseId??i.id)===id).reduce((n,i)=>n+i.count,0);
 if(prior.name?.toLowerCase()!==current.name.toLowerCase()||prior.pos?.x!==3120||prior.pos?.z!==9567||prior.pos?.level!==0||current.x!==3120||current.z!==9567||current.level!==0)throw Error('skull resume account/position mismatch');
 if(!/^fail step take skull /.test(prior.result??'')||!/^RESULT fail step take skull .*died=false milestones=1,2,3 /m.test(log)||!/^3 \d+$/.test(prior.phase??''))throw Error('skull resume requires failed producer stage3 proof');
 if(logout.state!=='confirmed'||logout.attemptId!==prior.sessionAttemptId||logout.account?.toLowerCase()!==current.name.toLowerCase())throw Error('skull resume requires matching confirmed logout');
 if(item(prior.inventory??[],553)||item(current.inventory,553)||item(prior.equipment??[],552)!==1||item(current.equipment,552)!==1)throw Error('skull resume requires worn amulet and missing skull');
 const project=(items:any[],equipment=false)=>items.map(i=>[i.baseId??i.id,i.count,equipment?i.slot??null:null]).sort((a,b)=>Number(a[0])-Number(b[0]));
 if(JSON.stringify(project(prior.inventory))!==JSON.stringify(project(current.inventory))||JSON.stringify(project(prior.equipment,true))!==JSON.stringify(project(current.equipment,true)))throw Error('skull resume held assets differ from producer');
}
export function readSkullResume(dir:string){return {prior:JSON.parse(readFileSync(join(dir,'final-status.json'),'utf8')),log:readFileSync(join(dir,'worker.log'),'utf8'),logout:JSON.parse(readFileSync(join(dir,'logout.json'),'utf8'))};}
