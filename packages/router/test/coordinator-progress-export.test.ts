import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initialState,type TaskRecord} from '../src/coordinator';
import {workerSourceRevision} from '../../core/src/worker-release';
import {summarizeProgress,exportProgress,acquireExporterLock,STALE_MS} from '../src/coordinator-progress';
const now=1793487000000;
function record(id:string,overrides:Partial<TaskRecord>={}):TaskRecord{return{spec:{id,goal:'wealth',kind:'run',capability:'earn',dependsOn:[],priority:1,estimatedMs:1000,why:'fixture',agent:'codex'},status:'pending',runId:'run-'+id,createdAt:now-10000,attempts:0,...overrides};}
function summarize(tasks:TaskRecord[],extra:any={}){
 const state=initialState();state.tasks=tasks;
 return summarizeProgress({side:'cloud',now,state:{value:state,observedAt:now-500},swarm:{value:{at:now-100,running:1,jobs:[]},observedAt:now-100},owner:{value:{pid:10},observedAt:now-1000},paused:false,process:()=> 'unknown',...extra});
}
const receipt=(id:string,evidence:string,at=now-500)=>({taskId:id,runId:'run-'+id,ok:true,at,output:{ok:true,evidence}});
test('model attribution reports current records without claiming verified process ownership',()=>{
 const a=record('author',{status:'running',agent:'claude',pid:20,startedAt:now-1000});
 const b=record('runner',{status:'running',pid:21,startedAt:now-2000});
 const c=record('legacy',{status:'running',spec:{...record('legacy').spec,agent:undefined}});
 const out=summarize([a,b,c],{process:(pid:number)=>pid===20?'alive':pid===21?'dead':'unknown'});
 expect(out.workers.claude.running[0]).toMatchObject({id:'author',processState:'alive',processIdentity:'unverified',startedAt:now-1000});
 expect(out.workers.codex.running[0]).toMatchObject({id:'runner',processState:'dead',blocker:'recorded worker PID is gone'});
 expect(out.workers.unassigned.running[0].processState).toBe('unknown');
});
test('native checks, builds, failed runs and recovery are not useful live gameplay results',()=>{
 const live=record('live',{status:'succeeded',receipt:receipt('live','live',now-4000)});
 const native=record('native',{status:'succeeded',spec:{...record('native').spec,kind:'qualify'},receipt:receipt('native','native',now-2000)});
 const build=record('build',{status:'succeeded',spec:{...record('build').spec,kind:'build'},receipt:receipt('build','native',now-1000)});
 const bad=record('bad',{status:'failed',receipt:{...receipt('bad','live'),ok:false,error:'PASSWORD=never export this'}});
 const recovery=record('recover',{status:'succeeded',spec:{...record('recover').spec,sessionRecovery:{account:'Rod',endedAt:10}},receipt:receipt('recover','live')});
 const out=summarize([live,native,build,bad,recovery]);
 expect(out.workers.codex.lastUsefulLive?.id).toBe('live');expect(out.workers.codex.lastPreparation?.id).toBe('build');expect(out.workers.codex.lastRecovery?.id).toBe('recover');
 expect(JSON.stringify(out)).not.toContain('PASSWORD');
 expect(summarize([native,build,bad,recovery]).workers.codex.lastUsefulLive).toBeNull();
});
test('a future receipt and an output refusing useful acceptance cannot become progress',()=>{
 const future=record('future',{status:'succeeded',receipt:receipt('future','live',now+1)});
 const refused=record('refused',{status:'succeeded',receipt:{...receipt('refused','live'),output:{ok:false,evidence:'live'}}});
 const crossed=record('crossed',{status:'succeeded',receipt:receipt('another-task','live')});
 expect(summarize([future,refused,crossed]).workers.codex.lastUsefulLive).toBeNull();
});
test('pending dependencies retain failed, unfinished and missing blockers',()=>{
 const failed=record('failed',{status:'failed'}),waiting=record('waiting',{spec:{...record('waiting').spec,dependsOn:['failed','missing','busy']}}),busy=record('busy',{status:'running'});
 const out=summarize([failed,waiting,busy]);
 expect(out.workers.codex.pending[0]).toMatchObject({id:'waiting',status:'waiting-dependencies',dependencies:[{id:'failed',status:'failed'},{id:'missing',status:'missing'},{id:'busy',status:'running'}]});
 expect(summarize([record('ready')]).workers.codex.pending[0].status).toBe('queued');
});
test('a fresh export cannot freshen stale state or swarm observations',()=>{
 const state=initialState();state.tasks=[record('r',{status:'running',pid:7})];
 const out=summarize(state.tasks,{state:{value:state,observedAt:now-STALE_MS-1},swarm:{value:{at:now-STALE_MS-1,running:2,jobs:[]},observedAt:now-STALE_MS-1},paused:true});
 expect(out.exportedAt).toBe(now);expect(out.sources.state.stale).toBe(true);expect(out.swarm.observationStale).toBe(true);expect(out.coordinator.paused).toBe(true);expect(out.workers.codex.running[0].observationStale).toBe(true);
});
test('one-shot export preserves source bytes and exposes missing or unreadable observations',()=>{
 const root=mkdtempSync(join(tmpdir(),'progress-export-')),fleet=join(root,'fleet');
 try{
  const first=exportProgress(root,fleet,'cloud',now);expect(first.report.sources.state.error).toBe('missing');expect(first.report.swarm.reportedRunning).toBeNull();
  mkdirSync(join(root,'.practice'),{recursive:true});const path=join(root,'.practice/swarm-state.json'),body=JSON.stringify({at:now-STALE_MS-1,running:0,jobs:[{account:'Haggis',state:'disabled'},{account:'Rod',state:'running'}]});writeFileSync(path,body);
  const second=exportProgress(root,fleet,'cloud',now);expect(readFileSync(path,'utf8')).toBe(body);expect(second.report.swarm.observationStale).toBe(true);expect(second.report.swarm.jobs.map(j=>j.account)).toEqual(['Rod']);
  expect(JSON.parse(readFileSync(second.file,'utf8')).side).toBe('cloud');
  writeFileSync(path,'{invalid');expect(exportProgress(root,fleet,'cloud',now).report.sources.swarm.error).toBe('unreadable');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('singleton lock refuses another exporter and releases only its own bytes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'progress-lock-')),file=join(dir,'nested','owner');
 try{const release=acquireExporterLock(file);expect(()=>acquireExporterLock(file)).toThrow('lock exists');writeFileSync(file,'another owner');release();expect(readFileSync(file,'utf8')).toBe('another owner');rmSync(file);const release2=acquireExporterLock(file);release2();expect(existsSync(file)).toBe(false);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('deploying router progress tooling leaves the gameplay worker fingerprint unchanged',()=>{
 const root=mkdtempSync(join(tmpdir(),'progress-release-'));
 try{
  for(const path of ['scripts','packages','vendor/rs-sdk/sdk','vendor/rs-sdk/server/webclient/src'])mkdirSync(join(root,path),{recursive:true});
  for(const path of ['package.json','bun.lock','tsconfig.json'])writeFileSync(join(root,path),'{}');
  writeFileSync(join(root,'scripts/worker.ts'),'export const worker=1;');const before=workerSourceRevision(root);
  mkdirSync(join(root,'packages/router/src'),{recursive:true});
  writeFileSync(join(root,'packages/router/src/coordinator-progress.ts'),readFileSync(join(import.meta.dir,'../src/coordinator-progress.ts')));
  expect(workerSourceRevision(root)).toBe(before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
