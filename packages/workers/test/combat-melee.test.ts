import { describe, expect, test } from 'bun:test';
import {
    AMMO_REACH,
    AMMO_WORTH,
    CONFIGS,
    COW_BEAR_BOXES,
    COW_FOOD_BITES,
    COW_FOOD_HP,
    COW_RELEASE,
    GIANT,
    GIANT_HERBS,
    TAVERLEY_ROUTE,
    TROOPER_FOODS,
    TROOPER_SITE,
    ammoPiles,
    anothersFight,
    bankCombatLoot,
    chickenCombatUnlockMode,
    chickenCombatUnlockPlan,
    chickenCombatUnlockStyle,
    chickenDesiredSkill,
    chickenStrengthGoal,
    chickenStyleForWeapon,
    chickenTrainingEntry,
    chickenTrainingHealth,
    chickenTrainingKit,
    chickenTrainingProfile,
    chickenTrainingStyle,
    chickenTrainingTarget,
    chickenTrainingThreat,
    combatTargetFinished,
    cowCredit,
    cowFoodBites,
    cowFoodHeal,
    cowFoodPick,
    cowGroundCounts,
    cowProfile,
    cowReleased,
    cowRoutePoints,
    cowStopControl,
    cowTraining,
    createTaverleyTravel,
    ensureSurfaceGroundEntry,
    genericCombatNpc,
    giantCredit,
    giantKillLimit,
    giantStyle,
    giantTraining,
    guardArdougneTrainingWalker,
    guardCowWalker,
    isNonWildernessGatherGoal,
    needsLongSurfaceWalk,
    retreatBudget,
    retreatWaypoints,
    roamTarget,
    runCows,
    runGiants,
    selectGiantArmour,
    selectGiantArrows,
    selectGiantBow,
    selectGiantWeapon,
    selectedGiantRangedKit,
    trainChickens,
} from '../src/combat';
import { type Session } from '../../../packages/core/src/inprocess';
import { questDefinitions } from '../../../packages/core/src/quest-status';
import { waitTicks } from '../../../packages/core/src/ticks';
import { gearById } from '../../../packages/planner/src/gear-progression';
import { mixedOreCombatProblem } from '../src/gather';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('train-chickens', () => {
test('qualification keeps combat13 by default and admits the bounded combat29 courier target',()=>{
    expect(chickenTrainingTarget()).toBe(13);
    expect(chickenTrainingTarget(29)).toBe(29);
    for(const n of [NaN,0,12,14,28,29.5,126])expect(()=>chickenTrainingTarget(n)).toThrow('13 or29');
});

test('training raises the weakest melee stat with the actual bronze sword style indices',()=>{
    expect(chickenTrainingStyle({Attack:5,Strength:1,Defence:5})).toBe(1);
    expect(chickenTrainingStyle({Attack:1,Strength:5,Defence:5})).toBe(0);
    expect(chickenTrainingStyle({Attack:5,Strength:5,Defence:1})).toBe(3);
    expect(()=>chickenTrainingStyle({Attack:0,Strength:1,Defence:1})).toThrow();
});

test('the mixed mine requires combat above twice the level6 rat, with unknown stats refused',()=>{
    for(const level of [undefined,NaN,0,3,12,12.5])expect(mixedOreCombatProblem(level)).toContain('combat13');
    expect(mixedOreCombatProblem(13)).toBeNull();
    expect(mixedOreCombatProblem(50)).toBeNull();
});

test('training uses an owned melee weapon and shield/armour upgrades, respecting levels and lower-health safety',()=>{
    expect(chickenTrainingKit([{id:1277},{id:1171},{id:1265}])).toEqual([1277,1171]);
    expect(chickenTrainingKit([{id:1265},{id:995}])).toEqual([1265]);
    expect(chickenTrainingKit([{id:1265},{id:1171}])).toEqual([1265,1171]);
    expect(chickenTrainingKit([{id:995},{id:1205}])).toEqual([1205]);
    expect(()=>chickenTrainingKit([{id:995},{id:315}])).toThrow('missing owned training weapon');

    const richStock=[{id:1277},{id:1171},{id:1333},{id:1201},{id:1163},{id:1127},{id:1113},{id:1079},{id:1725}];
    // Level 1 cannot wear Rune (40): keeps Bronze sword + Wooden shield + Amulet of strength.
    expect(chickenTrainingKit(richStock,{levels:{Attack:1,Defence:1}})).toEqual([1277,1171,1725]);
    // Attack 40 / Defence 40 without Dragon Slayer equips Rune scimitar, kiteshield, full helm, chainbody, platelegs, amulet.
    expect(chickenTrainingKit(richStock,{levels:{Attack:40,Defence:40},quests:[]})).toEqual([1333,1201,1163,1113,1079,1725]);
    // With Dragon Slayer complete, upgrades Rune chainbody (1113) to Rune platebody (1127).
    expect(chickenTrainingKit(richStock,{levels:{Attack:40,Defence:40},quests:['Dragon Slayer']})).toEqual([1333,1201,1163,1127,1079,1725]);
    // Lower-health mode accepts upgraded shield+sword equivalents and rejects dagger, pickaxe, or shieldless kits.
    expect(chickenTrainingKit([{id:1333},{id:1201},{id:1127}],{levels:{Attack:40,Defence:40},quests:['Dragon Slayer'],entry:'lower-health'})).toEqual([1333,1201,1127]);
    expect(()=>chickenTrainingKit([{id:1277}],{entry:'lower-health'})).toThrow('lower-health');
    expect(()=>chickenTrainingKit([{id:1205},{id:1171}],{entry:'lower-health'})).toThrow('lower-health');
    expect(()=>chickenTrainingKit([{id:1265},{id:1171}],{entry:'lower-health'})).toThrow('lower-health');
});

test('training admits only the two audited bank routes and keeps the original Varrock default',()=>{
    expect(chickenTrainingProfile().route[0]).toMatchObject({x:3253,z:3420});
    expect(chickenTrainingProfile('draynor').route[0]).toMatchObject({x:3092,z:3243});
    expect(chickenTrainingProfile('draynor').route.at(-1)).toEqual(chickenTrainingProfile().route.at(-1));
    expect(()=>chickenTrainingProfile('unknown')).toThrow('unsupported training bank');
});

test('Draynor wizard threshold follows its hunt3 plus one tile; jail guards and other threats remain guarded',()=>{
    const wizard={name:'Dark wizard',distance:5};
    expect(chickenTrainingThreat(wizard,'varrock')).toBe(true);
    expect(chickenTrainingThreat(wizard,'draynor')).toBe(false);
    expect(chickenTrainingThreat({...wizard,distance:4},'draynor')).toBe(true);
    expect(chickenTrainingThreat({name:'Jail guard',distance:7},'draynor')).toBe(true);
    expect(chickenTrainingThreat({name:'Highwayman',distance:7},'draynor')).toBe(true);
});

test('bootstrap chicken demand is finite and invalid demand fails before game actions',async()=>{
 for(const rawChicken of [-1,13,1.5,NaN])await expect(trainChickens({} as any,1800,'draynor',13,{rawChicken})).rejects.toThrow('0..12');
});

test('Ardougne is a local bank-to-farm profile and requires a bounded Strength goal',()=>{
 const p=chickenTrainingProfile('ardougne');expect(p.route[0]).toMatchObject({x:2654,z:3283});
 expect(p.pen).toMatchObject({x0:2686,x1:2700,z0:3268,z1:3283});
 expect(()=>chickenStrengthGoal('ardougne',undefined,undefined)).toThrow('explicit Strength');
 expect(chickenStrengthGoal('ardougne','Strength',13)).toBe(13);
 for(const [skill,level] of [['Attack',13],['Strength',0],['Strength',13.5],['Strength',100]] as const)
  expect(()=>chickenStrengthGoal('ardougne',skill,level)).toThrow();
});
test('partial HP admission is explicit and does not relax the original full-health profiles',()=>{
 expect(()=>chickenTrainingHealth('ardougne',27,35)).not.toThrow();
 for(const hp of [0,10,26,NaN])expect(()=>chickenTrainingHealth('ardougne',hp,35)).toThrow('at least27');
 expect(()=>chickenTrainingHealth('varrock',27,35)).toThrow('full HP');
 expect(()=>chickenTrainingHealth('draynor',35,35)).not.toThrow();
 expect(chickenTrainingThreat({name:'Bear',distance:4},'ardougne')).toBe(true);
 expect(chickenTrainingThreat({name:'Giant bat',distance:9},'ardougne')).toBe(false);
});
test('Ardougne route guard blocks direct and partial-path fallbacks outside the admitted corridor',()=>{
 let sent=0;
 const base={pos:()=>({x:2655,z:3283,level:0}),plan:(_l:number,_f:any,to:any)=>[to],walk:()=>{sent++;return{};},interactLoc:()=>({})} as any;
 const safe=guardArdougneTrainingWalker(base);
 safe.deps.walk(2691,3277);expect(sent).toBe(1);
 safe.deps.walk(2765,3422);expect(sent).toBe(1);expect(safe.reason()).toContain('outside admitted');
 const detour=guardArdougneTrainingWalker({...base,plan:(_l:number,_f:any,to:any)=>[{x:2640,z:3274},to]});
 expect(detour.deps.plan(0,{x:2655,z:3283},{x:2691,z:3277})).toEqual([]);
 detour.deps.walk(2691,3277);expect(sent).toBe(1);
 const partial=guardArdougneTrainingWalker({...base,plan:()=>[{x:2660,z:3283}]});
 partial.deps.walk(2691,3277);expect(sent).toBe(1);
});

test('lower-health entry is explicit, local and cannot relax default Brave admission',()=>{
 expect(chickenTrainingEntry()).toBe('standard');expect(chickenTrainingEntry('lower-health')).toBe('lower-health');
 expect(()=>chickenTrainingEntry('toss')).toThrow('unsupported');
 expect(()=>chickenTrainingHealth('ardougne',10,19,'lower-health')).not.toThrow();
 for(const [bank,hp,max] of [['ardougne',9,19],['ardougne',10,18],['draynor',10,19],['varrock',10,19],['ardougne',20,19]] as const)expect(()=>chickenTrainingHealth(bank,hp,max,'lower-health')).toThrow('lower-health');
 expect(()=>chickenTrainingHealth('ardougne',10,19)).toThrow('at least27');
 expect(()=>chickenTrainingHealth('ardougne',27,35)).not.toThrow();
});
test('balanced unlock minimizes remaining melee XP with conservative HP growth and fixes Attack',()=>{
 const levels={Attack:28,Defence:1,Hitpoints:19,Prayer:1,Ranged:1,Magic:1};
 expect(chickenCombatUnlockPlan(levels,{Strength:0,Defence:0,Hitpoints:3060})).toEqual({strength:27,defence:18,hitpoints:27,combat:29,requiredXp:8310});
 const partial=chickenCombatUnlockPlan({...levels,Defence:2},{Strength:200,Defence:100,Hitpoints:3060});expect(partial.requiredXp).toBeLessThan(8310);
 expect(()=>chickenCombatUnlockPlan(levels,{Strength:NaN,Defence:0,Hitpoints:3060})).toThrow('unavailable');
 expect(()=>chickenCombatUnlockPlan({...levels,Attack:0},{Strength:0,Defence:0,Hitpoints:3060})).toThrow('unavailable');
});
test('balanced phases raise early damage, then Defence, then remaining Strength with no Attack style',()=>{
 const plan={strength:27,defence:18};
 expect(chickenCombatUnlockStyle({Strength:1,Defence:1},plan)).toBe(1);
 expect(chickenCombatUnlockStyle({Strength:6,Defence:1},plan)).toBe(3);
 expect(chickenCombatUnlockStyle({Strength:6,Defence:18},plan)).toBe(1);
 expect(()=>chickenCombatUnlockStyle({Strength:27,Defence:18},plan)).toThrow('exhausted');
 expect(Math.floor(((6+8)*69+320)/640)).toBe(2);
 expect(chickenCombatUnlockMode('ardougne','CombatUnlock',undefined,'lower-health',29)).toBe(true);
 expect(chickenCombatUnlockMode('ardougne','Strength',13,'standard',29)).toBe(false);
 for(const args of [['draynor','CombatUnlock',undefined,'lower-health',29],['ardougne','CombatUnlock',27,'lower-health',29],['ardougne','CombatUnlock',undefined,'standard',29]] as const)expect(()=>chickenCombatUnlockMode(args[0],args[1],args[2],args[3],args[4])).toThrow('requires');
});

test('chickenStyleForWeapon matches dynamic weapon tabs including warhammer Defence index 2',()=>{
    const bluntTab={known:true,weaponName:'Iron warhammer',currentStyle:0,styles:[
        {index:0,name:'Pound',trainsSkills:['Attack']},
        {index:1,name:'Pummel',trainsSkills:['Strength']},
        {index:2,name:'Block',trainsSkills:['Defence']},
    ]};
    expect(chickenDesiredSkill({Attack:1,Strength:5,Defence:5})).toBe('Attack');
    expect(chickenDesiredSkill({Attack:5,Strength:5,Defence:1})).toBe('Defence');
    expect(chickenStyleForWeapon(bluntTab,'Defence')).toBe(2);
    expect(chickenStyleForWeapon(bluntTab,'Strength')).toBe(1);
    expect(()=>chickenStyleForWeapon({known:false,currentStyle:0,styles:[]},'Attack')).toThrow('styles unknown');
    expect(()=>chickenStyleForWeapon({known:true,weaponName:'Rune spear',currentStyle:0,styles:[{index:0,trainsSkills:['Attack','Strength','Defence']}]},'Strength')).toThrow('no style');
});

test('trainChickens equips best owned melee upgrades and picks non-sword weapon style indices dynamically',async()=>{
    let tick=0,open=false,style=0;
    const xp:Record<string,number>={Attack:0,Strength:1800,Defence:0,Hitpoints:3060};
    let pos={x:2654,z:3283};
    const listeners=new Set<()=>void>();
    const inv:any[]=[{id:1265,name:'Bronze pickaxe',count:1,slot:0}];
    const equipment:any[]=[];
    const bank:any[]=[
        {id:1343,name:'Mithril warhammer',count:1,slot:0},
        {id:1191,name:'Iron kiteshield',count:1,slot:1},
        {id:1153,name:'Iron full helm',count:1,slot:2},
    ];
    let chicken:any={id:41,index:12,name:'Chicken',x:2691,z:3277,hp:3,inCombat:false,reachable:true,distance:1,optionsWithIndex:[{text:'Attack',opIndex:2}]};
    const wearPosFor=(id:number)=>({righthand:3,lefthand:5,hat:0,torso:4,legs:7,front:2,back:1,hands:9,feet:10}[gearById(id)?.slot??'righthand']??3);
    const wornWeapon=()=>equipment.find(i=>i.slot===3);
    const stylesFor=(w:any)=>w?.id===1343
        ?[{index:0,name:'Pound',trainsSkills:['Attack']},{index:1,name:'Pummel',trainsSkills:['Strength']},{index:2,name:'Block',trainsSkills:['Defence']}]
        :[{index:0,name:'Stab',trainsSkills:['Attack']},{index:1,name:'Lunge',trainsSkills:['Strength']},{index:3,name:'Block',trainsSkills:['Defence']}];
    const combatLv=()=>xp.Defence>=4000?29:21;
    const defLv=()=>xp.Defence>=4000?19:1;
    const strLv=()=>14;
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const session:any={
        name:'chicken-prog',
        tick:()=>tick,
        onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},
        ended:new Promise(()=>{}),
        sdk:{
            getInventory:()=>inv,
            getEquipment:()=>equipment,
            getSkill:(n:string)=>{
                if(n==='Attack')return{level:28,baseLevel:28};
                if(n==='Strength')return{level:strLv(),baseLevel:strLv()};
                if(n==='Defence')return{level:defLv(),baseLevel:defLv()};
                if(n==='Hitpoints')return{level:19,baseLevel:19};
                return{level:1,baseLevel:1};
            },
            getSkillXp:(n:string)=>xp[n]??0,
            getState:()=>({
                player:{worldX:pos.x,worldZ:pos.z,level:0,combatLevel:combatLv()},
                inventory:inv,equipment,nearbyNpcs:pos.x>2680&&chicken?[chicken]:[],groundItems:[],
                bank:{isOpen:open,items:bank},
                combatStyle:{known:true,currentStyle:style,weaponName:wornWeapon()?.name??'',styles:stylesFor(wornWeapon())},
            }),
            sendSetCombatStyle:async(n:number)=>{style=n;return{success:true};},
            sendInteractNpc:async()=>{
                xp.Defence+=4000;
                chicken=null;
                return{success:true};
            },
        },
        bot:{
            openBank:async()=>{open=true;return{success:true};},
            closeBank:async()=>{open=false;return{success:true};},
            depositItem:async(item:any)=>{const idx=inv.indexOf(item);if(idx>=0)inv.splice(idx,1);bank.push({...item,slot:bank.length});return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;if(!item.count)bank.splice(bank.indexOf(item),1);inv.push({id:item.id,name:item.name,count:n,slot:inv.length});return{success:true};},
            equipItem:async(item:any)=>{
                const slot=wearPosFor(item.id);
                const oldIdx=equipment.findIndex(e=>e.slot===slot);
                if(oldIdx>=0)inv.push(...equipment.splice(oldIdx,1));
                inv.splice(inv.indexOf(item),1);
                equipment.push({...item,slot});
                return{success:true};
            },
            unequipItem:async(item:any)=>{equipment.splice(equipment.indexOf(item),1);inv.push({...item});return{success:true};},
            pickupItem:async()=>({success:true}),
        },
    };
    try{
        const r=await trainChickens(session,400,'ardougne',29,{
            trainSkill:'CombatUnlock',entry:'lower-health',
            walk:async(pts)=>{pos={x:pts.at(-1)!.x,z:pts.at(-1)!.z};await waitTicks(session,1);},
        });
        expect(r.ok).toBe(true);expect(r.preserved).toBe(true);
        // Mithril warhammer puts Block (Defence) at index 2 rather than sword's 3.
        expect(style).toBe(2);
        expect(equipment.map(i=>i.id).sort((a,b)=>a-b)).toEqual([1153,1191,1343]);
        // Secured pickaxe returned to inventory at end.
        expect(inv.some(i=>i.id===1265)).toBe(true);
    }finally{clearInterval(timer);}
});
});

describe('gather-combat', () => {
test('real CLI rejects unknown combat target before reading account config; valid targets still reach missing phantom config',async()=>{
    const name='__combat_validation_no_account__';
    expect(existsSync(resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name))).toBe(false);
    for(const target of ['bogus','cow','druid','giant']){
        // The synchronous Windows child bridge reported ETIMEDOUT during broad
        // runs while the identical isolated CLI passed. Await the real child
        // and both pipes, retaining the same5s deadline and exit/output checks.
        const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../../../scripts/aio-fighter.ts'),name,target,'1'],{env:{...process.env,FLEET_SIDE:'local',DEMO_OK:'0',TARGET:target},windowsHide:true,stdout:'pipe',stderr:'pipe'});
        let timedOut=false;
        const timer=setTimeout(()=>{timedOut=true;child.kill();},5000);
        let output:string;
        try{
            const [out,err,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
            expect(timedOut).toBe(false);expect(status).toBe(1);output=out+err;
        }finally{clearTimeout(timer);}
        expect(output).not.toContain('Pathfinding initialized');expect(output).not.toContain('START ');
        if(target==='bogus'){
            expect(output).toContain(`unknown target "${target}"`);
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
 for(const cap of ['0','-1','NaN','1.5']){const name='cap'+crypto.randomUUID().slice(0,8),r=Bun.spawnSync([process.execPath,'--smol',resolve(import.meta.dir,'../../../scripts/aio-fighter.ts'),name,'druid',cap],{windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000}),text=r.stdout.toString()+r.stderr.toString();expect(r.exitCode).toBe(1);expect(text).toContain('finite positive CAP required');expect(text).not.toContain('bot.env');expect(text).not.toContain('START combat');}
});

test('generic combat rejects malformed optional kill targets before login',()=>{
 for(const maximum of ['0','-1','NaN','1.5']){const name='max'+crypto.randomUUID().slice(0,8),r=Bun.spawnSync([process.execPath,'--smol',resolve(import.meta.dir,'../../../scripts/aio-fighter.ts'),name,'giant','1800'],{env:{...process.env,MAX_KILLS:maximum},windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000}),text=r.stdout.toString()+r.stderr.toString();expect(r.exitCode).toBe(1);expect(text).toContain('finite positive MAX_KILLS required');expect(text).not.toContain('bot.env');}
});

test('generic combat binds native Giant117 and Chaos druid181 rather than donor names',()=>{const types=JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/npcs.json'),'utf8')) as {id:number;name:string}[];expect(types.find(n=>n.id===117)?.name).toBe('Giant');const giant={id:117,name:'Giant',distance:3,reachable:true,inCombat:false,targetIndex:-1},druid={...giant,id:181,name:'Chaos druid'},warrior={...giant,id:193,name:'Chaos druid warrior',distance:1};expect(genericCombatNpc('giant',[warrior,giant,druid])).toBe(giant);expect(genericCombatNpc('druid',[warrior,giant,druid])).toBe(druid);});
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
    const bears=(JSON.parse(readFileSync(resolve(import.meta.dir,'../../../knowledge/npcs.json'),'utf8')) as {id:number;spawns:{x:number;z:number;level:number}[]}[]).find(n=>n.id===105)!.spawns;
    for(const [x1,z1,x2,z2] of COW_BEAR_BOXES){
        const inside=bears.filter(s=>s.level===0&&s.x>=x1&&s.x<=x2&&s.z>=z1&&s.z<=z2);
        expect(inside.length).toBeGreaterThan(0);
        expect([Math.min(...inside.map(s=>s.x)),Math.min(...inside.map(s=>s.z)),Math.max(...inside.map(s=>s.x)),Math.max(...inside.map(s=>s.z))]).toEqual([x1,z1,x2,z2]);
    }
    const area=bears.filter(s=>s.level===0&&s.x>=2600&&s.x<=2740&&s.z>=3250&&s.z<=3360);
    expect(area.every(s=>COW_BEAR_BOXES.some(([x1,z1,x2,z2])=>s.x>=x1&&s.x<=x2&&s.z>=z1&&s.z<=z2))).toBe(true);
});

test('non-Wilderness mainland supply configs resolve valid targets, guard Wilderness borders, and traverse Taverley Dungeon', async () => {
    for (const key of ['unicorn', 'wizard', 'giant', 'taverley_druid', 'taverley_black_knight', 'taverley_scales', 'taverley_blue_dragon', 'taverley_black_dragon', 'chaos_wine']) {
        const conf = CONFIGS[key]!;
        expect(conf).toBeDefined();
        expect(isNonWildernessGatherGoal(conf.spot.x, conf.spot.z)).toBe(true);
        expect(isNonWildernessGatherGoal(conf.bankSpot.x, conf.bankSpot.z)).toBe(true);
    }
    expect(isNonWildernessGatherGoal(3115, 9928)).toBe(false); // Edgeville dungeon Chaos druids (Wilderness)
    expect(isNonWildernessGatherGoal(3087, 3452)).toBe(true); // Edgeville surface Unicorns (non-Wilderness)
    expect(isNonWildernessGatherGoal(2932, 3515)).toBe(true); // Chaos Temple outside Wilderness
    expect(isNonWildernessGatherGoal(3095, 3521)).toBe(false); // Wilderness surface north of z=3520

    const npcsJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../knowledge/npcs.json'), 'utf8')) as { id: number; name: string }[];
    const base = { distance: 2, reachable: true, inCombat: false, targetIndex: -1 };
    expect(genericCombatNpc('taverley_druid', [{ ...base, id: 181 }])?.id).toBe(181);
    expect(genericCombatNpc('taverley_black_knight', [{ ...base, id: 179 }])?.id).toBe(179);
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
    expect(actions).toEqual([
        'ground:2884,3397', 'loc:1759:climb-down',
        'ground:2886,9817', 'ground:2889,9831', 'ground:2910,9830', 'ground:2924,9803',
        'key:1590->2623',
        'ground:2895,9792', 'ground:2893,9777', 'ground:2885,9769', 'ground:2877,9788', 'ground:2860,9799', 'ground:2839,9814',
        'ground:2832,9825',
    ]);

    actions.length = 0;
    expect(await travel.walk(s, 'taverley_black_dragon', { x: 2946, z: 3368 }, ground, () => false, 2)).toBe(true);
    expect(actions).toEqual([
        'ground:2839,9814', 'ground:2860,9799', 'ground:2877,9788', 'ground:2885,9769', 'ground:2893,9777', 'ground:2895,9792',
        'ground:2923,9803', 'loc:2623:open',
        'ground:2910,9830', 'ground:2889,9831', 'ground:2886,9817', 'ground:2884,9797',
        'loc:1755:climb-up', 'ground:2946,3368',
    ]);

    await expect(travel.walk(s, 'taverley_druid', { x: 3115, z: 9928 }, ground, () => false, 2)).rejects.toThrow('Wilderness goal forbidden');

    actions.length = 0;
    // Edgeville Dungeon (z>=6400 outside Taverley) must not route through Taverley corridors.
    player.worldX = 3095; player.worldZ = 9830;
    expect(await travel.walk(s, 'taverley_druid', { x: 2946, z: 3368 }, ground, () => false, 2)).toBe(false);
    expect(actions).toEqual([]);
});

test('ensureSurfaceGroundEntry descends one nearby staircase/gangplank or fails fast with level !== 0', async () => {
    const mk = (level: number, nearbyLocs: any[], dropTo0: boolean) => {
        const player = { worldX: 2686, worldZ: 3268, level };
        let tick = 0, clicks = 0;
        const listeners = new Set<() => void>();
        const timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 1);
        const s: any = {
            tick: () => tick,
            onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
            sdk: { getState: () => ({ player, nearbyLocs }) },
            bot: {
                interactLoc: async () => {
                    clicks++;
                    if (dropTo0) player.level = 0;
                    return { success: true };
                },
            },
        };
        return { s, clicks: () => clicks, cleanup: () => clearInterval(timer) };
    };

    const g0 = mk(0, [], false);
    try {
        await ensureSurfaceGroundEntry(g0.s);
        expect(g0.clicks()).toBe(0);
    } finally { g0.cleanup(); }

    const plank = { id: 2086, name: 'Gangplank', distance: 4, optionsWithIndex: [{ opIndex: 1, text: 'Cross' }] };
    const ship = mk(1, [plank], true);
    try {
        await ensureSurfaceGroundEntry(ship.s, () => false, 5);
        expect(ship.clicks()).toBe(1);
    } finally { ship.cleanup(); }

    const stuck = mk(1, [plank], false);
    try {
        await expect(ensureSurfaceGroundEntry(stuck.s, () => false, 2)).rejects.toThrow('level !== 0');
        expect(stuck.clicks()).toBe(1);
    } finally { stuck.cleanup(); }

    const noExit = mk(2, [{ id: 1, name: 'Table', distance: 1, optionsWithIndex: [] }], false);
    try {
        await expect(ensureSurfaceGroundEntry(noExit.s, () => false, 2)).rejects.toThrow('level !== 0');
        expect(noExit.clicks()).toBe(0);
    } finally { noExit.cleanup(); }

    // On a ship deck, Ship's ladder (id 273) and boarding plank (id 2085) are skipped in favor of disembark gangplank (id 2086).
    const holdLadder = { id: 273, name: "Ship's ladder", distance: 4, optionsWithIndex: [{ opIndex: 1, text: 'Climb-down' }] };
    const boardPlank = { id: 2085, name: 'Gangplank', distance: 5, optionsWithIndex: [{ opIndex: 1, text: 'Cross' }] };
    const exitPlank = { id: 2086, name: 'Gangplank', distance: 5, optionsWithIndex: [{ opIndex: 1, text: 'Cross' }] };
    const clicked: number[] = [];
    const ardougneDeck = mk(1, [holdLadder, boardPlank, exitPlank], false);
    ardougneDeck.s.bot.interactLoc = async (loc: any) => { clicked.push(loc.id); if (loc.id === 2086) ardougneDeck.s.sdk.getState().player.level = 0; return { success: true }; };
    try {
        await ensureSurfaceGroundEntry(ardougneDeck.s, () => false, 5);
        expect(clicked).toEqual([2086]);
    } finally { ardougneDeck.cleanup(); }
});

test('non-Wilderness giant and Taverley supply configs capture crystal key halves and shield left halves', () => {
    for (const key of ['giant', 'taverley_druid', 'taverley_black_knight', 'taverley_blue_dragon', 'taverley_black_dragon'] as const) {
        expect(CONFIGS[key]!.drops.test('Half of a key')).toBe(true);
    }
    expect(CONFIGS.taverley_blue_dragon!.drops.test('Shield left half')).toBe(true);
    expect(CONFIGS.taverley_black_dragon!.drops.test('Shield left half')).toBe(true);
});

test('needsLongSurfaceWalk enables ferry/planned travel only for >40-tile level-0 surface routes', () => {
    expect(needsLongSurfaceWalk({ x: 2862, z: 3440, level: 0 }, { x: 3097, z: 3468 })).toBe(true);
    expect(needsLongSurfaceWalk({ x: 3092, z: 3496, level: 0 }, { x: 3097, z: 3468 })).toBe(false);
    expect(needsLongSurfaceWalk({ x: 3117, z: 9850, level: 0 }, { x: 3097, z: 9868 })).toBe(false);
    expect(needsLongSurfaceWalk({ x: 2862, z: 3440, level: 1 }, { x: 3097, z: 3468 })).toBe(false);
});

test('combatTargetFinished detects kill, stolen aggro, and sustained disengagement without stalling', () => {
    expect(combatTargetFinished({ player: { combat: { inCombat: false } }, nearbyNpcs: [] }, 42, 2, 0)).toEqual({ done: true, dead: true });
    expect(combatTargetFinished({
        player: { combat: { inCombat: false } },
        nearbyNpcs: [{ index: 42, inCombat: true, targetIndex: 32768 + 5 }],
    }, 42, 2, 0)).toEqual({ done: true, dead: false });
    expect(combatTargetFinished({
        player: { combat: { inCombat: true, targetType: 'npc', targetIndex: 42 } },
        nearbyNpcs: [{ index: 42, inCombat: true, targetIndex: 32768 + 2 }],
    }, 42, 2, 10)).toEqual({ done: false, dead: false });
    expect(combatTargetFinished({
        player: { combat: { inCombat: false } },
        nearbyNpcs: [{ index: 42, inCombat: false, targetIndex: -1 }],
    }, 42, 2, 3)).toEqual({ done: false, dead: false });
    expect(combatTargetFinished({
        player: { combat: { inCombat: false } },
        nearbyNpcs: [{ index: 42, inCombat: false, targetIndex: -1 }],
    }, 42, 2, 4)).toEqual({ done: true, dead: false });
});
});

describe('gather-combat-giant', () => {
const SWORD_TAB=[{index:0,name:'Stab',trainsSkills:['Attack']},{index:1,name:'Lunge',trainsSkills:['Strength']},{index:2,name:'Slash',trainsSkills:['Strength']},{index:3,name:'Block',trainsSkills:['Defence']}];
test('giant style comes from the wielded tab: exact single skill only, unknown or missing fails clearly',()=>{
    expect(giantStyle({known:true,weaponName:'Silverlight',currentStyle:0,styles:SWORD_TAB},'Strength')).toEqual({index:1,name:'Lunge',weapon:'Silverlight'});
    const scimitar=[{index:0,name:'Chop',trainsSkills:['Attack']},{index:1,name:'Slash',trainsSkills:['Strength']},{index:2,name:'Lunge',trainsSkills:['Attack','Strength','Defence']},{index:3,name:'Block',trainsSkills:['Defence']}];
    expect(giantStyle({known:true,weaponName:'Rune scimitar',currentStyle:0,styles:scimitar},'Defence').index).toBe(3);
    const controlled=[{index:0,name:'Lunge',trainsSkills:['Attack','Strength','Defence']}];
    expect(()=>giantStyle({known:true,weaponName:'Odd',currentStyle:0,styles:controlled},'Strength')).toThrow('Odd has no style that trains only Strength');
    expect(()=>giantStyle({known:false,weaponName:'Silverlight',currentStyle:0,styles:SWORD_TAB},'Strength')).toThrow('styles unknown');
    expect(()=>giantTraining('Magic',90)).toThrow('TRAIN_SKILL');expect(()=>giantTraining('Strength')).toThrow('TARGET_LEVEL');expect(()=>giantTraining('Strength',100)).toThrow('TARGET_LEVEL');
    expect(giantCredit(true,3500,1)).toBe(true);expect(giantCredit(false,3500,1)).toBe(false);expect(giantCredit(true,0,1)).toBe(false);expect(giantCredit(true,3500,0)).toBe(false);
    expect(giantKillLimit(undefined)).toBeUndefined();expect(giantKillLimit('2')).toBe(2);
    for(const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])
        expect(()=>giantKillLimit(value)).toThrow('GIANT_KILLS must be a positive safe integer');
});

function giantFixture(o:{key?:boolean;roots?:boolean;herbs?:boolean;injure?:boolean;tab?:any[];bankedKit?:boolean}={}){
    let tick=0,open=false,generation=0,attacks=0,hp=75,style=0,doorUses=0,climbs=0,healAt=Infinity;
    let pos={x:2670,z:3290};const xp:Record<string,number>={Attack:0,Strength:0,Defence:0,Hitpoints:0};
    const listeners=new Set<()=>void>();
    const inv:any[]=[...(o.key===false?[]:[{id:983,name:'Brass key',count:1,slot:0}]),{id:385,name:'Shark',count:1,slot:1,optionsWithIndex:[{text:'Eat',opIndex:1}]},{id:995,name:'Coins',count:50,slot:2}];
    const equipment:any[]=[{id:2402,name:'Silverlight',count:1,slot:3}];
    const bank:any[]=[{id:385,name:'Shark',count:10,slot:0},{id:532,name:'Big bones',count:2,slot:1}];
    if(o.bankedKit){bank.push(...inv.filter(i=>i.id===385),...equipment);inv.splice(inv.findIndex(i=>i.id===385),1);equipment.splice(0);equipment.push({id:1381,name:'Staff of air',count:1,slot:3});}
    let ground:any[]=[];const spawn=()=>({id:117,index:9,name:'Giant',x:2545,z:3144,tileX:2545,tileZ:3144,hp:35,maxHp:35,inCombat:false,reachable:true});
    let npc:any=spawn();
    const cellar=()=>pos.z>9000,house=()=>pos.x>=3113&&pos.x<=3117&&pos.z>=3450&&pos.z<=3453;
    const locs=()=>[{id:1804,name:'Door',x:3115,z:3450,level:0},...(house()?[{id:1754,name:'Ladder',x:3116,z:3452,level:0}]:[]),...(cellar()?[{id:1757,name:'Ladder',x:3116,z:9852,level:0}]:[])];
    const state=()=>({player:{worldX:pos.x,worldZ:pos.z,level:0,lifeId:1,respawnCount:0,hp},inventory:inv,skills:[{name:'Hitpoints',level:hp,baseLevel:75}],equipment,nearbyPlayers:[],nearbyNpcs:npc&&pos.x<2560?[npc]:[],nearbyLocs:locs(),groundItems:ground,bank:{isOpen:open,items:bank},
        combatStyle:{known:true,currentStyle:style,weaponName:equipment[0]?.name??'',styles:o.tab??SWORD_TAB}});
    const timer=setInterval(()=>{tick++;if(tick>=healAt){hp=75;healAt=Infinity;}for(const f of [...listeners])f();},1);
    const session:any={name:'giant-fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),direct:async()=>{const item=inv.find(i=>i.id===385);if(!item)return {success:false};item.count--;if(!item.count)inv.splice(inv.indexOf(item),1);healAt=tick+2;return {success:true};},
        bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getEquipment:()=>equipment,getSkillXp:(n:string)=>xp[n]??0,sendSetCombatStyle:async(n:number)=>{style=n;return{success:true};},
            getSkill:(n:string)=>n==='Hitpoints'?{level:hp,baseLevel:xp.Hitpoints!>=7000?76:75}:n==='Strength'?{level:xp.Strength!>=7000?90:89,baseLevel:xp.Strength!>=7000?90:89}:{level:76,baseLevel:76}},
        bot:{equipItem:async(item:any)=>{const old=equipment.splice(0);inv.splice(inv.indexOf(item),1);equipment.push({...item,slot:3});inv.push(...old);return {success:true};},openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
            useItemOnLoc:async(item:any,loc:any)=>{doorUses++;if(item.id===983&&loc.id===1804)pos=house()?{x:3115,z:3449}:{x:3115,z:3450};return{success:true,message:''};},
            interactLoc:async(loc:any)=>{climbs++;pos=loc.z>9000?{x:3116,z:3453}:{x:3116,z:9851};return{success:true,message:''};},
            attack:async()=>{attacks++;if(o.injure&&attacks===1)hp=30;xp.Hitpoints!+=3500;xp[style===1||style===2?'Strength':style===0?'Attack':'Defence']+=3500;
                ground=[...(o.herbs?[{id:199,name:'Herb',count:1,x:2545,z:3144}]:[]),{id:532,name:'Big bones',count:1,x:2545,z:3144},...(o.roots?[{id:225,name:'Limpwurt root',count:1,x:2545,z:3144}]:[])];npc=null;return{success:true};},
            eatFood:async(item:any)=>{item.count--;if(!item.count)inv.splice(inv.indexOf(item),1);healAt=tick+2;return{success:true};},
            pickupItem:async(item:any)=>{ground=ground.filter(i=>i!==item);inv.push({id:item.id,name:item.name,count:1,slot:inv.length});if(!ground.length)npc=spawn();return{success:true};},
            depositItem:async(item:any)=>{for(const i of inv.filter(i=>i.id===item.id)){const row=bank.find(r=>r.id===i.id);if(row)row.count+=i.count;else bank.push({...i,slot:bank.length});inv.splice(inv.indexOf(i),1);}generation++;return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;const row=inv.find(i=>i.id===item.id);if(row)row.count+=n;else inv.push({id:item.id,name:item.name,count:n,slot:inv.length,optionsWithIndex:[{text:'Eat',opIndex:1}]});generation++;return{success:true};},
        }};
    const walk=async(x:number,z:number)=>{pos={x,z};await waitTicks(session,1);return true;};
    return {session:session as Session,bank,inv,walk,dispose:()=>clearInterval(timer),attacks:()=>attacks,doorUses:()=>doorUses,climbs:()=>climbs,style:()=>style};
}

test('Silverlight Strength order reaches the surface camp without key actions, stops at the target level and banks big bones and limpwurt',async()=>{
    const f=giantFixture({roots:true});try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.targetMet).toBe(true);expect(r.stop).toBe('target-level');expect(r.style).toEqual({index:1,name:'Lunge',weapon:'Silverlight'});expect(f.style()).toBe(1);
        expect(r.creditedKills).toBe(2);expect(f.attacks()).toBe(2);expect(r.selectedXp).toBe(7000);expect(r.finalLevel).toBe(90);
        expect(r.banked).toEqual({bigBones:2,limpwurt:2});expect(f.bank.find(i=>i.id===532).count).toBe(4);
        expect(f.doorUses()).toBe(0);expect(f.climbs()).toBe(0);expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);expect(r.eaten).toBe(0);
        expect(f.inv.some(i=>i.id===532||i.id===225)).toBe(false);expect(f.inv.find(i=>i.id===385).count).toBe(5);
    }finally{f.dispose();}
});
test('giant training stops on the base level; a boosted current level is not training',async()=>{
    const f=giantFixture();
    const getSkill=f.session.sdk.getSkill.bind(f.session.sdk);
    f.session.sdk.getSkill=(name:string)=>{
        const skill=getSkill(name);
        return skill&&name==='Strength'?{...skill,level:95}:skill;
    };
    try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.startLevel).toBe(89);expect(r.finalLevel).toBe(90);
        expect(r.ok).toBe(true);expect(r.stop).toBe('target-level');
        expect(r.creditedKills).toBe(2);expect(r.selectedXp).toBe(7000);
        expect(r.banked.bigBones).toBe(2);expect(r.foodAccounted).toBe(true);expect(r.preserved).toBe(true);
    }finally{f.dispose();}
});
test('giant base level already at the target stops with no route, style or combat input',async()=>{
    const f=giantFixture();
    const getSkill=f.session.sdk.getSkill.bind(f.session.sdk);
    f.session.sdk.getSkill=(name:string)=>{
        const skill=getSkill(name);
        return skill&&name==='Strength'?{...skill,level:80,baseLevel:90}:skill;
    };
    try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.stop).toBe('target-level');expect(r.startLevel).toBe(90);expect(r.creditedKills).toBe(0);
        expect(f.attacks()).toBe(0);expect(f.doorUses()).toBe(0);expect(f.style()).toBe(0);
    }finally{f.dispose();}
});

test('giant shark eating at the HP floor is observed and owned food reconciles',async()=>{
    const f=giantFixture({injure:true});try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.eatAt).toBe(38);expect(r.eaten).toBe(1);expect(r.initialFood).toBe(11);expect(r.finalFood).toBe(10);expect(r.foodAccounted).toBe(true);
        expect(r.banked).toEqual({bigBones:2,limpwurt:0});expect(r.hpMin).toBe(30);
    }finally{f.dispose();}
});
test('a bite whose heal a hit hides is still a bite: the debit is the proof and the trainer eats again',async()=>{
    const f=giantFixture({injure:true}),sdk=f.session.sdk as any,bot=f.session.bot as any;let bites=0;
    const eatFood=bot.eatFood.bind(bot),skill=sdk.getSkill.bind(sdk);
    bot.eatFood=async(item:any)=>{bites++;return eatFood(item);};
    // After the first bite HP still reads 30, as when a hit lands with it; the second bite shows its rise.
    sdk.getSkill=(n:string)=>n==='Hitpoints'&&bites===1?{level:30,baseLevel:75}:skill(n);
    try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.eaten).toBe(2);expect(r.initialFood).toBe(11);expect(r.finalFood).toBe(9);expect(r.foodAccounted).toBe(true);
    }finally{f.dispose();}
});
test('an eat the server drops is sent again; three eats with no debit end the run',async()=>{
    const dropping=(drops:number)=>{
        const f=giantFixture({injure:true}),bot=f.session.bot as any;let calls=0;
        const eatFood=bot.eatFood.bind(bot);
        bot.eatFood=async(item:any)=>++calls<=drops?{success:false,message:'Failed to eat Shark'}:eatFood(item);
        return {f,calls:()=>calls};
    };
    const once=dropping(1);try{
        const r=await runGiants(once.f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:once.f.walk});
        expect(r.ok).toBe(true);expect(r.eaten).toBe(1);expect(once.calls()).toBe(2);expect(r.foodAccounted).toBe(true);
    }finally{once.f.dispose();}
    const always=dropping(Infinity);try{
        const r=await runGiants(always.f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:always.f.walk});
        // The walk back eats through the shared sustain, which this fixture does not drop.
        expect(r.ok).toBe(false);expect(r.failure).toContain('shark did not heal');expect(always.calls()).toBe(3);
    }finally{always.f.dispose();}
});
test('GIANT_KILLS overrides an already met level and banks exactly two credited kills',async()=>{
    const f=giantFixture({herbs:true,injure:true});try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:89,maximum:2,walk:f.walk});
        expect(r.startLevel).toBe(89);expect(r.ok).toBe(true);expect(r.targetMet).toBe(true);
        expect(r.stop).toBe('max-kills');expect(r.creditedKills).toBe(2);expect(f.attacks()).toBe(2);
        expect(r.selectedXp).toBe(7000);expect(r.banked.bigBones).toBe(2);expect(r.bankedHerbs[199]).toBe(2);
        expect(r.eaten).toBe(1);expect(r.foodAccounted).toBe(true);expect(r.preserved).toBe(true);expect(r.died).toBe(false);
        expect(f.inv.some(i=>i.id===199||i.id===532)).toBe(false);
    }finally{f.dispose();}
});
test('surface camp needs no brass key; an unavailable single-skill style still refuses combat',async()=>{
    const nokey=giantFixture({key:false});try{
        const r=await runGiants(nokey.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:nokey.walk});
        expect(r.ok).toBe(true);expect(nokey.attacks()).toBe(2);expect(nokey.doorUses()).toBe(0);
    }finally{nokey.dispose();}
    const odd=giantFixture({tab:[{index:0,name:'Lunge',trainsSkills:['Attack','Strength','Defence']}]});try{
        const r=await runGiants(odd.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:odd.walk});
        expect(r.ok).toBe(false);expect(r.failure).toContain('no style that trains only Strength');expect(odd.attacks()).toBe(0);
    }finally{odd.dispose();}
});

test('giant stop request before departure keeps assets and makes no door or combat input',async()=>{
    const f=giantFixture();try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,stop:()=>true,walk:f.walk});
        expect(r.ok).toBe(false);expect(r.stop).toBe('stop-file');expect(f.doorUses()).toBe(0);expect(f.attacks()).toBe(0);
        expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);expect(r.banked).toEqual({bigBones:0,limpwurt:0});
    }finally{f.dispose();}
    expect(GIANT.room[1]).toBe(3136);
});

test('a stop during the walk out cancels that walk, and the retreat still runs',async()=>{
    const f=giantFixture();let requested=false,cancelled=false,retreats=0;try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,stop:()=>requested,walk:async(x,z,tol,signal)=>{
            if(x!==GIANT.spot.x||z!==GIANT.spot.z){retreats++;return f.walk(x,z);}
            requested=true;await waitTicks(f.session,3);cancelled=signal?.aborted===true;return false;
        }});
        expect(cancelled).toBe(true);expect(r.stop).toBe('stop-file');expect(r.ok).toBe(false);expect(f.attacks()).toBe(0);expect(r.failure??'').not.toContain('arrival unobserved');
    }finally{f.dispose();}
});

// Practice: try 1 of the retreat from the camp stopped 118 tiles from the bank, and try 2 ran past the proof's child
// timer. The retreat's tries share one tick deadline, which aborts the stalled walk and fails the run clearly.
test('a stalled bank retreat is aborted on its tick deadline and the run fails clearly',async()=>{
    const f=giantFixture();let fought=false,reason='',began=0,stopped=0,retreats=0;try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:async(x,z,tol,signal)=>{
            if(x===GIANT.spot.x&&z===GIANT.spot.z){fought=true;return f.walk(x,z);}
            if(!fought)return f.walk(x,z);
            // The walk back stalls at the camp and returns only when it is aborted.
            retreats++;began=f.session.tick();
            await new Promise<void>(done=>{if(signal!.aborted)done();else signal!.addEventListener('abort',()=>done(),{once:true});});
            reason=String(signal!.reason);stopped=f.session.tick();return false;
        }});
        expect(r.ok).toBe(false);expect(r.failure).toContain('bank retreat failed at distance=139');
        expect(reason).toBe('retreat deadline');expect(retreats).toBe(1);
        expect(retreatBudget(139)).toBe(537);expect(stopped-began).toBeLessThanOrEqual(retreatBudget(139)+3);
    }finally{f.dispose();}
},30000);

// Practice: the planned retreat camp->bank took the maze leg 'far walk to 2504,3192,0' and stalled at the camp. The
// retreat walks the observed outbound tiles back instead, and then the bank.
test('the giant retreat walks the outbound path in reverse and never the maze waypoint 2504,3192',async()=>{
    expect(retreatWaypoints([],{x:2545,z:3144},GIANT.bank)).toEqual([]);
    const out=[[2650,3270],[2640,3255],[2620,3240],[2600,3220],[2580,3200],[2560,3175]] as const;
    const f=giantFixture();const calls:number[][]=[];try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:async(x,z)=>{
            calls.push([x,z]);
            if(x===GIANT.spot.x&&z===GIANT.spot.z)for(const [sx,sz] of out)await f.walk(sx,sz);
            return f.walk(x,z);
        }});
        expect(r.ok).toBe(true);expect(r.banked.bigBones).toBe(2);expect(r.foodAccounted).toBe(true);expect(r.preserved).toBe(true);
        expect(calls.some(([x,z])=>x===2504&&z===3192)).toBe(false);
        const back=[...[...out].reverse().map(([x,z])=>[x,z]),[GIANT.bank.x,GIANT.bank.z]];
        // Every retreat from the camp: the outbound tiles in reverse, then the bank.
        const spots=calls.flatMap((c,i)=>c[0]===GIANT.spot.x&&c[1]===GIANT.spot.z?[i]:[]);
        expect(spots.length).toBeGreaterThanOrEqual(1);
        for(const i of spots)expect(calls.slice(i+1,i+1+back.length)).toEqual(back);
        expect(retreatWaypoints([{x:2655,z:3283},...out.map(([x,z])=>({x,z})),GIANT.spot],{x:2600,z:3221},GIANT.bank).map(p=>[p.x,p.z]))
            .toEqual([[2620,3240],[2640,3255],[2650,3270]]);
    }finally{f.dispose();}
});

test('Hitpoints accepts every observed weapon style and credits only its own XP and base level',async()=>{
    expect(giantTraining('Hitpoints',76)).toEqual({skill:'Hitpoints',targetLevel:76});
    expect(giantStyle({known:true,weaponName:'Sword',currentStyle:2,styles:SWORD_TAB},'Hitpoints').index).toBe(2);
    const f=giantFixture();try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Hitpoints',targetLevel:76,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.selectedXp).toBe(7000);expect(r.finalLevel).toBe(76);expect(r.creditedKills).toBe(2);
    }finally{f.dispose();}
});
// The replaced weapon goes to the bank: a death on the field loses the pack.
test('entry travels from an owned location and stages banked melee weapon and food without losing the old weapon',async()=>{
    const f=giantFixture({bankedKit:true});const legs:number[][]=[];try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:async(x,z,t)=>{legs.push([x,z]);return f.walk(x,z);}});
        expect(r.ok).toBe(true);expect(legs[0]).toEqual([2655,3283]);expect(legs).toContainEqual([2545,3144]);
        expect(f.bank.filter(i=>i.id===1381).reduce((n,i)=>n+i.count,0)).toBe(1);expect(f.inv.some(i=>i.id===1381)).toBe(false);expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);
        expect(selectGiantWeapon([{id:1331,count:1},{id:35,count:1},{id:2402,count:1}],99)).toBe(1331);
        expect(selectGiantWeapon([{id:1331,count:1},{id:2402,count:1}],1)).toBe(2402);
        expect(selectGiantWeapon([{id:1333,count:1},{id:1331,count:1}],99)).toBe(1333);
    }finally{f.dispose();}
});
test('surface config names Giant117 and Ardougne south bank, leaving the druid target intact',()=>{
    expect(CONFIGS.giant!.npc.test('Giant')).toBe(true);expect(CONFIGS.giant!.npc.test('Hill Giant')).toBe(true);
    expect(CONFIGS.giant!.spot).toEqual({x:2545,z:3144});expect(CONFIGS.giant!.bankSpot).toEqual({x:2655,z:3283});
    expect(CONFIGS.druid!.spot).toEqual({x:3115,z:9928});expect(CONFIGS.druid!.bankSpot).toEqual({x:3092,z:3496});
});
test('Herb drops are picked up and banked with exact credits, including carried outputs staged before combat',async()=>{
    expect(CONFIGS.giant!.drops.test('Herb')).toBe(true);
    const f=giantFixture({herbs:true});f.inv.push({id:199,name:'Herb',count:1,slot:4});try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.bankedHerbs[199]).toBe(2);expect(f.bank.find(i=>i.id===199).count).toBe(3);
        expect(f.inv.some(i=>i.id===199)).toBe(false);expect(r.preserved).toBe(true);
    }finally{f.dispose();}
});

test('coins held at entry are banked before the walk out, so a death on the field cannot lose them',async()=>{
    const f=giantFixture();const carried:number[][]=[];try{
        expect(f.inv.find(i=>i.id===995).count).toBe(50);
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:async(x,z)=>{if(f.inv.some(i=>i.id===995))carried.push([x,z]);return f.walk(x,z);}});
        expect(r.ok).toBe(true);expect(carried.every(([x,z])=>x===GIANT.bank.x&&z===GIANT.bank.z)).toBe(true);
        expect(f.bank.find(i=>i.id===995).count).toBe(50);expect(f.inv.some(i=>i.id===995)).toBe(false);expect(r.preserved).toBe(true);
    }finally{f.dispose();}
});

test('accounts in company spread over the free troopers; alone, an account takes the nearest',()=>{
    const free=Array.from({length:8},(_,i)=>({index:100+i,distance:3+i%2}));
    expect(roamTarget('Soldier',free,false)).toBe(free[0]);expect(roamTarget('Soldier',[],true)).toBeUndefined();
    const picks=['Fatstack','Fingerblastr','Deeppockets','Dipstick','KnightRider','Fingersmith'].map(n=>roamTarget(n,free,true)!.index);
    // Six accounts that see the same eight troopers do not all take one, and each choice is stable.
    expect(new Set(picks).size).toBeGreaterThanOrEqual(3);
    expect(['Fatstack','Fingerblastr','Deeppockets','Dipstick','KnightRider','Fingersmith'].map(n=>roamTarget(n,free,true)!.index)).toEqual(picks);
    // The offset is at most 7 tiles: a trooper 8 or more tiles nearer than the rest is always taken.
    for(const n of ['Fatstack','Dipstick'])expect(roamTarget(n,[{index:1,distance:1},...free.map(f=>({...f,distance:f.distance+8}))],true)!.index).toBe(1);
});

test('a trooper that faces another player is someone else\'s fight; one that faces this account or an NPC is not',()=>{
    expect(anothersFight({inCombat:true,targetIndex:32768+5},4)).toBe(true);
    expect(anothersFight({inCombat:true,targetIndex:32768+4},4)).toBe(false);
    expect(anothersFight({inCombat:true,targetIndex:77},4)).toBe(false);
    expect(anothersFight({inCombat:false,targetIndex:32768+5},4)).toBe(false);
    expect(anothersFight({inCombat:true,targetIndex:32768+5},undefined)).toBe(false);
    expect(anothersFight(undefined,4)).toBe(false);
});

test('with GIANT_BURY a trooper kill\'s bones are taken and buried on the field; at Prayer 99 they are left',async()=>{
    // Open ground with no credit drop, as the trooper site: a kill is the target gone with own XP.
    const site={label:'trooper',npcs:[117],foods:[385],bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:[]};
    const field=(prayer:number)=>{
        const f=giantFixture(),sdk=f.session.sdk as any,bot=f.session.bot as any;let bones=false,prayerXp=0,sent=0;
        const state=sdk.getState.bind(sdk),attack=bot.attack.bind(bot),pickup=bot.pickupItem.bind(bot),skill=sdk.getSkill.bind(sdk),xp=sdk.getSkillXp.bind(sdk);
        bot.attack=async(...a:any[])=>{bones=true;return attack(...a);};
        sdk.getState=()=>{const st=state();return bones?{...st,groundItems:[...st.groundItems,{id:526,name:'Bones',count:1,x:2545,z:3144}]}:st;};
        bot.pickupItem=async(item:any)=>{if(item.id!==526)return pickup(item);bones=false;f.inv.push({id:526,name:'Bones',count:1,slot:f.inv.length,optionsWithIndex:[{text:'Bury',opIndex:1}]});return{success:true};};
        sdk.sendUseItem=async(slot:number,op:number)=>{const i=f.inv.findIndex(x=>x.slot===slot&&x.id===526);if(i<0||op!==1)return{success:false};f.inv.splice(i,1);prayerXp+=112;sent++;return{success:true};};
        sdk.getSkill=(n:string)=>n==='Prayer'?{level:prayer,baseLevel:prayer}:skill(n);
        sdk.getSkillXp=(n:string)=>n==='Prayer'?prayerXp:xp(n);
        return {f,sent:()=>sent};
    };
    const low=field(40);try{
        const r=await runGiants(low.f.session,{cap:500,trainSkill:'Strength',targetLevel:99,maximum:1,bury:true,site,walk:low.f.walk}) as any;
        expect(r.ok).toBe(true);expect(r.creditedKills).toBe(1);expect(r.buried).toBe(1);expect(r.prayerXp).toBe(112);
        expect(low.f.inv.some(i=>i.id===526)).toBe(false);expect(r.preserved).toBe(true);
    }finally{low.f.dispose();}
    const max=field(99);try{
        const r=await runGiants(max.f.session,{cap:500,trainSkill:'Strength',targetLevel:99,maximum:1,bury:true,site,walk:max.f.walk}) as any;
        expect(r.ok).toBe(true);expect(r.creditedKills).toBe(1);expect(r.buried).toBeUndefined();expect(max.sent()).toBe(0);
    }finally{max.f.dispose();}
});

test('a restock takes each owned food kind in site order until the pack carries GIANT_FOOD pieces',async()=>{
    const site={label:'trooper',npcs:[117],foods:[385,2142],bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:[]};
    const f=giantFixture();try{
        f.bank.find(i=>i.id===385)!.count=2;f.bank.push({id:2142,name:'Cooked meat',count:10,slot:f.bank.length});
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:99,maximum:1,food:5,site,walk:f.walk}) as any;
        expect(r.ok).toBe(true);expect(r.initialFood).toBe(13);expect(r.finalFood).toBe(13);
        // One shark carried, the two banked sharks, then cooked meat up to five pieces.
        const held=(id:number)=>f.inv.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
        expect(held(385)).toBe(3);expect(held(2142)).toBe(2);
    }finally{f.dispose();}
});
test('out of food at low HP a trooper run ends stop=food, ok after its kills; the giants still fail',async()=>{
    // The first fight costs the one carried shark; in the second HP is low again with no food in the pack or the bank.
    const hungry=(site:any)=>{
        const f=giantFixture(),sdk=f.session.sdk as any,bot=f.session.bot as any;let low=false,fights=0;
        const state=sdk.getState.bind(sdk),attack=bot.attack.bind(bot),eatFood=bot.eatFood.bind(bot),skill=sdk.getSkill.bind(sdk);
        f.bank.splice(f.bank.findIndex(i=>i.id===385),1);
        const next={id:117,index:10,name:'Giant',x:2545,z:3144,tileX:2545,tileZ:3144,hp:35,maxHp:35,inCombat:false,reachable:true};
        sdk.getState=()=>{const st=state();return fights>=1&&site?{...st,nearbyNpcs:[next]}:st;};
        bot.attack=async(...a:any[])=>{fights++;low=true;return fights===1?attack(...a):{success:true};};
        bot.eatFood=async(item:any)=>{low=false;return eatFood(item);};
        sdk.getSkill=(n:string)=>n==='Hitpoints'&&low?{level:30,baseLevel:75}:skill(n);
        return f;
    };
    const site={label:'trooper',npcs:[117],foods:[385,2142],bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:[]};
    const field=hungry(site);try{
        const r=await runGiants(field.session,{cap:500,trainSkill:'Strength',targetLevel:99,site,walk:field.walk}) as any;
        expect(r.stop).toBe('food');expect(r.ok).toBe(true);expect(r.partial).toBe(true);expect(r.creditedKills).toBe(1);expect(r.eaten).toBe(1);
        expect(r.failure).toBe('-');expect(r.foodAccounted).toBe(true);expect(r.preserved).toBe(true);
    }finally{field.dispose();}
    const camp=hungry(undefined);try{
        const r=await runGiants(camp.session,{cap:500,trainSkill:'Strength',targetLevel:99,walk:camp.walk}) as any;
        expect(r.ok).toBe(false);expect(r.stop).toBe('low-hp');expect(r.failure).toContain('low HP in combat and no carried shark');
    }finally{camp.dispose();}
});
test('trooper food is counted in bites: a cake is eaten a piece at a time and the smallest piece goes first',async()=>{
    const site={label:'trooper',npcs:[117],foods:TROOPER_FOODS,bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:[]};
    // The stall's food follows the fish and the meat, cake by its smallest piece first.
    expect(TROOPER_FOODS.slice(-5)).toEqual([2309,1901,1895,1893,1891]);
    // One fight that costs one bite, with the given cake pieces in the pack and no food banked.
    const fight=async(pieces:number[])=>{
        const f=giantFixture(),sdk=f.session.sdk as any,bot=f.session.bot as any;let low=false;const ate:number[]=[];
        const skill=sdk.getSkill.bind(sdk),attack=bot.attack.bind(bot);
        f.inv.splice(f.inv.findIndex(i=>i.id===385),1);f.bank.splice(f.bank.findIndex(i=>i.id===385),1);
        pieces.forEach((id,k)=>f.inv.push({id,name:'Cake',count:1,slot:10+k,optionsWithIndex:[{text:'Eat',opIndex:1}]}));
        bot.attack=async(...a:any[])=>{low=true;return attack(...a);};
        bot.eatFood=async(item:any)=>{ate.push(item.id);const next=({1891:1893,1893:1895} as Record<number,number>)[item.id];if(next)item.id=next;else f.inv.splice(f.inv.indexOf(item),1);low=false;return{success:true};};
        sdk.getSkill=(n:string)=>n==='Hitpoints'&&low?{level:30,baseLevel:75}:skill(n);
        try{return{r:await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:99,maximum:1,site,walk:f.walk}) as any,ate,left:f.inv.map(i=>i.id).filter(id=>TROOPER_FOODS.includes(id))};}
        finally{f.dispose();}
    };
    // A whole cake is three bites: one is eaten and its 2/3 stays in the slot.
    const whole=await fight([1891]);
    expect(whole.r.ok).toBe(true);expect(whole.ate).toEqual([1891]);expect(whole.r.eaten).toBe(1);
    expect(whole.r.initialFood).toBe(3);expect(whole.r.finalFood).toBe(2);expect(whole.r.foodAccounted).toBe(true);expect(whole.left).toEqual([1893]);
    // With a slice beside it the slice goes first and the cake is not started.
    const mixed=await fight([1891,1895]);
    expect(mixed.r.ok).toBe(true);expect(mixed.ate).toEqual([1895]);expect(mixed.r.initialFood).toBe(4);expect(mixed.r.finalFood).toBe(3);expect(mixed.left).toEqual([1891]);
});
test('banked supplies absent or equip without effect cannot start a giant fight',async()=>{
 for(const mode of ['food','weapon','equip'] as const){
    const f=giantFixture({bankedKit:true});try{
        if(mode==='food')for(let i=f.bank.length-1;i>=0;i--)if(f.bank[i].id===385)f.bank.splice(i,1);
        if(mode==='weapon')f.bank.splice(f.bank.findIndex(i=>i.id===2402),1);
        if(mode==='equip')f.session.bot.equipItem=async()=>({success:true}) as any;
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:f.walk});
        expect(r.ok).toBe(false);expect(f.attacks()).toBe(0);
        expect(r.failure).toContain(mode==='food'?'no owned shark':mode==='weapon'?'no owned equippable melee weapon':'equip unobserved');
    }finally{f.dispose();}
 }
});
test('shared sustain eats on an active route and the final food account includes that observed debit',async()=>{
 const f=giantFixture();let injured=false;try{
    const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:async(x,z,t)=>{
        if(x===2545&&!injured){injured=true;const original=f.session.sdk.getState.bind(f.session.sdk);
            f.session.sdk.getState=()=>{const state=original();return {...state,skills:[{name:'Hitpoints',level:30,baseLevel:75}]} as any;};
            await waitTicks(f.session,3);f.session.sdk.getState=original;
        }
        return f.walk(x,z);
    }});
    expect(r.ok).toBe(true);expect(r.eaten).toBe(1);expect(r.foodAccounted).toBe(true);expect(f.bank.find(i=>i.id===385).count+f.inv.filter(i=>i.id===385).reduce((n,i)=>n+i.count,0)).toBe(10);
 }finally{f.dispose();}
});

test('Ranged takes the best owned bow for the level, a shortbow first, and arrows that bow fires, on rapid',()=>{
    expect(giantTraining('Ranged',99)).toEqual({skill:'Ranged',targetLevel:99});
    const stock=[{id:841,count:1},{id:839,count:1},{id:849,count:1},{id:857,count:1},{id:882,count:50},{id:884,count:300},{id:888,count:200},{id:892,count:66}];
    expect(selectGiantBow(stock,1)).toEqual({id:841,level:1});
    expect(selectGiantBow(stock,25)).toEqual({id:849,level:20});
    expect(selectGiantBow(stock,99)).toEqual({id:857,level:40});
    expect(selectGiantBow([{id:839,count:1}],10)).toEqual({id:839,level:1});
    expect(selectGiantBow([{id:861,count:1}],49)).toBeUndefined();
    expect(selectGiantArrows(stock,1,1)).toBe(884);
    expect(selectGiantArrows(stock,25,20)).toBe(888);
    expect(selectGiantArrows(stock,99,40)).toBe(892);
    expect(selectGiantArrows(stock,99,20)).toBe(888);
    expect(selectGiantArrows([{id:892,count:5}],99,5)).toBeUndefined();
    // A handful of better arrows is not a run's worth: the best kind with 50, else the largest stack.
    const mixed=[{id:888,count:10},{id:886,count:14},{id:884,count:45},{id:882,count:245}];
    expect(selectGiantArrows(mixed,45,20)).toBe(882);
    expect(selectGiantArrows([{id:888,count:50},{id:882,count:245}],45,20)).toBe(888);
    expect(selectGiantArrows([{id:888,count:10},{id:884,count:20}],45,20)).toBe(884);
    expect(selectGiantArrows([{id:888,count:10}],45,20)).toBe(888);
    const bow=[{index:0,name:'Accurate',trainsSkills:['Ranged']},{index:1,name:'Rapid',trainsSkills:['Ranged']},{index:2,name:'Longrange',trainsSkills:['Ranged','Defence']}];
    expect(giantStyle({known:true,weaponName:'Shortbow',currentStyle:0,styles:bow},'Ranged')).toEqual({index:1,name:'Rapid',weapon:'Shortbow'});
});

test('the selected faster shortbow is actually wielded when a higher-tier longbow is also owned',async()=>{
 const bowTab=[{index:0,name:'Accurate',trainsSkills:['Ranged']},{index:1,name:'Rapid',trainsSkills:['Ranged']}];
 const f=giantFixture({tab:bowTab}),sdk=f.session.sdk as any,bot=f.session.bot as any;
 f.bank.push({id:857,name:'Yew shortbow',count:1,slot:f.bank.length},{id:859,name:'Magic longbow',count:1,slot:f.bank.length+1},{id:892,name:'Rune arrow',count:500,slot:f.bank.length+2});
 const state=sdk.getState.bind(sdk),skill=sdk.getSkill.bind(sdk),oldXp=sdk.getSkillXp.bind(sdk),attack=bot.attack.bind(bot);let xp=0;
 sdk.getSkill=(name:string)=>name==='Ranged'?{level:80,baseLevel:80}:skill(name);
 sdk.getSkillXp=(name:string)=>name==='Ranged'?xp:oldXp(name);
 bot.attack=async(...args:any[])=>{xp+=2200;return attack(...args);};
 bot.equipItem=async(item:any)=>{
  const eq=state().equipment as any[],slot=item.id===892?13:3,old=eq.find(i=>i.slot===slot);
  if(old){eq.splice(eq.indexOf(old),1);f.inv.push({...old});}
  f.inv.splice(f.inv.indexOf(item),1);eq.push({...item,slot});return{success:true};
 };
 const site={label:'trooper',npcs:[117],foods:[385],bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:[]};
 try{
  const r=await runGiants(f.session,{cap:500,trainSkill:'Ranged',targetLevel:85,maximum:1,site,walk:f.walk,rangedKit:{bow:857,arrow:892}} as any);
  expect(r.ok).toBe(true);expect(state().equipment.find((i:any)=>i.slot===3)?.id).toBe(857);
  expect(state().equipment.find((i:any)=>i.slot===13)?.id).toBe(892);expect(r.preserved).toBe(true);
 }finally{f.dispose();}
});

test('a selected Ranged kit refuses absent stock, locked bows and arrows the chosen bow cannot fire',()=>{
 const stock=[{id:841,count:1},{id:857,count:1},{id:882,count:100},{id:892,count:100}];
 expect(selectedGiantRangedKit(stock,80,{bow:857,arrow:892})).toEqual({bow:{id:857,level:40},arrow:892});
 for(const [level,kit] of [[39,{bow:857,arrow:892}],[80,{bow:861,arrow:892}],[80,{bow:841,arrow:892}],[80,{bow:857,arrow:888}]] as const)
  expect(()=>selectedGiantRangedKit(stock,level,kit)).toThrow('selected Ranged kit is not owned, usable and compatible');
});

test('fired arrows are taken from the stacks within reach, the largest first; small stacks, other arrows, far stacks and missed tiles are left',()=>{
    const at={x:2520,z:3245},ground=[
        {id:882,x:2520,z:3245+AMMO_REACH+1,count:9},{id:882,x:2522,z:3246,count:2},{id:882,x:2521,z:3245,count:7},{id:882,x:2519,z:3246,count:11},{id:882,x:2520,z:3245,count:7},
        {id:884,x:2520,z:3245,count:30},{id:526,x:2521,z:3245,count:1}];
    // With the quiver empty every stack counts; on equal size the nearer goes first.
    expect(ammoPiles(ground,882,at).map(i=>[i.x,i.z,i.count])).toEqual([[2519,3246,11],[2520,3245,7],[2521,3245,7],[2522,3246,2]]);
    expect(ammoPiles(ground,882,at,AMMO_WORTH).map(i=>i.count)).toEqual([11,7,7]);
    expect(ammoPiles(ground,882,at,AMMO_WORTH,new Set(['2519,3246'])).map(i=>i.count)).toEqual([7,7]);
    expect(ammoPiles(ground,884,at,AMMO_WORTH).map(i=>i.count)).toEqual([30]);
    expect(ammoPiles(ground,886,at)).toEqual([]);
});

test('every eat of a run waits out the game\'s eat delay: a low-HP account on cooked meat eats up to its eat level before the walk, and the walk\'s sustain has no eat dropped',async()=>{
    const site={label:'trooper',npcs:[117],foods:[2142],bank:GIANT.bank,spot:GIANT.spot,room:GIANT.room,drops:[]};
    const f=giantFixture(),sdk=f.session.sdk as any,bot=f.session.bot as any,session=f.session as any;
    f.inv.splice(f.inv.findIndex(i=>i.id===385),1);f.bank.push({id:2142,name:'Cooked meat',count:30,slot:f.bank.length});
    let hp=30,lastEat=-Infinity,dropped=0;const bites:number[]=[];
    // consume.rs2 player_consume_item: an eat within 2 ticks of the last one does nothing. Cooked meat heals 3.
    const bite=()=>{
        const item=f.inv.find(i=>i.id===2142);if(!item)return false;
        if(session.tick()-lastEat<=2){dropped++;return true;}
        item.count--;if(!item.count)f.inv.splice(f.inv.indexOf(item),1);hp=Math.min(75,hp+3);lastEat=session.tick();bites.push(lastEat);return true;
    };
    bot.eatFood=async()=>({success:bite()});session.direct=async()=>({success:bite()});
    const state=sdk.getState.bind(sdk),skill=sdk.getSkill.bind(sdk);
    sdk.getState=()=>{const st=state();return {...st,player:{...st.player,hp},skills:[{name:'Hitpoints',level:hp,baseLevel:75}]};};
    sdk.getSkill=(n:string)=>n==='Hitpoints'?{level:hp,baseLevel:75}:skill(n);
    try{
        // Its eat level is 38: from 30 HP it takes three bites before the walk out, and the walk's sustain eats none.
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:89,maximum:1,site,walk:async(x,z)=>{await waitTicks(f.session,8);return f.walk(x,z);}}) as any;
        expect(r.failure).toBe('-');expect(r.ok).toBe(true);expect(dropped).toBe(0);
        expect(bites.length).toBe(3);expect(bites.every((t,i)=>i===0||t-bites[i-1]!>=3)).toBe(true);
        expect(r.eaten).toBe(3);expect(r.foodAccounted).toBe(true);
    }finally{f.dispose();}
});

test('runGiants equips quest-gated melee armour on startup and weapon upgrades on mid-run bank trips',async()=>{
    let tick=0,open=false,generation=0,style=0,hp=75,attacks=0,lostCityDone=false,attackLevel=40;
    let pos={x:2655,z:3283};
    const xp:Record<string,number>={Attack:0,Strength:0,Defence:0,Hitpoints:0};
    const listeners=new Set<()=>void>();
    const defs=questDefinitions();
    const dragonId=defs.find(d=>d.name==='Dragon Slayer')!.id;
    const fremId=defs.find(d=>d.name==='The Fremennik Trials')!.id;
    const lostId=defs.find(d=>d.name==='Lost City')!.id;
    const legendsId=defs.find(d=>/legends/i.test(d.name))!.id;
    const inv:any[]=[{id:385,name:'Shark',count:1,slot:0,optionsWithIndex:[{text:'Eat',opIndex:1}]}];
    const equipment:any[]=[{id:2402,name:'Silverlight',count:1,slot:3}];
    const bank:any[]=[
        {id:385,name:'Shark',count:10,slot:0},
        {id:1333,name:'Rune scimitar',count:1,slot:1},
        {id:1305,name:'Dragon longsword',count:1,slot:2},
        {id:3751,name:'Berserker helm',count:1,slot:3},
        {id:1163,name:'Rune full helm',count:1,slot:4},
        {id:1127,name:'Rune platebody',count:1,slot:5},
        {id:1113,name:'Rune chainbody',count:1,slot:6},
        {id:1079,name:'Rune platelegs',count:1,slot:7},
        {id:1201,name:'Rune kiteshield',count:1,slot:8},
        {id:1052,name:'Cape of legends',count:1,slot:9},
    ];
    let ground:any[]=[];
    const spawn=()=>({id:117,index:9,name:'Giant',x:2545,z:3144,tileX:2545,tileZ:3144,hp:35,maxHp:35,inCombat:false,reachable:true});
    let npc:any=spawn();
    const wearPosFor=(id:number)=>({righthand:3,lefthand:5,hat:0,torso:4,legs:7,front:2,back:1,hands:9,feet:10}[gearById(id)?.slot??'righthand']??3);
    const wornWeapon=()=>equipment.find(i=>i.slot===3);
    const startupWeapons:number[]=[];
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const client={
        ingame:true,
        ifType:(id:number)=>{
            if(id===dragonId||id===fremId)return{colour:0x00f800};
            if(id===lostId)return{colour:lostCityDone?0x00f800:0xf80000};
            if(id===legendsId)return{colour:0xf80000};
            return{colour:0xf80000};
        },
    };
    const session:any={
        name:'giant-gear-prog',client,tick:()=>tick,
        onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},
        ended:new Promise(()=>{}),
        bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        direct:async()=>{const item=inv.find(i=>i.id===385);if(!item)return{success:false};item.count--;if(!item.count)inv.splice(inv.indexOf(item),1);hp=75;return{success:true};},
        sdk:{
            getInventory:()=>inv,getEquipment:()=>equipment,getSkillXp:(n:string)=>xp[n]??0,
            sendSetCombatStyle:async(n:number)=>{style=n;return{success:true};},
            getSkill:(n:string)=>{
                if(n==='Hitpoints')return{level:hp,baseLevel:75};
                if(n==='Attack')return{level:attackLevel,baseLevel:attackLevel};
                if(n==='Defence')return{level:45,baseLevel:45};
                return{level:60,baseLevel:60};
            },
            getState:()=>({
                player:{worldX:pos.x,worldZ:pos.z,level:0,lifeId:1,respawnCount:0,hp},
                inventory:inv,equipment,nearbyPlayers:[],nearbyNpcs:npc&&pos.x<2560?[npc]:[],nearbyLocs:[],groundItems:ground,
                bank:{isOpen:open,items:bank},
                combatStyle:{known:true,currentStyle:style,weaponName:wornWeapon()?.name??'',styles:[{index:0,name:'Chop',trainsSkills:['Attack']},{index:1,name:'Slash',trainsSkills:['Strength']},{index:3,name:'Block',trainsSkills:['Defence']}]},
            }),
        },
        bot:{
            openBank:async()=>{open=true;generation++;return{success:true};},
            closeBank:async()=>{open=false;return{success:true};},
            equipItem:async(item:any)=>{
                const slot=wearPosFor(item.id);
                const oldIdx=equipment.findIndex(i=>i.slot===slot);
                if(oldIdx>=0)inv.push(...equipment.splice(oldIdx,1));
                inv.splice(inv.indexOf(item),1);
                equipment.push({...item,slot});
                return{success:true};
            },
            eatFood:async(item:any)=>{
                item.count--;if(!item.count)inv.splice(inv.indexOf(item),1);
                hp=75;
                return{success:true};
            },
            attack:async()=>{
                attacks++;startupWeapons.push(wornWeapon()?.id??0);
                if(attacks===1)hp=30;
                xp.Strength+=3500;
                ground=[{id:532,name:'Big bones',count:1,x:2545,z:3144}];
                npc=null;
                return{success:true};
            },
            pickupItem:async(item:any)=>{
                ground=ground.filter(i=>i!==item);
                inv.push({id:item.id,name:item.name,count:1,slot:inv.length});
                if(attacks===1){hp=30;attackLevel=60;lostCityDone=true;}
                if(!ground.length)npc=spawn();
                return{success:true};
            },
            depositItem:async(item:any)=>{for(const i of inv.filter(x=>x.id===item.id)){const row=bank.find(r=>r.id===i.id);if(row)row.count+=i.count;else bank.push({...i,slot:bank.length});inv.splice(inv.indexOf(i),1);}generation++;return{success:true};},
            withdrawItem:async(item:any,n:number)=>{item.count-=n;if(item.count<=0)bank.splice(bank.indexOf(item),1);const row=inv.find(i=>i.id===item.id);if(row)row.count+=n;else inv.push({id:item.id,name:item.name,count:n,slot:inv.length,optionsWithIndex:item.id===385?[{text:'Eat',opIndex:1}]:undefined});generation++;return{success:true};},
        },
    };
    const walk=async(x:number,z:number)=>{pos={x,z};await waitTicks(session,1);return true;};
    try{
        const r=await runGiants(session,{cap:500,trainSkill:'Strength',targetLevel:99,maximum:2,food:1,walk});
        expect(r.failure).toBe('-');
        expect(r.ok).toBe(true);expect(r.creditedKills).toBe(2);expect(r.bankTrips).toBeGreaterThanOrEqual(3);
        expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);
        // Startup (Attack 40, Dragon Slayer + Fremennik Trials): Rune scimitar + Berserker helm + Rune platebody + Rune platelegs + Rune kiteshield.
        expect(startupWeapons[0]).toBe(1333);
        // Mid-run trip after Attack 60 & Lost City: upgrades to Dragon longsword (1305) while Legends Cape (1052) stays locked.
        expect(startupWeapons[1]).toBe(1305);
        expect(equipment.map(i=>i.id).sort((a,b)=>a-b)).toEqual([1079,1127,1201,1305,3751]);
        expect(equipment.some(i=>i.id===1052)).toBe(false);
    }finally{clearInterval(timer);}
});
});
