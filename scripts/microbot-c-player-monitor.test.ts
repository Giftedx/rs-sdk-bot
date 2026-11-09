import {expect,test} from 'bun:test';
import{BotSDK}from'../vendor/rs-sdk/sdk/index';import{actionSessionOwner}from'./microbot-a-actions';
import {monitorPlayers,settleMonitorSession,monitorWildernessLevel,monitorStopRequested,validateMonitorPolicy,type MonitorPolicy} from './microbot-c-player-monitor';
function fixture(){
 let tick=0;const calls:number[][]=[],state:any={player:{lifeId:1,respawnCount:0,level:0},nearbyPlayers:[{name:'OwnedPeer',index:2,distance:2}],inventory:[{id:121,name:'Attack potion(3)',slot:4,count:1,optionsWithIndex:[{text:'Drink',opIndex:2}]}],interface:{isOpen:false},dialog:{isOpen:false},bank:{isOpen:false}};
 const s:any={name:'MonitorOwned',client:{selfSlot:1,executeBotAction:()=>({success:true})},ended:new Promise(()=>{}),tick:()=>tick,onTick:(cb:()=>void)=>{let live=true;const step=()=>queueMicrotask(()=>{if(live){tick++;cb();step();}});step();return()=>{live=false;};},sdk:{getState:()=>state,getSkill:()=>({level:99}),sendUseItem:async(slot:number,op:number)=>{calls.push([slot,op]);state.inventory=[{id:123,name:'Attack potion(2)',slot:4,count:1,optionsWithIndex:[{text:'Drink',opIndex:2}]}];return{success:true};}}};
 const policy:MonitorPolicy={radius:4,ignore:[],onlyNew:false,action:'item',itemAction:{id:121,option:'Drink',expectedDelta:{121:-1,123:1}}};return{s,state,calls,policy};
}
test('player trigger uses observed option index and exact configured inventory transform once',async()=>{const f=fixture();expect(await monitorPlayers(f.s,f.policy,20)).toMatchObject({ok:true,action:'item',item:{attempted:true,confirmed:true}});expect(f.calls).toEqual([[4,2]]);});
test('exact name selection uses fresh native option',async()=>{const f=fixture();f.policy.itemAction={name:'Attack potion(3)',option:'Drink',expectedDelta:{121:-1,123:1}};expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(true);expect(f.calls).toEqual([[4,2]]);});
test('unknown outcome is bounded and never retried',async()=>{const f=fixture();f.s.sdk.sendUseItem=async(slot:number,op:number)=>{f.calls.push([slot,op]);return{success:true};};const r=await monitorPlayers(f.s,f.policy,20);expect(r).toMatchObject({ok:false,item:{attempted:true,confirmed:false}});expect(r.ticks).toBeLessThanOrEqual(8);expect(f.calls).toHaveLength(1);});
test('refused input never retries even if a transform appears',async()=>{const f=fixture();f.s.sdk.sendUseItem=async()=>{f.calls.push([4,2]);return{success:false,message:'refused'};};expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);expect(f.calls).toHaveLength(1);});
test('missing, ambiguous and unknown options never dispatch',async()=>{for(const mode of ['missing','duplicate','option','modal']){const f=fixture();if(mode==='missing')f.state.inventory=[];if(mode==='duplicate')f.state.inventory.push({...f.state.inventory[0],slot:5});if(mode==='option')f.state.inventory[0].optionsWithIndex=[];if(mode==='modal')f.state.dialog.isOpen=true;expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);expect(f.calls).toHaveLength(0);}});
test('stopped life never dispatches; default stop remains intact',async()=>{const f=fixture();expect((await monitorPlayers(f.s,f.policy,20,()=>true)).ok).toBe(false);expect(f.calls).toHaveLength(0);expect(await monitorPlayers(f.s,{...f.policy,action:'stop'},20)).toMatchObject({ok:true,action:'stop'});expect(f.calls).toHaveLength(0);});
test('life change and unrelated inventory changes invalidate paid outcomes',async()=>{for(const mode of ['life','stock','throw']){const f=fixture(),send=f.s.sdk.sendUseItem;f.s.sdk.sendUseItem=async(slot:number,op:number)=>{const result=await send(slot,op);if(mode==='life')f.state.player.lifeId=2;if(mode==='stock')f.state.inventory.push({id:995,count:1,slot:6});if(mode==='throw')throw Error('transport outcome unknown');return result;};expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);expect(f.calls).toHaveLength(1);}});
test('unknown life and a receipt not debiting selected item cannot dispatch',async()=>{for(const mode of ['life','receipt']){const f=fixture();if(mode==='life')delete f.state.player.lifeId;else f.policy.itemAction!.expectedDelta={995:1};expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);expect(f.calls).toHaveLength(0);}});
test('native-derived wilderness includes surface and dungeon boundaries without treating missing position as outside',()=>{expect(monitorWildernessLevel({worldX:3185,worldZ:3436,level:0})).toBe(0);expect(monitorWildernessLevel({worldX:2944,worldZ:3520,level:0})).toBe(1);expect(monitorWildernessLevel({worldX:2944,worldZ:9928,level:0})).toBe(2);expect(monitorWildernessLevel({worldX:2944,worldZ:9928,level:1})).toBe(0);expect(monitorWildernessLevel(undefined)).toBeUndefined();});
test('wilderness-only suppresses town trigger and admits observed native wilderness trigger',async()=>{const f=fixture();Object.assign(f.state.player,{worldX:3185,worldZ:3436});f.policy.wildernessOnly=true;expect(await monitorPlayers(f.s,f.policy,3)).toMatchObject({ok:true,action:'none'});expect(f.calls).toHaveLength(0);Object.assign(f.state.player,{worldX:3100,worldZ:3530});expect(await monitorPlayers(f.s,f.policy,20)).toMatchObject({ok:true,action:'item'});expect(f.calls).toHaveLength(1);});
test('global and account stop files block the exported monitor before an item input',async()=>{for(const path of ['.practice/stop-all','.practice/stop-monitorTest']){const f=fixture();f.s.name='monitorTest';expect(await monitorPlayers(f.s,f.policy,20,()=>false,p=>p===path)).toMatchObject({ok:false,detail:'stop requested'});expect(f.calls).toHaveLength(0);}});
test('explicit role stop file uses the same stop predicate without writing shared files',()=>{expect(monitorStopRequested('monitorTest',()=>false,p=>p==='owned-role.stop','owned-role.stop')).toBe(true);expect(monitorStopRequested('monitorTest',()=>false,()=>false,'owned-role.stop')).toBe(false);expect(monitorStopRequested('monitorTest',()=>true,()=>false,undefined)).toBe(true);});

const destinations={'Edgeville':{x:3087,z:3496},'Karamja':{x:2918,z:3176},'Draynor Village':{x:3105,z:3251},'Al Kharid':{x:3293,z:3163}};
function gloryFixture(destination:keyof typeof destinations='Edgeville',id=1712,next=1710){
 const f=fixture();Object.defineProperty(f.state,'tick',{configurable:true,get:()=>f.s.tick()});Object.assign(f.state.player,{worldX:3100,worldZ:3530});
 f.s.client={selfSlot:1,membersAccount:1,executeBotAction:()=>{}};f.s.sdk.getStateAge=()=>0;f.s.sdk.getDialog=()=>f.state.dialog;
 f.state.skills=[{name:'Hitpoints',level:99,experience:1000},{name:'Magic',level:40,experience:1000}];f.state.equipment=[];
 f.state.inventory=[{id,name:'Amulet of glory(4)',slot:4,count:1,optionsWithIndex:[{text:'Rub',opIndex:4}]},{id:995,count:37,slot:5}];
 f.policy.wildernessOnly=true;f.policy.itemAction={id,option:'Rub',expectedDelta:{[id]:-1,[next]:1},teleport:{destination}} as any;
 f.s.sdk.sendUseItem=async(slot:number,op:number)=>{f.calls.push([slot,op]);f.state.dialog={isOpen:true,isWaiting:false,options:Object.keys(destinations).map((text,index)=>({text:text+'.',index:index+1}))};return{success:true};};
 f.s.sdk.sendClickDialog=async(index:number)=>{f.calls.push([-1,index]);f.state.dialog={isOpen:false};f.state.inventory[0]={...f.state.inventory[0],id:next};Object.assign(f.state.player,{worldX:destinations[destination].x,worldZ:destinations[destination].z,level:0});return{success:true};};
 return f;
}

test('monitor Glory escape confirms all four native destinations and exact charge replacement',async()=>{
 for(const destination of Object.keys(destinations) as (keyof typeof destinations)[]){
  const f=gloryFixture(destination);const r=await monitorPlayers(f.s,f.policy,30);
  expect(r).toMatchObject({ok:true,item:{attempted:true,confirmed:true}});expect(f.calls).toEqual([[4,4],[-1,Object.keys(destinations).indexOf(destination)+1]]);
 }
 const f=gloryFixture('Edgeville',1706,1704);expect((await monitorPlayers(f.s,f.policy,30)).ok).toBe(true);
});

test('Glory escape requires both landing and exact whole-pack payment',async()=>{
 for(const mode of ['landing','charge','unrelated','xp','gear']){
  const f=gloryFixture(),choose=f.s.sdk.sendClickDialog;
  f.s.sdk.sendClickDialog=async(index:number)=>{const r=await choose(index);if(mode==='landing')f.state.player.worldX++;if(mode==='charge')f.state.inventory[0].id=1712;if(mode==='unrelated')f.state.inventory[1].count--;if(mode==='xp')f.state.skills[1].experience++;if(mode==='gear')f.state.equipment.push({id:1,slot:3,count:1});return r;};
  const r=await monitorPlayers(f.s,f.policy,30);expect(r.ok).toBe(false);expect(f.calls.filter(c=>c[0]===4)).toHaveLength(1);
 }
});

test('Glory admission refuses wrong costs, unsupported destination, missing membership, stale state and deep wilderness',async()=>{
 for(const mode of ['cost','destination','member','stale','deep','owner']){
  const f=gloryFixture();if(mode==='cost')f.policy.itemAction!.expectedDelta={1712:-1,1708:1};if(mode==='destination')(f.policy.itemAction as any).teleport.destination='Ferox';if(mode==='member')f.s.client.membersAccount=0;if(mode==='stale')f.s.sdk.getStateAge=()=>6000;if(mode==='deep')f.state.player.worldZ=3760;if(mode==='owner')f.s.client.executeBotAction=undefined;
  try{expect((await monitorPlayers(f.s,f.policy,30)).ok).toBe(false);}catch(error){expect(String(error)).toContain('teleport');}expect(f.calls).toHaveLength(0);
 }
});

test('retained or unknown Glory dialogue is never blindly answered or rubbed again',async()=>{
 for(const mode of ['unknown','retained']){
  const f=gloryFixture(),rub=f.s.sdk.sendUseItem;
  if(mode==='unknown')f.s.sdk.sendUseItem=async(slot:number,op:number)=>{await rub(slot,op);f.state.dialog.options=[{text:'Buy something',index:0}];return{success:true};};
  else f.s.sdk.sendClickDialog=async(index:number)=>{f.calls.push([-1,index]);return{success:true};};
  expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);expect(f.calls.filter(c=>c[0]===4)).toHaveLength(1);expect(f.calls.filter(c=>c[0]===-1)).toHaveLength(mode==='unknown'?0:1);
 }
});

test('Glory action parks after original executor replacement or stop during its menu',async()=>{
 for(const mode of ['owner','stop']){
  const f=gloryFixture(),rub=f.s.sdk.sendUseItem;let stopped=false;
  f.s.sdk.sendUseItem=async(slot:number,op:number)=>{const r=await rub(slot,op);if(mode==='owner')f.s.client.executeBotAction=()=>{};else stopped=true;return r;};
  expect((await monitorPlayers(f.s,f.policy,30,()=>stopped)).ok).toBe(false);expect(f.calls).toEqual([[4,4]]);
 }
});

test('teleport policy preflight rejects malformed or unsupported profiles before login',()=>{
 const f=gloryFixture();expect(()=>validateMonitorPolicy(f.policy,30)).not.toThrow();
 for(const teleport of [null,{},'Edgeville',{destination:'Ferox'}]){
  const policy=structuredClone(f.policy);(policy.itemAction as any).teleport=teleport;expect(()=>validateMonitorPolicy(policy,30)).toThrow('teleport');
 }
});

test('Glory dialogue accepts one observed Continue page and never repeats a retained page',async()=>{
 for(const retained of [false,true]){
  const f=gloryFixture(),rub=f.s.sdk.sendUseItem,choose=f.s.sdk.sendClickDialog;let continued=false;
  f.s.sdk.sendUseItem=async(slot:number,op:number)=>{const r=await rub(slot,op);f.state.dialog={isOpen:true,isWaiting:false,options:[{text:'Click here to continue',index:0}]};return r;};
  f.s.sdk.sendClickDialog=async(index:number)=>{if(!continued){continued=true;f.calls.push([-2,index]);if(!retained)f.state.dialog={isOpen:true,isWaiting:false,options:[{text:'Edgeville.',index:1}]};return{success:true};}return choose(index);};
  expect((await monitorPlayers(f.s,f.policy,30)).ok).toBe(!retained);expect(f.calls.filter(c=>c[0]===-2)).toHaveLength(1);expect(f.calls.filter(c=>c[0]===4)).toHaveLength(1);
 }
});

test('Glory admission retains cleanup time and permits the native Wilderness30 boundary',async()=>{
 const late=gloryFixture();expect((await monitorPlayers(late.s,late.policy,11)).ok).toBe(false);expect(late.calls).toHaveLength(0);
 const boundary=gloryFixture();boundary.state.player.worldZ=3759;expect((await monitorPlayers(boundary.s,boundary.policy,30)).ok).toBe(true);
});

test('Glory escape uses one declared slot and preserves a second identical owned amulet',async()=>{
 const f=gloryFixture();f.state.inventory.push({...f.state.inventory[0],slot:7});
 expect((await monitorPlayers(f.s,f.policy,30)).ok).toBe(true);expect(f.calls).toEqual([[4,4],[-1,1]]);
 expect(f.state.inventory.filter((i:any)=>i.id===1712).length).toBe(1);expect(f.state.inventory.filter((i:any)=>i.id===1710).length).toBe(1);
});


test('monitor wait pins original context and actual SDK reconnect sends no replacement Rub or generic item',async()=>{
 for(const mode of ['item','glory','life','client']){const f=mode==='glory'?gloryFixture():fixture();let wires=0;const sdk:any=new BotSDK({botUsername:'MonitorOwned',actionTimeout:20});Object.assign(sdk,{getState:()=>f.state,getSkill:()=>({level:99}),getStateAge:()=>0,getDialog:()=>f.state.dialog});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();if(mode==='life')f.state.player.lifeId++;else if(mode==='client')f.s.client={...f.s.client};else f.s.client.executeBotAction=()=>({success:true});sdk.connectionState='connected';};f.s.sdk=sdk;expect((await monitorPlayers(f.s,f.policy,30)).ok).toBe(false);expect(wires).toBe(0);}
 const f=fixture();f.state.nearbyPlayers=[];f.s.onTick=(cb:()=>void)=>{queueMicrotask(()=>{f.s.client.executeBotAction=()=>({success:true});cb();});return()=>{};};expect((await monitorPlayers(f.s,f.policy,10)).ok).toBe(false);expect(f.calls).toHaveLength(0);
});

test('monitor canonical settlement uses guarded logout then raw identity, and never logs out a foreign owner',async()=>{
 const old=process.exitCode;try{const f=fixture(),owner=actionSessionOwner(f.s);let exits=0,final=0;expect(await settleMonitorSession(owner,true,'done',async(rows,_ok,_detail,opts)=>{expect(rows[0]).toBe(f.s);await opts!.logout!(rows[0]!);final++;return true;},async view=>{exits++;expect(view).toBe(owner.cleanup);return'logged-out';})).toBe(true);expect(exits).toBe(1);expect(final).toBe(1);
 const g=fixture(),foreign=actionSessionOwner(g.s);g.s.client.executeBotAction=()=>({success:true});expect(await settleMonitorSession(foreign,true,'foreign',async()=>{final++;},async()=>{exits++;return'logged-out';})).toMatchObject({recoveryDeferred:true});expect(exits).toBe(1);expect(final).toBe(1);
 const ended=fixture();let resolve!:(value:{reason:string})=>void;ended.s.ended=new Promise(r=>{resolve=r;});const previous=actionSessionOwner(ended.s);resolve({reason:'logged-out'});await Promise.resolve();expect(await settleMonitorSession(previous,true,'policy logged out',async rows=>{expect(rows[0]).toBe(ended.s);return true;},async()=>{throw Error('second logout input');})).toBe(true);
 }finally{process.exitCode=old??0;}
});


test('policy logout goes through canonical Core settlement before the original session ends',async()=>{
 const {watchUnexpectedEnd,settle}=await import('../packages/core/src/bot');const f=fixture();f.policy.action='logout';let end!:(value:{reason:string})=>void;f.s.ended=new Promise(r=>{end=r;});let inputs=0,closes=0,unexpected=0;
 f.s.direct=async()=>{inputs++;end({reason:'logged-out'});return{success:true};};f.s.close=async()=>{closes++;};
 // Real unexpected-end callback races the policy path; duplicate cleanup must reuse its original successful settlement.
 let observed:Promise<boolean>|undefined;watchUnexpectedEnd(f.s,()=>false,()=>false,async()=>{unexpected++;observed=settle([f.s],false,'unexpected end',{log:()=>{}});await observed;});
 const result=await monitorPlayers(f.s,f.policy,20);expect(result).toMatchObject({ok:true,action:'logout',logout:'logged-out'});expect(inputs).toBe(1);expect(closes).toBe(1);expect(unexpected).toBe(1);expect(await observed).toBe(true);expect(await settle([f.s],false,'repeat',{log:()=>{}})).toBe(true);expect(closes).toBe(1);
});

test('policy logout cannot dispatch after the original executor changes',async()=>{
 const previous=process.exitCode;try{const f=fixture();f.policy.action='logout';let inputs=0;f.s.direct=async()=>{inputs++;return{success:true};};let reads=0;const get=f.s.sdk.getState;f.s.sdk.getState=()=>{const state=get();if(++reads===4)f.s.client.executeBotAction=()=>({success:true});return state;};expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);expect(inputs).toBe(0);}finally{process.exitCode=previous??0;}
});


test('only Glory escape tolerates positive-HP incoming damage before, during and after the native charge/landing',async()=>{
 for(const phase of ['before','rub','landing']){const f=gloryFixture();f.s.sdk.getSkill=(name:string)=>f.state.skills.find((v:any)=>v.name===name);const hp=f.state.skills[0],rub=f.s.sdk.sendUseItem,land=f.s.sdk.sendClickDialog;if(phase==='before'){f.state.nearbyPlayers=[];const subscribe=f.s.onTick;f.s.onTick=(cb:()=>void)=>subscribe(()=>{hp.level=98;f.state.nearbyPlayers=[{name:'OwnedPeer',index:2,distance:2}];cb();});}if(phase==='rub')f.s.sdk.sendUseItem=async(...args:number[])=>{const result=await rub(...args);hp.level=98;return result;};if(phase==='landing')f.s.sdk.sendClickDialog=async(index:number)=>{const result=await land(index);hp.level=98;return result;};expect(await monitorPlayers(f.s,f.policy,30)).toMatchObject({ok:true,item:{attempted:true,confirmed:true}});expect(f.calls).toEqual([[4,4],[-1,1]]);expect(hp.level).toBe(98);}
 const f=fixture();let hp=99;f.s.sdk.getSkill=()=>({level:hp});const send=f.s.sdk.sendUseItem;f.s.sdk.sendUseItem=async(...args:number[])=>{const r=await send(...args);hp=98;return r;};expect((await monitorPlayers(f.s,f.policy,20)).ok).toBe(false);
});

test('Glory allowDamage never permits zero HP, death, new life, owner replacement or stop through a real SDK reconnect',async()=>{
 for(const mode of ['zero','dead','life','owner','stop','budget']){const f=gloryFixture();let wires=0,stopped=false;const sdk:any=new BotSDK({botUsername:'MonitorOwned',actionTimeout:20});Object.assign(sdk,{getState:()=>f.state,getSkill:(name:string)=>f.state.skills.find((v:any)=>v.name===name),getStateAge:()=>0,getDialog:()=>f.state.dialog});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();if(mode==='zero')f.state.skills[0].level=0;if(mode==='dead')f.state.player.isDead=true;if(mode==='life')f.state.player.lifeId++;if(mode==='owner')f.s.client.executeBotAction=()=>({success:true});if(mode==='stop')stopped=true;if(mode==='budget')f.s.tick=()=>100;sdk.connectionState='connected';};f.s.sdk=sdk;expect((await monitorPlayers(f.s,f.policy,30,()=>stopped)).ok).toBe(false);expect(wires).toBe(0);}
});


test('NPC damage closes an acknowledged unpaid Rub menu; two fresh public ticks permit reopening and exactly one destination',async()=>{
 const f=gloryFixture(),rub=f.s.sdk.sendUseItem;let openings=0;f.s.sdk.getSkill=(name:string)=>f.state.skills.find((v:any)=>v.name===name);f.s.sdk.sendUseItem=async(slot:number,op:number)=>{openings++;const r=await rub(slot,op);if(openings===1){f.state.dialog={isOpen:false,isWaiting:false};f.state.skills[0].level=97;}return r;};const r=await monitorPlayers(f.s,f.policy,40);expect(r).toMatchObject({ok:true,item:{confirmed:true,openingAttempts:2,destinationAttempts:1}});expect(f.calls).toEqual([[4,4],[4,4],[-1,1]]);expect(f.state.inventory[0].id).toBe(1710);
});

test('pre-choice reopening requires unchanged whole pack/position, original living owner, time and fresh publication',async()=>{
 for(const mode of ['stock','position','zero','owner','stop','time','no-publication','modal','unknown']){const f=gloryFixture(),rub=f.s.sdk.sendUseItem;let stopped=false;f.s.sdk.getSkill=(name:string)=>f.state.skills.find((v:any)=>v.name===name);f.s.sdk.sendUseItem=async(slot:number,op:number)=>{const r=await rub(slot,op);f.state.dialog={isOpen:false,isWaiting:false};if(mode==='stock')f.state.inventory[1].count--;if(mode==='position')f.state.player.worldX++;if(mode==='zero')f.state.skills[0].level=0;if(mode==='owner')f.s.client.executeBotAction=()=>({success:true});if(mode==='stop')stopped=true;if(mode==='no-publication')Object.defineProperty(f.state,'tick',{value:0,configurable:true});if(mode==='modal')f.state.interface.isOpen=true;if(mode==='unknown')f.state.dialog={isOpen:true,isWaiting:false,options:[{index:1,text:'Unknown paid choice'}]};return r;};expect((await monitorPlayers(f.s,f.policy,mode==='time'?13:20,()=>stopped)).ok).toBe(false);expect(f.calls).toEqual([[4,4]]);}
});

test('four known unpaid Rub acknowledgements are bounded; no Rub follows any uncertain destination attempt',async()=>{
 const f=gloryFixture(),rub=f.s.sdk.sendUseItem;f.s.sdk.sendUseItem=async(slot:number,op:number)=>{const r=await rub(slot,op);f.state.dialog={isOpen:false,isWaiting:false};return r;};const r=await monitorPlayers(f.s,f.policy,60);expect(r).toMatchObject({ok:false,item:{openingAttempts:4,destinationAttempts:0}});expect(f.calls).toEqual([[4,4],[4,4],[4,4],[4,4]]);
 for(const mode of ['refused','throw','ack-without-effect']){const g=gloryFixture();g.s.sdk.sendClickDialog=async(index:number)=>{g.calls.push([-1,index]);g.state.dialog={isOpen:false,isWaiting:false};if(mode==='throw')throw Error('transport unknown');return{success:mode!=='refused'};};expect(await monitorPlayers(g.s,g.policy,30)).toMatchObject({ok:false,item:{openingAttempts:1,destinationAttempts:1}});expect(g.calls).toEqual([[4,4],[-1,1]]);}
});


test('Rub refusal or unknown reply never reopens, and freshness loss during reconnect prevents the final Rub wire',async()=>{
 for(const mode of ['false','throw']){const f=gloryFixture();f.s.sdk.sendUseItem=async()=>{f.calls.push([4,4]);if(mode==='throw')throw Error('unknown Rub transport');return{success:false};};expect(await monitorPlayers(f.s,f.policy,30)).toMatchObject({ok:false,item:{openingAttempts:1,destinationAttempts:0}});expect(f.calls).toEqual([[4,4]]);}
 const f=gloryFixture();let age=0,wires=0;const sdk:any=new BotSDK({botUsername:'MonitorOwned',actionTimeout:20});Object.assign(sdk,{getState:()=>f.state,getSkill:(name:string)=>f.state.skills.find((v:any)=>v.name===name),getStateAge:()=>age,getDialog:()=>f.state.dialog});sdk.connectionState='reconnecting';sdk.ws={readyState:WebSocket.OPEN,send:()=>{wires++;}};sdk.waitForConnection=async()=>{await Promise.resolve();age=5001;sdk.connectionState='connected';};f.s.sdk=sdk;expect((await monitorPlayers(f.s,f.policy,30)).ok).toBe(false);expect(wires).toBe(0);
});
