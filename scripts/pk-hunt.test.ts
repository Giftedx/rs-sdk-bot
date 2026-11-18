import { expect, spyOn, test } from 'bun:test';
import { BOW_TRIP, fleetNames, hitByPlayer, hunt, HUNT_PRESETS, loot, pickTarget, pickTrip, resolveHuntSpots, restock, SNARE_TRIP, TRIBRID_KIT, TRIP, verdict } from './pk-hunt';
import { assessWildernessThreat, planWildernessEscape, restockPlan, restockPlanFromStock, slashWebThrough, WILDERNESS_ESCAPES, wildernessCombatMargin, wildernessDepth } from './pk-roam';
import { pvpCombatBracket } from './aio-pvp';
import * as pk from './pk';
import { RESTOCK_LIMITS, RESTOCK_MARKET } from './measure/pk-restock-fixture';
import * as walking from '../packages/core/src/walk';

const me = { z: 3556, combatLevel: 126 };
const p = (index: number, name: string, combatLevel: number, distance: number, extra: object = {}) => ({ index, name, combatLevel, z: 3556, distance, ...extra });

test('the target is whoever is hitting us, even a fleet account', () => {
    const players = [p(1, 'Stranger', 126, 2), p(2, 'KnightRider', 126, 5)];
    expect(pickTarget(me, players, new Set(['knightrider']), 2)?.name).toBe('KnightRider');
});

test('otherwise the nearest attackable stranger who is not already fighting a player', () => {
    const players = [p(1, 'KnightRider', 126, 1), p(2, 'Busy', 126, 2, { inCombat: true, combatTargetType: 'player' }), p(3, 'Far', 125, 9), p(4, 'Near', 124, 4), p(5, 'Low', 100, 3)];
    expect(pickTarget(me, players, new Set(['knightrider']), null)?.name).toBe('Near');
    expect(pickTarget(me, [p(5, 'Low', 100, 3)], new Set(), null)).toBeUndefined();
    expect(pickTarget(me, [p(6, 'NpcFighter', 126, 2, { inCombat: true, combatTargetType: 'npc' })], new Set(), null)?.name).toBe('NpcFighter');
});

test('fleet names cover every side and the main account, in lower case', () => {
    const owners = new Map([['knightrider', { side: 'claude-cloud-4', server: 's' }], ['porksword', { side: 'cloud', server: 's' }]]);
    expect(fleetNames(owners as any)).toEqual(new Set(['knightrider', 'porksword', 'haggis']));
});

test('every seen player gets a verdict: fleet, out of range, busy or attackable', () => {
    const ours = new Set(['knightrider']);
    expect(verdict(me, p(1, 'KnightRider', 126, 1), ours)).toBe('fleet');
    expect(verdict(me, p(2, 'Low', 100, 1), ours)).toBe('out of range');
    expect(verdict(me, p(3, 'Busy', 126, 1, { inCombat: true, combatTargetType: 'player' }), ours)).toBe('busy');
    expect(verdict(me, p(3, 'Busy', 126, 1, { inCombat: true, combatTargetType: 'player' }), ours, true)).toBe('attackable');
    expect(pickTarget(me, [p(3, 'Busy', 126, 1, { inCombat: true, combatTargetType: 'player' })], ours, null, undefined, true)?.name).toBe('Busy');
    expect(verdict(me, p(4, 'Fair', 122, 1), ours)).toBe('attackable');
});

test("only a player's hit on us counts as an attack, not an NPC's damage reported as taken", () => {
    expect(hitByPlayer({ type: 'damage_taken', sourceType: 'other_player', targetType: 'player', sourceIndex: 2 })).toBe(true);
    expect(hitByPlayer({ type: 'damage_taken', sourceType: 'other_player', targetType: 'npc', sourceIndex: -1 })).toBe(false);
    expect(hitByPlayer({ type: 'damage_taken', sourceType: 'npc', targetType: 'player', sourceIndex: 5 })).toBe(false);
    expect(hitByPlayer({ type: 'damage_dealt', sourceType: 'player', targetType: 'other_player', sourceIndex: 0 })).toBe(false);
});

test('restock re-equips melee weapon, shield, and platebody before depositing so ending a fight on ranged/magic preserves kit', async () => {
    const inventory: any[] = [
        { slot: 0, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        { slot: 1, id: 1201, name: 'Rune kiteshield', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
        { slot: 2, id: 1127, name: 'Rune platebody', count: 1, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
        { slot: 3, id: 1401, name: 'Mystic fire staff', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] },
    ];
    const equipment: any[] = [{ slot: 3, id: 861, name: 'Magic shortbow', count: 1 }];
    const bank: any[] = [{ id: 385, count: 50 }];
    const s: any = {
        sdk: {
            getInventory: () => inventory,
            getEquipment: () => equipment,
            getBankItems: () => bank,
            sendUseItem: async (slot: number) => {
                const idx = inventory.findIndex(i => i.slot === slot);
                if (idx >= 0) {
                    const [item] = inventory.splice(idx, 1);
                    if (item.id === 1231) {
                        const bowIdx = equipment.findIndex(e => e.id === 861);
                        if (bowIdx >= 0) inventory.push(equipment.splice(bowIdx, 1)[0]);
                    }
                    equipment.push(item);
                }
            },
        },
        bot: {
            openBank: async () => ({ success: true }),
            closeBank: async () => {},
            depositItem: async (item: any) => {
                const idx = inventory.findIndex(i => i.id === item.id);
                if (idx >= 0) inventory.splice(idx, 1);
                const row = bank.find(b => b.id === item.id);
                if (row) row.count += item.count; else bank.push({ id: item.id, count: item.count });
            },
            withdrawItem: async (row: any, need: number) => {
                row.count -= need;
                inventory.push({ slot: inventory.length, id: row.id, count: need });
            },
        },
    };
    const err = await restock(s, 2, [{ id: 1401, count: 1 }, { id: 861, count: 1 }], TRIBRID_KIT);
    expect(err).toBeNull();
    expect(equipment.map(e => e.id).sort()).toEqual([1127, 1201, 1231]);
    expect(inventory.some(i => i.id === 1401)).toBe(true);
    expect(inventory.some(i => i.id === 861)).toBe(true);
    expect(inventory.find(i => i.id === 385)?.count).toBe(2);
});

test('restock takes one of each boost potion the bank holds, each in place of one shark', async () => {
    const inventory: any[] = [], bank: any[] = [{ id: 385, count: 30 }, { id: 2440, count: 2 }, { id: 169, count: 1 }, { id: 1401, count: 1 }];
    const s: any = {
        sdk: { getInventory: () => inventory, getEquipment: () => [], getBankItems: () => bank, sendUseItem: async () => {} },
        bot: {
            openBank: async () => ({ success: true }), closeBank: async () => {}, depositItem: async () => {},
            withdrawItem: async (row: any, need: number) => { row.count -= need; inventory.push({ slot: inventory.length, id: row.id, count: need }); },
        },
    };
    expect(await restock(s, 10, [{ id: 1401, count: 1 }], TRIBRID_KIT)).toBeNull();
    expect(inventory.filter(i => i.id === 2440 || i.id === 169).map(i => i.id).sort((a, b) => a - b)).toEqual([169, 2440]); // super strength, a 3-dose ranging potion
    expect(inventory.find(i => i.id === 385)?.count).toBe(8);
});


test('pickTrip takes the snare trip where the bank holds all of it, else the staff trip', () => {
    const snare = SNARE_TRIP.map(w => ({ id: w.id, count: w.count }));
    expect(pickTrip(snare).name).toBe('snare');
    expect(pickTrip(snare.slice(1)).name).toBe('staff');
    expect(pickTrip(snare.map((w, i) => (i === 1 ? { ...w, count: w.count - 1 } : w))).name).toBe('staff');
    expect(pickTrip([]).trip).toBe(TRIP);
});

test('pickTrip takes the bow trip with three more sharks at shallow spots, where the bank holds it', () => {
    const bow = BOW_TRIP.map(w => ({ id: w.id, count: w.count }));
    expect(pickTrip(bow, true)).toMatchObject({ name: 'bow', moreFood: 3 });
    expect(pickTrip(bow, false).name).toBe('staff');
    expect(pickTrip(SNARE_TRIP.map(w => ({ id: w.id, count: w.count })), false)).toMatchObject({ name: 'snare', moreFood: 0 });
    expect(pickTrip(bow.slice(1), true).name).toBe('staff');
});

test('pickTrip accepts a partial charged glory but keeps eight prayer doses in two slots', () => {
    const bank = BOW_TRIP.map(w => ({ id: w.id === 1712 ? 1706 : w.id, count: w.count }));
    expect(pickTrip(bank, true).name).toBe('bow');
    expect(pickTrip(bank.map(w => w.id === 2434 ? { id: 139, count: 2 } : w), true).name).toBe('staff');
    expect(pickTrip(bank.map(w => w.id === 1706 ? { id: 1704, count: 1 } : w), true).name).toBe('staff');
});

function supplyBank(rows: { id: number; count: number }[], worn: any[] = []) {
    const inventory: any[] = [], bank = rows.map(r => ({ ...r })), withdrawals: { id: number; count: number }[] = [];
    const s: any = {
        sdk: { getInventory: () => inventory, getEquipment: () => worn, getBankItems: () => bank, sendUseItem: async () => {} },
        bot: {
            openBank: async () => ({ success: true }), closeBank: async () => {}, depositItem: async () => {},
            withdrawItem: async (row: any, count: number) => { row.count -= count; withdrawals.push({ id: row.id, count }); inventory.push({ id: row.id, count, slot: inventory.length }); },
        },
    };
    return { s, inventory, withdrawals };
}

test('restock refuses two partial prayer bottles before any withdrawal for an eight-dose trip', async () => {
    const f = supplyBank([{ id: 139, count: 2 }, { id: 385, count: 20 }]);
    expect(await restock(f.s, 2, [{ id: 2434, count: 2 }])).toContain('lacks');
    expect(f.withdrawals).toEqual([]);
});

test('planning and restock choose the same exact partial charged glory', async () => {
    const bank = [...BOW_TRIP.map(w => ({ id: w.id === 1712 ? 1706 : w.id, count: w.count })), { id: 385, count: 30 }];
    const f = supplyBank(bank), selected = pickTrip(bank, true);
    expect(selected.name).toBe('bow');
    expect(await restock(f.s, 2, BOW_TRIP, TRIBRID_KIT, rows => pickTrip(rows, true))).toBeNull();
    expect(f.withdrawals.filter(r => r.id !== 385)).toEqual(selected.resolution.items);
    expect(f.withdrawals.filter(r => r.id !== 385)).toEqual(expect.arrayContaining([{ id: 861, count: 1 }, { id: 2434, count: 2 }, { id: 1706, count: 1 }]));
});

test('a worn glory cannot fund the pack-held emergency escape', async () => {
    const f = supplyBank([{ id: 385, count: 20 }], [{ id: 1712, count: 1, slot: 2 }]);
    const escape = BOW_TRIP.filter(r => r.id === 1712);
    expect(await restock(f.s, 2, escape)).toContain('lacks');
    expect(f.withdrawals).toEqual([]);
});

test('an explicit slot extension carries eight prayer doses in three partial bottles', async () => {
    const f = supplyBank([{ id: 139, count: 2 }, { id: 141, count: 1 }, { id: 385, count: 20 }]);
    expect(await restock(f.s, 2, [{ id: 2434, count: 2, minDoses: 8, maxSlots: 3 }])).toBeNull();
    expect(f.withdrawals).toEqual(expect.arrayContaining([{ id: 139, count: 2 }, { id: 141, count: 1 }]));
});

test('restock checks the observed exact withdrawal effect', async () => {
    const f = supplyBank([{ id: 861, count: 1 }, { id: 385, count: 20 }]);
    f.s.bot.withdrawItem = async () => ({ success: true });
    expect(await restock(f.s, 2, [{ id: 861, count: 1 }])).toContain('short');
});

test('malformed PK_TRIP arrays refuse before opening the bank or moving assets', async () => {
    for (const trip of [null, {}, [null], [{ id: 2434, count: 2, minDoses: 'eight' }]]) {
        const f = supplyBank([{ id: 385, count: 20 }]);
        let opened = false;
        f.s.bot.openBank = async () => { opened = true; return { success: true }; };
        expect(await restock(f.s, 2, trip as any)).toContain('invalid');
        expect(opened).toBe(false);
        expect(f.withdrawals).toEqual([]);
    }
});

test('a captured mixed-dose pack preserves its total doses without consuming the full bottles twice', async () => {
    const f = supplyBank([{ id: 143, count: 1 }, { id: 2434, count: 2 }, { id: 385, count: 20 }]);
    expect(await restock(f.s, 2, [{ id: 143, count: 1 }, { id: 2434, count: 2 }])).toBeNull();
    expect(f.withdrawals).toEqual(expect.arrayContaining([{ id: 143, count: 1 }, { id: 2434, count: 2 }]));
});

test('restock keeps explicit per-line slot limits instead of weakening them to a family sum', async () => {
    const f = supplyBank([{ id: 139, count: 1 }, { id: 141, count: 1 }, { id: 385, count: 20 }]);
    expect(await restock(f.s, 2, [{ id: 2434, count: 1, minDoses: 4, maxSlots: 1 }, { id: 2434, count: 1, minDoses: 1, maxSlots: 2 }])).toContain('lacks');
    expect(f.withdrawals).toEqual([]);
});

for (const danger of [false, true]) test(`hunt restocks after spending its escape charge even while food remains${danger ? ' after danger' : ''}`, async () => {
    const f = supplyBank([{ id: 1706, count: 1 }, { id: 385, count: 20 }]);
    f.inventory.push({ id: 1706, count: 1, slot: 0, name: 'Amulet of glory(1)', optionsWithIndex: [] },
        ...[1, 2].map(slot => ({ id: 385, count: 1, slot, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 0 }] })));
    let tick = 0, banked = 0, stopped = false, fights = 0;
    const player = { worldX: 3094, worldZ: 3540, combatLevel: 100, hp: 99, maxHp: 99 };
    const state = { player, inventory: f.inventory, skills: [{ name: 'Magic', level: 1 }], combatEvents: [], nearbyPlayers: [{ index: 3, name: 'Test stranger', combatLevel: 100, z: 3540, x: 3094, distance: 1 }] };
    f.s.tick = () => tick; f.s.ended = new Promise(() => {}); f.s.client = {};
    f.s.sdk.getState = () => state;
    f.s.bot.openBank = async () => { banked++; return { success: true }; };
    f.s.bot.closeBank = async () => { stopped = true; };
    f.s.bot.depositItem = async (item: any) => { const index = f.inventory.indexOf(item); if (index >= 0) f.inventory.splice(index, 1); };
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { player.worldX = path[0]!.x; player.worldZ = path[0]!.z; return { ok: true, ticks: 0, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { tick++; return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async () => { fights++; if (danger && fights % 2 === 1) return { outcome: 'danger' } as any; const glory = f.inventory.find(i => i.id === 1706); if (glory) glory.id = 1704; player.worldZ = 3496; return { outcome: 'escaped' } as any; }),
    ];
    try {
        const result = await hunt(f.s, { cap: 5, food: 2, minFood: 1, escapeAt: 35, stop: () => stopped, log: () => {}, kit: {}, trip: [{ id: 1712, count: 1, minCharges: 1, maxSlots: 1 }], spots: [{ x: 3094, z: 3540, dwell: 1 }] });
        expect(result.escapes).toBe(1);
        expect(banked).toBe(1);
        expect(f.withdrawals).toEqual(expect.arrayContaining([{ id: 1706, count: 1 }]));
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

function killLoot(native: { stackable: boolean } | undefined, eatWorks = true) {
    const inventory: any[] = [{ id: 995, count: 1, slot: 0, optionsWithIndex: [] }, ...Array.from({ length: 27 }, (_, n) => ({ id: 385, count: 1, slot: n + 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 0 }] }))];
    let eaten = 0, picked = 0;
    const pile = { id: native?.stackable === false ? 1712 : 995, count: 1, x: 3094, z: 3540, distance: 0, name: 'Loot' };
    const s: any = {
        client: { objType: () => native }, sdk: { getInventory: () => inventory, getState: () => ({ groundItems: picked ? [] : [pile] }) },
        bot: { eatFood: async () => { eaten++; if (eatWorks) inventory.pop(); }, pickupItem: async () => { picked++; const row = inventory.find(i => i.id === pile.id); if (row && native?.stackable) row.count++; else inventory.push({ id: pile.id, count: 1, slot: inventory.length }); return { success: true }; } },
    };
    return { s, inventory, eaten: () => eaten, picked: () => picked };
}

test('kill loot merges a native stack held at count one in a full pack without eating', async () => {
    const f = killLoot({ stackable: true });
    expect(await loot(f.s, { x: 3094, z: 3540 }, () => false)).toBe(1);
    expect(f.eaten()).toBe(0);
    expect(f.inventory.find(i => i.id === 995)?.count).toBe(2);
    expect(f.inventory.filter(i => i.id === 385)).toHaveLength(27);
});

test('kill loot with unknown native capacity does not eat or pick up', async () => {
    const f = killLoot(undefined);
    expect(await loot(f.s, { x: 3094, z: 3540 }, () => false)).toBe(0);
    expect(f.eaten()).toBe(0);
    expect(f.picked()).toBe(0);
});

test('kill loot does not pick up when eating leaves no observed space', async () => {
    const f = killLoot({ stackable: false }, false);
    expect(await loot(f.s, { x: 3094, z: 3540 }, () => false)).toBe(0);
    expect(f.picked()).toBe(0);
    expect(f.eaten()).toBe(1);
    expect(f.inventory.filter(i => i.id === 385)).toHaveLength(27);
});

test('kill loot proves one food debit and one exact pile credit after making room', async () => {
    const f = killLoot({ stackable: false });
    expect(await loot(f.s, { x: 3094, z: 3540 }, () => false)).toBe(1);
    expect(f.eaten()).toBe(1);
    expect(f.inventory.filter(i => i.id === 385)).toHaveLength(26);
    expect(f.inventory.filter(i => i.id === 1712)).toEqual([{ id: 1712, count: 1, slot: 27 }]);
});

test('HUNT_PRESETS and resolveHuntSpots cover rev 289 Wilderness hotspots and reject unknown presets', () => {
    expect(resolveHuntSpots({})).toBeUndefined();
    expect(resolveHuntSpots({ HUNT_SPOT: 'green-dragons' })).toEqual(HUNT_PRESETS['green-dragons']);
    expect(resolveHuntSpots({ HUNT_SPOT: 'mage-bank', PK_SPOTS: '[{"x":3095,"z":3550}]' })).toEqual([{ x: 3095, z: 3550 }]);
    expect(() => resolveHuntSpots({ HUNT_SPOT: 'revs' })).toThrow('unknown HUNT_SPOT');
    for (const [name, spots] of Object.entries(HUNT_PRESETS)) {
        expect(spots.length, name).toBeGreaterThanOrEqual(3);
        for (const sp of spots) expect(pk.wildernessLevel(sp.z), `${name} ${sp.x},${sp.z}`).toBeGreaterThan(0);
    }
});

test('planWildernessEscape, wildernessCombatMargin, and assessWildernessThreat handle glory/tele/deep exits and PJ/multi risk', () => {
    expect(planWildernessEscape({ x: 3094, z: 3750 }, { glory: true, teleport: true }).kind).toBe('glory');
    expect(planWildernessEscape({ x: 3094, z: 3670 }, { glory: false, teleport: true }).kind).toBe('teleport');
    // At Mage Bank (level 55) or Deserted Keep (level 51), cellar ladder / lever beat walking 200+ tiles south.
    const mageBank = planWildernessEscape({ x: 3096, z: 3956 }, { glory: true, teleport: true });
    expect(mageBank.kind).toBe('ladder');
    expect(mageBank.loc?.id).toBe(2871);
    expect(mageBank.web?.id).toBe(733);
    expect(planWildernessEscape({ x: 3150, z: 3925 }, { glory: true, teleport: false }).loc?.id).toBe(1815);
    // Walking south near Lava Maze surfaces the Lava Maze gate obstacle on path.
    const maze = planWildernessEscape({ x: 3070, z: 3870 }, { glory: true, teleport: false });
    expect(maze.kind).toBe('run');
    expect(maze.obstacle?.id).toBe(1596);
    expect(WILDERNESS_ESCAPES.length).toBeGreaterThanOrEqual(8);

    const margin = wildernessCombatMargin({ z: 3640, combat: 100 }, 110);
    expect(margin).toMatchObject({ wildernessLevel: 16, attackable: true, minCombat: 84, maxCombat: 116 });
    expect(pvpCombatBracket({ Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Ranged: 99, Magic: 99 }, 3640)).toMatchObject({
        combatLevel: 126, wildernessLevel: 16, gloryUsable: true, spellTeleportUsable: true,
    });

    // Multi pile threat vs single-way PJ waiter on low food
    const multiThreat = assessWildernessThreat(
        { x: 3240, z: 3630, combat: 100, foodCount: 10, glory: true, teleport: true },
        [{ name: 'Pker1', combatLevel: 100, distance: 4 }, { name: 'Pker2', combatLevel: 102, distance: 6 }],
        new Set(),
    );
    expect(multiThreat.multi).toBe(true);
    expect(multiThreat.retreatReason).toContain('multi pile');

    const pjThreat = assessWildernessThreat(
        { x: 3094, z: 3555, combat: 100, foodCount: 3, glory: true, teleport: true },
        [{ name: 'Fighting', combatLevel: 100, distance: 1, inCombat: true }, { name: 'Hopper', combatLevel: 103, distance: 5, inCombat: false }],
        new Set(),
    );
    expect(pjThreat.multi).toBe(false);
    expect(pjThreat.retreatReason).toContain('pj risk');
});

test('restockPlan and restockPlanFromStock restock glory(4), prayer potions, super pots, and antipoison alongside runes and sharks', () => {
    const M = RESTOCK_MARKET, L = RESTOCK_LIMITS;
    const rich = { law: 5, nature: 10, water: 20, magic: 80, coins: 20_000_000, food: 18, glory: false, prayerPots: 1, superPots: true, antipoison: true };
    // No superantipoison and no antipoison is for sale, so the plan has no step for it.
    expect(restockPlan(rich, M)).toEqual([
        { kind: 'ge', item: 1712, quantity: 1, limit: L[1712], owned: 0 },
        { kind: 'ge', item: 2434, quantity: 3, limit: L[2434], owned: 1 },
        { kind: 'ge', item: 2440, quantity: 1, limit: L[2440], owned: 0 },
        { kind: 'ge', item: 2436, quantity: 1, limit: L[2436], owned: 0 },
    ]);
    // The super antipoison comes first. The plain one is the fallback. Each is bought at its ask plus 10 percent.
    expect(restockPlan(rich, { ...M, 2448: { ask: 2500, sell: 40 }, 2446: { ask: 14_000, sell: 5 } }).at(-1)).toEqual({ kind: 'ge', item: 2448, quantity: 1, limit: 2750, owned: 0 });
    expect(restockPlan(rich, { ...M, 2446: { ask: 14_000, sell: 5 } }).at(-1)).toEqual({ kind: 'ge', item: 2446, quantity: 1, limit: 15_400, owned: 0 });
    // With the coins of a small bank the dear items drop out and the rest stays within the coins.
    const small = restockPlan({ ...rich, coins: 120_000 }, M);
    expect(small).toEqual([{ kind: 'ge', item: 2440, quantity: 1, limit: L[2440], owned: 0 }]);
    const spent = small.reduce((n, s) => n + (s.kind === 'ge' ? s.quantity * s.limit : 0), 0);
    expect(spent).toBeLessThanOrEqual(120_000 - 1000);
    const stock = [{ id: 563, count: 5 }, { id: 561, count: 10 }, { id: 555, count: 20 }, { id: 385, count: 20 }, { id: 139, count: 1 }];
    expect(restockPlanFromStock(stock, { magic: 85 }, 100_000, M)).toEqual([]);
    expect(restockPlanFromStock(stock, { magic: 85 }, 20_000_000, M).map(s => (s.kind === 'ge' ? s.item : 0))).toEqual([1712, 2434]);
});

test('wildernessDepth treats Mage Bank cellar as level 0, slashWebThrough retries 50%-fail webs, and hunt uses Varrock tele fallback', async () => {
    expect(wildernessDepth(2542, 4713)).toBe(0); // Mage Bank cellar is safe despite z >= 3520
    expect(wildernessDepth(3095, 3957)).toBe(55);
    expect(wildernessDepth(3100, 9928)).toBe(2);

    // Web 733 fails twice (web.rs2 50% fail) before clearing to 734 on the 3rd slash.
    let slashes = 0;
    let webPresent = true;
    const webLoc = { id: 733, x: 3095, z: 3957, option: 'Slash' };
    const fakeSess: any = {
        sdk: {
            getState: () => ({ nearbyLocs: webPresent ? [{ id: 733, x: 3095, z: 3957, distance: 1 }] : [{ id: 734, x: 3095, z: 3957, distance: 1 }] }),
            waitForTicks: async () => {},
        },
        bot: {
            interactLoc: async () => { slashes++; if (slashes >= 3) webPresent = false; },
        },
    };
    expect(await slashWebThrough(fakeSess, webLoc)).toBe(true);
    expect(slashes).toBe(3);

    // hunt starting inside Mage Bank cellar (2542, 4713) with Varrock tele runes and no PK_TELE casts Varrock Teleport automatically.
    let tick = 0;
    const clickedSpells: number[] = [];
    const player = { worldX: 2542, worldZ: 4713, combatLevel: 126, hp: 99, maxHp: 99 };
    const inv = [
        { id: pk.ITEMS.lawRune, name: 'Law rune', count: 2, slot: 0, optionsWithIndex: [] },
        { id: pk.ITEMS.airRune, name: 'Air rune', count: 6, slot: 1, optionsWithIndex: [] },
        { id: pk.ITEMS.fireRune, name: 'Fire rune', count: 2, slot: 2, optionsWithIndex: [] },
    ];
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { player.worldX = path[0]!.x; player.worldZ = path[0]!.z; return { ok: true, ticks: 1, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { tick++; return true; }),
    ];
    const huntSess: any = {
        tick: () => tick, ended: new Promise(() => {}), client: {},
        sdk: {
            getState: () => ({ player, inventory: inv, equipment: [], skills: [{ name: 'Magic', level: 50 }], combatEvents: [], nearbyPlayers: [], nearbyLocs: [] }),
            getInventory: () => inv, getEquipment: () => [], getBankItems: () => [],
            sendClickComponent: async (id: number) => { clickedSpells.push(id); player.worldX = 3213; player.worldZ = 3424; },
        },
        bot: { openBank: async () => ({ success: false }), closeBank: async () => {} },
    };
    try {
        const res = await hunt(huntSess, { cap: 20, food: 2, minFood: 1, escapeAt: 35, stop: () => false, log: () => {}, kit: {} });
        expect(clickedSpells).toEqual([pk.SPELLS.varrockTeleport]);
        expect(res.end).toBe('bank did not open');
    } finally { for (const m of mocks) m.mockRestore(); }
});
