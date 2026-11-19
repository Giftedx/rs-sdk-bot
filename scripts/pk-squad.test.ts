import { describe, expect, spyOn, test } from 'bun:test';
import * as walking from '../packages/core/src/walk';
import * as pk from './pk';
import { maxDeathsOf } from './pk-hunt';
import { bankNear, isKillLine, leaveWilderness, openSquad, pickSquadFocus, rescueDropped, squadEscapeSpell, squadFallbackPlan, squadPaused, squadStartFood, squadStopHandlers, squadTarget, squadWorkSession, stopSquadSession, VARROCK_WEST_BANK, watchSquadTicks } from './pk-squad';
import { escapeCastable, nextTick } from './pk';
import { hold, squadEnd, squadFightOverrides } from './pk-squad';
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
    const threats: any = { act, step: () => ({ classes: [], actions: [{ kind: 'protect', member: 'Soldier', style: 'magic', reason: 'Mage magic by weapon, 4 tiles' }] }) };
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
