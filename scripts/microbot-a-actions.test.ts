import {test,expect} from 'bun:test';
import {validateActionGraph,runActionGraph,sessionGraphIO,actionSessionOwner,finishActionSession,graphCondition,type ActionGraph,type GraphObservation} from './microbot-a-actions';
import {BotSDK} from '../vendor/rs-sdk/sdk/index';
import {readFileSync} from 'node:fs';
import type {Session} from '../packages/core/src/inprocess';
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

const pickupPlan=():ActionGraph=>({start:'take',maximum:2,cap:10,nodes:[{id:'take',action:{kind:'ground-item',id:561,x:3001,z:3500,level:0,count:3},effect:{kind:'inventory',id:561,delta:3},timeout:3}]});

test('ground graph requires an exact declared pile and matching positive inventory receipt',()=>{
 expect(()=>validateActionGraph(pickupPlan())).not.toThrow();
 for(const change of [{count:0},{count:1.5},{level:4},{x:-1},{count:2147483648}]){
  const p=pickupPlan();Object.assign(p.nodes[0]!.action,change);expect(()=>validateActionGraph(p)).toThrow();
 }
 for(const effect of [{kind:'inventory',id:561,delta:2},{kind:'inventory',id:995,delta:3},{kind:'xp',skill:'Magic',minimum:1}]){
  const p=pickupPlan();p.nodes[0]!.effect=effect as any;expect(()=>validateActionGraph(p)).toThrow();
 }
});

test('ground graph confirms the whole pack rather than only the picked-up item',async()=>{
 let inventory:Record<number,number>={995:37},tick=0;
 const io={tick:()=>tick,stopped:()=>false,read:()=>({inventory:{...inventory},skills:{},position:null}),dispatch:async()=>{inventory={995:37,561:3};return true;},wait:async(p:()=>boolean)=>{tick++;return p();}};
 expect((await runActionGraph(io,pickupPlan())).ok).toBe(true);
 inventory={995:37};expect((await runActionGraph({...io,dispatch:async()=>{inventory={995:36,561:3};return true;}},pickupPlan())).ok).toBe(false);
});

test('an acknowledged action with no observed effect stops before a failure-edge retry',async()=>{
 let inputs=0,tick=0;const p=structuredClone(plan);p.nodes[0]!.failure='a';
 const r=await runActionGraph({tick:()=>tick,stopped:()=>false,read:()=>({inventory:{},skills:{},position:null}),dispatch:async()=>{inputs++;return true;},wait:async()=>{tick++;return false;}},p);
 expect(inputs).toBe(1);expect(r.ok).toBe(false);expect(r.stop).toBe('effect uncertain');
});

test('a target missing before dispatch may follow the declared failure edge',async()=>{
 let calls=0;const p=structuredClone(plan);p.nodes.push({...p.nodes[0]!,id:'b'});p.nodes[0]!.failure='b';
 const r=await runActionGraph({tick:()=>0,stopped:()=>false,read:()=>({inventory:{2:calls===2?1:0},skills:{},position:null}),dispatch:async()=>++calls===2,wait:async predicate=>predicate()},p);
 expect(calls).toBe(2);expect(r.confirmed).toBe(1);expect(r.ok).toBe(false);
});

function pickupSession(){
 let stopped=false;const calls:number[][]=[];
 const state:any={player:{worldX:3000,worldZ:3500,level:0,lifeId:1,isDead:false},inventory:[{id:995,count:37,slot:0}],skills:[{name:'Hitpoints',level:10,experience:100}],groundItems:[{id:561,name:'Nature rune',count:3,x:3001,z:3500,distance:1,reachable:true}],nearbyPlayers:[]};
 let definition:any={cost:180,stackable:true},success=true;
 const s={name:'ActionOwned',ended:new Promise(()=>{}),tick:()=>0,client:{selfSlot:1,executeBotAction:()=>({success:true}),objType:()=>definition},sdk:{getState:()=>state,getInventory:()=>state.inventory,getSkill:()=>({level:10}),sendPickup:async(...args:number[])=>{calls.push(args);return{success};}}} as unknown as Session;
 return{s,state,calls,io:()=>sessionGraphIO(s,()=>stopped),stop:()=>{stopped=true;},definition:(d:any)=>{definition=d;},refuse:()=>{success=false;}};
}

test('session ground dispatch selects exact ID, coordinates, plane and count',async()=>{
 const f=pickupSession(),io=f.io();expect(await io.dispatch(pickupPlan().nodes[0]!.action)).toBe(true);expect(f.calls).toEqual([[3001,3500,561]]);
 for(const change of [{id:560},{x:3002},{count:4},{reachable:false},{distance:13}]){
  const other=pickupSession();Object.assign(other.state.groundItems[0],change);expect(await other.io().dispatch(pickupPlan().nodes[0]!.action)).toBe(false);expect(other.calls).toHaveLength(0);
 }
 const other=pickupSession();other.state.player.level=1;expect(await other.io().dispatch(pickupPlan().nodes[0]!.action)).toBe(false);expect(other.calls).toHaveLength(0);
});

test('session ground dispatch reuses capacity checks and refuses unknown metadata or stopped work',async()=>{
 for(const definition of [undefined,{cost:180,stackable:false}]){
  const f=pickupSession();f.definition(definition);f.state.inventory=Array.from({length:28},(_,slot)=>({id:slot+1000,count:1,slot}));
  expect(await f.io().dispatch(pickupPlan().nodes[0]!.action)).toBe(false);expect(f.calls).toHaveLength(0);
 }
 const f=pickupSession();f.stop();expect(await f.io().dispatch(pickupPlan().nodes[0]!.action)).toBe(false);expect(f.calls).toHaveLength(0);
});

test('a full pack may receive an existing stack but cannot overflow its native count',async()=>{
 const f=pickupSession();f.state.inventory=Array.from({length:28},(_,slot)=>({id:slot===0?561:1000+slot,count:1,slot}));
 expect(await f.io().dispatch(pickupPlan().nodes[0]!.action)).toBe(true);expect(f.calls).toHaveLength(1);
 f.state.inventory[0].count=2147483646;expect(await f.io().dispatch(pickupPlan().nodes[0]!.action)).toBe(false);expect(f.calls).toHaveLength(1);
});

test('a pickup dispatch refusal is uncertain and cannot take the retry edge',async()=>{
 const f=pickupSession();f.refuse();const p=pickupPlan();p.nodes[0]!.failure='take';
 const r=await runActionGraph(f.io(),p);expect(f.calls).toHaveLength(1);expect(r.ok).toBe(false);expect(r.stop).toBe('dispatch uncertain');
});

test('replay conditions use current levels, exact inventory totals and bounded target presence',()=>{
 const s:GraphObservation={inventory:{561:3},skills:{Prayer:10000},levels:{Prayer:12,Hitpoints:40},npcs:[{id:81,distance:2}],locs:[{id:123,distance:21}],position:null};
 expect(graphCondition({kind:'stat',skill:'Prayer',comparator:'below',threshold:13},s)).toBe(true);
 expect(graphCondition({kind:'stat',skill:'Prayer',comparator:'above',threshold:12},s)).toBe(false);
 expect(graphCondition({kind:'inventory',id:561,minimum:3,present:true},s)).toBe(true);
 expect(graphCondition({kind:'inventory',id:561,minimum:4,present:false},s)).toBe(true);
 expect(graphCondition({kind:'npc',id:81,radius:20,present:true},s)).toBe(true);
 expect(graphCondition({kind:'loc',id:123,radius:20,present:false},s)).toBe(true);
 expect(graphCondition({kind:'npc',id:81,radius:20,present:false},{...s,npcs:undefined})).toBeUndefined();
 expect(graphCondition({kind:'stat',skill:'Prayer',comparator:'below',threshold:13},{...s,levels:undefined})).toBeUndefined();
});

test('replay delay uses ticks, then evaluates the condition on fresh state',async()=>{
 const p=structuredClone(plan);p.nodes[0]!.delayTicksBefore=3;p.nodes[0]!.condition={kind:'inventory',id:561,minimum:1,present:true};
 let tick=0,count=0;const dispatchTicks:number[]=[];
 const r=await runActionGraph({tick:()=>tick,stopped:()=>false,read:()=>({inventory:{561:tick>=3?1:0,2:count},skills:{},position:null}),dispatch:async()=>{dispatchTicks.push(tick);count++;return true;},wait:async(predicate,ticks)=>{for(let i=0;i<ticks&&!predicate();i++)tick++;return predicate();}},p);
 expect(r.ok).toBe(true);expect(dispatchTicks).toEqual([3]);
});

test('false conditions skip a step without an input or a false effect receipt',async()=>{
 const p=structuredClone(plan);p.nodes[0]!.condition={kind:'inventory',id:561,minimum:1,present:true};
 let inputs=0;const r=await runActionGraph({tick:()=>0,stopped:()=>false,read:()=>({inventory:{},skills:{},position:null}),dispatch:async()=>{inputs++;return true;},wait:async p=>p()},p);
 expect(inputs).toBe(0);expect(r).toMatchObject({ok:true,confirmed:0,skipped:1});expect(r.receipts[0]).toMatchObject({effect:false,skipped:true});
});

test('unknown conditions and interrupted delays cannot send an action',async()=>{
 const p=structuredClone(plan);p.nodes[0]!.condition={kind:'stat',skill:'Prayer',comparator:'below',threshold:20};
 let inputs=0,tick=0;const io={tick:()=>tick,stopped:()=>false,read:()=>({inventory:{},skills:{},position:null}),dispatch:async()=>{inputs++;return true;},wait:async()=>false};
 expect((await runActionGraph(io,p)).stop).toBe('condition unknown');
 p.nodes[0]!.condition=undefined;p.nodes[0]!.delayTicksBefore=3;
 expect((await runActionGraph(io,p)).ok).toBe(false);
 expect((await runActionGraph({...io,stopped:()=>tick>=1,wait:async()=>{tick++;return true;}},p)).ok).toBe(false);
 expect(inputs).toBe(0);
});

test('graph rejects malformed delays, conditions and required action fields before execution',()=>{
 for(const change of [{delayTicksBefore:-1},{delayTicksBefore:1.5},{delayTicksBefore:100001},{condition:{kind:'stat',skill:'Prayer',comparator:'equal',threshold:1}},{condition:{kind:'npc',id:81,radius:21,present:true}},{condition:{kind:'inventory',id:561,minimum:0,present:true}}]){
  const p=structuredClone(plan);Object.assign(p.nodes[0]!,change);expect(()=>validateActionGraph(p)).toThrow();
 }
 for(const action of [{kind:'npc',id:81},{kind:'loc',id:123,option:3},{kind:'item',id:561},{kind:'item-on-item',id:561}]){
  const p=structuredClone(plan);p.nodes[0]!.action=action as any;expect(()=>validateActionGraph(p)).toThrow();
 }
});


test('walk dispatch uses the pinned native executor discriminant rather than unsupported walk',async()=>{
 const source=readFileSync(new URL('../vendor/rs-sdk/server/webclient/src/bot/ActionExecutor.ts',import.meta.url),'utf8'),cases=new Set([...source.matchAll(/case '([^']+)'/g)].map(m=>m[1]));expect(cases.has('walkTo')).toBe(true);expect(cases.has('walk')).toBe(false);
 const f=pickupSession(),actions:any[]=[];(f.s as any).direct=async(a:any)=>{actions.push(a);return{success:cases.has(a.type)};};expect(await f.io().dispatch({kind:'walk',x:3001,z:3500})).toBe(true);expect(actions).toEqual([{type:'walkTo',x:3001,z:3500,reason:'finite observed graph'}]);
});

test('scalar identity rejects mutable life/respawn, SDK/server/client/executor replacement before input',async()=>{
 for(const change of [(f:any)=>f.state.player.lifeId++,(f:any)=>f.state.player.respawnCount=1,(f:any)=>f.s.client={...f.s.client},(f:any)=>f.s.client.executeBotAction=()=>({success:true}),(f:any)=>f.s.sdk={...f.s.sdk}]){
  const f=pickupSession(),io=f.io();change(f);expect(io.stopped()).toBe(true);expect(await io.dispatch(pickupPlan().nodes[0]!.action)).toBe(false);expect(f.calls).toHaveLength(0);
 }
 const f=pickupSession();(f.s.sdk as any).config={host:'localhost',port:19082};const io=f.io();(f.s.sdk as any).config.port=8888;expect(io.stopped()).toBe(true);expect(await io.dispatch(pickupPlan().nodes[0]!.action)).toBe(false);
});

test('real SDK reconnect and delayed pickup cannot wire after original owner or life changes',async()=>{
 for(const mode of ['executor','life','client','stop']){
  const f=pickupSession();let wires=0,stop=false;const sdk:any=new BotSDK({botUsername:'ActionOwned',actionTimeout:20});Object.assign(sdk,{getState:()=>f.state,getInventory:()=>f.state.inventory,getSkill:()=>({level:10})});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();if(mode==='executor')(f.s.client as any).executeBotAction=()=>({success:true});if(mode==='life')f.state.player.lifeId++;if(mode==='client')(f.s as any).client={...(f.s.client as object)};if(mode==='stop')stop=true;sdk.connectionState='connected';};(f.s as any).sdk=sdk;
  const io=sessionGraphIO(f.s,()=>stop);await expect(io.dispatch(pickupPlan().nodes[0]!.action)).rejects.toThrow();expect(wires).toBe(0);
 }
 const f=pickupSession();let release!:()=>void,wires=0;const sdk:any=f.s.sdk;sdk.send=()=>{wires++;return{success:true};};sdk.sendPickup=async function(){await new Promise<void>(r=>{release=r;});return this.send();};const io=f.io(),pending=io.dispatch(pickupPlan().nodes[0]!.action);(f.s.client as any).executeBotAction=()=>({success:true});release();await expect(pending).rejects.toThrow('original');expect(wires).toBe(0);
});

test('shared action settlement skips foreign context but permits original stopped cleanup and custom STOP_FILE',async()=>{
 const old=process.exitCode,prior=process.env.STOP_FILE;try{process.env.STOP_FILE='local-test-selected-stop';const f=pickupSession();const owner=actionSessionOwner(f.s,()=>false,p=>p==='local-test-selected-stop');expect(owner.stopped()).toBe(true);let settlements=0;await finishActionSession(owner,false,'stopped',async(s,_ok,_detail,opts)=>{expect(s).toHaveLength(1);expect(s[0]).toBe(f.s);await opts!.logout!(s[0]!);settlements++;},async(view)=>{expect(view).not.toBe(f.s);expect(view.client).toBe(f.s.client);return'logged-out';});expect(settlements).toBe(1);
 for(const change of [(g:any)=>g.state.player.lifeId++,(g:any)=>g.s.client.executeBotAction=()=>({success:true})]){const g=pickupSession(),o=actionSessionOwner(g.s);change(g);expect(await finishActionSession(o,false,'foreign',async()=>{settlements++;})).toMatchObject({recoveryDeferred:true});}expect(settlements).toBe(1);
 }finally{process.exitCode=old??0;if(prior===undefined)delete process.env.STOP_FILE;else process.env.STOP_FILE=prior;}
});


test('guarded logout must confirm before original-session bookkeeping; timeout or handoff cannot finalize',async()=>{
 const previous=process.exitCode;try{for(const outcome of ['logged-out','timeout','handoff']){const f=pickupSession(),o=actionSessionOwner(f.s);let final=0,logouts=0;await finishActionSession(o,true,'finish',async(sessions,_ok,_detail,opts)=>{expect(sessions[0]).toBe(f.s);await opts!.logout!(sessions[0]!);final++;},async view=>{logouts++;expect(view).toBe(o.cleanup);if(outcome==='handoff')(f.s.client as {executeBotAction?:unknown}).executeBotAction=()=>({success:true});return outcome==='timeout'?'timed-out':'logged-out';});expect(logouts).toBe(1);expect(final).toBe(outcome==='logged-out'?1:0);}}finally{process.exitCode=previous??0;}
});


test('allowDamage is explicit opt-in; default graph damage guard remains and every opted-in send requires positive original HP',async()=>{
 const f=pickupSession(),raw:any=f.s;raw.sdk.getSkill=()=>({level:f.state.skills[0].level});let inputs=0;raw.sdk.sendCloseModal=async()=>{inputs++;return{success:true};};const normal=actionSessionOwner(f.s),escape=actionSessionOwner(f.s,()=>false,()=>false,{allowDamage:true});f.state.skills[0].level=9;expect(normal.stopped()).toBe(true);expect(()=>normal.session.sdk.sendCloseModal()).toThrow();expect(escape.stopped()).toBe(false);await escape.session.sdk.sendCloseModal();expect(inputs).toBe(1);f.state.skills[0].level=0;expect(escape.own()).toBe(false);expect(()=>escape.session.sdk.sendCloseModal()).toThrow();expect(()=>escape.cleanup.direct({type:'logout'})).toThrow();expect(inputs).toBe(1);
});
