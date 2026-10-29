// Practice check for scripts/quest-sweep.ts (quest-sweep capability): Doric's Quest from Falador square with the items in the bank, then a
// refusal with an empty bank. Writes results.json here.
import {openSync,writeFileSync,rmSync,closeSync,mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {startStack,stopStack} from './stack';
import {applyPreset} from './presets';
import {createBot} from './bots';
import {runBotName} from './prove';
import {PRACTICE_STARTUP_GB} from '../../core/src/memory';
const root=resolve(import.meta.dir,'../../..'),dir=join(resolve(import.meta.dir,'../../..'),'.practice','quest-sweep');
// --verify: the consumer check reads the last practice results and passes only when every case met its expectation.
if(process.argv.includes('--verify')){
 const r=JSON.parse(readFileSync(join(dir,'results.json'),'utf8')) as {id:string;ok:boolean}[];
 const ok=['bank-stage','missing'].every(id=>r.some(x=>x.id===id&&x.ok));
 console.log(ok?'quest-sweep practice results verified':'quest-sweep practice results failed '+JSON.stringify(r));
 process.exit(ok?0:1);
}
if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('insufficient practice startup reserve');
const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
writeFileSync(fd,JSON.stringify({pid:process.pid,directory:dir,task:'quest-sweep'}));closeSync(fd);
mkdirSync(dir,{recursive:true});
const results:any[]=[];
try{
 await startStack({tickMs:150,readyTimeoutMs:60000});
 const cases=[
  {id:'bank-stage',quest:'doric',expect:/^RESULT ok/m,bank:[{id:434,count:6},{id:436,count:4},{id:440,count:2}]},
  {id:'missing',quest:'doric',expect:/^RESULT fail quest-sweep doric missing 434:6,436:4,440:2s*$/m,bank:[]},
 ];
 for(const c of cases){
  const name=runBotName('qsw',results.length);await createBot(name);
  await applyPreset(name,{position:{x:2965,z:3380,level:0},bank:c.bank,inventory:[{id:995,count:50},{id:1351,count:1}]});
  const t=Date.now();
  const p=Bun.spawn(['bun','scripts/quest-sweep.ts',name,c.quest],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});
  const kill=setTimeout(()=>p.kill(),300000);
  const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
  clearTimeout(kill);const code=await p.exited;
  writeFileSync(join(dir,c.id+'.log'),out+'\n--stderr--\n'+err);
  const line=out.split(/\r?\n/).find(l=>l.startsWith('RESULT'))??'';
  results.push({id:c.id,ok:c.expect.test(out),exit:code,seconds:Math.round((Date.now()-t)/1000),result:line.slice(0,300)});
  console.log(JSON.stringify(results.at(-1)));
 }
}finally{await stopStack();rmSync(lock,{force:true});writeFileSync(join(dir,'results.json'),JSON.stringify(results,null,1));}
process.exit(results.length===2&&results.every(r=>r.ok)?0:1);
