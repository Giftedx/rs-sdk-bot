import { describe, expect, test } from 'bun:test';
import { bankNear, leaveWilderness, openSquad, pickSquadFocus, rescueDropped, squadEscapeSpell, squadFallbackPlan, squadPaused, squadTarget, squadWorkSession, stopSquadSession, VARROCK_WEST_BANK, watchSquadTicks } from './pk-squad';
import { escapeCastable, nextTick } from './pk';
import { squadEnd } from './pk-squad';
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
