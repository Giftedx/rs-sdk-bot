import {test,expect} from 'bun:test';
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
