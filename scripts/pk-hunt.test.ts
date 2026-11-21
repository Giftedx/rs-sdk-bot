import { expect, spyOn, test } from 'bun:test';
import { classify } from '../packages/practice/src/supervise-host';
import { supervise } from '../packages/practice/src/supervise';
import { DEFAULT_MAX_DEATHS, huntEnd, maxDeathsOf } from './pk-hunt';
import { kitToWear, BOW_TRIP, EDGEVILLE_BANK, rekitAfterDeath, RESPAWN_TICKS, FOOD_LIST, foodHeld, healOf, planFood, fleetNames, hitByPlayer, hunt, HUNT_PRESETS, loot, pickTarget, pickTrip, resolveHuntSpots, restock, SNARE_TRIP, TRIBRID_KIT, TRIP, tripRequirements, verdict } from './pk-hunt';
import { assessWildernessThreat, planWildernessEscape, restockPlan, restockPlanFromStock, slashWebThrough, WILDERNESS_ESCAPES, wildernessCombatMargin, wildernessDepth } from './pk-roam';
import { pvpCombatBracket } from './aio-pvp';
import * as pk from './pk';
import marketRows from './measure/pk-restock-market.json';
import type { RestockMarket } from './pk-roam';
// Rows of the market cache (.practice/market-all.json) for the items of the PK restock: the lowest ask and the units offered
// (scripts/measure/pk-restock-market.json). The prayer potion, the glory and the super potions are dear, the superantipoison and
// the antipoison have no seller, and the nature rune asks more than twice the hand limit that the plan once used. The limit of
// each item is the ask plus RESTOCK_MARGIN_PERCENT (10).
const RESTOCK_MARKET: RestockMarket = marketRows;
const RESTOCK_LIMITS = { 563: 770, 561: 698, 385: 974, 2434: 354_864, 1712: 4_675_000, 2440: 110_000, 2436: 110_000, 861: 104_500, 1113: 231_404 } as const;
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

test('a restock that the bank and the pack together cannot fill deposits nothing, and one they can fill deposits the pack', async () => {
    // Live: an account at the bank with 20 sharks and none in the bank asked for 21, deposited its pack, and then
    // ended `bank lacks trip requirements` with an empty pack.
    const session = (carried: number, banked: number) => {
        const inventory: any[] = Array.from({ length: carried }, (_, slot) => ({ id: 385, count: 1, slot })), bank: any[] = banked ? [{ id: 385, count: banked }] : [], deposits: number[] = [];
        const s: any = {
            sdk: { getInventory: () => inventory, getEquipment: () => [], getBankItems: () => bank, sendUseItem: async () => {} },
            bot: {
                openBank: async () => ({ success: true }), closeBank: async () => {},
                depositItem: async (item: any) => { deposits.push(item.slot); const at = inventory.indexOf(item); if (at >= 0) { inventory.splice(at, 1); const row = bank.find(b => b.id === item.id); if (row) row.count += item.count; else bank.push({ id: item.id, count: item.count }); } },
                withdrawItem: async (row: any, count: number) => { row.count -= count; for (let i = 0; i < count; i++) inventory.push({ id: row.id, count: 1, slot: inventory.length }); },
            },
        };
        return { s, inventory, deposits };
    };
    // At or over the food floor (half of the 21) the trip takes what the stock holds: one meal short is no fault.
    const oneShort = session(20, 0);
    expect(await restock(oneShort.s, 21, [])).toBeNull();
    expect([oneShort.deposits.length, oneShort.inventory.length]).toEqual([20, 20]);
    // Under the floor the trip is refused before the deposit, and the pack stays in the pack.
    const short = session(5, 0);
    expect(await restock(short.s, 21, [])).toContain('bank lacks trip requirements');
    expect([short.deposits, short.inventory.length]).toEqual([[], 5]);
    const enough = session(20, 1);
    expect(await restock(enough.s, 21, [])).toBeNull();
    expect([enough.deposits.length, enough.inventory.length]).toEqual([20, 21]);
});

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

// The food of a trip: sharks first (heal 20), then lobsters (heal 12), from the bank.
test('planFood takes sharks first and fills the rest with lobsters, and names a shortfall as sharks', () => {
    const have = (sharks: number, lobsters: number) => (id: number) => (id === 385 ? sharks : id === 379 ? lobsters : 0);
    expect(planFood(have(30, 99), 18)).toEqual([{ id: 385, count: 18 }]);
    expect(planFood(have(5, 99), 18)).toEqual([{ id: 385, count: 5 }, { id: 379, count: 13 }]);
    expect(planFood(have(0, 99), 18)).toEqual([{ id: 379, count: 18 }]);
    expect(planFood(have(2, 3), 18)).toEqual([{ id: 385, count: 15 }, { id: 379, count: 3 }]);
    expect(planFood(have(0, 0), 4)).toEqual([{ id: 385, count: 4 }]);
    expect(FOOD_LIST.map(f => [f.id, f.heal])).toEqual([[385, 20], [379, 12]]);
    expect(healOf(385)).toBe(20);
    expect(healOf(379)).toBe(12);
});

test('restock withdraws sharks first and lobsters for the rest, and counts both as food', async () => {
    const mixed = supplyBank([{ id: 385, count: 2 }, { id: 379, count: 20 }]);
    expect(await restock(mixed.s, 5, [])).toBeNull();
    expect([...mixed.withdrawals].sort((x, y) => x.id - y.id)).toEqual([{ id: 379, count: 3 }, { id: 385, count: 2 }]);
    const lobsters = supplyBank([{ id: 379, count: 20 }]);
    expect(await restock(lobsters.s, 6, [])).toBeNull();
    expect(lobsters.withdrawals).toEqual([{ id: 379, count: 6 }]);
    expect(foodHeld(lobsters.s)).toBe(6);
    const sharks = supplyBank([{ id: 385, count: 30 }, { id: 379, count: 20 }]);
    expect(await restock(sharks.s, 4, [])).toBeNull();
    expect(sharks.withdrawals).toEqual([{ id: 385, count: 4 }]);
});

test('restock with too little food in the bank fails and names the sharks that are lacking', async () => {
    // 4 meals for a pack of 10: under the food floor (5).
    const f = supplyBank([{ id: 385, count: 2 }, { id: 379, count: 2 }]);
    const err = await restock(f.s, 10, []);
    expect(err).toContain('lacks');
    expect(err).toContain('385');
    expect(f.withdrawals).toEqual([]);
    // 5 meals for a pack of 10: at the floor, the trip takes the 5.
    const g = supplyBank([{ id: 385, count: 2 }, { id: 379, count: 3 }]);
    expect(await restock(g.s, 10, [])).toBeNull();
    expect(g.withdrawals.reduce((n, w) => n + w.count, 0)).toBe(5);
});

// A world for the death path: the account dies, respawns at Lumbridge with 1 Hitpoints and nothing worn, and the bank holds the rest.
function deathWorld(bankRows: { id: number; count: number }[], o: { respawnAfter?: number; worn?: number[]; loseKit?: boolean; kept?: number[] } = {}) {
    const wornAtStart = o.worn ?? [1163, 1201, 1231];
    const inventory: any[] = [], equipment: any[] = [], bank = bankRows.map(r => ({ ...r }));
    let tick = 0, deadSince = 0, eaten = 0, slots = 0;
    const player: any = { worldX: 3094, worldZ: 3540, combatLevel: 100, hp: 0, maxHp: 99, isDead: true, lifeId: 1 };
    const state: any = { player, inventory, equipment, skills: [], combatEvents: [], nearbyPlayers: [] };
    const respawn = () => { Object.assign(player, { worldX: 3222, worldZ: 3218, hp: 1, isDead: false, lifeId: 2 }); if (o.loseKit) { equipment.length = 0; inventory.length = 0; } for (const id of o.kept ?? []) inventory.push({ id, count: 1, slot: ++slots, name: 'Piece', optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }); };
    const s: any = {
        tick: () => tick, ended: new Promise(() => {}), client: {},
        sdk: {
            getState: () => state, getInventory: () => inventory, getEquipment: () => equipment, getBankItems: () => bank,
            sendUseItem: async (slot: number, op: number) => {
                const idx = inventory.findIndex(i => i.slot === slot);
                if (idx < 0) return;
                const item = inventory[idx]!;
                if (op === 1) { eaten++; player.hp = Math.min(player.maxHp, player.hp + 20); item.count--; if (item.count <= 0) inventory.splice(idx, 1); }
                else { inventory.splice(idx, 1); equipment.push(item); }
            },
        },
        bot: {
            openBank: async () => ({ success: true }), closeBank: async () => {}, depositItem: async () => {},
            withdrawItem: async (row: any, count: number) => {
                row.count -= count;
                const food = row.id === 385, held = inventory.find(i => i.id === row.id && food);
                if (held) held.count += count;
                else inventory.push({ id: row.id, count, slot: ++slots, name: food ? 'Shark' : 'Piece', optionsWithIndex: food ? [{ text: 'Eat', opIndex: 1 }] : [{ text: 'Wear', opIndex: 2 }] });
            },
        },
    };
    // The next tick: the account is dead for `respawnAfter` ticks (default 3) and then stands at the respawn point.
    const next = async () => { tick++; if (player.isDead && ++deadSince > (o.respawnAfter ?? 3)) respawn(); return true; };
    return { s, state, player, inventory, equipment, bank, wornAtStart: wornAtStart.map(id => ({ id, count: 1 })), next, eaten: () => eaten, tick: () => tick };
}

async function withDeathMocks<T>(w: ReturnType<typeof deathWorld>, run: () => Promise<T>): Promise<T> {
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(w.next),
    ];
    try { return await run(); } finally { for (const mock of mocks) mock.mockRestore(); }
}

test('rekitAfterDeath waits for the new life, walks to the bank, wears the starting pieces and eats up from 1 Hitpoints', async () => {
    const w = deathWorld([{ id: 385, count: 20 }, { id: 1163, count: 1 }, { id: 1201, count: 1 }, { id: 1231, count: 1 }]);
    const lines: string[] = [];
    const record = await withDeathMocks(w, () => rekitAfterDeath(w.s, { lifeBefore: 1, diedNear: { x: 3094, z: 3541 }, wornAtStart: w.wornAtStart, stop: () => false, log: l => lines.push(l) }));
    expect(record).toMatchObject({ rekit: 'ok', missing: [], hpAtRespawn: 1, lifeBefore: 1, lifeAfter: 2, respawnAt: { x: 3222, z: 3218 }, diedNear: { x: 3094, z: 3541 }, packAtRespawn: [] });
    expect(w.equipment.map(e => e.id).sort()).toEqual([1163, 1201, 1231]);
    // 1 Hitpoints need 5 sharks to reach 99, and the eating stops within 10 of full: 5 sharks eaten, 1 left over.
    expect(w.player.hp).toBeGreaterThanOrEqual(89);
    expect(w.eaten()).toBe(5);
    expect(w.inventory.find(i => i.id === 385)?.count).toBe(1);
    expect(w.player.worldX).toBe(EDGEVILLE_BANK.x);
    expect(lines.some(l => l.startsWith('HUNT death {') && l.includes('"rekit":"ok"'))).toBe(true);
});

test('rekitAfterDeath wears the pieces that the death kept in the pack, and the ones from the bank', async () => {
    // An unskulled account keeps its 3 priciest items: 1201 respawns in the pack and the bank holds the other two.
    const w = deathWorld([{ id: 385, count: 20 }, { id: 1163, count: 1 }, { id: 1231, count: 1 }], { kept: [1201] });
    const record = await withDeathMocks(w, () => rekitAfterDeath(w.s, { lifeBefore: 1, diedNear: null, wornAtStart: w.wornAtStart, stop: () => false, log: () => {} }));
    expect(record).toMatchObject({ rekit: 'ok', missing: [] });
    expect(w.equipment.map(e => e.id).sort()).toEqual([1163, 1201, 1231]);
    expect(w.inventory.some(i => [1163, 1201, 1231].includes(i.id))).toBe(false);
});

test('kitToWear lists the pieces of the starting kit that the pack holds, once each', () => {
    const kit = [{ id: 1163, count: 1 }, { id: 1201, count: 1 }, { id: 884, count: 100 }, { id: 1163, count: 1 }];
    expect(kitToWear(kit, [{ id: 1201 }, { id: 385 }, { id: 884 }])).toEqual([1201, 884]);
    expect(kitToWear(kit, [])).toEqual([]);
});

test('rekitAfterDeath names the pieces that the bank lacks, and ends with no food in the bank or no respawn', async () => {
    const lacks = deathWorld([{ id: 385, count: 20 }, { id: 1201, count: 1 }, { id: 1231, count: 1 }]);
    const a = await withDeathMocks(lacks, () => rekitAfterDeath(lacks.s, { lifeBefore: 1, diedNear: null, wornAtStart: lacks.wornAtStart, stop: () => false, log: () => {} }));
    expect(a).toMatchObject({ rekit: 'kit lacks 1163', missing: [1163] });
    expect(lacks.equipment.map(e => e.id).sort()).toEqual([1201, 1231]);
    const hungry = deathWorld([{ id: 1231, count: 1 }]);
    const b = await withDeathMocks(hungry, () => rekitAfterDeath(hungry.s, { lifeBefore: 1, diedNear: null, wornAtStart: hungry.wornAtStart, stop: () => false, log: () => {} }));
    expect(b.rekit).toBe('no food in the bank');
    const never = deathWorld([{ id: 385, count: 20 }], { respawnAfter: 1000 });
    const c = await withDeathMocks(never, () => rekitAfterDeath(never.s, { lifeBefore: 1, diedNear: null, wornAtStart: never.wornAtStart, stop: () => false, log: () => {} }));
    expect(c).toMatchObject({ rekit: 'no respawn', respawnAt: null });
    expect(c.ticks).toBeGreaterThanOrEqual(RESPAWN_TICKS);
    // The death limit only records the death.
    const limit = deathWorld([{ id: 385, count: 20 }]);
    const d = await withDeathMocks(limit, () => rekitAfterDeath(limit.s, { lifeBefore: 1, diedNear: null, wornAtStart: limit.wornAtStart, stop: () => false, log: () => {}, recordOnly: true }));
    expect(d).toMatchObject({ rekit: 'death limit', hpAtRespawn: 1 });
    expect(limit.player.worldX).toBe(3222);
});

for (const maxDeaths of [2, 0]) test(`hunt after a death to a player ${maxDeaths ? 're-kits and goes on' : 'ends with the record at the death limit'}`, async () => {
    const w = deathWorld([{ id: 385, count: 40 }, { id: 1163, count: 1 }, { id: 1201, count: 1 }, { id: 1231, count: 1 }]);
    w.player.hp = 99; w.player.isDead = false;
    w.equipment.push(...[1163, 1201, 1231].map(id => ({ id, count: 1, slot: 0, name: 'Piece', optionsWithIndex: [] })));
    w.state.nearbyPlayers.push({ index: 3, name: 'Test stranger', combatLevel: 100, z: 3540, x: 3094, distance: 1 });
    let fights = 0;
    const lines: string[] = [];
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(w.next),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        // The first fight: the account dies. Its pack and worn items are gone (the killer has them), the new life starts at Lumbridge.
        spyOn(pk, 'fightPlayer').mockImplementation(async () => {
            fights++;
            w.state.nearbyPlayers.length = 0;
            if (fights === 1) { w.equipment.length = 0; w.inventory.length = 0; w.player.hp = 0; w.player.isDead = true; return { outcome: 'died', ticks: 30, targetAt: { x: 3095, z: 3541 } } as any; }
            return { outcome: 'lost', ticks: 1 } as any;
        }),
    ];
    try {
        const result: any = await hunt(w.s, { cap: 400, food: 2, minFood: 1, escapeAt: 35, stop: () => false, log: l => lines.push(l), kit: {}, trip: [{ id: 385, count: 1 }], spots: [{ x: 3094, z: 3540, dwell: 3 }], maxDeaths });
        expect(result.deaths).toBe(1);
        if (maxDeaths) {
            expect(result.rekits).toBe(1);
            expect(result.end).toBe('cap');
            expect(result.death).toBeUndefined();
            expect(w.equipment.map(e => e.id).sort()).toEqual([1163, 1201, 1231]);
            expect(w.player.hp).toBeGreaterThanOrEqual(89);
            expect(lines.filter(l => l.startsWith('HUNT death {'))).toHaveLength(1);
        } else {
            expect(result.rekits).toBe(0);
            expect(result.end).toBe('died');
            expect(result.death).toMatchObject({ rekit: 'death limit', hpAtRespawn: 1, diedNear: { x: 3095, z: 3541 }, lifeBefore: 1, lifeAfter: 2 });
        }
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('maxDeathsOf takes a whole number of 0 or more and falls back to the default for anything else', () => {
    expect(maxDeathsOf('0')).toBe(0);
    expect(maxDeathsOf('5')).toBe(5);
    for (const bad of [undefined, '', ' ', 'abc', '-1', '1.5', 'NaN', 'Infinity']) expect(maxDeathsOf(bad)).toBe(DEFAULT_MAX_DEATHS);
    expect(DEFAULT_MAX_DEATHS).toBe(1);
});

test('a hunt that ends in a death ends with RESULT fail died, which the supervisor reads as a death', async () => {
    const record = { diedNear: null, respawnAt: { x: 3222, z: 3218 }, hpAtRespawn: 1, lifeBefore: 1, lifeAfter: 2, packAtRespawn: [], ticks: 20, rekit: 'kit lacks 1163', missing: [1163] };
    const dead = huntEnd({ end: 'died: kit lacks 1163', kills: 1, deaths: 1, rekits: 0, death: record });
    expect(dead.ok).toBe(false);
    const line = `RESULT fail ${dead.detail}`;
    expect(line.startsWith('RESULT fail died hunt died: kit lacks 1163 kills 1 deaths 1 rekits 0 death={')).toBe(true);
    expect(classify(line, false)).toBe('died');
    const out = await supervise({ run: async () => ({ stdout: `${line}\n`, exitCode: 1 }), stopped: () => false, pause: async () => {}, maxRestarts: 5 } as any);
    expect(out).toEqual({ reason: 'died', runs: 1 });
    // The limit end and the other ends.
    expect(classify(`RESULT fail ${huntEnd({ end: 'died', kills: 0, deaths: 3, rekits: 2, death: { ...record, rekit: 'death limit' } }).detail}`, false)).toBe('died');
    expect(huntEnd({ end: 'cap', kills: 2, deaths: 1, rekits: 1 })).toEqual({ ok: true, detail: 'hunt cap kills 2 deaths 1 rekits 1' });
    expect(huntEnd({ end: 'bank lacks trip requirements []', kills: 0, deaths: 0, rekits: 0 }).ok).toBe(false);
});

test('a hunt whose kit lost a piece that the bank lacks ends as died: kit lacks, which the supervisor reads as a death', async () => {
    const w = deathWorld([{ id: 385, count: 40 }, { id: 1201, count: 1 }, { id: 1231, count: 1 }], { loseKit: true });
    w.equipment.push(...[1163, 1201, 1231].map(id => ({ id, count: 1, slot: 0, name: 'Piece', optionsWithIndex: [] })));
    Object.assign(w.player, { worldX: 3222, worldZ: 3218, hp: 0, isDead: true, lifeId: 1 });
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(w.next), spyOn(pk, 'observePlayer').mockReturnValue(null),
    ];
    try {
        const result: any = await hunt(w.s, { cap: 300, food: 2, minFood: 1, escapeAt: 35, stop: () => false, log: () => {}, kit: {}, trip: [{ id: 385, count: 1 }], spots: [{ x: 3094, z: 3540, dwell: 3 }] });
        expect(result.end).toBe('died: kit lacks 1163');
        expect(result.death).toMatchObject({ rekit: 'kit lacks 1163', missing: [1163] });
        const end = huntEnd(result);
        expect(end.ok).toBe(false);
        expect(classify(`RESULT fail ${end.detail}`, false)).toBe('died');
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

// A death on the walk to the bank, and on the last tick, is read as a death and not as a failed walk, a stop or the cap.
async function huntWithDeath(when: 'bank-walk' | 'last-tick') {
    const w = deathWorld([{ id: 385, count: 40 }, { id: 1163, count: 1 }]);
    w.player.hp = 99; w.player.isDead = false; w.player.worldX = 3094; w.player.worldZ = 3540;
    let stopped = false, walks = 0;
    // The account dies and respawns within the walk or the tick: a new life at Lumbridge with 1 Hitpoints and nothing worn.
    const kill = () => { Object.assign(w.player, { worldX: 3222, worldZ: 3218, hp: 1, isDead: false, lifeId: 2 }); w.equipment.length = 0; w.inventory.length = 0; };
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => {
            walks++;
            if (when === 'bank-walk' && walks === 1) { kill(); return { ok: false, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 0, detail: 'died on the way' } as any; }
            w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 };
        }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { const r = await w.next(); if (when === 'last-tick' && w.tick() === 10) { kill(); stopped = true; } return r; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
    ];
    try {
        const lines: string[] = [];
        // No food held, so the first pass walks to the bank to restock.
        const result: any = await hunt(w.s, { cap: 400, food: 2, minFood: 1, escapeAt: 35, stop: () => stopped, log: l => lines.push(l), kit: {}, trip: [{ id: 385, count: 1 }], spots: [{ x: 3094, z: 3540, dwell: 3 }], maxDeaths: 0 });
        return { result, lines };
    } finally { for (const mock of mocks) mock.mockRestore(); }
}

test('a death on the walk to the bank ends the run as died (over the limit), not as a failed walk', async () => {
    const { result } = await huntWithDeath('bank-walk');
    expect(result.deaths).toBe(1);
    expect(result.end).toBe('died');
    expect(result.death).toMatchObject({ rekit: 'death limit' });
    expect(classify(`RESULT fail ${huntEnd(result).detail}`, false)).toBe('died');
});

test('a death on the tick that a stop or the cap ends the run is read as a death, not as stopped or cap', async () => {
    const { result } = await huntWithDeath('last-tick');
    expect(result.deaths).toBe(1);
    // The stop is set, so the respawn wait does not run: the end is a death with no respawn, not 'stopped'.
    expect(result.end).toBe('died: no respawn');
    expect(classify(`RESULT fail ${huntEnd(result).detail}`, false)).toBe('died');
});

test('hunt goes on after a re-kit that worked in its first retreat, and does not end the run as died', async () => {
    const w = deathWorld([{ id: 385, count: 40 }, { id: 1163, count: 1 }, { id: 1201, count: 1 }, { id: 1231, count: 1 }]);
    // The account starts dead and far from Edgeville: the first retreat sees the death.
    Object.assign(w.player, { worldX: 3222, worldZ: 3218, hp: 0, isDead: true, lifeId: 1 });
    const lines: string[] = [];
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(w.next),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async () => ({ outcome: 'lost', ticks: 1 }) as any),
    ];
    try {
        const deaths: unknown[] = [];
        const result: any = await hunt(w.s, { cap: 300, food: 2, minFood: 1, escapeAt: 35, stop: () => false, log: l => lines.push(l), kit: {}, trip: [{ id: 385, count: 1 }], spots: [{ x: 3094, z: 3540, dwell: 3 }], onDeath: near => deaths.push(near) });
        expect(result.deaths).toBe(1);
        expect(result.rekits).toBe(1);
        expect(deaths).toHaveLength(1);
        expect(result.end).toBe('cap');
        expect(lines.filter(l => l.startsWith('HUNT death {') && l.includes('"rekit":"ok"'))).toHaveLength(1);
        expect(w.player.hp).toBeGreaterThanOrEqual(89);
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

// The threat radar in the hunt: a retreat that the radar decides is logged as the hunt's own threat retreat, and ends the dwell for a restock.
test('a radar retreat in the hunt logs the hunt threat retreat with the radar reason', async () => {
    const w = deathWorld([{ id: 385, count: 40 }, { id: 1163, count: 1 }]);
    Object.assign(w.player, { hp: 99, isDead: false, worldX: 3094, worldZ: 3540 });
    for (let i = 0; i < 2; i++) w.inventory.push({ id: 385, count: 1, slot: i + 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
    const reason = 'outclassed by Boss(145,magic) at 3 tiles';
    const threats: any = { act: true, acted: () => {}, step: () => ({ classes: [], interlopers: [], actions: [{ kind: 'retreat', reason }] }) };
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 5, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any; }),
        spyOn(pk, 'nextTick').mockImplementation(w.next), spyOn(pk, 'observePlayer').mockReturnValue(null),
    ];
    try {
        const lines: string[] = [];
        await hunt(w.s, { cap: 60, food: 2, minFood: 1, escapeAt: 35, stop: () => w.tick() >= 40, log: l => lines.push(l), kit: {}, trip: [{ id: 385, count: 1 }], spots: [{ x: 3094, z: 3540, dwell: 3 }], threats });
        expect(lines.some(l => l.startsWith(`HUNT threat retreat (${reason}, bracket=`))).toBe(true);
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('shortageText names each item with what the trip needs and what the bank holds', async () => {
    const { shortageText } = await import('./pk-hunt');
    const names = new Map([[884, 'iron_arrow'], [563, 'law_rune']]);
    expect(shortageText([{ id: 884, unit: 'items', required: 75, available: 33 }, { id: 563, required: 1, available: 0 }, { id: 2446, unit: 'doses', required: 4, available: 3 }], id => names.get(id)))
        .toBe('iron arrow: 75 items needed, 33 in the bank; law rune: 1 items needed, 0 in the bank; item 2446: 4 doses needed, 3 in the bank');
    expect(shortageText([], () => undefined)).toBe('');
});

test('tripRequirements and restock allow worn arrows at or over minCount when bank has 0 spare, top up available arrows, and block under floor', async () => {
    // Live Trip 2 failure case: 298 worn rune arrows (target 300, floor 100) and 0 spare arrows in bank.
    const noSpare = supplyBank([{ id: 385, count: 20 }], [{ id: 892, count: 298, slot: 13 }]);
    expect(await restock(noSpare.s, 2, [{ id: 892, count: 300, minCount: 100 }], {})).toBeNull();
    expect(noSpare.withdrawals.filter(r => r.id === 892)).toEqual([]);

    // Bank holds 1 spare arrow (less than full 2 deficit): top up with that 1 instead of aborting.
    const oneSpare = supplyBank([{ id: 385, count: 20 }, { id: 892, count: 1 }], [{ id: 892, count: 298, slot: 13 }]);
    expect(await restock(oneSpare.s, 2, [{ id: 892, count: 300, minCount: 100 }], {})).toBeNull();
    expect(oneSpare.withdrawals.filter(r => r.id === 892)).toEqual([{ id: 892, count: 1 }]);

    // Bank holds plenty: top up back to the starting 300.
    const fullSpare = supplyBank([{ id: 385, count: 20 }, { id: 892, count: 500 }], [{ id: 892, count: 298, slot: 13 }]);
    expect(await restock(fullSpare.s, 2, [{ id: 892, count: 300, minCount: 100 }], {})).toBeNull();
    expect(fullSpare.withdrawals.filter(r => r.id === 892)).toEqual([{ id: 892, count: 2 }]);

    // Under the arrow floor (80 worn + 15 bank = 95 < 100): restock blocks; 80 worn + 25 bank = 105 >= 100 tops up all 25.
    const shortFloor = supplyBank([{ id: 385, count: 20 }, { id: 892, count: 15 }], [{ id: 892, count: 80, slot: 13 }]);
    expect(await restock(shortFloor.s, 2, [{ id: 892, count: 300, minCount: 100 }], {})).toContain('lacks');
    expect(shortFloor.withdrawals).toEqual([]);

    const passFloor = supplyBank([{ id: 385, count: 20 }, { id: 892, count: 25 }], [{ id: 892, count: 80, slot: 13 }]);
    expect(await restock(passFloor.s, 2, [{ id: 892, count: 300, minCount: 100 }], {})).toBeNull();
    expect(passFloor.withdrawals.filter(r => r.id === 892)).toEqual([{ id: 892, count: 25 }]);

    // Invalid minCount combinations fail cleanly before touching bank.
    expect(tripRequirements([{ id: 892, count: 300, minCount: -1 }])).toEqual([{ id: -1, count: Number.NaN }]);
    expect(tripRequirements([{ id: 2434, count: 1, minCount: 1 }])).toEqual([{ id: 2434, count: Number.NaN }]);

    // Rubbed glory and stripped legs sitting in inventory when returning to bank are re-equipped before deposit.
    const invGlory: any[] = [
        { slot: 0, id: 1710, name: 'Amulet of glory(3)', count: 1, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
        { slot: 1, id: 1079, name: 'Rune platelegs', count: 1, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] },
    ];
    const eqGlory: any[] = [{ slot: 13, id: 892, count: 298 }];
    const bankGlory: any[] = [{ id: 385, count: 20 }];
    const sGlory: any = {
        sdk: {
            getInventory: () => invGlory,
            getEquipment: () => eqGlory,
            getBankItems: () => bankGlory,
            sendUseItem: async (slot: number) => {
                const idx = invGlory.findIndex(i => i.slot === slot);
                if (idx >= 0) eqGlory.push(invGlory.splice(idx, 1)[0]);
            },
        },
        bot: {
            openBank: async () => ({ success: true }),
            closeBank: async () => {},
            depositItem: async (item: any) => {
                const idx = invGlory.findIndex(i => i.id === item.id);
                if (idx >= 0) invGlory.splice(idx, 1);
            },
            withdrawItem: async (row: any, need: number) => {
                row.count -= need;
                invGlory.push({ slot: invGlory.length, id: row.id, count: need });
            },
        },
    };
    expect(await restock(sGlory, 2, [{ id: 892, count: 300, minCount: 100 }], TRIBRID_KIT)).toBeNull();
    expect(eqGlory.map(e => e.id).sort((a, b) => a - b)).toEqual([892, 1079, 1710]);
});
