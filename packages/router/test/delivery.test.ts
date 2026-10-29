import {test, expect} from 'bun:test';
import {deliver, type DeliveryTask, type DeliveryDeps} from '../src/delivery';

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
