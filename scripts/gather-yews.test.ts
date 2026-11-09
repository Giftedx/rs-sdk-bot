import {readFileSync} from 'node:fs';
import {test,expect} from 'bun:test';
import {chopProcessingTree,processingTreeEdges,seersProcessingGrove,treeAfterBank,runDraynorOak,oakGrove,westOakPathAllowed,woodTreeOrder,normalGrove} from './gather-yews';
import type {Session} from '../packages/core/src/inprocess';

const woodTree=(x:number,distance:number)=>({x,z:3285,distance,reachable:true,optionsWithIndex:[{text:'Chop down',opIndex:1}]});
test('Draynor chooses an available tree over the closer tree another player is already chopping',()=>{
    const close=woodTree(3086,1),clear=woodTree(3091,5);
    expect(woodTreeOrder([close,clear],[{x:3086,z:3284}])[0]).toBe(clear);
    expect(woodTreeOrder([close,clear],[])[0]).toBe(close);
});
test('wood selection excludes unreachable or non-choppable resources before ranking',()=>{
    const clear=woodTree(3091,5);
    expect(woodTreeOrder([{...woodTree(3086,1),reachable:false},{...woodTree(3087,2),optionsWithIndex:[]},clear],[])).toEqual([clear]);
});
test('northern normal grove has separate primary map trees and keeps the old grove unchanged',()=>{
    const north=normalGrove('north'),south=normalGrove();
    expect(north.spot).toEqual({x:3088,z:3303});
    expect(north.contains(3089,3301)).toBe(true);expect(north.contains(3086,3284)).toBe(false);
    expect(south.contains(3086,3284)).toBe(true);expect(south.contains(3089,3301)).toBe(false);
    expect(()=>normalGrove('unknown')).toThrow('unsupported NORMAL_GROVE');
});

test('explicit TREE survives a bank visit with fewer than100normal logs',()=>{
    expect(treeAfterBank('oak',13)).toBe('oak');expect(treeAfterBank('normal',500)).toBe('normal');
    expect(treeAfterBank(undefined,13)).toBe('normal');expect(treeAfterBank(undefined,100)).toBe('oak');
});
function fixture(stalled=false,west=false){
    let tick=0,open=false,generation=0,xp=1010625;const listeners=new Set<()=>void>();
    const inv:any[]=[],bank:any[]=[{id:1349,name:'Iron axe',count:2,slot:0},{id:1351,name:'Bronze axe',count:1,slot:1},{id:315,name:'Shrimps',count:1,slot:2},{id:2309,name:'Bread',count:1,slot:3},{id:1511,name:'Logs',count:13,slot:4},{id:995,name:'Coins',count:84,slot:5}];
    const trees=(west?[[3102,3242,1],[3081,3291,1],[3070,3253,3]]:[[3081,3291,2]]).map(([x,z,distance])=>({id:1281,name:'Oak',x,z,distance,optionsWithIndex:[{text:'Chop down',opIndex:1}]}));
    const chopped:{x:number;z:number}[]=[];
    const state=()=>({player:{worldX:3092,worldZ:3243,level:0,lifeId:1,respawnCount:0},equipment:[],inventory:inv,bank:{isOpen:open,items:bank},nearbyLocs:trees});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const s:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getSkill:(n:string)=>({level:n==='Hitpoints'?11:99,baseLevel:n==='Hitpoints'?11:99}),getSkillXp:()=>xp,
            sendInteractLoc:async(x:number,z:number)=>{chopped.push({x,z});if(!stalled){const row=inv.find(i=>i.id===1521);if(row)row.count++;else inv.push({id:1521,name:'Oak logs',count:1,slot:inv.length});xp+=937;}return{success:true};}},
        bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;inv.push({id:item.id,name:item.name,count:n,slot:inv.length});generation++;return{success:true};},
            depositItem:async(item:any)=>{let row=bank.find(i=>i.id===item.id);if(!row){row={...item,slot:bank.length,count:0};bank.push(row);}row.count+=item.count;inv.splice(inv.indexOf(item),1);generation++;return{success:true};}},
        direct:async()=>({success:true})};
    return{s:s as Session,inv,bank,chopped,dispose:()=>clearInterval(timer)};
}
test('prepare withdraws only owned axe and2foods then banks25NEWoak while preserving all kit assets',async()=>{
    const f=fixture();try{const r=await runDraynorOak(f.s,{cap:500,maximum:25,prepare:true,walk:async()=>true});expect(r.ok).toBe(true);expect(r.banked).toBe(25);expect(r.newLogs).toBe(25);expect(r.preserved).toBe(true);expect(f.inv.find(i=>i.id===1349).count).toBe(1);expect(f.bank.find(i=>i.id===1349).count).toBe(1);expect(f.bank.find(i=>i.id===1511).count).toBe(13);}finally{f.dispose();}
});
test('west opt-in uses only verified3070,3253Oak and northern waypoints both ways; default stays north',async()=>{
    expect(oakGrove().name).toBe('north');expect([...oakGrove().trees]).toEqual(['3081,3291','3082,3295']);expect(()=>oakGrove('nearest')).toThrow('unsupported OAK_GROVE');
    const f=fixture(false,true),walks:number[][]=[];
    try{const r=await runDraynorOak(f.s,{cap:500,maximum:25,prepare:true,grove:'west',walk:async(x,z,tol)=>{walks.push([x,z,tol]);return true;}});
        expect(r.ok).toBe(true);expect(r.grove).toBe('west');expect(r.banked).toBe(25);expect(r.preserved).toBe(true);expect(r.plannedPathTiles).toBeNull();
        expect(walks).toEqual([[3092,3250,1],[3089,3266,1],[3070,3253,3],[3089,3266,1],[3092,3250,1],[3092,3243,2]]);
        expect(f.chopped).toHaveLength(25);expect(f.chopped.every(p=>p.x===3070&&p.z===3253)).toBe(true);
    }finally{f.dispose();}
});
test('west full expanded paths reject dark-wizard shortcut, eastern guard approach and unknown empty fallback',()=>{
    const bank={x:3092,z:3243};
    expect(westOakPathAllowed(bank,[{x:3092,z:3250},{x:3089,z:3266},{x:3073,z:3255}])).toBe(true);
    expect(westOakPathAllowed(bank,[{x:3089,z:3247},{x:3073,z:3255}])).toBe(false);
    expect(westOakPathAllowed(bank,[{x:3098,z:3250},{x:3073,z:3255}])).toBe(false);
    expect(westOakPathAllowed(bank,[])).toBe(false);
});
test('west guard permits the observed F88E northern fence detour3103,3271 only for its bank access leg',()=>{
    const south={x:3092,z:3250},north={x:3089,z:3266};
    // Retained native flwoodxf9801 frames t13..38 and reverse t278..295.
    const outward=[{x:3094,z:3250},{x:3096,z:3251},{x:3098,z:3252},{x:3100,z:3254},{x:3102,z:3255},{x:3103,z:3265},{x:3103,z:3271},{x:3095,z:3271},{x:3092,z:3269},north];
    const returning=[{x:3092,z:3269},{x:3096,z:3271},{x:3102,z:3271},{x:3103,z:3270},{x:3103,z:3256},{x:3101,z:3255},{x:3097,z:3252},{x:3095,z:3250},south];
    expect(westOakPathAllowed({x:3092,z:3242},[south])).toBe(true);
    expect(westOakPathAllowed(south,outward,north)).toBe(true);
    expect(westOakPathAllowed(north,returning,south)).toBe(true);
    expect(westOakPathAllowed(south,[{x:3104,z:3265},north],north)).toBe(false);
    expect(westOakPathAllowed(south,[{x:3103,z:3249},north],north)).toBe(false);
    expect(westOakPathAllowed(south,[{x:3089,z:3247},north],north)).toBe(false);
    expect(westOakPathAllowed(north,[{x:3103,z:3271},{x:3073,z:3255}])).toBe(false);
});
test('already held owned foods count toward preparation without withdrawing duplicate bank food',async()=>{
    const f=fixture();f.inv.push(...f.bank.splice(2,2).map((i:any,j:number)=>({...i,slot:j})));try{const r=await runDraynorOak(f.s,{cap:500,maximum:25,prepare:true,walk:async()=>true});expect(r.ok).toBe(true);expect(f.inv.filter(i=>i.id===315||i.id===2309).reduce((n,i)=>n+i.count,0)).toBe(2);expect(r.preserved).toBe(true);}finally{f.dispose();}
});
test('missing owned preparation food fails without chopping; stalled output remains bounded',async()=>{
    const missing=fixture();missing.bank.splice(2,2);try{const r=await runDraynorOak(missing.s,{cap:100,maximum:25,prepare:true,walk:async()=>true});expect(r.ok).toBe(false);expect(r.newLogs).toBe(0);expect(r.failure).toContain('food');}finally{missing.dispose();}
    const stalled=fixture(true);try{const r=await runDraynorOak(stalled.s,{cap:100,maximum:25,prepare:true,noProgress:12,walk:async()=>true});expect(r.ok).toBe(false);expect(r.newLogs).toBe(0);expect(r.failure).toContain('no wood progress');}finally{stalled.dispose();}
});

test('opt-in Native processing groves put willow and magic placements within observed loc radius',()=>{
 for(const [tree,tiles]of [['willow',[[2704,3506]]],['magic',[[2690,3427],[2691,3424],[2696,3423]]]]as const){const point=seersProcessingGrove(tree);for(const [x,z]of tiles)expect(Math.max(Math.abs(point.x-x),Math.abs(point.z-z))).toBeLessThanOrEqual(15);}
 for(const [tree,map,id] of [['willow',54,1308],['magic',53,1306]]as const){const p=seersProcessingGrove(tree),rows=readFileSync(`vendor/rs-sdk/server/content/maps/m42_${map}.jm2`,'utf8').split(/\r?\n/).map(l=>l.match(/^0 (\d+) (\d+): (\d+) /)).filter(v=>v&&Number(v[3])===id);expect(rows.some(v=>Math.max(Math.abs(42*64+Number(v![1])-p.x),Math.abs(map*64+Number(v![2])-p.z))<=15)).toBe(true);}
 expect(seersProcessingGrove('yew')).toEqual({x:2712,z:3462});expect(seersProcessingGrove('maple')).toEqual({x:2712,z:3462});expect(()=>seersProcessingGrove('redwood')).toThrow();
});
function processingActor(refuse=false){let tick=10,inputs=0;const tree:any={id:1306,name:'Magic tree',x:2690,z:3427,level:0,distance:2,reachable:true,optionsWithIndex:[{text:'Chop down',opIndex:1}]},state:any={tick:10,player:{worldX:2692,worldZ:3426,level:0,lifeId:1,respawnCount:0},nearbyLocs:[tree],inventory:[],dialog:{isOpen:false,options:[]},interface:{isOpen:false},gameMessages:[]},s:any={name:'woodunit',client:{executeBotAction:()=>{},mapBuildBaseX:0,mapBuildBaseZ:0,minusedlevel:0,localPlayer:{get routeX(){return[state.player.worldX];},get routeZ(){return[state.player.worldZ];},routeLength:0},locTypeOf:()=>({width:2,length:2})},tick:()=>tick,onTick:(f:()=>void)=>{const timer=setInterval(()=>{tick++;state.tick=tick;f();},1);return()=>clearInterval(timer);},sdk:{getState:()=>state,getSkill:()=>({level:99}),findPath:(x:number,z:number)=>({success:true,reachedDestination:true,waypoints:[{x,z,level:0}]}),countInventoryItems:()=>state.inventory.length,sendInteractLoc:async()=>{inputs++;return{success:true};},waitForCondition:async(predicate:(s:any)=>boolean)=>{tick++;state.tick=tick;if(refuse)state.gameMessages.push({type:0,text:"I can't reach that!",tick,observationId:1});else state.inventory.push({id:1513,count:1,name:'Magic logs'});if(!predicate(state))throw Error('predicate not satisfied');return state;}}};return{s,tree,state,inputs:()=>inputs};}
test('Native2x2 processing tree diagonal corner requires complete cardinal path and actual arrival before chop',async()=>{const a=processingActor(),walks:any[]=[];expect(processingTreeEdges(a.tree,2,2)).not.toContainEqual({x:2692,z:3426});const r=await chopProcessingTree(a.s,a.tree,()=>false,async(x,z)=>{walks.push([x,z]);a.state.player.worldX=x;a.state.player.worldZ=z;return true;});expect(r.success).toBe(true);expect(walks).toHaveLength(1);expect(processingTreeEdges(a.tree,2,2)).toContainEqual({x:walks[0][0],z:walks[0][1]});expect(a.inputs()).toBe(1);});
test('Native processing reach refusal ends the paid wait with no retry or false effect',async()=>{const a=processingActor(true);await expect(chopProcessingTree(a.s,a.tree,()=>false,async(x,z)=>{a.state.player.worldX=x;a.state.player.worldZ=z;return true;})).rejects.toThrow("native processing tree refusal: I can't reach that!");expect(a.inputs()).toBe(1);expect(a.state.inventory).toHaveLength(0);});
test('Native processing partial path or unobserved arrival cannot authorize a chop despite reachabletrue',async()=>{for(const partial of[true,false]){const a=processingActor();if(partial)a.s.sdk.findPath=()=>({success:true,reachedDestination:false,waypoints:[]});await expect(chopProcessingTree(a.s,a.tree,()=>false,async()=>true)).rejects.toThrow(partial?'complete cardinal':'arrival unobserved');expect(a.inputs()).toBe(0);}});

test('actual processing consumer cancels t36 corner route while t39 public position passes a cardinal edge before sole chop',async()=>{const a=processingActor();a.state.player.worldX=2690;a.state.player.worldZ=3429;const local:any={routeX:[2692],routeZ:[3426],routeLength:3};a.s.client.localPlayer=local;let resets=0;a.s.sdk.sendWalk=async(x:number,z:number)=>{resets++;expect(a.inputs()).toBe(0);expect(processingTreeEdges(a.tree,2,2)).toContainEqual({x,z});expect([x,z]).not.toEqual([local.routeX[0],local.routeZ[0]]);a.state.player.worldX=x;a.state.player.worldZ=z;local.routeX[0]=x;local.routeZ[0]=z;local.routeLength=9;return{success:true};};const r=await chopProcessingTree(a.s,a.tree,()=>false);expect(r.success).toBe(true);expect(resets).toBe(1);expect(a.inputs()).toBe(1);});
test('moving received head or a replacement during the single stand reset cannot authorize a chop',async()=>{for(const kind of['unknown','replacement']){const a=processingActor();a.state.player.worldX=2690;a.state.player.worldZ=3429;const local:any={routeX:[2692],routeZ:[3426]};a.s.client.localPlayer=local;let resets=0;a.s.sdk.sendWalk=async()=>{resets++;if(kind==='replacement')a.s.client.executeBotAction=()=>{};return{success:true};};await expect(chopProcessingTree(a.s,a.tree,()=>false)).rejects.toThrow('cardinal arrival unobserved');expect(resets).toBe(1);expect(a.inputs()).toBe(0);}});
test('delayed blocking-UI close cannot dispatch chop after the received head resumes movement',async()=>{const a=processingActor();a.state.player.worldX=2690;a.state.player.worldZ=3429;a.state.interface={isOpen:true,interfaceId:123};a.s.sdk.sendWalk=async(x:number,z:number)=>{a.state.player.worldX=x;a.state.player.worldZ=z;return{success:true};};let closed=0;a.s.sdk.waitForStateChange=async()=>a.state;a.s.sdk.sendCloseModal=async()=>{closed++;a.state.interface.isOpen=false;a.s.client.localPlayer={routeX:[2692],routeZ:[3426],routeLength:1};return{success:true};};await expect(chopProcessingTree(a.s,a.tree,()=>false)).rejects.toThrow('pre-dispatch context changed');expect(closed).toBe(1);expect(a.inputs()).toBe(0);});

test('persistent nonzero Lite render routeLength permits chop only after two fresh exact received stand frames',async()=>{const a=processingActor();a.state.player.worldX=2690;a.state.player.worldZ=3429;a.s.client.localPlayer.routeLength=9;let walks=0;a.s.sdk.sendWalk=async(x:number,z:number)=>{walks++;a.state.player.worldX=x;a.state.player.worldZ=z;return{success:true};};const r=await chopProcessingTree(a.s,a.tree,()=>false);expect(r.success).toBe(true);expect(a.state.tick).toBeGreaterThanOrEqual(12);expect(a.s.client.localPlayer.routeLength).toBe(9);expect(walks).toBe(1);expect(a.inputs()).toBe(1);});

test('actual Lite same-tile walk no-op cannot retain an old corner destination: consumer selects a different complete edge',async()=>{const a=processingActor();a.state.player.worldX=2690;a.state.player.worldZ=3429;let packets=0,calls=0;a.s.sdk.sendWalk=async(x:number,z:number)=>{calls++;if(x===a.state.player.worldX&&z===a.state.player.worldZ)return{success:true};packets++;a.state.player.worldX=x;a.state.player.worldZ=z;return{success:true};};const r=await chopProcessingTree(a.s,a.tree,()=>false);expect(r.success).toBe(true);expect(calls).toBe(1);expect(packets).toBe(1);expect(a.inputs()).toBe(1);expect(processingTreeEdges(a.tree,2,2)).toContainEqual({x:a.state.player.worldX,z:a.state.player.worldZ});});

test('cached loc type mutation after approach cannot alter the snapshotted Native footprint receipt',async()=>{const a=processingActor(),type={width:2,length:2},old=console.log,logs:string[]=[];a.s.client.locTypeOf=()=>type;console.log=(message:unknown)=>{logs.push(String(message));};try{const r=await chopProcessingTree(a.s,a.tree,()=>false,async(x,z)=>{a.state.player.worldX=x;a.state.player.worldZ=z;type.width=1;type.length=1;return true;});expect(r.success).toBe(true);const receipt=JSON.parse(logs.find(l=>l.startsWith('WOOD_TREE_APPROACH '))!.slice('WOOD_TREE_APPROACH '.length));expect(receipt.tree.width).toBe(2);expect(receipt.tree.length).toBe(2);expect(type.width).toBe(1);expect(a.inputs()).toBe(1);}finally{console.log=old;}});
