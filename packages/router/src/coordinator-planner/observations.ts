import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import type {TaskRecord} from '../coordinator';
import {projectRoot} from '../coordinator-store';
import {readFreshControllerState} from '../coordinator-live';
import {FLEET_DIR,mySide} from '../../../core/src/fleet';
import {fleetStatusRows,ownerOfIn,readSnapshotFiles} from '../../../core/src/fleet-snapshots';
import {readLogoutProof} from '../../../core/src/session-lifecycle';
import type {RecoveryPlanningProblem} from '../../../../scripts/cloud-recover';

export function readPlannerControllerCapacity(base=projectRoot,now=Date.now()){
 try{
  const owner=JSON.parse(readFileSync(join(base,'.practice/coordinator/swarm-owner.json'),'utf8'));
  if(!Number.isSafeInteger(owner?.pid)||owner.pid<=0||typeof owner.nonce!=='string'||!owner.nonce)return null;
  const state=readFreshControllerState(owner,base,now);
  if(!state)return null;
  const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
  const memory=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  return{at:state.at,running:count(state.running),externalRunning:count(state.externalRunning),
   pendingStartup:count(state.pendingStartup),pendingReserveGB:memory(state.pendingReserveGB),
   freeGB:memory(state.freeGB),minFreeGB:memory(state.minFreeGB),maxBots:count(state.maxBots)};
 }catch{return null;}
}

export function readPlannerStatuses(base=projectRoot,fleetDir=FLEET_DIR(),side=mySide()){
 const dir=join(base,'.practice/status'),ownerOf=ownerOfIn(fleetDir);
 const local=existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.json')).flatMap(f=>{
  try{const s=JSON.parse(readFileSync(join(dir,f),'utf8'));
   return typeof s?.name==='string'&&s.name.toLowerCase()===f.slice(0,-5).toLowerCase()
    &&typeof s.server==='string'&&s.server.toLowerCase()==='rs-sdk-demo.fly.dev'&&!s.practice?[s]:[];
  }catch{return [];}
 }):[];
 const byName=new Map(local.map(s=>[s.name.toLowerCase(),s]));
 return fleetStatusRows(local,readSnapshotFiles(join(fleetDir,'snapshots')),ownerOf,side)
  .filter(s=>(ownerOf(s.name)??s.side)===side).map(s=>{
   const current=byName.get(s.name.toLowerCase()),isLocal=s.side===side&&current?.at===s.at&&current!==undefined;
   return{
    name:s.name,server:s.server,side,at:s.at,observation:isLocal?'local-status':'fleet-snapshot',snapshotOnly:!isLocal,
    skills:s.skills,quests:Array.isArray(s.questJournal)?s.questJournal:s.quests,questsAt:s.questsAt,
    inventory:s.inventory,bank:s.bank,bankAt:s.bankAt,equipment:s.equipment,equipmentObserved:s.equipmentObserved,
    hp:s.hp,pos:s.pos,combat:s.combat,guildFacts:s.guildFacts,
    // Shared snapshots describe saved account facts, never another container's executing session.
    ...(isLocal?{result:current.result,started:current.started,sessionAttemptId:current.sessionAttemptId,
     workRevision:current.workRevision,workEntry:current.workEntry,goal:current.goal,tick:current.tick,
     counters:current.counters,ledger:current.ledger}:{}),
   };
  });
}

export function readRecoveryProblems(base:string,ended:Record<string,{at:number}>,tasks:readonly TaskRecord[]=[]):Array<RecoveryPlanningProblem&{evidence:string}>{
 const dir=join(base,'.practice/cloud-recover/planning');
 if(!existsSync(dir))return [];
 const current=new Map(Object.entries(ended).map(([name,end])=>[name.toLowerCase(),end.at]));
 const selected=new Map<string,RecoveryPlanningProblem&{evidence:string}>();
 const records=new Map(tasks.map(task=>[task.spec.id,task]));
 const deliveredAt=tasks.reduce((at,task)=>task.status==='succeeded'&&task.spec.capability==='session-recovery-only'
  &&task.receipt?.output?.delivery?.ok===true?Math.max(at,task.receipt.at):at,0);
 const files=readdirSync(dir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).flatMap(name=>{
  try{const stat=statSync(join(dir,name));return stat.isFile()&&stat.size<=32_768?[{name,at:stat.mtimeMs}]:[];}catch{return [];}
 }).sort((a,b)=>b.at-a.at).slice(0,512);
 for(const {name}of files){
  try{
   const row=JSON.parse(readFileSync(join(dir,name),'utf8')) as RecoveryPlanningProblem;
   if(row.schema!=='recovery-planning/1'||typeof row.account!=='string'||typeof row.server!=='string'
    ||!Array.isArray(row.failures)||!Array.isArray(row.pendingTaskIds)||typeof row.reason!=='string'
    ||!row.lineage||(row.endedAt===null?current.has(row.account.toLowerCase()):current.get(row.account.toLowerCase())!==row.endedAt)
    ||selected.has(row.account.toLowerCase()))continue;
   if(readLogoutProof(row.account,row.server,{root:join(base,'.practice/session-lifecycle')}).state==='confirmed')continue;
   const failures=row.failures.filter(f=>{
    const retained=typeof f.settledAt==='number'&&Number.isFinite(f.settledAt)&&f.settledAt>0?f.settledAt:Infinity;
    const record=records.get(f.taskId),at=record?record.receipt?.at??Infinity:retained;
    return !(deliveredAt>at);
   });
   if(row.failures.length&&!failures.length)continue;
   selected.set(row.account.toLowerCase(),{...row,reason:row.reason.slice(0,600),failures:failures.slice(0,8),
    pendingTaskIds:row.pendingTaskIds.slice(0,24),evidence:'.practice/cloud-recover/planning/'+name});
   if(selected.size>=32)break;
  }catch{/* A partial or unreadable fact cannot replace the ended account's source record. */}
 }
 return [...selected.values()];
}
