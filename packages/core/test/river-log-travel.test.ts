import { expect, test } from 'bun:test';
import { RIVER_LOG_TRAVEL, type Travel } from '../src/travel';
import { walkRoute } from '../src/walk';

const west = RIVER_LOG_TRAVEL.find(t => t.to.x === 2906)!, east = RIVER_LOG_TRAVEL.find(t => t.to.x === 2910)!;

// The river log (zq_logbalance 2332, skill_agility/scripts/shortcuts.rs2:49-95): from x < 2909 the player moves 2 + 2
// tiles east, from x >= 2909 2 + 2 tiles west; a failed roll ends on $fail_end_coord, on the far bank.
test('the river log edges start beside the log and land 4 tiles across, or on the far bank after a slip', () => {
    expect(west).toMatchObject({ from: { x: 2910, z: 3049, level: 0 }, to: { x: 2906, z: 3049, level: 0 }, slips: [{ x: 2903, z: 3057, level: 0 }],
        run: { how: 'loc', loc: 'zq_logbalance', op: 1, id: 2332, at: { x: 2909, z: 3049, level: 0 }, unlisted: true } });
    expect(east).toMatchObject({ from: { x: 2906, z: 3049, level: 0 }, to: { x: 2910, z: 3049, level: 0 }, slips: [{ x: 2909, z: 3059, level: 0 }],
        run: { how: 'loc', loc: 'zq_logbalance', op: 1, id: 2332, at: { x: 2907, z: 3049, level: 0 }, unlisted: true } });
    expect(RIVER_LOG_TRAVEL.every(t => t.needs.length === 0 && t.coins === 0)).toBe(true);
});

// The client scene keeps the log on level 1 under the bridge flag, so the state's loc list never shows it.
function fixture(t: Travel, end: { x: number; z: number } | null, hp: number | null = 99) {
    let tick = 0;
    const skills = hp === null ? [] : [{ name: 'Hitpoints', level: hp, baseLevel: 99 }];
    const calls: any[] = [], state: any = { player: { worldX: t.from!.x, worldZ: t.from!.z, level: 0 }, skills, nearbyLocs: [], dialog: { isOpen: false, isWaiting: false, options: [] } };
    const s: any = {
        sdk: { getState: () => state, getDialog: () => state.dialog, sendClickDialog: async () => ({ success: true }) },
        tick: () => tick,
        onTick: (cb: () => void) => { queueMicrotask(() => { tick++; cb(); }); return () => {}; },
        direct: async (a: any) => { calls.push(a); if (a.type === 'interactLoc' && end) Object.assign(state.player, { worldX: end.x, worldZ: end.z }); return { success: true }; },
        bot: { walkTo: async () => ({ success: true }), interactLoc: async () => ({ success: true }) },
    };
    return { s, calls, run: () => walkRoute(s, [{ kind: 'travel', travel: t, at: t.from!, to: t.to }], { maxRetriesPerLeg: 1 }) };
}

test('the walker sends the log op by id and tile, and a crossing or a slip to the far bank both arrive', async () => {
    for (const [t, end] of [[west, { x: 2906, z: 3049 }], [west, { x: 2903, z: 3057 }], [east, { x: 2910, z: 3049 }], [east, { x: 2909, z: 3059 }]] as const) {
        const f = fixture(t, end);
        expect(await f.run()).toMatchObject({ ok: true });
        expect(f.calls).toEqual([{ type: 'interactLoc', x: t.run.how === 'loc' ? t.run.at!.x : 0, z: 3049, locId: 2332, optionIndex: 1, reason: 'SDK' }]);
    }
});

// A slip deals floor(current hitpoints * 6 / 100) + 1 (shortcuts.rs2:89): 1 hitpoint dies, 2 keep 1.
test('the walker does not start the log at a hitpoint level a slip would kill, or with hitpoints unseen', async () => {
    expect(west.slipDamage).toEqual({ percent: 6, plus: 1 });
    for (const hp of [1, null]) {
        const f = fixture(west, { x: 2906, z: 3049 }, hp);
        expect(await f.run()).toMatchObject({ ok: false, reason: 'precondition' });
        expect(f.calls).toEqual([]);
    }
    const f = fixture(west, { x: 2906, z: 3049 }, 2);
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
});

test('a log crossing that leaves the player on the near bank fails', async () => {
    const f = fixture(west, null);
    expect(await f.run()).toMatchObject({ ok: false, reason: 'timeout' });
});
