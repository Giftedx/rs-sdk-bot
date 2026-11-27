import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { npcTravel, type Travel } from '../src/travel';
import { walkRoute } from '../src/walk';

const records = JSON.parse(readFileSync('knowledge/npc-travel.json', 'utf8')).records as any[];
const shantay = npcTravel([records.find(r => r.id === 'shantay_guard_still:kharidian-desert-south-of-shantay-pass')])[0]!;

// The Shantay Guard moves the player from 3303,3118 to 3304,3115 (shantay_pass.rs2:105). The start tile is 3 tiles
// from the landing, so "within 8 tiles of the landing" is true before the player talks to the guard.
function fixture(t: Travel, end: { x: number; z: number } | null) {
    let tick = 0;
    const calls: any[] = [];
    const state: any = {
        player: { worldX: t.from!.x, worldZ: t.from!.z - 1, level: 0 },
        nearbyNpcs: [{ index: 7, name: 'Shantay Guard', distance: 1 }],
        nearbyLocs: [],
        dialog: { isOpen: false, isWaiting: false, options: [] },
    };
    const s: any = {
        sdk: { getState: () => state, getDialog: () => state.dialog, sendClickDialog: async () => ({ success: true }) },
        tick: () => tick,
        onTick: (cb: () => void) => { queueMicrotask(() => { tick++; cb(); }); return () => {}; },
        direct: async (a: any) => { calls.push(a); if (a.type === 'interactNpc' && end) Object.assign(state.player, { worldX: end.x, worldZ: end.z }); return { success: true }; },
        bot: { walkTo: async () => ({ success: true }) },
    };
    return { s, calls, run: () => walkRoute(s, [{ kind: 'travel', travel: t, at: t.from!, to: t.to }], { maxRetriesPerLeg: 1 }) };
}

test('the Shantay Guard edge is a short NPC passage', () => {
    expect(shantay.from).toMatchObject({ x: 3303, z: 3118, level: 0 });
    expect(shantay.to).toMatchObject({ x: 3304, z: 3115, level: 0 });
    expect(shantay.run).toMatchObject({ how: 'npc', npc: 'Shantay Guard' });
});

test('a short NPC passage arrives only on its landing', async () => {
    const through = fixture(shantay, { x: 3304, z: 3115 });
    expect(await through.run()).toMatchObject({ ok: true });
    expect(through.calls.filter(c => c.type === 'interactNpc')).toHaveLength(1);
    // The guard did not move the player: still north of the gate, 2 tiles from the landing.
    const stuck = fixture(shantay, null);
    expect(await stuck.run()).toMatchObject({ ok: false, reason: 'timeout' });
});
