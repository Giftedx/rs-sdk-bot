import { expect, test } from 'bun:test';
import { startPrayerGuard } from '../../core/src/prayer-guard';
import { PRAYER } from '../src/pvp/fight';
import { createWildSurvival } from '../src/pvp/squad';

// A squad member in Wilderness between two fights: the survival helper of the squad (squad.ts createWildSurvival)
// keeps Protect from Melee and Protect Item on, and the session's prayer guard flicks the prayers that are on. The
// server model is the one of pvp-fight-prayer.test.ts: a prayer button toggles its prayer and turns the others of its
// group off, the server reads 5 inputs a tick, and `lag` holds each input that many ticks more.
// `start`: the prayers on at the start (a fight can leave its Defence prayer on).
// `hold`: the squad's hold loop with no target, which also wants Protect from Melee on, each 3 ticks of its own.
async function between(o: { start: number[]; lag?: number; ticks?: number; hold?: boolean }) {
    const lag = o.lag ?? 0, ticks = o.ticks ?? 60;
    let tick = 10;
    const active: boolean[] = new Array(15).fill(false);
    for (const p of o.start) active[p] = true;
    const inbox: { a: any; at: number }[] = [];
    const listeners = new Set<() => void>();
    const client: any = {
        selfSlot: 7, var: {}, localPlayer: { headicons: 1 }, players: [],
        executeBotAction(a: any) { inbox.push({ a, at: tick }); return { success: true }; },
    };
    const skills = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer'].map(name => ({ name, level: 99, baseLevel: 99 }));
    const state = (): any => ({
        tick,
        player: { worldX: 3094, worldZ: 3555, level: 0, combatLevel: 126, hp: 99, maxHp: 99, runEnergy: 100, lifeId: 1, isDead: false, animId: -1, combat: { inCombat: false, targetType: 'none', targetIndex: -1 } },
        skills,
        prayers: { prayerPoints: 99, prayerLevel: 99, activePrayers: [...active] },
        inventory: [], equipment: [], nearbyPlayers: [], nearbyNpcs: [], combatEvents: [], gameMessages: [],
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false }, modalOpen: false,
    });
    let published = state();
    const send = (a: any) => client.executeBotAction({ ...a, reason: 'SDK' });
    const session: any = {
        name: 'Member', client, tick: () => tick, ended: new Promise(() => {}),
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a),
        sdk: {
            getState: () => published,
            getSkill: (name: string) => skills.find(k => k.name === name),
            getInventory: () => [],
            sendTogglePrayer: (prayerIndex: number) => send({ type: 'togglePrayer', prayerIndex }),
            sendUseItem: (slot: number, optionIndex: number) => send({ type: 'useInventoryItem', slot, optionIndex }),
        },
    };
    const guard = startPrayerGuard(session, { protect: false });
    // A prayer input of the script before this part (the fight loop's): the guard chooses no prayer of its own.
    guard.note({ type: 'togglePrayer', prayerIndex: PRAYER.melee });
    const survival = createWildSurvival(session, { protect: () => 'melee', protectItem: () => true, eatBelow: 0 });
    let off = 0, counted = 0, holdAt = -10;
    for (let t = 0; t < ticks; t++) {
        let read = 0;
        for (let i = 0; i < inbox.length && read < 5;) {
            if (inbox[i]!.at + lag >= tick) { i++; continue; }
            const { a } = inbox.splice(i, 1)[0]!;
            read++;
            if (a.type !== 'togglePrayer') continue;
            active[a.prayerIndex] = !active[a.prayerIndex];
            if (active[a.prayerIndex]) for (const group of [[0, 3, 9], [1, 4, 10], [2, 5, 11], [12, 13, 14]]) if (group.includes(a.prayerIndex)) for (const g of group) if (g !== a.prayerIndex) active[g] = false;
        }
        tick++;
        published = state();
        if (t > 4) { counted++; if (!active[PRAYER.item] || !active[PRAYER.melee]) off++; }
        // The guard's listener first (openBot starts it at login), then the squad's loop.
        for (const cb of [...listeners]) cb();
        survival.step(tick);
        if (o.hold && tick - holdAt >= 3) { survival.protectNow('melee', tick); holdAt = tick; }
        await new Promise(r => setTimeout(r, 0));
    }
    return { off, counted, stats: guard.stats() };
}

// The helper and the hold loop run in the same tick and read the same prayers. If each sent a toggle for the prayer
// that is off, the second toggle would turn it off again, each 3 ticks. So they share one protect input (protectNow).
test('the survival helper and the hold loop send one protect prayer input between them', async () => {
    for (const lag of [0, 1]) {
        const r = await between({ start: [PRAYER.item], lag, hold: true });
        expect(r.counted).toBeGreaterThan(40);
        expect(r.off).toBe(0);
    }
});

for (const start of [[PRAYER.item, PRAYER.melee], [PRAYER.item, PRAYER.steelSkin, PRAYER.melee]]) {
    for (const lag of [0, 1]) {
        test(`survival helper beside the prayer guard, ${start.length} prayers on, input lag ${lag}`, async () => {
            const r = await between({ start, lag });
            console.log(`between start=${start.join('+')} lag=${lag}: off ${r.off} of ${r.counted}, guard ${JSON.stringify({ flicks: r.stats.flicks, repairs: r.stats.repairs, yielded: r.stats.yielded })}`);
            expect(r.counted).toBeGreaterThan(40);
            expect(r.off).toBe(0);
        });
    }
}
