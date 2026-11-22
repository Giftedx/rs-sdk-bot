import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {addTasks,deadRoots,provisionRefs,replaceTasks,type CapabilityChange,type CoordinatorState,type CoordTask} from '../coordinator';
import {validateDelivery,type DeliveryTask} from '../delivery';
import {projectRoot,publishCapabilityChanges} from '../coordinator-store';
import {repairModelTask} from './brief';

export function prepareProposal(state:CoordinatorState,raw:any,base=projectRoot,source:'manual'|'model'='manual'){
 if(!raw||typeof raw.reason!=='string'||!Array.isArray(raw.tasks)||!Array.isArray(raw.capabilities)||raw.tasks.length>12)throw Error('invalid planner proposal');
 const tasks:CoordTask[]=source==='model'?raw.tasks.map(repairModelTask):raw.tasks;
 const definitions=raw.capabilities as DeliveryTask[];
 if(new Set(definitions.map(d=>d.id)).size!==definitions.length)throw Error('duplicate proposed capability');
 const scope=(d:DeliveryTask)=>{validateDelivery(d);if(d.files.some(f=>! /^(scripts|packages\/(core|practice|planner))\//.test(f)))throw Error('capability scope must contain gameplay source/tests only');};
 for(const d of definitions){scope(d);if(existsSync(join(base,'packages/router/tasks',d.id+'.json')))throw Error('capability already exists: '+d.id);}
 const updates=(raw.capabilityUpdates??[]) as (CapabilityChange&{expectedSource:string})[];
 if(!Array.isArray(updates)||updates.length>1)throw Error('one owned capability update per proposal');
 for(const update of updates){
  scope(update.definition);const id=update.definition.id,file=join(base,'packages/router/tasks',id+'.json');
  if(!/^[a-f0-9]{64}$/.test(update.expectedSource)||!existsSync(file)||createHash('sha256').update(readFileSync(file)).digest('hex')!==update.expectedSource)throw Error('capability definition changed; re-read before update');
  if(state.tasks.some(r=>r.status==='running'&&r.spec.capability===id))throw Error('capability update waits for its current owner');
  if(!tasks.some(t=>t.kind==='build'&&t.capability===id))throw Error('capability update requires its own build and fresh delivery');
 }
 const known=new Set([...readdirSync(join(base,'packages/router/tasks')).map(f=>f.replace(/\.json$/,'')),...definitions.map(d=>d.id)]);
 for(const t of tasks)if(t.kind!=='provision'&&!known.has(t.capability!))throw Error('unknown capability: '+t.capability);
 // Validate the whole graph before writing any definition or changing state.
 const candidate=structuredClone(state);addTasks(candidate,tasks);
 for(const t of tasks)if(t.kind==='build'){
  const open=state.tasks.filter(r=>['pending','running'].includes(r.status)&&r.spec.kind==='build'&&r.spec.capability===t.capability);
  const blocking=open.filter(r=>r.status==='running'||!raw.replacements?.some((p:any)=>p.from===r.spec.id&&p.to===t.id));
  if(blocking.length)throw Error('replace existing build instead of duplicating it: '+t.capability+'; open builds: '+blocking.map(r=>r.spec.id+' ('+r.status+')').join(', ')+'. A pending build needs replacements:[{from:<open id>,to:"'+t.id+'"}]. A running build must finish first.');
 }
 if(raw.replacements!==undefined){
  if(!Array.isArray(raw.replacements)||raw.replacements.length>24||raw.replacements.some((r:any)=>typeof r?.from!=='string'||typeof r?.to!=='string'))throw Error('invalid replacements');
  replaceTasks(candidate,raw.replacements);
 }
 // Cancel obsolete pending work without removing prerequisites from surviving work.
 const cancellations:unknown=raw.cancel;
 if(cancellations!==undefined){
  if(!Array.isArray(cancellations)||cancellations.length>24||cancellations.some(c=>typeof c?.id!=='string'||c.use!==undefined&&typeof c.use!=='string'))throw Error('invalid cancel list');
  const cancelled=new Set<string>(cancellations.map(c=>c.id));
  if(cancelled.size!==cancellations.length)throw Error('duplicate cancellation');
  const byId=new Map(candidate.tasks.map(r=>[r.spec.id,r]));
  const surviving=candidate.tasks.filter(r=>r.status==='pending'&&!cancelled.has(r.spec.id));
  for(const c of cancellations){
   const old=byId.get(c.id);if(!old||old.status!=='pending')throw Error('cancel needs a pending task: '+c.id);
   if(c.use!==undefined){
    const substitute=byId.get(c.use);
    if(!substitute||substitute.status==='failed'||substitute.status==='superseded'||cancelled.has(c.use))throw Error('cancel needs a surviving substitute: '+c.use);
   }
   for(const r of surviving){
    if(provisionRefs(r.spec).includes(c.id))throw Error('cancel would leave an account reference from '+r.spec.id+' to '+c.id);
    if(!r.spec.dependsOn.includes(c.id))continue;
    if(c.use===undefined)throw Error('cancel needs a substitute for '+c.id+' used by '+r.spec.id);
    r.spec.dependsOn=[...new Set(r.spec.dependsOn.map(id=>id===c.id?c.use:id))];
   }
   old.status='superseded';old.supersededBy=c.use??'cancelled';
  }
 }
 // A changed contract must be built before any old consumer can request its
 // new (possibly not-yet-created) files or use its old qualification.
 for(const update of updates){
  const build=tasks.find(t=>t.kind==='build'&&t.capability===update.definition.id)!;
  for(const r of candidate.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'&&r.spec.capability===update.definition.id))r.spec.dependsOn=[...new Set([...r.spec.dependsOn,build.id])];
 }
 replaceTasks(candidate,[]); // Validate cycles introduced by promotion edges too.
 const newClaims=new Set(tasks.filter(t=>t.kind==='provision').map(t=>t.id));
 const builds=tasks.filter(t=>t.kind==='build');
 const dead=newClaims.size||builds.length?deadRoots(candidate):null;
 const pending=candidate.tasks.filter(r=>r.status==='pending'&&!dead?.has(r.spec.id));
 const runs=pending.filter(r=>r.spec.kind==='run');
 if(newClaims.size){
  const demanded=new Set(runs.flatMap(r=>provisionRefs(r.spec)));
  for(const {spec,status} of candidate.tasks){
   if(status==='pending'&&newClaims.has(spec.id)&&!demanded.has(spec.id))throw Error('account setup needs a viable first run: '+spec.id);
  }
 }
 if(builds.length){
  const byId=new Map(pending.map(r=>[r.spec.id,r.spec]));
  const visit=runs.map(r=>r.spec.id),reachable=new Set<string>();
  while(visit.length){
   const id=visit.pop()!,task=byId.get(id);
   if(!task||reachable.has(id))continue;
   reachable.add(id);visit.push(...task.dependsOn,...provisionRefs(task));
  }
  for(const build of builds)if(!reachable.has(build.id))throw Error('build requires a finite live consumer dependency: '+build.id+'. Link a pending run through pending dependencies with no terminal blockers.');
 }
 candidate.lastPlanReason=raw.reason;
 const capabilities:CapabilityChange[]=[...definitions.map(definition=>({definition,expectedSource:null})),
  ...updates.map(({definition,expectedSource})=>({definition,expectedSource}))];
 return {candidate,capabilities,count:tasks.length};
}

export function acceptProposal(state:CoordinatorState,raw:any,base=projectRoot,source:'manual'|'model'='manual'){
 const {candidate,capabilities,count}=prepareProposal(state,raw,base,source);
 publishCapabilityChanges(base,capabilities);
 Object.assign(state,candidate);
 return count;
}
