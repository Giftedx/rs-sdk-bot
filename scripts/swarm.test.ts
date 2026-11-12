import { test, expect } from 'bun:test';
import { coordinatedAdmission,demandCandidates,supervisorCommand,completeJobCandidates,admitRecovery } from './swarm';

test('recovery uses the real admission policy, including inherited startup reserves, before checking release',()=>{
 const v={account:'Rod',active:[] as string[],running:0,external:0,pending:0,freeGB:10,minFreeGB:0,maxBots:17};let releases=0;
 expect(()=>admitRecovery(v,()=>{releases++;})).not.toThrow();expect(releases).toBe(1);
 for(const patch of [{active:['rod']},{running:17},{external:17},{pending:1,freeGB:FREE_FLOOR_GB+1.5}])expect(()=>admitRecovery({...v,...patch},()=>{releases++;})).toThrow();
 expect(releases).toBe(1);expect(()=>admitRecovery(v,()=>{throw Error('source changed');})).toThrow('source changed');
});

test('orchestrator reserves every distinct participant and rejects conflicting modes and arguments',()=>{
 const job:Job={accounts:['Donor','Receiver'],orchestrate:true,host:false,script:'scripts/handoff-inputs.ts',enabled:true,args:['batch']};
 const parsed=parseJob(job);expect(parsed).toEqual({key:'order:Donor+Receiver',accounts:['Donor','Receiver'],host:false,job});
 for(const patch of [{host:true},{account:'Donor'},{accounts:['Donor','donor']},{accounts:['Donor','bad/name']},{accounts:[]},{accounts:['Donor']},{args:[1]},{maxRestarts:-1}])
  expect(parseJob({...job,...patch} as Job)).toHaveProperty('error');
 if('error' in parsed)throw Error(parsed.error);
 expect(overlappingRun([parsed],['receiver'])).toBe(parsed);
 expect(completeJobCandidates(parsed,{start:['Donor'],blocked:{Receiver:'paused: stop file'}})).toEqual({start:[],blocked:{Donor:'waiting: all orchestrator participants required',Receiver:'paused: stop file'}});
 expect(completeJobCandidates(parsed,{start:['Donor','Receiver'],blocked:{}}).start).toEqual(['Donor','Receiver']);
});

test('supervisor commands forward participants and arguments with bounded orchestrator restarts',()=>{
 const order:Job={accounts:['Donor','Receiver'],orchestrate:true,host:false,script:'scripts/handoff-inputs.ts',enabled:true,args:['batch','2']};
 for(const job of [order,{...order,maxRestarts:3},{account:'Donor',script:'scripts/worker.ts',enabled:true,args:['target','2']},{account:'Donor',script:'scripts/worker.ts',enabled:true,maxRestarts:0}]){
  const p=parseJob(job);if('error' in p)throw Error(p.error);
  const command=supervisorCommand(p,p.accounts);
  expect(command).toEqual(['bun','packages/practice/src/supervise.ts','Donor',job.script,String(job.maxRestarts??(job.orchestrate?0:20)),...(job.orchestrate?['Receiver']:[]),...(job.args??[])]);
 }
 expect(missionSignature({...order,args:['batch','3']})).not.toBe(missionSignature(order));
 expect(missionSignature({...order,orchestrate:false})).not.toBe(missionSignature(order));
 expect(missionSignature({account:'Donor',script:'worker.ts',enabled:true,args:[],orchestrate:false})).toBe(JSON.stringify(['worker.ts',false,['donor'],[]]));
 const host=parseJob({accounts:['Donor','Receiver'],host:true,script:'worker.ts',enabled:true});if('error' in host)throw Error(host.error);
 expect(supervisorCommand(host,host.accounts)).toEqual(['bun','packages/practice/src/supervise-host.ts','worker.ts','20','Donor','Receiver']);
});

test('no demand cannot hide a retained failure, stop marker or release hold',()=>{
 for(const reason of ['blocked after 1 runs']){
  const selection=startable(['Courier'],true,new Map([['Courier',{reason}]]),()=>Infinity);
  expect(demandCandidates(selection,()=>{throw Error('not eligible for demand check');})).toBe(selection);
 }
 const mixed={start:['Ready'],blocked:{Courier:'ended: blocked after 1 runs'}};
 expect(demandCandidates(mixed,()=> 'waiting offline: no demand')).toEqual({start:[],blocked:{Courier:'ended: blocked after 1 runs',Ready:'waiting offline: no demand'}});
 // A release pause starts again; the swarm checks the release pin itself before a non-standing start.
 expect(startable(['Courier'],true,new Map([['Courier',{reason:'release-paused'}]]),()=>Infinity).start).toEqual(['Courier']);
});
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { hasPayout } from '../packages/core/src/bank-demand';
import { supervise } from '../packages/practice/src/supervise';
import { enabledByAccount, foreignRun, endedForGood, isReservation, parseJob, startable, loadEnded, applyEndRepair, persistEnded, supervisorEndLine, activeExternalLive, pendingStartupCount, admissionDecision, startReserve, missionSignature, overlappingRun, observeEnabled, applyResume, ownedPayoutWaiting,foodSupplyDemand,type Job,type RepairProofs,
    applyScriptQualification, holdCandidates, loadHolds, persistHolds, currentLogout, defaultRepairProofs, type ScriptHold } from './swarm';
import { beginSessionAttempt, readLogoutProof, verifyLegacyLogout } from '../packages/core/src/session-lifecycle';
import { createHash } from 'node:crypto';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';

const rev=(script:string)=>JSON.stringify([script,false,['x'],[]]);
const proofRef={server:'rs-sdk-demo.fly.dev',proof:{kind:'producer' as const,attemptId:'A'}};
const confirmed:RepairProofs={readProof:(account,server)=>({state:'confirmed',account,server,domain:'live',attemptId:'A',loggedOutAt:1,ownerRun:null,receiptSha256:'0'.repeat(64)}),
    verifyLegacy:()=>({state:'refused',reason:'not used'})};
// Real producer receipts in a test-owned root, read back through the same reader the controller uses.
const LIVE='rs-sdk-demo.fly.dev';
const owner={pid:1,coordinatorRunId:'run-1',workerRelease:null,script:'test',role:null,participants:null};
function lifecycleProofs(root:string):RepairProofs{return {readProof:(a,s)=>readLogoutProof(a,s,{root}),verifyLegacy:c=>verifyLegacyLogout(c,{root})};}
function loggedOut(root:string,account:string,server=LIVE){const a=beginSessionAttempt({account,server},{root,owner});a.record('connected');a.record('ready');a.record('ended','logged-out');a.record('logout','logged-out');return a;}

test('an exact scoped repair clears one failure without clearing other failures or stealing a live session', () => {
    const dir=mkdtempSync(join(tmpdir(),'swarm-repair-')),file=join(dir,'ends.json');
    try {
        const ended=new Map([['Repaired',{at:100,reason:'died',revision:rev('scripts/fight.ts')}],['Other',{at:101,reason:'blocked',revision:rev('scripts/fight.ts')}]]);
        const request={account:'Repaired',endedAt:100,...proofRef};
        expect(applyEndRepair(request,ended,['repaired'],confirmed).changed).toBe(false);
        expect(ended.get('Repaired')?.reason).toBe('died');
        expect(applyEndRepair({...request,endedAt:99},ended,[],confirmed).changed).toBe(false);
        expect(applyEndRepair(request,ended,[],confirmed).changed).toBe(true);
        expect(ended.has('Repaired')).toBe(false);expect(ended.get('Other')?.reason).toBe('blocked');
        persistEnded(file,ended);expect(loadEnded(file).get('Other')?.reason).toBe('blocked');
        expect(startable(['Repaired','Other'],true,ended,()=>1,()=>200,'new').start).toEqual([]);
        expect(startable(['Repaired'],true,ended,()=>31000,()=>200,'new').start).toEqual(['Repaired']);
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('invalid end-state files fail closed at startup and preserve the raw failed file', () => {
    const dir=mkdtempSync(join(tmpdir(),'swarm-repair-bad-')),file=join(dir,'ends.json');
    try {
        const ended=new Map([['Worker',{at:100,reason:'died'}]]);
        for(const raw of ['{','[]','null','{"Worker":{"at":100}}','{"Worker":{"at":-1,"reason":"done"}}','{"Worker":{"at":100,"reason":"done"},"worker":{"at":101,"reason":"done"}}']){
            writeFileSync(file,raw);
            expect(readFileSync(file,'utf8')).toBe(raw);
            expect(()=>loadEnded(file)).toThrow();
        }
        rmSync(file);
        expect(ended.get('Worker')?.reason).toBe('died');
        expect(loadEnded(file).size).toBe(0);
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('invalid, stale and repeated repair requests cannot reopen completed work or clear a newer failure', () => {
    const dir=mkdtempSync(join(tmpdir(),'swarm-repair-silent-')),file=join(dir,'ends.json');
    try {
        const ended=new Map<string,any>([['Worker',{at:100,reason:'done',revision:'mission'}]]);
        persistEnded(file,new Map([['Worker',{at:100,reason:'done',revision:'mission'}]]));
        const raw=readFileSync(file,'utf8');
        for (const request of [null,[],{},'Worker',{account:'Worker',endedAt:-1},{account:'../Worker',endedAt:100},{account:'Worker',endedAt:100,...proofRef}])
            expect(applyEndRepair(request,ended,[],confirmed).changed).toBe(false);
        expect(ended.get('Worker')).toEqual({at:100,reason:'done',revision:'mission'});
        expect(readFileSync(file,'utf8')).toBe(raw);
        ended.set('Worker',{at:200,reason:'died',revision:rev('scripts/fight.ts')});
        expect(applyEndRepair({account:'Worker',endedAt:100,...proofRef},ended,[],confirmed).changed).toBe(false);
        expect(applyEndRepair({account:'Worker',endedAt:200,...proofRef},ended,[],confirmed).changed).toBe(true);
        expect(applyEndRepair({account:'Worker',endedAt:200,...proofRef},ended,[],confirmed)).toEqual({changed:false,reason:'already clear'});
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('food courier admission needs owned active low-food farm and dated cooked source bank; default jobs stay unchanged',()=>{
    const now=100000,owned=new Set(['farm','cook']);
    const job:Job={account:'Courier',script:'scripts/foodcourier.ts',enabled:true,whenFoodLowFrom:['Farm'],foodSourceAccount:'Cook'};
    const farm={name:'Farm',server:'rs-sdk-demo.fly.dev',at:now-1000,result:'',bankAt:now-2000,bank:[{id:333,count:50}],inventory:[{id:329,count:25}]};
    const cook={name:'Cook',server:'rs-sdk-demo.fly.dev',at:now,result:'',bankAt:now-5000,bank:[{id:329,count:100}]};
    const demand=(f:any=farm,c:any=cook,j:Job=job,o=owned)=>foodSupplyDemand(j,[f,c],o,now);
    expect(demand()).toBe(true);
    expect(demand({...farm,inventory:[{id:329,count:30}]})).toBe(false); // exactly80 is not low
    expect(demand({...farm,inventory:[{id:330,count:30}]})).toBe(false); // incoming cooked notes count too
    for(const change of [{at:now-30000},{at:now+1},{result:'ok paused'},{server:'localhost:8888'},{name:'Other'},
        {bank:null},{bankAt:null},{bankAt:now+1},{bank:[{name:'Trout',count:1}]}])expect(demand({...farm,...change})).toBe(false);
    for(const change of [{at:now-30000},{at:now+1},{result:'ok stopped'},{bankAt:undefined},{bankAt:now+1},{server:'localhost:8888'},{name:'Other'},
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
test('a host or orchestrate job reserves one startup heap; separate bots reserve one each', () => {
    const job={account:'A',script:'scripts/x.ts',enabled:true,repeat:false} as Job;
    expect(startReserve({host:true,job},3)).toBe(1);
    expect(startReserve({host:false,job:{...job,orchestrate:true}},8)).toBe(1);
    expect(startReserve({host:false,job},2)).toBe(2);
});
test('admission reserves pending heaps and a new account before enforcing the free-memory floor', () => {
    const base={running:3,external:0,starting:1,pending:0,freeGB:10.5,minFreeGB:8,maxBots:6};
    expect(admissionDecision(base).allowed).toBe(true);
    expect(admissionDecision({...base,running:4,pending:1}).projectedFreeGB).toBe(8.5);
    expect(admissionDecision({...base,running:4,pending:1}).allowed).toBe(true);
    const third=admissionDecision({...base,running:5,pending:2});
    expect(third.reason).toBe('memory');expect(third.projectedFreeGB).toBe(7.5);
    expect(admissionDecision({...base,running:5,external:1}).reason).toBe('maxBots');
    expect(admissionDecision({...base,freeGB:FREE_FLOOR_GB+1,minFreeGB:0}).allowed).toBe(true);
    expect(admissionDecision({...base,freeGB:FREE_FLOOR_GB+0.9,minFreeGB:0}).reason).toBe('memory');
    expect(admissionDecision({...base,starting:3,freeGB:10.5}).reason).toBe('memory');
    expect(admissionDecision({...base,freeGB:NaN}).allowed).toBe(false);
});

test('an open recovery gets the bot slot that frees at a full fleet, before a waiting planner job', async () => {
    const { recoverySlot, recoverySlotReserve, recoveryLeaseHeld, admitRecovery, RECOVERY_SLOT_HOLD_MS, RECOVERY_LEASE_MAX_MS } = await import('./swarm');
    const cap = { external: 0, pending: 0, freeGB: 64, minFreeGB: 0, maxBots: 25 };
    let slot = { until: 0 } as ReturnType<typeof recoverySlot>, now = 1_000_000;
    // The admission of one account of a job, as the controller's tick calls it.
    const job = (account: string, running: number, freeGB = cap.freeGB) => admissionDecision({ ...cap, freeGB, running,
        starting: 1 + recoverySlotReserve(slot, { recovering: false, accounts: [account], now }), startingReserve: 1 });
    const recovery = (running: number, freeGB = cap.freeGB) => admitRecovery({ account: 'Rod', active: [], ...cap, freeGB, running }, () => {});
    // The fleet is full and a planner job waits.
    expect(job('Planner', 25).reason).toBe('maxBots');
    // A recovery request opens: the coordinator holds the repair lease. No slot is free, so each side waits.
    slot = recoverySlot(slot, { leaseHeld: true, started: [], now });
    expect(() => recovery(25)).toThrow('recovery admission waiting: maxBots');
    // One bot ends. The planner job does not get the slot; the recovery does.
    now += 2000; slot = recoverySlot(slot, { leaseHeld: true, started: [], now });
    expect(job('Planner', 24).reason).toBe('maxBots');
    expect(() => recovery(24)).not.toThrow();
    // The cleanup child counts in the running bots: it uses the slot, and nothing more is held.
    now += 2000; slot = recoverySlot(slot, { leaseHeld: true, recovering: 'Rod', started: [], now });
    expect(recoverySlotReserve(slot, { recovering: true, accounts: ['Planner'], now })).toBe(0);
    // The child ends and the coordinator releases the lease. The job of the recovered account is not installed yet.
    now += 2000; slot = recoverySlot(slot, { leaseHeld: false, started: [], now });
    expect(job('Planner', 24).reason).toBe('maxBots');
    expect(job('rod', 24).allowed).toBe(true);
    // Its job starts: the hold ends and the fleet is full again.
    now += 2000; slot = recoverySlot(slot, { leaseHeld: false, started: ['Rod'], now });
    expect(slot.until).toBe(0);
    expect(job('Planner', 25).reason).toBe('maxBots');
    expect(job('Planner', 24).allowed).toBe(true);

    // A recovery whose job never starts keeps the slot for RECOVERY_SLOT_HOLD_MS after its last sign, no longer.
    slot = recoverySlot({ until: 0 }, { leaseHeld: false, recovering: 'Rod', started: [], now });
    slot = recoverySlot(slot, { leaseHeld: false, started: [], now: now + 2000 });
    expect(recoverySlotReserve(slot, { recovering: false, accounts: ['Planner'], now: now + RECOVERY_SLOT_HOLD_MS - 1 })).toBe(1);
    expect(recoverySlotReserve(slot, { recovering: false, accounts: ['Planner'], now: now + RECOVERY_SLOT_HOLD_MS })).toBe(0);
    expect(recoverySlot(slot, { leaseHeld: false, started: [], now: now + RECOVERY_SLOT_HOLD_MS })).toEqual({ until: 0 });
    // The next recovery opens its lease while the job of the one before starts: the hold stays, for the new request.
    slot = recoverySlot({ until: now + 1, account: 'Rod' }, { leaseHeld: true, started: ['Rod'], now });
    expect(slot).toEqual({ until: now + RECOVERY_SLOT_HOLD_MS });
    expect(job('Planner', 24).reason).toBe('maxBots');

    // The held slot changes the bot count only. A memory refusal stays a memory refusal, for the job and the recovery.
    slot = recoverySlot({ until: 0 }, { leaseHeld: true, started: [], now });
    const held = job('Planner', 10, FREE_FLOOR_GB + 1), free = admissionDecision({ ...cap, freeGB: FREE_FLOOR_GB + 1, running: 10, starting: 1, startingReserve: 1 });
    expect(held.allowed).toBe(true); expect(held.projectedFreeGB).toBe(free.projectedFreeGB);
    expect(job('Planner', 10, FREE_FLOOR_GB + 0.9).reason).toBe('memory');
    expect(() => recovery(24, FREE_FLOOR_GB + 0.9)).toThrow('recovery admission waiting: memory');

    // The lease counts while its file is younger than RECOVERY_LEASE_MAX_MS: a lease that a dead process left holds no slot.
    const dir = mkdtempSync(join(tmpdir(), 'recovery-lease-')), lease = join(dir, 'swarm-repair.json.lease');
    expect(recoveryLeaseHeld(lease, Date.now())).toBe(false);
    writeFileSync(lease, '{}');
    const written = statSync(lease).mtimeMs;
    expect(recoveryLeaseHeld(lease, written + RECOVERY_LEASE_MAX_MS - 1)).toBe(true);
    expect(recoveryLeaseHeld(lease, written + RECOVERY_LEASE_MAX_MS)).toBe(false);
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

test('either configured cook and retained courier notes keep a hungry farm supplied',()=>{
    const now=100000,owned=new Set(['farm','first','second','courier']);
    const job:Job={account:'Courier',script:'scripts/foodcourier.ts',enabled:true,whenFoodLowFrom:['Farm'],foodSourceAccounts:['First','Second'],sourceFoodMinimum:1};
    const farm={name:'Farm',server:'rs-sdk-demo.fly.dev',at:now,result:'',bankAt:now-1,bank:[],inventory:[]};
    const second={name:'Second',server:'rs-sdk-demo.fly.dev',at:now,result:'',bankAt:now-1,bank:[{id:333,count:170}]};
    expect(foodSupplyDemand(job,[farm,second],owned,now)).toBe(true);
    expect(foodSupplyDemand(job,[farm,{...second,result:'fail stopped'}],owned,now)).toBe(false);
    const courier={name:'Courier',server:'rs-sdk-demo.fly.dev',at:now-60000,result:'ok done',pos:{x:2653,z:3283,level:0},inventory:[{id:334,count:115}]};
    expect(foodSupplyDemand(job,[farm,courier],owned,now)).toBe(true);
    for(const patch of [{pos:{x:3222,z:3218,level:0}},{inventory:[{id:333,count:115}]},{server:'localhost:8888'},{at:now+1},{name:'Foreign'}])
        expect(foodSupplyDemand(job,[farm,{...courier,...patch}],owned,now)).toBe(false);
    expect(foodSupplyDemand({...job,foodSourceAccounts:['Second','Foreign']},[farm,second,courier],owned,now)).toBe(false);
});

test('scoped coordinator starts only its qualified assignments while ordinary swarm preserves existing admission',()=>{
 const old={account:'Existing',script:'scripts/cook-wine.ts',enabled:true} as Job;
 expect(coordinatedAdmission(old,false)).toBe(true);expect(coordinatedAdmission(old,true)).toBe(false);
 expect(coordinatedAdmission({...old,coordinatorOwner:'coordinator'} as Job,true)).toBe(true);
 expect(coordinatedAdmission({...old,standing:true} as Job,true)).toBe(true);
});

test('repair re-reads exact producer proof: new intent, late old callback, unknown cleanup and missing proof refuse',()=>{
    const root=mkdtempSync(join(tmpdir(),'swarm-proof-'));
    try{
        const proofs=lifecycleProofs(root),fail=()=>new Map([['Rod',{at:100,reason:'died after 1 runs',revision:rev('scripts/gather-fire-combat.ts')}]]);
        const req=(attemptId:string)=>({account:'Rod',endedAt:100,server:LIVE,proof:{kind:'producer',attemptId}});
        expect(applyEndRepair(req('x'),fail(),[],proofs).reason).toBe('no producer logout proof');
        const old=loggedOut(root,'Rod');
        // A new pre-START connection supersedes the old logout before any status exists.
        const fresh=beginSessionAttempt({account:'Rod',server:LIVE},{root,owner});
        expect(applyEndRepair(req(old.attemptId),fail(),[],proofs).reason).toBe('logout proof superseded by a newer attempt');
        expect(applyEndRepair(req(fresh.attemptId),fail(),[],proofs).reason).toMatch(/^logout not confirmed: connection attempt before START/);
        fresh.record('connected');fresh.record('logout','timeout');
        expect(applyEndRepair(req(fresh.attemptId),fail(),[],proofs).reason).toBe('logout not confirmed: logout timeout without an observed end');
        fresh.record('ended','disconnected');
        expect(applyEndRepair(req(fresh.attemptId),fail(),[],proofs).reason).toBe('logout not confirmed: ended disconnected');
        // A late callback cannot rewrite a recorded end or move the latest pointer back.
        expect(fresh.record('ended','logged-out')).toBe(false);old.record('closed');
        expect(applyEndRepair(req(old.attemptId),fail(),[],proofs).reason).toBe('logout proof superseded by a newer attempt');
        const last=loggedOut(root,'Rod'),ended=fail(),holds:ScriptHold[]=[];
        expect(applyEndRepair(req(last.attemptId),ended,[],proofs,holds)).toEqual({changed:true,reason:`repaired failure cleared (producer ${last.attemptId})`});
        expect(ended.size).toBe(0);expect(holds.map(h=>[h.account,h.script,h.at])).toEqual([['Rod','scripts/gather-fire-combat.ts',100]]);
        expect(applyEndRepair({account:'Rod',endedAt:100,server:LIVE},fail(),[],proofs).reason).toBe('missing logout proof');
        expect(applyEndRepair(req(last.attemptId),new Map([['Rod',{at:100,reason:'died'}]]),[],proofs).reason).toBe('failed script unknown; hold cannot be kept');
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('crossed account/server, practice identity, competing owner, malformed persistence and stop files cannot release a block',()=>{
    const root=mkdtempSync(join(tmpdir(),'swarm-cross-'));
    try{
        const proofs=lifecycleProofs(root),fail=()=>new Map([['Rod',{at:100,reason:'died',revision:rev('scripts/fight.ts')}]]);
        const other=loggedOut(root,'Other'),practice=loggedOut(root,'Rod','localhost:8888');
        expect(applyEndRepair({account:'Rod',endedAt:100,server:LIVE,proof:{kind:'producer',attemptId:other.attemptId}},fail(),[],proofs).reason).toBe('no producer logout proof');
        expect(applyEndRepair({account:'Rod',endedAt:100,server:'localhost:8888',proof:{kind:'producer',attemptId:practice.attemptId}},fail(),[],proofs).reason).toBe('repair server is not the live server');
        const live=loggedOut(root,'Rod'),req={account:'Rod',endedAt:100,server:LIVE,proof:{kind:'producer',attemptId:live.attemptId}};
        expect(applyEndRepair(req,fail(),['rod'],proofs).reason).toBe('account still active');
        // A status showing a session after the logout, outside the receipts (or another attempt), refuses.
        const loggedAt=(readLogoutProof('Rod',LIVE,{root}) as any).loggedOutAt;
        const withStatus=(st:any):RepairProofs=>({...proofs,status:()=>st});
        expect(applyEndRepair(req,fail(),[],withStatus({server:LIVE,started:loggedAt+1})).reason).toBe('status shows a session the logout proof does not cover');
        expect(applyEndRepair(req,fail(),[],withStatus({server:LIVE,sessionAttemptId:'other'})).reason).toBe('status shows a session the logout proof does not cover');
        expect(applyEndRepair(req,fail(),[],{...proofs,status:()=>{throw Error('bad json');}}).reason).toBe('status unreadable');
        expect(applyEndRepair(req,fail(),[],withStatus({server:LIVE,started:loggedAt-5,sessionAttemptId:live.attemptId})).changed).toBe(true);
        // A crossed receipt behind the pointer is invalid, not proof.
        const dir=join(root,'live','rs-sdk-demo.fly.dev','rod');
        const file=join(dir,'attempts',`${live.attemptId}.json`),raw=readFileSync(file,'utf8');
        writeFileSync(file,raw.replace('"account":"Rod"','"account":"Other"'));
        expect(applyEndRepair(req,fail(),[],proofs).reason).toBe('invalid logout proof: latest attempt identity mismatch');
        writeFileSync(file,'{');expect(applyEndRepair(req,fail(),[],proofs).reason).toBe('invalid logout proof: latest attempt missing or malformed');
        writeFileSync(file,raw);writeFileSync(join(dir,'latest.json'),'{');
        expect(applyEndRepair(req,fail(),[],proofs).reason).toBe('invalid logout proof: malformed latest pointer');
        rmSync(join(dir,'latest.json'));expect(applyEndRepair(req,fail(),[],proofs).reason).toBe('invalid logout proof: attempts without a latest pointer');
        // A real repair still leaves an operator stop in force.
        const fixed=loggedOut(root,'Rod'),ended=fail();
        expect(applyEndRepair({...req,proof:{kind:'producer',attemptId:fixed.attemptId}},ended,[],proofs).changed).toBe(true);
        expect(startable(['Rod'],false,ended,()=>Infinity,undefined,'m',()=>true).blocked.Rod).toBe('paused: stop file');
        // The default reader is identity-bound too: an invalid name is refused before any file read.
        expect(currentLogout({account:'../x',server:LIVE,proof:{kind:'producer',attemptId:'a'}},defaultRepairProofs)).toEqual({ok:false,reason:'invalid logout proof: invalid identity'});
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('old combat stays held after a fishing transition until same-script post-failure qualification',()=>{
    const root=mkdtempSync(join(tmpdir(),'swarm-hold-'));
    try{
        const proofs=lifecycleProofs(root),holdsFile=join(root,'holds.json');
        const ended=new Map([['Rod',{at:100,reason:'died after 1 runs',revision:rev('scripts/gather-fire-combat.ts')}]]),holds:ScriptHold[]=[];
        // Before repair the account-level failure blocks every role.
        expect(holdCandidates(startable(['Rod'],false,ended,()=>Infinity),'scripts/shark-supply.ts',holds).start).toEqual([]);
        const first=loggedOut(root,'Rod');
        expect(applyEndRepair({account:'Rod',endedAt:100,server:LIVE,proof:{kind:'producer',attemptId:first.attemptId}},ended,[],proofs,holds).changed).toBe(true);
        persistHolds(holdsFile,holds);const loaded=loadHolds(holdsFile);
        // Valid finite role transfer: fishing may start; the old combat script may not.
        expect(holdCandidates(startable(['Rod'],false,ended,()=>Infinity),'scripts/shark-supply.ts',loaded).start).toEqual(['Rod']);
        expect(holdCandidates(startable(['Rod'],false,ended,()=>Infinity),'./scripts\\gather-fire-combat.ts',loaded).blocked.Rod).toMatch(/^held: failed scripts\/gather-fire-combat.ts/);
        // A later fishing success and account-level end deletion do not unban combat.
        ended.set('Rod',{at:300,reason:'done',revision:rev('scripts/shark-supply.ts')});ended.delete('Rod');
        expect(holdCandidates(startable(['Rod'],false,ended,()=>Infinity),'scripts/gather-fire-combat.ts',loaded).start).toEqual([]);
        const receiptPath=join(root,'qualify.json'),write=(r:object)=>{writeFileSync(receiptPath,JSON.stringify(r));return createHash('sha256').update(readFileSync(receiptPath)).digest('hex');};
        const latest=()=>{const p=readLogoutProof('Rod',LIVE,{root});return 'attemptId' in p?p.attemptId:'none';};
        const good=()=>({ok:true,script:'scripts/gather-fire-combat.ts',account:'rod',at:500,attemptId:latest()});
        const q=(sha:string,at=500)=>({kind:'script-qualified',account:'Rod',script:'scripts/gather-fire-combat.ts',holdAt:100,server:LIVE,
            proof:{kind:'producer',attemptId:latest()},qualification:{receiptPath,receiptSha256:sha,at}});
        expect(applyScriptQualification(q(write({...good(),script:'scripts/shark-supply.ts'})),loaded,[],proofs).changed).toBe(false);
        expect(applyScriptQualification(q(write({...good(),at:50}),50),loaded,[],proofs).reason).toBe('qualification is not newer than the failure');
        expect(applyScriptQualification(q(write({...good(),ok:false})),loaded,[],proofs).changed).toBe(false);
        // A practice or other-session success is not bound to the live producer logout.
        expect(applyScriptQualification(q(write({...good(),attemptId:'1793249737408-0000000001-0000000001'})),loaded,[],proofs).reason).toBe('qualification is not bound to the current producer logout');
        const sha=write(good());writeFileSync(receiptPath,JSON.stringify({...good(),extra:1}));
        expect(applyScriptQualification(q(sha),loaded,[],proofs).reason).toBe('qualification receipt hash changed');
        const valid=write(good());
        expect(applyScriptQualification(q(valid),loaded,['ROD'],proofs).reason).toBe('account still active');
        beginSessionAttempt({account:'Rod',server:LIVE},{root,owner});
        expect(applyScriptQualification(q(valid),loaded,[],proofs).changed).toBe(false);
        loggedOut(root,'Rod');
        expect(applyScriptQualification(q(valid),loaded,[],proofs).reason).toBe('qualification is not bound to the current producer logout');
        expect(applyScriptQualification(q(write(good())),loaded,[],proofs).reason).toBe('script qualification unsupported: caller receipt has no producer-bound work result');
        expect(loaded[0]!.qualified).toBeUndefined();
        expect(holdCandidates({start:['Rod'],blocked:{}},'scripts/gather-fire-combat.ts',loaded).start).toEqual([]);
        for(const bad of ['{','{}','[{"account":"Rod"}]']){writeFileSync(holdsFile,bad);expect(()=>loadHolds(holdsFile)).toThrow();}
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('persisted unsupported qualification fields never close a failed-script hold',()=>{
 const root=mkdtempSync(join(tmpdir(),'unsupported-hold-')),file=join(root,'holds.json');
 try{for(const script of ['scripts/gather-fire-combat.ts','.\\Scripts\\Gather-Fire-Combat.ts'])for(const qualified of [true,{}, {at:500,receiptPath:'caller.json',receiptSha256:'a'.repeat(64),recordedAt:501}]){
  writeFileSync(file,JSON.stringify([{account:'Rod',script,at:100,reason:'blocked',heldAt:101,qualified}]));
  const holds=loadHolds(file);
  expect(holdCandidates({start:['Rod'],blocked:{}},'scripts/gather-fire-combat.ts',holds).start).toEqual([]);
  expect(holdCandidates({start:['Rod'],blocked:{}},'scripts/shark-supply.ts',holds).start).toEqual(['Rod']);
 }}finally{rmSync(root,{recursive:true,force:true});}
});

test('anonymous legacy logs cannot qualify logout even with exact hashes and matching adjacent status',()=>{
    const root=mkdtempSync(join(tmpdir(),'swarm-legacy-'));
    try{
        const proofs=lifecycleProofs(root),statusPath=join(root,'status.json'),logPath=join(root,'worker.log');
        writeFileSync(statusPath,JSON.stringify({name:'Rod',server:LIVE,at:1793158560221,result:'ok'}));
        const legacyLog='START 1 2 0\nLOGOUT_PROBE_END {}\nLOGOUT logged-out\nRESULT ok x\n';writeFileSync(logPath,legacyLog);
        const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
        const claim={kind:'legacy-logout',account:'Rod',server:LIVE,statusPath,statusSha256:sha(statusPath),statusAt:1793158560221,logPath,logSha256:sha(logPath)};
        const fail=()=>new Map([['Rod',{at:100,reason:'blocked after 1 runs',revision:rev('scripts/gather-fire-combat.ts')}]]);
        const req=(proof:object)=>({account:'Rod',endedAt:100,server:LIVE,proof});
        expect(applyEndRepair(req(claim),fail(),[],proofs).reason).toBe('legacy proof refused: anonymous legacy log has no independent account/server/session attribution');
        expect(applyEndRepair(req({...claim,account:'Other'}),fail(),[],proofs).reason).toBe('legacy proof identity mismatch');
        expect(applyEndRepair(req({...claim,statusAt:1}),fail(),[],proofs).reason).toBe('legacy proof refused: legacy status identity mismatch');
        // Timeout or RESULT-only text is never a legacy logout.
        const timeout=join(root,'timeout.log');writeFileSync(timeout,'START 1 2 0\nLOGOUT timeout\nRESULT ok x\n');
        expect(applyEndRepair(req({...claim,logPath:timeout,logSha256:sha(timeout)}),fail(),[],proofs).reason).toMatch(/^legacy proof refused: legacy log lacks/);
        writeFileSync(logPath,'START 1 2 0\nLOGOUT logged-out\nRESULT ok y\n');
        expect(applyEndRepair(req(claim),fail(),[],proofs).reason).toBe('legacy proof refused: legacy evidence hash changed');
        writeFileSync(logPath,legacyLog);
        // Any newer producer intent, even a pre-START partial connection, overrides legacy evidence.
        beginSessionAttempt({account:'Rod',server:LIVE},{root,owner});
        expect(applyEndRepair(req(claim),fail(),[],proofs).reason).toBe('legacy proof refused: producer evidence exists: held');
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('a refused job starts again only when it changes; a gave-up job stays held', async () => {
    const { startable } = await import('./swarm');
    const refused = new Map([['Fisher', { reason: 'refused after 1 runs', revision: 'shark-at-varrock' }]]);
    expect(startable(['Fisher'], false, refused, () => Infinity, undefined, 'shark-at-varrock', () => false).start).toEqual([]);
    expect(startable(['Fisher'], false, refused, () => Infinity, undefined, 'shark-walks', () => false).start).toEqual(['Fisher']);
    const gaveUp = new Map([['Fisher', { reason: 'gave-up after 1 runs', revision: 'a' }]]);
    expect(startable(['Fisher'], false, gaveUp, () => Infinity, undefined, 'b', () => false).start).toEqual([]);
});

test('an end from before producer receipts clears with a settled live status, not a fresh or unfinished one', async () => {
    const { applyEndRepair } = await import('./swarm');
    const LIVE_SRV = 'rs-sdk-demo.fly.dev', now = 10_000_000;
    const ended = () => new Map([['Thief', { at: 100, reason: 'gave-up after 1 runs', revision: '["scripts/agility-order.ts"]' }]]);
    const proofs = (st: any) => ({ readProof: () => ({ state: 'none' }) as any, verifyLegacy: () => ({ state: 'refused', reason: 'x' }) as any, now: () => now, status: () => st });
    const req = { account: 'Thief', endedAt: 100, server: LIVE_SRV, proof: { kind: 'settled-status' } };
    expect(applyEndRepair(req, ended(), [], proofs({ server: LIVE_SRV, result: 'fail gate', at: now - 16 * 60_000 })).changed).toBe(true);
    expect(applyEndRepair(req, ended(), [], proofs({ server: LIVE_SRV, result: 'fail gate', at: now - 60_000 })).reason).toBe('status changed in the last 15 minutes');
    expect(applyEndRepair(req, ended(), [], proofs({ server: LIVE_SRV, result: '', at: now - 16 * 60_000 })).reason).toBe('status shows no finished session');
});

test('a host job passes its script arguments to every hosted bot', async () => {
    const { supervisorCommand } = await import('./swarm');
    const { parseHostArgs } = await import('../packages/core/src/host');
    const cmd = supervisorCommand({ key: 'host:A+B', accounts: ['A', 'B'], host: true, job: { accounts: ['A', 'B'], script: 'scripts/agility-order.ts', args: ['gnome', '40'], host: true } as any }, ['A', 'B']);
    expect(cmd.slice(-4)).toEqual(['--arg', 'gnome', '--arg', '40']);
    expect(parseHostArgs(['scripts/agility-order.ts', 'A', 'B', '--stagger-ms', '2000', '--arg', 'gnome', '--arg', '40'])).toMatchObject({ names: ['A', 'B'], args: ['gnome', '40'], stagger: 2000 });
});

test('a host job gives each account its own env, for the accounts it starts', async () => {
    const { supervisorCommand, parseJob, missionSignature } = await import('./swarm');
    const job: Job = { accounts: ['A', 'B', 'C'], host: true, script: 'scripts/chain.ts', args: ['scripts/generated/thieving60.ts TARGET=55 CAP=3000', 'scripts/goldfarm.ts'], env: { ROUNDS: '1' }, envByAccount: { A: { KNIGHT_SPOT: '2670,3306' }, C: { KNIGHT_SPOT: '2653,3302', TICKS: '9000' } }, enabled: true };
    const p = parseJob(job); if ('error' in p) throw Error(p.error);
    expect(supervisorCommand(p, ['A', 'C'])).toEqual(['bun', 'packages/practice/src/supervise-host.ts', 'scripts/chain.ts', '20', 'A', 'C',
        '--arg', 'scripts/generated/thieving60.ts TARGET=55 CAP=3000', '--arg', 'scripts/goldfarm.ts', '--env', 'A', 'KNIGHT_SPOT=2670,3306', '--env', 'C', 'KNIGHT_SPOT=2653,3302', '--env', 'C', 'TICKS=9000']);
    expect(parseJob({ ...job, envByAccount: { Z: { K: '1' } } })).toEqual({ error: 'envByAccount names Z, which is not in "accounts"' });
    expect(parseJob({ ...job, envByAccount: { A: { K: 1 } } as any })).toEqual({ error: 'envByAccount for A must map KEY to a string' });
    expect(parseJob({ account: 'A', script: 'scripts/goldfarm.ts', enabled: true, envByAccount: { A: { K: '1' } } })).toEqual({ error: '"envByAccount" needs "host": true' });
    const base = missionSignature({ ...job, envByAccount: undefined });
    expect(base).toBe(missionSignature({ ...job, envByAccount: {} }));
    expect(missionSignature(job)).not.toBe(base);
    expect(missionSignature({ ...job, envByAccount: { ...job.envByAccount, A: { KNIGHT_SPOT: '2671,3313' } } })).not.toBe(missionSignature(job));
});

test('a repaired gave-up or blocked end leaves no script hold; a death does', () => {
    const proofs: any = { readProof: () => ({ state: 'confirmed', account: 'Rod', server: 'rs-sdk-demo.fly.dev', domain: 'live', attemptId: 'a1', loggedOutAt: 50, ownerRun: null, receiptSha256: 'x' } as any), verifyLegacy: () => ({ state: 'refused' } as any), now: () => 1000 };
    for (const [reason, held] of [['gave-up after 1 runs', 0], ['blocked after 1 runs', 0], ['died after 1 runs', 1]] as const) {
        const ended = new Map([['Rod', { at: 100, reason, revision: JSON.stringify(['scripts/quest-chain.ts']) }]]), holds: ScriptHold[] = [];
        expect(applyEndRepair({ account: 'Rod', endedAt: 100, server: 'rs-sdk-demo.fly.dev', proof: { kind: 'producer', attemptId: 'a1' } }, ended, [], proofs, holds).changed).toBe(true);
        expect(holds.length).toBe(held);
    }
});
test('a held session whose owner pid is gone gets an end record; live, busy or already ended accounts do not', async () => {
    const { orphanedSessionEnds } = await import('./swarm');
    const held = (a: string) => ({ state: 'held' as const, account: a, server: 's', domain: 'live' as const, attemptId: 'id-' + a, reason: 'session active or outcome unknown' });
    const pids: Record<string, number> = { 'id-Dead': 11, 'id-Live': 12, 'id-Busy': 13, 'id-Ended': 14 };
    const ended = new Map([['ended', { at: 1, reason: 'exit 1' }]]);
    const out = orphanedSessionEnds(['Dead', 'dead', 'Live', 'Busy', 'Ended', 'Clean', 'NoPid'], ended, ['busy'],
        a => a === 'Clean' ? { state: 'confirmed', account: a, server: 's', domain: 'live', attemptId: 'x', loggedOutAt: 1, ownerRun: null, receiptSha256: '' } : held(a),
        (_a, id) => pids[id] ? { pid: pids[id]!, createdAt: 1, updatedAt: 2 } : undefined, pid => pid === 12);
    expect(out).toEqual([['Dead', 'exit orphaned: attempt id-Dead owner 11 gone']]);
});
test('a held session whose owner pid a later process holds gets an end record, from one read of the process table', async () => {
    const { orphanedSessionEnds } = await import('./swarm');
    const held = (a: string) => ({ state: 'held' as const, account: a, server: 's', domain: 'live' as const, attemptId: 'id-' + a, reason: 'session active or outcome unknown' });
    const pids: Record<string, number> = { 'id-Reused': 21, 'id-Owner': 22, 'id-Unlisted': 23, 'id-Dead': 24, 'id-Ended': 25 };
    const producer = (_a: string, id: string) => ({ pid: pids[id]!, createdAt: 1_000_000, updatedAt: 1_000_500 });
    const ended = new Map([['Ended', { at: 1, reason: 'exit 1' }]]), answers = (pid: number) => pid !== 24, reads: number[][] = [];
    // 21 started after its receipt: a different process. 22 started before its receipt: the owner. 23 is not in the table.
    const starts = (asked: readonly number[]) => { reads.push([...asked]); return new Map([[21, 1_000_000 + PID_START_SLACK_MS + 1], [22, 999_960], [25, 2_000_000]]); };
    expect(orphanedSessionEnds(['Reused', 'Owner', 'Unlisted', 'Dead', 'Ended'], ended, [], held, producer, answers, starts))
        .toEqual([['Reused', 'exit orphaned: attempt id-Reused owner 21 gone'], ['Dead', 'exit orphaned: attempt id-Dead owner 24 gone']]);
    // One read, and only for the ids that answer a signal and whose end the scan can record.
    expect(reads).toEqual([[21, 22, 23]]);
    // A failed read proves nothing: the signal check decides alone. No id answers: no read.
    expect(orphanedSessionEnds(['Reused'], new Map(), [], held, producer, answers, () => null)).toEqual([]);
    expect(orphanedSessionEnds(['Dead'], new Map(), [], held, producer, answers, starts).length).toBe(1);
    expect(reads.length).toBe(1);
});
test('the orphan scan replaces only a successful end, and only for an attempt that started after it', async () => {
    const { orphanedSessionEnds } = await import('./swarm');
    const ended = new Map([
        ['Retired', { at: 100, reason: 'done after 1 runs' }],
        ['SameSession', { at: 100, reason: 'done after 1 runs' }],
        ['Died', { at: 100, reason: 'died during cows' }],
        ['Stopped', { at: 100, reason: 'stopped after 1 runs' }],
    ]);
    const held = (account: string) => ({
        state: 'held' as const, account, server: 's', domain: 'live' as const,
        attemptId: 'new-' + account, reason: 'session active or outcome unknown',
    });
    const producer = (account: string) => ({ pid: 11, createdAt: account === 'SameSession' ? 90 : 150, updatedAt: 200 });
    const out = orphanedSessionEnds(['Retired', 'SameSession', 'Died', 'Stopped'], ended, [], held, producer, () => false);
    expect(out).toEqual([['Retired', 'exit orphaned: attempt new-Retired owner 11 gone']]);
});

test('the orphan scan refreshes an older orphan end for a newer held attempt only', async () => {
    const { orphanedSessionEnds } = await import('./swarm');
    const prior = { at: 100, reason: 'exit orphaned: attempt old owner 10 gone' };
    const ended = new Map([
        ['Mightyrod', prior],
        ['AlreadyCurrent', { ...prior, at: 200 }],
        ['OwnerStopped', { at: 100, reason: 'stopped by owner' }],
        ['OwnerAlive', prior],
        ['StillBusy', prior],
    ]);
    const held = (account: string) => ({
        state: 'held' as const, account, server: 's', domain: 'live' as const,
        attemptId: 'new-' + account, reason: 'ended stopped',
    });
    const producer = (account: string) => ({ pid: account === 'OwnerAlive' ? 12 : 11, createdAt: 50, updatedAt: 200 });
    const out = orphanedSessionEnds(
        ['mightyrod', 'AlreadyCurrent', 'OwnerStopped', 'OwnerAlive', 'StillBusy'], ended,
        ['stillbusy'], held, producer, pid => pid === 12,
    );
    expect(out).toEqual([['Mightyrod', 'exit orphaned: attempt new-mightyrod owner 11 gone']]);
});
test('the orphan scan finds lifecycle accounts outside the plan and skips the protected accounts', async () => {
    const { orphanedSessionEnds, lifecycleAccounts } = await import('./swarm');
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'));
    try {
        for (const [folder, account] of [['offplan', 'OffPlan'], ['haggis', 'Haggis']]) {
            mkdirSync(join(dir, folder), { recursive: true });
            writeFileSync(join(dir, folder, 'latest.json'), JSON.stringify({ account }));
        }
        mkdirSync(join(dir, 'broken'));
        expect(lifecycleAccounts(dir).sort()).toEqual(['Haggis', 'OffPlan']);
        const held = (a: string) => ({ state: 'held' as const, account: a, server: 's', domain: 'live' as const, attemptId: 'id', reason: 'r' });
        expect(orphanedSessionEnds(lifecycleAccounts(dir), new Map(), [], held, () => ({ pid: 5, createdAt: 1, updatedAt: 2 }), () => false).map(([a]) => a)).toEqual(['OffPlan']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two jobs for one account do not queue a resume on every tick', () => {
    const planned = [parseJob({ account: 'YewFirst', script: 'scripts/session-check.ts', enabled: false } as any), parseJob({ account: 'YewFirst', script: 'scripts/shop-buyer.ts', enabled: true } as any)]
        .filter((p): p is Exclude<typeof p, { error: string }> => !('error' in p));
    const enabled = enabledByAccount(planned);
    expect(enabled.get('yewfirst')).toBe(true);
    const previous = new Map<string, boolean>(), pending = new Set<string>();
    for (let tick = 0; tick < 3; tick++) for (const p of planned) for (const a of p.accounts) observeEnabled([a], enabled.get(a.toLowerCase()) === true, previous, pending);
    expect(pending.size).toBe(0);
    expect(enabledByAccount([parseJob({ account: 'Moneyshot', script: 'scripts/x.ts', enabled: false } as any)].filter((p): p is Exclude<typeof p, { error: string }> => !('error' in p))).get('moneyshot')).toBe(false);
});

test('a host job off beside one account on and one off reads each account on its own', () => {
    const ok = (p: ReturnType<typeof parseJob>): p is Exclude<typeof p, { error: string }> => !('error' in p);
    const planned = [
        parseJob({ accounts: ['A', 'B'], host: true, script: 'scripts/quest-chain.ts', enabled: false } as any),
        parseJob({ account: 'A', script: 'scripts/x.ts', enabled: true } as any),
        parseJob({ account: 'B', script: 'scripts/y.ts', enabled: false } as any),
    ].filter(ok);
    const enabled = enabledByAccount(planned);
    expect([enabled.get('a'), enabled.get('b')]).toEqual([true, false]);
    const previous = new Map<string, boolean>(), pending = new Set<string>();
    for (let tick = 0; tick < 3; tick++) for (const p of planned) for (const a of p.accounts) observeEnabled([a], enabled.get(a.toLowerCase()) === true, previous, pending);
    expect(pending.size).toBe(0);
});

test('a run another job of the account started is foreign to a job that is off or changed; its own run is not', () => {
    const ok = (p: ReturnType<typeof parseJob>): p is Exclude<typeof p, { error: string }> => !('error' in p);
    const standing = parseJob({ account: 'Rod', script: 'scripts/goldfarm.ts', enabled: true, standing: true, env: { KNIGHT_SPOT: '1,1' } } as any);
    const finished = parseJob({ account: 'Rod', script: 'scripts/session-check.ts', enabled: false, coordinatorOwner: 'coordinator', env: { CAP: '1600' } } as any);
    const planned = [standing, finished].filter(ok);
    const run = { revision: missionSignature(planned[0]!.job) };
    expect(foreignRun(planned, planned[1]!, run)).toBe(true);
    expect(foreignRun(planned, planned[0]!, run)).toBe(false);
    expect(foreignRun(planned, planned[0]!, { revision: 'changed-mission' })).toBe(false);
});

import { SWARM_STOP, clearSwarmStop, swarmWroteStop, standingRetryable, writeSwarmStop } from './swarm';
test('the controller knows its own stop files, and a standing job retries the ends a plan removal or a lost process leaves', () => {
    for (const t of Object.values(SWARM_STOP)) expect(swarmWroteStop(t)).toBe(true);
    // A lost lease logs the runs out with the worker's own refusal text; the next controller's planner clears it.
    expect(SWARM_STOP.lease).toBe('fleet controller lease unavailable');
    expect(swarmWroteStop(`${SWARM_STOP.lease}\n`)).toBe(true);
    expect(swarmWroteStop('hold offline until the GE pilot')).toBe(false);
    expect(swarmWroteStop(undefined)).toBe(false);
    for (const r of ['blocked: no food', 'gave-up after 3 runs', 'exit unknown']) expect(standingRetryable(r)).toBe(true);
    for (const r of ['died', 'done after 1 runs', 'exit 1', 'release-paused: pin missing', 'stopped after 3 runs and more']) expect(standingRetryable(r)).toBe(false);
    // A stopped end is the stop file's unless the account's RESULT says no food, the supervisor's other stopped end.
    expect(standingRetryable('stopped after 3 runs', 'fail stop file ticks=6888 picks=1550')).toBe(true);
    expect(standingRetryable('stopped after 3 runs', 'RESULT fail stop file ticks=10')).toBe(true);
    // Trooper and cow mode word a stop-file end their own way; a run that ended ok under the file is stopped too.
    expect(standingRetryable('stopped after 2 runs', 'fail mode=giant ok=false creditedKills=12 trainSkill=Strength stop=stop-file failure=no trooper progress: bounded target unmet')).toBe(true);
    expect(standingRetryable('stopped after 0 runs', 'ok mode=cow ok=true creditedKills=8 stop=max-kills')).toBe(true);
    expect(standingRetryable('stopped after 1 runs', 'fail fleet controller lease unavailable ticks=40')).toBe(true);
    expect(standingRetryable('stopped after 1 runs', 'fail no food')).toBe(false);
    expect(standingRetryable('stopped after 1 runs', 'RESULT fail no food ticks=900')).toBe(false);
    expect(standingRetryable('stopped after 1 runs')).toBe(false);
});


test('controller stop and resume preserve a stop file the owner wrote', () => {
    const parent = resolve(tmpdir()), base = mkdtempSync(join(parent, 'rsbot-stop-owner-'));
    try {
        const file = join(base, 'stop-Helper');
        writeSwarmStop(file, SWARM_STOP.all);
        expect(readFileSync(file, 'utf8')).toBe(SWARM_STOP.all);
        writeFileSync(file, 'owner pause');
        writeSwarmStop(file, SWARM_STOP.removed);
        expect(clearSwarmStop(file)).toBe(false);
        expect(readFileSync(file, 'utf8')).toBe('owner pause');
        writeFileSync(file, SWARM_STOP.job);
        expect(clearSwarmStop(file)).toBe(true);
        writeSwarmStop(file, SWARM_STOP.lease);
        expect(clearSwarmStop(file)).toBe(true);
        expect(existsSync(file)).toBe(false);
    } finally {
        if (/^rsbot-stop-owner-[^\\/]+$/.test(relative(parent, base))) rmSync(base, { recursive: true });
    }
});

import { adoptedRunAlive, PID_START_SLACK_MS } from './swarm';
test('an adopted run whose pid a later process holds is ended', () => {
    const run = { pid: 2856, started: 1_000_000 }, answers = () => true, gone = () => false;
    // The id answers a signal, but its process started after the run record: a different process.
    expect(adoptedRunAlive(run, answers, new Map([[2856, run.started + PID_START_SLACK_MS + 1]]))).toBe(false);
    // The supervisor starts before the record is written, and stays the run's process.
    expect(adoptedRunAlive(run, answers, new Map([[2856, run.started - 40]]))).toBe(true);
    expect(adoptedRunAlive(run, answers, new Map([[2856, run.started + PID_START_SLACK_MS]]))).toBe(true);
    // A failed read, or a table without the id, proves nothing: the signal check decides alone.
    expect(adoptedRunAlive(run, answers, null)).toBe(true);
    expect(adoptedRunAlive(run, answers, new Map([[10568, run.started + 60_000]]))).toBe(true);
    expect(adoptedRunAlive(run, gone, null)).toBe(false);
    expect(adoptedRunAlive(run, gone, new Map([[2856, run.started - 40]]))).toBe(false);
    // A record without a start time cannot prove a different process.
    expect(adoptedRunAlive({ pid: 2856 } as { pid: number; started: number }, answers, new Map([[2856, 5_000_000]]))).toBe(true);
});
