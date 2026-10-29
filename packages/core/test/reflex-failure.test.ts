import {expect,test} from 'bun:test';
import {startReflexes,type Reflexive} from '../src/reflex';

const rules={eatBelowHp:5,fleeBelowHp:3,foods:/shrimps/i,safeTile:{x:1,z:2,level:0}};
function source(action:()=>Promise<unknown>,food=true){
 const callbacks=new Set<()=>void>();let last:()=>void=()=>{};
 const s:Reflexive={sdk:{getState:()=>({skills:[{name:'Hitpoints',level:2}],inventory:food?[{name:'Shrimps'}]:[]})},tick:()=>1,
  onTick:f=>{callbacks.add(f);last=f;return()=>{callbacks.delete(f);};},bot:{eatFood:action,walkTo:action}};
 return {s,emit:()=>{for(const f of callbacks)f();},retained:()=>last(),listeners:()=>callbacks.size};
}
const settle=async()=>{for(let n=0;n<6;n++)await Promise.resolve();};

test('a synchronous eat exception aborts the owning action and removes the reflex',async()=>{
 let calls=0;const g=source(()=>{calls++;throw Error('food op failed');});const r=startReflexes(g.s,rules);
 expect(()=>g.emit()).not.toThrow();await settle();
 expect(r.aborted.aborted).toBe(true);expect(String(r.aborted.reason)).toContain('food op failed');
 expect(g.listeners()).toBe(0);g.retained();await settle();expect(calls).toBe(1);
});
test('a rejected eat promise aborts rather than escaping as an unhandled rejection',async()=>{
 const g=source(()=>Promise.reject(Error('food disconnected')));const r=startReflexes(g.s,rules);
 g.emit();await settle();expect(r.aborted.aborted).toBe(true);expect(String(r.aborted.reason)).toContain('food disconnected');expect(g.listeners()).toBe(0);
});
test('a rejected emergency walk is handled after the low-health abort',async()=>{
 const g=source(()=>Promise.reject(Error('walk disconnected')),false);const r=startReflexes(g.s,rules);
 g.emit();await settle();expect(r.aborted.aborted).toBe(true);expect(g.listeners()).toBe(0);
});
test('stop prevents a retained tick callback from starting another action',async()=>{
 let calls=0;const g=source(async()=>{calls++;});const r=startReflexes(g.s,rules);
 r.stop();g.retained();await settle();expect(calls).toBe(0);expect(r.aborted.aborted).toBe(false);
});
test('a refused eat reply aborts instead of retrying food on every tick',async()=>{
 const g=source(async()=>({success:false,message:'food unavailable'}));const r=startReflexes(g.s,rules);
 g.emit();await settle();expect(r.aborted.aborted).toBe(true);expect(String(r.aborted.reason)).toContain('food unavailable');expect(g.listeners()).toBe(0);
});
test('stop cancels an action queued by a tick before it starts',async()=>{
 let calls=0;const g=source(async()=>{calls++;});const r=startReflexes(g.s,rules);
 g.emit();r.stop();await settle();expect(calls).toBe(0);
});
test('ticks cannot overlap an unsettled reflex action',async()=>{
 let calls=0;let done:()=>void=()=>{};
 const g=source(()=>{calls++;return new Promise<void>(resolve=>{done=resolve;});});
 const r=startReflexes(g.s,rules);g.emit();await settle();g.emit();g.emit();await settle();
 expect(calls).toBe(1);r.stop();done();await settle();g.retained();await settle();expect(calls).toBe(1);
});
