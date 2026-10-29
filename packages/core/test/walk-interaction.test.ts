import {test,expect,spyOn} from 'bun:test';
import * as world from '../src/world';
import {walkRoute} from '../src/walk';
import {fakeGame} from './fakegame';
const at={x:3059,z:3376,level:0},endpoint={x:3062,z:3376,level:0},to={x:3058,z:9776,level:0};
const geometry={id:1733,shape:10,angle:1,width:2,height:3,blockAccessFlags:14,src:'map:1',configSrc:'config:1'};
const leg:any={kind:'transport',loc:'stairs_cellar',option:'op1',at,to,exact:true,interaction:geometry};
function stubApproach(fn:(...a:any[])=>Promise<any>){return typeof (world as any).interactionApproach==='function'?spyOn(world as any,'interactionApproach').mockImplementation(fn):null;}
test('geometry climb walks exact operable face then dispatches without anchor prewalk',async()=>{
 const g=fakeGame({x:3059,z:3375,level:0,nearbyLocs:[{id:1733,...at}]});g.quirks.climbTo=to;const native=g.bot.interactLoc.bind(g.bot);let legacy=0,direct=0;
 g.bot.interactLoc=async()=>{legacy++;return{success:false,message:"Can't reach Staircase"};};

 // The exact ordinary SDK action must occur only from the allowed east face.
 (g.sdk as any).sendInteractLoc=async(x:number,z:number,id:number,op:number)=>{direct++;expect(g.state.player.worldX).toBe(endpoint.x);expect(g.state.player.worldZ).toBe(endpoint.z);expect({x,z,id,op}).toEqual({x:at.x,z:at.z,id:1733,op:1});return native({x,z},op);};
 const spy=stubApproach(async()=>endpoint);
 try{const r=await walkRoute(g as any,[leg],{maxRetriesPerLeg:1,legTimeoutTicks:10});expect(r.ok).toBe(true);expect(g.calls).toContain('walk 3062,3376');expect(direct).toBe(1);expect(legacy).toBe(0);}finally{spy?.mockRestore();g.stop();}
});
test('missing geometry route cannot dispatch or fall back to anchor tolerance',async()=>{
 const g=fakeGame({x:3059,z:3375,level:0,nearbyLocs:[{id:1733,...at}]});let dispatched=0;g.bot.interactLoc=async()=>{dispatched++;return{success:true};};(g.sdk as any).sendInteractLoc=async()=>{dispatched++;return{success:true};};const spy=stubApproach(async()=>null);
 try{const r=await walkRoute(g as any,[leg],{maxRetriesPerLeg:1,legTimeoutTicks:3});expect(r).toMatchObject({ok:false,reason:'rejected'});expect(dispatched).toBe(0);}finally{spy?.mockRestore();g.stop();}
});
test('explicit custom entry keeps precedence over generic interaction geometry',async()=>{
 const g=fakeGame({x:2418,z:3074,level:0,nearbyLocs:[{id:1733,x:2417,z:3074,level:0}]});g.quirks.climbTo={x:2416,z:3074,level:0};const spy=stubApproach(async()=>{throw Error('custom entry must not use generic approach');});
 try{const r=await walkRoute(g as any,[{...leg,at:{x:2417,z:3074,level:0},entry:{x:2418,z:3074,level:0},to:{x:2416,z:3074,level:0}}],{maxRetriesPerLeg:1,legTimeoutTicks:6});expect(r.ok).toBe(true);}finally{spy?.mockRestore();g.stop();}
});

test('changed identity or prerequisites during approach cannot dispatch',async()=>{
 for(const change of ['identity','skill']){
  const g=fakeGame({x:3059,z:3375,level:0,nearbyLocs:[{id:1733,...at}]});(g.state as any).skills=[{name:'Mining',level:60}];let sent=0;const original=g.bot.walkTo.bind(g.bot);
  g.bot.walkTo=async(x:number,z:number)=>{const r=await original(x,z);if(change==='identity')g.state.nearbyLocs[0].id=999;else(g.state as any).skills[0].level=59;return r;};
  (g.sdk as any).sendInteractLoc=async()=>{sent++;return{success:true};};const spy=stubApproach(async()=>endpoint);
  try{const r=await walkRoute(g as any,[{...leg,requires:{skill:{name:'mining',level:60}}}],{maxRetriesPerLeg:1,legTimeoutTicks:8});expect(r.ok).toBe(false);expect(sent).toBe(0);}finally{spy?.mockRestore();g.stop();}
 }
});
test('wrong plane cannot dispatch geometry transport',async()=>{
 const g=fakeGame({x:3059,z:3375,level:1,nearbyLocs:[{id:1733,...at}]});let sent=0;(g.sdk as any).sendInteractLoc=async()=>{sent++;return{success:true};};const spy=stubApproach(async()=>endpoint);
 try{expect(await walkRoute(g as any,[leg],{maxRetriesPerLeg:1,legTimeoutTicks:3})).toMatchObject({ok:false,reason:'precondition'});expect(sent).toBe(0);}finally{spy?.mockRestore();g.stop();}
});
test('shared leg timeout cancels a slow approach before interaction dispatch',async()=>{
 const g=fakeGame({x:3059,z:3375,level:0,nearbyLocs:[{id:1733,...at}]});let sent=0;
 g.bot.walkTo=async()=>{await new Promise(r=>setTimeout(r,80));return{success:true};};(g.sdk as any).sendInteractLoc=async()=>{sent++;return{success:true};};const spy=stubApproach(async()=>endpoint);
 try{const r=await walkRoute(g as any,[leg],{maxRetriesPerLeg:1,legTimeoutTicks:2});expect(r).toMatchObject({ok:false,reason:'timeout'});await new Promise(r=>setTimeout(r,100));expect(sent).toBe(0);}finally{spy?.mockRestore();g.stop();}
});
