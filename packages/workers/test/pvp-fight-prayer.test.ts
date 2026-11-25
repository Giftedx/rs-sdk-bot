import { expect, test } from 'bun:test';
import { startPrayerGuard } from '../../core/src/prayer-guard';
import { fightPlayer, PRAYER } from '../src/pvp/fight';

// One fighter against a dummy that does not die, on a model of the server rules that its prayers depend on:
// - a prayer button toggles its prayer (skill_prayer/scripts/prayers/*.rs2) and turns the others of its group off
//   (prayer.rs2 prayer_deactivate_conflicting);
// - the server reads 5 inputs of a player in a tick and keeps the rest for the next tick (engine NetworkPlayer.ts
//   decodeIn, ClientGameProtCategory.USER_EVENT);
// - `lag` holds each input that many ticks more before the server can read it, as a late network write does;
// - the button of a prayer in `refuse` changes nothing, as for a Prayer level under the prayer's level.
// `guard` starts the prayer guard of the session (packages/core/src/bot/open.ts starts one in every session).
// `dieAt`: the fighter dies that many ticks into the fight, skulled (head icon 1).
async function arena(o: { guard: boolean; lag?: number; ticks?: number; refuse?: number[]; dieAt?: number }) {
    const lag = o.lag ?? 0, ticks = o.ticks ?? 60;
    let tick = 10, dead = false;
    const active: boolean[] = new Array(15).fill(false);
    const inbox: { a: any; at: number }[] = [];
    const listeners = new Set<() => void>();
    const appearance = new Uint16Array(12);
    appearance[3] = 1231 + 512; // the dummy holds a dragon dagger: Protect from Melee is its overhead
    const client: any = {
        selfSlot: 7, var: { 300: 0, 301: 0, 172: 1 }, localPlayer: { headicons: 1 },
        players: [null, { headicons: 0, appearance, health: 99, totalHealth: 99 }],
        executeBotAction(a: any) { inbox.push({ a, at: tick }); return { success: true }; },
    };
    const state = (): any => ({
        tick,
        player: { worldX: 3094, worldZ: 3555, level: 0, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: dead ? 2 : 1, isDead: false, animId: -1, combat: { inCombat: false, targetType: 'none', targetIndex: -1 } },
        skills: ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'].map(name => ({ name, level: 99, baseLevel: 99 })),
        prayers: { prayerPoints: 99, prayerLevel: 99, activePrayers: [...active] },
        inventory: [{ slot: 0, id: 385, name: 'Shark', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }],
        equipment: [{ slot: 3, id: 1231, name: 'Dragon dagger(p)', count: 1, optionsWithIndex: [] }],
        nearbyPlayers: [{ index: 1, name: 'Dummy', combatLevel: 126, x: 3095, z: 3555, distance: 1 }],
        nearbyNpcs: [], combatEvents: [], gameMessages: [],
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false }, modalOpen: false,
    });
    let published = state();
    // The SDK calls go through the client, where the prayer guard watches every input of the script.
    const send = (a: any) => client.executeBotAction({ ...a, reason: 'SDK' });
    const session: any = {
        name: 'Fighter', client, tick: () => tick, ended: new Promise(() => {}),
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a),
        sdk: {
            getState: () => published,
            sendTogglePrayer: (prayerIndex: number) => send({ type: 'togglePrayer', prayerIndex }),
            sendInteractPlayer: (playerIndex: number, optionIndex: number) => send({ type: 'interactPlayer', playerIndex, optionIndex }),
            sendSpellOnPlayer: (playerIndex: number, spell: number) => send({ type: 'spellOnPlayer', playerIndex, spell }),
            sendUseItem: (slot: number, optionIndex: number) => send({ type: 'useInventoryItem', slot, optionIndex }),
            sendClickComponent: (componentId: number) => send({ type: 'clickComponent', componentId }),
            sendWalk: (x: number, z: number) => send({ type: 'walkTo', x, z }),
            sendSetCombatStyle: (style: number) => send({ type: 'setCombatStyle', style }),
        },
    };
    if (o.guard) startPrayerGuard(session, { protect: false });
    const logs: string[] = [];
    let done = false, itemOff = 0, counted = 0;
    const fight = fightPlayer(session, 'Dummy', { kit: { melee: [1231] }, rotation: ['melee'], prayerFlick: false, freeze: false, cap: ticks, log: l => logs.push(l) })
        .finally(() => { done = true; });
    const start = tick;
    while (!done) {
        // The server's tick: 5 inputs that it can read, in the order they came.
        let read = 0;
        for (let i = 0; i < inbox.length && read < 5;) {
            if (inbox[i]!.at + lag >= tick) { i++; continue; }
            const { a } = inbox.splice(i, 1)[0]!;
            read++;
            if (a.type !== 'togglePrayer' || o.refuse?.includes(a.prayerIndex)) continue;
            active[a.prayerIndex] = !active[a.prayerIndex];
            if (active[a.prayerIndex]) for (const group of [[0, 3, 9], [1, 4, 10], [2, 5, 11], [12, 13, 14]]) if (group.includes(a.prayerIndex)) for (const g of group) if (g !== a.prayerIndex) active[g] = false;
        }
        tick++;
        if (o.dieAt !== undefined && tick - start >= o.dieAt) dead = true;
        published = state();
        // After 4 ticks of set-up, each tick of the fight should hold Protect Item.
        if (tick - start > 4) { counted++; if (!active[PRAYER.item]) itemOff++; }
        for (const cb of [...listeners]) cb();
        await new Promise(r => setTimeout(r, 0));
    }
    return { res: await fight, itemOff, counted, logs };
}

test('with one sender and no late input, Protect Item stays on', async () => {
    const r = await arena({ guard: false });
    expect(r.counted).toBeGreaterThan(40);
    expect(r.itemOff).toBe(0);
});

test('the prayer guard of the session sends no prayer input during a fight, so Protect Item stays on', async () => {
    const r = await arena({ guard: true });
    expect(r.counted).toBeGreaterThan(40);
    expect(r.itemOff).toBe(0);
});

test('a prayer input that the server reads a tick late is not sent again, so Protect Item stays on', async () => {
    const r = await arena({ guard: false, lag: 1 });
    expect(r.counted).toBeGreaterThan(40);
    expect(r.itemOff).toBe(0);
});

test('the death line counts the kept items from the Protect Item varp, not from the choice of the loop', async () => {
    // The loop wants Protect Item, but its button changes nothing: a skulled death keeps 0 items.
    const off = await arena({ guard: false, refuse: [PRAYER.item], dieAt: 20 });
    expect(off.res.outcome).toBe('died');
    expect(off.logs.find(l => l.startsWith('PK died'))).toMatch(/ skull=1 keeps=0 /);
    const on = await arena({ guard: false, dieAt: 20 });
    expect(on.logs.find(l => l.startsWith('PK died'))).toMatch(/ skull=1 keeps=1 /);
});
