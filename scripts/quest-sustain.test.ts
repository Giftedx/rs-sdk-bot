import {expect,test} from 'bun:test';
import {selectQuestFood,startQuestSustain,questFoodDefinitions,defaultEatAt} from './quest-sustain';
import {waitUntil} from '../packages/core/src/ticks';

const item=(id:number,slot=0,count=1,op=1)=>({id,slot,count,optionsWithIndex:[{text:'Eat',opIndex:op}]});
const snapshot=(hp:number,max=20,inventory=[item(379)])=>({skills:[{name:'Hitpoints',level:hp,baseLevel:max}],inventory});
const policy={food:[379,2327,2323],eatAt:40};
test('pinned food forms keep half pies eligible and use our server healing values',()=>{
 const defs=questFoodDefinitions();expect(defs.get(2327)?.heal).toBe(4);expect(defs.get(2323)?.heal).toBe(5);
 expect(selectQuestFood(snapshot(14,20,[item(2331,4,1,3)]),policy)).toMatchObject({item:{id:2331,slot:4},opIndex:3});
 expect(selectQuestFood(snapshot(20),policy)).toBeNull();
 expect(selectQuestFood(snapshot(0),policy)).toBeNull();
});
test('a fitting heal wins across inventory, reserved inputs and notes remain unavailable',()=>{
 expect(selectQuestFood(snapshot(16,20,[item(379),item(2327,1)]),policy)?.item.id).toBe(2327);
 const p={food:[2325,379],eatAt:40,reserved:{2325:1}};
 expect(selectQuestFood(snapshot(8,20,[item(2325),item(379,1)]),p)?.item.id).toBe(379);
 expect(selectQuestFood(snapshot(8,20,[item(2325)]),p)).toBeNull();
 expect(selectQuestFood(snapshot(8,20,[item(2326)]),{food:[2325],eatAt:40})).toBeNull();
 expect(selectQuestFood(snapshot(8,20,[{...item(379),optionsWithIndex:[{text:'Use',opIndex:1}]}]),policy)).toBeNull();
});

function game(initial= snapshot(8,20,[item(2327)])){
 let state=initial,tick=0;const callbacks=new Set<()=>void>();const sent:any[]=[];
 let reply:()=>Promise<{success:boolean;message?:string}>=async()=>({success:true});
 const s={sdk:{getState:()=>state},tick:()=>tick,onTick:(f:()=>void)=>{callbacks.add(f);return()=>callbacks.delete(f);},direct:async(a:unknown)=>{sent.push(a);return reply();}};
 return {s,sent,set:(v:typeof state)=>{state=v;},reply:(r:typeof reply)=>{reply=r;},listeners:()=>callbacks.size,step:async()=>{tick++;for(const f of callbacks)f();for(let n=0;n<5;n++)await Promise.resolve();}};
}
test('one in-flight eat is counted only after its exact partial-form effect, then resumes from that form',async()=>{
 const g=game();let eaten=0;const eater=startQuestSustain(g.s,{...policy,onConsumed:()=>eaten++});
 await g.step();await g.step();expect(g.sent.length).toBe(1);expect(eaten).toBe(0);
 g.set(snapshot(12,20,[item(2331)]));await g.step();expect(eaten).toBe(1);
 await g.step();expect(g.sent.length).toBe(2);
 g.set(snapshot(16,20,[item(2313)]));await g.step();expect(eaten).toBe(2);expect(eater.failure()).toBeNull();eater.stop();
});
test('a debit without the required partial form does not prove an eat',async()=>{
 const g=game();let eaten=0;const eater=startQuestSustain(g.s,{...policy,timeoutTicks:3,onConsumed:()=>eaten++});
 await g.step();g.set(snapshot(12,20,[]));for(let n=0;n<3;n++)await g.step();
 expect(eaten).toBe(0);expect(eater.failure()).toContain('transform');expect(g.listeners()).toBe(0);
});
test('a refused dispatch and a no-effect deadline surface failure rather than useful-eat counts',async()=>{
 const g=game();g.reply(async()=>({success:false,message:'refused'}));const refused=startQuestSustain(g.s,policy);await g.step();expect(refused.failure()).toContain('refused');expect(g.listeners()).toBe(0);
 const stalled=game();const e=startQuestSustain(stalled.s,{...policy,timeoutTicks:3});for(let n=0;n<5;n++)await stalled.step();
 expect(e.failure()).toContain('unobserved');expect(stalled.sent.length).toBe(1);expect(stalled.listeners()).toBe(0);
 // With dropRetries an eat with no effect is sent again that many times, then the eater fails.
 const again=game();const r=startQuestSustain(again.s,{...policy,timeoutTicks:3,dropRetries:2});for(let n=0;n<16;n++)await again.step();
 expect(r.failure()).toContain('unobserved');expect(again.sent.length).toBe(3);
});
test('no second eat starts at full HP, after stop or when the latest slot is no longer eligible',async()=>{
 const g=game(snapshot(20));const e=startQuestSustain(g.s,policy);await g.step();expect(g.sent.length).toBe(0);
 g.set(snapshot(8,20,[]));await g.step();expect(g.sent.length).toBe(0);e.stop();g.set(snapshot(8));await g.step();expect(g.sent.length).toBe(0);
});
test('quest exit drains the already-sent bite before counting it and starts no further eat',async()=>{
 const g=game();let eaten=0;const e=startQuestSustain(g.s,{...policy,onConsumed:()=>eaten++});await g.step();
 let done=false;const end=e.settle().then(()=>{done=true;});expect(done).toBe(false);
 g.set(snapshot(12,20,[item(2331)]));await g.step();await end;expect(eaten).toBe(1);expect(done).toBe(true);
 for(let n=0;n<4;n++)await g.step();expect(g.sent.length).toBe(1);expect(g.listeners()).toBe(0);
});
test('consume refusal immediately releases a current quest wait instead of waiting120ticks',async()=>{
 const g=game();g.reply(async()=>({success:false,message:'refused'}));const e=startQuestSustain(g.s,policy);
 const pending=waitUntil(g.s,()=>false,{timeoutTicks:120,signal:e.aborted});await g.step();
 expect(await pending).toBe(false);expect(e.failure()).toContain('refused');expect(g.listeners()).toBe(0);
});
test('mutable inventory publication cannot rewrite the pending bite identity',async()=>{
 const original=item(2327);const g=game(snapshot(8,20,[original]));let eaten=0;
 const e=startQuestSustain(g.s,{...policy,onConsumed:()=>eaten++});await g.step();original.id=2331;await g.step();
 expect(eaten).toBe(1);expect(e.failure()).toBeNull();e.stop();
});
test('a new life cannot spend food before the quest death watcher runs',async()=>{
 const g=game({...snapshot(8),player:{lifeId:1,respawnCount:0}} as any);const e=startQuestSustain(g.s,policy);
 g.set({...snapshot(8),player:{lifeId:2,respawnCount:1}} as any);await g.step();
 expect(g.sent.length).toBe(0);expect(e.failure()).toContain('life changed');expect(e.aborted.aborted).toBe(true);
});

test('the default eat level follows the maximum, so a low account fights on through small hits',()=>{
 expect([17,40,66,67,99].map(defaultEatAt)).toEqual([10,24,39,40,40]);
 const state=(level:number)=>({skills:[{name:'Hitpoints',level,baseLevel:40}],inventory:[{id:379,slot:0,optionsWithIndex:[{text:'Eat',opIndex:1}]}]});
 expect(selectQuestFood(state(39),{food:[379],eatAt:defaultEatAt})).toBeNull();
 expect(selectQuestFood(state(25),{food:[379],eatAt:defaultEatAt})).toBeNull();
 expect(selectQuestFood(state(24),{food:[379],eatAt:defaultEatAt})?.item.id).toBe(379);
 expect(selectQuestFood(state(39),{food:[379],eatAt:40})?.item.id).toBe(379);
});
