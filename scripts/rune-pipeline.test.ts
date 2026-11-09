import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
import {observeCraftCompletion,pipelineOpeningReady,runeHandoffPipeline} from './rune-pipeline';

function fixture(){
 let tick=10,complete=false,stopped=false;const listeners=new Set<()=>void>();
 const session={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}};
 const boundary=observeCraftCompletion(session,()=>complete,()=>stopped);
 return {session,boundary,listeners,done:()=>{complete=true;},stop:()=>{stopped=true;},publish:(next:number)=>{tick=next;for(const cb of [...listeners])cb();}};
}
test('a catch-up publication batch anchors its final count before four later turns',async()=>{
 const f=fixture();f.done();f.publish(11);f.publish(12);f.publish(13);
 expect(f.boundary.tick()).toBeUndefined();await Promise.resolve();expect(f.boundary.tick()).toBe(13);expect(f.listeners.size).toBe(0);
 f.publish(16);expect(pipelineOpeningReady(f.session,f.boundary)).toBe(false);
 f.publish(17);expect(pipelineOpeningReady(f.session,f.boundary)).toBe(true);
});
test('split packets and action refreshes cannot anchor before a completed tick publication',async()=>{
 const f=fixture();f.publish(11);await Promise.resolve();f.done();await Promise.resolve();expect(f.boundary.tick()).toBeUndefined();
 f.publish(12);await Promise.resolve();expect(f.boundary.tick()).toBe(12);f.publish(15);expect(pipelineOpeningReady(f.session,f.boundary)).toBe(false);
 f.publish(16);expect(pipelineOpeningReady(f.session,f.boundary)).toBe(true);
});
test('stop before the anchor microtask removes the observer without a ready boundary',async()=>{
 const f=fixture();f.done();f.publish(11);f.stop();await Promise.resolve();expect(f.boundary.tick()).toBeUndefined();expect(f.listeners.size).toBe(0);
});
test('disposing a scheduled boundary prevents it from escaping into another craft',async()=>{
 const f=fixture();f.done();f.publish(11);f.boundary.dispose();await Promise.resolve();expect(f.boundary.tick()).toBeUndefined();expect(f.listeners.size).toBe(0);
 f.publish(20);expect(pipelineOpeningReady(f.session,f.boundary)).toBe(false);
});
test('the opt-in pipeline requires combined trade-message crafting before accounts open',()=>{
 expect(runeHandoffPipeline('0','inventory')).toBe(false);expect(runeHandoffPipeline('0','trade-message')).toBe(false);expect(runeHandoffPipeline('1','trade-message')).toBe(true);
 for(const value of ['true','2','', '01'])expect(()=>runeHandoffPipeline(value,'trade-message')).toThrow();
 expect(()=>runeHandoffPipeline('1','inventory')).toThrow();
});

test('pipeline opening preserves unrelated dialogs and stops on refused dispatch without retrying',()=>{
 for(const mode of ['dialog','refused','stop']){
  const code=`import{mock}from'bun:test';import{resolve}from'node:path';let requests=0,crafts=0;
  const s={name:'Crafter'},h={name:'Carrier'};
  for(const[a,o]of[[s,h],[h,s]]){a.tick=()=>104;a.direct=async()=>{requests++;return{success:false}};a.sdk={getInventory:()=>a===h?[{id:1436,count:27,slot:0}]:[],getState:()=>({trade:{isOpen:false},gameMessages:[],player:{worldX:2523,worldZ:4833,level:0},nearbyPlayers:[{name:o.name,index:1}],dialog:{isOpen:'${mode}'==='dialog'&&a===s,allComponents:[{text:'Keep this quest choice'}]}}),scanGroundItems:async()=>{}};}
  mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p)=>p(),waitTicks:async()=>{throw Error('Unexpected tick wait')}}));
  const{transfer}=await import('./scripts/rune-carrier-trade');let error='';try{await transfer(s,h,()=> '${mode}'==='stop',27,{send:async()=>{crafts++},complete:()=>false},{boundary:{tick:()=>100,dispose:()=>{}}})}catch(e){error=String(e)}console.log(JSON.stringify({error,requests,crafts}));`;
  const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:2000});
  expect(child.exitCode).toBe(0);const r=JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
  expect(r.crafts).toBe(0);expect(r.requests).toBe(mode==='refused'?2:0);
  expect(r.error).toContain(mode==='dialog'?'preserves unrelated dialogs':mode==='refused'?'reciprocal request refused':'did not reconcile');
 }
});
