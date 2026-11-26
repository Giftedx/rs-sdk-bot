import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {supervisorParticipants,workerCommand,participantsStopped,participantsHaveStopFile,lineKeeper,keepOutput,madeProgress,MAX_KEPT_LINE} from '../src/supervise';

test('lineKeeper keeps the last line of each key across chunk splits, CRLF and an unended last line', () => {
    const keep = lineKeeper(l => l.startsWith('RESULT') ? 'RESULT' : /^LEDGER ticks=\d+/.test(l) ? 'LEDGER' : null);
    for (const chunk of ['noise\nRESULT fail a\r\nLEDGER tic', 'ks=5 idle=1\nmore noise\nRES', 'ULT ok final']) keep.push(chunk);
    const text = keep.text();
    expect(text.split('\n').sort()).toEqual(['LEDGER ticks=5 idle=1', 'RESULT ok final']);
    expect(madeProgress(text)).toBe(false);
    expect(lineKeeper(() => null).text()).toBe('');
});

test('keepOutput holds a bounded amount of a long child output and a line over the cap keeps its head', async () => {
    const script = `const f='x'.repeat(200);for(let i=0;i<200000;i++){console.log(f+i);if(i%50000===0)console.log('LEDGER ticks='+i)}console.log('y'.repeat(${MAX_KEPT_LINE * 2}));console.log('RESULT ok '+'z'.repeat(${MAX_KEPT_LINE * 2}))`;
    const p = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'inherit' });
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let text: string;
    try { text = await keepOutput(p.stdout, l => l.startsWith('RESULT') ? 'RESULT' : /^LEDGER ticks=\d+/.test(l) ? 'LEDGER' : null); }
    finally { process.stdout.write = realWrite; }
    await p.exited;
    const kept = text.split('\n');
    expect(kept.length).toBe(2);
    expect(kept.find(l => l.startsWith('LEDGER'))).toBe('LEDGER ticks=150000');
    expect(kept.find(l => l.startsWith('RESULT'))!.length).toBe(MAX_KEPT_LINE);
}, 60_000);

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
import { drainPause, gainedInRun, supervise, isPrerequisiteFailure, isTransportStall, isHeldClaimRefusal, isClaimAuthorityFault, isNoProgressFailure, isEntryRefusal, CLAIM_AUTHORITY_PAUSE_MS, HELD_CLAIM_TRIES, failureShape, repeatableFailure } from '../src/supervise';

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

// The generic combat worker names the openBot stall stop (packages/workers/src/combat/melee-gather.ts combatStallWords).
// A stalled finite combat job ends in one of two shapes: the counted end or a cleanup throw. Without the stall words
// neither shape blocks, and the supervisor logs the job in again.
const combatStall = ' stalled=true no progress: 900 ticks without xp, items, dialog or a journey endTicks=0 endUnderAttack=false endLeft=false endQuiet=true endTiles=0 endEats=0 logout=confirmed logoutTries=1';
for (const detail of ['ticks=903 kills=0 looted=0 bankTrips=300 walkTicks=0 hp=60 actionsPer1kTicks=0.00 targetMet=false maximum=40',
    'Error: combat potion consumer original owner/life/stop; cleanup Error: combat fresh bank unavailable']) {
    test(`a combat stall stop blocks without another login: ${detail.slice(0, 40)}`, async () => {
        const result = `RESULT fail ${detail}${combatStall}`;
        expect([isNoProgressFailure(result), isTransportStall(result)]).toEqual([true, false]);
        let calls = 0;
        const r = await supervise({
            run: async () => { calls++; return { stdout: result, exitCode: 1 }; },
            stopped: () => false, pause: async () => { throw new Error('unexpected retry'); }, maxRestarts: 20,
        });
        expect(r).toEqual({ reason: 'blocked', runs: 1 });
        expect(calls).toBe(1);
        expect(isNoProgressFailure(`RESULT fail ${detail}`)).toBe(false);
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
    // Any kit item, not only the bronze starter kit: a better weapon that will not equip or bank is no fresh-login fix.
    'mode=cow ok=false failure=Error: cow kit equip failed 1333: Failed to equip Rune scimitar; equipped item not observed',
    'mode=cow ok=false failure=Error: cow kit: replaced gear deposit failed (1329)',
    'mode=cow ok=false failure=Error: cow kit withdraw failed 1333',
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

test('a quest sweep refusal at entry ends the job without a second login', async () => {
    const { supervise, isNamedRefusal } = await import('../src/supervise');
    const started = 'RESULT fail quest-sweep imp refused: Imp Catcher journal is started and quest-imp.ts has no resume stage';
    expect(isNamedRefusal(started)).toBe(true);
    expect(isNamedRefusal('RESULT fail quest-sweep dragon refused: Dragon Slayer needs 32 quest points, the account has 12')).toBe(true);
    // A script failure after the handover is no refusal: it keeps the retry rules.
    expect(isNamedRefusal('RESULT fail talk squire 1  xp= at=2976,3343,0 ticks=27')).toBe(false);
    expect(isNamedRefusal('RESULT fail quest-sweep squire missing 2325:1')).toBe(false);
    const r = await supervise({ run: async () => ({ exitCode: 1, stdout: started }), stopped: () => false, maxRestarts: 20, pause: async () => { throw new Error('unexpected retry'); } });
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

test('a failure that ended on another tile is not the same failure', async () => {
    const at = (position: string) => `RESULT fail Error: market bank travel failed: position=${position} currentHP=9 ticks=101; Error: far walk to 3185,3436,0: stopped`;
    expect(failureShape(at('3035,3247,0'))).not.toBe(failureShape(at('3096,3414,0')));
    expect(failureShape(at('3096,3414,0'))).toBe(failureShape(at('3096,3414,0').replace('currentHP=9', 'currentHP=8').replace('ticks=101', 'ticks=55')));
    const brief = (result: string) => out(['LEDGER ticks=3 xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=3 idlePct=100.0 ', result], 1);
    const moved = ['3035,3247,0', '3096,3414,0', '3184,3436,0'];
    let n = 0;
    const end = await supervise({ run: () => brief(at(moved[Math.min(n++, 2)]!))(), stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(end).toEqual({ reason: 'blocked', runs: 4 });
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

test('a login claim authority that did not answer never ends a job as blocked, and the next run waits longer', async () => {
    const brief = (result: string) => out(['LEDGER ticks=3 xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=3 idlePct=100.0 ', result], 1);
    // The text of a worker that caught the error, of a chain whose step ended on it, and of an ended time budget.
    for (const result of ['RESULT fail login: Error: fleet swarm claim authority unavailable or changed: spawnSync git ETIMEDOUT',
        'RESULT fail fleet swarm claim authority unavailable or changed: spawnSync git ETIMEDOUT chain rounds=1 ok=0 failed=1',
        'RESULT fail fleet swarm claim authority timed out chain rounds=1 ok=0 failed=1']) {
        expect(isClaimAuthorityFault(result), result).toBe(true);
        expect(repeatableFailure(result), result).toBe(false);
        // The crash text of this fault is no other rule's text.
        expect([isNoProgressFailure(result), isPrerequisiteFailure(result), isEntryRefusal(result), isHeldClaimRefusal(result)], result).toEqual([false, false, false, false]);
        let runs = 0; const pauses: number[] = [];
        const end = await supervise({ run: () => { runs++; return brief(result)(); }, stopped: () => false, pause: async ms => { pauses.push(ms); }, maxRestarts: 3 });
        expect(end, result).toEqual({ reason: 'gave-up', runs: 4 });
        expect(pauses, result).toEqual([CLAIM_AUTHORITY_PAUSE_MS, CLAIM_AUTHORITY_PAUSE_MS, CLAIM_AUTHORITY_PAUSE_MS]);
    }
    // A held claim and an other failure are not this fault and keep the 10 s pause.
    for (const result of ['RESULT fail fleet account claim held by swarm', 'RESULT fail bank did not open', 'RESULT fail no result chain rounds=1 ok=0 failed=1'])
        expect(isClaimAuthorityFault(result), result).toBe(false);
    const pauses: number[] = [];
    await supervise({ run: () => brief('RESULT fail bank did not open')(), stopped: () => false, pause: async ms => { pauses.push(ms); }, maxRestarts: 3 });
    expect(pauses).toEqual([10_000]);
});

test('a Grand Exchange buy that ended before it placed an offer is a blocked prerequisite, not a retry', () => {
 const unplaced = (failure: string) => `RESULT fail {"ok":false,"foodUsed":[],"phase":"unplaced","pending":false,"quantity":16,"acquired":0,"escrow":0,"refund":0,"spent":0,"ticks":3,"failure":"Error: ${failure}"}`;
 for (const failure of ['coins 160940 are under the escrow 160000 (16 x 10000) plus the reserve 1000: 60 short', 'pack holds 27 items, over 26: two collection slots unavailable',
  'order deadline passed 3 s ago (deadline 2000-01-01T00:00:00.000Z)', 'owned item baseline 68 differs from EXPECTED_OWNED 10']) expect([failure, isPrerequisiteFailure(unplaced(failure))]).toEqual([failure, true]);
 // An offer that was placed (escrow held) or an unknown failure is not.
 expect(isPrerequisiteFailure(unplaced('GE interface unavailable'))).toBe(false);
 // A stop can differ at the next login.
 expect(isPrerequisiteFailure(unplaced('order stopped: the session ended, died, was damaged, was told to stop or used its 500-tick budget'))).toBe(false);
 expect(isPrerequisiteFailure(unplaced('coins 1 are under the escrow 2 (1 x 2) plus the reserve 0: 1 short').replace('"escrow":0', '"escrow":2000'))).toBe(false);
});

test('participantsHaveStopFile honors stop files in both .practice/live/ and legacy .practice/', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'supervise-stop-'));
 try {
  expect(participantsHaveStopFile(['WorkerA', 'WorkerB'], dir)).toBe(false);
  mkdirSync(join(dir, '.practice', 'live'), { recursive: true });
  writeFileSync(join(dir, '.practice', 'live', 'stop-WorkerB'), 'owner live stop');
  expect(participantsHaveStopFile(['WorkerA', 'WorkerB'], dir)).toBe(true);
  let runs = 0;
  const res = await supervise({
   run: async () => { runs++; return { stdout: 'RESULT ok', exitCode: 0 }; },
   stopped: () => participantsHaveStopFile(['WorkerA', 'WorkerB'], dir),
   pause: async () => {},
   maxRestarts: 2,
  });
  expect(res).toEqual({ reason: 'stopped', runs: 0 });
  expect(runs).toBe(0);
  rmSync(join(dir, '.practice', 'live', 'stop-WorkerB'));
  writeFileSync(join(dir, '.practice', 'stop-workera'), 'legacy stop');
  expect(participantsHaveStopFile(['WorkerA', 'WorkerB'], dir)).toBe(true);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test('madeProgress and supervise backward line scanners inspect only the final matching LEDGER and RESULT lines', async () => {
 expect(madeProgress([
  'LEDGER ticks=900 xp=50 inventory=1 move=2 anim=0 dialog=0 stun=0 idle=0 idlePct=0.0',
  'noise line',
  'LEDGER ticks=50 xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=50 idlePct=100.0',
 ].join('\r\n'))).toBe(false);
 expect(madeProgress([
  'LEDGER ticks=50 xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=50 idlePct=100.0',
  'LEDGER ticks=900 xp=0 inventory=3 move=1 anim=0 dialog=0 stun=0 idle=0 idlePct=0.0',
 ].join('\n'))).toBe(true);

 const logs: string[] = [];
 const r = await supervise({
  run: out(['RESULT ok intermediate', 'RESULT fail final failure'], 1),
  stopped: () => false,
  pause: async () => {},
  maxRestarts: 0,
  log: line => logs.push(line),
 });
 expect(r.reason).toBe('gave-up');
 expect(logs[0]).toContain('RESULT fail final failure');

 const rOk = await supervise({
  run: out(['RESULT fail intermediate', 'RESULT ok final success'], 0),
  stopped: () => false,
  pause: async () => {},
  maxRestarts: 0,
 });
 expect(rOk.reason).toBe('done');
});

test('shop-buy zero-purchase stock-wait and coin-reserve failures block immediately as prerequisites', () => {
 expect(isPrerequisiteFailure('RESULT fail ticks=35 boughtTotal=0 stop=stock-wait targetMet=0')).toBe(true);
 expect(isPrerequisiteFailure('RESULT fail ticks=15 boughtTotal=0 stop=coin-reserve targetMet=0')).toBe(true);
 expect(isPrerequisiteFailure('RESULT fail ticks=45 boughtTotal=5 stop=stock-wait targetMet=0')).toBe(false);
});

test('parseSuperviseArgs validates bot, script, and non-negative integer maxRestarts', async () => {
 const { parseSuperviseArgs } = await import('../src/supervise');
 expect(parseSuperviseArgs(['Bot1', 'scripts/a.ts'])).toEqual({ bot: 'Bot1', script: 'scripts/a.ts', maxRestarts: 20, scriptArgs: [] });
 expect(parseSuperviseArgs(['Bot1', 'scripts/a.ts', '5', '--foo'])).toEqual({ bot: 'Bot1', script: 'scripts/a.ts', maxRestarts: 5, scriptArgs: ['--foo'] });
 expect(() => parseSuperviseArgs(['Bot1'])).toThrow(/usage/);
 expect(() => parseSuperviseArgs(['Bot1', 'scripts/a.ts', '--foo'])).toThrow(/maxRestarts/);
 expect(() => parseSuperviseArgs(['Bot1', 'scripts/a.ts', '-1'])).toThrow(/maxRestarts/);
 expect(() => parseSuperviseArgs(['Bot1', 'scripts/a.ts', '1.5'])).toThrow(/maxRestarts/);
});

test('a failed run with a DEATH line ends as died even when its RESULT does not name the death', async () => {
    const { diedInRun, isDeathLine } = await import('../src/supervise');
    const death = 'DEATH at=2934,9826,0 wild=0 hp=1/84 by=Black_Knight#179 taken=8 hits=5 script=gather-combat.ts bot=Shaftsinker';
    expect(isDeathLine(death)).toBe(true);
    expect(isDeathLine('  | ' + death)).toBe(true);
    expect(isDeathLine('DEATH_RECOVERY skip-too-far at=2934,9826 ticks=6')).toBe(false);
    expect(diedInRun(['LEDGER ticks=900 xp=10 idle=0', death, 'RESULT fail Error: combat bank return unavailable'].join('\n'))).toBe(true);
    let n = 0;
    const r = await supervise({ run: async () => { n++; return { stdout: [death, 'LEDGER ticks=5956 xp=400 inventory=8 move=478 idle=900', 'RESULT fail Error: combat bank return unavailable endTicks=0'].join('\n'), exitCode: 1 }; },
        stopped: () => false, pause: async () => { throw Error('must not log in again after a death'); }, maxRestarts: 20 });
    expect(r).toEqual({ reason: 'died', runs: 1 });
    expect(n).toBe(1);
    // A run that met its goal after a death is still done, and a stop still wins.
    expect(await supervise({ run: async () => ({ stdout: `${death}\nRESULT ok level=99`, exitCode: 0 }), stopped: () => false, pause: async () => {}, maxRestarts: 0 })).toEqual({ reason: 'done', runs: 1 });
    expect(await supervise({ run: async () => ({ stdout: `${death}\nRESULT fail stop file`, exitCode: 1 }), stopped: () => false, pause: async () => {}, maxRestarts: 0 })).toEqual({ reason: 'stopped', runs: 1 });
});

test('a run that was idle for its whole session is not work: the same failure twice ends as blocked', async () => {
    const idleRun = (ticks: number) => out([`LEDGER ticks=${ticks} xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=${ticks} idlePct=100.0 xpGain=0 longestIdle=${ticks}@t10(2945,3368) idleBy=after:closeModal:598,bank:303 bot=Magicwanda`,
        `RESULT fail ticks=${ticks} kills=0 looted=0 bankTrips=299 walkTicks=0 hp=60 actionsPer1kTicks=0.00 targetMet=false maximum=40`], 1);
    expect(madeProgress('LEDGER ticks=904 xp=0 inventory=0 move=0 anim=0 dialog=0 stun=0 idle=904 idlePct=100.0 xpGain=0')).toBe(false);
    expect(madeProgress('LEDGER ticks=904 xp=40 inventory=2 move=300 anim=100 dialog=0 stun=0 idle=462 idlePct=51.1 xpGain=900')).toBe(true);
    expect(madeProgress('LEDGER ticks=904 xp=0 inventory=0 move=1 anim=0 dialog=0 stun=0 idle=903 idlePct=99.9 xpGain=0')).toBe(true);
    let n = 0;
    const r = await supervise({ run: () => { n++; return idleRun(900 + n)(); }, stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(r).toEqual({ reason: 'blocked', runs: 2 });
});

test('crashResult turns the uncaught error Bun prints into the RESULT the worker would have printed', async () => {
    const { crashResult } = await import('../src/supervise');
    const frame = ['1174 |         if (n === undefined) throw Error(`invalid ${k}`);', '                         ^'];
    expect(crashResult([...frame, 'error: invalid tickCap', '      at read (thieving.ts:1174:86)', '', 'Bun v1.3.14 (Windows x64)'].join('\n'))).toBe('RESULT fail Error: invalid tickCap');
    expect(crashResult("TypeError: null is not an object (evaluating 'o.x')\n      at x.ts:1:1")).toBe("RESULT fail TypeError: null is not an object (evaluating 'o.x')");
    expect(crashResult('Pathfinding initialized in 8ms\nwarning: slow\n')).toBeUndefined();
    expect(crashResult(undefined)).toBeUndefined();
});

test('the real Bun stderr of an uncaught throw yields that crash result', async () => {
    const { crashResult, isUncaughtErrorLine } = await import('../src/supervise');
    const p = Bun.spawn(['bun', '-e', "console.log('START 1 1 0'); throw Error('smith refused: integer CAP>=1 required')"], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [stdout, stderr] = await Promise.all([keepOutput(p.stdout, l => l.startsWith('RESULT') ? 'RESULT' : null, () => {}), keepOutput(p.stderr, l => isUncaughtErrorLine(l) ? 'ERROR' : null, () => {})]);
    expect(await p.exited).not.toBe(0);
    expect(stdout).toBe('');
    expect(crashResult(stderr)).toBe('RESULT fail Error: smith refused: integer CAP>=1 required');
}, 30_000);

test('a crash with no RESULT line follows the same rules as a printed failure', async () => {
    const crash = (stderr: string) => async () => ({ stdout: '', stderr, exitCode: 1 });
    // A release hold thrown at login pauses at once, with no second login.
    const hold = await supervise({ run: crash('error: no worker progress: release peer state unknown; verify offline before rollout\n      at assertCompatibleWorkers (peers.ts:30:15)'),
        stopped: () => false, pause: async () => { throw Error('must not retry'); }, maxRestarts: 20 });
    expect(hold).toEqual({ reason: 'release-paused', runs: 1 });
    // The same argument refusal twice with no work between ends as blocked.
    let n = 0;
    const refusal = await supervise({ run: () => { n++; return crash('error: invalid tickCap')(); }, stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(refusal).toEqual({ reason: 'blocked', runs: 2 });
    expect(n).toBe(2);
    // An uncaught tick-stream stall is a transport loss: it keeps retrying to the limit.
    let s = 0;
    const stall = await supervise({ run: () => { s++; return crash('TickStallError: tick stream stalled: no new game tick for 30000ms')(); }, stopped: () => false, pause: async () => {}, maxRestarts: 3 });
    expect(stall).toEqual({ reason: 'gave-up', runs: 4 });
    // A run that ended with no RESULT and no error line (a killed process) still retries to the limit.
    let k = 0;
    const killed = await supervise({ run: () => { k++; return crash('')(); }, stopped: () => false, pause: async () => {}, maxRestarts: 3 });
    expect(killed).toEqual({ reason: 'gave-up', runs: 4 });
    // A printed RESULT wins over a stray error line on stderr.
    const printed = await supervise({ run: async () => ({ stdout: 'RESULT ok done', stderr: 'error: late cleanup', exitCode: 0 }), stopped: () => false, pause: async () => {}, maxRestarts: 0 });
    expect(printed).toEqual({ reason: 'done', runs: 1 });
});

test('a waiting live update that drains the worker ends the job as release-paused instead of a restart', async () => {
    const smithing = 'packages/workers/src/bank-artisan/smithing.ts';
    let calls = 0, drain: string[] = [];
    const lines: string[] = [];
    const r = await supervise({
        run: async () => { calls++; drain = [smithing, 'b.ts', 'c.ts']; return { stdout: 'RESULT fail walk', exitCode: 1 }; },
        stopped: () => false, pause: async () => {}, maxRestarts: 20, log: l => lines.push(l), drained: () => drain,
    });
    expect(r).toEqual({ reason: 'release-paused', runs: 1 });
    expect(calls).toBe(1);
    expect(lines.at(-1)).toBe(`SUPERVISE pause: a waiting live update drains ${smithing}, b.ts and 1 more`);
    // The first run is the swarm's own start, which the swarm already checks: the supervisor does not refuse it.
    let first = 0;
    const started = await supervise({ run: async () => { first++; return { stdout: 'RESULT ok', exitCode: 0 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 0, drained: () => [smithing] });
    expect(started).toEqual({ reason: 'done', runs: 1 });
    expect(first).toBe(1);
    // Nothing to drain: a failure restarts as before.
    let again = 0;
    const restarted = await supervise({ run: async () => (++again === 1 ? { stdout: 'RESULT fail walk', exitCode: 1 } : { stdout: 'RESULT ok', exitCode: 0 }), stopped: () => false, pause: async () => {}, maxRestarts: 5, drained: () => [] });
    expect(restarted).toEqual({ reason: 'done', runs: 2 });
    expect(drainPause(undefined)).toBeNull();
    expect(drainPause([])).toBeNull();
});

test('a run that walks to the same failure twice with no XP or item change ends as blocked', async () => {
    const walked = 'LEDGER ticks=504 xp=0 inventory=0 move=442 anim=2 dialog=3 stun=0 idle=57 idlePct=11.3 xpGain=0';
    const fail = 'RESULT fail dialogue click refused: Failed to click dialog option (continue; options ["No thanks","Ok then"])';
    expect(madeProgress(walked)).toBe(true);
    expect(gainedInRun(walked)).toBe(false);
    let calls = 0;
    const r = await supervise({ run: async () => { calls++; return { stdout: [walked, fail].join('\n'), exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(r).toEqual({ reason: 'blocked', runs: 2 });
    expect(calls).toBe(2);
    // A run that gained XP or changed an item keeps restarting on the same failure, as before.
    for (const gained of ['LEDGER ticks=504 xp=3 inventory=0 move=400 idle=50', 'LEDGER ticks=504 xp=0 inventory=1 move=400 idle=50']) {
        expect(gainedInRun(gained)).toBe(true);
        let n = 0;
        const again = await supervise({ run: async () => (++n < 3 ? { stdout: [gained, fail].join('\n'), exitCode: 1 } : { stdout: 'RESULT ok', exitCode: 0 }), stopped: () => false, pause: async () => {}, maxRestarts: 20 });
        expect(again).toEqual({ reason: 'done', runs: 3 });
    }
    // Two walks that fail in different ways keep restarting.
    let k = 0;
    const texts = [fail, 'RESULT fail talk bartender', 'RESULT ok'];
    const moved = await supervise({ run: async () => ({ stdout: [walked, texts[k++]!].join('\n'), exitCode: k === 3 ? 0 : 1 }), stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(moved).toEqual({ reason: 'done', runs: 3 });
    expect(gainedInRun('RESULT fail no ledger')).toBe(false);
});

test('a run that the swarm drain-stopped ends as release-paused; an owner stop stays a stop', async () => {
    const { DRAIN_STOP_TEXT } = await import('../../core/src/live-update-pending');
    const { participantsDrainStopped } = await import('../src/supervise');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const out = { stdout: 'LEDGER ticks=900 xp=5 inventory=2 move=10 idle=10\nRESULT fail stop file', exitCode: 1 };
    // The run itself ended on the stop file.
    const paused = await supervise({ run: async () => out, stopped: () => false, pause: async () => {}, maxRestarts: 20, drainStopped: () => true });
    expect(paused).toEqual({ reason: 'release-paused', runs: 1 });
    expect(await supervise({ run: async () => out, stopped: () => false, pause: async () => {}, maxRestarts: 20, drainStopped: () => false })).toEqual({ reason: 'stopped', runs: 1 });
    // A stop that stands before the first run ends the job with no run, as before.
    expect(await supervise({ run: async () => out, stopped: () => true, pause: async () => {}, maxRestarts: 20, drainStopped: () => true })).toEqual({ reason: 'release-paused', runs: 0 });
    // A drain stop seen before a restart ends the job without another run.
    let calls = 0, stop = false;
    const before = await supervise({ run: async () => { calls++; stop = true; return { stdout: 'RESULT fail walk', exitCode: 1 }; }, stopped: () => stop, pause: async () => {}, maxRestarts: 20, drainStopped: () => stop });
    expect(before).toEqual({ reason: 'release-paused', runs: 1 });
    expect(calls).toBe(1);
    const root = mkdtempSync(join(tmpdir(), 'drain-stopped-'));
    try {
        mkdirSync(join(root, '.practice'), { recursive: true });
        writeFileSync(join(root, '.practice', 'stop-Fisher'), `${DRAIN_STOP_TEXT}\n`);
        writeFileSync(join(root, '.practice', 'stop-Owned'), 'owner stop');
        expect(participantsDrainStopped(['Fisher'], root)).toBe(true);
        expect(participantsDrainStopped(['Owned'], root)).toBe(false);
        expect(participantsDrainStopped(['Nobody'], root)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a flee stop ends the job: a restart would log in at low hitpoints with no food next to the same monsters', async () => {
    const { isFleeStop } = await import('../src/supervise');
    const staffstiffy = 'RESULT fail ticks=307 kills=1 looted=0 bankTrips=1 walkTicks=245 hp=2 maximum=200 fled=true endTicks=51 endUnderAttack=true endLeft=false endQuiet=true endTiles=0 endEats=0 logout=confirmed logoutTries=1';
    const magicwanda = 'RESULT fail Error: combat potion consumer original owner/life/stop fled=true';
    expect(isFleeStop(staffstiffy)).toBe(true);
    expect(isFleeStop(magicwanda)).toBe(true);
    expect(isFleeStop('RESULT fail fled at low hitpoints: flee_guard id=13 at=3109,3148 ticks=40')).toBe(true);
    expect(isFleeStop('RESULT fail spar-batch fights=4 kills=1 deaths=0 escapes=0 fled=2 draws=1')).toBe(false);
    expect(isFleeStop('RESULT ok kills=5 fled=true')).toBe(false);
    for (const line of [staffstiffy, magicwanda]) {
        let n = 0;
        const r = await supervise({ run: async () => { n++; return { stdout: ['LEDGER ticks=900 xp=40 inventory=2 idle=10', line].join('\n'), exitCode: 1 }; },
            stopped: () => false, pause: async () => { throw Error('must not log in again after a flee stop'); }, maxRestarts: 20 });
        expect(r).toEqual({ reason: 'stopped', runs: 1 });
        expect(n).toBe(1);
    }
});
