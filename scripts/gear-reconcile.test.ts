import {expect,test} from 'bun:test';
import type {Session} from '../packages/core/src/inprocess';
import {gearById,selectProgressiveLoadout} from '../packages/planner/src/gear-progression';
import {gearLevelWatch,gearWants,loadoutTargets,questPointsFloor,reconcileLoadout} from './gear-reconcile';

type Row={id:number;name:string;count:number;slot:number};
const WEARPOS:Record<string,number>={hat:0,back:1,front:2,righthand:3,torso:4,lefthand:5,legs:7,hands:9,feet:10,quiver:13};
const LEVELS={Attack:40,Strength:40,Defence:40,Ranged:1,Magic:1};

// A session with a pack, worn gear and a bank. A mocked equip puts the replaced item back in the pack, as the game does.
function fixture(o:{inv?:number[];junk?:number;equipment?:number[];bank?:number[];depositFails?:boolean;equipFails?:number[];capacity?:number}={}){
    let tick=0,open=!!o.bank,generation=1;const listeners=new Set<()=>void>(),events:string[]=[];
    const row=(id:number,slot:number,count=1):Row=>({id,name:gearById(id)?.name??`item${id}`,count,slot});
    const inv:Row[]=[...(o.inv??[]).map((id,i)=>row(id,i)),...Array.from({length:o.junk??0},(_,i)=>row(333,100+i))];
    const equipment:Row[]=(o.equipment??[]).map(id=>row(id,WEARPOS[gearById(id)!.slot]!));
    const bank:Row[]=(o.bank??[]).map((id,i)=>row(id,i));
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1);
    const worn=(id:number)=>equipment.some(e=>e.id===id);
    const session={
        name:'gear-fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),
        bankObservation:()=>open?{generation,at:Date.now(),items:bank}:null,
        sdk:{
            getState:()=>({bank:{isOpen:open,items:bank},equipment}),getInventory:()=>inv,getEquipment:()=>equipment,
            getSkill:(n:string)=>n in LEVELS?{level:LEVELS[n as keyof typeof LEVELS],baseLevel:LEVELS[n as keyof typeof LEVELS]}:{level:1,baseLevel:1},
        },
        bot:{
            openBank:async()=>{open=true;generation++;events.push('open');return{success:true};},
            closeBank:async()=>{open=false;events.push('close');return{success:true};},
            equipItem:async(item:Row)=>{
                if(o.equipFails?.includes(item.id))return{success:false,message:'Failed to equip '+item.name};
                const pos=WEARPOS[gearById(item.id)!.slot]!;
                inv.splice(inv.indexOf(item),1);
                for(const old of equipment.filter(e=>e.slot===pos)){equipment.splice(equipment.indexOf(old),1);inv.push({...old,slot:inv.length});}
                equipment.push({...item,slot:pos});events.push('equip '+item.id);return{success:true};
            },
            withdrawItem:async(item:Row,n:number)=>{
                const at=bank.find(b=>b.id===item.id);if(!at||at.count<n)return{success:false};
                at.count-=n;if(!at.count)bank.splice(bank.indexOf(at),1);
                inv.push({id:item.id,name:item.name,count:n,slot:inv.length});generation++;events.push('withdraw '+item.id);return{success:true};
            },
            depositItem:async(item:Row)=>{
                if(o.depositFails)return{success:false};
                // The old weapon is banked only after the new one is worn: record what was worn at that moment.
                events.push(`deposit ${item.id} worn=[${equipment.map(e=>e.id).join(',')}]`);
                inv.splice(inv.indexOf(item),1);
                const at=bank.find(b=>b.id===item.id);if(at)at.count+=item.count;else bank.push({...item,slot:bank.length});
                generation++;return{success:true};
            },
        },
    };
    return{session:session as unknown as Session,inv,equipment,bank,events,worn,dispose:()=>clearInterval(timer),capacity:o.capacity};
}

test('with the bank closed it wears the better item from the pack and keeps the old one in the pack',async()=>{
    const f=fixture({inv:[1333],equipment:[1329]});
    try{
        const r=await reconcileLoadout(f.session,{style:'melee',levels:LEVELS});
        expect(f.worn(1333)).toBe(true);expect(f.worn(1329)).toBe(false);
        expect(r.weaponChanged).toBe(true);expect(r.worn).toEqual([1333]);
        expect(r.displaced).toEqual([1329]);expect(f.inv.some(i=>i.id===1329)).toBe(true);
        // The bank was not touched.
        expect(f.events.filter(e=>/^(open|close|withdraw|deposit)/.test(e))).toEqual([]);
    }finally{f.dispose();}
});

test('the bank is told a better item is waiting when the pack and the worn gear lack it',async()=>{
    const f=fixture({equipment:[1329]});
    try{
        const r=await reconcileLoadout(f.session,{style:'melee',levels:LEVELS,bankItems:[{id:1333,count:1}]});
        expect(r.bankBetter).toBe(true);expect(f.worn(1329)).toBe(true);
        const none=await reconcileLoadout(f.session,{style:'melee',levels:LEVELS,bankItems:[]});
        expect(none.bankBetter).toBe(false);
    }finally{f.dispose();}
});

test('with the bank open it withdraws, wears, and banks the old weapon only after the new one is worn',async()=>{
    const f=fixture({equipment:[1329],bank:[1333]});
    try{
        const r=await reconcileLoadout(f.session,{style:'melee',levels:LEVELS,bankOpen:true,strict:true});
        expect(f.worn(1333)).toBe(true);expect(f.inv.some(i=>i.id===1329)).toBe(false);
        expect(f.bank.some(b=>b.id===1329)).toBe(true);expect(r.deposited).toEqual([1329]);
        const order=f.events.filter(e=>/^(withdraw|equip|deposit)/.test(e));
        expect(order[0]).toBe('withdraw 1333');expect(order[1]).toBe('equip 1333');
        // The deposit of the mithril scimitar saw the rune scimitar already worn.
        expect(order[2]).toMatch(/^deposit 1329 worn=\[.*\b1333\b.*\]$/);
        expect(f.events.at(-1)).toBe('close');
    }finally{f.dispose();}
});

test('a full pack takes the loadout in three bank passes, one item a pass',async()=>{
    // 27 pack slots held: one free slot. Rune scimitar, helm and legs come out one at a time.
    const f=fixture({junk:27,bank:[1333,1163,1079]});
    try{
        const r=await reconcileLoadout(f.session,{style:'melee',levels:LEVELS,bankOpen:true,strict:true});
        for(const id of [1333,1163,1079])expect(f.worn(id)).toBe(true);
        expect(r.pending).toEqual([]);
        expect(f.events.filter(e=>e==='close').length).toBe(3);
        expect(f.events.filter(e=>e==='open').length).toBe(2);
        expect(f.events.filter(e=>e.startsWith('withdraw')).length).toBe(3);
    }finally{f.dispose();}
});

test('a failed deposit of the replaced item throws with strict and is left in the pack without it',async()=>{
    const strict=fixture({equipment:[1329],bank:[1333],depositFails:true});
    try{
        await expect(reconcileLoadout(strict.session,{style:'melee',levels:LEVELS,bankOpen:true,strict:true,label:'cow kit'}))
            .rejects.toThrow('cow kit: replaced gear deposit failed (1329)');
    }finally{strict.dispose();}
    const lax=fixture({equipment:[1329],bank:[1333],depositFails:true});
    try{
        const r=await reconcileLoadout(lax.session,{style:'melee',levels:LEVELS,bankOpen:true});
        expect(lax.worn(1333)).toBe(true);expect(r.deposited).toEqual([]);
        // The old weapon is not lost: it stays in the pack.
        expect(lax.inv.some(i=>i.id===1329)).toBe(true);
    }finally{lax.dispose();}
});

test('a weapon that will not equip throws with strict and is reported pending without it',async()=>{
    const strict=fixture({inv:[1333],equipment:[1329],equipFails:[1333]});
    try{
        await expect(reconcileLoadout(strict.session,{style:'melee',levels:LEVELS,strict:true,label:'cow kit'}))
            .rejects.toThrow(/^cow kit equip failed 1333: Failed to equip Rune scimitar; equipped item not observed/);
    }finally{strict.dispose();}
    const lax=fixture({inv:[1333],equipment:[1329],equipFails:[1333]});
    try{
        const r=await reconcileLoadout(lax.session,{style:'melee',levels:LEVELS});
        expect(r.pending).toContain(1333);expect(lax.worn(1329)).toBe(true);
    }finally{lax.dispose();}
});

test('the Ranged loadout wears the bow, the arrows it fires and the armour',async()=>{
    const f=fixture({inv:[853,890,1133,1097]});
    f.inv.find(i=>i.id===890)!.count=300;
    try{
        const levels={...LEVELS,Ranged:30,Defence:20};
        const r=await reconcileLoadout(f.session,{style:'ranged',levels,thrown:false});
        for(const id of [853,890,1133,1097])expect(f.worn(id)).toBe(true);
        expect(r.ammo).toEqual({id:890,wearpos:13});
    }finally{f.dispose();}
});

test('the unlock watch takes its baseline when every skill is read and never fires before that',()=>{
    let synced=false,defence=44;
    const s={sdk:{getSkill:(n:string)=>synced?{level:n==='Defence'?defence:1,baseLevel:n==='Defence'?defence:1}:null}} as never;
    const watch=gearLevelWatch(s,'melee');
    expect(watch.crossed()).toBe(false);          // skills not read: the real levels are no crossing
    synced=true;
    expect(watch.crossed()).toBe(false);          // the first read is the baseline
    defence=45;
    expect(watch.crossed()).toBe(true);           // Defence 44 to 45 unlocks gear
    expect(watch.crossed()).toBe(false);
});

test('GEAR_WANT rows name an unowned best item with a shop or a trade, and quest points are counted',()=>{
    expect(questPointsFloor(null)).toBe(0);
    expect(questPointsFloor(new Set(['Cook','Doric']))).toBe(2);
    expect(questPointsFloor([{name:'a',state:'complete'},{name:'b',state:'started'}])).toBe(1);
    const f=fixture({equipment:[1329]});
    try{
        const want=gearWants('gear-fixture',selectProgressiveLoadout('melee',[{id:1329,count:1}],LEVELS,[],{questPoints:0}));
        expect(want.length).toBeGreaterThan(0);
        for(const w of want)expect(w.source.kind==='trade'||w.source.shop.length>0).toBe(true);
        expect(want.find(w=>w.slot==='weapon')?.current).toBe(1329);
        expect(loadoutTargets(selectProgressiveLoadout('melee',[{id:1329,count:1}],LEVELS,[]),{weapon:1333}).find(t=>t.slot==='weapon')?.id).toBe(1333);
    }finally{f.dispose();}
});
