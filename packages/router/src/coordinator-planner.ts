import {readFileSync,existsSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {join} from 'node:path';
import {GOALS,addTasks,replaceTasks,type CoordinatorState,type CoordTask} from './coordinator';
import {runModel,type ModelWorker} from './model-worker';
import {validateDelivery,type DeliveryTask} from './delivery';
import {freshScoreboard} from './coverage';
import {projectRoot,atomicJson} from './coordinator-store';
import {PRACTICE_STARTUP_GB} from '../../core/src/memory';

export function parseModelObject(text:string):any{
 const trimmed=text.trim(),fence=trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
 return JSON.parse(fence?fence[1]!:trimmed);
}
export const GAME_SKILLS=['Attack','Defence','Strength','Hitpoints','Ranged','Prayer','Magic','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Runecraft'];
export function gameCoverage(methods:any[],quests:any[],statuses:any[],protectedNames:string[],scripts:string[]){
 const ordinary=statuses.filter(s=>!protectedNames.some(n=>n.toLowerCase()===s.name?.toLowerCase()));
 return{scope:'Pinned server content; script presence and saved skill levels are discovery, not live automation coverage.',
  skills:GAME_SKILLS.map(name=>({name,cataloguedMethods:methods.filter(m=>m.skill===name.toLowerCase()).length,
   bestObserved:ordinary.flatMap(s=>(s.skills??[]).filter((v:any)=>v.name?.toLowerCase()===name.toLowerCase()).map((v:any)=>({account:s.name,level:v.level,at:s.at}))).sort((a:any,b:any)=>b.level-a.level)[0]??null})),
  questCount:quests.length,quests:quests.map(q=>({key:q.varp,folder:q.folder,questPoints:q.questPoints,source:q.src})),
  scriptCandidates:scripts,methodCount:methods.length,
  otherGoals:['wealth and market logistics','quest access and travel unlocks','equipment and combat','items and collection','specialist records','main simultaneous24'],
  unknown:'Catalogue extraction is incomplete. Zero methods means inspect pinned content, not unavailable. Presence, native proof, live pilot and repeat qualification are separate states.'};
}
export function queueFacts(state:CoordinatorState){
 const records=new Map(state.tasks.map(r=>[r.spec.id,r]));
 return{lastUsefulLiveAt:Math.max(0,...state.tasks.filter(r=>r.spec.kind==='run'&&r.status==='succeeded').map(r=>r.receipt?.at??0)),
  blocked:state.tasks.filter(r=>r.status==='pending').map(r=>({id:r.spec.id,goal:r.spec.goal,capability:r.spec.capability,
   dependencies:r.spec.dependsOn.filter(id=>records.get(id)?.status!=='succeeded').map(id=>({id,status:records.get(id)?.status??'missing',replacement:records.get(id)?.supersededBy}))})).filter(r=>r.dependencies.length),
  active:state.tasks.filter(r=>r.status==='pending'||r.status==='running').map(r=>({spec:briefSpec(r.spec),status:r.status}))};
}
// The prompt carries each task's decision fields and the start of its work order; the full spec, receipts and logs stay
// in .practice/coordinator/state.json and runs/<runId>/ (full specs made the prompt 450,000 characters; research/bot-host.md "Isolated build workspaces").
const clip=(text:unknown,n:number)=>typeof text==='string'&&text.length>n?text.slice(0,n)+'...':text;
export function briefSpec(spec:CoordTask){
 const {why,env,args,...rest}=spec as any;
 return{...rest,why:clip(why,200),...(env?{env:Object.keys(env)}:{}),...(args?{args:args.length}:{})};
}
export function readWorld(){
 const plan=JSON.parse(readFileSync(join(projectRoot,'swarm.json'),'utf8'));
 const dir=join(projectRoot,'.practice/status'),statuses:any[]=[];
 if(existsSync(dir))for(const file of readdirSync(dir)){
  if(!file.endsWith('.json'))continue;
  try{const s=JSON.parse(readFileSync(join(dir,file),'utf8'));if(s.server==='rs-sdk-demo.fly.dev')statuses.push({name:s.name,at:s.at,result:s.result,started:s.started,workRevision:s.workRevision,goal:s.goal,skills:s.skills,quests:s.quests,questsAt:s.questsAt,inventory:s.inventory,bank:s.bank,bankAt:s.bankAt,equipment:s.equipment,hp:s.hp,pos:s.pos,counters:s.counters});}catch{}
 }
 const protectedNames=plan.jobs.filter((j:any)=>!j.script||/fresh.clock|main simultaneous|24 boards/i.test(j.goal??'')).flatMap((j:any)=>j.accounts??[j.account]).filter(Boolean);
 const capabilities=readdirSync(join(projectRoot,'packages/router/tasks')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(projectRoot,'packages/router/tasks',f),'utf8')));
 const capabilitySources=Object.fromEntries(capabilities.map(d=>[d.id,createHash('sha256').update(readFileSync(join(projectRoot,'packages/router/tasks',d.id+'.json'))).digest('hex')]));
 const ended=existsSync(join(projectRoot,'.practice/swarm-deaths.json'))?JSON.parse(readFileSync(join(projectRoot,'.practice/swarm-deaths.json'),'utf8')):{};
 const scripts:string[]=[];const walk=(path:string)=>{for(const f of readdirSync(join(projectRoot,path),{withFileTypes:true})){const file=path+'/'+f.name;if(f.isDirectory()&&!['measure'].includes(f.name))walk(file);else if(f.isFile()&&f.name.endsWith('.ts')&&!f.name.endsWith('.test.ts'))scripts.push(file);}};walk('scripts');
 const coverage=gameCoverage(JSON.parse(readFileSync(join(projectRoot,'knowledge/skills.json'),'utf8')),JSON.parse(readFileSync(join(projectRoot,'knowledge/quests.json'),'utf8')),statuses,protectedNames,scripts.sort());
 let scoreboard:any=null;try{scoreboard=scoreboardSummary(freshScoreboard(projectRoot));}catch(error){scoreboard={error:String(error)};}
 let stall:any=null;try{const f=join(projectRoot,'.practice/coordinator/stall.json');if(existsSync(f))stall=JSON.parse(readFileSync(f,'utf8'));}catch{/* no stall note */}
 return{at:Date.now(),scoreboard,stall,assets:assetSummary(statuses),executionDirective:plan.coordination?.directive??'',deliveryFocus:plan.coordination?.focusCapability??null,capacity:{maxBots:plan.maxBots,minFreeGB:plan.minFreeGB,freeGB:freemem()/2**30,nativeStartupGB:PRACTICE_STARTUP_GB,maxLive:plan.coordination?.maxLive??plan.maxBots,preferLive:plan.coordination?.preferLive===true},protectedNames,jobs:plan.jobs,statuses,ended,capabilities,capabilitySources,coverage};
}
// Coins and the large stacks each named account holds (inventory, worn and last seen bank), so plans spend and
// convert owned stock: logs to Firemaking, essence to Runecraft, bows and shafts to Ranged, coins to GE and shop buys.
export function assetSummary(statuses:readonly any[]){
 const names=new Map((JSON.parse(readFileSync(join(projectRoot,'knowledge/items.json'),'utf8')) as any[]).map(i=>[i.id,i.name]));
 return statuses.filter(s=>typeof s?.name==='string'&&/^[A-Z]/.test(s.name)&&s.server==='rs-sdk-demo.fly.dev').map(s=>{
  const sums=new Map<number,number>();
  for(const r of [...(s.inventory??[]),...(s.equipment??[]),...(s.bank??[])]){const id=r.baseId??r.id;sums.set(id,(sums.get(id)??0)+(r.count??0));}
  const coins=sums.get(995)??0;sums.delete(995);
  const stacks=[...sums].filter(([,n])=>n>=50).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([id,n])=>`${names.get(id)??id} ${n}`);
  return{account:s.name,coins,at:s.pos?`${s.pos.x},${s.pos.z}`:null,stacks};
 }).filter(a=>a.coins>=1000||a.stacks.length);
}
// The planner sees the whole-game scoreboard in a compact form: every skill, every quest by stage, weak domains.
export function scoreboardSummary(board:any){
 const byStage=(stage:string)=>board.quests.folders.filter((f:any)=>f.stage===stage).map((f:any)=>f.folder.replace(/^quest_/,''));
 return{at:board.at,scope:board.scope,progress:board.progress,totals:board.totals,items:board.items,
  skills:board.skills.map((s:any)=>({skill:s.skill,bestLive:s.bestLive})),
  quests:{liveComplete:board.quests.liveComplete,practice:byStage('practice'),named:byStage('named'),none:byStage('none')},
  weakDomains:board.domains.filter((d:any)=>d.share<50).sort((a:any,b:any)=>b.actions-a.actions).slice(0,40)};
}
export function plannerPrompt(state:CoordinatorState,world:ReturnType<typeof readWorld>,worldFile=''){
 const compact={...world,coverage:{...world.coverage,quests:undefined,scriptCandidates:world.coverage.scriptCandidates.length},statuses:world.statuses.map((s:any)=>({name:s.name,at:s.at,result:clip(s.result,160),goal:clip(s.goal,120),skills:Object.fromEntries((s.skills??[]).filter((v:any)=>v.level>1).map((v:any)=>[v.name,v.level])),bankAt:s.bankAt})),jobs:world.jobs.map((j:any)=>({account:j.account,accounts:j.accounts,script:j.script,goal:j.goal,enabled:j.enabled})),capabilities:world.capabilities.map((d:any)=>({id:d.id,entry:d.entry,goal:d.goal}))};
 return[
  'You are the autonomous director of this RuneScape project, working with Codex and Claude through one claimed task queue. Return ONLY a JSON object {reason:string,tasks:CoordTask[],capabilities:DeliveryTask[]}. Both tasks and capabilities must be JSON arrays, including when empty: {"reason":"No new work","tasks":[],"capabilities":[]}. Never use {} or null for either collection; capabilities is not a map of existing definitions.',
  'Do not edit files, launch processes or play the game. The coordinator owns execution. Read local sources as needed.',
  'Goals, all retained: wealth; all19 skills99; all quests/unlocks; best-in-slot/useful/rare items; specialist wins; main rank1 on all24boards simultaneously. Goal IDs: '+GOALS.join(', '),
  'Read AGENTS.md, docs/plans/joined-plan.md, docs/script-contract.md. All game mechanics are authorized. Missing supplies create acquisition tasks, never route exclusions. Preserve all current work, pauses and clocks. No paid APIs.',
  'Own a whole useful outcome through its consumer. Prefer existing workers and trained helpers. Parameterize simple scripts; compose them with dependency IDs. Research only an unresolved decision. Do not create notes/status tools as a substitute for game progress.',
  'GOAL LOOP: the project ends only when world.scoreboard.progress.done is true; progress.remaining lists what is left. Until then always queue the next best finite task; return no tasks only while queued or running work is about to change the scoreboard, and name it. When a band, quest or capability is done, queue the next one at once. World.stall, when present, means no progress number rose for its hours: drop the approaches tried in that window and choose a different lane, capability or method.',
  'SCOREBOARD (deterministic, .practice/coordinator/scoreboard.json; world.scoreboard): every skill, quest, content domain (5,807 player actions in 154 domains) and item, staged none, named, practice, live. Full game coverage means every entry live, then batch. Each task why must name the scoreboard entries it moves and the expected stage change or size (levels, quests, actions, items, main-run ticks). Rank by that movement per hour of total cost. Prefer one shared or parameterized change that moves many entries, skills with a band at none, quests from named to practice to live, and domains with share 0. Do not propose a small target (for example one helper +10 levels, a handful of items) unless it is the first proof of a new script; size live batches to whole bands. Stock without a named consumer moves nothing.',
  'Choose across the whole coverage catalogue before extending the current prototype. In reason compare the best ready live job, the highest-impact unlock/supply bottleneck, and an uncovered capability. State expected useful output, entry facts, total acquisition/travel/build/test cost, uncertainty, and the next consumer. Prefer the fastest supported gain, not the most familiar script. Finish a qualified live consumer before more unrelated builds. Never repeat a failed build without new evidence and the exact repair in why.',
  'Return optional replacements:[{from,to}] to replace failed/pending tasks with a changed same-kind/capability/goal/account task and reconnect waiting consumers atomically. Failed receipts remain history. Do not add another numbered repair while leaving its consumers behind failed dependencies. Do not replace successful/running work or provision identities. Avoid duplicate open work with the same consumer. Build why is the actual work order sent to its builder; include exact defect, source scope, evidence paths and acceptance.',
  'Expand coverage incrementally: reuse candidate scripts, promote the smallest missing parameterized action, qualify normal entry and recovery, run a useful finite live batch, then pick its next consumer. New accounts require a named absent role or measured capacity need, prepared inputs and a finite first useful job. Never use protected accounts for discovery. Full coverage is a continuing goal across pinned content, not a claim made from filename counts.',
  'For an existing capability whose owned files or entry cannot support the real consumer, return capabilityUpdates:[{expectedSource:<capabilitySources[id]>,definition:<complete DeliveryTask>}] with a same-capability build task and explicit replacements for old pending builds. One update per proposal; no running owner may hold that capability. The daemon preserves the old definition. Expand the existing module scope instead of duplicating it under a new capability name. Entry must be an actual account-parameterized live worker; local --save fixtures and privileged practice commands belong in checks. Native proof must invoke that worker CLI, not only helper functions. Every new/progress build must include a finite live consumer with useful acceptance, inputs and a next goal; never stop at stock or qualification.',
  'THIN ACCEPTANCE (owner order): a consumer and its checks hold only the script contract acceptance bar: unit tests, one practice run of the real CLI showing the useful effect, assets reconciled, a clear refusal and logout. Never add interruption/resume, reseed, independent recompute, raw-file binding or failure-window scenarios, and never widen an existing consumer. A live failure gets the smallest fix of the exact failed step plus one regression test.',
  'MEMORY GATES: a proof imports FREE_FLOOR_GB and PRACTICE_STARTUP_GB from packages/core/src/memory.ts and takes the practice turn through delivery; it never hardcodes a free-memory number (a hardcoded 12 GiB gate failed the Firemaking and Magic builds on a machine with 5 to 10 GB available).',
  'FAST LANE: when a qualified capability needs only a different account, quest or argument, queue the run; do not queue a build. A failed live step that the runtime already handles (for example the quest talk door rule) gets a fresh qualify and a retry run, not a build.',
  'ASSETS (world.assets): the coins and large stacks of every account. Turn owned stock into scoreboard progress before buying or gathering more: banked logs to Firemaking, rune essence to Runecraft, bows, shafts and arrows to Ranged, ores to Smithing, coins to GE and shop purchases (runes, bones, arrows, best-in-slot gear the account can wear now). Move coins and items to the account that will use them with the courier and trade workers.',
  'NO DIARY (AGENTS.md): write why, reason and capability consumer text as the current work order and current facts only. No dates, no was/now, no history of earlier attempts or builds; cite the failed runId or evidence path instead. Git and runs/<runId>/ hold the history.',
  'Task schema: {id,goal,kind,dependsOn,priority,estimatedMs,why,capability?,account?,accountFrom?,participants?,args?,acceptIndex?,role?,env?,accept?,timeoutMs?,launch?,agent?}. IDs lower-case letters/digits/hyphens. priority1..100 is impact, estimatedMs is an estimate of total work incl. preparation/recovery. Explain the next consumer in why.',
  'Kinds: review is a read-only cross-model source review of an existing delivered capability and can overlap independent authors. agent optionally selects codex or claude; the dispatcher balances builds and uses the other agent for review. qualify runs an existing capability native delivery. build authors named files, runs native delivery and a fresh reviewer. provision creates/registers one ordinary missing role. run installs a finite assignment in swarm.json, then checks fresh matched live status. Never set repeat:true yourself.',
  'For composed jobs use participants:[account or @provision-task-ID,...], at least2; args are passed after all account names. acceptIndex selects whose effects are checked (default0). No account/accountFrom with participants. Normal scripts use args too. '+
  'Each run must depend on a successful build/qualify of the SAME capability. Native tests do not prove live output. accept is {skills:{Skill:level},bank:{itemId:quantity},counters:{counter:minimum},quests:[questName]}; require a real useful effect, not login. Use only documented worker env controls and finite caps. accountFrom resolves the output of a provision task. No env passwords, release pins or HAGGIS_RUN.',
  'All dependsOn IDs must exist or be in this proposal. Failed tasks remain history. Repair by new tasks with new IDs and changed evidence, not blind retries. A run may specify repairs:[{account,endedAt}] naming an exact old failed end, only with a successful same-source native recovery delivery newer than that failure in its dependencies. The existing controller owns the actual repair. Owner stop files remain preserved. A failed account registration reserves its identity; do not create another same-purpose account to hide it.',
  'New capability schema is existing DeliveryTask: {id,goal,entry,files,consumer,checks:[{id,phase:regression|practice|consumer,command:[argv...],timeoutMs}]}. New definitions go in capabilities; no overwrite of existing definitions. A build task may own worker/helper/test/native-proof files, never credentials, AGENTS.md, swarm.json or the coordinator. Acceptance must independently inspect effects including applicable recovery/logout. Existing definitions are preferred.',
  'Use all game data, not just today\'s prototype. Entry points: knowledge/ (inspect filenames), knowledge/drops.json, packages/planner/src/{requirements,haggis,production-batch}.ts, research/INDEX.md and project-use-map.md. Unknown observations stay unknown. Supply qty, access, skills, location and clock constraints need producer tasks. Fresh accounts are for a missing role or measured bottleneck; reuse trained idle helpers first.',
  'Return at most12 tasks per proposal. Keep independent goal lanes eligible. Do not fill slots with surplus earning. If work is genuinely waiting, return tasks:[] and explain the missing event. No human confirmation is required within current authority.',
  'A hostDeferred receipt is a RAM deferral, not a source defect. Retain its prepared source and failed proof; do not invent another code repair. A same-source replacement build resumes native delivery without another author call once native headroom is ready. Keep its finite consumer connected through replacements; do not repeat a headroom failure while capacity is unchanged.',
  'RECENT FINISHED TASKS, last 48 succeeded or failed (open tasks are in the active queue below; superseded tasks are omitted; counts are NOT game completion): '+JSON.stringify({...state,tasks:state.tasks.filter(r=>r.status==='succeeded'||r.status==='failed').slice(-48).map(r=>({spec:briefSpec(r.spec),status:r.status,runId:r.runId,error:clip(r.receipt?.error,240),output:r.receipt?.output?{account:r.receipt.output.account,ok:r.receipt.output.ok,evidence:r.receipt.output.evidence,error:clip(r.receipt.output.error??r.receipt.output.review?.reason??r.receipt.output.delivery?.reason,240)}:null}))}),
  'DATED WORLD (timestamps matter; reserved main/specialists must not be used for tests): '+JSON.stringify(compact),
  'COMPLETE ACTIVE QUEUE AND BLOCKED EDGES (not truncated to recent history): '+JSON.stringify(queueFacts(state)),
  'Full inventories, raw dated status and definitions: '+worldFile,
  'Task source, model/reviewer output, failures and complete receipts: .practice/coordinator/runs/<runId>/. Read these for any repair; do not re-diagnose from summaries.',
  'Task specs above are brief (work order why clipped to 200 characters, receipts to 240). Full specs and receipts: .practice/coordinator/state.json. Read the full why of any task you replace, repair or depend on.',
 ].join('\n');
}
export function acceptProposal(state:CoordinatorState,raw:any,base=projectRoot){
 if(!raw||typeof raw.reason!=='string'||!Array.isArray(raw.tasks)||!Array.isArray(raw.capabilities)||raw.tasks.length>12)throw Error('invalid planner proposal');
 const definitions=raw.capabilities as DeliveryTask[];
 if(new Set(definitions.map(d=>d.id)).size!==definitions.length)throw Error('duplicate proposed capability');
 const scope=(d:DeliveryTask)=>{validateDelivery(d);if(d.files.some(f=>! /^(scripts|packages\/(core|practice|planner))\//.test(f)))throw Error('capability scope must contain gameplay source/tests only');};
 for(const d of definitions){scope(d);if(existsSync(join(base,'packages/router/tasks',d.id+'.json')))throw Error('capability already exists: '+d.id);}
 const updates=raw.capabilityUpdates??[];
 if(!Array.isArray(updates)||updates.length>1)throw Error('one owned capability update per proposal');
 for(const update of updates){
  scope(update.definition);const id=update.definition.id,file=join(base,'packages/router/tasks',id+'.json');
  if(!/^[a-f0-9]{64}$/.test(update.expectedSource)||!existsSync(file)||createHash('sha256').update(readFileSync(file)).digest('hex')!==update.expectedSource)throw Error('capability definition changed; re-read before update');
  if(state.tasks.some(r=>r.status==='running'&&r.spec.capability===id))throw Error('capability update waits for its current owner');
  if(!raw.tasks.some((t:CoordTask)=>t.kind==='build'&&t.capability===id))throw Error('capability update requires its own build and fresh delivery');
 }
 const known=new Set([...readdirSync(join(base,'packages/router/tasks')).map(f=>f.replace(/\.json$/,'')),...definitions.map(d=>d.id)]);
 for(const t of raw.tasks as CoordTask[])if(t.kind!=='provision'&&!known.has(t.capability!))throw Error('unknown capability: '+t.capability);
 // Validate the whole graph before writing any definition or changing state.
 const candidate=structuredClone(state);addTasks(candidate,raw.tasks);
 for(const t of raw.tasks as CoordTask[])if(t.kind==='build'){
  const open=state.tasks.filter(r=>['pending','running'].includes(r.status)&&r.spec.kind==='build'&&r.spec.capability===t.capability);
  if(open.some(r=>r.status==='running'||!raw.replacements?.some((p:any)=>p.from===r.spec.id&&p.to===t.id)))throw Error('replace existing build instead of duplicating it: '+t.capability);
 }
 if(raw.replacements!==undefined){
  if(!Array.isArray(raw.replacements)||raw.replacements.length>24||raw.replacements.some((r:any)=>typeof r?.from!=='string'||typeof r?.to!=='string'))throw Error('invalid replacements');
  replaceTasks(candidate,raw.replacements);
 }
 // cancel retires pending tasks that no longer serve a consumer (for example a build that only rebinds source);
 // each consumer then depends on `use` instead, or loses that dependency.
 if(raw.cancel!==undefined){
  if(!Array.isArray(raw.cancel)||raw.cancel.length>24)throw Error('invalid cancel list');
  const byId=new Map(candidate.tasks.map(r=>[r.spec.id,r]));
  for(const c of raw.cancel){
   const old=byId.get(c?.id);if(!old||old.status!=='pending')throw Error('cancel needs a pending task: '+c?.id);
   if(c.use!==undefined&&!byId.has(c.use))throw Error('cancel substitute is unknown: '+c.use);
   old.status='superseded';old.supersededBy=c.use??'cancelled';
   for(const r of candidate.tasks)if(r.status==='pending'&&r.spec.dependsOn.includes(old.spec.id))
    r.spec.dependsOn=[...new Set(r.spec.dependsOn.flatMap(d=>d===old.spec.id?(c.use?[c.use]:[]):[d]))];
  }
 }
 // A changed contract must be built before any old consumer can request its
 // new (possibly not-yet-created) files or use its old qualification.
 for(const update of updates){
  const build=(raw.tasks as CoordTask[]).find(t=>t.kind==='build'&&t.capability===update.definition.id)!;
  for(const r of candidate.tasks.filter(r=>r.status==='pending'&&r.spec.kind==='run'&&r.spec.capability===update.definition.id))r.spec.dependsOn=[...new Set([...r.spec.dependsOn,build.id])];
 }
 replaceTasks(candidate,[]); // Validate cycles introduced by promotion edges too.
 for(const build of (raw.tasks as CoordTask[]).filter(t=>t.kind==='build')){
  const reaches=(id:string):boolean=>id===build.id||candidate.tasks.find(r=>r.spec.id===id)!.spec.dependsOn.some(reaches);
  if(!candidate.tasks.some(r=>r.status==='pending'&&r.spec.kind==='run'&&reaches(r.spec.id)))throw Error('build requires a finite live consumer dependency: '+build.id);
 }
 for(const d of definitions)atomicJson(join(base,'packages/router/tasks',d.id+'.json'),d);
 for(const update of updates){
  const file=join(base,'packages/router/tasks',update.definition.id+'.json'),bytes=readFileSync(file);
  if(createHash('sha256').update(bytes).digest('hex')!==update.expectedSource)throw Error('capability definition changed during proposal');
  const history=join(base,'.practice/coordinator/capability-history');mkdirSync(history,{recursive:true});
  writeFileSync(join(history,update.definition.id+'-'+update.expectedSource+'.json'),bytes);
  atomicJson(file,update.definition);
 }
 Object.assign(state,candidate);state.lastPlanReason=raw.reason;return raw.tasks.length;
}
export async function planWork(state:CoordinatorState,directory:string,timeoutMs:number,agent:ModelWorker='codex'){
 const world=readWorld();atomicJson(join(directory,'world.json'),world);const prompt=plannerPrompt(state,world,join(directory,'world.json'));writeFileSync(join(directory,'prompt.txt'),prompt);
 const result=await runModel(agent,prompt,timeoutMs,true);atomicJson(join(directory,'model.json'),result);
 if(!result.ok)throw Error('subscription planner unavailable: '+result.text.slice(-400));
 return parseModelObject(result.text);
}
