import {expect,test} from 'bun:test';
import {createAutopilotProgression,executingProgressionMethod} from './autopilot-progression';
import {accountFromStatus,type CatalogAccept,type ProgressionCatalog} from '../packages/planner/src/progression-catalog';
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
  evaluate:(work:any,s:any,o:any)=>{calls.push({accept:o.accept,status:s});const account=accountFromStatus(s.name,s,now),intent=o.accept?.bank?{kind:'acquire' as const,items:o.accept.bank,consumer:'army bones'}:{kind:'train' as const,skill:'ranged',targetLevel:o.accept?.skills?.Ranged??50};
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
test('AP retains modeled or unqualified rivals as evidence work and honors build caps and holds',()=>{
 const modeled=method('fast',10,{rate:{unitsPerTick:10,basis:'model',evidence:'estimate'}});
 const {planner}=setup([slow,modeled],{builds:new Map([['archer',{Ranged:45}]])}),r=planner.refine([assignment()]);
 expect(r.changes).toEqual([]);expect(r.requests.some((q:any)=>q.method==='fast'&&q.action==='measure')).toBe(true);
 expect(planner.decisions()[0]?.intent).toEqual({kind:'train',skill:'ranged',targetLevel:45});
 for(const hold of ['busy','paused','protected']){const p=setup([slow,fast],{[hold]:new Set(['archer'])}).planner,b=assignment();expect(p.refine([b]).assignments[0]).toBe(b);}
});
test('AP preserves an item supply consumer despite a training stop condition on its template',()=>{
 const supply={...template('scripts/buy-owned-ge-item.ts'),trains:{skill:'Ranged',to:99,unlocks:[]},stock:{item:'dragon bones',to:20},env:{ITEM_ID:'536',QUANTITY:'20',EXPECTED_OWNED:'0'}};
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
 expect(bound.resources).toEqual(['trooper:battlefield']);expect(bound.env.PROGRESSION_METHOD).toBe('ranged/troopers');
 const a=Array.from({length:3},(_,i)=>({name:'Archer'+i,side:'local',skills:{Ranged:40},items:{}}));
 const result=plan({side:'local',accounts:a,owners:new Map(a.map(x=>[x.name.toLowerCase(),{side:'local'}])),bill:[],templates:[t],prices:{},army:new Set(a.map(x=>x.name.toLowerCase())),capacity:{'pen:3229,3298':1,'trooper:battlefield':14},
  templateFor:(listed,account)=>({...listed,resources:bound.resources,env:bound.env})});
 expect(result.filter(x=>x.template)).toHaveLength(3);
 const shipped=catalogue().find(t=>t.id==='army-trooper-ranged-99')!;
 expect(shipped.script).toBe('scripts/ranged-train.ts');expect(shipped.args).toEqual(['99','1500']);expect(shipped.trains?.to).toBe(99);expect(shipped.repeats).toBe(true);
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
 const ended=setup([m],{observed:()=>({...active,result:'RESULT ok'}),jobs:[job]}).planner.templateFor(t,{name:'Archer',side:'local',skills:{Ranged:40},items:{}});
 expect(ended.env.PROGRESSION_METHOD).toBeUndefined();
 const changed={...t,trains:{...t.trains!,to:51}},fresh=p.templateFor(changed,{name:'Archer',side:'local',skills:{Ranged:40},items:{}});
 expect(fresh.env.PROGRESSION_METHOD).toBeUndefined();
});
