import {expect,test} from 'bun:test';
import {chickenTrainingStyle,chickenTrainingKit,chickenStyleForWeapon,chickenDesiredSkill,chickenTrainingProfile,chickenTrainingThreat,chickenTrainingTarget,chickenStrengthGoal,chickenTrainingHealth,chickenTrainingEntry,chickenCombatUnlockPlan,chickenCombatUnlockStyle,chickenCombatUnlockMode,guardArdougneTrainingWalker,trainChickens} from './train-chickens';
import {mixedOreCombatProblem} from '../packages/workers/src/gather';
import {gearById} from '../packages/planner/src/gear-progression';
import {waitTicks} from '../packages/core/src/ticks';

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
