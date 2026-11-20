import {test,expect} from 'bun:test';
import {GIANT,GIANT_HERBS,TROOPER_FOODS,TROOPER_SITE,COW_BEAR_BOXES,CONFIGS,TAVERLEY_ROUTE,isNonWildernessGatherGoal,createTaverleyTravel} from './gather-combat';
import {cowCredit,runCows,cowTraining,cowGroundCounts,guardCowWalker,cowRoutePoints,cowProfile,cowStopControl,genericCombatNpc,bankCombatLoot,cowFoodBites,cowFoodPick,cowFoodHeal,COW_FOOD_HP,cowReleased,COW_RELEASE,selectGiantArmour,COW_FOOD_BITES} from './gather-combat';
import {gearById} from '../packages/planner/src/gear-progression';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks} from '../packages/core/src/ticks';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

test('real CLI rejects unknown combat target before reading account config; valid targets still reach missing phantom config',async()=>{
    const name='__combat_validation_no_account__';
    expect(existsSync(resolve(import.meta.dir,'../vendor/rs-sdk/bots',name))).toBe(false);
    for(const target of ['imp','bogus','cow','druid','giant']){
        // The synchronous Windows child bridge reported ETIMEDOUT during broad
        // runs while the identical isolated CLI passed. Await the real child
        // and both pipes, retaining the same5s deadline and exit/output checks.
        const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'gather-combat.ts'),name,'1',...(target==='imp'?[]:[target])],{env:{...process.env,FLEET_SIDE:'local',DEMO_OK:'0',TARGET:target},windowsHide:true,stdout:'pipe',stderr:'pipe'});
        let timedOut=false;
        const timer=setTimeout(()=>{timedOut=true;child.kill();},5000);
        let output:string;
        try{
            const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
            expect(timedOut).toBe(false);expect(status).toBe(1);output=out+err;
        }finally{clearTimeout(timer);}
        expect(output).not.toContain('Pathfinding initialized');expect(output).not.toContain('START ');
        if(target==='imp'||target==='bogus'){
            expect(output).toContain(`RESULT fail no combat progress: unsupported target ${target}`);
            expect(output).not.toContain('ENOENT');expect(output).not.toContain('bot.env');
        }else{expect(output).not.toContain('unsupported target');expect(output).toContain('ENOENT');expect(output).toContain(name);expect(output).toContain('bot.env');}
    }
},15000);

test('cow credit requires own Attack XP and three newly observed target-tile drops, not disappearance',()=>{
    expect(cowCredit(true,800,[1,1,1])).toBe(true);
    expect(cowCredit(true,0,[1,1,1])).toBe(false);
    expect(cowCredit(false,800,[1,1,1])).toBe(false);
    expect(cowCredit(true,800,[1,0,1])).toBe(false);
    const pile={id:526,x:1,z:2,count:1};expect(cowGroundCounts([pile,pile]).get('526:1:2')).toBe(2);
});
test('cow route rejects complete bear paths, partial endpoints and empty fallback before any game input',()=>{
    for(const corners of [[{x:2688,z:3342},{x:2664,z:3344}],[{x:2650,z:3354}],[]]){
        let inputs=0;const base:any={pos:()=>({x:2655,z:3283,level:0}),plan:()=>corners,walk:()=>{inputs++;},interactLoc:()=>{inputs++;},runOn:()=>{inputs++;}};
        const guard=guardCowWalker(base,()=>null);
        guard.deps.plan(0,{x:2655,z:3283},{x:2664,z:3344});guard.deps.walk(2664,3344);guard.deps.runOn?.();
        expect(inputs).toBe(0);expect(guard.reason()).toContain('cow route');
    }
});
test('verified cow waypoints reverse on return and dynamic health/threat aborts before dispatch',()=>{
    expect(cowRoutePoints({x:2655,z:3283},2664,3344,4).map(p=>[p.x,p.z])).toEqual([[2648,3358],[2677,3358],[2664,3344]]);
    expect(cowRoutePoints({x:2666,z:3348},2654,3283,2).map(p=>[p.x,p.z])).toEqual([[2677,3358],[2648,3358],[2654,3283]]);
    let inputs=0;const base:any={pos:()=>({x:2664,z:3344,level:0}),plan:()=>[{x:2665,z:3344}],walk:()=>{inputs++;}};
    const guard=guardCowWalker(base,()=> 'observed bear within6');guard.deps.walk(2665,3344);expect(inputs).toBe(0);expect(guard.reason()).toContain('bear');
});

test('north profile keeps explicit house-free corridor and bounds packing by food mode',()=>{
    expect(cowRoutePoints({x:2619,z:3332},2664,3344,4,true).map(p=>[p.x,p.z])).toEqual([[2635,3360],[2647,3391],[2676,3350],[2664,3344]]);
    expect(cowRoutePoints({x:2664,z:3344},2619,3332,1,true).map(p=>[p.x,p.z])).toEqual([[2676,3350],[2647,3391],[2635,3360],[2619,3332]]);
    expect(cowRoutePoints({x:2619,z:3332},2619,3332,1,true)).toHaveLength(1);
    expect(()=>cowProfile('south','held',8)).toThrow('MAX_KILLS1..5');
    expect(cowProfile('north','held',8).limit).toBe(8);
    expect(()=>cowProfile('north','held',9)).toThrow('MAX_KILLS1..8');
    expect(cowProfile('north','banked',9).limit).toBe(9);
    expect(()=>cowProfile('south','banked',9)).toThrow('unsupported');
});

function fixture(disappearOnly=false,injury?:'low-nofood'|'death'|'delayed-food',options:{alreadyMet?:boolean;wrongXp?:boolean;unknownStyle?:boolean;slowFight?:boolean;alreadyEquipped?:boolean;equipNoLanding?:boolean;equipDelay?:boolean}={}) {
    let tick=0,open=false,generation=0,kills=0,hp=10,lifeId=1,healAt=Infinity,style=0,fightAt=Infinity;
    const xp:Record<string,number>={Attack:0,Strength:0,Defence:0};
    const listeners=new Set<()=>void>();
    const inv:any[]=[{id:1277,name:'Bronze sword',count:1,slot:0},{id:1171,name:'Wooden shield',count:1,slot:1},{id:333,name:'Trout',count:2,slot:2},{id:995,name:'Coins',count:20,slot:3}];
    const equipment:any[]=options.alreadyEquipped?inv.filter(i=>[1277,1171].includes(i.id)).map(i=>({...i})):[];let equipCalls=0,equipAt=Infinity,equipPending:any;
    for(const item of inv)if([1277,1171].includes(item.id))item.optionsWithIndex=[{text:'Wield',opIndex:2}];
    const bank:any[]=[{id:333,name:'Trout',count:5,slot:0}];let ground:any[]=[];let npc:any={id:81,index:7,name:'Cow',tileX:2664,tileZ:3344,x:2664,z:3344,hp:8,maxHp:8,inCombat:false};
    const state=()=>({player:{worldX:2654,worldZ:3283,level:0,lifeId,respawnCount:0,hp},inventory:inv,equipment,nearbyPlayers:[],nearbyNpcs:npc?[npc]:[],groundItems:ground,bank:{isOpen:open,items:bank},combatStyle:{known:!options.unknownStyle,currentStyle:style,weaponName:'Bronze sword',styles:[{index:0,trainsSkills:['Attack']},{index:1,trainsSkills:['Strength']},{index:3,trainsSkills:['Defence']}]}});
    const timer=setInterval(()=>{tick++;if(tick>=equipAt){equipment.push(equipPending);inv.splice(inv.indexOf(equipPending),1);equipAt=Infinity;}if(tick>=healAt){hp=10;healAt=Infinity;}
        if(options.slowFight&&tick>fightAt&&(tick-fightAt)%30===0&&npc){xp.Attack+=100;npc.hp--;if(npc.hp===0){ground=[{id:1739,name:'Cowhide',count:1,x:2664,z:3344},{id:526,name:'Bones',count:1,x:2664,z:3344},{id:2132,name:'Raw beef',count:1,x:2664,z:3344}];npc=null;}}
        for(const f of [...listeners])f();},1);
    const session:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),
        bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getEquipment:()=>equipment,getSkill:(n:string)=>{const level=n==='Hitpoints'?hp:n==='Strength'?(options.alreadyMet||xp.Strength>=1600?10:1):n==='Defence'&&xp.Defence>=800?5:1;return{level,baseLevel:n==='Hitpoints'?10:level};},getSkillXp:(n:string)=>xp[n]??0,sendSetCombatStyle:async(n:number)=>{style=n;return{success:true};}},
        bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},equipItem:async(item:any)=>{equipCalls++;if(equipment.some(i=>i.id===item.id))return{success:false,message:`Failed to equip ${item.name}`};if(!options.equipNoLanding){if(options.equipDelay){equipPending=item;equipAt=tick+2;}else{equipment.push(item);inv.splice(inv.indexOf(item),1);}}return{success:true};},
            attack:async()=>{kills++;if(options.slowFight){fightAt=tick;return{success:true};}if(injury==='delayed-food'&&kills===1)hp=6;if(injury==='low-nofood'){hp=6;inv.splice(inv.findIndex(i=>i.id===333),1);}if(injury==='death'){hp=0;lifeId=2;}if(!disappearOnly){xp[options.wrongXp||style===0?'Attack':style===1?'Strength':'Defence']+=800;ground=[{id:1739,name:'Cowhide',count:1,x:2664,z:3344},{id:526,name:'Bones',count:1,x:2664,z:3344},{id:2132,name:'Raw beef',count:1,x:2664,z:3344}];}npc=null;return{success:true};},
            eatFood:async()=>{inv.find(i=>i.id===333).count--;healAt=tick+2;return{success:true};},
            pickupItem:async(item:any)=>{ground=ground.filter(i=>i!==item);const held=inv.find(i=>i.id===item.id);if(held)held.count++;else inv.push({...item,slot:inv.length});if(!ground.length)npc={id:81,index:7,name:'Cow',tileX:2664,tileZ:3344,x:2664,z:3344,hp:8,maxHp:8,inCombat:false};return{success:true};},
            depositItem:async(item:any)=>{const held=inv.find(i=>i.id===item.id);const row=bank.find(i=>i.id===item.id);if(row)row.count+=held.count;else bank.push({...held,slot:bank.length});inv.splice(inv.indexOf(held),1);generation++;return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;inv.push({id:item.id,name:item.name,count:n,slot:inv.length});generation++;return{success:true};},
        }};
    return {session:session as Session,bank,inv,dispose:()=>clearInterval(timer),kills:()=>kills,equipCalls:()=>equipCalls};
}

function northFixture(cutoff=false){
    const f=fixture(),sdk=f.session.sdk,bot=f.session.bot;
    const originalState=sdk.getState.bind(sdk),originalSkill=sdk.getSkill.bind(sdk),attack=bot.attack.bind(bot),pickup=bot.pickupItem.bind(bot),deposit=bot.depositItem.bind(bot);
    const cash=f.inv.find(i=>i.id===995)!;f.bank.push({...cash});f.inv.splice(f.inv.indexOf(cash),1);
    let position={x:2619,z:3332},health=71,attacks=0;
    sdk.getState=()=>{const st=originalState()!;return {...st,player:{...st.player!,worldX:position.x,worldZ:position.z,hp:health}};};
    sdk.getSkill=(name:string)=>name==='Hitpoints'?{name,level:health,baseLevel:71,experience:0}:name==='Defence'?{name,level:75,baseLevel:75,experience:0}:originalSkill(name);
    bot.attack=async(...args:any[])=>{attacks++;const r=await (attack as any)(...args);if(cutoff)health=40;return r;};
    bot.pickupItem=async(...args:any[])=>{const r=await(pickup as any)(...args);for(const id of [1739,526,2132]){
        const item=f.inv.find(i=>i.id===id&&i.count>1);if(item){const n=item.count;f.inv.splice(f.inv.indexOf(item),1);for(let i=0;i<n;i++)f.inv.push({...item,count:1,slot:f.inv.length});}
    }return r;};
    bot.depositItem=async(item:any,...args:any[])=>{const r=await(deposit as any)(item,...args);const rest=f.inv.filter(i=>i.id===item.id),row=f.bank.find(i=>i.id===item.id);for(const i of rest){row.count+=i.count;f.inv.splice(f.inv.indexOf(i),1);}return r;};
    const walk=async(x:number,z:number)=>{position={x,z};await waitTicks(f.session,1);return true;};
    return {...f,walk,attacks:()=>attacks};
}

test('qualified north banked-food mode stores both Trout and banks nine full 27-slot bundles',async()=>{
    const f=northFixture();try{
        const r=await runCows(f.session,{cap:500,maximum:9,bankProfile:'north',foodMode:'banked',trainSkill:'Defence',walk:f.walk});
        expect(r.ok).toBe(true);expect(r.targetMet).toBe(true);expect(r.creditedKills).toBe(9);expect(r.banked).toEqual({hide:9,bones:9,beef:9});
        expect(r.maxPackSlots).toBe(27);expect(r.eaten).toBe(0);expect(r.preserved).toBe(true);expect(r.healthCutoff).toBe(false);
        expect(f.bank.find(i=>i.id===333).count).toBe(7);expect(f.inv).toHaveLength(0);
    }finally{f.dispose();}
});

test('north banked-food cutoff40 prevents another attack and still banks owned assets',async()=>{
    const f=northFixture(true);try{
        const r=await runCows(f.session,{cap:500,maximum:9,bankProfile:'north',foodMode:'banked',trainSkill:'Defence',walk:f.walk});
        expect(r.ok).toBe(false);expect(r.healthCutoff).toBe(true);expect(r.failure).toContain('HP40 cutoff');expect(f.attacks()).toBe(1);
        expect(r.eaten).toBe(0);expect(r.preserved).toBe(true);expect(r.banked).toEqual({hide:0,bones:0,beef:0});expect(f.bank.find(i=>i.id===333).count).toBe(7);
    }finally{f.dispose();}
});

test('fresh low-level worker cannot opt into food-free north profile',async()=>{
    const f=fixture();const old=f.session.sdk.getState.bind(f.session.sdk);f.session.sdk.getState=()=>{const st=old()!;return {...st,player:{...st.player!,worldX:2619,worldZ:3332}};};
    try{await expect(runCows(f.session,{cap:500,maximum:9,bankProfile:'north',foodMode:'banked',walk:async()=>true})).rejects.toThrow('HPbase/current60');expect(f.kills()).toBe(0);}finally{f.dispose();}
});
test('cow already worn kit with identical held copies never re-equips and preserves both copies',async()=>{
    const f=fixture(false,undefined,{alreadyEquipped:true});try{const r=await runCows(f.session,{cap:500,maximum:1,walk:async()=>true});expect(r.ok).toBe(true);expect(r.creditedKills).toBe(1);expect(f.equipCalls()).toBe(0);expect(r.preserved).toBe(true);expect(f.inv.filter(i=>[1277,1171].includes(i.id))).toHaveLength(2);}finally{f.dispose();}
});
test('cow truly unequipped kit waits for actual worn arrival once per item',async()=>{
    const f=fixture(false,undefined,{equipDelay:true});try{const r=await runCows(f.session,{cap:500,maximum:1,walk:async()=>true});expect(r.ok).toBe(true);expect(r.creditedKills).toBe(1);expect(f.equipCalls()).toBe(2);expect(r.preserved).toBe(true);}finally{f.dispose();}
});
test('cow equip dispatch success without actual worn item stops before leaving bank',async()=>{
    const f=fixture(false,undefined,{equipNoLanding:true});let outbound=0;try{const r=await runCows(f.session,{cap:500,maximum:1,walk:async x=>{if(x===2664)outbound++;return true;}});expect(r.ok).toBe(false);expect(r.failure).toContain('equipped');expect(outbound).toBe(0);expect(f.kills()).toBe(0);}finally{f.dispose();}
});
test('bounded cow mode banks five actual credited bundles and preserves kit and cash',async()=>{
    const f=fixture();try{const r=await runCows(f.session,{cap:500,maximum:5,walk:async()=>true});
        expect(r.ok).toBe(true);expect(r.creditedKills).toBe(5);expect(r.banked).toEqual({hide:5,bones:5,beef:5});expect(r.attackXp).toBe(4000);expect(r.preserved).toBe(true);
    }finally{f.dispose();}
});
test('outbound travel and a long fight with real own XP do not consume the no-progress window',async()=>{
    const f=fixture(false,undefined,{slowFight:true});try{
        const r=await runCows(f.session,{cap:450,maximum:1,walk:async x=>{if(x===2664)await waitTicks(f.session,90);return true;}});
        expect(r.ok).toBe(true);expect(r.creditedKills).toBe(1);expect(r.ticks).toBeGreaterThan(300);expect(r.attackXp).toBe(800);
    }finally{f.dispose();}
},10000);
test('absolute cap still stops an active own-XP fight',async()=>{
    const f=fixture(false,undefined,{slowFight:true});try{
        const r=await runCows(f.session,{cap:150,maximum:1,walk:async()=>true});
        expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.ticks).toBeGreaterThanOrEqual(150);expect(r.stop).toBe('cap');
    }finally{f.dispose();}
},10000);
test('training styles use verified sword indexes; selected level stops new attacks and keeps exact loot',async()=>{
    expect(cowTraining()).toEqual({skill:'Attack',style:0,targetLevel:undefined});
    expect(cowTraining('Strength',10).style).toBe(1);expect(cowTraining('Defence',5).style).toBe(3);
    expect(()=>cowTraining('Ranged',10)).toThrow('TRAIN_SKILL');expect(()=>cowTraining('Strength',0)).toThrow('TARGET_LEVEL');
    for(const [skill,level,kills] of [['Strength',10,2],['Defence',5,1]] as const){const f=fixture();try{
        const r=await runCows(f.session,{cap:500,maximum:5,trainSkill:skill,targetLevel:level,walk:async()=>true});
        expect(r.ok).toBe(true);expect(r.stop).toBe('target-level');expect(r.creditedKills).toBe(kills);expect(f.kills()).toBe(kills);
        expect(r.selectedXp).toBe(800*kills);expect(r.attackXp).toBe(0);expect(r.finalLevel).toBe(level);expect(r.banked.hide).toBe(kills);
    }finally{f.dispose();}}
});
test('already met level performs no combat; wrong skill XP cannot claim requested training credit',async()=>{
    const met=fixture(false,undefined,{alreadyMet:true});try{
        const r=await runCows(met.session,{cap:500,maximum:5,trainSkill:'Strength',targetLevel:10,walk:async()=>true});
        expect(r.ok).toBe(true);expect(r.targetMet).toBe(true);expect(met.kills()).toBe(0);expect(r.banked.hide).toBe(0);
    }finally{met.dispose();}
    const wrong=fixture(false,undefined,{wrongXp:true});try{
        const r=await runCows(wrong.session,{cap:120,maximum:5,noProgress:20,trainSkill:'Strength',targetLevel:10,walk:async()=>true});
        expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.selectedXp).toBe(0);expect(r.attackXp).toBe(800);
    }finally{wrong.dispose();}
});
test('verified bounded training may stop safely partial without claiming the requested level',async()=>{
    const f=fixture();try{const r=await runCows(f.session,{cap:500,maximum:1,trainSkill:'Strength',targetLevel:10,walk:async()=>true});
        expect(r.ok).toBe(true);expect(r.targetMet).toBe(false);expect(r.partial).toBe(true);expect(r.stop).toBe('max-kills');expect(r.banked).toEqual({hide:1,bones:1,beef:1});expect(r.finalLevel).toBe(1);
    }finally{f.dispose();}
});
test('unknown style observation prevents combat instead of assuming selected training',async()=>{
    const f=fixture(false,undefined,{unknownStyle:true});try{const r=await runCows(f.session,{cap:120,maximum:5,trainSkill:'Defence',targetLevel:5,walk:async()=>true});
        expect(r.ok).toBe(false);expect(f.kills()).toBe(0);expect(r.failure).toContain('style unobserved');
    }finally{f.dispose();}
});
test('food debit before delayed HP publication waits for healing and counts actual consumption',async()=>{
    const f=fixture(false,'delayed-food');try{const r=await runCows(f.session,{cap:500,maximum:5,walk:async()=>true});
        expect(r.ok).toBe(true);expect(r.eaten).toBe(1);expect(r.creditedKills).toBe(5);expect(r.preserved).toBe(true);
        expect(f.bank.find(i=>i.id===333).count).toBe(4);
        expect(r.foodAccounted).toBe(true);expect(r.initialFood).toBe(7);expect(r.finalFood).toBe(6);
    }finally{f.dispose();}
});
test('stop request before departure performs no route, kit or combat input and keeps assets',async()=>{
    const f=fixture();let outbound=0;try{
        const r=await runCows(f.session,{cap:500,maximum:5,trainSkill:'Attack',targetLevel:20,stop:()=>true,walk:async x=>{if(x===2664)outbound++;return true;}});
        expect(r.ok).toBe(false);expect(r.stop).toBe('stop-file');expect(outbound).toBe(0);expect(f.kills()).toBe(0);expect(f.equipCalls()).toBe(0);
        expect(r.banked).toEqual({hide:0,bones:0,beef:0});expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);
    }finally{f.dispose();}
});
test('mocked finite partial route banks its credited loot; another call can continue from that state',async()=>{
    const f=fixture();try{
        const first=await runCows(f.session,{cap:500,maximum:1,trainSkill:'Defence',targetLevel:10,walk:async()=>true});
        expect(first.ok).toBe(true);expect(first.partial).toBe(true);expect(first.targetMet).toBe(false);expect(first.stop).toBe('max-kills');expect(first.creditedKills).toBe(1);expect(f.kills()).toBe(1);
        expect(first.banked).toEqual({hide:1,bones:1,beef:1});expect(first.preserved).toBe(true);expect(first.foodAccounted).toBe(true);
        expect(f.inv.some(i=>[1739,526,2132].includes(i.id))).toBe(false);
        const second=await runCows(f.session,{cap:500,maximum:4,walk:async()=>true});
        expect(second.ok).toBe(true);expect(second.creditedKills).toBe(4);expect(second.banked).toEqual({hide:4,bones:4,beef:4});
        expect(f.bank.find(i=>i.id===1739).count).toBe(5);expect(second.foodAccounted).toBe(true);
    }finally{f.dispose();}
});
test('mocked stop control retains onStop ownership until the cow loop banks',async()=>{
    // Unit evidence only. The installed CLI native stopped case checks openBot's callback marker.
    expect(cowStopControl('druid',()=>false).options).toEqual({});
    let file=false;const control=cowStopControl('cow',()=>file);
    const onStop=(control.options as {onStop?:(s:unknown,why:string)=>Promise<unknown>}).onStop;
    expect(typeof onStop).toBe('function');expect(control.stop()).toBe(false);
    file=true;expect(control.stop()).toBe(true);file=false;
    const f=fixture();let fired=false;try{
        // Fire core onStop on the tick the first credited hide is held.
        const r=await runCows(f.session,{cap:500,maximum:5,walk:async()=>true,stop:()=>{
            if(!fired&&f.inv.some(i=>i.id===1739)){fired=true;void onStop!(f.session,'stop file');}return control.stop();}});
        expect(control.reason()).toBe('stop file');expect(r.ok).toBe(false);expect(r.stop).toBe('stop-file');expect(r.creditedKills).toBe(1);
        expect(r.banked).toEqual({hide:1,bones:1,beef:1});expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);
        expect(f.inv.some(i=>[1739,526,2132].includes(i.id))).toBe(false);
    }finally{f.dispose();}
    const died=cowStopControl('cow',()=>false);await (died.options as any).onStop({}, 'died');await (died.options as any).onStop({}, 'stop file');
    expect(died.stop()).toBe(true);expect(died.reason()).toBe('died');
});
test('vanished NPC without credited drops/XP blocks rather than claiming kills',async()=>{
    const f=fixture(true);try{const r=await runCows(f.session,{cap:120,maximum:5,walk:async()=>true,noProgress:20});expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.failure).toContain('no cow progress');expect(f.kills()).toBe(1);
        expect(r.diagnostics.length).toBeLessThanOrEqual(16);expect(r.diagnostics[0]?.index).toBe(7);expect(r.diagnostics.some(d=>d.gone===true&&d.npc===null)).toBe(true);
    }finally{f.dispose();}
});
test('a busy pen ends a run that has kills as crowded and banks them; a run with no kills fails and says what the pen held',async()=>{
    const busy=(f:ReturnType<typeof fixture>,after:number)=>{const sdk=f.session.sdk as any,state=sdk.getState.bind(sdk);
        sdk.getState=()=>{const st=state();return f.kills()>=after?{...st,nearbyNpcs:st.nearbyNpcs.map((n:any)=>({...n,inCombat:true}))}:st;};};
    const f=fixture();busy(f,2);try{const r=await runCows(f.session,{cap:500,maximum:5,walk:async()=>true,noProgress:20});
        expect(r.ok).toBe(true);expect(r.stop).toBe('crowded');expect(r.partial).toBe(true);expect(r.creditedKills).toBe(2);expect(r.banked).toEqual({hide:2,bones:2,beef:2});expect(r.failure).toBe('-');
    }finally{f.dispose();}
    const g=fixture();busy(g,0);try{const r=await runCows(g.session,{cap:500,maximum:5,walk:async()=>true,noProgress:20});
        expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(r.failure).toContain('no cow progress: target/loot timeout cows=1 inCombat=1 besidePlayer=0 players=0');
    }finally{g.dispose();}
});
test('a cow another account kills is given up at once, and the run goes on to its own kills',async()=>{
    const f=fixture(),sdk=f.session.sdk as any,bot=f.session.bot as any,state=sdk.getState.bind(sdk),attack=bot.attack.bind(bot);let calls=0,hideUntil=-1;
    // The first cow goes with no own XP and no drops, and a cow with the same index is back three ticks later.
    bot.attack=async(...args:any[])=>{calls++;if(calls===1){hideUntil=f.session.tick()+3;return{success:true};}return attack(...args);};
    sdk.getState=()=>{const st=state();return f.session.tick()<hideUntil?{...st,nearbyNpcs:[]}:st;};
    try{const r=await runCows(f.session,{cap:500,maximum:5,walk:async()=>true,noProgress:40});
        expect(r.ok).toBe(true);expect(r.creditedKills).toBe(5);expect(calls).toBe(6);expect(r.banked).toEqual({hide:5,bones:5,beef:5});
    }finally{f.dispose();}
});
test('low HP with no food retreats and banks; a changed life stops without another attack',async()=>{
    for(const injury of ['low-nofood','death'] as const){const f=fixture(false,injury);try{const r=await runCows(f.session,{cap:120,maximum:5,walk:async()=>true,noProgress:20});
        expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(f.kills()).toBe(1);
        // The fixture removes Trout without an eat; that unobserved debit is a food loss.
        if(injury==='death'){expect(r.died).toBe(true);expect(r.lifeId).toBe(2);}else{expect(r.stop).toBe('low-hp');expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(false);}
    }finally{f.dispose();}}
});

test('generic combat rejects invalid finite caps before opening an account',()=>{
 for(const cap of ['0','-1','NaN','1.5']){const name='cap'+crypto.randomUUID().slice(0,8),r=Bun.spawnSync([process.execPath,'--smol',resolve(import.meta.dir,'gather-combat.ts'),name,cap,'druid'],{windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000}),text=r.stdout.toString()+r.stderr.toString();expect(r.exitCode).toBe(1);expect(text).toContain('finite positive CAP required');expect(text).not.toContain('bot.env');expect(text).not.toContain('START combat');}
});

test('generic combat rejects malformed optional kill targets before login',()=>{
 for(const maximum of ['0','-1','NaN','1.5']){const name='max'+crypto.randomUUID().slice(0,8),r=Bun.spawnSync([process.execPath,'--smol',resolve(import.meta.dir,'gather-combat.ts'),name,'1800','giant'],{env:{...process.env,MAX_KILLS:maximum},windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000}),text=r.stdout.toString()+r.stderr.toString();expect(r.exitCode).toBe(1);expect(text).toContain('finite positive MAX_KILLS required');expect(text).not.toContain('bot.env');}
});

test('generic combat binds native Giant117 and Chaos druid181 rather than donor names',()=>{const types=JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/npcs.json'),'utf8')) as {id:number;name:string}[];expect(types.find(n=>n.id===117)?.name).toBe('Giant');const giant={id:117,name:'Giant',distance:3,reachable:true,inCombat:false,targetIndex:-1},druid={...giant,id:181,name:'Chaos druid'},warrior={...giant,id:193,name:'Chaos druid warrior',distance:1};expect(genericCombatNpc('giant',[warrior,giant,druid])).toBe(giant);expect(genericCombatNpc('druid',[warrior,giant,druid])).toBe(druid);});
test('generic combat rejects foreign, unreachable, unknown or out-of-leash targets',()=>{const base={id:117,distance:3,reachable:true,inCombat:false,targetIndex:-1};for(const bad of [{...base,inCombat:true},{...base,targetIndex:32770},{...base,reachable:false},{...base,distance:16},{...base,distance:NaN},{...base,distance:-1},{...base,targetIndex:undefined}])expect(genericCombatNpc('giant',[bad])).toBeUndefined();expect(genericCombatNpc('unknown',[base])).toBeUndefined();});

test('combat bank return requires fresh bank and paired loot debit/credit before success',async()=>{
 for(const mode of['landed','refused','missing-credit','bank-refused','stale-bank']){
  let tick=0,generation=0,open=false,inputs=0;const listeners=new Set<()=>void>(),pack=[{id:532,name:'Big bones',count:2,slot:0},{id:379,name:'Lobster',count:3,slot:1}],bank:any[]=[];
  const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);
  const s:any={name:'combat-bank',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},bankObservation:()=>open||mode==='stale-bank'?{generation,items:bank}:null,sdk:{getState:()=>({inventory:pack,bank:{isOpen:open}}),getInventory:()=>pack},bot:{openBank:async()=>{if(mode==='bank-refused')return{success:false};open=true;if(mode!=='stale-bank')generation++;return{success:true};},depositItem:async()=>{inputs++;if(mode==='refused')return{success:false};pack.shift();generation++;if(mode!=='missing-credit')bank.push({id:532,name:'Big bones',count:2});return{success:true};}}};
  try{if(mode==='landed'){await bankCombatLoot(s,/big bones/i);expect(pack.map(i=>i.id)).toEqual([379]);expect(bank[0].count).toBe(2);}else await expect(bankCombatLoot(s,/big bones/i)).rejects.toThrow();expect(inputs).toBe(['bank-refused','stale-bank'].includes(mode)?0:1);}finally{clearInterval(timer);}
 }
});

test('generic combat prefers a native attacker targeting this player over a free NPC', () => {
    const free = {id:181,distance:1,reachable:true,inCombat:false,targetIndex:-1};
    const own = {...free,distance:3,inCombat:true,targetIndex:32769};
    const foreign = {...own,distance:0,targetIndex:32770};
    expect(genericCombatNpc('druid',[foreign,free,own],1)).toBe(own);
    expect(genericCombatNpc('druid',[foreign,free,own])).toBe(free);
});

test('cow food counts cake pieces in bites and eats the smallest piece first', () => {
    expect(cowFoodBites([{id:333,count:2}])).toBe(2);
    expect(cowFoodBites([{id:1891,count:1},{id:1893,count:1},{id:1895,count:2},{id:1901,count:1},{id:995,count:500}])).toBe(3+2+2+1);
    expect(cowFoodBites([{id:995,count:9}])).toBe(0);
    expect(cowFoodPick([{id:1891},{id:1893},{id:1895},{id:995}])?.id).toBe(1895);
    expect(cowFoodPick([{id:1897},{id:1899}])?.id).toBe(1899);
    expect(cowFoodPick([{id:995}])).toBeUndefined();
});

test('cow food bites and heals come from the content (cake 4 a bite in 3 bites, chocolate cake 5, trout 7)', () => {
    expect(cowFoodHeal([{id:333,count:1}])).toBe(7);
    expect(cowFoodHeal([{id:1891,count:1}])).toBe(12);
    expect(cowFoodHeal([{id:1897,count:1}])).toBe(15);
    expect(Object.keys(COW_FOOD_BITES).map(Number).sort((a,b)=>a-b)).toEqual([333,1891,1893,1895,1897,1899,1901]);
});

test('held cow food must cover the trout rule in HP, not in pieces', () => {
    expect(cowFoodHeal([{id:333,count:2}])).toBe(COW_FOOD_HP);
    expect(cowFoodHeal([{id:1895,count:3}])).toBe(12);
    expect(cowFoodHeal([{id:1895,count:3}])<COW_FOOD_HP).toBe(true);
    expect(cowFoodHeal([{id:1891,count:1},{id:1895,count:1}])).toBe(16);
    expect(cowFoodHeal([{id:1901,count:3}])).toBe(15);
});

test('cow mode gives a cow up after 12 ticks in someone else\'s combat, or 40 ticks with no own XP and no combat', () => {
    expect(COW_RELEASE).toBe(12);
    expect(cowReleased(11, 39)).toBe(false);
    expect(cowReleased(12, 0)).toBe(true);
    expect(cowReleased(0, 40)).toBe(true);
});

test('selectGiantArmour picks best owned armour per Defence level and quest unlocks', () => {
    const stock = [
        { id: 1725, count: 1 }, { id: 1731, count: 1 }, { id: 3105, count: 1 },
        { id: 1163, count: 1 }, { id: 1127, count: 1 }, { id: 1113, count: 1 },
        { id: 4087, count: 1 }, { id: 1079, count: 1 }, { id: 1201, count: 1 },
        { id: 3751, count: 1 }, { id: 1052, count: 1 },
    ];
    // Defence 1: only neck (Amulet of strength 1725) and feet (Climbing boots 3105) have no Defence requirement.
    expect(selectGiantArmour(stock, 1, new Set())).toEqual([{ slot: 2, id: 1725 }, { slot: 10, id: 3105 }]);
    // Defence 45 with no quests: Rune chainbody (1113) instead of Rune platebody (1127), Rune full helm (1163) instead of Berserker helm (3751).
    expect(selectGiantArmour(stock, 45, new Set())).toEqual([
        { slot: 2, id: 1725 }, { slot: 10, id: 3105 }, { slot: 0, id: 1163 },
        { slot: 4, id: 1113 }, { slot: 7, id: 1079 }, { slot: 5, id: 1201 },
    ]);
    // Defence 60 with Dragon Slayer, The Fremennik Trials, and Legends' Quest: Berserker helm, Rune platebody, Dragon platelegs, Cape of legends.
    expect(selectGiantArmour(stock, 60, new Set(['dragon slayer', 'the fremennik trials', "legends' quest"]))).toEqual([
        { slot: 2, id: 1725 }, { slot: 10, id: 3105 }, { slot: 0, id: 3751 },
        { slot: 4, id: 1127 }, { slot: 7, id: 4087 }, { slot: 5, id: 1201 }, { slot: 1, id: 1052 },
    ]);
});

function progressiveCowFixture(opts: {
    startEquipment?: any[];
    startInv?: any[];
    bankItems?: any[];
    attackLevel?: () => number;
    defenceLevel?: () => number;
    onAttack?: (wornIds: number[]) => void;
} = {}) {
    let tick = 0, open = false, generation = 0, style = 0;
    const xp: Record<string, number> = { Attack: 0, Strength: 0, Defence: 0 };
    const listeners = new Set<() => void>();
    const equipment: any[] = [...(opts.startEquipment ?? [])];
    const inv: any[] = [...(opts.startInv ?? [{ id: 333, name: 'Trout', count: 2, slot: 0 }])];
    const bank: any[] = [...(opts.bankItems ?? [{ id: 333, name: 'Trout', count: 5, slot: 0 }])];
    let ground: any[] = [];
    let npc: any = { id: 81, index: 7, name: 'Cow', tileX: 2664, tileZ: 3344, x: 2664, z: 3344, hp: 8, maxHp: 8, inCombat: false };
    const wearPosFor = (id: number) => ({ righthand: 3, lefthand: 5, hat: 0, torso: 4, legs: 7, front: 2, back: 1, hands: 9, feet: 10 }[gearById(id)?.slot ?? 'righthand'] ?? 3);
    const wornWeapon = () => equipment.find(i => i.slot === 3);
    const stylesFor = (w: any) => {
        if (!w) return [{ index: 0, trainsSkills: ['Attack'] }, { index: 1, trainsSkills: ['Strength'] }, { index: 2, trainsSkills: ['Defence'] }];
        // Warhammers (weapon_blunt) put Defence at index 2 rather than sword/scimitar index 3.
        if (/warhammer/i.test(w.name)) {
            return [{ index: 0, trainsSkills: ['Attack'] }, { index: 1, trainsSkills: ['Strength'] }, { index: 2, trainsSkills: ['Defence'] }];
        }
        return [{ index: 0, trainsSkills: ['Attack'] }, { index: 1, trainsSkills: ['Strength'] }, { index: 3, trainsSkills: ['Defence'] }];
    };
    const timer = setInterval(() => { tick++; for (const f of [...listeners]) f(); }, 1);
    const session: any = {
        name: 'cow-prog',
        tick: () => tick,
        onTick: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); },
        ended: new Promise(() => {}),
        bankObservation: () => open ? { generation, at: Date.now(), items: bank } : null,
        sdk: {
            getState: () => ({
                player: { worldX: 2654, worldZ: 3283, level: 0, lifeId: 1, respawnCount: 0, hp: 10 },
                inventory: inv, equipment, nearbyPlayers: [], nearbyNpcs: npc ? [npc] : [], groundItems: ground,
                bank: { isOpen: open, items: bank },
                combatStyle: { known: true, currentStyle: style, weaponName: wornWeapon()?.name ?? '', styles: stylesFor(wornWeapon()) },
            }),
            getInventory: () => inv,
            getEquipment: () => equipment,
            getSkill: (n: string) => {
                if (n === 'Hitpoints') return { level: 10, baseLevel: 10 };
                if (n === 'Attack') { const l = opts.attackLevel?.() ?? 1; return { level: l, baseLevel: l }; }
                if (n === 'Defence') { const l = opts.defenceLevel?.() ?? 1; return { level: l, baseLevel: l }; }
                return { level: 1, baseLevel: 1 };
            },
            getSkillXp: (n: string) => xp[n] ?? 0,
            sendSetCombatStyle: async (n: number) => { style = n; return { success: true }; },
        },
        bot: {
            openBank: async () => { open = true; generation++; return { success: true }; },
            closeBank: async () => { open = false; return { success: true }; },
            equipItem: async (item: any) => {
                const slot = wearPosFor(item.id);
                const oldIdx = equipment.findIndex(i => i.slot === slot);
                if (oldIdx >= 0) inv.push(...equipment.splice(oldIdx, 1));
                inv.splice(inv.indexOf(item), 1);
                equipment.push({ ...item, slot });
                return { success: true };
            },
            attack: async () => {
                opts.onAttack?.(equipment.map(i => i.id).sort((a, b) => a - b));
                const tab = stylesFor(wornWeapon());
                const trained = tab.find(s => s.index === style)?.trainsSkills[0] ?? 'Attack';
                xp[trained] = (xp[trained] ?? 0) + 800;
                ground = [
                    { id: 1739, name: 'Cowhide', count: 1, x: 2664, z: 3344 },
                    { id: 526, name: 'Bones', count: 1, x: 2664, z: 3344 },
                    { id: 2132, name: 'Raw beef', count: 1, x: 2664, z: 3344 },
                ];
                npc = null;
                return { success: true };
            },
            pickupItem: async (item: any) => {
                ground = ground.filter(i => i !== item);
                const held = inv.find(i => i.id === item.id);
                if (held) held.count++; else inv.push({ ...item, slot: inv.length });
                if (!ground.length) npc = { id: 81, index: 7, name: 'Cow', tileX: 2664, tileZ: 3344, x: 2664, z: 3344, hp: 8, maxHp: 8, inCombat: false };
                return { success: true };
            },
            depositItem: async (item: any, n: number) => {
                const held = inv.find(i => i.id === item.id);
                if (!held) return { success: false };
                const take = n < 0 ? held.count : Math.min(held.count, n);
                const row = bank.find(i => i.id === item.id);
                if (row) row.count += take; else bank.push({ id: held.id, name: held.name, count: take, slot: bank.length });
                held.count -= take;
                if (held.count <= 0) inv.splice(inv.indexOf(held), 1);
                generation++;
                return { success: true };
            },
            withdrawItem: async (item: any, n: number) => {
                item.count -= n;
                if (item.count <= 0) bank.splice(bank.indexOf(item), 1);
                inv.push({ id: item.id, name: item.name, count: n, slot: inv.length });
                generation++;
                return { success: true };
            },
        },
    };
    return { session: session as Session, equipment, inv, bank, getStyle: () => style, dispose: () => clearInterval(timer) };
}

test('runCows equips banked melee weapon+armour upgrades, reconciles assets, and dynamically matches warhammer styles', async () => {
    const f = progressiveCowFixture({
        startEquipment: [{ id: 1337, name: 'Bronze warhammer', count: 1, slot: 3 }, { id: 1171, name: 'Wooden shield', count: 1, slot: 5 }],
        bankItems: [
            { id: 333, name: 'Trout', count: 5, slot: 0 },
            { id: 1335, name: 'Iron warhammer', count: 1, slot: 1 },
            { id: 1191, name: 'Iron kiteshield', count: 1, slot: 2 },
            { id: 1153, name: 'Iron full helm', count: 1, slot: 3 },
            { id: 1725, name: 'Amulet of strength', count: 1, slot: 4 },
        ],
    });
    try {
        const r = await runCows(f.session, { cap: 500, maximum: 2, trainSkill: 'Defence', walk: async () => true });
        expect(r.ok).toBe(true);
        expect(r.preserved).toBe(true);
        expect(r.banked).toEqual({ hide: 2, bones: 2, beef: 2 });
        // Warhammer (weapon_blunt) puts Block (Defence) at index 2 rather than sword's 3.
        expect(f.getStyle()).toBe(2);
        expect(f.equipment.map(i => i.id).sort((a, b) => a - b)).toEqual([1153, 1191, 1335, 1725]);
        // Replaced Bronze warhammer (1337) and Wooden shield (1171) were returned cleanly to bank.
        expect(f.bank.some(i => i.id === 1337 && i.count === 1)).toBe(true);
        expect(f.bank.some(i => i.id === 1171 && i.count === 1)).toBe(true);
    } finally {
        f.dispose();
    }
});

test('runCows re-checks inventory and bank gear upgrades when crossing level tier boundaries 5..60', async () => {
    const attackSequence: number[][] = [];
    let kills = 0;
    const invUpgrade = progressiveCowFixture({
        startEquipment: [{ id: 1277, name: 'Bronze sword', count: 1, slot: 3 }, { id: 1171, name: 'Wooden shield', count: 1, slot: 5 }],
        startInv: [{ id: 333, name: 'Trout', count: 2, slot: 0 }, { id: 1325, name: 'Steel scimitar', count: 1, slot: 1 }],
        attackLevel: () => (kills >= 1 ? 5 : 1),
        onAttack: (worn) => { kills++; attackSequence.push(worn); },
    });
    try {
        const r = await runCows(invUpgrade.session, { cap: 500, maximum: 2, trainSkill: 'Attack', walk: async () => true });
        expect(r.ok).toBe(true);
        expect(r.preserved).toBe(true);
        expect(attackSequence[0]).toEqual([1171, 1277]);
        // After Attack reaches 5 on kill 1, Steel scimitar (1325) in inv is worn immediately for kill 2.
        expect(attackSequence[1]).toEqual([1171, 1325]);
    } finally {
        invUpgrade.dispose();
    }

    const bankSequence: number[][] = [];
    let defKills = 0;
    const bankUpgrade = progressiveCowFixture({
        startEquipment: [{ id: 1277, name: 'Bronze sword', count: 1, slot: 3 }, { id: 1171, name: 'Wooden shield', count: 1, slot: 5 }],
        bankItems: [
            { id: 333, name: 'Trout', count: 5, slot: 0 },
            { id: 1193, name: 'Steel kiteshield', count: 1, slot: 1 },
            { id: 1157, name: 'Steel full helm', count: 1, slot: 2 },
        ],
        defenceLevel: () => (defKills >= 1 ? 5 : 1),
        onAttack: (worn) => { defKills++; bankSequence.push(worn); },
    });
    try {
        const r = await runCows(bankUpgrade.session, { cap: 500, maximum: 2, trainSkill: 'Defence', targetLevel: 10, walk: async () => true });
        expect(r.ok).toBe(true);
        expect(r.preserved).toBe(true);
        expect(r.bankTrips).toBeGreaterThanOrEqual(3);
        expect(bankSequence[0]).toEqual([1171, 1277]);
        // Crossing Defence 5 on kill 1 triggers a bank trip to equip Steel kiteshield + Steel full helm.
        expect(bankSequence[1]).toEqual([1157, 1193, 1277]);
        expect(bankUpgrade.bank.some(i => i.id === 1171 && i.count === 1)).toBe(true);
    } finally {
        bankUpgrade.dispose();
    }
});

test('the giant and trooper ids and the bear boxes match the content',()=>{
    expect(GIANT).toMatchObject({npc:117,food:385,bigBones:532,limpwurt:225});
    expect(GIANT_HERBS).toEqual([199,201,203,205,207,209,211,213,215,217,219]);
    expect(TROOPER_FOODS).toEqual([385,373,379,333,2142,2309,1901,1895,1893,1891]);
    expect(TROOPER_SITE.npcs).toEqual([475,476]);
    const bears=(JSON.parse(readFileSync(resolve(import.meta.dir,'../knowledge/npcs.json'),'utf8')) as {id:number;spawns:{x:number;z:number;level:number}[]}[]).find(n=>n.id===105)!.spawns;
    for(const [x1,z1,x2,z2] of COW_BEAR_BOXES){
        const inside=bears.filter(s=>s.level===0&&s.x>=x1&&s.x<=x2&&s.z>=z1&&s.z<=z2);
        expect(inside.length).toBeGreaterThan(0);
        expect([Math.min(...inside.map(s=>s.x)),Math.min(...inside.map(s=>s.z)),Math.max(...inside.map(s=>s.x)),Math.max(...inside.map(s=>s.z))]).toEqual([x1,z1,x2,z2]);
    }
    const area=bears.filter(s=>s.level===0&&s.x>=2600&&s.x<=2740&&s.z>=3250&&s.z<=3360);
    expect(area.every(s=>COW_BEAR_BOXES.some(([x1,z1,x2,z2])=>s.x>=x1&&s.x<=x2&&s.z>=z1&&s.z<=z2))).toBe(true);
});

test('non-Wilderness mainland supply configs resolve valid targets, guard Wilderness borders, and traverse Taverley Dungeon', async () => {
    for (const key of ['unicorn', 'wizard', 'giant', 'taverley_druid', 'taverley_scales', 'taverley_blue_dragon', 'taverley_black_dragon', 'chaos_wine']) {
        const conf = CONFIGS[key]!;
        expect(conf).toBeDefined();
        expect(isNonWildernessGatherGoal(conf.spot.x, conf.spot.z)).toBe(true);
        expect(isNonWildernessGatherGoal(conf.bankSpot.x, conf.bankSpot.z)).toBe(true);
    }
    expect(isNonWildernessGatherGoal(3115, 9928)).toBe(false); // Edgeville dungeon Chaos druids (Wilderness)
    expect(isNonWildernessGatherGoal(3087, 3452)).toBe(true); // Edgeville surface Unicorns (non-Wilderness)
    expect(isNonWildernessGatherGoal(2932, 3515)).toBe(true); // Chaos Temple outside Wilderness
    expect(isNonWildernessGatherGoal(3095, 3521)).toBe(false); // Wilderness surface north of z=3520

    const npcsJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/npcs.json'), 'utf8')) as { id: number; name: string }[];
    const base = { distance: 2, reachable: true, inCombat: false, targetIndex: -1 };
    expect(genericCombatNpc('taverley_druid', [{ ...base, id: 181 }])?.id).toBe(181);
    const blueId = npcsJson.find(n => n.name === 'Blue dragon')!.id;
    const blackId = npcsJson.find(n => n.name === 'Black dragon')!.id;
    expect(genericCombatNpc('taverley_blue_dragon', [{ ...base, id: blueId }])?.id).toBe(blueId);
    expect(genericCombatNpc('taverley_black_dragon', [{ ...base, id: blackId }])?.id).toBe(blackId);

    const travel = createTaverleyTravel();
    const player = { worldX: 2946, worldZ: 3368, level: 0 };
    const inv = [{ id: TAVERLEY_ROUTE.DUSTY_KEY_ID, count: 1, slot: 0, name: 'Dusty key' }];
    const actions: string[] = [];
    const s: any = {
        tick: () => 0,
        onTick: () => () => {},
        sdk: {
            getInventory: () => inv,
            getState: () => ({
                player,
                nearbyLocs: [
                    { id: TAVERLEY_ROUTE.LADDER_DOWN.id, name: 'Ladder', x: TAVERLEY_ROUTE.LADDER_DOWN.x, z: TAVERLEY_ROUTE.LADDER_DOWN.z },
                    { id: TAVERLEY_ROUTE.LADDER_UP.id, name: 'Ladder', x: TAVERLEY_ROUTE.LADDER_UP.x, z: TAVERLEY_ROUTE.LADDER_UP.z },
                    { id: TAVERLEY_ROUTE.DUSTY_GATE.id, name: 'Gate', x: TAVERLEY_ROUTE.DUSTY_GATE.x, z: TAVERLEY_ROUTE.DUSTY_GATE.z },
                ],
            }),
        },
        bot: {
            interactLoc: async (loc: any, op: RegExp) => {
                actions.push(`loc:${loc.id}:${op.source}`);
                if (loc.id === TAVERLEY_ROUTE.LADDER_DOWN.id) { player.worldX = 2884; player.worldZ = 9797; }
                else if (loc.id === TAVERLEY_ROUTE.LADDER_UP.id) { player.worldX = 2884; player.worldZ = 3397; }
                else if (loc.id === TAVERLEY_ROUTE.DUSTY_GATE.id) { player.worldX = 2925; player.worldZ = 9803; }
                return { success: true };
            },
            useItemOnLoc: async (item: any, loc: any) => {
                actions.push(`key:${item.id}->${loc.id}`);
                player.worldX = 2923; player.worldZ = 9803;
                return { success: true };
            },
        },
    };
    const ground = async (x: number, z: number) => { actions.push(`ground:${x},${z}`); player.worldX = x; player.worldZ = z; return true; };

    expect(await travel.walk(s, 'taverley_black_dragon', { x: 2832, z: 9825 }, ground, () => false, 2)).toBe(true);
    expect(actions).toEqual(['ground:2884,3397', 'loc:1759:climb-down', 'ground:2925,9803', 'key:1590->2623', 'ground:2832,9825']);

    actions.length = 0;
    expect(await travel.walk(s, 'taverley_black_dragon', { x: 2946, z: 3368 }, ground, () => false, 2)).toBe(true);
    expect(actions).toEqual(['ground:2923,9803', 'loc:2623:open', 'ground:2884,9797', 'loc:1755:climb-up', 'ground:2946,3368']);

    await expect(travel.walk(s, 'taverley_druid', { x: 3115, z: 9928 }, ground, () => false, 2)).rejects.toThrow('Wilderness goal forbidden');
});
