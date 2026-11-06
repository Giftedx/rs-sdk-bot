import {describe,it,expect} from 'bun:test';
import {RECIPES,selectRecipe,supplyPlan,supplyPurchases,reconcile,options,reachSeller,observeHerbloreStep,boundedHerbloreMove,tracedWalker,workingBatch} from './brew-potions';
import {executionContext,throwIfExecutionAborted} from '../vendor/rs-sdk/sdk/execution-context';
import type {Session} from '../packages/core/src/inprocess';
import {sellersByDistance} from '../packages/core/src/shop-index';
import {goTo} from '../packages/core/src/walk';
import type {World} from '../packages/core/src/world';
import {fakeGame} from '../packages/core/test/fakegame';
describe('herblore orders',()=>{
 it('passes the deadline through real goTo and stops before another route leg',async()=>{
  const g=fakeGame({x:2655,z:3283,level:0});g.state.equipment=[];
  g.bot.walkTo=()=>{g.calls.push('pending walk');return new Promise(()=>{});};
  const to={x:2665,z:3283,level:0};
  const world={route:()=>({ok:true,cost:2,legs:[{kind:'walk',to},{kind:'walk',to:{...to,x:2675}}]})} as unknown as World;
  try{
   const result=await boundedHerbloreMove(g as unknown as Session,signal=>goTo(g,world,to,{skills:{},varps:{},items:[]},{signal,legTimeoutTicks:100}),3);
   expect(result).toMatchObject({ok:false,reason:'timeout',ticks:3});
   expect(g.calls).toEqual(['pending walk']);
  }finally{g.stop();}
 });
 it('cancels a seller that never returns and tries the next seller without late actions',async()=>{
  let tick=0,signal:AbortSignal|undefined,late!:()=>void,lateSent=false;
  const listeners=new Set<()=>void>(),at={x:2655,z:3283,level:0};
  const s={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getState:()=>({})}} as unknown as Session;
  let attempts=0;
  const pending=reachSeller('eye_of_newt',at,()=>boundedHerbloreMove(s,async abort=>{
   attempts++;
   if(attempts>1)return {ok:true,ticks:0};
   signal=abort;expect(executionContext.getStore()?.signal).toBe(abort);
   await new Promise<void>(resolve=>{late=resolve;});
   throwIfExecutionAborted();lateSent=true;return {ok:true,ticks:0};
  },3));
  for(let i=0;i<3;i++){tick++;for(const cb of [...listeners])cb();await Promise.resolve();}
  expect(await pending).toEqual(sellersByDistance('eye_of_newt',at)[1]!);
  expect(attempts).toBe(2);expect(signal?.aborted).toBe(true);expect(listeners.size).toBe(0);
  late();await Promise.resolve();await Promise.resolve();expect(lateSent).toBe(false);
 });
 it('identifies a pending seller call after bank closure without claiming return',async()=>{
  const lines:string[]=[];
  const s={tick:()=>1118,sdk:{getState:()=>({player:{worldX:2655,worldZ:3283,level:0},bank:{isOpen:false},interface:{isOpen:false}}),getInventory:()=>[{id:995,count:1000}]}} as unknown as Session;
  const log=(line:string)=>lines.push(line);
  await observeHerbloreStep('buy 221: close bank',s,async()=>({success:true}),log);
  let resolve!: (value:{ok:boolean})=>void;
  const pending=observeHerbloreStep('buy 221: goTo 2808,3342,0',s,()=>new Promise<{ok:boolean}>(r=>{resolve=r;}),log);
  const rows=()=>lines.map(line=>JSON.parse(line.slice('HERBLORE_STEP '.length)));
  expect(rows().map(r=>[r.step,r.phase])).toEqual([
   ['buy 221: close bank','enter'],['buy 221: close bank','return'],['buy 221: goTo 2808,3342,0','enter']]);
  expect(rows().at(-1)).toMatchObject({tick:1118,position:{x:2655,z:3283,level:0},coins:1000,bank:false});
  resolve({ok:false});expect(await pending).toEqual({ok:false});
  expect(rows().at(-1).phase).toBe('return');
  const error=Error('no route');
  await expect(observeHerbloreStep('seller',s,async()=>{throw error;},log)).rejects.toBe(error);
  expect(rows().at(-1)).toMatchObject({phase:'throw',error:'Error: no route'});
 });
 it('skips a nearest seller with no route for both supplies and refuses when none is reachable',async()=>{
  const at={x:3092,z:3243,level:0};
  for(const item of ['vial_water','eye_of_newt']){
   const candidates=sellersByDistance(item,at),visited:typeof at[]=[];
   expect(candidates.length).toBeGreaterThan(1);
   const seller=await reachSeller(item,at,async tile=>{
    visited.push(tile);
    return visited.length===1?{ok:false,reason:'precondition',detail:'no route'}:{ok:true};
   });
   expect(visited).toEqual([candidates[0]!.tile,candidates[1]!.tile]);
   expect(seller).toEqual(candidates[1]!);
   let attempts=0;
   await expect(reachSeller(item,at,async()=>{attempts++;return {ok:false,reason:'precondition',detail:'no route'};})).rejects.toThrow(`no reachable seller for ${item}`);
   expect(attempts).toBe(candidates.length);
  }
 });
 it('uses exact guam IDs despite generic names',()=>{expect(RECIPES.attack).toMatchObject({dirty:199,clean:249,unf:91,sec:221,pot:121});});
 it('chooses the highest usable owned herb and respects explicit recipes',()=>{
  expect(selectRecipe(46,{199:4,209:2}).key).toBe('super_attack');
  expect(selectRecipe(44,{199:4,209:2}).key).toBe('attack');
  expect(()=>selectRecipe(46,{})).toThrow('herbs missing');
  expect(()=>selectRecipe(46,{199:4},'prayer')).toThrow('herbs missing');
 });
 it('buys only shortfalls and refuses over budget or without owned coins',()=>{
  expect(supplyPlan(5,2,3,100,1000,1000)).toEqual({vials:3,eyes:2,reserve:18});
  expect(()=>supplyPlan(5,0,5,100,19,1000)).toThrow('vial budget');
  expect(()=>supplyPlan(501,0,501,10000,1000,1000)).toThrow('vial budget');
  expect(()=>supplyPlan(5,0,0,1,1000,1000)).toThrow('coins');
 });
 it('buys eyes before vials and starts no trip while the next potion has supplies',()=>{
  expect(supplyPurchases({batch:27,make:27,vials:0,eyes:0,buyEyes:true})).toEqual([[221,27],[227,27]]);
  expect(supplyPurchases({batch:27,make:27,vials:26,eyes:26,buyEyes:true})).toEqual([]);
  expect(supplyPurchases({batch:27,make:27,vials:0,eyes:5,buyEyes:true})).toEqual([[221,22],[227,27]]);
  expect(supplyPurchases({batch:27,make:27,vials:0,eyes:0,buyEyes:false})).toEqual([[227,27]]);
 });
 it('counts game actions sent through a traced walker',async()=>{
  const s={direct:async()=>'sent',bot:{walkTo:async()=>'walked'},name:'x'};
  const trace=tracedWalker(s as unknown as Session);
  expect(trace.sent()).toBe(0);expect(trace.walker.name).toBe('x');
  expect(await trace.walker.direct({type:'walkTo'})).toBe('sent');
  expect(await (trace.walker.bot.walkTo as unknown as ()=>Promise<string>)()).toBe('walked');
  expect(trace.sent()).toBe(2);
 });
 it('checks all assets including undeclared loss',()=>{
  expect(reconcile({199:2,995:100,952:1},{199:1,121:1,995:95,952:1},{199:-1,121:1,995:-5})).toBe(true);
  expect(reconcile({952:1},{},{})).toBe(false);
 });
 it('keeps finite CAP and validates target and budgets',()=>{
  expect(options(['Mightyrod','6000'],{TARGET_LEVEL:'50'})).toMatchObject({cap:6000,target:50,recipe:'auto',vialBudget:1000});
  for(const env of [{TARGET_LEVEL:'0'},{VIAL_BUDGET:'1001'},{CAP:'Infinity'}])expect(()=>options(['x'],env)).toThrow();
  expect(options(['x','300','prayer'],{}).recipe).toBe('prayer');
 });
});

it('the owned secondaries limit the working batch',()=>{
 expect(workingBatch(0,27,1)).toBe(1);
 expect(workingBatch(5,0,27)).toBe(5);
 expect(workingBatch(30,0,40)).toBe(27);
 expect(workingBatch(3,0,0)).toBe(0);
});
