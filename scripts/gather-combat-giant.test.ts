import {test,expect} from 'bun:test';
import {GIANT,CONFIGS,giantStyle,giantTraining,giantCredit,giantKillLimit,runGiants,selectGiantWeapon} from './gather-combat';
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
    expect(()=>giantTraining('Ranged',90)).toThrow('TRAIN_SKILL');expect(()=>giantTraining('Strength')).toThrow('TARGET_LEVEL');expect(()=>giantTraining('Strength',100)).toThrow('TARGET_LEVEL');
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
