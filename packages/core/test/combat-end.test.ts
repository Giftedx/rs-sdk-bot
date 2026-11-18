import { expect, test } from 'bun:test';
import { loadRoamers, parseRoamer } from '../src/danger';
import { LOGOUT_QUIET_TICKS, combatEndText, combatSquares, confirmedLogout, finishCombat, leaveCombat, nearestSafeTile, outside, safeCandidates, type CombatLeave } from '../src/combat-end';
import { defaultEatAt, questFoodDefinitions, registerSessionEater } from '../src/sustain';

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
// The Gnome battlefield: the camp tile of the trooper trainer (scripts/gather-combat.ts TROOPER_SITE) and a trooper that fights.
const FIELD = { x: 2525, z: 3242, level: 0 }, SKILLS = { attack: 60, strength: 60, defence: 60, hitpoints: 60, prayer: 43 };
const trooper = (more: object = {}) => ({ id: 476, name: 'Khazard trooper', x: 2526, z: 3242, hp: 20, combatTargetType: 'player', inCombat: true, ...more });

test('the ground on which a monster keeps a target comes from its config: maxrange + 1, or + attackrange', () => {
    const npc = { id: 1, name: 'x', spawns: [{ x: 10, z: 10, level: 0 }] };
    expect(parseRoamer(npc, 'wanderrange=9\nmaxrange=10')!.keep).toBe(11);
    // No range in the config: wanderrange 5, maxrange wanderrange + 2.
    expect(parseRoamer(npc, 'name=x')!.keep).toBe(8);
    expect(parseRoamer(npc, 'wanderrange=3')!.keep).toBe(6);
    // maxrange is never under wanderrange, and a ranged monster keeps its target to maxrange + attackrange.
    expect(parseRoamer(npc, 'wanderrange=9\nmaxrange=4')!.keep).toBe(10);
    expect(parseRoamer(npc, 'wanderrange=5\nmaxrange=7\nattackrange=7')!.keep).toBe(14);
    expect(parseRoamer({ name: 'no id', spawns: npc.spawns }, '')).toBeNull();
    expect(parseRoamer({ id: 2, name: 'no spawn' }, '')).toBeNull();
    // The content: both kinds of Khazard trooper, wanderrange 9 and maxrange 10.
    for (const id of [475, 476]) expect(loadRoamers().get(id)).toMatchObject({ name: 'Khazard trooper', keep: 11 });
    expect(loadRoamers().get(476)!.spawns.length).toBeGreaterThan(5);
});

test('the safe tile is outside the square of each spawn of each kind that fights, and the walk to it is the shortest', () => {
    const squares = combatSquares(FIELD, [trooper()], SKILLS);
    // A square for each trooper spawn in view of the camp, 11 tiles and the margin. Other squares are of monsters
    // that hunt this account near the field.
    const troopers = squares.filter(q => q.name === 'Khazard trooper');
    expect(troopers.length).toBeGreaterThan(5);
    expect(troopers.every(q => q.r === 13)).toBe(true);
    expect(outside(FIELD, squares)).toBe(false);
    const candidates = safeCandidates(FIELD, squares);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(t => outside(t, squares) && t.level === 0)).toBe(true);
    // Rings: no candidate is nearer than the first one by more than one ring step.
    expect(Math.min(...candidates.map(t => cheb(t, FIELD)))).toBeGreaterThanOrEqual(cheb(candidates[0]!, FIELD) - 2);
    const straight = (a: { x: number; z: number }, b: { x: number; z: number }) => cheb(a, b);
    const best = nearestSafeTile(FIELD, squares, straight)!;
    expect(outside(best, squares)).toBe(true);
    expect(cheb(best, FIELD)).toBe(Math.min(...candidates.slice(0, 24).map(t => cheb(t, FIELD))));
    // A tile with no walk to it is not taken.
    const blocked = nearestSafeTile(FIELD, squares, (a, b) => b.x === best.x && b.z === best.z ? null : straight(a, b))!;
    expect(blocked.x === best.x && blocked.z === best.z).toBe(false);
    expect(outside(blocked, squares)).toBe(true);
    expect(nearestSafeTile(FIELD, squares, () => null)).toBeNull();
    // A monster that fights nobody gives no square, and a tile that is safe already is its own answer.
    expect(combatSquares(FIELD, [trooper({ combatTargetType: 'none', inCombat: false })], SKILLS).filter(q => q.name === 'Khazard trooper')).toEqual([]);
    expect(nearestSafeTile({ x: 3222, z: 3218, level: 0 }, [], straight)).toEqual({ x: 3222, z: 3218, level: 0 });
});

// A fake session on a 1 ms tick. A trooper hits each 4 ticks while the account stands inside a trooper square.
// `hp`: the Hitpoints at the start, of 60. `pack`: the item id of each pack slot. An eat takes the item of its slot and
// heals by the content's amount. `walkTicks`: the ticks of a walk, 0 for a walk that arrives at once.
const TROUT = 333, LOBSTER_POT = 301;
function underAttack(o: { attacked?: boolean; walkArrives?: boolean; hp?: number; pack?: number[]; walkTicks?: number } = {}) {
    let tick = 100, at = { ...FIELD }, retaliate = true, lastHit = o.attacked === false ? -Infinity : 100, hp = o.hp ?? 60;
    const pack = new Map((o.pack ?? []).map((id, slot) => [slot, id])), eatTicks: number[] = [];
    const callbacks = new Set<() => void>(), actions: string[] = [], squares = combatSquares(FIELD, [trooper()], SKILLS);
    const inside = () => !outside(at, squares);
    const state = () => ({ player: { worldX: at.x, worldZ: at.z, level: 0, combat: { inCombat: o.attacked !== false && inside(), lastDamageTick: lastHit } },
        skills: Object.entries({ Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60, Prayer: 43 }).map(([name, level]) => ({ name, level: name === 'Hitpoints' ? hp : level, baseLevel: level })),
        inventory: [...pack].map(([slot, id]) => ({ id, slot, count: 1, optionsWithIndex: id === TROUT ? [{ text: 'Eat', opIndex: 1 }, { text: 'Drop', opIndex: 5 }] : [{ text: 'Drop', opIndex: 5 }] })),
        nearbyNpcs: [trooper()], autoRetaliateEnabled: retaliate });
    const s: any = { name: 'Fixture', sdk: { getState: state }, tick: () => tick, onTick: (cb: () => void) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
        ended: new Promise<{ reason: string }>(() => {}),
        direct: async (a: { type: string; componentId?: number; slot?: number; optionIndex?: number }) => {
            actions.push(`${a.type}:${a.componentId ?? a.slot ?? ''}`);
            if (a.componentId === 151) retaliate = false; if (a.componentId === 150) retaliate = true;
            if (a.type === 'useInventoryItem' && a.optionIndex === 1 && pack.get(a.slot!) === TROUT) { pack.delete(a.slot!); hp = Math.min(60, hp + questFoodDefinitions().get(TROUT)!.heal); eatTicks.push(tick); }
            return { success: true };
        } };
    const timer = setInterval(() => { tick++; if (o.attacked !== false && inside() && tick % 4 === 0) lastHit = tick; for (const cb of [...callbacks]) cb(); }, 1);
    const walk = async (to: { x: number; z: number }) => {
        actions.push(`walk:${to.x},${to.z}`); if (o.walkArrives === false) return false;
        const until = tick + (o.walkTicks ?? 0); while (tick < until) await new Promise(r => setTimeout(r, 1));
        at = { ...at, x: to.x, z: to.z }; return true;
    };
    return { s, actions, squares, walk, tick: () => tick, lastHit: () => lastHit, at: () => at, retaliate: () => retaliate, hp: () => hp, pack: () => [...pack.values()], eatTicks, end: () => clearInterval(timer) };
}
const straight = (a: { x: number; z: number }, b: { x: number; z: number }) => cheb(a, b);

test('an account under attack leaves the monsters ground, waits for the logout window and gets auto-retaliate back', async () => {
    const f = underAttack();
    try {
        const end = await leaveCombat(f.s, { walk: f.walk, pathLength: straight, log: () => {} });
        expect(end).toMatchObject({ underAttack: true, left: true, quiet: true, moves: 0, from: FIELD, eats: 0 });
        expect(outside(end.to!, f.squares)).toBe(true);
        expect(end.tiles).toBe(cheb(FIELD, end.to!));
        expect(end.tiles).toBeGreaterThan(0);
        expect(f.at()).toMatchObject({ x: end.to!.x, z: end.to!.z });
        // No hit for the logout window, and the step counts its ticks.
        expect(f.tick() - f.lastHit()).toBeGreaterThanOrEqual(LOGOUT_QUIET_TICKS);
        expect(end.ticks).toBeGreaterThanOrEqual(LOGOUT_QUIET_TICKS);
        // Auto-retaliate goes off for the walk and comes back.
        expect(f.actions[0]).toBe('clickComponent:151');
        expect(f.actions.at(-1)).toBe('clickComponent:150');
        expect(f.retaliate()).toBe(true);
    } finally { f.end(); }
}, 30_000);

test('an account that is not under attack stays where it is, and a walk that does not arrive is reported', async () => {
    const calm = underAttack({ attacked: false });
    try {
        expect(await leaveCombat(calm.s, { walk: calm.walk, pathLength: straight, log: () => {} })).toEqual({ underAttack: false, left: false, quiet: true, ticks: 0, moves: 0, tiles: 0, eats: 0 });
        expect(calm.actions).toEqual([]);
    } finally { calm.end(); }
    const stuck = underAttack({ walkArrives: false });
    try {
        const end = await leaveCombat(stuck.s, { walk: stuck.walk, pathLength: straight, log: () => {}, moves: 2 });
        expect(end).toMatchObject({ underAttack: true, left: false, quiet: false, moves: 2, tiles: 0, detail: 'walk to the safe tile did not arrive' });
        expect(stuck.retaliate()).toBe(true);
        // The second walk goes to a different tile: the tile that the first walk did not reach is not chosen again.
        const walks = stuck.actions.filter(a => a.startsWith('walk:'));
        expect(walks).toHaveLength(2);
        expect(walks[0]).not.toBe(walks[1]);
    } finally { stuck.end(); }
}, 30_000);

test('the end step eats by itself while it walks and waits, and holds the eat guard of the session for that time', async () => {
    const heal = questFoodDefinitions().get(TROUT)!.heal, eatAt = defaultEatAt(60);
    // Hitpoints 12 of 60, a pack with a lobster pot and 5 trout. The walk takes 8 ticks, then the wait.
    const f = underAttack({ hp: 12, pack: [LOBSTER_POT, TROUT, TROUT, TROUT, TROUT, TROUT], walkTicks: 8 });
    let holds = 0, releases = 0;
    registerSessionEater(f.s.sdk, () => { holds++; return { ateAt: -Infinity, release() { releases++; } }; });
    try {
        const end = await leaveCombat(f.s, { walk: f.walk, pathLength: straight, log: () => {} });
        expect(end).toMatchObject({ underAttack: true, left: true, quiet: true });
        // It eats until the Hitpoints are over the eat level, and no more: the other trout stay in the pack.
        const need = Math.ceil((eatAt + 1 - 12) / heal);
        expect(need).toBeGreaterThan(1);
        expect(need).toBeLessThan(5);
        expect(end.eats).toBe(need);
        expect(f.eatTicks).toHaveLength(need);
        expect(f.hp()).toBe(12 + need * heal);
        expect(f.hp()).toBeGreaterThan(eatAt);
        expect(f.pack()).toEqual([LOBSTER_POT, ...Array(5 - need).fill(TROUT)]);
        // The first eat comes before the walk ends. Two eats are 3 ticks apart or more (the food delay).
        const walkStart = f.tick() - end.ticks;
        expect(f.eatTicks[0]!).toBeLessThan(walkStart + 8);
        for (let i = 1; i < f.eatTicks.length; i++) expect(f.eatTicks[i]! - f.eatTicks[i - 1]!).toBeGreaterThanOrEqual(3);
        // An item with no Eat option is never used.
        expect(f.actions.filter(a => a === 'useInventoryItem:0')).toEqual([]);
        expect([holds, releases]).toEqual([1, 1]);
    } finally { f.end(); }
    // A pack with no food: no eat input, and the step still ends.
    const none = underAttack({ hp: 12, pack: [LOBSTER_POT] });
    try {
        const end = await leaveCombat(none.s, { walk: none.walk, pathLength: straight, log: () => {} });
        expect(end).toMatchObject({ left: true, quiet: true, eats: 0 });
        expect(none.actions.filter(a => a.startsWith('useInventoryItem'))).toEqual([]);
    } finally { none.end(); }
    // Hitpoints over the eat level: the food stays in the pack.
    const well = underAttack({ hp: eatAt + 1, pack: [TROUT] });
    try {
        expect((await leaveCombat(well.s, { walk: well.walk, pathLength: straight, log: () => {} })).eats).toBe(0);
        expect(well.pack()).toEqual([TROUT]);
    } finally { well.end(); }
    // A food list of the worker: a food that is not on it stays in the pack.
    const listed = underAttack({ hp: 12, pack: [TROUT] });
    try {
        expect((await leaveCombat(listed.s, { walk: listed.walk, pathLength: straight, log: () => {}, food: [385] })).eats).toBe(0);
    } finally { listed.end(); }
}, 30_000);

test('logout is pressed in windows until the server confirms it, and the receipt gets the last answer one time', async () => {
    const session = (combatUntil = 0) => { const recorded: string[] = []; let tick = 0; const callbacks = new Set<() => void>();
        const s: any = { sdk: { getState: () => ({ player: { combat: { inCombat: tick < combatUntil } } }) }, tick: () => tick, onTick: (cb: () => void) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
            ended: new Promise<{ reason: string }>(() => {}), direct: async () => ({ success: true }), lifecycle: { record: (kind: string, detail: string) => { recorded.push(`${kind}:${detail}`); return true; } } };
        const timer = setInterval(() => { tick++; for (const cb of [...callbacks]) cb(); }, 1);
        return { s, recorded, tick: () => tick, end: () => clearInterval(timer) }; };
    const answers = (list: string[]) => { let n = 0; return async () => list[Math.min(n++, list.length - 1)]!; };
    const late = session();
    try {
        expect(await confirmedLogout(late.s, { press: answers(['timeout', 'timeout', 'logged-out']) as any })).toEqual({ out: 'logged-out', tries: 3 });
        expect(late.recorded).toEqual(['logout:logged-out']);
    } finally { late.end(); }
    const first = session();
    try { expect(await confirmedLogout(first.s, { press: answers(['logged-out']) as any })).toEqual({ out: 'logged-out', tries: 1 }); } finally { first.end(); }
    const never = session();
    try {
        expect(await confirmedLogout(never.s, { press: answers(['timeout']) as any, tries: 3 })).toEqual({ out: 'timeout', tries: 3 });
        expect(never.recorded).toEqual(['logout:timeout']);
    } finally { never.end(); }
    // Between two windows the step waits for the end of the fight: the second press comes after it.
    const fought = session(9);
    try {
        const pressedAt: number[] = [], press = answers(['timeout', 'logged-out']);
        expect(await confirmedLogout(fought.s, { press: (async () => { pressedAt.push(fought.tick()); return press(); }) as any })).toEqual({ out: 'logged-out', tries: 2 });
        expect(pressedAt).toHaveLength(2);
        expect(pressedAt[0]!).toBeLessThan(9);
        expect(pressedAt[1]!).toBeGreaterThanOrEqual(9);
    } finally { fought.end(); }
    // A fight that does not end: the wait has a limit of the logout window, then the next press.
    const endless = session(Infinity);
    try {
        const pressedAt: number[] = [], press = answers(['timeout', 'logged-out']);
        expect(await confirmedLogout(endless.s, { press: (async () => { pressedAt.push(endless.tick()); return press(); }) as any })).toEqual({ out: 'logged-out', tries: 2 });
        expect(pressedAt[1]! - pressedAt[0]!).toBeGreaterThanOrEqual(LOGOUT_QUIET_TICKS);
        expect(pressedAt[1]! - pressedAt[0]!).toBeLessThan(LOGOUT_QUIET_TICKS + 15);
    } finally { endless.end(); }
    // An end that is not a logout (the server dropped the session) ends the tries: no click can follow it.
    const dropped = session();
    try { expect(await confirmedLogout(dropped.s, { press: answers(['disconnected']) as any })).toEqual({ out: 'disconnected', tries: 1 }); } finally { dropped.end(); }
}, 30_000);

test('the result line of a combat worker ends with the ticks of the end step and the result of the logout', async () => {
    const end: CombatLeave = { underAttack: true, left: true, quiet: true, ticks: 42, moves: 0, tiles: 35, eats: 2, from: FIELD, to: { x: 2560, z: 3242, level: 0 } };
    expect(combatEndText(end, { out: 'logged-out', tries: 2 })).toBe('endTicks=42 endUnderAttack=true endLeft=true endQuiet=true endTiles=35 endEats=2 logout=confirmed logoutTries=2');
    expect(combatEndText({ ...end, left: false, quiet: false, detail: 'no safe tile in reach' }, { out: 'timeout', tries: 3 }))
        .toBe('endTicks=42 endUnderAttack=true endLeft=false endQuiet=false endTiles=35 endEats=2 endDetail="no safe tile in reach" logout=timeout logoutTries=3');
    // finishCombat: the end step runs first, then the settlement presses logout through confirmedLogout.
    const order: string[] = [];
    let line = '';
    const fakeFinish = (async (sessions: unknown[], ok: boolean, detail: (ok: boolean) => string, opts: { logout: (s: unknown) => Promise<string> }) => {
        order.push('finish'); const out = await opts.logout(sessions[0]); line = `RESULT ${ok && out === 'logged-out' ? 'ok' : 'fail'} ${detail(ok)}`; return undefined as never;
    }) as any;
    // A death recovery that runs is over before the end step starts, and the worker's food list reaches the step.
    let recovered = false, foodSeen: readonly number[] | undefined;
    await finishCombat({} as any, true, 'mode=giant creditedKills=28', { food: [333],
        recovery: () => new Promise(done => setTimeout(() => { recovered = true; order.push('recovery'); done('recovered'); }, 5)),
        leave: async (_s, deps) => { expect(recovered).toBe(true); foodSeen = deps?.food; order.push('leave'); return end; },
        logout: async () => { order.push('logout'); return { out: 'logged-out', tries: 1 }; }, finish: fakeFinish });
    expect(order).toEqual(['recovery', 'leave', 'finish', 'logout']);
    expect(foodSeen).toEqual([333]);
    expect(line).toBe('RESULT ok mode=giant creditedKills=28 endTicks=42 endUnderAttack=true endLeft=true endQuiet=true endTiles=35 endEats=2 logout=confirmed logoutTries=1');
    // An end step that throws does not stop the settlement.
    await finishCombat({} as any, false, () => 'Error: bank retreat failed', { recovery: () => undefined,
        leave: async () => { throw Error('route data missing'); }, logout: async () => ({ out: 'timeout', tries: 3 }), finish: fakeFinish });
    expect(line).toBe('RESULT fail Error: bank retreat failed endTicks=0 endUnderAttack=true endLeft=false endQuiet=false endTiles=0 endEats=0 endDetail="Error: route data missing" logout=timeout logoutTries=3');
});
