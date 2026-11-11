import { expect, test } from 'bun:test';
import { BOW_TRIP, fleetNames, hitByPlayer, pickTarget, pickTrip, restock, SNARE_TRIP, TRIBRID_KIT, TRIP, verdict } from './pk-hunt';

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
