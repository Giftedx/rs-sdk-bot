import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {age,isPortUnbound,nowLines,procRows,readSwarmStops,resolveSyncedLeasesDir,scriptsOf,type Checkout,type DashState,type Local} from './now';
import type {ProgressReport} from './progress';
import {coordinationView} from '../packages/dashboard/coordination';
import {scoreboardView} from '../packages/dashboard/fleet-view';

const NOW=1_000_000_000_000,MIN=60_000;
const checkout=(over:Partial<Checkout>={}):Checkout=>({path:'x',branch:'master',head:'abc1234',dirty:0,behind:0,ahead:0,fetchedAt:NOW-2*MIN,patch:'applied',...over});
const procs=()=>[{scripts:['swarm.ts'],up:72*MIN},{scripts:['fleet-agent.ts'],up:73*MIN},
    {scripts:['aio-practice-bench.ts'],up:MIN},{scripts:['swarm.test.ts','bun test'],up:MIN},{scripts:['bun test'],up:MIN},{scripts:['tsc'],up:MIN},{scripts:[],up:MIN}];
const local=(over:Partial<Local>={}):Local=>({uptimeSec:7200,procs:procs(),stops:[],here:checkout(),main:null,...over});
const state=():DashState=>({now:NOW,
    capacity:{freeGB:6.6,floorGB:4,pendingReserveGB:2,headroomGB:0.6},
    swarm:{at:NOW-2000,running:25,maxBots:25,pendingStartup:2,jobs:33},
    sys:{cpu:58.4},
    brain:{available:true,at:NOW-10*MIN,fresh:false,paused:true,activeChains:2,goals:5,defects:1,infraOpen:false,chains:[
        {account:'Balls',goal:'quest_board',step:'quest_cooks_assistant'}]},
    bots:[{name:'A',job:{enabled:true,state:'running'}},{name:'B',job:{enabled:true,state:'exit orphaned'}},{name:'C',job:{enabled:false,state:'exit orphaned'}},{name:'D',job:null}],
    alerts:[{name:'A',kind:'stuck',practice:false},{name:'P',kind:'idle',practice:true}],
    scoreboard:{available:true,at:NOW-13*MIN,skills99:19,remaining:['quests 44/68 live']},
    fleetSides:{sides:[{side:'local',at:NOW-5*MIN,late:false},{side:'cloud',at:NOW-5*86_400_000,late:true}]},
    prs:[{number:7,branch:'claude/x',draft:true,state:'OPEN'},{number:6,branch:'claude/y',draft:false,state:'MERGED'}]});

test('age picks the unit by size',()=>{
    expect([age(42_000),age(7*MIN),age(3.2*3_600_000),age(3.6*86_400_000),age(-5)]).toEqual(['42 s','7 min','3.2 h','3.6 d','0 s']);
});

test('scriptsOf names the script files of a command line, and the compiler in both of its forms',()=>{
    expect(scriptsOf('C:\\Users\\x\\.bun\\bin\\bun.exe scripts/measure/aio-practice-bench.ts ^quester --seed 1')).toEqual(['aio-practice-bench.ts']);
    expect(scriptsOf('bun test scripts/swarm.test.ts packages/core/src/a.test.ts')).toEqual(['swarm.test.ts','a.test.ts','bun test']);
    // A test run that names folders, or nothing, is still a test run.
    expect(scriptsOf('C:\\Users\\x\\.bun\\bin\\bun.exe test ./scripts ./packages')).toEqual(['bun test']);
    expect(scriptsOf('"C:\\Users\\x\\.bun\\bin\\bun.exe" test')).toEqual(['bun test']);
    expect(scriptsOf('bun scripts/aio.ts test')).toEqual(['aio.ts']);
    expect(scriptsOf('node --max-old-space-size=2048 F:\\repo\\node_modules\\typescript\\lib\\tsc.js -p x')).toEqual(['tsc']);
    expect(scriptsOf('"C:\\Program Files\\nodejs\\node.exe" F:\\repo\\node_modules\\typescript\\bin\\tsc --noEmit')).toEqual(['tsc']);
    expect(scriptsOf('bun.exe')).toEqual([]);
});

test('procRows reads the scan output of Windows and of ps',()=>{
    const win=procRows('101|2001-09-09T01:45:40.0000000+00:00|C:\\b\\bun.exe scripts/swarm.ts\r\n102|2001-09-09T01:46:10.0000000+00:00|"C:\\b\\bun.exe" test ./scripts\r\n\r\n',true,NOW);
    expect(win).toEqual([{pid:101,scripts:['swarm.ts'],up:60_000},{pid:102,scripts:['bun test'],up:30_000}]);
    const ps=procRows('    7    90 /usr/local/bin/bun scripts/ci-gate.ts --post\n    8    12 node /repo/node_modules/typescript/bin/tsc --noEmit\n    9  5000 /usr/bin/bash -c bun test\n',false,NOW);
    expect(ps).toEqual([{pid:7,scripts:['ci-gate.ts'],up:90_000},{pid:8,scripts:['tsc'],up:12_000}]);
});

test('every fact of the state gets a line',()=>{
    const text=nowLines(state(),local({stops:[{file:'stop-swarm',text:'owner pause'}]}),NOW).join('\n');
    expect(text).toContain('free 6.6 GiB = floor 4.0 + pending starts 2.0 + headroom 0.6; cpu 58%; up 2.0 h');
    expect(text).toContain('heavy   ci-gate.ts 0, test-shards.ts 0, aio-practice-bench.ts 1, typecheck-narrow.ts 0, tsc 1, bun test 2');
    expect(text).toContain('stop    stop-swarm: "owner pause"; side paused');
    expect(text).toContain('control swarm.ts up 72 min, fleet-agent.ts up 73 min');
    expect(text).toContain('swarm   25 of 25 bots, 2 pending starts, 33 jobs; state 2 s old');
    // A job that is not enabled and a bot with no job do not count. A state that is not `running` names its accounts.
    expect(text).toContain('jobs    running 1, exit orphaned 1 (B)');
    expect(text).toContain('brain   chains 2, goals 5, defects 1; state 10 min old (not fresh)');
    expect(text).toContain('  chain Balls (quest_board, quest_cooks_assistant)');
    expect(text).toContain('alerts  stuck 1 (A)');
    expect(text).toContain('board   99s 19; quests 44/68 live; 13 min old');
    expect(text).toContain('sides   snapshots: local 5 min, cloud 5.0 d LATE');
    expect(text).toContain('prs     1 open: 7 claude/x (draft)');
    expect(text).toContain('here    master @ abc1234, 0 changed files, 0 behind, 0 ahead of origin/master (fetched 2 min ago), SDK patch applied');
});

test('snapshot age stays separate from synced controller renewals and remote health',()=>{
    const lines=nowLines(state(),local({syncedLeases:[{side:'cloud',pid:33,at:NOW-2*MIN},{side:'local',pid:22,at:NOW-20*MIN}]}),NOW);
    expect(lines).toContain('sides   snapshots: local 5 min, cloud 5.0 d LATE');
    expect(lines).toContain('leases  synced controller records: local pid=22 renewal=20 min STALE, cloud pid=33 renewal=2 min; current remote process identity and health not checked');
    expect(lines.join('\n')).not.toContain('cloud DOWN');
});

test('missing and invalid snapshot or lease dates stay unknown',()=>{
    const s={...state(),fleetSides:{sides:[{side:'cloud',at:null,late:true},{side:'other',at:NOW+1,late:false}]}};
    const lines=nowLines(s,local({syncedLeases:[{side:'cloud',pid:null,at:null},{side:'other',pid:4,at:NOW+1}]}),NOW);
    expect(lines).toContain('sides   snapshots: cloud unknown, other unknown');
    expect(lines).toContain('leases  synced controller records: cloud pid=unknown renewal=unknown, other pid=4 renewal=unknown; current remote process identity and health not checked');
    expect(nowLines(null,local({syncedLeases:null}),NOW)).toContain('leases  not known: synced controller records could not be read');
});

test('the board line reports owner goal gaps instead of a fleet skill maximum',()=>{
 const s={...state(),scoreboard:{available:true,at:NOW,remaining:[],goals:{version:1,main:{rank:null,gapTicks:8492},specialists:{rank1s:[]},quests:{complete:45,total:68},collection:{scopeKnown:false},army:{maxed:2,roster:['A','B','C']}}}} as unknown as DashState;
 const line=nowLines(s,local(),NOW).find(row=>row.startsWith('board'))!;
 expect(line).toContain('Overall rank unknown; launch gap 8492 ticks');
 expect(line).toContain('quests 45/68');
 expect(line).toContain('army 2/3 maxed');
 expect(line).not.toContain('99s');
});

test('a failed process scan is not read as "no heavy job" or as "controller down"',()=>{
    const text=nowLines(state(),local({procs:null}),NOW).join('\n');
    expect(text).toContain('heavy   not known: the process scan failed. Do not start a heavy job on this line.');
    expect(text).toContain('control not known: the process scan failed');
    expect(text).not.toContain('DOWN');
});

test('the projections that the dashboard gives with no source file print "no state"',()=>{
    // The real projections: a missing scoreboard.json and a missing fleet-state.json.
    const s:DashState={...state(),scoreboard:scoreboardView(null) as DashState['scoreboard'],brain:coordinationView(null,NaN,NOW) as DashState['brain'],swarm:null,capacity:null};
    const lines=nowLines(s,local(),NOW);
    expect(lines).toContain('board   no state');
    expect(lines).toContain('brain   no state');
    expect(lines).toContain('swarm   no state');
    expect(lines).toContain('host    up 2.0 h');
    expect(lines.at(-1)).toStartWith('here    master @ abc1234');
});

test('one part with a wrong shape does not hide the other lines',()=>{
    const s={...state(),scoreboard:{available:true,at:NOW,skills99:1,remaining:5},fleetSides:{sides:'x'}} as unknown as DashState;
    const lines=nowLines(s,local(),NOW);
    expect(lines.find(l=>l.startsWith('board'))).toMatch(/^board {3}not readable: /);
    expect(lines.find(l=>l.startsWith('sides'))).toMatch(/^sides {3}not readable: /);
    expect(lines.some(l=>l.startsWith('host    free 6.6 GiB'))).toBe(true);
    expect(lines.some(l=>l.startsWith('prs     1 open'))).toBe(true);
    expect(lines.at(-1)).toStartWith('here    master @ abc1234');
});

test('with no dashboard the local facts still print, and a worktree also shows the main checkout',()=>{
    const lines=nowLines(null,local({here:checkout({branch:'claude/t',behind:null,ahead:null,fetchedAt:null,patch:'no vendor/rs-sdk'}),main:checkout({behind:7,dirty:2})}),NOW);
    expect(lines).toEqual([
        'host    up 2.0 h',
        'heavy   ci-gate.ts 0, test-shards.ts 0, aio-practice-bench.ts 1, typecheck-narrow.ts 0, tsc 1, bun test 2',
        'stop    no stop-swarm',
        'control swarm.ts up 72 min, fleet-agent.ts up 73 min',
        'dashboard: no answer, so the fleet lines are missing. The other lines come from this PC.',
        'here    claude/t @ abc1234, 0 changed files, origin/master not known (never fetched), SDK patch no vendor/rs-sdk',
        'main    master @ abc1234, 2 changed files, 7 behind, 0 ahead of origin/master (fetched 2 min ago), SDK patch applied']);
});

test('the loops line names each fast-fail loop, says none, or is left out when not read', () => {
    const loop = { name: 'Shaftmaker', goal: 'headless arrows', error: 'Error: bank did not open', runs: 6, medianSec: 3, lastAt: NOW };
    const lines = nowLines(state(), local({ loops: [loop] }), NOW);
    expect(lines).toContain('loops   1 fast-fail loops in 2.0 h (bun tools/fail-loops.ts):');
    expect(lines).toContain('  loop  Shaftmaker 6x 3 s: headless arrows | Error: bank did not open');
    expect(nowLines(state(), local({ loops: [] }), NOW)).toContain('loops   none in 2.0 h');
    expect(nowLines(state(), local(), NOW).some(l => l.startsWith('loops'))).toBe(false);
});

test('the repeats line names each error that ended short runs of many accounts, and is left out when none', () => {
    const fault = { error: 'quest-sweep tree missing #:# (unsold; others in shops)', runs: 17, accounts: 10, goals: 1, lostSec: 190, lastAt: NOW };
    const lines = nowLines(state(), local({ repeats: [fault] }), NOW);
    expect(lines).toContain('repeats 1 errors ended short runs of 3 or more accounts in 24 h (bun tools/fail-loops.ts):');
    expect(lines).toContain('  fault 17x on 10 accounts, 1 goals, 190 s in runs: quest-sweep tree missing #:# (unsold; others in shops)');
    expect(nowLines(state(), local({ repeats: [] }), NOW).some(l => l.startsWith('repeats'))).toBe(false);
});

test('the progress line prints the game progress, says when it was not read, and is left out when not asked for', () => {
    const progress: ProgressReport = { hours: 24, since: NOW - 24 * 3_600_000, now: NOW, maxBots: 25,
        sessions: { botMs: 12 * 3_600_000, logins: 40, shortLogins: 30, failedLogins: 0, open: 0, byScript: [] },
        runs: { ok: 5, failed: 2, runMs: 3_600_000, byGoal: [], failClasses: [], topErrors: [] },
        gains: null, work: { at: NOW, withWork: 3, idle: [] }, errors: ['gains: no snapshot'] };
    const lines = nowLines(null, local({ progress }), NOW);
    // It comes from the main checkout's records, so it prints with no dashboard too.
    expect(lines).toContain('progress 24 h: 12.0 bot-hours online (average 0.5 bots, 2% of 25 maxBots), 40 logins (30 under 5 min); runs 5 ok, 2 failed; gains not known; 3 accounts with work (bun tools/progress.ts)');
    expect(nowLines(state(), local({ progress: null }), NOW)).toContain('progress not known: tools/progress.ts did not finish');
    expect(nowLines(state(), local(), NOW).some(l => l.startsWith('progress'))).toBe(false);
});

test('the idle line warns when one blocker idles 10 or more accounts, and is left out for planned idle states', () => {
    const progress = (idle: [string, number][]): ProgressReport => ({ hours: 24, since: NOW - 24 * 3_600_000, now: NOW, maxBots: 25,
        sessions: null, runs: null, gains: null, work: { at: NOW, withWork: 0, idle }, errors: [] });
    const lines = nowLines(null, local({ progress: progress([['unresolvable_supply:1289', 32], ['missing_skill_unlock:Hitpoints', 20], ['dead', 13], ['missing_skill_unlock:Magic', 2]]) }), NOW);
    expect(lines).toContain('idle    WARN 32 accounts on unresolvable_supply:1289, 20 accounts on missing_skill_unlock:Hitpoints (one blocker on 10 or more accounts; bun tools/progress.ts)');
    expect(nowLines(null, local({ progress: progress([['max_bots_limit', 40], ['paused_owner', 12], ['campaign_state_staging', 18]]) }), NOW).some(l => l.startsWith('idle'))).toBe(false);
    expect(nowLines(null, local({ progress: null }), NOW).some(l => l.startsWith('idle'))).toBe(false);
});

test('readSwarmStops and resolveSyncedLeasesDir prefer .practice/live/ and fall back to legacy paths', () => {
    const base = mkdtempSync(join(tmpdir(), 'now-live-'));
    try {
        expect(readSwarmStops(base)).toEqual([]);
        expect(resolveSyncedLeasesDir(base)).toBe(join(base, 'fleet', 'leases'));

        mkdirSync(join(base, '.practice', 'fleet-data', 'fleet', 'leases'), { recursive: true });
        writeFileSync(join(base, '.practice', 'stop-swarm'), 'legacy stop\nsecond line');
        expect(readSwarmStops(base)).toEqual([{ file: 'stop-swarm', text: 'legacy stop' }]);
        expect(resolveSyncedLeasesDir(base)).toBe(join(base, '.practice', 'fleet-data', 'fleet', 'leases'));

        mkdirSync(join(base, '.practice', 'live', 'fleet-data', 'fleet', 'leases'), { recursive: true });
        writeFileSync(join(base, '.practice', 'live', 'stop-swarm'), 'live owner pause');
        expect(readSwarmStops(base)).toEqual([{ file: 'stop-swarm', text: 'live owner pause' }]);
        expect(resolveSyncedLeasesDir(base)).toBe(join(base, '.practice', 'live', 'fleet-data', 'fleet', 'leases'));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('procRows ignores malformed Windows WMI lines with invalid PID or creation time', () => {
    const rows = procRows('bad|not-a-date|bun.exe\r\n0|2001-09-09T01:45:40.0000000+00:00|bun.exe\r\n105|2001-09-09T01:45:40.0000000+00:00|bun.exe scripts/swarm.ts\r\n', true, NOW);
    expect(rows).toEqual([{ pid: 105, scripts: ['swarm.ts'], up: 60_000 }]);
});

test('isPortUnbound detects active listeners on 127.0.0.1 and 0.0.0.0 and rejects invalid ports', () => {
    expect(isPortUnbound(0)).toBe(false);
    expect(isPortUnbound(70000)).toBe(false);
    for (const hostname of ['127.0.0.1', '0.0.0.0'] as const) {
        const srv = Bun.listen({ hostname, port: 0, socket: { data() {} } });
        const port = srv.port;
        try {
            expect(isPortUnbound(port)).toBe(false);
        } finally {
            srv.stop(true);
        }
        expect(isPortUnbound(port)).toBe(true);
    }
});
