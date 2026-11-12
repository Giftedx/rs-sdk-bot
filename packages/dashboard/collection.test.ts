import { expect, test } from 'bun:test';

test('release-paused is a rollout hold, not healthy work or a gameplay block',()=>{
 for(const state of ['paused: worker release','ended: release-paused after 1 runs','paused: Error: no worker progress: release pin missing; live starts paused'])
  expect(operationState({at:1000,result:'ok previous run',planJob:{state}},1001)).toBe('paused');
});
import { productionReview } from './collection';

test('completed cow trips expose observed travel and spare pack capacity without claiming an optimum',()=>{
    const b={result:'ok mode=cow creditedKills=5 targetLevel=null',tick:381,ledger:{move:230},inventory:[{id:333},{id:333}]};
    expect(productionReview(b)).toEqual(['Last batch: 60% of ticks moving; review bank and route','Last cow batch used about 17/28 pack slots; review batch size']);
    expect(productionReview({...b,result:'ok mode=cow creditedKills=9 targetLevel=null',ledger:{move:140},inventory:[]})).toEqual([]);
    expect(productionReview({...b,result:'ok mode=cow creditedKills=2 targetLevel=10',ledger:{move:10}})).toEqual([]);
    expect(productionReview({...b,practice:true})).toEqual([]);
    expect(productionReview({...b,result:'fail no cow progress'})).toEqual([]);
    expect(productionReview({...b,result:'',tick:200})).toEqual([]);
    expect(productionReview({...b,result:'ok mode=draynor-oak banked=25',ledger:{}})).toEqual([]);
    expect(productionReview({...b,result:'ok mode=fire-access phase=reclaim'})).toEqual([]);
});
import { collectionState, operationState, isLoopback, effectiveJob, productionGoal, boundedOperation, capacityState, hostStopNativeProof, HOST_STOP_SOURCE } from './collection';
test('normal failure counters do not mark productive workers blocked',()=>{
 expect(operationState({at:1000,phase:'t=2000 banked=25000 fails=40 picks=563',result:''},1001)).toBe('observed');
 expect(operationState({at:1000,phase:'Error: cannot reach bank',result:''},1001)).toBe('blocked');
 expect(operationState({at:1000,result:'fail stop-file'},1001)).toBe('paused');
 expect(operationState({at:1000,planJob:{state:'ended: blocked after 1 runs'},result:'ok endpoint inspected'},1001)).toBe('blocked');
});
test('bank evidence excludes packs, cargo, strangers and practice; flags name-only and old banks', () => {
    const c = collectionState([
        { name: 'a', bankAt: 1, bank: [{ name: 'Flax', count: 5 }, { name: 'Flax (noted)', count: 3 }], inventory: [{ name: 'Ore', count: 200 }] },
        { name: 'stranger', bankAt: 1, bank: [{ name: 'Sword', count: 1 }] },
        { name: 'b', practice: true, bank: [{ name: 'Food', count: 1 }] },
    ], ['a', 'b'], [{ name: 'a', at: 1, items: [{ name: 'Flax', count: 100 }] }],
    [{ from: 'a', to: 'b' }, { from: 'stranger', to: 'b' }], 400_000);
    expect(c.distinct).toBe(1);
    expect(c.items[0]?.count).toBe(8);
    expect(c.missingIds).toBe(2);
    expect(c.banks[0]?.state).toBe('stale');
    expect(c.pending[0]?.stale).toBe(true);
    expect(c.transferCount).toBe(1);
});
test('stale presence and fresh errors do not count as running', () => {
    expect(operationState({ at: 1, inWorld: true }, 30_000)).toBe('unobserved');
    expect(operationState({ at: 29_000, result: 'error connection refused' }, 30_000)).toBe('failed');
    expect(operationState({ at: 29_000, phase: 'blocked path' }, 30_000)).toBe('blocked');
    expect(isLoopback('192.168.0.2')).toBe(false);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
});

test('mixed snapshot generations and noted IDs count one type', () => {
    const c = collectionState([{name:'a',bank:[{id:1780,baseId:1779,name:'Flax',count:4}]},
        {name:'b',bank:[{name:'Flax (noted)',count:7}]}],['a','b'],[],[],1);
    expect(c.distinct).toBe(1);
    expect(c.items[0]?.count).toBe(11);
    expect(c.missingIds).toBe(1);
    expect(c.banks.every(b=>b.state==='unknown')).toBe(true);
});
test('recent offline failures need attention; deliberate stops pause and ancient errors expire', () => {
    const now = 4_000_000;
    expect(operationState({at:now-120_000,result:'fail Error: bank'},now)).toBe('failed');
    expect(operationState({at:now-120_000,result:'fail no food',hp:{now:0}},now)).toBe('died');
    expect(operationState({at:now-120_000,result:'fail stop file'},now)).toBe('paused');
    expect(operationState({at:now-3_600_001,result:'fail Error: bank'},now)).toBe('offline');
});
test('fresh manual production supersedes disabled historical job and old results', () => {
    const status={name:'worker',at:29_000,goal:'Process 60 surplus fish',result:'',role:'cooking',lastRes:{at:1,text:'fail EFAULT'}};
    const job=effectiveJob(status,{enabled:false,goal:'old fishcook',state:'disabled'},true);
    expect(job.state).toBe('manual');expect(job.goal).toBe(status.goal);
    expect(productionGoal(job.goal)).toBe(true);
    expect(operationState(status,30_000)).toBe('observed');
    expect(operationState({...status,processActive:true},60_000)).toBe('active-stale');
    expect(operationState({...status,processActive:false},60_000)).toBe('offline');
    expect(effectiveJob({...status,result:'ok done'},{state:'disabled'},true).state).toBe('disabled');
});
test('known producer script identifies a custom manual goal without changing legacy mining jobs', () => {
    const goal='Live proof of ore fallback and completed mining actions';
    expect(productionGoal(goal,'scripts/gather-ore.ts')).toBe(true);
    expect(productionGoal('Live proof of tree fallback','scripts/gather-yews.ts')).toBe(true);
    expect(productionGoal('Reach Mining 99','scripts/mining-board.ts')).toBe(false);
    expect(productionGoal('Reach Mining 99')).toBe(false);
});
test('bounded operation distinguishes safe partial stops, fulfilled buffers and unreported legacy results', () => {
    const partial=boundedOperation({result:'ok boughtTotal=12 bankedTotal=12 spentTotal=56 coinReserve=5000 noBuyTicks=25 noBuyLimit=25 targetMet=0 stop=stock-wait'});
    expect(partial.targetMet).toBe(false);expect(partial.label).toContain('Partial stock');
    expect(partial.counters.spentTotal).toBe(56);expect(partial.counters.noBuyTicks).toBe(25);expect(partial.counters.noBuyLimit).toBe(25);
    expect(boundedOperation({result:'ok boughtTotal=0 bankedTotal=0 targetMet=1 stop=stock-target'}).label).toBe('Buffer ready · no new purchases');
    expect(boundedOperation({result:'ok boughtTotal=204 stop=stock-target'}).targetMet).toBeNull();
    expect(boundedOperation({phase:'bank t=30 boughtTotal=12 bankedTotal=12'}).counters.bankedTotal).toBe(12);
    expect(boundedOperation({result:'ok boughtTotal=7',phase:'old spentTotal=999'}).counters.spentTotal).toBeUndefined();
});

test('actual bounded headless result reports390 output and explicit boolean fulfillment', () => {
    const result='ok mode=headless ok=true ticks=76 made=390 banked=390 planned=390 actions=26 bankTrips=2 xpGain=9750 shaftBank=330 featherBank=110 headlessBank=390 heldHeadless=0 reserveMet=true preserved=true targetMet=true stop=max-make hpMin=11 died=false failure=-';
    const proof=boundedOperation({result});
    expect(proof.targetMet).toBe(true);expect(proof.visible).toBe(true);expect(proof.label).toBe('Stock target met');
    expect(proof.counters).toEqual({made:390,banked:390,planned:390,xpGain:9750});
    for(const [token,value] of [['true',true],['false',false],['1',true],['0',false]] as const)
        expect(boundedOperation({result:`ok mode=steel made=15 banked=15 planned=30 targetMet=${token}`}).targetMet).toBe(value);
    for(const token of ['yes','2','trueish','10','']) expect(boundedOperation({result:`ok mode=headless made=390 banked=390 planned=390 targetMet=${token}`}).targetMet).toBeNull();
    expect(boundedOperation({result:'ok mode=headless made=390 banked=390 planned=390'}).targetMet).toBeNull();
    expect(boundedOperation({result:'ok banked=50000'}).counters.banked).toBeUndefined(); // Could be coins, not fletching output.
});

test('finished result plus a briefly retained world-feed avatar is offline, not an unobserved failure', () => {
    expect(operationState({at:1,result:'ok stop=stock-target targetMet=1',inWorld:true},30_000)).toBe('offline');
    expect(operationState({at:1,result:'',inWorld:true},30_000)).toBe('unobserved');
});

test('capacity uses fresh controller occupancy and queues only admission/mission waits', () => {
    const sw={at:1000,running:2,externalRunning:1,maxBots:6,minFreeGB:8,pendingReserveGB:1,jobs:[
        {account:'queued',enabled:true,state:'waiting: maxBots'}, {account:'QUEUED',enabled:true,state:'waiting: projected 7 GB free'},
        {account:'next',enabled:true,state:'running; updated mission queued'}, {account:'resume',enabled:true,state:'stopping; resume queued'},
        {account:'banker',enabled:true,state:'waiting offline: no nearby owned cargo or payout'},
        {account:'blocked',enabled:true,state:'ended: blocked'}, {account:'paused',enabled:true,state:'paused: stop file'},
        {account:'disabled',enabled:false,state:'waiting: maxBots'},
    ]};
    expect(capacityState(sw,10,2000)).toEqual({at:1000,fresh:true,active:3,cap:6,queued:3,freeGB:10,floorGB:8,pendingReserveGB:1,headroomGB:1});
    const stale=capacityState(sw,10,31_001);
    expect(stale.fresh).toBe(false);expect(stale.active).toBeNull();expect(stale.queued).toBeNull();expect(stale.headroomGB).toBeNull();
    expect(capacityState({...sw,externalRunning:undefined,pendingReserveGB:undefined},10,2000).active).toBeNull();
    expect(capacityState(null,10,2000).headroomGB).toBeNull();
    // The floor is the swarm's own: the larger of 4 GiB (FREE_FLOOR_GB) and the plan's minFreeGB. A plan of 4 with
    // 6.4 GiB free has room for a start, and the page must not show it as blocked.
    expect(capacityState({...sw,minFreeGB:5.5},8.5,2000)).toMatchObject({floorGB:5.5,headroomGB:2});
    expect(capacityState({...sw,minFreeGB:4,pendingReserveGB:0},6.5,2000)).toMatchObject({floorGB:4,headroomGB:2.5});
    expect(capacityState({...sw,minFreeGB:4},4.5,2000)).toMatchObject({floorGB:4,headroomGB:-0.5});
    expect(capacityState({...sw,minFreeGB:2},10,2000).floorGB).toBe(4);
    expect(capacityState({...sw,minFreeGB:undefined},10,2000).floorGB).toBe(4);
});

function stopProofFixture() {
    const actor='flhstopfixture',hashes={...HOST_STOP_SOURCE};
    const initial={version:9,position:{x:2655,z:3283,level:0},skills:Array.from({length:21},(_,i)=>({index:i,rawExperience:i===5?0:1000,level:i===3?70:1})),
        inventories:{93:[{slot:0,id:333,count:2}],94:[{slot:3,id:1277,count:1}],95:[{slot:0,id:526,count:222},{slot:1,id:995,count:178}]}};
    const final=structuredClone(initial);final.inventories[95][0]!.count=218;final.skills[5]!.rawExperience=4500;final.skills[5]!.level=5;
    const worker={ok:false,targetMet:false,buried:4,consumed:4,initialBones:222,boneBank:218,heldBones:0,preserved:true,died:false,hpMin:70,stop:'stop-file'};
    const request={tick:12,prayerXp:112,heldBones:25,bankOpen:false,pos:[2655,3283,0]};
    const snapshot={ok:true,actor,hostSha256:hashes.host,prayerSha256:hashes.worker,harnessSha256:hashes.harness,sourceSnapshotSha256:hashes.fixture,
        sourcePath:'.practice/fleet-proof/prayer-flprior-source.json',code:1,timedOut:false,expectedWorkFailure:true,cleanup:true,assets:true,equipment:true,skills:true,atBank:true,life:true,
        worker,request,debit:4,initial,final};
    const status={name:actor,server:'localhost:8888',goal:'host.ts',at:1000,started:900,result:'fail mode=prayer targetMet=false buried=4 consumed=4'};
    const raw=[`HOST start bots=1 script=scripts/train-prayer.ts pid=1`,'PROOF_SKILLS_EXACT true',`HOST_STOP_REQUEST ${JSON.stringify(request)}`,
        `[${actor}] PRAYER_BANK ${JSON.stringify(worker)}`,`[${actor}] RESULT fail mode=prayer targetMet=false buried=4 stop=stop-file`,
        `[${actor}] LOGOUT logged-out`,'HOST done ok=0/1 seconds=16','PROOF_SURVIVAL started=true died=false hpMin=70 finalHp=70'].join('\n');
    return {status,evidence:{filename:`host-stop-${actor}-snapshot.json`,snapshot,raw,at:1100,hashes}};
}

test('expected host STOP has a native cleanup outcome while raw work failure stays failed', () => {
    const f=stopProofFixture(),before=structuredClone(f.status);
    const proof=hostStopNativeProof(f.status,f.evidence);
    expect(proof?.label).toBe('Stop cleanup proved · work stopped');expect(proof?.goalMet).toBe(false);
    expect(proof?.workerOutcome).toBe('fail');expect(proof?.level).toBe('local-native');
    expect(f.status).toEqual(before);expect(operationState(f.status,1100)).toBe('failed');
    f.evidence.hashes.worker='E'.repeat(64);
    expect(hostStopNativeProof(f.status,f.evidence)?.source.matchesCurrent).toBe(false);
});

test('host STOP proof refuses failed first case, mismatched actors, live results and unbound JSON', () => {
    const mutations:((f:ReturnType<typeof stopProofFixture>)=>void)[]=[
        f=>{f.evidence.snapshot.ok=false;},f=>{f.evidence.snapshot.expectedWorkFailure=false;},
        f=>{f.evidence.snapshot.worker.heldBones=22;},f=>{f.evidence.snapshot.cleanup=false;},
        f=>{f.evidence.snapshot.final.inventories[95][1]!.count--;},f=>{f.evidence.snapshot.final.skills[0]!.rawExperience++;},
        f=>{f.evidence.snapshot.final.skills[5]!.rawExperience++;},f=>{f.evidence.snapshot.final.inventories[94][0]!.id=1171;},
        f=>{f.status.server='rs-sdk-demo.fly.dev';},f=>{f.status.name='another';},f=>{f.status.result='ok targetMet=true';},
        f=>{f.evidence.filename='../host-stop-flhstopfixture-snapshot.json';},f=>{f.evidence.snapshot.sourcePath='../secret.json';},
        f=>{f.evidence.snapshot.prayerSha256='E'.repeat(64);},f=>{f.evidence.hashes.fixture='E'.repeat(64);},f=>{f.evidence.raw=f.evidence.raw.replace('LOGOUT logged-out','LOGOUT unknown');},
        f=>{f.evidence.raw=f.evidence.raw.replace('"heldBones":25','"heldBones":0');},f=>{f.evidence.at=200_000;},
    ];
    for(const mutate of mutations){const f=stopProofFixture();mutate(f);expect(hostStopNativeProof(f.status,f.evidence)).toBeNull();}
});

import {accountJobRows} from './collection';
test('grouped coordinator assignments reach each account without undefined identities',()=>{
 const rows=accountJobRows([{accounts:['Worker','worker','Courier'],enabled:true,state:'waiting: maxBots',script:'scripts/order.ts'},null,{accounts:[undefined,4,'../secret']},{account:'Solo',accounts:['Solo','Other']}]);
 expect(rows.map(r=>r.account)).toEqual(['Worker','Courier','Solo','Other']);expect(rows[0].script).toBe('scripts/order.ts');
 expect(capacityState({at:1000,jobs:[{accounts:['Worker','Courier'],enabled:true,state:'waiting: maxBots'}]},12,2000).queued).toBe(2);
 expect(accountJobRows(null)).toEqual([]);
});
