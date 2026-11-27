import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { classifyRawWorkerExit } from '../../brain/src/outcome-classifier';
import { classify as classifyHost, keptHostLine, superviseHost } from '../../practice/src/supervise-host';
import { isHpFloorLine, isHpFloorStop, supervise } from '../../practice/src/supervise';
import { startEatGuard } from '../src/eat-guard';
import { CALM_TICKS, ESCAPE_BUDGET, floorLine, hpFloorOf, hpFloorOff, playerMaxHitEstimate, startHpFloor, type HpFloorConfig } from '../src/hp-floor';
import { startInProcessSession } from '../src/inprocess';
import { questFoodDefinitions } from '../src/sustain';

const SHARK = 385;
const food = (id: number, slot: number, count = 1) => ({ id, slot, count, name: `food ${id}`, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] });
const SELF = 7;

// A small model of the game: each tick the client takes the inputs of the last tick. An eat heals; a walk moves the
// player one tile toward its target unless the target is in `walls` (the client refuses it). `hit` lowers Hitpoints.
function world(init: { hp?: number; max?: number; inventory?: any[]; at?: { x: number; z: number } } = {}) {
    let tick = 0;
    const w = {
        hp: init.hp ?? 10, max: init.max ?? 10, inventory: init.inventory ?? [] as any[],
        x: init.at?.x ?? 3200, z: init.at?.z ?? 3200, level: 0, dead: false, lifeId: 1,
        npcs: [] as any[], players: [] as any[], target: null as null | { x: number; z: number },
        walls: new Set<string>(), sent: [] as any[], eaten: 0,
    };
    const inbox: any[] = [];
    const listeners = new Set<() => void>();
    const client = {
        executeBotAction(a: any) {
            w.sent.push(a);
            if (a.type === 'walkTo' && w.walls.has(`${a.x},${a.z}`)) return { success: false, message: 'Failed to walk' };
            inbox.push(a);
            return { success: true };
        },
    };
    const state = () => ({
        tick,
        player: { worldX: w.x, worldZ: w.z, level: w.level, isDead: w.dead, hp: w.hp, maxHp: w.max, lifeId: w.lifeId },
        skills: [{ name: 'Hitpoints', level: w.hp, baseLevel: w.max }, { name: 'Magic', level: 1, baseLevel: 1 }],
        inventory: w.inventory.map(i => ({ ...i })), equipment: [], nearbyNpcs: w.npcs, nearbyPlayers: w.players,
    });
    let published = state();
    const s = {
        name: 'Fixture',
        sdk: { getState: () => published }, tick: () => tick, client,
        onTick(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
        direct: async (a: any) => client.executeBotAction(a) as { success: boolean },
    };
    const advance = (n = 1) => {
        for (let k = 0; k < n; k++) {
            for (const a of inbox.splice(0)) {
                if (a.type === 'useInventoryItem') {
                    const item = w.inventory.find(i => i.slot === a.slot);
                    if (!item) continue;
                    if (--item.count <= 0) w.inventory.splice(w.inventory.indexOf(item), 1);
                    w.hp = Math.min(w.max, w.hp + (questFoodDefinitions().get(item.id)?.heal ?? 0));
                    w.eaten++;
                } else if (a.type === 'walkTo') w.target = { x: a.x, z: a.z };
            }
            if (w.target) {
                w.x += Math.sign(w.target.x - w.x); w.z += Math.sign(w.target.z - w.z);
                if (w.x === w.target.x && w.z === w.target.z) w.target = null;
            }
            tick++;
            published = state();
            for (const cb of [...listeners]) cb();
        }
    };
    const hit = (n: number) => { w.hp = Math.max(0, w.hp - n); };
    const attacker = (over: Record<string, unknown> = {}) => ({ index: 3, id: 13, name: 'Wizard', combatLevel: 9, x: w.x + 1, z: w.z, distance: 1, targetIndex: 32768 + SELF, ...over });
    return { w, s, client, advance, hit, attacker };
}

const start = (s: any, cfg: HpFloorConfig = {}) => {
    const lines: string[] = [], stops: string[] = [];
    const floor = startHpFloor(s, { log: l => lines.push(l), stop: r => { stops.push(r); }, ...cfg });
    return { floor, lines, stops };
};

test('the floor line is two hits of the largest hit in reach, never a fixed number', () => {
    expect(floorLine(0)).toBe(0);
    expect(floorLine(3)).toBe(6);
    expect(floorLine(13)).toBe(26);
    expect(playerMaxHitEstimate(100)).toBe(26);
    expect(playerMaxHitEstimate(3)).toBe(4);
});

test('eats held food at the floor with no script attack, and logs one HP_FLOOR eat line', () => {
    const { w, s, advance, hit, attacker } = world({ hp: 10, max: 10, inventory: [food(SHARK, 0), food(SHARK, 1)] });
    const { floor, lines } = start(s);
    w.npcs = [attacker()];
    advance(2);
    hit(5);
    advance(2);
    expect(w.eaten).toBe(1);
    expect(floor.stats().eats).toBe(1);
    expect(lines.filter(l => l.startsWith('HP_FLOOR eat ')).length).toBe(1);
    expect(floor.escaping()).toBe(false);
});

test('does not eat above the floor, and not while no damage arrives', () => {
    const { w, s, advance, hit } = world({ hp: 50, max: 60, inventory: [food(SHARK, 0)] });
    start(s);
    advance(2);
    hit(4);
    advance(3);
    // One hit of 4: the floor is 8, Hitpoints 46.
    expect(w.eaten).toBe(0);
    // Low Hitpoints with no damage and no attacker: no eat, no escape.
    const low = world({ hp: 5, max: 60, inventory: [food(SHARK, 0)] });
    const quiet = start(low.s);
    low.advance(40);
    expect(low.w.eaten).toBe(0);
    expect(quiet.floor.escaping()).toBe(false);
});

test('with no food left a fight that hits half the Hitpoints escapes even at full Hitpoints', () => {
    const { w, s, advance, hit, attacker } = world({ hp: 10, max: 10, inventory: [food(SHARK, 0)] });
    const { floor } = start(s);
    w.npcs = [attacker()];
    advance(1);
    hit(5);
    advance(2);
    // The shark healed to 10; the floor is two hits of 5, so the next tick escapes with no food.
    expect(w.eaten).toBe(1);
    expect(floor.line().floor).toBe(10);
    expect(floor.escaping()).toBe(true);
});

test('aggressive NPCs that target the player without a hit never start an escape at full Hitpoints', () => {
    const { w, s, advance, hit, attacker } = world({ hp: 68, max: 68 });
    const { floor, lines, stops } = start(s);
    // Four attackers of combat level 57-73: the estimate floor reaches the full 68 Hitpoints.
    w.npcs = [attacker({ index: 3, combatLevel: 57 }), attacker({ index: 4, combatLevel: 57 }), attacker({ index: 5, combatLevel: 73 }), attacker({ index: 6, combatLevel: 25 })];
    advance(20);
    expect(floor.line().floor).toBeGreaterThanOrEqual(68);
    expect(floor.escaping()).toBe(false);
    expect(lines.some(l => l.startsWith('HP_FLOOR escape '))).toBe(false);
    expect(stops).toEqual([]);
    // A hit that lands at the floor with no food still escapes.
    hit(3);
    advance(1);
    expect(floor.escaping()).toBe(true);
});

test('an attacker the bot does not see (npc@-1) still sets the floor from the Hitpoints it lost', () => {
    const { w, s, advance, hit } = world({ hp: 10, max: 10 });
    const { floor, lines } = start(s);
    advance(2);
    hit(2);
    advance(1);
    hit(2);
    advance(1);
    expect(floor.line()).toEqual({ floor: 4, maxHit: 2 });
    expect(lines.some(l => /^HP_FLOOR escape hp=6\/10 floor=4 /.test(l))).toBe(false);
    hit(2);
    advance(1);
    expect(lines.some(l => /^HP_FLOOR escape hp=4\/10 floor=4 maxHit=2 food=0 .* by=unseen /.test(l))).toBe(true);
});

test('with no food the floor refuses script moves, walks back along its trail, and stops the run once calm', async () => {
    const { w, s, client, advance, hit, attacker } = world({ hp: 10, max: 10, at: { x: 3190, z: 3200 } });
    const { floor, lines, stops } = start(s);
    // The bot walks east 12 tiles to the Wizard: those tiles are its trail.
    for (let i = 0; i < 12; i++) { w.x++; advance(1); }
    w.npcs = [attacker()];
    hit(5);
    advance(1);
    expect(floor.escaping()).toBe(true);
    expect(lines.filter(l => l.startsWith('HP_FLOOR escape ')).length).toBe(1);
    // A script input that moves or attacks is refused; an eat or a logout click passes.
    expect((client.executeBotAction({ type: 'interactNpc', npcIndex: 3, optionIndex: 2 }) as any).success).toBe(false);
    expect((client.executeBotAction({ type: 'walkTo', x: 3203, z: 3200 }) as any).success).toBe(false);
    expect((client.executeBotAction({ type: 'clickComponent', componentId: 1 }) as any).success).toBe(true);
    const walk = w.sent.find(a => a.type === 'walkTo' && a.reason === 'hp-floor');
    expect(walk).toBeDefined();
    // A trail tile at least ESCAPE_DIST tiles from the Wizard, back the way the bot came (west).
    expect(walk.x).toBe(3193);
    expect(walk.z).toBe(3200);
    await Bun.sleep(0);
    // The Wizard drops the target: once no damage arrived for CALM_TICKS ticks the run ends.
    w.npcs = [];
    advance(CALM_TICKS + 1);
    expect(stops.length).toBe(1);
    expect(stops[0]).toMatch(/^stop=hp-floor hp=5\/10 floor=\d+ maxHit=\d+ food=0 by=Wizard#13 escape=walk at=/);
    expect(lines.filter(l => l.startsWith('HP_FLOOR stop ')).length).toBe(1);
    advance(20);
    expect(stops.length).toBe(1);
});

test('a walk the client refuses is never sent again; the floor picks another tile', async () => {
    const { w, s, advance, hit, attacker } = world({ hp: 10, max: 10 });
    start(s);
    // No trail: the rays. The first ray (straight away from the Wizard, west) is a wall.
    w.walls.add(`${w.x - 6},${w.z}`);
    w.npcs = [attacker()];
    advance(1);
    hit(5);
    for (let i = 0; i < 6; i++) { advance(1); await Bun.sleep(0); }
    const walks = w.sent.filter(a => a.type === 'walkTo' && a.reason === 'hp-floor').map(a => `${a.x},${a.z}`);
    expect(walks[0]).toBe(`${3200 - 6},3200`);
    expect(walks.filter(k => k === walks[0]).length).toBe(1);
    expect(new Set(walks).size).toBeGreaterThanOrEqual(2);
});

test('the escape ends the run at its budget when the damage goes on', async () => {
    const { w, s, advance, hit, attacker } = world({ hp: 30, max: 30 });
    const { stops } = start(s);
    w.npcs = [attacker({ combatLevel: 33 })];
    advance(1);
    hit(20);
    for (let i = 0; i < ESCAPE_BUDGET + 2; i++) { w.npcs = [attacker({ combatLevel: 33 })]; advance(1); await Bun.sleep(0); }
    expect(stops.length).toBe(1);
    expect(stops[0]).toMatch(/escape=walk-timeout /);
});

test('while the flee guard moves the player the floor sends no walk; when it stands still the floor takes over', () => {
    const { w, s, advance, hit, attacker } = world({ hp: 10, max: 10 });
    let busy = true, took = 0;
    start(s, { fleeActive: () => busy, takeOver: () => { took++; busy = false; } });
    w.npcs = [attacker()];
    advance(1);
    hit(5);
    for (let i = 0; i < 3; i++) { w.x--; advance(1); }
    expect(w.sent.filter(a => a.reason === 'hp-floor').length).toBe(0);
    expect(took).toBe(0);
    advance(4);
    expect(took).toBe(1);
    expect(w.sent.some(a => a.type === 'walkTo' && a.reason === 'hp-floor')).toBe(true);
});

test("the flee job's own walk passes the floor while the floor delegates; after the take-over it does not", () => {
    const { w, s, advance, hit, attacker } = world({ hp: 10, max: 10 });
    let busy = true;
    start(s, { fleeActive: () => busy, takeOver: () => { busy = false; } });
    w.npcs = [attacker()];
    advance(1);
    hit(5);
    advance(1);
    // gate.ts send adds reason 'random-event' to the flee job's walk.
    expect((s.client.executeBotAction({ type: 'walkTo', x: 3190, z: 3200, reason: 'random-event' }) as any).success).toBe(true);
    expect((s.client.executeBotAction({ type: 'walkTo', x: 3190, z: 3200 }) as any).success).toBe(false);
    busy = false;
    advance(1);
    expect((s.client.executeBotAction({ type: 'walkTo', x: 3190, z: 3200, reason: 'random-event' }) as any).success).toBe(false);
});

test('a death ends the escape and lets death recovery move the player', () => {
    const { w, s, client, advance, hit, attacker } = world({ hp: 10, max: 10 });
    const { floor, lines } = start(s);
    w.npcs = [attacker()];
    advance(1);
    hit(5);
    advance(1);
    expect(floor.escaping()).toBe(true);
    w.dead = true;
    advance(1);
    expect(floor.escaping()).toBe(false);
    expect(lines.some(l => l.startsWith('HP_FLOOR dead '))).toBe(true);
    expect((client.executeBotAction({ type: 'walkTo', x: 1, z: 1 }) as any).success).toBe(true);
});

test("the floor's eat does not make the eat guard yield to a script eater", () => {
    const { w, s, advance, hit, attacker } = world({ hp: 10, max: 10, inventory: [food(SHARK, 0), food(SHARK, 1)] });
    startHpFloor(s, { log: () => {}, stop: () => {} });
    const guard = startEatGuard(s as any, { fightOnly: true });
    w.npcs = [attacker()];
    advance(1);
    hit(5);
    advance(2);
    expect(w.eaten).toBeGreaterThanOrEqual(1);
    expect(guard.stats().yielded).toBe(false);
});

test('every session that startInProcessSession opens has the floor; SESSION_HP_FLOOR=0 removes it only on a local server', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hp-floor-'));
    class FakeActions { constructor(public sdk: unknown) {} }
    const fakeStart = async (o: any) => {
        let done = false, resolveStopped!: (v: unknown) => void;
        const stopped = new Promise(r => { resolveStopped = r; });
        const end = (reason: string) => { if (done) return; done = true; o.onEnd({ reason }); resolveStopped({ reason }); };
        const client: any = { collectBotState: () => ({}), executeBotAction: () => ({ success: true }), setOnGameTickCallback: () => {}, end };
        o.onClient(client);
        return { client, stop: () => end('stopped'), stopped };
    };
    const open = (name: string) => startInProcessSession({ name, password: 'fixture-only', server: 'localhost:8888' }, {
        startSession: fakeStart, sdk: new BotSDK({ botUsername: name, password: 'fixture-only', autoLaunchBrowser: false, autoReconnect: false } as any),
        Actions: FakeActions as any, cacheDir: base, lifecycle: { root: join(base, 'lifecycle') }, recordOwned: () => {},
    });
    const prior = process.env.SESSION_HP_FLOOR;
    try {
        delete process.env.SESSION_HP_FLOOR;
        const a = await open('FloorA');
        expect(hpFloorOf(a)).toBeDefined();
        process.env.SESSION_HP_FLOOR = '0';
        const b = await open('FloorB');
        expect(hpFloorOf(b)).toBeUndefined();
        (a.client as any).end('logged-out'); (b.client as any).end('logged-out');
    } finally {
        if (prior === undefined) delete process.env.SESSION_HP_FLOOR; else process.env.SESSION_HP_FLOOR = prior;
        rmSync(base, { recursive: true, force: true });
    }
});

test('only a local server runs a session with no floor', () => {
    expect(hpFloorOff({}, false, 'scripts/pk.ts')).toBe(false);
    expect(hpFloorOff({ SESSION_HP_FLOOR: '0' }, false, 'scripts/woodcutting.ts')).toBe(false);
    expect(hpFloorOff({ SESSION_HP_FLOOR: '0' }, true, 'scripts/woodcutting.ts')).toBe(true);
    expect(hpFloorOff({}, true, 'C:\\repo\\scripts\\measure\\pk-spar-climb.ts')).toBe(true);
    expect(hpFloorOff({}, true, 'scripts/gather-combat.ts')).toBe(false);
});

test('a hp-floor end is a defect: the supervisor blocks the job and the brain quarantines the activity', async () => {
    const result = 'RESULT fail stop=hp-floor hp=4/59 floor=10 maxHit=5 food=0 by=Giant#117 escape=walk at=3110,9840,0 ticks=14';
    expect(isHpFloorStop(result)).toBe(true);
    expect(isHpFloorStop('RESULT ok stop=hp-floor')).toBe(false);
    expect(isHpFloorLine('  | HP_FLOOR escape hp=4/59 floor=10')).toBe(true);
    let runs = 0;
    const r = await supervise({ run: async () => { runs++; return { stdout: result, exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(r).toEqual({ reason: 'blocked', runs: 1 });
    expect(runs).toBe(1);
    // A script that printed its own RESULT after the floor's escape: the HP_FLOOR line still ends the job.
    const own = await supervise({ run: async () => ({ stdout: 'HP_FLOOR escape hp=2/10 floor=6\nRESULT fail Error: combat travel original owner/life/stop', exitCode: 1 }), stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(own.reason).toBe('blocked');
    expect(classifyHost(result, false)).toBe('blocked');
    // A hosted account whose script printed another failure after the floor's escape ends as blocked; its peer retries.
    expect(keptHostLine('[Ana]   | HP_FLOOR escape hp=2/10 floor=6')).toBe('HAna');
    let hostRuns = 0;
    const host = await superviseHost(['Ana', 'Bob'], {
        run: async () => { hostRuns++; return { stdout: '[Ana] HP_FLOOR escape hp=2/10 floor=6\n[Ana] RESULT fail Error: combat travel original owner/life/stop\n[Bob] RESULT ok', exitCode: 1 }; },
        stopped: () => false, pause: async () => {}, maxRestarts: 5,
    });
    expect(host.ends).toEqual({ Ana: 'blocked', Bob: 'done' });
    expect(hostRuns).toBe(1);
    const out = classifyRawWorkerExit({ activityId: 'gather-combat:giant', account: 'Bot1', exitCode: 1, status: result, ticksElapsed: 300 });
    expect(out.kind).toBe('worker_defect');
    expect((out as { faultSignature?: string }).faultSignature).toBe('hp-floor');
});
