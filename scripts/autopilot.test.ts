import { expect, test } from 'bun:test';
import { admittedByLevels, handNamed } from '../packages/core/src/army-roster';
import { OBSERVATION_FRESH_MS, reservedAccounts } from '../packages/planner/src/autopilot';
import { loadOwners } from '../packages/core/src/fleet';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { jobLogStart } from '../packages/core/src/job-log';
import { aioTemplates, BLOOD_FOOD, BLOOD_MEALS, BOUGHT_BONE_XP, CANNON_BARS, SWEEP_MEALS, catalogue, finishedTrainers, FOOD_HEAL, jobFor, mergeJobs, norm, plan, plannableAccounts, reservedResources, type Acct, type Inputs } from '../packages/planner/src/autopilot';
import { COW_FOOD_BITES, COW_FOOD_HP, cowFoodHeal } from './gather-combat';
import { BONE_XP } from './train-prayer';
import { coordinatedAdmission, missionSignature, parseJob, standingRetryable, startable, supervisorCommand } from './swarm';
import { supervise } from '../packages/practice/src/supervise';
import { assess } from '../packages/planner/src/autopilot';
import { planView } from './fleet-sync';
import { squadInput, unplacedPrecondition, unplacedHeld, UNPLACED_RETRY_MS, SIDE_STOCK_MAX_AGE_MS, unobservedAccounts, headroomWithMargin, plannerOwns, squadRestockAccounts, writtenNotRunning, tradeStarts, memoryHeadroom, freeSlots, jobRate, raiseKitSeq, aioPilots, armyRoster, completedHeldOrderSeq, donorStock, liveRetirements, coinOrder, fundOrders, heldResources, inOpenOrder, kitMarket, newestClaims, observedAccount, pass, planningOwnership, readJobResultLines, tradeStockReady } from './autopilot';
import { mergedPlan } from '../packages/core/src/coordinator-jobs';
import { FOLLOWED_RETRY_MS, GEAR_ASK_LIMIT, GEAR_ASK_MARGIN, UNSOLD_RETRY_MS, gearLimit } from './autopilot';
import { KIT_PRICE_CAPS } from '../packages/planner/src/autopilot';
import type { TradeReceipt } from './fleet-trade-settlement';
import { existsSync } from 'node:fs';
import { resolveAioStep } from './aio';
import { benchCases } from './measure/aio-bench-cases';
import { MEALS, presetFor } from './quest-sweep';
import { BANK_FOOD } from './blood-chest';
import { smeltRecipe } from './smelt-batch';
import {addTasks,initialState} from '../packages/router/src/coordinator';
test('pending dynamic participant ownership follows the shared binding without inventing unresolved names',()=>{
 const queue=initialState(),task={goal:'skills' as const,dependsOn:[],priority:1,estimatedMs:1,why:'Finite participant reservation'};
 addTasks(queue,[{...task,id:'new-account',kind:'provision',role:'combat'},{...task,id:'paired',kind:'run',capability:'handoff',dependsOn:['new-account'],participants:['Donor','@new-account'],acceptIndex:1,accept:{bank:{554:250}}}],1);
 expect(planningOwnership([],[],new Set(),queue).held.size).toBe(0);
 const created=queue.tasks[0]!;created.status='succeeded';created.receipt={taskId:created.spec.id,runId:'provision-run',ok:true,at:2,output:{account:'Helper 1'}};
 const bound=planningOwnership([],[],new Set(),queue);expect([...bound.held].sort()).toEqual(['donor','helper 1']);expect([...bound.busy].sort()).toEqual(['donor','helper 1']);
 queue.tasks[1]!.status='succeeded';expect(planningOwnership([],[],new Set(),queue).held.size).toBe(0);
});

test('pending observation consumers and native state qualifications reserve their account until settlement',()=>{
 const queue=initialState();addTasks(queue,[{id:'observe',kind:'run',capability:'owned-bank-observation',goal:'skills',account:'Fighter',accept:{skills:{Hitpoints:1}},dependsOn:[],priority:1,estimatedMs:1,why:'Read actual entry'},
  {id:'state-native',kind:'qualify',capability:'ranged-train',goal:'skills',account:'Fighter',dependsOn:['observe'],priority:1,estimatedMs:1,why:'Qualify actual entry'}],1);
 const held=planningOwnership([],[],new Set(),queue);expect(held.held.has('fighter')).toBe(true);expect(held.busy.has('fighter')).toBe(true);
 expect(plannableAccounts([],side,['Fighter','Free'],held.keep)).toEqual(['Free']);
 queue.tasks.forEach(r=>r.status='succeeded');expect(planningOwnership([],[],new Set(),queue).held.size).toBe(0);
});
import { GEM_RINGS, MAKE_BATCH, RING_BATCH, RUNE_ARROW_COST, RUNE_ARROW_SPEND, UNF_POTIONS, makerChains, priceTable } from '../packages/planner/src/autopilot';
import { supplyBill } from '../packages/planner/src/supply-bill';
import { inventoryRecipes } from './microbot-production';
import { jewelleryOrderFromEnv, planJewelleryOrder, validateJewelleryOrder } from './microbot-jewellery-trip';
import { smithRecipe } from './smith-batch';
import { parseStep } from '../packages/core/src/chain-step';
import { PROFILES, maximumUnitCost, selectItems } from './shop-buyer';

test('settled finite makers wake the existing planner on success or failure without matching another job',()=>{
    const t=aioTemplates().find(t=>t.id==='aio-sapphire-rings')!,side='local';
    const job=jobFor({account:'Crafter',template:t,value:1,reason:'one useful ring',resources:[]},side);
    expect(job.repeat).toBe(false);
    const assigned={Crafter:{template:t.id,offset:10}};
    for(const result of ['RESULT ok one ring banked','RESULT fail owned gem exhausted'])
        expect(finishedTrainers([job],side,assigned,[t],()=>[result])).toEqual(['Crafter']);
    expect(finishedTrainers([job],side,assigned,[t],()=>[])).toEqual([]);
    expect(finishedTrainers([job],side,{Crafter:{template:'different',offset:10}},[t],()=>['RESULT ok'])).toEqual([]);
    expect(finishedTrainers([{...job,autopilot:'cloud'}],side,assigned,[t],()=>['RESULT ok'])).toEqual([]);
    const farm=catalogue().find(t=>t.id.startsWith('goldfarm@'))!;
    expect(finishedTrainers([jobFor({account:'Farmer',template:farm,value:1,reason:'continuous funding',resources:[]},side)],side,
        {Farmer:{template:farm.id,offset:0}},[farm],()=>['RESULT ok finite farm window'])).toEqual([]);
});

test('held Prayer batches stop repeating and rearm only after a matching settled supply episode',()=>{
    const side='local',templates=catalogue();
    for(const id of ['army-bury-prayer-99','army-bury-dragon-99','army-bury-big-99']){
        const t=templates.find(t=>t.id===id)!;
        expect(jobFor({account:'Priest',template:t,value:0,reason:'finite owned bones',resources:[]},side).repeat).toBe(false);
    }
    const t=templates.find(t=>t.id==='army-bury-dragon-99')!;
    const account:Acct={name:'Priest',side,skills:{Prayer:98,Ranged:99,Magic:99},items:{'dragon bone':30}};
    const make=(sequence:Record<string,number>,a=account)=>{
        const [assignment]=plan({side,accounts:[a],owners:new Map([['priest',{side}]]),templates:[t],army:new Set(['priest']),bill:[],prices:{},kitSeq:new Map(Object.entries(sequence))});
        return assignment?.template?jobFor(assignment,side):undefined;
    };
    const old=make({})!;expect(old.repeat).toBe(false);
    const advance=completedHeldOrderSeq;
    const assigned={Priest:{template:t.id,offset:12}},initial={priest:0};
    expect(advance([old],side,assigned,[t],initial,()=>[])).toEqual(initial);
    expect(advance([{...old,enabled:false}],side,assigned,[t],initial,()=>['RESULT ok targetMet=false'])).toEqual(initial);
    expect(advance([old],side,assigned,[t],initial,()=>['RESULT fail input missing'])).toEqual(initial);
    expect(advance([old],side,assigned,[t],initial,()=>['RESULT ok targetMet=true consumed=24 preserved=true'])).toEqual(initial);
    const sequence=advance([old],side,assigned,[t],initial,()=>['RESULT ok targetMet=false consumed=24 preserved=true']);
    expect(sequence).toEqual({priest:1});expect(initial).toEqual({priest:0});
    const next=make(sequence)!;expect(missionSignature(next)).not.toBe(missionSignature(old));
    const done=new Map([['Priest',{reason:'done after 1 runs',revision:missionSignature(old)}]]);
    expect(startable(['Priest'],old.repeat,done,()=>Infinity,undefined,missionSignature(old)).start).toEqual([]);
    expect(startable(['Priest'],next.repeat,done,()=>Infinity,undefined,missionSignature(next)).start).toEqual(['Priest']);
    expect(make(sequence,{...account,skills:{...account.skills,Prayer:99}})).toBeUndefined();
});

test('a finished repeating job that a hold keeps stops repeating; every other job stays as it is',()=>{
    const side='local',job=(account:string,extra:Record<string,unknown>={})=>({account,script:'scripts/shop-buyer.ts',args:['zaff','3000'],env:{},role:'supply',enabled:true,repeat:true,standing:true,autopilot:side,template:'army-staff-zaff',...extra});
    const keep=new Set(['held','open','paused']),finished=new Set(['held','free','paused']);
    const out=mergeJobs([job('Held'),job('Open'),job('Free'),job('Paused',{enabled:false}),job('Other',{autopilot:'cloud'})],side,[],keep,finished).jobs;
    // Held and finished: it stops repeating. Held and not finished: unchanged. Not held: this pass replaces it (here by nothing). Owner pause: unchanged.
    expect(out.map(j=>[j.account,j.repeat])).toEqual([['Held',false],['Open',true],['Paused',true],['Other',true]]);
    // Nothing finished or no keep set: the old result.
    expect(mergeJobs([job('Held')],side,[],keep).jobs).toEqual([job('Held')]);
    expect(mergeJobs([job('Held')],side,[],new Set(),finished).jobs).toEqual([]);
});

test('a kit buy that never started is not running: no process ran since its assignment, so no offer is open',()=>{
    const job={account:'Idle',enabled:true,template:'kit-buy:army-weapon'},assigned={template:'kit-buy:army-weapon',offset:500,at:1_000_000};
    const late=1_000_000+JOB_START_GRACE_MS+1;
    // The log has not grown since the assignment, no run is active, and the grace has passed: not running (a stop file kept the swarm from starting it).
    expect(kitBuyRunning(job,assigned,()=>[],false,{active:false,logSize:500,now:late})).toBe(false);
    expect(neverStarted(assigned,{active:false,logSize:500,now:late})).toBe(true);
    // Inside the grace, a grown log, an active run or an unknown log size: still running.
    expect(kitBuyRunning(job,assigned,()=>[],false,{active:false,logSize:500,now:1_000_000+JOB_START_GRACE_MS})).toBe(true);
    expect(kitBuyRunning(job,assigned,()=>[],false,{active:false,logSize:640,now:late})).toBe(true);
    expect(kitBuyRunning(job,assigned,()=>[],false,{active:true,logSize:500,now:late})).toBe(true);
    expect(kitBuyRunning(job,assigned,()=>[],false,{active:false,now:late})).toBe(true);
    expect(kitBuyRunning(job,{...assigned,at:undefined},()=>[],false,{active:false,logSize:500,now:late})).toBe(true);
    // The old end record of an earlier job (before the assignment) does not make a started job look ended.
    expect(kitBuyRunning(job,assigned,()=>[],false,{active:false,logSize:640,now:late,ended:{at:900_000,reason:'exit 4'}})).toBe(true);
});

test('a declared finite maker keeps its exact pending mission until its own terminal result',()=>{
    const t=aioTemplates().find(t=>t.id==='aio-sapphire-rings')!,side='local';
    const job=jobFor({account:'Crafter',template:t,value:1,reason:'useful ring',resources:[]},side),assigned={template:t.id,offset:12};
    expect(kitBuyRunning(job,assigned,()=>[],true)).toBe(true);
    expect(kitBuyRunning(job,assigned,()=>['RESULT ok ring banked'],true)).toBe(false);
    expect(kitBuyRunning(job,assigned,()=>['RESULT fail no gem'],true)).toBe(false);
    expect(kitBuyRunning({...job,enabled:false},assigned,()=>[],true)).toBe(false);
    expect(kitBuyRunning(job,{...assigned,template:'other'},()=>[],true)).toBe(false);
});

test('finite makers use one supervisor attempt and keep an unchanged failed mission held by the swarm',async()=>{
    const t=aioTemplates().find(t=>t.id==='aio-sapphire-rings')!,side='local';
    const make=(count:number)=>{
        const account:Acct={name:'Crafter',side,skills:{Crafting:20},items:{'gold bar':count,sapphire:count,'ring mould':1}};
        const [assignment]=plan({side,accounts:[account],owners:new Map([['crafter',{side}]]),templates:[t],pilots:new Set([t.id]),
            bill:[{item:'sapphire ring',need:1,owned:0,short:1,ids:[],holders:[]}],prices:{'sapphire ring':900}});
        return jobFor(assignment!,side);
    };
    const job=make(13),parsed=parseJob(job);
    if('error' in parsed)throw Error(parsed.error);
    const command=supervisorCommand(parsed,parsed.accounts);
    expect(command.slice(0,5)).toEqual(['bun','packages/practice/src/supervise.ts','Crafter','scripts/aio.ts','0']);
    let attempts=0;
    const end=await supervise({run:async()=>{attempts++;return {stdout:'RESULT fail unfinished recipe ticks=20\n',exitCode:1};},
        stopped:()=>false,pause:async()=>{},maxRestarts:Number(command[4])});
    expect(end).toEqual({reason:'gave-up',runs:1});expect(attempts).toBe(1);
    expect(job).toMatchObject({repeat:false,standing:true,standingRetry:false,maxRestarts:0});
    expect(coordinatedAdmission(job,true)).toBe(true);
    const reason=`${end.reason} after ${end.runs} runs`,revision=missionSignature(job);
    // The existing standing retry would release this end, so a finite job must not opt into it.
    expect(standingRetryable(reason)).toBe(true);
    expect(standingRetryable(reason,undefined,job.standingRetry)).toBe(false);
    const ended=new Map([['Crafter',{reason,at:1000,revision}]]);
    expect(startable(['Crafter'],job.repeat,ended,()=>60_000,undefined,revision).start).toEqual([]);
    expect(missionSignature(make(13))).toBe(revision);
    const next=make(12);expect(missionSignature(next)).not.toBe(revision);
    // A failed end still needs the supported repair/resume path; only success rearms on changed observed stock.
    expect(startable(['Crafter'],next.repeat,ended,()=>60_000,undefined,missionSignature(next)).start).toEqual([]);
    const done=new Map([['Crafter',{reason:'done after 1 runs',at:1000,revision}]]);
    expect(startable(['Crafter'],job.repeat,done,()=>60_000,undefined,revision).start).toEqual([]);
    expect(startable(['Crafter'],next.repeat,done,()=>60_000,undefined,missionSignature(next)).start).toEqual(['Crafter']);
});

test('finite maker polling and preservation ignore stale, foreign and incomplete job results',()=>{
    const t=aioTemplates().find(t=>t.id==='aio-sapphire-rings')!,side='local';
    const job=jobFor({account:'Crafter',template:t,value:1,reason:'useful ring',resources:[]},side),foreign={...job,args:[...job.args,'TARGET=2']};
    const dir=mkdtempSync(join(tmpdir(),'autopilot-finite-log-')),log=join(dir,'account.log');
    try{
        const stale=jobLogStart(job)+'RESULT ok previous assignment\n';
        writeFileSync(log,stale+jobLogStart(job)+'SUPERVISE start\n'+jobLogStart(foreign)+'RESULT ok foreign order\n');
        const assigned={template:t.id,offset:Buffer.byteLength(stale)},read=(offset:number)=>readJobResultLines(log,offset,job);
        const poll=()=>finishedTrainers([job],side,{Crafter:assigned},[t],(_a,offset,active)=>readJobResultLines(log,offset,active));
        expect(kitBuyRunning(job,assigned,read,true)).toBe(true);expect(poll()).toEqual([]);
        appendFileSync(log,jobLogStart(job)+'RESULT fail own recipe');
        expect(kitBuyRunning(job,assigned,read,true)).toBe(true);expect(poll()).toEqual([]);
        appendFileSync(log,'\n');
        expect(kitBuyRunning(job,assigned,read,true)).toBe(false);expect(poll()).toEqual(['Crafter']);
    }finally{rmSync(dir,{recursive:true,force:true});}
});

test('finite maker chains remain pending until their outer result after indented child results',()=>{
    const t=makerChains().find(t=>t.id==='make-uncooked-stew')!,side='local';
    const job=jobFor({account:'Cook',template:t,value:1,reason:'useful stew',resources:[]},side);
    const dir=mkdtempSync(join(tmpdir(),'autopilot-finite-chain-')),log=join(dir,'account.log'),assigned={template:t.id,offset:0};
    try{
        const read=(offset:number)=>readJobResultLines(log,offset,job);
        const poll=()=>finishedTrainers([job],side,{Cook:assigned},[t],(_a,offset,active)=>readJobResultLines(log,offset,active));
        for(const outcome of ['ok','fail']){
            writeFileSync(log,jobLogStart(job)+`  | RESULT ${outcome} prepare potato-stew\nCHAIN round=1 scripts/aio.ts ${outcome}\n`);
            expect(read(0)).toContain(`  | RESULT ${outcome} prepare potato-stew`);
            expect(kitBuyRunning(job,assigned,read,true)).toBe(true);expect(poll()).toEqual([]);
            appendFileSync(log,`RESULT ${outcome} chain rounds=1 ok=1 failed=${outcome==='ok'?0:1}\n`);
            expect(kitBuyRunning(job,assigned,read,true)).toBe(false);expect(poll()).toEqual(['Cook']);
        }
    }finally{rmSync(dir,{recursive:true,force:true});}
});
import { sideCard } from './fleet-sync';

const side = 'claude-cloud';
// Admission and skill-transition cases have a finite route funding request. Supply-value cases set their own bill.
const coinBill = [{ item: 'coins', need: 1_000_000, owned: 0, short: 1_000_000, ids: [995], holders: [] }];
const inputs = (a: Acct): Inputs => ({ side, accounts: [a], owners: new Map([[a.name.toLowerCase(), { side }]]), bill: coinBill, templates: catalogue(), prices: {} });
const settled = () => 60_000;

test('a trainer at its target stays ended for the swarm, and the next pass starts the account on its next template', () => {
    const fresh: Acct = { name: 'TrouserSnake', side, skills: { Hitpoints: 10 }, items: {} };
    const [first] = plan(inputs(fresh));
    const trainer = jobFor(first!, side);
    expect(trainer).toMatchObject({ template: 'thieving55', enabled: true, repeat: false, standing: true });

    // The trainer's ok RESULT: the supervisor ends done, and a job that does not repeat is blocked on that end.
    const ended = new Map([['TrouserSnake', { reason: 'done after 1 runs', at: 1000, revision: missionSignature(trainer) }]]);
    expect(startable(['TrouserSnake'], trainer.repeat, ended, settled, undefined, missionSignature(trainer)))
        .toEqual({ start: [], blocked: { TrouserSnake: 'ended: done after 1 runs' } });
    // The daemon sees the finish in the job's log since its assignment and passes without waiting for the timer.
    const assigned = { TrouserSnake: { template: 'thieving55', offset: 0 } };
    expect(finishedTrainers([trainer], side, assigned, catalogue(), () => ['RESULT ok thieving=55 xp=16000 ticks=1736 died=false'])).toEqual(['TrouserSnake']);

    // That pass reads the status at the target level: the trainer is skipped, a knight spot replaces it, and the new
    // mission starts although the account's last end is done. The account has 20 Hitpoints here: the frail rule keeps
    // a thief under that off the knights until it holds food (GOLDFARM_FRAIL, packages/planner/src/autopilot.ts).
    const [next] = plan(inputs({ ...fresh, skills: { ...fresh.skills, Thieving: 55, Hitpoints: 20 } }));
    expect(next!.template!.id).toMatch(/^goldfarm@/);
    const merged = mergeJobs([trainer], side, [next!]);
    expect(merged.fresh).toEqual(['TrouserSnake']);
    expect(merged.jobs).toEqual([jobFor(next!, side)]);
    expect(merged.jobs[0].repeat).toBe(true);
    expect(startable(['TrouserSnake'], merged.jobs[0].repeat, ended, settled, undefined, missionSignature(merged.jobs[0])).start).toEqual(['TrouserSnake']);
});


const order = (id: string, from: string, to: string, end: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from, to, item: 'coins', count: 1500, start: 0, end });
const make = (from: string, to: string, coins: number) => ({ ...order(`o-${from}-${to}`, from, to, 9_999), count: coins });

test('legacy order receipts do not close a live window or supply proven stock', () => {
    const orders = [order('a', 'Big', 'Poor', 100), order('b', 'Rich', 'Low', 100), order('c', 'Old', 'Gone', 10)];
    const receipts = [{ id: 'b', role: 'from' }, { id: 'b', role: 'to' }] as any;
    expect([...inOpenOrder(orders, receipts, 50)].sort()).toEqual(['big', 'low', 'poor', 'rich']);
    expect([...inOpenOrder(orders, receipts, 101)]).toEqual([]);
});

test('funding holds past expiry on incomplete proof and releases each party only against current settled stock', () => {
    const o = order('a', 'Big', 'Poor', 3000);
    const receipt = (role: 'from' | 'to'): TradeReceipt => ({
        version: 2, state: 'settled', id: o.id, role, account: o[role], partner: role === 'from' ? o.to : o.from, side: 'local',
        server: o.server, item: o.item, requested: o.count, claim: '12345678-1234-1234-1234-123456789012', at: 2700,
        ok: true, detail: '', count: o.count, inventory: role === 'from' ? { before: o.count, after: 0 } : { before: 0, after: o.count },
        ...(role === 'to' ? { bank: { count: o.count, at: 2300 } } : {}),
        logout: { attemptId: '0000000002400-1-1', at: 2600, sha256: 'a'.repeat(64) },
    });
    const giver = receipt('from'), receiver = receipt('to'), now = 5000;
    const expected = ['big', 'poor'];
    const held = (r: TradeReceipt[]) => [...inOpenOrder([o], r, now)].sort();
    expect(held([{ ...giver, state: 'prepared', ok: false }])).toEqual(expected);
    expect(held([giver, { ...receiver, state: 'reconcile', ok: false }])).toEqual(expected);
    expect(held([giver, { ...receiver, bank: undefined }])).toEqual(expected);
    expect(held([giver, { ...receiver, partner: 'Wrong' }])).toEqual(expected);
    expect(held([giver, { ...receiver, state: 'failed', ok: false, count: 0 }])).toEqual(expected);
    expect(held([giver, receiver])).toEqual([]);
    const statuses = {
        Big: { name: 'Big', server: o.server, at: 2700, inventory: [] },
        Poor: { name: 'Poor', server: o.server, at: 2700, bankAt: 2299, bank: [], inventory: [] },
    };
    const observed = (r: TradeReceipt) => tradeStockReady(r, statuses[r.account as keyof typeof statuses]);
    expect([...inOpenOrder([o], [giver, receiver], now, observed)]).toEqual(['poor']);
    statuses.Poor.bankAt = 2300;
    expect([...inOpenOrder([o], [giver, receiver], now, observed)]).toEqual([]);
});

test('after its window an order holds no one when one party failed and the other never started, or when a retry completed it', () => {
    const receipt = (o: ReturnType<typeof order>, role: 'from' | 'to', state: 'settled' | 'failed'): TradeReceipt => ({
        version: 2, state, id: o.id, role, account: o[role], partner: role === 'from' ? o.to : o.from, side: 'local',
        server: o.server, item: o.item, requested: o.count, claim: '12345678-1234-1234-1234-123456789012', at: 2700,
        ok: state === 'settled', detail: '', count: state === 'settled' ? o.count : 0,
        inventory: state === 'failed' ? { before: 7, after: 7 } : role === 'from' ? { before: o.count, after: 0 } : { before: 0, after: o.count },
        ...(role === 'to' && state === 'settled' ? { bank: { count: o.count, at: 2300 } } : {}),
        logout: { attemptId: '0000000002400-1-1', at: 2600, sha256: 'a'.repeat(64) },
    });
    const first = order('a', 'Big', 'Poor', 3000), retry = order('b', 'Big', 'Poor', 4000), now = 5000;
    const held = (orders: ReturnType<typeof order>[], r: TradeReceipt[], at = now) => [...inOpenOrder(orders, r, at)].sort();
    // The taker failed and the giver never ran: closed once the window is over, held while it is open.
    expect(held([first], [receipt(first, 'to', 'failed')])).toEqual([]);
    expect(held([first], [receipt(first, 'to', 'failed')], 2900)).toEqual(['big', 'poor']);
    // A party that is still uncertain keeps the hold.
    expect(held([first], [{ ...receipt(first, 'to', 'failed'), state: 'reconcile' }])).toEqual(['big', 'poor']);
    // One order alone with a settled giver and a failed taker is a real mismatch.
    const gaveFirst = [receipt(first, 'from', 'settled'), receipt(first, 'to', 'failed')];
    expect(held([first], gaveFirst)).toEqual(['big', 'poor']);
    // The retry holds the other half: the taker's settled receipt and the giver's failure. Together, one transfer.
    const tookRetry = [receipt(retry, 'from', 'failed'), receipt(retry, 'to', 'settled')];
    expect(held([first, retry], [...gaveFirst, ...tookRetry])).toEqual([]);
    // A retry for another count does not complete it.
    const other = { ...retry, count: 9 };
    expect(held([first, other], [...gaveFirst, receipt(other, 'from', 'failed'), receipt(other, 'to', 'settled')])).toEqual(['big', 'poor']);
    // The settled halves still wait for a status that shows the stock.
    expect([...inOpenOrder([first, retry], [...gaveFirst, ...tookRetry], now, r => r.role !== 'to')]).toEqual(['poor']);
    // A giver that claimed and died leaves a prepared receipt. While its trade claim is held the order holds both;
    // once the claim is released by hand the receipt counts as none, unless the taker shows a transfer.
    const died: TradeReceipt = { ...receipt(first, 'from', 'failed'), state: 'prepared', inventory: undefined, logout: undefined, claim: '99999999-1234-1234-1234-123456789012' };
    const released = (r: TradeReceipt[]) => [...inOpenOrder([first], r, now, () => true, () => false)].sort();
    expect(held([first], [died])).toEqual(['big', 'poor']);
    expect(released([died])).toEqual([]);
    expect(released([died, receipt(first, 'to', 'failed')])).toEqual([]);
    expect(released([died, receipt(first, 'to', 'settled')])).toEqual(['big', 'poor']);
    expect([...inOpenOrder([first], [died], 2900, () => true, () => false)].sort()).toEqual(['big', 'poor']);
    // The same for a giver whose session ended in reconcile with nothing given (live: its partner never came).
    const unsure: TradeReceipt = { ...receipt(first, 'from', 'failed'), state: 'reconcile', inventory: undefined, claim: '99999999-1234-1234-1234-123456789012' };
    expect(held([first], [unsure])).toEqual(['big', 'poor']);
    expect(released([unsure])).toEqual([]);
    expect(released([unsure, receipt(first, 'to', 'settled')])).toEqual(['big', 'poor']);
});

test('a funded assignment becomes a coin order and a vacant account; an account in an open order waits', () => {
    const shop = { id: 'shop-feathers' } as any;
    const out = [
        { account: 'Poor', template: shop, value: 9, resources: ['shop:sarim'], reason: 'feather', fund: { from: 'Big', to: 'Poor', coins: 1500, template: 'shop-feathers' } },
        { account: 'Low', template: shop, value: 9, resources: ['shop:sarim'], reason: 'feather', fund: { from: 'Big', to: 'Low', coins: 1500, template: 'shop-feathers' } },
        { account: 'Farmer', template: { id: 'goldfarm@2652,3318' } as any, value: 5, resources: [], reason: 'coins' },
    ];
    const r = fundOrders(out, new Set(['low']), make);
    expect(r.orders.map(o => [o.from, o.to, o.count])).toEqual([['Big', 'Poor', 1500]]);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual([
        'vacant: awaits 1500 coins from Big for shop-feathers', 'vacant: awaits 1500 coins from Big for shop-feathers', 'goldfarm@2652,3318']);
    expect(r.log[1]).toContain('waits for an open order');
});

test('a party to an open order takes no normal job until the order closes', () => {
    const out = [
        { account: 'Big', template: { id: 'shop-runes' } as any, value: 9, resources: ['shop:aubury'], reason: 'rune' },
        { account: 'Poor', template: { id: 'goldfarm@2652,3318' } as any, value: 5, resources: [], reason: 'coins' },
        { account: 'Farmer', template: { id: 'goldfarm@2653,3300' } as any, value: 5, resources: [], reason: 'coins' },
    ];
    const r = fundOrders(out, new Set(['big', 'poor']), make);
    expect(r.orders).toEqual([]);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual(['vacant: in an open fleet order', 'vacant: in an open fleet order', 'goldfarm@2653,3300']);
});

test('a coin order opens in 15 minutes for 40 and fits the fleet order format', () => {
    const o = coinOrder('Pocketpython', 'YewFirst', 18_000, 'rs-sdk-demo.fly.dev', 1_000);
    expect(o).toEqual({ id: '901000-pocketpython-yewfirst', server: 'rs-sdk-demo.fly.dev', from: 'Pocketpython', to: 'YewFirst', item: 'coins', count: 18_000, start: 901_000, end: 3_301_000 });
    // The same checks as scripts/fleet-trade.ts validOrder.
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(o.id) && [o.from, o.to].every(n => /^[A-Za-z0-9]{1,12}$/.test(n)) && o.end > o.start).toBe(true);
});

import { pauses, stopClearable, OFFLINE_STATUS_MS } from './autopilot';
import { SWARM_STOP } from './swarm';
test('a stop file pauses an account only when the owner wrote it; the controller\'s own marks an account to plan again', () => {
    const { paused, swarmStopped } = pauses(new Map([['TrouserSnake', SWARM_STOP.removed], ['UnderMyKilt', 'hold for the trade'], ['Quickhandjob', `${SWARM_STOP.all}\n`],
        ['Kiltlifter', SWARM_STOP.lease]]));
    expect([...paused]).toEqual(['undermykilt']);
    expect([...swarmStopped].sort()).toEqual(['kiltlifter', 'quickhandjob', 'trousersnake']);
});

test('the controller\'s stop file goes only once the account is offline: no status, a RESULT, or a row older than the live refresh', () => {
    const now = 1_000_000;
    expect(stopClearable(null, now)).toBe(true);
    expect(stopClearable({ at: now - 5_000, result: 'fail stop file ticks=55' }, now)).toBe(true);
    expect(stopClearable({ at: now - OFFLINE_STATUS_MS - 1 }, now)).toBe(true);
    expect(stopClearable({ at: now - 5_000 }, now)).toBe(false);
});

test('trainer polling supplies the actual standing job to the result reader', () => {
    const template = catalogue().find(t => t.id === 'thieving55')!;
    const trainer = jobFor({account:'Trainer',template,value:1,resources:[],reason:'train'},side);
    const assigned = {Trainer:{template:template.id,offset:0}};
    const results = finishedTrainers([trainer],side,assigned,catalogue(),
        (...args: unknown[]) => args[2] === trainer ? ['RESULT ok'] : []);
    expect(results).toEqual(['Trainer']);
});

test('Autopilot only reads complete results written by the matching standing job', () => {
    const template = catalogue().find(t => t.id === 'thieving55')!;
    const trainer = jobFor({account:'Trainer',template,value:1,resources:[],reason:'train'},side);
    const coordinator = {...trainer, autopilot:undefined, template:undefined};
    const otherStanding = {...trainer, env:{...trainer.env, CAP:'different'}};
    const log = join(mkdtempSync(join(tmpdir(),'autopilot-job-log-')),'account.log');
    const past = 'RESULT ok legacy\n';
    writeFileSync(log, past + jobLogStart(coordinator) + 'RESULT fail coordinator\nRESULT ok coordinator\n'
        + jobLogStart(otherStanding) + 'RESULT fail different arguments\n'
        + jobLogStart(trainer) + 'RESULT fail own attempt\nRESULT ok own attempt');
    const assigned = {Trainer:{template:template.id,offset:Buffer.byteLength(past)}};
    const poll = () => finishedTrainers([trainer],side,assigned,catalogue(),(_a,offset,job)=>readJobResultLines(log,offset,job));
    expect(readJobResultLines(log,0,trainer).filter(l=>l.startsWith('RESULT'))).toEqual(['RESULT fail own attempt']);
    expect(poll()).toEqual([]);
    appendFileSync(log,'\n');
    expect(poll()).toEqual(['Trainer']);
});

test('coordinator ownership preserves a standing job and excludes held funding parties until release', () => {
    const standing = {account:'Held',autopilot:side,enabled:true,repeat:true,script:'scripts/goldfarm.ts',
        template:'test',resources:['knight:2671,3313']};
    const ownerJobs = [standing];
    const overlays = [{accounts:['HELD','Donor'],enabled:false,script:'scripts/chain.ts',coordinatorOwner:'coordinator'}];
    const paused = new Set(['paused']);
    const ownership = planningOwnership(ownerJobs, overlays, paused);
    expect(ownership.held).toEqual(new Set(['held','donor']));
    expect(ownership.busy.has('donor')).toBe(true);
    expect(plannableAccounts(ownerJobs,side,['Held','Donor','Paused','Free'],ownership.keep)).toEqual(['Free']);
    expect(mergeJobs(ownerJobs,side,[],ownership.keep).jobs).toEqual([standing]);
    expect(reservedResources(ownerJobs,side,ownership.keep)).toEqual({'knight:2671,3313':1});
    const released=planningOwnership(ownerJobs,[],paused);
    expect(plannableAccounts(ownerJobs,side,['Held','Donor'],released.keep)).toEqual(['Held','Donor']);
    expect(released.busy.has('donor')).toBe(false);
});


test('a paused autopilot pass holds before reading the plan', () => {
    expect(pass('missing-owner-plan.json', false, () => true)).toEqual(['AUTOPILOT hold: swarm is paused']);
});


test('a pause arriving during planning leaves the owner plan bytes intact', () => {
    const parent = resolve(tmpdir()), base = mkdtempSync(join(parent, 'rsbot-autopilot-pause-'));
    const previous = process.env.FLEET_DIR;
    try {
        const planFile = join(base, 'swarm.json'), before = '{"jobs":[],"maxBots":4}';
        writeFileSync(planFile, before);
        process.env.FLEET_DIR = base;
        let checks = 0;
        expect(pass(planFile, false, () => ++checks > 1)).toEqual(['AUTOPILOT hold: swarm is paused']);
        expect(readFileSync(planFile, 'utf8')).toBe(before);
        expect(pass(planFile, true, () => true).at(-1)).toBe('AUTOPILOT dry run: nothing written');
        expect(readFileSync(planFile, 'utf8')).toBe(before);
    } finally {
        if (previous === undefined) delete process.env.FLEET_DIR;
        else process.env.FLEET_DIR = previous;
        if (/^rsbot-autopilot-pause-[^\\/]+$/.test(relative(parent, base))) rmSync(base, { recursive: true });
    }
});

test('each side counts at its newest claim, synced or on origin', () => {
    const synced = [{ side: 'claude-cloud', at: 100, resources: ['knight:2652,3318'] }, { side: 'claude-cloud-2', at: 300, resources: ['knight:2582,3297'] }, null, { side: 'bad' }];
    const origin = [{ side: 'claude-cloud', at: 200, resources: [] }, { side: 'claude-cloud-2', at: 250, resources: [] }, { side: 'claude-cloud-3', at: 150, resources: ['knight:2652,3318'] }];
    const out = Object.fromEntries(newestClaims(synced, origin).map(c => [c.side, c.resources]));
    expect(out).toEqual({ 'claude-cloud': [], 'claude-cloud-2': ['knight:2582,3297'], 'claude-cloud-3': ['knight:2652,3318'] });
    expect(newestClaims(synced, [])).toHaveLength(2);
});

test('a plan whose enabled jobs hold different resources has a changed claim; an unchanged one does not', () => {
    const farm = (account: string, spot: string, enabled = true) => ({ account, script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot }, enabled, resources: [`knight:${spot}`] });
    const before = [farm('A', '2652,3318'), farm('B', '2669,3298')];
    expect(heldResources(before)).toBe(heldResources([farm('B', '2669,3298'), farm('A', '2652,3318')]));
    expect(heldResources(before)).not.toBe(heldResources([farm('A', '2653,3300'), farm('B', '2669,3298')]));
    expect(heldResources(before)).not.toBe(heldResources([farm('A', '2652,3318'), farm('B', '2669,3298', false)]));
    expect(heldResources([...before, farm('C', '2671,3313', false)])).toBe(heldResources(before));
});

test('the army roster is the plan\'s explicit list, lower-cased, never Haggis', () => {
    expect([...armyRoster({ army: ['Kiltlifter', 'PocketPool', 'Haggis', 7] })]).toEqual(['kiltlifter', 'pocketpool']);
    expect(armyRoster({ jobs: [] }).size).toBe(0);
    expect(armyRoster(null).size).toBe(0);
});

test('the planner food heals are the content heals over all bites', () => {
    expect({ ...FOOD_HEAL }).toEqual({
        trout: 7, cake: 12, '2/3 cake': 8, 'slice of cake': 4, 'chocolate cake': 15, '2/3 chocolate cake': 10, 'chocolate slice': 5,
    });
});

test('the planner heals food by the same table as cow mode, and the cow bands need its HP', () => {
    const names = new Map((JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8')) as { id: number; name: string }[]).map(i => [i.id, i.name]));
    const ids = Object.keys(COW_FOOD_BITES).map(Number);
    expect(Object.fromEntries(ids.map(id => [norm(names.get(id)!), cowFoodHeal([{ id, count: 1 }])]))).toEqual({ ...FOOD_HEAL });
    for (const t of catalogue().filter(t => t.id.startsWith('army-cow-'))) expect(t.needs?.food).toBe(COW_FOOD_HP);
});

test('the planner sizes a bone buy by the XP the Prayer trainer checks on each bury', () => {
    for (const [id, xp] of Object.entries(BOUGHT_BONE_XP)) expect(BONE_XP[Number(id)]).toBe(xp);
});

test('a retirement lapses when its script changes, except a death or a gone template', () => {
    const scriptOf = (t: string) => ({ 'army-cow-strength-45': 'new', goldfarm: 'same' } as Record<string, string>)[t];
    expect(liveRetirements({
        'trousersnake:army-cow-strength-45': { reason: '2 fail RESULTs', script: 'old' },
        'fatstack:goldfarm': { reason: 'tick waste 95%', script: 'same' },
        'dipstick:army-cow-strength-45': { reason: 'death: died', script: 'old' },
        'kiltlifter:gone-template': { reason: '2 fail RESULTs', script: 'old' },
        'thefullmonty:army-cow-strength-45': '2 fail RESULTs',
    }, scriptOf)).toEqual({
        retired: {
            'fatstack:goldfarm': { reason: 'tick waste 95%', script: 'same' },
            'dipstick:army-cow-strength-45': { reason: 'death: died', script: 'old' },
            'kiltlifter:gone-template': { reason: '2 fail RESULTs', script: 'old' },
            // A bare reason from before scripts were recorded takes the current script and stays.
            'thefullmonty:army-cow-strength-45': { reason: '2 fail RESULTs', script: 'new' },
        },
        lapsed: ['trousersnake:army-cow-strength-45'],
    });
});

test('a retirement whose last fail is now a drain lapses, whatever its script', () => {
    const scriptOf = () => 'same';
    const noRoute = '2 fail RESULTs: RESULT fail travel to Ardougne from 3185,3436 failed: precondition no route to 2654,3283,0';
    expect(liveRetirements({
        'thefullmonty:army-cow-strength-70': { reason: noRoute, script: 'same' },
        'quickhandjob:army-cow-defence-45': noRoute,
        'trousersnake:army-cow-strength-45': { reason: '2 fail RESULTs: RESULT fail no cow progress: insufficient slots', script: 'same' },
    }, scriptOf)).toEqual({
        retired: { 'trousersnake:army-cow-strength-45': { reason: '2 fail RESULTs: RESULT fail no cow progress: insufficient slots', script: 'same' } },
        lapsed: ['thefullmonty:army-cow-strength-70', 'quickhandjob:army-cow-defence-45'],
    });
});
test('a saved infrastructure retirement lapses while gameplay and death holds remain', () => {
    const offline = { reason: '2 fail RESULTs: RESULT fail login: LoginError: Login server offline', script: 'same' };
    const claim = { reason: '2 fail RESULTs: RESULT fail login: Error: fleet swarm claim authority unavailable or changed', script: 'same' };
    const stalled = { reason: 'tick waste 97% idle+move', script: 'same' };
    const death = { reason: 'death: died', script: 'same' };
    expect(liveRetirements({ 'first:goldfarm': offline, 'second:feathers': claim, 'third:ranged': stalled, 'fourth:ranged': death }, () => 'same')).toEqual({
        retired: { 'third:ranged': stalled, 'fourth:ranged': death }, lapsed: ['first:goldfarm', 'second:feathers'],
    });
});
test('kit offers buy the usable bow ID and retain market absence and unsold holds', () => {
    const bows = [
        { id: 72, name: 'Magic shortbow', debugname: 'unstrung_magic_shortbow' },
        { id: 861, name: 'Magic shortbow', debugname: 'magic_shortbow' },
        { id: 862, name: 'Magic shortbow', debugname: 'cert_magic_shortbow' },
    ];
    expect(kitMarket(bows, {}, 1_000)['magic shortbow']?.id).toBe(861);
    expect(kitMarket(bows.slice(0, 1), {}, 1_000)['magic shortbow']).toBeUndefined();
    expect(kitMarket(bows, { '861': 900 }, 1_000)['magic shortbow']).toBeUndefined();
    const nativeItems = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    expect(kitMarket(nativeItems, {}, 1_000)['magic shortbow']?.id).toBe(861);
});
test('the limit of a worn item follows the lowest ask up to five times its shop value; stacked supplies keep their caps', () => {
    const legs = KIT_PRICE_CAPS['rune plateleg']!, helm = KIT_PRICE_CAPS['rune full helm']!, arrow = KIT_PRICE_CAPS['rune arrow']!;
    // Rune platelegs: shop value 64,000, asked 105,375 by four sellers.
    expect(gearLimit(1079, legs, { ask: 105_375, sell: 4 })).toBe(Math.ceil(105_375 * GEAR_ASK_MARGIN));
    // An ask at or under the cap, an ask with no seller behind it and no quote leave the cap.
    expect(gearLimit(1079, legs, { ask: legs - 1, sell: 4 })).toBe(legs);
    expect(gearLimit(1079, legs, { ask: 105_375, sell: 0 })).toBe(legs);
    expect(gearLimit(1079, legs, undefined)).toBe(legs);
    // Rune chainbody: shop value 50,000, asked 210,367.
    expect(gearLimit(1113, KIT_PRICE_CAPS['rune chainbody']!, { ask: 210_367, sell: 896 })).toBe(220_886);
    // Rune full helm: shop value 35,200, asked 349,982: over the bound.
    expect(349_982).toBeGreaterThan(GEAR_ASK_LIMIT * 35_200);
    expect(gearLimit(1163, helm, { ask: 349_982, sell: 40 })).toBe(helm);
    // Rune arrows are bought in stacks, and a rune is not worn.
    expect(gearLimit(892, arrow, { ask: arrow + 100, sell: 500 })).toBe(arrow);
    expect(gearLimit(561, KIT_PRICE_CAPS['nature rune']!, { ask: 900, sell: 500 })).toBe(KIT_PRICE_CAPS['nature rune']!);
    const items = [{ id: 1079, name: 'Rune platelegs', debugname: 'rune_platelegs' }, { id: 1163, name: 'Rune full helm', debugname: 'rune_full_helm' }];
    const asks = { 1079: { ask: 105_375, sell: 4 }, 1163: { ask: 349_982, sell: 40 } }, hour = FOLLOWED_RETRY_MS, now = 10 * UNSOLD_RETRY_MS;
    // The helm's lowest ask is over its limit, so no buy is planned for it.
    expect(kitMarket(items, {}, now, asks)).toEqual({ 'rune plateleg': { id: 1079, name: 'Rune platelegs', limit: 110_644 } });
    // A buy that got none: the followed item is back after an hour, the capped one after a day.
    const failed = { '1079': now - hour + 1, '1163': now - hour - 1 };
    expect(Object.keys(kitMarket(items, failed, now, asks))).toEqual([]);
    expect(Object.keys(kitMarket(items, { '1079': now - hour - 1, '1163': now - UNSOLD_RETRY_MS - 1 }, now, asks))).toEqual(['rune plateleg']);
    expect(Object.keys(kitMarket(items, { '1163': now - UNSOLD_RETRY_MS - 1 }, now))).toEqual(['rune plateleg', 'rune full helm']);
    // A read with no seller, or with the lowest ask over the limit, plans no buy; an item with no read stays.
    const blades = [{ id: 1333, name: 'Rune scimitar', debugname: 'rune_scimitar' }, { id: 1331, name: 'Adamant scimitar', debugname: 'adamant_scimitar' }, { id: 1215, name: 'Dragon dagger', debugname: 'dragon_dagger' }, { id: 1303, name: 'Rune longsword', debugname: 'rune_longsword' }];
    expect(Object.keys(kitMarket(blades, {}, now, { 1333: { ask: null, sell: 0 }, 1331: { ask: 36_948, sell: 439 }, 1215: { ask: 266_203, sell: 2 } }))).toEqual(['adamant scimitar', 'rune longsword']);
    expect(Object.keys(kitMarket(blades, {}, now))).toEqual(['rune scimitar', 'adamant scimitar', 'dragon dagger', 'rune longsword']);
    // With no quote the platelegs wait the day too.
    expect(Object.keys(kitMarket(items, { '1079': now - hour - 1 }, now))).toEqual(['rune full helm']);
});
test('a confirmed-offline account keeps its observed stock for a day, unless a session or an order touched it later', () => {
    const hour = 3_600_000, seen = 10 * hour, now = seen + 5 * hour;
    const status = { name: 'Donor', server: 'rs-sdk-demo.fly.dev', at: seen, bankAt: seen, inventory: [], bank: [{ id: 556, name: 'Air rune', count: 400 }] };
    const stockOf = (offline?: Parameters<typeof offlineStockFresh>[1], at = now) => donorStock('Donor', 'local', status, at, 30 * 60_000, () => undefined, 'rs-sdk-demo.fly.dev', offline)?.items['air rune'];
    const proof = { confirmed: true, loggedOutAt: seen + 5_000, startedAt: seen - hour };
    // Past the 30-minute window, no proof: no stock. With a confirmed logout after the observation: the stock stands.
    expect(stockOf()).toBeUndefined();
    expect(stockOf(proof)).toBe(400);
    // Not confirmed, a logout before the observation, an order that ended after it, or an observation over a day old.
    expect(stockOf({ confirmed: false })).toBeUndefined();
    expect(stockOf({ confirmed: true, loggedOutAt: seen - 61_000, startedAt: seen - 2 * hour })).toBeUndefined();
    // A later session (it started after the observation, so it may have changed the bank before it wrote a status).
    expect(stockOf({ ...proof, startedAt: seen + 1 })).toBeUndefined();
    expect(stockOf({ ...proof, startedAt: undefined })).toBeUndefined();
    expect(stockOf({ ...proof, ordersEnd: seen + 1 })).toBeUndefined();
    expect(stockOf({ ...proof, ordersEnd: seen })).toBe(400);
    expect(stockOf(proof, seen + OFFLINE_STOCK_MAX_AGE_MS)).toBeUndefined();
    expect(stockOf(proof, seen + OFFLINE_STOCK_MAX_AGE_MS - 1)).toBe(400);
    // A fresh observation needs no proof, and a future time is never fresh.
    expect(offlineStockFresh(now, undefined, now)).toBe(false);
    expect(offlineStockFresh(now + 1, proof, now)).toBe(false);
    // The vacant note counts an account as unobserved only when neither window holds.
    const at = (n: string) => ({ a: seen, b: seen, c: now - 60_000 })[n];
    expect(unobservedAccounts(['a', 'b', 'c'], at, now, n => (n === 'a' ? proof : undefined))).toEqual(['b']);
});
test('donor stock keeps unstrung bow names apart from usable and noted gear', () => {
    const stock = donorStock('Donor', 'local', { name: 'Donor', server: 'rs-sdk-demo.fly.dev', at: 1_000, bankAt: 1_000,
        inventory: [{ id: 72, name: 'Magic shortbow', count: 3 }], bank: [{ id: 862, baseId: 861, name: 'Magic shortbow (noted)', count: 1 }] }, 1_001, 500, () => undefined);
    expect(stock?.items['magic shortbow']).toBe(1);
    expect(stock?.items['unstrung magic shortbow']).toBe(3);
});

import { ARMY_MEET, OFFLINE_STOCK_MAX_AGE_MS, itemOrder, offlineStockFresh, sideStock } from './autopilot';
import { meetingTiles } from './coin-courier';
import { validOrder } from './fleet-trade-settlement';
test('a kit item order fits the fleet order format and meets at the army bank', () => {
    const o = itemOrder('TheFullMonty', 'Masterbaiter', 'Mind rune', 20, 'rs-sdk-demo.fly.dev', 1_000_000);
    expect(validOrder(o)).toBe(true);
    expect(o).toMatchObject({ id: '1900000-thefullmonty-masterbaiter-mindrune', item: 'Mind rune', count: 20, start: 1_900_000, end: 1_900_000 + 40 * 60_000, meet: ARMY_MEET });
    expect(itemOrder('TheFullMonty', 'Masterbaiter', 'Air rune', 10, 'rs-sdk-demo.fly.dev', 1_000_000).id).not.toBe(o.id);
    expect(meetingTiles({ x: 2619, z: 3332 })).toEqual(ARMY_MEET);
});

test('a same-side owned supply order can start immediately without the remote sync lead', () => {
    const now=1_000_000;
    const o=itemOrder('Near','Needy','Mind rune',20,'rs-sdk-demo.fly.dev',now,0);
    expect(o.start).toBe(now);
    expect(o.end).toBe(now+40*60_000);
    expect(validOrder(o)).toBe(true);
});

test('a local funding order starts immediately while the default remote funding lead remains intact',()=>{
    const now=1_000_000;
    const remote=coinOrder('FarCash','Maker',120,'rs-sdk-demo.fly.dev',now);
    expect(remote.start).toBe(now+15*60_000);
    const local=coinOrder('NearCash','Maker',120,'rs-sdk-demo.fly.dev',now,ARMY_MEET,0);
    expect(local).toMatchObject({start:now,end:now+40*60_000,count:120,meet:ARMY_MEET});
    expect(validOrder(local)).toBe(true);
    for(const lead of [-1,15*60_000+1,0.5,NaN])expect(()=>coinOrder('NearCash','Maker',120,'rs-sdk-demo.fly.dev',now,undefined,lead)).toThrow('invalid coin order lead');
});

test('a kit send becomes an item order and a vacant account; a party to an open order waits', () => {
    const band = catalogue().find(t => t.id === 'army-strike-magic-21')!;
    const out = [{ account: 'Needy', template: band, value: 0, reason: 'army band', resources: [], send: { from: 'Near', to: 'Needy', item: 'mind rune', count: 20, template: band.id } }];
    const order = (s: { from: string; to: string; item: string; count: number }) => itemOrder(s.from, s.to, 'Mind rune', s.count, 'rs-sdk-demo.fly.dev', 0);
    const placed = fundOrders(out, new Set(), () => { throw Error('no coin order'); }, order);
    expect(placed.orders.map(o => [o.from, o.to, o.item, o.count])).toEqual([['Near', 'Needy', 'Mind rune', 20]]);
    expect(placed.assignments).toEqual([{ account: 'Needy', value: 0, resources: [], reason: 'vacant: awaits 20 mind rune from Near for army-strike-magic-21' }]);
    expect(placed.log).toEqual(['AUTOPILOT send Needy 20 mind rune from Near for army-strike-magic-21']);
    const waiting = fundOrders(out, new Set(['near']), () => { throw Error('no coin order'); }, order);
    expect(waiting.orders).toEqual([]);
    expect(waiting.log).toEqual(['AUTOPILOT send Needy 20 mind rune from Near for army-strike-magic-21: waits for an open order']);
});

test('another side gives only from accounts its fresh plan leaves free and no open order holds', () => {
    const server = 'rs-sdk-demo.fly.dev';
    const snapshot = { accounts: [
        { name: 'Free', inventory: [{ name: 'Mind rune', count: 374 }], bank: [{ name: 'Coins', count: 4_000_000 }] },
        { name: 'Working', bank: [{ name: 'Mind rune', count: 335 }] }, { name: 'Trading', bank: [{ name: 'Mind rune', count: 50 }] }, { name: 'Haggis', bank: [] }].map(row => ({ ...row, server, at:1_000_000,bankAt:1_000_000 })) };
    const context = { server, owners: new Map(snapshot.accounts.map(row => [row.name.toLowerCase(), { side: 'claude-cloud', server }])) };
    const plan = { at: 1_000_000, jobs: [{ account: 'Working', enabled: true }, { account: 'Free', enabled: false }] };
    const stock = (at: number) => sideStock('claude-cloud', snapshot, { ...plan, at }, new Set(['trading']), 1_000_000 + 60_000, 30 * 60_000, () => undefined, context);
    expect(stock(1_000_000)).toEqual([{ name: 'Free', side: 'claude-cloud', items: { 'mind rune': 374, coin: 4_000_000 } }]);
    // A side with no fresh plan has no running fleet agent to trade.
    expect(stock(1_000_000 - 31 * 60_000)).toEqual([]);
    expect(sideStock('claude-cloud', snapshot, null, new Set(), 0, 1, () => undefined, context)).toEqual([]);
    expect(stock(1_000_000 + 60_001)).toEqual([]);
});

test('published owner pauses and death holds keep remote kit orders on an available live donor', () => {
    const server = 'rs-sdk-demo.fly.dev', remote = 'local', now = 1_000_000;
    const row = (name: string, count: number) => ({ name, server, at:now,bankAt:now,inventory: [{ name: 'Mind rune', count }], bank: [] });
    const rows = [row('Paused', 1000), row('Dead', 900), row('Free', 100)];
    const owners = new Map<string, { side: string; server: string }>([...rows.map(r => [r.name.toLowerCase(), { side: remote, server }] as const), ['needy', { side, server }] as const]);
    const card = sideCard(remote, 5, rows.map(r => r.name), n => n === 'Paused' ? 'owner pause' : undefined, ['Dead']);
    const stockFor = (card?: unknown) => sideStock(remote, { accounts: rows }, { at: now, jobs: [] }, new Set(), now, 30 * 60_000, () => undefined, { owners, server, card });
    const recipient: Acct = { name: 'Needy', side, skills: { Hitpoints: 20, Magic: 1 }, items: {} };
    const band = { ...catalogue().find(t => t.id === 'army-strike-magic-21')!, needs: { items: { 'mind rune': 20 } }, resources: [] };
    const [assignment] = plan({ ...inputs(recipient), owners, templates: [band], army: new Set(['needy']), stock: stockFor(card), market: {} });
    expect(assignment!.send?.from).toBe('Free');
    const funded = fundOrders([assignment!], new Set(), () => { throw Error('unexpected coin order'); }, send => itemOrder(send.from, send.to, send.item, send.count, server, now));
    expect(funded.orders).toHaveLength(1); expect(funded.orders[0]).toMatchObject({ from: 'Free', to: 'Needy', server });
    expect(stockFor(card).map(s => s.name)).toEqual(['Free']);
    expect(stockFor({ ...card, paused: ['PAUSED'], died: ['DEAD'] }).map(s => s.name)).toEqual(['Free']);
    expect(stockFor({ ...card, stopped: true })).toEqual([]);
    expect(stockFor().map(s => s.name)).toEqual(['Paused', 'Dead', 'Free']);
    expect(stockFor({ ...card, side: 'another-side', stopped: true }).map(s => s.name)).toEqual(['Paused', 'Dead', 'Free']);
});

test('remote donor observations must belong to the registered live server and current side', () => {
    const server = 'rs-sdk-demo.fly.dev', remote = 'local', now = 1_000_000;
    const row = (name: string) => ({ name, server, at:now,bankAt:now,inventory: [{ name: 'Mind rune', count: 100 }], bank: [] });
    const rows = [row('Live'), { ...row('Practice'), practice: true }, { ...row('WrongServer'), server: 'localhost:8888' },
        row('WrongOwner'), row('Moved'), row('Unregistered'), { ...row('UndatedServer'), server: undefined }];
    const owners = new Map(rows.filter(r => r.name !== 'Unregistered').map(r => [r.name.toLowerCase(), {
        side: r.name === 'Moved' ? side : remote, server: r.name === 'WrongOwner' ? 'localhost:8888' : server,
    }]));
    const stock = sideStock(remote, { accounts: rows }, { at: now, jobs: [] }, new Set(), now, 30 * 60_000, () => undefined, { owners, server });
    expect(stock.map(s => s.name)).toEqual(['Live']);
});

test('a fresh side plan cannot refresh stale donor bank stock or count worn kit as spare', () => {
    const server='rs-sdk-demo.fly.dev',remote='local',now=4_000_000;
    const row=(name:string,bankAt:number)=>({name,server,at:now,bankAt,inventory:[{id:558,name:'Mind rune',count:10}],
        bank:[{id:558,name:'Mind rune',count:30}],equipment:[{id:1387,name:'Staff of fire',count:1}]});
    const rows=[row('Fresh',now-1000),row('Stale',now-31*60_000),row('Future',now+1)];
    const owners=new Map(rows.map(r=>[r.name.toLowerCase(),{side:remote,server}]));
    const stock=sideStock(remote,{accounts:rows},{at:now,jobs:[]},new Set(),now,30*60_000,()=>undefined,{owners,server});
    expect(stock.find(s=>s.name==='Fresh')?.items).toEqual({'mind rune':30});
    expect(stock.find(s=>s.name==='Stale')?.items).toEqual({'mind rune':10});
    expect(stock.find(s=>s.name==='Future')?.items).toEqual({'mind rune':10});
});

import { failedSends, JOB_START_GRACE_MS, kitBuyRunning, neverStarted, SEND_RETRY_MS } from './autopilot';
test('a failed item order stops new orders for that pair for a day; coin orders and old orders do not', () => {
    const order = (id: string, item: string, start: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from: 'Near', to: 'Needy', item, count: 20, start, end: start + 40 * 60_000 });
    const now = 10 * 3600_000;
    // Past its window with one receipt that is not terminal, an order needs reconciliation.
    const receipt = (id: string) => ({ id, account: 'Needy', role: 'to', side: 'local', ok: false, count: 0, at: now - 3000_000, detail: 'Error: no route', version: 2, state: 'failed', server: 'rs-sdk-demo.fly.dev', partner: 'Near', item: 'Mind rune', requested: 20, claim: 'x' });
    expect([...failedSends([order('a', 'Mind rune', now - 3600_000)], [receipt('a')] as any, now)]).toEqual(['near>needy']);
    expect(failedSends([order('a', 'coins', now - 3600_000)], [receipt('a')] as any, now).size).toBe(0);
    expect(failedSends([order('a', 'Mind rune', now - SEND_RETRY_MS - 1)], [receipt('a')] as any, now).size).toBe(0);
    // An order still inside its window with no receipt is pending, not failed.
    expect(failedSends([order('b', 'Mind rune', now - 60_000)], [], now).size).toBe(0);
});

import { silentSides } from './autopilot';
test('a side whose latest closed order its giver never answered gives no kit until it answers one', () => {
    const now = 10 * 3600_000, sideOf = (n: string) => ({ far: 'local', far2: 'local', near: 'cloud' } as Record<string, string>)[n.toLowerCase()];
    const order = (id: string, from: string, end: number) => ({ id, server: 's', from, to: 'Needy', item: 'Bones', count: 37, start: end - 40 * 60_000, end });
    const gave = (id: string) => ({ id, role: 'from', account: 'Far', side: 'local', ok: false, count: 0, at: now, detail: '' });
    const took = (id: string) => ({ ...gave(id), role: 'to', account: 'Needy', side: 'cloud' });
    // The taker's receipt alone does not answer for the giver.
    expect([...silentSides([order('a', 'Far', now - 1000)], [took('a')] as any, sideOf, now)]).toEqual(['local']);
    expect(silentSides([order('a', 'Far', now - 1000)], [gave('a')] as any, sideOf, now).size).toBe(0);
    // The latest closed order decides: an answered one after a silent one brings the side back, and the reverse.
    expect(silentSides([order('a', 'Far', now - 5000), order('b', 'Far2', now - 1000)], [gave('b')] as any, sideOf, now).size).toBe(0);
    expect([...silentSides([order('a', 'Far', now - 5000), order('b', 'Far2', now - 1000)], [gave('a')] as any, sideOf, now)]).toEqual(['local']);
    // An order still in its window, one older than the retry window and an account of no listed side say nothing.
    expect(silentSides([order('a', 'Far', now + 1000)], [], sideOf, now).size).toBe(0);
    expect(silentSides([order('a', 'Far', now - SEND_RETRY_MS - 1)], [], sideOf, now).size).toBe(0);
    expect(silentSides([order('a', 'Stranger', now - 1000)], [], sideOf, now).size).toBe(0);
    // Each side by its own orders.
    expect([...silentSides([order('a', 'Far', now - 1000), order('b', 'Near', now - 1000)], [gave('b')] as any, sideOf, now)]).toEqual(['local']);
});

test('a kit buy with no RESULT yet is running and stays as it is', () => {
    const job = { enabled: true, template: 'kit-buy:army-strike-magic-21' }, assigned = { template: job.template, offset: 0 };
    expect(kitBuyRunning(job, assigned, () => ['SUPERVISE start', 'LEDGER ticks=40 xp=0 move=30 idle=10'])).toBe(true);
    expect(kitBuyRunning(job, assigned, () => ['  | RESULT ok {"ok":true,"died":false}'])).toBe(false);
    expect(kitBuyRunning(job, assigned, () => ['RESULT fail login: Error: fleet account claim held by swarm'])).toBe(false);
    expect(kitBuyRunning({ ...job, enabled: false }, assigned, () => [])).toBe(false);
    expect(kitBuyRunning({ enabled: true, template: 'goldfarm@2652,3318' }, { template: 'goldfarm@2652,3318', offset: 0 }, () => [])).toBe(false);
    expect(kitBuyRunning(job, { template: 'army-strike-magic-21', offset: 0 }, () => [])).toBe(false);
});

import { unfilledItems } from './autopilot';
test('a kit buy that got none of an item names that item; a filled or broken buy names none', () => {
    const none = '  | RESULT fail {"ok":false,"phase":"settled","quantity":20,"targetMet":false,"acquired":0,"refund":2400,"spent":0,"offerId":157266,"progress":{"actor":"Wandwaver","offerId":157266,"itemId":558,"side":"buy","quantity":20,"limit":120,"filled":0},"failure":"exact order short: acquired 0/20"}';
    const filled = '  | RESULT ok {"ok":true,"phase":"settled","quantity":50,"targetMet":true,"acquired":50,"progress":{"actor":"Mightyrod","itemId":561,"side":"buy","quantity":50,"limit":800,"filled":50,"gross":12500}}';
    expect(unfilledItems([filled, none, none.replace('"itemId":558', '"itemId":314')])).toEqual([558, 314]);
    expect(unfilledItems([filled])).toEqual([]);
    // A part fill and a failure with no offer are not an empty market.
    expect(unfilledItems([none.replace('"acquired":0', '"acquired":7')])).toEqual([]);
    expect(unfilledItems(['RESULT fail walk-to {"ok":false,"reason":"timeout"}', 'RESULT fail chain rounds=1 ok=1 failed=1'])).toEqual([]);
});

test('each AIO template dispatches to the worker it names, and its route has a bench case that can pass', () => {
    const cases = new Map(benchCases().map(c => [c.key, c]));
    for (const t of aioTemplates()) {
        const step = resolveAioStep(t.args![0]!, t.args!.slice(1));
        expect(`${t.id} ${step.script}`).toBe(`${t.id} ${t.worker}`);
        expect(existsSync(resolve(import.meta.dir, '..', t.worker!))).toBe(true);
        expect(`${t.id} ${cases.has(t.aio!)}`).toBe(`${t.id} true`);
        expect(cases.get(t.aio!)!.known).toBeUndefined();
    }
    // The quest the sweep template names has its own bench case.
    expect(cases.has('quester:quest:runemysteries')).toBe(true);
    expect(resolveAioStep('quester', ['sweep', 'runemysteries'])).toEqual({ script: 'scripts/quest-sweep.ts', args: ['runemysteries'], env: {} });
    expect(resolveAioStep('skiller', ['fletching', 'shafts', '600', 'MAX_MAKE=25', 'LOG_RESERVE=0']).env).toEqual({ MODE: 'shafts', MAX_MAKE: '25', LOG_RESERVE: '0' });
});

test('the Rune Mysteries template needs the pack the sweep takes: the preset runes and its meals', () => {
    const items: { id: number; name: string; debugname?: string }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const t = aioTemplates().find(t => t.id === 'aio-quest-runemysteries')!, pack: Record<string, number> = {};
    let meals = 0;
    for (const i of presetFor('runemysteries').inventory ?? []) { if (MEALS.includes(i.id)) meals += i.count; else pack[name(i.id)] = (pack[name(i.id)] ?? 0) + i.count; }
    expect(Object.fromEntries(Object.entries(t.needs!.items!).map(([i, n]) => [norm(i), n]))).toEqual(pack);
    expect(t.needs!.pieces!.count).toBe(meals);
    expect([...SWEEP_MEALS].map(norm).sort()).toEqual(MEALS.map(name).sort());
});

test('a maker of a short bill line has the value of that line for an account that meets its needs, and none for another', () => {
    // Prices as scripts/autopilot.ts builds them: the shop value of each item, by norm() name.
    const items: { name?: string; debugname?: string; cost?: number }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const prices: Record<string, number> = {};
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    // The line names of the saved Overall bill.
    const line = (item: string, short: number) => ({ item, need: short, owned: 0, short, ids: [], holders: [] });
    const bill = [line('cannonball', 1700), line('blood rune', 624), line('adamantite bar', 345), line('mithril bar', 280), line('iron bar', 2)];
    const makers: Record<string, { item: string; perTick: number; meets: Acct; lacks: Acct }> = {
        'aio-cannonballs': { item: 'cannonball', perTick: 0.2, meets: { name: 'A', side, skills: { Smithing: 35 }, items: { 'ammo mould': 1, 'steel bar': CANNON_BARS } },
            lacks: { name: 'A', side, skills: { Smithing: 35 }, items: { 'steel bar': CANNON_BARS } } },
        'aio-blood-chest': { item: 'blood rune', perTick: 0.01, meets: { name: 'A', side, skills: { Thieving: 59 }, items: { lobster: BLOOD_MEALS } },
            lacks: { name: 'A', side, skills: { Thieving: 58 }, items: { lobster: BLOOD_MEALS } } },
        'aio-adamantite-bars': { item: 'adamantite bar', perTick: 0.07, meets: { name: 'A', side, skills: { Smithing: 70 }, items: { 'adamantite ore': 4, coal: 24 } },
            lacks: { name: 'A', side, skills: { Smithing: 70 }, items: { 'adamantite ore': 4, coal: 5 } } },
        'aio-mithril-bars': { item: 'mithril bar', perTick: 0.08, meets: { name: 'A', side, skills: { Smithing: 50 }, items: { 'mithril ore': 5, coal: 20 } },
            lacks: { name: 'A', side, skills: { Smithing: 49 }, items: { 'mithril ore': 5, coal: 20 } } },
        'aio-iron-bars': { item: 'iron bar', perTick: 0.074, meets: { name: 'A', side, skills: { Smithing: 15 }, items: { 'iron ore': 28 } },
            lacks: { name: 'A', side, skills: { Smithing: 15 }, items: { 'iron ore': 0 } } },
    };
    for (const [id, m] of Object.entries(makers)) {
        const run = (a: Acct, rows = bill) => plan({ ...inputs({...a,items:{...a.items,
            coin:rows.reduce((n,r)=>n+r.short*(prices[norm(r.item)]??0),0)}}), templates: aioTemplates(), bill: rows, prices, pilots: new Set([id]) })[0]!;
        const price = prices[norm(m.item)]!;
        expect(`${id} ${price > 0}`).toBe(`${id} true`);
        expect(`${id} ${run(m.meets).template?.id}`).toBe(`${id} ${id}`);
        // Only needed units in the 1,000-tick planning window count, at twice the shop value.
        const short = bill.find(r => norm(r.item) === norm(m.item))!.short;
        expect(run(m.meets).value).toBeCloseTo(Math.min(m.perTick, short / 1000) * price * 2);
        expect(run(m.meets, bill.map(r => ({ ...r, short: 0 }))).value).toBe(0);
        expect(run(m.meets, bill.map(r => ({ ...r, short: 0 }))).template).toBeUndefined();
        expect(run(m.lacks)).toMatchObject({ value: 0 });
        expect(run(m.lacks).template).toBeUndefined();
    }
    for(const [id,a,units,ingredients]of [
        ['aio-adamantite-bars',{name:'A',side,skills:{Smithing:70},items:{'adamantite ore':4,coal:23}},3,{'adamantite ore':3,coal:18}],
        ['aio-iron-bars',{name:'A',side,skills:{Smithing:15},items:{'iron ore':27}},2,{'iron ore':2}],
    ]as const){
        const [partial]=plan({...inputs(a),templates:aioTemplates(),bill,prices,pilots:new Set([id])});
        expect(partial!.template!.id).toBe(id);expect(partial!.template!.args).toContain(`MAX_MAKE=${units}`);
        expect(partial!.template!.needs!.items).toEqual(ingredients);
    }
    expect([...BLOOD_FOOD].map(norm).sort()).toEqual(BANK_FOOD.map(norm).sort());
});

test('the steel bar template has the value of a short line only while the bill is short of cannonballs', () => {
    const items: { name?: string; debugname?: string; cost?: number }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const prices: Record<string, number> = {};
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    const line = (item: string, short: number) => ({ item, need: 1700, owned: 1700 - short, short, ids: [], holders: [] });
    const id = 'aio-steel-bars', t = aioTemplates().find(t => t.id === id)!;
    const smith = (level: number, ore: number, coal: number): Acct => ({ name: 'A', side, skills: { Smithing: level }, items: { 'iron ore': ore, coal } });
    const run = (a: Acct, bill: Inputs['bill']) => plan({ ...inputs(a), templates: aioTemplates(), bill, prices, pilots: new Set([id]) })[0]!;
    // The worker's own table: the level and the two ingredients of the bar, and one pack load of them in `needs`.
    const recipe = smeltRecipe('steel'), units = (item: number) => recipe.ingredients.find(i => i.id === item)!.units;
    const load = Math.floor(28 / (units(440) + units(453)));
    expect(t.needs).toEqual({ skills: { Smithing: recipe.level }, items: { 'iron ore': load * units(440), coal: load * units(453) } });
    const [made] = t.yields(smith(30, 9, 18));
    expect(made!.item).toBe('steel bar');
    const price = prices['steel bar']!;
    expect(price > 0).toBe(true);
    // No bill line names the bar. Short of cannonballs: twice the shop value of the bar.
    expect(run(smith(30, 9, 18), [line('cannonball', 1700)]).template?.id).toBe(id);
    expect(run(smith(30, 9, 18), [line('cannonball', 1700)]).value).toBeCloseTo(made!.perTick * price * 2);
    // A met cannonball line, an unrelated shortage, or no bill gives this bar no consumer.
    for (const bill of [[line('cannonball', 0)], [line('cannonball', 0), line('iron bar', 2), line('mithril bar', 280)], []]) {
        expect(run(smith(30, 9, 18), bill).value).toBe(0);
        expect(run(smith(30, 9, 18), bill).template).toBeUndefined();
    }
    // An account below the level or without one complete recipe gets no production job.
    for (const a of [smith(29, 9, 18), smith(30, 0, 18), smith(30, 9, 1)]) {
        expect(run(a, [line('cannonball', 1700)])).toMatchObject({ value: 0 });
        expect(run(a, [line('cannonball', 1700)]).template).toBeUndefined();
    }
    for(const a of [smith(30,8,18),smith(30,9,17)]){
        const partial=run(a,[line('cannonball',1700)]);
        expect(partial.template!.args).toContain('MAX_MAKE=8');
        expect(partial.template!.needs!.items).toEqual({'iron ore':8,coal:16});
    }
});

test('the makers of the unfinished potion, dust, ring and axe lines ask what their worker recipes ask, and get the price of their bill line', () => {
    const items: { id: number; name: string; debugname?: string; cost?: number }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const all = new Map(aioTemplates().map(t => [t.id, t])), recipes = inventoryRecipes();
    const recipeOf = (id: string) => { const env = resolveAioStep('skiller', all.get(id)!.args!.slice(1)); return { step: env, recipe: recipes.find(r => r.name === env.args[0])! }; };
    // The bill as scripts/autopilot.ts builds it: one line for each potion, with the item ids idsFor matches.
    const lines = [...UNF_POTIONS.map(([herb]) => `${herb} potion (unf)`), 'unicorn horn dust', 'dragon scale dust', 'mort myre fungus'];
    const bill = supplyBill(lines.map(item => ({ item, count: 5 })), items, []), prices = priceTable(items, bill);
    expect(bill.every(r => r.short === 5 && r.ids.length === 1)).toBe(true);
    for (const [herb, item, level] of UNF_POTIONS) {
        const id = `aio-unf-${herb.replace(' ', '-')}`, t = all.get(id)!, line = `${herb} potion (unf)`, { step, recipe } = recipeOf(id);
        expect(`${id} ${step.script} ${recipe?.name}`).toBe(`${id} scripts/microbot-production.ts brew:unf_${herb.replace(' ', '_')}_potion`);
        expect(step.env).toEqual({ MAX_MAKE: String(MAKE_BATCH), CAP: '1500', MEMBERS: '1', ORDER_MODE: 'best-effort' });
        expect(`${id} ${recipe.level}`).toBe(`${id} ${level}`);
        expect(t.needs).toEqual({ skills: { Herblore: recipe.level }, items: { [item]: 1, 'vial of water': 1 } });
        expect(recipe.inputs.map(i => name(i.id)).sort()).toEqual(Object.keys(t.needs!.items!).map(norm).sort());
        // The product is the item of the bill line, and the line has its price.
        expect(bill.find(r => r.item === line)!.ids).toEqual([recipe.product]);
        expect(t.yields({ name: 'A', side, skills: {}, items: {} })).toEqual([{ item: line, perTick: 0.1 }]);
        const price = items.find(i => i.id === recipe.product)!.cost!;
        expect(`${id} ${price > 0} ${prices[norm(line)]}`).toBe(`${id} true ${price}`);
        const brewer: Acct = { name: 'A', side, skills: { Herblore: level }, items: { [norm(item)]: 1, 'vial of water': 1 } };
        const short = bill.find(r => r.item === line)!.short;
        expect(plan({ ...inputs(brewer), templates: aioTemplates(), bill, prices, pilots: new Set([id]) })[0]!.value).toBeCloseTo(short / 1000 * price * 2);
    }
    expect(prices[norm('mort myre fungus')]).toBe(items.find(i => i.name === 'Mort myre fungi')!.cost!);
    for (const [id, raw, dust] of [['aio-unicorn-horn-dust', 'unicorn horn', 'unicorn horn dust'], ['aio-dragon-scale-dust', 'blue dragon scale', 'dragon scale dust']] as const) {
        const { recipe } = recipeOf(id), t = all.get(id)!;
        expect(`${id} ${recipe?.name}`).toBe(`${id} grind:${raw.replace(/ /g, '_')}`);
        expect([...recipe.inputs.map(i => name(i.id)), ...recipe.tools.map(name)].sort()).toEqual(Object.keys(t.needs!.items!).map(norm).sort());
        expect(name(recipe.product)).toBe(norm(dust));
        expect(recipe.level).toBe(1);
        expect(t.needs!.skills).toBeUndefined();
    }
    // The ring order of each template is one the trip worker accepts, and `needs` holds its whole batch.
    for (const [gem, level] of GEM_RINGS) {
        const id = `aio-${gem}-rings`, t = all.get(id)!, step = resolveAioStep('skiller', t.args!.slice(1));
        expect(`${id} ${step.script} ${step.args.length}`).toBe(`${id} scripts/microbot-jewellery-trip.ts 0`);
        const order = jewelleryOrderFromEnv(step.env), recipe = validateJewelleryOrder(order);
        expect(order).toMatchObject({ recipe: `${gem}_ring`, target: RING_BATCH, batch: RING_BATCH, members: false, stringAmulet: false });
        expect(`${id} ${recipe.level}`).toBe(`${id} ${level}`);
        expect(t.needs).toEqual({ skills: { Crafting: level }, items: { ...Object.fromEntries(recipe.tools.map(tool => [name(tool), 1])), ...Object.fromEntries(recipe.inputs.map(i => [name(i.id), RING_BATCH])) } });
        expect(name(recipe.product)).toBe(`${gem} ring`);
        // One trip: the mould and the batch of bars and gems fit in the pack.
        expect(1 + recipe.inputs.length * RING_BATCH <= 28).toBe(true);
        const stock = Object.fromEntries([...recipe.tools.map(tool => [tool, 1]), ...recipe.inputs.map(i => [i.id, RING_BATCH])]);
        expect(planJewelleryOrder(order, stock, level).stages.map(s => `${s.family} ${s.recipe} ${s.target}`)).toEqual([`jewellery ${gem}_ring ${RING_BATCH}`]);
    }
    const axe = all.get('aio-rune-axe')!, smith = smithRecipe(Number(resolveAioStep('skiller', axe.args!.slice(1)).env.PRODUCT_ID));
    expect(name(smith.product)).toBe('rune axe');
    expect(axe.needs).toEqual({ skills: { Smithing: smith.level }, items: { hammer: 1, [name(smith.bar)]: smith.bars, coins: 10 }, holdsUnder: { 'rune axe': 1 } });
    expect(axe.repeats).toBe(false);
});

test('each step of a two-recipe maker dispatches to the bank-standing worker with a recipe it knows, at the level the template asks', () => {
    const items: { id: number; name: string; debugname?: string }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const cases = new Map(benchCases().map(c => [c.key, c])), recipes = inventoryRecipes();
    expect(cases.get('skiller:crafting:inventory')?.known).toBeUndefined();
    for (const t of makerChains()) {
        const steps = t.args!.map(parseStep).map(s => { expect(s.script).toBe('scripts/aio.ts'); return { env: s.env, step: resolveAioStep(s.args[0]!, s.args.slice(1)) }; });
        const used = steps.map(({ step, env }) => {
            expect(`${t.id} ${step.script}`).toBe(`${t.id} ${t.worker}`);
            expect(env).toMatchObject({ MEMBERS: '1', ORDER_MODE: 'best-effort' });
            const recipe = recipes.find(r => r.name === step.args[0]);
            expect(`${t.id} ${step.args[0]} ${!!recipe}`).toBe(`${t.id} ${step.args[0]} true`);
            return recipe!;
        });
        // The second recipe takes the product of the first, and the template asks the level of both and every other input.
        expect(used[1]!.inputs.some(i => i.id === used[0]!.product)).toBe(true);
        expect(Object.values(t.needs!.skills!)).toEqual([Math.max(...used.map(r => r.level))]);
        expect(Object.keys(t.needs!.skills!)).toEqual([...new Set(used.map(r => r.skill))]);
        const asked = used.flatMap(r => [...r.inputs.map(i => i.id), ...r.tools]).filter(id => id !== used[0]!.product).map(name).sort();
        expect(Object.keys(t.needs!.items!).map(norm).sort()).toEqual(asked);
        expect(name(used[1]!.product)).toBe(norm(t.yields({ name: 'A', side, skills: {}, items: {} })[0]!.item));
    }
});

test('the rune arrow run names a line of the Ranging Guild profile, and its spend covers a top-up off a full shelf', () => {
    const t = catalogue().find(t => t.id === 'shop-rune-arrows')!;
    expect(t.pilot).toBe(true);
    expect(selectItems(PROFILES[t.args![0]!]!.items, t.env!.ITEMS).map(i => i.re.source)).toEqual(['^rune arrow$']);
    // ranging.inv: 400 in stock at a base cost of 400; ranging.npc: sell multiplier 1000 and shop_delta 10.
    const content = resolve(import.meta.dir, '../vendor/rs-sdk/server/content/scripts/minigames/game_ranging/configs');
    expect(readFileSync(resolve(content, 'ranging.inv'), 'utf8')).toMatch(/^stock13=rune_arrow,400,130\r?$/m);
    expect(readFileSync(resolve(content, 'ranging.npc'), 'utf8')).toMatch(/param=owned_shop,ranging_guild_bowshop\r?\nparam=shop_sell_multiplier,1000\r?\nparam=shop_buy_multiplier,500\r?\nparam=shop_delta,10\r?\n/);
    const base = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8')).find((i: { id: number }) => i.id === 892).cost;
    expect(base).toBe(400);
    expect(RUNE_ARROW_SPEND).toBe(RUNE_ARROW_COST + maximumUnitCost({ baseCost: base }, { sellMultiplier: 1000 }));
    expect(Number(t.env!.MAX_SPEND)).toBe(RUNE_ARROW_SPEND);
    expect(t.needs!.items!.coins! >= Number(t.env!.FLOAT)).toBe(true);
});

test('the aio list of the plan admits pilot templates by id; anything else admits none', () => {
    expect([...aioPilots({ aio: ['aio-flax', 7, 'aio-ore'] })]).toEqual(['aio-flax', 'aio-ore']);
    expect(aioPilots({}).size).toBe(0);
    expect(aioPilots({ aio: 'aio-flax' }).size).toBe(0);
});

import { handedAccounts } from './autopilot';
test('a kept job is handed work too, so the controller\'s stale stop file is cleared on a later pass', () => {
    // Live: the pass that assigned the job found the last run still ending and held the file; every later pass kept
    // the job, and the account stood 40 minutes with its job enabled and never started.
    const out = [{ account: 'Fresh', template: { id: 'a' } }, { account: 'Kept', template: { id: 'b' } }, { account: 'Vacant' }];
    expect([...handedAccounts(out, [{ from: 'Giver', to: 'Taker' }])].sort()).toEqual(['fresh', 'giver', 'kept', 'taker']);
    expect(handedAccounts(out, []).has('vacant')).toBe(false);
});


test('the plan names a PK build for an army account; an unknown kit trains nothing', async () => {
    const { buildCaps } = await import('./autopilot');
    const caps = buildCaps({ builds: { Tosser: 'dragon', Wrong: 'no-such-kit' } });
    expect(caps.get('tosser')).toMatchObject({ Attack: 60, Defence: 60, Prayer: 43, Strength: 99 });
    expect(caps.get('wrong')).toEqual({ Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1 });
    expect(buildCaps({}).size).toBe(0);
    expect(buildCaps({ builds: ['dragon'] }).size).toBe(0);
});

test('the plan gives a build account the levels it may have before its quest route', async () => {
    const { buildBefore } = await import('./autopilot');
    const before = buildBefore({ builds: { Tosser: 'tank-range', Caber: 'pure-pray', Wrong: 'no-such-kit' } });
    expect(before.get('tosser')).toMatchObject({ Attack: 68, Strength: 60, Defence: 99 });
    expect(before.get('caber')).toMatchObject({ Attack: 60, Defence: 1, Prayer: 43 });
    expect(before.has('wrong')).toBe(false);
    expect(buildBefore({}).size).toBe(0);
});

test('the plan gives a build account the quest route of its kit; a kit with no route gets none', async () => {
    const { buildQuests } = await import('./autopilot');
    const routes = buildQuests({ builds: { Tosser: 'pure-pray', Caber: 'baby-pure', Wrong: 'no-such-kit' } });
    expect(routes.get('tosser')).toEqual(['Lost City']);
    expect(routes.get('caber')).toEqual([]);
    expect(routes.get('wrong')).toEqual([]);
    expect(buildQuests({ builds: ['pure-pray'] }).size).toBe(0);
});

import { mountainWalk, offlinePlace, MOUNTAIN } from './autopilot';
import { runningAssignments } from './autopilot';

test('only a recent bound live assignment can keep its running goal through a stock dip',()=>{
 const job={account:'Worker',script:'scripts/train.ts',template:'army-magic',enabled:true};
 const live={name:'Worker',server:'rs-sdk-demo.fly.dev',at:99999,sessionAttemptId:'attempt',workEntry:'scripts/train.ts'};
 expect([...runningAssignments([job],()=>live,100000)]).toEqual(['worker']);
 for(const patch of [{practice:true},{server:'localhost:8888'},{at:100001},{at:1},{result:'RESULT ok'},{name:'Other'},{sessionAttemptId:null},{workEntry:'scripts/other.ts'}])
  expect(runningAssignments([job],()=>({...live,...patch}),100000).size).toBe(0);
 expect(runningAssignments([{...job,enabled:false}],()=>live,100000).size).toBe(0);
});
import { accountFrom, FERRY_FARE, KNIGHT_BANK, PLACES, TOLL, placeOf, wayCost } from '../packages/planner/src/autopilot';

test('autopilot plans from shared live skills when a newer local file belongs to practice or another account', () => {
    const server = 'rs-sdk-demo.fly.dev', owners = new Map([['worker', { side, server }]]);
    const published = { name: 'Worker', server, at: 100, bankAt: 50, bank: [], inventory: [],
        skills: [{ name: 'Thieving', level: 55 }, { name: 'Hitpoints', level: 20 }] };
    const files = [{ side, at: 1000, accounts: [published] }];
    for (const local of [
        { ...published, at: 200, server: 'localhost:8888', skills: [{ name: 'Thieving', level: 1 }] },
        { ...published, at: 200, practice: true, skills: [{ name: 'Thieving', level: 1 }] },
        { ...published, at: 200, name: 'Other', skills: [{ name: 'Thieving', level: 1 }] },
    ]) {
        const observed = observedAccount('worker', local, files, owners, side);
        expect(observed).toMatchObject({ name: 'Worker', at: 100, bankAt: 50, side });
        const [assignment] = plan(inputs(accountFrom('Worker', side, observed, () => undefined)));
        expect(assignment!.template!.id).toMatch(/^goldfarm@/);
    }
    const local = { ...published, at: 200, skills: [{ name: 'Thieving', level: 1 }, { name: 'Hitpoints', level: 20 }], result: 'ok' };
    const observed = observedAccount('Worker', local, files, owners, side);
    expect(observed).toMatchObject({ at: 200, result: 'ok' });
    expect(plan(inputs(accountFrom('Worker', side, observed, () => undefined)))[0]!.template!.id).toBe('thieving55');
    expect(observedAccount('Worker', local, [{ ...files[0], accounts: [{ ...published, at: 200 }] }], owners, side).result).toBe('ok');
});

test('autopilot retains same-side and adopted observations while obeying the owner and expected server', () => {
    const server = 'rs-sdk-demo.fly.dev', owners = new Map([['worker', { side, server }]]);
    const row = (at: number, level: number) => ({ name: 'Worker', server, at, bankAt: 50,
        bank: [{ id: 995, name: 'Coins', count: level }], inventory: [], skills: [{ name: 'Thieving', level }] });
    const adopted = { side: 'old-side', accounts: [row(300, 99)] }, owned = { side, at: 900, accounts: [row(100, 55)] };
    expect(observedAccount('Worker', null, [adopted, owned], owners, side)).toMatchObject({ side, at: 100, bankAt: 50 });
    expect(observedAccount('Worker', null, [adopted], owners, side)).toMatchObject({ side: 'old-side', at: 300, bankAt: 50 });
    expect(observedAccount('Worker', null, [{ ...owned, accounts: [{ ...row(900, 1), server: 'other-server' }] }, adopted], owners, side))
        .toMatchObject({ side: 'old-side', at: 300 });
    expect(observedAccount('Unknown', row(400, 1), [adopted], owners, side)).toBeNull();
    expect(observedAccount('Worker', { ...row(400, 1), name: 'Other' }, [], owners, side)).toBeNull();
});
import { walkWithFerryFallback } from './walk-to';
import { loadHunters } from '../packages/core/src/danger';
import { loadTravel } from '../packages/core/src/travel';

// Status files as the live accounts wrote them: a thief east of the mountain with 1 coin, a rich thief with 10
// Hitpoints at Draynor, and a thief at the Ardougne south bank with no coins.
const levels = (skills: Record<string, number>) => Object.entries({ Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1, Hitpoints: 10, ...skills }).map(([name, level]) => ({ name, level }));
const statusAt = (name: string, pos: { x: number; z: number; level: number }, skills: Record<string, number>, coins: number, bank = 0) => ({
    name, server: 'rs-sdk-demo.fly.dev', at: 1_000, result: 'RESULT ok', pos, skills: levels(skills),
    inventory: coins ? [{ id: 995, name: 'Coins', count: coins }] : [], bank: bank ? [{ id: 995, name: 'Coins', count: bank }] : [], equipment: [],
});
const fromStatus = (s: ReturnType<typeof statusAt>) => offlinePlace(accountFrom(s.name, side, s, () => undefined), s, 60_000_000);
const featherBill = [{ item: 'feathers', need: 800, owned: 0, short: 800, ids: [314], holders: [] }];
const reach = (a: Acct, templates: string[], extra: Partial<Inputs> = {}) => plan({ ...inputs(a), templates: catalogue().filter(t => templates.includes(t.id)), prices: { flax: 5, feather: 2 },
    bill: featherBill, mountain: mountainWalk(), pilots: new Set(['aio-flax']), ...extra })[0]!;
const strongThief = { Thieving: 89, Hitpoints: 54, Attack: 40, Strength: 40, Defence: 30 };

test('a status file gives the account its place, and a live session gives none', () => {
    const s = statusAt('Abracadickra', { x: 2877, z: 3501, level: 0 }, strongThief, 1);
    expect(accountFrom('Abracadickra', side, s, () => undefined).pos).toEqual({ x: 2877, z: 3501, level: 0 });
    expect(accountFrom('Abracadickra', side, { ...s, pos: null }, () => undefined).pos).toBeUndefined();
    expect(accountFrom('Abracadickra', side, null, () => undefined).pos).toBeUndefined();
    // A session that is live now (a fresh row with no result) is on its way: its place does not count.
    const live = { ...s, result: undefined, at: 60_000_000 - 5_000 };
    expect(offlinePlace(accountFrom('Abracadickra', side, live, () => undefined), live, 60_000_000).pos).toBeUndefined();
    expect(fromStatus(s).pos).toEqual({ x: 2877, z: 3501, level: 0 });
});

test('the walker lets a strong account over White Wolf Mountain and refuses an account with 10 Hitpoints', () => {
    const walks = mountainWalk();
    const acct = (skills: Record<string, number>): Acct => ({ name: 'A', side, skills: { Hitpoints: 10, ...skills }, items: {} });
    expect(walks(acct({ Thieving: 99 }))).toBe(false);
    expect(walks(acct(strongThief))).toBe(true);
    // The rule is the walker's own: the wolves of the mountain are among the hunters it closes ground for.
    const onPass = loadHunters().filter(h => h.spawns.some(s => s.level === 0 && s.x >= MOUNTAIN.minX && s.x <= MOUNTAIN.maxX && s.z >= MOUNTAIN.minZ && s.z <= MOUNTAIN.maxZ)).map(h => h.name);
    expect(onPass).toContain('White wolf');
    // With no hunter on the pass every account walks it.
    expect(mountainWalk([])(acct({}))).toBe(true);
});

test('an account at Taverley with 1 coin gets a coin order for the ferry fare, then the knight spot', () => {
    const thief = fromStatus(statusAt('Abracadickra', { x: 2877, z: 3501, level: 0 }, strongThief, 1));
    const donors = [{ name: 'Billionaire', coins: 2_000_000 }];
    const out = reach(thief, ['goldfarm@2652,3318'], { donors, bill: coinBill });
    expect(out.fund).toEqual({ from: 'Billionaire', to: 'Abracadickra', coins: 59, template: 'goldfarm@2652,3318' });
    // The order is for 59 coins and names no meeting place: scripts/fleet-trade.ts then meets at Varrock West.
    const placed = fundOrders([out], new Set(), (from, to, coins, meet) => coinOrder(from, to, coins, 'rs-sdk-demo.fly.dev', 1_000, meet === 'ardougne' ? ARMY_MEET : undefined));
    expect(placed.orders).toEqual([{ id: '901000-billionaire-abracadickra', server: 'rs-sdk-demo.fly.dev', from: 'Billionaire', to: 'Abracadickra', item: 'coins', count: 59, start: 901_000, end: 901_000 + 40 * 60_000 }]);
    expect(placed.assignments[0]!.reason).toBe('vacant: awaits 59 coins from Billionaire for goldfarm@2652,3318');
    // The coins arrived: the next pass gives the spot with no order.
    const paid = fromStatus(statusAt('Abracadickra', { x: 3182, z: 3440, level: 0 }, strongThief, 60));
    expect(reach(paid, ['goldfarm@2652,3318'], { donors, bill: coinBill })).toMatchObject({ template: { id: 'goldfarm@2652,3318' }, reason: 'coins' });
    // With no donor it takes a job on its own side.
    expect(reach(thief, ['goldfarm@2652,3318', 'feathers@3017,3288'], { bill: [...coinBill, ...featherBill] }).template?.id).toBe('feathers@3017,3288');
});

test('an account with 10 Hitpoints east of the mountain is not offered the flax field at Seers', () => {
    const weak = fromStatus(statusAt('Billionaire', { x: 3087, z: 3250, level: 0 }, { Thieving: 99 }, 1_508, 2_195_386));
    const flaxBill = [{ item: 'flax', need: 1000, owned: 0, short: 1000, ids: [1779], holders: [] }];
    expect(reach(weak, ['aio-flax'], { bill: flaxBill }).template).toBeUndefined();
    expect(reach(weak, ['aio-flax', 'feathers@3017,3288'], { bill: [...flaxBill, ...featherBill] }).template?.id).toBe('feathers@3017,3288');
    // The strong thief is offered it: the walk over the mountain costs no fare.
    expect(reach(fromStatus(statusAt('Abracadickra', { x: 3092, z: 3242, level: 0 }, strongThief, 1)), ['aio-flax'], { bill: flaxBill }).template?.id).toBe('aio-flax');
});

test('an account at Ardougne with no coins needs no fare for a knight spot', () => {
    const there = fromStatus(statusAt('Hocuspokeus', { x: 2654, z: 3283, level: 0 }, strongThief, 0));
    const out = reach(there, ['goldfarm@2652,3318'], { donors: [{ name: 'Billionaire', coins: 2_000_000 }], bill: coinBill });
    expect(out).toMatchObject({ template: { id: 'goldfarm@2652,3318' }, reason: 'coins' });
    expect(out.fund).toBeUndefined();
});

test('a coin order for an account in Kandarin meets at the Ardougne north bank', () => {
    const west = fromStatus(statusAt('Hocuspokeus', { x: 2727, z: 3493, level: 0 }, {}, 0));
    const out = reach(west, ['feathers@3017,3288'], { donors: [{ name: 'Billionaire', coins: 2_000_000 }] });
    expect(out.fund).toEqual({ from: 'Billionaire', to: 'Hocuspokeus', coins: 60, template: 'feathers@3017,3288', meet: 'ardougne' });
    const placed = fundOrders([out], new Set(), (from, to, coins, meet) => coinOrder(from, to, coins, 'rs-sdk-demo.fly.dev', 1_000, meet === 'ardougne' ? ARMY_MEET : undefined));
    expect(placed.orders[0]).toMatchObject({ count: 60, meet: ARMY_MEET });
    expect(validOrder(placed.orders[0]!)).toBe(true);
});

test('the fare of the reach rule is the fare the shared walker asks for', async () => {
    // The walker asks `stageFare` for its need before the first plan. Each walk arrives, so no ferry sails here.
    const asked = async (from: { x: number; z: number; level: number }, to: { x: number; z: number; level: number }) => {
        let need = 0;
        await walkWithFerryFallback(from, to, async () => ({ ok: true, ticks: 1 }), async () => ({ ok: true, ticks: 1 }), () => 0, async n => { need = n; return { ok: true, ticks: 1 }; });
        return need;
    };
    const T = (x: number, z: number) => ({ x, z, level: 0 });
    const trips: [ReturnType<typeof T>, ReturnType<typeof T>][] = [
        [T(2877, 3501), T(2652, 3318)], [T(3092, 3242), T(2615, 3332)], [T(3269, 3164), T(2615, 3332)], [T(3222, 3218), T(2654, 3283)],
        [T(2727, 3493), T(3017, 3288)], [T(2654, 3283), T(3185, 3436)], [T(2525, 3242), T(3092, 3243)], [T(2809, 3441), T(3253, 3420)],
        [T(2877, 3501), T(3185, 3436)], [T(2809, 3441), T(2615, 3332)], [T(3092, 3242), T(2744, 3445)], [T(3092, 3242), T(2582, 3297)], [T(3092, 3242), T(2809, 3441)],
    ];
    for (const [from, to] of trips) expect([from, to, wayCost(from, to, true)]).toEqual([from, to, await asked(from, to)]);
    expect(wayCost(T(2877, 3501), T(2652, 3318), true)).toBe(60);
    expect(wayCost(T(3269, 3164), T(2615, 3332), true)).toBe(70);
    // The planner's constants are the fares of the two ferries and the toll in the travel table.
    const fare = (id: string) => loadTravel().find(t => t.id === id)!.coins;
    expect([fare('npc:captain_tobias:karamja-musa-point@3028,3216'), fare('npc:customs_officer:ardougne@2772,3225'), fare('npc:captain_barnaby:brimhaven@2679,3275'), fare('npc:customs_officer:port-sarim@2953,3147')])
        .toEqual([FERRY_FARE, FERRY_FARE, FERRY_FARE, FERRY_FARE]);
    expect(fare('npc:borderguard2:lumbridge-side-west-of-the-toll-gate@3268,3226')).toBe(TOLL);
});

test('the place of each shop job is the bank of its shop profile, and the reach rule covers each template with a place resource', () => {
    for (const [resource, spot] of Object.entries(PLACES)) if (resource.startsWith('shop:')) expect([resource, spot]).toEqual([resource, PROFILES[resource.slice(5)]!.bankSpot]);
    // The templates the reach rule covers, of the whole catalogue.
    // A template has a place when one of its resources is a knight spot, a chicken pen or a place of PLACES: the count follows the data.
    const hasPlace = (t: { resources?: string[] }) => (t.resources ?? []).some(r => r.startsWith('knight:') || /^pen:\d+,\d+$/.test(r) || r in PLACES);
    expect(catalogue().filter(t => placeOf(t)).map(t => t.id)).toEqual(catalogue().filter(hasPlace).map(t => t.id));
    // The knight job's first walk from far away is to the bank that the planner names for each knight spot.
    const goldfarm = readFileSync(resolve(import.meta.dir, 'goldfarm.ts'), 'utf8');
    expect(goldfarm).toContain(`walkTargetPersist(s, { x: ${KNIGHT_BANK.x}, z: ${KNIGHT_BANK.z}, level: 0 })`);
});

test('an account whose logout is not confirmed is stranded and gives nothing', async () => {
    const { strandedAccounts } = await import('./autopilot');
    const proofs: Record<string, string> = { mmtha0205: 'held', Masterbaiter: 'confirmed', Fresh: 'none' };
    const out = strandedAccounts(['mmtha0205', 'Masterbaiter', 'Fresh', 'Broken'], n => { if (n === 'Broken') throw Error('unreadable'); return proofs[n]!; });
    expect([...out]).toEqual(['mmtha0205']);
});

import { OFFLINE_GUARDED, isJobEnded, readSwarmActiveAccounts, readSwarmEnded, stoppedAccounts } from './autopilot';
import { ARMOUR_IDS, KIT_BUY } from '../packages/planner/src/autopilot';

test('the planner leaves out an account whose stopped end the swarm holds, as the swarm refuses its new mission', () => {
    const ended = new Map([['nab', { reason: 'stopped after 1 runs', revision: 'old' }], ['busy', { reason: 'stopped after 1 runs' }], ['fin', { reason: 'done after 1 runs', revision: 'old' }], ['ko', { reason: 'died: x' }]]);
    expect([...stoppedAccounts(ended, new Set(['busy']))]).toEqual(['nab']);
    // The swarm's own rule: a new mission starts after a done end, not after a stopped end.
    const swarmEnded = new Map([['nab', { reason: 'stopped after 1 runs', at: 1, revision: 'old' }], ['fin', { reason: 'done after 1 runs', at: 1, revision: 'old' }]]);
    const r = startable(['nab', 'fin'], false, swarmEnded, () => Infinity, undefined, 'new');
    expect(JSON.stringify(r)).toContain('ended: stopped after 1 runs');
    expect(JSON.stringify(r)).toContain('fin');
});

test('stoppedAccounts admits offline controller-stopped accounts whose status shows a retryable result while holding supply-exhausted or missing ends', () => {
    const ended = new Map([
        ['shaftsinker', { reason: 'stopped after 1 runs' }],
        ['magicwanda', { reason: 'stopped after 0 runs' }],
        ['backdoorman', { reason: 'stopped after 1 runs' }],
        ['missing', { reason: 'stopped after 1 runs' }],
        ['busy', { reason: 'stopped after 1 runs' }],
    ]);
    const results: Record<string, string> = {
        shaftsinker: 'ok fleet-trade 1795241358859-shaftsinker-woodenstaff',
        magicwanda: 'ok fleet-trade 1795288538530-magicwanda-ballspinner-air',
        backdoorman: 'fail no food (frail: 10 Hitpoints) ticks=5 picks=0 fail',
    };
    expect([...stoppedAccounts(ended, new Set(['busy']), a => results[a])]).toEqual(['backdoorman', 'missing']);
});

test('kitMarket pins exact green dragonhide item ids ahead of blue, red and black variants', () => {
    const table = kitMarket([
        { id: 2499, name: 'Dragonhide body', debugname: 'blue_dragonhide_body' },
        { id: 1135, name: 'Dragonhide body', debugname: 'dragonhide_body' },
        { id: 2493, name: 'Dragonhide chaps', debugname: 'blue_dragonhide_chaps' },
        { id: 1099, name: 'Dragonhide chaps', debugname: 'dragonhide_chaps' },
        { id: 2487, name: 'Dragon vambraces', debugname: 'blue_dragon_vambraces' },
        { id: 1065, name: 'Dragon vambraces', debugname: 'dragon_vambraces' },
    ]);
    expect(ARMOUR_IDS).toEqual({ 'dragonhide body': 1135, 'dragonhide chap': 1099, 'dragon vambrace': 1065 });
    expect(table['dragonhide body']?.id).toBe(1135);
    expect(table['dragonhide chap']?.id).toBe(1099);
    expect(table['dragon vambrace']?.id).toBe(1065);
});

test('kitBuyRunning releases exit-4, orphaned and died kit buys while keeping active or fresh buys and paused stop files', () => {
    const job = { account: 'SporranBulge', template: `${KIT_BUY}army-weapon`, enabled: true };
    const assigned = { template: `${KIT_BUY}army-weapon`, offset: 0, at: 1000 };
    expect(kitBuyRunning(job, assigned, () => [])).toBe(true);
    expect(kitBuyRunning(job, assigned, () => [], false, { active: true, ended: { at: 900, reason: 'exit 4' } })).toBe(true);
    expect(kitBuyRunning(job, assigned, () => [], false, { active: false, ended: { at: 900, reason: 'exit 4' } })).toBe(true);
    expect(kitBuyRunning(job, assigned, () => [], false, { active: false, ended: { at: 1100, reason: 'exit 4' } })).toBe(false);
    expect(kitBuyRunning(job, assigned, () => [], false, { active: false, ended: { at: 1100, reason: 'exit orphaned: attempt x gone' } })).toBe(false);
    expect(kitBuyRunning(job, assigned, () => [], false, { active: false, ended: { at: 1100, reason: 'died after 1 runs' } })).toBe(false);
    expect(isJobEnded(assigned, { active: false, ended: { at: 1200, reason: 'exit 4' } })).toBe(true);

    const stopMap = pauses(new Map([['Woodenstaff', 'owner pause']]));
    const pausedJob = { account: 'Woodenstaff', autopilot: 'local', script: 'scripts/goldfarm.ts', enabled: false };
    const owned = planningOwnership([pausedJob], [], stopMap.paused);
    expect(stopMap.paused.has('woodenstaff')).toBe(true);
    expect(owned.keep.has('woodenstaff')).toBe(true);
    expect(plannableAccounts([pausedJob], 'local', ['Woodenstaff'], owned.keep)).toEqual([]);
    expect(mergeJobs([pausedJob], 'local', [], owned.keep).jobs).toEqual([pausedJob]);

    const tmp = mkdtempSync(join(tmpdir(), 'autopilot-runs-'));
    try {
        const runsFile = join(tmp, 'swarm-runs.json'), deathsFile = join(tmp, 'swarm-deaths.json');
        writeFileSync(runsFile, JSON.stringify([{ accounts: ['CoinCock'] }, { account: 'Ballspinner' }]));
        writeFileSync(deathsFile, JSON.stringify({ SporranBulge: { at: 1200, reason: 'exit 4' }, Magicwanda: { at: 1300, reason: 'died after 1 runs' } }));
        expect([...readSwarmActiveAccounts(runsFile)]).toEqual(['coincock', 'ballspinner']);
        expect(readSwarmEnded(deathsFile).get('magicwanda')?.reason).toBe('died after 1 runs');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('OFFLINE_GUARDED excludes main and specialists from stock transfers and planner work', () => {
    expect([...OFFLINE_GUARDED].sort()).toEqual([...RESERVED_ACCOUNTS].sort());
    const owners = new Map([
        ['haggis', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['shaftshooter', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['polevaulter', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['freebee', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
    ]);
    const at = Date.now() - 1000;
    const row = (name: string) => ({ name, server: 'rs-sdk-demo.fly.dev', at, bankAt: at, inventory: [{ id: 995, count: 50000 }], bank: [], skills: [] });
    const stock = sideStock('local', { accounts: ['Haggis', 'Shaftshooter', 'Polevaulter', 'Freebee'].map(row) },
        { at, jobs: [] }, new Set(), Date.now(), 60_000, id => (id === 995 ? 'Coins' : undefined), { owners, server: 'rs-sdk-demo.fly.dev' });
    expect(stock.map(s => s.name)).toEqual(['Freebee']);
});

test('a preparation/acquire retirement stays retired: its own embedded RESULT is not a drain of the job', () => {
    const reason = '2 preparation/acquire RESULTs: RESULT fail no Ranged progress: {"ok":false,"stop":"preparation","failure":"progression requires acquire"}';
    expect(liveRetirements({ 'wandwaver:army-trooper-ranged-99': { reason, script: 'same' } }, () => 'same')).toEqual({
        retired: { 'wandwaver:army-trooper-ranged-99': { reason, script: 'same' } }, lapsed: [],
    });
});

test('only a bare exit code of 4 ends a job as a script error: exit 4294967295 is no such end', () => {
    const assigned = { at: 1000 };
    expect(isJobEnded(assigned, { active: false, ended: { at: 1200, reason: 'exit 4' } })).toBe(true);
    expect(isJobEnded(assigned, { active: false, ended: { at: 1200, reason: 'exit 4294967295' } })).toBe(false);
    expect(isJobEnded(assigned, { active: false, ended: { at: 1200, reason: 'exit 40' } })).toBe(false);
    expect(isJobEnded(assigned, { active: false, ended: { at: 1200, reason: 'exit unknown' } })).toBe(true);
    expect(isJobEnded(assigned, { active: false, ended: { at: 1200, reason: 'exit unknown x' } })).toBe(false);
});

test('an orphaned kit buy raises its order sequence once for each end record', () => {
    const state: Parameters<typeof raiseKitSeq>[0] = {};
    expect(raiseKitSeq(state, 'Bulge', 5000)).toBe(true);
    // A paused account keeps its job, so each pass reads the same end record again.
    expect(raiseKitSeq(state, 'Bulge', 5000)).toBe(false);
    expect(raiseKitSeq(state, 'bulge', 4000)).toBe(false);
    expect(state.kitSeq).toEqual({ bulge: 1 });
    expect(raiseKitSeq(state, 'Bulge', 9000)).toBe(true);
    expect(state.kitSeq).toEqual({ bulge: 2 });
});

test('a goal job prints its band, not a coin rate of zero', async () => {
    const { catalogue } = await import('../packages/planner/src/autopilot');
    const all = catalogue(), band = all.find(t => t.id === 'army-trooper-prayer-99')!;
    expect(jobRate({ template: band, value: 0 })).toBe(`band ${band.band}`);
    expect(jobRate({ template: all.find(t => t.id === 'shop-runes')!, value: 0.14 })).toBe('0.14/tick');
    expect(jobRate({ template: { ...band, tier: undefined, family: 'kit-buy' }, value: 0 })).toBe('kit buy');
});

test('every shop template of the catalogue selects at least one line of its profile with the real selectItems', () => {
    // selectItems tests ITEMS against the SOURCE of each profile line (an anchored line has the source ^name$), so an
    // anchored ITEMS value never matches it: the run throws "ITEMS matches no <profile> item" at once.
    const empty: string[] = [];
    for (const t of catalogue()) {
        const steps: { profile: string; items?: string }[] = [];
        if (t.script === 'scripts/shop-buyer.ts') steps.push({ profile: t.args?.[0] ?? '', items: t.env?.ITEMS });
        if (t.script === 'scripts/chain.ts') for (const a of t.args ?? []) { const m = a.match(/shop-buyer\.ts\s+(\S+)/); if (m) steps.push({ profile: m[1]!, items: a.match(/ITEMS=(\S+)/)?.[1] }); }
        for (const s of steps) if (PROFILES[s.profile] && s.items && selectItems(PROFILES[s.profile]!.items, s.items).length === 0) empty.push(`${t.id} ${s.profile} ITEMS=${s.items}`);
    }
    expect(empty).toEqual([]);
    expect(selectItems(PROFILES.ardy!.items, 'iron axe').map(i => i.re.source)).toEqual(['^iron axe$']);
});

test('the squad shop templates select their profile line with the real selectItems', () => {
    for (const t of catalogue().filter(x => x.squadOnly && x.family === 'shop-buyer')) {
        const lines = selectItems(PROFILES[t.args![0]!]!.items, t.env!.ITEMS).map(i => i.re.source);
        expect([t.id, lines.length]).toEqual([t.id, 1]);
    }
    // The water-rune craft reaches the runecraft worker at the water altar, and its resize keeps the altar.
    const craft = catalogue().find(t => t.id === 'squad-water-craft')!;
    expect(resolveAioStep('skiller', craft.args!.slice(1)).script).toBe('scripts/rune-bank-craft.ts');
    expect(craft.production!.resize(10).args).toContain('RUNE_ALTAR=water');
    expect(craft.production!.resize(10).args).toContain('ESSENCE_TARGET=10');
    // The talisman hunt reaches the combat worker at the wizards, and the iron tips reach the anvil worker.
    const hunt = catalogue().find(t => t.id === 'squad-water-talisman')!;
    expect(resolveAioStep('fighter', hunt.args!.slice(1)).script).toBe('scripts/gather-combat.ts');
    expect(hunt.args).toContain('UNTIL_ITEM=water talisman');
    expect(hunt.provides).toEqual({ item: 'water talisman', unlocks: ['squad-water-craft'] });
    // The rune arrows: the tip step buys 15 rune arrowtips a set at Catherby (a line of the real profile), and the fletch step
    // makes 15 rune arrows a set. The sharks: a finite order of the shark worker.
    const arrows = catalogue().find(t => t.id === 'squad-rune-arrows')!, [buy, fletch] = arrows.production!.resize(2).args!;
    expect(buy).toContain('scripts/shop-buyer.ts catherby 1200 ITEMS=rune.arrowtips STOCK_TARGET=30 ');
    expect(selectItems(PROFILES.catherby!.items, 'rune.arrowtips').map(i => i.re.source)).toEqual([/rune arrowtips/i.source]);
    expect(fletch).toContain('fletch-arrows.ts 3000 native-arrows rune MAX_MAKE=30 ');
    const sharks = catalogue().find(t => t.id === 'squad-sharks')!;
    expect([sharks.script, sharks.production!.resize(7).args]).toEqual(['scripts/shark-supply.ts', ['7', '9000']]);
    const potion = catalogue().find(t => t.id === 'squad-antipoison-jiminua')!;
    expect(selectItems(PROFILES.jiminua!.items, potion.env!.ITEMS).map(i => i.re.source)).toEqual([/^antipoison\(3\)$/i.source]);
});

test('squadInput holds a member that runs outside the swarm or has no observation, and reads maxCoins', () => {
    const owners = new Map([['a', { side: 'local', server: 's' }], ['b', { side: 'local', server: 's' }], ['c', { side: 'local', server: 's' }], ['d', { side: 'cloud', server: 's' }]]);
    const plan = { squad: { active: true, members: ['A', 'B', 'C', 'D'], hours: 4, maxCoins: 5000 } };
    const items = (n: string) => n === 'C' ? undefined : { shark: 1 };
    const got = squadInput(plan, 'local', owners as any, items, n => n === 'B');
    expect(got?.members.map(m => m.name)).toEqual(['A']);
    // Every member this side owns drives the hold-out, held or not; only the observed, free ones are restocked.
    expect(got?.all).toEqual(['A', 'B', 'C']);
    expect(got?.maxCoins).toBe(5000);
    expect(squadInput({ squad: { active: false, members: ['A'] } }, 'local', owners as any, items)).toBeUndefined();
    expect(squadInput({}, 'local', owners as any, items)).toBeUndefined();
});

const unplacedResult = (failure: string, extra = '') => `RESULT fail {"ok":false,"phase":"unplaced","pending":false,"quantity":16,"acquired":0${extra},"escrow":0,"refund":0,"spent":0,"ticks":3,"failure":"Error: ${failure}"}`;
const COINS_REFUSAL = 'coins 160940 are under the escrow 160000 (16 x 10000) plus the reserve 1000: 60 short', PACK_REFUSAL = 'pack holds 27 items, over 26: two collection slots unavailable';

test('a refusal on the coins or the pack marks its pair; a deadline or a baseline does not; none is a job failure', () => {
    const coins = unplacedResult(COINS_REFUSAL);
    expect(unplacedPrecondition([coins])).toBe(true);
    expect(unplacedPrecondition(['LEDGER ticks=3', unplacedResult(PACK_REFUSAL)])).toBe(true);
    for (const settled of ['owned item baseline 68 differs from EXPECTED_OWNED 10', 'order deadline passed 3 s ago (deadline 2000-01-01T00:00:00.000Z)', 'owned item already present;allocate it instead of buying duplicate stock'])
        expect([settled, unplacedPrecondition([unplacedResult(settled)])]).toEqual([settled, false]);
    expect(unplacedPrecondition([unplacedResult('GE interface unavailable')])).toBe(false);
    expect(unplacedPrecondition([coins.replace('"escrow":0', '"escrow":9')])).toBe(false);
    // Every refusal is a drain for assess, so two of them retire no pair.
    for (const failure of [COINS_REFUSAL, PACK_REFUSAL, 'owned item baseline 68 differs from EXPECTED_OWNED 10', 'order deadline passed 3 s ago (deadline 2000-01-01T00:00:00.000Z)'])
        expect(assess([unplacedResult(failure), unplacedResult(failure)])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    // The mark holds for UNPLACED_RETRY_MS and no longer.
    const now = 10_000_000, marks = { 'a:kit-buy:x': now - 60_000, 'b:kit-buy:x': now - UNPLACED_RETRY_MS, 'c:kit-buy:x': now + 1 };
    expect(unplacedHeld(marks, now)).toEqual(['a:kit-buy:x']);
    expect(unplacedHeld(undefined, now)).toEqual([]);
});

test('a pass writes state.unplaced for a refusal on the coins, and a death in the same log still retires the pair', () => {
    const rootDir = resolve(import.meta.dir, '..'), prac = join(rootDir, '.practice'), side = 'unpltest', account = 'Zunp', template = `${KIT_BUY}army-x`;
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-unplaced-')), prevFleet = process.env.FLEET_DIR, prevSide = process.env.FLEET_SIDE;
    const files = [join(prac, 'autopilot', `${side}.json`), join(prac, 'progression-system', `fleet-${side}.json`), join(prac, 'swarm-logs', `${account}.log`)];
    const job = { account, script: 'scripts/chain.ts', args: [], env: {}, role: 'supply', goal: 'test', enabled: true, standing: true, autopilot: side, template, resources: [] };
    const run = (lines: string[]) => {
        mkdirSync(join(prac, 'autopilot'), { recursive: true }); mkdirSync(join(prac, 'swarm-logs'), { recursive: true });
        writeFileSync(files[0]!, JSON.stringify({ assigned: { [account.toLowerCase()]: { template, offset: 0, at: 1 }, [account]: { template, offset: 0, at: 1 } }, retired: {} }));
        writeFileSync(files[2]!, jobLogStart(job) + lines.join('\n') + '\n');
        writeFileSync(join(dir, 'swarm.json'), JSON.stringify({ maxBots: 5, minFreeGB: 0, jobs: [job] }));
        pass(join(dir, 'swarm.json'), false, () => false, undefined, () => []);
        return JSON.parse(readFileSync(files[0]!, 'utf8'));
    };
    try {
        mkdirSync(join(dir, 'fleet'), { recursive: true });
        writeFileSync(join(dir, 'fleet', 'owners.json'), JSON.stringify({ accounts: { [account]: { side, server: 'rs-sdk-demo.fly.dev' } } }));
        process.env.FLEET_DIR = join(dir, 'fleet'); process.env.FLEET_SIDE = side;
        const before = Date.now(), marked = run([unplacedResult(COINS_REFUSAL)]);
        expect(marked.unplaced[`${account.toLowerCase()}:${template}`]).toBeGreaterThanOrEqual(before);
        expect(Object.keys(marked.retired)).toEqual([]);
        // A settled cause leaves no mark, and a death that the log also holds still retires the pair.
        expect(run([unplacedResult('owned item baseline 68 differs from EXPECTED_OWNED 10')]).unplaced).toBeUndefined();
        const died = run([unplacedResult(COINS_REFUSAL), 'RESULT fail died at 2652,3318']);
        expect(died.unplaced[`${account.toLowerCase()}:${template}`]).toBeGreaterThanOrEqual(before);
        expect(Object.keys(died.retired)).toEqual([`${account.toLowerCase()}:${template}`]);
    } finally {
        if (prevFleet === undefined) delete process.env.FLEET_DIR; else process.env.FLEET_DIR = prevFleet;
        if (prevSide === undefined) delete process.env.FLEET_SIDE; else process.env.FLEET_SIDE = prevSide;
        for (const f of files) rmSync(f, { force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the army roster adds each plannable account with Attack, Strength and Defence 90, never a guarded or specialist account', () => {
    const melee = (name: string, level: number) => ({ name, skills: { Attack: level, Strength: level, Defence: level } });
    const accounts = [melee('Maxed', 99), melee('NinetyOne', 91), melee('Edge', 90), melee('Low', 89), { name: 'Nine', skills: { Attack: 99, Strength: 99, Defence: 89 } },
        melee('Shaftshooter', 99), melee('Polevaulter', 99), melee('Haggis', 99), melee('Fresh', 1)];
    expect([...armyRoster({ army: ['Fresh'] }, accounts)].sort()).toEqual(['edge', 'fresh', 'maxed', 'ninetyone']);
    // An account that a guard set names never joins by rule.
    expect([...armyRoster({}, accounts, new Set(['maxed']))].sort()).toEqual(['edge', 'ninetyone']);
    // The hand list keeps its own: a listed account stays on the roster at any level.
    expect(armyRoster({ army: ['Low'] }, [melee('Low', 1)]).has('low')).toBe(true);
});

test('an active squad keeps its members off the roster by rule, and open trade parties reserve a start', () => {
    const melee = (name: string) => ({ name, skills: { Attack: 99, Strength: 99, Defence: 99 } });
    const accounts = [melee('Member'), melee('Other')];
    expect([...armyRoster({ squad: { active: true, members: ['Member'] } }, accounts)]).toEqual(['other']);
    expect([...armyRoster({ squad: { active: false, members: ['Member'] } }, accounts)].sort()).toEqual(['member', 'other']);
    expect([...armyRoster({ army: ['Member'], squad: { active: true, members: ['Member'] } }, accounts)].sort()).toEqual(['member', 'other']);
    // Two open order parties, one with a live session and one managed by the swarm: one start is still to come.
    expect(tradeStarts(new Set(['a', 'b', 'c', 'd']), ['A'], new Set(['b']))).toBe(2);
    expect(memoryHeadroom(8.6, 0, 2 + tradeStarts(new Set(['x', 'y']), [], new Set()))).toBe(0);
});

test('a swarm.json reservation holds its account: no roster by rule, no job, no donor; the protected AFKnight stays off the rule', () => {
    const melee = (name: string) => ({ name, skills: { Attack: 99, Strength: 99, Defence: 99 } });
    const accounts = [melee('Held'), melee('AFKnight'), melee('Free')];
    const jobs = [{ account: 'Held', role: 'pvp', enabled: false, goal: 'reserved: gang squad' }, { account: 'Mine', autopilot: 'local', script: 'scripts/goldfarm.ts' }, { account: 'Hand', script: 'scripts/goldfarm.ts', enabled: false }];
    // A job with no script that is no planner job is a reservation, enabled or not; a hand job with a script, off, is not.
    expect([...reservedAccounts(jobs, 'local')]).toEqual(['held']);
    expect([...armyRoster({}, accounts, OFFLINE_GUARDED, reservedAccounts(jobs, 'local'))]).toEqual(['free']);
    // A reserved account that the hand list names stays on the roster (mmsmk1232: listed, held by a coordinator run): only the rule skips it.
    expect([...armyRoster({ army: ['Held'] }, accounts, OFFLINE_GUARDED, reservedAccounts(jobs, 'local'))].sort()).toEqual(['free', 'held']);
    expect(admittedByLevels('AFKnight', { Attack: 99, Strength: 99, Defence: 99 })).toBe(false);
    // The scoreboard and planView count held accounts the same way: handNamed holds the reservation and an enabled hand job, not an off scripted one.
    expect([...handNamed(jobs, 'local')].sort()).toEqual(['held']);
    expect([...handNamed([...jobs, { account: 'Busy', script: 'scripts/goldfarm.ts', enabled: true }], 'local')].sort()).toEqual(['busy', 'held']);
    const owners = new Map([['held', { side: 'local', server: 's' }], ['free', { side: 'local', server: 's' }]]);
    const row = (name: string) => ({ name, skills: ['Attack', 'Strength', 'Defence'].map(n => ({ name: n, level: 99 })) });
    const view = planView(jobs, 'local', owners as any, 7, { observed: [row('Held'), row('Free')] });
    expect(view.army).toEqual(['free']);
    // A party of an open fleet order keeps no band: fundOrders replaces its assignment while the order is open.
    const band = { id: 'army-cow-strength-45', tier: 'goal' } as any;
    const r = fundOrders([{ account: 'Giver', template: band, value: 0, resources: ['cow:ardougne-north'], reason: 'army band 0' }, { account: 'Other', template: band, value: 0, resources: [], reason: 'army band 0' }], new Set(['giver']), make);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual(['vacant: in an open fleet order', 'army-cow-strength-45']);
    expect(r.assignments[0]!.resources).toEqual([]);
});

test('the memory headroom carries the margin of one start while a planner job is written and not running', () => {
    expect(headroomWithMargin(0, true)).toBe(1);
    expect(headroomWithMargin(3, true)).toBe(4);
    expect(headroomWithMargin(3, false)).toBe(3);
    // A running planner job's slot is kept at headroom 0 plus the margin: the plan holds the running bots and one more start.
    expect(freeSlots({ maxBots: 25 }, [], 'local', new Set(), 0, { running: 10, headroom: headroomWithMargin(0, true) })).toBe(11);
});

test('a planner job that is written and not running keeps one start of margin', () => {
    const jobs = [{ account: 'Run', autopilot: 'local', enabled: true }, { account: 'Wait', autopilot: 'local', enabled: true }, { account: 'Off', autopilot: 'local', enabled: false }];
    expect(writtenNotRunning(jobs, new Set(['run']))).toBe(true);
    expect(writtenNotRunning(jobs.slice(0, 1), new Set(['run']))).toBe(false);
    expect(writtenNotRunning([jobs[2]!], new Set())).toBe(false);
    // Memory below the running count never retires a running job: the cap keeps every running bot.
    expect(freeSlots({ maxBots: 25 }, [], 'local', new Set(), 0, { running: 10, headroom: 0 })).toBe(10);
});

test('armyBatch admits that many accounts under the rule, best melee first, and defaults to none', () => {
    const melee = (name: string, level: number) => ({ name, skills: { Attack: level, Strength: level, Defence: level } });
    const accounts = [melee('A', 80), melee('B', 70), melee('C', 60), melee('D', 50), melee('Maxed', 95), melee('Shaftshooter', 89)];
    expect([...armyRoster({}, accounts)]).toEqual(['maxed']);
    expect([...armyRoster({ armyBatch: 2 }, accounts)].sort()).toEqual(['a', 'b', 'maxed']);
    expect([...armyRoster({ armyBatch: 0 }, accounts)]).toEqual(['maxed']);
    expect([...armyRoster({ armyBatch: -1 }, accounts)]).toEqual(['maxed']);
    expect([...armyRoster({ armyBatch: 1.5 }, accounts)]).toEqual(['maxed']);
    expect([...armyRoster({ armyBatch: 99 }, accounts)].sort()).toEqual(['a', 'b', 'c', 'd', 'maxed']);
});

test('freeSlots is maxBots less the hand jobs, a host job counting each account', () => {
    const jobs = [{ account: 'Hand', enabled: true }, { account: 'Off', enabled: false }, { accounts: ['H1', 'H2', 'H3'], host: true, enabled: true },
        { account: 'Mine', autopilot: 'local', enabled: true }, { account: 'Paused', autopilot: 'local', enabled: true }];
    expect(freeSlots({ maxBots: 25 }, jobs, 'local', new Set(['paused']))).toBe(25 - 1 - 3 - 1);
    expect(freeSlots({ maxBots: 3 }, jobs, 'local', new Set())).toBe(0);
    expect(freeSlots({}, jobs, 'local', new Set())).toBeUndefined();
    // Memory caps the planner at its running bots plus the starts that headroom allows (floor 4 GiB, 1 GiB a start).
    expect(memoryHeadroom(8.6, 0, 0)).toBe(4);
    expect(memoryHeadroom(8.6, 0, 2)).toBe(2);
    expect(memoryHeadroom(8.6, 6, 0)).toBe(2);
    expect(memoryHeadroom(3.9, 0, 0)).toBe(0);
    expect(memoryHeadroom(8.6, Number.NaN, 0)).toBe(4);
    expect(freeSlots({ maxBots: 25 }, [], 'local', new Set(), 0, { running: 10, headroom: 4 })).toBe(14);
    expect(freeSlots({ maxBots: 25 }, [], 'local', new Set(), 0, { running: 10, headroom: 40 })).toBe(25);
    expect(freeSlots({ maxBots: 25 }, [], 'local', new Set(), 0, { running: 0, headroom: 0 })).toBe(0);
    // Live bots that no swarm run owns count against the limit, as in admissionDecision.
    expect(freeSlots({ maxBots: 25 }, jobs, 'local', new Set(['paused']), 4)).toBe(25 - 1 - 3 - 1 - 4);
    // The coordinator's expansion replaces maxBots only when it was granted over the owner plan's value.
    const owner = { maxBots: 25, jobs: [] };
    expect(freeSlots(mergedPlan(owner, { jobs: [], coordination: {}, expansion: { over: 25, maxBots: 30 } } as any), jobs, 'local', new Set(['paused']))).toBe(30 - 5);
    expect(freeSlots(mergedPlan(owner, { jobs: [], coordination: {}, expansion: { over: 20, maxBots: 30 } } as any), jobs, 'local', new Set(['paused']))).toBe(25 - 5);
});

test('plannerOwns refuses a reserved account as donor or job holder, and an unreserved one passes', () => {
    const owners = new Map([['keeper', { side: 'local', server: 's' }], ['taker', { side: 'local', server: 's' }], ['other', { side: 'cloud', server: 's' }], ['haggis', { side: 'local', server: 's' }]]);
    const reserved = new Set(['keeper']), died = new Set(['gone']);
    expect(plannerOwns(owners as any, 'local', 'keeper', reserved, died)).toBe(false);
    expect(plannerOwns(owners as any, 'local', 'taker', reserved, died)).toBe(true);
    expect(plannerOwns(owners as any, 'local', 'other', reserved, died)).toBe(false);
    expect(plannerOwns(owners as any, 'local', 'haggis', reserved, died)).toBe(false);
    expect(plannerOwns(owners as any, 'local', 'gone', reserved, died)).toBe(false);
});

test('the members of an active squad enter the plan for the restock, past their reservation', () => {
    const owners = new Map(['hunter', 'mate', 'paused', 'gone', 'remote', 'haggis', 'free'].map(n => [n, { side: n === 'remote' ? 'cloud' : 'local', server: 's' }]));
    const squad = { active: true, members: ['Hunter', 'Mate', 'Paused', 'Gone', 'Remote', 'Haggis'] };
    const listed = ['Hunter', 'Mate', 'Paused', 'Gone', 'Remote', 'Haggis', 'Free'];
    // Mate is on the plannable list already; Paused has an owner stop file; Gone died; Remote is another side's; Haggis is guarded.
    expect(squadRestockAccounts({ squad }, listed, owners as any, 'local', new Set(['paused']), new Set(['gone']), ['Mate'])).toEqual(['Hunter']);
    expect(squadRestockAccounts({ squad: { ...squad, active: false } }, listed, owners as any, 'local', new Set(), new Set())).toEqual([]);
    expect(squadRestockAccounts({}, listed, owners as any, 'local', new Set(), new Set())).toEqual([]);
});

test('the dry pass names a swarm.json reservation by its goal and gives its account no job', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-reserved-'));
    const prevFleet = process.env.FLEET_DIR, prevSide = process.env.FLEET_SIDE;
    try {
        mkdirSync(join(dir, 'fleet'), { recursive: true });
        writeFileSync(join(dir, 'fleet', 'owners.json'), JSON.stringify({ accounts: { Keeper: { side: 'local', server: 'rs-sdk-demo.fly.dev' }, Taker: { side: 'local', server: 'rs-sdk-demo.fly.dev' } } }));
        process.env.FLEET_DIR = join(dir, 'fleet'); process.env.FLEET_SIDE = 'local';
        const planFile = join(dir, 'swarm.json');
        writeFileSync(planFile, JSON.stringify({ maxBots: 5, minFreeGB: 0, army: ['Taker'], jobs: [{ account: 'Keeper', role: 'pvp', enabled: false, goal: 'reserved: gang squad' }] }));
        const lines = pass(planFile, true, () => false);
        expect(lines).toContain('AUTOPILOT vacant Keeper: reserved: gang squad');
        expect(lines.filter(l => /Keeper/.test(l) && /(assign|keep|fund|send) /.test(l))).toEqual([]);
    } finally {
        if (prevFleet === undefined) delete process.env.FLEET_DIR; else process.env.FLEET_DIR = prevFleet;
        if (prevSide === undefined) delete process.env.FLEET_SIDE; else process.env.FLEET_SIDE = prevSide;
        rmSync(dir, { recursive: true });
    }
});

test('the stock freshness of the donor rule is the one OBSERVATION_FRESH_MS', () => {
    expect(SIDE_STOCK_MAX_AGE_MS).toBe(OBSERVATION_FRESH_MS);
});

test('unobservedAccounts reads the observation time alone', () => {
    const now = 10 * 3_600_000, at: Record<string, unknown> = { Fresh: now - 60_000, Old: now - 31 * 60_000, Edge: now - 30 * 60_000, Future: now + 1, Missing: undefined, Text: 'x', Zero: 0, Empty: now - 1000 };
    expect(unobservedAccounts(Object.keys(at), n => at[n], now)).toEqual(['Old', 'Edge', 'Future', 'Missing', 'Text', 'Zero']);
});

test('the ring mould shop step selects the Dommik mould line with the real selectItems', () => {
    const t = catalogue().find(x => x.id === 'shop-ring-mould')!;
    expect(selectItems(PROFILES[t.args![0]!]!.items, t.env!.ITEMS).map(i => i.re.source)).toEqual(['^ring mould$']);
});

import { QUEST_DEMAND_ROWS, questDemand } from '../packages/planner/src/autopilot';
test('each quest demand row dispatches to the sweep, has a bench case that can pass, and asks what the journal and the practice pack ask', () => {
    const cases = new Map(benchCases().map(c => [c.key, c]));
    const items: { id: number; name: string; debugname?: string }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const reqs: Record<string, { s?: [string, number][]; q?: [string][]; qp?: number[] }> = JSON.parse(readFileSync(resolve(import.meta.dir, '../packages/dashboard/client-assets/quest-reqs.json'), 'utf8'));
    const templates = new Map(questDemand().map(t => [t.id, t]));
    expect(templates.size).toBe(QUEST_DEMAND_ROWS.length);
    // Hitpoints 90 stands only where the saved practice run fell under 70 Hitpoints with 99 in every skill.
    expect(QUEST_DEMAND_ROWS.filter(r => r.skills.Hitpoints).map(r => r.slug).sort()).toEqual(['crest', 'itwatchtower', 'regicide', 'upass', 'viking', 'zombiequeen']);
    for (const row of QUEST_DEMAND_ROWS) {
        const t = templates.get(`quest-${row.slug}`)!, step = resolveAioStep('quester', t.args!.slice(1));
        expect(`${row.slug} ${step.script} ${step.args}`).toBe(`${row.slug} scripts/quest-sweep.ts ${row.slug}`);
        expect(existsSync(resolve(import.meta.dir, '..', t.worker!))).toBe(true);
        // A one-account sweep: the generated script takes no helper account (Arrav, Hero's Quest and Legends Quest do), and the sweep does not refuse the quest.
        expect(`${row.slug} ${readFileSync(resolve(import.meta.dir, `generated/quest-${row.slug}.ts`), 'utf8').includes('process.argv[3]')}`).toBe(`${row.slug} false`);
        expect(`${row.slug} ${['hero', 'arrav', 'legends', 'misc'].includes(row.slug)}`).toBe(`${row.slug} false`);
        expect(`${row.slug} ${cases.has(t.aio!)}`).toBe(`${row.slug} true`);
        expect(cases.get(t.aio!)!.known).toBeUndefined();
        // The journal's own asks: its skills (and Hitpoints 90 where the practice run fell low), its quests and quest points.
        const journal = reqs[row.name]!, skills: Record<string, number> = Object.fromEntries((journal?.s ?? []).map(([s, l]) => [s, l]));
        expect(`${row.slug} ${JSON.stringify(Object.entries(row.skills).filter(([s]) => s !== 'Hitpoints' || skills.Hitpoints !== undefined).sort())}`)
            .toBe(`${row.slug} ${JSON.stringify(Object.entries(skills).sort())}`);
        expect(row.quests).toEqual((journal?.q ?? []).map(q => q[0]));
        expect(row.questPoints).toBe(journal?.qp?.[0]);
        // The practice pack: every item of the run's inventory and bank, with its food as meals.
        const pack: Record<string, number> = {}; let meals = 0;
        const preset = presetFor(row.slug);
        for (const i of [...(preset.inventory ?? []), ...(preset.bank ?? [])]) { if (MEALS.includes(i.id) || (row.slug === 'regicide' && name(i.id) === 'shark')) meals += i.count; else pack[name(i.id)] = (pack[name(i.id)] ?? 0) + i.count; }
        expect(`${row.slug} ${JSON.stringify(Object.entries(row.items).map(([i, n]) => [norm(i), n]).sort())}`).toBe(`${row.slug} ${JSON.stringify(Object.entries(pack).sort())}`);
        expect(`${row.slug} ${row.meals}`).toBe(`${row.slug} ${meals}`);
    }
});

import { parseCatFileBatch } from './autopilot';
test('the batch output of git cat-file is read object by object, with a missing object as null', () => {
    const out = Buffer.from(['abc123 blob 7', '{"a":1}', 'origin/fleet-data:fleet/claims/x.json missing', 'def456 blob 2', '{}', ''].join(String.fromCharCode(10)));
    expect(parseCatFileBatch(out, 3)).toEqual(['{"a":1}', null, '{}']);
    // A multibyte character counts its bytes (the size of the header), and a short output leaves the rest null.
    const nl = String.fromCharCode(10), wide = Buffer.from('abc blob 3' + nl + 'é"' + nl + 'def blob 1' + nl + 'x' + nl);
    expect(parseCatFileBatch(wide, 3)).toEqual(['é"', 'x', null]);
    expect(parseCatFileBatch(Buffer.from(''), 2)).toEqual([null, null]);
});
