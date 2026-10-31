import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,utimesSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {finishBuildDelivery,buildReviewGate,executeTask} from '../src/coordinator-worker';
import {reviewGate} from '../src/model-worker';
import {initialState,addTasks,startTask,finishTask,type CoordTask} from '../src/coordinator';
import {prepareWorkspace,prepareReplayRoot,removeReplayRoot} from '../src/build-workspace';
import {deliveryTask} from '../src/delivery-cli';
import {projectRoot} from '../src/coordinator-store';
import type {DeliveryResult} from '../src/delivery';

const source='a'.repeat(64);
function build(gate?:{blocking:boolean;reason:string}){
 let reviewed=0;
 const delivery:DeliveryResult={ok:true,stage:'delivered',evidence:'native',consumer:'fixture only',source,reason:'test-only delivery',checks:[]};
 const deps={fingerprint:()=>source,author:async()=>({ok:true,delivery,lastTail:''}),deliver:async()=>delivery,
  review:async()=>{reviewed++;return{approved:true,reason:'fixture only'};},record:()=>{},...(gate?{gate:async()=>gate}:{})};
 return{deps,reviewed:()=>reviewed};
}
const clean={status:'clean' as const};
const scope=(changed:string[])=>({known:true,changed,owned:['scripts/x.ts','scripts/x.test.ts']});

test('an owned-only build with a clean replay delivers without a review verdict',async()=>{
 const gate=reviewGate({scope:scope(['scripts/x.ts']),records:3,replays:[clean,clean,clean]});
 expect(gate.blocking).toBe(false);
 const f=build(gate),r:any=await finishBuildDelivery('fixture',null,f.deps,'claude');
 expect(r.ok).toBe(true);expect(f.reviewed()).toBe(0);
 expect(r.review).toEqual({deferred:true,reason:gate.reason});expect(r.review.approved).toBeUndefined();
});

test('an out-of-scope build still waits for its review',async()=>{
 const gate=reviewGate({scope:scope(['scripts/x.ts','packages/core/src/bot.ts']),records:3,replays:[clean,clean,clean]});
 expect(gate).toMatchObject({blocking:true});expect(gate.reason).toContain('packages/core/src/bot.ts');
 const f=build(gate),r:any=await finishBuildDelivery('fixture',null,f.deps,'claude');
 expect(f.reviewed()).toBe(1);expect(r.review).toEqual({approved:true,reason:'fixture only'});
 // A rejected blocking review keeps the build from delivering.
 const rejected={...build(gate).deps,review:async()=>({approved:false,reason:'x.ts:3 wrong NPC'})};
 expect((await finishBuildDelivery('fixture',null,rejected,'claude')).ok).toBe(false);
 // No gate, unknown changes, too few records or a replay difference outside replayAllow all block.
 const plain=build();await finishBuildDelivery('fixture',null,plain.deps,'claude');expect(plain.reviewed()).toBe(1);
 expect(reviewGate({scope:{known:false,changed:[],owned:[]},records:3,replays:[clean,clean,clean]}).blocking).toBe(true);
 expect(reviewGate({scope:scope([]),records:2,replays:[clean,clean]}).reason).toContain('found 2');
 const differ={status:'differ' as const,difference:{tick:9,index:4,expected:{a:{type:'walkTo'}},actual:{a:{type:'interactNpc'}}}};
 expect(reviewGate({scope:scope([]),records:3,replays:[clean,differ,clean]}).blocking).toBe(true);
 expect(reviewGate({scope:scope([]),records:3,replays:[clean,differ,clean],allow:['walkTo','interactNpc']}).blocking).toBe(false);
 expect(reviewGate({scope:scope([]),records:3,replays:[clean,{status:'error',error:'boom'},clean]}).blocking).toBe(true);
});

test('the gate reads workspace changes and replays the three newest records from before the build',async()=>{
 const main=mkdtempSync(join(tmpdir(),'gate-main-'));
 mkdirSync(join(main,'scripts'),{recursive:true});mkdirSync(join(main,'packages'),{recursive:true});
 writeFileSync(join(main,'scripts/x.ts'),'one');writeFileSync(join(main,'scripts/other.ts'),'two');
 const {root}=prepareWorkspace(main,'fixture',['scripts/x.ts']);
 const ticks=join(root,'.practice','ticks','x');mkdirSync(ticks,{recursive:true});
 for(const at of [10,20,30,40,500])writeFileSync(join(ticks,`bot-${at}.ticks.ndjson.gz`),'');
 const replayed:string[]=[];const replay=async(file:string)=>{replayed.push(file);return clean;};
 const input={root,isolated:true,entry:'scripts/x.ts',owned:['scripts/x.ts'],startedAt:100,replay};
 writeFileSync(join(root,'scripts/x.ts'),'changed');
 expect((await buildReviewGate(input)).blocking).toBe(false);
 expect(replayed.map(f=>f.match(/bot-(\d+)/)![1])).toEqual(['40','30','20']);
 writeFileSync(join(root,'scripts/other.ts'),'changed too');utimesSync(join(root,'scripts/other.ts'),new Date(),new Date(Date.now()+5000));
 replayed.length=0;
 const outside=await buildReviewGate(input);
 expect(outside.blocking).toBe(true);expect(outside.reason).toContain('scripts/other.ts');expect(replayed).toEqual([]);
 expect((await buildReviewGate({...input,isolated:false})).reason).toContain('main checkout');
});

test('a review rejection after delivery stops the next run of that capability',async()=>{
 const s=initialState();
 const spec:CoordTask={id:'build-magic',goal:'skills',kind:'build',capability:'magic-order',dependsOn:[],priority:50,estimatedMs:1,why:'repair magic order'};
 addTasks(s,[spec]);startTask(s,'build-magic',1,'run-1');s.tasks[0]!.agent='claude';
 expect(finishTask(s,{taskId:'build-magic',runId:'run-1',ok:true,at:2,output:{ok:true,review:{deferred:true,reason:'owned files only'},agent:'claude'}})).toBe(true);
 const review=s.tasks.find(r=>r.spec.id==='build-magic-review')!;
 expect(review.spec).toMatchObject({kind:'review',capability:'magic-order',dependsOn:['build-magic'],agent:'codex'});
 // The review runs on the published source and rejects it; its failed receipt reaches later run tasks.
 const definition=deliveryTask('magic-order');
 const published=createHash('sha256').update(JSON.stringify(definition.files.map(file=>[file,readFileSync(join(projectRoot,file),'utf8')]))).digest('hex');
 startTask(s,'build-magic-review',3,'run-2');
 finishTask(s,{taskId:'build-magic-review',runId:'run-2',ok:false,at:4,output:{ok:false,review:{approved:false,reason:'magic-order.ts:40 casts with no runes'},evidence:'source-review',source:published}});
 const dependencies=Object.fromEntries(s.tasks.filter(r=>r.status==='succeeded'||r.receipt&&r.spec.capability==='magic-order').map(r=>[r.spec.id,{...r.receipt?.output,_task:{capability:r.spec.capability,status:r.status,at:r.receipt?.at}}]));
 const run:CoordTask={id:'run-magic',goal:'skills',kind:'run',capability:'magic-order',account:'Fixture',dependsOn:['build-magic'],priority:50,estimatedMs:1,why:'next magic band',accept:{skills:{Magic:13}}};
 await expect(executeTask(run,dependencies,tmpdir(),'run-3',5)).rejects.toThrow('casts with no runes');
});

test('a replay root has its own .practice and its removal keeps every link target',()=>{
 const source=mkdtempSync(join(tmpdir(),'replay-source-'));
 for(const dir of ['scripts','node_modules','vendor','.practice/cache','.practice/status'])mkdirSync(join(source,dir),{recursive:true});
 writeFileSync(join(source,'scripts/x.ts'),'worker');writeFileSync(join(source,'node_modules/keep'),'1');writeFileSync(join(source,'vendor/keep'),'1');
 writeFileSync(join(source,'.practice/cache/route-legs.json'),'{}');writeFileSync(join(source,'.practice/status/bot.json'),'live');
 const root=prepareReplayRoot(source);
 expect(readFileSync(join(root,'scripts/x.ts'),'utf8')).toBe('worker');
 expect(existsSync(join(root,'.practice/cache/route-legs.json'))).toBe(true);
 expect(existsSync(join(root,'.practice/status'))).toBe(false);
 writeFileSync(join(root,'.practice/receipt.json'),'replayed');
 expect(existsSync(join(source,'.practice/receipt.json'))).toBe(false);
 expect(removeReplayRoot(root)).toBe(true);
 expect(existsSync(root)).toBe(false);
 for(const kept of ['node_modules/keep','vendor/keep','.practice/cache/route-legs.json','.practice/status/bot.json'])expect(existsSync(join(source,kept))).toBe(true);
});
