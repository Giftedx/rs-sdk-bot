import {expect,test} from 'bun:test';
import {age,nowLines,procRows,scriptsOf,type Checkout,type DashState,type Local} from './now';
import {coordinationView} from '../packages/dashboard/coordination';
import {scoreboardView} from '../packages/dashboard/fleet-view';

const NOW=1_000_000_000_000,MIN=60_000;
const checkout=(over:Partial<Checkout>={}):Checkout=>({path:'x',branch:'master',head:'abc1234',dirty:0,behind:0,ahead:0,fetchedAt:NOW-2*MIN,patch:'applied',...over});
const procs=()=>[{scripts:['swarm.ts'],up:72*MIN},{scripts:['coordinator-cli.ts'],up:83*MIN},{scripts:['fleet-agent.ts'],up:73*MIN},
    {scripts:['aio-practice-bench.ts'],up:MIN},{scripts:['swarm.test.ts','bun test'],up:MIN},{scripts:['bun test'],up:MIN},{scripts:['tsc'],up:MIN},{scripts:[],up:MIN}];
const local=(over:Partial<Local>={}):Local=>({uptimeSec:7200,procs:procs(),stops:[],here:checkout(),main:null,...over});
const state=():DashState=>({now:NOW,
    capacity:{freeGB:6.6,floorGB:4,pendingReserveGB:2,headroomGB:0.6},
    swarm:{at:NOW-2000,running:25,maxBots:25,pendingStartup:2,jobs:33},
    sys:{cpu:58.4},
    coordination:{available:true,at:NOW-10*MIN,fresh:false,paused:true,counts:{running:1,pending:1},tasks:[
        {id:'run-a',kind:'run',status:'running',agent:'codex',account:'Balls',startedAt:NOW-30*MIN,timeoutMs:90*MIN},
        {id:'build-b',kind:'build',status:'pending',agent:null,account:null,startedAt:null},
        {id:'old',kind:'run',status:'failed',agent:null,account:null,startedAt:NOW-999*MIN}]},
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
    const text=nowLines(state(),local({stops:[{file:'stop-coordinator',text:'owner pause'}]}),NOW).join('\n');
    expect(text).toContain('free 6.6 GiB = floor 4.0 + pending starts 2.0 + headroom 0.6; cpu 58%; up 2.0 h');
    expect(text).toContain('heavy   ci-gate.ts 0, test-shards.ts 0, aio-practice-bench.ts 1, typecheck-narrow.ts 0, tsc 1, bun test 2');
    expect(text).toContain('stop    stop-coordinator: "owner pause"; the coordinator is paused');
    expect(text).toContain('control swarm.ts up 72 min, coordinator-cli.ts up 83 min, autopilot.ts DOWN, fleet-agent.ts up 73 min');
    expect(text).toContain('swarm   25 of 25 bots, 2 pending starts, 33 jobs; state 2 s old');
    // A job that is not enabled and a bot with no job do not count. A state that is not `running` names its accounts.
    expect(text).toContain('jobs    running 1, exit orphaned 1 (B)');
    expect(text).toContain('coord   running 1, pending 1; state 10 min old (not fresh)');
    expect(text).toContain('  run   run-a (run, codex, Balls) 30 min of 1.5 h');
    expect(text).toContain('  wait  build-b');
    // A task that ended gets no line.
    expect(text).not.toMatch(/^ {2}(run|wait) +old\b/m);
    expect(text).toContain('alerts  stuck 1 (A)');
    expect(text).toContain('board   99s 19; quests 44/68 live; 13 min old');
    expect(text).toContain('sides   local 5 min, cloud 5.0 d LATE');
    expect(text).toContain('prs     1 open: 7 claude/x (draft)');
    expect(text).toContain('here    master @ abc1234, 0 changed files, 0 behind, 0 ahead of origin/master (fetched 2 min ago), SDK patch applied');
});

test('a failed process scan is not read as "no heavy job" or as "controller down"',()=>{
    const text=nowLines(state(),local({procs:null}),NOW).join('\n');
    expect(text).toContain('heavy   not known: the process scan failed. Do not start a heavy job on this line.');
    expect(text).toContain('control not known: the process scan failed');
    expect(text).not.toContain('DOWN');
});

test('the projections that the dashboard gives with no source file print "no state"',()=>{
    // The real projections: a missing scoreboard.json and a missing coordinator state.json.
    const s:DashState={...state(),scoreboard:scoreboardView(null) as DashState['scoreboard'],coordination:coordinationView(null,NaN,NOW) as DashState['coordination'],swarm:null,capacity:null};
    const lines=nowLines(s,local(),NOW);
    expect(lines).toContain('board   no state');
    expect(lines).toContain('coord   no state');
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
        'stop    no stop-coordinator, no stop-swarm',
        'control swarm.ts up 72 min, coordinator-cli.ts up 83 min, autopilot.ts DOWN, fleet-agent.ts up 73 min',
        'dashboard: no answer, so the fleet lines are missing. The other lines come from this PC.',
        'here    claude/t @ abc1234, 0 changed files, origin/master not known (never fetched), SDK patch no vendor/rs-sdk',
        'main    master @ abc1234, 2 changed files, 7 behind, 0 ahead of origin/master (fetched 2 min ago), SDK patch applied']);
});

test('the loops line names each fast-fail loop, says none, or is left out when not read', () => {
    const loop = { name: 'Shaftmaker', goal: 'headless arrows', error: 'Error: bank did not open', runs: 6, medianSec: 3, lastAt: NOW };
    const lines = nowLines(state(), local({ loops: [loop] }), NOW);
    expect(lines).toContain('loops   1 fast-fail loops in 2.0 h (bun scripts/fail-loops.ts):');
    expect(lines).toContain('  loop  Shaftmaker 6x 3 s: headless arrows | Error: bank did not open');
    expect(nowLines(state(), local({ loops: [] }), NOW)).toContain('loops   none in 2.0 h');
    expect(nowLines(state(), local(), NOW).some(l => l.startsWith('loops'))).toBe(false);
});
