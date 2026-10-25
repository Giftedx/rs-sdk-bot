import { test, expect } from 'bun:test';
import { supervise, isPrerequisiteFailure } from '../src/supervise';

const out = (lines: string[], code: number) => async () => ({ stdout: lines.join('\n'), exitCode: code });

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


for (const detail of ['no ore progress for 220 ticks', 'no wood progress for 220 ticks', 'shearing made no progress',
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
