import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    clearEscortRelease, createEscortTracker, ESCORT_DEAD_TICKS, ESCORT_DEATH_GRACE, ESCORT_WAIT_TICKS, escortGate, escortGateCheck, escortHolding, escortReleased,
    escortReleasePath, escortSuppression, gangStatus, readEscortState, releaseEscort, writeEscortState, type EscortState,
} from '../src/pvp/escort';
import { applySquadStallTicks } from '../src/pvp/pk-squad-stall';
import { killLineVictim, squadEnd } from '../src/pvp/squad';

const POST = { x: 3067, z: 3640 };
const noFeed = { fresh: false, at: null };

describe('gang status from what the squad sees', () => {
    test('a gang account in the view on a Wilderness tile is present, out of the view and with no kill it is away', () => {
        expect(gangStatus({ tick: 100, diedTick: null, view: { tick: 100, x: 3078, z: 3640, by: 'view' }, radar: noFeed })).toBe('present');
        expect(gangStatus({ tick: 100, diedTick: null, view: { tick: 90, x: 3078, z: 3640, by: 'view' }, radar: noFeed })).toBe('away');
        // Edgeville (Wilderness level 0) is no threat to a route in the deep Wilderness.
        expect(gangStatus({ tick: 100, diedTick: null, view: { tick: 100, x: 3093, z: 3495, by: 'view' }, radar: noFeed })).toBe('away');
    });
    test('a kill line makes it dead, the dying player in the view does not count, a later sighting makes it present again', () => {
        const dying = { tick: 105, x: 3078, z: 3640, by: 'view' as const };
        expect(gangStatus({ tick: 105, diedTick: 100, view: dying, radar: noFeed })).toBe('dead');
        expect(gangStatus({ tick: 100 + ESCORT_DEATH_GRACE + 1, diedTick: 100, view: { ...dying, tick: 100 + ESCORT_DEATH_GRACE + 1 }, radar: noFeed })).toBe('present');
    });
    test('dead lasts ESCORT_DEAD_TICKS with no sighting, then the account is away (it can be anywhere)', () => {
        expect(gangStatus({ tick: 100 + ESCORT_DEAD_TICKS, diedTick: 100, view: null, radar: noFeed })).toBe('dead');
        expect(gangStatus({ tick: 101 + ESCORT_DEAD_TICKS, diedTick: 100, view: null, radar: noFeed })).toBe('away');
    });
    test('a fresh world feed puts an account out of view: present in the Wilderness, away at the Lumbridge spawn', () => {
        expect(gangStatus({ tick: 200, diedTick: null, view: null, radar: { fresh: true, at: { x: 3155, z: 3900 } } })).toBe('present');
        expect(gangStatus({ tick: 200, diedTick: null, view: null, radar: { fresh: true, at: { x: 3222, z: 3218 } } })).toBe('away');
        expect(gangStatus({ tick: 200, diedTick: 150, view: null, radar: { fresh: true, at: { x: 3222, z: 3218 } } })).toBe('dead');
        // A feed that is not fresh says nothing.
        expect(gangStatus({ tick: 200, diedTick: null, view: null, radar: { fresh: false, at: { x: 3155, z: 3900 } } })).toBe('away');
    });
});

describe('suppression rule of the squad', () => {
    const gang = (...s: ('dead' | 'present' | 'away')[]) => ['goondelf', 'ligma', 'sugma'].map((name, i) => ({ name, status: s[i]! }));
    test('every gang account dead or away on a fresh feed, with four of five members holding', () => {
        expect(escortSuppression({ squad: { size: 5, alive: 4 }, gang: gang('dead', 'dead', 'away'), radar: true }))
            .toEqual({ ok: true, why: 'goondelf dead, ligma dead, sugma away' });
    });
    test('too few members, a present account, or an away account with no feed keep the gang not suppressed', () => {
        expect(escortSuppression({ squad: { size: 5, alive: 3 }, gang: gang('dead', 'dead', 'dead'), radar: true })).toEqual({ ok: false, why: 'squad 3 of 5 hold, 4 needed' });
        expect(escortSuppression({ squad: { size: 5, alive: 5 }, gang: gang('dead', 'present', 'dead'), radar: true })).toEqual({ ok: false, why: 'ligma present' });
        expect(escortSuppression({ squad: { size: 5, alive: 5 }, gang: gang('dead', 'away', 'away'), radar: false })).toEqual({ ok: false, why: 'ligma,sugma away with no world feed' });
        expect(escortSuppression({ squad: { size: 5, alive: 5 }, gang: gang('dead', 'dead', 'dead'), radar: false }).ok).toBe(true);
    });
    test('the member floor is never over the squad size, and ESCORT_MIN_SQUAD moves it', () => {
        expect(escortSuppression({ squad: { size: 2, alive: 2 }, gang: gang('dead', 'dead', 'dead'), radar: true }).ok).toBe(true);
        expect(escortSuppression({ squad: { size: 5, alive: 4 }, gang: gang('dead', 'dead', 'dead'), radar: true, minSquad: 5 }).ok).toBe(false);
    });
});

describe('escort tracker and state file', () => {
    const write = (t: ReturnType<typeof createEscortTracker>, tick: number, o: Partial<{ alive: number; holding: boolean; fresh: boolean }> = {}) =>
        t.state({ at: 1_000, tick, post: POST, squad: { size: 5, alive: o.alive ?? 5 }, kills: 0, holding: o.holding ?? true,
            radar: { fresh: o.fresh ?? true, at: name => (name === 'sugma' ? { x: 3222, z: 3218 } : null) } });
    test('the gang at the post is present, then each kill line makes one dead, and the state says suppressed', () => {
        const t = createEscortTracker(['Goondelf', 'Ligma', 'Sugma']);
        for (const n of ['Goondelf', 'Ligma']) t.sight(n, 3078, 3640, 100, 'view');
        t.sight('Stranger', 3078, 3640, 100, 'view');
        const before = write(t, 100);
        expect(before.gang.map(g => g.status)).toEqual(['present', 'present', 'away']);
        expect(before.suppressed).toBe(false);
        expect(before.why).toBe('goondelf,ligma present');
        t.kill('Goondelf', 120); t.kill('LIGMA', 130); t.kill('Stranger', 130);
        const after = write(t, 200);
        expect(after.gang.map(g => [g.name, g.status, g.diedTick])).toEqual([['goondelf', 'dead', 120], ['ligma', 'dead', 130], ['sugma', 'away', null]]);
        expect(after.gang[2]!.seen).toEqual({ tick: 200, x: 3222, z: 3218, by: 'radar' });
        expect(after.suppressed).toBe(true);
        expect(after.why).toBe('goondelf dead, ligma dead, sugma away');
        expect(after).toMatchObject({ v: 1, at: 1_000, tick: 200, post: POST, squad: { size: 5, alive: 5 }, radar: true, holding: true });
    });
    test('the end of the hold writes holding false and never suppressed', () => {
        const t = createEscortTracker(['goondelf']);
        t.kill('goondelf', 10);
        const end = write(t, 20, { holding: false });
        expect(end.suppressed).toBe(false);
        expect(end.why).toBe('hold ended');
    });
    test('the state file and the release file round trip on disk', () => {
        const dir = mkdtempSync(join(tmpdir(), 'escort-test-'));
        try {
            const path = join(dir, 'sub', 'state.json'), t = createEscortTracker(['goondelf']);
            writeEscortState(path, write(t, 5));
            expect((readEscortState(path) as EscortState).tick).toBe(5);
            expect(readEscortState(join(dir, 'missing.json'))).toBeNull();
            const release = escortReleasePath(path, {});
            expect(release).toBe(`${path}.release`);
            expect(escortReleasePath(path, { ESCORT_RELEASE: join(dir, 'r') })).toBe(join(dir, 'r'));
            expect(escortReleased(release)).toBe(false);
            releaseEscort(release);
            expect(escortReleased(release)).toBe(true);
            clearEscortRelease(release);
            expect(existsSync(release)).toBe(false);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});

describe('route gate', () => {
    const state = (o: Partial<EscortState> = {}): Partial<EscortState> => ({ v: 1, at: 10_000, holding: true, suppressed: true, why: 'goondelf dead', ...o });
    test('the check: fresh, holding and suppressed, each with its reason', () => {
        expect(escortGateCheck(null, 10_000)).toEqual({ ok: false, why: 'no escort state' });
        expect(escortGateCheck({ v: 2, at: 10_000 }, 10_000)).toEqual({ ok: false, why: 'escort state not readable' });
        expect(escortGateCheck(state(), 41_000)).toEqual({ ok: false, why: 'escort state 31 s old' });
        expect(escortGateCheck(state({ holding: false }), 10_000)).toEqual({ ok: false, why: 'squad does not hold' });
        expect(escortGateCheck(state({ suppressed: false, why: 'ligma present' }), 10_000)).toEqual({ ok: false, why: 'ligma present' });
        expect(escortGateCheck(state(), 12_000)).toEqual({ ok: true, why: 'goondelf dead' });
        expect(escortGateCheck(state(), 12_000, 1_000).ok).toBe(false);
    });
    const fakeSession = () => { let tick = 0; return { s: { name: 'walker', tick: () => tick, sdk: { getState: () => ({}) }, onTick: () => () => {} }, step: () => { tick++; } }; };
    test('no ESCORT_STATE: the gate returns at once and never waits or reads', async () => {
        const { s } = fakeSession();
        let reads = 0, waits = 0;
        const r = await escortGate(s, () => false, { env: {}, read: () => { reads++; return null; }, wait: async () => { waits++; } });
        expect(r).toEqual({ gated: false, ticks: 0, why: 'no escort' });
        expect([reads, waits]).toEqual([0, 0]);
    });
    test('with ESCORT_STATE: it waits a tick at a time until the squad says suppressed', async () => {
        const { s, step } = fakeSession(), lines: string[] = [];
        const r = await escortGate(s, () => false, {
            env: { ESCORT_STATE: 'x.json' }, now: () => 10_000, log: l => lines.push(l), wait: async () => { step(); },
            read: () => (s.tick() < 3 ? state({ suppressed: false, why: 'ligma present' }) : state()),
        });
        expect(r).toEqual({ gated: true, ticks: 3, why: 'goondelf dead' });
        expect(lines).toEqual(['ESCORT wait at 0 ticks: ligma present', 'ESCORT clear after 3 ticks: goondelf dead']);
    });
    test('it throws at ESCORT_WAIT_TICKS so the route does not enter alone, and a stop returns', async () => {
        const { s, step } = fakeSession();
        const opts = { now: () => 10_000, log: () => {}, wait: async () => { step(); }, read: () => state({ holding: false }) };
        await expect(escortGate(s, () => false, { ...opts, env: { ESCORT_STATE: 'x.json', ESCORT_WAIT_TICKS: '5' } })).rejects.toThrow('escort not clear after 5 ticks: squad does not hold');
        const stopped = await escortGate(fakeSession().s, () => true, { ...opts, env: { ESCORT_STATE: 'x.json' } });
        expect(stopped).toEqual({ gated: true, ticks: 0, why: 'stopped: squad does not hold' });
        expect(ESCORT_WAIT_TICKS).toBeLessThan(900);
    });
});

describe('squad side of the hold', () => {
    test('the victim of a kill line, never of a receipt or feed line', () => {
        expect(killLineVictim('[aiobb] PK kill Goondelf after 41 ticks')).toBe('Goondelf');
        expect(killLineVictim('PK kill aiobg after 7 ticks')).toBe('aiobg');
        expect(killLineVictim('[aiobb] PK kill receipt practice 12 wilderness 16 single')).toBeNull();
        expect(killLineVictim('[aiobb] PK kill feed matched at feed tick 9')).toBeNull();
    });
    test('a hold with no fight ends ok and says hold=1, a hold with a death does not', () => {
        const base = { accounts: 5, kills: 0, taken: 0, trips: 5, fights: 0, picked: {}, dropped: [], stranded: [], deaths: 0 };
        expect(squadEnd(base).ok).toBe(false);
        const held = squadEnd({ ...base, hold: true });
        expect(held.ok).toBe(true);
        expect(held.detail).toContain(' hold=1');
        expect(squadEnd({ ...base, hold: true, deaths: 1 }).ok).toBe(false);
    });
    test('the stall boot turns the stall check off for the hold and keeps an explicit STALL_TICKS', () => {
        const env1: Record<string, string | undefined> = {};
        applySquadStallTicks(env1, ['bun', 'scripts/pk-squad.ts', 'a', 'ESCORT_HOLD=1']);
        expect(env1.STALL_TICKS).toBe('0');
        const env2: Record<string, string | undefined> = { ESCORT_HOLD: '1' };
        applySquadStallTicks(env2, []);
        expect(env2.STALL_TICKS).toBe('0');
        const env3: Record<string, string | undefined> = { ESCORT_HOLD: '1', STALL_TICKS: '1200' };
        applySquadStallTicks(env3, []);
        expect(env3.STALL_TICKS).toBe('1200');
        const env4: Record<string, string | undefined> = {};
        applySquadStallTicks(env4, ['bun', 'scripts/pk-squad.ts', 'a']);
        expect(Number(env4.STALL_TICKS)).toBeGreaterThanOrEqual(900);
    });
});

describe('escortHolding', () => {
    test('the published hold ends at the hold deadline, before the retreat that follows it', () => {
        expect(escortHolding(false, 99, 100)).toBe(true);
        expect(escortHolding(false, 100, 100)).toBe(false);
        expect(escortHolding(false, 140, 100)).toBe(false);
        expect(escortHolding(true, 50, 100)).toBe(false);
    });
});
