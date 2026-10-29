import{test,expect}from'bun:test';
import{finishBuildDelivery}from'../src/coordinator-worker';
import type{DeliveryResult}from'../src/delivery';
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
