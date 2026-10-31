// Harness-owned practice proof for scripts/rune-bank-craft.ts. --verify never launches services or workers.
// One staged account at Falador East bank: Rune Mysteries done, talisman and 30 essence banked, 5 air runes held.
// xpRate1 keeps Runecraft below 11, so one essence makes one air rune.
import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {PRACTICE_STARTUP_GB} from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
const ESSENCE=1436,AIR=556,TALISMAN=1438,PACK=93,BANK=95,RC=20,XP_RATE=1,STAGED=30;
const sum=(s:Save,id:number,container?:number)=>Object.entries(s.inventories).filter(([key])=>container===undefined||Number(key)===container)
 .reduce((n,[,items])=>n+items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
const assets=(s:Save)=>{const a:Record<number,number>={};for(const i of Object.values(s.inventories).flat())a[i.id]=(a[i.id]??0)+i.count;return a;};
export function runeBankSaveChecks(before:Save,after:Save,xpRate=XP_RATE){
 const used=sum(before,ESSENCE)-sum(after,ESSENCE),raw=(s:Save,i:number)=>s.skills[i]!.rawExperience;
 const a=assets(before),b=assets(after),converted=new Set([ESSENCE,AIR]);
 return {entry:before.vars[63]===6&&sum(before,ESSENCE,BANK)===STAGED&&sum(before,ESSENCE,PACK)===0&&sum(before,TALISMAN)===1
   &&sum(before,AIR,PACK)>0&&before.skills[RC]!.level===1&&raw(before,RC)===0,
  essence:used===STAGED&&sum(after,ESSENCE)===0,
  // Air altar: 5 XP per essence, saved as tenths.
  xp:raw(after,RC)-raw(before,RC)===used*50*xpRate,
  runes:sum(after,AIR,BANK)-sum(before,AIR)===used&&sum(after,AIR,PACK)===0,
  multiplierOne:after.skills[RC]!.level<11,
  otherSkills:after.skills.every((s,i)=>i===RC||s.rawExperience===raw(before,i)),
  assets:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  life:after.skills[3]!.level>0};
}
function verify(directory:string){
 const before=readPracticeSave(join(directory,'before.sav')),after=readPracticeSave(join(directory,'after.sav'));
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8')),log=readFileSync(join(directory,'worker.log'),'utf8');
 const summary=JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('RUNE_BANK_CRAFT_RESULT ')).at(-1)?.slice('RUNE_BANK_CRAFT_RESULT '.length)??'null');
 const used=sum(before,ESSENCE)-sum(after,ESSENCE);
 const checks={...runeBankSaveChecks(before,after),exit:meta.code===0&&!meta.timedOut,published:meta.published===true,
  result:summary?.ok===true&&summary?.consumed===used&&summary?.crafted===used&&summary?.trips>=2&&summary?.bankEssence===0,
  logout:(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*logout/m.test(log),
  life:!/"died"/.test(log),
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),
  scope:'One staged practice account, 30 banked essence, Runecraft below 11, tick150 xpRate1. No live, unattended or speed claim.',
  checks,used,runecraftXp:after.skills[RC]!.xp,workerElapsedMs:meta.workerElapsedMs};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('insufficient practice startup reserve');
 const lock=resolve(import.meta.dir,'../../../.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'rune-bank-craft'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=workerSourceRevision(),name=runBotName('rbc',1);
  const botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);if(existsSync(botDir))throw Error('fresh account required');
  stack=await startStack({tickMs:150,xpRate:XP_RATE,readyTimeoutMs:60000});await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const path=await applyPreset(name,{position:{x:3013,z:3355,level:0},varps:{63:6,101:1,281:1000},
   bank:[{id:ESSENCE,count:STAGED},{id:AIR,count:25},{id:TALISMAN,count:1}],inventory:[{id:AIR,count:5}]});
  copyFileSync(path,join(directory,'before.sav'));
  const before=readPracticeSave(path),started=Date.now();
  const child=Bun.spawn(['bun','scripts/rune-bank-craft.ts',name,'99'],{cwd:resolve(import.meta.dir,'../../..'),
   env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'4000'},
   stdout:Bun.file(join(directory,'worker.log')),stderr:Bun.file(join(directory,'worker.err')),windowsHide:true});
  let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},600000);
  const code=await child.exited;clearTimeout(timer);await termination;
  const workerElapsedMs=Date.now()-started;
  const saved=await waitPracticeSave(path,s=>code!==0||sum(s,ESSENCE)===0&&s.skills[RC]!.rawExperience>before.skills[RC]!.rawExperience);
  copyFileSync(path,join(directory,'after.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),name,source,code,timedOut,published:saved.matched,workerElapsedMs},null,2));
  return verify(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through the delivery harness (DELIVERY_DIR)');
  const directory=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
