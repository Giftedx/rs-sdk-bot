import { expect, test } from 'bun:test';
import { isNoProgressFailure } from '../packages/practice/src/supervise';
import { mineRock, selectRock, oreStalled,oreDamageEvidence,watchOreDamage,retreatOre, selectActiveOrePickaxe, reconcileOrePickaxeAtBank } from './gather-ore';
import type { Session } from '../packages/core/src/inprocess';
import type { NearbyLoc } from '../vendor/rs-sdk/sdk/types';
const rock = (id = 2090, distance = 1): NearbyLoc => ({ id, name: 'Rocks', x: 3285, z: 3367, level: 0, distance, options: ['Mine'], optionsWithIndex: [{ text: 'Mine', opIndex: 1 }] });
function fixture(change: (tick: number, f: { rocks: NearbyLoc[]; ore: number; xp: number }) => void, rejected = false) {
    let tick = 0, calls = 0;
    const listeners = new Set<() => void>();
    const f = { rocks: [rock()], ore: 0, xp: 0 };
    const timer = setInterval(() => { tick++; change(tick, f); for (const cb of [...listeners]) cb(); }, 1);
    const s = { tick: () => tick, ended: new Promise(() => {}), onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        sdk: { getState: () => ({ nearbyLocs: f.rocks, gameMessages: [] }), getInventory: () => f.ore ? [{ name: 'Copper ore', count: f.ore }] : [], getSkillXp: () => f.xp,
            sendInteractLoc: async () => { calls++; return { success: !rejected, reason: 'client_rejected' }; } } } as unknown as Session;
    return { s, f, calls: () => calls, close: () => clearInterval(timer) };
}
test('chooses active eligible alternative when preferred species is gone; respects floor/reach/current level', () => {
    expect(selectRock([rock(2094)], 1, 0, 0)?.id).toBe(2094);
    expect(selectRock([rock(2092)], 14, 0, 0)).toBeUndefined();
    expect(selectRock([{ ...rock(), reachable: false }, { ...rock(2094), level: 1 }], 30, 0, 0)).toBeUndefined();
    expect(selectRock([rock(2090, 4), { ...rock(2091, 1), x: 3287 }], 1, 0, 0)?.id).toBe(2091);
});
test('unoccupied nodes precede crowded preferred species, while equally crowded nodes retain species rotation',()=>{
    const copper=rock(2090,1),tin={...rock(2094,4),x:3289,z:3364};
    expect(selectRock([copper,tin],30,0,0,'mixed',[{x:3285,z:3368}])).toBe(tin);
    expect(selectRock([copper,tin],30,0,0,'mixed',[{x:3285,z:3368},{x:3289,z:3365}])).toBe(copper);
    expect(selectRock([copper,{...rock(2091,5),x:3290,z:3364}],30,0,0,'mixed',[{x:3285,z:3367}])?.x).toBe(3290);
});

for (const replacement of [[], [rock(2093)], [{ ...rock(), optionsWithIndex: [] }]]) {
    test('depleted/despawned/replaced selected rock ends wait without60tick timeout', async () => {
        const f = fixture((t, state) => { if (t === 2) state.rocks = replacement; });
        try { const r = await mineRock(f.s, rock(), () => false); expect(r.reason).toBe('rock-gone'); expect(r.ticks).toBeLessThanOrEqual(3); expect(r.ore).toBe(0); }
        finally { f.close(); }
    });
}
test('our ore+XP wins over simultaneous depletion; publication can settle one tick later', async () => {
    const f = fixture((t, state) => { if (t === 2) { state.rocks = []; state.ore = 1; } if (t === 3) state.xp = 437; });
    try { expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ ore: 1, xp: 437, ticks: 3, reason: 'mined' }); }
    finally { f.close(); }
});
test('XP alone never counts ore production', async () => {
    const f = fixture((t, state) => { if (t === 2) { state.xp = 100; state.rocks = []; } });
    try { expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ ore: 0, xp: 100, reason: 'rock-gone' }); }
    finally { f.close(); }
});
test('client rejection ends immediately and does not pretend ore progress', async () => {
    const f = fixture(() => {}, true);
    try { expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ ore: 0, xp: 0, ticks: 0, reason: 'rejected:client_rejected' }); expect(f.calls()).toBe(1); }
    finally { f.close(); }
});
test('unchanged live rock retains a bounded roll wait and cumulative misses exhaust deadline', async () => {
    const f = fixture(() => {});
    try {
        let waiting = 0, attempts = 0;
        while (!oreStalled(waiting, 12)) { const r = await mineRock(f.s, rock(), () => false, Math.min(5, 12 - waiting)); waiting += r.ticks; attempts++; }
        expect(waiting).toBe(12); expect(attempts).toBe(3); expect(oreStalled(0, 12)).toBe(false);
    } finally { f.close(); }
});
test('already stale rock is not clicked', async () => {
    const f = fixture(() => {}); f.f.rocks = [];
    try { expect(await mineRock(f.s, rock(), () => false)).toMatchObject({ reason: 'rock-gone', ticks: 0 }); expect(f.calls()).toBe(0); }
    finally { f.close(); }
});

test('bounded ore failure is a permanent supervisor block, successful ore metrics are not', () => {
    expect(isNoProgressFailure('RESULT fail ticks=120 stop=no-progress no ore progress: bounded mining wait exhausted')).toBe(true);
    expect(isNoProgressFailure('RESULT ok mined=5 oreWaitTicks=0 stop=max-trips')).toBe(false);
});

test('explicit clay profile selects only exact clay IDs; default mixed profile stays unchanged', () => {
    const clay = rock(2108);
    expect(selectRock([clay, rock()], 1, 0, 0, 'clay')?.id).toBe(2108);
    expect(selectRock([clay, rock()], 1, 0, 0)?.id).toBe(2090);
    expect(selectRock([rock()], 99, 0, 0, 'clay')).toBeUndefined();
});

test('first positive damage cancels a live rock wait above7HP; a second attempt cannot click',async()=>{
    const f=fixture(()=>{});let hp=10,halted=false;const seen:any[]=[];
    (f.s.sdk as any).getSkill=()=>({level:hp,baseLevel:10});
    const off=watchOreDamage(f.s,e=>{seen.push(e);halted=true;});
    const hurt=f.s.onTick(()=>{if(f.s.tick()>=2)hp=8;});
    try{const r=await mineRock(f.s,rock(),()=>halted);expect(r.ticks).toBeLessThanOrEqual(4);expect(halted).toBe(true);expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({hpBefore:10,hpAfter:8,attacker:'unknown'});
        await mineRock(f.s,rock(),()=>halted);expect(f.calls()).toBe(1);
    }finally{off();hurt();f.close();}
});
test('near Mugger or player-facing damage evidence never becomes a claimed live attacker',()=>{
    const st={player:{worldX:3180,worldZ:3371,level:0,combat:{targetType:'player',targetIndex:44}},nearbyNpcs:[{id:175,index:9,name:'Mugger',distance:2,x:3179,z:3371,targetIndex:32769,inCombat:true}],nearbyPlayers:[{name:'Nearby',index:44,distance:1,x:3181,z:3371,inCombat:true}],combatEvents:[{type:'damage_taken',tick:8,sourceType:'other_player',sourceIndex:44,damage:2}]};
    const e=oreDamageEvidence(st,10,8,8)!;expect(e.attacker).toBe('unknown');expect(e.npcs[0].id).toBe(175);expect(e.players[0].index).toBe(44);expect(e.eventAttribution).toContain('heuristics');expect(e.events).toHaveLength(1);
    expect(oreDamageEvidence(st,0,8,8)).toBeUndefined();expect(oreDamageEvidence(st,8,10,8)).toBeUndefined();
});
function recoveryFixture(refuseFood=false) {
    const inv:any[]=[{id:434,name:'Clay',count:1,slot:0},{id:434,name:'Clay',count:19,slot:1},{id:2309,name:'Bread',count:1,slot:2,optionsWithIndex:[{text:'Eat',opIndex:1}]},{id:1265,name:'Bronze pickaxe',count:1,slot:3},{id:995,name:'Coins',count:25,slot:4}];
    let tick=0,hp=8;const bank:any[]=[{id:434,name:'Clay',count:0}],calls:string[]=[],listeners=new Set<()=>void>();
    const timer=setInterval(()=>{tick++;for(const cb of [...listeners])cb();},1);
    const state:any={player:{worldX:3171,worldZ:3396,level:0},bank:{items:bank}};
    const s={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getState:()=>state,getInventory:()=>inv,getSkill:()=>({level:hp,baseLevel:10})},direct:async(a:any)=>{calls.push('eat');expect(a.slot).toBe(2);if(!refuseFood){inv.splice(inv.findIndex(i=>i.id===2309),1);hp=10;}return{success:!refuseFood};},bot:{openBank:async()=>({success:true}),closeBank:async()=>({success:true}),depositItem:async(item:any)=>{calls.push('deposit:'+item.id);bank[0].count+=inv.filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0);for(let i=inv.length-1;i>=0;i--)if(inv[i].id===item.id)inv.splice(i,1);return{success:true};}}} as unknown as Session;
    const walk=async()=>{calls.push('walk');state.player={worldX:3185,worldZ:3436,level:0};return true;};
    return{s,inv,bank,calls,walk,close:()=>clearInterval(timer)};
}
test('wounded owned20Clay recovery heals confirmedBread beforewalk, banks raw only and preserves tools/coins',async()=>{
    const f=recoveryFixture();try{const r=await retreatOre(f.s,{x:3185,z:3436},/^clay$/i,()=>false,f.walk);expect(r).toMatchObject({ok:true,banked:20,held:0,hp:10});expect(r.foods).toEqual([{id:2309,count:1,hpBefore:8,hpAfter:10}]);expect(f.calls).toEqual(['eat','walk','deposit:434']);expect(f.bank[0].count).toBe(20);expect(f.inv.map(i=>[i.id,i.count])).toEqual([[1265,1],[995,25]]);}finally{f.close();}
});
test('unconfirmed food is bounded to2attempts; no alive session means no eat/walk/deposit',async()=>{
    const f=recoveryFixture(true);try{const r=await retreatOre(f.s,{x:3185,z:3436},/^clay$/i,()=>false,f.walk);expect(r.foods).toEqual([]);expect(f.calls.filter(c=>c==='eat')).toHaveLength(2);expect(f.inv.some(i=>i.id===2309)).toBe(true);}finally{f.close();}
    const g=recoveryFixture();try{await expect(retreatOre(g.s,{x:3185,z:3436},/^clay$/i,()=>true,g.walk)).rejects.toThrow('no ore progress');expect(g.calls).toEqual([]);}finally{g.close();}
});
test('failed route or expired retreat cannot claim deposit or continue mining',async()=>{
    const f=recoveryFixture();try{await expect(retreatOre(f.s,{x:3185,z:3436},/^clay$/i,()=>false,async()=>false)).rejects.toThrow('bounded safety retreat');expect(f.calls.some(c=>c.startsWith('deposit'))).toBe(false);expect(f.inv.filter(i=>i.id===434).reduce((n,i)=>n+i.count,0)).toBe(20);}finally{f.close();}
    const g=recoveryFixture();try{await expect(retreatOre(g.s,{x:3185,z:3436},/^clay$/i,()=>false,async()=>{g.s.tick=()=>1000;return true;})).rejects.toThrow('bounded safety retreat');expect(g.calls.some(c=>c.startsWith('deposit'))).toBe(false);}finally{g.close();}
    const dead=recoveryFixture();(dead.s.sdk as any).getSkill=()=>({level:0,baseLevel:10});try{await expect(retreatOre(dead.s,{x:3185,z:3436},/^clay$/i,()=>false,dead.walk)).rejects.toThrow('died=true');expect(dead.calls).toEqual([]);}finally{dead.close();}
});

test('reconcileOrePickaxeAtBank selects, wields when Attack allows, and buys Nurmof upgrade when funded', async () => {
    let bankOpen = true, shopOpen = false, gen = 1, tick = 0;
    const bank: any[] = [{ id: 1265, name: 'Bronze pickaxe', count: 1, slot: 0 }, { id: 995, name: 'Coins', count: 5000, slot: 1 }];
    const inv: any[] = [];
    const eq: any[] = [];
    const shopItems = [{ id: 1273, name: 'Mithril pickaxe', count: 2, buyPrice: 1300, slot: 0 }];
    let attack = 1;
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 1);

    const state: any = { bank: { isOpen: true, items: bank }, shop: { isOpen: false, shopItems } };
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        bankObservation: () => bankOpen ? { generation: gen, items: bank } : null,
        sdk: {
            getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Mining' ? 21 : attack, baseLevel: n === 'Attack' ? attack : 21 }),
        },
        bot: {
            openBank: async () => { bankOpen = true; gen++; return { success: true }; },
            closeBank: async () => { bankOpen = false; return { success: true }; },
            withdrawItem: async (item: any, n: number) => {
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                const held = inv.find(r => r.id === item.id);
                if (held && item.id === 995) held.count += n;
                else inv.push({ id: item.id, name: item.name, count: n });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                const row = bank.find(r => r.id === removed.id);
                if (row) row.count += removed.count;
                else bank.push({ ...removed });
                gen++;
                return { success: true };
            },
            equipItem: async (item: any) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const [removed] = inv.splice(idx, 1);
                eq.push({ ...removed, slot: 3 });
                return { success: true };
            },
            openShop: async () => { shopOpen = true; return { success: true }; },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.name, count: n });
                return { success: true };
            },
            closeShop: async () => { shopOpen = false; return { success: true }; },
        },
    };

    try {
        // At Mining 21, Attack 1 with 5000gp: buys Mithril pickaxe (1273) from Nurmof, carries in pack (not wielded).
        const rLow = await reconcileOrePickaxeAtBank(s, {
            bankSpot: { x: 3253, z: 3420 },
            stop: () => false,
            walkTo: async spot => { walks.push(`${spot.x},${spot.z}`); return true; },
        });
        expect(rLow).toEqual({ activeId: 1273, worn: false, bought: 1273 });
        expect(walks).toEqual(['2998,9844', '3253,3420']);
        expect(eq).toHaveLength(0);
        expect(inv.map(i => i.id)).toEqual([1273]);
        expect(bank.find(i => i.id === 995)?.count).toBe(5000 - 1300);
        expect(selectActiveOrePickaxe(s).current?.item.id).toBe(1273);

        // After hitting Attack 20: same Mithril pickaxe is automatically wielded into slot 3.
        attack = 20;
        const rHigh = await reconcileOrePickaxeAtBank(s, {
            bankSpot: { x: 3253, z: 3420 },
            stop: () => false,
            allowShop: false,
        });
        expect(rHigh.activeId).toBe(1273);
        expect(rHigh.worn).toBe(true);
        expect(eq[0]?.id).toBe(1273);
        expect(inv).toHaveLength(0);
    } finally {
        clearInterval(timer);
    }
});

test('reconcileOrePickaxeAtBank recovers coins when Nurmof shelf is empty, skips repeat trips for 700 ticks, and retries on restock or higher tier', async () => {
    let bankOpen = true, shopOpen = false, gen = 1, tick = 100;
    let mining = 31;
    const bank: any[] = [{ id: 1265, name: 'Bronze pickaxe', count: 1, slot: 0 }, { id: 995, name: 'Coins', count: 40000, slot: 1 }];
    const inv: any[] = [];
    const eq: any[] = [];
    const shopItems = [
        { id: 1271, name: 'Adamant pickaxe', count: 0, buyPrice: 3200, slot: 0 },
        { id: 1275, name: 'Rune pickaxe', count: 0, buyPrice: 32000, slot: 1 },
    ];
    const walks: string[] = [];
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 2);

    const state: any = { bank: { isOpen: true, items: bank }, shop: { isOpen: false, shopItems } };
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        bankObservation: () => bankOpen ? { generation: gen, items: bank } : null,
        sdk: {
            getState: () => ({ ...state, inventory: inv, equipment: eq, bank: { isOpen: bankOpen, items: bank }, shop: { isOpen: shopOpen, shopItems } }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: (n: string) => ({ level: n === 'Mining' ? mining : 1, baseLevel: n === 'Mining' ? mining : 1 }),
        },
        bot: {
            openBank: async () => { bankOpen = true; gen++; return { success: true }; },
            closeBank: async () => { bankOpen = false; return { success: true }; },
            withdrawItem: async (item: any, n: number) => {
                const row = bank.find(r => r.id === item.id);
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                inv.push({ id: item.id, name: item.name, count: n, slot: 0 });
                gen++;
                return { success: true };
            },
            depositItem: async (item: any, n: number) => {
                const idx = inv.findIndex(r => r.id === item.id);
                const cur = inv[idx];
                const amt = n === -1 ? cur.count : n;
                cur.count -= amt;
                if (cur.count <= 0) inv.splice(idx, 1);
                const row = bank.find(r => r.id === item.id);
                if (row) row.count += amt;
                else bank.push({ id: item.id, name: item.name, count: amt, slot: 0 });
                gen++;
                return { success: true };
            },
            openShop: async () => { shopOpen = true; return { success: true }; },
            buyFromShop: async (row: any, n: number) => {
                row.count -= n;
                inv.find(i => i.id === 995).count -= row.buyPrice * n;
                inv.push({ id: row.id, name: row.name, count: n, slot: 1 });
                return { success: true };
            },
            closeShop: async () => { shopOpen = false; return { success: true }; },
        },
    };

    const walkTo = async (spot: { x: number; z: number }) => { walks.push(`${spot.x},${spot.z}`); return true; };

    try {
        // Trip 1 (Mining 31): Nurmof out of Addy -> walks back, deposits 4000gp, keeps Bronze pickaxe.
        const r1 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r1).toEqual({ activeId: 1265, worn: false, bought: undefined });
        expect(walks).toEqual(['2998,9844', '3253,3420']);
        expect(bank.find(i => i.id === 995)?.count).toBe(40000);
        expect(inv.filter(i => i.id === 995)).toHaveLength(0);

        // Trip 2 within cooldown: skips Nurmof entirely.
        tick += 50;
        const r2 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r2).toEqual({ activeId: 1265, worn: false, bought: undefined });
        expect(walks).toHaveLength(2);

        // Crossing Mining 41 resets gate immediately -> tries Rune pickaxe, also empty, deposits coins cleanly.
        mining = 41;
        const r3 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r3).toEqual({ activeId: 1265, worn: false, bought: undefined });
        expect(walks).toEqual(['2998,9844', '3253,3420', '2998,9844', '3253,3420']);
        expect(bank.find(i => i.id === 995)?.count).toBe(40000);

        // Still inside 700-tick cooldown at Mining 41 -> skipped even after Rune pickaxe restocks.
        shopItems[1]!.count = 1;
        tick += 100;
        await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(walks).toHaveLength(4);

        // After 700 ticks elapsed: retries Nurmof and buys Rune pickaxe.
        tick += 650;
        const r4 = await reconcileOrePickaxeAtBank(s, { bankSpot: { x: 3253, z: 3420 }, stop: () => false, walkTo });
        expect(r4).toEqual({ activeId: 1275, worn: false, bought: 1275 });
        expect(inv.map(i => i.id)).toEqual([1275]);
    } finally {
        clearInterval(timer);
    }
});
