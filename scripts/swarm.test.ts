import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasPayout } from '../packages/core/src/bank-demand';
import { supervise } from '../packages/practice/src/supervise';
import { endedForGood, isReservation, parseJob, startable, loadEnded, persistEnded, supervisorEndLine, activeExternalLive, pendingStartupCount, admissionDecision, missionSignature, overlappingRun, observeEnabled, applyResume, ownedPayoutWaiting,foodSupplyDemand,type Job } from './swarm';

test('food courier admission needs owned active low-food farm and dated cooked source bank; default jobs stay unchanged',()=>{
    const now=100000,owned=new Set(['farm','cook']);
    const job:Job={account:'Courier',script:'scripts/foodcourier.ts',enabled:true,whenFoodLowFrom:['Farm'],foodSourceAccount:'Cook'};
    const farm={name:'Farm',server:'rs-sdk-demo.fly.dev',at:now-1000,result:'',bankAt:now-2000,bank:[{id:333,count:50}],inventory:[{id:329,count:25}]};
    const cook={name:'Cook',server:'rs-sdk-demo.fly.dev',bankAt:now-5000,bank:[{id:329,count:100}]};
    const demand=(f:any=farm,c:any=cook,j:Job=job,o=owned)=>foodSupplyDemand(j,[f,c],o,now);
    expect(demand()).toBe(true);
    expect(demand({...farm,inventory:[{id:329,count:30}]})).toBe(false); // exactly80 is not low
    expect(demand({...farm,inventory:[{id:330,count:30}]})).toBe(false); // incoming cooked notes count too
    for(const change of [{at:now-30000},{at:now+1},{result:'ok paused'},{server:'localhost:8888'},{name:'Other'},
        {bank:null},{bankAt:null},{bankAt:now+1},{bank:[{name:'Trout',count:1}]}])expect(demand({...farm,...change})).toBe(false);
    for(const change of [{bankAt:undefined},{bankAt:now+1},{server:'localhost:8888'},{name:'Other'},
        {bank:[{id:329,count:99}]},{bank:[{id:331,count:1000}]},{bank:[{id:330,count:1000}]}])expect(demand(farm,{...cook,...change})).toBe(false);
    expect(demand(farm,cook,job,new Set(['cook']))).toBe(false);expect(demand(farm,cook,job,new Set(['farm']))).toBe(false);
    expect(demand(farm,cook,{...job,script:'scripts/goldfarm.ts'})).toBe(false);
    expect(demand(farm,cook,{...job,whenFoodLowFrom:undefined})).toBe(false);
    expect(demand(farm,cook,{...job,foodLowBelow:75})).toBe(false);
    expect(demand(farm,cook,{...job,sourceFoodMinimum:101})).toBe(false);
});

test('only confirmed success repeats; operator stop and no-food remain paused beyond30seconds and restart', async () => {
    const dir=mkdtempSync(join(tmpdir(),'swarm-pause-'));
    try {
        const food=await supervise({run:async()=>({stdout:'RESULT fail no food',exitCode:1}),stopped:()=>false,pause:async()=>{},maxRestarts:20});
        const ended=new Map([['Food',{at:100,reason:`${food.reason} after ${food.runs} runs`}],['Operator',{at:100,reason:'stopped after 1 runs'}],['Unknown',{at:100,reason:'exit 0'}]]);
        const file=join(dir,'ends.json');persistEnded(file,ended);
        for(const records of [ended,loadEnded(file)]) expect(startable(['Food','Operator','Unknown'],true,records,()=>60_000).start).toEqual([]);
        // A pre-existing stop file also wins when no end is available at startup.
        expect(startable(['Startup'],true,new Map(),()=>Infinity,undefined,undefined,()=>true).blocked.Startup).toContain('paused');
        expect(endedForGood({reason:'done unexpectedly'},true)).toBe(true);
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an observed disable-enable explicitly resumes paused work once, only after active run settles', () => {
    const previous=new Map<string,boolean>(),pending=new Set<string>(),ended=new Map([['Worker',{at:100,reason:'stopped after 1 runs'}]]);
    let clears=0;const clear=()=>{clears++;};
    observeEnabled(['Worker'],true,previous,pending); // startup is not a resume
    expect(applyResume(['Worker'],false,ended,pending,clear)).toBe(false);
    observeEnabled(['worker'],false,previous,pending);
    observeEnabled(['Worker'],true,previous,pending);
    expect(applyResume(['Worker'],true,ended,pending,clear)).toBe(false);
    expect(clears).toBe(0);expect(ended.has('Worker')).toBe(true);
    expect(applyResume(['Worker'],false,ended,pending,clear)).toBe(true);
    expect(clears).toBe(1);expect(ended.size).toBe(0);
    expect(startable(['Worker'],false,ended,()=>60_000).start).toEqual(['Worker']);
    ended.set('Worker',{at:200,reason:'stopped after 1 runs'});
    expect(applyResume(['Worker'],false,ended,pending,clear)).toBe(false);
    expect(startable(['Worker'],true,ended,()=>60_000).start).toEqual([]);
});

test('explicit resume preserves death/no-progress/exhausted retries and does not reset done work', () => {
    for(const reason of ['died','blocked after 1 runs','gave-up after 21 runs','done after 1 runs']) {
        const ended=new Map([['worker',{at:100,reason}]]),pending=new Set(['worker']);let clears=0;
        expect(applyResume(['Worker'],false,ended,pending,()=>{clears++;})).toBe(false);
        expect(clears).toBe(0);expect(ended.get('worker')?.reason).toBe(reason);
    }
});

test('mission identity includes actual work and canonical env but excludes display and enable fields', () => {
    const job = {account:'Ore',script:'scripts/gather-ore.ts',enabled:true,env:{B:'2',A:'1'}};
    const sig = missionSignature(job);
    expect(missionSignature({...job,account:'ore',env:{A:'1',B:'2'},enabled:false,goal:'new label',note:'reviewed',role:'miner',repeat:true})).toBe(sig);
    expect(missionSignature({...job,env:{A:'1',B:'3'}})).not.toBe(sig);
    expect(missionSignature({...job,script:'scripts/smelt-bars.ts'})).not.toBe(sig);
    expect(missionSignature({script:job.script,enabled:true,host:true,accounts:['Ore']})).not.toBe(sig);
    expect(missionSignature({script:job.script,enabled:true,host:true,accounts:['Ore','Bars']}))
        .not.toBe(missionSignature({script:job.script,enabled:true,host:true,accounts:['Bars','Ore']}));
});

test('new bounded mission starts once after success; same mission and note edits remain quiet', () => {
    const job={account:'Ore',script:'ore.ts',env:{TARGET:'10'},enabled:true,repeat:false};
    const old=missionSignature(job), next=missionSignature({...job,env:{TARGET:'20'}});
    const ended=new Map([['Ore',{at:100,reason:'done after 1 runs',revision:old}]]);
    expect(startable(['ore'],false,ended,()=>1,()=>90,old).start).toEqual([]);
    expect(startable(['ore'],false,ended,()=>1,()=>90,missionSignature({...job,note:'done'})).start).toEqual([]);
    expect(startable(['ore'],false,ended,()=>1,()=>90,next).start).toEqual(['ore']);
    // Actual end captures the new launched revision. Repeated reads never relogin.
    ended.set('Ore',{at:200,reason:'done after 1 runs',revision:next});
    for(let i=0;i<3;i++) expect(startable(['ore'],false,ended,()=>1,()=>190,next).start).toEqual([]);
});

test('completed bounded mission identity survives controller restart; only changed work or repeat can start', () => {
    const dir=mkdtempSync(join(tmpdir(),'swarm-success-'));
    try {
        const job={account:'Buyer',script:'scripts/shop-buyer.ts',enabled:true,repeat:false,env:{PROFILE:'tips',STOCK_TARGET:'20'}};
        const revision=missionSignature(job),file=join(dir,'ends.json');
        persistEnded(file,new Map([['Buyer',{at:100,reason:'done after 1 runs',revision}]]));
        const loaded=loadEnded(file);
        expect(loaded.get('Buyer')).toEqual({at:100,reason:'done after 1 runs',revision});
        for(let i=0;i<3;i++) expect(startable(['Buyer'],false,loadEnded(file),()=>60_000,undefined,revision).start).toEqual([]);
        expect(startable(['Buyer'],false,loaded,()=>60_000,undefined,missionSignature({...job,note:'updated note'})).start).toEqual([]);
        const changed=missionSignature({...job,env:{...job.env,STOCK_TARGET:'40'}});
        expect(startable(['Buyer'],false,loaded,()=>1,()=>90,changed).start).toEqual(['Buyer']);
        expect(startable(['Buyer'],true,loaded,()=>1,()=>90,revision).start).toEqual(['Buyer']);
        expect(startable(['Buyer'],true,loaded,()=>1,()=>101,revision).start).toEqual([]);
        // The replacement mission's end overwrites the prior revision on disk.
        loaded.set('Buyer',{at:200,reason:'done after 1 runs',revision:changed});persistEnded(file,loaded);
        expect(startable(['Buyer'],false,loadEnded(file),()=>60_000,undefined,changed).start).toEqual([]);
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('revision changes preserve failure, stop, unknown and fresh manual-session ownership', () => {
    for(const reason of ['died','blocked after 1 runs','gave-up after 21 runs','stopped after 1 runs','exit 0','done unexpectedly']) {
        const ended=new Map([['Ore',{at:100,reason,revision:'old'}]]);
        expect(startable(['Ore'],false,ended,()=>Infinity,()=>90,'new').start).toEqual([]);
    }
    const success=new Map([['Ore',{at:100,reason:'done',revision:'old'}]]);
    expect(startable(['Ore'],false,success,()=>1,()=>101,'new').blocked.Ore).toContain('external');
    expect(startable(['Ore'],false,success,()=>1,undefined,'new').blocked.Ore).toContain('external');
    expect(startable(['Ore'],false,new Map([['Ore',{at:100,reason:'done'}]]),()=>Infinity,()=>90,'new').start).toEqual([]);
});

test('changed active missions defer by account even across host key or account case changes', () => {
    const active={accounts:['Ore','Bars'],revision:'old'};
    expect(overlappingRun([active],['ore'])).toBe(active);
    expect(overlappingRun([active],['Bars','New'])).toBe(active);
    expect(overlappingRun([active],['Other'])).toBeUndefined();
    // Until the active run exits the new job has no launch slot; then its
    // completed old revision permits exactly the one new bounded mission.
    const runs=[active], ended=new Map([['Ore',{at:100,reason:'done',revision:'old'}]]);
    expect(overlappingRun(runs,['Ore'])).toBeDefined();
    runs.pop();
    expect(overlappingRun(runs,['Ore'])).toBeUndefined();
    expect(startable(['Ore'],false,ended,()=>Infinity,undefined,'new').start).toEqual(['Ore']);
});

test('parseJob keeps single-account jobs as before and reads host jobs', () => {
    const one = parseJob({ account: 'Mightyrod', script: 's.ts', enabled: true });
    expect(one).toEqual({ key: 'Mightyrod', accounts: ['Mightyrod'], host: false, job: expect.anything() });
    const h = parseJob({ accounts: ['Pocketpython', 'Pocketrocket'], script: 'scripts/goldfarm.ts', host: true, enabled: true });
    expect(h).toEqual({ key: 'host:Pocketpython+Pocketrocket', accounts: ['Pocketpython', 'Pocketrocket'], host: true, job: expect.anything() });
});

test('parseJob refuses malformed host jobs', () => {
    expect(parseJob({ accounts: [], script: 's', host: true, enabled: true })).toEqual({ error: expect.stringMatching(/non-empty/) });
    expect(parseJob({ accounts: ['a', 'A'], script: 's', host: true, enabled: true })).toEqual({ error: 'account listed twice' });
    expect(parseJob({ accounts: ['a'], account: 'b', script: 's', host: true, enabled: true })).toEqual({ error: expect.stringMatching(/both/) });
    expect(parseJob({ accounts: ['a'], script: 's', enabled: true })).toEqual({ error: expect.stringMatching(/host/) });
    expect(parseJob({ accounts: ['bad/name'], script: 's', host: true, enabled: true })).toEqual({ error: expect.stringMatching(/bad account/) });
    expect(parseJob({ script: 's', enabled: true })).toEqual({ error: 'no account' });
});

test('a death ends an account for good; only confirmed done can repeat', () => {
    expect(endedForGood({ reason: 'died' }, true)).toBe(true);
    expect(endedForGood({ reason: 'died after 1 runs' }, true)).toBe(true);
    expect(endedForGood({ reason: 'done' }, true)).toBe(false);
    expect(endedForGood({ reason: 'done' }, false)).toBe(true);
    expect(endedForGood(undefined, false)).toBe(false);
});

test('startable leaves out dead and external accounts of a host job, per account', () => {
    const ended = new Map([['dead', { reason: 'died' }], ['fine', { reason: 'gave-up' }]]);
    const age = (a: string) => (a === 'ext' ? 5_000 : Infinity);
    const r = startable(['dead', 'fine', 'ext', 'new'], true, ended, age);
    expect(r.start).toEqual(['new']);
    expect(r.blocked).toEqual({ dead: 'ended: died', fine: 'ended: gave-up', ext: 'external (status fresh, not started by swarm)' });
});

test('an account entry without a script is a reservation, not a bad job', () => {
    expect(isReservation({ account: 'Main', script: '', enabled: false })).toBe(true);
    expect(isReservation({ account: 'Main', enabled: false } as any)).toBe(true);
    expect(isReservation({ account: 'Mightyrod', script: 's.ts', enabled: true })).toBe(false);
    expect(isReservation({ accounts: ['a'], script: '', host: true, enabled: true })).toBe(false);
});


test('progress failure stays blocked through repeated controller checks and a controller restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-block-'));
    try {
        const file = join(dir, 'swarm-deaths.json');
        let logins = 0;
        const result = await supervise({
            run: async () => { logins++; return { stdout: 'RESULT fail Error: no ore progress for 220 ticks', exitCode: 1 }; },
            stopped: () => false, pause: async () => { throw new Error('must not retry'); }, maxRestarts: 20,
        });
        expect(result).toEqual({ reason: 'blocked', runs: 1 });
        persistEnded(file, new Map([['Ore', { at: 123, reason: `${result.reason} after ${result.runs} runs` }],
            ['Dead', { at: 122, reason: 'died' }], ['Spent', { at: 124, reason: 'gave-up after 21 runs' }], ['Success', { at: 125, reason: 'done' }]]));
        const restarted = loadEnded(file);
        expect(restarted.get('Success')).toEqual({at:125,reason:'done'});
        for (let i = 0; i < 5; i++) {
            const next = startable(['ore', 'Dead', 'Spent', 'Success'], true, restarted, () => Infinity);
            expect(next.start).toEqual(['Success']);
            expect(next.blocked.ore).toContain('blocked');
            expect(next.blocked.Spent).toContain('gave-up');
        }
        expect(logins).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('current supervisor end records parse complete reasons, not ordinary log text', () => {
    expect(supervisorEndLine('SUPERVISE end gave-up after 21 runs')).toBe('gave-up after 21 runs');
    expect(supervisorEndLine('SUPERVISE end blocked after 1 runs')).toBe('blocked after 1 runs');
    expect(supervisorEndLine('SUPERVISE run 1: RESULT fail no progress')).toBeUndefined();
});

test('capacity counts fresh external LIVE accounts outside the plan once, excluding ours and invalid evidence', () => {
    const now=100_000, live='rs-sdk-demo.fly.dev';
    const row=(name:string,server=live,at=now-1,result='')=>({name,server,at,result});
    const rows=[row('Unlisted'),row('unlisted'),row('Managed'),row('Practice','localhost:8888'),
        row('Unknown',''),row('Other','example.org'),row('Future',live,now+1),
        row('Stale',live,now-30_000),row('Ended',live,now-1,'ok done'),row('Failure',live,now-1,'fail'),
        row('bad/name'),row('NoTime',live,NaN)];
    expect(activeExternalLive(rows,['managed'],now)).toEqual(['Unlisted']);
});
test('pending startup reserve counts host accounts once and expires at30seconds', () => {
    const now=100_000;
    expect(pendingStartupCount([{started:now-1,accounts:['A','B']},{started:now-2,accounts:['a']},
        {started:now-30_000,accounts:['Old']},{started:now+1,accounts:['Future']}],now)).toBe(2);
});
test('admission reserves pending heaps and a new account before enforcing the8GiB floor', () => {
    const base={running:3,external:0,starting:1,pending:0,freeGB:10.5,minFreeGB:8,maxBots:6};
    expect(admissionDecision(base).allowed).toBe(true);
    expect(admissionDecision({...base,running:4,pending:1}).projectedFreeGB).toBe(8.5);
    expect(admissionDecision({...base,running:4,pending:1}).allowed).toBe(true);
    const third=admissionDecision({...base,running:5,pending:2});
    expect(third.reason).toBe('memory');expect(third.projectedFreeGB).toBe(7.5);
    expect(admissionDecision({...base,running:5,external:1}).reason).toBe('maxBots');
    expect(admissionDecision({...base,freeGB:9,minFreeGB:0}).allowed).toBe(true);
    expect(admissionDecision({...base,freeGB:8.9,minFreeGB:0}).reason).toBe('memory');
    expect(admissionDecision({...base,starting:3,freeGB:10.5}).reason).toBe('memory');
    expect(admissionDecision({...base,freeGB:NaN}).allowed).toBe(false);
});

test('own successful completed run bypasses fresh-status wait only for its old session epoch', () => {
    const ended=new Map([['Moneyshot',{at:10_000,reason:'done after 1 runs'}]]);
    expect(startable(['moneyshot'],true,ended,()=>1,()=>9_000).start).toEqual(['moneyshot']);
    expect(startable(['Moneyshot'],true,ended,()=>1,()=>10_000).start).toEqual(['Moneyshot']);
    expect(startable(['Moneyshot'],true,ended,()=>1,()=>10_001).blocked.Moneyshot).toContain('external');
    expect(startable(['Moneyshot'],true,ended,()=>1).blocked.Moneyshot).toContain('external');
    expect(startable(['Moneyshot'],true,ended,()=>1,()=>undefined).blocked.Moneyshot).toContain('external');
    expect(startable(['Moneyshot'],true,ended,()=>1,()=>NaN).blocked.Moneyshot).toContain('external');
    expect(startable(['Moneyshot'],false,ended,()=>1,()=>9_000).blocked.Moneyshot).toContain('ended: done');
});
test('stopped, failed, and unknown ends remain paused even before the fresh manual-session guard', () => {
    for(const reason of ['stopped after 1 runs','exit 1','fail','done unexpectedly']) {
        const ended=new Map([['Moneyshot',{at:10_000,reason}]]);
        expect(startable(['Moneyshot'],true,ended,()=>1,()=>9_000).blocked.Moneyshot).toBe(`ended: ${reason}`);
    }
    expect(startable(['Moneyshot'],true,new Map([['Moneyshot',{reason:'done'}]]),()=>1,()=>9_000).blocked.Moneyshot).toContain('external');
});

test('new live owned payout recipient wakes banker without joining cargo whitelist', () => {
    const now = 200000, near = { x: 2654, z: 3283, radius: 25 };
    const sword = { name: 'Swordinhand', server: 'rs-sdk-demo.fly.dev', at: now, result: '', pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ name: 'Trout', count: 2 }] };
    const owned = new Set(['bigpackage', 'swordinhand']);
    const request = { items: [{ name: 'Trout', count: 7 }, { name: 'Bronze sword', count: 1 }, { name: 'Wooden shield', count: 1 }] };
    const check = (names: string[], location: typeof near | undefined) => names.some(name => hasPayout(name, sword, request, now, now, location));
    expect(ownedPayoutWaiting([sword], near, owned, check, now)).toBe(true);
    // The previous gate passed only Bigpackage into hasPayout, which cannot match Sword's exact identity.
    expect(check(['Bigpackage'], near)).toBe(false);
});
test('payout wake rejects foreign/far/stale/malformed/offline recipients and working food alone', () => {
    const now = 200000, near = { x: 2654, z: 3283, radius: 25 }, owned = new Set(['swordinhand']);
    const base = { name: 'Swordinhand', server: 'rs-sdk-demo.fly.dev', at: now, result: '', pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ name: 'Trout', count: 2 }] };
    const valid = { items: [{ name: 'Trout', count: 7 }] };
    const wakes = (status: any, request: any = valid, requestAt = now, owners = owned) => ownedPayoutWaiting([status], near, owners,
        (names, location) => names.some(name => hasPayout(name, status, request, requestAt, now, location)), now);
    expect(wakes({ ...base, name: 'Stranger' })).toBe(false);
    expect(wakes(base, valid, now, new Set())).toBe(false);
    expect(wakes({ ...base, pos: { x: 2727, z: 3492, level: 0 } })).toBe(false);
    expect(wakes({ ...base, at: now - 30000 })).toBe(false);
    expect(wakes({ ...base, result: 'ok done' })).toBe(false);
    expect(wakes({ ...base, server: 'localhost:8888' })).toBe(false);
    expect(wakes(base, valid, now - 180001)).toBe(false);
    expect(wakes(base, { items: [{ name: 'Trout', count: -1 }] })).toBe(false);
    expect(wakes(base, null)).toBe(false); // actual working food without a request cannot wake
    expect(ownedPayoutWaiting([base], undefined, owned, (names, location) => names.some(name => hasPayout(name, base, valid, now, now, location)), now)).toBe(false);
});
