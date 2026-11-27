import { expect, test } from 'bun:test';
import { fareCrossings, loadTravel, npcTravel, type Travel } from '../src/travel';
import { applyKnownDoorBlocks, fareDetour, travelNpc, unpaidFaresNear, walkPath, type PathDeps, type PathLoc } from '../src/walk';
import { createWorld, rsPathLength, type Account, type Tile } from '../src/world';

const LUMBRIDGE: Tile = { x: 3222, z: 3218, level: 0 }, AL_KHARID_BANK: Tile = { x: 3269, z: 3167, level: 0 };
// The walk through the gate: 125 ticks east and 124 west (route search, 100 coins). Round the fence by Varrock: 307.
const GATED_COST = 125, MARGIN = 35;
const account = (coins: number): Account => ({ skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10 }, varps: {}, items: coins ? ['coins'] : [], counts: { coins }, coins });
const travelIds = (r: { ok: boolean; legs?: { kind: string; travel?: Travel }[] }) => (r.ok ? r.legs! : []).flatMap(l => l.kind === 'travel' ? [l.travel!.id] : []);

test('Lumbridge and Al Kharid plan through the toll gate both ways with 10 coins, and round it with none', async () => {
    const world = createWorld({ pathLength: await rsPathLength() });
    for (const [from, to] of [[LUMBRIDGE, AL_KHARID_BANK], [AL_KHARID_BANK, LUMBRIDGE]] as const) {
        const paid = world.route(from, to, account(10));
        expect(paid.ok).toBe(true);
        expect(travelIds(paid).some(id => /^npc:borderguard[12]:/.test(id))).toBe(true);
        // A planner or walker change that drops the gate edge makes this route the 307-tick walk round the fence.
        expect(paid.ok && paid.cost).toBeLessThanOrEqual(GATED_COST + MARGIN);
        const poor = world.route(from, to, account(9));
        expect(poor.ok && travelIds(poor).some(id => id.startsWith('npc:borderguard'))).toBe(false);
        expect(fareDetour(poor.ok ? poor : { cost: 0 }, paid.ok ? paid : null)).toBe(true);
    }
}, 120_000);

test('the toll gate edges name the guard by id: both guards are "Border Guard", one on each side of the fence', () => {
    const rows = (Bun.file('knowledge/npc-travel.json').json() as Promise<{ records: any[] }>);
    return rows.then(({ records }) => {
        const edges = npcTravel(records.filter(r => /^borderguard[12]:/.test(r.id)));
        expect(edges.length).toBe(4);
        for (const e of edges) expect(e.run.how === 'npc' && e.run.npcId).toBe(e.id.startsWith('npc:borderguard1') ? 925 : 926);
        const west = edges.find(e => e.id === 'npc:borderguard1:al-kharid-east-of-the-toll-gate@3267,3229')!;
        // The player stands between the guards: the east guard is as near and stands behind the fence.
        const npcs = [
            { id: 926, name: 'Border Guard', x: 3268, z: 3229, distance: 1, index: 2 },
            { id: 925, name: 'Border Guard', x: 3267, z: 3229, distance: 1, index: 1 },
        ];
        expect(travelNpc(npcs, west.run as { npc: string; npcId?: number }, west.from)?.index).toBe(1);
        // Without ids the guard on the edge's start tile still wins.
        expect(travelNpc(npcs.map(({ id: _, ...n }) => n), { npc: 'Border Guard' }, west.from)?.index).toBe(1);
    });
});

test('a ground walk keeps the toll gate open in its plan only for an account that holds the fare', () => {
    const toll = fareCrossings();
    expect(toll.map(c => `${c.x},${c.z},${c.coins}`)).toEqual(['3268,3227,10', '3268,3228,10']);
    const sdk = (coins: number) => ({ getState: () => ({ player: { worldX: 3222, worldZ: 3218, level: 0 }, inventory: coins ? [{ id: 995, name: 'Coins', count: coins, slot: 0 }] : [], skills: [], equipment: [] }) });
    const gate = (coins: number) => applyKnownDoorBlocks(sdk(coins), 0, LUMBRIDGE, AL_KHARID_BANK).filter(b => b.x === 3268 && (b.z === 3227 || b.z === 3228));
    expect(gate(0).length).toBe(2);
    expect(gate(9).length).toBe(2);
    expect(gate(10)).toEqual([]);
});

test('an unpaid fare in the box of a walk asks for the paid comparison', () => {
    const edges = loadTravel().filter(t => t.id.startsWith('npc:borderguard'));
    expect(unpaidFaresNear(LUMBRIDGE, AL_KHARID_BANK, 0, edges).length).toBe(4);
    expect(unpaidFaresNear(LUMBRIDGE, AL_KHARID_BANK, 10, edges)).toEqual([]);
    expect(unpaidFaresNear({ x: 2800, z: 3400, level: 0 }, { x: 2850, z: 3450, level: 0 }, 0, edges)).toEqual([]);
    expect(fareDetour({ cost: 307 }, { cost: 125 })).toBe(true);
    expect(fareDetour({ cost: 150 }, { cost: 125 })).toBe(false);
});

// A road at z=3227 with the toll gate at x=3268 (its wall on the west edge of the tile). The fake bot runs 2 tiles a
// tick; Open from the tile next to the gate starts the guard's dialogue (border_gate.rs2), and "Yes, ok." with 10
// coins moves the bot onto the gate tile. The gate stays shut in the loc list.
function tollRoad(coins: number) {
    let x = 3250, clickX = 3250, tick = 0, held = coins, talking = -1, page = 0;
    const inputs: string[] = [], blocked: string[] = [];
    const listeners = new Set<() => void>();
    const gate: PathLoc = { x: 3268, z: 3227, id: 2882, name: 'Gate', optionsWithIndex: [{ text: 'Open', opIndex: 1 }] };
    const pages = [
        { text: 'Can I come through this gate?', options: [{ index: 0, text: 'Click here to continue' }] },
        { text: 'You must pay a toll of 10 gold coins to pass.', options: [{ index: 0, text: 'Click here to continue' }] },
        { text: '', options: [{ index: 1, text: "No thank you, I'll walk around." }, { index: 2, text: 'Who does my money go to?' }, { index: 3, text: 'Yes, ok.' }] },
    ];
    const deps: PathDeps = {
        pos: () => ({ x, z: 3227, level: 0 }),
        onTick: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        walk: tx => { clickX = tx; inputs.push(`walk ${tx}`); },
        interactLoc: l => { clickX = l.x - 1; talking = 0; page = 0; inputs.push(`open ${l.x}`); },
        locs: () => [gate],
        plan: (_l, _f, to) => [{ x: to.x, z: to.z }],
        blockDoor: (_l, loc) => { blocked.push(`${loc.x},${loc.z}`); return false; },
        fare: (_l, loc) => fareCrossings().find(c => c.x === loc.x && c.z === loc.z) ?? null,
        coins: () => held,
        dialog: () => talking >= 0 && x === 3267 ? { isOpen: true, isWaiting: false, text: pages[page]!.text, options: pages[page]!.options } : null,
        answer: i => {
            inputs.push(`answer ${i}`);
            if (page < 2) { page++; return; }
            talking = -1;
            if (i === 3 && held >= 10) { held -= 10; x = 3268; clickX = 3268; }
        },
    };
    const step = () => {
        tick++;
        for (let k = 0; k < 2; k++) {
            const nx = x + Math.sign(clickX - x);
            if (nx === x || (x < 3268 && nx >= 3268)) break;
            x = nx;
        }
        for (const l of [...listeners]) l();
    };
    return { deps, step, inputs, blocked, at: () => x, coins: () => held };
}

async function run(w: ReturnType<typeof tollRoad>, to: number, maxSteps = 200, stop?: () => boolean) {
    const p = walkPath(w.deps, [{ x: to, z: 3227, tol: 1 }], { stop });
    for (let i = 0; i < maxSteps; i++) {
        const r = await Promise.race([p, Promise.resolve(null)]);
        if (r) return r;
        w.step();
    }
    return p;
}

test('walkPath pays the toll gate and walks on through it', async () => {
    const w = tollRoad(25);
    const r = await run(w, 3290);
    expect(r.ok).toBe(true);
    expect(w.coins()).toBe(15);
    expect(w.inputs).toContain('answer 3');
    expect(w.inputs.filter(i => i.startsWith('open')).length).toBe(1);
    expect(w.blocked).toEqual([]);
    // 40 tiles at 2 a tick, the dialogue and the gate: far from the walk round the fence.
    expect(r.ticks).toBeLessThan(45);
});

async function logged(f: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [], log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { await f(); } finally { console.log = log; }
    return lines;
}
const tagged = (lines: string[], tag: string) => lines.filter(l => l.startsWith(`${tag} `)).map(l => JSON.parse(l.slice(tag.length + 1)));

test('walkPath short of the toll tries the gate once (Prince Ali Rescue waives it) and logs WALK_FARE_FAIL with the dialogue', async () => {
    const w = tollRoad(4);
    const lines = await logged(async () => {
        const r = await run(w, 3290);
        expect(r.ok).toBe(false);
        expect(r.detail).toContain('fare crossing did not move the bot');
    });
    expect(w.inputs.filter(i => i.startsWith('open')).length).toBe(1);
    expect(w.blocked).toEqual(['3268,3227']);
    expect(tagged(lines, 'WALK_FARE_FAIL')[0]).toMatchObject({ crossing: 'Al Kharid toll gate', fare: 10, coins: 4, dialog: expect.arrayContaining(['You must pay a toll of 10 gold coins to pass.']) });
});

test('walkPath short of a fare that no quest waives never opens the gate', async () => {
    const w = tollRoad(4), base = w.deps.fare!;
    w.deps.fare = (l, loc) => { const f = base(l, loc); return f ? { ...f, waived: false } : null; };
    const lines = await logged(async () => {
        const r = await run(w, 3290);
        expect(r.ok).toBe(false);
        expect(r.detail).toContain('fare 10 coins, the pack holds 4');
    });
    expect(w.inputs.some(i => i.startsWith('open'))).toBe(false);
    expect(tagged(lines, 'WALK_FARE_FAIL')[0]).toMatchObject({ fare: 10, coins: 4, attempts: 0 });
});

test('a fare crossing that fails and is walked round logs WALK_DETOUR with both path lengths', async () => {
    const w = tollRoad(0);
    let round = false;
    w.deps.blockDoor = () => { round = true; return true; };
    // Round the gate: the fake plan only says how long the way round is; the walk is not followed.
    w.deps.plan = (_l, from, to) => round ? [{ x: from.x, z: 3300 }, { x: to.x, z: 3300 }, { x: to.x, z: to.z }] : [{ x: to.x, z: to.z }];
    const lines = await logged(async () => { let n = 0; await run(w, 3290, 40, () => ++n > 30); });
    const [detour] = tagged(lines, 'WALK_DETOUR');
    expect(detour).toMatchObject({ crossing: 'Al Kharid toll gate' });
    expect(detour.roundTiles).toBeGreaterThan(detour.throughTiles + 100);
});
