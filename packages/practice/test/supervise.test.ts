import { test, expect } from 'bun:test';
import {supervisorParticipants,workerCommand,participantsStopped} from '../src/supervise';

test('supervisor forwards remaining CLI arguments and validates all orchestrator participants',async()=>{
 expect(workerCommand('Donor','scripts/handoff-inputs.ts',['Receiver','batch'])).toEqual(['bun','scripts/handoff-inputs.ts','Donor','Receiver','batch']);
 expect(supervisorParticipants('Donor','["Donor","Receiver"]')).toEqual(['Donor','Receiver']);
 expect(supervisorParticipants('Donor',undefined)).toEqual(['Donor']);
 for(const raw of ['no json','[]','["Receiver"]','["Donor","donor"]','["Donor","bad/name"]'])expect(()=>supervisorParticipants('Donor',raw)).toThrow();
 let runs=0;
 const stopped=()=>participantsStopped(['Donor','Receiver'],name=>name==='Receiver');
 const result=await supervise({run:async()=>{runs++;return{stdout:'RESULT ok',exitCode:0};},stopped,pause:async()=>{},maxRestarts:0});
 expect(result).toEqual({reason:'stopped',runs:0});expect(runs).toBe(0);
});

test('release holds pause without retries or a gameplay failure classification',async()=>{
 let calls=0;
 const r=await supervise({run:async()=>{calls++;return {stdout:'RESULT fail Error: no worker progress: release pin missing; live starts paused',exitCode:1};},
 stopped:()=>false,pause:async()=>{throw Error('must not retry');},maxRestarts:20});
 expect(r).toEqual({reason:'release-paused',runs:1});expect(calls).toBe(1);
});

test('Rune Mysteries qualification failures block instead of relogging an untrained starter',()=>{
 expect(isPrerequisiteFailure('RESULT fail Error: Rune Mysteries prerequisite: combat13 required for guarded route')).toBe(true);
 expect(isPrerequisiteFailure('RESULT ok Rune Mysteries prerequisite: qualified')).toBe(false);
});
import { supervise, isPrerequisiteFailure, isTransportStall, isHeldClaimRefusal, HELD_CLAIM_TRIES, failureShape, repeatableFailure } from '../src/supervise';

const out = (lines: string[], code: number) => async () => ({ stdout: lines.join('\n'), exitCode: code });

test('an ended game session retries after backoff while a real task prerequisite still blocks',async()=>{
    let calls=0,pauses=0;
    const r=await supervise({run:async()=>++calls===1?{stdout:'RESULT fail session ended: logged-out',exitCode:1}:{stdout:'RESULT ok recovered',exitCode:0},
        stopped:()=>false,pause:async()=>{pauses++;},maxRestarts:2});
    expect(r).toEqual({reason:'done',runs:2});expect(pauses).toBe(1);
});

test('a failed finite Fire pilot stops after one run even when a public player caused the refusal',async()=>{
    let calls=0;
    const result=await supervise({run:async()=>{calls++;return{stdout:'RESULT fail Fire-pilot {"ok":false,"creditedKills":0,"failure":"another player near target"}',exitCode:1};},
        stopped:()=>false,pause:async()=>{},maxRestarts:20});
    expect(calls).toBe(1);expect(result).toEqual({reason:'blocked',runs:1});
    expect(isPrerequisiteFailure('RESULT ok Fire-pilot {"ok":true}')).toBe(false);
});

test('a success line followed by a failed exit is not done', async () => {
    const r = await supervise({ run: out(['RESULT ok goal met', 'LOGOUT timeout'], 1), stopped: () => false, pause: async () => {}, maxRestarts: 0 });
    expect(r.reason).toBe('gave-up');
});

test('supervise restarts a run that ends without RESULT ok, and stops on RESULT ok', async () => {
    const runs = [out(['START 1 1 0', 'RESULT fail thieving 70 < 99'], 1), out(['START 1 1 0', 'RESULT ok thieving=99'], 0)];
    let n = 0;
    const r = await supervise({ run: () => runs[n++]!(), stopped: () => false, pause: async () => {}, maxRestarts: 5 });
    expect(n).toBe(2);
    expect(r.reason).toBe('done');
});

test('supervise does not restart after a stop file', async () => {
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: 'RESULT fail stop file', exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 5 });
    expect(n).toBe(1);
    expect(r.reason).toBe('stopped');
});

test('supervise gives up after maxRestarts failures in a row', async () => {
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: 'login: Error: Unable to connect', exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 3 });
    expect(n).toBe(4);
    expect(r.reason).toBe('gave-up');
});

test('a death ends supervision: restarting would walk the account into the same danger', async () => {
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: 'RESULT fail died thieving=40 died=true', exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 5 });
    expect(n).toBe(1);
    expect(r.reason).toBe('died');
});


test('a tick-stream stall retries like a disconnect, even inside a no-progress result, then gives up',async()=>{
    const stall='RESULT fail no Ranged progress: {"failure":"Error: ranged-train route failed tick stream stalled: no new game tick for 15000ms"}';
    expect(isTransportStall(stall)).toBe(true);
    expect(isTransportStall('RESULT fail Error: stalled at bank ticks=999')).toBe(false);
    expect(isTransportStall('RESULT ok mode=x tick stream stalled: no new game tick for 15000ms')).toBe(false);
    let calls=0;const result=await supervise({run:async()=>{calls++;return{stdout:stall,exitCode:1};},stopped:()=>false,pause:async()=>{},maxRestarts:2});
    expect(result).toEqual({reason:'gave-up',runs:3});expect(calls).toBe(3);
});

for (const detail of ['no ore progress for 220 ticks', 'no wood progress for 220 ticks', 'no training progress: training requires full HP', 'shearing made no progress',
    'spinning made no progress', 'flax spinning made no progress', 'withdraw made no progress', 'cooking made no progress for12 ticks', 'stalled at bank', 'no-progress guard']) {
    test(`first failure blocks without another login: ${detail}`, async () => {
        let calls = 0;
        const result = await supervise({
            run: async () => { calls++; return { stdout: `RESULT fail Error: ${detail} ticks=999 stallTicks=0`, exitCode: 1 }; },
            stopped: () => false, pause: async () => { throw new Error('unexpected retry'); }, maxRestarts: 20,
        });
        expect(result).toEqual({ reason: 'blocked', runs: 1 });
        expect(calls).toBe(1);
    });
}

test('progress metrics do not block success or transient login retries', async () => {
    let calls = 0, pauses = 0;
    const result = await supervise({
        run: async () => ++calls === 1 ? { stdout: 'RESULT fail login: connection timeout stallTicks=0', exitCode: 1 }
            : { stdout: 'RESULT ok ticks=100 stallTicks=20 no progress warnings=0', exitCode: 0 },
        stopped: () => false, pause: async () => { pauses++; }, maxRestarts: 2,
    });
    expect(result).toEqual({ reason: 'done', runs: 2 });
    expect(pauses).toBe(1);
});


test('a stop during retry delay prevents the next login', async () => {
    let calls = 0, stopped = false;
    const result = await supervise({
        run: async () => { calls++; return { stdout: 'RESULT fail login timeout', exitCode: 1 }; },
        stopped: () => stopped, pause: async () => { stopped = true; }, maxRestarts: 20,
    });
    expect(result).toEqual({ reason: 'stopped', runs: 1 });
    expect(calls).toBe(1);
});

for(const detail of [
    'essence {"failure":"Error: Rune Mysteries quest required: Aubury refused teleport"}',
    'Error: cow prerequisite: stage2unnoted Trout and syncedHP/skill',
    'Error: cow prerequisite: stage at Ardougne south bank',
    'Error: cow prerequisite: empty carried cow outputs',
    'Error: cow prerequisite: missing kit1277',
    'mode=cow ok=false failure=Error: cow kit equip failed 1171: no held item and not equipped',
    'Error: oak PREPARE requires known Draynor bank start',
    'Error: cow needs positive CAP and MAX_KILLS1..5',
    'Error: oak needs CAP>0 and MAX_MAKE1..25',
    'Error: TRAIN_SKILL must be Attack, Strength or Defence',
    'Error: TARGET_LEVEL must be1..99',
    'Error: missing shears',
    'Error: low HP during tool bootstrap',
    'Error: worker ended or cap',
])test(`deterministic prerequisite blocks after one login: ${detail}`,async()=>{
    let calls=0;
    const result=await supervise({run:async()=>{calls++;return {stdout:`RESULT fail ${detail}`,exitCode:1};},
        stopped:()=>false,pause:async()=>{throw new Error('must not retry an unchanged prerequisite');},maxRestarts:20});
    expect(result).toEqual({reason:'blocked',runs:1});expect(calls).toBe(1);
});

test('verified wool availability timeout blocks after one run without a second walk/login',async()=>{
    let calls=0;
    const result=await supervise({run:async()=>{calls++;return {stdout:'RESULT fail Error: no woolly sheep within 120 ticks',exitCode:1};},
        stopped:()=>false,pause:async()=>{throw new Error('must not retry failed sheep availability');},maxRestarts:20});
    expect(result).toEqual({reason:'blocked',runs:1});expect(calls).toBe(1);
});

test('prerequisite matching does not swallow success or generic transient errors',()=>{
    expect(isPrerequisiteFailure('RESULT ok cow prerequisite: missing kit1277')).toBe(false);
    expect(isPrerequisiteFailure('RESULT fail login: connection timeout')).toBe(false);
    expect(isPrerequisiteFailure('RESULT fail SDK temporarily unavailable')).toBe(false);
    expect(isPrerequisiteFailure('RESULT fail requires another state update')).toBe(false);
    expect(isPrerequisiteFailure('RESULT fail walk: temporary route unavailable')).toBe(false);
    expect(isPrerequisiteFailure('RESULT fail worker temporarily unavailable')).toBe(false);
});

test('death and deliberate stop retain priority over prerequisite blocking',async()=>{
    for(const [suffix,reason] of [[' died=true','died'],[' stop file','stopped']] as const){
        const result=await supervise({run:out([`RESULT fail cow prerequisite: missing kit1277${suffix}`],1),stopped:()=>false,
            pause:async()=>{throw new Error('unexpected retry');},maxRestarts:20});
        expect(result).toEqual({reason,runs:1});
    }
});

test('a refusal before any game tick frees the account instead of holding it', async () => {
    const { supervise, isEntryRefusal } = await import('../src/supervise');
    const shark = 'RESULT fail newBankedSharks=0 caught=0 ticks=0 detail={"ticks":0,"failure":"Error: shark entry requires west bank"}';
    expect(isEntryRefusal(shark)).toBe(true);
    expect(isEntryRefusal('RESULT fail no wood progress ticks=407')).toBe(false);
    expect(isEntryRefusal('RESULT fail ticks=0 died=true')).toBe(false);
    const r = await supervise({ run: async () => ({ exitCode: 1, stdout: shark }), stopped: () => false, maxRestarts: 20, pause: async () => {} } as any);
    expect(r).toEqual({ reason: 'refused', runs: 1 });
});

test('three logins in a row refused on a held fleet claim end the job at once, so its recovery can start; a release still being written does not', async () => {
    const cut = out(['LEDGER ticks=900 xp=9000 inventory=0 move=100 anim=600 dialog=0 stun=0 idle=200 idlePct=22.0 ', 'RESULT fail session ended: disconnected'], 1);
    const refused = out(['RESULT fail login: Error: fleet account claim held by swarm'], 1), ok = out(['RESULT ok ticks=1500'], 0);
    expect(isHeldClaimRefusal('RESULT fail login: Error: fleet account claim held by swarm')).toBe(true);
    expect(isHeldClaimRefusal('RESULT fail fleet account claim held by swarm')).toBe(true);
    expect(isHeldClaimRefusal('RESULT fail login: Error: Unable to connect')).toBe(false);
    let n = 0;
    const dropped = [cut, refused, refused, refused, refused];
    expect(await supervise({ run: () => dropped[n++]!(), stopped: () => false, pause: async () => {}, maxRestarts: 20 })).toEqual({ reason: 'gave-up', runs: 1 + HELD_CLAIM_TRIES });
    // Two refusals, then the release lands and the login works.
    n = 0;
    const late = [refused, refused, ok];
    expect(await supervise({ run: () => late[n++]!(), stopped: () => false, pause: async () => {}, maxRestarts: 20 })).toEqual({ reason: 'done', runs: 3 });
    // The count is of refusals in a row: another failure between them starts it again.
    n = 0;
    const dead = out(['login: Error: Unable to connect'], 1), mixed = [refused, refused, dead, refused, refused, ok];
    expect(await supervise({ run: () => mixed[n++]!(), stopped: () => false, pause: async () => {}, maxRestarts: 20 })).toEqual({ reason: 'done', runs: 6 });
});

test('a run the connection ended after real work restarts the streak toward gave-up; failures without work still add up', async () => {
    const drained = out(['START 1 1 0', 'LEDGER ticks=1200 xp=9000 inventory=0 move=100 anim=800 dialog=0 stun=0 idle=300 idlePct=25.0 ', 'RESULT fail session ended: disconnected'], 1);
    const dead = out(['login: Error: Unable to connect'], 1);
    const brief = out(['LEDGER ticks=40 xp=0 inventory=0 move=10 anim=0 dialog=0 stun=0 idle=30 idlePct=75.0 ', 'RESULT fail session ended: disconnected'], 1);
    let n = 0;
    const runs = [dead, dead, drained, dead, dead, drained, dead, brief, dead];
    const r = await supervise({ run: () => runs[n++]!(), stopped: () => false, pause: async () => {}, maxRestarts: 3 });
    expect(r.reason).toBe('gave-up');
    expect(n).toBe(9);
    // Productive runs alone never give up: a stop file ends them.
    let m = 0;
    const s = await supervise({ run: () => { m++; return drained(); }, stopped: () => m >= 6, pause: async () => {}, maxRestarts: 1 });
    expect(s).toEqual({ reason: 'stopped', runs: 6 });
});

test('a walker result with no route ends the session as blocked at the first run', async () => {
    const noRoute = 'RESULT fail travel to chickens 3017,3288 failed: precondition no route to 3018,3289,0';
    expect(isPrerequisiteFailure(noRoute)).toBe(true);
    expect(isPrerequisiteFailure('RESULT ok travel to chickens 3017,3288')).toBe(false);
    // A missing fare is the same kind of result: the coins do not come between two logins.
    expect(isPrerequisiteFailure('RESULT fail travel to Ardougne from 2877,3501 failed: precondition westbound ferry needs 60 coins in the pack')).toBe(true);
    expect(isPrerequisiteFailure('RESULT fail travel to Ardougne from 3092,3242 failed: precondition ferry needs 60 coins and the bank holds 0')).toBe(true);
    expect(isPrerequisiteFailure('RESULT fail travel to Ardougne from 3092,3242 failed: precondition ferry needs 60 coins in the pack')).toBe(true);
    expect(isPrerequisiteFailure('RESULT fail travel to chickens 3017,3288 failed: precondition ferry departure state unavailable')).toBe(false);
    expect(isPrerequisiteFailure('RESULT fail travel to Ardougne failed: precondition ferry fare: the bank at 3092,3243 did not open')).toBe(false);
    // A bank that holds the fare had a failed withdrawal: a restart can repair that.
    expect(isPrerequisiteFailure('RESULT fail travel to Ardougne failed: precondition ferry fare: the withdrawal of 60 coins failed, the bank holds 11000')).toBe(false);
    let runs = 0;
    const end = await supervise({ run: async () => { runs++; return { exitCode: 1, stdout: ['LEDGER ticks=4', noRoute].join(String.fromCharCode(10)) }; }, stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(end).toEqual({ reason: 'blocked', runs: 1 });
    expect(runs).toBe(1);
});

test('two runs in a row with the same failure and no work end as blocked; work, logins and stalls keep retrying', async () => {
    expect(failureShape('RESULT fail feathers=2000 gained=0 kills=0 idle=0 ticks=2')).toBe(failureShape('RESULT fail feathers=2000 gained=0 kills=0 idle=0 ticks=3'));
    const brief = (result: string) => out(['LEDGER ticks=3 xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=3 idlePct=100.0 ', result], 1);
    let n = 0;
    const same = await supervise({ run: () => { n++; return brief(`RESULT fail feathers=2000 gained=0 kills=0 idle=0 ticks=${n}`)(); }, stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(same).toEqual({ reason: 'blocked', runs: 2 });
    // Different failures in a row do not count as a repeat.
    let m = 0;
    const varied = ['RESULT fail bank did not open', 'RESULT fail shop closed', 'RESULT fail bank did not open', 'RESULT fail shop closed'];
    const mixed = await supervise({ run: () => brief(varied[m++ % 4]!)(), stopped: () => false, pause: async () => {}, maxRestarts: 3 });
    expect(mixed).toEqual({ reason: 'gave-up', runs: 4 });
    // A run with real work between two equal failures resets the repeat.
    const worked = out(['LEDGER ticks=900 xp=10 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=0 idlePct=0.0 ', 'RESULT fail bank did not open'], 1);
    let w = 0;
    const seq = [worked, brief('RESULT fail bank did not open'), worked, brief('RESULT fail bank did not open')];
    const productive = await supervise({ run: () => seq[w++]!(), stopped: () => w >= 4, pause: async () => {}, maxRestarts: 20 });
    expect(productive.reason).toBe('stopped');
    // Login errors, dropped sessions and transport stalls still retry to the restart limit.
    for (const result of ['RESULT fail login: Error: fleet swarm claim authority unavailable or changed', 'RESULT fail session ended: disconnected',
        'RESULT fail tick stream stalled: no new game tick for 15000ms']) {
        expect(repeatableFailure(result)).toBe(false);
        let k = 0;
        const r = await supervise({ run: () => { k++; return brief(result)(); }, stopped: () => false, pause: async () => {}, maxRestarts: 3 });
        expect(r.reason).toBe('gave-up');
        expect(k).toBe(4);
    }
});
