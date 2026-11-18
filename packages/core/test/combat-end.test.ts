import { expect, test } from 'bun:test';
import { loadRoamers, parseRoamer } from '../src/danger';
import { LOGOUT_QUIET_TICKS, combatEndText, combatSquares, confirmedLogout, finishCombat, leaveCombat, nearestSafeTile, outside, safeCandidates, type CombatLeave } from '../src/combat-end';

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
function underAttack(o: { attacked?: boolean; walkArrives?: boolean } = {}) {
    let tick = 100, at = { ...FIELD }, retaliate = true, lastHit = o.attacked === false ? -Infinity : 100;
    const callbacks = new Set<() => void>(), actions: string[] = [], squares = combatSquares(FIELD, [trooper()], SKILLS);
    const inside = () => !outside(at, squares);
    const state = () => ({ player: { worldX: at.x, worldZ: at.z, level: 0, combat: { inCombat: o.attacked !== false && inside(), lastDamageTick: lastHit } },
        skills: Object.entries({ Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60, Prayer: 43 }).map(([name, level]) => ({ name, level, baseLevel: level })),
        nearbyNpcs: [trooper()], autoRetaliateEnabled: retaliate });
    const s: any = { name: 'Fixture', sdk: { getState: state }, tick: () => tick, onTick: (cb: () => void) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
        ended: new Promise<{ reason: string }>(() => {}),
        direct: async (a: { type: string; componentId?: number }) => { actions.push(`${a.type}:${a.componentId ?? ''}`); if (a.componentId === 151) retaliate = false; if (a.componentId === 150) retaliate = true; return { success: true }; } };
    const timer = setInterval(() => { tick++; if (o.attacked !== false && inside() && tick % 4 === 0) lastHit = tick; for (const cb of [...callbacks]) cb(); }, 1);
    const walk = async (to: { x: number; z: number }) => { actions.push(`walk:${to.x},${to.z}`); if (o.walkArrives === false) return false; at = { ...at, x: to.x, z: to.z }; return true; };
    return { s, actions, squares, walk, tick: () => tick, lastHit: () => lastHit, at: () => at, retaliate: () => retaliate, end: () => clearInterval(timer) };
}
const straight = (a: { x: number; z: number }, b: { x: number; z: number }) => cheb(a, b);

test('an account under attack leaves the monsters ground, waits for the logout window and gets auto-retaliate back', async () => {
    const f = underAttack();
    try {
        const end = await leaveCombat(f.s, { walk: f.walk, pathLength: straight, log: () => {} });
        expect(end).toMatchObject({ underAttack: true, left: true, quiet: true, moves: 0, from: FIELD });
        expect(outside(end.to!, f.squares)).toBe(true);
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
        expect(await leaveCombat(calm.s, { walk: calm.walk, pathLength: straight, log: () => {} })).toEqual({ underAttack: false, left: false, quiet: true, ticks: 0, moves: 0 });
        expect(calm.actions).toEqual([]);
    } finally { calm.end(); }
    const stuck = underAttack({ walkArrives: false });
    try {
        const end = await leaveCombat(stuck.s, { walk: stuck.walk, pathLength: straight, log: () => {}, moves: 2 });
        expect(end).toMatchObject({ underAttack: true, left: false, quiet: false, moves: 2, detail: 'walk to the safe tile did not arrive' });
        expect(stuck.retaliate()).toBe(true);
    } finally { stuck.end(); }
}, 30_000);

test('logout is pressed in windows until the server confirms it, and the receipt gets the last answer one time', async () => {
    const session = () => { const recorded: string[] = []; let tick = 0; const callbacks = new Set<() => void>();
        const s: any = { sdk: { getState: () => ({ player: { combat: { inCombat: false } } }) }, tick: () => tick, onTick: (cb: () => void) => { callbacks.add(cb); return () => { callbacks.delete(cb); }; },
            ended: new Promise<{ reason: string }>(() => {}), direct: async () => ({ success: true }), lifecycle: { record: (kind: string, detail: string) => { recorded.push(`${kind}:${detail}`); return true; } } };
        const timer = setInterval(() => { tick++; for (const cb of [...callbacks]) cb(); }, 1);
        return { s, recorded, end: () => clearInterval(timer) }; };
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
    // An end that is not a logout (the server dropped the session) ends the tries: no click can follow it.
    const dropped = session();
    try { expect(await confirmedLogout(dropped.s, { press: answers(['disconnected']) as any })).toEqual({ out: 'disconnected', tries: 1 }); } finally { dropped.end(); }
}, 30_000);

test('the result line of a combat worker ends with the ticks of the end step and the result of the logout', async () => {
    const end: CombatLeave = { underAttack: true, left: true, quiet: true, ticks: 42, moves: 0, from: FIELD, to: { x: 2560, z: 3242, level: 0 } };
    expect(combatEndText(end, { out: 'logged-out', tries: 2 })).toBe('endTicks=42 endUnderAttack=true endLeft=true endQuiet=true logout=confirmed logoutTries=2');
    expect(combatEndText({ ...end, left: false, quiet: false, detail: 'no safe tile in reach' }, { out: 'timeout', tries: 3 }))
        .toBe('endTicks=42 endUnderAttack=true endLeft=false endQuiet=false endDetail="no safe tile in reach" logout=timeout logoutTries=3');
    // finishCombat: the end step runs first, then the settlement presses logout through confirmedLogout.
    const order: string[] = [];
    let line = '';
    const fakeFinish = (async (sessions: unknown[], ok: boolean, detail: (ok: boolean) => string, opts: { logout: (s: unknown) => Promise<string> }) => {
        order.push('finish'); const out = await opts.logout(sessions[0]); line = `RESULT ${ok && out === 'logged-out' ? 'ok' : 'fail'} ${detail(ok)}`; return undefined as never;
    }) as any;
    await finishCombat({} as any, true, 'mode=giant creditedKills=28', {
        leave: async () => { order.push('leave'); return end; }, logout: async () => { order.push('logout'); return { out: 'logged-out', tries: 1 }; }, finish: fakeFinish });
    expect(order).toEqual(['leave', 'finish', 'logout']);
    expect(line).toBe('RESULT ok mode=giant creditedKills=28 endTicks=42 endUnderAttack=true endLeft=true endQuiet=true logout=confirmed logoutTries=1');
    // An end step that throws does not stop the settlement.
    await finishCombat({} as any, false, () => 'Error: bank retreat failed', {
        leave: async () => { throw Error('route data missing'); }, logout: async () => ({ out: 'timeout', tries: 3 }), finish: fakeFinish });
    expect(line).toBe('RESULT fail Error: bank retreat failed endTicks=0 endUnderAttack=true endLeft=false endQuiet=false endDetail="Error: route data missing" logout=timeout logoutTries=3');
});
