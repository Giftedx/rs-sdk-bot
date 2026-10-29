import {test,expect} from 'bun:test';
import {runWineOrder,starterConsumed,type WineStage} from './cook-wine';

test('all-bad fermentation is settled stock even without XP; unknown or retained raw stock is not',()=>{
 expect(starterConsumed({bankRaw:0,heldRaw:0})).toBe(true);
 expect(starterConsumed(null)).toBe(false);
 expect(starterConsumed({bankRaw:10,heldRaw:0})).toBe(false);
 expect(starterConsumed({bankRaw:0,heldRaw:1})).toBe(false);
});

test('a wine order reaches its target through staged stock and a confirmed relog',async()=>{
 const phases:string[]=[];
 const stage:WineStage=async(_name,o,phase)=>{phases.push(phase);return{ok:true,targetMet:phase==='finish',level:phase==='finish'?o.target:70,ticks:phase==='finish'?22:28,banked:phase==='starter'?600:0,detail:'observed'};};
 expect(await runWineOrder('practice',{target:99,cap:80},stage)).toMatchObject({ok:true,targetMet:true,level:99,ticks:50});
 expect(phases).toEqual(['starter','finish']);
});
test('reaching target early avoids another login and leaves bulk stock alone',async()=>{
 let opened=0;
 const result=await runWineOrder('practice',{target:99,cap:80},async()=>{opened++;return{ok:true,targetMet:true,level:99,ticks:22,banked:0,detail:'already done'};});
 expect(result.ok).toBe(true);expect(opened).toBe(1);
});
test('failed settlement or missing bulk stops the order instead of retrying',async()=>{
 let opened=0;
 const result=await runWineOrder('practice',{target:99,cap:80},async()=>{opened++;return{ok:false,targetMet:false,level:70,ticks:30,banked:0,detail:'logout unconfirmed'};});
 expect(result.ok).toBe(false);expect(opened).toBe(1);
});
test('partial XP cannot satisfy an exact target; invalid budgets never log in',async()=>{
 const stage:WineStage=async()=>({ok:true,targetMet:false,level:98,ticks:30,banked:600,detail:'short'});
 expect((await runWineOrder('practice',{target:99,cap:80},stage)).ok).toBe(false);
 for(const target of [0,100,NaN])await expect(runWineOrder('practice',{target,cap:80},stage)).rejects.toThrow('invalid wine order');
});
