import { test, expect } from 'bun:test';
import { watchRandomEvents, outOfReach, solveCube } from '../src/randomevents';

// A fake session: one mutable state, a tick counter, and a log of every action that reached the "client".
function fake(state: any) {
    let t = 0;
    const listeners = new Set<() => void>();
    const sent: any[] = [];
    const queued: any[] = [];
    const lines: string[] = [];
    const sdk: any = {
        getState: () => ({ ...state, tick: t }),
        send: (msg: any) => { queued.push(msg); },
        handleMessage: (_: string) => {},
    };
    const s: any = {
        name: 'fake', sdk, bot: {},
        tick: () => t,
        onTick(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        direct: async (a: any) => { sent.push({ t, ...a }); return { success: true }; },
        close: async () => {}, ended: new Promise(() => {}),
    };
    return {
        s, state, sent, queued, lines,
        async step(n = 1) { for (let i = 0; i < n; i++) { t++; for (const l of [...listeners]) l(); await Promise.resolve(); await Promise.resolve(); } },
        watch(extra: any = {}) { return watchRandomEvents(s, { pf: null, ifReader: null, danger: null, log: l => { lines.push(l); console.log(l); }, ...extra }); },
    };
}

const player = (x: number, z: number, extra: any = {}) => ({ worldX: x, worldZ: z, level: 0, animId: -1, combat: { targetIndex: -1, targetType: 'none' }, ...extra });
const base = (x: number, z: number) => ({
    player: player(x, z), skills: [{ name: 'Woodcutting', level: 49, baseLevel: 49, experience: 250000 }],
    inventory: [] as any[], equipment: [] as any[], nearbyNpcs: [] as any[], nearbyPlayers: [] as any[], nearbyLocs: [] as any[],
    groundItems: [] as any[], gameMessages: [] as any[], dialog: { isOpen: false }, modalInterface: -1, bank: { isOpen: false },
});
const npc = (index: number, id: number, name: string, x: number, z: number, extra: any = {}) =>
    ({ index, id, name, x, z, tileX: x, tileZ: z, size: 1, distance: 1, targetIndex: -1, animId: -1, optionsWithIndex: [], options: [], ...extra });

test('outOfReach follows Npc.ts targetWithinMaxRange (op branch): past maxrange+1, or on the corner', () => {
    const sp = { x: 0, z: 0 };
    expect(outOfReach({ x: 6, z: 0 }, sp, 5)).toBe(false);
    expect(outOfReach({ x: 7, z: 0 }, sp, 5)).toBe(true);
    expect(outOfReach({ x: 6, z: 6 }, sp, 5)).toBe(true);
    expect(outOfReach({ x: 6, z: 5 }, sp, 5)).toBe(false);
    expect(outOfReach({ x: 0, z: -17 }, sp, 15)).toBe(true);
});

test('dryad: flee to a tile 7 from its spawn, hold the script, walk back, then release it', async () => {
    const f = fake(base(3233, 3244));
    f.state.player.animId = 867; // chopping
    const w = f.watch();
    await f.step();
    // The dryad spawns next to the player and targets it (player slot 5 + 32768; no other player near).
    f.state.nearbyNpcs = [npc(77, 440, 'Tree spirit', 3234, 3244, { targetIndex: 32768 + 5 })];
    await f.step();
    expect(f.lines.some(l => /^EVENT dryad flee t=\d+/.test(l))).toBe(true);
    const walk = f.sent.find(a => a.type === 'walkTo');
    expect(walk).toBeTruthy();
    expect(outOfReach(walk, { x: 3234, z: 3244 }, 5)).toBe(true);
    expect(Math.max(Math.abs(walk.x - 3234), Math.abs(walk.z - 3244))).toBe(7);
    expect(w.busy()).toBe(true);

    // The script tries to chop again: held, not sent.
    let chopDone = false;
    void f.s.direct({ type: 'interactLoc', x: 3233, z: 3245, locId: 1308, optionIndex: 1 }).then(() => { chopDone = true; });
    f.s.sdk.send({ type: 'sdk_action', actionId: 'a1', action: { type: 'walkTo', x: 3233, z: 3244 } });
    await f.step();
    expect(f.sent.some(a => a.type === 'interactLoc')).toBe(false);
    expect(f.queued.length).toBe(0);

    // The player reaches the tile; the dryad loses the target (engine resets it to wander, faceEntity -1).
    f.state.player = player(walk.x, walk.z);
    f.state.nearbyNpcs = [npc(77, 440, 'Tree spirit', 3236, 3244, { targetIndex: -1 })];
    await f.step(4);
    expect(f.lines.some(l => /^EVENT dryad escaped/.test(l))).toBe(true);
    // Back to the tile the flight began on, still holding the script.
    expect(w.busy()).toBe(true);
    expect(chopDone).toBe(false);
    expect(f.sent.at(-1)).toMatchObject({ type: 'walkTo', x: 3233, z: 3244 });
    f.state.player = player(3233, 3244);
    await f.step();
    expect(f.lines.some(l => /^EVENT dryad returned/.test(l))).toBe(true);
    await f.step();
    expect(w.busy()).toBe(false);
    expect(chopDone).toBe(true);
    expect(f.sent.some(a => a.type === 'interactLoc')).toBe(true);
    expect(f.queued.length).toBe(1);
    expect(w.counts()['dryad:flee']).toBe(1);
    w.stop();
});

test('a dryad that targets another player near by is left alone', async () => {
    const f = fake(base(3233, 3244));
    f.state.nearbyPlayers = [{ index: 9, name: 'other', x: 3235, z: 3244 }];
    const w = f.watch();
    f.state.nearbyNpcs = [npc(77, 440, 'Tree spirit', 3236, 3244, { targetIndex: 32768 + 9 })];
    await f.step(3);
    expect(f.sent.length).toBe(0);
    expect(w.busy()).toBe(false);
    w.stop();
});

test('genie: talk at once, click through the chat, then rub the lamp on the skill this session trains', async () => {
    const f = fake(base(3233, 3244));
    const w = f.watch();
    await f.step();
    f.state.skills = [{ name: 'Woodcutting', level: 49, baseLevel: 49, experience: 251000 }];
    f.state.nearbyNpcs = [npc(12, 409, 'Genie', 3234, 3244, { targetIndex: 32768 + 5, optionsWithIndex: [{ text: 'Talk-to', opIndex: 1 }] })];
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'interactNpc', npcIndex: 12, optionIndex: 1 });
    expect(w.busy()).toBe(true);
    // "Click here to continue" is published with server index 1 (sdk/actions.ts dismissBlockingUI).
    f.state.dialog = { isOpen: true, text: 'Ah, so you are there master.', options: [{ index: 1, text: 'Click here to continue' }] };
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'clickDialogOption', optionIndex: 1 });
    f.state.dialog = { isOpen: false };
    f.state.nearbyNpcs = [];
    f.state.inventory = [{ slot: 3, id: 2528, name: 'Lamp', count: 1, optionsWithIndex: [{ text: 'Rub', opIndex: 1 }] }];
    await f.step(2);
    expect(f.sent.some(a => a.type === 'useInventoryItem' && a.slot === 3)).toBe(true);
    f.state.modalInterface = 2808;
    await f.step(2);
    expect(f.sent.some(a => a.type === 'clickComponent' && a.componentId === 2812 + 17)).toBe(true); // woodcutting
    await f.step(2);
    expect(f.sent.some(a => a.type === 'clickComponent' && a.componentId === 2831)).toBe(true); // confirm
    f.state.modalInterface = -1;
    f.state.inventory = [];
    await f.step(2);
    expect(f.lines.some(l => /^EVENT genie lamp-woodcutting/.test(l))).toBe(true);
    expect(w.busy()).toBe(false);
    w.stop();
});

test('lost axe (worn): unequip the handle, pick up the head, join them, wield the axe', async () => {
    const f = fake(base(3233, 3244));
    f.state.equipment = [{ slot: 3, id: 492, name: 'Axe handle', count: 1 }];
    f.state.inventory = [{ slot: 0, id: 946, name: 'Knife', count: 1 }];
    const w = f.watch();
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'useEquipmentItem', slot: 3 });
    f.state.equipment = [];
    f.state.inventory.push({ slot: 1, id: 492, name: 'Axe handle', count: 1 });
    f.state.groundItems = [{ id: 512, name: 'Axe head', count: 1, x: 3238, z: 3246, distance: 5 }];
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'pickupItem', x: 3238, z: 3246, itemId: 512 });
    f.state.groundItems = [];
    f.state.inventory.push({ slot: 2, id: 512, name: 'Axe head', count: 1 });
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'useItemOnItem', sourceSlot: 1, targetSlot: 2 });
    f.state.inventory = [{ slot: 0, id: 946, name: 'Knife', count: 1 }, { slot: 1, id: 1353, name: 'Steel axe', count: 1, optionsWithIndex: [{ text: 'Wield', opIndex: 2 }] }];
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'useInventoryItem', slot: 1, optionIndex: 2 });
    await f.step();
    expect(f.lines.some(l => /^EVENT lost_axe fixed/.test(l))).toBe(true);
    w.stop();
});

test('big fish: the net left the pack and lies near by, so pick it up', async () => {
    const f = fake(base(3087, 3230));
    f.state.inventory = [{ slot: 0, id: 303, name: 'Small fishing net', count: 1 }];
    const w = f.watch();
    await f.step();
    f.state.inventory = [];
    f.state.groundItems = [{ id: 303, name: 'Small fishing net', count: 1, x: 3090, z: 3233, distance: 3 }];
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'pickupItem', x: 3090, z: 3233, itemId: 303 });
    f.state.inventory = [{ slot: 0, id: 303, name: 'Small fishing net', count: 1 }];
    await f.step();
    expect(f.lines.some(l => /^EVENT big_fish recovered/.test(l))).toBe(true);
    w.stop();
});

test('an offered net with another net nearby never triggers pickup during or after trade', async () => {
    for (const prior of ['none', 'disappearance', 'pickup'] as const) {
        const f = fake({ ...base(3222, 3222), trade: { isOpen: false } });
        const net = { slot: 0, id: 303, name: 'Small fishing net', count: 1 };
        const nearby = { id: 303, name: 'Small fishing net', count: 1, x: 3223, z: 3222, distance: 1 };
        f.state.inventory = [net];
        const w = f.watch();
        await f.step();
        if (prior !== 'none') {
            f.state.inventory = [];
            if (prior === 'pickup') f.state.groundItems = [nearby];
            await f.step();
        }
        const sentBeforeTrade = f.sent.length;
        f.state.trade = { isOpen: true, screen: 'offer', myOffer: [net] };
        f.state.inventory = [];
        f.state.groundItems = [nearby];
        await f.step(2);
        f.state.trade.screen = 'confirm';
        await f.step(2);
        expect(f.sent.length).toBe(sentBeforeTrade);
        expect(w.busy()).toBe(false);
        // Completed trade: the offered net stays absent after both windows close.
        f.state.trade = { isOpen: false };
        await f.step(13);
        expect(f.sent.length).toBe(sentBeforeTrade);
        expect(f.lines.filter(l => l.includes('tool-dropped')).length).toBe(prior === 'pickup' ? 1 : 0);
        // A later real loss still uses the refreshed inventory baseline.
        f.state.inventory = [net];
        await f.step();
        f.state.inventory = [];
        await f.step();
        expect(f.sent.at(-1)).toMatchObject({ type: 'pickupItem', itemId: 303 });
        expect(f.sent.length).toBe(sentBeforeTrade + 1);
        w.stop();
    }
});

test('strange box: the solver reads the models, and the job clicks the right answer', async () => {
    // centre red triangle (3063), side blue star (3083), top yellow circle (3079)
    expect(solveCube('What colour is the Star?', [3063, 3083, 3079])).toBe(1);
    expect(solveCube('Which shape is Yellow?', [3063, 3083, 3079])).toBe(2);
    expect(solveCube('Which shape is Red?', [3063, 3083, 3079])).toBe(0);
    const f = fake(base(3233, 3244));
    f.state.inventory = [{ slot: 4, id: 3062, name: 'Strange box', count: 1, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }];
    const texts: Record<number, string> = { 6561: 'Which shape is Yellow?' };
    const objs: Record<number, number> = { 6555: 3063, 6557: 3083, 6559: 3079 };
    const w = f.watch({ ifReader: { text: (c: number) => texts[c], obj: (c: number) => objs[c] } });
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'useInventoryItem', slot: 4, optionIndex: 1 });
    f.state.modalInterface = 6554;
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'clickComponent', componentId: 6564 });
    f.state.modalInterface = -1;
    f.state.inventory = [];
    await f.step();
    expect(f.lines.some(l => /^EVENT strange_box solved/.test(l))).toBe(true);
    w.stop();
});

test('ent: the player chopping it is sent to another tree of the same kind, and scripts may not click it', async () => {
    const f = fake(base(3233, 3244));
    f.state.player.animId = 867;
    f.state.nearbyNpcs = [npc(30, 449, 'Willow', 3234, 3244, { size: 2, options: ['Chop down'] })];
    f.state.nearbyLocs = [{ id: 1308, name: 'Willow', x: 3240, z: 3240, distance: 7, options: ['Chop down'], optionsWithIndex: [{ text: 'Chop down', opIndex: 1 }] }];
    const w = f.watch();
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'interactLoc', x: 3240, z: 3240, locId: 1308 });
    expect(w.avoid().npcs.has(30)).toBe(true);
    let res: any = null;
    void f.s.direct({ type: 'interactNpc', npcIndex: 30, optionIndex: 1 }).then((r: any) => { res = r; });
    await f.step();
    expect(res?.success).toBe(false);
    w.stop();
});

test('mime: copy the emote the mime played once it bows', async () => {
    const f = fake(base(2008, 4764));
    const w = f.watch();
    f.state.nearbyNpcs = [npc(40, 1056, 'Mime', 2011, 4762, { animId: 866 })]; // dance
    await f.step();
    f.state.nearbyNpcs = [npc(40, 1056, 'Mime', 2011, 4762, { animId: 858 })]; // bow: the panel opens
    await f.step();
    expect(f.sent.at(-1)).toMatchObject({ type: 'clickComponent', componentId: 6546 + 3 });
    w.stop();
});

test('the flight tile keeps away from NPCs that hunt players', async () => {
    const f = fake(base(3086, 3231));
    // A swarm spawns south of the player; a dark wizard (hunter, radius 10) stands north at 3084,3241.
    f.state.nearbyNpcs = [npc(5, 411, 'Swarm', 3086, 3230, { targetIndex: 32768 + 1 }), npc(6, 174, 'Dark wizard', 3084, 3241)];
    const w = watchRandomEvents(f.s, { pf: null, ifReader: null, danger: new Map([[174, 10]]), log: l => f.lines.push(l) });
    await f.step();
    const walk = f.sent.find(a => a.type === 'walkTo');
    expect(outOfReach(walk, { x: 3086, z: 3230 }, 15)).toBe(true);
    expect(Math.max(Math.abs(walk.x - 3084), Math.abs(walk.z - 3241))).toBeGreaterThan(10);
    w.stop();
});
