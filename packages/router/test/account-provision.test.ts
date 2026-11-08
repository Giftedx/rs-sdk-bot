import {test, expect} from 'bun:test';
import {NAMES} from '../../core/src/names';
import {provisionAccount, createAccountProvisionDeps,registrationEnvironment, type AccountProvisionDeps, type RegistrationResult} from '../src/account-provision';
import {addTasks, finishTask, initialState, startTask, type CoordTask} from '../src/coordinator';
import {preparedProvisionProof} from '../src/coordinator-worker';

const request = {role:'ranged' as const,purpose:'missing role: ranged supply',server:'rs-sdk-demo.fly.dev',reservedNames:['PULLMYBOW']};
test('live registration forwards its verified release and refuses a missing pin before login',()=>{
 const pin='a'.repeat(64);expect(registrationEnvironment('rs-sdk-demo.fly.dev',pin).WORKER_RELEASE).toBe(pin);expect(registrationEnvironment('rs-sdk-demo.fly.dev',pin).DEMO_OK).toBe('1');
 expect(()=>registrationEnvironment('rs-sdk-demo.fly.dev',undefined)).toThrow('qualified runtime');expect(()=>registrationEnvironment('rs-sdk-demo.fly.dev','bad')).toThrow('qualified runtime');expect(registrationEnvironment('localhost:8888',undefined).DEMO_OK).toBe('');
});
function harness(result:RegistrationResult={exitCode:0,stdout:'CLAIM ticks=1 in_game=false logout=logged-out\n'}) {
    const created:string[]=[],registered:string[]=[],reserved:string[]=[];
    const deps:AccountProvisionDeps={
        listLocalAccountNames:()=>['shaftshooter','earlyshooter'],
        reserveLiveAccount:async(name)=>{reserved.push(name);return true;},
        createLocalAccount:(name)=>{created.push(name);},
        registerAccount:async(name)=>{registered.push(name);return result;},
    };
    return {deps,created,registered,reserved};
}

test('uses the next role name excluding all local and reserved names without changing list order',async()=>{
    const h=harness(), result=await provisionAccount(request,h.deps);
    expect(result).toMatchObject({account:'Quiverfull',server:request.server,registered:true});
    expect(h.reserved).toEqual(['Quiverfull']);
    expect(h.created).toEqual(['Quiverfull']);expect(h.registered).toEqual(['Quiverfull']);
});

test('skips a shared name before writing credentials and never falls back after an uncertain reservation',async()=>{
    const h=harness();
    h.deps.listLocalAccountNames=()=>['shaftshooter'];
    h.deps.reserveLiveAccount=async name=>{
        expect(h.created).toEqual([]);
        expect(h.registered).toEqual([]);
        h.reserved.push(name);
        if(name==='Earlyshooter')return false;
        throw Error('private remote failure');
    };
    const out=await provisionAccount(request,h.deps);
    expect(h.reserved).toEqual(['Earlyshooter','Quiverfull']);
    expect(out).toMatchObject({account:'Quiverfull',registered:false,reason:'shared identity reservation unconfirmed; retain identity for review'});
    expect(h.created).toEqual([]);expect(h.registered).toEqual([]);
});

test('practice registration does not claim a live registry entry',async()=>{
    const h=harness();
    expect((await provisionAccount({...request,server:'localhost:8888'},h.deps)).registered).toBe(true);
    expect(h.reserved).toEqual([]);
});

test('first job must directly name the current proof for its own capability',()=>{
    const state=initialState();
    const task=(id:string, extra:Partial<CoordTask>):CoordTask=>({
        id,kind:'qualify',goal:'skills',capability:'train',dependsOn:[],priority:1,estimatedMs:1,why:'starter job',...extra,
    });
    addTasks(state,[
        task('claim',{kind:'provision',role:'ranged'}),
        task('unrelated',{capability:'other'}),
        task('proof',{}),
        task('first-job',{kind:'run',accountFrom:'claim',dependsOn:['unrelated'],accept:{skills:{Ranged:7}}}),
    ],1);
    for(const [id,capability] of [['unrelated','other'],['proof','train']] as const){
        startTask(state,id,2,id);
        finishTask(state,{taskId:id,runId:id,ok:true,at:3,output:{delivery:{id:capability,ok:true,stage:'delivered',source:'qualified-source',runtimeRevision:'qualified-runtime'}}});
    }
    const source=()=>({fingerprint:'qualified-source',runtime:'qualified-runtime'});
    expect(preparedProvisionProof(state,'claim',source)).toBe(false);
    state.tasks[3]!.spec.dependsOn=['proof'];
    expect(preparedProvisionProof(state,'claim',source)).toBe(true);
    expect(preparedProvisionProof(state,'claim',()=>({...source(),runtime:'changed-runtime'}))).toBe(false);
});

test('local credentials alone, exit failure, timeout and unconfirmed logout are not registration',async()=>{
    for(const result of [
        {exitCode:0,stdout:'created bot.env'},
        {exitCode:1,stdout:'CLAIM ticks=1 in_game=false logout=logged-out'},
        {exitCode:0,timedOut:true,stdout:'CLAIM ticks=1 in_game=false logout=logged-out'},
        {exitCode:0,stdout:'CLAIM ticks=1 in_game=true logout=still-in-game'},
        {exitCode:0,stdout:'CLAIM ticks=1 in_game=false logout=logged-out extra'},
        {exitCode:0,stdout:'CLAIM ticks=1 in_game=false logout=logged-out\nCLAIM ticks=0 in_game=true logout=failed'},
    ]) {
        const h=harness(result), out=await provisionAccount(request,h.deps);
        expect(out.registered).toBe(false);expect(out.account).toBe('Quiverfull');
        expect(h.created).toHaveLength(1);expect(h.registered).toHaveLength(1);
    }
});

test('invalid intent or exhausted names performs no creation or login',async()=>{
    for(const change of [{purpose:'  '},{role:'main'},{reservedNames:NAMES.ranged},{server:'evil.example'}]) {
        const h=harness();const out=await provisionAccount({...request,...change} as typeof request,h.deps);
        expect(out.registered).toBe(false);expect(h.created).toEqual([]);expect(h.registered).toEqual([]);
    }
});

test('creation or registration errors retain the selected identity and never disclose error secrets',async()=>{
    for(const stage of ['create','register']) {
        const h=harness();
        if(stage==='create')h.deps.createLocalAccount=()=>{throw Error('PASSWORD=secret');};
        else h.deps.registerAccount=async(name)=>{h.registered.push(name);throw Error('PASSWORD=secret');};
        const out=await provisionAccount(request,h.deps);
        expect(out.registered).toBe(false);expect(out.account).toBe('Quiverfull');
        expect(JSON.stringify(out)).not.toContain('secret');
        expect(h.registered.length).toBe(stage==='create'?0:1);
    }
});

test('inventory failure prevents credentials and claim; factory rejects unbounded timeouts',async()=>{
    const h=harness();h.deps.listLocalAccountNames=()=>{throw Error('private inventory');};
    expect((await provisionAccount(request,h.deps)).registered).toBe(false);
    expect(h.created).toEqual([]);expect(h.registered).toEqual([]);
    for(const timeoutMs of [0,-1,Infinity,120001])expect(()=>createAccountProvisionDeps({timeoutMs})).toThrow();
    expect(typeof createAccountProvisionDeps().registerAccount).toBe('function');
});
