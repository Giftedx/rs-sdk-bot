import {test, expect} from 'bun:test';
import {deliver, type DeliveryTask, type DeliveryDeps} from '../src/delivery';
import {readFileSync} from 'node:fs';

const task:DeliveryTask={id:'ammo',goal:'Bank arrows from supplied tips',entry:'scripts/fletch-arrows.ts',files:['scripts/fletch-arrows.ts'],consumer:'Ranged supply',checks:[
    {id:'regression',phase:'regression',command:['bun','test'],timeoutMs:1000},
    {id:'native',phase:'practice',command:['bun','proof.ts'],timeoutMs:1000},
    {id:'banked',phase:'consumer',command:['bun','verify.ts'],timeoutMs:1000},
]};
function harness(){
    const calls:string[]=[];let version='source';
    const deps:DeliveryDeps={fingerprint:()=>version,run:async c=>{calls.push(c.id);return{exitCode:0,detail:'checked'};}};
    return{calls,deps,edit:()=>{version='changed';}};
}
test('delivery reaches the consumer after regressions and native work',async()=>{
    const h=harness(),r=await deliver(task,h.deps);
    expect(r).toMatchObject({ok:true,stage:'delivered',consumer:'Ranged supply',evidence:'native'});
    expect(h.calls).toEqual(['regression','native','banked']);
});

test('the shipped adaptive Ranged contract keeps native checks before read-only consumers',async()=>{
 const actual=JSON.parse(readFileSync(new URL('../tasks/ranged-train.json',import.meta.url),'utf8')) as DeliveryTask;
 const h=harness(),r=await deliver(actual,h.deps);
 expect(r.ok).toBe(true);expect(h.calls).toEqual(actual.checks.map(c=>c.id));
 const {isSavedProofVerifier}=await import('../src/delivery-cli');
 expect(isSavedProofVerifier(actual.checks.find(c=>c.id==='adaptive-ranged-saved')!)).toBe(true);
});
test('the 400ms carrier proof fits a finite check budget while excessive budgets run nothing',async()=>{
    const carrier=JSON.parse(readFileSync(new URL('../tasks/rune-bank-craft.json',import.meta.url),'utf8')) as DeliveryTask;
    const h=harness();expect((await deliver(carrier,h.deps)).ok).toBe(true);
    expect(h.calls).toEqual(carrier.checks.map(c=>c.id));
    const refused=harness();
    expect((await deliver({...carrier,checks:carrier.checks.map(c=>({...c,timeoutMs:1800001}))},refused.deps)).ok).toBe(false);
    expect(refused.calls).toEqual([]);
});
test('producer success cannot hide a failed consumer',async()=>{
    const h=harness();h.deps.run=async c=>({exitCode:c.phase==='consumer'?1:0,detail:c.id});
    const r=await deliver(task,h.deps);expect(r.ok).toBe(false);expect(r.failedCheck).toBe('banked');
});
test('invalid, empty or out-of-order acceptance runs nothing',async()=>{
    for(const checks of [[],task.checks.slice(0,2),[task.checks[2]!,...task.checks.slice(0,2)],task.checks.map(c=>({...c,timeoutMs:0})),task.checks.map(c=>({...c,command:[]}))]){
        const h=harness();expect((await deliver({...task,checks},h.deps)).ok).toBe(false);expect(h.calls).toEqual([]);
    }
});
test('a timeout stops dependent checks even when a child reports exit zero',async()=>{
    const h=harness();h.deps.run=async c=>{h.calls.push(c.id);return{exitCode:0,timedOut:true,detail:'expired'};};
    expect((await deliver(task,h.deps)).ok).toBe(false);expect(h.calls).toEqual(['regression']);
});
test('changing source invalidates the result and stops the next stage',async()=>{
    const h=harness();h.deps.run=async c=>{h.calls.push(c.id);h.edit();return{exitCode:0,detail:'checked'};};
    const r=await deliver(task,h.deps);expect(r.ok).toBe(false);expect(r.reason).toContain('source changed');expect(h.calls).toEqual(['regression']);
});
test('missing source and thrown check failures are retained as failed deliveries',async()=>{
    const h=harness();h.deps.fingerprint=()=>{throw Error('missing entry');};expect((await deliver(task,h.deps)).reason).toContain('missing entry');
    h.deps.fingerprint=()=> 'source';h.deps.run=async()=>{throw Error('cannot start');};expect((await deliver(task,h.deps)).reason).toContain('cannot start');
});

test('diagnostics stop at the declared practice check and cannot qualify delivery',async()=>{
 const h=harness(),r=await deliver(task,h.deps,'native');
 expect(h.calls).toEqual(['regression','native']);expect(r).toMatchObject({ok:false,stage:'failed',diagnostic:{checkId:'native',complete:true}});
 for(const id of ['banked','regression','unknown','']){const bad=harness();expect((await deliver(task,bad.deps,id)).ok).toBe(false);expect(bad.calls).toEqual([]);}
});

test('diagnostic failure, timeout and source drift retain failure and never reach consumer',async()=>{
 for(const cause of ['failure','timeout','drift']){
  const h=harness();h.deps.run=async c=>{h.calls.push(c.id);if(c.id==='native'&&cause==='drift')h.edit();return{exitCode:c.id==='native'&&cause==='failure'?1:0,timedOut:c.id==='native'&&cause==='timeout',detail:c.id};};
  const r=await deliver(task,h.deps,'native');expect(r.diagnostic?.complete).toBe(false);expect(r.ok).toBe(false);expect(h.calls).toEqual(['regression','native']);
 }
});

import {checkBatches, validateDelivery} from '../src/delivery';
const grouped:DeliveryTask={...task,checks:[
    {id:'regression',phase:'regression',command:['bun','test'],timeoutMs:1000},
    {id:'native-a',phase:'practice',command:['bun','a.ts'],timeoutMs:1000,group:'practice'},
    {id:'native-b',phase:'practice',command:['bun','b.ts'],timeoutMs:1000,group:'practice'},
    {id:'banked',phase:'consumer',command:['bun','verify.ts'],timeoutMs:1000},
]};
test('the checks of one group run at one time, inside one batch wrapper, and report in task order',async()=>{
    const events:string[]=[];let release!:()=>void;const both=new Promise<void>(r=>{release=r;});let started=0;
    const deps:DeliveryDeps={fingerprint:()=>'source',
        run:async c=>{events.push('start '+c.id);if(c.group){if(++started===2)release();await both;}events.push('end '+c.id);return{exitCode:0,detail:c.id};},
        batch:async(checks,work)=>{events.push('batch '+checks.map(c=>c.id).join('+'));try{return await work();}finally{events.push('batch end');}}};
    const r=await deliver(grouped,deps);
    expect(r.ok).toBe(true);
    // native-b started before native-a ended: a serial run would wait for ever on `both`.
    expect(events).toEqual(['start regression','end regression','batch native-a+native-b','start native-a','start native-b','end native-a','end native-b','batch end','start banked','end banked']);
    expect(r.checks.map(c=>c.id)).toEqual(['regression','native-a','native-b','banked']);
    expect(checkBatches(grouped.checks).map(b=>b.map(c=>c.id))).toEqual([['regression'],['native-a','native-b'],['banked']]);
});
test('a failed check of a group fails the delivery after every check of the group ended, and the consumer does not run',async()=>{
    const calls:string[]=[];
    const deps:DeliveryDeps={fingerprint:()=>'source',run:async c=>{calls.push(c.id);return c.id==='native-b'?{exitCode:1,detail:'x'}:{exitCode:0,detail:'x'};}};
    const r=await deliver(grouped,deps);
    expect(r).toMatchObject({ok:false,stage:'failed',failedCheck:'native-b',reason:'check failed'});
    expect(calls).toEqual(['regression','native-a','native-b']);
    expect(r.checks.map(c=>[c.id,c.exitCode])).toEqual([['regression',0],['native-a',0],['native-b',1]]);
    const thrown=await deliver(grouped,{fingerprint:()=>'source',run:async c=>{if(c.id==='native-a')throw Error('host fault');return{exitCode:0,detail:'x'};}});
    expect(thrown).toMatchObject({ok:false,failedCheck:'native-a',reason:'Error: host fault'});
});
test('a diagnostic runs the checks one by one, and a group must be neighbours of one phase with a plain name',async()=>{
    const calls:string[]=[];
    const r=await deliver(grouped,{fingerprint:()=>'source',run:async c=>{calls.push(c.id);return{exitCode:0,detail:'x'};},batch:async()=>{throw Error('no batch in a diagnostic');}},'native-a');
    expect(r.diagnostic).toEqual({checkId:'native-a',complete:true});expect(calls).toEqual(['regression','native-a']);
    const split={...grouped,checks:[grouped.checks[0]!,grouped.checks[1]!,{...grouped.checks[3]!,phase:'practice' as const,id:'plain'},grouped.checks[2]!,grouped.checks[3]!]};
    expect(()=>validateDelivery(split)).toThrow('neighbours of one phase');
    expect(()=>validateDelivery({...grouped,checks:grouped.checks.map(c=>c.group?{...c,group:'Bad Name'}:c)})).toThrow('invalid delivery check group');
    expect(()=>validateDelivery(grouped)).not.toThrow();
});
