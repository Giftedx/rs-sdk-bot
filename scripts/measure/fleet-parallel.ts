// Two independent regions, one shared engine. Each child owns only its account and logs.
import {startStack} from '../../packages/practice/src/stack';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
const cases=process.argv.slice(2);
if(cases.length!==2 || new Set(cases).size!==2)throw new Error('provide exactly two distinct proof modes');
const stack=process.env.REUSE_STACK==='1'?null:await startStack({tickMs:150});
const children:{exitCode:number|null;exited:Promise<number>;kill():void}[]=[];
const started=Date.now();
try{
 for(const mode of cases){
  const p=Bun.spawn(['bun',resolve('scripts/measure/fleet-practice.ts'),mode,'1'],{env:{...process.env,DEMO_OK:'',REUSE_STACK:'1'},stdout:'inherit',stderr:'inherit'});
  children.push(p);
 }
 const codes=await Promise.all(children.map(p=>p.exited));
 writeFileSync(resolve('.practice/fleet-proof',`parallel-${started}.json`),JSON.stringify({cases,codes,started,finished:Date.now(),oneEngine:true,botsMax:2,tickMs:150},null,2));
 console.log(`PARALLEL_RESULT cases=${cases.join(',')} codes=${codes.join(',')} oneEngine=true botsMax=2 tickMs=150`);
 process.exitCode=codes.every(c=>c===0)?0:1;
}finally{
 for(const p of children)if(p.exitCode===null)p.kill();
 await stack?.stop();
}
