import {test,expect} from 'bun:test';
import {cowCredit,runCows,cowTraining,cowGroundCounts,guardCowWalker,cowRoutePoints,cowProfile,cowStopControl} from './gather-combat';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks} from '../packages/core/src/ticks';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

test('real CLI rejects unknown combat target before reading account config; valid targets still reach missing phantom config',async()=>{
    const name='__combat_validation_no_account__';
    expect(existsSync(resolve(import.meta.dir,'../vendor/rs-sdk/bots',name))).toBe(false);
    for(const target of ['imp','bogus','cow','druid','giant']){
        // The synchronous Windows child bridge reported ETIMEDOUT during broad
        // runs while the identical isolated CLI passed. Await the real child
        // and both pipes, retaining the same5s deadline and exit/output checks.
        const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'gather-combat.ts'),name,'1',...(target==='imp'?[]:[target])],{env:{...process.env,DEMO_OK:'0',TARGET:target},stdout:'pipe',stderr:'pipe'});
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
test('low HP with no food retreats and banks; a changed life stops without another attack',async()=>{
    for(const injury of ['low-nofood','death'] as const){const f=fixture(false,injury);try{const r=await runCows(f.session,{cap:120,maximum:5,walk:async()=>true,noProgress:20});
        expect(r.ok).toBe(false);expect(r.creditedKills).toBe(0);expect(f.kills()).toBe(1);
        // The fixture removes Trout without an eat; that unobserved debit is a food loss.
        if(injury==='death'){expect(r.died).toBe(true);expect(r.lifeId).toBe(2);}else{expect(r.stop).toBe('low-hp');expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(false);}
    }finally{f.dispose();}}
});
