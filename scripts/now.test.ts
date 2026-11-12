import {expect,test} from 'bun:test';
import {age,nowLines,type Checkout,type DashState,type Local} from './now';

const NOW=1_000_000_000_000,MIN=60_000;
const checkout=(over:Partial<Checkout>={}):Checkout=>({path:'x',branch:'master',head:'abc1234',dirty:0,behind:0,ahead:0,fetchedAt:NOW-2*MIN,patch:'applied',...over});
const local=(over:Partial<Local>={}):Local=>({uptimeSec:7200,stops:[],here:checkout(),main:null,...over});
const state=():DashState=>({now:NOW,
    capacity:{freeGB:6.6,floorGB:4,pendingReserveGB:2,headroomGB:0.6},
    swarm:{at:NOW-2000,running:25,maxBots:25,pendingStartup:2,jobs:33},
    sys:{cpu:58.4,procs:[{script:'swarm.ts',up:72*MIN},{script:'coordinator-cli.ts',up:83*MIN},{script:'fleet-agent.ts',up:73*MIN},{script:'aio-practice-bench.ts',up:MIN},{script:'swarm.test.ts',up:MIN}]},
    coordination:{at:NOW-10*MIN,fresh:false,paused:true,counts:{running:1,pending:1},tasks:[
        {id:'run-a',kind:'run',status:'running',agent:'codex',account:'Balls',startedAt:NOW-30*MIN,timeoutMs:90*MIN},
        {id:'build-b',kind:'build',status:'pending',agent:null,account:null,startedAt:null},
        {id:'old',kind:'run',status:'failed',agent:null,account:null,startedAt:NOW-999*MIN}]},
    bots:[{name:'A',job:{enabled:true,state:'running'}},{name:'B',job:{enabled:true,state:'exit orphaned'}},{name:'C',job:{enabled:false,state:'exit orphaned'}},{name:'D',job:null}],
    alerts:[{name:'A',kind:'stuck',practice:false},{name:'P',kind:'idle',practice:true}],
    scoreboard:{at:NOW-13*MIN,skills99:19,remaining:['quests 44/68 live']},
    fleetSides:{sides:[{side:'local',at:NOW-5*MIN,late:false},{side:'cloud',at:NOW-5*86_400_000,late:true}]},
    prs:[{number:7,branch:'claude/x',draft:true,state:'OPEN'},{number:6,branch:'claude/y',draft:false,state:'MERGED'}]});

test('age picks the unit by size',()=>{
    expect([age(42_000),age(7*MIN),age(3.2*3_600_000),age(3.6*86_400_000),age(-5)]).toEqual(['42 s','7 min','3.2 h','3.6 d','0 s']);
});

test('every fact of the state gets a line',()=>{
    const text=nowLines(state(),local({stops:[{file:'stop-coordinator',text:'owner pause'}]}),NOW).join('\n');
    expect(text).toContain('free 6.6 GiB = floor 4.0 + pending starts 2.0 + headroom 0.6; cpu 58%; up 2.0 h');
    expect(text).toContain('heavy   ci-gate.ts 0, test-shards.ts 0, aio-practice-bench.ts 1, typecheck-narrow.ts 0, test files 1 (bun processes, up to 60 s old)');
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

test('with no dashboard the local facts still print, and a worktree also shows the main checkout',()=>{
    const lines=nowLines(null,local({here:checkout({branch:'claude/t',behind:null,ahead:null,fetchedAt:null,patch:'no vendor/rs-sdk'}),main:checkout({behind:7,dirty:2})}),NOW);
    expect(lines).toEqual([
        'host    up 2.0 h',
        'stop    no stop-coordinator, no stop-swarm',
        'dashboard: no answer, so the fleet lines are missing. The lines below come from this PC only.',
        'here    claude/t @ abc1234, 0 changed files, origin/master not known (never fetched), SDK patch no vendor/rs-sdk',
        'main    master @ abc1234, 2 changed files, 7 behind, 0 ahead of origin/master (fetched 2 min ago), SDK patch applied']);
});
