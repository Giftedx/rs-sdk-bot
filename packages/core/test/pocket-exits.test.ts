import { expect, test } from 'bun:test';
import { pocketExitTravel, type Travel } from '../src/travel';
import { walkRoute } from '../src/walk';
import { createWorld, rsPathLength, type Account, type Leg, type Tile } from '../src/world';

const teleports = async () => (await Bun.file('knowledge/teleports.json').json() as { teleports: Parameters<typeof pocketExitTravel>[0] }).teleports;

test('the essence mine and chaos altar portals get one edge per landing, each listing the other landings', async () => {
    const edges = pocketExitTravel(await teleports());
    const mine = edges.filter(e => e.id.startsWith('runecraft_portal:blankrunestone_exit_portal@'));
    const chaos = edges.filter(e => e.id.startsWith('runecraft_portal:chaostemple_exit_portal@'));
    // maps/m45_75.jm2: 4 portals (loc 2492); runecraft.constant:15-19: 5 wizards to go back to.
    expect(mine.length).toBe(20);
    expect(new Set(mine.map(e => `${e.from!.x},${e.from!.z}`))).toEqual(new Set(['2885,4850', '2889,4813', '2932,4854', '2933,4815']));
    expect(new Set(mine.map(e => `${e.to.x},${e.to.z}`))).toEqual(new Set(['3253,3401', '3106,9572', '2591,3086', '2390,9810', '2684,3322']));
    // maps/m35_75.jm2: 3 portals (loc 2474) on levels 0 and 3; runecraft.dbrow:114-122: 9 exit rows, 8 tiles.
    expect(chaos.length).toBe(24);
    for (const e of [...mine, ...chaos]) {
        expect(e.run.how === 'loc' && e.run.op === 1 && e.run.id).toBe(e.id.includes('blankrunestone') ? 2492 : 2474);
        expect(e.run.how === 'loc' && e.run.at).toEqual(e.from!);
        expect(e.lands!.length).toBe(e.id.includes('blankrunestone') ? 4 : 7);
        expect(e.lands!.some(t => t.x === e.to.x && t.z === e.to.z && t.level === e.to.level)).toBe(false);
    }
    // An exit with one landing is a shortcuts.json passage row, not a pocket exit.
    expect(edges.some(e => e.id.includes('airtemple'))).toBe(false);
});

// A session whose portal op lands the player on `landing` two ticks later.
function portalSession(start: { x: number; z: number; level: number }, landing: { x: number; z: number; level: number }) {
    let tick = 0, moveAt = -1;
    const player = { worldX: start.x, worldZ: start.z, level: start.level };
    const callbacks = new Set<() => void>(), walks: string[] = [];
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
        sdk: { getState: () => ({ tick, player, nearbyLocs: [], skills: [], inventory: [] }), getDialog: () => null, sendClickDialog: async () => {} },
        bot: { walkTo: async (x: number, z: number) => { walks.push(`${x},${z}`); Object.assign(player, { worldX: x, worldZ: z }); return { success: true, message: 'walked' }; } },
        direct: async () => { moveAt = tick + 2; },
    };
    const timer = setInterval(() => {
        tick++;
        if (moveAt >= 0 && tick >= moveAt) { Object.assign(player, { worldX: landing.x, worldZ: landing.z, level: landing.level }); moveAt = -1; }
        for (const cb of [...callbacks]) cb();
    }, 1);
    return { s, walks, stop: () => clearInterval(timer) };
}

test('a portal that lands on another of its landings stops the route for a new plan; the planned landing goes on', async () => {
    const edges = pocketExitTravel(await teleports());
    const edge: Travel = edges.find(e => e.id === 'runecraft_portal:blankrunestone_exit_portal@2932,4854,0>3106,9572,0')!;
    // The plan walks on from the Sedridor landing, to the basement ladder.
    const legs = (t: Travel): Leg[] => [{ kind: 'travel', travel: t, at: t.from, to: t.to }, { kind: 'walk', to: { x: 3104, z: 9575, level: 0 } }];
    // Woodpecker's tile; the server sends the player back to Aubury in Varrock, not to the Sedridor plan.
    const off = portalSession({ x: 2933, z: 4854, level: 0 }, { x: 3253, z: 3401, level: 0 });
    try {
        const r = await walkRoute(off.s, legs(edge), { maxRetriesPerLeg: 1 });
        expect(r.ok).toBe(false);
        expect(!r.ok && r.offPlan).toBe(true);
        expect(!r.ok && r.detail).toContain('landed at 3253,3401,0');
        expect(off.walks).toEqual([]);
    } finally { off.stop(); }
    const on = portalSession({ x: 2933, z: 4854, level: 0 }, { x: 3106, z: 9572, level: 0 });
    try {
        const r = await walkRoute(on.s, legs(edge), { maxRetriesPerLeg: 1 });
        expect(r.ok).toBe(true);
        expect(on.walks).toContain('3104,9575');
    } finally { on.stop(); }
});

// Landing tiles of teleports and NPC travel that no walker edge leaves. Each reason names what is missing.
const NO_EXIT: Record<string, string> = {
    '2933,4713,2': 'Watchtower top: the way down is watchladderdown, a quest_itwatchtower loc (shortcuts.json kind quest), which shortcutTravel takes only when it is listed ungated',
    '2890,3679,0': 'Trollheim: the way down is troll_mountain_shortcut_climbingrocks1/2, quest_troll rows with an Agility 15 failure roll',
    '2851,3235,0': 'Crandor: the way off is crandor_rock_opening, a Dragon Slayer quest loc; the boat there is one-way',
    '2822,9774,0': 'Entrana dungeon: the cave monk takes the player down one way; no loc row leaves it (a teleport does)',
    '2588,9410,0': 'Skavid cave by the enclave: the enclave guard takes the player in; no loc row within 15 tiles leaves it (a teleport does)',
};

const WOODPECKER: Tile = { x: 2924, z: 4848, level: 0 };

test('every teleport and NPC travel landing has a walker edge out to the mainland, except the listed pockets', async () => {
    const pl = await rsPathLength(), world = createWorld({ pathLength: pl }), g = world.navigationGraph!();
    const areaOf = pl.areaOf!;
    // A loc tile is often unlabelled: an edge starts from every area within 2 tiles of it (PORTAL_TOL) and lands in
    // the nearest labelled area.
    const areasNear = (t: Tile): number[] => {
        const s = new Set<number>();
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { const a = areaOf({ x: t.x + dx, z: t.z + dz, level: t.level }); if (a >= 0) s.add(a); }
        return [...s];
    };
    const areaNear = (t: Tile): number => {
        for (let r = 0; r <= 3; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const a = areaOf({ x: t.x + dx, z: t.z + dz, level: t.level });
            if (a >= 0) return a;
        }
        return -1;
    };
    // Areas joined by edges, backwards from the mainland. Every fixed edge counts, whatever it needs: the test asks
    // whether a way out exists. Teleports from anywhere are left out, or every pocket would pass.
    const into = new Map<number, Set<number>>();
    const join = (from: Tile, to: Tile) => { const b = areaNear(to); for (const a of areasNear(from)) if (b >= 0 && a !== b) (into.get(b) ?? into.set(b, new Set()).get(b)!).add(a); };
    for (const t of g.transports) join(t.entry ?? t.from, t.to);
    for (const t of g.travel) if (t.from) for (const to of [t.to, ...(t.lands ?? [])]) join(t.from, to);
    const mainland = areaOf({ x: 3222, z: 3218, level: 0 }), out = new Set([mainland]), queue = [mainland];
    while (queue.length) for (const a of into.get(queue.pop()!) ?? []) if (!out.has(a)) { out.add(a); queue.push(a); }

    const landings = new Map<string, string>([[`${WOODPECKER.x},${WOODPECKER.z},0`, 'live: Woodpecker in the essence mine']]);
    for (const r of (await Bun.file('knowledge/teleports.json').json() as any).teleports) for (const d of r.to) for (const c of d.candidates) landings.set(`${c.x},${c.z},${c.level}`, r.id);
    for (const r of (await Bun.file('knowledge/npc-travel.json').json() as any).records) if (r.to) landings.set(`${r.to.x},${r.to.z},${r.to.level}`, `npc:${r.id}`);
    expect(landings.size).toBeGreaterThan(100);
    const stuck: string[] = [];
    for (const [k, src] of landings) {
        const [x, z, level] = k.split(',').map(Number) as [number, number, number];
        if (!out.has(areaNear({ x, z, level }))) stuck.push(`${k} ${src}`);
    }
    expect(stuck.map(s => s.split(' ')[0]).sort()).toEqual(Object.keys(NO_EXIT).sort());
}, 120_000);

test('the walker plans out of the essence mine, the chaos altar and the Wizards\' Tower ladder room', async () => {
    const world = createWorld({ pathLength: await rsPathLength() });
    // WALK_NO_ROUTE for Woodpecker: no coins, no runes.
    const broke: Account = { skills: { attack: 1, strength: 1, defence: 1, hitpoints: 10 }, varps: {}, items: [], counts: {}, coins: 0 };
    const strong: Account = { ...broke, skills: { attack: 99, strength: 99, defence: 99, hitpoints: 99 } };
    const exits = (r: ReturnType<typeof world.route>) => (r.ok ? r.legs : []).flatMap(l => l.kind === 'travel' ? [l.travel.id.split('@')[0]] : l.kind === 'transport' ? [l.loc] : []);
    for (const to of [{ x: 3094, z: 3491, level: 0 }, { x: 2809, z: 3441, level: 0 }]) {
        const r = world.route(WOODPECKER, to, broke);
        expect(r.ok).toBe(true);
        expect(exits(r)[0]).toBe('runecraft_portal:blankrunestone_exit_portal');
    }
    const chaos = world.route({ x: 2275, z: 4847, level: 3 }, { x: 3222, z: 3218, level: 0 }, strong);
    expect(exits(chaos)[0]).toBe('runecraft_portal:chaostemple_exit_portal');
    // The essence mine exit to Sedridor lands in the tower basement; its ladder room opens by a diagonal door
    // (components.ts mapAreas opens those before it labels the map).
    const tower = world.route({ x: 3106, z: 9572, level: 0 }, { x: 3222, z: 3218, level: 0 }, broke);
    expect(exits(tower)).toEqual(['wizards_tower_ladder']);
}, 120_000);
