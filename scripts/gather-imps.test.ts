import {expect,test} from 'bun:test';
import {impCredit,impGroundCounts,impInsideFence,guardImpWalker,runImps,chooseImpCancelStep,cancelImpTarget} from './gather-imps';
import type {Session} from '../packages/core/src/inprocess';
import {resolve} from 'node:path';

test('actual lite movement returns success with no packet for current tile, but adjacent movement emits MOVE_GAMECLICK',async()=>{
    const root=resolve(import.meta.dir,'../vendor/rs-sdk/server/webclient/src');
    await import(resolve(root,'lite/dom-shim.ts'));
    const {findPathToTile}=await import(resolve(root,'lite/movement.ts'));
    const {default:CollisionMap}=await import(resolve(root,'dash3d/CollisionMap.ts'));
    const writes:[string,number][]=[];
    const client={ensureCollision(){},collision:[new CollisionMap()],minusedlevel:0,localPlayer:{routeX:[50],routeZ:[50]},mapBuildBaseX:2589,mapBuildBaseZ:3178,
        out:{p1Enc(n:number){writes.push(['opcode',n]);},p1(n:number){writes.push(['p1',n]);},p2(n:number){writes.push(['p2',n]);}}};
    expect(findPathToTile(client,50,50,false)).toBe(true);expect(writes).toEqual([]);
    expect(findPathToTile(client,51,50,false)).toBe(true);
    expect(writes).toEqual([['opcode',234],['p1',5],['p1',0],['p2',2640],['p2',3228]]);
});
test('adjacent cancellation selection rejects blocked, detour and outside-fence candidates without trial input',()=>{
    expect(chooseImpCancelStep({plan:()=>[]},{x:2639,z:3228})).toBeNull();
    expect(chooseImpCancelStep({plan:(_l,_f,to)=>[{x:2637,z:3234},to]},{x:2639,z:3228})).toBeNull();
    expect(chooseImpCancelStep({plan:(_l,_f,to)=>[to]},{x:2627,z:3228})).toBeNull();
});
test('adjacent cancellation requires observed step and fresh targetNONE, while recent-hit inCombat may remain true',async()=>{
    for(const mode of ['arrived','no-move','stale-target'] as const){
        let tick=0,x=2639,z=3228,target=true,pending:{x:number;z:number}|undefined,calls=0;
        const listeners=new Set<()=>void>(),timer=setInterval(()=>{tick++;if(pending&&mode!=='no-move'){x=pending.x;z=pending.z;pending=undefined;if(mode!=='stale-target')target=false;}for(const cb of listeners)cb();},1);
        const session={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
            sdk:{getSkill:()=>({level:13}),getState:()=>({autoRetaliateEnabled:false,player:{worldX:x,worldZ:z,level:0,combat:{inCombat:true,targetType:target?'npc':'none',targetIndex:target?3529:-1}}})},
            direct:async(a:any)=>{calls++;expect(a.running).toBe(false);expect(a.x!==x||a.z!==z).toBe(true);expect(impInsideFence({x:a.x,z:a.z})).toBe(true);pending={x:a.x,z:a.z};return{success:true};}
        } as unknown as Session;
        try{const promise=cancelImpTarget(session,{plan:(_l,_f,to)=>[to]});if(mode==='arrived')expect(await promise).toMatchObject({movementObserved:true,targetNoneObserved:true,recentHitInCombat:true});else await expect(promise).rejects.toThrow('adjacent cancellation unobserved');expect(calls).toBe(1);}finally{clearInterval(timer);}
    }
});

test('imp teleport/disappearance, dispatch and XP alone never prove a kill',()=>{
    expect(impCredit(true,100,0)).toBe(false);
    expect(impCredit(false,100,1)).toBe(false);
    expect(impCredit(true,0,1)).toBe(false);
    expect(impCredit(true,100,1)).toBe(true);
    const counts=impGroundCounts([{id:592,x:2633,z:3243,count:1},{id:592,x:2633,z:3243,count:2}]);
    expect(counts.get('592:2633:3243')).toBe(3);
});
test('imp guard rejects incomplete paths and fence escapes before dispatch',()=>{
    expect(impInsideFence({x:2633,z:3243,level:0})).toBe(true);
    expect(impInsideFence({x:2610,z:3268,level:0})).toBe(false);
    let calls=0;
    const base:any={pos:()=>({x:2633,z:3243,level:0}),plan:()=>[{x:2610,z:3268}],walk:()=>{calls++;},interactLoc:()=>{calls++;}};
    const g=guardImpWalker(base,()=>null);
    g.deps.walk(2639,3230);expect(calls).toBe(0);expect(g.reason()).toContain('imp route');
});
test('imp guard rejects an adjacent blocked goal and a full hunt path that briefly leaves the fence',()=>{
    for(const path of [[{x:2638,z:3230}],[{x:2646,z:3243},{x:2639,z:3230}]]){
        let calls=0;const g=guardImpWalker({pos:()=>({x:2633,z:3243,level:0}),plan:()=>path,walk:()=>{calls++;},interactLoc:()=>{},locs:()=>[],onTick:()=>()=>{}},()=>null,true);
        g.deps.walk(2639,3230);expect(calls).toBe(0);expect(g.reason()).toContain('imp route incomplete');
    }
});
function fixture(mode:'kill'|'teleport'|'escape'|'no-loot'|'pickup-loss'|'delayed-food'|'old-ash'|'other-player'|'unwitnessed-ash'|'retarget'|'retarget-no-cancel'|'unsafe-actor'|'deferred-first'|'reengage'|'reengage-stall'='kill'){
    let tick=0,generation=0,open=false,x=2655,z=3283,hp=14,xp=900,index=7,attacks=0,eats=0,healAt=Infinity,dropAt=Infinity,dropX=2633,dropZ=3243;
    const listeners=new Set<()=>void>();
    const inv:any[]=[{id:995,count:140,name:'Coins',slot:0},{id:333,count:6,name:'Trout',slot:1},{id:315,count:1,name:'Shrimps',slot:2},{id:2309,count:1,name:'Bread',slot:3},{id:1277,count:1,name:'Bronze sword',slot:4},{id:1171,count:1,name:'Wooden shield',slot:5}];
    const equipment:any[]=[{id:1277,count:1,name:'Bronze sword',slot:3},{id:1171,count:1,name:'Wooden shield',slot:5}];
    const bank:any[]=[{id:995,count:25,name:'Coins',slot:0},{id:592,count:3,name:'Ashes',slot:1}];let ground:any[]=mode==='old-ash'?[{id:592,name:'Ashes',x:2633,z:3243,count:3,distance:0}]:[];
    const makeNpc=()=>({id:708,index:index++,name:'Imp',tileX:2633,tileZ:3243,x:2633,z:3243,hp:8,maxHp:8,inCombat:false,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]});
    let npc:any=makeNpc();const other=mode.startsWith('retarget')||mode==='deferred-first'?makeNpc():null;let fighting=false,recentHit=false,cancels=0,outsideHuntClicks=0,pendingStep:{x:number;z:number}|undefined;
    if(mode==='deferred-first'){npc.hp=null;npc.maxHp=null;}
    const state=()=>({player:{worldX:x,worldZ:z,level:0,lifeId:1,respawnCount:0,combat:{inCombat:fighting||recentHit,targetType:fighting?'npc':'none',targetIndex:fighting?npc?.index??-1:-1}},autoRetaliateEnabled:false,inventory:inv,equipment,bank:{isOpen:open,items:bank},nearbyNpcs:[...(npc?[npc]:[]),...(other?[other]:[])],nearbyPlayers:mode==='other-player'?[{index:99,x:2634,z:3243}]:[],groundItems:ground,combatStyle:{known:true,currentStyle:0,weaponName:'Bronze sword',styles:[{index:0,trainsSkills:['Attack']}]}});
    const add=(items:any[],id:number,n:number)=>{const item=items.find(i=>i.id===id);if(item)item.count+=n;else items.push({id,name:String(id),count:n,slot:items.length});};
    const drop=()=>{if(mode!=='no-loot'&&mode!=='old-ash')ground=[{id:592,name:'Ashes',x:dropX,z:dropZ,count:2,distance:0},{id:1470,name:'Red bead',x:dropX,z:dropZ,count:1,distance:0}];npc=null;};
    const timer=setInterval(()=>{tick++;if(pendingStep){x=pendingStep.x;z=pendingStep.z;pendingStep=undefined;fighting=false;}if(tick>=dropAt){drop();dropAt=Infinity;}if(tick>=healAt){hp=14;healAt=Infinity;}for(const cb of listeners)cb();},1);
    const session={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
        bankObservation:()=>open?{generation,at:tick,items:bank}:null,direct:async(a:any)=>{if(a.type==='walkTo'&&(a.x!==x||a.z!==z)&&mode!=='retarget-no-cancel')pendingStep={x:a.x,z:a.z};cancels++;return{success:true};},
        sdk:{getState:state,getInventory:()=>inv,getEquipment:()=>equipment,getSkillXp:()=>xp,getSkill:(name:string)=>({level:name==='Hitpoints'?hp:9,baseLevel:name==='Hitpoints'?14:9}),sendSetCombatStyle:async()=>({success:true}),
            sendInteractNpc:async(actualIndex:number,op:number)=>{expect(op).toBe(2);if((mode.startsWith('retarget')||mode.startsWith('reengage'))&&attacks>0){expect(fighting).toBe(false);expect(cancels).toBeGreaterThan(0);}attacks++;if(mode!=='reengage-stall'||attacks===1)xp+=200;fighting=true;recentHit=true;
                if(mode.startsWith('reengage')){expect(actualIndex).toBe(npc.index);if(attacks===1||mode==='reengage-stall'){npc.hp=1;npc.inCombat=false;npc.tileX=2634;npc.x=2634;fighting=false;return{success:true};}dropX=npc.tileX;dropZ=npc.tileZ;}
                if(mode.startsWith('retarget')&&attacks===1){expect(actualIndex).toBe(npc.index);npc.tileX=2627;npc.x=2627;return{success:true};}
                if(mode.startsWith('retarget')||mode==='deferred-first'){expect(actualIndex).toBe(other!.index);npc=other;}
                else expect(actualIndex).toBe(npc.index);
                if(mode==='unsafe-actor'){x=2627;return{success:true};}
                if(mode==='teleport'){npc=null;return{success:true};}
                if(mode==='escape'){npc.tileX=2610;npc.x=2610;return{success:true};}
                if(mode==='delayed-food')hp=8;
                if(mode==='unwitnessed-ash')drop();else{npc.hp=0;npc.animId=172;dropAt=tick+2;}
                return{success:true};},
            sendPickup:async(px:number,pz:number,id:number)=>{const item=ground.find(i=>i.id===id&&i.x===px&&i.z===pz);if(!item)return{success:false};ground=ground.filter(i=>i!==item);if(mode!=='pickup-loss')add(inv,id,item.count);if(!ground.length)npc=makeNpc();return{success:true};}},
        bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},equipItem:async()=>{throw new Error('already worn kit must not re-equip');},eatFood:async()=>{inv.find(i=>i.id===333).count--;eats++;healAt=tick+2;return{success:true};},depositItem:async(item:any)=>{add(bank,item.id,item.count);inv.splice(inv.indexOf(item),1);generation++;return{success:true};}}
    } as unknown as Session;
    return{session,planner:{plan:(_level:number,_from:any,to:any)=>[to]},walk:async(points:any[])=>{const end=points.at(-1);if(points.length===1&&!impInsideFence(end))outsideHuntClicks++;x=end.x;z=end.z;return true;},pos:()=>[x,z],stop:()=>clearInterval(timer),attacks:()=>attacks,eats:()=>eats,cancels:()=>cancels,outsideHuntClicks:()=>outsideHuntClicks,bank,inv};
}
test('same visible1HP target disengages, then guarded re-engagement yields witnessed death and anchored ashes',async()=>{
    const f=fixture('reengage');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:30,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:1,attacks:2,reengagements:1,attackXp:400,creditedAttackXp:400,abandonedAttackXp:0,preserved:true,banked:{592:2,1470:1}});expect(r.credits[0].anchor).toEqual([2634,3243]);expect(r.abandoned).toHaveLength(0);expect(f.outsideHuntClicks()).toBe(0);}finally{f.stop();}
});
test('re-engagement clicks without new damage never reset the damage deadline or create a kill',async()=>{
    const f=fixture('reengage-stall');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:20,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.creditedAttackXp).toBe(0);expect(r.abandonedAttackXp).toBe(200);expect(r.ticks).toBeLessThan(50);expect(f.attacks()).toBeLessThanOrEqual(5);}finally{f.stop();}
});
test('target-only teleport cancels then selects a different safe imp; abandoned XP is never a kill',async()=>{
    const f=fixture('retarget');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:10,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:1,attacks:2,attackXp:400,creditedAttackXp:200,abandonedAttackXp:200,banked:{592:2,1470:1},preserved:true});expect(r.abandoned).toHaveLength(1);expect(r.abandoned[0].cancellationObserved).toBe(true);expect(f.cancels()).toBeGreaterThan(0);expect(f.outsideHuntClicks()).toBe(0);}finally{f.stop();}
});
test('target-only escape cannot retarget while cancellation remains unobserved',async()=>{
    const f=fixture('retarget-no-cancel');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.failure).toContain('cancellation unobserved');expect(f.attacks()).toBe(1);expect(r.abandonedAttackXp).toBe(200);expect(f.pos()).toEqual([2655,3283]);expect(r.preserved).toBe(true);}finally{f.stop();}
});
test('actor near the edge still aborts the whole job and never retargets',async()=>{
    const f=fixture('unsafe-actor');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(f.attacks()).toBe(1);expect(r.creditedKills).toBe(0);expect(r.failure).toContain('player');}finally{f.stop();}
});
test('known prior partial NPC can be explicitly excluded without attacking it or treating unknown health as proof',async()=>{
    const f=fixture('deferred-first');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:10,deferredNpcIndices:[7],walk:f.walk,cancelPlanner:f.planner});expect(r.initialDeferredNpcIndices).toEqual([7]);expect(r.ok).toBe(true);expect(r.attacks).toBe(1);expect(r.creditedKills).toBe(1);expect(r.credits[0].npcIndex).toBe(8);}finally{f.stop();}
});
test('initial deferred list is bounded and validated before session use',async()=>{
    for(const indices of [[-1],[1.5],Array.from({length:9},(_,i)=>i)])await expect(runImps({} as Session,{cap:100,maximum:1,deferredNpcIndices:indices})).rejects.toThrow('invalid initial deferred');
});
test('two bounded imp kills bank actual double-ash and optional bead counts, XP and all duplicate kit/cash',async()=>{
    const f=fixture();try{const r=await runImps(f.session,{cap:200,maximum:2,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:2,attacks:2,attackXp:400,loot:{592:4,1470:2},banked:{592:4,1470:2},eaten:0,preserved:true,targetMet:true,hpMin:14});expect(f.bank.find(i=>i.id===592).count).toBe(7);}finally{f.stop();}
});
for(const mode of ['teleport','no-loot','old-ash','unwitnessed-ash'] as const)test(`imp ${mode} with own XP stops without invented kill or loot`,async()=>{
    const f=fixture(mode);try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:5,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.banked[592]).toBe(0);expect(r.preserved).toBe(true);expect(f.attacks()).toBe(1);}finally{f.stop();}
});
test('imp refuses a competing player before attack and keeps all assets',async()=>{
    const f=fixture('other-player');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.failure).toContain('another player');expect(f.attacks()).toBe(0);expect(r.preserved).toBe(true);}finally{f.stop();}
});
test('imp teleport outside fence is deferred without chasing; no other eligible target ends bounded search',async()=>{
    const f=fixture('escape');try{const r=await runImps(f.session,{cap:200,maximum:1,noProgress:5,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.failure).toContain('no eligible target');expect(r.creditedKills).toBe(0);expect(f.attacks()).toBe(1);expect(r.preserved).toBe(true);expect(r.abandoned).toHaveLength(1);expect(r.abandoned[0]).toMatchObject({partialDamageXp:200,cancellationObserved:true});}finally{f.stop();}
});
test('imp pickup disappearance without actual inventory gain cannot claim output',async()=>{
    const f=fixture('pickup-loss');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.banked[592]).toBe(0);expect(r.failure).toContain('pickup unobserved');}finally{f.stop();}
});
test('imp food waits for the actual delayed heal and counts one debit before carrying on',async()=>{
    const f=fixture('delayed-food');try{const r=await runImps(f.session,{cap:200,maximum:1,walk:f.walk,cancelPlanner:f.planner});expect(r).toMatchObject({ok:true,creditedKills:1,eaten:1,hpMin:8,preserved:true});expect(f.eats()).toBe(1);expect(f.inv.find(i=>i.id===333).count).toBe(5);}finally{f.stop();}
});
