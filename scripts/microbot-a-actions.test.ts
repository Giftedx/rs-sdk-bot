import {test,expect} from 'bun:test';
import {validateActionGraph,runActionGraph,type ActionGraph} from './microbot-a-actions';
const plan:ActionGraph={start:'a',maximum:2,cap:10,nodes:[{id:'a',action:{kind:'item',id:1,optionIndex:1},effect:{kind:'inventory',id:2,delta:1},timeout:3}]};
test('JSON graph refuses unbounded execution and missing effect/edges',()=>{
 expect(()=>validateActionGraph({...plan,maximum:Infinity})).toThrow();expect(()=>validateActionGraph({...plan,nodes:[{...plan.nodes[0]!,next:'missing'}]})).toThrow();expect(()=>validateActionGraph({...plan,nodes:[{...plan.nodes[0]!,action:{kind:'eval',code:'x'} as any}]})).toThrow();
});
test('graph confirms relative output and ends; dispatch acknowledgement alone fails',async()=>{
 let tick=0,n=0;const io={tick:()=>tick,stopped:()=>false,read:()=>({inventory:{2:n},skills:{},position:null}),dispatch:async()=>{n++;return true},wait:async(p:()=>boolean)=>{tick++;return p()}};
 expect((await runActionGraph(io,plan)).ok).toBe(true);expect((await runActionGraph({...io,dispatch:async()=>true},plan)).ok).toBe(false);
});
test('cyclic graph stops at finite node budget and honors stop before action',async()=>{
 let tick=0,n=0;const cyclic={...plan,nodes:[{...plan.nodes[0]!,next:'a'}]};const io={tick:()=>tick,stopped:()=>false,read:()=>({inventory:{2:n},skills:{},position:null}),dispatch:async()=>{n++;return true},wait:async(p:()=>boolean)=>{tick++;return p()}};
 const r=await runActionGraph(io,cyclic);expect(r.ok).toBe(false);expect(r.steps).toBe(2);expect((await runActionGraph({...io,stopped:()=>true},plan)).steps).toBe(0);
});
