// Readiness is read-only with --check. Default writes a non-authorizing report.
// Only --authorize can issue login permission after all evidence passes.
import {readFileSync,readdirSync,existsSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {haggisActivities,haggisTravel,loadSnapshot,schedule,overallRequirementsFor,TRICKS,type Activity,type ScheduleResult} from '../packages/planner/src/haggis';
import {FLEET} from './fleet';
import {launchContext,readBound,sha,fresh,validateSupplies,validateRehearsals,type Binding} from '../packages/core/src/launch-evidence';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';

// The main goal is Overall rank 1 under the record (AGENTS.md), not all 24 boards. Overall must win by a 2% margin,
// and every activity that starts before the Overall finish must have MEASURED inputs: one still running then sets
// the finish rate. Work that starts after Overall does not gate it.
export function overallWins(plan:ScheduleResult,activities:Activity[]):string{
 const o=plan.boards.find(b=>b.id==='overall');
 if(!o||o.deadline===null||typeof o.finish!=='number'||!Number.isFinite(o.finish)||o.finish<=0)throw Error('Overall board missing or never finishes');
 const margin=Math.ceil(o.deadline*.02);
 if(o.status!=='WIN'||(o.slack??-1)<margin)throw Error(`Overall needs a ${margin}-tick margin: finish ${o.finish}, deadline ${o.deadline}, slack ${o.slack}`);
 const byId=new Map(activities.map(a=>[a.id,a]));
 const unmeasured=[...new Set(plan.order.filter(p=>p.start<o.finish!).map(p=>p.id))].filter(id=>{const a=byId.get(id);return !a||/"evidence":"(ESTIMATE|CODE-READ)"/.test(JSON.stringify(a))});
 if(unmeasured.length)throw Error(`${unmeasured.length} activities before Overall lack MEASURED inputs: ${unmeasured.slice(0,8).join(', ')}`);
 return `Overall wins by ${o.slack} ticks (margin ${margin}) with measured inputs`;
}

export function evaluateLaunch(root:string,snapshot:string,now=Date.now(),authorize=false){
 const bindings:Binding[]=[],gates:{name:string;pass:boolean;detail:string}[]=[];
 let context='',expected:Record<string,number>={},requirements:{item:string;count:number}[]=[],expiresAt=now+600000;
 const read=(path:string)=>{const raw=readFileSync(join(root,path));bindings.push({path,sha256:sha(raw)});return JSON.parse(raw.toString())};
 const bound=(ref:Binding,json=true)=>readBound(root,ref,bindings,json);
 const check=(name:string,fn:()=>string)=>{try{gates.push({name,pass:true,detail:fn()})}catch(e){gates.push({name,pass:false,detail:String(e).slice(0,300)})}};
 check('plan wins',()=>{
  const c=launchContext(root,snapshot);context=c.context;bindings.push(...c.bindings);
  const opts={travel:haggisTravel(),mode:'realistic' as const,tricks:new Set(TRICKS)};
  const activities=haggisActivities(),targets=loadSnapshot(join(root,snapshot)),plan=schedule(targets,activities,opts);
  read('packages/planner/src/haggis-boards.json');
  const detail=overallWins(plan,activities);
  for(const b of plan.boards)if(b.deadline!==null&&typeof b.finish==='number'&&Number.isFinite(b.finish)&&b.finish>0)expected[b.id]=b.finish;
  requirements=overallRequirementsFor(activities,opts,plan).supplies;return detail;
 });
 check('rehearsed',()=>{
  const dir=join(root,'.practice/rehearsals');
  const runs=readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>read('.practice/rehearsals/'+f)).sort((a,b)=>b.at-a.at).slice(0,3);
  expiresAt=Math.min(expiresAt,validateRehearsals(runs,context,expected,now,bound));return 'Three distinct full-clock rehearsals match current context and raw logs';
 });
 check('supplies staged',()=>{
  const s=read('.practice/haggis-supplies.json');
  const suppliesExpiry=validateSupplies(s,context,requirements,read('knowledge/items.json'),FLEET.filter(a=>a.role!=='main'&&a.server==='rs-sdk-demo.fly.dev').map(a=>a.name),now,bound);
  expiresAt=Math.min(expiresAt,suppliesExpiry);return 'Exact item reservations covered by owned delivery and bank receipts';
 });
 check('fresh targets',()=>{
  const s=read(snapshot),at=Date.parse(s.takenAt);
  if(!fresh(at,now,3600000)||s.base!=='https://rs-sdk-demo.fly.dev'||s.tickMs!==400)throw Error('Target observation missing, stale, future-dated or wrong server/tick units');
  expiresAt=Math.min(expiresAt,at+3600000);return 'Target observation is under one hour old';
 });
 check('machine clear',()=>{
  // Monitor is volatile: do not hash it into the token. Limit token lifetime to this observation.
  const m=JSON.parse(readFileSync(join(root,'.practice/monitor.json'),'utf8'));
  if(!fresh(m.at,now,120000)||!Array.isArray(m.alerts)||m.alerts.some((a:any)=>a.level!=='fixed')||!Number.isFinite(m.freeGB)||m.freeGB<FREE_FLOOR_GB)throw Error('Need recent monitor, no open alerts and 8 GiB free');
  expiresAt=Math.min(expiresAt,m.at+120000);return 'Recent monitor, no alerts, memory floor met';
 });
 const ready=gates.every(g=>g.pass);
 return {version:2,go:authorize&&ready,ready,at:now,expiresAt,context,snapshot,bindings:[...new Map(bindings.map(b=>[b.path,b])).values()],gates};
}
if(import.meta.main){
 const root=resolve(import.meta.dir,'..'),arg=process.argv.slice(2).find(a=>!a.startsWith('--'));
 const snapshot=arg?relative(root,resolve(arg)).replaceAll('\\','/'):'research/hiscores-live.json';
 const report=evaluateLaunch(root,snapshot,Date.now(),process.argv.includes('--authorize'));
 if(!process.argv.includes('--check')){
  mkdirSync(join(root,'.practice'),{recursive:true});const file=join(root,process.argv.includes('--authorize')?'.practice/haggis-go.json':'.practice/haggis-readiness.json'),tmp=file+'.'+process.pid+'.tmp';
  writeFileSync(tmp,JSON.stringify(report,null,2));renameSync(tmp,file);
 }
 for(const g of report.gates)console.log(`${g.pass?'PASS':'FAIL'}  ${g.name}: ${g.detail}`);
 console.log(report.go?'GO: evidence-bound main login authorized':report.ready?'READY: not authorized; explicit --authorize required':'NO-GO: main remains offline');
 process.exitCode=report.ready?0:1;
}
