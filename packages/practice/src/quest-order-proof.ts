import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {createHash} from 'node:crypto';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {questSpec,questSavedChecks,savedQuest,questCompleted,runQuestOrder,questOrderRuntime} from '../../../scripts/quest-order';
import {workerSourceRevision} from '../../core/src/worker-release';

// Native practice for scripts/quest-order.ts: fresh completion, two recovery boundaries and pre-login refusals.
// The consumer stage reads only retained saves, journals and logs.
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
const QUEST='cook',LEFTOVER=1351; // bronze axe: a non-quest pack item the order must bank
const result=(log:string)=>{
 try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_ORDER_RESULT ')).at(-1)?.slice('QUEST_ORDER_RESULT '.length)??'null');}
 catch{return null;}
};
const noLogin=(r:Run)=>!/^START /m.test(r.log)&&!/^LOGOUT /m.test(r.log);
export function questOrderChecks(p:{before:Save;after:Save;rerunAfter:string;afterHash:string;missBefore:string;missAfter:string;order:Run;missing:Run;rerun:Run}){
 const spec=questSpec(QUEST),summary=result(p.order.log),miss=result(p.missing.log),again=result(p.rerun.log);
 const saved=savedQuest(p.after,spec),child=summary?.stages?.quest,bank=summary?.stages?.bank;
 return{
  ...questSavedChecks(spec,p.before,p.after),
  leftover:(p.before.inventories[93]??[]).some(i=>i.id===LEFTOVER),
  order:p.order.code===0&&summary?.ok===true&&summary?.quest===spec.key&&summary?.saved?.done===true&&summary?.saved?.progress===saved.progress&&summary?.saved?.qp===saved.qp,
  stages:child?.ok===true&&child?.code===0&&/^RESULT ok(?: |$)/.test(child?.result??'')&&bank?.ok===true&&Number.isSafeInteger(bank?.banked)&&bank.banked>=1,
  // The quest child and the bank session each confirm their own logout.
  logout:(p.order.log.match(/^LOGOUT logged-out$/gm)??[]).length===2&&!/WARN logout did not complete/.test(p.order.log),
  missing:p.missing.code!==0&&miss?.ok===false&&/^missing item /.test(miss?.refused??'')&&miss?.login===false&&noLogin(p.missing)&&p.missBefore===p.missAfter,
  rerun:p.rerun.code!==0&&again?.ok===false&&again?.refused==='quest already complete'&&again?.login===false&&noLogin(p.rerun)&&p.rerunAfter===p.afterHash,
 };
}

// Retained saves and logs are evaluated again by the independent consumer stage.
export function questRecoveryChecks(p:{before:Save;after:Save;interrupted?:Save;first:Run;resume?:Run;rerun:Run;afterHash:string;rerunHash:string}){
 const spec=questSpec(QUEST),first=result(p.first.log),done=result((p.resume??p.first).log),again=result(p.rerun.log);
 const logouts=(r:Run,n:number)=>(r.log.match(/^LOGOUT logged-out$/gm)??[]).length===n&&!/^WARN .*?(?:logout|session close)/m.test(r.log);
 const saved=savedQuest(p.after,spec);
 return{
  ...questSavedChecks(spec,p.before,p.after),
  completed:done?.ok===true&&done?.saved?.progress===saved.progress&&done?.saved?.qp===saved.qp&&done?.stages?.completion?.matched===true,
  child:p.resume?first?.stages?.quest?.ok===true&&done?.stages?.quest?.ok===true:first?.stages?.quest?.ok===false&&first?.stages?.quest?.code!==0,
  childLogout:done?.stages?.quest?.logout===true,
  bank:done?.stages?.bank?.ok===true&&done?.stages?.bank?.logout===true&&(p.resume??p.first).code===0,
  interruption:!p.resume||!!p.interrupted&&questCompleted(spec,p.before,p.interrupted)&&!questSavedChecks(spec,p.before,p.interrupted).banked&&p.first.code!==0&&first?.failed==='bank'&&first?.stages?.bank?.ok===false&&first?.stages?.bank?.logout===true,
  resume:!p.resume||done?.stages?.resumed===true&&!/^MILESTONE /m.test(p.resume.log)&&logouts(p.resume,1)&&(p.resume.log.match(/^START /gm)??[]).length===1,
  logout:logouts(p.first,2),
  rerun:p.rerun.code!==0&&again?.refused==='quest already complete'&&again?.login===false&&noLogin(p.rerun)&&p.afterHash===p.rerunHash,
 };
}

export function questJournalChecks(p:{pending:any;settled:any;before:Save;account:string}){
 const {pending,settled,before,account}=p;
 const bound=(r:any)=>r?.version===1&&r?.account===account&&r?.quest===QUEST&&r?.server==='localhost:8888'&&typeof r?.save==='string'&&r.save.toLowerCase().endsWith(account+'.sav')&&JSON.stringify(r?.before)===JSON.stringify(before);
 return{pending:bound(pending)&&pending.state==='pending'&&pending.child?.logout===true&&pending.bank?.ok===false&&pending.bank?.logout===true,
  settled:bound(settled)&&settled.state==='settled'&&settled.bank?.ok===true&&settled.bank?.logout===true,
  retained:JSON.stringify(pending?.child)===JSON.stringify(settled?.child)&&pending?.save===settled?.save};
}

const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function verify(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const log=(label:string)=>readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8');
 const recovery=(label:string,resume=false)=>questRecoveryChecks({before:readPracticeSave(join(directory,label+'-before.sav')),after:readPracticeSave(join(directory,label+'-after.sav')),
  interrupted:resume?readPracticeSave(join(directory,label+'-interrupted.sav')):undefined,
  first:{code:meta[label+'Code'],log:log(label)},resume:resume?{code:meta.resumeCode,log:log('resume')}:undefined,
  rerun:{code:meta[label+'RerunCode'],log:log(label+'-rerun')},afterHash:hash(join(directory,label+'-after.sav')),rerunHash:hash(join(directory,label+'-rerun-after.sav'))});
 const checks={...questOrderChecks({before:readPracticeSave(join(directory,'before.sav')),after:readPracticeSave(join(directory,'after.sav')),
  rerunAfter:hash(join(directory,'rerun-after.sav')),afterHash:hash(join(directory,'after.sav')),
  missBefore:hash(join(directory,'missing-before.sav')),missAfter:hash(join(directory,'missing-after.sav')),
  order:{code:meta.orderCode,log:log('order')},missing:{code:meta.missingCode,log:log('missing')},rerun:{code:meta.rerunCode,log:log('rerun')}}),
  ...Object.fromEntries(Object.entries(recovery('child-fail')).map(([k,v])=>['childFailure_'+k,v])),
  ...Object.fromEntries(Object.entries(recovery('bank-fail',true)).map(([k,v])=>['bankResume_'+k,v])),
  ...Object.fromEntries(Object.entries(questJournalChecks({pending:JSON.parse(readFileSync(join(directory,'bank-fail-pending.json'),'utf8')),settled:JSON.parse(readFileSync(join(directory,'bank-fail-settled.json'),'utf8')),before:readPracticeSave(join(directory,'bank-fail-before.sav')),account:meta.names[3]})).map(([k,v])=>['journal_'+k,v])),
  unrelated:meta.unrelatedCode!==0&&result(log('unrelated'))?.refused==='quest already complete'&&result(log('unrelated'))?.login===false&&noLogin({code:meta.unrelatedCode,log:log('unrelated')})&&hash(join(directory,'unrelated-before.sav'))===hash(join(directory,'unrelated-after.sav')),
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,source:meta.source,
  scope:"Native150ms/25x: staged Cook's Assistant, child failure after completion, bank failure and bank-only resume, exact saved varp/QP/assets, logout and pre-login refusals. Boundary failures are injected by this proof around real sessions. No live, unattended or other-quest claim."};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(directory:string){
 if(freemem()/2**30<12)throw Error('practice needs 8GiB floor plus 4GiB startup reserve');
 const lock=resolve(import.meta.dir,'../../../.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'quest-order',directory,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 const command=async(args:string[],label:string):Promise<Run>=>{
  const out=join(directory,label+'.log'),err=join(directory,label+'.err');
  const child=Bun.spawn(['bun',...args],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0'},stdout:Bun.file(out),stderr:Bun.file(err),windowsHide:true});
  let expired=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},420000);
  const code=await child.exited;clearTimeout(timer);await termination;
  return{code:expired?-1:code,log:readFileSync(out,'utf8')+readFileSync(err,'utf8')};
 };
 try{
  const source=workerSourceRevision(),names=['qcook','qmiss','qchild','qbank','qdone'].map((prefix,i)=>runBotName(prefix,i+1));
  stack=await startStack({tickMs:150,readyTimeoutMs:60000});
  const paths:string[]=[];
  for(const [i,name] of names.entries()){
   const botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);if(existsSync(botDir))throw Error('fresh account required');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
   // The missing-item account lacks the pot of flour.
   const pack=(i===1?[1944,1927]:i===4?[LEFTOVER]:[1944,1927,1933,LEFTOVER]).map(id=>({id,count:1}));
   paths.push(await applyPreset(name,{position:{x:3208,z:3214,level:0},inventory:[...pack,{id:995,count:37}],
    bank:[{id:LEFTOVER,count:2},{id:995,count:100},{id:1511,count:8}],equipment:[{id:1205,count:1,slot:3}],
    varps:i===4?{29:2,101:1}:{}}));
  }
  copyFileSync(paths[0]!,join(directory,'before.sav'));copyFileSync(paths[1]!,join(directory,'missing-before.sav'));
  const order=(i:number,label:string)=>command(['scripts/quest-order.ts',names[i]!,QUEST,`--save=${paths[i]}`,'--timeout-ms=300000'],label);
  const missing=await order(1,'missing');copyFileSync(paths[1]!,join(directory,'missing-after.sav'));
  const done=await order(0,'order');copyFileSync(paths[0]!,join(directory,'after.sav'));
  const rerun=await order(0,'rerun');copyFileSync(paths[0]!,join(directory,'rerun-after.sav'));
  const codes:Record<string,number>={};
  for(const [i,label] of [[2,'child-fail'],[3,'bank-fail']] as const){
   copyFileSync(paths[i]!,join(directory,label+'-before.sav'));
   const failed=await command(['packages/practice/src/quest-order-proof.ts','--boundary',label,names[i]!,paths[i]!],label);codes[label+'Code']=failed.code;
   if(label==='bank-fail'){
    copyFileSync(paths[i]!,join(directory,label+'-interrupted.sav'));
    copyFileSync(paths[i]!+'.quest-order.json',join(directory,label+'-pending.json'));
    codes.resumeCode=(await order(i,'resume')).code;
    copyFileSync(paths[i]!+'.quest-order.json',join(directory,label+'-settled.json'));
   }
   copyFileSync(paths[i]!,join(directory,label+'-after.sav'));
   codes[label+'RerunCode']=(await order(i,label+'-rerun')).code;
   copyFileSync(paths[i]!,join(directory,label+'-rerun-after.sav'));
  }
  copyFileSync(paths[4]!,join(directory,'unrelated-before.sav'));
  codes.unrelatedCode=(await order(4,'unrelated')).code;copyFileSync(paths[4]!,join(directory,'unrelated-after.sav'));
  writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,names,quest:QUEST,orderCode:done.code,missingCode:missing.code,rerunCode:rerun.code,...codes},null,2));
  return verify(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}

if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through bun run deliver quest-order');
  if(process.argv[2]==='--boundary'){
   const [, , ,boundary,name,path]=process.argv;
   if(!name||!path||!['child-fail','bank-fail'].includes(boundary??''))throw Error('invalid proof boundary');
   const runtime={...questOrderRuntime,
    child:async(...args:Parameters<typeof questOrderRuntime.child>)=>{const child=await questOrderRuntime.child(...args);return boundary==='child-fail'&&child.ok?{...child,ok:false,code:1,result:'RESULT fail injected after confirmed child completion'}:child;},
    bank:(name:string,spec:Parameters<typeof questOrderRuntime.bank>[1])=>questOrderRuntime.bank(name,boundary==='bank-fail'?{...spec,deadlineTicks:0}:spec)};
   const report=await runQuestOrder(name,QUEST,{save:path,timeoutMs:300000},runtime);
   console.log('QUEST_ORDER_RESULT '+JSON.stringify(report));process.exitCode=report.ok?0:1;
  }else{
   const directory=resolve(process.env.DELIVERY_DIR);
   process.exitCode=(process.argv[2]==='--verify'?verify(directory):await run(directory)).ok?0:1;
  }
 }catch(error){console.error(String(error));process.exitCode=1;}
}
