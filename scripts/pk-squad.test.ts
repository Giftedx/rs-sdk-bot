import { describe, expect, spyOn, test } from 'bun:test';
import * as walking from '../packages/core/src/walk';
import * as pk from './pk';
import * as pkGang from './pk-gang';
import { maxDeathsOf } from './pk-hunt';
import { activeCentroid, bankNear, configureBenchSession, createSquadCohesion, createSquadFocus, isKillLine, leaveWilderness, marchPlan, needsSingleWayMove, openSquad, outTripDue, pickSquadFocus, rescue, rescueDropped, shouldBreakSingleWayChase, shouldFollowReplan, shouldSwitchFocus, SINGLE_WAY_CHASE_LEASH, squadEscapeSpell, squadFallbackPlan, squadMetrics, squadPaused, squadStartFood, squadStopHandlers, squadTarget, squadWorkSession, stopSquadSession, VARROCK_WEST_BANK, watchSquadTicks } from './pk-squad';
import { escapeCastable, isMulti, nextTick } from './pk';
import { benchCases } from './measure/aio-bench-cases';
import { hold, SQUAD_OPTS, squadEnd, squadFightOverrides } from './pk-squad';
import { sparOptions } from './pk-spar';
import { newWatch, readLine } from './squad-watch';
import { classify } from '../packages/practice/src/supervise-host';
import { supervise } from '../packages/practice/src/supervise';
import { assertActionScope } from '../packages/core/src/action-scope';

const session = (z: number) => ({ sdk: { getState: () => ({ player: { worldX: 3092, worldZ: z, hp: 50, maxHp: 99 } }), getInventory: () => [] } }) as any;

describe('leaveWilderness', () => {
    test('missing player state cannot prove an exit', async () => {
        expect(await leaveWilderness({ sdk: { getState: () => null } } as any, false)).toEqual({ died: false, why: 'player state unavailable at squad exit' });
    });
    test('an account out of the Wilderness stays where it is', async () => {
        expect(await leaveWilderness(session(3496), false)).toEqual({ died: false, why: null });
    });
    test('an account the hold saw die does not walk', async () => {
        expect(await leaveWilderness(session(3640), true)).toEqual({ died: false, why: null });
    });
    test('a death on the way out is reported, not taken for an escape', async () => {
        let reads = 0;
        const s = { sdk: { getState: () => ({ player: { worldX: 3092, worldZ: 3640, hp: 5, maxHp: 99, lifeId: reads++ === 0 ? 1 : 2 } }), getInventory: () => [] } } as any;
        expect(await leaveWilderness(s, false)).toEqual({ died: true, why: 'died walking out of the Wilderness' });
    });
});

test('a rescue session remains owned for logout when retreat fails or throws', async () => {
    const opened = ['failed', 'threw', 'safe'].map(name => ({ name }) as any), sessions: any[] = [];
    const stranded = await rescueDropped(['failed', 'threw', 'safe'], sessions,
        async name => opened.find(s => s.name === name)!, () => {}, async s => {
            if (s.name === 'threw') throw Error('walk failed');
            return s.name === 'safe' ? s : null;
        });
    expect(sessions).toEqual(opened);
    expect(stranded).toEqual(['failed', 'threw']);
});

test('a refused squad login settles earlier sessions and skips remaining logins', async () => {
    const first = { name: 'first' } as any, opened: string[] = [], cleanup: string[] = [];
    const settledFailure = Error('settled startup failure');
    await expect(openSquad(['first', 'refused', 'unused'], async name => {
        opened.push(name);
        if (name === 'refused') throw Error('account ownership refused');
        return first;
    }, async (sessions, detail) => {
        expect(sessions).toEqual([first]);
        expect(detail).toContain('squad startup refused: Error: account ownership refused');
        await Promise.resolve();
        cleanup.push(...sessions.map(s => s.name));
        throw settledFailure;
    })).rejects.toBe(settledFailure);
    expect(opened).toEqual(['first', 'refused']);
    expect(cleanup).toEqual(['first']);
});

function rescueSession(name = 'rescue') {
    const listeners = new Set<() => void>(), inputs: string[] = [];
    let end!: (value: { reason: string }) => void, tick = 0;
    const ended = new Promise<{ reason: string }>(resolve => { end = resolve; });
    const raw: any = { name, ended, tick: () => tick,
        onTick: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
        sdk: { getState: () => ({ player: { worldX: 3092, worldZ: 3640, hp: 30, maxHp: 99 }, skills: [], inventory: [] }),
            getInventory: () => [{ slot: 0, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }] },
        direct: async (action: any) => { assertActionScope(action); inputs.push(action.type); },
        close: async () => { end({ reason: 'closed' }); },
    };
    return { raw, inputs, listeners, advance: () => { tick++; for (const listener of [...listeners]) listener(); } };
}

test('a tick-stalled squad waiter ends even if close hangs while another member finishes', async () => {
    const stalled = rescueSession('stalled'), other = rescueSession('other'), halted: string[] = [];
    stalled.raw.close = () => new Promise(() => {});
    const waiting = nextTick(squadWorkSession(stalled.raw)), completing = nextTick(squadWorkSession(other.raw));
    const stopping = stopSquadSession(stalled.raw, 'tick stream stalled: 120 s without a game tick', reason => halted.push(reason), 5);
    other.advance();
    expect(await Promise.all([waiting, completing, stopping])).toEqual([false, true, undefined]);
    expect(halted).toEqual(['tick stream stalled: 120 s without a game tick']);
    expect(stalled.listeners.size).toBe(0);
});

test('a bank trip is due at the start and after the Wilderness, and not on the first steps of the march', () => {
    const bank = 3491, step = 3503, inWilderness = 3560;
    // The start: no trip done yet, outside the Wilderness.
    expect(outTripDue(bank, false, 0)).toBe(true);
    // After the first trip the member stands on a march step outside the Wilderness and has not been in it: no second trip.
    expect(outTripDue(step, false, 1)).toBe(false);
    expect(outTripDue(bank, false, 1)).toBe(false);
    // In the Wilderness nothing is due; once it has been in it, a stand outside is a walk out or a teleport: a trip.
    expect(outTripDue(inWilderness, true, 1)).toBe(false);
    expect(outTripDue(step, true, 1)).toBe(true);
    expect(outTripDue(bank, true, 3)).toBe(true);
});

test('a member one meal short starts, and one under half of its pack food does not', () => {
    expect(squadStartFood(20, 21)).toEqual({ ok: true, floor: 11 });
    expect(squadStartFood(11, 21).ok).toBe(true);
    expect(squadStartFood(10, 21)).toEqual({ ok: false, floor: 11 });
    expect(squadStartFood(0, 0).ok).toBe(true);
});

test('an idle-stalled squad member ends its own session, halts no one, and is recorded as dropped for the rescue', async () => {
    const idle = rescueSession('idle'), other = rescueSession('other'), halted: string[] = [], dropped = new Map<string, string>(), lines: string[] = [];
    const { onStop } = squadStopHandlers(reason => halted.push(reason), dropped, line => lines.push(line));
    const waiting = nextTick(squadWorkSession(idle.raw)), completing = nextTick(squadWorkSession(other.raw));
    const stopping = onStop(idle.raw, 'no progress: 900 ticks without xp, items, dialog or a journey');
    other.advance();
    expect(await Promise.all([waiting, completing, stopping])).toEqual([false, true, undefined]);
    expect(halted).toEqual([]);
    expect(idle.listeners.size).toBe(0);
    // The rescue at the end reads `dropped`: a member that stalled in the Wilderness is taken out, not left closed there.
    expect([...dropped]).toEqual([['idle', 'no progress: 900 ticks without xp, items, dialog or a journey']]);
    expect(lines).toEqual(['[idle] SQUAD session ended: no progress: 900 ticks without xp, items, dialog or a journey']);
});

test('a tick stall still halts the squad, and a death is left to the death handling', async () => {
    const stalled = rescueSession('stalled'), halted: string[] = [], dropped = new Map<string, string>();
    const { onStop } = squadStopHandlers(reason => halted.push(reason), dropped, () => {});
    await onStop(rescueSession('dead').raw, 'died');
    expect(halted).toEqual([]);
    await onStop(stalled.raw, 'tick stream stalled: 120 s without a game tick');
    expect(halted).toEqual(['tick stream stalled: 120 s without a game tick']);
    expect(dropped.size).toBe(0);
});

test('the kill counter of the MAX_KILLS cutoff counts a kill line once, not its receipt and feed lines', () => {
    const lines = ['[A] PK kill Sugma after 37 ticks', '[A] PK kill receipt live 1795039182214-0000026472-0000000005 wilderness 15 multi', '[A] PK kill feed matched at feed tick 209996', '[B] PK special melee energy 750 on false target 43/99', '[B] PK died to Ligma after 88 ticks'];
    expect(lines.filter(isKillLine)).toEqual(['[A] PK kill Sugma after 37 ticks']);
});

test('account and squad pause files each prevent rescue login and remain in place', async () => {
    for (const file of ['.practice/stop-rescue', '.practice/stop-pk-squad']) {
        const files = new Set([file]), sessions: any[] = [];
        let logins = 0;
        const stranded = await rescueDropped(['rescue'], sessions, async () => { logins++; throw Error('must not log in'); }, () => {}, undefined,
            name => squadPaused(name, path => files.has(path)));
        expect(stranded).toEqual(['rescue']);
        expect([logins, sessions.length]).toEqual([0, 0]);
        expect([...files]).toEqual([file]);
    }
});

test('a pause arriving during rescue login retains the session and sends no game input', async () => {
    const { raw, inputs } = rescueSession(), sessions: any[] = [];
    let paused = false;
    expect(await rescueDropped(['rescue'], sessions, async () => { paused = true; return raw; }, () => {}, undefined, () => paused)).toEqual(['rescue']);
    expect(sessions).toEqual([raw]);
    expect(inputs).toEqual([]);
});

test('a rescue pause releases a tick wait without another game tick or game input', async () => {
    const { raw, inputs, listeners } = rescueSession(), sessions: any[] = [];
    let paused = false;
    const rescuing = rescueDropped(['rescue'], sessions, async () => raw, () => {}, undefined, () => paused);
    await Bun.sleep(0);
    expect(listeners.size).toBe(1);
    paused = true;
    expect(await rescuing).toEqual(['rescue']);
    expect(sessions).toEqual([raw]);
    expect(inputs).toEqual([]);
    expect(listeners.size).toBe(0);
});

test('a pause guards an already issued rescue input at its deferred dispatch', async () => {
    const { raw, inputs, advance } = rescueSession(), sessions: any[] = [];
    let paused = false;
    raw.direct = async (action: any) => {
        paused = true;
        await Bun.sleep(0);
        assertActionScope(action);
        inputs.push(action.type);
    };
    const rescuing = rescueDropped(['rescue'], sessions, async () => raw, () => {}, undefined, () => paused);
    for (let i = 0; i < 3; i++) { await Bun.sleep(0); advance(); }
    expect(await rescuing).toEqual(['rescue']);
    expect(sessions).toEqual([raw]);
    expect(inputs).toEqual([]);
});

test('a rescue stop callback releases its pending wait and retains the raw session for logout', async () => {
    const { raw, inputs } = rescueSession(), sessions: any[] = [];
    let stop!: (s: any, reason: string) => Promise<void>;
    const rescuing = rescueDropped(['rescue'], sessions, async (_name, onStop) => { stop = onStop; return raw; }, () => {}, undefined, () => false);
    await Bun.sleep(0);
    await stop(raw, 'stop file');
    expect(await rescuing).toEqual(['rescue']);
    expect(sessions).toEqual([raw]);
    expect(inputs).toEqual([]);
});

test('a surviving squad member advances coordination after the first disconnects', () => {
    const dropped = new Set<string>(), ticks: number[] = [];
    const clocks = ['first', 'second'].map(name => {
        let tick = 0;
        const listeners = new Set<() => void>();
        return { name, tick: () => tick, onTick: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
            advance: (next: number) => { tick = next; for (const listener of listeners) listener(); } };
    });
    const stop = watchSquadTicks(clocks as any, name => dropped.has(name), tick => ticks.push(tick));
    clocks[0]!.advance(10); clocks[1]!.advance(10);
    dropped.add('first');
    clocks[0]!.advance(11); clocks[1]!.advance(11);
    stop(); clocks[1]!.advance(12);
    expect(ticks).toEqual([10, 11]);
});

describe('squadTarget', () => {
    test('takes the lowest health bar of the targets in view', () => {
        const view = [{ name: 'Ligma', index: 1, distance: 2 }, { name: 'Sugma', index: 2, distance: 5 }, { name: 'Other', index: 3, distance: 1 }];
        const hp: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
        expect(squadTarget(view, new Set(['ligma', 'sugma']), p => hp[p.index]!)?.name).toBe('Sugma');
    });
});

describe('escapeCastable', () => {
    test('Camelot Teleport needs its law and air runes', () => {
        expect(escapeCastable(1174, [], [], 99)).toBe(false);
        expect(escapeCastable(1174, [{ id: 563, count: 1 }, { id: 556, count: 5 }], [], 99)).toBe(true);
    });
    test('a staff of air stands in for the air runes, and the level counts', () => {
        expect(escapeCastable(1174, [{ id: 563, count: 1 }], [1381], 99)).toBe(true);
        expect(escapeCastable(1174, [{ id: 563, count: 1 }, { id: 556, count: 5 }], [], 40)).toBe(false);
    });
});

describe('squadEscapeSpell', () => {
    test('picks Camelot with worn Staff of air, falls back to Varrock below Magic 45, and skips deep Wilderness', () => {
        expect(squadEscapeSpell(3632, [{ id: 563, count: 1 }], [1381], 45)).toBe(1174);
        expect(squadEscapeSpell(3632, [{ id: 563, count: 1 }, { id: 556, count: 3 }, { id: 554, count: 1 }], [], 25)).toBe(1164);
        expect(squadEscapeSpell(3632, [{ id: 563, count: 1 }, { id: 556, count: 3 }], [1387], 30)).toBe(1164);
        expect(squadEscapeSpell(3715, [{ id: 563, count: 1 }], [1381], 99)).toBeNull();
        expect(squadEscapeSpell(3632, [{ id: 563, count: 1 }], [], 99)).toBeNull();
    });
});

test('bankNear: Varrock West for the east multi-way zone, Edgeville west of it', () => {
    expect(bankNear(3200)).toEqual(VARROCK_WEST_BANK);
    expect(bankNear(3136)).toEqual(VARROCK_WEST_BANK);
    expect(bankNear(3067)).toEqual({ x: 3092, z: 3496 });
});

test('pickSquadFocus prioritizes stunned targets, skips single-way PJ fights, and squadFallbackPlan handles multi/dry retreats', () => {
    const view = [
        { name: 'Goondelf', index: 1, distance: 2, x: 3067, z: 3640, combatLevel: 120, inCombat: true },
        { name: 'Ligma', index: 2, distance: 3, x: 3067, z: 3641, combatLevel: 120, inCombat: false },
        { name: 'Sugma', index: 3, distance: 1, x: 3067, z: 3642, combatLevel: 120, inCombat: true },
    ];
    const targets = new Set(['goondelf', 'ligma', 'sugma']);
    const hp: Record<number, number> = { 1: 0.3, 2: 0.7, 3: 0.6 };
    // In single-way combat, Goondelf/Sugma already inCombat are skipped for anti-PJ unless it's activeFocus.
    expect(pickSquadFocus({ view, targets, health: p => hp[p.index]!, inMulti: false, stunned: new Set(['sugma']) })?.name).toBe('Ligma');
    // In multi-way combat, stunned Sugma takes priority focus pile over un-stunned Goondelf.
    expect(pickSquadFocus({ view, targets, health: p => hp[p.index]!, inMulti: true, stunned: new Set(['sugma']) })?.name).toBe('Sugma');

    expect(squadFallbackPlan({ z: 3640, hp: 50, maxHp: 99, foodCount: 4, enemyCount: 4, allyCount: 1, inMulti: true, hasGlory: true, hasTeleport: true })).toBe('glory');
    expect(squadFallbackPlan({ z: 3640, hp: 73, maxHp: 99, foodCount: 4, enemyCount: 4, allyCount: 2, inMulti: true, hasGlory: false, hasTeleport: true })).toBe('teleport');
    expect(squadFallbackPlan({ z: 3640, hp: 99, maxHp: 99, foodCount: 4, enemyCount: 3, allyCount: 0, inMulti: true, hasGlory: false, hasTeleport: true })).toBe('teleport');
    expect(squadFallbackPlan({ z: 3640, hp: 50, maxHp: 99, foodCount: 0, enemyCount: 1, allyCount: 0, inMulti: false, hasGlory: false, hasTeleport: true })).toBe('teleport');
    expect(squadFallbackPlan({ z: 3880, hp: 50, maxHp: 99, foodCount: 0, enemyCount: 3, allyCount: 0, inMulti: true, hasGlory: true, hasTeleport: true })).toBe('run');
    expect(squadFallbackPlan({ z: 3640, hp: 90, maxHp: 99, foodCount: 6, enemyCount: 2, allyCount: 1, inMulti: true, hasGlory: true, hasTeleport: true })).toBe('hold');
});

// The end of a squad run (scripts/pk-squad.ts squadEnd) and how the supervisor and the watch read it.
describe('squad end with a death', () => {
    const base = { accounts: 4, kills: 3, taken: 500, trips: 1, fights: 6, picked: { 884: 3 }, dropped: [], stranded: [] };
    const line = (e: { ok: boolean; detail: string }) => `RESULT ${e.ok ? 'ok' : 'fail'} ${e.detail}`;

    test('no death is ok, and a death is a fail that starts with died', () => {
        const fine = squadEnd({ ...base, deaths: 0, gangDied: 3 });
        expect(line(fine)).toBe('RESULT ok squad accounts=4 kills=3 gangDied=3 died=0 taken=500 trips=1 picked={"884":3}');
        const dead = squadEnd({ ...base, deaths: 1, gangDied: 2 });
        expect(dead.ok).toBe(false);
        expect(line(dead)).toBe('RESULT fail died squad accounts=4 kills=3 gangDied=2 died=1 taken=500 trips=1 picked={"884":3}');
        expect(squadEnd({ ...base, deaths: 0, halted: 'stop file' }).ok).toBe(false);
        expect(squadEnd({ ...base, deaths: 0, fights: 0 }).ok).toBe(false);
        expect(squadEnd({ ...base, deaths: 0, stranded: ['A'] }).detail).toContain('stranded=A');
    });

    test('the supervisor reads a squad with a death as a death, and a squad with none as done', async () => {
        const dead = line(squadEnd({ ...base, deaths: 2 })), fine = line(squadEnd({ ...base, deaths: 0 }));
        expect(classify(dead, false)).toBe('died');
        expect(classify(fine, false)).toBe('done');
        let runs = 0;
        const out = await supervise({ run: async () => { runs++; return { stdout: `PK died to X after 9 ticks\n${dead}\n`, exitCode: 1 }; }, stopped: () => false, pause: async () => {}, maxRestarts: 5 } as any);
        expect(out).toEqual({ reason: 'died', runs: 1 });
        expect(runs).toBe(1);
    });

    test('the watch reads the line as a death with its count', () => {
        const w = newWatch(0);
        const e = readLine(w, line(squadEnd({ ...base, deaths: 2 })), 0, { repeat: false });
        expect(e).toMatchObject({ kind: 'death', account: '-' });
        expect(w.deaths).toBe(2);
    });
});

test('the squad end line carries the kill receipt proof right after the kills, for the bench pass rule', () => {
    const end = squadEnd({ accounts: 4, kills: 3, taken: 500, trips: 1, fights: 6, picked: {}, dropped: [], stranded: [], deaths: 0, gangDied: 3, receiptProof: 'killReceipts=3 receiptDomain=practice feedMatched=0' });
    expect(`RESULT ok ${end.detail}`).toBe('RESULT ok squad accounts=4 kills=3 killReceipts=3 receiptDomain=practice feedMatched=0 gangDied=3 died=0 taken=500 trips=1 picked={}');
});

// A squad member that dies at the post: with deaths left it respawns, re-kits at the bank, restocks and walks back; over the limit it ends.
function squadWorld() {
    const worn = [{ id: 1163, count: 1, slot: 0, name: 'Rune full helm', optionsWithIndex: [] }, { id: 1231, count: 1, slot: 3, name: 'Dragon dagger(p)', optionsWithIndex: [] }];
    const inventory: any[] = [], equipment: any[] = worn.map(w => ({ ...w })), bank = [{ id: 385, count: 40 }, { id: 1163, count: 1 }, { id: 1231, count: 1 }];
    let tick = 0, deadAt = -1, slots = 0, eaten = 0;
    const player: any = { worldX: 3066, worldZ: 3641, combatLevel: 126, hp: 99, maxHp: 99, isDead: false, lifeId: 1, runEnergy: 100 };
    const state: any = { player, inventory, equipment, skills: [], combatEvents: [], gameMessages: [], nearbyPlayers: [], prayers: { prayerPoints: 99, activePrayers: [] } };
    const walks: { x: number; z: number }[] = [];
    const s: any = {
        name: 'Soldier', tick: () => tick, ended: new Promise(() => {}), client: {}, onTick: () => () => {},
        sdk: {
            getState: () => state, getInventory: () => inventory, getEquipment: () => equipment, getBankItems: () => bank, getSkill: () => ({ level: 99 }), sendWalk: async () => {},
            sendUseItem: async (slot: number, op: number) => {
                const at = inventory.findIndex(i => i.slot === slot), item = inventory[at];
                if (!item) return;
                if (op === 1) { eaten++; player.hp = Math.min(99, player.hp + 20); inventory.splice(at, 1); } else { inventory.splice(at, 1); equipment.push(item); }
            },
        },
        bot: {
            openBank: async () => ({ success: true }), closeBank: async () => {}, depositItem: async (item: any) => { const at = inventory.indexOf(item); if (at >= 0) inventory.splice(at, 1); },
            withdrawItem: async (row: any, count: number) => {
                row.count -= count;
                const food = row.id === 385;
                for (let i = 0; i < (food ? count : 1); i++) inventory.push({ id: row.id, count: food ? 1 : count, slot: ++slots, name: food ? 'Shark' : 'Piece', optionsWithIndex: food ? [{ text: 'Eat', opIndex: 1 }] : [{ text: 'Wear', opIndex: 2 }] });
            },
            eatFood: async () => ({ success: true }),
        },
    };
    // The account dies at tick 5: its pack and worn items are gone, and it respawns at Lumbridge 3 ticks later with 1 Hitpoints.
    const next = async () => {
        tick++;
        if (tick === 5) { deadAt = tick; equipment.length = 0; inventory.length = 0; Object.assign(player, { hp: 0, isDead: true }); }
        if (deadAt >= 0 && tick === deadAt + 3) Object.assign(player, { worldX: 3222, worldZ: 3218, hp: 1, isDead: false, lifeId: 2 });
        return true;
    };
    return { s, player, equipment, inventory, walks, next, eaten: () => eaten, tick: () => tick };
}

async function runSquadDeath(maxDeaths: number | undefined, onDeath?: (near: { x: number; z: number } | null) => void, run?: { deaths: number; limit: number }) {
    const w = squadWorld(), lines: string[] = [];
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_deps, path) => { w.walks.push({ x: path[0]!.x, z: path[0]!.z }); w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 3, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 }; }),
        spyOn(pk, 'nextTick').mockImplementation(w.next),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
    ];
    try {
        const stats = await hold(w.s, { targets: new Set(['goondelf']), post: { x: 3066, z: 3641 }, options: { kit: {} }, allies: [], pickup: false, trips: 3, deadline: 400,
            stopped: () => w.tick() >= 120, killsLeft: () => true, log: l => lines.push(l), ...(maxDeaths === undefined ? {} : { maxDeaths }), ...(onDeath ? { onDeath } : {}), ...(run ? { run } : {}) });
        return { stats, w, lines };
    } finally { for (const mock of mocks) mock.mockRestore(); }
}

test('a squad member that dies with deaths left re-kits, restocks and goes back to the post', async () => {
    const { stats, w, lines } = await runSquadDeath(1);
    expect(stats).toMatchObject({ deaths: 1, rekits: 1, died: false });
    expect(w.equipment.map(e => e.id).sort()).toEqual([1163, 1231]);
    expect(w.player.hp).toBeGreaterThanOrEqual(89);
    // It walked to a bank after the death and back to the post.
    expect(w.walks.some(t => t.z < 3520)).toBe(true);
    expect(w.walks.at(-1)).toEqual({ x: 3066, z: 3641 });
    expect(lines.some(l => l.includes('SQUAD re-kitted after a death (1)'))).toBe(true);
});

test('a squad member that dies over its limit ends its part as died, with no re-kit', async () => {
    for (const limit of [0, undefined]) {
        const { stats, w, lines } = await runSquadDeath(limit);
        expect(stats).toMatchObject({ deaths: 1, rekits: 0, died: true });
        expect(w.equipment).toEqual([]);
        expect(lines.some(l => l.includes('over the limit of 0'))).toBe(true);
    }
});

test('the squad end line counts the re-kits and stays ok when every death was recovered', () => {
    const base = { accounts: 4, kills: 3, taken: 500, trips: 1, fights: 6, picked: {}, dropped: [], stranded: [] };
    const recovered = squadEnd({ ...base, deaths: 0, rekits: 2 });
    expect(recovered.ok).toBe(true);
    expect(recovered.detail).toBe('squad accounts=4 kills=3 died=0 rekits=2 taken=500 trips=1 picked={}');
    const lost = squadEnd({ ...base, deaths: 1, rekits: 1 });
    expect(lost.ok).toBe(false);
    expect(lost.detail.startsWith('died squad accounts=4')).toBe(true);
    expect(maxDeathsOf('1', 1)).toBe(1);
    expect(maxDeathsOf('x', 1)).toBe(1);
    expect(maxDeathsOf('0', 1)).toBe(0);
});

test('a rescue account that dies during its rescue is stranded, so a run cannot end ok with a dead account', async () => {
    const sessions: any[] = [];
    let retreated = false;
    const stranded = await rescueDropped(['dead', 'safe'], sessions, async (name, onStop) => {
        const s = { name } as any;
        // The default openBot ends a death through onStop (the rescue opens its account without continueAfterDeath).
        if (name === 'dead') await onStop(s, 'died');
        return s;
    }, () => {}, async s => { if (s.name === 'dead') retreated = true; return s; });
    expect(stranded).toEqual(['dead']);
    expect(retreated).toBe(false);
});

test('a squad member calls the death ledger hook for each death, also over the limit, and a failing hook does not stop the re-kit', async () => {
    const seen: ({ x: number; z: number } | null)[] = [];
    const a = await runSquadDeath(1, near => { seen.push(near); });
    expect(a.stats).toMatchObject({ deaths: 1, rekits: 1 });
    expect(seen).toEqual([{ x: 3066, z: 3641 }]);
    const over = await runSquadDeath(0, near => { seen.push(near); });
    expect(over.stats.died).toBe(true);
    expect(seen).toHaveLength(2);
    const failing = await runSquadDeath(1, () => { throw new Error('disk full'); });
    expect(failing.stats).toMatchObject({ rekits: 1, died: false });
    expect(failing.lines.some(l => l.includes('SQUAD death ledger write failed: Error: disk full'))).toBe(true);
});

test('the deaths of all the members of a run share one limit: the death that reaches it is not recovered', async () => {
    // The first death of the run (limit 2) is recovered.
    const first = { deaths: 0, limit: 2 };
    const a = await runSquadDeath(5, undefined, first);
    expect(a.stats).toMatchObject({ deaths: 1, rekits: 1, died: false });
    expect(first.deaths).toBe(1);
    // Another member has died already: this member's death is the second of the run and ends its part.
    const second = { deaths: 1, limit: 2 };
    const b = await runSquadDeath(5, undefined, second);
    expect(b.stats).toMatchObject({ deaths: 1, rekits: 0, died: true });
    expect(second.deaths).toBe(2);
    expect(b.lines.some(l => l.includes('reaches the run limit of 2'))).toBe(true);
    // The death is still handed to the ledger hook.
    const seen: unknown[] = [];
    await runSquadDeath(5, near => seen.push(near), { deaths: 1, limit: 2 });
    expect(seen).toHaveLength(1);
});

test('the squad end line names the accounts that died, right after the account count, only for a squad with a death', () => {
    const base = { accounts: 4, kills: 3, taken: 500, trips: 1, fights: 6, picked: {}, dropped: [], stranded: [] };
    expect(squadEnd({ ...base, deaths: 1, diedAccounts: ['Squad3'] }).detail).toBe('died squad accounts=4 diedAccounts=Squad3 kills=3 died=1 taken=500 trips=1 picked={}');
    expect(squadEnd({ ...base, deaths: 2, diedAccounts: ['Squad1', 'Squad3'] }).detail.startsWith('died squad accounts=4 diedAccounts=Squad1,Squad3 kills=3')).toBe(true);
    // A space in an account name is written as an underscore, so that the name stays one token on the line.
    expect(squadEnd({ ...base, deaths: 1, diedAccounts: ['Sq 3'] }).detail.startsWith('died squad accounts=4 diedAccounts=Sq_3 kills=3')).toBe(true);
    expect(squadEnd({ ...base, deaths: 0, diedAccounts: [] }).detail).toBe('squad accounts=4 kills=3 died=0 taken=500 trips=1 picked={}');
    // The supervisor logs 200 characters of the RESULT line: the names are in them even for a long line.
    const long = squadEnd({ ...base, deaths: 1, diedAccounts: ['Squad3'], picked: { 884: 3, 1231: 2, 385: 40, 995: 99999 }, dropped: ['A', 'B'], stranded: ['C'] });
    expect(('SUPERVISE run 1 exit 1: RESULT fail ' + long.detail).slice(0, 200)).toContain('diedAccounts=Squad3');
});

// The threat radar in the hold loop: with no target, a member that a threat can hit holds the protect prayer of the threat's style.
async function holdWithThreats(act: boolean) {
    const w = squadWorld(), toggles: number[] = [];
    let t = 0;
    w.s.tick = () => t;
    w.s.sdk.sendTogglePrayer = async (i: number) => { toggles.push(i); };
    const threats: any = { act, acted: () => {}, step: () => ({ classes: [], interlopers: [], actions: [{ kind: 'protect', member: 'Soldier', style: 'magic', reason: 'Mage magic by weapon, 4 tiles' }] }) };
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockResolvedValue({ ok: true, ticks: 1, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
    ];
    try {
        await hold(w.s, { targets: new Set(['goondelf']), post: { x: 3066, z: 3641 }, options: { kit: {} }, allies: [], pickup: false, trips: 3, deadline: 400, stopped: () => t >= 12, killsLeft: () => true, log: () => {}, threats });
        return toggles;
    } finally { for (const mock of mocks) mock.mockRestore(); }
}

test('with a threat that can hit it and no target, a member holds the protect prayer of the threat style (Protect from Magic is prayer 12)', async () => {
    const toggles = await holdWithThreats(true);
    expect(toggles.length).toBeGreaterThan(0);
    expect(new Set(toggles)).toEqual(new Set([12]));
});

test('with act off the threat watch changes nothing in the hold loop', async () => {
    expect(await holdWithThreats(false)).toEqual([]);
});

// The armour swap and the single-way hold of the threat radar in the hold loop.
async function holdRadar(actions: (tick: number) => any[], until = 120) {
    const w = squadWorld(), lines: string[] = [], walks: { x: number; z: number }[] = [], seen: number[][] = [];
    let t = 0, slot = 20;
    w.s.tick = () => t;
    w.equipment.push({ id: 1127, count: 1, slot: 4, name: 'Rune platebody', optionsWithIndex: [] });
    w.inventory.push({ id: 1135, count: 1, slot: ++slot, name: 'Dragonhide body', optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] });
    // Wearing swaps the body: the worn one goes to the pack.
    const body: Record<number, number> = { 1135: 1127, 1127: 1135 };
    w.s.sdk.sendUseItem = async (s: number, op: number) => {
        const at = w.inventory.findIndex(i => i.slot === s), item = w.inventory[at];
        if (!item || op !== 2) return;
        w.inventory.splice(at, 1);
        const old = w.equipment.findIndex(e => e.id === body[item.id]);
        if (old >= 0) { const [gone] = w.equipment.splice(old, 1); w.inventory.push({ ...gone, slot: ++slot, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }); }
        w.equipment.push(item);
    };
    const threats: any = { act: true, acted: () => {}, step: (tick: number) => ({ classes: [], interlopers: [], actions: actions(tick) }) };
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_d, path) => { walks.push({ x: path[0]!.x, z: path[0]!.z }); w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z; return { ok: true, ticks: 1, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any; }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; seen.push(w.equipment.map(e => e.id)); return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
    ];
    try {
        const stats = await hold(w.s, { targets: new Set(['goondelf']), post: { x: 3066, z: 3641 }, options: { kit: {} }, allies: [], pickup: false, trips: 3, deadline: 400, stopped: () => t >= until, killsLeft: () => true, log: l => lines.push(l), threats });
        return { w, lines, walks, seen, stats };
    } finally { for (const mock of mocks) mock.mockRestore(); }
}

test('a kit action wears the pack armour from the pack once, and wears the worn armour again 60 ticks after the threat is gone', async () => {
    const { w, lines, seen } = await holdRadar(tick => tick < 30 ? [{ kind: 'kit', member: 'Soldier', style: 'magic', wear: [1135], gain: 26, reason: 'Mage magic: wear 1135 (+26)' }] : []);
    expect(lines.filter(l => l.includes('threat kit swap'))).toHaveLength(1);
    expect(seen.some(ids => ids.includes(1135) && !ids.includes(1127))).toBe(true);
    expect(lines.some(l => l.includes('threat kit restore: wear 1127'))).toBe(true);
    expect(w.equipment.map(e => e.id)).toContain(1127);
    expect(w.equipment.map(e => e.id)).not.toContain(1135);
});

test('a single-way action walks to the tile once, and the squad stays there: no walk back to the multi-way post', async () => {
    const to = { x: 3040, z: 3600 };
    const { lines, walks } = await holdRadar(() => [{ kind: 'single-way', to, reason: 'team of 3: A(126,melee)' }], 40);
    expect(walks).toEqual([to]);
    expect(lines.filter(l => l.includes('SQUAD threat single-way: team of 3'))).toHaveLength(1);
});

test('a retreat action ends a member part in the Wilderness with the rescue: a walk to the bank, then back to the post by the bank trip', async () => {
    const reason = 'outclassed by Boss(145,magic) at 3 tiles';
    let fired = false;
    const { lines, walks, stats } = await holdRadar(() => fired ? [] : (fired = true, [{ kind: 'retreat', reason }]), 200);
    expect(lines.filter(l => l.includes(`SQUAD threat retreat: ${reason}`))).toHaveLength(1);
    expect(lines.some(l => l.includes('SQUAD rescue at 3066,3641'))).toBe(true);
    expect(lines.some(l => l.includes('SQUAD rescue ends at') && l.includes('wild 0'))).toBe(true);
    expect(walks.some(t => t.z < 3520)).toBe(true);
    expect(stats).toMatchObject({ died: false });
    expect(stats.trips).toBeGreaterThanOrEqual(1);
});

test('a fight of the hold loop stops when the radar decides a retreat or a single-way move, and not for the protect prayer', async () => {
    const w = squadWorld();
    w.s.tick = () => 0;
    w.s.sdk.getState().nearbyPlayers = [{ index: 5, name: 'Goondelf', combatLevel: 126, x: 3067, z: 3641, distance: 1 }];
    const decided: { actions: any[] } = { actions: [{ kind: 'protect', member: 'Soldier', style: 'magic', reason: 't' }] };
    const threats: any = { act: true, acted: () => {}, step: () => ({ classes: [], interlopers: [], actions: decided.actions }) };
    const stops: boolean[] = [];
    let t = 0;
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async (_s: any, _name: string, opts: any) => {
            stops.push(opts.stop());
            decided.actions = [{ kind: 'retreat', reason: 'outnumbered' }];
            stops.push(opts.stop());
            decided.actions = [{ kind: 'single-way', to: { x: 1, z: 1 }, reason: 'team' }];
            stops.push(opts.stop());
            t = 1000;
            return { outcome: 'stopped' } as any;
        }),
    ];
    try {
        await hold(w.s, { targets: new Set(['goondelf']), post: { x: 3066, z: 3641 }, options: { kit: {} }, allies: [], pickup: false, trips: 3, deadline: 400, stopped: () => t >= 500, killsLeft: () => true, log: () => {}, threats });
        expect(stops.slice(0, 3)).toEqual([false, true, true]);
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('pickSquadFocus: an interloper comes before the squad targets, the one with the lowest health first among interlopers, and the squad goes back to its targets when they are gone', () => {
    const gang = { name: 'Goondelf', index: 1, distance: 5, hp: 0.2 }, mage = { name: 'Mage', index: 2, distance: 9, hp: 1 }, ranger = { name: 'Ranger', index: 3, distance: 6, hp: 0.5 };
    const health = (p: { hp: number }) => p.hp;
    const targets = new Set(['goondelf']);
    expect(pickSquadFocus({ view: [gang, mage], targets, health })?.name).toBe('Goondelf');
    const interlopers = new Set(['mage', 'ranger']);
    const all = new Set([...targets, ...interlopers]);
    expect(pickSquadFocus({ view: [gang, mage], targets: all, priority: interlopers, health })?.name).toBe('Mage');
    expect(pickSquadFocus({ view: [gang, mage, ranger], targets: all, priority: interlopers, health })?.name).toBe('Ranger');
    expect(pickSquadFocus({ view: [gang], targets, priority: new Set(), health })?.name).toBe('Goondelf');
});

test('the squad end line prints the kills of interlopers only when the threat watch counted them', () => {
    const base = { accounts: 4, kills: 3, taken: 500, trips: 1, fights: 6, picked: {}, dropped: [], stranded: [], deaths: 0 };
    expect(squadEnd(base).detail).toBe('squad accounts=4 kills=3 died=0 taken=500 trips=1 picked={}');
    expect(squadEnd({ ...base, interlopers: 2 }).detail).toBe('squad accounts=4 kills=3 died=0 attackerKills=2 taken=500 trips=1 picked={}');
    expect(squadEnd({ ...base, interlopers: 0 }).detail).toContain(' attackerKills=0 ');
});

test('the hold loop wears the starting armour again after a fight that stripped it', async () => {
    const w = squadWorld();
    w.s.tick = () => 0;
    w.s.sdk.getState().nearbyPlayers = [{ index: 5, name: 'Goondelf', combatLevel: 126, x: 3067, z: 3641, distance: 1 }];
    let t = 0, fights = 0;
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async () => {
            fights++;
            // A freeze stripped the helm in the first fight: it sits in the pack.
            const at = fights === 1 ? w.equipment.findIndex(e => e.id === 1163) : -1;
            if (at >= 0) { const [helm] = w.equipment.splice(at, 1); w.inventory.push({ ...helm, slot: 21, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }); }
            return { outcome: 'timeout' } as any;
        }),
    ];
    const lines: string[] = [];
    try {
        await hold(w.s, { targets: new Set(['goondelf']), post: { x: 3066, z: 3641 }, options: { kit: {} }, allies: [], pickup: false, trips: 3, deadline: 5000, stopped: () => t >= 30, killsLeft: () => true, log: l => lines.push(l) });
        expect(fights).toBeGreaterThanOrEqual(1);
        expect(lines.filter(l => l.includes('PK wore 1 piece of the starting armour again'))).toHaveLength(1);
        expect(w.equipment.map(e => e.id)).toContain(1163);
        expect(w.inventory.map(e => e.id)).not.toContain(1163);
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('squadFightOverrides: the plain settings for freezeArmour and protectItem, and a fail for a value that is not listed', () => {
    const env = (values: Record<string, string>) => (name: string, fallback: string) => values[name] ?? fallback;
    expect(squadFightOverrides(env({}))).toEqual({});
    expect(squadFightOverrides(env({ SQUAD_FREEZE_ARMOUR: 'torso' }))).toEqual({ freezeArmour: 'torso' });
    expect(squadFightOverrides(env({ SQUAD_PROTECT_ITEM: 'skulled' }))).toEqual({ protectItem: 'skulled' });
    expect(squadFightOverrides(env({ SQUAD_PROTECT_ITEM: 'on', SQUAD_FREEZE_ARMOUR: 'keep' }))).toEqual({ protectItem: true, freezeArmour: 'keep' });
    expect(squadFightOverrides(env({ SQUAD_PROTECT_ITEM: 'off' }))).toEqual({ protectItem: false });
    expect(() => squadFightOverrides(env({ SQUAD_FREEZE_ARMOUR: 'bare' }))).toThrow('strip, torso or keep');
    expect(() => squadFightOverrides(env({ SQUAD_PROTECT_ITEM: 'yes' }))).toThrow('on, off or skulled');
});

test('a member that drops starts its rescue at once through onDrop, once', async () => {
    const dropped = new Map<string, string>(), started: string[] = [];
    const { onSessionEnd } = squadStopHandlers(() => {}, dropped, () => {}, name => started.push(name));
    await onSessionEnd({ name: 'Alpha' } as any, 'connection lost');
    await onSessionEnd({ name: 'Alpha' } as any, 'connection lost again');
    await onSessionEnd({ name: 'Beta' } as any, 'stall');
    expect(started).toEqual(['Alpha', 'Beta']);
});

test('the early check of the members options: the defaults pass with an empty kit, an unknown profile and bad JSON throw', () => {
    expect(() => sparOptions('gang-hunter', JSON.stringify(SQUAD_OPTS), {}, 1200)).not.toThrow();
    expect(() => sparOptions('no-such-profile', JSON.stringify(SQUAD_OPTS), {}, 1200)).toThrow('unknown profile');
    expect(() => sparOptions('gang-hunter', '{bad', {}, 1200)).toThrow();
});

test('activeCentroid excludes dropped, tripping, and finished members and prefers Wilderness members when marching north', () => {
    const members = [
        { name: 'UnderMyKilt', at: { x: 2888, z: 3345 } },
        { name: 'TrouserSnake', at: { x: 3070, z: 3560 } },
        { name: 'TheFullMonty', at: { x: 3072, z: 3562 } },
        { name: 'PocketPool', at: { x: 3185, z: 3436 } },
    ];
    expect(activeCentroid(members, new Set(['UnderMyKilt', 'PocketPool']))).toEqual({ x: 3071, z: 3561 });
    expect(activeCentroid(members, new Set(['UnderMyKilt']), true)).toEqual({ x: 3071, z: 3561 });
    expect(activeCentroid(members, new Set(members.map(m => m.name)))).toBeNull();
});

test('marchPlan never generates intermediate straight-line waypoints south of the Wilderness ditch', () => {
    const plan = marchPlan({ x: 2888, z: 3345 }, { x: 3067, z: 3640 }, 12);
    expect(plan[0]!.z).toBe(3519);
    expect(plan.every(step => step.z >= 3519)).toBe(true);
    expect(plan[plan.length - 1]).toEqual({ x: 3067, z: 3640 });
    // Single-way Wilderness target from far mainland first pathfinds to the ditch north of target x.
    const singlePlan = marchPlan({ x: 2617, z: 3308 }, { x: 3090, z: 3560 }, 12);
    expect(singlePlan[0]).toEqual({ x: 3090, z: 3519 });
    expect(singlePlan.every(step => step.z >= 3519)).toBe(true);
});

test('shouldFollowReplan suppresses pre-rally replans and minor mid-march target jitter', () => {
    const base = { rallied: true, routePending: true, currentAim: { x: 3067, z: 3640 }, nextTile: { x: 3071, z: 3634 }, tick: 100, lastReplanTick: -1 };
    expect(shouldFollowReplan({ ...base, rallied: false, nextTile: { x: 3190, z: 3680 } })).toBe(false);
    expect(shouldFollowReplan(base)).toBe(false);
    expect(shouldFollowReplan({ ...base, nextTile: { x: 3185, z: 3679 } })).toBe(true);
    expect(shouldFollowReplan({ ...base, nextTile: { x: 3185, z: 3679 }, tick: 115, lastReplanTick: 100 })).toBe(false);
    expect(shouldFollowReplan({ ...base, routePending: false, nextTile: { x: 3075, z: 3640 }, tick: 120, lastReplanTick: 100 })).toBe(true);
});

test('createSquadFocus and shouldSwitchFocus pile all multi-way members onto one target and switch onto stunned/dying focus', () => {
    const focus = createSquadFocus();
    const targets = new Set(['goondelf', 'ligma', 'sugma']);
    const viewA = [
        { name: 'Goondelf', index: 1, distance: 1, x: 3067, z: 3640, combatLevel: 126 },
        { name: 'Ligma', index: 2, distance: 5, x: 3069, z: 3640, combatLevel: 125 },
    ];
    const viewB = [
        { name: 'Goondelf', index: 1, distance: 6, x: 3067, z: 3640, combatLevel: 126 },
        { name: 'Ligma', index: 2, distance: 1, x: 3069, z: 3640, combatLevel: 125 },
    ];
    const hp: Record<number, number> = { 1: 1.0, 2: 1.0 };
    expect(focus.pick({ view: viewA, targets, health: p => hp[p.index]!, inMulti: true, now: 10 })?.name).toBe('Goondelf');
    // Second bot nearer Ligma still piles onto Goondelf at equal HP.
    expect(focus.pick({ view: viewB, targets, health: p => hp[p.index]!, inMulti: true, now: 10 })?.name).toBe('Goondelf');
    // Once Ligma drops to stunned or significantly lower HP, focus shifts and multi-way teammates yield to finish it.
    hp[2] = 0.35;
    expect(focus.pick({ view: viewA, targets, health: p => hp[p.index]!, inMulti: true, stunned: new Set(['ligma']), now: 15 })?.name).toBe('Ligma');
    expect(shouldSwitchFocus({ inMulti: true, currentName: 'Goondelf', currentHp: 0.9, focusName: 'ligma', focusHp: 0.35, focusStunned: true, elapsedTicks: 4 })).toBe(true);
    expect(shouldSwitchFocus({ inMulti: true, currentName: 'Goondelf', currentHp: 0.2, focusName: 'ligma', focusHp: 0.35, focusStunned: true, elapsedTicks: 4 })).toBe(false);
    focus.clear('Ligma');
    expect(focus.active(15)).toBeUndefined();
});

test('rescue casts an available escape teleport on tick 0 before eating so multi-way retreats do not stall', async () => {
    const actions: string[] = [];
    let z = 3600, ticks = 0;
    const inv = [
        { id: 563, count: 2, slot: 0, optionsWithIndex: [] },
        { id: 556, count: 10, slot: 1, optionsWithIndex: [] },
        { id: 385, count: 1, slot: 2, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    ];
    const mockSess: any = {
        name: 'Escaper',
        tick: () => ticks,
        ended: new Promise(() => {}),
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z, hp: 45, maxHp: 99 },
                inventory: inv,
                skills: [{ name: 'Magic', level: 45 }],
            }),
            getInventory: () => inv,
            getEquipment: () => [],
        },
        direct: async (action: any) => {
            actions.push(`${action.type}:${action.componentId ?? action.slot}`);
            if (action.type === 'clickComponent' && action.componentId === 1174) z = 3480;
        },
    };
    const spyTick = spyOn(pk, 'nextTick').mockImplementation(async () => { ticks++; return true; });
    try {
        const res = await rescue(mockSess, () => {}, () => false, false);
        expect(res).toBe(mockSess);
        expect(actions).toEqual(['useInventoryItem:2', 'clickComponent:1174']);
    } finally {
        spyTick.mockRestore();
    }
});

test('needsSingleWayMove checks single-way status and exact destination tile', () => {
    expect(needsSingleWayMove({ worldX: 3071, worldZ: 3600 }, { x: 3070, z: 3599 })).toBe(true);
    expect(needsSingleWayMove({ worldX: 3070, worldZ: 3599 }, { x: 3070, z: 3599 })).toBe(false);
    expect(needsSingleWayMove({ worldX: 3072, worldZ: 3603 }, { x: 3070, z: 3599 })).toBe(false);
    expect(needsSingleWayMove({ worldX: 3040, worldZ: 3600 }, { x: 3040, z: 3600 })).toBe(false);
});

test('hold does not stop fightPlayer for single-way once standing on single-way tile and holds ranged without chase against multi-way targets', async () => {
    const w = squadWorld();
    w.s.tick = () => 0;
    w.player.worldX = 3071;
    w.player.worldZ = 3600;
    w.s.sdk.getState().nearbyPlayers = [{ index: 5, name: 'Goondelf', combatLevel: 126, x: 3070, z: 3600, distance: 1 }];
    const decided: { actions: any[] } = { actions: [{ kind: 'single-way', to: { x: 3070, z: 3599 }, reason: 'team' }] };
    const threats: any = { act: true, acted: () => {}, step: () => ({ classes: [], interlopers: [], actions: decided.actions }) };
    const stops: boolean[] = [];
    let seenOpts: any = null;
    let t = 0;
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_d, path) => {
            w.player.worldX = path[0]!.x;
            w.player.worldZ = path[0]!.z;
            return { ok: true, ticks: 1, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any;
        }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async (_s: any, _name: string, opts: any) => {
            seenOpts = opts;
            stops.push(opts.stop());
            w.player.worldX = 3071;
            w.player.worldZ = 3600;
            stops.push(opts.stop());
            decided.actions = [];
            w.s.sdk.getState().nearbyPlayers = [
                { index: 5, name: 'Goondelf', combatLevel: 126, x: 3070, z: 3600, distance: 1 },
                { index: 6, name: 'Enemy2', combatLevel: 126, x: 3070, z: 3600, distance: 1 },
                { index: 7, name: 'Enemy3', combatLevel: 126, x: 3070, z: 3600, distance: 1 },
                { index: 8, name: 'Enemy4', combatLevel: 126, x: 3070, z: 3600, distance: 1 },
                { index: 9, name: 'Enemy5', combatLevel: 126, x: 3070, z: 3600, distance: 1 },
            ];
            w.player.hp = Math.floor(w.player.maxHp * 0.65);
            stops.push(opts.stop());
            t = 1000;
            return { outcome: 'timeout' } as any;
        }),
    ];
    try {
        await hold(w.s, {
            targets: new Set(['goondelf']), post: { x: 3071, z: 3600 },
            options: { kit: { ranged: [861], melee: [1215] }, rotation: ['ranged', 'melee'], chase: true, spec: { kit: [1215], bar: 'dds', cost: 250, below: 1 } },
            allies: ['Ally1'], pickup: false, trips: 3, deadline: 400, stopped: () => t >= 500, killsLeft: () => true, log: () => {}, threats,
        });
        expect(stops).toEqual([false, true, true]);
        expect(seenOpts.rotation).toEqual(['ranged']);
        expect(seenOpts.chase).toBe(false);
        expect(seenOpts.spec).toBeUndefined();
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('hold keeps singleUntil extended past 120 ticks while dangerous interlopers remain and skips risky pickup', async () => {
    const w = squadWorld();
    let t = 0;
    w.s.tick = () => t;
    w.player.worldX = 3071;
    w.player.worldZ = 3600;
    w.s.sdk.getState().nearbyPlayers = [{ index: 5, name: 'Mage1', combatLevel: 126, x: 3070, z: 3600, distance: 1 }];
    const decided = { actions: [{ kind: 'single-way', to: { x: 3070, z: 3599 }, reason: 'team' }] as any[], interlopers: ['Mage1'] };
    const threats: any = { act: true, acted: () => {}, step: () => ({ classes: [], interlopers: decided.interlopers, actions: decided.actions }) };
    const fightOptsList: any[] = [];
    let pickups = 0;
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_d, path) => {
            w.player.worldX = path[0]!.x;
            w.player.worldZ = path[0]!.z;
            return { ok: true, ticks: 1, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any;
        }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pkGang, 'pickUp').mockImplementation(async () => { pickups++; return {}; }),
        spyOn(pk, 'fightPlayer').mockImplementation(async (_s: any, _name: string, opts: any) => {
            fightOptsList.push({ rotation: opts.rotation, chase: opts.chase });
            if (fightOptsList.length === 1) {
                t = 130;
                decided.actions = [];
                decided.interlopers = ['Mage2'];
                w.s.sdk.getState().nearbyPlayers = [{ index: 6, name: 'Mage2', combatLevel: 126, x: 3070, z: 3600, distance: 1 }];
                return { outcome: 'kill' } as any;
            }
            t = 1000;
            return { outcome: 'timeout' } as any;
        }),
    ];
    try {
        await hold(w.s, {
            targets: new Set(['goondelf']), post: { x: 3071, z: 3600 },
            options: { kit: { ranged: [861], melee: [1215] }, rotation: ['ranged', 'melee'], chase: true },
            allies: [], pickup: true, pull: true, trips: 3, deadline: 400, stopped: () => t >= 500, killsLeft: () => true, log: () => {}, threats,
        });
        expect(pickups).toBe(0);
        expect(fightOptsList).toEqual([
            { rotation: ['ranged'], chase: false },
            { rotation: ['ranged'], chase: false },
        ]);
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('configureBenchSession disables reachability, preserves PICKUP=1 ground items on squad clients, and restores locs only during withLocs', async () => {
    const mk = () => {
        const reachCalls: boolean[] = [];
        const collector: any = {
            collectNearbyLocs: () => ['loc'],
            collectGroundItems: () => ['loot'],
        };
        return { reachCalls, collector, s: { client: { setReachabilityEnabled: (on: boolean) => reachCalls.push(on), collector } } as any };
    };
    const gang = mk();
    configureBenchSession(gang.s, { isGang: true, pickup: true });
    expect(gang.reachCalls).toEqual([false]);
    expect(gang.collector.collectNearbyLocs()).toEqual([]);
    expect(gang.collector.collectGroundItems()).toEqual([]);

    const sqNoPickup = mk();
    const ctrl0 = configureBenchSession(sqNoPickup.s, { isGang: false, pickup: false });
    expect(sqNoPickup.reachCalls).toEqual([false]);
    expect(sqNoPickup.collector.collectNearbyLocs()).toEqual([]);
    expect(sqNoPickup.collector.collectGroundItems()).toEqual([]);
    await ctrl0.withLocs(async () => {
        expect(sqNoPickup.collector.collectNearbyLocs()).toEqual(['loc']);
        await ctrl0.withoutLocs(async () => {
            expect(sqNoPickup.collector.collectNearbyLocs()).toEqual([]);
        });
        expect(sqNoPickup.collector.collectNearbyLocs()).toEqual(['loc']);
    });
    expect(sqNoPickup.collector.collectNearbyLocs()).toEqual([]);

    const sqPickup = mk();
    configureBenchSession(sqPickup.s, { isGang: false, pickup: true });
    expect(sqPickup.collector.collectGroundItems()).toEqual(['loot']);
    expect(sqPickup.collector.collectNearbyLocs()).toEqual([]);
});

test('hold tracks sharks/karambwans eaten, minHp, freeze hit rate, escapes, and kill ticks into squadMetrics', async () => {
    const w = squadWorld();
    let t = 0;
    const listeners = new Set<() => void>();
    w.s.tick = () => t;
    w.s.onTick = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
    w.player.hp = 90;
    w.inventory.push(
        { id: 385, count: 1, slot: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { id: 3144, count: 1, slot: 2, name: 'Cooked karambwan', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    );
    w.s.sdk.getState().nearbyPlayers = [{ index: 5, name: 'Goondelf', combatLevel: 126, x: 3067, z: 3641, distance: 1 }];
    let fightCalls = 0;
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockResolvedValue({ ok: true, ticks: 1, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; for (const fn of listeners) fn(); return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async (sess: any, _name: string, opts: any) => {
            fightCalls++;
            if (fightCalls === 1) {
                w.player.hp = 44;
                for (const fn of listeners) fn();
                await sess.sdk.sendUseItem(1, 1);
                await sess.sdk.sendUseItem(2, 1);
                // Own freeze cast + held within 4 ticks counts 1 landed; stray ally freeze held without prior cast does not double-count.
                opts.log('PK freeze cast at distance 4');
                t += 2;
                opts.log('PK freeze held (graphic) at distance 4');
                opts.log('PK freeze held (graphic) at distance 4');
                t = 40;
                return { outcome: 'kill', ticks: 40, freezes: 2 } as any;
            }
            t = 1000;
            return { outcome: 'escaped', ticks: 15, freezes: 1 } as any;
        }),
    ];
    try {
        const stats = await hold(w.s, {
            targets: new Set(['goondelf']), post: { x: 3066, z: 3641 }, options: { kit: {} }, allies: [], pickup: false,
            trips: 3, deadline: 400, stopped: () => t >= 500, killsLeft: () => true, log: () => {},
        });
        expect(stats).toMatchObject({
            kills: 1,
            killTicks: 40,
            minHp: 44,
            sharksEaten: 1,
            karamEaten: 1,
            freezesCast: 3,
            freezesLanded: 1,
            escapes: 1,
        });
        expect(squadMetrics([stats, { name: 'B', fights: 1, pulls: 0, kills: 1, trips: 1, died: false, picked: {}, taken: 10, receipts: [], deaths: 0, rekits: 0, killTicks: 20, minHp: 58, sharksEaten: 1, karamEaten: 0, freezesCast: 1, freezesLanded: 1, escapes: 0 }])).toEqual({
            accounts: 2,
            kills: 2,
            deaths: 0,
            taken: stats.taken + 10,
            trips: stats.trips + 1,
            avgKillTicks: 30,
            minHp: 44,
            sharksEaten: 2,
            karamEaten: 1,
            freezesCast: 4,
            freezesLanded: 2,
            escapes: 1,
        });
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('pickSquadFocus and shouldSwitchFocus prioritize multi-way targets over lower-HP single-way decoys and enforce single-way anti-PJ', () => {
    expect([isMulti(3068, 3640), isMulti(3073, 3640), isMulti(3071, 3525)]).toEqual([true, false, false]);
    const view = [
        { name: 'Decoy', index: 1, distance: 2, x: 3073, z: 3640, combatLevel: 120, inCombat: true },
        { name: 'Goondelf', index: 2, distance: 3, x: 3074, z: 3640, combatLevel: 120, inCombat: false },
        { name: 'Ligma', index: 3, distance: 5, x: 3068, z: 3640, combatLevel: 120, inCombat: true },
    ];
    const hp: Record<number, number> = { 1: 0.2, 2: 0.5, 3: 0.9 };
    const targets = new Set(['decoy', 'goondelf', 'ligma']);
    // Even with attacker in multi-way, Ligma in multi-way outranks lower-HP Decoy/Goondelf in single-way.
    expect(pickSquadFocus({ view, targets, health: p => hp[p.index]!, inMulti: true, preferMulti: true })?.name).toBe('Ligma');
    // Without multi-way targets, inCombat target on single-way tile is still skipped for anti-PJ.
    expect(pickSquadFocus({ view: view.slice(0, 2), targets, health: p => hp[p.index]!, inMulti: true, preferMulti: true })?.name).toBe('Goondelf');
    // A chaser pulled onto a single-way tile still switches off a single-way target onto a multi-way shared focus.
    expect(shouldSwitchFocus({
        inMulti: false,
        currentName: 'Goondelf',
        currentHp: 0.6,
        currentInMulti: false,
        focusName: 'ligma',
        focusHp: 0.9,
        focusInMulti: true,
        focusStunned: false,
        elapsedTicks: 1,
    })).toBe(true);
});

test('shouldBreakSingleWayChase and hold cohesion prevent 2v2 single-way splitting and return to multi-way post', async () => {
    const coh = createSquadCohesion();
    coh.update('Ally1', { x: 3067, z: 3640, inMulti: true, hasMultiTarget: true, tick: 10 });
    const snap = coh.snapshot(10, 'soldier');
    expect(snap).toEqual({ allyCount: 1, multiAllyCount: 1, anyMultiTarget: true, multiAnchor: { x: 3067, z: 3640 } });

    expect(shouldBreakSingleWayChase({
        now: 10, singleUntil: -1, aimInMulti: true,
        self: { x: 3070, z: 3598, inMulti: false }, target: { x: 3071, z: 3525 },
        hasMultiTargetInView: false, multiAllyCount: 1, anyAllyHasMultiTarget: true, anchor: { x: 3067, z: 3640 },
    })).toBe(true);
    // Out of multi-way past leash even with no allies visible splits -> break off.
    expect(shouldBreakSingleWayChase({
        now: 10, singleUntil: -1, aimInMulti: true,
        self: { x: 3071, z: 3530, inMulti: false }, target: { x: 3071, z: 3525 },
        hasMultiTargetInView: false, multiAllyCount: 0, anyAllyHasMultiTarget: false, anchor: { x: 3067, z: 3640 },
    })).toBe(true);
    // ALLOW_SINGLE (aimInMulti=false) or ThreatWatch single-way (now < singleUntil) are never broken.
    expect(shouldBreakSingleWayChase({
        now: 10, singleUntil: -1, aimInMulti: false,
        self: { x: 3071, z: 3530, inMulti: false }, target: { x: 3071, z: 3525 },
        hasMultiTargetInView: false, multiAllyCount: 0, anyAllyHasMultiTarget: false, anchor: { x: 3075, z: 3640 },
    })).toBe(false);
    expect(shouldBreakSingleWayChase({
        now: 10, singleUntil: 120, aimInMulti: true,
        self: { x: 3070, z: 3599, inMulti: false }, target: { x: 3071, z: 3598 },
        hasMultiTargetInView: true, multiAllyCount: 1, anyAllyHasMultiTarget: true, anchor: { x: 3067, z: 3640 },
    })).toBe(false);

    // Hold loop: Soldier in Wild 1 single-way skips decoy and walks back to multi-way post without stopping for single-way decoy.
    const w = squadWorld();
    let t = 5;
    w.s.tick = () => t;
    w.player.worldX = 3071; w.player.worldZ = 3530;
    w.s.sdk.getState().nearbyPlayers = [
        { index: 1, name: 'Decoy', combatLevel: 126, x: 3071, z: 3525, distance: 5 },
    ];
    const focus = createSquadFocus();
    const sharedCoh = createSquadCohesion();
    sharedCoh.update('Ally1', { x: 3067, z: 3640, inMulti: true, hasMultiTarget: true, tick: 5 });
    const fought: string[] = [];
    const mocks = [
        spyOn(walking, 'sessionWalker').mockResolvedValue({} as any),
        spyOn(walking, 'walkPath').mockImplementation(async (_d, path, opts: any) => {
            // Confirm walkPath stop callback does not abort for the Wild 1 single-way decoy.
            expect(opts?.stop?.()).toBe(false);
            w.walks.push({ x: path[0]!.x, z: path[0]!.z });
            w.player.worldX = path[0]!.x; w.player.worldZ = path[0]!.z;
            w.s.sdk.getState().nearbyPlayers = [
                { index: 2, name: 'Ligma', combatLevel: 126, x: 3068, z: 3640, distance: 1 },
            ];
            return { ok: true, ticks: 2, still: 0, clicks: 0, repaths: 0, doors: 0, next: 1 } as any;
        }),
        spyOn(pk, 'nextTick').mockImplementation(async () => { t++; sharedCoh.update('Ally1', { x: 3067, z: 3640, inMulti: true, hasMultiTarget: true, tick: t }); return true; }),
        spyOn(pk, 'observePlayer').mockReturnValue(null),
        spyOn(pk, 'fightPlayer').mockImplementation(async (_s: any, targetName: string) => {
            fought.push(targetName);
            t = 500;
            return { outcome: 'kill' } as any;
        }),
    ];
    try {
        await hold(w.s, {
            targets: new Set(['decoy', 'ligma']), post: { x: 3067, z: 3640 },
            options: { kit: { ranged: [861], melee: [1231] }, rotation: ['ranged', 'melee'] },
            allies: ['Ally1'], pickup: false, pull: true, trips: 3, deadline: 400, focus, cohesion: sharedCoh,
            stopped: () => t >= 400, killsLeft: () => true, log: () => {},
        });
        expect(SINGLE_WAY_CHASE_LEASH).toBe(16);
        expect(w.walks).toEqual([{ x: 3067, z: 3640 }]);
        expect(fought).toEqual(['Ligma']);
    } finally { for (const mock of mocks) mock.mockRestore(); }
});

test('Wave A scaled clone-tribrid, threat, scattered-follow, single-way split, and nospare multi-trip bench cases exist', () => {
    const all = benchCases();
    const find = (key: string) => {
        const found = all.find(c => c.key === key);
        expect(found).toBeDefined();
        return found!;
    };
    for (const n of [4, 6, 8, 10, 12, 16]) {
        const c = find(`extra:clone-tribrid-${n}-x1`);
        expect(c.companions).toHaveLength(n - 1 + 3);
        expect(c.scriptArgs).toEqual(expect.arrayContaining([
            'SQUAD_GANG=3',
            'SQUAD_GANG_PROFILES=clone-goondelf+clone-ligma+clone-sugma',
            'SPAR_B_OPTS={}',
            'SQUAD_GANG_HUNT=1',
            'SQUAD_GANG_SPLIT=1',
        ]));
        expect(c.pass('RESULT ok squad accounts=4 kills=3 killReceipts=3 receiptDomain=practice gangDied=3 died=0')).toBe(true);
        expect(c.pass('RESULT fail died squad accounts=4 kills=2 killReceipts=2 receiptDomain=practice gangDied=2 died=1')).toBe(false);
    }
    for (const key of [
        'extra:clone-tribrid-threat-ranger-x1',
        'extra:clone-tribrid-threat-spear-radar-x1',
        'extra:clone-tribrid-threat-team3-x1',
        'extra:clone-tribrid-threat-team5-x1',
        'extra:clone-tribrid-scattered-follow-x1',
    ]) {
        const c = find(key);
        expect(c.scriptArgs).toEqual(expect.arrayContaining([
            'SQUAD_GANG_PROFILES=clone-goondelf+clone-ligma+clone-sugma' + (key.includes('team5') ? '+attacker-fight+attacker-fight+attacker-fight+attacker-fight+attacker-fight' : key.includes('team3') ? '+attacker-fight+attacker-fight+attacker-fight' : key.includes('threat-') ? '+attacker-fight' : ''),
            'SQUAD_THREAT=1',
        ]));
    }
    const split = find('extra:squad-4-singleway-split-x1');
    expect(split.companions![3]!.presetConfig!.position).toEqual({ x: 3071, z: 3525, level: 0 });
    expect(split.pass('RESULT ok squad accounts=4 kills=2 killReceipts=2 receiptDomain=practice gangDied=2 died=0')).toBe(true);

    const nospare = find('extra:squad-2-trips-nospare-x1');
    expect(nospare.presetConfig!.bank!.some(r => r.id === 892 || r.id === 886)).toBe(false);
    expect(nospare.pass('RESULT ok squad accounts=2 kills=2 killReceipts=2 receiptDomain=practice gangDied=2 died=0 trips=2')).toBe(true);
    expect(nospare.pass('RESULT ok squad accounts=2 kills=2 killReceipts=2 receiptDomain=practice gangDied=2 died=0 trips=0')).toBe(false);
});

test('rescue unequips worn glory(4), rubs it, clicks Edgeville dialog to escape wild <= 30, and squadFallbackPlan retreats when dry', async () => {
    expect(squadFallbackPlan({ z: 3640, hp: 85, maxHp: 99, foodCount: 0, enemyCount: 1, allyCount: 1, inMulti: true, hasGlory: true, hasTeleport: false, packFood: 18 })).toBe('glory');
    expect(shouldBreakSingleWayChase({
        now: 10, singleUntil: -1, aimInMulti: true,
        self: { x: 3071, z: 3619, inMulti: true }, target: { x: 3068, z: 3619 },
        hasMultiTargetInView: true, multiAllyCount: 3, anyAllyHasMultiTarget: false, anchor: { x: 3066, z: 3641 },
        isInterloper: true,
    })).toBe(false);
    expect(shouldBreakSingleWayChase({
        now: 10, singleUntil: -1, aimInMulti: true,
        self: { x: 3071, z: 3619, inMulti: true }, target: { x: 3068, z: 3619 },
        hasMultiTargetInView: false, multiAllyCount: 3, anyAllyHasMultiTarget: false, anchor: { x: 3066, z: 3641 },
    })).toBe(false);

    let ticks = 0, z = 3615, dialogOpen = false;
    const eq: any[] = [{ id: 1712, slot: 2, count: 1, name: 'Amulet of glory(4)' }];
    const inv: any[] = Array.from({ length: 27 }, (_, i) => ({
        slot: i, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }],
    }));
    inv.push({ slot: 27, id: 229, count: 1, name: 'Vial', optionsWithIndex: [{ text: 'Drop', opIndex: 1 }] });
    const events: string[] = [];
    const mockSess: any = {
        name: 'GloryBot',
        tick: () => ticks,
        client: {},
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z, hp: 70, maxHp: 99, combatLevel: 126 },
                inventory: inv,
                equipment: eq,
                skills: [{ name: 'Magic', level: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                prayers: { activePrayers: [], prayerPoints: 80 },
                combatEvents: [],
                dialog: { isOpen: dialogOpen },
            }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: () => ({ level: 99, baseLevel: 99 }),
            sendUseEquipmentItem: async (slot: number) => {
                events.push(`unequip:${slot}`);
                const idx = eq.findIndex(e => e.slot === slot);
                if (idx >= 0) {
                    const [removed] = eq.splice(idx, 1);
                    inv.push({ slot: 27, id: removed.id, count: 1, name: removed.name, optionsWithIndex: [{ text: 'Rub', opIndex: 4 }] });
                }
            },
            clickDialogByText: async (pat: RegExp) => {
                events.push(`dialog:${pat.source}`);
                if (dialogOpen) { dialogOpen = false; z = 3496; }
            },
        },
        direct: async (action: any) => {
            events.push(`${action.type}:${action.slot}:${action.optionIndex}`);
            const item = inv.find(i => i.slot === action.slot);
            if (item?.id === 229) { inv.splice(inv.indexOf(item), 1); }
            else if (item?.id === 1712) { dialogOpen = true; }
        },
    };
    const spyTick = spyOn(pk, 'nextTick').mockImplementation(async () => { ticks++; return true; });
    try {
        const res = await rescue(mockSess, () => {}, () => false, false);
        expect(res).toBe(mockSess);
        expect(z).toBe(3496);
        expect(events).toEqual(['useInventoryItem:0:1', 'useInventoryItem:27:1', 'unequip:2', 'useInventoryItem:27:4', 'dialog:^Edgeville']);
    } finally {
        spyTick.mockRestore();
    }
});

test('squadKitFightDefaults enables comboFood, God spell + Charge, and freezeWear staff without breaking explicit rotation', () => {
    const { squadKitFightDefaults } = require('./pk-squad');
    // Combo food + carried mystic_fire_staff without blood runes -> freezeWear staff and no magic DPS turn.
    const ent = squadKitFightDefaults(
        [{ id: 2412 }],
        [{ id: 3144, count: 1 }, { id: 1401, count: 1 }, { id: 561, count: 50 }],
        { rotation: ['magic', 'ranged', 'melee'] },
    );
    expect(ent).toEqual({ comboFood: true, rotation: ['ranged', 'melee'], freezeWear: ['mystic_fire_staff'] });
    // God staff + matching cape + Fire/Blood/Air runes enables God spell, Charge, strip castArmour, and magic rotation.
    const god = squadKitFightDefaults(
        [{ id: 2412 }],
        [{ id: 2415, count: 1 }, { id: 554, count: 100 }, { id: 565, count: 50 }, { id: 556, count: 100 }],
        { rotation: ['ranged', 'melee'] },
    );
    expect(god).toEqual({ damageSpell: 1190, charge: true, rotation: ['magic', 'ranged', 'melee'], castArmour: 'strip' });
    // Explicit rotation in SQUAD_OPTS stays intact.
    const explicit = squadKitFightDefaults(
        [{ id: 2412 }],
        [{ id: 2415, count: 1 }, { id: 554, count: 100 }, { id: 565, count: 50 }, { id: 556, count: 100 }],
        { rotation: ['ranged', 'melee'] },
        undefined,
        true,
    );
    expect(explicit.rotation).toBeUndefined();
});

test('squadFallbackPlan escapes focus piles even with allies present and disableAutoRetaliate toggles off once', async () => {
    const { disableAutoRetaliate } = require('./pk-squad');
    // 3+ attackers targeting this member in multi triggers escape at <= 78% HP despite 10 nearby allies.
    expect(squadFallbackPlan({ z: 3640, hp: 75, maxHp: 99, foodCount: 10, enemyCount: 6, allyCount: 10, targetingMe: 3, inMulti: true, hasGlory: true, hasTeleport: false })).toBe('glory');
    // 2 attackers targeting us when food is nearly exhausted also falls back early.
    expect(squadFallbackPlan({ z: 3640, hp: 80, maxHp: 99, foodCount: 3, enemyCount: 4, allyCount: 6, targetingMe: 2, inMulti: true, hasGlory: true, hasTeleport: false })).toBe('glory');
    // Full HP or < 3 focus attackers with ample food holds the fight.
    expect(squadFallbackPlan({ z: 3640, hp: 90, maxHp: 99, foodCount: 10, enemyCount: 6, allyCount: 10, targetingMe: 4, inMulti: true, hasGlory: true, hasTeleport: false })).toBe('hold');

    let enabled = true;
    const clicks: number[] = [];
    const s: any = {
        sdk: { getState: () => ({ autoRetaliateEnabled: enabled }) },
        direct: async (a: any) => { clicks.push(a.componentId); enabled = false; },
    };
    const spyTick = spyOn(pk, 'nextTick').mockImplementation(async () => true);
    try {
        await disableAutoRetaliate(s);
        await disableAutoRetaliate(s);
        expect(clicks).toEqual([151]);
    } finally {
        spyTick.mockRestore();
    }
});

test('rescue skips eating while Glory Edgeville dialog is open so food never cancels teleport', async () => {
    let ticks = 0, z = 3616, dialogOpen = false;
    const eq: any[] = [];
    const inv: any[] = [
        { slot: 0, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { slot: 1, id: 1712, count: 1, name: 'Amulet of glory(4)', optionsWithIndex: [{ text: 'Rub', opIndex: 4 }] },
    ];
    const events: string[] = [];
    const mockSess: any = {
        name: 'GloryDialogBot',
        tick: () => ticks,
        client: {},
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z, hp: 65, maxHp: 99, combatLevel: 126 },
                inventory: inv,
                equipment: eq,
                skills: [{ name: 'Magic', level: 99 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                prayers: { activePrayers: [], prayerPoints: 80 },
                combatEvents: [],
                dialog: { isOpen: dialogOpen, options: dialogOpen ? [{ text: 'Edgeville.' }] : [] },
            }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: () => ({ level: 99, baseLevel: 99 }),
            clickDialogByText: async (pat: RegExp) => {
                events.push(`dialog:${pat.source}`);
                if (dialogOpen) { dialogOpen = false; z = 3496; }
                return { success: true };
            },
        },
        direct: async (action: any) => {
            events.push(`${action.type}:${action.slot}:${action.optionIndex}`);
            if (action.slot === 1) dialogOpen = true;
            else inv.shift();
        },
    };
    const spyTick = spyOn(pk, 'nextTick').mockImplementation(async () => { ticks++; return true; });
    try {
        const res = await rescue(mockSess, () => {}, () => false, false);
        expect(res).toBe(mockSess);
        expect(z).toBe(3496);
        expect(events).toEqual(['useInventoryItem:0:1', 'useInventoryItem:1:4', 'dialog:^Edgeville']);
    } finally {
        spyTick.mockRestore();
    }
});

test('curePoisonAndEat drinks antipoison and eats above fatal poison ticks once in safe Edgeville, and isolatedPile guards full-HP re-entries', async () => {
    const { curePoisonAndEat } = require('./pk-squad');
    // Freshly banked lone re-entrant at full HP with 21 food does not endlessly Glory out before allies join.
    expect(squadFallbackPlan({ z: 3640, hp: 99, maxHp: 99, foodCount: 21, enemyCount: 3, allyCount: 0, inMulti: true, hasGlory: true, hasTeleport: false })).toBe('hold');
    // Low-HP or outnumbered solo still escapes immediately.
    expect(squadFallbackPlan({ z: 3640, hp: 80, maxHp: 99, foodCount: 21, enemyCount: 3, allyCount: 0, inMulti: true, hasGlory: true, hasTeleport: false })).toBe('glory');

    let hp = 12;
    const inv: any[] = [
        { slot: 0, id: 2448, count: 1, name: 'Superantipoison(4)', optionsWithIndex: [{ text: 'Drink', opIndex: 1 }] },
        { slot: 1, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    ];
    const used: number[] = [];
    const s: any = {
        tick: () => 50,
        client: {},
        sdk: {
            getState: () => ({ player: { worldX: 3087, worldZ: 3496, hp, maxHp: 99 } }),
            getInventory: () => inv,
        },
        direct: async (a: any) => {
            used.push(a.slot);
            if (a.slot === 1) { hp += 20; inv.splice(inv.findIndex(x => x.slot === 1), 1); }
        },
    };
    const spyTick = spyOn(pk, 'nextTick').mockImplementation(async () => true);
    try {
        await curePoisonAndEat(s, () => false, true);
        expect(used).toEqual([0, 1]);
    } finally {
        spyTick.mockRestore();
    }
});

test('squadFallbackPlan catches 2+ hitter focus and 4+ enemy multi bursts, and rescue combo-heals on Glory entry and low-HP teleport windup', async () => {
    expect(squadFallbackPlan({ z: 3604, hp: 85, maxHp: 99, foodCount: 14, enemyCount: 5, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 3 })).toBe('glory');
    expect(squadFallbackPlan({ z: 3604, hp: 71, maxHp: 99, foodCount: 14, enemyCount: 5, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 2 })).toBe('glory');
    expect(squadFallbackPlan({ z: 3604, hp: 61, maxHp: 99, foodCount: 14, enemyCount: 4, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 0 })).toBe('glory');
    expect(squadFallbackPlan({ z: 3604, hp: 75, maxHp: 99, foodCount: 14, enemyCount: 5, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 1 })).toBe('hold');

    let z = 3604, hp = 64, ticks = 0, dialogOpen = false;
    const inv: any[] = [
        { slot: 0, id: 1712, count: 1, name: 'Amulet of glory(4)', optionsWithIndex: [{ text: 'Rub', opIndex: 4 }] },
        { slot: 1, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { slot: 2, id: 3144, count: 1, name: 'Cooked karambwan', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    ];
    const used: string[] = [];
    const s: any = {
        name: 'GloryHealBot',
        tick: () => ticks,
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z, hp, maxHp: 99, combatLevel: 126 },
                inventory: inv,
                equipment: [],
                skills: [{ name: 'Magic', level: 45 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                prayers: { activePrayers: [], prayerPoints: 99 },
                combatEvents: [],
                dialog: dialogOpen ? { isOpen: true, isWaiting: false, options: [{ text: 'Edgeville' }] } : { isOpen: false },
            }),
            getInventory: () => inv,
            getEquipment: () => [],
            getSkill: () => ({ level: 99, baseLevel: 99 }),
            clickDialogByText: async () => {
                dialogOpen = false;
                used.push('clickEdgeville');
                hp = 48; // simulate heavy spike during teleport windup
                return { success: true };
            },
        },
        direct: async (a: any) => {
            used.push(`use:${a.slot}`);
            if (a.slot === 0) dialogOpen = true;
            if (a.slot === 1) hp += 20;
            if (a.slot === 2) hp += 18;
        },
    };
    const spyTick = spyOn(pk, 'nextTick').mockImplementation(async () => {
        ticks++;
        if (ticks >= 2 && !dialogOpen && used.includes('clickEdgeville')) z = 3496;
        return true;
    });
    try {
        await rescue(s, () => {}, () => false, false);
        expect(used[0]).toBe('use:1');
        expect(used[1]).toBe('use:2');
        expect(used).toContain('use:0');
        expect(used).toContain('clickEdgeville');
        expect(z).toBe(3496);
    } finally {
        spyTick.mockRestore();
    }

    // Prayer toggles / eats must not run during the 1-tick wait after Rub glory before Edgeville dialog appears.
    let ticks2 = 0, z2 = 3604, dlg2 = false, rubTick = -1;
    const inv2: any[] = [
        { slot: 0, id: 1712, count: 1, name: 'Amulet of glory(4)', optionsWithIndex: [{ text: 'Rub', opIndex: 4 }] },
        { slot: 1, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    ];
    const log2: string[] = [];
    const s2: any = {
        name: 'NoClearModalBot',
        tick: () => ticks2,
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z2, hp: 88, maxHp: 99, combatLevel: 126 },
                inventory: inv2,
                equipment: [],
                skills: [{ name: 'Magic', level: 45 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                prayers: { activePrayers: [], prayerPoints: 99 },
                combatEvents: [],
                dialog: dlg2 ? { isOpen: true, isWaiting: false, options: [{ text: 'Edgeville.' }] } : { isOpen: false },
            }),
            getInventory: () => inv2,
            getEquipment: () => [],
            getSkill: () => ({ level: 99, baseLevel: 99 }),
            sendTogglePrayer: async (p: number) => { log2.push(`pray:${p}@t${ticks2}`); },
            clickDialogByText: async () => { log2.push(`edge@t${ticks2}`); dlg2 = false; z2 = 3496; return { success: true }; },
        },
        direct: async (a: any) => {
            log2.push(`use:${a.slot}@t${ticks2}`);
            if (a.slot === 0) rubTick = ticks2;
        },
    };
    const spy2 = spyOn(pk, 'nextTick').mockImplementation(async () => {
        ticks2++;
        if (rubTick >= 0 && ticks2 === rubTick + 1) dlg2 = true;
        return true;
    });
    try {
        await rescue(s2, () => {}, () => false, false, { protect: () => 'melee', protectItem: () => true });
        expect(z2).toBe(3496);
        expect(log2.filter(x => x.endsWith('@t1'))).toEqual(['edge@t1']);
    } finally {
        spy2.mockRestore();
    }
});

test('rescue retries Glory rub every tick on .if_close interruption and dispatches direct dialog/unequip actions when available', async () => {
    expect(squadFallbackPlan({ z: 3604, hp: 75, maxHp: 99, foodCount: 14, enemyCount: 6, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 2 })).toBe('hold');
    expect(squadFallbackPlan({ z: 3604, hp: 75, maxHp: 99, foodCount: 14, enemyCount: 6, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: true, targetingMe: 2 })).toBe('glory');
    expect(squadFallbackPlan({ z: 3604, hp: 75, maxHp: 99, foodCount: 14, enemyCount: 6, allyCount: 7, inMulti: true, hasGlory: false, hasTeleport: true, targetingMe: 2 })).toBe('teleport');

    let ticks = 0, z = 3604, dlgOpen = false;
    const eq: any[] = [{ slot: 2, id: 1712, count: 1, name: 'Amulet of glory(4)' }];
    const inv: any[] = [];
    const actions: string[] = [];
    const s: any = {
        name: 'DirectRetryBot',
        client: { clickEquipmentSlot: () => true },
        tick: () => ticks,
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z, hp: 92, maxHp: 99, combatLevel: 126 },
                inventory: inv,
                equipment: eq,
                skills: [{ name: 'Magic', level: 45 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                prayers: { activePrayers: [], prayerPoints: 99 },
                combatEvents: [],
                dialog: dlgOpen ? { isOpen: true, isWaiting: false, pageId: 'page-1', options: [{ index: 1, componentId: 2494, text: 'Edgeville.' }] } : { isOpen: false },
            }),
            getInventory: () => inv,
            getEquipment: () => eq,
            getSkill: () => ({ level: 99, baseLevel: 99 }),
            clickDialogByText: async () => { actions.push('queuedDialog'); return { success: true }; },
            sendUseEquipmentItem: async () => { actions.push('queuedUnequip'); },
        },
        direct: async (a: any) => {
            actions.push(`${a.type}@t${ticks}`);
            if (a.type === 'useEquipmentItem') {
                const [gl] = eq.splice(0, 1);
                if (gl) inv.push({ slot: 0, id: gl.id, count: 1, name: gl.name, optionsWithIndex: [{ text: 'Rub', opIndex: 4 }] });
            } else if (a.type === 'clickDialogOption') {
                expect(a.guard).toEqual({ pageId: 'page-1', componentId: 2494 });
                dlgOpen = false;
                z = 3496;
            }
            return { success: true };
        },
    };
    let rubCount = 0;
    const spy = spyOn(pk, 'nextTick').mockImplementation(async () => {
        ticks++;
        // First rub at t=1 gets closed by .if_close; second rub at t=2 succeeds and opens dialog at t=3.
        if (actions.some(x => x.startsWith('useInventoryItem@'))) {
            rubCount++;
            if (rubCount === 2) dlgOpen = true;
        }
        return true;
    });
    try {
        await rescue(s, () => {}, () => false, false);
        expect(z).toBe(3496);
        expect(actions).toEqual(['useEquipmentItem@t0', 'useInventoryItem@t1', 'useInventoryItem@t2', 'clickDialogOption@t3']);
    } finally {
        spy.mockRestore();
    }
});

test('squadFallbackPlan outgunned triggers early Glory fallback, and rescue buffers <= 86 HP and aborts Edgeville dialog if spiked <= 68 HP', async () => {
    expect(squadFallbackPlan({ z: 3604, hp: 75, maxHp: 99, foodCount: 14, enemyCount: 5, allyCount: 3, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 2 })).toBe('glory');
    expect(squadFallbackPlan({ z: 3604, hp: 71, maxHp: 99, foodCount: 14, enemyCount: 4, allyCount: 3, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 1 })).toBe('glory');
    expect(squadFallbackPlan({ z: 3604, hp: 75, maxHp: 99, foodCount: 14, enemyCount: 5, allyCount: 7, inMulti: true, hasGlory: true, hasTeleport: false, targetingMe: 2 })).toBe('hold');

    let ticks = 0, z = 3604, hp = 84, dlgOpen = false, rubCount = 0, rubTick = -1;
    const inv: any[] = [
        { slot: 0, id: 1712, count: 1, name: 'Amulet of glory(4)', optionsWithIndex: [{ text: 'Rub', opIndex: 4 }] },
        { slot: 1, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { slot: 2, id: 385, count: 1, name: 'Shark', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
        { slot: 3, id: 3144, count: 1, name: 'Cooked karambwan', optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    ];
    const log: string[] = [];
    const s: any = {
        name: 'PreHealAndAbortBot',
        tick: () => ticks,
        sdk: {
            getState: () => ({
                player: { worldX: 3071, worldZ: z, hp, maxHp: 99, combatLevel: 126 },
                inventory: inv,
                equipment: [],
                skills: [{ name: 'Magic', level: 45 }, { name: 'Prayer', level: 99, baseLevel: 99 }],
                prayers: { activePrayers: [], prayerPoints: 99 },
                combatEvents: [],
                dialog: dlgOpen ? { isOpen: true, isWaiting: false, pageId: 'p1', options: [{ index: 1, componentId: 2494, text: 'Edgeville.' }] } : { isOpen: false },
            }),
            getInventory: () => inv,
            getEquipment: () => [],
            getSkill: () => ({ level: 99, baseLevel: 99 }),
        },
        direct: async (a: any) => {
            log.push(`${a.type}:${a.slot ?? a.optionIndex}@t${ticks}`);
            if (a.type === 'useInventoryItem') {
                if (a.slot === 0) { rubCount++; rubTick = ticks; }
                else {
                    dlgOpen = false;
                    const idx = inv.findIndex(i => i.slot === a.slot);
                    if (idx >= 0) {
                        const [food] = inv.splice(idx, 1);
                        hp = Math.min(99, hp + (food.id === 3144 ? 18 : 20));
                    }
                }
            } else if (a.type === 'clickDialogOption') {
                dlgOpen = false;
                z = 3496;
            }
            return { success: true };
        },
    };
    const spy = spyOn(pk, 'nextTick').mockImplementation(async () => {
        ticks++;
        // Rub #1 opens dialog, then an enemy spike drops HP 99 -> 58 before Edgeville click.
        if (rubTick >= 0 && ticks === rubTick + 1) {
            dlgOpen = true;
            if (rubCount === 1) hp = 58;
        }
        return true;
    });
    try {
        await rescue(s, () => {}, () => false, false);
        expect(z).toBe(3496);
        // Eats Shark at hp=84 before first Rub, waits out foodReady=3 on spike to 58, aborts dialog via Shark+Karambwan at t3, then rubs and clicks Edgeville.
        expect(log).toEqual([
            'useInventoryItem:1@t0',
            'useInventoryItem:0@t1',
            'useInventoryItem:2@t3',
            'useInventoryItem:3@t3',
            'useInventoryItem:0@t4',
            'clickDialogOption:1@t5',
        ]);
    } finally {
        spy.mockRestore();
    }
});

test('squadEliteDefaults enables Entangle, zeroDrainFlick/offensiveFlick, fakieSwitch, eatAt:76, and specBelow:1 only for maxed supplied tribrids', () => {
    const { ELITE_SQUAD_OPTS, squadEliteDefaults } = require('./pk-squad');
    const maxSkills = [
        { name: 'Magic', baseLevel: 99 },
        { name: 'Prayer', baseLevel: 99 },
        { name: 'Hitpoints', baseLevel: 99 },
    ];
    // Run-1 low Prayer or un-potted chainbind iron-arrow kits keep historical SQUAD_OPTS unchanged.
    expect(squadEliteDefaults([{ name: 'Magic', baseLevel: 99 }, { name: 'Prayer', baseLevel: 1 }, { name: 'Hitpoints', baseLevel: 99 }], [{ id: 2434 }])).toEqual({});
    expect(squadEliteDefaults(maxSkills, [{ id: 385 }, { id: 175 }])).toEqual({});
    // Supplied maxed tribrid (carrying prayer restore or super combat/ranging boost) activates ELITE_SQUAD_OPTS and removes freezeMagicCap.
    const elite = squadEliteDefaults(maxSkills, [{ id: 2434 }, { id: 385 }]);
    expect(elite).toEqual(ELITE_SQUAD_OPTS);
    const serialized = JSON.parse(JSON.stringify({ ...SQUAD_OPTS, ...elite }));
    expect(serialized.freezeMagicCap).toBeUndefined();
    expect(serialized.eatAt).toBe(76);
    expect(serialized.comboAt).toBe(64);
    expect(serialized.specBelow).toBe(1);
    expect(serialized.zeroDrainFlick).toBe(true);
    expect(serialized.offensiveFlick).toBe(true);
    expect(serialized.fakieSwitch).toBe(true);
    // Scaled BiS clone & team5 cases default to winning tribrid-bis-zerk-glory-tele (Camelot Teleport + Berserker + Dragon + Glory).
    const clones4 = benchCases().find(c => c.key === 'extra:clone-bis-clones-4-x1')!;
    const team5 = benchCases().find(c => c.key === 'extra:clone-bis-team5-4-x1')!;
    expect(clones4.presetConfig!.inventory!.some(i => i.id === 563)).toBe(true);
    expect(team5.presetConfig!.inventory!.some(i => i.id === 563)).toBe(true);
});
