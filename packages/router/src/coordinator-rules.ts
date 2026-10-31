// Deterministic next jobs for qualified chains: no model call. The coordinator runs these rules every tick before the
// planner, so a failed or slow planner does not stop a proven chain at its next step (research/community-and-upstream.md
// section 8.6, change 2). A rule only adds ordinary run records; admission, memory, review and recovery checks apply.
// The planner keeps new capabilities, builds, repairs, supply and every case a rule cannot decide.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {addTasks,boundAccounts,type CoordinatorState,type CoordTask,type TaskRecord} from './coordinator';

export const RULES={
 'next-band':{
  trigger:'The newest finished live run of a capability succeeded within CHAIN_FRESH_MS with a single skill target, on one ordinary account, with no supply run of another capability in its dependencies (the worker buys or holds its own inputs).',
  acceptance:'The same skill reaches the next band: the next method unlock at least MIN_BAND_STEP levels above the reached level, else BAND_STEP levels, at most 99.',
 },
} as const;
export type RuleId=keyof typeof RULES;
export const MIN_BAND_STEP=5,BAND_STEP=10,MAX_LEVEL=99;
// A chain continues only from a fresh result; an older one leaves the account to the planner.
export const CHAIN_FRESH_MS=24*60*60*1000;
const PROTECTED=['haggis','shaftshooter','polevaulter'];
// A supply or repair run in a chain's dependencies says its inputs were moved in for that band only.
const NEUTRAL_DEPENDENCIES=new Set(['session-recovery-only']);
export interface RuleDeps{
 /** Current delivery fingerprint of a capability; throws when its source cannot be read. */
 fingerprint:(capability:string)=>string;
 /** Method unlock levels of a skill (knowledge/skills.json). */
 unlocks:(skill:string)=>number[];
 /** Last observed level of an account's skill, if known. */
 level:(account:string,skill:string)=>number|undefined;
 /** An owner stop file holds the account. */
 paused:(account:string)=>boolean;
 /** Open rule tasks never exceed this (the live limit). */
 maxOpen:number;
}
const at=(r:TaskRecord)=>r.receipt?.at??0;
const finished=(r:TaskRecord)=>(r.status==='succeeded'||r.status==='failed')&&!!r.receipt;
/** Newest succeeded build or qualify whose native delivery matches the current source; null when none. */
export function currentQualification(state:CoordinatorState,capability:string,source:string):TaskRecord|null{
 return state.tasks.filter(r=>r.status==='succeeded'&&(r.spec.kind==='build'||r.spec.kind==='qualify')&&r.spec.capability===capability
  &&r.receipt?.output?.delivery?.ok===true&&r.receipt.output.delivery.source===source).sort((a,b)=>at(b)-at(a))[0]??null;
}
/** True when the newest review verdict of a capability (a review task or a build's paired review) approved it. */
export function reviewApproved(state:CoordinatorState,capability:string){
 const verdict=state.tasks.filter(r=>r.spec.capability===capability&&(r.spec.kind==='review'||r.spec.kind==='build')&&finished(r)&&typeof r.receipt?.output?.review?.approved==='boolean')
  .sort((a,b)=>at(b)-at(a))[0];
 return verdict?.receipt?.output?.review?.approved===true;
}
/** The next target of a skill band, or null at the level cap. */
export function nextBand(reached:number,unlocks:readonly number[]){
 if(reached>=MAX_LEVEL)return null;
 const unlock=unlocks.filter(n=>Number.isSafeInteger(n)&&n>=reached+MIN_BAND_STEP).sort((a,b)=>a-b)[0];
 return Math.min(MAX_LEVEL,unlock??reached+BAND_STEP);
}
/** Copy a run spec with its skill target moved from one level to another. Null when the worker takes no level input. */
export function retarget(spec:CoordTask,skill:string,from:number,to:number){
 const level=String(from);let moved=false;
 const args=spec.args?.map(a=>a===level?(moved=true,String(to)):a);
 const env=spec.env&&Object.fromEntries(Object.entries(spec.env).map(([k,v])=>/LEVEL|TARGET/i.test(k)&&v===level?(moved=true,[k,String(to)]):[k,v]));
 return moved?{args,env,accept:{skills:{[skill]:to}}}:null;
}
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
/** Add the rule-derived next jobs. Returns the new tasks (empty when no rule can decide). */
export function applyRules(state:CoordinatorState,deps:RuleDeps,now=Date.now()):CoordTask[]{
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 const open=state.tasks.filter(r=>r.status==='pending'||r.status==='running');
 let openRuleTasks=open.filter(r=>r.spec.rule).length;
 const added:CoordTask[]=[],ids=new Set(state.tasks.map(r=>r.spec.id));
 const capabilities=[...new Set(state.tasks.filter(r=>r.spec.kind==='run'&&r.spec.capability).map(r=>r.spec.capability!))];
 for(const capability of capabilities){
  if(openRuleTasks>=deps.maxOpen)break;
  // One rule output failing stops the rule for this capability: the newest finished run is then not a success, until
  // the planner or the owner queues a run that succeeds.
  const last=state.tasks.filter(r=>r.spec.kind==='run'&&r.spec.capability===capability&&finished(r)).sort((a,b)=>at(b)-at(a))[0];
  if(!last||last.status!=='succeeded'||last.receipt?.output?.evidence!=='live'||now-at(last)>CHAIN_FRESH_MS)continue;
  const spec=last.spec,targets=Object.entries(spec.accept?.skills??{});
  if(targets.length!==1||Object.keys(spec.accept?.bank??{}).length||spec.accept?.quests?.length||Object.keys(spec.accept?.counters??{}).length)continue;
  if(spec.participants||spec.sessionRecovery||spec.launch&&spec.launch!=='ordinary')continue;
  const names=boundAccounts(spec,state);if(names?.length!==1)continue;
  const account=names[0]!;
  if(PROTECTED.includes(account.toLowerCase())||deps.paused(account))continue;
  if(spec.dependsOn.some(id=>{const dep=records.get(id);return dep?.spec.kind==='run'&&dep.spec.capability!==capability&&!NEUTRAL_DEPENDENCIES.has(dep.spec.capability!);}))continue;
  // No second open run of the same capability on the same account, from any source.
  if(open.some(r=>r.spec.kind==='run'&&r.spec.capability===capability&&(boundAccounts(r.spec,state)??[]).some(n=>n.toLowerCase()===account.toLowerCase())))continue;
  let source:string;try{source=deps.fingerprint(capability);}catch{continue;}
  const qualification=currentQualification(state,capability,source);
  if(!qualification||!reviewApproved(state,capability))continue;
  const [skill,target]=targets[0]!;
  const reached=Math.max(target,deps.level(account,skill)??0);
  const next=nextBand(reached,deps.unlocks(skill));if(next===null)continue;
  const moved=retarget(spec,skill,target,next);if(!moved)continue;
  let id=`chain-${slug(capability)}-${slug(account)}-${slug(skill)}${next}`;
  for(let n=2;ids.has(id);n++)id=`chain-${slug(capability)}-${slug(account)}-${slug(skill)}${next}-${n}`;
  const task:CoordTask={id,goal:spec.goal,kind:'run',capability,account,dependsOn:[qualification.spec.id,last.spec.id],
   priority:spec.priority,estimatedMs:spec.estimatedMs,...(spec.timeoutMs?{timeoutMs:spec.timeoutMs}:{}),
   ...(moved.args?{args:moved.args}:{}),...(moved.env?{env:moved.env}:{}),accept:moved.accept,rule:'next-band',
   why:`Rule next-band: ${last.spec.id} reached ${skill} ${reached} live on ${account} with qualification ${qualification.spec.id} at the current source and an approved review. This run takes ${skill} to ${next} with the same worker inputs and budgets. Consumer: the ${skill} board entry for ${account}; the next band follows by the same rule.`};
  // One capability's invalid output must not stop the rules for the others.
  try{addTasks(state,[task],now);}catch{continue;}
  ids.add(id);added.push(task);openRuleTasks++;
 }
 return added;
}
/** Method unlock levels per skill from knowledge/skills.json. */
export function skillUnlocks(base:string){
 const rows=JSON.parse(readFileSync(join(base,'knowledge/skills.json'),'utf8')) as {skill?:string;level?:number}[];
 const by=new Map<string,number[]>();
 for(const r of rows)if(typeof r.skill==='string'&&Number.isSafeInteger(r.level))by.set(r.skill.toLowerCase(),[...(by.get(r.skill.toLowerCase())??[]),r.level!]);
 return(skill:string)=>by.get(skill.toLowerCase())??[];
}
