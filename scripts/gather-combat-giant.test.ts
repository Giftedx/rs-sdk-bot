import {test,expect} from 'bun:test';
import {GIANT,CONFIGS,TROOPER_FOODS,giantStyle,giantTraining,giantCredit,giantKillLimit,runGiants,selectGiantWeapon,selectGiantBow,selectGiantArrows,roamTarget,anothersFight,ammoPiles,AMMO_REACH,AMMO_WORTH} from './gather-combat';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks} from '../packages/core/src/ticks';

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

test('Hitpoints accepts every observed weapon style and credits only its own XP and base level',async()=>{
    expect(giantTraining('Hitpoints',76)).toEqual({skill:'Hitpoints',targetLevel:76});
    expect(giantStyle({known:true,weaponName:'Sword',currentStyle:2,styles:SWORD_TAB},'Hitpoints').index).toBe(2);
    const f=giantFixture();try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Hitpoints',targetLevel:76,walk:f.walk});
        expect(r.ok).toBe(true);expect(r.selectedXp).toBe(7000);expect(r.finalLevel).toBe(76);expect(r.creditedKills).toBe(2);
    }finally{f.dispose();}
});
test('entry travels from an owned location and stages banked melee weapon and food without losing the old weapon',async()=>{
    const f=giantFixture({bankedKit:true});const legs:number[][]=[];try{
        const r=await runGiants(f.session,{cap:500,trainSkill:'Strength',targetLevel:90,walk:async(x,z,t)=>{legs.push([x,z]);return f.walk(x,z);}});
        expect(r.ok).toBe(true);expect(legs[0]).toEqual([2655,3283]);expect(legs).toContainEqual([2545,3144]);
        expect(f.inv.some(i=>i.id===1381)).toBe(true);expect(r.preserved).toBe(true);expect(r.foodAccounted).toBe(true);
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
