import {expect,test} from 'bun:test';
import {addTasks,finishTask,initialState,startTask} from '../src/coordinator';
import * as cli from '../src/coordinator-cli';
import type {ProgressionProofDelivery} from '../src/progression-proof-publish';

const delivery:ProgressionProofDelivery={id:'ranged-train',goal:'Finite Ranged',ok:true,stage:'delivered',evidence:'native',consumer:'Ranged85',reason:'native consumer verified',checks:[],source:'a'.repeat(64),runtimeRevision:'b'.repeat(64),directory:'/native'};
function settled(ok=true,kind:'qualify'|'run'='qualify'){
 const s=initialState();addTasks(s,[{id:'q',kind,goal:'skills',capability:'ranged-train',account:kind==='run'?'Unit':undefined,accept:kind==='run'?{skills:{Ranged:85}}:undefined,dependsOn:[],priority:1,estimatedMs:1,why:'finite useful consumer'}]);startTask(s,'q',1,'q-run');
 finishTask(s,{taskId:'q',runId:'q-run',ok,at:2,output:{ok,delivery}});return s;
}
test('accepted native qualifications feed their method evidence to the shared publisher',()=>{
 const state=settled(),calls:unknown[]=[];
 const out=cli.publishQualifiedProgression(state,'/root',(value,options)=>{calls.push({value,options});return{status:'published',changed:true,reason:'source/state proof indexed'};},()=>[]);
 expect(calls).toEqual([{value:delivery,options:{root:'/root'}}]);expect(out[0]).toMatchObject({taskId:'q',runId:'q-run',status:'published',changed:true});
});
test('failed qualification and live receipts cannot publish native method admissions',()=>{
 let calls=0;const publish=()=>{calls++;return{status:'held' as const,changed:false,reason:'unexpected'};};
 expect(cli.publishQualifiedProgression(settled(false),'/root',publish,()=>[])).toEqual([]);expect(cli.publishQualifiedProgression(settled(true,'run'),'/root',publish,()=>[])).toEqual([]);expect(calls).toBe(0);
});
test('optional publication retries without changing the accepted qualification or receipt',()=>{
 const state=settled(),before=JSON.stringify(state);let attempts=0;
 const publish=()=>({status:++attempts===1?'retry' as const:'published' as const,changed:attempts>1,reason:attempts===1?'writer unavailable':'indexed'});
 expect(cli.publishQualifiedProgression(state,'/root',publish,()=>[])[0]?.status).toBe('retry');expect(cli.publishQualifiedProgression(state,'/root',publish,()=>[])[0]?.status).toBe('published');expect(JSON.stringify(state)).toBe(before);
});
test('a publisher exception becomes a retry and leaves scheduling state intact',()=>{
 const state=settled(),before=JSON.stringify(state);
 expect(cli.publishQualifiedProgression(state,'/root',()=>{throw Error('file temporarily held');},()=>[])[0]).toMatchObject({status:'retry',changed:false});expect(JSON.stringify(state)).toBe(before);
});
test('retained canonical native reports backfill once without a matching queue record',()=>{
 let calls=0;const publish=()=>{calls++;return{status:'published' as const,changed:true,reason:'indexed'};};
 const out=cli.publishQualifiedProgression(initialState(),'/root',publish,()=>[delivery]);
 expect(calls).toBe(1);expect(out[0]).toMatchObject({directory:'/native',status:'published'});expect(out[0]?.taskId).toBeUndefined();
 cli.publishQualifiedProgression(settled(),'/root',publish,()=>[delivery]);expect(calls).toBe(2);
});
