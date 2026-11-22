import {expect,test} from 'bun:test';
import {createAutopilotProgression,executingProgressionMethod} from './autopilot-progression';
import {accountFromStatus,loadProgressionCatalog,type CatalogAccept,type ProgressionCatalog} from '../packages/planner/src/progression-catalog';
import {preflightProgressionWork} from '../packages/core/src/progression-session';
import {resolveAioStep} from './aio';
import {chooseProgression,type ProgressionMethod} from '../packages/planner/src/progression';
import {catalogue,jobResources,plan,type Assignment,type Template} from '../packages/planner/src/autopilot';
import {xpForLevel} from '../packages/planner/src/curve';
const now=100000,server='rs-sdk-demo.fly.dev';
const status={name:'Archer',at:now,server,bankAt:now,inventory:[],bank:[],equipment:[],equipmentObserved:true,quests:[],skills:[{name:'Ranged',level:40,xp:xpForLevel(40)}]};
const template=(script='scripts/slow.ts'):Template=>({id:'army-range',family:'combat-train',script,args:['50'],role:'combat',goal:'Ranged50',trains:{skill:'Ranged',to:50,unlocks:[]},tier:'goal',band:1,yields:()=>[]});
const assignment=(t=template()):Assignment=>({account:'Archer',template:t,value:1,reason:'army goal',resources:[]});
const method=(id:string,rate:number,over:Partial<ProgressionMethod>={}):ProgressionMethod=>({id,step:{script:'scripts/'+id+'.ts',args:['50'],env:{}},source:'proof-'+id,
 effects:{xp:{ranged:1}},repeatable:true,rate:{unitsPerTick:rate,basis:'measured',evidence:'three matched native samples'},
 costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0},qualification:{source:'proof-'+id,bands:[{}]},...over});
const slow=method('slow',1),fast=method('fast',10);
function setup(methods:ProgressionMethod[]=[slow,fast],extra:any={}){
 const calls:{accept?:CatalogAccept;status:any}[]=[];
 const planner=createAutopilotProgression({now,observed:()=>status,itemId:(name:string)=>name==='dragon bones'?536:undefined,itemName:(id:number)=>id===536?'dragon bones':undefined,
  catalog:{version:1,generatedBy:'fixture',skills:['ranged'],routes:[],methods:[],quests:[],entries:[]} as ProgressionCatalog,
  evaluate:(work:any,s:any,o:any)=>{calls.push({accept:o.accept,status:s});const account=accountFromStatus(s.name,s,now),[skill,target]=Object.entries(o.accept?.skills??{})[0]??['ranged',50],intent=o.accept?.bank?{kind:'acquire' as const,items:o.accept.bank,consumer:'army bones'}:{kind:'train' as const,skill:String(skill).toLowerCase(),targetLevel:Number(target)};
   return{supported:true,intent,account,methods,decision:chooseProgression(intent,account,methods,{now,requireQualification:true})};},...extra});
 return{planner,calls};
}
test('AP refines its actual finite assignment through the shared measured selector',()=>{
 const {planner,calls}=setup(),r=planner.refine([assignment()]);
 expect(r.changes[0]?.method).toBe('fast');expect(r.assignments[0]?.template?.id).toBe('army-range');
 expect(r.assignments[0]?.template?.script).toBe('scripts/fast.ts');expect(r.assignments[0]?.template?.goal).toBe('Ranged50');
 expect(JSON.parse(r.assignments[0]?.template?.env?.PROGRESSION_CONSUMER??'null')).toEqual({skills:{Ranged:50}});
 expect(r.assignments[0]?.template?.env?.PROGRESSION_METHOD).toBe('fast');expect(r.assignments[0]?.template?.env?.PROGRESSION_SOURCE).toBe('proof-fast');
 expect(calls).toHaveLength(1);expect(calls[0]?.accept).toEqual({skills:{Ranged:50}});
});

test('AP leaves a selected stale Ranged consumer as an executable coordinator request instead of logging it in',()=>{
 const t=template('scripts/ranged-train.ts'),m={...slow,step:{script:t.script,args:t.args!,env:{}}};
 const {planner}=setup([m],{observed:()=>({...status,at:0})}),result=planner.refine([assignment(t)]);
 expect(result.requests.find(r=>r.action==='observe')?.consumer).toEqual({work:{script:t.script,args:['50'],env:{PROGRESSION_CONSUMER:JSON.stringify({skills:{Ranged:50}})}},accept:{skills:{Ranged:50}}});
 expect(result.assignments[0]?.template).toBeUndefined();expect(result.assignments[0]?.resources).toEqual([]);
});

test('Prayer keeps its existing finite admitted path for unknown comparisons while supported Ranged waits for a method proof',()=>{
 const prayer:Template={...template('scripts/train-prayer.ts'),id:'army-prayer',args:['99'],env:{BONE_ID:'536',BONE_RESERVE:'6',CAP:'4000'},trains:{skill:'Prayer',to:99,unlocks:[]}};
 const prayerMethod=method('prayer-bones',1,{step:{script:prayer.script,args:prayer.args!,env:prayer.env!},effects:{xp:{Prayer:1800}},qualification:undefined,rate:{unitsPerTick:1,basis:'model',evidence:'unqualified comparison'}});
 // The real catalog: its Prayer route maps the trainer to a train intent. A catalog with no route gives the bounded-service intent.
 const prayerPlanner=setup([prayerMethod],{catalog:loadProgressionCatalog(),observed:()=>({...status,skills:[{name:'Prayer',level:96,xp:xpForLevel(96)}]})}).planner,result=prayerPlanner.refine([assignment(prayer)]),kept=result.assignments[0]!.template;
 expect(result.requests.some(r=>r.action==='qualify'&&r.consumer?.accept.skills?.Prayer===99)).toBe(true);
 expect(kept?.script).toBe(prayer.script);expect(kept?.args).toEqual(['99']);expect(kept?.env).toEqual({...prayer.env,PROGRESSION_CONSUMER:JSON.stringify({skills:{Prayer:99}})});
 expect(kept?.env?.PROGRESSION_METHOD).toBeUndefined();expect(kept?.env?.PROGRESSION_SOURCE).toBeUndefined();
 expect(()=>preflightProgressionWork({script:kept!.script,args:kept!.args!,env:kept!.env!},server,loadProgressionCatalog(),'Archer')).not.toThrow();
 const ranged=template('scripts/ranged-train.ts'),rangedMethod={...slow,qualification:undefined,step:{script:ranged.script,args:ranged.args!,env:{}}},held=setup([rangedMethod]).planner.refine([assignment(ranged)]);
 expect(held.requests.some(r=>r.action==='qualify'&&r.consumer?.accept.skills?.Ranged===50)).toBe(true);expect(held.assignments[0]?.template).toBeUndefined();
});
test('AP retains modeled or unqualified rivals as evidence work and honors build caps and holds',()=>{
 const modeled=method('fast',10,{rate:{unitsPerTick:10,basis:'model',evidence:'estimate'}});
 const {planner}=setup([slow,modeled],{builds:new Map([['archer',{Ranged:45}]])}),r=planner.refine([assignment()]);
 expect(r.changes).toEqual([]);expect(r.requests.some((q:any)=>q.method==='fast'&&q.action==='measure')).toBe(true);
 expect(planner.decisions()[0]?.intent).toEqual({kind:'train',skill:'ranged',targetLevel:45});
 for(const hold of ['busy','paused','protected']){const p=setup([slow,fast],{[hold]:new Set(['archer'])}).planner,b=assignment();expect(p.refine([b]).assignments[0]).toBe(b);}
});
test('AP preserves an item supply consumer despite a training stop condition on its template',()=>{
 const supply={...template('scripts/aio-market.ts'),args:['ge-buy'],trains:{skill:'Ranged',to:99,unlocks:[]},stock:{item:'dragon bones',to:20},env:{ITEM_ID:'536',QUANTITY:'20',EXPECTED_OWNED:'0'}};
 const bones=method('bones',1,{effects:{items:{536:1}},step:{script:supply.script,args:['50'],env:supply.env}});
 const {planner,calls}=setup([bones,fast]),r=planner.refine([assignment(supply)]);
 expect(calls[0]?.accept).toEqual({bank:{536:20}});expect(planner.decisions()[0]?.intent?.kind).toBe('acquire');
 expect(r.changes.some((c:any)=>c.method==='fast')).toBe(false);
});
test('AP finite production asks for new output beyond its observed owned stock',()=>{
 const t={...template('scripts/microbot-production.ts'),args:['bones'],production:{output:'dragon bones',outputPerUnit:2,maximum:3,inputs:{},resize:()=>({args:['bones']})}};
 const {planner,calls}=setup([method('bones',1,{effects:{items:{536:2}},step:{script:t.script,args:t.args,env:{}}})],{observed:()=>({...status,bank:[{id:536,count:20}]})});
 planner.refine([assignment(t)]);expect(calls[0]?.accept).toEqual({bank:{536:26}});
});
test('an unchanged unqualified AP producer carries its finite consumer into the actual delegated preflight',()=>{
 const listed=catalogue().find(t=>t.id==='aio-cannonballs')!,t={...listed,...listed.production!.resize(1),production:{...listed.production!,maximum:1}},c=loadProgressionCatalog();
 const observed={...status,bank:[{id:2,count:10},{id:2353,count:1},{id:4,count:1}],skills:[{name:'Smithing',level:35,xp:xpForLevel(35)}]};
 const {planner}=setup([],{catalog:c,observed:()=>observed,itemId:(name:string)=>name==='cannonball'?2:undefined});
 const r=planner.refine([assignment(t)]),out=r.assignments[0]!.template!;
 expect(r.changes).toEqual([]);expect(out.script).toBe(t.script);expect(out.args).toEqual(t.args);
 expect(JSON.parse(out.env?.PROGRESSION_CONSUMER??'null')).toEqual({bank:{2:14}});
 expect(out.env?.PROGRESSION_METHOD).toBeUndefined();expect(out.env?.PROGRESSION_SOURCE).toBeUndefined();
 const step=resolveAioStep(out.args![0]!,out.args!.slice(1)),work={...step,env:{...out.env,...step.env}};
 expect(step.script).toBe('scripts/microbot-a-cannonballs.ts');expect(()=>preflightProgressionWork(work,server,c,'Archer')).not.toThrow();
});
test('AP stages priced external stock only through its existing finite order adapter',()=>{
 const remaining=xpForLevel(50)-xpForLevel(40),withInput=method('fast',10,{inputs:{536:1}}),t=template();
 const {planner}=setup([slow,withInput],{stocks:[{holder:'Supplier',at:now,items:{536:remaining},delivery:{ticks:10,basis:'measured',source:'transfer-proof',evidence:'three matched owned transfers'}}],
  sourcesFor:()=>['Supplier'],canTransfer:(from:string,to:string)=>from==='Supplier'&&to==='Archer'});
 const r=planner.refine([assignment(t)]);
 expect(r.changes[0]?.ready).toBe(false);expect(r.assignments[0]?.template?.script).toBe(t.script);
 expect(r.assignments[0]?.send).toEqual({from:'Supplier',to:'Archer',item:'dragon bones',count:remaining,template:t.id});
 const unpriced=setup([slow,withInput],{stocks:[{holder:'Supplier',at:now,items:{536:remaining}}],sourcesFor:()=>['Supplier'],canTransfer:()=>true}).planner.refine([assignment(t)]);
 expect(unpriced.assignments[0]?.send).toBeUndefined();expect(unpriced.changes).toEqual([]);
});
test('AP resolves qualified adaptive resources before cohort capacity allocation',()=>{
 const ranged=method('ranged/troopers',2,{source:'range-source',qualification:{source:'range-source',bands:[{}]},step:{script:'scripts/ranged-train.ts',args:['50','1500'],env:{TARGET_LEVEL:'50'}}});
 const t={...template(ranged.step.script),args:ranged.step.args,env:ranged.step.env,resources:['pen:3229,3298','trooper:battlefield']};
 const {planner}=setup([ranged]);
 const bound=planner.templateFor(t,{name:'Archer',side:'local',skills:{Ranged:40},items:{}});
 expect(bound.resources).toEqual(['trooper:battlefield']);expect(bound.env).toMatchObject({PROGRESSION_METHOD:'ranged/troopers'});
 const a=Array.from({length:3},(_,i)=>({name:'Archer'+i,side:'local',skills:{Ranged:40},items:{}}));
 const result=plan({side:'local',accounts:a,owners:new Map(a.map(x=>[x.name.toLowerCase(),{side:'local'}])),bill:[],templates:[t],prices:{},army:new Set(a.map(x=>x.name.toLowerCase())),capacity:{'pen:3229,3298':1,'trooper:battlefield':14},
  templateFor:(listed,account)=>({...listed,resources:bound.resources,env:bound.env})});
 expect(result.filter(x=>x.template)).toHaveLength(3);
 const shipped=catalogue().find(t=>t.id==='army-trooper-ranged-99')!;
 // The army band runs the trooper trainer itself: the adaptive worker starts only with a proof for the exact account state.
 expect(shipped.script).toBe('scripts/gather-combat.ts');expect(shipped.resources).toEqual(['trooper:battlefield']);expect(shipped.trains?.to).toBe(99);expect(shipped.repeats).toBe(true);
 expect(planner.templateFor(shipped,{name:'Archer',side:'local',skills:{Ranged:1},items:{}})).toBe(shipped);
});
test('adaptive claims use a bound method and unmatched execution telemetry cannot shrink a provisional claim',()=>{
 const j={account:'Archer',script:'scripts/ranged-train.ts',args:['50','1500'],env:{PROGRESSION_SOURCE:'range-source'},enabled:true};
 const s={...status,started:now-1000,sessionAttemptId:'attempt',workEntry:j.script,workRevision:'range-source',progression:{selected:'ranged/chickens',executing:'ranged/troopers',boundMethod:null,source:'range-source',consumer:null}};
 expect(executingProgressionMethod(j,s,now)).toBe('ranged/troopers');
 for(const changed of [{name:'Other'},{at:now-400000},{workRevision:'old'},{workEntry:'scripts/other.ts'},{sessionAttemptId:''},{result:'RESULT ok'}, {practice:true}])expect(executingProgressionMethod(j,{...s,...changed},now)).toBeUndefined();
 for(const progression of [{...s.progression,source:'old'},{...s.progression,boundMethod:'ranged/chickens'},{...s.progression,consumer:{skills:{Ranged:99}}}])expect(executingProgressionMethod(j,{...s,progression},now)).toBeUndefined();
 expect(executingProgressionMethod({...j,sessionAttemptId:'another'},s,now)).toBeUndefined();
 expect(executingProgressionMethod({...j,assignedAt:now},s,now)).toBeUndefined();
 expect(jobResources(j)).toEqual(['pen:3229,3298','trooper:battlefield']);
 expect(jobResources({...j,env:{...j.env,PROGRESSION_METHOD:'ranged/troopers'}})).toEqual(['trooper:battlefield']);
 expect(jobResources({...j,env:{...j.env,PROGRESSION_METHOD:'ranged/chickens'}})).toEqual(['pen:3229,3298']);
});
test('AP keeps only the exact active finite mission after its admitted arrows are consumed',()=>{
 const m=method('ranged/troopers',2,{source:'range-source',requirements:{items:{882:149}},qualification:{source:'range-source',bands:[{items:{882:149}}]},step:{script:'scripts/ranged-train.ts',args:['50','1500'],env:{TARGET_LEVEL:'50'}}});
 const t={...template(m.step.script),args:m.step.args,env:m.step.env,resources:['pen:3229,3298','trooper:battlefield']};
 const env={...m.step.env,PROGRESSION_METHOD:m.id,PROGRESSION_SOURCE:m.source,PROGRESSION_CONSUMER:JSON.stringify({skills:{Ranged:50}})},job={account:'Archer',template:t.id,script:t.script,args:t.args,env,enabled:true};
 const active={...status,bank:[{id:882,count:148}],started:now-1000,sessionAttemptId:'attempt',workEntry:job.script,workRevision:m.source,progression:{executing:m.id,boundMethod:m.id,source:m.source,consumer:{skills:{Ranged:50}}}};
 const p=setup([m],{observed:()=>active,jobs:[job]}).planner,kept=p.templateFor(t,{name:'Archer',side:'local',skills:{Ranged:40},items:{}});
 expect(kept.env).toEqual(env);expect(kept.args).toEqual(job.args);expect(kept.resources).toEqual(['trooper:battlefield']);
 expect(p.refine([assignment(t)]).assignments[0]?.template?.env).toEqual(env);
 const ended=setup([m],{observed:()=>({...active,result:'RESULT ok'}),jobs:[job]}).planner.templateFor(t,{name:'Archer',side:'local',skills:{Ranged:40},items:{}});
 expect(ended.env).toEqual({...t.env,PROGRESSION_CONSUMER:JSON.stringify({skills:{Ranged:50}})});expect(ended.env?.PROGRESSION_METHOD).toBeUndefined();expect(ended.env?.PROGRESSION_SOURCE).toBeUndefined();
 const changed={...t,trains:{...t.trains!,to:51}},fresh=p.templateFor(changed,{name:'Archer',side:'local',skills:{Ranged:40},items:{}});
 expect(fresh.env).toEqual({...t.env,PROGRESSION_CONSUMER:JSON.stringify({skills:{Ranged:51}})});expect(fresh.env?.PROGRESSION_METHOD).toBeUndefined();expect(fresh.env?.PROGRESSION_SOURCE).toBeUndefined();
});
