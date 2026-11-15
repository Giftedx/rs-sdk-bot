import{test,expect,spyOn}from'bun:test';
import{finishBuildDelivery,executeTask}from'../src/coordinator-worker';
import{initialState,addTasks,startTask,finishTask,preparedNativeDelivery,validateTask}from'../src/coordinator';
import type{DeliveryResult}from'../src/delivery';
import * as modelWorker from'../src/model-worker';
import{mkdtempSync,readFileSync,rmSync}from'node:fs';
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
 expect(r.result.review).toBeUndefined();expect(r.result.error).toContain('review model unavailable');expect(r.model.attempts).toHaveLength(2);
 const state=initialState();addTasks(state,[{id:'delivered',kind:'build',goal:'main24',capability:'fixture',dependsOn:[],priority:1,estimatedMs:1000,why:'Fixture source review'}],0);
 startTask(state,'delivered',1,'delivered');finishTask(state,{taskId:'delivered',runId:'delivered',ok:false,at:2,output:r.result});
 expect(preparedNativeDelivery(state,'fixture',source,source)?.source).toBe(source);
});
test('an answered negative review stays a rejection and never tries a second provider',async()=>{
 const r=await reviewPipeline([{ok:true,text:'{"approved":false,"reason":"a.ts:1 loses the owned stock"}',costUsd:0}]);
 expect(r.calls.map(c=>c.agent)).toEqual(['claude']);expect(r.result.ok).toBe(false);expect(r.result.review).toEqual({approved:false,reason:'a.ts:1 loses the owned stock'});
});
test('review fallback cannot release a delivery whose source changed while the review ran',async()=>{
 const r=await reviewPipeline([limited,{ok:true,text:'{"approved":true,"reason":"checked"}',costUsd:0}],true);
 expect(r.result.ok).toBe(false);expect(r.result.delivery?.source).toBe(source);expect(r.result.error).toBe('source changed during review');
});
