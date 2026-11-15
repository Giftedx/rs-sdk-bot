import{test,expect,spyOn}from'bun:test';
import{finishBuildDelivery,executeTask}from'../src/coordinator-worker';
import{initialState,addTasks,startTask,finishTask,preparedNativeDelivery,validateTask}from'../src/coordinator';
import type{DeliveryResult}from'../src/delivery';
import * as modelWorker from'../src/model-worker';
import * as deliveryCli from'../src/delivery-cli';
import{coordinationDir}from'../src/coordinator-store';
import{existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';
const source='a'.repeat(64);
function fixture(){let author=0,delivered=0,reviewed=0,current=source;const records:any[]=[];
 const delivery:DeliveryResult={ok:true,stage:'delivered',evidence:'native',consumer:'fixture only',source,reason:'test-only delivery',checks:[]};
 const deps={fingerprint:()=>current,author:async()=>{author++;return{ok:true,delivery,lastTail:''};},deliver:async()=>{delivered++;return delivery;},review:async()=>{reviewed++;return{approved:true,reason:'fixture only'};},record:(r:any)=>{records.push(r);}};
 return{deps,delivery,records,counts:()=>({author,delivered,reviewed}),change:()=>{current='b'.repeat(64);}};
}
test('the actual executor stage resumes matching prepared source without an author, but still delivers and reviews',async()=>{
 const f=fixture(),r=await finishBuildDelivery('fixture',{source},f.deps,'claude');
 expect(r.ok).toBe(true);expect(f.counts()).toEqual({author:0,delivered:1,reviewed:1});expect(f.records[0].resumedPreparedSource).toBe(source);
});

test('a completed native delivery survives an unavailable handoff author and still requires fresh delivery and review',async()=>{
 const f=fixture(),s=initialState();
 for(const [id,at,output] of [
  ['delivered',2,{ok:false,delivery:f.delivery,review:{approved:false,reason:'weekly limit'}}],
  ['handoff',4,{ok:false,error:'Model failed: weekly limit'}],
 ] as const){
  addTasks(s,[{id,kind:'build',goal:'skills',capability:'fixture',dependsOn:[],priority:100,estimatedMs:1000,why:'Train the connected finite consumer'}],0);
  startTask(s,id,at-1,id);finishTask(s,{taskId:id,runId:id,ok:false,at,output});
 }
 expect(preparedNativeDelivery(s,'fixture',source)).toBeNull();
 const prepared=preparedNativeDelivery(s,'fixture',source,source);
 expect(prepared).toBe(f.delivery);
 const result=await finishBuildDelivery('fixture',prepared,f.deps,'claude');
 expect(result.ok).toBe(true);expect(f.counts()).toEqual({author:0,delivered:1,reviewed:1});
 expect(preparedNativeDelivery(s,'fixture','b'.repeat(64),source)).toBeNull();
 const ordinary=fixture();
 expect((await finishBuildDelivery('fixture',preparedNativeDelivery(s,'fixture',source),ordinary.deps,'codex')).ok).toBe(true);
 expect(ordinary.counts().author).toBe(1);
 f.deps.review=async()=>({approved:false,reason:'concrete defect'});
 expect((await finishBuildDelivery('fixture',prepared,f.deps,'claude')).ok).toBe(false);
 f.delivery.diagnostic={checkId:'observation',complete:true};
 expect(preparedNativeDelivery(s,'fixture',source,source)).toBeNull();
});

test('explicit source continuation is a validated build-only request',()=>{
 const task={id:'resume',kind:'build' as const,goal:'skills' as const,capability:'fixture',dependsOn:[],priority:100,estimatedMs:1000,why:'Continue exact delivered source',resumeSource:source};
 expect(()=>validateTask(task)).not.toThrow();
 expect(()=>validateTask({...task,resumeSource:'wrong'})).toThrow('prepared source');
 expect(()=>validateTask({...task,kind:'qualify'})).toThrow('prepared source');
});
test('a first build may create declared files before any complete-source fingerprint exists',async()=>{
 const f=fixture();f.deps.fingerprint=()=>{if(f.counts().author===0)throw Error('new declared source file not created yet');return source;};
 expect((await finishBuildDelivery('fixture',null,f.deps,'claude')).ok).toBe(true);expect(f.counts().author).toBe(1);
});
test('changed prepared source authors normally; rejected review cannot release a prepared delivery',async()=>{
 const f=fixture();await finishBuildDelivery('fixture',{source:'old'},f.deps,'claude');expect(f.counts().author).toBe(1);
 const x=fixture();x.deps.review=async()=>({approved:false,reason:'actual rejection'});
 expect((await finishBuildDelivery('fixture',{source},x.deps,'claude')).ok).toBe(false);
});
test('the executor cannot rebind delivered evidence when source changes before or during review',async()=>{
 const f=fixture();f.deps.deliver=async()=>{f.change();return f.delivery;};
 const before=await finishBuildDelivery('fixture',{source},f.deps,'claude');expect(before.ok).toBe(false);expect(f.counts().reviewed).toBe(0);expect(before.delivery?.source).toBe(source);
 const x=fixture();x.deps.review=async()=>{x.change();return{approved:true,reason:'fixture only'};};
 const during=await finishBuildDelivery('fixture',{source},x.deps,'claude');expect(during.ok).toBe(false);expect(during.delivery?.source).toBe(source);
});
test('full delivery deferral preserves preparation; a deferred diagnostic never becomes prepared source',async()=>{
 const f=fixture();f.delivery.ok=false;f.delivery.stage='failed';f.delivery.hostDeferred=true;
 const full=await finishBuildDelivery('fixture',{source},f.deps,'claude');expect(full).toMatchObject({ok:false,hostDeferred:true,sourcePrepared:true});expect(f.counts().reviewed).toBe(0);
 const x=fixture(),diagnostic={...x.delivery,ok:false,stage:'failed' as const,hostDeferred:true,diagnostic:{checkId:'native-observation',complete:false}};
 const deps={...x.deps,author:async()=>({ok:false,diagnostic,lastTail:'unrepaired defect'})};
 const result=await finishBuildDelivery('fixture',null,deps,'claude');expect(result).toMatchObject({ok:false,hostDeferred:true,sourcePrepared:false});expect(result.delivery).toBeUndefined();
});

const limited={ok:false,text:"model exit 1\nYou've hit your weekly limit · resets Nov 17",costUsd:0};
const blocked={ok:true,text:JSON.stringify({status:'blocked',reason:'fixture stops before gameplay',requiredChange:'fixture only'}),costUsd:0};
const ready={ok:true,text:JSON.stringify({status:'ready',summary:'fixture source is present'}),costUsd:0};
async function authorPipeline(replies:({ok:boolean;text:string;costUsd:number}|Error)[],options:{elapsed?:number[];regressionRepair?:boolean;agent?:modelWorker.ModelWorker}={}){
 const directory=mkdtempSync(join(tmpdir(),'author-quota-')),calls:{agent:string;timeout:number;readOnly:boolean;prompt:string}[]=[];
 mkdirSync(coordinationDir,{recursive:true});
 let at=1000,deliveries=0;
 const clock=spyOn(Date,'now').mockImplementation(()=>at);
 const model=spyOn(modelWorker,'runModel').mockImplementation(async(agent,prompt,timeout,readOnly)=>{
  const reply=replies[calls.length],elapsed=options.elapsed?.[calls.length]??1000;
  calls.push({agent,prompt,timeout,readOnly});at+=elapsed;
  if(reply instanceof Error)throw reply;
  if(!reply)throw Error('unexpected model attempt');return reply;
 });
 const delivery=spyOn(deliveryCli,'runDeliveryTask').mockImplementation(async definition=>{
  deliveries++;
  if(!options.regressionRepair)throw Error('fixture must not start delivery');
  return{ok:deliveries>1,stage:deliveries>1?'delivered':'failed',evidence:'native',consumer:'mocked fixture only',
   source:deliveryCli.deliveryFingerprint(definition),reason:'fixture regression',checks:deliveries>1?[]:[{id:'fixture',phase:'regression',exitCode:1,timedOut:false,detail:'fixture only'}],
   ...(deliveries===1?{failedCheck:'fixture'}:{})} as DeliveryResult;
 });
 try{
  const result=await executeTask({id:'author-quota-fixture',kind:'build',goal:'skills',capability:'prayer-order',dependsOn:[],priority:1,
   estimatedMs:1000,timeoutMs:10000,why:'Fixture author control only; no game action'}, {},directory,'author-quota-fixture',1000,options.agent??'claude');
  const primary=JSON.parse(readFileSync(join(directory,'author-response-1.json'),'utf8'));
  const fallbackFile=join(directory,'author-response-1-fallback.json');
  return{result,calls,deliveries,primary,fallback:existsSync(fallbackFile)?JSON.parse(readFileSync(fallbackFile,'utf8')):undefined,
   author:JSON.parse(readFileSync(join(directory,'author.json'),'utf8'))};
 }finally{model.mockRestore();delivery.mockRestore();clock.mockRestore();rmSync(directory,{recursive:true,force:true});}
}
test('author quota recovery uses the alternate writable provider and retains both raw replies within one deadline',async()=>{
 const r=await authorPipeline([limited,blocked],{elapsed:[1500,500]});
 expect(r.calls.map(c=>[c.agent,c.readOnly,c.timeout])).toEqual([['claude',false,10000],['codex',false,8500]]);
 expect(r.calls[1]!.prompt).toBe(r.calls[0]!.prompt);
 expect(r.primary).toMatchObject({...limited,agent:'claude'});
 expect(r.fallback).toMatchObject({...blocked,agent:'codex'});
 expect(r.result).toMatchObject({ok:false,agent:'codex',blocked:{reason:'fixture stops before gameplay'}});
 expect(r.deliveries).toBe(0);
});
test('author quota recovery never retries a non-quota failure or a successful reply mentioning quota',async()=>{
 for(const reply of [{ok:false,text:'model deadline exceeded',costUsd:0},{ok:false,text:'authentication failed',costUsd:0},
  {ok:true,text:JSON.stringify({status:'blocked',reason:limited.text,requiredChange:'fixture only'}),costUsd:0}]){
  const r=await authorPipeline([reply]);expect(r.calls).toHaveLength(1);expect(r.calls[0]!.readOnly).toBe(false);
  expect(r.fallback).toBeUndefined();expect(r.deliveries).toBe(0);
 }
});
test('author quota recovery does not start an alternate after its original deadline is spent',async()=>{
 const r=await authorPipeline([limited],{elapsed:[10000]});
 expect(r.calls).toHaveLength(1);expect(r.calls[0]!.timeout).toBe(10000);expect(r.fallback).toBeUndefined();
 expect(r.result.ok).toBe(false);expect(r.deliveries).toBe(0);
});
test('author quota recovery stops after one unavailable alternate and retains its startup error',async()=>{
 const r=await authorPipeline([limited,new Error('fixture alternate unavailable')]);
 expect(r.calls.map(c=>[c.agent,c.readOnly])).toEqual([['claude',false],['codex',false]]);
 expect(r.primary.text).toBe(limited.text);expect(r.fallback).toMatchObject({ok:false,agent:'codex'});
 expect(r.fallback.text).toContain('fixture alternate unavailable');expect(r.result.ok).toBe(false);expect(r.deliveries).toBe(0);
});
test('author quota recovery keeps the successful provider for a diagnosed repair and reports the actual author to review',async()=>{
 const r=await authorPipeline([limited,ready,ready,limited,{ok:true,text:'{"approved":true,"reason":"mocked source review"}',costUsd:0}],{regressionRepair:true});
 expect(r.calls.map(c=>[c.agent,c.readOnly])).toEqual([['claude',false],['codex',false],['codex',false],['claude',true],['codex',true]]);
 expect(r.calls.slice(0,3).map(c=>c.timeout)).toEqual([10000,9000,8000]);
 expect(r.calls[2]!.prompt).toContain('regression gate failed');
 expect(r.deliveries).toBe(2);expect(r.result).toMatchObject({ok:true,agent:'codex'});expect(r.author.agent).toBe('codex');
});
test('author quota recovery cannot return to the exhausted provider during a later diagnosed repair',async()=>{
 const r=await authorPipeline([limited,ready,limited],{regressionRepair:true});
 expect(r.calls.map(c=>[c.agent,c.readOnly])).toEqual([['claude',false],['codex',false],['codex',false]]);
 expect(r.result).toMatchObject({ok:false,agent:'codex'});expect(r.deliveries).toBe(1);
});
test('author quota recovery also preserves writable mode when Codex is the exhausted primary',async()=>{
 const r=await authorPipeline([limited,blocked],{agent:'codex'});
 expect(r.calls.map(c=>[c.agent,c.readOnly])).toEqual([['codex',false],['claude',false]]);
 expect(r.primary).toMatchObject({...limited,agent:'codex'});expect(r.fallback).toMatchObject({...blocked,agent:'claude'});
 expect(r.result).toMatchObject({ok:false,agent:'claude'});expect(r.deliveries).toBe(0);
});
async function reviewPipeline(replies:{ok:boolean;text:string;costUsd:number}[],changeOnFallback=false){
 const f=fixture(),directory=mkdtempSync(join(tmpdir(),'build-review-')),calls:{agent:string;timeout:number;readOnly:boolean}[]=[];
 const model=spyOn(modelWorker,'runModel').mockImplementation(async(agent,_prompt,timeout,readOnly)=>{
  const reply=replies[calls.length];calls.push({agent,timeout,readOnly});if(changeOnFallback&&calls.length===2)f.change();
  if(!reply)throw Error('unexpected model attempt');return reply;
 });
 f.deps.review=async()=>{
  const r=await executeTask({id:'review-fixture',kind:'review',goal:'main24',capability:'ge-bulk-order',dependsOn:[],priority:1,estimatedMs:1000,timeoutMs:10000,why:'Read the unchanged capability source only'}, {},directory,'fixture-review',1,'claude');
  return (r as {review:{approved:boolean;reason:string}}).review;
 };
 try{
  const result=await finishBuildDelivery('fixture',{source},f.deps,'codex');
  return{result,calls,model:JSON.parse(readFileSync(join(directory,'review-model.json'),'utf8'))};
 }finally{model.mockRestore();rmSync(directory,{recursive:true,force:true});}
}
test('the real read-only review pipeline falls back once on a quota and releases the unchanged delivered source',async()=>{
 const r=await reviewPipeline([limited,{ok:true,text:'{"approved":true,"reason":"source and saved proof checked"}',costUsd:0}]);
 expect(r.result.ok).toBe(true);expect(r.calls.map(c=>c.agent)).toEqual(['claude','codex']);expect(r.calls.every(c=>c.readOnly)).toBe(true);
 expect(r.calls[1]!.timeout).toBeGreaterThan(0);expect(r.calls[1]!.timeout).toBeLessThanOrEqual(r.calls[0]!.timeout);
 expect(r.model.attempts.map((a:any)=>[a.agent,a.ok])).toEqual([['claude',false],['codex',true]]);
});
test('both unavailable reviewers retain the full native delivery without inventing a source rejection',async()=>{
 const r=await reviewPipeline([limited,limited]);
 expect(r.calls.map(c=>c.agent)).toEqual(['claude','codex']);expect(r.result).toMatchObject({ok:false,sourcePrepared:true,delivery:{ok:true,stage:'delivered',source}});
 expect('review' in r.result?r.result.review:undefined).toBeUndefined();expect(r.result.error).toContain('review model unavailable');expect(r.model.attempts).toHaveLength(2);
 const state=initialState();addTasks(state,[{id:'delivered',kind:'build',goal:'main24',capability:'fixture',dependsOn:[],priority:1,estimatedMs:1000,why:'Fixture source review'}],0);
 startTask(state,'delivered',1,'delivered');finishTask(state,{taskId:'delivered',runId:'delivered',ok:false,at:2,output:r.result});
 expect(preparedNativeDelivery(state,'fixture',source,source)?.source).toBe(source);
});
test('an answered negative review stays a rejection and never tries a second provider',async()=>{
 const r=await reviewPipeline([{ok:true,text:'{"approved":false,"reason":"a.ts:1 loses the owned stock"}',costUsd:0}]);
 expect(r.calls.map(c=>c.agent)).toEqual(['claude']);expect(r.result.ok).toBe(false);expect('review' in r.result?r.result.review:undefined).toEqual({approved:false,reason:'a.ts:1 loses the owned stock'});
});
test('review fallback cannot release a delivery whose source changed while the review ran',async()=>{
 const r=await reviewPipeline([limited,{ok:true,text:'{"approved":true,"reason":"checked"}',costUsd:0}],true);
 expect(r.result.ok).toBe(false);expect(r.result.delivery?.source).toBe(source);expect(r.result.error).toBe('source changed during review');
});
