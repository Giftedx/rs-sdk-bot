import {expect, test} from 'bun:test';
import {fightPlayer, ITEMS} from './pk';

async function escape(full: boolean, food: boolean, flee = true) {
    let tick = 10;
    const actions: string[] = [];
    const inventory = Array.from({length: full ? 28 : 27}, (_, slot) => ({
        slot, id: food && slot === 0 ? ITEMS.shark : 995, count: 1,
        name: food && slot === 0 ? 'Shark' : 'Coins',
        optionsWithIndex: food && slot === 0 ? [{text: 'Eat', opIndex: 1}] : [],
    }));
    const state: any = {
        player: {worldX: 3094, worldZ: 3700, combatLevel: 126, hp: 99, maxHp: 99, lifeId: 1},
        skills: [{name: 'Magic', level: 1}, {name: 'Prayer', baseLevel: 1}],
        prayers: {prayerPoints: 0, activePrayers: []},
        inventory, equipment: [{id: ITEMS.glory[0], slot: 2}],
        nearbyPlayers: [{index: 1, name: 'Dummy', x: 3096, z: 3700, combatLevel: 126, distance: 2}],
        combatEvents: [], gameMessages: [], dialog: {isOpen: false},
    };
    const session: any = {
        tick: () => tick, ended: new Promise(() => {}),
        onTick: (cb: () => void) => {queueMicrotask(() => {tick++; cb();}); return () => {};},
        sdk: {
            getState: () => state,
            sendUseItem: (slot: number, op: number) => {
                const item = state.inventory.find((i: any) => i.slot === slot);
                if (item?.id === ITEMS.shark) {actions.push('eat'); state.inventory = state.inventory.filter((i: any) => i.slot !== slot);}
                else if (op === 4) {actions.push('rub'); state.dialog.isOpen = true;}
            },
            sendUseEquipmentItem: () => {
                actions.push('remove');
                expect(state.inventory.length).toBeLessThan(28);
                const slot = Array.from({length: 28}, (_, n) => n).find(n => !state.inventory.some((i: any) => i.slot === n));
                state.inventory.push({id: ITEMS.glory[0], slot, name: 'Amulet of glory(4)', count: 1, optionsWithIndex: [{text: 'Rub', opIndex: 4}]});
                state.equipment = [];
            },
            clickDialogByText: () => {actions.push('teleport'); state.player.worldZ = 3495; state.dialog.isOpen = false;},
            sendWalk: () => {actions.push('walk');},
        },
    };
    const result = await fightPlayer(session, 'Dummy', {kit: {}, flee, cap: 8, log: () => {}});
    return {result, actions};
}

test('a full-health escape eats one food to remove and rub its worn glory', async () => {
    const {result, actions} = await escape(true, true);
    expect(result.outcome).toBe('escaped');
    expect(result.eaten).toBe(1);
    expect(actions).toEqual(['eat', 'remove', 'rub', 'teleport']);
});

test('an escape with room removes its worn glory without eating', async () => {
    const {result, actions} = await escape(false, true);
    expect(result.outcome).toBe('escaped');
    expect(result.eaten).toBe(0);
    expect(actions).toEqual(['remove', 'rub', 'teleport']);
});

test('a full pack without food uses the walking fallback', async () => {
    const {result, actions} = await escape(true, false);
    expect(result.outcome).toBe('timeout');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(a => a === 'walk')).toBe(true);
});

test('a full pack at full health keeps its food when no escape is requested', async () => {
    const {result, actions} = await escape(true, true, false);
    expect(result.eaten).toBe(0);
    expect(actions).toEqual([]);
});
