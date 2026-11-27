import { test, expect } from 'bun:test';
import { inMineJail, leaveMineJail, MINE_JAIL_ROCKS, MINE_JAIL_WINDOW, mineJailRock, onMineJailCliff } from '../src/walk/mine-jail';

// A session that plays quest_desertrescue.rs2:188-274: the window asks to bend a bar (the first roll fails), the first
// rock asks to try the climb, and each rock moves the player one tile west of it (the last one 4 tiles west).
function fake(start: { x: number; z: number }, hp = 40) {
    let tick = 0, dialog: any = null, moveAt = -1, moveTo: { x: number; z: number } | null = null, bends = 0;
    const player = { worldX: start.x, worldZ: start.z, level: 0 };
    const ops: string[] = [];
    const callbacks = new Set<() => void>();
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
        sdk: {
            getState: () => ({ tick, player, skills: [{ name: 'Hitpoints', level: hp }], nearbyLocs: [] }),
            getDialog: () => dialog,
            sendClickDialog: async (i: number) => {
                const opt = dialog?.options.find((o: any) => o.index === i);
                dialog = null;
                if (!opt) return;
                if (/bend the bar/i.test(opt.text)) {
                    if (++bends < 2) dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: "Yes, I'll bend the bar again." }, { index: 2, text: "No, I'm going to give up." }] };
                    else { moveAt = tick + 2; moveTo = { x: MINE_JAIL_WINDOW.x - 1, z: MINE_JAIL_WINDOW.z }; }
                }
                if (/give it a try/i.test(opt.text)) { moveAt = tick + 2; moveTo = { x: MINE_JAIL_ROCKS[0].x - 1, z: MINE_JAIL_ROCKS[0].z }; }
            },
        },
        bot: { walkTo: async (x: number, z: number) => { if (inMineJail(player) === inMineJail({ worldX: x, worldZ: z, level: 0 })) Object.assign(player, { worldX: x, worldZ: z }); } },
        direct: async (a: any) => {
            ops.push(`${a.locId}@${a.x},${a.z}:${a.optionIndex}`);
            if (a.locId === MINE_JAIL_WINDOW.id) dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: "Yes, I'll bend the bar." }, { index: 2, text: "No, I'd better stay here." }] };
            else if (a.locId === MINE_JAIL_ROCKS[0].id) dialog = { isOpen: true, isWaiting: false, options: [{ index: 1, text: "Yes, I'll give it a try." }, { index: 2, text: "No, I'd better stay here." }] };
            else { moveAt = tick + 2; moveTo = { x: a.locId === MINE_JAIL_ROCKS[3].id ? a.x - 4 : a.x - 1, z: a.z }; }
        },
    };
    const timer = setInterval(() => {
        tick++;
        if (moveAt >= 0 && tick >= moveAt && moveTo) { Object.assign(player, { worldX: moveTo.x, worldZ: moveTo.z }); moveAt = -1; moveTo = null; }
        for (const cb of [...callbacks]) cb();
    }, 1);
    return { s, player, ops, stop: () => clearInterval(timer) };
}

const FALADOR = { x: 3013, z: 3355, level: 0 };

test('the mining camp cell and the tiles below its rocks are jail; the open desert west of the rocks is not', () => {
    // Live: Woodpecker and BowBeforeMe stood at 3287,3032 with "no route" to 3013,3355.
    expect(inMineJail({ worldX: 3287, worldZ: 3032, level: 0 })).toBe(true);
    expect(inMineJail({ worldX: 3285, worldZ: 3034, level: 0 })).toBe(true);
    expect(onMineJailCliff({ worldX: 3283, worldZ: 3032, level: 0 })).toBe(true);
    expect(onMineJailCliff({ worldX: 3277, worldZ: 3039, level: 0 })).toBe(true);
    expect(inMineJail({ worldX: 3270, worldZ: 3039, level: 0 }) || onMineJailCliff({ worldX: 3270, worldZ: 3039, level: 0 })).toBe(false);
    expect(inMineJail({ worldX: 3287, worldZ: 3032, level: 1 })).toBe(false);
    // Each rock lands one tile west of it, where the next rock is the one to climb.
    expect(mineJailRock({ worldX: 3282, worldZ: 3037, level: 0 }).id).toBe(2694);
    expect(mineJailRock({ worldX: 3279, worldZ: 3038, level: 0 }).id).toBe(2695);
    expect(mineJailRock({ worldX: 3277, worldZ: 3039, level: 0 }).id).toBe(2696);
    expect(mineJailRock({ worldX: 3275, worldZ: 3040, level: 0 }).id).toBe(2697);
});

test('a walk that starts in the mining camp cell leaves by the window and the four rocks', async () => {
    const f = fake({ x: 3287, z: 3032 });
    try {
        expect(await leaveMineJail(f.s, FALADOR)).toBe('out');
        expect(f.player.worldX).toBeLessThanOrEqual(3272);
        expect(f.ops[0]).toBe('2683@3284,3032:2');
        expect(f.ops.filter(o => o.startsWith('2683')).length).toBe(1);
        expect(f.ops.filter(o => !o.startsWith('2683')).map(o => Number(o.split('@')[0]))).toEqual([2694, 2695, 2696, 2697]);
    } finally { f.stop(); }
}, 20_000);

test('outside the jail, or with a target inside it, nothing is clicked; low hitpoints stop before a slip', async () => {
    const open = fake({ x: 3270, z: 3039 });
    try { expect(await leaveMineJail(open.s, FALADOR)).toBe('none'); expect(open.ops).toEqual([]); } finally { open.stop(); }
    const quest = fake({ x: 3287, z: 3032 });
    try { expect(await leaveMineJail(quest.s, { x: 3285, z: 3034, level: 0 })).toBe('none'); expect(quest.ops).toEqual([]); } finally { quest.stop(); }
    const weak = fake({ x: 3282, z: 3037 }, 7);
    try { expect(await leaveMineJail(weak.s, FALADOR)).toBe('stuck'); expect(weak.ops).toEqual([]); } finally { weak.stop(); }
}, 20_000);
